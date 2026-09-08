import type {
  AutomationCreateInput,
  AutomationDefinition,
  AutomationEvaluation,
  AutomationMonitorEventSnapshot,
  AutomationEvaluationFinishInput,
  AutomationRun,
  AutomationScriptTestReport,
  AutomationUpdateInput,
} from '@cc/superai-contracts';
import type { EventBus } from '@cc/plugin-sdk';
import type { LocalCoreAcpStore } from '../acp/local-core-acp-store.js';
import {
  isPlainRecord,
  normalizeAutomationError,
  normalizeProviderEventSnapshot,
  providerLifecycleBlockReason,
} from './automation-event-utils.js';
import {
  decideTrigger,
  decideCondition,
  evaluateCondition,
} from './automation-condition-engine.js';
import {
  ScriptProtocolError,
  ScriptProtocolRunner,
} from './scripts/script-protocol-runner.js';
import { createAnthropicSandboxRunner } from './scripts/anthropic-sandbox-runner.js';
import { evaluateExpression } from './condition-evaluator.js';
import { nextActivationAt } from './automation-trigger-engine.js';
import type { AutomationActionExecutor } from './automation-action-executor.js';
import type { LegacyAutomationCreateInput } from './legacy-automation-mappers.js';
import {
  AutomationEventProjector,
  type EvaluationContext,
} from './automation-event-projector.js';
import {
  calculateInitialNextCheckAt,
  formatSuccessfulRunUpdate,
  isAutomationConsumedOnce,
  shouldPollAutomation,
  type AutomationOwnershipPolicy,
  NATIVE_AUTOMATION_OWNERSHIP,
} from './automation-schedule-utils.js';

export {
  type AutomationOwnershipPolicy,
  NATIVE_AUTOMATION_OWNERSHIP,
} from './automation-schedule-utils.js';

const DUE_LOOP_INTERVAL_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const FAILURE_ALERT_COUNTS = new Set([1, 3, 7, 15, 31]);
const RESTART_INTERRUPTION_REASON = 'Automation action interrupted by Local AI Core restart.';

type TimerHandle = unknown;
type ActionExecutor = Pick<AutomationActionExecutor, 'execute'>;

export interface AutomationServiceOptions {
  store: LocalCoreAcpStore;
  eventBus: EventBus;
  actionExecutor: ActionExecutor;
  clock?: () => Date;
  setInterval?: (handler: () => void, delayMs: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
  conditionEvaluator?: typeof evaluateCondition;
  scriptProtocolRunner?: Pick<ScriptProtocolRunner, 'run'> & Partial<Pick<ScriptProtocolRunner, 'runTest'>>;
  maxConcurrency?: number;
  ownershipPolicy?: AutomationOwnershipPolicy;
  alert?: (input: { automation: AutomationDefinition; count: number; error: string }) => void;
  log?: (message: string) => void;
}

export type AutomationServiceRuntimeStatus =
  | { status: 'stopped' | 'running' }
  | { status: 'degraded'; reason: string };

export class AutomationService {
  private timer: TimerHandle | undefined;
  private tickPromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly inFlight = new Map<string, Promise<AutomationEvaluation>>();
  private runtimeStatus: AutomationServiceRuntimeStatus = { status: 'stopped' };
  private stopping = false;
  private lifecycleGeneration = 0;
  private scriptProtocolRunner: (Pick<ScriptProtocolRunner, 'run'> & Partial<Pick<ScriptProtocolRunner, 'runTest'>>) | undefined;
  private readonly eventProjector: AutomationEventProjector;

  constructor(private readonly options: AutomationServiceOptions) {
    const concurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error('Automation maxConcurrency must be a positive safe integer.');
    }
    this.scriptProtocolRunner = options.scriptProtocolRunner;
    this.eventProjector = new AutomationEventProjector(
      options.eventBus,
      {
        getAutomation: (id) => this.get(id),
        listRuns: (id) => this.listRuns(id),
        listEvaluations: (id) => this.listEvaluations(id),
        getLatestEvaluationWithState: (id) => this.getLatestEvaluationWithState(id),
      },
      options.log,
    );
  }

