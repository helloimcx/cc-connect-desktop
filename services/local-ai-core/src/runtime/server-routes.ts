export type LocalAiCoreRoute =
  | { name: 'health' }
  | { name: 'runtime.status' }
  | { name: 'runtime.service.start' }
  | { name: 'runtime.service.stop' }
  | { name: 'runtime.service.restart' }
  | { name: 'runtime.logs' }
  | { name: 'logs.list' }
  | { name: 'runtime.agent-runtimes' }
  | { name: 'runtime.runtime-config.read' }
  | { name: 'runtime.runtime-config.save' }
  | { name: 'runtime.settings.save' }
  | { name: 'runtimes.list' }
  | { name: 'runtimes.detail'; runtimeId: string }
  | { name: 'runtimes.refresh' }
  | { name: 'runtimes.refresh-one'; runtimeId: string }
  | { name: 'scheduler.jobs.list' }
  | { name: 'scheduler.jobs.create' }
  | { name: 'scheduler.job.get'; jobId: string }
  | { name: 'scheduler.job.runs'; jobId: string }
  | { name: 'scheduler.job.run'; jobId: string }
  | { name: 'scheduler.job.update'; jobId: string }
  | { name: 'scheduler.job.delete'; jobId: string }
  | { name: 'automation.monitors.list' }
  | { name: 'automation.monitors.create' }
  | { name: 'automation.monitor.get'; monitorId: string }
  | { name: 'automation.monitor.runs'; monitorId: string }
  | { name: 'automation.monitor.run'; monitorId: string }
  | { name: 'automation.monitor.update'; monitorId: string }
  | { name: 'automation.monitor.delete'; monitorId: string }
  | { name: 'automation.hooks.trigger'; hookId: string }
  | { name: 'automations.list' }
  | { name: 'automations.create' }
  | { name: 'automation.get'; automationId: string }
  | { name: 'automation.update'; automationId: string }
  | { name: 'automation.delete'; automationId: string }
  | { name: 'automation.check'; automationId: string }
  | { name: 'automation.evaluations'; automationId: string }
  | { name: 'automation.runs'; automationId: string }
  | { name: 'automation-scripts.list' }
  | { name: 'automation-scripts.create' }
  | { name: 'automation-script.get'; scriptId: string }
  | { name: 'automation-script.update'; scriptId: string }
  | { name: 'automation-script.versions'; scriptId: string }
  | { name: 'automation-script.version.submit'; scriptId: string }
  | { name: 'automation-script-version.test-approval'; versionId: string }
  | { name: 'automation-script-version.test'; versionId: string }
  | { name: 'automation-script-version.enable-approval'; versionId: string }
  | { name: 'automation-script-version.approve'; versionId: string }
  | { name: 'automation-script-version.reject'; versionId: string }
  | { name: 'automation-script-version.revoke'; versionId: string }
  | { name: 'threads.list' }
  | { name: 'threads.create' }
  | { name: 'thread.get'; threadId: string }
  | { name: 'thread.rename'; threadId: string }
  | { name: 'thread.update-mode'; threadId: string }
  | { name: 'thread.update-knowledge-bases'; threadId: string }
  | { name: 'thread.delete'; threadId: string }
  | { name: 'thread.messages.send'; threadId: string }
  | { name: 'thread.actions.send'; threadId: string }
  | { name: 'run.interrupt'; runId: string }
  | { name: 'runs.trace.get'; runId: string }
  | { name: 'runs.spans.list'; runId: string }
  | { name: 'costs.summary' }
  | { name: 'costs.events' }
  | { name: 'costs.top-runs' }
  | { name: 'budgets.list' }
  | { name: 'budgets.create' }
  | { name: 'budget.get'; id: string }
  | { name: 'budget.update'; id: string }
  | { name: 'budget.delete'; id: string }
  | { name: 'workspaces.list' }
  | { name: 'workspace-registry.list' }
  | { name: 'workspace-registry.get'; workspaceId: string }
  | { name: 'providers.list' }
  | { name: 'providers.create' }
  | { name: 'provider.update'; providerId: string }
  | { name: 'provider.delete'; providerId: string }
  | { name: 'workspace-security.get'; workspaceId: string }
  | { name: 'workspace-security.update'; workspaceId: string }
  | { name: 'security.command-risk.classify' }
  | { name: 'approvals.list' }
  | { name: 'approvals.create' }
  | { name: 'approval.get'; approvalId: string }
  | { name: 'approval.resolve'; approvalId: string }
  | { name: 'audit-events.list' }
  | { name: 'tasks.list' }
  | { name: 'tasks.create' }
  | { name: 'task.get'; taskId: string }
  | { name: 'task.update'; taskId: string }
  | { name: 'task.artifacts.list'; taskId: string }
  | { name: 'task.artifact.content'; taskId: string; artifactId: string }
  | { name: 'knowledge.sources.list' }
  | { name: 'knowledge.config.read' }
  | { name: 'knowledge.config.update' }
  | { name: 'knowledge.folders.list' }
  | { name: 'knowledge.folders.create' }
  | { name: 'knowledge.folder.update'; folderId: string }
  | { name: 'knowledge.folder.delete'; folderId: string }
  | { name: 'knowledge.bases.list' }
  | { name: 'knowledge.bases.create' }
  | { name: 'knowledge.base.get'; knowledgeBaseId: string }
  | { name: 'knowledge.base.update'; knowledgeBaseId: string }
  | { name: 'knowledge.base.delete'; knowledgeBaseId: string }
  | { name: 'knowledge.base.files.list'; knowledgeBaseId: string }
  | { name: 'knowledge.base.files.upload'; knowledgeBaseId: string }
  | { name: 'knowledge.base.file.delete'; knowledgeBaseId: string; fileId: string }
  | { name: 'knowledge.base.search'; knowledgeBaseId: string }
  | { name: 'skills.list' }
  | { name: 'skills.get'; skillId: string }
  | { name: 'skills.save' }
  | { name: 'skills.delete' }
  | { name: 'skills.install' }
  | { name: 'skills.installBundle' }
  | { name: 'skills.add' }
  | { name: 'skills.update' }
  | { name: 'skills.verify' }
  | { name: 'skills.sources' }
  | { name: 'skills.toggle' }
  | { name: 'skills.scan' }
  | { name: 'skills.route' }
  | { name: 'capabilities.read' }
  | { name: 'capabilities.snapshot' }
  | { name: 'diagnostics.errors' }
  | { name: 'diagnostics.doctor' }
  | { name: 'diagnostics.deployment' }
  | { name: 'plugins.diagnostics' }
  | { name: 'workspace.streaming-probe'; workspaceId: string }
  | { name: 'external.project.ensure' }
  | { name: 'external.run.create' }
  | { name: 'external.run.events'; runId: string }
  | { name: 'openai.chat.completions' }
  | { name: 'events.stream' }
  | { name: 'platform.gateways.list'; platform: string }
  | { name: 'platform.pairings.list'; platform: string }
  | { name: 'platform.users.list'; platform: string }
  | { name: 'platform.gateway.get'; platform: string; workspaceId: string }
  | { name: 'platform.qrcode.status'; platform: string; workspaceId: string }
  | { name: 'platform.pairing.approve'; platform: string }
  | { name: 'platform.pairing.reject'; platform: string }
  | { name: 'platform.gateway.test'; platform: string; workspaceId: string }
  | { name: 'platform.gateway.enable'; platform: string; workspaceId: string }
  | { name: 'platform.gateway.disable'; platform: string; workspaceId: string }
  | { name: 'platform.file.send'; platform: string; workspaceId: string }
  | { name: 'platform.message.send'; platform: string; workspaceId: string }
  | { name: 'platform.qrcode.create'; platform: string; workspaceId: string };

