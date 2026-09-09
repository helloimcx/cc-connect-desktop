import process from 'node:process';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type {
  AutomationMonitor,
  AutomationMonitorCondition,
  AutomationMonitorRun,
  AutomationMonitorUpdateInput,
  ScheduledJob,
  ScheduledJobRun,
  ScheduledJobUpdateInput,
  AutomationDecisionRecord,
} from '@cc/superai-contracts';
import { normalizeChannelPlatform, normalizeScheduledJobExecutionMode } from '@cc/superai-contracts';
import { toPublicScheduledJobId } from '../scheduler/job-id.js';
import { getChannelPlatformBase, getChannelPlatformInstanceId, scheduledJobMatchesCliContext } from '../scheduler/scheduled-job-route.js';
import { toPublicAutomationMonitorId } from '../automation/monitor-id.js';
import { automationMonitorToScheduledJob } from '../automation/automation-schedule-utils.js';
import { parseDurationMs, parseMonitorCondition, parseMonitorSchedule, parseRetroDelayHours } from './monitor-cli-parsers.js';
import { formatSafeError } from '../kernel/local-core-errors.js';
import { runSkillDomain } from './skill-cli-handlers.js';
import type { StdIo, ParsedFlags, CliContext } from './cli-helpers.js';
import {
  request,
  resolveContext,
  parseArgs,
  getFlag,
  getRequiredFlag,
  getBooleanFlag,
  getOptionalBooleanFlag,
  normalizeMaybeBooleanFlag,
  print,
  DEFAULT_BASE_URL,
} from './cli-helpers.js';

export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env, io: StdIo = process) {
  try {
    const { positionals, flags } = parseArgs(argv);
    const [domain = '', action = '', maybeId = ''] = positionals;
    const json = getBooleanFlag(flags, 'json', false);
    switch (domain) {
      case 'channel':
        return await runChannelDomain(action, flags, env, io, json);
      case 'monitor':
        return await runMonitorDomain(action, maybeId, flags, env, io, json);
      case 'automation':
        return await runAutomationDomain(action, maybeId, flags, env, io, json);
      case 'script':
        return await runScriptDomain(action, maybeId, flags, env, io, json);
      case 'scheduler':
        return await runSchedulerDomain(action, maybeId, flags, env, io, json);
      case 'skill':
        return await runSkillDomain(action, maybeId, flags, env, io, json);
      default:
        printUsage(io.stderr);
        return 2;
    }
  } catch (err: any) {
    io.stderr.write(`lac CLI error: ${err.message}\n`);
    return 1;
  }
}

async function runChannelDomain(action: string, flags: ParsedFlags, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (action === 'send-file') {
    return await handleChannelSendFile(flags, env, io, json);
  }
  printUsage(io.stderr);
  return 2;
}

async function runMonitorDomain(action: string, maybeId: string, flags: ParsedFlags, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  switch (action) {
    case 'add': return await handleMonitorAdd(flags, env, io, json);
    case 'list': return await handleMonitorList(flags, env, io, json);
    case 'info': return await handleMonitorInfo(maybeId, flags, env, io, json);
    case 'edit': return await handleMonitorEdit(maybeId, flags, env, io, json);
    case 'del':
    case 'delete': return await handleMonitorDelete(maybeId, flags, env, io, json);
    case 'run': return await handleMonitorRun(maybeId, flags, env, io, json);
    case 'decisions': return await handleMonitorDecisions(maybeId, flags, env, io, json);
    default: printUsage(io.stderr); return 2;
  }
}

async function runAutomationDomain(action: string, maybeId: string, flags: ParsedFlags, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  switch (action) {
    case 'add': return await handleAutomationAdd(flags, env, io, json);
    case 'list': return await handleAutomationList(flags, env, io, json);
    case 'info': return await handleAutomationInfo(maybeId, flags, env, io, json);
    case 'edit': return await handleAutomationEdit(maybeId, flags, env, io, json);
    case 'del':
    case 'delete': return await handleAutomationDelete(maybeId, flags, env, io, json);
    case 'check': return await handleAutomationCheck(maybeId, flags, env, io, json);
    default: printUsage(io.stderr); return 2;
  }
}

async function runScriptDomain(action: string, maybeId: string, flags: ParsedFlags, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  switch (action) {
    case 'list': return await handleScriptList(flags, env, io, json);
    case 'create': return await handleScriptCreate(flags, env, io, json);
    case 'stage': return await handleScriptStage(flags, env, io, json);
    case 'status': return await handleScriptStatus(maybeId, flags, env, io, json);
    case 'test-approval': return await handleScriptTransition('test-approval', maybeId, flags, env, io, json);
    case 'test': return await handleScriptTest(maybeId, flags, env, io, json);
    case 'enable-approval': return await handleScriptTransition('enable-approval', maybeId, flags, env, io, json);
    case 'approve': return await handleScriptApprovalDecision('approve', maybeId, flags, env, io, json);
    case 'reject': return await handleScriptApprovalDecision('reject', maybeId, flags, env, io, json);
    case 'revoke': return await handleScriptTransition('revoke', maybeId, flags, env, io, json);
    default: printUsage(io.stderr); return 2;
  }
}

