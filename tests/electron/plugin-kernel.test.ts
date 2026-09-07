import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimePlugin } from '../../packages/plugin-sdk/src/index.js';
import { bootstrapLocalCoreKernel } from '../../services/local-ai-core/src/kernel/bootstrap.js';
import { bootstrapLocalCoreRuntime } from '../../services/local-ai-core/src/kernel/bootstrap.js';
import { LocalCoreCapabilityRegistry } from '../../services/local-ai-core/src/kernel/capability-registry.js';
import { LocalCoreEventBus } from '../../services/local-ai-core/src/kernel/event-bus.js';
import { LocalCoreLifecycleManager } from '../../services/local-ai-core/src/kernel/lifecycle-manager.js';
import { LocalCorePluginRegistry } from '../../services/local-ai-core/src/kernel/plugin-registry.js';
import { LocalCoreController } from '../../services/local-ai-core/src/runtime/local-core-controller.js';
import { createLocalCoreRuntimeState } from '../../services/local-ai-core/src/runtime/local-core-runtime-state.js';
import { LocalAiCoreServer } from '../../services/local-ai-core/src/runtime/server.js';

function withLogEnv<T>(logDir: string, fn: () => T, options: {
  maxBytes?: number;
  maxFiles?: number;
} = {}): T {
  const previousLogDir = process.env.AGENTDOCK_LOG_DIR;
  const previousMaxBytes = process.env.AGENTDOCK_LOG_MAX_BYTES;
  const previousMaxFiles = process.env.AGENTDOCK_LOG_MAX_FILES;
  process.env.AGENTDOCK_LOG_DIR = logDir;
  if (options.maxBytes !== undefined) {
    process.env.AGENTDOCK_LOG_MAX_BYTES = String(options.maxBytes);
  } else {
    delete process.env.AGENTDOCK_LOG_MAX_BYTES;
  }
  if (options.maxFiles !== undefined) {
    process.env.AGENTDOCK_LOG_MAX_FILES = String(options.maxFiles);
  } else {
    delete process.env.AGENTDOCK_LOG_MAX_FILES;
  }
  const restore = () => {
    if (previousLogDir === undefined) {
      delete process.env.AGENTDOCK_LOG_DIR;
    } else {
      process.env.AGENTDOCK_LOG_DIR = previousLogDir;
    }
    if (previousMaxBytes === undefined) {
      delete process.env.AGENTDOCK_LOG_MAX_BYTES;
    } else {
      process.env.AGENTDOCK_LOG_MAX_BYTES = previousMaxBytes;
    }
    if (previousMaxFiles === undefined) {
      delete process.env.AGENTDOCK_LOG_MAX_FILES;
    } else {
      process.env.AGENTDOCK_LOG_MAX_FILES = previousMaxFiles;
    }
  };
  try {
    const result = fn();
    const maybePromise = result as unknown as Promise<unknown> | null;
    if (maybePromise && typeof maybePromise.finally === 'function') {
      return maybePromise.finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function parseLogLine(line: string) {
  return JSON.parse(line) as { ts: string; level: string; scope: string; message: string };
}

async function saveConfig(runtime: { store: { saveRuntimeConfig(config: unknown): unknown } }, config: unknown) {
  runtime.store.saveRuntimeConfig(config);
}

function plugin(id: string, dependsOn: string[] = []): RuntimePlugin {
  return {
    manifest: {
      id,
      kind: 'composite',
      version: '0.1.0',
      dependsOn,
      provides: [],
    },
  };
}

async function invokeServer(
  server: LocalAiCoreServer,
  method: string,
  url: string,
  inputBody?: unknown,
) {
  const requestBody = inputBody === undefined ? '' : JSON.stringify(inputBody);
  const req = Object.assign(new EventEmitter(), {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (requestBody) {
        yield Buffer.from(requestBody);
      }
    },
  }) as any;
  let body = '';
  const headers = new Map<string, string>();
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    writeHead(statusCode: number, nextHeaders: Record<string, string>) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(nextHeaders)) {
        headers.set(name, value);
      }
    },
    write(chunk: string) {
      body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) {
        body += chunk;
      }
      res.emit('finish');
    },
  }) as any;

  await (server as any).handleRequest(req, res);
  return {
    statusCode: res.statusCode,
    headers,
    body: body ? JSON.parse(body) : null,
  };
}

test('bootstrapLocalCoreKernel exposes the static built-in capability snapshot', () => {
  const kernel = bootstrapLocalCoreKernel();

  assert.deepEqual(kernel.getCapabilitySnapshot(), {
    adapters: {
      channels: ['localcore-acp'],
      agents: ['cursor', 'gemini', 'qoder', 'iflow', 'localcore-acp'],
      knowledge: false,
      knowledgeProviders: [],
    },
    scheduler: {
      enabled: true,
      triggerTypes: ['cron', 'once'],
      deliveryTargets: [],
      platforms: [],
    },
    snapshot: {
      agents: [
        { id: 'agent.cursor', agentType: 'cursor', displayName: 'Cursor' },
        { id: 'agent.gemini', agentType: 'gemini', displayName: 'Gemini' },
        { id: 'agent.qoder', agentType: 'qoder', displayName: 'Qoder' },
        { id: 'agent.iflow', agentType: 'iflow', displayName: 'iFlow' },
        { id: 'agent.localcore-acp', agentType: 'localcore-acp', displayName: 'LocalCore ACP' },
      ],
      channels: [
        { id: 'channel.localcore-acp', platform: 'localcore-acp', displayName: 'LocalCore ACP' },
      ],
      knowledge: [],
      schedulers: [
        {
          id: 'scheduler.trigger.cron',
          triggerTypes: ['cron', 'once'],
          deliveryTargets: [],
          enabled: true,
          displayName: 'Cron Trigger',
        },
      ],
      ui: [],
    },
  });
});

test('plugin registry preserves registration order for unrelated plugins', () => {
  const registry = new LocalCorePluginRegistry();
  registry.register(plugin('plugin.first'));
  registry.register(plugin('plugin.second'));
  registry.register(plugin('plugin.third'));

  assert.deepEqual(registry.list().map((entry) => entry.manifest.id), [
    'plugin.first',
    'plugin.second',
    'plugin.third',
  ]);
});

