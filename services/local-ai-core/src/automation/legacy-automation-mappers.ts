import type {
  AutomationCreateInput,
  AutomationDefinition,
  AutomationEvaluation,
  AutomationMonitor,
  AutomationMonitorCondition,
  AutomationMonitorCreateInput,
  AutomationMonitorEventSnapshot,
  AutomationMonitorRun,
  AutomationRun,
  ScheduledJob,
  ScheduledJobCreateInput,
  ScheduledJobRun,
} from '@cc/superai-contracts';
import {
  normalizeAutomationMonitorConditionOperator,
  normalizeScheduledJobExecutionMode,
  normalizeScheduledJobTriggerType,
} from '@cc/superai-contracts';
import { assertSupportedTimezone, isValidTimezone } from '../scheduler/cron.js';
import { validateRestrictedExpression } from './condition-evaluator.js';

// The timezone used for cron expressions created through the legacy scheduler facade.
// The old SchedulerService interpreted cron in the server's local wall clock, so we
// default to the host's IANA timezone (falling back to UTC) to preserve that behavior.
// Resolves lazily so environments without full IANA data still boot.
let defaultTimezone: string | undefined;
function resolveDefaultTimezone(): string {
  if (defaultTimezone) return defaultTimezone;
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    defaultTimezone = detected && isValidTimezone(detected) ? detected : 'UTC';
  } catch {
    defaultTimezone = 'UTC';
  }
  return defaultTimezone;
}

/** Override the default timezone used for legacy cron jobs (e.g. from runtime config). */
export function setDefaultTimezone(timezone: string): void {
  assertSupportedTimezone(timezone);
  defaultTimezone = timezone;
}

type ResolvedScheduledJobInput = ScheduledJobCreateInput & {
  platform: NonNullable<ScheduledJobCreateInput['platform']>;
  route: NonNullable<ScheduledJobCreateInput['route']>;
};

type ResolvedMonitorInput = AutomationMonitorCreateInput & {
  platform: NonNullable<AutomationMonitorCreateInput['platform']>;
  route: NonNullable<AutomationMonitorCreateInput['route']>;
};

export type LegacyAutomationCreateInput = AutomationCreateInput & {
  originKind: 'scheduled-job' | 'automation-monitor';
  legacyMetadata?: AutomationDefinition['legacyMetadata'];
};

export function scheduledJobToAutomationInput(input: ResolvedScheduledJobInput): LegacyAutomationCreateInput {
  const triggerType = normalizeScheduledJobTriggerType(input.triggerType);
  const activation = triggerType === 'once'
    ? { kind: 'once' as const, runAt: requireText(input.runAt, 'Scheduled job runAt') }
      : triggerType === 'cron'
      ? { kind: 'cron' as const, expression: requireText(input.cronExpr, 'Scheduled job cronExpr'), timezone: resolveDefaultTimezone() }
      : fail(`Unsupported scheduled job trigger type: ${triggerType}`);
  return {
    workspaceId: requireText(input.workspaceId, 'Scheduled job workspaceId'),
    title: String(input.description || '').trim() || requireText(input.promptTemplate, 'Scheduled job promptTemplate'),
    enabled: input.enabled !== false,
    activation,
    condition: { kind: 'always' },
    action: {
      kind: 'agent-prompt',
      promptTemplate: requireText(input.promptTemplate, 'Scheduled job promptTemplate'),
      executionMode: legacyExecutionMode(input.executionMode, 'same-thread'),
    },
    delivery: { platform: requireText(input.platform, 'Scheduled job platform'), route: input.route },
    policies: { concurrency: 'skip-if-running', cooldownMs: 0 },
    originKind: 'scheduled-job',
    legacyMetadata: { scheduledDescription: input.description ?? '' },
  };
}