async function runSchedulerDomain(action: string, maybeId: string, flags: ParsedFlags, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  switch (action) {
    case 'add': return await handleAdd(flags, env, io, json);
    case 'list': return await handleList(flags, env, io, json);
    case 'info': return await handleInfo(maybeId, flags, env, io, json);
    case 'edit': return await handleEdit(maybeId, flags, env, io, json);
    case 'del':
    case 'delete': return await handleDelete(maybeId, flags, env, io, json);
    case 'run': return await handleRun(maybeId, flags, env, io, json);
    default: printUsage(io.stderr); return 2;
  }
}

type ScriptVersionSummary = { id: string; scriptId: string; status: string };

async function handleAutomationAdd(flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  const context = requireWorkspaceContext(flags, env, 'automation add');
  const scriptId = getRequiredFlag(flags, 'script-id');
  const versionId = getRequiredFlag(flags, 'script-version');
  const version = await request<ScriptVersionSummary>(context.baseUrl, 'GET', scriptVersionPath(versionId, context));
  if (version.status !== 'approved') throw new Error(`automation add requires an approved script version, got ${version.status}.`);
  if (version.scriptId !== scriptId) throw new Error('automation add script id does not match the approved script version.');
  const intervalMs = parseDurationMs(getFlag(flags, 'interval') || '1m');
  const hasChannelRoute = Boolean(context.platform && context.chatId);
  const platform = hasChannelRoute ? context.platform : 'local';
  const route = hasChannelRoute
    ? { type: context.routeType || 'channel.chat', channelId: context.chatId, ...(context.platformInstanceId ? { instanceId: context.platformInstanceId } : {}), ...(context.platformUserId ? { participantId: context.platformUserId } : {}), ...(context.threadId ? { threadId: context.threadId } : {}) }
    : { type: 'local.thread', channelId: context.workspaceId, ...(context.threadId ? { threadId: context.threadId } : {}) };
  const automation = await request<unknown>(context.baseUrl, 'POST', '/automations', {
    workspaceId: context.workspaceId,
    title: getRequiredFlag(flags, 'title'),
    enabled: getBooleanFlag(flags, 'enabled', true),
    activation: { kind: 'interval', intervalMs },
    condition: { kind: 'approved-script', scriptId, approvedVersionId: versionId, edge: getFlag(flags, 'edge') || 'rising' },
    action: { kind: 'agent-prompt', promptTemplate: getRequiredFlag(flags, 'message'), executionMode: getFlag(flags, 'execution-mode') || 'side-thread' },
    delivery: { platform, route },
    policies: { concurrency: 'skip-if-running', cooldownMs: getFlag(flags, 'cooldown') ? parseDurationMs(getFlag(flags, 'cooldown')) : 0 },
  });
  print(json, io.stdout, automation, `Created automation ${(automation as { id?: string }).id || ''}`.trim());
  return 0;
}

async function handleAutomationList(flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  const context = requireWorkspaceContext(flags, env, 'automation list');
  const response = await request<{ automations: unknown[] }>(context.baseUrl, 'GET', `/automations?workspace_id=${encodeURIComponent(context.workspaceId)}`);
  print(json, io.stdout, response, response.automations.length ? response.automations.map((item) => JSON.stringify(item)).join('\n') : 'No automations.');
  return 0;
}

async function handleAutomationInfo(id: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!id) throw new Error('automation info requires an automation id.');
  const context = requireWorkspaceContext(flags, env, 'automation info');
  const automation = await request<unknown>(context.baseUrl, 'GET', `/automations/${encodeURIComponent(id)}?workspace_id=${encodeURIComponent(context.workspaceId)}`);
  print(json, io.stdout, automation, JSON.stringify(automation, null, 2));
  return 0;
}

async function handleAutomationEdit(id: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!id) throw new Error('automation edit requires an automation id.');
  const context = requireWorkspaceContext(flags, env, 'automation edit');
  const body: Record<string, unknown> = {};
  const title = getFlag(flags, 'title');
  const enabled = getOptionalBooleanFlag(flags, 'enabled');
  if (title) body.title = title;
  if (enabled !== undefined) body.enabled = enabled;
  if (!Object.keys(body).length) throw new Error('automation edit requires --title or --enabled.');
  const automation = await request<unknown>(context.baseUrl, 'PATCH', `/automations/${encodeURIComponent(id)}?workspace_id=${encodeURIComponent(context.workspaceId)}`, body);
  print(json, io.stdout, automation, `Updated automation ${id}`);
  return 0;
}

async function handleAutomationDelete(id: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!id) throw new Error('automation del requires an automation id.');
  const context = requireWorkspaceContext(flags, env, 'automation del');
  const result = await request<unknown>(context.baseUrl, 'DELETE', `/automations/${encodeURIComponent(id)}?workspace_id=${encodeURIComponent(context.workspaceId)}`);
  print(json, io.stdout, result, `Deleted automation ${id}`);
  return 0;
}

