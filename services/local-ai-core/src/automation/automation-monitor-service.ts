import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AutomationMonitor,
  AutomationMonitorCreateInput,
  AutomationMonitorEventSnapshot,
  AutomationMonitorRun,
  AutomationMonitorSchedule,
  AutomationMonitorUpdateInput,
  ScheduledJobRoute,
} from '@cc/superai-contracts';
import type { ChannelRuntime, EventBus, MonitorProviderRuntime } from '@cc/plugin-sdk';
import type { LocalCoreAcpStore } from '../acp/local-core-acp-store.js';
import type { WorkspaceRouter } from '../router/workspace-router.js';
import {
  assertSupportedTimezone,
  compileCronExpression,
  cronMatchesFields,
  extractFieldsInTimezone,
} from '../scheduler/cron.js';
import {
  routeFromPlatformThreadBinding,
  routeWithPlatformInstance,
  scheduledJobMatchesPlatformBinding,
  withoutThreadRoute,
} from '../scheduler/scheduled-job-route.js';
import {
  automationToMonitor,
  automationToMonitorRun,
  latestAutomationRun,
  latestFinishedEvaluation,
  monitorToAutomationInput,
} from './legacy-automation-mappers.js';
import type { AutomationService } from './automation-service.js';
import { automationMonitorToScheduledJob } from './automation-schedule-utils.js';
import {
  normalizeAutomationError,
  normalizeProviderEventSnapshot,
  PROVIDER_LIFECYCLE_BLOCK_PREFIX,
  providerLifecycleBlockReason,
} from './automation-service.js';
import { toPublicAutomationMonitorId } from './monitor-id.js';

type ResolvedAutomationMonitorCreateInput = AutomationMonitorCreateInput & {
  platform: NonNullable<AutomationMonitorCreateInput['platform']>;
  route: NonNullable<AutomationMonitorCreateInput['route']>;
};

// A monitor with a schedule only polls when the current wall clock (in the schedule's
// timezone) matches the cron expression. Stored schedules are validated on create/update,
// so fail-open here would only trigger on corrupted state — degrading to always-poll is
// safer for a monitoring tool than silently dropping evaluations.
export function isMonitorWithinSchedule(schedule: AutomationMonitorSchedule | undefined, now: Date): boolean {
  if (!schedule) return true;
  try {
    const compiled = compileCronExpression(schedule.cron);
    return cronMatchesFields(compiled, extractFieldsInTimezone(now, schedule.timezone));
  } catch {
    return true;
  }
}

type AutomationMonitorServiceOptions = {
  store: LocalCoreAcpStore;
  automations: AutomationService;
  providers: MonitorProviderRuntime[];
  getWorkspaceRouter?: () => WorkspaceRouter;
  getChannelRuntime?: (platform: string) => ChannelRuntime | undefined;
  eventBus: EventBus;
  log?: (message: string) => void;
  setInterval?: (handler: () => void, delayMs: number) => NodeJS.Timeout;
  clearInterval?: (handle: NodeJS.Timeout) => void;
};
const PROVIDER_EVENT_CONCURRENCY = 4;
type MonitorLifecycleState = 'starting' | 'running' | 'stopping' | 'stopped';

export class WebhookTriggerError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 404) {
    super(message);
    this.name = 'WebhookTriggerError';
  }
}

