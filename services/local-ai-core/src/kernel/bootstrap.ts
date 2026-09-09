import type {
  ChannelRoute,
  DesktopConnectConfig,
  LocalCoreCapabilities,
} from '@cc/superai-contracts';
import type {
  AgentPlugin,
  AgentRuntime,
  AgentRuntimeRegistration,
  ChannelRuntime,
  ChannelRuntimeRegistration,
  KnowledgeRuntime,
  KnowledgeRuntimeRegistration,
  MonitorProviderRuntime,
  MonitorRuntimeRegistration,
  PluginContext,
  RuntimePlugin,
  SchedulerExecutorRuntime,
  SchedulerRuntimeRegistration,
  SchedulerTriggerRuntime,
  ThreadKnowledgeAttachmentStore,
} from '@cc/plugin-sdk';
import { LocalCoreAcpStore } from '../acp/local-core-acp-store.js';
import { LocalCoreCapabilityRegistry } from './capability-registry.js';

import { LocalCoreDiagnostics } from './diagnostics.js';
import { LocalCoreEventBus } from './event-bus.js';
import { LocalCoreLifecycleManager } from './lifecycle-manager.js';
import { LocalCorePluginRegistry } from './plugin-registry.js';
import {
  createBuiltinCronSchedulerPlugin,
  createBuiltinNoopKnowledgePlugin,
  createKernelBuiltinPlugins,
  createRuntimeAgentPlugins,
  createRuntimeChannelPlugins,
  createRuntimeMonitorPlugins,
  createRuntimeSchedulerPlugins,
} from '../plugins/builtin/catalog.js';
import { createWorkspaceRouter, type WorkspaceRouter } from '../router/workspace-router.js';
import { createLocalCoreRuntimeState, type LocalCoreRuntimeState } from '../runtime/local-core-runtime-state.js';
import { ScheduledJobApplicationService } from '../scheduler/scheduled-job-application-service.js';
import { SchedulerService } from '../scheduler/scheduler-service.js';
import { AutomationMonitorService } from '../automation/automation-monitor-service.js';
import { AutomationActionExecutor } from '../automation/automation-action-executor.js';
import { DecisionLogService } from '../automation/decision-log-service.js';
import { AutomationService } from '../automation/automation-service.js';
import { CostService } from '../cost/cost-service.js';
import { setDefaultTimezone } from '../automation/legacy-automation-mappers.js';

export interface LocalCoreKernel {
  context: PluginContext;
  plugins: LocalCorePluginRegistry;
  capabilities: LocalCoreCapabilityRegistry;
  lifecycle: LocalCoreLifecycleManager;
  diagnostics: LocalCoreDiagnostics;
  getCapabilitySnapshot(): LocalCoreCapabilities;
}