async function handleAutomationCheck(id: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!id) throw new Error('automation check requires an automation id.');
  const context = requireWorkspaceContext(flags, env, 'automation check');
  const result = await request<unknown>(context.baseUrl, 'POST', `/automations/${encodeURIComponent(id)}/check?workspace_id=${encodeURIComponent(context.workspaceId)}`);
  print(json, io.stdout, result, `Checked automation ${id}`);
  return 0;
}

async function handleScriptList(flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  const context = requireWorkspaceContext(flags, env, 'script list');
  const result = await request<unknown>(context.baseUrl, 'GET', `/automation-scripts?workspace_id=${encodeURIComponent(context.workspaceId)}`);
  print(json, io.stdout, result, JSON.stringify(result, null, 2));
  return 0;
}

async function handleScriptCreate(flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  const context = requireWorkspaceContext(flags, env, 'script create');
  const result = await request<unknown>(context.baseUrl, 'POST', '/automation-scripts', { workspaceId: context.workspaceId, title: getRequiredFlag(flags, 'title'), ...(getFlag(flags, 'desc') ? { description: getFlag(flags, 'desc') } : {}) });
  print(json, io.stdout, result, `Created script ${(result as { id?: string }).id || ''}`.trim());
  return 0;
}

async function handleScriptStage(flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  const context = requireWorkspaceContext(flags, env, 'script stage');
  const scriptId = getRequiredFlag(flags, 'script');
  const sourceJson = getFlag(flags, 'source-json');
  const sourceFile = getFlag(flags, 'source-file');
  if (Boolean(sourceJson) === Boolean(sourceFile)) throw new Error('script stage requires exactly one of --source-json or --source-file.');
  let source: string;
  if (sourceFile) {
    source = readStableSourceFile(sourceFile);
  } else {
    source = sourceJson;
  }
  if (Buffer.byteLength(source, 'utf8') > 1_200_000) throw new Error('script stage source bundle exceeds 1,200,000 bytes.');
  let files: unknown;
  try { files = JSON.parse(source); } catch { throw new Error('script stage --source-json must be a JSON array.'); }
  if (!Array.isArray(files) || files.some((file) => !file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file as object).some((key) => key !== 'path' && key !== 'content'))) {
    throw new Error('script stage accepts only source file path and content fields.');
  }
  const result = await request<unknown>(context.baseUrl, 'POST', `/automation-scripts/${encodeURIComponent(scriptId)}/versions?workspace_id=${encodeURIComponent(context.workspaceId)}`, { files });
  print(json, io.stdout, result, `Staged script version ${(result as { id?: string }).id || ''}`.trim());
  return 0;
}

function readStableSourceFile(path: string) {
  if (!constants.O_NOFOLLOW) throw new Error('script stage --source-file requires O_NOFOLLOW support.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('script stage --source-file must be a regular file.');
    if (before.size > 1_200_000) throw new Error('script stage source bundle exceeds 1,200,000 bytes.');
    const buffer = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!read) throw new Error('script stage source file changed while reading.');
      offset += read;
    }
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('script stage source file changed while reading.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } finally {
    closeSync(fd);
  }
}

async function handleScriptStatus(versionId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!versionId) throw new Error('script status requires a version id.');
  const context = requireWorkspaceContext(flags, env, 'script status');
  const version = await request<unknown>(context.baseUrl, 'GET', scriptVersionPath(versionId, context));
  print(json, io.stdout, version, JSON.stringify(version, null, 2));
  return 0;
}

async function handleScriptTransition(action: 'test-approval' | 'enable-approval' | 'revoke', versionId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!versionId) throw new Error(`script ${action} requires a version id.`);
  const context = requireWorkspaceContext(flags, env, `script ${action}`);
  const result = await request<unknown>(context.baseUrl, 'POST', scriptVersionActionPath(versionId, action, context), { actor: getRequiredFlag(flags, 'actor') });
  print(json, io.stdout, result, `Requested script ${action} for ${versionId}`);
  return 0;
}

async function handleScriptTest(versionId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!versionId) throw new Error('script test requires a version id.');
  const context = requireWorkspaceContext(flags, env, 'script test');
  const version = await request<ScriptVersionSummary>(context.baseUrl, 'GET', scriptVersionPath(versionId, context));
  if (version.status !== 'test_authorized') throw new Error(`script test requires a live unconsumed test authorization, got ${version.status}.`);
  const result = await request<unknown>(context.baseUrl, 'POST', scriptVersionActionPath(versionId, 'test', context), { actor: getRequiredFlag(flags, 'actor') });
  print(json, io.stdout, result, `Ran script test for ${versionId}`);
  return 0;
}

async function handleScriptApprovalDecision(action: 'approve' | 'reject', versionId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!versionId) throw new Error(`script ${action} requires a version id.`);
  const context = requireWorkspaceContext(flags, env, `script ${action}`);
  const result = await request<unknown>(context.baseUrl, 'POST', scriptVersionActionPath(versionId, action, context), { approvalId: getRequiredFlag(flags, 'approval'), actor: getRequiredFlag(flags, 'actor') });
  print(json, io.stdout, result, `Applied script ${action} for ${versionId}`);
  return 0;
}

