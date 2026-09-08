import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AutomationMonitorService, WebhookTriggerError } from '../../services/local-ai-core/src/automation/automation-monitor-service.js';
import { AutomationService } from '../../services/local-ai-core/src/automation/automation-service.js';
import { WebhookMonitorProvider } from '../../services/local-ai-core/src/automation/webhook-provider.js';
import { LocalCoreAcpStore } from '../../services/local-ai-core/src/acp/local-core-acp-store.js';
import { LocalCoreEventBus } from '../../services/local-ai-core/src/kernel/event-bus.js';
import { parseLocalAiCoreRoute } from '../../services/local-ai-core/src/runtime/server-routes.js';
import { registerAutomationHandlers } from '../../services/local-ai-core/src/runtime/handlers/automation-handler.js';
import type { RouteHandler } from '../../services/local-ai-core/src/runtime/server-helpers.js';
import { parseMonitorCondition } from '../../services/local-ai-core/src/cli/monitor-cli-parsers.js';

function fixture(execute?: (automationId: string) => Promise<void>) {
  const path = mkdtempSync(join(tmpdir(), 'webhook-monitor-test-'));
  const store = new LocalCoreAcpStore(path);
  const eventBus = new LocalCoreEventBus();
  const executedActions: string[] = [];
  const automations = new AutomationService({
    store,
    eventBus,
    actionExecutor: {
      async execute({ automation }) {
        executedActions.push(automation.id);
        await execute?.(automation.id);
        return {
          threadId: 'thread:test-workspace::11111111-2222-3333-4444-555555555555',
          acpRunId: `run:agentdock::${automation.id}:${Date.now()}`,
          deliveryStatus: 'succeeded' as const,
        };
      },
    },
    ownershipPolicy: { executes: () => true },
  });

  const webhookProvider = new WebhookMonitorProvider();
  const monitors = new AutomationMonitorService({
    store,
    automations,
    eventBus,
    providers: [webhookProvider],
  });

  return {
    path,
    store,
    eventBus,
    automations,
    monitors,
    executedActions,
    close() {
      store.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}

test('WebhookMonitorProvider declares webhook sourceType and mode', () => {
  const provider = new WebhookMonitorProvider();
  assert.equal(provider.sourceType, 'webhook');
  assert.ok((provider.modes as string[]).includes('webhook'));
});

test('createMonitor auto-generates hookId and token if omitted for webhook source', async () => {
  const context = fixture();
  try {
    const monitor = await context.monitors.createMonitor({
      workspaceId: 'workspace-a',
      title: 'CI Alerts Webhook',
      sourceType: 'webhook',
      condition: { metric: 'always', operator: '==', value: true },
      promptTemplate: 'Analyze CI alert: {{payload.event}}',
    });

    assert.equal(monitor.sourceType, 'webhook');
    assert.ok(typeof monitor.sourceConfig.hookId === 'string' && monitor.sourceConfig.hookId.startsWith('wh_'));
    assert.ok(typeof monitor.sourceConfig.token === 'string' && monitor.sourceConfig.token.startsWith('whsec_'));

    // Preserves custom hookId and token if supplied
    const custom = await context.monitors.createMonitor({
      workspaceId: 'workspace-a',
      title: 'GitHub Triage Webhook',
      sourceType: 'webhook',
      sourceConfig: {
        hookId: 'github-triage',
        token: 'secret-custom-token-12345',
      },
      condition: { metric: 'always', operator: '==', value: true },
      promptTemplate: 'Triage issue: {{payload.issue.title}}',
    });

    assert.equal(custom.sourceConfig.hookId, 'github-triage');
    assert.equal(custom.sourceConfig.token, 'secret-custom-token-12345');
  } finally {
    await context.monitors.stop();
    context.close();
  }
});

test('triggerWebhook authenticates token and evaluates condition', async () => {
  const context = fixture();
  try {
    const monitor = await context.monitors.createMonitor({
      workspaceId: 'workspace-a',
      title: 'Deploy Failure Hook',
      sourceType: 'webhook',
      sourceConfig: {
        hookId: 'deploy-fail',
        token: 'sec-deploy-token-999',
      },
      condition: { metric: 'expression', operator: '==', value: true, expression: 'status == "failed"' },
      promptTemplate: 'Analyze failure for {{payload.service}}',
      cooldownMs: 60_000,
    });

    // 1. Invalid token rejects with 401-style error
    await assert.rejects(
      () => context.monitors.triggerWebhook('deploy-fail', { status: 'failed' }, 'wrong-token'),
      /Invalid or missing webhook token/,
    );

    // 2. Missing token rejects
    await assert.rejects(
      () => context.monitors.triggerWebhook('deploy-fail', { status: 'failed' }, undefined),
      /Invalid or missing webhook token/,
    );

    // 3. Unknown hookId rejects with 404-style error
    await assert.rejects(
      () => context.monitors.triggerWebhook('non-existent-hook', { status: 'failed' }, 'sec-deploy-token-999'),
      /Webhook monitor not found/,
    );

    // 4. Condition does NOT match: status == "success"
    const nonMatchResult = await context.monitors.triggerWebhook(
      'deploy-fail',
      { status: 'success', service: 'billing' },
      'sec-deploy-token-999',
    );
    assert.equal(nonMatchResult.decision, 'not_matched');
    assert.equal(context.executedActions.length, 0);

    // 5. Valid token + condition matches: triggers action execution
    const matchResult = await context.monitors.triggerWebhook(
      'deploy-fail',
      { status: 'failed', service: 'billing' },
      'sec-deploy-token-999',
    );
    assert.equal(matchResult.decision, 'triggered');
    assert.equal(context.executedActions.length, 1);
    assert.equal(context.executedActions[0], monitor.id);

    // 6. Immediate second trigger within cooldown period: skipped_cooldown
    const cooldownResult = await context.monitors.triggerWebhook(
      'deploy-fail',
      { status: 'failed', service: 'billing' },
      'sec-deploy-token-999',
    );
    assert.equal(cooldownResult.decision, 'skipped_cooldown');
    assert.equal(context.executedActions.length, 1); // No new execution
  } finally {
    await context.monitors.stop();
    context.close();
  }
});

test('triggerWebhook token compare rejects wrong-length tokens with 401', async () => {
  const context = fixture();
  try {
    await context.monitors.createMonitor({
      workspaceId: 'workspace-a',
      title: 'Length Mismatch Hook',
      sourceType: 'webhook',
      sourceConfig: {
        hookId: 'length-hook',
        token: 'sec-deploy-token-999',
      },
      condition: { metric: 'always', operator: '==', value: true },
      promptTemplate: 'Hello',
      cooldownMs: 60_000,
    });

    // Shorter and longer wrong tokens must both reject with the typed 401
    // error — the timing-safe compare must not throw on length mismatch.
    await assert.rejects(
      () => context.monitors.triggerWebhook('length-hook', { event: 't' }, 'x'),
      (error: unknown) => error instanceof WebhookTriggerError && error.status === 401,
    );
    await assert.rejects(
      () => context.monitors.triggerWebhook(
        'length-hook',
        { event: 't' },
        'x'.repeat(64),
      ),
      (error: unknown) => error instanceof WebhookTriggerError && error.status === 401,
    );
  } finally {
    await context.monitors.stop();
    context.close();
  }
});

test('triggerWebhook rejects when monitor is disabled', async () => {
  const context = fixture();
  try {
    const monitor = await context.monitors.createMonitor({
      workspaceId: 'workspace-a',
      title: 'Disabled Hook',
      sourceType: 'webhook',
      sourceConfig: {
        hookId: 'disabled-hook',
        token: 'sec-disabled',
      },
      condition: { metric: 'always', operator: '==', value: true },
      promptTemplate: 'Hello',
      enabled: false,
    });

    await assert.rejects(
      () => context.monitors.triggerWebhook('disabled-hook', { event: 'test' }, 'sec-disabled'),
      /Webhook monitor is disabled/,
    );
  } finally {
    await context.monitors.stop();
    context.close();
  }
});

test('parseLocalAiCoreRoute parses POST /api/local/v1/automation/hooks/:hookId', () => {
  const route = parseLocalAiCoreRoute('POST', '/api/local/v1/automation/hooks/hook-abc-123');
  assert.deepEqual(route, {
    name: 'automation.hooks.trigger',
    hookId: 'hook-abc-123',
  });

  assert.equal(parseLocalAiCoreRoute('GET', '/api/local/v1/automation/hooks/hook-abc-123'), null);
  assert.equal(parseLocalAiCoreRoute('POST', '/api/local/v1/automation/hooks'), null);
});

test('HTTP automation.hooks.trigger handler supports Bearer, X-Hook-Token, and query token', async () => {
  const context = fixture();
  try {
    await context.monitors.createMonitor({
      workspaceId: 'workspace-a',
      title: 'HTTP Hook Test',
      sourceType: 'webhook',
      sourceConfig: {
        hookId: 'http-test-hook',
        token: 'auth-secret-token',
      },
      condition: { metric: 'always', operator: '==', value: true },
      promptTemplate: 'Triggered via HTTP',
    });

    const handlers = new Map<string, RouteHandler>();
    registerAutomationHandlers(handlers, context.monitors);

    const handler = handlers.get('automation.hooks.trigger');
    assert.ok(handler, 'automation.hooks.trigger handler must be registered');

    // Test helper to mock req/res
    function mockReq(body: any, headers: Record<string, string> = {}) {
      const data = Buffer.from(JSON.stringify(body));
      const stream = Readable.from(data) as any;
      stream.headers = headers;
      return stream;
    }

    function mockRes() {
      return {
        statusCode: 200,
        bodyData: '',
        setHeader(_name: string, _value: string) {},
        writeHead(code: number, _headers?: any) {
          this.statusCode = code;
        },
        end(data?: any) {
          this.bodyData = data || '';
        },
        get body() { return this.bodyData ? JSON.parse(this.bodyData) : null; },
      };
    }

    // 1. Bearer token in Authorization header
    const res1 = mockRes();
    await handler!(
      { name: 'automation.hooks.trigger', hookId: 'http-test-hook' } as any,
      mockReq({ event: 'ping' }, { authorization: 'Bearer auth-secret-token' }),
      res1 as any,
      new URL('http://127.0.0.1/api/local/v1/automation/hooks/http-test-hook'),
    );
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.body.success, true);
    assert.equal(res1.body.decision, 'triggered');

    // 2. X-Hook-Token header
    const res2 = mockRes();
    await handler!(
      { name: 'automation.hooks.trigger', hookId: 'http-test-hook' } as any,
      mockReq({ event: 'ping2' }, { 'x-hook-token': 'auth-secret-token' }),
      res2 as any,
      new URL('http://127.0.0.1/api/local/v1/automation/hooks/http-test-hook'),
    );
    assert.equal(res2.statusCode, 200);

    // 3. Query param token
    const res3 = mockRes();
    await handler!(
      { name: 'automation.hooks.trigger', hookId: 'http-test-hook' } as any,
      mockReq({ event: 'ping3' }),
      res3 as any,
      new URL('http://127.0.0.1/api/local/v1/automation/hooks/http-test-hook?token=auth-secret-token'),
    );
    assert.equal(res3.statusCode, 200);

    // 4. Invalid token returns 401
    const res4 = mockRes();
    await handler!(
      { name: 'automation.hooks.trigger', hookId: 'http-test-hook' } as any,
      mockReq({ event: 'bad' }, { authorization: 'Bearer wrong' }),
      res4 as any,
      new URL('http://127.0.0.1/api/local/v1/automation/hooks/http-test-hook'),
    );
    assert.equal(res4.statusCode, 401);

    // 5. Unknown hookId returns 404
    const res5 = mockRes();
    await handler!(
      { name: 'automation.hooks.trigger', hookId: 'unknown-hook' } as any,
      mockReq({ event: 'test' }, { authorization: 'Bearer auth-secret-token' }),
      res5 as any,
      new URL('http://127.0.0.1/api/local/v1/automation/hooks/unknown-hook'),
    );
    assert.equal(res5.statusCode, 404);

    // 6. Non-JSON raw body is parsed as { raw: text }
    const res6 = mockRes();
    await handler!(
      { name: 'automation.hooks.trigger', hookId: 'http-test-hook' } as any,
      {
        headers: { authorization: 'Bearer auth-secret-token' },
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from('plain text body');
        },
      } as any,
      res6 as any,
      new URL('http://127.0.0.1/api/local/v1/automation/hooks/http-test-hook'),
    );
    assert.equal(res6.statusCode, 200);
  } finally {
    await context.monitors.stop();
    context.close();
  }
});

test('parseMonitorCondition correctly parses quoted string literals without double escaping', () => {
  const parsed = parseMonitorCondition('status == "failed"');
  assert.equal(parsed.metric, 'status');
  assert.equal(parsed.operator, '==');
  assert.equal(parsed.value, 'failed');

  const parsedSingle = parseMonitorCondition("env == 'production'");
  assert.equal(parsedSingle.metric, 'env');
  assert.equal(parsedSingle.operator, '==');
  assert.equal(parsedSingle.value, 'production');
});

