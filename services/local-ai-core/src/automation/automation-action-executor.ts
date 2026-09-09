import type { AutomationDefinition, AutomationEvaluation } from '@cc/superai-contracts';
import type { ChannelRuntime } from '@cc/plugin-sdk';
import type { LocalCoreAcpStore } from '../acp/local-core-acp-store.js';
import type { WorkspaceRouter } from '../router/workspace-router.js';
import type { CostService } from '../cost/cost-service.js';
import { BACKGROUND_AGENT_EXECUTION_TIMEOUT_MS } from '../agents/shared/execution-timeouts.js';
import { ScheduledBridgeSession, type ScheduledBridgeSessionHandle } from '../scheduler/scheduled-bridge-session.js';
import { buildPlatformRuntimeEnv, getChannelPlatformBase } from '../scheduler/scheduled-job-route.js';
import { waitForRunCompletion } from '../scheduler/run-polling.js';
import { getLatestAssistantFinalContent, threadExists } from '../scheduler/thread-resolution.js';

const AUTOMATION_RUN_PERMISSION_MODE = 'bypassPermissions';
const UNSAFE_PROMPT_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString']);

export interface AutomationActionExecutionInput {
  automation: AutomationDefinition;
  evaluation: AutomationEvaluation;
  promptVariables: Record<string, unknown>;
}

import type { AutomationDecisionRecord } from '@cc/superai-contracts';
import {
  composeDeepAnalysisPrompt,
  extractDecisionRecord,
  composeRetrospectivePrompt,
  extractRetrospectiveReflection,
} from './decision-workflow.js';
import { DecisionLogService } from './decision-log-service.js';

export interface AutomationActionExecutionResult {
  threadId: string;
  acpRunId: string;
  replyText?: string;
  deliveryMode?: 'thread-only' | 'bridge-stream';
  deliveryStatus?: 'succeeded' | 'failed';
  deliveryError?: string;
  lastBridgeEventAt?: string;
  decision?: AutomationDecisionRecord;
  retrospectiveOutcome?: {
    accuracy: 'correct' | 'incorrect' | 'neutral';
    realizedOutcome: string;
    reflection: string;
    lessons: string[];
  };
}

interface AutomationCreatorService {
  create: (definition: any) => any;
}

export type AutomationActionExecutorOptions = {
  store: LocalCoreAcpStore;
  getWorkspaceRouter: () => WorkspaceRouter;
  getChannelRuntime: (platform: string) => ChannelRuntime | undefined;
  costService?: CostService;
  decisionLogService?: DecisionLogService;
  getAutomationService?: () => AutomationCreatorService;
};

function extractChannelId(route: unknown): string | undefined {
  if (typeof route === 'object' && route && 'channelId' in route) {
    const raw = (route as Record<string, unknown>).channelId;
    return raw ? String(raw) : undefined;
  }
  return undefined;
}

function checkBudgetPreflight(costService: CostService | undefined, automation: AutomationDefinition): void {
  if (!costService) return;
  const preflight = costService.checkBudgetPreflight({
    workspaceId: automation.workspaceId,
    channelId: extractChannelId(automation.delivery.route),
    sourceId: automation.id,
  });
  if (!preflight.allowed) {
    throw new Error(`budget_exceeded: ${preflight.budget?.name || 'budget limit reached'}`);
  }
}

async function resolveExecutionPrompt(
  automation: AutomationDefinition,
  input: AutomationActionExecutionInput,
  decisionService: DecisionLogService,
  workspacePath?: string,
): Promise<string> {
  const basePrompt = renderAutomationPrompt(automation.action.promptTemplate, input.promptVariables);
  if (automation.action.workflowTemplate !== 'deep-analysis') {
    return basePrompt;
  }
  const priorLessons = await decisionService.getPriorLessons(automation.id, workspacePath);
  return composeDeepAnalysisPrompt(basePrompt, input.promptVariables, priorLessons, automation.title);
}