export function automationToScheduledJob(automation: AutomationDefinition, latestRun?: AutomationRun): ScheduledJob {
  assertOrigin(automation, 'scheduled-job');
  if (automation.condition.kind !== 'always') throw new Error('Scheduled-job automation condition must be always.');
  if (automation.activation.kind !== 'cron' && automation.activation.kind !== 'once') {
    throw new Error('Scheduled-job automation activation must be cron or once.');
  }
  return {
    id: automation.id,
    workspaceId: automation.workspaceId,
    platform: automation.delivery.platform,
    route: automation.delivery.route,
    executionMode: automation.action.executionMode,
    triggerType: automation.activation.kind,
    ...(automation.activation.kind === 'cron' ? { cronExpr: automation.activation.expression } : { runAt: automation.activation.runAt }),
    promptTemplate: automation.action.promptTemplate,
    description: automation.legacyMetadata?.scheduledDescription ?? automation.title,
    enabled: automation.enabled,
    concurrencyPolicy: 'skip_if_running',
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    ...(latestRun?.finishedAt || latestRun?.startedAt || automation.lastEvaluationAt
      ? { lastRunAt: latestRun?.finishedAt || latestRun?.startedAt || automation.lastEvaluationAt }
      : {}),
    ...(latestRun ? { lastStatus: latestRun.status } : {}),
    ...(latestRun?.error ? { lastError: latestRun.error } : {}),
  };
}

export function monitorToAutomationInput(input: ResolvedMonitorInput): LegacyAutomationCreateInput {
  return {
    workspaceId: requireText(input.workspaceId, 'Automation monitor workspaceId'),
    title: requireText(input.title, 'Automation monitor title'),
    enabled: input.enabled !== false,
    activation: {
      kind: 'provider-event',
      sourceType: requireText(input.sourceType, 'Automation monitor sourceType'),
      sourceConfig: input.sourceConfig || {},
      ...(input.schedule ? { schedule: input.schedule } : {}),
    },
    condition: { kind: 'expression', expression: monitorConditionExpression(input.condition) },
    action: {
      kind: 'agent-prompt',
      promptTemplate: requireText(input.promptTemplate, 'Automation monitor promptTemplate'),
      executionMode: legacyExecutionMode(input.executionMode, 'side-thread'),
      ...(input.workflowTemplate ? { workflowTemplate: input.workflowTemplate } : {}),
      ...(input.retrospectiveDelayHours !== undefined && input.retrospectiveDelayHours !== null
        ? { retrospectiveDelayHours: input.retrospectiveDelayHours }
        : {}),
    },
    delivery: { platform: requireText(input.platform, 'Automation monitor platform'), route: input.route },
    policies: { concurrency: 'skip-if-running', cooldownMs: input.cooldownMs ?? 15 * 60 * 1_000 },
    originKind: 'automation-monitor',
  };
}

export function automationToMonitor(
  automation: AutomationDefinition,
  latestEvaluation?: AutomationEvaluation,
  latestRun?: AutomationRun,
  latestStateEvaluation?: AutomationEvaluation,
): AutomationMonitor {
  assertOrigin(automation, 'automation-monitor');
  if (automation.activation.kind !== 'provider-event') {
    throw new Error('Automation-monitor automation activation must be provider-event.');
  }
  if (automation.condition.kind !== 'expression') {
    throw new Error('Automation-monitor automation condition must be expression.');
  }
  const stateEvaluation = latestStateEvaluation || latestEvaluation;
  const lastState = stateEvaluation?.status === 'finished' ? stateEvaluation.nextState : undefined;
  const latestEvaluationStatus = latestEvaluation && latestRun?.evaluationId !== latestEvaluation.id
    ? evaluationStatus(latestEvaluation)
    : undefined;
  return {
    id: automation.id,
    workspaceId: automation.workspaceId,
    title: automation.title,
    sourceType: automation.activation.sourceType,
    sourceConfig: automation.activation.sourceConfig,
    condition: expressionToMonitorCondition(automation.condition.expression),
    promptTemplate: automation.action.promptTemplate,
    platform: automation.delivery.platform,
    route: automation.delivery.route,
    executionMode: automation.action.executionMode,
    enabled: automation.enabled,
    cooldownMs: automation.policies.cooldownMs,
    concurrencyPolicy: 'skip_if_running',
    ...(automation.action.workflowTemplate ? { workflowTemplate: automation.action.workflowTemplate } : {}),
    ...(automation.action.retrospectiveDelayHours !== undefined ? { retrospectiveDelayHours: automation.action.retrospectiveDelayHours } : {}),
    ...(automation.activation.schedule ? { schedule: automation.activation.schedule } : {}),
    ...(lastState ? { lastState } : {}),
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    ...(automation.lastTriggeredAt ? { lastTriggeredAt: automation.lastTriggeredAt } : {}),
    ...(latestEvaluationStatus ? { lastStatus: latestEvaluationStatus } : latestRun ? { lastStatus: latestRun.status } : {}),
    ...(latestEvaluation?.status === 'finished' && latestEvaluation.conditionOutcome === 'error' && latestEvaluation.resultSummary
      ? { lastError: latestEvaluation.resultSummary }
      : latestRun?.error
      ? { lastError: latestRun.error }
      : automation.consecutiveEvaluationFailures > 0 && latestEvaluation?.status === 'finished' && latestEvaluation.resultSummary
        ? { lastError: latestEvaluation.resultSummary }
        : {}),
  };
}