function scriptVersionPath(versionId: string, context: CliContext) {
  return `/automation-scripts/versions/${encodeURIComponent(versionId)}?workspace_id=${encodeURIComponent(context.workspaceId)}`;
}

function scriptVersionActionPath(versionId: string, action: string, context: CliContext) {
  return `/automation-scripts/versions/${encodeURIComponent(versionId)}/${action}?workspace_id=${encodeURIComponent(context.workspaceId)}`;
}

function requireWorkspaceContext(flags: Map<string, string[]>, env: NodeJS.ProcessEnv, operation: string) {
  const context = resolveContext(flags, env);
  if (!context.workspaceId) throw new Error(`${operation} requires a workspace context. Set LOCAL_AI_WORKSPACE_ID or pass --workspace.`);
  return context;
}

function parseWorkflowFlags(flags: Map<string, string[]>): Partial<AutomationMonitorUpdateInput> {
  const workflowFlag = getFlag(flags, 'workflow');
  if (workflowFlag && workflowFlag !== 'direct' && workflowFlag !== 'deep-analysis') {
    throw new Error('--workflow must be "direct" or "deep-analysis".');
  }
  const retroDelayFlag = getFlag(flags, 'retro-delay');
  return {
    ...(workflowFlag ? { workflowTemplate: workflowFlag as 'direct' | 'deep-analysis' } : {}),
    ...(retroDelayFlag ? { retrospectiveDelayHours: parseRetroDelayHours(retroDelayFlag) } : {}),
  };
}

async function handleMonitorAdd(flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  const context = resolveContext(flags, env);
  if (!context.workspaceId) {
    throw new Error('monitor add requires a workspace context. Set LOCAL_AI_WORKSPACE_ID or pass --workspace.');
  }
  const title = getRequiredFlag(flags, 'title');
  const sourceType = getRequiredFlag(flags, 'source');
  const promptTemplate = getRequiredFlag(flags, 'message');
  const condition = parseMonitorCondition(getRequiredFlag(flags, 'condition'));
  const sourceConfig = buildSourceConfig(sourceType, flags);
  const cronFlag = getFlag(flags, 'cron');
  const timezoneFlag = getFlag(flags, 'timezone');
  if (timezoneFlag && !cronFlag) throw new Error('--timezone requires --cron.');
  const monitor = await request<AutomationMonitor>(context.baseUrl, 'POST', '/automation/monitors', {
    workspaceId: context.workspaceId,
    ...(context.threadId ? { threadId: context.threadId } : {}),
    title,
    sourceType,
    sourceConfig,
    condition,
    promptTemplate,
    executionMode: getMonitorExecutionMode(flags),
    cooldownMs: parseDurationMs(getFlag(flags, 'cooldown') || '15m'),
    ...(cronFlag ? { schedule: parseMonitorSchedule(cronFlag, timezoneFlag) } : {}),
    ...parseWorkflowFlags(flags),
    enabled: true,
  });
  const outputLines = [
    `Created monitor ${toPublicAutomationMonitorId(monitor.id)}`,
    `Title: ${monitor.title}`,
    `Source: ${monitor.sourceType}`,
    `Condition: ${formatCondition(monitor.condition)}`,
    `Execution mode: ${monitor.executionMode}`,
  ];
  if (monitor.sourceType === 'webhook' && monitor.sourceConfig) {
    const hookId = String(monitor.sourceConfig.hookId || monitor.id);
    const token = String(monitor.sourceConfig.token || '');
    const hookUrl = `${context.baseUrl}/automation/hooks/${encodeURIComponent(hookId)}`;
    outputLines.push(
      `Hook URL: ${hookUrl}`,
      `Token: ${token}`,
      `Curl example: curl -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"event":"ping"}' "${hookUrl}"`,
    );
  }
  print(json, io.stdout, presentMonitor(monitor), outputLines.join('\n'));
  return 0;
}

async function handleMonitorList(flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  const context = resolveContext(flags, env);
  const workspaceId = getFlag(flags, 'workspace') || context.workspaceId;
  const threadId = flags.has('thread')
    ? normalizeMaybeBooleanFlag(getFlag(flags, 'thread')) || context.threadId
    : '';
  const suffix = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : '';
  const response = await request<{ monitors: AutomationMonitor[] }>(context.baseUrl, 'GET', `/automation/monitors${suffix}`);
  const monitors = threadId
    ? response.monitors.filter((monitor) => monitor.route.threadId === threadId || monitorMatchesCliContext(monitor, context))
    : response.monitors;
  print(json, io.stdout, { monitors: monitors.map(presentMonitor) }, monitors.length === 0 ? 'No monitors.' : monitors.map(formatMonitorLine).join('\n'));
  return 0;
}

async function handleMonitorInfo(monitorId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!monitorId) {
    throw new Error('monitor info requires a monitor id.');
  }
  const context = resolveContext(flags, env);
  const monitor = await request<AutomationMonitor>(context.baseUrl, 'GET', `/automation/monitors/${encodeURIComponent(monitorId)}`);
  const runs = await request<{ runs: AutomationMonitorRun[] }>(context.baseUrl, 'GET', `/automation/monitors/${encodeURIComponent(monitorId)}/runs`);
  print(json, io.stdout, { monitor: presentMonitor(monitor), runs: runs.runs }, formatMonitorDetails(monitor, runs.runs[0]));
  return 0;
}