  list(
    workspaceId?: string,
    originKind?: NonNullable<AutomationDefinition['originKind']>,
    channelId?: string,
    platform?: string,
  ): AutomationDefinition[] {
    return this.options.store.listAutomations(workspaceId, originKind, channelId, platform);
  }

  get(automationId: string): AutomationDefinition | undefined {
    return this.options.store.getAutomation(automationId);
  }

  create(input: AutomationCreateInput): AutomationDefinition {
    const updated = this.options.store.createAutomationAtomically(input, (automation) => ({
      nextCheckAt: calculateInitialNextCheckAt(automation, this.now()),
    }));
    this.eventProjector.emitDefinition(updated);
    return updated;
  }

  createFromLegacy(input: LegacyAutomationCreateInput): AutomationDefinition {
    this.assertLegacyFacadesAvailable();
    const updated = this.options.store.createTrustedAutomationAtomically(input, (automation) => ({
      nextCheckAt: calculateInitialNextCheckAt(automation, this.now()),
    }));
    this.eventProjector.emitDefinition(updated);
    return updated;
  }

  assertLegacyFacadesAvailable(): void {
    if (this.runtimeStatus.status === 'degraded') {
      throw new Error(`Unified automation migration is unavailable: ${this.runtimeStatus.reason}`);
    }
  }

  update(automationId: string, input: AutomationUpdateInput): AutomationDefinition {
    return this.updateInternal(automationId, input);
  }

  updateFromLegacy(
    automationId: string,
    input: AutomationUpdateInput & { legacyMetadata?: AutomationDefinition['legacyMetadata'] },
  ): AutomationDefinition {
    this.assertLegacyFacadesAvailable();
    return this.updateInternal(automationId, input, true);
  }

  private updateInternal(
    automationId: string,
    input: AutomationUpdateInput,
    trustedLegacy = false,
  ): AutomationDefinition {
    const existing = this.requireAutomation(automationId);
    const initialize = (automation: AutomationDefinition) => {
      if (input.activation !== undefined) {
        return { nextCheckAt: calculateInitialNextCheckAt(automation, this.now(), true) };
      }
      if (
        input.enabled === true
        && existing.enabled === false
        && this.options.store.getAutomationNextCheckAt(automation.id) === null
        && !isAutomationConsumedOnce(automation, (id) => this.listEvaluations(id))
      ) {
        return { nextCheckAt: calculateInitialNextCheckAt(automation, this.now()) };
      }
      return undefined;
    };
    const updated = trustedLegacy
      ? this.options.store.updateTrustedAutomationAtomically(automationId, input, initialize)
      : this.options.store.updateAutomationAtomically(automationId, input, initialize);
    this.eventProjector.emitDefinition(updated);
    return updated;
  }

  delete(automationId: string): { deleted: boolean } {
    const existing = this.options.store.getAutomation(automationId);
    const result = this.options.store.deleteAutomation(automationId);
    if (result.deleted && existing) {
      this.eventProjector.emitDefinition({ ...existing, enabled: false });
    }
    return result;
  }

  listEvaluations(automationId: string): AutomationEvaluation[] {
    return this.options.store.listAutomationEvaluations(automationId);
  }

  getLatestEvaluationWithState(automationId: string): AutomationEvaluation | undefined {
    return this.options.store.getLatestAutomationEvaluationWithState(automationId);
  }

  listRuns(automationId: string): AutomationRun[] {
    return this.options.store.listAutomationRuns(automationId);
  }

  listLatestFinishedEvaluationByOrigin(
    originKind: Exclude<NonNullable<AutomationDefinition['originKind']>, 'native'>,
    workspaceId?: string,
  ): Map<string, AutomationEvaluation> {
    return this.options.store.listLatestFinishedAutomationEvaluationByOrigin(originKind, workspaceId);
  }

  listLatestEvaluationWithStateByOrigin(
    originKind: Exclude<NonNullable<AutomationDefinition['originKind']>, 'native'>,
    workspaceId?: string,
  ): Map<string, AutomationEvaluation> {
    return this.options.store.listLatestAutomationEvaluationWithStateByOrigin(originKind, workspaceId);
  }