export function automationToScheduledJobRun(
  evaluation: AutomationEvaluation,
  run?: AutomationRun,
): ScheduledJobRun {
  const status = run?.status || evaluationStatus(evaluation);
  const evaluationError = !run && evaluation.status === 'finished'
    && (evaluation.conditionOutcome === 'skipped' || evaluation.conditionOutcome === 'error')
    ? evaluation.resultSummary
    : undefined;
  return {
    id: run?.id || evaluation.id,
    jobId: evaluation.automationId,
    status,
    triggeredAt: evaluation.status === 'finished' ? evaluation.triggeredAt || evaluation.startedAt : evaluation.startedAt,
    ...(run?.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run?.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run?.error || evaluationError
      ? { error: run?.error || evaluationError, deliveryError: run?.error || evaluationError }
      : {}),
    ...(run?.threadId ? { threadId: run.threadId } : {}),
    ...(run?.acpRunId ? { runId: run.acpRunId } : {}),
    ...(legacyDeliveryMode(run?.bridgeActivity?.deliveryMode) ? { deliveryMode: legacyDeliveryMode(run?.bridgeActivity?.deliveryMode) } : {}),
    ...(run?.deliveryStatus
      ? { deliveryStatus: legacyDeliveryStatus(run.deliveryStatus) }
      : evaluationError ? { deliveryStatus: status === 'failed' ? 'failed' as const : 'skipped' as const } : {}),
    ...(typeof run?.bridgeActivity?.lastBridgeEventAt === 'string'
      ? { lastBridgeEventAt: run.bridgeActivity.lastBridgeEventAt }
      : {}),
  };
}