async function handleMonitorEdit(monitorId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!monitorId) {
    throw new Error('monitor edit requires a monitor id.');
  }
  const input: AutomationMonitorUpdateInput = {};
  const title = getFlag(flags, 'title');
  const promptTemplate = getFlag(flags, 'message');
  const condition = getFlag(flags, 'condition');
  const enabled = getOptionalBooleanFlag(flags, 'enabled');
  const executionMode = getFlag(flags, 'execution-mode');
  const cooldown = getFlag(flags, 'cooldown');
  const cronFlag = getFlag(flags, 'cron');
  const timezoneFlag = getFlag(flags, 'timezone');
  if (timezoneFlag && !cronFlag) throw new Error('--timezone requires --cron.');
  if (title) input.title = title;
  if (typeof promptTemplate === 'string' && promptTemplate) input.promptTemplate = promptTemplate;
  if (condition) input.condition = parseMonitorCondition(condition);
  if (typeof enabled === 'boolean') input.enabled = enabled;
  if (executionMode) input.executionMode = normalizeScheduledJobExecutionMode(executionMode);
  if (cooldown) input.cooldownMs = parseDurationMs(cooldown);
  Object.assign(input, parseWorkflowFlags(flags));
  if (cronFlag === 'off') input.schedule = null;
  else if (cronFlag) input.schedule = parseMonitorSchedule(cronFlag, timezoneFlag);
  if (Object.keys(input).length === 0) {
    throw new Error('monitor edit requires at least one editable field.');
  }
  const context = resolveContext(flags, env);
  const monitor = await request<AutomationMonitor>(context.baseUrl, 'PATCH', `/automation/monitors/${encodeURIComponent(monitorId)}`, input);
  print(json, io.stdout, presentMonitor(monitor), `Updated monitor ${toPublicAutomationMonitorId(monitor.id)}`);
  return 0;
}

async function handleMonitorDelete(monitorId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!monitorId) {
    throw new Error('monitor del requires a monitor id.');
  }
  const context = resolveContext(flags, env);
  const result = await request<{ deleted: boolean }>(context.baseUrl, 'DELETE', `/automation/monitors/${encodeURIComponent(monitorId)}`);
  print(json, io.stdout, result, `Deleted monitor ${monitorId}`);
  return 0;
}

async function handleMonitorRun(monitorId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!monitorId) {
    throw new Error('monitor run requires a monitor id.');
  }
  const context = resolveContext(flags, env);
  const run = await request<AutomationMonitorRun>(context.baseUrl, 'POST', `/automation/monitors/${encodeURIComponent(monitorId)}/run`);
  print(json, io.stdout, run, `Triggered monitor ${monitorId}: ${run.status}`);
  return 0;
}

async function handleMonitorDecisions(monitorId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!monitorId) {
    throw new Error('monitor decisions requires a monitor id.');
  }
  const context = resolveContext(flags, env);
  const response = await request<{ decisions: AutomationDecisionRecord[] }>(
    context.baseUrl,
    'GET',
    `/automation/monitors/${encodeURIComponent(monitorId)}/decisions`,
  );
  const decisions = response.decisions || [];
  print(
    json,
    io.stdout,
    { decisions },
    decisions.length === 0
      ? 'No decision records found.'
      : decisions.map((d) => [
          `[${d.createdAt}] Run: ${d.runId || 'unknown'}`,
          `Action: ${d.action} (Confidence: ${d.confidence}%)`,
          `Thesis: ${d.thesis}`,
          `Bull: ${d.bullPoints.join('; ')}`,
          `Bear: ${d.bearPoints.join('; ')}`,
          d.retrospectiveOutcome
            ? `Retrospective: Accuracy=${d.retrospectiveOutcome.accuracy} | Realized=${d.retrospectiveOutcome.realizedOutcome} | Reflection=${d.retrospectiveOutcome.reflection}`
            : `Retrospective: ${d.retrospectiveStatus}`,
        ].join('\n')).join('\n---\n'),
  );
  return 0;
}