export interface LocalCoreRuntimeBootstrap {
  kernel: LocalCoreKernel;
  state: LocalCoreRuntimeState;
  store: LocalCoreAcpStore;
  agentRuntimes: AgentRuntime[];
  channelRuntimes: ChannelRuntime[];
  channelRuntime: ChannelRuntime;
  weixinChannelRuntime: ChannelRuntime;
  knowledgeProvider: KnowledgeRuntime;
  knowledgeAttachments: ThreadKnowledgeAttachmentStore;
  workspaceRouter: WorkspaceRouter;
  scheduler: SchedulerService;
  scheduledJobs: ScheduledJobApplicationService;
  automationMonitors?: AutomationMonitorService;
  automationActionExecutor?: AutomationActionExecutor;
  automations?: AutomationService;
  decisionLogService?: DecisionLogService;
  costService?: CostService;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function bootstrapLocalCoreKernel(options?: {
  log?: (message: string) => void;
  disabledPluginIds?: string[];
  builtinPlugins?: RuntimePlugin[];
}): LocalCoreKernel {
  const capabilities = new LocalCoreCapabilityRegistry();
  const plugins = new LocalCorePluginRegistry(options?.disabledPluginIds);
  const context: PluginContext = {
    bus: new LocalCoreEventBus(),
    capabilities,
    logger: {
      log(message: string) {
        options?.log?.(message);
      },
    },
  };
  const lifecycle = new LocalCoreLifecycleManager(plugins, context);
  const diagnostics = new LocalCoreDiagnostics(plugins, lifecycle);

  const initialPlugins = options?.builtinPlugins ?? createKernelBuiltinPlugins();
  registerPluginSet(plugins, capabilities, context, initialPlugins);

  return {
    context,
    plugins,
    capabilities,
    lifecycle,
    diagnostics,
    getCapabilitySnapshot() {
      const snapshot = capabilities.snapshot();
      const monitorCapabilities = snapshot.monitors || [];
      return {
        adapters: {
          channels: snapshot.channels.map((capability) => capability.platform),
          agents: snapshot.agents.map((capability) => capability.agentType),
          knowledge: snapshot.knowledge.some((capability) => capability.enabled !== false),
          knowledgeProviders: [...new Set(
            snapshot.knowledge
              .filter((capability) => capability.enabled !== false)
              .map((capability) => capability.sourceType),
          )],
        },
        scheduler: {
          enabled: snapshot.schedulers.some((capability) => capability.enabled !== false),
          triggerTypes: [...new Set(snapshot.schedulers.flatMap((capability) => capability.triggerTypes))],
          deliveryTargets: [...new Set(snapshot.schedulers.flatMap((capability) => capability.deliveryTargets || capability.deliveryPlatforms || []))],
          platforms: [...new Set(snapshot.schedulers.flatMap((capability) => capability.deliveryTargets || capability.deliveryPlatforms || []))],
        },
        ...(monitorCapabilities.length > 0
          ? {
              monitors: {
                enabled: monitorCapabilities.some((capability) => capability.enabled !== false),
                sourceTypes: [...new Set(monitorCapabilities.flatMap((capability) => capability.sourceTypes))],
              },
            }
          : {}),
        snapshot,
      };
    },
  };
}

function registerPlugin(kernel: LocalCoreKernel, plugin: RuntimePlugin) {
  registerPluginSet(kernel.plugins, kernel.capabilities, kernel.context, [plugin]);
}

function registerPluginSet(
  plugins: LocalCorePluginRegistry,
  capabilities: LocalCoreCapabilityRegistry,
  context: PluginContext,
  pluginSet: RuntimePlugin[],
) {
  for (const plugin of pluginSet) {
    plugins.register(plugin);
    context.logger.log(`[plugin:${plugin.manifest.id}] registered`);
    if (plugin.capabilities && plugins.isEnabled(plugin.manifest.id)) {
      logCapabilityContributions(plugin, context.logger.log);
      capabilities.registerContributions(plugin.capabilities);
    } else if (!plugins.isEnabled(plugin.manifest.id)) {
      context.logger.log(`[plugin:${plugin.manifest.id}] disabled by runtime settings`);
    }
  }
}

function logCapabilityContributions(plugin: RuntimePlugin, log?: (message: string) => void) {
  if (!log || !plugin.capabilities) {
    return;
  }
  const capabilityIds = [
    ...(plugin.capabilities.agents || []).map((capability) => capability.id),
    ...(plugin.capabilities.channels || []).map((capability) => capability.id),
    ...(plugin.capabilities.knowledge || []).map((capability) => capability.id),
    ...(plugin.capabilities.schedulers || []).map((capability) => capability.id),
    ...(plugin.capabilities.monitors || []).map((capability) => capability.id),
    ...(plugin.capabilities.ui || []).map((capability) => capability.id),
  ];
  for (const capabilityId of capabilityIds) {
    log(`[plugin:${plugin.manifest.id}][capability:${capabilityId}] registered`);
  }
}

type SyncRuntimePlugin<T> = RuntimePlugin & {
  createRuntime?: (context: PluginContext) => T | Promise<T>;
};

function resolveRuntime<T>(plugin: SyncRuntimePlugin<T>, context: PluginContext): T {
  if (!plugin.createRuntime) {
    throw new Error(`Plugin ${plugin.manifest.id} does not provide a runtime factory.`);
  }
  const runtime = plugin.createRuntime(context);
  if (runtime instanceof Promise) {
    throw new Error(`Plugin ${plugin.manifest.id} returned an async runtime factory during synchronous bootstrap.`);
  }
  return runtime;
}

function isAgentPlugin(plugin: RuntimePlugin | null): plugin is AgentPlugin {
  return Boolean(plugin && (plugin.manifest.kind === 'agent' || plugin.manifest.kind === 'composite'));
}

export function bootstrapLocalCoreRuntime(options: {
  userDataPath: string;
  localCoreBase?: string;
  log?: (message: string) => void;
}): LocalCoreRuntimeBootstrap {
  const state = createLocalCoreRuntimeState({
    userDataPath: options.userDataPath,
    onLog: options.log,
  });
  const disabledPluginIds = Object.entries(state.getSettings().plugins)
    .filter(([, settings]) => settings.enabled === false)
    .map(([pluginId]) => pluginId);
  const kernel = bootstrapLocalCoreKernel({
    log: options.log,
    disabledPluginIds,
  });
  const store = new LocalCoreAcpStore(options.userDataPath);
  const localCoreAgentPlugin = kernel.plugins.get('builtin.agent-localcore-acp');
  if (!isAgentPlugin(localCoreAgentPlugin)) {
    throw new Error('Missing built-in LocalCore ACP agent plugin.');
  }
  const agentPlugins = createRuntimeAgentPlugins(localCoreAgentPlugin);
  let workspaceRouter!: WorkspaceRouter;
  let weixinChannelRuntime!: ChannelRuntime;
  const channelPlugins = createRuntimeChannelPlugins({
    store,
    readConfig: async () => {
      const configState = store.readRuntimeConfig();
      return configState.config as DesktopConnectConfig | null | undefined;
    },

    getWorkspaceRouter: () => workspaceRouter,
    log: options.log,
  });
  const channelPlugin = channelPlugins.lark;
  const weixinChannelPlugin = channelPlugins.weixin;
  const knowledgePlugin = createBuiltinNoopKnowledgePlugin();
  const schedulerPlugins = createRuntimeSchedulerPlugins({
    store,
    getWorkspaceRouter: () => workspaceRouter,
    getLarkChannelRuntime: () => channelRuntime,
    getWeixinChannelRuntime: () => weixinChannelRuntime,
    log: options.log,
  });
  const monitorPlugins = createRuntimeMonitorPlugins();
  for (const plugin of agentPlugins.filter((plugin) => plugin !== localCoreAgentPlugin)) {
    registerPlugin(kernel, plugin);
  }
  registerPlugin(kernel, channelPlugin);
  registerPlugin(kernel, weixinChannelPlugin);
  registerPlugin(kernel, knowledgePlugin);
  for (const plugin of schedulerPlugins) {
    registerPlugin(kernel, plugin);
  }
  for (const plugin of monitorPlugins) {
    registerPlugin(kernel, plugin);
  }
  const agentRuntimes = agentPlugins
    .filter((plugin) => kernel.plugins.isEnabled(plugin.manifest.id))
    .map((plugin) => resolveRuntime<AgentRuntimeRegistration>(plugin, kernel.context).runtime);
  const channelRuntime = resolveRuntime<ChannelRuntimeRegistration>(channelPlugin, kernel.context).channel;
  weixinChannelRuntime = resolveRuntime<ChannelRuntimeRegistration>(weixinChannelPlugin, kernel.context).channel;
  const channelRuntimes = [
    channelRuntime,
    weixinChannelRuntime,
  ];
  const knowledgeRuntime = kernel.plugins.isEnabled(knowledgePlugin.manifest.id)
    ? resolveRuntime<KnowledgeRuntimeRegistration>(knowledgePlugin, kernel.context)
    : resolveRuntime<KnowledgeRuntimeRegistration>(createBuiltinNoopKnowledgePlugin(), kernel.context);
  const cronSchedulerPlugin = createBuiltinCronSchedulerPlugin();
  const schedulerRuntimes = [
    ...(kernel.plugins.isEnabled(cronSchedulerPlugin.manifest.id)
      ? [resolveRuntime<SchedulerRuntimeRegistration>(cronSchedulerPlugin, kernel.context)]
      : []),
    ...schedulerPlugins
      .filter((plugin) => kernel.plugins.isEnabled(plugin.manifest.id))
      .map((plugin) => resolveRuntime<SchedulerRuntimeRegistration>(plugin, kernel.context)),
  ];
  const schedulerTriggers = schedulerRuntimes.flatMap((runtime) => runtime.triggers || []) as SchedulerTriggerRuntime[];
  const schedulerExecutors = schedulerRuntimes.flatMap((runtime) => runtime.executors || []) as SchedulerExecutorRuntime[];
  const monitorRuntimes = monitorPlugins
    .filter((plugin) => kernel.plugins.isEnabled(plugin.manifest.id))
    .map((plugin) => resolveRuntime<MonitorRuntimeRegistration>(plugin, kernel.context));
  const monitorProviders = monitorRuntimes.flatMap((runtime) => runtime.providers || []) as MonitorProviderRuntime[];
  const knowledgeProvider = knowledgeRuntime.provider as KnowledgeRuntime;
  const knowledgeAttachments = knowledgeRuntime.attachments as ThreadKnowledgeAttachmentStore;
  const costService = new CostService({
    store,
    eventBus: kernel.context.bus,
    log: options.log,
  });
  workspaceRouter = createWorkspaceRouter({
    store,
    costService,
    cliBinDir: state.cliBinDir,
    localCoreBase: options.localCoreBase,
    readRuntimeConfig: async () => store.readRuntimeConfig(),
    getCapabilities: () => kernel.getCapabilitySnapshot(),
    getAgentRuntimes: () => agentRuntimes,
    eventBus: kernel.context.bus,
    knowledgeProvider,
    knowledgeAttachments,
    log: options.log,
  });
  const decisionLogService = new DecisionLogService(store);
  let automations: AutomationService;
  const automationActionExecutor = new AutomationActionExecutor({
    store,
    getWorkspaceRouter: () => workspaceRouter,
    getChannelRuntime: (platform) =>
      channelRuntimes.find((runtime) => runtime.platform === platform || platform.startsWith(`${runtime.platform}:`)),
    costService,
    decisionLogService,
    getAutomationService: () => automations,
  });
  // Default legacy cron jobs to the host's local timezone so they fire at the wall
  // clock the user wrote (e.g. a job written as "0 1 * * *" runs at 1 AM server time).
  // Matches the behavior of the old SchedulerService, which matched in local time.
  setDefaultTimezone(resolveHostTimezone());
  automations = new AutomationService({
    store,
    actionExecutor: automationActionExecutor,
    eventBus: kernel.context.bus,
    log: options.log,
  });
  const scheduler = new SchedulerService({
    store,
    automations,
    triggers: schedulerTriggers,
    executors: schedulerExecutors,
    eventBus: kernel.context.bus,
    log: options.log,
  });
  const scheduledJobs = new ScheduledJobApplicationService({
    store,
    scheduler,
    automations,
    eventBus: kernel.context.bus,
  });
  const automationMonitors = new AutomationMonitorService({
    store,
    automations,
    providers: monitorProviders,
    getWorkspaceRouter: () => workspaceRouter,
    getChannelRuntime: (platform) =>
      channelRuntimes.find((runtime) => runtime.platform === platform || platform.startsWith(`${runtime.platform}:`)),
    eventBus: kernel.context.bus,
    log: options.log,
  });

  workspaceRouter.setSchedulerBridge({
    createJob: async ({ workspaceId, platform, route, name, schedule, scheduleDescription, message }) =>
      scheduledJobs.createCronJob({ workspaceId, platform, route, name, schedule, scheduleDescription, message }),
    listJobsForThread: async (threadId) => scheduledJobs.listJobsForThread(threadId),
    deleteJob: async (jobId) => {
      scheduledJobs.deleteJob(jobId);
    },
  });

  return {
    kernel,
    state,
    store,
    agentRuntimes,
    channelRuntimes,
    channelRuntime,
    weixinChannelRuntime,
    knowledgeProvider,
    knowledgeAttachments,
    workspaceRouter,
    scheduler,
    scheduledJobs,
    automationMonitors,
    automationActionExecutor,
    automations,
    decisionLogService,
    costService,
    async start() {
      await kernel.lifecycle.startAll();
      await automations.start();
      await scheduler.start();
      await automationMonitors.start();
    },
    async stop() {
      await automationMonitors.stop();
      await automations.stop();
      await scheduler.stop();
      await kernel.lifecycle.stopAll();
      workspaceRouter.close();
    },
  };
}

// The host machine's IANA timezone. Falls back to UTC if the runtime cannot determine it.
function resolveHostTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length > 0 ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}
