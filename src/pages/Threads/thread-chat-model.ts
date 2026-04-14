import type { Session } from '@/api/sessions';
import type { ThreadDetail, ThreadSummary } from '../../../packages/contracts/src';
import type {
  DesktopBridgeButtonOption,
  DesktopRuntimeStatus,
} from '../../../shared/desktop';
import {
  isPermissionButtonOption,
  normalizeDesktopBridgeButtonOption,
} from '../../../shared/desktop';
import { sessionLabel } from '@/lib/session-utils';

export const ASSISTANT_REPLY_TIMEOUT_MS = 90000;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind?: 'final' | 'progress';
  order: number;
  timestamp?: string;
  turnKey?: string;
  actions?: DesktopBridgeButtonOption[][];
  actionReplyCtx?: string;
  actionPending?: boolean;
  actionMode?: 'permission' | 'generic';
  actionStatus?: string;
  actionInteractive?: boolean;
  preview?: boolean;
}

export type ChatTaskState = 'idle' | 'running' | 'awaiting_permission' | 'permission_submitted' | 'stopping';

export interface ThreadGroup {
  project: string;
  sessions: ChatThreadSummary[];
}

export type SessionGroup = ThreadGroup;

export interface ThreadActionTarget {
  id: string;
  name: string;
  project: string;
}

export type SessionActionTarget = ThreadActionTarget;

export interface ChatThreadSummary {
  id: string;
  project: string;
  name: string;
  live: boolean;
  createdAt: string;
  updatedAt: string;
  excerpt: string;
  agentType?: string;
  bridgeSessionKey?: string;
}

export function isInternalProgressMessage(content?: string) {
  if (!content) {
    return false;
  }
  return (
    content.startsWith('💭 ') ||
    content.startsWith('🔧 ') ||
    content.startsWith('📤 ') ||
    content.startsWith('⏳ ')
  );
}

export function extractVisibleMessageContent(content?: string) {
  if (!content) {
    return '';
  }
  const match = content.match(/\[User Message\]\s*([\s\S]*?)\s*\[\/User Message\]/);
  if (!match) {
    return content;
  }
  return match[1] || '';
}

export function sessionMatchesDesktop(session: Session) {
  return session.platform === 'desktop' || session.session_key.startsWith('desktop:');
}

export function toMessages(history: { role: string; content: string; kind?: string; timestamp: string }[]): ChatMessage[] {
  return history.map((message, index) => ({
    id: `${index}-${message.timestamp || message.role}`,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.role === 'user' ? extractVisibleMessageContent(message.content) : message.content,
    kind: message.kind === 'progress' ? 'progress' : 'final',
    order: index,
    timestamp: message.timestamp,
  }));
}

export function toMessagesFromThread(history: ThreadDetail['messages']): ChatMessage[] {
  return history.map((message, index) => ({
    id: message.id || `${index}-${message.timestamp || message.role}`,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.role === 'user' ? extractVisibleMessageContent(message.content) : message.content,
    kind:
      message.kind === 'progress'
        ? 'progress'
        : message.kind === 'system'
          ? 'progress'
          : 'final',
    order: index,
    timestamp: message.timestamp,
  }));
}

export function toChatThreadSummary(project: string, session: Session): ChatThreadSummary {
  return {
    id: session.id,
    project,
    name: sessionLabel(session),
    live: session.live,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    excerpt: extractVisibleMessageContent(session.last_message?.content || ''),
    agentType: session.agent_type,
    bridgeSessionKey: session.session_key,
  };
}

export function toCoreChatThreadSummary(thread: ThreadSummary): ChatThreadSummary {
  return {
    id: thread.id,
    project: thread.workspaceId,
    name: thread.title,
    live: thread.live,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    excerpt: extractVisibleMessageContent(thread.excerpt),
    agentType: thread.agentType,
    bridgeSessionKey: thread.bridgeSessionKey,
  };
}

export function sortChatThreadsByLiveAndUpdated(items: ChatThreadSummary[]) {
  return [...items].sort((a, b) => {
    if (a.live !== b.live) {
      return a.live ? -1 : 1;
    }
    return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
  });
}

export function chatThreadMatchesSearch(thread: ChatThreadSummary, query: string) {
  if (!query) {
    return true;
  }
  const haystack = [thread.name, thread.excerpt, thread.bridgeSessionKey || ''].join(' ').toLowerCase();
  return haystack.includes(query);
}

export function sortChatMessages(messages: ChatMessage[]) {
  return [...messages].sort((a, b) => {
    const aTime = a.timestamp ? new Date(a.timestamp).getTime() : Number.NaN;
    const bTime = b.timestamp ? new Date(b.timestamp).getTime() : Number.NaN;
    const aHasTime = Number.isFinite(aTime);
    const bHasTime = Number.isFinite(bTime);
    if (aHasTime && bHasTime && aTime !== bTime) {
      return aTime - bTime;
    }
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.id.localeCompare(b.id);
  });
}

export function formatMessageTimestamp(timestamp?: string) {
  if (!timestamp) {
    return '';
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function formatRuntimePhase(phase?: DesktopRuntimeStatus['phase']) {
  switch (phase) {
    case 'starting':
      return 'starting runtime';
    case 'api_ready':
      return 'service ready';
    case 'bridge_ready':
      return 'ready';
    case 'error':
      return 'runtime error';
    default:
      return 'stopped';
  }
}

export function sessionProjectFromKey(sessionKey?: string) {
  if (!sessionKey?.startsWith('desktop:')) {
    return '';
  }
  const [, project = ''] = sessionKey.split(':');
  return project;
}

export function normalizeBridgeActionRows(input: unknown): DesktopBridgeButtonOption[][] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((row) => {
      if (!Array.isArray(row)) {
        return [];
      }
      return row
        .map((button) => normalizeDesktopBridgeButtonOption(button))
        .filter((button): button is DesktopBridgeButtonOption => Boolean(button));
    })
    .filter((row) => row.length > 0);
}

export function upsertThreadGroup(groups: ThreadGroup[], project: string, sessions: ChatThreadSummary[]) {
  const next = groups.filter((group) => group.project !== project);
  next.push({ project, sessions });
  return next.sort((a, b) => a.project.localeCompare(b.project));
}

export const upsertSessionGroup = upsertThreadGroup;

export function upsertThreadInGroup(groups: ThreadGroup[], project: string, thread: ChatThreadSummary) {
  const current = groups.find((group) => group.project === project)?.sessions || [];
  const nextSessions = sortChatThreadsByLiveAndUpdated([
    thread,
    ...current.filter((item) => item.id !== thread.id),
  ]);
  return upsertThreadGroup(groups, project, nextSessions);
}

export function isPermissionActionRow(rows: DesktopBridgeButtonOption[][]) {
  return rows.some((row) => row.some((action) => isPermissionButtonOption(action)));
}

export function formatTaskHint(taskState: ChatTaskState, typing: boolean) {
  if (taskState === 'stopping') {
    return 'Stopping current task…';
  }
  if (taskState === 'permission_submitted') {
    return 'Permission sent. Waiting for the agent to continue…';
  }
  if (taskState === 'awaiting_permission') {
    return 'Waiting for your permission response.';
  }
  if (typing) {
    return 'Agent is typing…';
  }
  if (taskState === 'running') {
    return 'Task is running…';
  }
  return '';
}