test('plugin registry resolves dependencies before dependents', () => {
  const registry = new LocalCorePluginRegistry();
  registry.register(plugin('plugin.scheduler', ['plugin.channel']));
  registry.register(plugin('plugin.channel'));
  registry.register(plugin('plugin.unrelated'));

  assert.deepEqual(registry.list().map((entry) => entry.manifest.id), [
    'plugin.channel',
    'plugin.scheduler',
    'plugin.unrelated',
  ]);
});

test('plugin registry rejects duplicate plugin ids', () => {
  const registry = new LocalCorePluginRegistry();
  registry.register(plugin('plugin.duplicate'));

  assert.throws(
    () => registry.register(plugin('plugin.duplicate')),
    /Plugin already registered: plugin\.duplicate/,
  );
});

test('capability registry snapshots contributions by capability type', () => {
  const capabilities = new LocalCoreCapabilityRegistry();
  capabilities.registerContributions({
    agents: [{ id: 'agent.test', agentType: 'test-agent' }],
    channels: [{ id: 'channel.test', platform: 'test-platform' }],
    knowledge: [{ id: 'knowledge.test', sourceType: 'test-source', enabled: true }],
    schedulers: [{ id: 'scheduler.test', triggerTypes: ['cron'], deliveryTargets: ['test-platform'] }],
    ui: [{ id: 'ui.test' }],
  });

  assert.deepEqual(capabilities.snapshot(), {
    agents: [{ id: 'agent.test', agentType: 'test-agent' }],
    channels: [{ id: 'channel.test', platform: 'test-platform' }],
    knowledge: [{ id: 'knowledge.test', sourceType: 'test-source', enabled: true }],
    schedulers: [{ id: 'scheduler.test', triggerTypes: ['cron'], deliveryTargets: ['test-platform'] }],
    ui: [{ id: 'ui.test' }],
  });
});

test('kernel lifecycle initializes plugins and diagnostics report health', async () => {
  const kernel = bootstrapLocalCoreKernel();

  await kernel.lifecycle.initAll();
  const diagnostics = await kernel.diagnostics.snapshot();

  assert.equal(diagnostics.pluginCount, 6);
  assert.equal(diagnostics.enabledPluginCount, 6);
  assert.deepEqual(
    diagnostics.plugins.map((plugin) => plugin.pluginId).sort(),
    [
      'builtin.agent-cursor',
      'builtin.agent-gemini',
      'builtin.agent-iflow',
      'builtin.agent-localcore-acp',
      'builtin.agent-qoder',
      'builtin.scheduler-cron',
    ],
  );
  assert.deepEqual(
    diagnostics.plugins.map((plugin) => ({
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
      health: plugin.health,
    })),
    [
      'builtin.agent-cursor',
      'builtin.agent-gemini',
      'builtin.agent-qoder',
      'builtin.agent-iflow',
      'builtin.agent-localcore-acp',
      'builtin.scheduler-cron',
    ].map((pluginId) => ({
      pluginId,
      enabled: true,
      health: { status: 'healthy' },
    })),
  );
});

