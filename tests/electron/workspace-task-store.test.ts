import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { LocalCoreAcpStore } from '../../services/local-ai-core/src/acp/local-core-acp-store.js';
import { configureSqlitePragmas } from '../../services/local-ai-core/src/acp/store/schema.js';
import { LocalCoreAcpBackend } from '../../services/local-ai-core/src/acp/local-core-acp-backend.js';
import { buildAgentPath, LocalCoreAcpSessionCoordinator } from '../../services/local-ai-core/src/acp/local-core-acp-session-coordinator.js';
import { LocalCoreAcpTransport } from '../../services/local-ai-core/src/acp/local-core-acp-transport.js';
import { LocalCoreAcpTurnCoordinator } from '../../services/local-ai-core/src/acp/local-core-acp-turn-coordinator.js';
import { SchedulerService } from '../../services/local-ai-core/src/scheduler/scheduler-service.js';
import { LarkScheduleAdapter } from '../../services/local-ai-core/src/scheduler/lark-schedule-adapter.js';
import { bootstrapLocalCoreRuntime } from '../../services/local-ai-core/src/kernel/bootstrap.js';
import { LocalCoreController } from '../../services/local-ai-core/src/runtime/local-core-controller.js';
import { getPathEnv } from '../../services/local-ai-core/src/runtime/env-utils.js';