const API_PREFIX = '/api/local/v1';

const STATIC_LOCALCORE_ROUTES: Record<string, LocalAiCoreRoute> = {
  'GET /health': { name: 'health' },
  'GET /runtime': { name: 'runtime.status' },
  'POST /runtime/service/start': { name: 'runtime.service.start' },
  'POST /runtime/service/stop': { name: 'runtime.service.stop' },
  'POST /runtime/service/restart': { name: 'runtime.service.restart' },
  'GET /runtime/logs': { name: 'runtime.logs' },
  'GET /logs': { name: 'logs.list' },
  'GET /runtime/agent-runtimes': { name: 'runtime.agent-runtimes' },
  'GET /runtime/runtime-config': { name: 'runtime.runtime-config.read' },
  'GET /runtime/config': { name: 'runtime.runtime-config.read' },
  'POST /runtime/runtime-config': { name: 'runtime.runtime-config.save' },
  'POST /runtime/settings': { name: 'runtime.settings.save' },
};

export function parseLocalAiCoreRoute(method: string | undefined, path: string): LocalAiCoreRoute | null {
  const normalizedMethod = String(method || '').toUpperCase();
  const relativePath = path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) || '/' : path;

  const staticMatch = STATIC_LOCALCORE_ROUTES[`${normalizedMethod} ${relativePath}`];
  if (staticMatch) {
    return staticMatch;
  }

  const segments = splitRouteSegments(relativePath);
  if (segments[0] === 'scheduler' && segments[1] === 'jobs') {
    return parseSchedulerJobsRoute(normalizedMethod, segments);
  }
  if (segments[0] === 'automation' && segments[1] === 'monitors') {
    return parseAutomationMonitorsRoute(normalizedMethod, segments);
  }
  if (segments[0] === 'automation' && segments[1] === 'hooks') {
    return parseAutomationHooksRoute(normalizedMethod, segments);
  }
  if (normalizedMethod === 'GET' && segments.length === 1 && segments[0] === 'events') {
    return { name: 'events.stream' };
  }
  const parser = SEGMENT_ROUTE_PARSERS[segments[0]];
  if (parser) {
    return parser(normalizedMethod, segments);
  }

  return null;
}

