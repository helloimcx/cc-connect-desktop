import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalCoreAcpStore } from '../../services/local-ai-core/src/acp/store/local-core-acp-store.js';
import { LocalCoreAcpSessionCoordinator } from '../../services/local-ai-core/src/acp/local-core-acp-session-coordinator.js';
import { bootstrapLocalCoreRuntime } from '../../services/local-ai-core/src/kernel/bootstrap.js';

test('SessionCoordinator skips stale acp_session_id when launch config key changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-config-mismatch-'));
  try {
    const store = new LocalCoreAcpStore(dir);
    const thread = store.createThread('workspace-a', 'Test Thread', 'hermes');
    const oldConfigKey = JSON.stringify({
      agentType: 'hermes',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      keyHash: '',
    });
    // Simulate previous session saved under old provider
    store.updateThreadSession(thread.id, 'old-session-123', true, oldConfigKey);
    const loadedRow = store.getThreadRow(thread.id);
    assert.equal(loadedRow?.acp_session_id, 'old-session-123');
    assert.equal(loadedRow?.acp_launch_config_key, oldConfigKey);

    const calls: string[] = [];
    const coordinator = new LocalCoreAcpSessionCoordinator({
      store,
      transport: {
        spawnSession(input: any) {
          return {
            threadId: input.threadId,
            bridgeSessionKey: input.bridgeSessionKey,
            closed: false,
            sessionId: '',
            supportsLoad: true,
            currentRunId: null,
            currentTurn: null,
            pendingPermissionByRun: new Map(),
            schedulerJobCreatedByRun: new Map(),
            launchPermissionMode: '',
          };
        },
        initializeSession: async () => {},
        request: async (_session: any, method: string, params: any) => {
          calls.push(`${method}:${params?.sessionId || ''}`);
          if (method === 'session/new') {
            return { sessionId: 'new-session-456' };
          }
          return {};
        },
        closeSession: () => {},
        closeSessionWithError: () => {},
        sendRaw: () => true,
      } as any,
      runThreadMap: new Map(),
      emitBridge: () => {},
    });

    // Now ensureSession runs with the NEW provider config (火山)
    const newConfig = {
      workspaceId: 'workspace-a',
      agentType: 'hermes',
      workDir: '/tmp/workspace-a',
      command: 'hermes',
      args: ['acp'],
      env: {
        OPENAI_BASE_URL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        OPENAI_API_KEY: 'sk-secret-volcano-api-key-98765',
      },
      model: 'deepseek-v4-flash',
    };

    const session = await coordinator.ensureSession(thread.id, 'session:thread-1', newConfig as any);
    assert.equal(session.sessionId, 'new-session-456');

    // session/load must NOT have been called with 'old-session-123'!
    assert.equal(calls.includes('session/load:old-session-123'), false, 'Stale session must not be loaded when config changes');
    assert.equal(calls.some((c) => c.startsWith('session/new')), true, 'Fresh session must be created on config change');

    // Verify DB was updated with new session and new config key
    const updatedRow = store.getThreadRow(thread.id);
    assert.equal(updatedRow?.acp_session_id, 'new-session-456');
    assert.ok(updatedRow?.acp_launch_config_key?.includes('ark.cn-beijing.volces.com'));
    assert.equal(
      updatedRow?.acp_launch_config_key?.includes('sk-secret-volcano-api-key-98765'),
      false,
      'API key must not be stored in plaintext in acp_launch_config_key',
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Platform thread binding supports preferred_provider_id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-provider-binding-'));
  try {
    const store = new LocalCoreAcpStore(dir);
    const now = new Date().toISOString();
    store.upsertPlatformThreadBinding({
      workspace_id: 'workspace-a',
      platform: 'lark',
      chat_id: 'chat-1',
      platform_user_id: 'user-1',
      thread_id: 'thread-1',
      last_platform_message_id: null,
      preferred_agent_type: 'hermes',
      preferred_provider_id: 'provider-volcano',
      created_at: now,
      updated_at: now,
    });

    let binding = store.getPlatformThreadBinding('workspace-a', 'chat-1', 'user-1', 'lark');
    assert.equal(binding?.preferred_provider_id, 'provider-volcano');

    store.updatePlatformThreadPreferredProvider('workspace-a', 'chat-1', 'user-1', 'provider-deepseek', 'lark');
    binding = store.getPlatformThreadBinding('workspace-a', 'chat-1', 'user-1', 'lark');
    assert.equal(binding?.preferred_provider_id, 'provider-deepseek');

    store.updatePlatformThreadPreferredProvider('workspace-a', 'chat-1', 'user-1', null, 'lark');
    binding = store.getPlatformThreadBinding('workspace-a', 'chat-1', 'user-1', 'lark');
    assert.equal(binding?.preferred_provider_id, null);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upsertModelProvider clears existing thread sessions when credentials change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-change-invalidation-'));
  try {
    const store = new LocalCoreAcpStore(dir);
    store.upsertModelProvider({
      id: 'provider-1',
      name: 'Old Provider',
      base_url: 'https://old.provider.com/v1',
      api_key: 'old-key',
    });

    const thread = store.createThread('workspace-a', 'Test Thread', 'hermes');
    store.updateThreadSession(thread.id, 'session-abc', true, 'old-key-hash');

    let row = store.getThreadRow(thread.id);
    assert.equal(row?.acp_session_id, 'session-abc');

    // Updating same provider with same credentials does NOT clear sessions
    store.upsertModelProvider({
      id: 'provider-1',
      name: 'Old Provider Renamed',
      base_url: 'https://old.provider.com/v1',
      api_key: 'old-key',
    });
    row = store.getThreadRow(thread.id);
    assert.equal(row?.acp_session_id, 'session-abc');

    // Updating provider base_url/api_key (e.g. opencode -> 火山) clears thread sessions
    store.upsertModelProvider({
      id: 'provider-1',
      name: 'Volcano Provider',
      base_url: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      api_key: 'ark-new-key',
    });
    row = store.getThreadRow(thread.id);
    assert.equal(row?.acp_session_id, null, 'acp_session_id must be cleared on provider credentials update');
    assert.equal(row?.acp_launch_config_key, null, 'acp_launch_config_key must be cleared');

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ThreadCommandService handles /provider current, list, use, reset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-slash-command-'));
  try {
    const store = new LocalCoreAcpStore(dir);
    store.upsertModelProvider({
      id: 'provider-default',
      name: 'Default Provider',
      base_url: 'https://default.ai/v1',
      api_key: 'key-1',
    });
    store.upsertModelProvider({
      id: 'provider-volcano',
      name: '火山方舟',
      base_url: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      api_key: 'key-2',
    });

    const thread = store.createThread('workspace-a', 'Test Thread', 'hermes');
    const channelContext = {
      chatId: 'chat-100',
      platformUserId: 'user-200',
      platform: 'lark',
    };
    const now = new Date().toISOString();
    store.upsertPlatformThreadBinding({
      workspace_id: 'workspace-a',
      platform: 'lark',
      chat_id: 'chat-100',
      platform_user_id: 'user-200',
      thread_id: thread.id,
      last_platform_message_id: null,
      created_at: now,
      updated_at: now,
    });

    const { ThreadCommandService, createProviderCommandOptions } = await import('../../services/local-ai-core/src/thread/thread-command-service.js');
    const service = new ThreadCommandService({
      getThreadRow: (id) => store.getThreadRow(id),
      updateThreadAgentMode: (id, mode) => store.updateThreadAgentMode(id, mode),
      updateThreadAgentType: (id, type) => store.updateThreadAgentType(id, type),
      getLatestRunForThread: () => undefined,
      createAuditEvent: () => {},
      ...createProviderCommandOptions(store),
      getWorkspaceDefaultProviderId: () => 'provider-default',
    });

    // 1. /provider current when inheriting default
    const resCurrentDefault = await service.execute({
      threadId: thread.id,
      workspaceId: 'workspace-a',
      content: '/provider current',
      defaultAgentType: 'hermes',
      channel: channelContext,
    });
    assert.ok(resCurrentDefault.displayText.includes('Default Provider'));
    assert.ok(resCurrentDefault.displayText.includes('工作区默认设置'));

    // 2. /provider list
    const resList = await service.execute({
      threadId: thread.id,
      workspaceId: 'workspace-a',
      content: '/provider list',
      defaultAgentType: 'hermes',
      channel: channelContext,
    });
    assert.ok(resList.displayText.includes('provider-default'));
    assert.ok(resList.displayText.includes('provider-volcano'));

    // 3. /provider use provider-volcano
    const resUse = await service.execute({
      threadId: thread.id,
      workspaceId: 'workspace-a',
      content: '/provider use provider-volcano',
      defaultAgentType: 'hermes',
      channel: channelContext,
    });
    assert.ok(resUse.displayText.includes('火山方舟'));

    // Verify channel binding now has preferred_provider_id
    const bindingAfterUse = store.getPlatformThreadBinding('workspace-a', 'chat-100', 'user-200', 'lark');
    assert.equal(bindingAfterUse?.preferred_provider_id, 'provider-volcano');

    // 4. /provider current now reflects channel override
    const resCurrentOverride = await service.execute({
      threadId: thread.id,
      workspaceId: 'workspace-a',
      content: '/provider current',
      defaultAgentType: 'hermes',
      channel: channelContext,
    });
    assert.ok(resCurrentOverride.displayText.includes('火山方舟'));
    assert.ok(resCurrentOverride.displayText.includes('渠道偏好设置'));

    // 5. /provider reset
    const resReset = await service.execute({
      threadId: thread.id,
      workspaceId: 'workspace-a',
      content: '/provider reset',
      defaultAgentType: 'hermes',
      channel: channelContext,
    });
    assert.ok(resReset.displayText.includes('已清除当前渠道的 Provider 偏好设置'));

    const bindingAfterReset = store.getPlatformThreadBinding('workspace-a', 'chat-100', 'user-200', 'lark');
    // 6. /provider help
    const resHelp = await service.execute({
      threadId: thread.id,
      workspaceId: 'workspace-a',
      content: '/provider help',
      defaultAgentType: 'hermes',
      channel: channelContext,
    });
    assert.ok(resHelp.displayText.includes('使用方式：'));
    assert.ok(resHelp.displayText.includes('/provider use <id>'));

    // 7. /provider use without channel
    const resNoChannel = await service.execute({
      threadId: thread.id,
      workspaceId: 'workspace-a',
      content: '/provider use provider-volcano',
      defaultAgentType: 'hermes',
    });
    assert.ok(resNoChannel.displayText.includes('未绑定飞书或微信等渠道'));

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkspaceRouter resolves channel preferred provider via channelRoute with type channel.chat', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-channel-router-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    runtime.store.upsertModelProvider({
      id: 'provider-default',
      name: 'Default Provider',
      base_url: 'https://default.ai/v1',
      api_key: 'key-default',
    });
    runtime.store.upsertModelProvider({
      id: 'provider-volcano',
      name: '火山方舟',
      base_url: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      api_key: 'key-volcano',
    });
    await runtime.store.saveRuntimeConfig({
      projects: [{ name: 'agent-workspace', agent: { type: 'hermes', options: { provider_id: 'provider-default' } } }] as any,
    });

    const thread = await runtime.workspaceRouter.createThread('agent-workspace', 'Channel route provider test');
    const now = new Date().toISOString();
    runtime.store.upsertPlatformThreadBinding({
      workspace_id: 'agent-workspace',
      platform: 'lark',
      chat_id: 'chat-999',
      platform_user_id: 'user-888',
      thread_id: thread.id,
      last_platform_message_id: null,
      preferred_agent_type: 'hermes',
      preferred_provider_id: 'provider-volcano',
      created_at: now,
      updated_at: now,
    });

    let capturedConfig: any;
    (runtime.workspaceRouter as any).localCoreAcp.sendThreadMessage = async (
      _tid: string,
      _content: any,
      config: any,
    ) => {
      capturedConfig = config;
      return { runId: 'run-1' };
    };

    // When channelRoute is passed with type: 'channel.chat' (as Lark/Weixin gateways do)
    await runtime.workspaceRouter.sendThreadMessage(thread.id, 'Hello test', {
      channelRoute: {
        type: 'channel.chat',
        channelId: 'chat-999',
        participantId: 'user-888',
      },
    });

    assert.ok(capturedConfig, 'sendThreadMessage must be called');
    assert.ok(
      capturedConfig.env?.OPENAI_BASE_URL?.includes('ark.cn-beijing.volces.com'),
      `Expected Volcano Ark endpoint, but got: ${capturedConfig.env?.OPENAI_BASE_URL}`,
    );

    await runtime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