// Hashing both sides first keeps the comparison constant-time regardless of
// token length, so a wrong-length guess cannot short-circuit or throw.
function webhookTokenEquals(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export class AutomationMonitorService {
  private timer: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private tickPromise: Promise<void> | undefined;
  private lifecycleState: MonitorLifecycleState = 'stopped';
  private lifecycleGeneration = 0;
  private providerEventsInFlight = 0;
  private readonly providerEventWaiters: Array<(admitted: boolean) => void> = [];
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly subscriptionHandles = new Map<string, { stop(): Promise<void> | void }>();
  private readonly handleLifecycleGenerations = new Map<string, number>();
  private readonly subscriptionGenerations = new Map<string, number>();
  private readonly providers = new Map<string, MonitorProviderRuntime>();

  constructor(private readonly options: AutomationMonitorServiceOptions) {
    for (const provider of options.providers) this.providers.set(provider.sourceType, provider);
  }

  start(): Promise<void> {
    if (this.lifecycleState === 'stopping') {
      return (this.stopPromise || Promise.resolve()).then(() => this.start());
    }
    if (this.startPromise) return this.startPromise;
    if (this.lifecycleState === 'running') return Promise.resolve();
    const generation = ++this.lifecycleGeneration;
    this.lifecycleState = 'starting';
    const work = this.startInternal(generation).catch((error) => {
      if (this.lifecycleGeneration === generation) {
        if (this.timer) (this.options.clearInterval || clearInterval)(this.timer);
        this.timer = null;
        this.lifecycleState = 'stopped';
      }
      throw error;
    });
    let shared!: Promise<void>;
    shared = work.finally(() => {
      if (this.startPromise === shared) this.startPromise = undefined;
      if (this.lifecycleGeneration === generation && this.lifecycleState === 'starting') {
        this.lifecycleState = 'stopped';
      }
    });
    this.startPromise = shared;
    return shared;
  }

  private async startInternal(generation: number): Promise<void> {
    if (this.options.automations.getRuntimeStatus().status === 'degraded') {
      if (this.isCurrentLifecycle(generation, 'starting')) this.lifecycleState = 'stopped';
      this.reportProviderError('start', new Error('Unified automation migration is unavailable.'));
      return;
    }
    await this.refreshSubscriptions(generation);
    if (!this.isCurrentLifecycle(generation, 'starting')) return;
    this.lifecycleState = 'running';
    await this.tick(false, generation);
    if (!this.isCurrentLifecycle(generation, 'running')) return;
    this.timer = (this.options.setInterval || setInterval)(() => {
      if (!this.isCurrentLifecycle(generation, 'running')) return;
      void this.tick(true, generation).catch((error) => this.reportProviderError('interval', error));
    }, 30_000);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (
      this.lifecycleState === 'stopped'
      && this.subscriptionHandles.size === 0
      && this.inFlight.size === 0
      && !this.startPromise
    ) return Promise.resolve();
    const starting = this.startPromise;
    const generation = ++this.lifecycleGeneration;
    this.lifecycleState = 'stopping';
    if (this.timer) (this.options.clearInterval || clearInterval)(this.timer);
    this.timer = null;
    this.handleLifecycleGenerations.clear();
    for (const monitorId of this.subscriptionHandles.keys()) {
      this.subscriptionGenerations.set(monitorId, (this.subscriptionGenerations.get(monitorId) || 0) + 1);
    }
    for (const waiter of this.providerEventWaiters.splice(0)) waiter(false);
    const work = this.stopInternal(starting);
    let shared!: Promise<void>;
    shared = work.finally(() => {
      if (this.stopPromise === shared) this.stopPromise = undefined;
      if (this.lifecycleGeneration === generation && this.lifecycleState === 'stopping') {
        this.lifecycleState = 'stopped';
      }
    });
    this.stopPromise = shared;
    return shared;
  }

  private async stopInternal(starting: Promise<void> | undefined): Promise<void> {
    if (starting) await Promise.allSettled([starting]);
    await this.settleInFlight();
    const handles = [...this.subscriptionHandles.entries()];
    const results = await Promise.allSettled(handles.map(([, handle]) => this.observeProviderWork(
      Promise.resolve().then(() => handle.stop()),
    )));
    results.forEach((result, index) => {
      const [monitorId, handle] = handles[index] || [];
      if (!monitorId || !handle) return;
      if (result.status === 'fulfilled') {
        if (this.subscriptionHandles.get(monitorId) === handle) {
          this.subscriptionHandles.delete(monitorId);
          this.handleLifecycleGenerations.delete(monitorId);
        }
      } else {
        this.reportProviderError(`stop:${monitorId}`, result.reason);
      }
    });
    await this.settleInFlight();
  }

  listMonitors(workspaceId?: string): AutomationMonitor[] {
    const automations = this.options.automations.list(workspaceId, 'automation-monitor');
    const latestEvaluationById = this.options.automations.listLatestFinishedEvaluationByOrigin(
      'automation-monitor',
      workspaceId,
    );
    const latestRunById = this.options.automations.listLatestRunByOrigin(
      'automation-monitor',
      workspaceId,
    );
    const latestEvaluationWithStateById = this.options.automations.listLatestEvaluationWithStateByOrigin(
      'automation-monitor',
      workspaceId,
    );
    return automations.map((automation) => automationToMonitor(
      automation,
      latestEvaluationById.get(automation.id),
      latestRunById.get(automation.id),
      latestEvaluationWithStateById.get(automation.id),
    ));
  }

  getMonitor(monitorId: string): AutomationMonitor | undefined {
    const resolved = this.resolveMonitorId(monitorId);
    const automation = resolved ? this.options.automations.get(resolved) : undefined;
    return automation?.originKind === 'automation-monitor'
      ? automationToMonitor(
        automation,
        latestFinishedEvaluation(this.options.automations.listEvaluations(automation.id)),
        latestAutomationRun(this.options.automations.listRuns(automation.id)),
        this.options.automations.getLatestEvaluationWithState(automation.id),
      )
      : undefined;
  }

  getMonitorByHookId(hookId: string): AutomationMonitor | undefined {
    const clean = String(hookId || '').trim();
    if (!clean) return undefined;
    return this.listMonitors().find((m) =>
      m.sourceType === 'webhook' && (m.sourceConfig?.hookId === clean || m.id === clean)
    );
  }

  private prepareMonitorInput(input: AutomationMonitorCreateInput): AutomationMonitorCreateInput {
    if (input.sourceType === 'webhook') {
      const sourceConfig = { ...(input.sourceConfig || {}) };
      if (!sourceConfig.hookId || typeof sourceConfig.hookId !== 'string' || !sourceConfig.hookId.trim()) {
        sourceConfig.hookId = `wh_${randomBytes(6).toString('hex')}`;
      }
      if (!sourceConfig.token || typeof sourceConfig.token !== 'string' || !sourceConfig.token.trim()) {
        sourceConfig.token = `whsec_${randomBytes(16).toString('hex')}`;
      }
      return { ...input, sourceConfig };
    }
    return input;
  }

  async createMonitor(input: AutomationMonitorCreateInput): Promise<AutomationMonitor> {
    const prepared = this.prepareMonitorInput(input);
    const resolved = this.resolveCreateInput(prepared);
    this.assertValidMonitorSchedule(resolved.schedule);
    this.providers.get(resolved.sourceType)?.validateConfig?.(resolved.sourceConfig || {});
    const mapped = monitorToAutomationInput(resolved);
    let monitor: AutomationMonitor | undefined;
    let persistedId: string | undefined;
    try {
      const persisted = this.options.automations.createFromLegacy(mapped);
      persistedId = persisted.id;
      monitor = automationToMonitor(persisted);
      await this.ensureSubscription(monitor);
      return monitor;
    } catch (error) {
      if (!persistedId) throw error;
      const message = this.lifecycleError(`create:${persistedId}`, error);
      if (this.subscriptionHandles.has(persistedId)) throw new Error(message);
      try {
        this.options.automations.delete(persistedId);
      } catch (cleanupError) {
        const cleanupMessage = this.lifecycleError(`create-cleanup:${persistedId}`, cleanupError);
        this.options.automations.failClosedLegacyAutomation(persistedId, `${message}; ${cleanupMessage}`);
      }
      throw new Error(message);
    }
  }

  async updateMonitor(monitorId: string, input: AutomationMonitorUpdateInput): Promise<AutomationMonitor> {
    this.options.automations.assertLegacyFacadesAvailable();
    const existing = this.getRequiredMonitor(monitorId);
    if (input.sourceConfig) this.providers.get(existing.sourceType)?.validateConfig?.(input.sourceConfig);
    this.assertValidMonitorSchedule(input.schedule === null ? undefined : input.schedule);
    const resolved = this.resolveCreateInput({
      workspaceId: existing.workspaceId,
      title: input.title ?? existing.title,
      sourceType: existing.sourceType,
      sourceConfig: input.sourceConfig ?? existing.sourceConfig,
      condition: input.condition ?? existing.condition,
      promptTemplate: input.promptTemplate ?? existing.promptTemplate,
      platform: existing.platform,
      route: input.route ? withoutThreadRoute(input.route) : existing.route,
      executionMode: input.executionMode ?? existing.executionMode,
      enabled: input.enabled ?? existing.enabled,
      cooldownMs: input.cooldownMs ?? existing.cooldownMs,
      schedule: input.schedule === undefined ? existing.schedule : input.schedule || undefined,
    });
    const mapped = monitorToAutomationInput(resolved);
    const { workspaceId: _workspaceId, originKind: _originKind, ...update } = mapped;
    if (input.sourceConfig) {
      return this.updateSourceConfigTransaction(existing, update, resolved.sourceConfig || {});
    }
    if (
      !existing.enabled
      && resolved.enabled
      && this.providers.get(existing.sourceType)?.startMonitor
    ) {
      return this.enableSubscriptionTransaction(existing, update, resolved.sourceConfig || {});
    }
    if (
      existing.enabled
      && !resolved.enabled
      && this.providers.get(existing.sourceType)?.startMonitor
    ) {
      return this.disableSubscriptionTransaction(existing, update);
    }
    const monitor = automationToMonitor(this.options.automations.updateFromLegacy(this.resolveRequiredMonitorId(monitorId), update));
    await this.ensureSubscription(monitor);
    return monitor;
  }

  async deleteMonitor(monitorId: string): Promise<{ deleted: boolean }> {
    this.options.automations.assertLegacyFacadesAvailable();
    const resolved = this.resolveRequiredMonitorId(monitorId);
    const existing = this.getRequiredMonitor(resolved);
    await this.stopSubscription(resolved);
    try {
      return this.options.automations.delete(resolved);
    } catch (error) {
      try {
        const restored = await this.startSubscriptionHandle(existing);
        if (restored) {
          this.installSubscriptionHandle(existing.id, restored);
          this.recoverSubscriptionHealth(existing.id);
        }
      } catch (restoreError) {
        const message = `${this.lifecycleError(`delete:${existing.id}`, error)}; ${this.lifecycleError(`delete-restore:${existing.id}`, restoreError)}`;
        this.options.automations.failClosedLegacyAutomation(existing.id, message);
      }
      throw new Error(this.lifecycleError(`delete:${existing.id}`, error));
    }
  }

  listRuns(monitorId: string) {
    const resolved = this.resolveRequiredMonitorId(monitorId);
    const runs = this.options.automations.listRuns(resolved);
    const runsByEvaluationId = new Map(runs.map((run) => [run.evaluationId, run]));
    return this.options.automations.listEvaluations(resolved).map((evaluation) =>
      automationToMonitorRun(evaluation, runsByEvaluationId.get(evaluation.id))
    );
  }

  async runMonitorNow(monitorId: string, event?: AutomationMonitorEventSnapshot) {
    this.options.automations.assertLegacyFacadesAvailable();
    const monitor = this.getRequiredMonitor(monitorId);
    const hasExplicitEvent = event !== undefined;
    const polled = hasExplicitEvent ? undefined : await this.pollMonitor(monitor, true);
    if (!hasExplicitEvent && !polled) throw new Error('Automation monitor changed while provider polling was in progress.');
    const snapshot = hasExplicitEvent ? event : polled?.event;
    this.options.automations.assertLegacyFacadesAvailable();
    if (!hasExplicitEvent && !snapshot) {
      const evaluation = this.options.automations.recordUnavailableProviderEvent(
        monitor.id,
        'No event snapshot is available for this monitor.',
      );
      return automationToMonitorRun(evaluation);
    }
    const evaluated = await this.evaluateEvent(monitor.id, snapshot as AutomationMonitorEventSnapshot, {
      kind: 'manual',
      ...(polled ? { token: polled.token } : {}),
    });
    if (!evaluated) throw new Error('Automation monitor changed before the provider event could be evaluated.');
    return evaluated;
  }

  async triggerWebhook(hookId: string, payload: unknown, token?: string): Promise<{
    success: boolean;
    monitorId: string;
    run: AutomationMonitorRun;
    decision: string;
  }> {
    const cleanHookId = String(hookId || '').trim();
    const monitor = this.getMonitorByHookId(cleanHookId);
    if (!monitor) {
      throw new WebhookTriggerError(`Webhook monitor not found: ${cleanHookId}`, 404);
    }
    if (!monitor.enabled) {
      throw new WebhookTriggerError(`Webhook monitor is disabled: ${cleanHookId}`, 400);
    }

    const expectedToken = String(monitor.sourceConfig?.token || '').trim();
    const cleanToken = String(token || '').trim();
    if (!cleanToken || !expectedToken || !webhookTokenEquals(cleanToken, expectedToken)) {
      throw new WebhookTriggerError('Invalid or missing webhook token.', 401);
    }

    const body = (typeof payload === 'object' && payload !== null)
      ? payload as Record<string, unknown>
      : { raw: payload };

    const event: AutomationMonitorEventSnapshot = {
      id: `evt_webhook_${Date.now()}_${randomBytes(4).toString('hex')}`,
      sourceType: 'webhook',
      occurredAt: new Date().toISOString(),
      subject: (typeof body.subject === 'string' ? body.subject : undefined)
        || (typeof body.event === 'string' ? body.event : undefined)
        || (typeof body.action === 'string' ? String(body.action) : undefined)
        || `Webhook:${cleanHookId}`,
      summary: (typeof body.summary === 'string' ? body.summary : undefined)
        || (typeof body.message === 'string' ? body.message : undefined)
        || `Inbound webhook triggered for ${cleanHookId}`,
      payload: body,
    };

    const run = await this.runMonitorNow(monitor.id, event);
    const latestEval = this.options.automations.listEvaluations(monitor.id)[0];
    const decision = latestEval?.conditionOutcome === 'not_matched'
      ? 'not_matched'
      : (latestEval?.triggerDecision ?? (run.status === 'succeeded' || run.status === 'running' || run.status === 'queued' ? 'triggered' : run.status));

    return {
      success: decision === 'triggered',
      monitorId: monitor.id,
      run,
      decision,
    };
  }

  listMonitorsForThread(threadId: string): AutomationMonitor[] {
    const binding = this.options.store.getPlatformThreadBindingByThreadId(threadId);
    return this.listMonitors().filter((monitor) =>
      monitor.route.threadId === threadId || (binding ? scheduledJobMatchesPlatformBinding(
        automationMonitorToScheduledJob(monitor),
        binding,
      ) : false)
    );
  }

  private tick(refreshSubscriptions = true, generation?: number): Promise<void> {
    if (generation !== undefined && !this.isCurrentLifecycle(generation, 'running')) return Promise.resolve();
    if (this.tickPromise) return this.tickPromise;
    const work = this.runTick(refreshSubscriptions, generation);
    let shared!: Promise<void>;
    shared = this.observeProviderWork(work).finally(() => {
      if (this.tickPromise === shared) this.tickPromise = undefined;
    });
    this.tickPromise = shared;
    return shared;
  }

  private async runTick(refreshSubscriptions: boolean, generation?: number): Promise<void> {
    try {
      if (refreshSubscriptions) await this.refreshSubscriptions(generation);
      if (generation !== undefined && !this.isCurrentLifecycle(generation, 'running')) return;
      const monitors = this.listMonitors().filter((candidate) =>
        candidate.enabled
        && !this.providers.get(candidate.sourceType)?.startMonitor
        && isMonitorWithinSchedule(candidate.schedule, new Date())
      );
      let index = 0;
      const worker = async () => {
        while (true) {
          const monitor = monitors[index++];
          if (!monitor) return;
          if (generation !== undefined && !this.isCurrentLifecycle(generation, 'running')) return;
          try {
            const polled = await this.pollMonitor(monitor, false, generation);
            if (generation !== undefined && !this.isCurrentLifecycle(generation, 'running')) return;
            if (polled?.event) await this.evaluateEvent(monitor.id, polled.event, {
              kind: 'poll', token: polled.token, lifecycleGeneration: generation,
            });
            if (generation !== undefined && !this.isCurrentLifecycle(generation, 'running')) return;
          } catch (error) {
            this.reportProviderError(`poll:${monitor.id}`, error);
          }
        }
      };
      await Promise.allSettled(Array.from(
        { length: Math.min(PROVIDER_EVENT_CONCURRENCY, monitors.length) },
        () => worker(),
      ));
    } finally {
      // tickPromise owns overlap and settlement state.
    }
  }

  private async pollMonitor(monitor: AutomationMonitor, manual: boolean, generation?: number) {
    if (this.lifecycleState === 'stopping') return undefined;
    const operationGeneration = this.lifecycleGeneration;
    if (generation !== undefined && !this.isCurrentLifecycle(generation, 'running')) return undefined;
    const provider = this.providers.get(monitor.sourceType);
    if (!provider?.poll) {
      if (manual) throw new Error(`No polling provider is available for monitor source "${monitor.sourceType}"`);
      return undefined;
    }
    const token = this.providerDefinitionToken(monitor.id);
    const event = await this.observeProviderWork(Promise.resolve(provider.poll({
      monitorId: monitor.id,
      workspaceId: monitor.workspaceId,
      sourceConfig: monitor.sourceConfig,
      lastState: monitor.lastState,
    })));
    if (operationGeneration !== this.lifecycleGeneration || this.isLifecycleStopping()) return undefined;
    if (generation !== undefined && !this.isCurrentLifecycle(generation, 'running')) return undefined;
    this.options.automations.assertLegacyFacadesAvailable();
    if (!this.isProviderDefinitionCurrent(monitor.id, token)) return undefined;
    return { event, token };
  }

  private evaluateEvent(
    monitorId: string,
    event: AutomationMonitorEventSnapshot,
    admission: { kind: 'manual'; token?: string }
      | { kind: 'subscription'; generation: number; lifecycleGeneration: number }
      | { kind: 'poll'; token: string; lifecycleGeneration?: number },
  ) {
    let snapshot: AutomationMonitorEventSnapshot;
    try {
      snapshot = normalizeProviderEventSnapshot(event);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.observeProviderWork(this.evaluateNormalizedEvent(monitorId, snapshot, admission));
  }

  private async evaluateNormalizedEvent(
    monitorId: string,
    event: AutomationMonitorEventSnapshot,
    admission: { kind: 'manual'; token?: string }
      | { kind: 'subscription'; generation: number; lifecycleGeneration: number }
      | { kind: 'poll'; token: string; lifecycleGeneration?: number },
  ) {
    const admitted = await this.acquireProviderEventPermit(admission.kind === 'manual'
      ? undefined
      : admission.lifecycleGeneration);
    if (!admitted) return undefined;
    try {
      if (
        admission.kind !== 'manual'
        && admission.lifecycleGeneration !== undefined
        && !this.isCurrentLifecycle(admission.lifecycleGeneration, 'running')
      ) return undefined;
      this.options.automations.assertLegacyFacadesAvailable();
      const definition = this.options.automations.get(monitorId);
      if (!definition || definition.activation.kind !== 'provider-event') return undefined;
      if (admission.kind === 'manual') {
        if (admission.token && !this.isProviderDefinitionCurrent(monitorId, admission.token)) return undefined;
      } else {
        if (!definition.enabled || definition.health === 'blocked') return undefined;
        if (
          admission.kind === 'subscription'
          && (
            this.subscriptionGenerations.get(monitorId) !== admission.generation
            || !this.subscriptionHandles.has(monitorId)
          )
        ) return undefined;
        if (admission.kind === 'poll' && !this.isProviderDefinitionCurrent(monitorId, admission.token)) return undefined;
      }
      const evaluation = await this.observeProviderWork(
        this.options.automations.evaluateProviderEvent(monitorId, event),
      );
      if (
        admission.kind !== 'manual'
        && admission.lifecycleGeneration !== undefined
        && !this.isCurrentLifecycle(admission.lifecycleGeneration, 'running')
      ) return undefined;
      const run = this.options.automations.listRuns(monitorId).find((candidate) => candidate.evaluationId === evaluation.id);
      return automationToMonitorRun(evaluation, run);
    } finally {
      this.releaseProviderEventPermit();
    }
  }

  private async acquireProviderEventPermit(generation?: number): Promise<boolean> {
    if (!this.canAdmitProviderWork(generation)) return false;
    if (this.providerEventsInFlight >= PROVIDER_EVENT_CONCURRENCY) {
      const admitted = await new Promise<boolean>((resolve) => this.providerEventWaiters.push(resolve));
      if (!admitted) return false;
    }
    if (!this.canAdmitProviderWork(generation)) return false;
    this.providerEventsInFlight += 1;
    return true;
  }

  private releaseProviderEventPermit(): void {
    this.providerEventsInFlight -= 1;
    this.providerEventWaiters.shift()?.(true);
  }

  private async refreshSubscriptions(generation?: number): Promise<void> {
    if (generation !== undefined && !this.isActiveLifecycle(generation)) return;
    const activeIds = new Set<string>();
    const work: Array<{ monitorId: string; kind: 'start' | 'stop'; run(): Promise<void> }> = [];
    for (const monitor of this.listMonitors().filter((candidate) => candidate.enabled)) {
      if (!this.providers.get(monitor.sourceType)?.startMonitor) continue;
      activeIds.add(monitor.id);
      if (!this.subscriptionHandles.has(monitor.id)) {
        work.push({ monitorId: monitor.id, kind: 'start', run: () => this.ensureSubscription(monitor, generation) });
      } else if (generation !== undefined) {
        this.handleLifecycleGenerations.set(monitor.id, generation);
      }
    }
    for (const monitorId of this.subscriptionHandles.keys()) {
      if (!activeIds.has(monitorId)) {
        work.push({ monitorId, kind: 'stop', run: () => this.stopSubscription(monitorId) });
      }
    }
    let index = 0;
    const worker = async () => {
      while (true) {
        const entry = work[index++];
        if (!entry) return;
        if (generation !== undefined && !this.isActiveLifecycle(generation)) return;
        try {
          await entry.run();
          if (generation !== undefined && !this.isActiveLifecycle(generation)) return;
        } catch (error) {
          if (generation !== undefined && !this.isActiveLifecycle(generation)) return;
          if (entry.kind === 'start') this.blockSubscription(entry.monitorId, error);
          this.reportProviderError(`subscription:${entry.monitorId}`, error);
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(PROVIDER_EVENT_CONCURRENCY, work.length) },
      () => worker(),
    ));
    if (generation !== undefined && !this.isActiveLifecycle(generation)) return;
  }

  private async ensureSubscription(monitor: AutomationMonitor, lifecycleGeneration?: number): Promise<void> {
    if (this.lifecycleState === 'stopping') return;
    if (lifecycleGeneration !== undefined && !this.isActiveLifecycle(lifecycleGeneration)) return;
    this.options.automations.assertLegacyFacadesAvailable();
    const provider = this.providers.get(monitor.sourceType);
    if (!monitor.enabled || !provider?.startMonitor) {
      await this.stopSubscription(monitor.id);
      if (lifecycleGeneration !== undefined && !this.isActiveLifecycle(lifecycleGeneration)) return;
      return;
    }
    if (this.subscriptionHandles.has(monitor.id)) {
      if (lifecycleGeneration !== undefined) this.handleLifecycleGenerations.set(monitor.id, lifecycleGeneration);
      this.recoverSubscriptionHealth(monitor.id);
      return;
    }
    const handle = await this.startSubscriptionHandle(monitor, lifecycleGeneration);
    if (lifecycleGeneration !== undefined && !this.isActiveLifecycle(lifecycleGeneration)) {
      if (handle) await this.stopProviderHandle(monitor.id, handle, 'stale-ensure');
      return;
    }
    if (handle) {
      this.installSubscriptionHandle(monitor.id, handle, lifecycleGeneration);
      this.recoverSubscriptionHealth(monitor.id);
    }
  }

  private async startSubscriptionHandle(monitor: AutomationMonitor, lifecycleGeneration?: number) {
    if (this.lifecycleState === 'stopping') return undefined;
    const operationGeneration = this.lifecycleGeneration;
    if (lifecycleGeneration !== undefined && !this.isActiveLifecycle(lifecycleGeneration)) return undefined;
    const provider = this.providers.get(monitor.sourceType);
    if (!monitor.enabled || !provider?.startMonitor) return undefined;
    const generation = (this.subscriptionGenerations.get(monitor.id) || 0) + 1;
    this.subscriptionGenerations.set(monitor.id, generation);
    const handle = await this.observeProviderWork(Promise.resolve(provider.startMonitor({
      monitorId: monitor.id,
      workspaceId: monitor.workspaceId,
      sourceConfig: monitor.sourceConfig,
      lastState: monitor.lastState,
      emit: async (event) => {
        try {
          const callbackLifecycleGeneration = this.handleLifecycleGenerations.get(monitor.id);
          if (
            callbackLifecycleGeneration === undefined
            || !this.isCurrentLifecycle(callbackLifecycleGeneration, 'running')
          ) return;
          const latest = this.getMonitor(monitor.id);
          const definition = this.options.automations.get(monitor.id);
          if (
            latest?.enabled
            && definition?.health !== 'blocked'
            && this.subscriptionHandles.has(monitor.id)
          ) {
            await this.evaluateEvent(latest.id, event, {
              kind: 'subscription', generation, lifecycleGeneration: callbackLifecycleGeneration,
            });
          }
        } catch (error) {
          this.reportProviderError(`event:${monitor.id}`, error);
        }
      },
    })));
    if (operationGeneration !== this.lifecycleGeneration || this.isLifecycleStopping()) {
      await this.stopProviderHandle(monitor.id, handle, 'stale-start');
      return undefined;
    }
    if (lifecycleGeneration !== undefined && !this.isActiveLifecycle(lifecycleGeneration)) {
      await this.stopProviderHandle(monitor.id, handle, 'stale-start');
      return undefined;
    }
    try {
      this.options.automations.assertLegacyFacadesAvailable();
    } catch (error) {
      try {
        await this.observeProviderWork(Promise.resolve().then(() => handle.stop()));
      } catch (stopError) {
        this.installSubscriptionHandle(monitor.id, handle, lifecycleGeneration);
        const message = `${this.lifecycleError(`degraded-start:${monitor.id}`, error)}; ${this.lifecycleError(`degraded-stop:${monitor.id}`, stopError)}`;
        this.options.automations.failClosedLegacyAutomation(monitor.id, message);
        this.reportProviderError(`degraded-stop:${monitor.id}`, stopError);
      }
      throw error;
    }
    return handle;
  }

  private async stopSubscription(monitorId: string): Promise<void> {
    const handle = this.subscriptionHandles.get(monitorId);
    if (!handle) return;
    await this.observeProviderWork(Promise.resolve().then(() => handle.stop()));
    if (this.subscriptionHandles.get(monitorId) === handle) {
      this.subscriptionHandles.delete(monitorId);
      this.handleLifecycleGenerations.delete(monitorId);
      this.subscriptionGenerations.set(monitorId, (this.subscriptionGenerations.get(monitorId) || 0) + 1);
    }
  }

  private async updateSourceConfigTransaction(
    existing: AutomationMonitor,
    update: Parameters<AutomationService['updateFromLegacy']>[1],
    sourceConfig: Record<string, unknown>,
  ): Promise<AutomationMonitor> {
    await this.stopSubscription(existing.id);
    const prospective = { ...existing, ...('enabled' in update ? { enabled: update.enabled ?? existing.enabled } : {}), sourceConfig };
    let nextHandle: Awaited<ReturnType<AutomationMonitorService['startSubscriptionHandle']>>;
    try {
      nextHandle = await this.startSubscriptionHandle(prospective);
    } catch (error) {
      if (!this.subscriptionHandles.has(existing.id)) {
        await this.restoreSubscriptionOrFailClosed(existing, error);
      }
      throw new Error(this.lifecycleError(`update-start:${existing.id}`, error));
    }
    try {
      if (nextHandle) this.installSubscriptionHandle(existing.id, nextHandle);
      const monitor = automationToMonitor(this.options.automations.updateFromLegacy(existing.id, update));
      this.recoverSubscriptionHealth(existing.id);
      return monitor;
    } catch (error) {
      if (nextHandle) {
        try {
          await this.stopSubscription(existing.id);
        } catch (stopError) {
          const message = `${this.lifecycleError(`update-persist:${existing.id}`, error)}; ${this.lifecycleError(`update-new-stop:${existing.id}`, stopError)}`;
          this.options.automations.failClosedLegacyAutomation(existing.id, message);
          throw new Error(message);
        }
      }
      await this.restoreSubscriptionOrFailClosed(existing, error);
      throw new Error(this.lifecycleError(`update-persist:${existing.id}`, error));
    }
  }

  private async enableSubscriptionTransaction(
    existing: AutomationMonitor,
    update: Parameters<AutomationService['updateFromLegacy']>[1],
    sourceConfig: Record<string, unknown>,
  ): Promise<AutomationMonitor> {
    let handle = this.subscriptionHandles.get(existing.id);
    if (!handle) {
      try {
        handle = await this.startSubscriptionHandle({ ...existing, enabled: true, sourceConfig });
      } catch (error) {
        throw new Error(this.lifecycleError(`enable-start:${existing.id}`, error));
      }
      if (handle) this.installSubscriptionHandle(existing.id, handle);
    }
    try {
      const monitor = automationToMonitor(this.options.automations.updateFromLegacy(existing.id, update));
      this.recoverSubscriptionHealth(existing.id);
      return monitor;
    } catch (error) {
      if (handle) {
        try {
          await this.stopSubscription(existing.id);
        } catch (stopError) {
          const message = `${this.lifecycleError(`enable-persist:${existing.id}`, error)}; ${this.lifecycleError(`enable-stop:${existing.id}`, stopError)}`;
          this.options.automations.failClosedLegacyAutomation(existing.id, message);
          throw new Error(message);
        }
      }
      this.options.automations.failClosedLegacyAutomation(existing.id, this.lifecycleError(`enable-persist:${existing.id}`, error));
      throw new Error(this.lifecycleError(`enable-persist:${existing.id}`, error));
    }
  }

  private async disableSubscriptionTransaction(
    existing: AutomationMonitor,
    update: Parameters<AutomationService['updateFromLegacy']>[1],
  ): Promise<AutomationMonitor> {
    try {
      await this.stopSubscription(existing.id);
    } catch (error) {
      throw new Error(this.lifecycleError(`disable-stop:${existing.id}`, error));
    }
    try {
      return automationToMonitor(this.options.automations.updateFromLegacy(existing.id, update));
    } catch (error) {
      await this.restoreSubscriptionOrFailClosed(existing, error);
      throw new Error(this.lifecycleError(`disable-persist:${existing.id}`, error));
    }
  }

  private async restoreSubscriptionOrFailClosed(existing: AutomationMonitor, cause: unknown): Promise<void> {
    try {
      const restored = await this.startSubscriptionHandle(existing);
      if (restored) {
        this.installSubscriptionHandle(existing.id, restored);
        this.recoverSubscriptionHealth(existing.id);
      }
    } catch (restoreError) {
      const message = `${this.lifecycleError(`subscription-transition:${existing.id}`, cause)}; ${this.lifecycleError(`subscription-restore:${existing.id}`, restoreError)}`;
      this.options.automations.failClosedLegacyAutomation(existing.id, message);
    }
  }

  private reportProviderError(scope: string, error: unknown): void {
    const message = this.lifecycleError(scope, error);
    try {
      this.options.log?.(`automation monitor provider ${scope} failed: ${message}`);
    } catch {
      // Provider diagnostics must not destabilize lifecycle isolation.
    }
  }

  private lifecycleError(scope: string, error: unknown): string {
    return normalizeAutomationError(error, `automation monitor provider ${scope} failed: `);
  }

  private blockSubscription(monitorId: string, error: unknown): void {
    const reason = providerLifecycleBlockReason(error);
    try {
      this.options.automations.assertLegacyFacadesAvailable();
      this.options.automations.markLegacyProviderLifecycleBlocked(monitorId, reason);
    } catch (healthError) {
      this.reportProviderError(`subscription-health:${monitorId}`, healthError);
    }
  }

  private recoverSubscriptionHealth(monitorId: string): void {
    const definition = this.options.automations.get(monitorId);
    const reason = definition?.health === 'blocked' ? definition.blockedReason : undefined;
    if (reason?.startsWith(PROVIDER_LIFECYCLE_BLOCK_PREFIX)) {
      this.options.automations.clearLegacyProviderLifecycleBlocked(monitorId, reason);
    }
  }

  private providerDefinitionToken(monitorId: string): string {
    const definition = this.options.automations.get(monitorId);
    if (!definition || definition.activation.kind !== 'provider-event') return '';
    return `${definition.updatedAt}\n${JSON.stringify(definition.activation.sourceConfig || {})}`;
  }

  private isProviderDefinitionCurrent(monitorId: string, token: string): boolean {
    return token !== '' && this.providerDefinitionToken(monitorId) === token;
  }

  private isCurrentLifecycle(generation: number, state: MonitorLifecycleState): boolean {
    return this.lifecycleGeneration === generation && this.lifecycleState === state;
  }

  private isActiveLifecycle(generation: number): boolean {
    return this.lifecycleGeneration === generation
      && (this.lifecycleState === 'starting' || this.lifecycleState === 'running');
  }

  private canAdmitProviderWork(generation?: number): boolean {
    return this.lifecycleState !== 'stopping'
      && (generation === undefined || this.isCurrentLifecycle(generation, 'running'));
  }

  private isLifecycleStopping(): boolean {
    return this.lifecycleState === 'stopping';
  }

  private installSubscriptionHandle(
    monitorId: string,
    handle: { stop(): Promise<void> | void },
    lifecycleGeneration = this.lifecycleGeneration,
  ): void {
    this.subscriptionHandles.set(monitorId, handle);
    if (this.lifecycleState === 'running' && lifecycleGeneration === this.lifecycleGeneration) {
      this.handleLifecycleGenerations.set(monitorId, lifecycleGeneration);
    } else {
      this.handleLifecycleGenerations.delete(monitorId);
    }
  }

  private async stopProviderHandle(
    monitorId: string,
    handle: { stop(): Promise<void> | void },
    scope: string,
  ): Promise<void> {
    try {
      await this.observeProviderWork(Promise.resolve().then(() => handle.stop()));
    } catch (error) {
      if (!this.subscriptionHandles.has(monitorId)) this.installSubscriptionHandle(monitorId, handle);
      this.reportProviderError(`${scope}:${monitorId}`, error);
    }
  }

  private observeProviderWork<T>(work: Promise<T>): Promise<T> {
    let observed!: Promise<T>;
    observed = work.finally(() => this.inFlight.delete(observed));
    this.inFlight.add(observed);
    return observed;
  }

  private async settleInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private assertValidMonitorSchedule(schedule: AutomationMonitorSchedule | undefined): void {
    if (!schedule) return;
    try {
      compileCronExpression(schedule.cron);
      assertSupportedTimezone(schedule.timezone);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Monitor schedule is invalid: ${message}`);
    }
  }

  private resolveCreateInput(input: AutomationMonitorCreateInput): ResolvedAutomationMonitorCreateInput {
    if (input.platform && input.route) {
      return { ...input, route: routeWithPlatformInstance(withoutThreadRoute(input.route), input.platform) } as ResolvedAutomationMonitorCreateInput;
    }
    const threadId = String(input.threadId || input.route?.threadId || '').trim();
    if (threadId) {
      const binding = this.options.store.getPlatformThreadBindingByThreadId(threadId);
      if (binding && binding.workspace_id === input.workspaceId) {
        return { ...input, platform: binding.platform, route: routeFromPlatformThreadBinding(binding) };
      }
    }
    return {
      ...input,
      platform: 'local',
      route: { type: 'local.thread', channelId: input.workspaceId } satisfies ScheduledJobRoute,
    };
  }

  private getRequiredMonitor(monitorId: string): AutomationMonitor {
    const monitor = this.getMonitor(monitorId);
    if (!monitor) throw new Error(`Automation monitor not found: ${monitorId}`);
    return monitor;
  }

  private resolveMonitorId(monitorId: string): string {
    const direct = this.options.automations.get(monitorId);
    if (direct?.originKind === 'automation-monitor') return direct.id;
    const matches = this.options.automations.list().filter((automation) =>
      automation.originKind === 'automation-monitor' && toPublicAutomationMonitorId(automation.id) === monitorId
    );
    if (matches.length > 1) throw new Error(`Automation monitor id is ambiguous: ${monitorId}`);
    return matches[0]?.id || '';
  }

  private resolveRequiredMonitorId(monitorId: string): string {
    const resolved = this.resolveMonitorId(monitorId);
    if (!resolved) throw new Error(`Automation monitor not found: ${monitorId}`);
    return resolved;
  }
}