type SegmentRouteParser = (method: string, segments: string[]) => LocalAiCoreRoute | null;

const SEGMENT_ROUTE_PARSERS: Record<string, SegmentRouteParser> = {
  runtimes: parseRuntimesRoute,
  automations: parseAutomationsRoute,
  'automation-scripts': parseAutomationScriptsRoute,
  threads: parseThreadsRoute,
  runs: parseRunsRoute,
  workspaces: parseWorkspacesRoute,
  'workspace-registry': parseWorkspaceRegistryRoute,
  providers: parseProvidersRoute,
  'workspace-security': parseWorkspaceSecurityRoute,
  security: parseSecurityRoute,
  approvals: parseApprovalsRoute,
  'audit-events': parseAuditEventsRoute,
  tasks: parseTasksRoute,
  knowledge: parseKnowledgeRoute,
  skills: parseSkillsRoute,
  capabilities: parseCapabilitiesRoute,
  diagnostics: parseDiagnosticsRoute,
  plugins: parsePluginsRoute,
  external: parseExternalRoute,
  openai: parseOpenAiRoute,
  costs: parseCostsRoute,
  budgets: parseBudgetsRoute,
  platforms: parsePlatformsRoute,
};

function parseAutomationActionRoute(method: string, automationId: string, action: string): LocalAiCoreRoute | null {
  if (method === 'POST' && action === 'check') return { name: 'automation.check', automationId };
  if (method === 'GET' && action === 'evaluations') return { name: 'automation.evaluations', automationId };
  if (method === 'GET' && action === 'runs') return { name: 'automation.runs', automationId };
  return null;
}

function parseAutomationsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (segments.length === 1) {
    if (method === 'GET') return { name: 'automations.list' };
    if (method === 'POST') return { name: 'automations.create' };
    return null;
  }
  const automationId = decodeURIComponent(segments[1] || '').trim();
  if (!automationId) return null;
  if (segments.length === 2) {
    if (method === 'GET') return { name: 'automation.get', automationId };
    if (method === 'PATCH') return { name: 'automation.update', automationId };
    if (method === 'DELETE') return { name: 'automation.delete', automationId };
    return null;
  }
  if (segments.length === 3) {
    return parseAutomationActionRoute(method, automationId, segments[2]);
  }
  return null;
}

function parseAutomationScriptsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (segments.length === 1) {
    if (method === 'GET') return { name: 'automation-scripts.list' };
    if (method === 'POST') return { name: 'automation-scripts.create' };
    return null;
  }
  if (segments[1] === 'versions') {
    const versionId = decodeURIComponent(segments[2] || '').trim();
    if (!versionId || segments.length !== 4 || method !== 'POST') return null;
    switch (segments[3]) {
      case 'test-approval': return { name: 'automation-script-version.test-approval', versionId };
      case 'test': return { name: 'automation-script-version.test', versionId };
      case 'enable-approval': return { name: 'automation-script-version.enable-approval', versionId };
      case 'approve': return { name: 'automation-script-version.approve', versionId };
      case 'reject': return { name: 'automation-script-version.reject', versionId };
      case 'revoke': return { name: 'automation-script-version.revoke', versionId };
      default: return null;
    }
  }
  const scriptId = decodeURIComponent(segments[1] || '').trim();
  if (!scriptId) return null;
  if (segments.length === 2) {
    if (method === 'GET') return { name: 'automation-script.get', scriptId };
    if (method === 'PATCH') return { name: 'automation-script.update', scriptId };
  }
  if (segments.length === 3 && segments[2] === 'versions') {
    if (method === 'GET') return { name: 'automation-script.versions', scriptId };
    if (method === 'POST') return { name: 'automation-script.version.submit', scriptId };
  }
  return null;
}

function parseOpenAiRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'POST' && segments.length === 3 && segments[1] === 'chat' && segments[2] === 'completions') {
    return { name: 'openai.chat.completions' };
  }
  return null;
}

function parseExternalRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'POST' && segments.length === 2 && segments[1] === 'projects') {
    return { name: 'external.project.ensure' };
  }
  if (method === 'POST' && segments.length === 2 && segments[1] === 'runs') {
    return { name: 'external.run.create' };
  }
  if (method === 'GET' && segments.length === 4 && segments[1] === 'runs' && segments[3] === 'events') {
    const runId = decodeURIComponent(segments[2] || '').trim();
    return runId ? { name: 'external.run.events', runId } : null;
  }
  return null;
}

function parseProvidersRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 1) {
    return { name: 'providers.list' };
  }
  if (method === 'POST' && segments.length === 1) {
    return { name: 'providers.create' };
  }
  const providerId = segments.length >= 2 ? decodeURIComponent(segments[1] || '') : '';
  if (!providerId || segments.length !== 2) {
    return null;
  }
  if (method === 'PUT' || method === 'PATCH') {
    return { name: 'provider.update', providerId };
  }
  if (method === 'DELETE') {
    return { name: 'provider.delete', providerId };
  }
  return null;
}

function parseAutomationMonitorsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 2) {
    return { name: 'automation.monitors.list' };
  }
  if (method === 'POST' && segments.length === 2) {
    return { name: 'automation.monitors.create' };
  }
  const monitorId = segments.length >= 3 ? decodeURIComponent(segments[2] || '') : '';
  if (!monitorId) {
    return null;
  }
  if (method === 'GET' && segments.length === 3) {
    return { name: 'automation.monitor.get', monitorId };
  }
  if (method === 'GET' && segments.length === 4 && segments[3] === 'runs') {
    return { name: 'automation.monitor.runs', monitorId };
  }
  if (method === 'POST' && segments.length === 4 && segments[3] === 'run') {
    return { name: 'automation.monitor.run', monitorId };
  }
  if (method === 'PATCH' && segments.length === 3) {
    return { name: 'automation.monitor.update', monitorId };
  }
  if (method === 'DELETE' && segments.length === 3) {
    return { name: 'automation.monitor.delete', monitorId };
  }
  return null;
}

function parseAutomationHooksRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'POST' && segments.length === 3) {
    const hookId = decodeURIComponent(segments[2] || '').trim();
    return hookId ? { name: 'automation.hooks.trigger', hookId } : null;
  }
  return null;
}

function parseRuntimesRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 1) {
    return { name: 'runtimes.list' };
  }
  if (method === 'POST' && segments.length === 2 && segments[1] === 'refresh') {
    return { name: 'runtimes.refresh' };
  }
  if (method === 'GET' && segments.length === 2) {
    return { name: 'runtimes.detail', runtimeId: decodeURIComponent(segments[1] || '') };
  }
  if (method === 'POST' && segments.length === 3 && segments[2] === 'refresh') {
    return { name: 'runtimes.refresh-one', runtimeId: decodeURIComponent(segments[1] || '') };
  }
  return null;
}

function parseSchedulerJobsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 2) {
    return { name: 'scheduler.jobs.list' };
  }
  if (method === 'POST' && segments.length === 2) {
    return { name: 'scheduler.jobs.create' };
  }
  const jobId = segments.length >= 3 ? decodeURIComponent(segments[2] || '') : '';
  if (!jobId) {
    return null;
  }
  if (method === 'GET' && segments.length === 3) {
    return { name: 'scheduler.job.get', jobId };
  }
  if (method === 'GET' && segments.length === 4 && segments[3] === 'runs') {
    return { name: 'scheduler.job.runs', jobId };
  }
  if (method === 'POST' && segments.length === 4 && segments[3] === 'run') {
    return { name: 'scheduler.job.run', jobId };
  }
  if (method === 'PATCH' && segments.length === 3) {
    return { name: 'scheduler.job.update', jobId };
  }
  if (method === 'DELETE' && segments.length === 3) {
    return { name: 'scheduler.job.delete', jobId };
  }
  return null;
}

function parseThreadsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 1) {
    return { name: 'threads.list' };
  }
  if (method === 'POST' && segments.length === 1) {
    return { name: 'threads.create' };
  }
  const threadId = segments.length >= 2 ? decodeURIComponent(segments[1] || '') : '';
  if (!threadId) {
    return null;
  }
  if (method === 'GET' && segments.length === 2) {
    return { name: 'thread.get', threadId };
  }
  if (method === 'PATCH' && segments.length === 2) {
    return { name: 'thread.rename', threadId };
  }
  if (method === 'DELETE' && segments.length === 2) {
    return { name: 'thread.delete', threadId };
  }
  if (method === 'PATCH' && segments.length === 3 && segments[2] === 'knowledge-bases') {
    return { name: 'thread.update-knowledge-bases', threadId };
  }
  if (method === 'PATCH' && segments.length === 3 && segments[2] === 'mode') {
    return { name: 'thread.update-mode', threadId };
  }
  if (method === 'POST' && segments.length === 3 && segments[2] === 'messages') {
    return { name: 'thread.messages.send', threadId };
  }
  if (method === 'POST' && segments.length === 3 && segments[2] === 'actions') {
    return { name: 'thread.actions.send', threadId };
  }
  return null;
}

function parseRunsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  const runId = segments.length >= 2 ? decodeURIComponent(segments[1] || '') : '';
  if (!runId) return null;
  if (method === 'POST' && segments.length === 3 && segments[2] === 'interrupt') {
    return { name: 'run.interrupt', runId };
  }
  if (method === 'GET' && segments.length === 3 && segments[2] === 'trace') {
    return { name: 'runs.trace.get', runId };
  }
  if (method === 'GET' && segments.length === 3 && segments[2] === 'spans') {
    return { name: 'runs.spans.list', runId };
  }
  return null;
}

function parseWorkspacesRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 1) {
    return { name: 'workspaces.list' };
  }
  const workspaceId = segments.length >= 2 ? decodeURIComponent(segments[1] || '') : '';
  if (method === 'POST' && workspaceId && segments.length === 3 && segments[2] === 'streaming-probe') {
    return { name: 'workspace.streaming-probe', workspaceId };
  }
  return null;
}

function parseWorkspaceRegistryRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 1) {
    return { name: 'workspace-registry.list' };
  }
  const workspaceId = segments.length >= 2 ? decodeURIComponent(segments[1] || '') : '';
  if (!workspaceId || segments.length !== 2) {
    return null;
  }
  if (method === 'GET') {
    return { name: 'workspace-registry.get', workspaceId };
  }
  return null;
}

function parseWorkspaceSecurityRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  const workspaceId = segments.length >= 2 ? decodeURIComponent(segments[1] || '') : '';
  if (!workspaceId || segments.length !== 2) {
    return null;
  }
  if (method === 'GET') {
    return { name: 'workspace-security.get', workspaceId };
  }
  if (method === 'PATCH') {
    return { name: 'workspace-security.update', workspaceId };
  }
  return null;
}

function parseSecurityRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'POST' && segments.length === 2 && segments[1] === 'command-risk') {
    return { name: 'security.command-risk.classify' };
  }
  return null;
}

function parseApprovalsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 1) {
    return { name: 'approvals.list' };
  }
  if (method === 'POST' && segments.length === 1) {
    return { name: 'approvals.create' };
  }
  const approvalId = segments.length >= 2 ? decodeURIComponent(segments[1] || '') : '';
  if (!approvalId) {
    return null;
  }
  if (method === 'GET' && segments.length === 2) {
    return { name: 'approval.get', approvalId };
  }
  if (method === 'POST' && segments.length === 3 && segments[2] === 'resolve') {
    return { name: 'approval.resolve', approvalId };
  }
  return null;
}

function parseAuditEventsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 1) {
    return { name: 'audit-events.list' };
  }
  return null;
}

function parseTaskSubresourceRoute(method: string, segments: string[], taskId: string): LocalAiCoreRoute | null {
  if (segments.length === 2) {
    if (method === 'GET') {
      return { name: 'task.get', taskId };
    }
    if (method === 'PATCH') {
      return { name: 'task.update', taskId };
    }
    return null;
  }
  if (segments.length === 3 && segments[2] === 'artifacts') {
    return method === 'GET' ? { name: 'task.artifacts.list', taskId } : null;
  }
  if (segments.length === 5 && segments[2] === 'artifacts' && segments[4] === 'content') {
    const artifactId = decodeURIComponent(segments[3] || '');
    return method === 'GET' && artifactId ? { name: 'task.artifact.content', taskId, artifactId } : null;
  }
  return null;
}

function parseTasksRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 1) {
    return { name: 'tasks.list' };
  }
  if (method === 'POST' && segments.length === 1) {
    return { name: 'tasks.create' };
  }
  const taskId = segments.length >= 2 ? decodeURIComponent(segments[1] || '') : '';
  if (!taskId) {
    return null;
  }
  return parseTaskSubresourceRoute(method, segments, taskId);
}

function parseKnowledgeRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 2 && segments[1] === 'sources') {
    return { name: 'knowledge.sources.list' };
  }
  if (segments.length === 2 && segments[1] === 'config') {
    if (method === 'GET') {
      return { name: 'knowledge.config.read' };
    }
    if (method === 'POST') {
      return { name: 'knowledge.config.update' };
    }
    return null;
  }
  if (segments[1] === 'folders') {
    return parseKnowledgeFoldersRoute(method, segments);
  }
  if (segments[1] === 'bases') {
    return parseKnowledgeBasesRoute(method, segments);
  }
  return null;
}

function parseSkillsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (segments.length === 1) {
    if (method === 'GET') return { name: 'skills.list' };
    if (method === 'POST') return { name: 'skills.save' };
    if (method === 'DELETE') return { name: 'skills.delete' };
  }
  if (segments.length === 2) {
    if (segments[1] === 'install' && method === 'POST') return { name: 'skills.install' };
    if (segments[1] === 'install-bundle' && method === 'POST') return { name: 'skills.installBundle' };
    if (segments[1] === 'add' && method === 'POST') return { name: 'skills.add' };
    if (segments[1] === 'update' && method === 'POST') return { name: 'skills.update' };
    if (segments[1] === 'verify' && method === 'GET') return { name: 'skills.verify' };
    if (segments[1] === 'sources' && method === 'GET') return { name: 'skills.sources' };
    if (segments[1] === 'toggle' && method === 'POST') return { name: 'skills.toggle' };
    if (segments[1] === 'scan' && (method === 'GET' || method === 'POST')) return { name: 'skills.scan' };
    if (segments[1] === 'route' && (method === 'GET' || method === 'POST')) return { name: 'skills.route' };
    if (method === 'GET') return { name: 'skills.get', skillId: decodeURIComponent(segments[1]) };
  }
  return null;
}

function parseKnowledgeFoldersRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (segments.length === 2) {
    if (method === 'GET') {
      return { name: 'knowledge.folders.list' };
    }
    if (method === 'POST') {
      return { name: 'knowledge.folders.create' };
    }
    return null;
  }
  const folderId = segments.length >= 3 ? decodeURIComponent(segments[2] || '') : '';
  if (!folderId || segments.length !== 3) {
    return null;
  }
  if (method === 'PATCH') {
    return { name: 'knowledge.folder.update', folderId };
  }
  if (method === 'DELETE') {
    return { name: 'knowledge.folder.delete', folderId };
  }
  return null;
}

function parseKnowledgeBasesRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (segments.length === 2) {
    if (method === 'GET') {
      return { name: 'knowledge.bases.list' };
    }
    if (method === 'POST') {
      return { name: 'knowledge.bases.create' };
    }
    return null;
  }

  const knowledgeBaseId = segments.length >= 3 ? decodeURIComponent(segments[2] || '') : '';
  if (!knowledgeBaseId) {
    return null;
  }
  if (segments.length === 3) {
    if (method === 'GET') {
      return { name: 'knowledge.base.get', knowledgeBaseId };
    }
    if (method === 'PATCH') {
      return { name: 'knowledge.base.update', knowledgeBaseId };
    }
    if (method === 'DELETE') {
      return { name: 'knowledge.base.delete', knowledgeBaseId };
    }
    return null;
  }
  if (segments.length === 4 && segments[3] === 'files') {
    if (method === 'GET') {
      return { name: 'knowledge.base.files.list', knowledgeBaseId };
    }
    if (method === 'POST') {
      return { name: 'knowledge.base.files.upload', knowledgeBaseId };
    }
    return null;
  }
  if (method === 'DELETE' && segments.length === 5 && segments[3] === 'files') {
    const fileId = decodeURIComponent(segments[4] || '');
    return fileId ? { name: 'knowledge.base.file.delete', knowledgeBaseId, fileId } : null;
  }
  if (method === 'POST' && segments.length === 4 && segments[3] === 'search') {
    return { name: 'knowledge.base.search', knowledgeBaseId };
  }
  return null;
}

function parseCapabilitiesRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 1) {
    return { name: 'capabilities.read' };
  }
  if (method === 'GET' && segments.length === 2 && segments[1] === 'snapshot') {
    return { name: 'capabilities.snapshot' };
  }
  return null;
}

function parsePluginsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 2 && segments[1] === 'diagnostics') {
    return { name: 'plugins.diagnostics' };
  }
  return null;
}

function parseDiagnosticsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'POST' && segments.length === 2 && segments[1] === 'deployment') {
    return { name: 'diagnostics.deployment' };
  }
  if (method === 'GET' && segments.length === 2 && segments[1] === 'errors') {
    return { name: 'diagnostics.errors' };
  }
  if (method === 'POST' && segments.length === 2 && segments[1] === 'doctor') {
    return { name: 'diagnostics.doctor' };
  }
  return null;
}

function parsePlatformsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  const platform = segments.length >= 2 ? decodeURIComponent(segments[1] || '') : '';
  if (!platform) {
    return null;
  }
  if (method === 'GET') {
    return parsePlatformReadRoute(platform, segments);
  }
  if (method === 'POST') {
    return parsePlatformWriteRoute(platform, segments);
  }
  return null;
}

function parsePlatformReadRoute(platform: string, segments: string[]): LocalAiCoreRoute | null {
  if (segments.length === 2) {
    return { name: 'platform.gateways.list', platform };
  }
  if (segments.length === 3 && segments[2] === 'pairings') {
    return { name: 'platform.pairings.list', platform };
  }
  if (segments.length === 3 && segments[2] === 'users') {
    return { name: 'platform.users.list', platform };
  }
  const workspaceId = segments.length >= 3 ? decodeURIComponent(segments[2] || '') : '';
  if (!workspaceId) {
    return null;
  }
  if (segments.length === 3) {
    return { name: 'platform.gateway.get', platform, workspaceId };
  }
  if (segments.length === 5 && segments[3] === 'qrcode' && segments[4] === 'status') {
    return { name: 'platform.qrcode.status', platform, workspaceId };
  }
  return null;
}

function parsePlatformWriteRoute(platform: string, segments: string[]): LocalAiCoreRoute | null {
  if (segments.length === 4 && segments[2] === 'pairings' && segments[3] === 'approve') {
    return { name: 'platform.pairing.approve', platform };
  }
  if (segments.length === 4 && segments[2] === 'pairings' && segments[3] === 'reject') {
    return { name: 'platform.pairing.reject', platform };
  }

  const workspaceId = segments.length >= 3 ? decodeURIComponent(segments[2] || '') : '';
  const action = segments[3] || '';
  if (!workspaceId || segments.length !== 4 || segments[2] === 'pairings') {
    return null;
  }
  if (action === 'test') {
    return { name: 'platform.gateway.test', platform, workspaceId };
  }
  if (action === 'enable') {
    return { name: 'platform.gateway.enable', platform, workspaceId };
  }
  if (action === 'disable') {
    return { name: 'platform.gateway.disable', platform, workspaceId };
  }
  if (action === 'files') {
    return { name: 'platform.file.send', platform, workspaceId };
  }
  if (action === 'messages') {
    return { name: 'platform.message.send', platform, workspaceId };
  }
  if (action === 'qrcode') {
    return { name: 'platform.qrcode.create', platform, workspaceId };
  }
  return null;
}

function parseCostsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (method === 'GET' && segments.length === 2 && segments[1] === 'summary') {
    return { name: 'costs.summary' };
  }
  if (method === 'GET' && segments.length === 2 && segments[1] === 'events') {
    return { name: 'costs.events' };
  }
  if (method === 'GET' && segments.length === 2 && segments[1] === 'top-runs') {
    return { name: 'costs.top-runs' };
  }
  return null;
}

function parseBudgetsRoute(method: string, segments: string[]): LocalAiCoreRoute | null {
  if (segments.length === 1) {
    if (method === 'GET') return { name: 'budgets.list' };
    if (method === 'POST') return { name: 'budgets.create' };
    return null;
  }
  const id = decodeURIComponent(segments[1] || '').trim();
  if (!id || segments.length !== 2) return null;
  if (method === 'GET') return { name: 'budget.get', id };
  if (method === 'PUT' || method === 'PATCH') return { name: 'budget.update', id };
  if (method === 'DELETE') return { name: 'budget.delete', id };
  return null;
}

function splitRouteSegments(path: string) {
  return path.split('/').filter(Boolean);
}

