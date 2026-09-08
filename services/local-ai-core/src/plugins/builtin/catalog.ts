import type { DesktopConnectConfig } from '@cc/superai-contracts';
import type {
  AgentPlugin,
  ChannelPlugin,
  ChannelRuntime,
  MonitorPlugin,
  RuntimePlugin,
  SchedulerPlugin,
} from '@cc/plugin-sdk';
import type { LocalCoreAcpStore } from '../../acp/local-core-acp-store.js';
import type { WorkspaceRouter } from '../../router/workspace-router.js';
import {
  createBuiltinCodexAgentPlugin,
  createBuiltinClaudeCodeAgentPlugin,
  createBuiltinHermesAgentPlugin,
  createBuiltinLocalCoreAcpAgentPlugin,
  createBuiltinOpencodeAgentPlugin,
  createBuiltinPiAgentPlugin,
  createBuiltinStaticAgentCapabilityPlugin,
  getStaticAgentRuntimeDefinitions,
} from '../../agents/index.js';
import { createBuiltinStockMonitorPlugin } from './monitor-stock-plugin.js';
import { createBuiltinWebhookMonitorPlugin } from './monitor-webhook-plugin.js';
import { createBuiltinLarkChannelPlugin } from './channel-lark-plugin.js';
import { createBuiltinWeixinChannelPlugin } from './channel-weixin-plugin.js';
import { createBuiltinNoopKnowledgePlugin } from './knowledge-noop-plugin.js';
import { createBuiltinCronSchedulerPlugin } from './scheduler-cron-plugin.js';
import { createBuiltinLarkSchedulerPlugin } from './scheduler-lark-plugin.js';
import { createBuiltinLocalSchedulerPlugin } from './scheduler-local-plugin.js';
import { createBuiltinWeixinSchedulerPlugin } from './scheduler-weixin-plugin.js';

export function createKernelBuiltinPlugins(): RuntimePlugin[] {
  return [
    ...getStaticAgentRuntimeDefinitions().map((definition) =>
      createBuiltinStaticAgentCapabilityPlugin(definition.agentType, definition.displayName)
    ),
    createBuiltinLocalCoreAcpAgentPlugin(),
    createBuiltinCronSchedulerPlugin(),
  ];
}

export function createRuntimeAgentPlugins(localCoreAgentPlugin: AgentPlugin): AgentPlugin[] {
  return [
    localCoreAgentPlugin,
    createBuiltinPiAgentPlugin(),
    createBuiltinOpencodeAgentPlugin(),
    createBuiltinCodexAgentPlugin(),
    createBuiltinClaudeCodeAgentPlugin(),
    createBuiltinHermesAgentPlugin(),
  ];
}

export function createRuntimeChannelPlugins(options: {
  store: LocalCoreAcpStore;
  readConfig: () => Promise<DesktopConnectConfig | null | undefined>;
  getWorkspaceRouter: () => WorkspaceRouter;
  log?: (message: string) => void;
}): { lark: ChannelPlugin; weixin: ChannelPlugin } {
  return {
    lark: createBuiltinLarkChannelPlugin(options),
    weixin: createBuiltinWeixinChannelPlugin(options),
  };
}

export function createRuntimeSchedulerPlugins(options: {
  store: LocalCoreAcpStore;
  getWorkspaceRouter: () => WorkspaceRouter;
  getLarkChannelRuntime: () => ChannelRuntime;
  getWeixinChannelRuntime: () => ChannelRuntime;
  log?: (message: string) => void;
}): SchedulerPlugin[] {
  return [
    createBuiltinLocalSchedulerPlugin({
      store: options.store,
      getWorkspaceRouter: options.getWorkspaceRouter,
    }),
    createBuiltinLarkSchedulerPlugin({
      store: options.store,
      getWorkspaceRouter: options.getWorkspaceRouter,
      getChannelRuntime: options.getLarkChannelRuntime,
      log: options.log,
    }),
    createBuiltinWeixinSchedulerPlugin({
      store: options.store,
      getWorkspaceRouter: options.getWorkspaceRouter,
      getChannelRuntime: options.getWeixinChannelRuntime,
      log: options.log,
    }),
  ];
}

export function createRuntimeMonitorPlugins(): MonitorPlugin[] {
  return [
    createBuiltinStockMonitorPlugin(),
    createBuiltinWebhookMonitorPlugin(),
  ];
}

export { createBuiltinCronSchedulerPlugin, createBuiltinNoopKnowledgePlugin };
