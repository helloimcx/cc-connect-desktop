import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AutomationDefinition, AutomationEvaluation } from '@cc/superai-contracts';
import { AutomationActionExecutor } from '../../services/local-ai-core/src/automation/automation-action-executor.js';
import { DecisionLogService } from '../../services/local-ai-core/src/automation/decision-log-service.js';

test('AutomationActionExecutor wraps deep-analysis prompt and logs structured decision', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agentdock-executor-test-'));
  try {
    const decisionLogService = new DecisionLogService({ rootDir: tempDir });
    let sentMessage = '';
    const mockStore = {
      getPlatformThreadBinding: () => undefined,
      getWorkspaceRegistryEntry: () => ({ id: 'ws_test', path: tempDir }),
      getRun: () => ({ status: 'completed', completed_at: new Date().toISOString() }),
    } as any;

    const mockWorkspaceRouter = {
      listThreads: async () => [],
      createThread: async () => ({ id: 'th_mock_123', title: 'Test Thread' }),
      getWorkspaceAgentType: async () => 'mock-agent',
      sendThreadMessage: async (_threadId: string, message: string) => {
        sentMessage = message;
        return { runId: 'run_mock_456' };
      },
      getThread: async () => ({
        id: 'th_mock_123',
        messages: [
          {
            id: 'msg_1',
            role: 'assistant',
            kind: 'final',
            content: `
Phase 1: Bull Case
Stock is at weekly lower Bollinger band.

Phase 2: Bear Case
Volume is low.

Phase 3: Final Adjudication
\`\`\`json
{
  "action": "BUY",
  "confidence": 90,
  "thesis": "Oversold rebound likely from support.",
  "bullPoints": ["Weekly support"],
  "bearPoints": ["Low volume"],
  "keyAssumptions": ["170 holds"]
}
\`\`\`
`,
          },
        ],
      }),
      interruptRun: async () => {},
    } as any;

    let createdOnceAutomation: any = null;
    const mockAutomationService = {
      create: (input: any) => {
        createdOnceAutomation = input;
        return { id: 'auto_retro_once', ...input };
      },
    } as any;

    const executor = new AutomationActionExecutor({
      store: mockStore,
      getWorkspaceRouter: () => mockWorkspaceRouter,
      getChannelRuntime: () => undefined,
      decisionLogService,
      getAutomationService: () => mockAutomationService,
    });

    const automation: AutomationDefinition = {
      id: 'mon_test_apple',
      workspaceId: 'ws_test',
      title: 'AAPL Oversold Alert',
      enabled: true,
      health: 'healthy',
      activation: {
        kind: 'provider-event',
        sourceType: 'stock.quote',
        sourceConfig: { symbol: 'AAPL' },
      },
      condition: { kind: 'always' },
      action: {
        kind: 'agent-prompt',
        promptTemplate: 'Analyze {{symbol}} at price {{latestPrice}}.',
        executionMode: 'side-thread',
        workflowTemplate: 'deep-analysis',
        retrospectiveDelayHours: 24,
      },
      delivery: { platform: 'local', route: { type: 'local.thread', channelId: 'ws_test' } },
      policies: { concurrency: 'skip-if-running', cooldownMs: 0 },
      consecutiveEvaluationFailures: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      originKind: 'automation-monitor',
    };

    const evaluation: AutomationEvaluation = {
      id: 'eval_mock_1',
      automationId: automation.id,
      status: 'finished',
      activationKind: 'provider-event',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      conditionOutcome: 'matched',
      triggerDecision: 'triggered',
    };

    const promptVariables = {
      symbol: 'AAPL',
      latestPrice: 175.5,
      boll_lower: 170.0,
    };

    const result = await executor.execute({
      automation,
      evaluation,
      promptVariables,
    });

    // Verify Grounded Prompt and Bull/Bear instructions were injected into sentMessage
    assert.match(sentMessage, /\[GROUNDED DATA CONTRACT/);
    assert.match(sentMessage, /latestPrice\*\*:\s*175\.5/);
    assert.match(sentMessage, /\[STRUCTURED WORKFLOW: BULL\/BEAR DEBATE & ADJUDICATION\]/);
    assert.match(sentMessage, /Analyze AAPL at price 175\.5/);

    // Verify Decision was extracted
    assert(result.decision);
    assert.equal(result.decision.action, 'BUY');
    assert.equal(result.decision.confidence, 90);
    assert.match(result.decision.thesis, /Oversold rebound/);

    // Verify decision was written to markdown log
    const logPath = join(tempDir, '.agentdock', 'decisions', 'mon_test_apple.md');
    const logContent = readFileSync(logPath, 'utf8');
    assert.match(logContent, /# Decision Log: mon_test_apple/);
    assert.match(logContent, /- \*\*Action\*\*: BUY \(Confidence: 90%\)/);

    // Verify Retrospective follow-up once-job was scheduled
    assert(createdOnceAutomation);
    assert.equal(createdOnceAutomation.activation.kind, 'once');
    assert(createdOnceAutomation.action.retrospectiveTarget);
    assert.equal(createdOnceAutomation.action.retrospectiveTarget.monitorId, 'mon_test_apple');
    assert.equal(createdOnceAutomation.action.retrospectiveTarget.decisionId, result.decision.id);

    // Test Retrospective execution
    const retroAutomation: AutomationDefinition = {
      id: 'retro_once_job',
      workspaceId: 'ws_test',
      title: createdOnceAutomation.title,
      enabled: true,
      health: 'healthy',
      activation: createdOnceAutomation.activation,
      condition: { kind: 'always' },
      action: {
        ...createdOnceAutomation.action,
        promptTemplate: createdOnceAutomation.action.promptTemplate,
      },
      delivery: automation.delivery,
      policies: { concurrency: 'skip-if-running', cooldownMs: 0 },
      consecutiveEvaluationFailures: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      originKind: 'automation-monitor',
    };

    // Mock assistant reply for the retrospective
    mockWorkspaceRouter.getThread = async () => ({
      id: 'th_mock_123',
      messages: [
        {
          id: 'msg_2',
          role: 'assistant',
          kind: 'final',
          content: `
\`\`\`json
{
  "accuracy": "correct",
  "realizedOutcome": "AAPL rebounded to 182 as expected.",
  "reflection": "Lower Bollinger band provided strong support.",
  "lessons": ["Bollinger lower band is reliable for AAPL."]
}
\`\`\`
`,
        },
      ],
    });

    const retroResult = await executor.execute({
      automation: retroAutomation,
      evaluation,
      promptVariables: { latestPrice: 182.0 },
    });

    assert(retroResult.retrospectiveOutcome);
    assert.equal(retroResult.retrospectiveOutcome.accuracy, 'correct');
    assert.match(retroResult.retrospectiveOutcome.realizedOutcome, /AAPL rebounded to 182/);

    // Verify updated log has the retrospective outcome
    const updatedLogContent = readFileSync(logPath, 'utf8');
    assert.match(updatedLogContent, /Status: completed \(Accuracy: correct\)/);
    assert.match(updatedLogContent, /Bollinger lower band is reliable for AAPL\./);

    // Verify prior lessons can now be read
    const lessons = await decisionLogService.getPriorLessons('mon_test_apple', tempDir);
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0], 'Bollinger lower band is reliable for AAPL.');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
