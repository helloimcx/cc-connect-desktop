import { randomUUID } from 'node:crypto';
import type {
  AutomationDecisionAction,
  AutomationDecisionRecord,
} from '@cc/superai-contracts';

const VALID_ACTIONS = new Set<AutomationDecisionAction>([
  'BUY',
  'SELL',
  'HOLD',
  'WATCH',
  'ALERT',
  'REDUCE',
  'IGNORE',
]);

function normalizeDecisionAction(raw: unknown, fallback: AutomationDecisionAction = 'WATCH'): AutomationDecisionAction {
  const candidate = String(raw || '').trim().toUpperCase() as AutomationDecisionAction;
  return VALID_ACTIONS.has(candidate) ? candidate : fallback;
}

export function formatGroundedDataContract(
  payload: Record<string, unknown>,
  summary?: string,
): string {
  const lines: string[] = [
    '### [GROUNDED DATA CONTRACT - CRITICAL CITATION MANDATE]',
    'You are executing under a strict Grounded Data Contract. All numerical assertions, prices, indicators, and timestamps MUST be cited directly from the verified snapshot below or explicit tool outputs.',
    '**STRICT PROHIBITION**: NEVER hallucinate, invent, or assume any price, financial metric, target price, or indicator not present in this snapshot.',
    '',
    '#### Verified Event Data Snapshot:',
  ];

  if (summary) {
    lines.push(`- **Summary**: ${summary}`);
  }

  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      try {
        lines.push(`- **${key}**: ${JSON.stringify(value)}`);
      } catch {
        lines.push(`- **${key}**: [Object]`);
      }
    } else {
      lines.push(`- **${key}**: ${value}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export function composeDeepAnalysisPrompt(
  basePrompt: string,
  payload: Record<string, unknown>,
  priorLessons?: string[],
  summary?: string,
): string {
  const sections: string[] = [];

  // 1. Data Grounding Contract
  sections.push(formatGroundedDataContract(payload, summary));

  // 2. Prior Retrospective Lessons (Feedback Loop)
  if (priorLessons && priorLessons.length > 0) {
    sections.push(
      '### [PREVIOUS RETROSPECTIVE LESSONS]\n' +
      'The following lessons were recorded from previous monitor decisions and retrospectives. Incorporate them to avoid repeating past errors:\n' +
      priorLessons.map((lesson) => `- ${lesson}`).join('\n') + '\n'
    );
  }

  // 3. User Base Prompt
  sections.push(`### Analysis Objective:\n${basePrompt}\n`);

  // 4. Bull/Bear Debate Rubric & Output Contract
  sections.push(
    '### [STRUCTURED WORKFLOW: BULL/BEAR DEBATE & ADJUDICATION]\n' +
    'Perform a rigorous, balanced 3-phase analysis:\n\n' +
    '#### Phase 1: Bull Case (多头充分论证)\n' +
    '- Core positive catalysts, technical support levels, valuation discounts, margin of safety.\n\n' +
    '#### Phase 2: Bear Case (空头充分论证)\n' +
    '- Key downside risks, macro/sector headwinds, invalidation signals, capital preservation concerns.\n\n' +
    '#### Phase 3: Final Adjudication (综合裁决)\n' +
    '- Synthesize both perspectives and render a definitive, actionable decision.\n' +
    '- Conclude your response with a structured JSON decision block in EXACTLY this format:\n\n' +
    '```json\n' +
    '{\n' +
    '  "action": "BUY" | "SELL" | "HOLD" | "WATCH" | "ALERT" | "REDUCE" | "IGNORE",\n' +
    '  "confidence": 0-100,\n' +
    '  "thesis": "<Concise 1-2 sentence core reasoning>",\n' +
    '  "bullPoints": ["<key bull point 1>", "<key bull point 2>"],\n' +
    '  "bearPoints": ["<key bear point 1>", "<key bear point 2>"],\n' +
    '  "keyAssumptions": ["<critical assumption 1>", "<critical assumption 2>"],\n' +
    '  "invalidationTriggers": ["<condition that proves thesis wrong>"]\n' +
    '}\n' +
    '```'
  );

  return sections.join('\n');
}

export interface ExtractDecisionInput {
  replyText?: string;
  monitorId: string;
  workspaceId: string;
  runId?: string;
  threadId?: string;
  dataSnapshot: Record<string, unknown>;
}

function parseDecisionJson(text: string): Record<string, unknown> | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    || text.match(/(\{[\s\S]*?"action"\s*:[\s\S]*?\})/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseHeuristicDecision(text: string): { action: AutomationDecisionAction; confidence: number; thesis: string } {
  const actionMatch = text.match(/\b(BUY|SELL|HOLD|WATCH|ALERT|REDUCE|IGNORE)\b/i);
  const action = normalizeDecisionAction(actionMatch?.[1]);
  const confidenceMatch = text.match(/(\d{1,3})\s*%/);
  const confidence = confidenceMatch
    ? Math.max(0, Math.min(100, Number(confidenceMatch[1])))
    : 50;
  const firstSentence = text.split(/[。\n.!?]/)[0]?.trim();
  const thesis = firstSentence ? firstSentence.slice(0, 200) : 'Decision extracted from analysis.';
  return { action, confidence, thesis };
}

export function extractDecisionRecord(input: ExtractDecisionInput): AutomationDecisionRecord {
  const text = String(input.replyText || '').trim();
  const id = `dec_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();
  const parsed = parseDecisionJson(text);

  if (parsed) {
    const action = normalizeDecisionAction(parsed.action);
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.confidence)))
      : 60;
    const thesis = String(parsed.thesis || parsed.summary || '').trim() || 'No thesis provided.';
    const bullPoints = Array.isArray(parsed.bullPoints) ? parsed.bullPoints.map(String) : [];
    const bearPoints = Array.isArray(parsed.bearPoints) ? parsed.bearPoints.map(String) : [];
    const keyAssumptions = Array.isArray(parsed.keyAssumptions) ? parsed.keyAssumptions.map(String) : [];
    const invalidationTriggers = Array.isArray(parsed.invalidationTriggers)
      ? parsed.invalidationTriggers.map(String)
      : undefined;

    return {
      id,
      monitorId: input.monitorId,
      workspaceId: input.workspaceId,
      runId: input.runId,
      threadId: input.threadId,
      action,
      confidence,
      thesis,
      bullPoints,
      bearPoints,
      keyAssumptions,
      ...(invalidationTriggers && invalidationTriggers.length > 0 ? { invalidationTriggers } : {}),
      dataSnapshot: input.dataSnapshot,
      createdAt: now,
      retrospectiveStatus: 'pending',
    };
  }

  const heuristic = parseHeuristicDecision(text);
  return {
    id,
    monitorId: input.monitorId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    threadId: input.threadId,
    action: heuristic.action,
    confidence: heuristic.confidence,
    thesis: heuristic.thesis,
    bullPoints: [],
    bearPoints: [],
    keyAssumptions: [],
    dataSnapshot: input.dataSnapshot,
    createdAt: now,
    retrospectiveStatus: 'pending',
  };
}

export interface ComposeRetrospectiveInput {
  monitorTitle: string;
  decision: Pick<AutomationDecisionRecord, 'action' | 'confidence' | 'thesis' | 'keyAssumptions'>;
  currentSnapshot: Record<string, unknown>;
}

export function composeRetrospectivePrompt(input: ComposeRetrospectiveInput): string {
  const sections: string[] = [
    `### [RETROSPECTIVE EVALUATION: ${input.monitorTitle}]`,
    'You are performing a scheduled retrospective review of a previously recorded decision.',
    '',
    '#### Previous Recorded Decision:',
    `- Action: ${input.decision.action} (Confidence: ${input.decision.confidence}%)`,
    `- Thesis: ${input.decision.thesis}`,
    `- Key Assumptions: ${input.decision.keyAssumptions.length > 0 ? input.decision.keyAssumptions.join('; ') : 'None specified'}`,
    '',
    formatGroundedDataContract(input.currentSnapshot, 'Current Realized Market Snapshot for Retrospective Evaluation:'),
    '',
    '#### Retrospective Instructions:',
    '1. Compare the realized price/indicators against the previous thesis and assumptions.',
    '2. Did the anticipated movement occur as projected? Did key assumptions hold or break?',
    '3. Evaluate accuracy as "correct", "incorrect", or "neutral".',
    '4. Record concrete reflections and actionable lessons for future trigger events.',
    '',
    '#### Output Format Mandate:',
    'Conclude your response with a fenced ```json codeblock matching this schema exactly:',
    '```json',
    '{',
    '  "accuracy": "correct" | "incorrect" | "neutral",',
    '  "realizedOutcome": "Summary of realized price action or indicator change",',
    '  "reflection": "Concise analysis of why the decision was right/wrong",',
    '  "lessons": ["Lesson 1", "Lesson 2"]',
    '}',
    '```',
  ];

  return sections.join('\n');
}

function parseRetrospectiveJson(text: string): Record<string, unknown> | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    || text.match(/(\{[\s\S]*?"accuracy"\s*:[\s\S]*?\})/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function extractRetrospectiveReflection(replyText?: string): {
  accuracy: 'correct' | 'incorrect' | 'neutral';
  realizedOutcome: string;
  reflection: string;
  lessons: string[];
} {
  const text = String(replyText || '').trim();
  const parsed = parseRetrospectiveJson(text);
  if (parsed) {
    const accuracy = parsed.accuracy === 'correct' || parsed.accuracy === 'incorrect' ? parsed.accuracy : 'neutral';
    const realizedOutcome = String(parsed.realizedOutcome || '').trim() || 'Outcome evaluated.';
    const reflection = String(parsed.reflection || '').trim() || 'Reflection recorded.';
    const lessons = Array.isArray(parsed.lessons) ? parsed.lessons.map(String) : [];
    return { accuracy, realizedOutcome, reflection, lessons };
  }

  return {
    accuracy: 'neutral',
    realizedOutcome: text.slice(0, 200) || 'Retrospective completed.',
    reflection: text.slice(0, 400) || 'Follow-up evaluated.',
    lessons: [],
  };
}