async function openExecutionBridge(
  automation: AutomationDefinition,
  promptVariables: Record<string, unknown>,
  threadId: string,
  workspaceRouter: WorkspaceRouter,
  getChannelRuntime: (platform: string) => ChannelRuntime | undefined,
): Promise<ScheduledBridgeSessionHandle | undefined> {
  if (automation.delivery.platform === 'local') {
    return undefined;
  }
  const channelRuntime = getChannelRuntime(automation.delivery.platform);
  if (!channelRuntime) {
    return undefined;
  }
  const isStock = automation.originKind === 'automation-monitor' && promptVariables.sourceType === 'stock.quote';
  return ScheduledBridgeSession.open({
    target: {
      id: automation.id,
      workspaceId: automation.workspaceId,
      platform: automation.delivery.platform,
      route: automation.delivery.route,
      title: automation.title,
      promptTemplate: automation.action.promptTemplate,
    },
    threadId,
    workspaceRouter,
    getChannelRuntime: () => channelRuntime,
    noticeIcon: isStock ? '📈' : '🔔',
    noticeTitle: automation.title,
  });
}

export class AutomationActionExecutor {
  constructor(private readonly options: AutomationActionExecutorOptions) {}

  async execute(
    input: AutomationActionExecutionInput,
    timeoutMs = BACKGROUND_AGENT_EXECUTION_TIMEOUT_MS,
  ): Promise<AutomationActionExecutionResult> {
    const { automation } = input;
    checkBudgetPreflight(this.options.costService, automation);

    const workspaceRouter = this.options.getWorkspaceRouter();
    const threadId = await this.resolveThread(automation);
    const workspacePath = this.options.store.getWorkspaceRegistryEntry?.(automation.workspaceId)?.path;
    const decisionService = this.options.decisionLogService
      || new DecisionLogService({ getWorkspacePath: (id) => this.options.store.getWorkspaceRegistryEntry?.(id)?.path });

    const isDeepAnalysis = automation.action.workflowTemplate === 'deep-analysis';
    const prompt = await resolveExecutionPrompt(automation, input, decisionService, workspacePath);

    const bridge = await openExecutionBridge(
      automation,
      input.promptVariables,
      threadId,
      workspaceRouter,
      this.options.getChannelRuntime,
    );
    try {
      const sendResult = await workspaceRouter.sendThreadMessage(threadId, prompt, {
        permissionMode: AUTOMATION_RUN_PERMISSION_MODE,
        runtimeEnv: buildPlatformRuntimeEnv(automation.delivery.platform, automation.delivery.route),
      });
      await waitForRunCompletion({
        store: this.options.store,
        runId: sendResult.runId,
        timeoutMs,
        label: automation.originKind === 'automation-monitor' ? 'Monitor' : 'Automation',
        interruptRun: (runId) => workspaceRouter.interruptRun(runId),
      });
      const thread = await workspaceRouter.getThread(threadId);
      const replyText = getLatestAssistantFinalContent(thread);

      const { decision, retrospectiveOutcome } = await processPostRunDecision({
        automation,
        replyText,
        runId: sendResult.runId,
        threadId,
        dataSnapshot: input.promptVariables,
        decisionService,
        workspacePath,
        isDeepAnalysis,
        getAutomationService: this.options.getAutomationService,
      });

      return {
        threadId,
        acpRunId: sendResult.runId,
        replyText,
        deliveryMode: bridge ? 'bridge-stream' : 'thread-only',
        deliveryStatus: 'succeeded',
        lastBridgeEventAt: bridge ? new Date().toISOString() : undefined,
        ...(decision ? { decision } : {}),
        ...(retrospectiveOutcome ? { retrospectiveOutcome } : {}),
      };
    } finally {
      await bridge?.close();
    }
  }