async function handleChannelSendFile(flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  const context = resolveContext(flags, env);
  const filePath = getRequiredFlag(flags, 'path');
  const rawPlatform = getFlag(flags, 'platform') || context.platform;
  const platform = rawPlatform ? normalizeChannelPlatform(rawPlatform) : '';
  if (!platform) {
    throw new Error('channel send-file requires a platform. Set LOCAL_AI_PLATFORM or pass --platform.');
  }
  if (!context.workspaceId) {
    throw new Error('channel send-file requires a workspace context. Set LOCAL_AI_WORKSPACE_ID or pass --workspace.');
  }
  const target = getFlag(flags, 'target') || getFlag(flags, 'chat-id') || context.chatId;
  if (!target) {
    throw new Error('channel send-file requires a target. Set LOCAL_AI_CHAT_ID or pass --target.');
  }
  const result = await request<{
    platform: string;
    workspaceId: string;
    channelId: string;
    messageIds: string[];
    attachments?: Array<{
      kind: string;
      attachmentId?: string;
      fileName?: string;
      fileSize?: number;
      metadata?: Record<string, unknown>;
    }>;
  }>(
    context.baseUrl,
    'POST',
    `/platforms/${encodeURIComponent(platform)}/${encodeURIComponent(context.workspaceId)}/messages`,
    {
      route: {
        type: 'channel.chat',
        channelId: target,
        instanceId: context.platformInstanceId || undefined,
        participantId: getFlag(flags, 'participant-id') || context.platformUserId || undefined,
      },
      parts: [{
        type: 'file',
        path: filePath,
        fileName: getFlag(flags, 'name') || undefined,
        metadata: context.workspacePath ? { workspacePath: context.workspacePath } : undefined,
      }],
    },
  );
  const file = result.attachments?.[0];
  print(json, io.stdout, result, `Sent file ${file?.fileName || filePath} to ${result.channelId}: ${result.messageIds[0] || ''}`);
  return 0;
}

async function handleAdd(flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  const cronExpr = getRequiredFlag(flags, 'cron');
  const promptTemplate = getRequiredFlag(flags, 'message');
  const description = getRequiredFlag(flags, 'desc');
  const executionMode = getExecutionMode(flags);
  const context = resolveContext(flags, env);
  if (!context.workspaceId) {
    throw new Error('scheduler add requires a workspace context. Set LOCAL_AI_WORKSPACE_ID or pass --workspace.');
  }
  const explicitPlatform = getFlag(flags, 'platform');
  const explicitChannelId = getFlag(flags, 'channel') || getFlag(flags, 'channel-id') || getFlag(flags, 'chat-id');
  const job = await request<ScheduledJob>(context.baseUrl, 'POST', '/scheduler/jobs', {
    workspaceId: context.workspaceId,
    ...(explicitPlatform ? { platform: explicitPlatform } : {}),
    ...(explicitChannelId ? { channelId: explicitChannelId } : {}),
    ...(context.threadId ? { threadId: context.threadId } : {}),
    executionMode,
    triggerType: 'cron',
    cronExpr,
    promptTemplate,
    description,
    enabled: true,
  });
  print(json, io.stdout, presentJob(job), [
    `Created scheduler job ${toPublicScheduledJobId(job.id)}`,
    `Schedule: ${job.cronExpr || ''}`,
    `Execution mode: ${job.executionMode}`,
    `Description: ${job.description}`,
  ].join('\n'));
  return 0;
}

async function handleList(flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  const context = resolveContext(flags, env);
  const workspaceId = getFlag(flags, 'workspace') || context.workspaceId;
  const showAllChannels = flags.has('all-channels') || flags.has('all');
  const explicitChannelId = getFlag(flags, 'channel') || getFlag(flags, 'channel-id') || getFlag(flags, 'chat-id');
  const threadId = flags.has('thread')
    ? normalizeMaybeBooleanFlag(getFlag(flags, 'thread')) || context.threadId
    : '';
  const suffix = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : '';
  const response = await request<{ jobs: ScheduledJob[] }>(context.baseUrl, 'GET', `/scheduler/jobs${suffix}`);
  let jobs = response.jobs;
  if (threadId) {
    jobs = jobs.filter((job) => job.route.threadId === threadId || scheduledJobMatchesCliContext(job, context));
  } else if (!showAllChannels && (explicitChannelId || context.chatId)) {
    const targetChannel = explicitChannelId || context.chatId;
    jobs = jobs.filter((job) => job.route.channelId === targetChannel || scheduledJobMatchesCliContext(job, context));
  }
  print(json, io.stdout, { jobs: jobs.map(presentJob) }, jobs.length === 0 ? 'No scheduler jobs.' : jobs.map(formatJobLine).join('\n'));
  return 0;
}

async function handleInfo(jobId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!jobId) {
    throw new Error('scheduler info requires a job id.');
  }
  const context = resolveContext(flags, env);
  const job = await request<ScheduledJob>(context.baseUrl, 'GET', `/scheduler/jobs/${encodeURIComponent(jobId)}`);
  const runs = await request<{ runs: ScheduledJobRun[] }>(context.baseUrl, 'GET', `/scheduler/jobs/${encodeURIComponent(jobId)}/runs`);
  print(json, io.stdout, { job: presentJob(job), runs: runs.runs }, formatJobDetails(job, runs.runs[0]));
  return 0;
}

