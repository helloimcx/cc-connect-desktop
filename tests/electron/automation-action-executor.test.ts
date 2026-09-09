import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AutomationDefinition, AutomationEvaluation } from '../../packages/contracts/src/automations.js';
import {
  AutomationActionExecutor,
  renderAutomationPrompt,
} from '../../services/local-ai-core/src/automation/automation-action-executor.js';
import { DecisionLogService } from '../../services/local-ai-core/src/automation/decision-log-service.js';
import {
  ACP_PROMPT_TIMEOUT_MS,
  BACKGROUND_AGENT_EXECUTION_TIMEOUT_MS,
} from '../../services/local-ai-core/src/agents/shared/execution-timeouts.js';
import { LocalCoreAcpStore } from '../../services/local-ai-core/src/acp/local-core-acp-store.js';
import { LocalAutomationStore } from '../../services/local-ai-core/src/acp/store/automation-store.js';

function definition(platform = 'lark'): AutomationDefinition {
  return {
    id: 'automation-1',
    workspaceId: 'workspace-1',
    title: 'Safe prompt',
    enabled: true,
    health: 'healthy',
    activation: { kind: 'once', runAt: '2026-07-05T08:00:00.000Z' },
    condition: { kind: 'always' },
    action: { kind: 'agent-prompt', promptTemplate: 'run', executionMode: 'side-thread' },
    delivery: { platform, route: { type: 'channel.chat', channelId: 'chat-1' } },
    policies: { concurrency: 'skip-if-running', cooldownMs: 0 },
    consecutiveEvaluationFailures: 0,
    createdAt: '2026-07-05T07:00:00.000Z',
    updatedAt: '2026-07-05T07:00:00.000Z',
    originKind: 'native',
  };
}

const evaluation: AutomationEvaluation = {
  id: 'evaluation-1',
  automationId: 'automation-1',
  status: 'finished',
  activationKind: 'once',
  startedAt: '2026-07-05T08:00:00.000Z',
  finishedAt: '2026-07-05T08:00:00.000Z',
  conditionOutcome: 'matched',
  triggerDecision: 'triggered',
};

test('background agent execution has one business deadline below the ACP safety ceiling', () => {
  assert.equal(BACKGROUND_AGENT_EXECUTION_TIMEOUT_MS, 60 * 60 * 1_000);
  assert.equal(ACP_PROMPT_TIMEOUT_MS, 180 * 60 * 1_000);
  assert.ok(BACKGROUND_AGENT_EXECUTION_TIMEOUT_MS < ACP_PROMPT_TIMEOUT_MS);
});

test('prompt rendering uses only own data properties and safely serializes objects', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const inherited = Object.create({ constructor: 'unsafe', toString: 'unsafe', prototype: 'unsafe' }) as Record<string, unknown>;
  Object.defineProperty(inherited, 'constructor', { enumerable: true, value: 'also unsafe' });
  const object = Object.create({ toJSON: () => { throw new Error('must not run'); } }) as Record<string, unknown>;
  object.value = 42;
  Object.defineProperty(object, 'nestedGetter', { enumerable: true, get: () => { throw new Error('must not run'); } });
  inherited.object = object;
  inherited.circular = circular;
  Object.defineProperty(inherited, 'getter', { enumerable: true, get: () => { throw new Error('must not run'); } });

  assert.equal(
    renderAutomationPrompt(
      '{{constructor}}|{{toString}}|{{prototype}}|{{getter}}|{{object}}|{{circular}}',
      inherited,
    ),
    '||||{"value":42}|[Unserializable]',
  );
});

test('action executor closes an opened bridge when ACP send fails', async () => {
  let closed = false;
  const executor = new AutomationActionExecutor({
    store: {
      getPlatformThreadBinding: () => undefined,
      getRun: () => ({ status: 'completed' }),
    },
    getWorkspaceRouter: () => ({
      listThreads: async () => [],
      createThread: async () => ({ id: 'thread-1' }),
      getThreadSessionKey: () => 'session-1',
      sendThreadMessage: async () => { throw new Error('send failed'); },
    }),
    getChannelRuntime: () => ({
      platform: 'lark',
      registerScheduledThreadBridge: async () => () => { closed = true; },
      onBridgeEvent: async () => undefined,
    }),
  } as any);

  await assert.rejects(() => executor.execute({
    automation: definition(),
    evaluation,
    promptVariables: {},
  }), /send failed/);
  assert.equal(closed, true);
});

test('action executor interrupts the ACP run when execution times out', async () => {
  let interruptedRunId: string | undefined;
  const executor = new AutomationActionExecutor({
    store: {
      getPlatformThreadBinding: () => undefined,
      getRun: () => ({ status: 'running' }),
    },
    getWorkspaceRouter: () => ({
      listThreads: async () => [],
      createThread: async () => ({ id: 'thread-1' }),
      sendThreadMessage: async () => ({ runId: 'acp-run-1' }),
      interruptRun: async (runId: string) => {
        interruptedRunId = runId;
        return { interrupted: true };
      },
    }),
    getChannelRuntime: () => undefined,
  } as any);

  await assert.rejects(() => executor.execute({
    automation: definition('local'),
    evaluation,
    promptVariables: {},
  }, 1), /Timed out waiting for automation run acp-run-1/);
  assert.equal(interruptedRunId, 'acp-run-1');
});