export function automationToMonitorRun(
  evaluation: AutomationEvaluation,
  run?: AutomationRun,
): AutomationMonitorRun {
  const payload = evaluation.status === 'finished' ? evaluation.payload : undefined;
  const eventSnapshot = payload?.eventSnapshot ? parseEventSnapshot(payload.eventSnapshot) : undefined;
  const evaluationError = resolveEvaluationError(evaluation, run);
  const status = run?.status || evaluationStatus(evaluation);
  const deliveryStatus = resolveEvaluationDeliveryStatus(run, evaluationError, status);
  const deliveryMode = legacyDeliveryMode(run?.bridgeActivity?.deliveryMode);
  return {
    id: run?.id || evaluation.id,
    monitorId: evaluation.automationId,
    status,
    triggeredAt: eventSnapshot?.occurredAt || (evaluation.status === 'finished' ? evaluation.triggeredAt : undefined) || evaluation.startedAt,
    ...(run?.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run?.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(evaluationError ? { error: evaluationError, deliveryError: evaluationError } : {}),
    ...(eventSnapshot ? { eventSnapshot } : {}),
    ...(run?.threadId ? { threadId: run.threadId } : {}),
    ...(run?.acpRunId ? { runId: run.acpRunId } : {}),
    ...(deliveryMode ? { deliveryMode } : {}),
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(typeof run?.bridgeActivity?.lastBridgeEventAt === 'string'
      ? { lastBridgeEventAt: run.bridgeActivity.lastBridgeEventAt }
      : {}),
  };
}

function resolveEvaluationError(evaluation: AutomationEvaluation, run?: AutomationRun): string | undefined {
  if (run?.error) {
    return run.error;
  }
  if (!run && evaluation.status === 'finished' && (evaluation.conditionOutcome === 'skipped' || evaluation.conditionOutcome === 'error')) {
    return evaluation.resultSummary;
  }
  return undefined;
}

function resolveEvaluationDeliveryStatus(run: AutomationRun | undefined, evaluationError: string | undefined, status: string) {
  if (run?.deliveryStatus) {
    return legacyDeliveryStatus(run.deliveryStatus);
  }
  if (evaluationError) {
    return status === 'failed' ? ('failed' as const) : ('skipped' as const);
  }
  return undefined;
}

export function latestFinishedEvaluation(evaluations: AutomationEvaluation[]): AutomationEvaluation | undefined {
  return evaluations.find((evaluation) => evaluation.status === 'finished');
}

export function latestAutomationRun(runs: AutomationRun[]): AutomationRun | undefined {
  return runs[0];
}

function monitorConditionExpression(condition: AutomationMonitorCondition): string {
  if (condition.metric === 'always' || condition.expression?.trim() === 'always') {
    return 'always';
  }
  const operator = normalizeAutomationMonitorConditionOperator(condition.operator);
  if (typeof condition.value !== 'number' && typeof condition.value !== 'string' && typeof condition.value !== 'boolean') {
    throw new Error('Automation monitor condition value must be a number, string, or boolean.');
  }
  if (condition.expression?.trim()) {
    const expression = condition.expression.trim();
    validateRestrictedExpression(expression);
    return expression;
  }
  const metric = requireText(condition.metric, 'Automation monitor condition metric');
  const expression = `${metric} ${operator} ${JSON.stringify(condition.value)}`;
  validateRestrictedExpression(expression);
  return expression;
}

function expressionToMonitorCondition(expression: string): AutomationMonitorCondition {
  if (expression.trim() === 'always') {
    return { metric: 'always', operator: '==', value: true, expression: 'always' };
  }
  if (expression.includes('&&') || expression.includes('||')) {
    return { metric: 'expression', operator: '==', value: true, expression };
  }
  const match = expression.trim().match(/^([a-zA-Z0-9_.-]+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
  if (!match) return { metric: 'expression', operator: '==', value: true, expression };
  const raw = match[3]!.trim();
  let value: number | string | boolean = raw.replace(/^["']|["']$/g, '');
  if (raw === 'true' || raw === 'false') value = raw === 'true';
  else if (raw !== '' && Number.isFinite(Number(raw))) value = Number(raw);
  return {
    metric: match[1]!,
    operator: parseMonitorOperator(match[2]),
    value,
  };
}

function evaluationStatus(evaluation: AutomationEvaluation): ScheduledJobRun['status'] {
  if (evaluation.status === 'running') return 'running';
  if (evaluation.conditionOutcome === 'error') return 'failed';
  if (evaluation.triggerDecision !== 'triggered') return 'skipped';
  return 'queued';
}

function legacyDeliveryStatus(status: NonNullable<AutomationRun['deliveryStatus']>): NonNullable<ScheduledJobRun['deliveryStatus']> {
  if (status === 'delivered') return 'succeeded';
  if (status === 'delivering') return 'streaming';
  return status;
}

function legacyDeliveryMode(value: unknown): ScheduledJobRun['deliveryMode'] | undefined {
  return value === 'thread-only' || value === 'bridge-stream' || value === 'final-message' ? value : undefined;
}

function parseEventSnapshot(value: unknown): AutomationMonitorEventSnapshot {
  if (!isRecord(value)) throw new Error('Automation eventSnapshot must be an object.');
  const candidate = value;
  if (!isRecord(candidate.payload)) {
    throw new Error('Automation eventSnapshot payload must be an object.');
  }
  return {
    id: requireText(candidate.id, 'Automation eventSnapshot id'),
    sourceType: requireText(candidate.sourceType, 'Automation eventSnapshot sourceType'),
    occurredAt: requireText(candidate.occurredAt, 'Automation eventSnapshot occurredAt'),
    subject: requireText(candidate.subject, 'Automation eventSnapshot subject'),
    ...(typeof candidate.summary === 'string' ? { summary: candidate.summary } : {}),
    payload: candidate.payload,
  };
}

function parseMonitorOperator(value: unknown): AutomationMonitorCondition['operator'] {
  if (value === '>' || value === '>=' || value === '<' || value === '<=' || value === '==' || value === '!=') return value;
  throw new Error(`Automation monitor operator is invalid: ${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertOrigin(automation: AutomationDefinition, expected: NonNullable<AutomationDefinition['originKind']>): void {
  if (automation.originKind !== expected) throw new Error(`Automation must have ${expected} origin.`);
}

function requireText(value: unknown, label: string): string {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function legacyExecutionMode(
  value: unknown,
  fallback: 'same-thread' | 'side-thread',
): 'same-thread' | 'side-thread' {
  const normalized = normalizeScheduledJobExecutionMode(value, fallback);
  if (normalized === 'same-thread') return 'same-thread';
  if (normalized === 'side-thread') return 'side-thread';
  throw new Error('Scheduled job execution mode must be same-thread or side-thread.');
}

function fail(message: string): never {
  throw new Error(message);
}
