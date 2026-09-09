import type { AutomationMonitor, AutomationMonitorEventSnapshot } from '@cc/superai-contracts';
import type { ChannelRuntime } from '@cc/plugin-sdk';
import type { LocalCoreAcpStore } from '../acp/local-core-acp-store.js';
import type { WorkspaceRouter } from '../router/workspace-router.js';
import { BACKGROUND_AGENT_EXECUTION_TIMEOUT_MS } from '../agents/shared/execution-timeouts.js';
import { AutomationActionExecutor } from './automation-action-executor.js';

export type AutomationConversationExecutionResult = {
  threadId: string;
  runId: string;
  replyText?: string;
  deliveryMode?: 'thread-only' | 'bridge-stream';
  deliveryStatus?: 'succeeded' | 'failed';
  deliveryError?: string;
  lastBridgeEventAt?: string;
};

type AutomationConversationExecutorOptions = {
  store: LocalCoreAcpStore;
  getWorkspaceRouter: () => WorkspaceRouter;
  getChannelRuntime: (platform: string) => ChannelRuntime | undefined;
};

export class AutomationConversationExecutor {
  private readonly executor: AutomationActionExecutor;

  constructor(options: AutomationConversationExecutorOptions) {
    this.executor = new AutomationActionExecutor(options);
  }

  async execute(monitor: AutomationMonitor, event: AutomationMonitorEventSnapshot, timeoutMs = BACKGROUND_AGENT_EXECUTION_TIMEOUT_MS): Promise<AutomationConversationExecutionResult> {
    const result = await this.executor.execute({
      automation: {
        id: monitor.id,
        workspaceId: monitor.workspaceId,
        title: monitor.title,
        enabled: monitor.enabled,
        health: 'healthy',
        activation: { kind: 'provider-event', sourceType: monitor.sourceType, sourceConfig: monitor.sourceConfig },
        condition: { kind: 'always' },
        action: {
          kind: 'agent-prompt',
          promptTemplate: monitor.promptTemplate,
          executionMode: monitor.executionMode === 'same-thread' ? 'same-thread' : 'side-thread',
          workflowTemplate: monitor.workflowTemplate,
          retrospectiveDelayHours: monitor.retrospectiveDelayHours,
        },
        delivery: { platform: monitor.platform, route: monitor.route },
        policies: { concurrency: 'skip-if-running', cooldownMs: monitor.cooldownMs },
        consecutiveEvaluationFailures: 0,
        createdAt: monitor.createdAt,
        updatedAt: monitor.updatedAt,
        originKind: 'automation-monitor',
      },
      evaluation: {
        id: `legacy-monitor-event:${monitor.id}`,
        automationId: monitor.id,
        status: 'finished',
        activationKind: 'provider-event',
        startedAt: event.occurredAt,
        finishedAt: event.occurredAt,
        conditionOutcome: 'matched',
        triggerDecision: 'triggered',
      },
      promptVariables: monitorPromptVariables(event, monitor),
    }, timeoutMs);
    return { ...result, runId: result.acpRunId };
  }

}

function monitorPromptVariables(
  event: AutomationMonitorEventSnapshot,
  monitor: AutomationMonitor,
): Record<string, unknown> {
  return {
    title: monitor.title,
    sourceType: event.sourceType,
    subject: event.subject,
    summary: event.summary || '',
    timestamp: event.occurredAt,
    ...event.payload,
  };
}