async function handleEdit(jobId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!jobId) {
    throw new Error('scheduler edit requires a job id.');
  }
  const input: ScheduledJobUpdateInput = {};
  const cronExpr = getFlag(flags, 'cron');
  const promptTemplate = getFlag(flags, 'message');
  const description = getFlag(flags, 'desc');
  const enabled = getOptionalBooleanFlag(flags, 'enabled');
  const executionMode = getFlag(flags, 'execution-mode');
  if (cronExpr) {
    input.cronExpr = cronExpr;
  }
  if (promptTemplate) {
    input.promptTemplate = promptTemplate;
  }
  if (description) {
    input.description = description;
  }
  if (typeof enabled === 'boolean') {
    input.enabled = enabled;
  }
  if (executionMode) {
    input.executionMode = normalizeScheduledJobExecutionMode(executionMode);
  }
  if (Object.keys(input).length === 0) {
    throw new Error('scheduler edit requires at least one editable field.');
  }
  const context = resolveContext(flags, env);
  const job = await request<ScheduledJob>(context.baseUrl, 'PATCH', `/scheduler/jobs/${encodeURIComponent(jobId)}`, input);
  print(json, io.stdout, presentJob(job), `Updated scheduler job ${toPublicScheduledJobId(job.id)}`);
  return 0;
}

async function handleDelete(jobId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!jobId) {
    throw new Error('scheduler del requires a job id.');
  }
  const context = resolveContext(flags, env);
  const result = await request<{ deleted: boolean }>(context.baseUrl, 'DELETE', `/scheduler/jobs/${encodeURIComponent(jobId)}`);
  print(json, io.stdout, result, `Deleted scheduler job ${jobId}`);
  return 0;
}

async function handleRun(jobId: string, flags: Map<string, string[]>, env: NodeJS.ProcessEnv, io: StdIo, json: boolean) {
  if (!jobId) {
    throw new Error('scheduler run requires a job id.');
  }
  const context = resolveContext(flags, env);
  const run = await request<ScheduledJobRun>(context.baseUrl, 'POST', `/scheduler/jobs/${encodeURIComponent(jobId)}/run`);
  print(json, io.stdout, run, `Triggered scheduler job ${jobId}: ${run.status}`);
  return 0;
}

function getExecutionMode(flags: Map<string, string[]>) {
  return normalizeScheduledJobExecutionMode(getFlag(flags, 'execution-mode'));
}

function getMonitorExecutionMode(flags: Map<string, string[]>) {
  return normalizeScheduledJobExecutionMode(getFlag(flags, 'execution-mode') || 'side-thread');
}

function buildSourceConfig(sourceType: string, flags: Map<string, string[]>) {
  const config: Record<string, unknown> = {};
  if (sourceType === 'stock.quote') {
    config.symbol = getRequiredFlag(flags, 'symbol').toUpperCase();
    const price = getFlag(flags, 'price');
    if (price) config.price = Number(price);
    const bollInterval = getFlag(flags, 'boll-interval');
    if (bollInterval) config.bollInterval = bollInterval;
    const bollPeriod = getFlag(flags, 'boll-period');
    if (bollPeriod) config.bollPeriod = Number(bollPeriod);
    const bollStdDev = getFlag(flags, 'boll-std-dev');
    if (bollStdDev) config.bollStdDev = Number(bollStdDev);
    const treasuryYield = getFlag(flags, 'treasury-yield');
    if (treasuryYield) config.treasury10yYield = Number(treasuryYield);
  } else if (sourceType === 'webhook') {
    const hookId = getFlag(flags, 'hook-id');
    if (hookId) config.hookId = hookId;
    const token = getFlag(flags, 'token');
    if (token) config.token = token;
  }
  const rawConfig = getFlag(flags, 'source-config');
  if (rawConfig) {
    return { ...config, ...JSON.parse(rawConfig) as Record<string, unknown> };
  }
  return config;
}

function printUsage(output: Pick<NodeJS.WriteStream, 'write'>) {
  output.write([
    'Usage:',
    '  lac skill add <owner/repo>[@ref] [--scope user|workspace] [--skills-dir <dir>] [--force] [--json]',
    '  lac skill list [--installed] [--workspace <id>] [--json]',
    '  lac skill update <name|all> [--force] [--json]',
    '  lac skill remove <name> [--scope user|workspace] [--json]',
    '  lac skill verify [<name>] [--json]',
    '  lac skill scan [<name>] [--all] [--workspace <id>] [--json]',
    '  lac scheduler add --cron "<expr>" --message "<text>" --desc "<label>" [--execution-mode same-thread|side-thread] [--json]',
    '  lac scheduler list [--workspace <id>] [--thread [<id>]] [--json]',
    '  lac scheduler info <job-id> [--json]',
    '  lac scheduler edit <job-id> [--cron "<expr>"] [--message "<text>"] [--desc "<label>"] [--enabled true|false] [--execution-mode same-thread|side-thread] [--json]',
    '  lac scheduler del <job-id> [--json]',
    '  lac scheduler run <job-id> [--json]',
    '  lac monitor add --title "<title>" --source stock.quote|webhook [--symbol <symbol>] [--hook-id <id>] [--token <tok>] --condition "<expr>" --message "<text>" [--cooldown 15m] [--cron "<expr>"] [--timezone <tz>] [--workflow direct|deep-analysis] [--retro-delay <hours>] [--execution-mode same-thread|side-thread] [--json]',
    '  lac monitor list [--workspace <id>] [--thread [<id>]] [--json]',
    '  lac monitor info <monitor-id> [--json]',
    '  lac monitor decisions <monitor-id> [--json]',
    '  lac monitor edit <monitor-id> [--title "<title>"] [--condition "<expr>"] [--message "<text>"] [--enabled true|false] [--cooldown 15m] [--cron "<expr>"|off] [--timezone <tz>] [--workflow direct|deep-analysis] [--retro-delay <hours>] [--execution-mode same-thread|side-thread] [--json]',
    '  lac monitor del <monitor-id> [--json]',
    '  lac monitor run <monitor-id> [--json]',
    '  lac automation add --title "<title>" --script-id <script-id> --script-version <approved-version-id> --interval <duration> --message "<prompt>" [--json]',
    '  lac automation list|info <id>|edit <id> [--title "<title>"] [--enabled true|false]|del <id>|check <id> [--json]',
    '  lac script list|create --title "<title>"|stage --script <script-id> --source-json "<files-json>"|status <version-id> [--json]',
    '  lac script test-approval|test|enable-approval|revoke <version-id> --actor <actor> [--json]',
    '  lac script approve|reject <version-id> --approval <approval-id> --actor <actor> [--json]',
    '  lac channel send-file --path "<file>" [--target <chat-or-user-id>] [--workspace <id>] [--workspace-path <path>] [--platform lark] [--name <filename>] [--json]',
  ].join('\n') + '\n');
}