  private async resolveThread(automation: AutomationDefinition): Promise<string> {
    const workspaceRouter = this.options.getWorkspaceRouter();
    const route = automation.delivery.route;
    const platform = automation.delivery.platform;
    if (automation.action.executionMode === 'same-thread') {
      const binding = this.options.store.getPlatformThreadBinding(
        automation.workspaceId,
        route.channelId,
        route.participantId || '',
        platform,
      );
      if (binding?.thread_id && await threadExists(workspaceRouter, binding.thread_id)) return binding.thread_id;
      if (route.threadId && await threadExists(workspaceRouter, route.threadId)) return route.threadId;
    }
    const label = automation.originKind === 'automation-monitor' ? 'Monitor' : 'Automation';
    const title = platform === 'local'
      ? `[${label}] ${automation.title}`
      : `[${label}:${getChannelPlatformBase(platform) || platform}] ${automation.title}`;
    const existing = (await workspaceRouter.listThreads(automation.workspaceId))
      .find((thread) => thread.title === title);
    if (existing) {
      // A scheduled task must follow the workspace's current agent runtime.
      // The thread created under a previous agent keeps a session that no
      // longer exists once the workspace agent changes, so reuse it only when
      // its agent type still matches; otherwise start a fresh thread under the
      // current agent.
      const currentAgentType = await workspaceRouter.getWorkspaceAgentType(automation.workspaceId);
      if (existing.agentType === currentAgentType) return existing.id;
    }
    return (await workspaceRouter.createThread(automation.workspaceId, title)).id;
  }
}

async function processPostRunDecision(options: {
  automation: AutomationDefinition;
  replyText?: string;
  runId: string;
  threadId: string;
  dataSnapshot: Record<string, unknown>;
  decisionService: DecisionLogService;
  workspacePath?: string;
  isDeepAnalysis: boolean;
  getAutomationService?: () => AutomationCreatorService;
}): Promise<{
  decision?: AutomationDecisionRecord;
  retrospectiveOutcome?: AutomationActionExecutionResult['retrospectiveOutcome'];
}> {
  const {
    automation,
    replyText,
    runId,
    threadId,
    dataSnapshot,
    decisionService,
    workspacePath,
    isDeepAnalysis,
    getAutomationService,
  } = options;

  let decision: AutomationDecisionRecord | undefined;
  let retrospectiveOutcome: AutomationActionExecutionResult['retrospectiveOutcome'];

  if (automation.action.retrospectiveTarget) {
    retrospectiveOutcome = extractRetrospectiveReflection(replyText);
    await decisionService.recordRetrospective(
      automation.action.retrospectiveTarget.monitorId,
      automation.action.retrospectiveTarget.decisionId,
      retrospectiveOutcome,
      workspacePath,
    );
  } else if (isDeepAnalysis) {
    decision = extractDecisionRecord({
      replyText,
      monitorId: automation.id,
      workspaceId: automation.workspaceId,
      runId,
      threadId,
      dataSnapshot,
    });
    await decisionService.appendDecision(decision, workspacePath);

    const delayHours = automation.action.retrospectiveDelayHours;
    if (delayHours !== undefined && delayHours > 0) {
      const automationService = getAutomationService?.();
      if (automationService) {
        const delayMs = delayHours * 60 * 60 * 1000;
        const runAt = new Date(Date.now() + delayMs).toISOString();
        const retroPrompt = composeRetrospectivePrompt({
          monitorTitle: automation.title,
          decision,
          currentSnapshot: dataSnapshot,
        });
        automationService.create({
          workspaceId: automation.workspaceId,
          title: `[Retrospective] ${automation.title}`,
          enabled: true,
          activation: { kind: 'once', runAt },
          condition: { kind: 'always' },
          action: {
            kind: 'agent-prompt',
            promptTemplate: retroPrompt,
            executionMode: 'side-thread',
            retrospectiveTarget: {
              monitorId: automation.id,
              decisionId: decision.id,
            },
          },
          delivery: automation.delivery,
          policies: { concurrency: 'skip-if-running', cooldownMs: 0 },
        });
      }
    }
  }

  return { decision, retrospectiveOutcome };
}

export function renderAutomationPrompt(template: string, values: Record<string, unknown>): string {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    if (UNSAFE_PROMPT_KEYS.has(key)) return '';
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return '';
    return serializePromptValue(descriptor.value);
  });
}

function serializePromptValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(toSafeJsonValue(value, new Set<object>())) ?? '';
  } catch {
    return '[Unserializable]';
  }
}

function toSafeJsonValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? String(value) : value;
  }
  if (seen.has(value)) throw new Error('Circular prompt value.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((_entry, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
          ? toSafeJsonValue(descriptor.value, seen)
          : null;
      });
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (UNSAFE_PROMPT_KEYS.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
      const nested = descriptor.value;
      if (typeof nested === 'function' || typeof nested === 'symbol' || nested === undefined) continue;
      result[key] = toSafeJsonValue(nested, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