  listLatestRunByOrigin(
    originKind: Exclude<NonNullable<AutomationDefinition['originKind']>, 'native'>,
    workspaceId?: string,
  ): Map<string, AutomationRun> {
    return this.options.store.listLatestAutomationRunByOrigin(originKind, workspaceId);
  }

  getRuntimeStatus(): AutomationServiceRuntimeStatus {
    return this.runtimeStatus;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.runtimeStatus.status === 'running') return Promise.resolve();
    const work = this.startInternal();
    let shared!: Promise<void>;
    shared = work.finally(() => {
      if (this.startPromise === shared) this.startPromise = undefined;
    });
    this.startPromise = shared;
    return shared;
  }

  private async startInternal(): Promise<void> {
    this.stopping = false;
    const generation = ++this.lifecycleGeneration;
    await this.settleActiveWork();
    if (generation !== this.lifecycleGeneration || this.stopping) return;
    try {
      this.options.store.importLegacyAutomations();
    } catch (error) {
      const reason = normalizeAutomationError(error, 'Legacy automation import failed: ');
      this.runtimeStatus = { status: 'degraded', reason };
      this.eventProjector.reportDiagnostic('legacy-import', reason);
      return;
    }
    try {
      const recovered = this.options.store.reconcileInterruptedAutomationRuns(
        normalizeAutomationError(RESTART_INTERRUPTION_REASON),
        this.now().toISOString(),
      );
      for (const run of recovered) this.eventProjector.emitRun(run);
      const missingNextCheckAt = this.options.store.listAutomationIdsMissingNextCheckAt();
      for (const automation of this.list()) {
        if (
          shouldPollAutomation(automation, this.options.ownershipPolicy)
          && missingNextCheckAt.has(automation.id)
          && !isAutomationConsumedOnce(automation, (id) => this.listEvaluations(id))
        ) {
          this.persistInitialNextCheck(automation);
        }
      }
      this.runtimeStatus = { status: 'running' };
      if (this.timer === undefined) {
        this.timer = (this.options.setInterval || setInterval)(() => {
          this.runTimerTick(generation);
        }, DUE_LOOP_INTERVAL_MS);
      }
      await this.tick();
    } catch (error) {
      const isCurrentGeneration = this.lifecycleGeneration === generation && !this.stopping;
      if (isCurrentGeneration) {
        this.clearTimer();
        this.runtimeStatus = { status: 'stopped' };
      }
      const message = normalizeAutomationError(error, 'Automation startup failed: ');
      this.eventProjector.reportDiagnostic('startup', message);
      throw new Error(message);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const stopGeneration = ++this.lifecycleGeneration;
    this.clearTimer();
    this.runtimeStatus = { status: 'stopped' };
    await this.settleActiveWork();
    if (this.lifecycleGeneration === stopGeneration) {
      this.runtimeStatus = { status: 'stopped' };
    }
  }

  async tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    const work = this.runTick(this.lifecycleGeneration);
    this.tickPromise = work;
    try {
      await work;
    } finally {
      if (this.tickPromise === work) this.tickPromise = undefined;
    }
  }

  async checkNow(automationId: string): Promise<AutomationEvaluation> {
    const automation = this.requireAutomation(automationId);
    if (automation.activation.kind === 'provider-event') {
      throw new Error(`Provider-event automation requires an event snapshot: ${automationId}`);
    }
    return this.checkAutomation(automation, undefined, true);
  }

  /** The HTTP layer calls this only after the approval service grants one test run. */
  async executeAuthorizedScriptTest(versionId: string): Promise<AutomationScriptTestReport> {
    const version = this.options.store.getAutomationScriptVersion(versionId);
    if (!version || version.status !== 'testing') {
      throw new Error('Automation script test requires a claimed test authorization.');
    }
    const finishedAt = this.now().toISOString();
    try {
      const result = await this.getScriptTestRunner().runTest({
        scriptId: version.scriptId,
        approvedVersionId: version.id,
        evaluationId: `script-test:${version.id}`,
        triggeredAt: finishedAt,
        previousState: {},
      });
      return {
        status: 'passed',
        finishedAt: this.now().toISOString(),
        ...(result.summary === undefined ? {} : { summary: result.summary }),
      };
    } catch (error) {
      return {
        status: 'failed',
        finishedAt: this.now().toISOString(),
        summary: normalizeAutomationError(error),
      };
    }
  }

  async evaluateProviderEvent(
    automationId: string,
    event: AutomationMonitorEventSnapshot,
  ): Promise<AutomationEvaluation> {
    this.assertLegacyFacadesAvailable();
    const automation = this.requireAutomation(automationId);
    if (automation.activation.kind !== 'provider-event') {
      throw new Error(`Automation is not provider-event activated: ${automationId}`);
    }
    const snapshot = normalizeProviderEventSnapshot(event);
    if (snapshot.sourceType !== automation.activation.sourceType) {
      throw new Error(normalizeAutomationError(`Provider event source "${snapshot.sourceType}" does not match automation source "${automation.activation.sourceType}".`));
    }
    return this.checkAutomation(automation, this.eventProjector.buildProviderEventContext(automation, snapshot));
  }

  recordUnavailableProviderEvent(automationId: string, reason: string): AutomationEvaluation {
    this.assertLegacyFacadesAvailable();
    const automation = this.requireAutomation(automationId);
    if (automation.activation.kind !== 'provider-event') {
      throw new Error(`Automation is not provider-event activated: ${automationId}`);
    }
    const startedAt = this.now();
    const running = this.createEvaluation(automation, startedAt);
    const finishedAt = this.now();
    const finished = this.finishEvaluation(running.id, {
      conditionOutcome: 'skipped',
      triggerDecision: 'not_evaluated',
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      resultSummary: normalizeAutomationError(reason),
    });
    this.updateDefinitionAfterEvaluation(automation, finishedAt, {
      nextMatch: automation.lastSuccessfulMatch,
      failureCount: automation.consecutiveEvaluationFailures,
    });
    this.eventProjector.emitCompatibilityEvaluationRun(automation, finished);
    return finished;
  }

  failClosedLegacyAutomation(automationId: string, reason: string): AutomationDefinition {
    const automation = this.requireAutomation(automationId);
    if (automation.originKind === 'native') {
      throw new Error(`Automation is not owned by a legacy facade: ${automationId}`);
    }
    const blocked = this.options.store.updateAutomationAtomically(automationId, { enabled: false }, () => ({
      health: 'blocked',
      blockedReason: providerLifecycleBlockReason(reason),
    }));
    this.eventProjector.emitDefinition(blocked);
    return blocked;
  }

  markLegacyProviderLifecycleBlocked(automationId: string, reason: string): AutomationDefinition {
    const automation = this.requireAutomation(automationId);
    if (automation.originKind !== 'automation-monitor') {
      throw new Error(`Automation is not owned by the legacy monitor facade: ${automationId}`);
    }
    const blocked = this.options.store.updateAutomationState(automationId, {
      health: 'blocked',
      blockedReason: providerLifecycleBlockReason(reason),
    });
    this.eventProjector.emitDefinition(blocked);
    return blocked;
  }

  clearLegacyProviderLifecycleBlocked(automationId: string, expectedReason: string): AutomationDefinition {
    const automation = this.requireAutomation(automationId);
    if (automation.originKind !== 'automation-monitor') {
      throw new Error(`Automation is not owned by the legacy monitor facade: ${automationId}`);
    }
    if (automation.health !== 'blocked' || automation.blockedReason !== normalizeAutomationError(expectedReason)) {
      return automation;
    }
    const healthy = this.options.store.updateAutomationState(automationId, { health: 'healthy' });
    this.eventProjector.emitDefinition(healthy);
    return healthy;
  }

  private async runTick(generation: number): Promise<void> {
    const now = this.now();
    const due: AutomationDefinition[] = [];
    const dueIds = this.options.store.listDueAutomationIds(now);
    for (const automation of this.list()) {
      if (!shouldPollAutomation(automation, this.options.ownershipPolicy)) continue;
      if (dueIds.has(automation.id)) {
        due.push(automation);
      }
    }
    let index = 0;
    const worker = async () => {
      while (!this.stopping && generation === this.lifecycleGeneration) {
        const automation = due[index];
        index += 1;
        if (!automation) return;
        await this.checkAutomation(automation);
      }
    };
    const workerCount = Math.min(due.length, this.options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (!this.stopping && generation === this.lifecycleGeneration) {
      this.options.store.pruneAutomationEvaluations(now);
    }
  }

  private async checkAutomation(
    automation: AutomationDefinition,
    context?: EvaluationContext,
    manual = false,
  ): Promise<AutomationEvaluation> {
    const existing = this.inFlight.get(automation.id);
    if (existing) return this.recordConcurrentSkip(automation, context);
    const work = this.evaluateAndMaybeRun(automation, context, manual);
    this.inFlight.set(automation.id, work);
    try {
      return await work;
    } finally {
      if (this.inFlight.get(automation.id) === work) this.inFlight.delete(automation.id);
    }
  }

  private async recordConcurrentSkip(
    automation: AutomationDefinition,
    context?: EvaluationContext,
  ): Promise<AutomationEvaluation> {
    const now = context ? new Date(context.occurredAt) : this.now();
    const running = this.createEvaluation(automation, now);
    const finished = this.finishEvaluation(running.id, {
      conditionOutcome: 'skipped',
      triggerDecision: 'skipped_concurrent',
      finishedAt: now.toISOString(),
      durationMs: 0,
      resultSummary: 'Skipped because another evaluation is still running.',
      ...(context ? { payload: context.payload, nextState: context.nextState } : {}),
    });
    this.updateDefinitionAfterEvaluation(automation, now, {
      nextMatch: automation.lastSuccessfulMatch,
      failureCount: automation.consecutiveEvaluationFailures,
    });
    this.eventProjector.emitCompatibilityEvaluationRun(automation, finished);
    return finished;
  }

  private async evaluateAndMaybeRun(
    automation: AutomationDefinition,
    context?: EvaluationContext,
    manual = false,
  ): Promise<AutomationEvaluation> {
    const startedAt = context ? new Date(context.occurredAt) : this.now();
    const running = this.createEvaluation(automation, startedAt);
    const actionRunning = this.listRuns(automation.id)
      .some((run) => run.status === 'queued' || run.status === 'running');
    const coolingDown = automation.lastTriggeredAt !== undefined
      && startedAt.getTime() < Date.parse(automation.lastTriggeredAt) + automation.policies.cooldownMs;
    const payload = context?.payload || {};
    let decision: ReturnType<typeof decideCondition>;
    try {
      const legacySnapshot = automation.originKind === 'automation-monitor'
        && automation.condition.kind === 'expression'
        && isPlainRecord(payload.eventSnapshot)
        ? payload.eventSnapshot as unknown as AutomationMonitorEventSnapshot
        : undefined;
      const evaluator = this.options.conditionEvaluator || (legacySnapshot
        ? ((condition: AutomationDefinition['condition']) => condition.kind === 'expression'
          ? { kind: 'evaluated' as const, matched: evaluateExpression(condition.expression, legacySnapshot) }
          : evaluateCondition(condition, payload))
        : evaluateCondition);
      decision = decideCondition({
        condition: automation.condition,
        payload,
        previous: (automation.condition.kind === 'always' || (automation.activation.kind === 'provider-event' && automation.activation.sourceType === 'webhook'))
          ? undefined
          : automation.lastSuccessfulMatch,
        coolingDown,
        actionRunning,
      }, evaluator);
    } catch (error) {
      const finishedAt = this.now();
      return this.finishError(
        automation,
        running,
        startedAt,
        finishedAt,
        normalizeAutomationError(error),
        context,
      );
    }
    const finishedAt = this.now();
    if (decision.kind === 'script-delegation') {
      return await this.handleScriptDelegationEvaluation({
        automation,
        running,
        startedAt,
        context,
        decision,
        coolingDown,
        actionRunning,
        manual,
      });
    }
    if (decision.conditionOutcome === 'error') {
      return this.finishError(
        automation,
        running,
        startedAt,
        finishedAt,
        normalizeAutomationError(decision.error || 'Condition evaluation failed.'),
        context,
      );
    }
    const finishDetails = {
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      ...(decision.triggerDecision === 'triggered' ? { triggeredAt: startedAt.toISOString() } : {}),
      payload,
      ...(context ? { nextState: context.nextState } : {}),
    };
    let finishInput: AutomationEvaluationFinishInput;
    if (decision.conditionOutcome === 'matched') {
      finishInput = { ...finishDetails, conditionOutcome: 'matched', triggerDecision: decision.triggerDecision };
    } else if (decision.conditionOutcome === 'not_matched') {
      finishInput = { ...finishDetails, conditionOutcome: 'not_matched', triggerDecision: 'not_rising' };
    } else {
      finishInput = { ...finishDetails, conditionOutcome: 'skipped', triggerDecision: decision.triggerDecision };
    }
    const finished = this.finishEvaluation(running.id, finishInput);
    const updated = this.updateDefinitionAfterEvaluation(automation, startedAt, {
      nextMatch: decision.nextMatch,
      failureCount: 0,
      triggered: decision.triggerDecision === 'triggered',
    });
    if (decision.triggerDecision === 'triggered') {
      const run = await this.executeAction(updated, finished, payload);
      if (!manual && updated.originKind === 'scheduled-job' && updated.activation.kind === 'once' && run.status === 'succeeded') {
        const disabled = this.options.store.updateAutomation(updated.id, { enabled: false });
        this.eventProjector.emitDefinition(disabled);
      }
    } else {
      this.eventProjector.emitCompatibilityEvaluationRun(updated, finished);
    }
    return finished;
  }

  private finishError(
    automation: AutomationDefinition,
    running: AutomationEvaluation,
    startedAt: Date,
    finishedAt: Date,
    error: string,
    context?: EvaluationContext,
    details?: { networkAudit?: Array<{ host: string; port?: number; allowed: boolean; timestamp: string }> },
  ): AutomationEvaluation {
    const finished = this.finishEvaluation(running.id, {
      conditionOutcome: 'error',
      triggerDecision: 'not_evaluated',
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      errorCategory: 'condition_evaluation',
      resultSummary: error,
      ...(context ? { payload: context.payload, nextState: context.nextState } : {}),
      ...(details?.networkAudit === undefined ? {} : { networkAudit: details.networkAudit }),
    });
    const count = automation.consecutiveEvaluationFailures + 1;
    const updated = this.updateDefinitionAfterEvaluation(automation, context ? startedAt : finishedAt, {
      nextMatch: automation.lastSuccessfulMatch,
      failureCount: count,
    });
    this.options.log?.(normalizeAutomationError(error, `automation evaluation failed ${automation.id} (${count}): `));
    if (FAILURE_ALERT_COUNTS.has(count)) this.options.alert?.({ automation: updated, count, error });
    this.eventProjector.emitCompatibilityEvaluationRun(updated, finished);
    return finished;
  }

  private async handleScriptDelegationEvaluation(input: {
    automation: AutomationDefinition;
    running: AutomationEvaluation;
    startedAt: Date;
    context?: EvaluationContext;
    decision: any;
    coolingDown: boolean;
    actionRunning: boolean;
    manual: boolean;
  }): Promise<AutomationEvaluation> {
    const { automation, running, startedAt, decision, coolingDown, actionRunning } = input;
    try {
      const previousEvaluation = this.getLatestEvaluationWithState(automation.id);
      const previousState = previousEvaluation?.status === 'finished' && previousEvaluation.nextState
        ? previousEvaluation.nextState
        : {};
      const scriptResult = await this.getScriptProtocolRunner().run({
        scriptId: decision.request.scriptId,
        approvedVersionId: decision.request.approvedVersionId,
        evaluationId: running.id,
        triggeredAt: startedAt.toISOString(),
        previousState,
      });
      const scriptDecision = decideTrigger({
        previous: (automation.condition.kind === 'always' || (automation.activation.kind === 'provider-event' && automation.activation.sourceType === 'webhook'))
          ? undefined
          : automation.lastSuccessfulMatch,
        matched: scriptResult.matched,
        coolingDown,
        actionRunning,
      });
      const scriptFinishedAt = this.now();
      const scriptPayload = scriptResult.payload || {};
      const scriptFinishDetails = {
        finishedAt: scriptFinishedAt.toISOString(),
        durationMs: Math.max(0, scriptFinishedAt.getTime() - startedAt.getTime()),
        ...(scriptDecision.triggerDecision === 'triggered' ? { triggeredAt: startedAt.toISOString() } : {}),
        payload: scriptPayload,
        ...(scriptResult.nextState === undefined ? {} : { nextState: scriptResult.nextState }),
        stdout: scriptResult.stdout,
        stderr: scriptResult.stderr,
        exitCode: scriptResult.exitCode === null ? undefined : scriptResult.exitCode,
        outputTruncated: scriptResult.outputTruncated,
        ...(scriptResult.networkAudit === undefined ? {} : { networkAudit: scriptResult.networkAudit }),
        ...(scriptResult.summary === undefined ? {} : { resultSummary: scriptResult.summary }),
      };
      const scriptFinished = this.finishEvaluation(running.id, scriptDecision.conditionOutcome === 'matched'
        ? { ...scriptFinishDetails, conditionOutcome: 'matched', triggerDecision: scriptDecision.triggerDecision }
        : { ...scriptFinishDetails, conditionOutcome: 'not_matched', triggerDecision: 'not_rising' });
      const updated = this.updateDefinitionAfterEvaluation(automation, startedAt, {
        nextMatch: scriptDecision.nextMatch,
        failureCount: 0,
        triggered: scriptDecision.triggerDecision === 'triggered',
      });
      if (scriptDecision.triggerDecision === 'triggered') {
        await this.executeAction(updated, scriptFinished, scriptPayload);
      } else {
        this.eventProjector.emitCompatibilityEvaluationRun(updated, scriptFinished);
      }
      return scriptFinished;
    } catch (error) {
      const message = normalizeAutomationError(error);
      if (error instanceof ScriptProtocolError && error.blockAutomation) this.blockAutomation(automation, message);
      return this.finishError(automation, running, startedAt, this.now(), message, undefined,
        error instanceof ScriptProtocolError ? { networkAudit: error.networkAudit } : undefined);
    }
  }

  private getScriptProtocolRunner(): Pick<ScriptProtocolRunner, 'run'> {
    if (!this.scriptProtocolRunner) {
      this.scriptProtocolRunner = new ScriptProtocolRunner({
        sandbox: createAnthropicSandboxRunner(),
        getVersion: (versionId) => this.options.store.getAutomationScriptVersion(versionId),
      });
    }
    return this.scriptProtocolRunner;
  }

  private getScriptTestRunner(): Pick<ScriptProtocolRunner, 'runTest'> {
    if (!this.scriptProtocolRunner?.runTest) {
      this.scriptProtocolRunner = new ScriptProtocolRunner({
        sandbox: createAnthropicSandboxRunner(),
        getVersion: (versionId) => this.options.store.getAutomationScriptVersion(versionId),
      });
    }
    return this.scriptProtocolRunner as Pick<ScriptProtocolRunner, 'runTest'>;
  }

  private blockAutomation(automation: AutomationDefinition, reason: string) {
    const blocked = this.options.store.updateAutomationState(automation.id, {
      health: 'blocked',
      blockedReason: normalizeAutomationError(reason),
    });
    this.eventProjector.emitDefinition(blocked);
  }

  private async executeAction(
    automation: AutomationDefinition,
    evaluation: AutomationEvaluation,
    payload: Record<string, unknown>,
  ): Promise<AutomationRun> {
    let run = this.options.store.createAutomationRun(automation.id, evaluation.id);
    this.eventProjector.emitRun(run);
    const startedAt = this.now().toISOString();
    run = this.options.store.updateAutomationRun(run.id, { status: 'running', startedAt });
    this.eventProjector.emitRun(run);
    const promptVariables = {
      title: automation.title,
      timestamp: evaluation.status === 'finished' ? evaluation.finishedAt : startedAt,
      evaluationId: evaluation.id,
      ...payload,
    };
    try {
      const result = await this.options.actionExecutor.execute({ automation, evaluation, promptVariables });
      run = this.options.store.updateAutomationRun(run.id, formatSuccessfulRunUpdate(result, this.now().toISOString()));
    } catch (error) {
      const message = normalizeAutomationError(error);
      run = this.options.store.updateAutomationRun(run.id, {
        status: 'failed',
        finishedAt: this.now().toISOString(),
        deliveryStatus: 'failed',
        error: message,
      });
      this.options.log?.(normalizeAutomationError(run.error, `automation action failed ${automation.id}: `));
    }
    this.eventProjector.emitRun(run);
    return run;
  }

  private createEvaluation(automation: AutomationDefinition, now: Date): AutomationEvaluation {
    const evaluation = this.options.store.createAutomationEvaluation(automation.id, {
      activationKind: automation.activation.kind,
      ...(automation.condition.kind === 'approved-script'
        ? { scriptVersionId: automation.condition.approvedVersionId }
        : {}),
      startedAt: now.toISOString(),
    });
    this.eventProjector.emitEvaluation(evaluation);
    return evaluation;
  }

  private finishEvaluation(
    evaluationId: string,
    input: Parameters<LocalCoreAcpStore['finishAutomationEvaluation']>[1],
  ): AutomationEvaluation {
    const evaluation = this.options.store.finishAutomationEvaluation(evaluationId, input);
    this.eventProjector.emitEvaluation(evaluation);
    return evaluation;
  }

  private updateDefinitionAfterEvaluation(
    automation: AutomationDefinition,
    now: Date,
    input: { nextMatch: boolean | undefined; failureCount: number; triggered?: boolean },
  ): AutomationDefinition {
    const next = nextActivationAt(automation.activation, now);
    const updated = this.options.store.updateAutomationState(automation.id, {
      ...(input.nextMatch === undefined ? {} : { lastSuccessfulMatch: input.nextMatch }),
      lastEvaluationAt: now.toISOString(),
      ...(input.triggered ? { lastTriggeredAt: now.toISOString() } : {}),
      consecutiveEvaluationFailures: input.failureCount,
      nextCheckAt: next?.toISOString() || null,
    });
    this.eventProjector.emitDefinition(updated);
    return updated;
  }

  private persistInitialNextCheck(
    automation: AutomationDefinition,
    replace = false,
    activationReplaced = false,
  ): AutomationDefinition {
    if (!replace && this.options.store.getAutomationNextCheckAt(automation.id) !== null) return automation;
    return this.options.store.updateAutomationState(automation.id, {
      nextCheckAt: calculateInitialNextCheckAt(automation, this.now(), activationReplaced),
    });
  }

  private requireAutomation(automationId: string): AutomationDefinition {
    const automation = this.get(automationId);
    if (!automation) throw new Error(`Automation not found: ${automationId}`);
    return automation;
  }

  private now(): Date {
    const now = (this.options.clock || (() => new Date()))();
    if (!Number.isFinite(now.getTime())) throw new Error('Automation clock returned an invalid date.');
    return new Date(now);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    (this.options.clearInterval || clearInterval)(this.timer as ReturnType<typeof setInterval>);
    this.timer = undefined;
  }

  private runTimerTick(generation: number): void {
    if (!this.isActiveGeneration(generation)) return;
    void this.tick().catch((error) => this.handleTimerFailure(error, generation));
  }

  private handleTimerFailure(error: unknown, generation: number): void {
    const reason = normalizeAutomationError(error, 'Automation timer tick failed: ');
    if (this.isActiveGeneration(generation)) {
      try {
        this.clearTimer();
      } catch {
        this.timer = undefined;
      }
      this.runtimeStatus = { status: 'degraded', reason };
    }
    this.eventProjector.reportDiagnostic('timer-tick', reason);
  }

  private isActiveGeneration(generation: number): boolean {
    return generation === this.lifecycleGeneration
      && !this.stopping
      && this.runtimeStatus.status === 'running';
  }

  private async settleActiveWork(): Promise<void> {
    const tick = this.tickPromise;
    if (tick) await Promise.allSettled([tick]);
    await Promise.allSettled([...this.inFlight.values()]);
  }
}

// Public API preserved for existing consumers (e.g. automation-monitor-service).
export { PROVIDER_LIFECYCLE_BLOCK_PREFIX, normalizeAutomationError, normalizeProviderEventSnapshot, providerLifecycleBlockReason } from './automation-event-utils.js';