function formatJobLine(job: ScheduledJob) {
  const schedule = job.triggerType === 'cron' ? job.cronExpr || '' : job.runAt || '';
  return `${toPublicScheduledJobId(job.id)} | ${job.enabled ? 'enabled' : 'disabled'} | ${job.executionMode} | ${schedule} | ${job.description}`;
}

function formatJobDetails(job: ScheduledJob, latestRun?: ScheduledJobRun) {
  return [
    `Job: ${toPublicScheduledJobId(job.id)}`,
    `Workspace: ${job.workspaceId}`,
    `Platform: ${job.platform}`,
    `Thread: ${job.route.threadId || ''}`,
    `Execution mode: ${job.executionMode}`,
    `Schedule: ${job.triggerType === 'cron' ? job.cronExpr || '' : job.runAt || ''}`,
    `Enabled: ${job.enabled ? 'true' : 'false'}`,
    `Description: ${job.description}`,
    `Message: ${job.promptTemplate}`,
    latestRun ? `Latest run: ${latestRun.status} @ ${latestRun.triggeredAt}` : 'Latest run: none',
  ].join('\n');
}

function presentJob(job: ScheduledJob): ScheduledJob {
  return {
    ...job,
    id: toPublicScheduledJobId(job.id),
  };
}

function formatMonitorLine(monitor: AutomationMonitor) {
  return `${toPublicAutomationMonitorId(monitor.id)} | ${monitor.enabled ? 'enabled' : 'disabled'} | ${monitor.executionMode} | ${monitor.sourceType} | ${formatCondition(monitor.condition)} | ${monitor.title}`;
}

function formatMonitorDetails(monitor: AutomationMonitor, latestRun?: AutomationMonitorRun) {
  return [
    `Monitor: ${toPublicAutomationMonitorId(monitor.id)}`,
    `Title: ${monitor.title}`,
    `Workspace: ${monitor.workspaceId}`,
    `Platform: ${monitor.platform}`,
    `Thread: ${monitor.route.threadId || ''}`,
    `Execution mode: ${monitor.executionMode}`,
    ...(monitor.workflowTemplate ? [`Workflow: ${monitor.workflowTemplate}`] : []),
    ...(monitor.retrospectiveDelayHours ? [`Retro delay: ${monitor.retrospectiveDelayHours}h`] : []),
    `Source: ${monitor.sourceType}`,
    ...(monitor.sourceType === 'webhook' && monitor.sourceConfig?.hookId ? [
      `Hook ID: ${monitor.sourceConfig.hookId}`,
      `Token: ${monitor.sourceConfig.token || '(none)'}`,
    ] : []),
    `Condition: ${formatCondition(monitor.condition)}`,
    `Cooldown: ${monitor.cooldownMs}ms`,
    ...(monitor.schedule ? [`Schedule: ${monitor.schedule.cron} (${monitor.schedule.timezone})`] : []),
    `Enabled: ${monitor.enabled ? 'true' : 'false'}`,
    `Message: ${monitor.promptTemplate}`,
    latestRun ? `Latest run: ${latestRun.status} @ ${latestRun.triggeredAt}` : 'Latest run: none',
  ].join('\n');
}

function formatCondition(condition: AutomationMonitorCondition) {
  if (condition.expression) {
    return condition.expression;
  }
  return `${condition.metric} ${condition.operator} ${condition.value}`;
}

function presentMonitor(monitor: AutomationMonitor): AutomationMonitor {
  return {
    ...monitor,
    id: toPublicAutomationMonitorId(monitor.id),
  };
}

function monitorMatchesCliContext(monitor: AutomationMonitor, context: CliContext) {
  return scheduledJobMatchesCliContext(automationMonitorToScheduledJob(monitor), context);
}

void (async () => {
  if (typeof require === 'undefined' || require.main !== module) {
    return;
  }
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
})();
