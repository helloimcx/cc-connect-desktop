import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../../services/local-ai-core/src/cli/lac.js';

function createIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        },
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function withFetchMock(mock: FetchMock): { restore: () => void } {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock as typeof globalThis.fetch;
  return { restore: () => { globalThis.fetch = originalFetch; } };
}

test('lac scheduler add posts thread context and lets local core resolve platform binding', async () => {
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (input, init) => {
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'job:826aff79-570b-4308-822e-18318e2c96ba',
        workspaceId: '知识库',
        platform: 'lark',
        route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1', threadId: 'thread-1' },
        executionMode: 'same-thread',
        triggerType: 'cron',
        cronExpr: '*/2 * * * *',
        promptTemplate: 'ping',
        description: 'two-minute ping',
        enabled: true,
        concurrencyPolicy: 'skip_if_running',
        createdAt: '2026-04-22T06:00:00.000Z',
        updatedAt: '2026-04-22T06:00:00.000Z',
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['scheduler', 'add', '--cron', '*/2 * * * *', '--message', 'ping', '--desc', 'two-minute ping'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: '知识库',
        LOCAL_AI_THREAD_ID: 'thread-1',
        LOCAL_AI_PLATFORM: 'lark',
        LOCAL_AI_CHAT_ID: 'chat-1',
        LOCAL_AI_PLATFORM_USER_ID: 'user-1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert(capturedBody);
    assert.deepEqual(JSON.parse(capturedBody), {
      workspaceId: '知识库',
      threadId: 'thread-1',
      executionMode: 'same-thread',
      triggerType: 'cron',
      cronExpr: '*/2 * * * *',
      promptTemplate: 'ping',
      description: 'two-minute ping',
      enabled: true,
    });
    assert.match(read().stdout, /Created scheduler job 826aff79/);
  } finally {
    restore();
  }
});

test('lac scheduler add posts a local job without IM context', async () => {
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (input, init) => {
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'job-local-1',
        workspaceId: '知识库',
        platform: 'local',
        route: { type: 'local.thread', channelId: '知识库' },
        executionMode: 'same-thread',
        triggerType: 'cron',
        cronExpr: '*/5 * * * *',
        promptTemplate: 'ping local',
        description: 'local ping',
        enabled: true,
        concurrencyPolicy: 'skip_if_running',
        createdAt: '2026-04-22T06:00:00.000Z',
        updatedAt: '2026-04-22T06:00:00.000Z',
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['scheduler', 'add', '--cron', '*/5 * * * *', '--message', 'ping local', '--desc', 'local ping'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: '知识库',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert(capturedBody);
    assert.deepEqual(JSON.parse(capturedBody), {
      workspaceId: '知识库',
      executionMode: 'same-thread',
      triggerType: 'cron',
      cronExpr: '*/5 * * * *',
      promptTemplate: 'ping local',
      description: 'local ping',
      enabled: true,
    });
    assert.match(read().stdout, /Created scheduler job job-local-1/);
  } finally {
    restore();
  }
});

test('lac channel send-file posts a workspace-relative file through outbound message parts', async () => {
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (input, init) => {
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        platform: 'lark',
        workspaceId: '知识库',
        channelId: 'chat-1',
        messageIds: ['msg-file-1'],
        attachments: [{
          kind: 'file',
          attachmentId: 'file-key-1',
          fileName: 'out.pdf',
          fileSize: 123,
          metadata: { fileKey: 'file-key-1' },
        }],
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['channel', 'send-file', '--path', 'reports/out.pdf', '--name', 'out.pdf'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: '知识库',
        LOCAL_AI_WORKSPACE_PATH: '/workspace/project',
        LOCAL_AI_PLATFORM: 'lark',
        LOCAL_AI_CHAT_ID: 'chat-1',
        LOCAL_AI_PLATFORM_USER_ID: 'user-1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert(capturedBody);
    assert.deepEqual(JSON.parse(capturedBody), {
      route: {
        type: 'channel.chat',
        channelId: 'chat-1',
        participantId: 'user-1',
      },
      parts: [{
        type: 'file',
        path: 'reports/out.pdf',
        fileName: 'out.pdf',
        metadata: {
          workspacePath: '/workspace/project',
        },
      }],
    });
    assert.match(read().stdout, /Sent file out\.pdf to chat-1: msg-file-1/);
  } finally {
    restore();
  }
});

test('lac channel send-file normalizes instance-qualified platform env into route instance', async () => {
  let capturedUrl = '';
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (input, init) => {
    capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        platform: 'lark',
        workspaceId: '知识库',
        channelId: 'chat-1',
        messageIds: ['msg-file-1'],
        attachments: [{ kind: 'file', fileName: 'out.pdf', fileSize: 123 }],
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io } = createIo();
    const exitCode = await runCli(
      ['channel', 'send-file', '--path', 'reports/out.pdf'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: '知识库',
        LOCAL_AI_WORKSPACE_PATH: '/workspace/project',
        LOCAL_AI_PLATFORM: 'lark:lark-1',
        LOCAL_AI_CHAT_ID: 'chat-1',
        LOCAL_AI_PLATFORM_USER_ID: 'user-1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert.match(capturedUrl, /\/platforms\/lark\/%E7%9F%A5%E8%AF%86%E5%BA%93\/messages/);
    assert(capturedBody);
    assert.deepEqual(JSON.parse(capturedBody).route, {
      type: 'channel.chat',
      channelId: 'chat-1',
      instanceId: 'lark-1',
      participantId: 'user-1',
    });
  } finally {
    restore();
  }
});

test('lac channel send-file posts allowed absolute paths through the same outbound message path', async () => {
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (input, init) => {
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        platform: 'lark',
        workspaceId: '知识库',
        channelId: 'chat-1',
        messageIds: ['msg-file-2'],
        attachments: [{
          kind: 'file',
          attachmentId: 'file-key-2',
          fileName: 'absolute.pdf',
          fileSize: 456,
          metadata: { fileKey: 'file-key-2' },
        }],
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['channel', 'send-file', '--path', '/tmp/absolute.pdf'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: '知识库',
        LOCAL_AI_WORKSPACE_PATH: '/workspace/project',
        LOCAL_AI_PLATFORM: 'lark',
        LOCAL_AI_CHAT_ID: 'chat-1',
        LOCAL_AI_PLATFORM_USER_ID: 'user-1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert(capturedBody);
    assert.deepEqual(JSON.parse(capturedBody), {
      route: {
        type: 'channel.chat',
        channelId: 'chat-1',
        participantId: 'user-1',
      },
      parts: [{
        type: 'file',
        path: '/tmp/absolute.pdf',
        metadata: {
          workspacePath: '/workspace/project',
        },
      }],
    });
    assert.match(read().stdout, /Sent file absolute\.pdf to chat-1: msg-file-2/);
  } finally {
    restore();
  }
});

test('lac monitor add posts thread context and stock source config', async () => {
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (input, init) => {
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'monitor:826aff79-570b-4308-822e-18318e2c96ba',
        workspaceId: '知识库',
        title: 'AAPL swing',
        sourceType: 'stock.quote',
        sourceConfig: { symbol: 'AAPL', price: 188.5 },
        condition: { metric: 'abs_change_percent', operator: '>=', value: 3 },
        promptTemplate: 'analyze AAPL',
        platform: 'lark',
        route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1' },
        executionMode: 'side-thread',
        enabled: true,
        cooldownMs: 900000,
        concurrencyPolicy: 'skip_if_running',
        createdAt: '2026-04-22T06:00:00.000Z',
        updatedAt: '2026-04-22T06:00:00.000Z',
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      [
        'monitor',
        'add',
        '--title',
        'AAPL swing',
        '--source',
        'stock.quote',
        '--symbol',
        'aapl',
        '--price',
        '188.5',
        '--condition',
        'abs_change_percent >= 3',
        '--message',
        'analyze AAPL',
      ],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: '知识库',
        LOCAL_AI_THREAD_ID: 'thread-1',
        LOCAL_AI_PLATFORM: 'lark',
        LOCAL_AI_CHAT_ID: 'chat-1',
        LOCAL_AI_PLATFORM_USER_ID: 'user-1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert(capturedBody);
    assert.deepEqual(JSON.parse(capturedBody), {
      workspaceId: '知识库',
      threadId: 'thread-1',
      title: 'AAPL swing',
      sourceType: 'stock.quote',
      sourceConfig: { symbol: 'AAPL', price: 188.5 },
      condition: { metric: 'abs_change_percent', operator: '>=', value: 3 },
      promptTemplate: 'analyze AAPL',
      executionMode: 'side-thread',
      cooldownMs: 900000,
      enabled: true,
    });
    assert.match(read().stdout, /Created monitor 826aff79/);
  } finally {
    restore();
  }
});

test('lac monitor list filters by current thread context', async () => {
  const { restore } = withFetchMock(async () => {
    return new Response(JSON.stringify({
      ok: true,
      data: {
        monitors: [
          {
            id: 'monitor-1',
            workspaceId: '知识库',
            title: 'current',
            sourceType: 'stock.quote',
            sourceConfig: { symbol: 'AAPL' },
            condition: { metric: 'abs_change_percent', operator: '>=', value: 3 },
            promptTemplate: 'ping',
            platform: 'lark',
            route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1' },
            executionMode: 'side-thread',
            enabled: true,
            cooldownMs: 900000,
            concurrencyPolicy: 'skip_if_running',
            createdAt: '2026-04-22T06:00:00.000Z',
            updatedAt: '2026-04-22T06:00:00.000Z',
          },
          {
            id: 'monitor-2',
            workspaceId: '知识库',
            title: 'other',
            sourceType: 'stock.quote',
            sourceConfig: { symbol: 'MSFT' },
            condition: { metric: 'abs_change_percent', operator: '>=', value: 3 },
            promptTemplate: 'pong',
            platform: 'lark',
            route: { type: 'channel.chat', channelId: 'chat-2', participantId: 'user-2' },
            executionMode: 'side-thread',
            enabled: true,
            cooldownMs: 900000,
            concurrencyPolicy: 'skip_if_running',
            createdAt: '2026-04-22T06:00:00.000Z',
            updatedAt: '2026-04-22T06:00:00.000Z',
          },
        ],
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['monitor', 'list', '--thread'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: '知识库',
        LOCAL_AI_THREAD_ID: 'thread-1',
        LOCAL_AI_PLATFORM: 'lark',
        LOCAL_AI_CHAT_ID: 'chat-1',
        LOCAL_AI_PLATFORM_USER_ID: 'user-1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert.match(read().stdout, /monitor-1/);
    assert.doesNotMatch(read().stdout, /monitor-2/);
  } finally {
    restore();
  }
});

test('lac scheduler list shows workspace jobs by default', async () => {
  const { restore } = withFetchMock(async () => {
    return new Response(JSON.stringify({
      ok: true,
      data: {
        jobs: [
          {
            id: 'job:826aff79-570b-4308-822e-18318e2c96ba',
            workspaceId: '知识库',
            platform: 'lark',
            route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1', threadId: 'thread-1' },
            executionMode: 'same-thread',
            triggerType: 'cron',
            cronExpr: '*/2 * * * *',
            promptTemplate: 'ping',
            description: 'current',
            enabled: true,
            concurrencyPolicy: 'skip_if_running',
            createdAt: '2026-04-22T06:00:00.000Z',
            updatedAt: '2026-04-22T06:00:00.000Z',
          },
          {
            id: 'job-2',
            workspaceId: '知识库',
            platform: 'lark',
            route: { type: 'channel.chat', channelId: 'chat-2', participantId: 'user-2', threadId: 'thread-2' },
            executionMode: 'side-thread',
            triggerType: 'cron',
            cronExpr: '0 9 * * *',
            promptTemplate: 'pong',
            description: 'other',
            enabled: true,
            concurrencyPolicy: 'skip_if_running',
            createdAt: '2026-04-22T06:00:00.000Z',
            updatedAt: '2026-04-22T06:00:00.000Z',
          },
        ],
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['scheduler', 'list'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: '知识库',
        LOCAL_AI_THREAD_ID: 'thread-1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert.match(read().stdout, /826aff79/);
    assert.doesNotMatch(read().stdout, /job:826aff79/);
    assert.match(read().stdout, /job-2/);
  } finally {
    restore();
  }
});

test('lac scheduler info prints the short job id', async () => {
  let requestCount = 0;
  const { restore } = withFetchMock(async (input) => {
    requestCount++;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    if (url.includes('/runs')) {
      return new Response(JSON.stringify({ ok: true, data: { runs: [] } }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'job:826aff79-570b-4308-822e-18318e2c96ba',
        workspaceId: '知识库',
        platform: 'lark',
        route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1', threadId: 'thread-1' },
        executionMode: 'side-thread',
        triggerType: 'cron',
        cronExpr: '30 18 * * *',
        promptTemplate: 'ping',
        description: 'daily ping',
        enabled: true,
        concurrencyPolicy: 'skip_if_running',
        createdAt: '2026-04-22T06:00:00.000Z',
        updatedAt: '2026-04-22T06:00:00.000Z',
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['scheduler', 'info', '826aff79'],
      { LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1' },
      io,
    );
    assert.equal(exitCode, 0);
    assert.match(read().stdout, /Job: 826aff79/);
    assert.doesNotMatch(read().stdout, /job:826aff79/);
  } finally {
    restore();
  }
});

test('lac scheduler edit patches a short job id and normalizes execution mode', async () => {
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (input, init) => {
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'job:826aff79-570b-4308-822e-18318e2c96ba',
        workspaceId: '知识库',
        platform: 'lark',
        route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1', threadId: 'thread-1' },
        executionMode: 'side-thread',
        triggerType: 'cron',
        cronExpr: '0 10 * * *',
        promptTemplate: 'updated ping',
        description: 'daily updated ping',
        enabled: false,
        concurrencyPolicy: 'skip_if_running',
        createdAt: '2026-04-22T06:00:00.000Z',
        updatedAt: '2026-04-22T07:00:00.000Z',
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      [
        'scheduler',
        'edit',
        '826aff79',
        '--cron',
        '0 10 * * *',
        '--message',
        'updated ping',
        '--desc',
        'daily updated ping',
        '--enabled',
        'false',
        '--execution-mode',
        'side_thread',
      ],
      { LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1' },
      io,
    );
    assert.equal(exitCode, 0);
    assert(capturedBody);
    assert.deepEqual(JSON.parse(capturedBody), {
      cronExpr: '0 10 * * *',
      promptTemplate: 'updated ping',
      description: 'daily updated ping',
      enabled: false,
      executionMode: 'side-thread',
    });
    assert.match(read().stdout, /Updated scheduler job 826aff79/);
    assert.doesNotMatch(read().stdout, /job:826aff79/);
  } finally {
    restore();
  }
});

test('lac scheduler edit with only --cron does not clear message or description', async () => {
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (_input, init) => {
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'job:826aff79-570b-4308-822e-18318e2c96ba',
        workspaceId: '知识库',
        platform: 'lark',
        route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1', threadId: 'thread-1' },
        executionMode: 'same-thread',
        triggerType: 'cron',
        cronExpr: '0 2 * * *',
        promptTemplate: 'preserved message',
        description: 'preserved desc',
        enabled: true,
        concurrencyPolicy: 'skip_if_running',
        createdAt: '2026-04-22T06:00:00.000Z',
        updatedAt: '2026-04-22T07:00:00.000Z',
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['scheduler', 'edit', '826aff79', '--cron', '0 2 * * *'],
      { LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1' },
      io,
    );
    assert.equal(exitCode, 0);
    assert(capturedBody);
    assert.deepEqual(JSON.parse(capturedBody), { cronExpr: '0 2 * * *' });
    assert.match(read().stdout, /Updated scheduler job 826aff79/);
  } finally {
    restore();
  }
});

test('lac scheduler del deletes a short job id', async () => {
  const { restore } = withFetchMock(async () => {
    return new Response(JSON.stringify({ ok: true, data: { deleted: true } }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['scheduler', 'del', '826aff79'],
      { LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1' },
      io,
    );
    assert.equal(exitCode, 0);
    assert.match(read().stdout, /Deleted scheduler job 826aff79/);
    assert.doesNotMatch(read().stdout, /job:826aff79/);
  } finally {
    restore();
  }
});

test('lac scheduler run triggers a short job id', async () => {
  const { restore } = withFetchMock(async () => {
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'run-1',
        jobId: 'job:826aff79-570b-4308-822e-18318e2c96ba',
        status: 'queued',
        triggeredAt: '2026-04-22T07:00:00.000Z',
        startedAt: '2026-04-22T07:00:00.000Z',
        completedAt: '',
        output: '',
        error: '',
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['scheduler', 'run', '826aff79'],
      { LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1' },
      io,
    );
    assert.equal(exitCode, 0);
    assert.match(read().stdout, /Triggered scheduler job 826aff79: queued/);
    assert.doesNotMatch(read().stdout, /job:826aff79/);
  } finally {
    restore();
  }
});

test('lac scheduler list --thread filters by current thread context', async () => {
  const { restore } = withFetchMock(async () => {
    return new Response(JSON.stringify({
      ok: true,
      data: {
        jobs: [
          {
            id: 'job-1',
            workspaceId: '知识库',
            platform: 'lark',
            route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1' },
            executionMode: 'same-thread',
            triggerType: 'cron',
            cronExpr: '*/2 * * * *',
            promptTemplate: 'ping',
            description: 'current',
            enabled: true,
            concurrencyPolicy: 'skip_if_running',
            createdAt: '2026-04-22T06:00:00.000Z',
            updatedAt: '2026-04-22T06:00:00.000Z',
          },
          {
            id: 'job-2',
            workspaceId: '知识库',
            platform: 'lark',
            route: { type: 'channel.chat', channelId: 'chat-2', participantId: 'user-2' },
            executionMode: 'side-thread',
            triggerType: 'cron',
            cronExpr: '0 9 * * *',
            promptTemplate: 'pong',
            description: 'other',
            enabled: true,
            concurrencyPolicy: 'skip_if_running',
            createdAt: '2026-04-22T06:00:00.000Z',
            updatedAt: '2026-04-22T06:00:00.000Z',
          },
        ],
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['scheduler', 'list', '--thread'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: '知识库',
        LOCAL_AI_THREAD_ID: 'thread-1',
        LOCAL_AI_PLATFORM: 'lark',
        LOCAL_AI_CHAT_ID: 'chat-1',
        LOCAL_AI_PLATFORM_USER_ID: 'user-1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert.match(read().stdout, /job-1/);
    assert.doesNotMatch(read().stdout, /job-2/);
  } finally {
    restore();
  }
});

test('lac scheduler list scopes to current channel context by default and supports --all-channels', async () => {
  const { restore } = withFetchMock(async () => {
    return new Response(JSON.stringify({
      ok: true,
      data: {
        jobs: [
          {
            id: 'job-chat-1',
            workspaceId: '知识库',
            platform: 'lark',
            route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1' },
            executionMode: 'same-thread',
            triggerType: 'cron',
            cronExpr: '0 9 * * *',
            promptTemplate: 'chat 1 ping',
            description: 'chat 1 task',
            enabled: true,
            concurrencyPolicy: 'skip_if_running',
            createdAt: '2026-04-22T06:00:00.000Z',
            updatedAt: '2026-04-22T06:00:00.000Z',
          },
          {
            id: 'job-chat-2',
            workspaceId: '知识库',
            platform: 'lark',
            route: { type: 'channel.chat', channelId: 'chat-2', participantId: 'user-2' },
            executionMode: 'side-thread',
            triggerType: 'cron',
            cronExpr: '0 10 * * *',
            promptTemplate: 'chat 2 ping',
            description: 'chat 2 task',
            enabled: true,
            concurrencyPolicy: 'skip_if_running',
            createdAt: '2026-04-22T06:00:00.000Z',
            updatedAt: '2026-04-22T06:00:00.000Z',
          },
        ],
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    // In chat-1 context, default list should only show chat-1's task
    const { io: io1, read: read1 } = createIo();
    const exit1 = await runCli(
      ['scheduler', 'list'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: '知识库',
        LOCAL_AI_PLATFORM: 'lark',
        LOCAL_AI_CHAT_ID: 'chat-1',
      },
      io1,
    );
    assert.equal(exit1, 0);
    assert.match(read1().stdout, /job-chat-1/);
    assert.doesNotMatch(read1().stdout, /job-chat-2/);

    // With --all-channels, it should show both
    const { io: ioAll, read: readAll } = createIo();
    const exitAll = await runCli(
      ['scheduler', 'list', '--all-channels'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: '知识库',
        LOCAL_AI_PLATFORM: 'lark',
        LOCAL_AI_CHAT_ID: 'chat-1',
      },
      ioAll,
    );
    assert.equal(exitAll, 0);
    assert.match(readAll().stdout, /job-chat-1/);
    assert.match(readAll().stdout, /job-chat-2/);
  } finally {
    restore();
  }
});

test('lac scheduler add supports explicit --platform and --channel flags', async () => {
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (input, init) => {
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'job-explicit-1',
        workspaceId: '知识库',
        platform: 'lark',
        route: { type: 'channel.chat', channelId: 'custom-channel-id' },
        executionMode: 'same-thread',
        triggerType: 'cron',
        cronExpr: '0 8 * * *',
        promptTemplate: 'explicit prompt',
        description: 'explicit channel task',
        enabled: true,
        concurrencyPolicy: 'skip_if_running',
        createdAt: '2026-04-22T06:00:00.000Z',
        updatedAt: '2026-04-22T06:00:00.000Z',
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['scheduler', 'add', '--cron', '0 8 * * *', '--message', 'explicit prompt', '--desc', 'explicit channel task', '--platform', 'lark', '--channel', 'custom-channel-id', '--workspace', '知识库'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert(capturedBody);
    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.workspaceId, '知识库');
    assert.equal(parsed.platform, 'lark');
    assert.equal(parsed.channelId, 'custom-channel-id');
    assert.match(read().stdout, /Created scheduler job job-explicit-1/);
  } finally {
    restore();
  }
});

test('lac automation add verifies an approved script version before creating the automation', async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const { restore } = withFetchMock(async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/automation-scripts/versions/version-1')) {
      return new Response(JSON.stringify({ ok: true, data: { id: 'version-1', scriptId: 'script-1', status: 'approved' } }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, data: { id: 'automation-1', title: 'Price watch' } }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io } = createIo();
    const exitCode = await runCli([
      'automation', 'add', '--title', 'Price watch', '--script-version', 'version-1', '--script-id', 'script-1',
      '--interval', '1m', '--message', 'Tell me when it matches', '--json',
    ], {
      LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
      LOCAL_AI_WORKSPACE_ID: 'workspace-1',
      LOCAL_AI_THREAD_ID: 'thread-1',
      LOCAL_AI_PLATFORM: 'lark',
      LOCAL_AI_CHAT_ID: 'chat-1',
      LOCAL_AI_PLATFORM_USER_ID: 'user-1',
    }, io);
    assert.equal(exitCode, 0);
    assert.deepEqual(requests, [
      { url: 'http://127.0.0.1:9831/api/local/v1/automation-scripts/versions/version-1?workspace_id=workspace-1', method: 'GET', body: undefined },
      {
        url: 'http://127.0.0.1:9831/api/local/v1/automations', method: 'POST', body: {
          workspaceId: 'workspace-1', title: 'Price watch', enabled: true,
          activation: { kind: 'interval', intervalMs: 60_000 },
          condition: { kind: 'approved-script', scriptId: 'script-1', approvedVersionId: 'version-1', edge: 'rising' },
          action: { kind: 'agent-prompt', promptTemplate: 'Tell me when it matches', executionMode: 'side-thread' },
          delivery: { platform: 'lark', route: { type: 'channel.chat', channelId: 'chat-1', participantId: 'user-1', threadId: 'thread-1' } },
          policies: { concurrency: 'skip-if-running', cooldownMs: 0 },
        },
      },
    ]);
  } finally { restore(); }
});

test('lac script stage uploads only a bounded source bundle and script test requires claimable authorization', async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const { restore } = withFetchMock(async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/versions/version-1') && !url.endsWith('/test')) {
      return new Response(JSON.stringify({ ok: true, data: { id: 'version-1', status: 'test_authorized' } }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, data: { id: 'version-1', status: 'pending_test_approval' } }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io } = createIo();
    const env = { LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1', LOCAL_AI_WORKSPACE_ID: 'workspace-1', LOCAL_AI_THREAD_ID: 'thread-1' };
    assert.equal(await runCli(['script', 'stage', '--script', 'script-1', '--source-json', '[{"path":"manifest.json","content":"{}"},{"path":"check.js","content":"#!/usr/bin/env node"}]'], env, io), 0);
    assert.deepEqual(requests[0], {
      url: 'http://127.0.0.1:9831/api/local/v1/automation-scripts/script-1/versions?workspace_id=workspace-1', method: 'POST',
      body: { files: [{ path: 'manifest.json', content: '{}' }, { path: 'check.js', content: '#!/usr/bin/env node' }] },
    });
    assert.equal(await runCli(['script', 'test', 'version-1', '--actor', 'agent'], env, io), 0);
    assert.deepEqual(requests.slice(1), [
      { url: 'http://127.0.0.1:9831/api/local/v1/automation-scripts/versions/version-1?workspace_id=workspace-1', method: 'GET', body: undefined },
      { url: 'http://127.0.0.1:9831/api/local/v1/automation-scripts/versions/version-1/test?workspace_id=workspace-1', method: 'POST', body: { actor: 'agent' } },
    ]);
  } finally { restore(); }
});

test('lac script and automation commands fail closed before a server-approved status permits execution', async () => {
  const requests: string[] = [];
  const { restore } = withFetchMock(async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ ok: true, data: { id: 'version-1', scriptId: 'script-1', status: 'pending_approval' } }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io } = createIo();
    const env = { LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1', LOCAL_AI_WORKSPACE_ID: 'workspace-1' };
    assert.equal(await runCli(['automation', 'add', '--title', 'blocked', '--script-id', 'script-1', '--script-version', 'version-1', '--message', 'nope'], env, io), 1);
    assert.equal(await runCli(['script', 'test', 'version-1', '--actor', 'agent'], env, io), 1);
    assert.deepEqual(requests, [
      'http://127.0.0.1:9831/api/local/v1/automation-scripts/versions/version-1?workspace_id=workspace-1',
      'http://127.0.0.1:9831/api/local/v1/automation-scripts/versions/version-1?workspace_id=workspace-1',
    ]);
  } finally { restore(); }
});

test('lac automation add uses local delivery when channel identifiers are incomplete', async () => {
  let body: Record<string, unknown> | undefined;
  const { restore } = withFetchMock(async (input, init) => {
    if (String(input).includes('/versions/version-1')) {
      return new Response(JSON.stringify({ ok: true, data: { id: 'version-1', scriptId: 'script-1', status: 'approved' } }), { headers: { 'content-type': 'application/json' } });
    }
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, data: { id: 'automation-1' } }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io } = createIo();
    assert.equal(await runCli(['automation', 'add', '--title', 'local', '--script-id', 'script-1', '--script-version', 'version-1', '--message', 'check'], {
      LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1', LOCAL_AI_WORKSPACE_ID: 'workspace-1', LOCAL_AI_PLATFORM: 'lark',
    }, io), 0);
    assert.deepEqual(body?.delivery, { platform: 'local', route: { type: 'local.thread', channelId: 'workspace-1' } });
  } finally { restore(); }
});

test('lac skill add, list, verify, update, and remove commands', async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const { restore } = withFetchMock(async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });

    if (url.includes('/skills/add')) {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          installed: [{ id: 'tdd', name: 'TDD Skill', scope: 'user', path: '/skills/tdd/SKILL.md' }],
          skipped: [],
        },
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/skills/verify')) {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          skills: [{ id: 'tdd', name: 'TDD Skill', scope: 'user', sourceRepo: 'mattpocock/skills', sourceRef: 'main', status: 'clean', path: '/skills/tdd/SKILL.md' }],
        },
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/skills/update')) {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          updated: [{ id: 'tdd', name: 'TDD Skill', scope: 'user', path: '/skills/tdd/SKILL.md' }],
          unchanged: [],
          conflicts: [],
        },
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/skills') && method === 'GET') {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          skills: [{
            id: 'tdd',
            name: 'TDD Skill',
            scope: 'user',
            path: '/skills/tdd/SKILL.md',
            enabled: true,
            source: { skillId: 'tdd', scope: 'user', sourceRepo: 'mattpocock/skills', sourceRef: 'main', status: 'clean' },
          }],
        },
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/skills') && method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true, data: { success: true } }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, data: {} }), { headers: { 'content-type': 'application/json' } });
  });

  try {
    const { io, read } = createIo();
    const env = { LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1' };

    // 1. lac skill add
    const addCode = await runCli(['skill', 'add', 'mattpocock/skills@main', '--scope', 'user'], env, io);
    assert.equal(addCode, 0);
    assert.match(read().stdout, /Installed 1 skill/);
    assert.deepEqual(requests[0], {
      url: 'http://127.0.0.1:9831/api/local/v1/skills/add',
      method: 'POST',
      body: { repo: 'mattpocock/skills@main', targetScope: 'user', force: false },
    });

    // 2. lac skill list
    const listCode = await runCli(['skill', 'list'], env, io);
    assert.equal(listCode, 0);
    assert.match(read().stdout, /tdd/);

    // 3. lac skill verify
    const verifyCode = await runCli(['skill', 'verify'], env, io);
    assert.equal(verifyCode, 0);
    assert.match(read().stdout, /clean/);

    // 4. lac skill update
    const updateCode = await runCli(['skill', 'update', 'tdd'], env, io);
    assert.equal(updateCode, 0);
    assert.match(read().stdout, /Updated 1 skill/);

    // 5. lac skill remove
    const removeCode = await runCli(['skill', 'remove', 'tdd'], env, io);
    assert.equal(removeCode, 0);
    assert.match(read().stdout, /Deleted skill "tdd"/);
  } finally {
    restore();
  }
});

test('lac monitor add supports --workflow deep-analysis and --retro-delay 24h', async () => {
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (_input, init) => {
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'monitor:decision-test-1',
        workspaceId: 'ws-1',
        title: 'AAPL Bull/Bear',
        sourceType: 'stock.quote',
        sourceConfig: { symbol: 'AAPL' },
        condition: { metric: 'abs_change_percent', operator: '>=', value: 5 },
        promptTemplate: 'Conduct deep analysis',
        platform: 'local',
        route: { type: 'local.thread', channelId: 'ws-1' },
        executionMode: 'side-thread',
        workflowTemplate: 'deep-analysis',
        retrospectiveDelayHours: 24,
        enabled: true,
        cooldownMs: 900000,
        createdAt: '2026-09-06T12:00:00.000Z',
        updatedAt: '2026-09-06T12:00:00.000Z',
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      [
        'monitor', 'add',
        '--title', 'AAPL Bull/Bear',
        '--source', 'stock.quote',
        '--symbol', 'AAPL',
        '--condition', 'abs_change_percent >= 5',
        '--message', 'Conduct deep analysis',
        '--workflow', 'deep-analysis',
        '--retro-delay', '24h',
      ],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: 'ws-1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert(capturedBody);
    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.workflowTemplate, 'deep-analysis');
    assert.equal(parsed.retrospectiveDelayHours, 24);
    assert.match(read().stdout, /Created monitor decision-test-1/);
  } finally {
    restore();
  }
});

test('lac monitor add supports webhook source and outputs hook URL and token', async () => {
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (input, init) => {
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'monitor:wh-12345678',
        workspaceId: 'workspace-a',
        title: 'CI Webhook',
        sourceType: 'webhook',
        sourceConfig: { hookId: 'ci-alert', token: 'whsec_test_secret' },
        condition: { metric: 'always', operator: '==', value: true, expression: 'always' },
        promptTemplate: 'Analyze CI alert',
        executionMode: 'side-thread',
        enabled: true,
        cooldownMs: 900000,
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['monitor', 'add', '--title', 'CI Webhook', '--source', 'webhook', '--hook-id', 'ci-alert', '--token', 'whsec_test_secret', '--condition', 'always', '--message', 'Analyze CI alert'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
        LOCAL_AI_WORKSPACE_ID: 'workspace-a',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert(capturedBody);
    assert.deepEqual(JSON.parse(capturedBody), {
      workspaceId: 'workspace-a',
      title: 'CI Webhook',
      sourceType: 'webhook',
      sourceConfig: { hookId: 'ci-alert', token: 'whsec_test_secret' },
      condition: { metric: 'always', operator: '==', value: true, expression: 'always' },
      promptTemplate: 'Analyze CI alert',
      executionMode: 'side-thread',
      cooldownMs: 900000,
      enabled: true,
    });
    const stdout = read().stdout;
    assert.match(stdout, /Created monitor wh-12345678/);
    assert.match(stdout, /Hook URL: http:\/\/127\.0\.0\.1:9831\/api\/local\/v1\/automation\/hooks\/ci-alert/);
    assert.match(stdout, /Token: whsec_test_secret/);
    assert.match(stdout, /Curl example: curl -X POST/);
  } finally {
    restore();
  }
});

test('lac monitor edit supports --workflow and --retro-delay', async () => {
  let capturedBody: string | null = null;
  const { restore } = withFetchMock(async (_input, init) => {
    if (init?.body) capturedBody = init.body as string;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'monitor:decision-test-1',
        workspaceId: 'ws-1',
        title: 'AAPL Bull/Bear',
        sourceType: 'stock.quote',
        condition: { metric: 'change_percent', operator: '>=', value: 3 },
        promptTemplate: 'analyze',
        workflowTemplate: 'deep-analysis',
        retrospectiveDelayHours: 48,
        platform: 'local',
        route: { type: 'local.thread', channelId: 'ws-1' },
        executionMode: 'side-thread',
        enabled: true,
        cooldownMs: 900000,
        createdAt: '2026-09-06T12:00:00.000Z',
        updatedAt: '2026-09-06T12:00:00.000Z',
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      [
        'monitor', 'edit', 'monitor:decision-test-1',
        '--workflow', 'deep-analysis',
        '--retro-delay', '48h',
      ],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    assert(capturedBody);
    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.workflowTemplate, 'deep-analysis');
    assert.equal(parsed.retrospectiveDelayHours, 48);
    assert.match(read().stdout, /Updated monitor decision-test-1/);
  } finally {
    restore();
  }
});

test('lac monitor decisions displays structured decisions', async () => {
  const { restore } = withFetchMock(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/decisions')) {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          decisions: [
            {
              id: 'dec-1',
              monitorId: 'monitor:decision-test-1',
              workspaceId: 'ws-1',
              runId: 'run:agentdock::111:222',
              action: 'BUY',
              confidence: 78,
              thesis: 'Strong Q3 margin upside outweighs supply chain bumpiness',
              bullPoints: ['Services revenue growth accelerate', 'Valuation compression priced in'],
              bearPoints: ['High multiple versus peers'],
              keyAssumptions: ['Services gross margin remains > 70%'],
              dataSnapshot: { symbol: 'AAPL', current_price: 180 },
              createdAt: '2026-09-06T12:00:00.000Z',
              retrospectiveStatus: 'completed',
              retrospectiveOutcome: {
                accuracy: 'correct',
                realizedOutcome: 'AAPL rose to 192 at T+1',
                reflection: 'Services expansion drove sentiment rebound as projected',
                lessons: ['Hardware slowdown had already been priced in'],
              },
            },
          ],
        },
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  });
  try {
    const { io, read } = createIo();
    const exitCode = await runCli(
      ['monitor', 'decisions', 'monitor:decision-test-1'],
      {
        LOCAL_AI_CORE_BASE: 'http://127.0.0.1:9831/api/local/v1',
      },
      io,
    );
    assert.equal(exitCode, 0);
    const output = read().stdout;
    assert.match(output, /Action: BUY \(Confidence: 78%\)/);
    assert.match(output, /Thesis: Strong Q3 margin upside/);
    assert.match(output, /Bull: Services revenue growth accelerate/);
    assert.match(output, /Retrospective: Accuracy=correct/);
  } finally {
    restore();
  }
});
