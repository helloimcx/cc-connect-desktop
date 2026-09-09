import {
  normalizeScheduledJobExecutionMode,
  type ScheduledJobRoute,
} from './scheduler.js';

export type AutomationActivation =
  | { kind: 'cron'; expression: string; timezone: string }
  | { kind: 'once'; runAt: string }
  | { kind: 'interval'; intervalMs: number }
  | { kind: 'provider-event'; sourceType: string; sourceConfig: Record<string, unknown>; schedule?: AutomationMonitorSchedule };

export interface AutomationMonitorSchedule {
  cron: string;
  timezone: string;
}

export type AutomationCondition =
  | { kind: 'always' }
  | { kind: 'expression'; expression: string }
  | { kind: 'approved-script'; scriptId: string; approvedVersionId: string; edge: 'rising' };

export interface AutomationAction {
  kind: 'agent-prompt';
  promptTemplate: string;
  executionMode: 'same-thread' | 'side-thread';
  workflowTemplate?: 'direct' | 'deep-analysis';
  retrospectiveDelayHours?: number;
  retrospectiveTarget?: {
    monitorId: string;
    decisionId: string;
  };
}

export interface AutomationDelivery {
  platform: string;
  route: ScheduledJobRoute;
}

export interface AutomationPolicies {
  concurrency: 'skip-if-running';
  cooldownMs: number;
}

export interface AutomationLegacyMetadata {
  scheduledDescription?: string;
}

export interface AutomationDefinition {
  id: string;
  workspaceId: string;
  title: string;
  enabled: boolean;
  health: 'healthy' | 'blocked';
  blockedReason?: string;
  activation: AutomationActivation;
  condition: AutomationCondition;
  action: AutomationAction;
  delivery: AutomationDelivery;
  policies: AutomationPolicies;
  lastSuccessfulMatch?: boolean;
  lastEvaluationAt?: string;
  lastTriggeredAt?: string;
  consecutiveEvaluationFailures: number;
  createdAt: string;
  updatedAt: string;
  originKind?: 'native' | 'scheduled-job' | 'automation-monitor';
  legacyMetadata?: AutomationLegacyMetadata;
}

type AutomationWritableFields = Pick<
  AutomationDefinition,
  'workspaceId' | 'title' | 'enabled' | 'activation' | 'condition' | 'action' | 'delivery' | 'policies'
>;

export type AutomationCreateInput = AutomationWritableFields;
export type AutomationUpdateInput = Partial<Omit<AutomationWritableFields, 'workspaceId'>>;

export type AutomationConditionOutcome = 'matched' | 'not_matched' | 'error' | 'skipped';
export type AutomationTriggerDecision =
  | 'triggered'
  | 'not_rising'
  | 'skipped_concurrent'
  | 'skipped_cooldown'
  | 'skipped_action_running'
  | 'not_evaluated';

interface AutomationEvaluationBase {
  activationKind: AutomationActivation['kind'];
  scriptVersionId?: string;
  startedAt: string;
}

interface AutomationEvaluationResultDetails {
  triggeredAt?: string;
  finishedAt: string;
  durationMs?: number;
  exitCode?: number;
  errorCategory?: string;
  stdout?: string;
  stderr?: string;
  outputTruncated?: boolean;
  resultSummary?: string;
  payload?: Record<string, unknown>;
  nextState?: Record<string, unknown>;
  sandboxViolations?: string[];
  networkAudit?: Array<{ host: string; port?: number; allowed: boolean; timestamp?: string }>;
}

type AutomationEvaluationResult = AutomationEvaluationResultDetails & (
  | {
      conditionOutcome: 'matched';
      triggerDecision: 'triggered' | 'not_rising' | 'skipped_cooldown' | 'skipped_action_running';
    }
  | { conditionOutcome: 'not_matched'; triggerDecision: 'not_rising' }
  | { conditionOutcome: 'error'; triggerDecision: 'not_evaluated' }
  | {
      conditionOutcome: 'skipped';
      triggerDecision: 'not_evaluated' | 'skipped_concurrent' | 'skipped_cooldown' | 'skipped_action_running';
    }
);

interface AutomationEvaluationIdentity {
  id: string;
  automationId: string;
}