test('workspace registry entries persist in LocalCoreAcpStore', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'workspace-registry-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    store.upsertWorkspaceRegistryEntry({
      workspaceId: 'workspace-a',
      displayName: 'Workspace A',
      path: '/tmp/workspace-a',
      deviceId: 'local',
      defaultRuntimeId: 'opencode',
      health: { status: 'healthy', summary: 'ok', issues: [] },
      git: { isRepo: false },
    });
    store.close();

    const nextStore = new LocalCoreAcpStore(userDataPath);
    const workspace = nextStore.getWorkspaceRegistryEntry('workspace-a');
    assert.equal(workspace?.displayName, 'Workspace A');
    assert.equal(workspace?.defaultRuntimeId, 'opencode');
    assert.equal(workspace?.health.status, 'healthy');
    nextStore.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('runtime project migration makes workspace registry authoritative and preserves identity across rename', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'workspace-project-migration-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({ userDataPath, log: () => {} });
    const controller = new LocalCoreController(userDataPath, runtime);
    await controller.saveRuntimeConfig({
      projects: [{
        name: 'Workspace A',
        agent: { type: 'pi', options: { work_dir: '/tmp/workspace-a' } },
        platforms: [],
      }],
    });

    const first = await controller.readRuntimeConfig();
    const workspaceId = first.config.projects?.[0]?.workspace_id;
    assert.ok(workspaceId);
    assert.equal(controller.store.getWorkspaceRegistryEntry(workspaceId)?.displayName, 'Workspace A');
    // SQLite runtime_config is the single source of truth: the full project
    // (with its workspace_id) is persisted there, and the registry mirrors it.
    const storeProjects = controller.store.readRuntimeConfig().config.projects;
    assert.equal(storeProjects?.[0]?.workspace_id, workspaceId);
    assert.equal(storeProjects?.[0]?.name, 'Workspace A');

    await controller.saveRuntimeConfig({
      ...first.config,
      projects: [{ ...first.config.projects![0]!, name: 'Workspace B' }],
    });
    const renamed = await controller.readRuntimeConfig();
    assert.equal(renamed.config.projects?.[0]?.workspace_id, workspaceId);
    assert.equal(controller.store.getWorkspaceRegistryEntry(workspaceId)?.displayName, 'Workspace B');
    assert.equal((await controller.workspaceRouter.listWorkspaces())[0]?.id, workspaceId);
    await controller.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('countThreadsByWorkspace batches thread counts across workspaces in one query', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'thread-count-batch-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    store.createThread('workspace-a', 'A1');
    store.createThread('workspace-a', 'A2');
    store.createThread('workspace-b', 'B1');
    // workspace-c has no threads; workspace-d is not in the input set at all.

    const counts = store.countThreadsByWorkspace(['workspace-a', 'workspace-b', 'workspace-c']);
    assert.equal(counts.get('workspace-a'), 2);
    assert.equal(counts.get('workspace-b'), 1);
    assert.equal(counts.get('workspace-c'), 0);
    assert.equal(counts.has('workspace-d'), false);

    const empty = store.countThreadsByWorkspace([]);
    assert.equal(empty.size, 0);

    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('model providers persist independently from workspace config', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'model-provider-store-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const provider = store.upsertModelProvider({
      name: 'deepseek',
      api_key: 'secret',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      env: { CUSTOM_PROVIDER_ENV: '1' },
    });

    assert.equal(provider.id, 'deepseek');
    assert.equal(provider.api_key, 'secret');
    assert.equal(store.listModelProviders().length, 1);

    const reopened = new LocalCoreAcpStore(userDataPath);
    assert.equal(reopened.getModelProvider('deepseek')?.model, 'deepseek-v4-flash');
    reopened.close();
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('external project and thread mappings persist with isolated workspace paths', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'external-store-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const project = store.upsertExternalProject({
      userId: 'user-a',
      externalProjectId: 'project-a',
      workspaceId: 'external-user-a-project-a',
      workspacePath: '/data/users/user-a/projects/project-a',
      displayName: 'Project A',
      agentType: 'pi',
      providerId: 'deepseek',
      metadata: { source: 'external' },
      createdAt: '2026-05-15T00:00:00.000Z',
      updatedAt: '2026-05-15T00:00:00.000Z',
    });
    const thread = store.createThread(project.workspaceId, 'Thread A', 'pi');
    store.upsertExternalThread({
      userId: project.userId,
      externalProjectId: project.externalProjectId,
      externalThreadId: 'thread-a',
      workspaceId: project.workspaceId,
      threadId: thread.id,
      workspacePath: '/data/users/user-a/projects/project-a/threads/thread-a/workspace',
      metadata: { channel: 'api' },
      createdAt: '2026-05-15T00:00:00.000Z',
      updatedAt: '2026-05-15T00:00:00.000Z',
    });
    store.close();

    const reopened = new LocalCoreAcpStore(userDataPath);
    assert.equal(reopened.getExternalProject('user-a', 'project-a')?.workspacePath, '/data/users/user-a/projects/project-a');
    assert.equal(
      reopened.getExternalThreadByThreadId(thread.id)?.workspacePath,
      '/data/users/user-a/projects/project-a/threads/thread-a/workspace',
    );
    reopened.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('controller stores embedded project providers as-is without migrating them', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'model-provider-migration-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
      log: () => {},
    });
    const controller = new LocalCoreController(userDataPath, runtime);
    await controller.saveRuntimeConfig({
      projects: [{
        name: 'workspace-a',
        agent: {
          type: 'pi',
          options: { work_dir: '/tmp/workspace-a' },
          providers: [{
            name: 'deepseek-v4-flash',
            api_key: 'secret',
            base_url: 'https://api.deepseek.com',
            model: 'deepseek-v4-flash',
          }],
        },
        platforms: [],
      }],
    });

    // SQLite is the single source of truth: the project is stored verbatim and
    // nothing is copied into the shared provider store.
    const config = await controller.readRuntimeConfig();
    assert.equal(config.config?.projects?.[0]?.agent.options?.provider_id, undefined);
    assert.equal(config.config?.projects?.[0]?.agent.providers?.length, 1);
    assert.equal(controller.store.listModelProviders().length, 0);
    await controller.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('workspace router resolves projects that select a shared provider', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'workspace-provider-ref-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
      log: () => {},
    });
    const controller = new LocalCoreController(userDataPath, runtime);
    const provider = controller.store.upsertModelProvider({
      name: 'deepseek',
      api_key: 'secret',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });
    await controller.saveRuntimeConfig({
      projects: [{
        name: 'workspace-a',
        agent: {
          type: 'pi',
          options: {
            work_dir: '/tmp/workspace-a',
            provider_id: provider.id,
          },
        },
        platforms: [],
      }],
    });

    const workspaces = await controller.workspaceRouter.listWorkspaces();
    assert.equal(workspaces[0]?.id, 'workspace-a');
    assert.equal(workspaces[0]?.agentType, 'pi');
    await controller.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('scheduler create resolves a Lark delivery route without binding the job to a thread', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'scheduler-binding-route-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
      log: () => {},
    });
    const controller = new LocalCoreController(userDataPath, runtime);
    const thread = runtime.store.createThread('workspace-a', 'Lark thread');
    const now = new Date().toISOString();
    runtime.store.upsertPlatformThreadBinding({
      workspace_id: 'workspace-a',
      platform: 'lark',
      chat_id: 'chat-1',
      platform_user_id: 'user-1',
      thread_id: thread.id,
      last_platform_message_id: null,
      created_at: now,
      updated_at: now,
    });

    const job = await controller.scheduledJobs.createJob({
      workspaceId: 'workspace-a',
      threadId: thread.id,
      executionMode: 'side-thread',
      triggerType: 'cron',
      cronExpr: '30 18 * * *',
      promptTemplate: 'ping',
      description: 'bound lark task',
      enabled: true,
    });

    assert.equal(job.platform, 'lark');
    assert.deepEqual(job.route, {
      type: 'channel.chat',
      channelId: 'chat-1',
      participantId: 'user-1',
    });
    await controller.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('scheduler create from a bound thread preserves channel instance route', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'scheduler-instance-route-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
      log: () => {},
    });
    const controller = new LocalCoreController(userDataPath, runtime);
    const thread = runtime.store.createThread('workspace-a', 'Lark instance thread');
    const now = new Date().toISOString();
    runtime.store.upsertPlatformThreadBinding({
      workspace_id: 'workspace-a',
      platform: 'lark:lark-1',
      chat_id: 'chat-1',
      platform_user_id: 'user-1',
      thread_id: thread.id,
      last_platform_message_id: null,
      created_at: now,
      updated_at: now,
    });

    const job = await controller.scheduledJobs.createJob({
      workspaceId: 'workspace-a',
      threadId: thread.id,
      executionMode: 'side-thread',
      triggerType: 'cron',
      cronExpr: '30 18 * * *',
      promptTemplate: 'ping',
      description: 'bound lark task',
      enabled: true,
    });

    assert.equal(job.platform, 'lark:lark-1');
    assert.deepEqual(job.route, {
      type: 'channel.chat',
      channelId: 'chat-1',
      instanceId: 'lark-1',
      participantId: 'user-1',
    });
    await controller.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('Lark scheduled same-thread execution resolves the latest channel thread and keeps channel delivery', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'scheduler-lark-latest-thread-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const oldThread = store.createThread('workspace-a', 'Old Lark thread');
    const latestThread = store.createThread('workspace-a', 'Latest Lark thread');
    const now = new Date().toISOString();
    store.upsertPlatformThreadBinding({
      workspace_id: 'workspace-a',
      platform: 'lark',
      chat_id: 'chat-1',
      platform_user_id: 'user-1',
      thread_id: oldThread.id,
      last_platform_message_id: null,
      created_at: now,
      updated_at: now,
    });
    store.upsertPlatformThreadBinding({
      workspace_id: 'workspace-a',
      platform: 'lark',
      chat_id: 'chat-1',
      platform_user_id: 'user-1',
      thread_id: latestThread.id,
      last_platform_message_id: null,
      created_at: now,
      updated_at: now,
    });
    const job = store.createScheduledJob({
      workspaceId: 'workspace-a',
      platform: 'lark',
      route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1', threadId: oldThread.id },
      executionMode: 'same-thread',
      triggerType: 'cron',
      cronExpr: '30 18 * * *',
      promptTemplate: 'ping',
      description: 'bound lark task',
      enabled: true,
    });
    let sentThreadId = '';
    let registeredBridge: any;
    const bridgeEvents: any[] = [];
    let unregisteredBridge = false;
    const adapter = new LarkScheduleAdapter({
      store,
      getWorkspaceRouter: () => ({
        getThreadSessionKey: (threadId: string) => `session:${threadId}`,
        getThread: async (threadId: string) => ({
          id: threadId,
          workspaceId: 'workspace-a',
          title: 'Thread',
          live: false,
          updatedAt: now,
          createdAt: now,
          historyCount: 1,
          excerpt: '',
          bridgeSessionKey: '',
          agentType: 'localcore-acp',
          selectedKnowledgeBaseIds: [],
          pendingPermissionRequest: null,
          messages: [{ id: 'message-1', role: 'assistant', kind: 'final', content: 'pong', timestamp: now }],
        }),
        sendThreadMessage: async (threadId: string) => {
          sentThreadId = threadId;
          store.updateRun('run-1', threadId, 'completed');
          return { runId: 'run-1' };
        },
      }) as any,
      getChannelRuntime: () => ({
        onBridgeEvent: async (event: any) => {
          bridgeEvents.push(event);
        },
        registerScheduledThreadBridge: (input: any) => {
          registeredBridge = input;
          return () => {
            unregisteredBridge = true;
          };
        },
        sendScheduledMessage: async () => {
          throw new Error('scheduled Lark replies should be delivered through bridge events');
        },
      }) as any,
    });

    const result = await adapter.execute({ job, triggeredAt: now });

    assert.equal(sentThreadId, latestThread.id);
    assert.equal(result.threadId, latestThread.id);
    assert.equal('platformMessageId' in result, false);
    assert.deepEqual(registeredBridge, {
      workspaceId: 'workspace-a',
      platform: 'lark',
      route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1', threadId: oldThread.id },
      threadId: latestThread.id,
      sessionKey: `session:${latestThread.id}`,
    });
    assert.deepEqual(bridgeEvents[0], {
      type: 'status',
      sessionKey: `session:${latestThread.id}`,
      bridgeKind: 'status',
      content: '⏰ bound lark task',
    });
    assert.equal(unregisteredBridge, true);
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('Lark scheduled execution resolves workspace router at execution time', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'scheduler-lark-lazy-router-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const thread = store.createThread('workspace-a', 'Lark thread');
    const now = new Date().toISOString();
    store.upsertPlatformThreadBinding({
      workspace_id: 'workspace-a',
      platform: 'lark:lark-1',
      chat_id: 'chat-1',
      platform_user_id: 'user-1',
      thread_id: thread.id,
      last_platform_message_id: null,
      created_at: now,
      updated_at: now,
    });
    const job = store.createScheduledJob({
      workspaceId: 'workspace-a',
      platform: 'lark:lark-1',
      route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1' },
      executionMode: 'same-thread',
      triggerType: 'cron',
      cronExpr: '30 18 * * *',
      promptTemplate: 'ping',
      description: 'bound lark task',
      enabled: true,
    });
    let sentThreadId = '';
    let workspaceRouter: any;
    const adapter = new LarkScheduleAdapter({
      store,
      getWorkspaceRouter: () => workspaceRouter,
      getChannelRuntime: () => ({
        registerScheduledThreadBridge: () => () => {},
        sendScheduledMessage: async () => {
          throw new Error('scheduled Lark replies should be delivered through bridge events');
        },
      }) as any,
    });
    workspaceRouter = {
      getThreadSessionKey: (threadId: string) => `session:${threadId}`,
      getThread: async (threadId: string) => ({
        id: threadId,
        workspaceId: 'workspace-a',
        title: 'Thread',
        live: false,
        updatedAt: now,
        createdAt: now,
        historyCount: 1,
        excerpt: '',
        bridgeSessionKey: '',
        agentType: 'localcore-acp',
        selectedKnowledgeBaseIds: [],
        pendingPermissionRequest: null,
        messages: [{ id: 'message-1', role: 'assistant', kind: 'final', content: 'pong', timestamp: now }],
      }),
      sendThreadMessage: async (threadId: string) => {
        sentThreadId = threadId;
        store.updateRun('run-1', threadId, 'completed');
        return { runId: 'run-1' };
      },
    };

    const result = await adapter.execute({ job, triggeredAt: now });

    assert.equal(sentThreadId, thread.id);
    assert.equal(result.threadId, thread.id);
    assert.equal('platformMessageId' in result, false);
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('Lark scheduled execution supports instance-qualified platform keys', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'scheduler-lark-instance-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const thread = store.createThread('workspace-a', 'Lark instance thread');
    const now = new Date().toISOString();
    store.upsertPlatformThreadBinding({
      workspace_id: 'workspace-a',
      platform: 'lark:lark-1',
      chat_id: 'chat-1',
      platform_user_id: 'user-1',
      thread_id: thread.id,
      last_platform_message_id: null,
      created_at: now,
      updated_at: now,
    });
    const job = store.createScheduledJob({
      workspaceId: 'workspace-a',
      platform: 'lark:lark-1',
      route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1' },
      executionMode: 'same-thread',
      triggerType: 'cron',
      cronExpr: '30 18 * * *',
      promptTemplate: 'ping',
      description: 'bound lark task',
      enabled: true,
    });
    let registeredBridge: any;
    const adapter = new LarkScheduleAdapter({
      store,
      getWorkspaceRouter: () => ({
        getThreadSessionKey: (threadId: string) => `session:${threadId}`,
        getThread: async (threadId: string) => ({
          id: threadId,
          workspaceId: 'workspace-a',
          title: 'Thread',
          live: false,
          updatedAt: now,
          createdAt: now,
          historyCount: 1,
          excerpt: '',
          bridgeSessionKey: '',
          agentType: 'localcore-acp',
          selectedKnowledgeBaseIds: [],
          pendingPermissionRequest: null,
          messages: [{ id: 'message-1', role: 'assistant', kind: 'final', content: 'pong', timestamp: now }],
        }),
        sendThreadMessage: async (threadId: string, _prompt: string, options?: any) => {
          assert.equal(threadId, thread.id);
          assert.equal(options?.runtimeEnv?.LOCAL_AI_PLATFORM, 'lark');
          assert.equal(options?.runtimeEnv?.LOCAL_AI_PLATFORM_INSTANCE_ID, 'lark-1');
          assert.equal(options?.runtimeEnv?.LOCAL_AI_CHAT_ID, 'chat-1');
          store.updateRun('run-1', threadId, 'completed');
          return { runId: 'run-1' };
        },
      }) as any,
      getChannelRuntime: () => ({
        registerScheduledThreadBridge: (input: any) => {
          registeredBridge = input;
          return () => {};
        },
        sendScheduledMessage: async () => {
          throw new Error('scheduled Lark replies should be delivered through bridge events');
        },
      }) as any,
    });

    const result = await adapter.execute({ job, triggeredAt: now });

    assert.equal(result.threadId, thread.id);
    assert.equal('platformMessageId' in result, false);
    assert.deepEqual(registeredBridge, {
      workspaceId: 'workspace-a',
      platform: 'lark:lark-1',
      route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1' },
      threadId: thread.id,
      sessionKey: `session:${thread.id}`,
    });
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('ACP runtime env includes the current workspace path for file returns', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'workspace-env-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    store.upsertWorkspaceRegistryEntry({
      workspaceId: 'workspace-a',
      displayName: 'Workspace A',
      path: '/tmp/workspace-a',
      deviceId: 'local',
      defaultRuntimeId: 'opencode',
      health: { status: 'healthy', summary: 'ok', issues: [] },
      git: { isRepo: false },
    });
    const thread = store.createThread('workspace-a', 'Thread');
    let capturedRuntimeEnv: Record<string, string> | undefined;
    const coordinator = new LocalCoreAcpSessionCoordinator({
      store,
      transport: {
        spawnSession(input: any) {
          capturedRuntimeEnv = input.runtimeEnv;
          return {
            threadId: input.threadId,
            bridgeSessionKey: input.bridgeSessionKey,
            closed: false,
            sessionId: '',
            supportsLoad: false,
            pendingPermissionByRun: new Map(),
            schedulerJobCreatedByRun: new Map(),
          };
        },
        initializeSession: async () => {},
        request: async () => ({ sessionId: 'session-1' }),
        closeSession: () => {},
        closeSessionWithError: () => {},
        sendRaw: () => true,
      } as any,
      runThreadMap: new Map(),
      emitBridge: () => {},
    });

    await coordinator.ensureSession(thread.id, 'session:thread-1', {
      workspaceId: 'workspace-a',
      agentType: 'opencode',
      command: 'opencode',
      args: [],
      env: {},
      workDir: '/tmp/workspace-a',
      model: '',
    });

    assert.equal(capturedRuntimeEnv?.LOCAL_AI_WORKSPACE_ID, 'workspace-a');
    assert.equal(capturedRuntimeEnv?.LOCAL_AI_WORKSPACE_PATH, '/tmp/workspace-a');
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('ACP interruption does not cancel a newer run that reused the same session', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'run-interrupt-race-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const thread = store.createThread('workspace-a', 'Thread');
    store.updateRun('run-old', thread.id, 'completed');
    const runThreadMap = new Map([['run-old', thread.id]]);
    const sentPayloads: any[] = [];
    const coordinator = new LocalCoreAcpSessionCoordinator({
      store,
      transport: {
        spawnSession(input: any) {
          return {
            threadId: input.threadId,
            bridgeSessionKey: input.bridgeSessionKey,
            closed: false,
            sessionId: '',
            supportsLoad: false,
            pendingPermissionByRun: new Map(),
            schedulerJobCreatedByRun: new Map(),
            launchPermissionMode: '',
          };
        },
        initializeSession: async () => {},
        request: async (_session: any, method: string) => method === 'session/new' ? { sessionId: 'session-1' } : {},
        closeSession: () => {},
        closeSessionWithError: () => {},
        sendRaw: (_session: any, payload: any) => {
          sentPayloads.push(payload);
          return true;
        },
      } as any,
      runThreadMap,
      emitBridge: () => {},
    });
    const session = await coordinator.ensureSession(thread.id, 'session:thread-1', {
      workspaceId: 'workspace-a',
      agentType: 'opencode',
      command: 'opencode',
      args: [],
      env: {},
      workDir: '/tmp/workspace-a',
      model: '',
    });
    session.currentRunId = 'run-new';

    assert.deepEqual(await coordinator.interruptRun('run-old'), { interrupted: false });
    assert.equal(store.getRun('run-old')?.status, 'completed');
    assert.equal(sentPayloads.some((payload) => payload.method === 'session/cancel'), false);
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('ACP interruption marks a run interrupted while its session has no active prompt yet', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'run-interrupt-initializing-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const thread = store.createThread('workspace-a', 'Thread');
    store.updateRun('run-initializing', thread.id, 'running');
    const runThreadMap = new Map([['run-initializing', thread.id]]);
    const sentPayloads: any[] = [];
    const coordinator = new LocalCoreAcpSessionCoordinator({
      store,
      transport: {
        spawnSession(input: any) {
          return {
            threadId: input.threadId,
            bridgeSessionKey: input.bridgeSessionKey,
            closed: false,
            sessionId: '',
            supportsLoad: false,
            currentRunId: null,
            currentTurn: null,
            pendingPermissionByRun: new Map(),
            schedulerJobCreatedByRun: new Map(),
            launchPermissionMode: '',
          };
        },
        initializeSession: async () => {},
        request: async (_session: any, method: string) => method === 'session/new' ? { sessionId: 'session-1' } : {},
        closeSession: () => {},
        closeSessionWithError: () => {},
        sendRaw: (_session: any, payload: any) => {
          sentPayloads.push(payload);
          return true;
        },
      } as any,
      runThreadMap,
      emitBridge: () => {},
    });
    const session = await coordinator.ensureSession(thread.id, 'session:thread-1', {
      workspaceId: 'workspace-a',
      agentType: 'opencode',
      command: 'opencode',
      args: [],
      env: {},
      workDir: '/tmp/workspace-a',
      model: '',
    });

    assert.deepEqual(await coordinator.interruptRun('run-initializing'), { interrupted: false });
    assert.equal(store.getRun('run-initializing')?.status, 'interrupted');
    assert.equal(sentPayloads.some((payload) => payload.method === 'session/cancel'), false);

    store.updateRun('run-queued', thread.id, 'running');
    runThreadMap.set('run-queued', thread.id);
    session.currentRunId = 'run-active';
    assert.deepEqual(await coordinator.interruptRun('run-queued'), { interrupted: false });
    assert.equal(store.getRun('run-queued')?.status, 'interrupted');
    assert.equal(sentPayloads.some((payload) => payload.method === 'session/cancel'), false);
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('ACP backend does not start a prompt after its registered run was interrupted', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'run-interrupt-before-prompt-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const thread = store.createThread('workspace-a', 'Thread');
    const runThreadMap = new Map<string, string>();
    const backend = new LocalCoreAcpBackend({
      store,
      runThreadMap,
      emitBridge: () => {},
      eventBus: { emit: () => {}, on: () => () => {} },
      scheduler: {
        createJob: async () => { throw new Error('not used'); },
        listJobsForThread: async () => [],
        deleteJob: async () => {},
      },
    } as any);
    const session = {
      threadId: thread.id,
      bridgeSessionKey: `session:${thread.id}`,
      closed: false,
      sessionId: 'session-1',
      supportsLoad: false,
      currentRunId: null,
      currentTurn: null,
      pendingPermissionByRun: new Map(),
      schedulerJobCreatedByRun: new Map(),
      promptPromise: null,
    };
    let promptRequests = 0;
    (backend as any).sessionCoordinator.ensureSession = async () => session;
    (backend as any).transport.request = async (_session: any, method: string) => {
      if (method === 'session/prompt') promptRequests += 1;
      return {};
    };

    const sent = await backend.sendThreadMessage(thread.id, 'work', {
      workspaceId: 'workspace-a',
      agentType: 'opencode',
      command: 'opencode',
      args: [],
      env: {},
      workDir: '/tmp/workspace-a',
      model: '',
    });
    await backend.interruptRun(sent.runId);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(promptRequests, 0);
    assert.equal(store.getRun(sent.runId)?.status, 'interrupted');
    assert.equal(store.getAgentTaskByRunId(sent.runId)?.status, 'cancelled');
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('ACP backend preserves interruption when cancelled session initialization rejects', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'run-interrupt-initialization-error-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const thread = store.createThread('workspace-a', 'Thread');
    const backend = new LocalCoreAcpBackend({
      store,
      runThreadMap: new Map<string, string>(),
      emitBridge: () => {},
      eventBus: { emit: () => {}, on: () => () => {} },
      scheduler: {
        createJob: async () => { throw new Error('not used'); },
        listJobsForThread: async () => [],
        deleteJob: async () => {},
      },
    } as any);
    (backend as any).sessionCoordinator.ensureSession = async () => {
      throw new Error('session closed during initialization');
    };

    const sent = await backend.sendThreadMessage(thread.id, 'work', {
      workspaceId: 'workspace-a',
      agentType: 'opencode',
      command: 'opencode',
      args: [],
      env: {},
      workDir: '/tmp/workspace-a',
      model: '',
    });
    await backend.interruptRun(sent.runId);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(store.getRun(sent.runId)?.status, 'interrupted');
    assert.equal(store.getAgentTaskByRunId(sent.runId)?.status, 'cancelled');
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('ACP runtime PATH includes service-safe user bin directories', () => {
  const previousHome = process.env.HOME;
  process.env.HOME = '/home/agentdock-test';
  try {
    const existingPath = ['/usr/bin', '/bin'].join(delimiter);
    const path = buildAgentPath(existingPath, '/opt/agentdock/bin', { pathExists: () => false });
    const expectedEntries = process.platform === 'win32'
      ? ['/opt/agentdock/bin', '/usr/bin', '/bin']
      : ['/opt/agentdock/bin', '/home/agentdock-test/.local/bin', '/home/agentdock-test/bin', '/usr/bin', '/bin'];
    assert.equal(path, expectedEntries.join(delimiter));
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('ACP runtime PATH adds Git Bash bin when Windows PATH only has Git cmd', () => {
  const existingPath = [
    'C:\\Windows\\System32',
    'D:\\Program Files\\Git\\cmd',
  ].join(';');
  const path = buildAgentPath(existingPath, undefined, {
    platform: 'win32',
    pathExists: (candidate) => candidate === 'D:\\Program Files\\Git\\bin\\bash.exe',
  });
  assert.equal(
    path,
    [
      'D:\\Program Files\\Git\\bin',
      'C:\\Windows\\System32',
      'D:\\Program Files\\Git\\cmd',
    ].join(';'),
  );
});

test('ACP runtime reads Windows Path env regardless of key casing', () => {
  assert.equal(getPathEnv({ Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs' }), 'C:\\Windows\\System32;C:\\Program Files\\nodejs');
  assert.equal(getPathEnv({ PATH: '/usr/bin:/bin' }), '/usr/bin:/bin');
  assert.equal(getPathEnv({ Path: 'C:\\Windows\\System32', PATH: 'D:\\agentdock\\bin' }), 'D:\\agentdock\\bin');
});

test('ACP transport reports missing agent commands without an unhandled process error', async () => {
  const closed = new Promise<Error>((resolve) => {
    const transport = new LocalCoreAcpTransport({
      log: () => {},
      onAgentRequest: () => {},
      onAgentNotification: () => {},
      onSessionClosed: (_session, error) => {
        resolve(error);
      },
    });
    transport.spawnSession({
      threadId: 'thread-missing-command',
      bridgeSessionKey: 'session:missing-command',
      config: {
        workspaceId: 'workspace-a',
        agentType: 'hermes',
        command: 'agentdock-command-that-does-not-exist',
        args: ['acp'],
        env: {},
        workDir: tmpdir(),
        model: '',
      },
      runtimeEnv: {},
    });
  });

  const error = await closed;
  assert.equal(error.message, 'ACP agent command not found: agentdock-command-that-does-not-exist');
});

test('ACP transport isolates notification and request handler errors instead of crashing', () => {
  const logs: string[] = [];
  const transport = new LocalCoreAcpTransport({
    log: (message: string) => logs.push(message),
    onAgentRequest: () => {
      throw new Error('request handler boom');
    },
    onAgentNotification: () => {
      throw new Error('notification handler boom');
    },
    onSessionClosed: () => {},
  });
  const session = {
    threadId: 'thread-error-isolation',
    stdoutBuffer: '',
    pending: new Map(),
  } as any;

  // A throwing notification handler must not propagate out of the stdout
  // event (the crash class that killed the core with "database is locked").
  assert.doesNotThrow(() => {
    (transport as any).handleStdout(session, '{"method":"message","params":{}}\n');
  });
  // A throwing request handler must not propagate either.
  assert.doesNotThrow(() => {
    (transport as any).handleStdout(session, '{"method":"initialize","id":1,"params":{}}\n');
  });
  // The stream keeps being consumed after handler failures.
  assert.doesNotThrow(() => {
    (transport as any).handleStdout(session, 'garbage line\n{"method":"message","params":{}}\n');
  });
  assert.ok(logs.some((line) => line.includes('notification handler boom')));
  assert.ok(logs.some((line) => line.includes('request handler boom')));
  assert.ok(logs.some((line) => line.includes('ACP stdout parse failed')));
});

test('SQLite stores run in WAL mode with a busy timeout', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'store-pragma-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    // journal_mode is persisted in the database header, so a separate
    // connection observes the mode the store set.
    const probe = new DatabaseSync(join(userDataPath, 'runtime', 'local-core.db'));
    const mode = probe.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    assert.equal(mode.journal_mode, 'wal');
    probe.close();
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('configureSqlitePragmas sets WAL and a busy timeout on the connection', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'pragma-helper-'));
  try {
    const db = new DatabaseSync(join(userDataPath, 'pragma.db'));
    configureSqlitePragmas(db);
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    // SQLite returns the busy timeout under the column name "timeout".
    const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    assert.equal(mode.journal_mode, 'wal');
    assert.equal(timeout.timeout, 5000);
    db.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('ACP scheduled session can override permission mode without changing thread mode', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'scheduler-permission-mode-'));
  let store: LocalCoreAcpStore | null = null;
  try {
    store = new LocalCoreAcpStore(userDataPath);
    const thread = store.createThread('workspace-a', 'Thread');
    const capturedSessionNewParams: any[] = [];
    let closeCount = 0;
    const coordinator = new LocalCoreAcpSessionCoordinator({
      store,
      transport: {
        spawnSession(input: any) {
          return {
            threadId: input.threadId,
            bridgeSessionKey: input.bridgeSessionKey,
            closed: false,
            sessionId: '',
            supportsLoad: false,
            pendingPermissionByRun: new Map(),
            schedulerJobCreatedByRun: new Map(),
            launchPermissionMode: '',
          };
        },
        initializeSession: async () => {},
        request: async (_session: any, method: string, params: any) => {
          if (method === 'session/new') {
            capturedSessionNewParams.push(params);
            return { sessionId: 'session-1' };
          }
          return {};
        },
        closeSession: () => {
          closeCount += 1;
        },
        closeSessionWithError: () => {},
        sendRaw: () => true,
      } as any,
      runThreadMap: new Map(),
      emitBridge: () => {},
    });

    await coordinator.ensureSession(thread.id, 'session:thread-1', {
      workspaceId: 'workspace-a',
      agentType: 'claudecode',
      command: 'claude',
      args: [],
      env: {},
      workDir: '/tmp/workspace-a',
      model: '',
    }, { permissionMode: 'bypassPermissions' });

    assert.equal(capturedSessionNewParams[0]?._meta?.claudeCode?.options?.permissionMode, 'bypassPermissions');
    assert.equal(store.getThreadRow(thread.id)?.agent_mode, 'default');

    await coordinator.ensureSession(thread.id, 'session:thread-1', {
      workspaceId: 'workspace-a',
      agentType: 'claudecode',
      command: 'claude',
      args: [],
      env: {},
      workDir: '/tmp/workspace-a',
      model: '',
    });

    assert.equal(closeCount, 1);
    assert.deepEqual(capturedSessionNewParams[1]?._meta, {
      claudeCode: {
        emitRawSDKMessages: [
          { type: 'system', subtype: 'local_command_output' },
        ],
      },
    });
  } finally {
    store?.close();
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('ACP sandbox sessions use container workspace cwd', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'sandbox-session-cwd-'));
  let store: LocalCoreAcpStore | null = null;
  try {
    store = new LocalCoreAcpStore(userDataPath);
    const thread = store.createThread('workspace-a', 'Thread');
    let sessionNewParams: any;
    const coordinator = new LocalCoreAcpSessionCoordinator({
      store,
      transport: {
        spawnSession(input: any) {
          return {
            threadId: input.threadId,
            bridgeSessionKey: input.bridgeSessionKey,
            closed: false,
            sessionId: '',
            supportsLoad: false,
            pendingPermissionByRun: new Map(),
            schedulerJobCreatedByRun: new Map(),
            launchPermissionMode: '',
          };
        },
        initializeSession: async () => {},
        request: async (_session: any, method: string, params: any) => {
          if (method === 'session/new') {
            sessionNewParams = params;
            return { sessionId: 'session-1' };
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

    await coordinator.ensureSession(thread.id, 'session:thread-1', {
      workspaceId: 'workspace-a',
      agentType: 'pi',
      command: process.execPath,
      args: ['/host/sandbox-stdio-proxy.js'],
      env: {},
      workDir: '/host/workspace-a',
      model: '',
      sandbox: {
        enabled: true,
        provider: 'opensandbox',
        transport: 'http-ndjson',
        serverUrl: 'http://127.0.0.1:8080',
        apiKeyEnv: 'OPEN_SANDBOX_API_KEY',
        image: 'agentdock/pi-acp:local',
        acpPort: 8080,
        entrypoint: ['node', '/opt/agentdock/acp-bridge.mjs'],
        timeoutSeconds: 600,
        lifecycle: 'per_thread',
        idleSeconds: 900,
        warmPoolSize: 0,
        cpu: '1000m',
        memory: '1Gi',
        userId: 'local',
        projectId: 'workspace-a',
        stateScope: 'project',
        workspaceHostPath: '/host/workspace-a',
        workspaceMountPath: '/workspace',
        stateHostPath: '/host/state',
        stateMountPath: '/agent-state',
        runtimeCommand: '/usr/local/bin/pi-acp',
        runtimeArgs: [],
        runtimeEnv: {},
      },
    });

    assert.equal(sessionNewParams?.cwd, '/workspace');
  } finally {
    store?.close();
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('ACP permission requests honor scheduled session permission override', () => {
  const sentPayloads: any[] = [];
  let approvalCreated = false;
  let awaitingInput = false;
  const coordinator = new LocalCoreAcpTurnCoordinator({
    emitBridge: () => {},
    appendMessage: () => {},
    updateRunStatus: () => {
      awaitingInput = true;
    },
    createApprovalRequest: () => {
      approvalCreated = true;
      return 'approval-1';
    },
    getThreadAgentMode: () => 'default',
    sendRaw: (_session, payload) => {
      sentPayloads.push(payload);
      return true;
    },
  });

  coordinator.handleAgentRequest({
    threadId: 'thread-1',
    bridgeSessionKey: 'bridge-1',
    currentRunId: 'run-1',
    currentTurn: null,
    pendingPermissionByRun: new Map(),
    schedulerJobCreatedByRun: new Map(),
    launchPermissionMode: 'bypassPermissions',
  } as any, {
    jsonrpc: '2.0',
    id: 42,
    method: 'session/request_permission',
    params: {
      toolCall: { title: 'Write AI早报/AI早报-2026-05-08.md' },
      options: [
        { optionId: 'deny', name: 'Deny', kind: 'deny' },
        { optionId: 'allow', name: 'Allow', kind: 'allow' },
      ],
    },
  });

  assert.equal(approvalCreated, false);
  assert.equal(awaitingInput, false);
  assert.deepEqual(sentPayloads[0], {
    jsonrpc: '2.0',
    id: 42,
    result: {
      outcome: {
        outcome: 'selected',
        optionId: 'allow',
      },
    },
  });
});

test('scheduler uses short ids for new jobs and resolves legacy full ids by short id', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'scheduler-id-store-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const scheduler = new SchedulerService({
      store,
      triggers: [],
      executors: [],
      eventBus: { emit: () => {}, on: () => () => {} },
    });
    const created = scheduler.createJob({
      workspaceId: 'workspace-a',
      platform: 'local',
      route: { type: 'local.thread', channelId: 'workspace-a', threadId: 'thread-1' },
      executionMode: 'side-thread',
      triggerType: 'cron',
      cronExpr: '30 18 * * *',
      promptTemplate: 'ping',
      description: 'daily ping',
      enabled: true,
    });

    assert.match(created.id, /^[0-9a-f]{8}$/);

    const legacy = store.createScheduledJob({
      workspaceId: 'workspace-a',
      platform: 'local',
      route: { type: 'local.thread', channelId: 'workspace-a', threadId: 'thread-1' },
      executionMode: 'side-thread',
      triggerType: 'cron',
      cronExpr: '0 9 * * *',
      promptTemplate: 'legacy',
      description: 'legacy job',
      enabled: true,
    });
    (store as any).db.prepare('UPDATE scheduled_jobs SET id = ? WHERE id = ?').run(
      'job:826aff79-570b-4308-822e-18318e2c96ba',
      legacy.id,
    );

    assert.equal(scheduler.getJob('826aff79')?.id, 'job:826aff79-570b-4308-822e-18318e2c96ba');
    scheduler.updateJob('826aff79', { description: 'updated legacy job' });
    assert.equal(scheduler.getJob('826aff79')?.description, 'updated legacy job');
    scheduler.deleteJob('826aff79');
    assert.equal(scheduler.getJob('826aff79'), undefined);
    assert.throws(() => scheduler.deleteJob('826aff79'), /Scheduled job not found: 826aff79/);
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('scheduler dispatches due jobs without waiting for long-running jobs', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'scheduler-dispatch-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    store.createScheduledJob({
      workspaceId: 'workspace-a',
      platform: 'local',
      route: { type: 'local.thread', channelId: 'workspace-a', threadId: 'thread-1' },
      executionMode: 'side-thread',
      triggerType: 'cron',
      cronExpr: '* * * * *',
      promptTemplate: 'slow',
      description: 'slow job',
      enabled: true,
    });
    store.createScheduledJob({
      workspaceId: 'workspace-a',
      platform: 'local',
      route: { type: 'local.thread', channelId: 'workspace-a', threadId: 'thread-2' },
      executionMode: 'side-thread',
      triggerType: 'cron',
      cronExpr: '* * * * *',
      promptTemplate: 'fast',
      description: 'fast job',
      enabled: true,
    });
    let releaseSlow!: () => void;
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const started: string[] = [];
    let slowJobId = '';
    const scheduler = new SchedulerService({
      store,
      triggers: [{
        triggerTypes: ['cron'],
        supports: () => true,
        isDue: () => true,
      }],
      executors: [{
        deliveryTargets: ['local'],
        supports: () => true,
        execute: async ({ job }) => {
          const isFirstStartedJob = started.length === 0;
          started.push(job.id);
          if (isFirstStartedJob) {
            slowJobId = job.id;
            await slowDone;
          }
          return {
            threadId: String(job.route.threadId || job.id),
            runId: `run:${job.id}`,
          };
        },
      }],
      eventBus: { emit: () => {}, on: () => () => {} },
    });

    await (scheduler as any).tick();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(started.length, 2);
    const fastJobId = started.find((id) => id !== slowJobId)!;
    assert.equal(store.listScheduledJobRuns(slowJobId)[0]?.status, 'running');
    assert.equal(store.listScheduledJobRuns(fastJobId)[0]?.status, 'succeeded');

    releaseSlow();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.listScheduledJobRuns(slowJobId)[0]?.status, 'succeeded');
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('scheduler ignores malformed enabled legacy cron jobs during startup and ticks', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'scheduler-malformed-cron-'));
  const runtime = bootstrapLocalCoreRuntime({ userDataPath, log: () => {} });
  try {
    const job = runtime.store.createScheduledJob({
      workspaceId: 'workspace-a',
      platform: 'local',
      route: { type: 'local.thread', channelId: 'workspace-a', threadId: 'thread-1' },
      executionMode: 'side-thread',
      triggerType: 'cron',
      cronExpr: '* * * * *',
      promptTemplate: 'legacy',
      description: 'malformed legacy job',
      enabled: true,
    });
    (runtime.store as any).db.prepare('UPDATE scheduled_jobs SET cron_expr = ? WHERE id = ?').run(
      '*/0 * * * *',
      job.id,
    );

    await runtime.scheduler.start();
    await (runtime.scheduler as any).tick();
    assert.equal(runtime.store.listScheduledJobRuns(job.id).length, 0);
  } finally {
    await runtime.stop();
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('scheduler auto-disables a job after 5 consecutive failures', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'scheduler-autodisable-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const created = store.createScheduledJob({
      workspaceId: 'workspace-a',
      platform: 'local',
      route: { type: 'local.thread', channelId: 'workspace-a', threadId: 'thread-1' },
      executionMode: 'side-thread',
      triggerType: 'cron',
      cronExpr: '* * * * *',
      promptTemplate: 'broken',
      description: 'always-failing job',
      enabled: true,
    });

    const logs: string[] = [];
    const jobUpdates: { enabled: boolean }[] = [];
    const scheduler = new SchedulerService({
      store,
      triggers: [{
        triggerTypes: ['cron'],
        supports: () => true,
        isDue: () => true,
      }],
      executors: [{
        deliveryTargets: ['local'],
        supports: () => true,
        execute: async () => {
          throw new Error("The 'gpt-5.3-codex' model is not supported");
        },
      }],
      eventBus: {
        emit: (event: any) => {
          if (event?.type === 'scheduler.job.updated') {
            jobUpdates.push({ enabled: event.payload.enabled });
          }
        },
        on: () => () => {},
      },
      log: (message) => logs.push(message),
    });

    for (let i = 0; i < 5; i += 1) {
      await scheduler.runJobNow(created.id);
    }

    const jobAfter = store.getScheduledJob(created.id);
    assert.equal(jobAfter?.enabled, false);
    assert.ok(
      logs.some((msg) => msg.includes('auto-disabled') && msg.includes('5 consecutive failures')),
      `expected auto-disable log, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(jobUpdates.some((update) => update.enabled === false));

    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('scheduled jobs normalize enum-like input before persistence', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'scheduler-enum-store-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const created = store.createScheduledJob({
      workspaceId: 'workspace-a',
      platform: ' Lark ',
      route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1' },
      executionMode: 'side_thread',
      triggerType: 'CRON',
      cronExpr: '30 18 * * *',
      promptTemplate: 'ping',
      description: 'daily ping',
      enabled: true,
    });

    assert.equal(created.platform, 'lark');
    assert.equal(created.executionMode, 'side-thread');
    assert.equal(created.triggerType, 'cron');

    const updated = store.updateScheduledJob(created.id, {
      executionMode: 'same_thread',
      triggerType: 'one time',
      runAt: '2026-05-04T10:00:00.000Z',
      cronExpr: '',
    });

    assert.equal(updated.executionMode, 'same-thread');
    assert.equal(updated.triggerType, 'once');
    assert.equal(updated.runAt, '2026-05-04T10:00:00.000Z');
    assert.equal(updated.cronExpr, undefined);
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('agent tasks persist, update status, and can be found by run id', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agent-task-store-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const task = store.createAgentTask({
      workspaceId: 'workspace-a',
      deviceId: 'local',
      runtimeId: 'opencode',
      threadId: 'thread-1',
      runId: 'run-1',
      title: 'Implement feature',
      prompt: 'Please implement feature',
      status: 'running',
    });

    const updated = store.updateAgentTask(task.taskId, {
      status: 'completed',
      summary: 'done',
      log: { level: 'info', message: 'finished' },
    });

    assert.equal(updated.status, 'completed');
    assert.equal(updated.summary, 'done');
    assert.equal(updated.logs[0]?.message, 'finished');
    assert.equal(store.getAgentTaskByRunId('run-1')?.taskId, task.taskId);
    assert.equal(store.listAgentTasks({ status: 'completed' }).tasks.length, 1);
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('agent task and run statuses normalize before persistence', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'task-run-status-store-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const task = store.createAgentTask({
      workspaceId: 'workspace-a',
      deviceId: 'device-a',
      runtimeId: 'runtime-a',
      title: 'Normalize states',
      status: 'waiting for user' as any,
    });

    assert.equal(task.status, 'waiting_for_user');
    assert.equal(store.listAgentTasks({ status: 'waiting for user' as any }).tasks.length, 1);

    const updated = store.updateAgentTask(task.taskId, { status: 'canceled' as any });
    assert.equal(updated.status, 'cancelled');
    assert.equal(updated.timeline.at(-1)?.status, 'cancelled');

    const thread = store.createThread('workspace-a', 'Thread');
    store.updateRun('run-1', thread.id, 'awaiting input' as any);
    assert.equal(store.getRun('run-1')?.status, 'awaiting_input');
    store.updateRun('run-1', thread.id, 'canceled' as any);
    assert.equal(store.getRun('run-1')?.status, 'interrupted');

    const job = store.createScheduledJob({
      workspaceId: 'workspace-a',
      platform: 'local',
      route: { type: 'local.thread', channelId: 'workspace-a', threadId: 'thread-1' },
      executionMode: 'same-thread',
      triggerType: 'cron',
      cronExpr: '0 9 * * *',
      promptTemplate: 'ping',
      description: 'daily ping',
      enabled: true,
    });
    const run = store.createScheduledJobRun(job.id, 'complete' as any, {
      deliveryMode: 'bridge-stream',
      deliveryStatus: 'streaming',
      platformMessageIds: ['msg-1', 'msg-2'],
      lastBridgeEventAt: '2026-04-22T06:00:03.000Z',
    });
    assert.equal(run.status, 'succeeded');
    assert.equal(run.deliveryMode, 'bridge-stream');
    assert.equal(run.deliveryStatus, 'streaming');
    assert.deepEqual(run.platformMessageIds, ['msg-1', 'msg-2']);
    assert.equal(run.lastBridgeEventAt, '2026-04-22T06:00:03.000Z');
    const skipped = store.updateScheduledJobRun(run.id, { status: 'cancelled' as any });
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.deliveryMode, 'bridge-stream');
    assert.deepEqual(skipped.platformMessageIds, ['msg-1', 'msg-2']);
    assert.equal(store.getScheduledJob(job.id)?.lastStatus, 'skipped');
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('listWorkspaceRegistry batches active task counts and recent task ids across workspaces', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'registry-list-batch-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    store.upsertWorkspaceRegistryEntry({
      workspaceId: 'ws-a',
      displayName: 'Workspace A',
      path: '/tmp/ws-a',
      deviceId: 'local',
      defaultRuntimeId: 'opencode',
      health: { status: 'healthy', summary: 'ok', issues: [] },
      git: { isRepo: false },
    });
    store.upsertWorkspaceRegistryEntry({
      workspaceId: 'ws-b',
      displayName: 'Workspace B',
      path: '/tmp/ws-b',
      deviceId: 'local',
      defaultRuntimeId: 'opencode',
      health: { status: 'healthy', summary: 'ok', issues: [] },
      git: { isRepo: false },
    });
    store.upsertWorkspaceRegistryEntry({
      workspaceId: 'ws-c',
      displayName: 'Workspace C',
      path: '/tmp/ws-c',
      deviceId: 'local',
      defaultRuntimeId: 'opencode',
      health: { status: 'healthy', summary: 'ok', issues: [] },
      git: { isRepo: false },
    });

    for (let i = 0; i < 10; i++) {
      store.createAgentTask({
        workspaceId: 'ws-a',
        deviceId: 'local',
        runtimeId: 'opencode',
        title: `A task ${i}`,
        status: i % 2 === 0 ? 'running' : 'completed',
      });
    }
    store.createAgentTask({
      workspaceId: 'ws-b',
      deviceId: 'local',
      runtimeId: 'opencode',
      title: 'B active task',
      status: 'queued',
    });

    const entries = store.listWorkspaceRegistry();
    const a = entries.find((entry) => entry.workspaceId === 'ws-a');
    const b = entries.find((entry) => entry.workspaceId === 'ws-b');
    const c = entries.find((entry) => entry.workspaceId === 'ws-c');
    assert.ok(a);
    assert.ok(b);
    assert.ok(c);
    // 5 of 10 ws-a tasks are running (even indexes) — only active statuses count.
    assert.equal(a!.activeTaskCount, 5);
    assert.equal(a!.recentTaskIds.length, 8);
    assert.equal(b!.activeTaskCount, 1);
    assert.equal(b!.recentTaskIds.length, 1);
    // Workspace C has zero tasks — list and get paths agree on defaults.
    assert.equal(c!.activeTaskCount, 0);
    assert.deepEqual(c!.recentTaskIds, []);

    const single = store.getWorkspaceRegistryEntry('ws-a');
    assert.ok(single);
    assert.equal(single!.activeTaskCount, 5);
    assert.equal(single!.recentTaskIds.length, 8);

    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('WorkspaceRouter retrieves artifact content with security boundary checks', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'artifact-content-test-'));
  const workspacePath = mkdtempSync(join(tmpdir(), 'workspace-artifact-test-'));
  try {
    const runtime = bootstrapLocalCoreRuntime({ userDataPath, log: () => {} });
    const controller = new LocalCoreController(userDataPath, runtime);

    const workspaceId = 'ws-artifact-test';
    controller.store.upsertWorkspaceRegistryEntry({
      workspaceId,
      displayName: 'Artifact Test Workspace',
      path: workspacePath,
      deviceId: 'local',
      defaultRuntimeId: 'pi',
      health: { status: 'healthy', summary: 'ok', issues: [] },
      git: { isRepo: false },
    });

    // Create artifact files inside workspace
    const artifactsDir = join(workspacePath, '.agentdock', 'artifacts', 'run-test-123');
    mkdirSync(artifactsDir, { recursive: true });

    const htmlFile = join(artifactsDir, 'architecture.html');
    const mdFile = join(artifactsDir, 'report.md');
    writeFileSync(htmlFile, '<html><body><h1>Architecture</h1></body></html>', 'utf8');
    writeFileSync(mdFile, '# System Report\n\nAll systems nominal.', 'utf8');

    // Create task with artifacts
    const task = controller.workspaceRouter.createAgentTask({
      workspaceId,
      runtimeId: 'pi',
      title: 'Generate architecture diagram',
    });

    const updatedTask = controller.workspaceRouter.updateAgentTask(task.taskId, {
      artifact: {
        title: 'Architecture Diagram',
        kind: 'html',
        path: '.agentdock/artifacts/run-test-123/architecture.html',
      },
    });

    const secondTask = controller.workspaceRouter.updateAgentTask(task.taskId, {
      artifact: {
        title: 'Markdown Report',
        kind: 'markdown',
        path: '.agentdock/artifacts/run-test-123/report.md',
      },
    });

    const htmlArtifact = secondTask.artifacts.find((a) => a.title === 'Architecture Diagram')!;
    const mdArtifact = secondTask.artifacts.find((a) => a.title === 'Markdown Report')!;

    // Test successful retrieval
    const htmlContent = await controller.workspaceRouter.getAgentTaskArtifactContent(task.taskId, htmlArtifact.id);
    assert.equal(htmlContent.kind, 'html');
    assert.equal(htmlContent.mimeType, 'text/html');
    assert.equal(htmlContent.isBinary, false);
    assert.equal(htmlContent.content, '<html><body><h1>Architecture</h1></body></html>');

    const mdContent = await controller.workspaceRouter.getAgentTaskArtifactContent(task.taskId, mdArtifact.id);
    assert.equal(mdContent.kind, 'markdown');
    assert.equal(mdContent.mimeType, 'text/markdown');
    assert.equal(mdContent.isBinary, false);
    assert.equal(mdContent.content, '# System Report\n\nAll systems nominal.');

    // Test path traversal security check
    const outsideFile = join(tmpdir(), 'outside-secret.txt');
    writeFileSync(outsideFile, 'secret content', 'utf8');

    const evilTask = controller.workspaceRouter.updateAgentTask(task.taskId, {
      artifact: {
        title: 'Evil Traversal',
        kind: 'file',
        path: '../../../../../../../../../../../../../../../../tmp/outside-secret.txt',
      },
    });
    const evilArtifact = evilTask.artifacts.find((a) => a.title === 'Evil Traversal')!;

    await assert.rejects(
      async () => controller.workspaceRouter.getAgentTaskArtifactContent(task.taskId, evilArtifact.id),
      /outside the allowed artifacts directory/,
    );

    await controller.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('WorkspaceRouter restricts artifact reads to the run artifacts directory', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'artifact-scope-test-'));
  const workspacePath = mkdtempSync(join(tmpdir(), 'artifact-scope-ws-'));
  const secretPath = join(tmpdir(), `artifact-scope-secret-${process.pid}.txt`);
  try {
    const runtime = bootstrapLocalCoreRuntime({ userDataPath, log: () => {} });
    const controller = new LocalCoreController(userDataPath, runtime);

    const workspaceId = 'ws-artifact-scope';
    controller.store.upsertWorkspaceRegistryEntry({
      workspaceId,
      displayName: 'Artifact Scope Workspace',
      path: workspacePath,
      deviceId: 'local',
      defaultRuntimeId: 'pi',
      health: { status: 'healthy', summary: 'ok', issues: [] },
      git: { isRepo: false },
    });

    const runDir = join(workspacePath, '.agentdock', 'artifacts', 'run-scope-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'report.html'), '<html><body>ok</body></html>', 'utf8');
    writeFileSync(secretPath, 'secret content', 'utf8');
    symlinkSync(secretPath, join(runDir, 'escape.html'));
    writeFileSync(join(workspacePath, 'notes.txt'), 'internal notes', 'utf8');

    const task = controller.workspaceRouter.createAgentTask({
      workspaceId,
      runtimeId: 'pi',
      title: 'Artifact scope test',
    });
    const addArtifact = (title: string, path: string) => {
      const updated = controller.workspaceRouter.updateAgentTask(task.taskId, {
        artifact: { title, kind: 'file', path },
      });
      return updated.artifacts.find((a) => a.title === title)!;
    };

    const readable = addArtifact('Readable', '.agentdock/artifacts/run-scope-1/report.html');
    const readableContent = await controller.workspaceRouter.getAgentTaskArtifactContent(task.taskId, readable.id);
    assert.equal(readableContent.content, '<html><body>ok</body></html>');

    const symlinkEscape = addArtifact('Escape', '.agentdock/artifacts/run-scope-1/escape.html');
    await assert.rejects(
      async () => controller.workspaceRouter.getAgentTaskArtifactContent(task.taskId, symlinkEscape.id),
      (error: Error) => {
        assert.match(error.message, /outside the allowed artifacts directory/);
        assert.doesNotMatch(error.message, /escape\.html|run-scope-1/);
        return true;
      },
    );

    const workspaceFile = addArtifact('Notes', 'notes.txt');
    await assert.rejects(
      async () => controller.workspaceRouter.getAgentTaskArtifactContent(task.taskId, workspaceFile.id),
      /outside the allowed artifacts directory/,
    );

    writeFileSync(join(runDir, 'huge.bin'), Buffer.alloc(10 * 1024 * 1024 + 1, 97));
    const oversize = addArtifact('Oversize', '.agentdock/artifacts/run-scope-1/huge.bin');
    await assert.rejects(
      async () => controller.workspaceRouter.getAgentTaskArtifactContent(task.taskId, oversize.id),
      /exceeds the maximum supported artifact size/,
    );

    const missing = addArtifact('Missing', '.agentdock/artifacts/run-scope-1/gone.html');
    await assert.rejects(
      async () => controller.workspaceRouter.getAgentTaskArtifactContent(task.taskId, missing.id),
      /Artifact file not found/,
    );

    await controller.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(secretPath, { force: true });
  }
});

test('LocalCoreAcpBackend automatically scans and registers artifacts on run completion', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'acp-artifact-auto-test-'));
  const workspacePath = mkdtempSync(join(tmpdir(), 'acp-workspace-artifact-test-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const workspaceId = 'ws-acp-artifact';
    store.upsertWorkspaceRegistryEntry({
      workspaceId,
      displayName: 'ACP Artifact Workspace',
      path: workspacePath,
      deviceId: 'local',
      defaultRuntimeId: 'pi',
      health: { status: 'healthy', summary: 'ok', issues: [] },
      git: { isRepo: false },
    });

    const thread = store.createThread(workspaceId, 'Test Thread', 'pi');
    const runId = 'run:acp-auto-test:123';
    const task = store.createAgentTask({
      workspaceId,
      deviceId: 'local',
      runtimeId: 'pi',
      threadId: thread.id,
      runId,
      title: 'Generate architecture chart',
      status: 'running',
    });

    // Simulate agent writing artifacts to .agentdock/artifacts/<runId>/
    const artifactsDir = join(workspacePath, '.agentdock', 'artifacts', runId);
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, 'system-architecture.html'), '<html><body>Diagram</body></html>');
    writeFileSync(join(artifactsDir, 'diff-changes.diff'), '+ added line\n- removed line');

    // Trigger discovery via registerDiscoveredArtifacts (simulate backend run completion)
    const backend = new LocalCoreAcpBackend({
      store,
      runThreadMap: new Map([[runId, thread.id]]),
      emitBridge: () => {},
      eventBus: { emit: () => {} } as any,
      scheduler: {} as any,
    });

    (backend as any).registerDiscoveredArtifacts(task.taskId, workspacePath, runId);

    const reloadedTask = store.getAgentTask(task.taskId)!;
    assert.equal(reloadedTask.artifacts.length, 2);

    const htmlArtifact = reloadedTask.artifacts.find((a) => a.title === 'system-architecture.html');
    assert.ok(htmlArtifact);
    assert.equal(htmlArtifact.kind, 'html');
    assert.equal(htmlArtifact.metadata?.mimeType, 'text/html');

    const diffArtifact = reloadedTask.artifacts.find((a) => a.title === 'diff-changes.diff');
    assert.ok(diffArtifact);
    assert.equal(diffArtifact.kind, 'diff');
    assert.equal(diffArtifact.metadata?.mimeType, 'text/x-diff');

    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});