test('runtime bootstrap registers the active knowledge provider in capability snapshot', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });

    assert.deepEqual(runtime.kernel.getCapabilitySnapshot().adapters.agents, [
      'cursor',
      'gemini',
      'qoder',
      'iflow',
      'localcore-acp',
      'pi',
      'opencode',
      'codex',
      'claudecode',
      'hermes',
    ]);
    assert.deepEqual(runtime.kernel.getCapabilitySnapshot().adapters.channels, ['localcore-acp', 'lark', 'weixin']);
    assert.deepEqual(runtime.kernel.getCapabilitySnapshot().adapters.knowledgeProviders, []);
    assert.equal(runtime.kernel.getCapabilitySnapshot().adapters.knowledge, false);
    assert.deepEqual(runtime.kernel.getCapabilitySnapshot().scheduler, {
      enabled: true,
      triggerTypes: ['cron', 'once'],
      deliveryTargets: ['local', 'lark', 'weixin'],
      platforms: ['local', 'lark', 'weixin'],
    });

    await runtime.start();
    await runtime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('runtime bootstrap supports a disabled knowledge plugin path', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });

    assert.deepEqual(runtime.kernel.getCapabilitySnapshot().adapters.agents, [
      'cursor',
      'gemini',
      'qoder',
      'iflow',
      'localcore-acp',
      'pi',
      'opencode',
      'codex',
      'claudecode',
      'hermes',
    ]);
    assert.deepEqual(runtime.kernel.getCapabilitySnapshot().adapters.channels, ['localcore-acp', 'lark', 'weixin']);
    assert.deepEqual(runtime.kernel.getCapabilitySnapshot().adapters.knowledgeProviders, []);
    assert.equal(runtime.kernel.getCapabilitySnapshot().adapters.knowledge, false);
    assert.deepEqual(runtime.kernel.getCapabilitySnapshot().scheduler, {
      enabled: true,
      triggerTypes: ['cron', 'once'],
      deliveryTargets: ['local', 'lark', 'weixin'],
      platforms: ['local', 'lark', 'weixin'],
    });
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('codex agent runtime routes projects through the bundled ACP adapter', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    await saveConfig(runtime, {
      projects: [{ name: 'codex-workspace', agent: { type: 'codex' } }],
    });
    const configState = runtime.store.readRuntimeConfig();
    const project = configState.config?.projects?.find((entry) => entry.name === 'codex-workspace');
    const codexRuntime = runtime.agentRuntimes.find((entry) => entry.agentType === 'codex');
    const route = project ? codexRuntime?.createRoute(configState, project) : null;

    assert.equal(route?.agentType, 'codex');
    assert.equal(route?.config.command, process.execPath);
    assert.match(route?.config.args[0] || '', /@zed-industries[/\\]codex-acp[/\\]bin[/\\]codex-acp\.js$/);
    assert.deepEqual(await runtime.workspaceRouter.listWorkspaces(), [
      {
        id: 'codex-workspace',
        name: 'codex-workspace',
        agentType: 'codex',
        platforms: [],
        sessionsCount: 0,
        heartbeatEnabled: false,
      },
    ]);

    await runtime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('thread slash agent reset resolves the workspace default agent through the router', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-agent-reset-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    await saveConfig(runtime, {
      projects: [{ name: 'agent-workspace', agent: { type: 'codex' } }],
    });
    const thread = await runtime.workspaceRouter.createThread('agent-workspace', 'Agent reset');

    await runtime.workspaceRouter.sendThreadMessage(thread.id, '/agent use pi');
    assert.equal(runtime.store.getThreadRow(thread.id)?.agent_type, 'pi');

    await runtime.workspaceRouter.sendThreadMessage(thread.id, '/agent reset');
    assert.equal(runtime.store.getThreadRow(thread.id)?.agent_type, 'codex');
    assert.match(runtime.store.getThread(thread.id, []).messages.at(-1)?.content || '', /回到默认 Agent：codex/);

    await runtime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('thread slash provider commands query and list providers through router', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-provider-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    runtime.store.upsertModelProvider({
      id: 'provider-default',
      name: 'Default Provider',
      base_url: 'https://default.ai/v1',
      api_key: 'key-1',
    });
    runtime.store.upsertModelProvider({
      id: 'provider-volcano',
      name: '火山方舟',
      base_url: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      api_key: 'key-2',
    });
    await saveConfig(runtime, {
      projects: [{ name: 'agent-workspace', agent: { type: 'hermes', options: { provider_id: 'provider-default' } } }],
    });
    const thread = await runtime.workspaceRouter.createThread('agent-workspace', 'Provider test');

    await runtime.workspaceRouter.sendThreadMessage(thread.id, '/provider current');
    assert.match(runtime.store.getThread(thread.id, []).messages.at(-1)?.content || '', /Default Provider/);

    await runtime.workspaceRouter.sendThreadMessage(thread.id, '/provider list');
    assert.match(runtime.store.getThread(thread.id, []).messages.at(-1)?.content || '', /火山方舟/);

    await runtime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('hermes agent runtime routes projects through hermes ACP command', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    await saveConfig(runtime, {
      projects: [{ name: 'hermes-workspace', agent: { type: 'hermes' } }],
    });
    const configState = runtime.store.readRuntimeConfig();
    const project = configState.config?.projects?.find((entry) => entry.name === 'hermes-workspace');
    const hermesRuntime = runtime.agentRuntimes.find((entry) => entry.agentType === 'hermes');
    const route = project ? hermesRuntime?.createRoute(configState, project) : null;

    assert.equal(route?.agentType, 'hermes');
    assert.equal(route?.config.command, 'hermes');
    assert.deepEqual(route?.config.args, ['acp']);
    assert.equal(route?.config.env?.HERMES_YOLO_MODE, '1');
    assert.deepEqual(await runtime.workspaceRouter.listWorkspaces(), [
      {
        id: 'hermes-workspace',
        name: 'hermes-workspace',
        agentType: 'hermes',
        platforms: [],
        sessionsCount: 0,
        heartbeatEnabled: false,
      },
    ]);

    await runtime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('hermes agent runtime injects provider API key, base URL, and model into launch env', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    runtime.store.upsertModelProvider({
      id: 'provider-opencode-go',
      name: 'opencode go',
      base_url: 'https://api.opencode.ai/v1',
      api_key: 'sk-test-opencode-key',
      model: 'opencode-go-v1',
    });
    await saveConfig(runtime, {
      projects: [{
        name: 'hermes-provider-workspace',
        agent: { type: 'hermes', options: { provider_id: 'provider-opencode-go' } },
      }],
    });
    const configState = runtime.store.readRuntimeConfig();
    const rawProject = configState.config?.projects?.find((entry) => entry.name === 'hermes-provider-workspace');
    const providerId = String(rawProject?.agent?.options?.provider_id || '').trim();
    const provider = providerId ? runtime.store.getModelProvider(providerId) : undefined;
    const project = rawProject ? {
      ...rawProject,
      agent: {
        ...rawProject.agent,
        providers: provider ? [provider] : [],
      },
    } : null;
    const hermesRuntime = runtime.agentRuntimes.find((entry) => entry.agentType === 'hermes');
    const route = project ? hermesRuntime?.createRoute(configState, project) : null;

    assert.equal(route?.agentType, 'hermes');
    assert.equal(route?.config.env?.HERMES_YOLO_MODE, '1');
    assert.equal(route?.config.env?.OPENAI_API_KEY, 'sk-test-opencode-key');
    assert.equal(route?.config.env?.HERMES_API_KEY, 'sk-test-opencode-key');
    assert.equal(route?.config.env?.OPENAI_BASE_URL, 'https://api.opencode.ai/v1');
    assert.equal(route?.config.env?.HERMES_BASE_URL, 'https://api.opencode.ai/v1');
    assert.equal(route?.config.env?.HERMES_MODEL, 'opencode-go-v1');



    await runtime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('hermes agent runtime does not silently fallback to first provider when specified provider_id is unmatched', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    // Add a default provider that should NOT be selected if unmatched provider_id is requested
    runtime.store.upsertModelProvider({
      id: 'provider-cloud-openai',
      name: 'openai',
      api_key: 'sk-cloud-secret',
    });
    const configState = runtime.store.readRuntimeConfig();
    const hermesRuntime = runtime.agentRuntimes.find((entry) => entry.agentType === 'hermes');
    const project = {
      name: 'unmatched-provider-workspace',
      platforms: [],
      agent: {
        type: 'hermes',
        options: { provider_id: 'missing-local-provider' },
        providers: [],
      },
    };
    const route = hermesRuntime?.createRoute(configState, project);
    assert.equal(route?.config.env?.OPENAI_API_KEY, undefined);
    assert.equal(route?.config.env?.HERMES_API_KEY, undefined);

    await runtime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});



test('pi agent runtime routes projects through bundled pi ACP and coding agent', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    runtime.store.upsertModelProvider({
      id: 'provider-openai',
      name: 'openai',
      api_key: 'test-openai-key',
    });
    await saveConfig(runtime, {
      projects: [{
        name: 'pi-workspace',
        agent: {
          type: 'pi',
          options: {
            provider_id: 'provider-openai',
            env: { OPENAI_API_KEY: 'override-openai-key' },
          },
        },
      }],
    });
    const configState = runtime.store.readRuntimeConfig();
    const rawProject = configState.config?.projects?.find((entry) => entry.name === 'pi-workspace');
    const provider = runtime.store.getModelProvider('provider-openai');
    const project = rawProject ? {
      ...rawProject,
      agent: { ...rawProject.agent, providers: provider ? [provider] : [] },
    } : null;
    const piRuntime = runtime.agentRuntimes.find((entry) => entry.agentType === 'pi');
    const route = project ? piRuntime?.createRoute(configState, project) : null;

    assert.equal(route?.agentType, 'pi');
    assert.equal(route?.config.command, process.execPath);
    assert.match(route?.config.args[0] || '', /pi-acp[/\\]dist[/\\]index\.js$/);
    if (process.platform === 'win32') {
      assert.match(route?.config.env.PI_ACP_PI_COMMAND || '', /[\\/]node_modules[\\/]\.bin[\\/]pi\.CMD$/i);
    } else {
      assert.match(route?.config.env.PI_ACP_PI_COMMAND || '', /@mariozechner[/\\]pi-coding-agent[/\\]dist[/\\]cli\.js$/);
    }
    assert.equal(route?.config.env.OPENAI_API_KEY, 'override-openai-key');
    assert.match(route?.config.env.PI_CODING_AGENT_DIR || '', /[\\/]\.pi-agent[\\/]pi-workspace$/);
    assert.deepEqual(await runtime.workspaceRouter.listWorkspaces(), [
      {
        id: 'pi-workspace',
        name: 'pi-workspace',
        agentType: 'pi',
        platforms: [],
        sessionsCount: 0,
        heartbeatEnabled: false,
      },
    ]);

    await runtime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('pi agent runtime writes provider auth and default model into Pi config dir', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    runtime.store.upsertModelProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      api_key: 'test-deepseek-key',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });
    await saveConfig(runtime, {
      projects: [{
        name: 'deepseek-workspace',
        agent: { type: 'pi', options: { provider_id: 'deepseek' } },
      }],
    });
    const configState = runtime.store.readRuntimeConfig();
    const rawProject = configState.config?.projects?.find((entry) => entry.name === 'deepseek-workspace');
    const provider = runtime.store.getModelProvider('deepseek');
    const project = rawProject ? {
      ...rawProject,
      agent: { ...rawProject.agent, providers: provider ? [provider] : [] },
    } : null;
    const piRuntime = runtime.agentRuntimes.find((entry) => entry.agentType === 'pi');
    const route = project ? piRuntime?.createRoute(configState, project) : null;
    const piAgentDir = route?.config.env.PI_CODING_AGENT_DIR || '';

    assert.equal(route?.config.model, 'deepseek-v4-flash');
    assert.equal(route?.config.env.DEEPSEEK_API_KEY, 'test-deepseek-key');
    assert.match(piAgentDir, /[\\/]\.pi-agent[\\/]deepseek-workspace$/);
    assert.deepEqual(JSON.parse(readFileSync(join(piAgentDir, 'auth.json'), 'utf8')), {
      deepseek: { type: 'api_key', key: 'test-deepseek-key' },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(piAgentDir, 'settings.json'), 'utf8')), {
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      quietStartup: true,
    });
    assert.deepEqual(JSON.parse(readFileSync(join(piAgentDir, 'models.json'), 'utf8')), {
      providers: {
        deepseek: {
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'test-deepseek-key',
        },
      },
    });

    await runtime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('pi agent runtime normalizes DeepSeek provider when provider name is the model id', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    runtime.store.upsertModelProvider({
      id: 'deepseek-v4-flash',
      name: 'deepseek-v4-flash',
      api_key: 'test-deepseek-key',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });
    await saveConfig(runtime, {
      projects: [{
        name: 'deepseek-model-name-workspace',
        agent: { type: 'pi', options: { provider_id: 'deepseek-v4-flash' } },
      }],
    });
    const configState = runtime.store.readRuntimeConfig();
    const rawProject = configState.config?.projects?.find((entry) => entry.name === 'deepseek-model-name-workspace');
    const provider = runtime.store.getModelProvider('deepseek-v4-flash');
    const project = rawProject ? {
      ...rawProject,
      agent: { ...rawProject.agent, providers: provider ? [provider] : [] },
    } : null;
    const piRuntime = runtime.agentRuntimes.find((entry) => entry.agentType === 'pi');
    const route = project ? piRuntime?.createRoute(configState, project) : null;
    const piAgentDir = route?.config.env.PI_CODING_AGENT_DIR || '';

    assert.equal(route?.config.env.DEEPSEEK_API_KEY, 'test-deepseek-key');
    assert.deepEqual(JSON.parse(readFileSync(join(piAgentDir, 'auth.json'), 'utf8')), {
      deepseek: { type: 'api_key', key: 'test-deepseek-key' },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(piAgentDir, 'settings.json'), 'utf8')), {
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      quietStartup: true,
    });
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('runtime bootstrap knowledge capabilities come from the selected provider plugin', () => {
  const enabledUserDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  const disabledUserDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const enabledRuntime = bootstrapLocalCoreRuntime({
      userDataPath: enabledUserDataPath,
    });
    const disabledRuntime = bootstrapLocalCoreRuntime({
      userDataPath: disabledUserDataPath,    });

    assert.deepEqual(
      enabledRuntime.kernel.getCapabilitySnapshot().snapshot.knowledge.map((capability) => capability.sourceType),
      ['noop'],
    );
    assert.deepEqual(disabledRuntime.kernel.getCapabilitySnapshot().snapshot.knowledge, [
      {
        id: 'knowledge.noop',
        sourceType: 'noop',
        enabled: false,
        displayName: 'Disabled Knowledge',
      },
    ]);
    assert.equal(disabledRuntime.kernel.getCapabilitySnapshot().adapters.knowledge, false);
  } finally {
    rmSync(enabledUserDataPath, { recursive: true, force: true });
    rmSync(disabledUserDataPath, { recursive: true, force: true });
  }
});

test('runtime bootstrap keeps disabled plugins diagnosable without contributing capabilities', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const runtimeDir = join(userDataPath, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'local-core-settings.json'),
      JSON.stringify({
        defaultProject: 'default',
        autoStartService: true,
        plugins: {
          'builtin.scheduler-lark': { enabled: false },
        },
      }),
      'utf8',
    );

    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    const diagnostics = await runtime.kernel.diagnostics.snapshot();
    const disabledPlugin = diagnostics.plugins.find((plugin) => plugin.pluginId === 'builtin.scheduler-lark');

    assert.ok(disabledPlugin);
    assert.equal(disabledPlugin.enabled, false);
    assert.equal(disabledPlugin.health.status, 'degraded');
    assert.deepEqual(runtime.kernel.getCapabilitySnapshot().scheduler, {
      enabled: true,
      triggerTypes: ['cron', 'once'],
      deliveryTargets: ['local', 'weixin'],
      platforms: ['local', 'weixin'],
    });
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('LocalCoreController accepts injected bootstrap dependencies', async () => {
  const bus = new LocalCoreEventBus();
  const capabilitySnapshot = {
    adapters: {
      channels: ['test-channel'],
      agents: ['test-agent'],
      knowledge: false,
      knowledgeProviders: [],
    },
    scheduler: {
      enabled: false,
      triggerTypes: [],
      deliveryTargets: [],
      platforms: [],
    },
    snapshot: {
      agents: [{ id: 'agent.test', agentType: 'test-agent' }],
      channels: [{ id: 'channel.test', platform: 'test-channel' }],
      knowledge: [],
      schedulers: [],
      ui: [],
    },
  };
  let started = false;
  let stopped = false;
  let channelRefreshes = 0;
  let weixinRefreshes = 0;
  let runtimeConfig: any = {
    storage: 'sqlite' as const,
    databasePath: '/tmp/local-core-controller-injected/runtime/local-core.db',
    baseDir: '/tmp/local-core-controller-injected/runtime',
    config: { projects: [] },
  };
  const channelRuntime = {
    platform: 'test-channel',
    routeType: 'channel.test',
    refreshBindings: async () => {
      channelRefreshes++;
    },
    getQrCode: async (workspaceId: string, instanceId?: string) => ({
      ticket: `ticket:${workspaceId}`,
      expiresIn: 60,
      qrCodeUrl: 'https://example.test/qr',
      instanceId,
    }),
    checkQrCodeStatus: async (_workspaceId: string, ticket: string) => ({
      status: ticket === 'signed-ticket' ? 'signed' : 'wait',
    }),
  } as any;
  const weixinChannelRuntime = {
    platform: 'weixin',
    routeType: 'channel.chat',
    refreshBindings: async () => {
      weixinRefreshes++;
    },
  } as any;
  const controller = new LocalCoreController('/tmp/local-core-controller-injected', {
    kernel: {
      context: {
        bus,
        capabilities: new LocalCoreCapabilityRegistry(),
        logger: { log: () => {} },
      },
      plugins: new LocalCorePluginRegistry(),
      capabilities: new LocalCoreCapabilityRegistry(),
      lifecycle: {} as any,
      diagnostics: {
        snapshot: async () => ({
          pluginCount: 0,
          enabledPluginCount: 0,
          plugins: [],
        }),
      } as any,
      getCapabilitySnapshot: () => capabilitySnapshot,
    },
    state: {
      getSettings: () => ({
        binaryPath: '',
        autoStartService: true,
        defaultProject: 'default',
        managementPort: 0,
        managementToken: '',
        bridgePort: 0,
        bridgeToken: '',
        bridgePath: '',
        plugins: {},
      }),
      getLogs: () => [],
      getLogEntries: () => [],
    } as any,
    store: {
      readRuntimeConfig: () => runtimeConfig,
      saveRuntimeConfig: (config: any) => {
        runtimeConfig = {
          ...runtimeConfig,
          config,
          updatedAt: new Date().toISOString(),
        };
        return runtimeConfig;
      },
      listWorkspaceRegistry: () => [],
    } as any,
    agentRuntimes: [],
    channelRuntimes: [channelRuntime, weixinChannelRuntime],
    channelRuntime,
    weixinChannelRuntime,
    knowledgeProvider: {} as any,
    knowledgeAttachments: {} as any,
    workspaceRouter: {} as any,
    scheduler: {} as any,
    scheduledJobs: {} as any,
    start: async () => {
      started = true;
    },
    stop: async () => {
      stopped = true;
    },
  });

  await controller.init();
  assert.equal(started, true);
  assert.deepEqual(await controller.kernel.getCapabilitySnapshot(), capabilitySnapshot);
  assert.deepEqual(await controller.channelService.getQrCode('test-channel', 'workspace-1', 'instance-1'), {
    ticket: 'ticket:workspace-1',
    expiresIn: 60,
    qrCodeUrl: 'https://example.test/qr',
    instanceId: 'instance-1',
  });
  assert.deepEqual(await controller.channelService.checkQrCodeStatus('test-channel', 'workspace-1', 'signed-ticket'), {
    status: 'signed',
  });
  await controller.saveRuntimeConfig({ projects: [] } as any);
  // init() and saveRuntimeConfig() each refresh bindings once; the channel-gateway
  // startup fix in local-core-controller.init() intentionally added the first call.
  assert.equal(channelRefreshes, 2);
  assert.equal(weixinRefreshes, 2);
  await controller.close();
  assert.equal(stopped, true);
});

test('runtime logs are persisted to unified sys and level logs', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-logs-'));
  const logDir = join(userDataPath, 'logs');
  try {
    withLogEnv(logDir, () => {
      const runtime = bootstrapLocalCoreRuntime({
        userDataPath,
        log: () => {},
      });

      runtime.state.pushLog('localcore-weixin send failed for sessionKey=test');
      runtime.state.pushLog('second line');

      const sysRaw = readFileSync(join(logDir, 'sys.log'), 'utf-8');
      const errorRaw = readFileSync(join(logDir, 'error.log'), 'utf-8');
      const infoRaw = readFileSync(join(logDir, 'info.log'), 'utf-8');
      const sysLines = sysRaw.trim().split(/\r?\n/).map(parseLogLine);
      assert.equal(runtime.state.logPath, join(logDir, 'sys.log'));
      for (const fileName of ['sys.log', 'debug.log', 'info.log', 'warn.log', 'error.log']) {
        assert.equal(existsSync(join(logDir, fileName)), true);
      }
      assert.equal(sysLines.at(-2)?.level, 'error');
      assert.match(sysLines.at(-2)?.ts || '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      assert.equal(sysLines.at(-2)?.message, 'localcore-weixin send failed for sessionKey=test');
      assert.equal(sysLines.at(-1)?.level, 'info');
      assert.equal(sysLines.at(-1)?.message, 'second line');
      assert.match(errorRaw, /localcore-weixin send failed for sessionKey=test/);
      assert.match(infoRaw, /second line/);
      assert.deepEqual(runtime.state.getLogEntries('error', 10).map((entry) => entry.message), [
        'localcore-weixin send failed for sessionKey=test',
      ]);
      assert.deepEqual(runtime.state.getLogEntries('sys', 2).map((entry) => entry.message), [
        'localcore-weixin send failed for sessionKey=test',
        'second line',
      ]);
    });
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('runtime getLogs reads from disk after state is recreated', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-disk-logs-'));
  const logDir = join(userDataPath, 'logs');
  try {
    withLogEnv(logDir, () => {
      const state = createLocalCoreRuntimeState({ userDataPath });
      state.pushLog('first persisted line');
      state.pushLog('second persisted line');

      const recreated = createLocalCoreRuntimeState({ userDataPath });

      assert.deepEqual(recreated.getLogs(2).map((line) => parseLogLine(line).message), [
        'first persisted line',
        'second persisted line',
      ]);
    });
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('runtime getLogs fills from rotated log when current log has fewer lines', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-rotated-logs-'));
  const logDir = join(userDataPath, 'logs');
  try {
    withLogEnv(logDir, () => {
      const state = createLocalCoreRuntimeState({ userDataPath });
      writeFileSync(`${state.logPath}.1`, [
        JSON.stringify({ ts: '2026-01-01 00:00:00.000', level: 'info', scope: 'test', message: 'old-1' }),
        JSON.stringify({ ts: '2026-01-01 00:00:01.000', level: 'info', scope: 'test', message: 'old-2' }),
        JSON.stringify({ ts: '2026-01-01 00:00:02.000', level: 'info', scope: 'test', message: 'old-3' }),
        '',
      ].join('\n'), 'utf8');
      writeFileSync(state.logPath, `${JSON.stringify({ ts: '2026-01-01 00:00:03.000', level: 'info', scope: 'test', message: 'new-1' })}\n`, 'utf8');

      assert.deepEqual(state.getLogs(3).map((line) => parseLogLine(line).message), ['old-2', 'old-3', 'new-1']);
    });
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('runtime getLogs returns only the requested tail lines from disk', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-tail-logs-'));
  const logDir = join(userDataPath, 'logs');
  try {
    withLogEnv(logDir, () => {
      const state = createLocalCoreRuntimeState({ userDataPath });
      writeFileSync(
        state.logPath,
        Array.from({ length: 1000 }, (_, index) =>
          JSON.stringify({ ts: '2026-01-01 00:00:00.000', level: 'info', scope: 'test', message: `line-${index + 1}` })
        ).join('\n') + '\n',
        'utf8',
      );

      assert.deepEqual(state.getLogs(4).map((line) => parseLogLine(line).message), ['line-997', 'line-998', 'line-999', 'line-1000']);
    });
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('runtime logs rotate by file size', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-size-rotated-logs-'));
  const logDir = join(userDataPath, 'logs');
  try {
    withLogEnv(logDir, () => {
      const state = createLocalCoreRuntimeState({ userDataPath });
      state.pushLog('first failed line with enough text to rotate');
      state.pushLog('second failed line with enough text to rotate');
      state.pushLog('third failed line with enough text to rotate');

      const currentSys = readFileSync(join(logDir, 'sys.log'), 'utf8');
      const rotatedSys = readFileSync(join(logDir, 'sys.log.1'), 'utf8');
      const currentError = readFileSync(join(logDir, 'error.log'), 'utf8');
      const rotatedError = readFileSync(join(logDir, 'error.log.1'), 'utf8');
      assert.match(currentSys, /third failed line/);
      assert.match(rotatedSys, /second failed line/);
      assert.match(currentError, /third failed line/);
      assert.match(rotatedError, /second failed line/);
    }, { maxBytes: 120, maxFiles: 2 });
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('controller logs are persisted to sys.log', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-controller-logs-'));
  const logDir = join(userDataPath, 'logs');
  try {
    withLogEnv(logDir, () => {
      const runtime = bootstrapLocalCoreRuntime({
        userDataPath,
      });
      const controller = new LocalCoreController(userDataPath, runtime);
      const emittedLogs: string[] = [];
      controller.on('logs', (line) => emittedLogs.push(line));

      (controller as any).handleLog('localcore-lark inbound message for project-1');

      const raw = readFileSync(join(logDir, 'sys.log'), 'utf-8');
      assert.deepEqual(emittedLogs, ['localcore-lark inbound message for project-1']);
      assert.equal(parseLogLine(raw.trim().split(/\r?\n/).at(-1) || '').message, 'localcore-lark inbound message for project-1');
    });
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('controller buffers bootstrap logs until runtime state is assigned', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-bootstrap-logs-'));
  const logDir = join(userDataPath, 'logs');
  try {
    withLogEnv(logDir, () => {
      const controller = new LocalCoreController(userDataPath);
      const raw = readFileSync(join(logDir, 'sys.log'), 'utf-8');
      assert.match(raw, /\[plugin:builtin\.agent-codex\] registered/);
      assert.equal((raw.match(/\[plugin:builtin\.agent-codex\] registered/g) || []).length, 1);
      void controller.close();
    });
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('channel plugin lifecycle start and stop are driven by the kernel lifecycle', async () => {
  const calls: string[] = [];
  const registry = new LocalCorePluginRegistry();
  registry.register({
    manifest: {
      id: 'plugin.channel-test',
      kind: 'channel',
      version: '0.1.0',
      provides: ['channel:test'],
    },
    init: () => {
      calls.push('init');
    },
    start: () => {
      calls.push('start');
    },
    stop: () => {
      calls.push('stop');
    },
  });
  const lifecycle = new LocalCoreLifecycleManager(registry, {
    bus: new LocalCoreEventBus(),
    capabilities: new LocalCoreCapabilityRegistry(),
    logger: { log: () => {} },
  });

  await lifecycle.startAll();
  await lifecycle.stopAll();

  assert.deepEqual(calls, ['init', 'start', 'stop']);
});

test('server QR routes dispatch through generic channel bindings', async () => {
  const calls: string[] = [];
  const controller = Object.assign(new EventEmitter(), {
    getChannelQrCode: undefined,
    checkChannelQrCodeStatus: undefined,
  });
  const channelService = {
    getQrCode: async (platform: string, workspaceId: string, instanceId?: string) => {
      calls.push(`get:${platform}:${workspaceId}:${instanceId || ''}`);
      return {
        ticket: 'ticket-1',
        expiresIn: 60,
        qrCodeUrl: 'https://example.test/qr',
        instanceId,
      };
    },
    checkQrCodeStatus: async (platform: string, workspaceId: string, ticket: string, instanceId?: string) => {
      calls.push(`check:${platform}:${workspaceId}:${ticket}:${instanceId || ''}`);
      return { status: 'signed' };
    },
  };
  const bindings = { controller, channelService } as any;
  const server = new LocalAiCoreServer(bindings, { port: 0 });
  const qrResponse = await invokeServer(server, 'POST', '/api/local/v1/platforms/slack/workspace-1/qrcode?instance_id=bot-1');
  assert.equal(qrResponse.body.data.ticket, 'ticket-1');
  const statusResponse = await invokeServer(server, 'GET', '/api/local/v1/platforms/slack/workspace-1/qrcode/status?ticket=ticket-1&instance_id=bot-1');
  assert.equal(statusResponse.body.data.status, 'signed');
  assert.deepEqual(calls, [
    'get:slack:workspace-1:bot-1',
    'check:slack:workspace-1:ticket-1:bot-1',
  ]);
});

test('server unknown routes return structured error responses', async () => {
  const controller = new EventEmitter() as any;
  const bindings = { controller } as any;
  const server = new LocalAiCoreServer(bindings, { port: 0 });
  const response = await invokeServer(server, 'GET', '/api/local/v1/not-found');

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'internal_error');
  assert.match(response.body.error, /Unknown route/);
  assert.equal(response.body.errorInfo?.severity, 'error');
});

test('server rejects malformed endpoint input with a 400 response before domain dispatch', async () => {
  let dispatched = false;
  const controller = new EventEmitter() as any;
  const workspaceRouter = {
    createThread: async () => {
      dispatched = true;
      return {};
    },
  };
  const server = new LocalAiCoreServer({ controller, workspaceRouter } as any, { port: 0 });
  const response = await invokeServer(server, 'POST', '/api/local/v1/threads', { workspaceId: 42 });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /workspaceId/);
  assert.equal(dispatched, false);

  const emptyResponse = await invokeServer(server, 'POST', '/api/local/v1/threads', { workspaceId: '   ' });
  assert.equal(emptyResponse.statusCode, 400);
  assert.match(emptyResponse.body.error, /workspaceId/);
  assert.equal(dispatched, false);
});

test('server validates the actual desktop settings contract before dispatch', async () => {
  let dispatched = false;
  const controller = new EventEmitter() as any;
  controller.saveSettings = async () => {
    dispatched = true;
    return {};
  };
  const server = new LocalAiCoreServer({ controller } as any, { port: 0 });

  const invalidPlugins = await invokeServer(server, 'POST', '/api/local/v1/runtime/settings', { plugins: [] });
  assert.equal(invalidPlugins.statusCode, 400);
  assert.match(invalidPlugins.body.error, /plugins/);

  const invalidPluginSettings = await invokeServer(server, 'POST', '/api/local/v1/runtime/settings', {
    plugins: { 'channel.lark': { enabled: 'yes' } },
  });
  assert.equal(invalidPluginSettings.statusCode, 400);
  assert.match(invalidPluginSettings.body.error, /plugins\.channel\.lark\.enabled/);
  assert.equal(dispatched, false);

  const valid = await invokeServer(server, 'POST', '/api/local/v1/runtime/settings', {
    autoStartService: true,
    defaultProject: 'workspace-stable',
    plugins: { 'channel.lark': { enabled: true, config: { appId: 'app-id' } } },
  });
  assert.equal(valid.statusCode, 200);
  assert.equal(dispatched, true);
});

test('server diagnostics routes dispatch through generic bindings', async () => {
  const calls: string[] = [];
  const controller = Object.assign(new EventEmitter(), {
    runDiagnosticsDoctor: async () => {
      calls.push('doctor');
      return {
        status: 'warn',
        checkedAt: '2026-05-12T00:00:00.000Z',
        checks: [
          { id: 'config', label: 'Configuration', status: 'pass', summary: 'ok' },
        ],
      };
    },
    runDeploymentDiagnostics: async () => {
      calls.push('deployment');
      return {
        status: 'pass',
        checkedAt: '2026-05-14T00:00:00.000Z',
        checks: [
          { id: 'deployment.profile', label: 'Deployment profile', status: 'pass', summary: 'ok' },
        ],
      };
    },
  });
  const errorReporter = {
    list: async () => {
      calls.push('errors');
      return [{
        key: 'channel.weixin:channel_session_expired:workspace-1',
        count: 2,
        firstSeenAt: '2026-05-12T00:00:00.000Z',
        lastSeenAt: '2026-05-12T00:05:00.000Z',
        errorInfo: {
          code: 'channel_session_expired',
          message: 'WeChat login expired.',
          userMessage: 'Channel login has expired.',
          severity: 'error',
          retryable: false,
          suggestedAction: 'Reconnect the channel.',
        },
      }];
    },
  };
  const bindings = { controller, errorReporter } as any;
  const server = new LocalAiCoreServer(bindings, { port: 0 });
  const errorsResponse = await invokeServer(server, 'GET', '/api/local/v1/diagnostics/errors');
  const doctorResponse = await invokeServer(server, 'POST', '/api/local/v1/diagnostics/doctor');
  const deploymentResponse = await invokeServer(server, 'POST', '/api/local/v1/diagnostics/deployment');

  assert.equal(errorsResponse.body.data.errors[0].errorInfo.code, 'channel_session_expired');
  assert.equal(doctorResponse.body.data.status, 'warn');
  assert.equal(deploymentResponse.body.data.status, 'pass');
  assert.deepEqual(calls, ['errors', 'doctor', 'deployment']);
});

test('server OpenAI-compatible chat route maps metadata to sandbox yolo external run', async () => {
  let externalInput: any;
  const controller = new EventEmitter() as any;
  const externalService = {
    createRun: async (input: any) => {
      externalInput = input;
      return {
        project: {},
        thread: {},
        workspace_id: 'external-user-project',
        thread_id: 'thread-1',
        run_id: 'run-1',
        task_id: 'task-1',
        events_url: '/api/local/v1/external/runs/run-1/events',
      };
    },
    getRunSnapshot: async () => ({
      runId: 'run-1',
      task: {
        taskId: 'task-1',
        workspaceId: 'external-user-project',
        runtimeId: 'pi',
        threadId: 'thread-1',
        runId: 'run-1',
        title: 'Task',
        status: 'completed',
        createdAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:02.000Z',
        startedAt: '2026-05-15T00:00:01.000Z',
        timeline: [],
        logs: [],
        artifacts: [],
        approvalIds: [],
      },
      thread: {
        id: 'thread-1',
        workspaceId: 'external-user-project',
        title: 'Thread',
        createdAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:02.000Z',
        messages: [{
          id: 'message-1',
          role: 'assistant',
          content: 'final answer',
          timestamp: '2026-05-15T00:00:02.000Z',
          kind: 'final',
        }],
      },
    }),
  };
  const bindings = { controller, externalService } as any;
  const server = new LocalAiCoreServer(bindings, { port: 0 });

  const response = await invokeServer(server, 'POST', '/api/local/v1/openai/chat/completions', {
    model: 'model-1',
    stream: false,
    metadata: {
      user_id: 'user-1',
      project_id: 'project-1',
      thread_id: 'thread-1',
      agent_type: 'pi',
    },
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.object, 'chat.completion');
  assert.equal(response.body.choices[0].message.content, 'final answer');
  assert.equal(externalInput.user_id, 'user-1');
  assert.equal(externalInput.external_project_id, 'project-1');
  assert.equal(externalInput.external_thread_id, 'thread-1');
  assert.equal(externalInput.permission_mode, 'bypassPermissions');
  assert.equal(externalInput.runtime_env.AGENTDOCK_OPENAI_COMPAT, '1');
  assert.match(externalInput.prompt, /\[system\]\nBe concise\./);
  assert.match(externalInput.prompt, /Hello/);
});

test('channel and scheduler capabilities use registry targets instead of Lark-specific routing', () => {
  const registry = new LocalCorePluginRegistry();
  const capabilities = new LocalCoreCapabilityRegistry();
  const plugins: RuntimePlugin[] = [
    {
      manifest: {
        id: 'plugin.channel-slack',
        kind: 'channel',
        version: '0.1.0',
        provides: ['channel:slack'],
      },
      capabilities: {
        channels: [{ id: 'channel.slack', platform: 'slack', routeType: 'channel.chat' }],
      },
    },
    {
      manifest: {
        id: 'plugin.scheduler-slack',
        kind: 'scheduler',
        version: '0.1.0',
        dependsOn: ['plugin.channel-slack'],
        provides: ['scheduler.delivery.slack'],
      },
      capabilities: {
        schedulers: [{ id: 'scheduler.delivery.slack', triggerTypes: [], deliveryTargets: ['slack'] }],
      },
    },
  ];
  for (const entry of plugins) {
    registry.register(entry);
  }
  for (const entry of registry.list()) {
    capabilities.registerContributions(entry.capabilities || {});
  }

  assert.deepEqual(capabilities.snapshot().channels.map((capability) => capability.platform), ['slack']);
  assert.deepEqual(capabilities.snapshot().schedulers.flatMap((capability) => capability.deliveryTargets), ['slack']);
});

test('agent runtime selection is registry-based and disabled runtimes do not route workspaces', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-kernel-'));
  try {
    const runtimeDir = join(userDataPath, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'local-core-settings.json'),
      JSON.stringify({
        defaultProject: 'default',
        autoStartService: true,
        plugins: {
          'builtin.agent-pi': { enabled: false },
          'builtin.agent-claudecode': { enabled: false },
        },
      }),
      'utf8',
    );
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    await saveConfig(runtime, {
      projects: [
        { name: 'claude-workspace', agent: { type: 'claudecode' } },
        { name: 'pi-workspace', agent: { type: 'pi' } },
      ],
    });

    assert.deepEqual(
      runtime.agentRuntimes.map((entry) => entry.agentType),
      ['localcore-acp', 'opencode', 'codex', 'hermes'],
    );
    assert.equal(
      runtime.kernel.getCapabilitySnapshot().snapshot.agents.some((capability) => capability.agentType === 'claudecode'),
      false,
    );
    assert.equal(
      runtime.kernel.getCapabilitySnapshot().snapshot.agents.some((capability) => capability.agentType === 'pi'),
      false,
    );
    assert.deepEqual(await runtime.workspaceRouter.listWorkspaces(), []);

    await assert.rejects(
      () => runtime.workspaceRouter.listThreads('claude-workspace'),
      /Workspace "claude-workspace" is not configured as a Local AI Core ACP workspace/,
    );
    await runtime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('renderer route and nav rendering are sourced from the contribution registry', () => {
  const appSource = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
  const sidebarSource = readFileSync(join(process.cwd(), 'src', 'components', 'Layout', 'Sidebar.tsx'), 'utf8');
  const headerSource = readFileSync(join(process.cwd(), 'src', 'components', 'Layout', 'Header.tsx'), 'utf8');

  assert.match(appSource, /rendererUiContributions\.listRoutes\(\)\.map/);
  assert.match(sidebarSource, /rendererUiContributions\s*\.\s*listNavItems\(\)/);
  assert.match(headerSource, /resolveRouteTitleKey/);
});

test('renderer feature visibility is capability-driven', () => {
  const runtimeSource = readFileSync(join(process.cwd(), 'src', 'app', 'runtime.ts'), 'utf8');
  const sidebarSource = readFileSync(join(process.cwd(), 'src', 'components', 'Layout', 'Sidebar.tsx'), 'utf8');
  const dashboardSource = readFileSync(join(process.cwd(), 'src', 'pages', 'Dashboard.tsx'), 'utf8');

  assert.match(runtimeSource, /snapshot\?\.knowledge\.some/);
  assert.match(runtimeSource, /snapshot\?\.schedulers\.some/);
  assert.match(runtimeSource, /snapshot\?\.agents\.some/);
  assert.match(sidebarSource, /useRuntimeFeatureSupport/);
  assert.match(dashboardSource, /useRuntimeFeatureSupport/);
});