export type AutomationEvaluation = AutomationEvaluationIdentity & AutomationEvaluationBase & (
  | {
      status: 'running';
      conditionOutcome?: never;
      triggerDecision?: never;
      finishedAt?: never;
    }
  | ({ status: 'finished' } & AutomationEvaluationResult)
);

export type AutomationEvaluationCreateInput = AutomationEvaluationBase;
export type AutomationEvaluationFinishInput = AutomationEvaluationResult;

export interface AutomationRun {
  id: string;
  automationId: string;
  evaluationId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
  threadId?: string;
  acpRunId?: string;
  executionMode: 'same-thread' | 'side-thread';
  deliveryStatus?: 'pending' | 'delivering' | 'delivered' | 'failed';
  bridgeActivity?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AutomationScript {
  id: string;
  workspaceId: string;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export type AutomationScriptVersionStatus =
  | 'draft'
  | 'pending_test_approval'
  | 'test_authorized'
  | 'testing'
  | 'tested'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'revoked';

export interface AutomationScriptAuditActor {
  actor: string;
  at: string;
  approvalId?: string;
}

export interface AutomationScriptTestReport extends Record<string, unknown> {
  status: 'passed' | 'failed';
  finishedAt: string;
  summary?: string;
}

export interface AutomationScriptVersion {
  id: string;
  scriptId: string;
  status: AutomationScriptVersionStatus;
  packageSha256: string;
  packagePath: string;
  shebang: string;
  interpreterPath: string;
  interpreterVersion: string;
  capabilities: Record<string, unknown>;
  config: Record<string, unknown>;
  configSchema: Record<string, unknown>;
  networkMode: 'none' | 'public';
  internalAccess: boolean;
  allowedReadDirs: string[];
  secretRefs: string[];
  env: string[];
  limits: {
    timeoutMs: number;
    stdoutBytes: number;
    stderrBytes: number;
    payloadBytes: number;
    stateBytes: number;
  };
  staticCheck: Record<string, unknown>;
  testPlan: Record<string, unknown>;
  testReport?: Record<string, unknown>;
  pendingTestApprovalId?: string;
  pendingApprovalId?: string;
  testAuthorization?: AutomationScriptAuditActor;
  approval?: AutomationScriptAuditActor;
  rejection?: AutomationScriptAuditActor;
  revocation?: AutomationScriptAuditActor;
  createdAt: string;
  updatedAt: string;
}

export type AutomationScriptCreateInput = Omit<AutomationScript, 'id' | 'createdAt' | 'updatedAt'>;
export type AutomationScriptUpdateInput = Partial<Pick<AutomationScript, 'title' | 'description'>>;

/** Source-only API handoff. The server derives package and interpreter facts. */
export interface AutomationScriptSourceFile {
  path: string;
  content: string;
}
export type AutomationScriptVersionCreateInput = Pick<
  AutomationScriptVersion,
  'scriptId' | 'shebang' | 'capabilities' | 'config' | 'configSchema' | 'secretRefs' | 'testPlan'
>;

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

export function isoTimestamp(value: unknown, label: string): string {
  const normalized = requiredString(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(normalized);
  if (!match || Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59
  ) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  return normalized;
}

function optionalIsoTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return isoTimestamp(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function normalizeAutomationExecutionMode(value: unknown): AutomationAction['executionMode'] {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Automation action executionMode must be a non-empty string.');
  }
  const normalized = normalizeScheduledJobExecutionMode(value.trim());
  if (normalized === 'same-thread') return 'same-thread';
  if (normalized === 'side-thread') return 'side-thread';
  throw new Error('Automation action executionMode must be same-thread or side-thread.');
}

function normalizeWorkflowTemplate(value: unknown): AutomationAction['workflowTemplate'] {
  if (value === undefined) return undefined;
  if (value === 'direct' || value === 'deep-analysis') return value;
  throw new Error('Automation workflowTemplate must be direct or deep-analysis.');
}

function normalizeRetrospectiveDelayHours(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('Automation retrospectiveDelayHours must be a positive number.');
  }
  return value;
}

function normalizeRetrospectiveTarget(value: unknown): AutomationAction['retrospectiveTarget'] {
  if (value === undefined) return undefined;
  const target = asRecord(value, 'Automation retrospectiveTarget');
  return {
    monitorId: requiredString(target.monitorId, 'Automation retrospectiveTarget monitorId'),
    decisionId: requiredString(target.decisionId, 'Automation retrospectiveTarget decisionId'),
  };
}

function normalizeAutomationAction(action: Record<string, unknown>): AutomationAction {
  const workflowTemplate = normalizeWorkflowTemplate(action.workflowTemplate);
  const retrospectiveDelayHours = normalizeRetrospectiveDelayHours(action.retrospectiveDelayHours);
  const retrospectiveTarget = normalizeRetrospectiveTarget(action.retrospectiveTarget);
  return {
    kind: 'agent-prompt',
    promptTemplate: requiredString(action.promptTemplate, 'Automation promptTemplate'),
    executionMode: normalizeAutomationExecutionMode(action.executionMode),
    ...(workflowTemplate !== undefined ? { workflowTemplate } : {}),
    ...(retrospectiveDelayHours !== undefined ? { retrospectiveDelayHours } : {}),
    ...(retrospectiveTarget !== undefined ? { retrospectiveTarget } : {}),
  };
}

function normalizeRoute(value: unknown): ScheduledJobRoute {
  const route = asRecord(value, 'Automation delivery route');
  const normalized: ScheduledJobRoute = {
    type: requiredString(route.type, 'Automation delivery route type'),
    channelId: requiredString(route.channelId, 'Automation delivery route channelId'),
  };
  const instanceId = optionalString(route.instanceId, 'Automation delivery route instanceId');
  const participantId = optionalString(route.participantId, 'Automation delivery route participantId');
  const threadId = optionalString(route.threadId, 'Automation delivery route threadId');
  if (instanceId) normalized.instanceId = instanceId;
  if (participantId) normalized.participantId = participantId;
  if (threadId) normalized.threadId = threadId;
  if (route.metadata !== undefined) normalized.metadata = asRecord(route.metadata, 'Automation delivery route metadata');
  return normalized;
}

export function normalizeAutomationMonitorSchedule(value: unknown, label = 'Automation monitor schedule'): AutomationMonitorSchedule | undefined {
  if (value === undefined || value === null) return undefined;
  const input = asRecord(value, label);
  return {
    cron: requiredString(input.cron, `${label} cron`),
    timezone: requiredString(input.timezone, `${label} timezone`),
  };
}

export function normalizeAutomationActivation(value: unknown): AutomationActivation {
  const input = asRecord(value, 'Automation activation');
  switch (input.kind) {
    case 'cron':
      return {
        kind: 'cron',
        expression: requiredString(input.expression, 'Automation cron expression'),
        timezone: requiredString(input.timezone, 'Automation cron timezone'),
      };
    case 'once':
      return { kind: 'once', runAt: isoTimestamp(input.runAt, 'Automation runAt') };
    case 'interval': {
      const intervalMs = nonNegativeInteger(input.intervalMs, 'Automation intervalMs');
      if (intervalMs === 0) throw new Error('Automation intervalMs must be greater than zero.');
      return { kind: 'interval', intervalMs };
    }
    case 'provider-event': {
      const activation: AutomationActivation = {
        kind: 'provider-event',
        sourceType: requiredString(input.sourceType, 'Automation provider sourceType'),
        sourceConfig: asRecord(input.sourceConfig, 'Automation provider sourceConfig'),
      };
      const schedule = normalizeAutomationMonitorSchedule(input.schedule, 'Automation provider-event schedule');
      if (schedule) activation.schedule = schedule;
      return activation;
    }
    default:
      throw new Error('Automation activation kind must be cron, once, interval, or provider-event.');
  }
}

export function normalizeAutomationCondition(value: unknown): AutomationCondition {
  const input = asRecord(value, 'Automation condition');
  switch (input.kind) {
    case 'always':
      return { kind: 'always' };
    case 'expression':
      return { kind: 'expression', expression: requiredString(input.expression, 'Automation condition expression') };
    case 'approved-script':
      if (input.edge !== 'rising') throw new Error('Automation approved-script edge must be rising.');
      return {
        kind: 'approved-script',
        scriptId: requiredString(input.scriptId, 'Automation condition scriptId'),
        approvedVersionId: requiredString(input.approvedVersionId, 'Automation condition approvedVersionId'),
        edge: 'rising',
      };
    default:
      throw new Error('Automation condition kind must be always, expression, or approved-script.');
  }
}

export function normalizeAutomationDefinition(value: unknown): AutomationDefinition {
  const input = asRecord(value, 'Automation definition');
  const action = asRecord(input.action, 'Automation action');
  if (action.kind !== 'agent-prompt') throw new Error('Automation action kind must be agent-prompt.');
  const delivery = asRecord(input.delivery, 'Automation delivery');
  const policies = asRecord(input.policies, 'Automation policies');
  if (policies.concurrency !== 'skip-if-running') {
    throw new Error('Automation concurrency policy must be skip-if-running.');
  }
  if (input.health !== 'healthy' && input.health !== 'blocked') {
    throw new Error('Automation health must be healthy or blocked.');
  }
  if (typeof input.enabled !== 'boolean') throw new Error('Automation enabled must be a boolean.');

  const normalized: AutomationDefinition = {
    id: requiredString(input.id, 'Automation id'),
    workspaceId: requiredString(input.workspaceId, 'Automation workspaceId'),
    title: requiredString(input.title, 'Automation title'),
    enabled: input.enabled,
    health: input.health,
    activation: normalizeAutomationActivation(input.activation),
    condition: normalizeAutomationCondition(input.condition),
    action: normalizeAutomationAction(action),
    delivery: {
      platform: requiredString(delivery.platform, 'Automation delivery platform').toLowerCase(),
      route: normalizeRoute(delivery.route),
    },
    policies: {
      concurrency: 'skip-if-running',
      cooldownMs: nonNegativeInteger(policies.cooldownMs, 'Automation cooldownMs'),
    },
    consecutiveEvaluationFailures: nonNegativeInteger(
      input.consecutiveEvaluationFailures,
      'Automation consecutiveEvaluationFailures',
    ),
    createdAt: isoTimestamp(input.createdAt, 'Automation createdAt'),
    updatedAt: isoTimestamp(input.updatedAt, 'Automation updatedAt'),
  };

  const blockedReason = optionalString(input.blockedReason, 'Automation blockedReason');
  const lastEvaluationAt = optionalIsoTimestamp(input.lastEvaluationAt, 'Automation lastEvaluationAt');
  const lastTriggeredAt = optionalIsoTimestamp(input.lastTriggeredAt, 'Automation lastTriggeredAt');
  if (blockedReason) normalized.blockedReason = blockedReason;
  if (lastEvaluationAt) normalized.lastEvaluationAt = lastEvaluationAt;
  if (lastTriggeredAt) normalized.lastTriggeredAt = lastTriggeredAt;
  if (input.lastSuccessfulMatch !== undefined) {
    if (typeof input.lastSuccessfulMatch !== 'boolean') {
      throw new Error('Automation lastSuccessfulMatch must be a boolean.');
    }
    normalized.lastSuccessfulMatch = input.lastSuccessfulMatch;
  }
  if (
    input.originKind === 'native' ||
    input.originKind === 'scheduled-job' ||
    input.originKind === 'automation-monitor'
  ) {
    normalized.originKind = input.originKind;
  } else if (input.originKind !== undefined) {
    throw new Error('Automation originKind is invalid.');
  }
  if (input.legacyMetadata !== undefined) {
    if (input.originKind !== 'scheduled-job') {
      throw new Error('Automation legacyMetadata requires scheduled-job origin.');
    }
    const legacyMetadata = asRecord(input.legacyMetadata, 'Automation legacyMetadata');
    const scheduledDescription = legacyMetadata.scheduledDescription;
    if (scheduledDescription !== undefined && typeof scheduledDescription !== 'string') {
      throw new Error('Automation legacy scheduledDescription must be a string.');
    }
    normalized.legacyMetadata = {
      ...(scheduledDescription !== undefined ? { scheduledDescription } : {}),
    };
  }
  return normalized;
}