test('side-thread executor recreates the thread when the workspace agent changed', async () => {
  const created: Array<{ workspaceId: string; title: string }> = [];
  const executor = new AutomationActionExecutor({
    store: {
      getPlatformThreadBinding: () => undefined,
      getRun: () => ({ status: 'completed' }),
    },
    getWorkspaceRouter: () => ({
      listThreads: async () => [
        {
          id: 'stale-thread',
          title: '[Automation:lark] Safe prompt',
          agentType: 'hermes',
        },
      ],
      getWorkspaceAgentType: async () => 'pi',
      createThread: async (workspaceId: string, title: string) => {
        created.push({ workspaceId, title });
        return { id: 'fresh-thread' };
      },
      getThread: async () => ({ messages: [] }),
      sendThreadMessage: async () => ({ runId: 'acp-run-1' }),
    }),
    getChannelRuntime: () => undefined,
  } as any);

  const result = await executor.execute({
    automation: definition(),
    evaluation,
    promptVariables: {},
  });
  // The stale thread was bound to hermes; the workspace now runs pi, so the
  // task must start a fresh thread under the current agent instead of
  // reusing the dead session.
  assert.deepEqual(created, [{ workspaceId: 'workspace-1', title: '[Automation:lark] Safe prompt' }]);
  assert.equal(result.threadId, 'fresh-thread');
});

test('side-thread executor reuses the thread when the workspace agent matches', async () => {
  let createCalls = 0;
  const executor = new AutomationActionExecutor({
    store: {
      getPlatformThreadBinding: () => undefined,
      getRun: () => ({ status: 'completed' }),
    },
    getWorkspaceRouter: () => ({
      listThreads: async () => [
        {
          id: 'matching-thread',
          title: '[Automation:lark] Safe prompt',
          agentType: 'pi',
        },
      ],
      getWorkspaceAgentType: async () => 'pi',
      createThread: async () => {
        createCalls += 1;
        return { id: 'fresh-thread' };
      },
      getThread: async () => ({ messages: [] }),
      sendThreadMessage: async () => ({ runId: 'acp-run-1' }),
    }),
    getChannelRuntime: () => undefined,
  } as any);

  const result = await executor.execute({
    automation: definition(),
    evaluation,
    promptVariables: {},
  });
  assert.equal(createCalls, 0);
  assert.equal(result.threadId, 'matching-thread');
});

test('deep-analysis run records a decision and schedules a working retrospective through the real store', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'automation-executor-'));
  const workspacePath = join(tmpdir(), 'automation-executor-ws');
  const facade = new LocalCoreAcpStore(userDataPath);
  try {
    const store = new LocalAutomationStore(
      (facade as unknown as { db: ConstructorParameters<typeof LocalAutomationStore>[0] }).db,
    );
    const decisionService = new DecisionLogService({ getWorkspacePath: () => workspacePath });
    const created = store.create({
      workspaceId: 'workspace-1',
      title: 'AAPL Bull/Bear debate',
      enabled: true,
      activation: { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
      condition: { kind: 'always' },
      action: {
        kind: 'agent-prompt',
        promptTemplate: 'Debate the AAPL weekly setup.',
        executionMode: 'side-thread',
        workflowTemplate: 'deep-analysis',
        retrospectiveDelayHours: 24,
      },
      delivery: { platform: 'local', route: { type: 'local.thread', channelId: 'workspace-1' } },
      policies: { concurrency: 'skip-if-running', cooldownMs: 0 },
    });

    let replyText = JSON.stringify({
      action: 'BUY',
      confidence: 72,
      thesis: 'Weekly lower-band tag with a high dividend cushion.',
      bullPoints: ['Boll %B 0.04'],
      bearPoints: [],
      keyAssumptions: ['Dividend stays >= 4%'],
    });
    let createdRetro: AutomationDefinition | undefined;
    const executor = new AutomationActionExecutor({
      store: {
        getPlatformThreadBinding: () => undefined,
        getRun: () => ({ status: 'completed' }),
        getWorkspaceRegistryEntry: () => ({ path: workspacePath }),
      },
      getWorkspaceRouter: () => ({
        listThreads: async () => [],
        createThread: async () => ({ id: 'thread-1' }),
        getThread: async () => ({ messages: [{ role: 'assistant', kind: 'final', content: replyText }] }),
        sendThreadMessage: async () => ({ runId: 'acp-run-1' }),
      }),
      getChannelRuntime: () => undefined,
      decisionLogService: decisionService,
      getAutomationService: () => ({
        create: (job: AutomationDefinition) => {
          createdRetro = store.create(job);
          return createdRetro;
        },
      }),
    } as any);

    const result = await executor.execute({
      automation: store.get(created.id)!,
      evaluation,
      promptVariables: { sourceType: 'stock.quote' },
    });

    assert.ok(result.decision, 'deep-analysis run should record a decision');
    assert.match(result.decision.id, /^dec_[0-9a-f]{16}$/);
    assert.ok(createdRetro, 'deep-analysis run should schedule a retrospective once-job');
    assert.deepEqual(store.get(createdRetro.id)?.action.retrospectiveTarget, {
      monitorId: created.id,
      decisionId: result.decision.id,
    });

    replyText = JSON.stringify({
      accuracy: 'correct',
      realizedOutcome: 'AAPL closed +4.1% within the week.',
      reflection: 'Lower-band entry held; the dividend assumption held.',
      lessons: ['Wait for weekly close confirmation.'],
    });
    const retroResult = await executor.execute({
      automation: store.get(createdRetro.id)!,
      evaluation: { ...evaluation, automationId: createdRetro.id, activationKind: 'once' },
      promptVariables: {},
    });
    assert.equal(retroResult.retrospectiveOutcome?.accuracy, 'correct');

    const decisions = await decisionService.listDecisions(created.id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.retrospectiveStatus, 'completed');
    assert.equal(decisions[0]?.retrospectiveOutcome?.realizedOutcome, 'AAPL closed +4.1% within the week.');
  } finally {
    facade.close();
    rmSync(userDataPath, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
