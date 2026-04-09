import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Circle,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  RotateCw,
  Search,
  Send,
  Trash2,
  User,
  WifiOff,
} from 'lucide-react';
import { Button, Card, EmptyState, Input, Modal, Textarea } from '@/components/ui';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { listProjects } from '@/api/projects';
import { createSession, deleteSession, getSession, listSessions, renameSession, type Session } from '@/api/sessions';
import {
  createThread,
  deleteThread as deleteCoreThread,
  getThread,
  interruptRun,
  listThreads,
  listWorkspaces,
  renameThread,
  sendAction,
  sendMessage as sendThreadMessage,
} from '../../../packages/core-sdk/src';
import { useSearchParams } from 'react-router-dom';
import {
  bridgeConnect,
  bridgeSendMessage,
  getRuntimeStatus,
  onBridgeEvent,
  onRuntimeEvent,
  startDesktopService,
} from '@/api/desktop';
import { cn } from '@/lib/utils';
import { sessionLabel, timeAgo } from '@/lib/session-utils';
import type { ThreadDetail, ThreadSummary } from '../../../packages/contracts/src';
import type {
  DesktopBridgeButtonOption,
  DesktopBridgeEvent,
  DesktopRuntimeStatus,
} from '../../../shared/desktop';
import {
  isPermissionButtonOption,
  normalizeDesktopBridgeButtonOption,
  normalizePermissionResponse,
  supportsInteractivePermission,
} from '../../../shared/desktop';
import { getRuntimeProvider } from '@/app/runtime';
import { getRuntimeBranding } from '@/lib/runtime-branding';

const ASSISTANT_REPLY_TIMEOUT_MS = 90000;

interface ChatMessage {
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

type ChatTaskState = 'idle' | 'running' | 'awaiting_permission' | 'permission_submitted' | 'stopping';

interface SessionGroup {
  project: string;
  sessions: ChatThreadSummary[];
}

interface SessionActionTarget {
  id: string;
  name: string;
  project: string;
}

interface ChatThreadSummary {
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

function isInternalProgressMessage(content?: string) {
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

function sessionMatchesDesktop(session: Session) {
  return session.platform === 'desktop' || session.session_key.startsWith('desktop:');
}

function toMessages(history: { role: string; content: string; kind?: string; timestamp: string }[]): ChatMessage[] {
  return history.map((message, index) => ({
    id: `${index}-${message.timestamp || message.role}`,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
    kind: message.kind === 'progress' ? 'progress' : 'final',
    order: index,
    timestamp: message.timestamp,
  }));
}

function toMessagesFromThread(history: ThreadDetail['messages']): ChatMessage[] {
  return history.map((message, index) => ({
    id: message.id || `${index}-${message.timestamp || message.role}`,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
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

function toChatThreadSummary(project: string, session: Session): ChatThreadSummary {
  return {
    id: session.id,
    project,
    name: sessionLabel(session),
    live: session.live,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    excerpt: session.last_message?.content || '',
    agentType: session.agent_type,
    bridgeSessionKey: session.session_key,
  };
}

function toCoreChatThreadSummary(thread: ThreadSummary): ChatThreadSummary {
  return {
    id: thread.id,
    project: thread.workspaceId,
    name: thread.title,
    live: thread.live,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    excerpt: thread.excerpt,
    agentType: thread.agentType,
    bridgeSessionKey: thread.bridgeSessionKey,
  };
}

function sortChatThreadsByLiveAndUpdated(items: ChatThreadSummary[]) {
  return [...items].sort((a, b) => {
    if (a.live !== b.live) {
      return a.live ? -1 : 1;
    }
    return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
  });
}

function chatThreadMatchesSearch(thread: ChatThreadSummary, query: string) {
  if (!query) {
    return true;
  }
  const haystack = [thread.name, thread.excerpt, thread.bridgeSessionKey || ''].join(' ').toLowerCase();
  return haystack.includes(query);
}

function sortChatMessages(messages: ChatMessage[]) {
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

function formatMessageTimestamp(timestamp?: string) {
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

function formatRuntimePhase(phase?: DesktopRuntimeStatus['phase']) {
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

function sessionProjectFromKey(sessionKey?: string) {
  if (!sessionKey?.startsWith('desktop:')) {
    return '';
  }
  const [, project = ''] = sessionKey.split(':');
  return project;
}

function normalizeBridgeActionRows(input: unknown): DesktopBridgeButtonOption[][] {
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

function upsertSessionGroup(groups: SessionGroup[], project: string, sessions: ChatThreadSummary[]) {
  const next = groups.filter((group) => group.project !== project);
  next.push({ project, sessions });
  return next.sort((a, b) => a.project.localeCompare(b.project));
}

function upsertThreadInGroup(groups: SessionGroup[], project: string, thread: ChatThreadSummary) {
  const current = groups.find((group) => group.project === project)?.sessions || [];
  const nextSessions = sortChatThreadsByLiveAndUpdated([
    thread,
    ...current.filter((item) => item.id !== thread.id),
  ]);
  return upsertSessionGroup(groups, project, nextSessions);
}

function isPermissionActionRow(rows: DesktopBridgeButtonOption[][]) {
  return rows.some((row) => row.some((action) => isPermissionButtonOption(action)));
}

function permissionSupportMessage(agentType?: string) {
  const name = agentType || 'This agent';
  const branding = getRuntimeBranding();
  if (branding.permissionUnsupportedLabel.startsWith('This agent')) {
    return branding.permissionUnsupportedLabel;
  }
  return `${name} ${branding.permissionUnsupportedLabel.replace(/^This agent\s+/i, '')}`;
}

function formatTaskHint(taskState: ChatTaskState, typing: boolean) {
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

export default function ThreadChat() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [runtime, setRuntime] = useState<DesktopRuntimeStatus | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [sessionGroups, setSessionGroups] = useState<SessionGroup[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [activeSessionKey, setActiveSessionKey] = useState('');
  const [activeSessionName, setActiveSessionName] = useState('');
  const [activeSessionAgentType, setActiveSessionAgentType] = useState('');
  const [activeRunId, setActiveRunId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sessionSearch, setSessionSearch] = useState('');
  const [renameTarget, setRenameTarget] = useState<SessionActionTarget | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SessionActionTarget | null>(null);
  const [pendingSessionAction, setPendingSessionAction] = useState<'rename' | 'delete' | null>(null);
  const [pendingBridgeActionId, setPendingBridgeActionId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [typing, setTyping] = useState(false);
  const [taskState, setTaskState] = useState<ChatTaskState>('idle');
  const [bridgeError, setBridgeError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const replyTimeoutRef = useRef<number | null>(null);
  const replyTimeoutModeRef = useRef<'reply' | 'permission_continue'>('reply');
  const lastSessionByProjectRef = useRef<Record<string, string>>({});
  const nextMessageOrderRef = useRef(0);
  const pendingTurnRef = useRef<{ sessionKey: string; userOrder: number } | null>(null);
  const holdBlankComposerRef = useRef(false);
  const progressSequenceByTurnRef = useRef<Record<string, number>>({});
  const taskStateRef = useRef<ChatTaskState>('idle');
  const activeSessionIdRef = useRef('');
  const localCorePollGenerationRef = useRef(0);
  const requestedProject = searchParams.get('project') || '';
  const requestedSessionId = searchParams.get('session') || '';
  const branding = getRuntimeBranding();
  const runtimeProvider = getRuntimeProvider();
  const showSessionKey = runtimeProvider === 'electron';

  const serviceRunning = runtime?.phase === 'api_ready' || runtime?.phase === 'bridge_ready';
  const bridgeConnected = runtime?.bridge.status === 'connected';
  const transportReady = runtimeProvider === 'local_core' ? serviceRunning : bridgeConnected;
  const taskRunning = taskState !== 'idle';
  const taskHint = formatTaskHint(taskState, typing);

  const sessionsForSelectedProject = useMemo(
    () => sessionGroups.find((group) => group.project === selectedProject)?.sessions || [],
    [selectedProject, sessionGroups],
  );

  const filteredSessionGroups = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    return projects
      .map((project) => {
        const sessions = (sessionGroups.find((group) => group.project === project)?.sessions || []).filter((session) =>
          chatThreadMatchesSearch(session, query),
        );
        return { project, sessions };
      })
      .filter((group) => group.sessions.length > 0 || (!query && group.project === selectedProject));
  }, [projects, selectedProject, sessionGroups, sessionSearch]);

  const renderedMessages = useMemo(() => sortChatMessages(messages), [messages]);

  const updateTaskState = useCallback((next: ChatTaskState) => {
    taskStateRef.current = next;
    setTaskState(next);
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const clearReplyTimeout = useCallback(() => {
    if (replyTimeoutRef.current) {
      window.clearTimeout(replyTimeoutRef.current);
      replyTimeoutRef.current = null;
    }
  }, []);

  const armReplyTimeout = useCallback((mode: 'reply' | 'permission_continue' = 'reply') => {
    clearReplyTimeout();
    replyTimeoutModeRef.current = mode;
    replyTimeoutRef.current = window.setTimeout(() => {
      setTyping(false);
      pendingTurnRef.current = null;
      updateTaskState('idle');
      setBridgeError(
        mode === 'permission_continue'
          ? branding.replyTimeoutLabel
          : 'Agent did not respond in time. Check Desktop Runtime logs or adjust the model/provider.',
      );
    }, ASSISTANT_REPLY_TIMEOUT_MS);
  }, [branding.replyTimeoutLabel, clearReplyTimeout, updateTaskState]);

  const clearActionStatuses = useCallback(() => {
    setMessages((current) =>
      current.map((message) =>
        message.actionStatus || message.actionPending
          ? { ...message, actionPending: false, actionStatus: undefined }
          : message,
      ),
    );
  }, []);

  const reserveNextMessageOrder = useCallback(() => {
    const order = nextMessageOrderRef.current;
    nextMessageOrderRef.current += 1;
    return order;
  }, []);

  const reserveAssistantMessageOrder = useCallback((sessionKey?: string) => {
    const pendingTurn = pendingTurnRef.current;
    if (pendingTurn && sessionKey && pendingTurn.sessionKey === sessionKey) {
      const minimum = pendingTurn.userOrder + 1;
      if (nextMessageOrderRef.current < minimum) {
        nextMessageOrderRef.current = minimum;
      }
    }
    return reserveNextMessageOrder();
  }, [reserveNextMessageOrder]);

  const nextProgressMessageId = useCallback((replyCtx?: string) => {
    const turnKey = replyCtx || crypto.randomUUID();
    const nextSequence = (progressSequenceByTurnRef.current[turnKey] || 0) + 1;
    progressSequenceByTurnRef.current[turnKey] = nextSequence;
    return `${turnKey}-progress-${nextSequence}`;
  }, []);

  const finalizeTurnMessages = useCallback((turnKey?: string) => {
    if (!turnKey) {
      return;
    }
    setMessages((current) => {
      const candidates = current.filter((message) => message.turnKey === turnKey && !message.preview);
      if (candidates.length === 0) {
        return current;
      }
      const lastId = candidates[candidates.length - 1]?.id;
      return current.map((message) => {
        if (message.turnKey !== turnKey || message.preview) {
          return message;
        }
        return {
          ...message,
          kind: message.id === lastId ? 'final' : 'progress',
        };
      });
    });
  }, []);

  const clearLocalCorePolling = useCallback(() => {
    localCorePollGenerationRef.current += 1;
  }, []);

  const applyLocalCoreThreadDetail = useCallback((detail: ThreadDetail) => {
    lastSessionByProjectRef.current[detail.workspaceId] = detail.id;
    setSelectedProject(detail.workspaceId);
    setActiveSessionId(detail.id);
    setActiveSessionKey(detail.bridgeSessionKey || '');
    setActiveSessionName(detail.title);
    setActiveSessionAgentType(detail.agentType || '');
    setActiveRunId(detail.runId || '');
    setSessionGroups((current) => upsertThreadInGroup(current, detail.workspaceId, toCoreChatThreadSummary(detail)));
    holdBlankComposerRef.current = false;
    progressSequenceByTurnRef.current = {};
    const nextMessages = toMessagesFromThread(detail.messages || []);
    nextMessageOrderRef.current = nextMessages.length;
    pendingTurnRef.current = null;
    setMessages(nextMessages);
  }, []);

  const startLocalCoreThreadPolling = useCallback((threadId: string, baselineAssistantCount: number) => {
    clearLocalCorePolling();
    const generation = localCorePollGenerationRef.current;
    const startedAt = Date.now();
    let unchangedPolls = 0;
    let lastSignature = '';

    const tick = async () => {
      if (localCorePollGenerationRef.current !== generation || activeSessionIdRef.current !== threadId) {
        return;
      }
      try {
        const detail = await getThread(threadId);
        if (localCorePollGenerationRef.current !== generation || activeSessionIdRef.current !== threadId) {
          return;
        }
        applyLocalCoreThreadDetail(detail);
        const nextMessages = toMessagesFromThread(detail.messages || []);
        const assistantCount = nextMessages.filter((message) => message.role === 'assistant').length;
        const signature = nextMessages.map((message) => `${message.id}:${message.content}:${message.kind || 'final'}`).join('|');
        unchangedPolls = signature === lastSignature ? unchangedPolls + 1 : 0;
        lastSignature = signature;
        if ((assistantCount > baselineAssistantCount && unchangedPolls >= 2) || Date.now() - startedAt >= ASSISTANT_REPLY_TIMEOUT_MS) {
          setTyping(false);
          updateTaskState('idle');
          if (Date.now() - startedAt >= ASSISTANT_REPLY_TIMEOUT_MS && assistantCount <= baselineAssistantCount) {
            setBridgeError('Agent did not respond in time. Check Local AI Core logs or adapter status.');
          }
          return;
        }
        window.setTimeout(() => {
          void tick();
        }, 1500);
      } catch (error) {
        if (localCorePollGenerationRef.current !== generation || activeSessionIdRef.current !== threadId) {
          return;
        }
        setTyping(false);
        updateTaskState('idle');
        setBridgeError(error instanceof Error ? error.message : 'Failed to refresh the current thread.');
      }
    };

    window.setTimeout(() => {
      void tick();
    }, 1500);
  }, [applyLocalCoreThreadDetail, clearLocalCorePolling, updateTaskState]);

  const handleBridgeAction = useCallback(async (message: ChatMessage, action: DesktopBridgeButtonOption) => {
    if (!activeSessionId) {
      return;
    }
    const actionContent = normalizePermissionResponse(action.data) || action.data;
    const actionLabel = normalizePermissionResponse(action.data) || action.text || action.data;
    const userOrder = reserveNextMessageOrder();
    const actionMessageId = `${crypto.randomUUID()}-user-action`;
    let sent = false;
    setPendingBridgeActionId(message.id);
    setMessages((current) =>
      current.map((item) =>
        item.id === message.id
          ? { ...item, actionPending: true }
          : item,
      ),
    );
    try {
      setMessages((current) => [
        ...current,
        { id: actionMessageId, role: 'user', content: actionLabel, order: userOrder, timestamp: new Date().toISOString() },
      ]);
      if (runtimeProvider === 'local_core') {
        const result = await sendAction(activeSessionId, actionContent);
        setActiveRunId(result.runId);
        const assistantCount = messages.filter((item) => item.role === 'assistant').length;
        startLocalCoreThreadPolling(activeSessionId, assistantCount);
      } else {
        const [, project = selectedProject, chatId = 'main'] = activeSessionKey.split(':');
        await bridgeSendMessage({
          project,
          chatId,
          content: actionContent,
        });
      }
      sent = true;
      setBridgeError('');
      setTyping(runtimeProvider !== 'local_core');
      clearReplyTimeout();
      clearActionStatuses();
      if (message.actionMode === 'permission' && message.actionInteractive) {
        updateTaskState('permission_submitted');
        if (runtimeProvider !== 'local_core') {
          armReplyTimeout('permission_continue');
        }
        setMessages((current) =>
          current.map((item) =>
            item.id === message.id
              ? {
                  ...item,
                  actions: [],
                  actionPending: false,
                  actionStatus: 'Permission sent. Waiting for the agent to continue…',
                }
              : item,
          ),
        );
      } else {
        updateTaskState('running');
        if (runtimeProvider !== 'local_core') {
          armReplyTimeout();
        }
      }
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : 'Failed to send permission response.');
      setMessages((current) =>
        current.filter((item) => item.id !== actionMessageId),
      );
      updateTaskState(message.actionMode === 'permission' && message.actionInteractive ? 'awaiting_permission' : 'idle');
      setTyping(false);
    } finally {
      setPendingBridgeActionId(null);
      setMessages((current) =>
        current.map((item) =>
          item.id === message.id
            ? {
                ...item,
                actionPending: false,
                actions: sent ? item.actions || [] : item.actions,
              }
            : item,
        ),
      );
    }
  }, [
    activeSessionId,
    activeSessionKey,
    armReplyTimeout,
    clearActionStatuses,
    clearLocalCorePolling,
    clearReplyTimeout,
    messages,
    reserveNextMessageOrder,
    runtimeProvider,
    selectedProject,
    startLocalCoreThreadPolling,
    updateTaskState,
  ]);

  const refreshSessionsForProject = useCallback(async (project: string) => {
    if (!project || !serviceRunning) {
      return [];
    }
    const nextSessions = runtimeProvider === 'local_core'
      ? sortChatThreadsByLiveAndUpdated((await listThreads(project)).threads.map((thread) => toCoreChatThreadSummary(thread)))
      : sortChatThreadsByLiveAndUpdated(
          ((await listSessions(project)).sessions || [])
            .filter(sessionMatchesDesktop)
            .map((session) => toChatThreadSummary(project, session)),
        );
    const activeSession = nextSessions.find((session) => session.id === activeSessionId);
    if (activeSession?.agentType) {
      setActiveSessionAgentType(activeSession.agentType);
    }
    setSessionGroups((current) => upsertSessionGroup(current, project, nextSessions));
    return nextSessions;
  }, [activeSessionId, runtimeProvider, serviceRunning]);

  const refreshProjectsAndSessions = useCallback(async () => {
    if (!serviceRunning) {
      setProjects([]);
      setSessionGroups([]);
      return [];
    }
    const names = runtimeProvider === 'local_core'
      ? (await listWorkspaces()).workspaces.map((workspace) => workspace.id)
      : (await listProjects()).projects.map((project) => project.name);
    setProjects(names);
    const groups = (
      await Promise.all(
        names.map(async (project) => {
          return {
            project,
            sessions: await refreshSessionsForProject(project),
          };
        }),
      )
    ).sort((a, b) => a.project.localeCompare(b.project));
    setSessionGroups(groups);
    setSelectedProject((current) => current || requestedProject || runtime?.settings.defaultProject || names[0] || '');
    return groups;
  }, [refreshSessionsForProject, requestedProject, runtime?.settings.defaultProject, runtimeProvider, serviceRunning]);

  const loadActiveSession = useCallback(async (project: string, sessionId: string) => {
    if (!project || !sessionId || !serviceRunning) {
      return;
    }
    clearLocalCorePolling();
    updateTaskState('idle');
    setTyping(false);
    if (runtimeProvider === 'local_core') {
      const detail = await getThread(sessionId);
      applyLocalCoreThreadDetail(detail);
      return;
    }
    const detail = await getSession(project, sessionId, 200);
    lastSessionByProjectRef.current[project] = detail.id;
    setSelectedProject(project);
    setActiveSessionId(detail.id);
    setActiveSessionKey(detail.session_key);
    setActiveSessionName(detail.name);
    setActiveSessionAgentType(detail.agent_type || '');
    setActiveRunId('');
    setSessionGroups((current) => upsertThreadInGroup(current, project, toChatThreadSummary(project, detail)));
    holdBlankComposerRef.current = false;
    progressSequenceByTurnRef.current = {};
    const nextMessages = toMessages(detail.history || []);
    nextMessageOrderRef.current = nextMessages.length;
    pendingTurnRef.current = null;
    setMessages(nextMessages);
  }, [applyLocalCoreThreadDetail, clearLocalCorePolling, runtimeProvider, serviceRunning, updateTaskState]);

  const refreshRuntime = useCallback(async () => {
    const nextRuntime = await getRuntimeStatus();
    setRuntime(nextRuntime);
    if (!nextRuntime.service.lastError && !selectedProject) {
      setSelectedProject(requestedProject || nextRuntime.settings.defaultProject);
    }
  }, [requestedProject, selectedProject]);

  useEffect(() => {
    if (!serviceRunning) {
      setSessionGroups([]);
      setMessages([]);
      setActiveSessionAgentType('');
      setActiveRunId('');
      setBridgeError('');
      pendingTurnRef.current = null;
      nextMessageOrderRef.current = 0;
      progressSequenceByTurnRef.current = {};
      updateTaskState('idle');
      setTyping(false);
      clearLocalCorePolling();
      clearReplyTimeout();
      return;
    }
    void refreshProjectsAndSessions();
    void bridgeConnect();
  }, [clearLocalCorePolling, clearReplyTimeout, refreshProjectsAndSessions, serviceRunning, updateTaskState]);

  useEffect(() => {
    if (!selectedProject || !serviceRunning) {
      return;
    }

    const currentSessions = sessionsForSelectedProject;
    const activeInProject = currentSessions.find((session) => session.id === activeSessionId);
    if (activeInProject) {
      return;
    }

    const preferredSessionId = requestedProject === selectedProject ? requestedSessionId : '';
    const rememberedSessionId = lastSessionByProjectRef.current[selectedProject];
    if (!activeSessionId && holdBlankComposerRef.current) {
      return;
    }
    const targetSession =
      currentSessions.find((session) => session.id === preferredSessionId) ||
      currentSessions.find((session) => session.id === rememberedSessionId) ||
      currentSessions[0];

    if (targetSession) {
      setTyping(false);
      updateTaskState('idle');
      setBridgeError('');
      clearLocalCorePolling();
      clearReplyTimeout();
      void loadActiveSession(selectedProject, targetSession.id);
      return;
    }

    setTyping(false);
    updateTaskState('idle');
    setBridgeError('');
    clearReplyTimeout();
    setActiveSessionId('');
    setActiveSessionKey('');
    setActiveSessionName('');
    setActiveSessionAgentType('');
    setActiveRunId('');
    setMessages([]);
    pendingTurnRef.current = null;
    nextMessageOrderRef.current = 0;
    progressSequenceByTurnRef.current = {};
    clearLocalCorePolling();
  }, [
    activeSessionId,
    clearLocalCorePolling,
    clearReplyTimeout,
    loadActiveSession,
    requestedProject,
    requestedSessionId,
    selectedProject,
    serviceRunning,
    sessionsForSelectedProject,
    updateTaskState,
  ]);

  useEffect(() => {
    if (!selectedProject && !activeSessionId) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    if (selectedProject) {
      next.set('project', selectedProject);
    } else {
      next.delete('project');
    }
    if (activeSessionId) {
      next.set('session', activeSessionId);
    } else {
      next.delete('session');
    }
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [activeSessionId, searchParams, selectedProject, setSearchParams]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [renderedMessages, typing]);

  const handleBridgeEvent = useCallback((event: DesktopBridgeEvent) => {
    const eventProject = sessionProjectFromKey(event.sessionKey);
    if (eventProject) {
      void refreshSessionsForProject(eventProject);
    }

    if (!event.sessionKey || event.sessionKey !== activeSessionKey) {
      return;
    }

    switch (event.type) {
      case 'preview_start':
        clearActionStatuses();
        setTyping(true);
        updateTaskState('running');
        armReplyTimeout();
        setBridgeError('');
        setMessages((current) => {
          const previewId = event.previewHandle || crypto.randomUUID();
          const existing = current.find((message) => message.id === previewId);
          const next = current.filter((message) => !(message.preview && message.id === previewId));
          next.push({
            id: previewId,
            role: 'assistant',
            content: event.content || '',
            kind: 'progress',
            order: existing?.order ?? reserveAssistantMessageOrder(event.sessionKey),
            timestamp: existing?.timestamp || new Date().toISOString(),
            turnKey: event.replyCtx,
            preview: true,
          });
          return next;
        });
        break;
      case 'update_message':
        clearActionStatuses();
        setTyping(true);
        updateTaskState('running');
        armReplyTimeout();
        setBridgeError('');
        setMessages((current) =>
          current.some((message) => message.id === event.previewHandle)
            ? current.map((message) =>
                message.id === event.previewHandle ? { ...message, content: event.content || '' } : message,
              )
            : [
                ...current,
                {
                  id: event.previewHandle || crypto.randomUUID(),
                  role: 'assistant',
                  content: event.content || '',
                  kind: 'progress',
                  order: reserveAssistantMessageOrder(event.sessionKey),
                  timestamp: new Date().toISOString(),
                  turnKey: event.replyCtx,
                  preview: true,
                },
              ],
        );
        break;
      case 'delete_message':
        setMessages((current) => current.filter((message) => message.id !== event.previewHandle));
        break;
      case 'typing_start':
        clearActionStatuses();
        setTyping(true);
        updateTaskState('running');
        setBridgeError('');
        armReplyTimeout();
        break;
      case 'typing_stop':
        setTyping(false);
        clearReplyTimeout();
        pendingTurnRef.current = null;
        clearActionStatuses();
        updateTaskState('idle');
        finalizeTurnMessages(event.replyCtx);
        break;
      case 'reply':
        clearActionStatuses();
        setTyping(true);
        updateTaskState('running');
        setBridgeError('');
        armReplyTimeout();
        const replyMessageId = nextProgressMessageId(event.replyCtx);
        if (!isInternalProgressMessage(event.content) && event.replyCtx) {
          delete progressSequenceByTurnRef.current[event.replyCtx];
        }
        setBridgeError('');
        setMessages((current) => [
          ...current.filter((message) => !(message.preview && message.turnKey === event.replyCtx)),
          {
            id: replyMessageId,
            role: 'assistant',
            content: event.content || '',
            kind: 'progress',
            order: reserveAssistantMessageOrder(event.sessionKey),
            timestamp: new Date().toISOString(),
            turnKey: event.replyCtx,
          },
        ]);
        break;
      case 'buttons':
        clearReplyTimeout();
        setTyping(false);
        pendingTurnRef.current = null;
        setBridgeError('');
        clearActionStatuses();
        setMessages((current) => {
          const messageId = `${event.replyCtx || crypto.randomUUID()}-buttons`;
          const actionRows = normalizeBridgeActionRows(event.buttonRows || event.buttons);
          const isPermissionPrompt = isPermissionActionRow(actionRows);
          const interactivePermission = isPermissionPrompt && supportsInteractivePermission(activeSessionAgentType);
          const nextActions = isPermissionPrompt && !interactivePermission ? [] : actionRows;
          const nextStatus = isPermissionPrompt && !interactivePermission
            ? permissionSupportMessage(activeSessionAgentType)
            : undefined;
          const existing = current.find((message) => message.id === messageId);
          if (existing) {
            return current.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    content: event.content || message.content,
                    actions: nextActions,
                    actionReplyCtx: event.replyCtx,
                    actionPending: false,
                    actionMode: isPermissionPrompt ? 'permission' : 'generic',
                    actionInteractive: interactivePermission,
                    actionStatus: nextStatus,
                  }
                : message,
            );
          }
          return [
            ...current,
            {
              id: messageId,
              role: 'assistant',
              content: event.content || 'Permission required before continuing.',
              kind: 'progress',
              order: reserveAssistantMessageOrder(event.sessionKey),
              timestamp: new Date().toISOString(),
              turnKey: event.replyCtx,
              actions: nextActions,
              actionReplyCtx: event.replyCtx,
              actionPending: false,
              actionMode: isPermissionPrompt ? 'permission' : 'generic',
              actionInteractive: interactivePermission,
              actionStatus: nextStatus,
            },
          ];
        });
        updateTaskState(
          isPermissionActionRow(normalizeBridgeActionRows(event.buttonRows || event.buttons)) &&
            supportsInteractivePermission(activeSessionAgentType)
            ? 'awaiting_permission'
            : 'idle',
        );
        break;
      case 'card':
        clearReplyTimeout();
        setTyping(false);
        pendingTurnRef.current = null;
        clearActionStatuses();
        updateTaskState('idle');
        finalizeTurnMessages(event.replyCtx);
        setBridgeError('');
        setMessages((current) => [
          ...current,
          {
            id: `${event.replyCtx || crypto.randomUUID()}-card`,
            role: 'assistant',
            content: 'Interactive card received. Open the session in the standard Sessions view for full controls.',
            order: reserveAssistantMessageOrder(event.sessionKey),
            timestamp: new Date().toISOString(),
          },
        ]);
        break;
      default:
        break;
    }
  }, [
    activeSessionAgentType,
    activeSessionKey,
    armReplyTimeout,
    clearActionStatuses,
    clearReplyTimeout,
    finalizeTurnMessages,
    nextProgressMessageId,
    refreshSessionsForProject,
    reserveAssistantMessageOrder,
    updateTaskState,
  ]);

  useEffect(() => {
    void refreshRuntime().finally(() => setLoading(false));
    const stopRuntime = onRuntimeEvent((nextRuntime) => {
      setRuntime(nextRuntime);
      if (nextRuntime.phase === 'stopped' || nextRuntime.phase === 'error') {
        setTyping(false);
        clearReplyTimeout();
        updateTaskState('idle');
      }
    });
    const stopBridge = onBridgeEvent((event) => {
      handleBridgeEvent(event);
    });
    return () => {
      clearLocalCorePolling();
      clearReplyTimeout();
      stopRuntime();
      stopBridge();
    };
  }, [clearLocalCorePolling, clearReplyTimeout, handleBridgeEvent, refreshRuntime, updateTaskState]);

  const ensureSession = useCallback(async () => {
    if (!selectedProject) {
      throw new Error('Choose a project first');
    }
    if (activeSessionId) {
      return { id: activeSessionId, sessionKey: activeSessionKey };
    }

    if (runtimeProvider === 'local_core') {
      const detail = await createThread(selectedProject, `${branding.newThreadLabel} ${new Date().toLocaleTimeString()}`);
      applyLocalCoreThreadDetail(detail);
      await refreshSessionsForProject(selectedProject);
      return { id: detail.id, sessionKey: detail.bridgeSessionKey || '' };
    }

    const chatId = crypto.randomUUID().slice(0, 8);
    const sessionKey = `desktop:${selectedProject}:${chatId}`;
    const created = await createSession(selectedProject, {
      session_key: sessionKey,
      name: `Desktop ${new Date().toLocaleTimeString()}`,
    });
    const nextSessions = await refreshSessionsForProject(selectedProject);
    const matched = nextSessions.find((session) => session.bridgeSessionKey === sessionKey);
    const nextId = created.id || matched?.id || '';
    if (nextId) {
      lastSessionByProjectRef.current[selectedProject] = nextId;
    }
    holdBlankComposerRef.current = false;
    setActiveSessionId(nextId);
    setActiveSessionKey(sessionKey);
    setActiveSessionName(created.name);
    if (nextId) {
      await loadActiveSession(selectedProject, nextId);
    } else {
      setMessages([]);
      pendingTurnRef.current = null;
      nextMessageOrderRef.current = 0;
      progressSequenceByTurnRef.current = {};
    }
    return { id: nextId, sessionKey };
  }, [
    activeSessionId,
    activeSessionKey,
    applyLocalCoreThreadDetail,
    branding.newThreadLabel,
    loadActiveSession,
    refreshSessionsForProject,
    runtimeProvider,
    selectedProject,
  ]);

  const handleSend = useCallback(async () => {
    if (!draft.trim() || !selectedProject) {
      return;
    }
    const content = draft.trim();
    const userOrder = reserveNextMessageOrder();
    setDraft('');
    setSending(true);

    try {
      const ensured = await ensureSession();
      pendingTurnRef.current = { sessionKey: ensured.sessionKey, userOrder };
      setMessages((current) => [
        ...current,
        { id: `${crypto.randomUUID()}-user`, role: 'user', content, order: userOrder, timestamp: new Date().toISOString() },
      ]);
      updateTaskState('running');
      setTyping(runtimeProvider !== 'local_core');
      setBridgeError('');
      if (runtimeProvider === 'local_core') {
        clearReplyTimeout();
        const result = await sendThreadMessage(ensured.id, content);
        setActiveRunId(result.runId);
        startLocalCoreThreadPolling(
          ensured.id,
          messages.filter((message) => message.role === 'assistant').length,
        );
      } else {
        armReplyTimeout();
        await bridgeSendMessage({
          project: selectedProject,
          chatId: ensured.sessionKey.split(':')[2] || 'main',
          content,
        });
      }
    } catch (error) {
      clearReplyTimeout();
      clearLocalCorePolling();
      pendingTurnRef.current = null;
      setTyping(false);
      updateTaskState('idle');
      setBridgeError(error instanceof Error ? error.message : 'Failed to send the message.');
    } finally {
      setSending(false);
    }
  }, [
    armReplyTimeout,
    clearLocalCorePolling,
    clearReplyTimeout,
    draft,
    ensureSession,
    messages,
    reserveNextMessageOrder,
    runtimeProvider,
    selectedProject,
    startLocalCoreThreadPolling,
    updateTaskState,
  ]);

  const handleStopTask = useCallback(async () => {
    if (!selectedProject || taskState === 'stopping') {
      return;
    }
    setBridgeError('');
    clearReplyTimeout();
    clearLocalCorePolling();
    setTyping(false);
    updateTaskState('stopping');
    try {
      if (runtimeProvider === 'local_core' && activeRunId) {
        await interruptRun(activeRunId);
      } else if (activeSessionKey) {
        const [, project = selectedProject, chatId = 'main'] = activeSessionKey.split(':');
        await bridgeSendMessage({
          project,
          chatId,
          content: '/stop',
        });
      } else {
        throw new Error('No active run to stop.');
      }
      window.setTimeout(() => {
        if (taskStateRef.current === 'stopping') {
          updateTaskState('idle');
        }
      }, 1500);
    } catch (error) {
      updateTaskState('idle');
      setBridgeError(error instanceof Error ? error.message : 'Failed to stop the current task.');
    }
  }, [activeRunId, activeSessionKey, clearLocalCorePolling, clearReplyTimeout, runtimeProvider, selectedProject, taskState, updateTaskState]);

  const handleCreateNew = useCallback(async () => {
    if (!selectedProject) {
      return;
    }
    if (runtimeProvider === 'local_core') {
      setPendingSessionAction('rename');
      try {
        const detail = await createThread(selectedProject, `${branding.newThreadLabel} ${new Date().toLocaleTimeString()}`);
        await refreshSessionsForProject(selectedProject);
        applyLocalCoreThreadDetail(detail);
        const next = new URLSearchParams(searchParams);
        next.set('project', selectedProject);
        next.set('session', detail.id);
        setSearchParams(next, { replace: true });
      } finally {
        setPendingSessionAction(null);
      }
      return;
    }
    holdBlankComposerRef.current = true;
    setActiveSessionId('');
    setActiveSessionKey('');
    setActiveSessionName('');
    setActiveSessionAgentType('');
    setActiveRunId('');
    setMessages([]);
    setTyping(false);
    updateTaskState('idle');
    setBridgeError('');
    pendingTurnRef.current = null;
    nextMessageOrderRef.current = 0;
    progressSequenceByTurnRef.current = {};
    clearLocalCorePolling();
    clearReplyTimeout();
    const next = new URLSearchParams(searchParams);
    next.delete('session');
    setSearchParams(next, { replace: true });
  }, [
    applyLocalCoreThreadDetail,
    branding.newThreadLabel,
    clearLocalCorePolling,
    clearReplyTimeout,
    refreshSessionsForProject,
    runtimeProvider,
    searchParams,
    selectedProject,
    setSearchParams,
    updateTaskState,
  ]);

  const openRenameModal = useCallback((project: string, session: ChatThreadSummary) => {
    setRenameTarget({ project, id: session.id, name: session.name });
    setRenameDraft(session.name);
  }, []);

  const handleRenameSession = useCallback(async () => {
    if (!renameTarget) {
      return;
    }
    setPendingSessionAction('rename');
    try {
      const name = renameDraft.trim();
      if (runtimeProvider === 'local_core') {
        await renameThread(renameTarget.id, name);
      } else {
        await renameSession(renameTarget.project, renameTarget.id, { name });
      }
      if (renameTarget.id === activeSessionId) {
        setActiveSessionName(name);
      }
      await refreshSessionsForProject(renameTarget.project);
      setRenameTarget(null);
      setRenameDraft('');
    } finally {
      setPendingSessionAction(null);
    }
  }, [activeSessionId, refreshSessionsForProject, renameDraft, renameTarget, runtimeProvider]);

  const handleDeleteSession = useCallback(async () => {
    if (!deleteTarget) {
      return;
    }
    setPendingSessionAction('delete');
    try {
      if (runtimeProvider === 'local_core') {
        await deleteCoreThread(deleteTarget.id);
      } else {
        await deleteSession(deleteTarget.project, deleteTarget.id);
      }
      if (deleteTarget.id === activeSessionId) {
        setActiveSessionId('');
        setActiveSessionKey('');
        setActiveSessionName('');
        setActiveSessionAgentType('');
        setActiveRunId('');
        setMessages([]);
        setTyping(false);
        updateTaskState('idle');
      }
      await refreshSessionsForProject(deleteTarget.project);
      setDeleteTarget(null);
    } finally {
      setPendingSessionAction(null);
    }
  }, [activeSessionId, deleteTarget, refreshSessionsForProject, runtimeProvider, updateTaskState]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400 animate-pulse">Loading...</div>;
  }

  return (
    <>
      <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-6 h-[calc(100vh-8rem)] animate-fade-in">
        <Card className="overflow-hidden p-0 flex flex-col">
          <div className="p-5 border-b border-gray-200/80 dark:border-white/[0.08] space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{branding.chatHeading}</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {branding.chatDescription}
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => void refreshRuntime()}>
                <RotateCw size={14} />
              </Button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{branding.scopeLabel}</label>
              <select
                value={selectedProject}
                onChange={(event) => setSelectedProject(event.target.value)}
                data-testid="desktop-chat-project-select"
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300/90 dark:border-white/[0.1] bg-white/90 dark:bg-[rgba(0,0,0,0.45)] text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent/45 focus:border-accent"
              >
                <option value="">{branding.scopeSelectPlaceholder}</option>
                {projects.map((project) => (
                  <option key={project} value={project}>
                    {project}
                  </option>
                ))}
              </select>
            </div>

            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                value={sessionSearch}
                onChange={(event) => setSessionSearch(event.target.value)}
                placeholder={branding.searchPlaceholder}
                data-testid="desktop-chat-session-search"
                className="pl-9"
              />
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void startDesktopService().then(refreshRuntime)}
                disabled={runtime?.phase === 'starting' || serviceRunning}
                data-testid="desktop-chat-start-service"
              >
                {serviceRunning ? formatRuntimePhase(runtime?.phase) : runtime?.phase === 'starting' ? branding.startingRuntimeLabel : branding.startRuntimeLabel}
              </Button>
              <Button size="sm" variant="secondary" onClick={handleCreateNew} data-testid="desktop-chat-new-chat">
                <MessageSquarePlus size={14} /> {branding.newThreadLabel}
              </Button>
            </div>

            {runtime?.service.lastError && (
              <div className="text-xs rounded-lg border border-red-200 bg-red-50 text-red-600 px-3 py-2 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
                {runtime.service.lastError}
              </div>
            )}
            {runtime?.pendingRestart && (
              <div className="text-xs rounded-lg border border-amber-200 bg-amber-50 text-amber-700 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
                {branding.pendingRestartLabel}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            {!selectedProject && filteredSessionGroups.length === 0 ? (
              <EmptyState message={branding.emptySelectionLabel} />
            ) : filteredSessionGroups.length === 0 ? (
              <EmptyState message={branding.emptySearchLabel} />
            ) : (
              filteredSessionGroups.map((group) => (
                <section key={group.project} className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setSelectedProject(group.project)}
                    data-testid="desktop-chat-session-group"
                    data-project={group.project}
                    className={cn(
                      'w-full flex items-center justify-between rounded-xl px-3 py-2 text-left transition-colors',
                      group.project === selectedProject
                        ? 'bg-accent/10 text-gray-900 dark:text-white'
                        : 'bg-gray-100/60 dark:bg-white/[0.04] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.08]',
                    )}
                  >
                    <div>
                      <p className="text-sm font-medium">{group.project}</p>
                      <p className="text-[10px] uppercase tracking-wide opacity-70">{group.sessions.length} {branding.collectionLabel}</p>
                    </div>
                    {group.project === selectedProject && (
                      <span className="text-[10px] uppercase tracking-wide text-accent">{branding.activeScopeLabel}</span>
                    )}
                  </button>

                  {group.sessions.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-gray-200/80 dark:border-white/[0.08] px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {branding.emptyThreadsLabel}
                    </div>
                  ) : (
                    group.sessions.map((session) => (
                      <div
                        key={session.id}
                        data-testid="desktop-chat-session-row"
                        data-session-id={session.id}
                        data-project={group.project}
                        className={cn(
                          'group rounded-xl border px-4 py-3 transition-colors',
                          session.id === activeSessionId
                            ? 'border-accent/40 bg-accent/10'
                            : 'border-transparent bg-gray-100/70 dark:bg-white/[0.04] hover:bg-gray-100 dark:hover:bg-white/[0.08]',
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <button
                            type="button"
                            onClick={() => void loadActiveSession(group.project, session.id)}
                            data-testid="desktop-chat-session-open"
                            data-session-id={session.id}
                            data-project={group.project}
                            className="min-w-0 flex-1 text-left"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <span className="font-medium text-sm text-gray-900 dark:text-white truncate block">
                                  {session.name}
                                </span>
                                <p className="text-[10px] text-gray-400 mt-1">
                                  {timeAgo(session.updatedAt || session.createdAt)}
                                </p>
                              </div>
                              {session.live ? (
                                <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 shrink-0">
                                  <Circle size={6} className="fill-current" /> live
                                </span>
                              ) : (
                                <span className="text-[10px] text-gray-400 shrink-0">offline</span>
                              )}
                            </div>
                            {session.excerpt && (
                              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2 line-clamp-2">
                                {session.excerpt.replace(/\n/g, ' ')}
                              </p>
                            )}
                            {showSessionKey && session.bridgeSessionKey && (
                              <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-1">
                                {session.bridgeSessionKey}
                              </p>
                            )}
                          </button>

                          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openRenameModal(group.project, session)}
                              data-testid="desktop-chat-session-rename"
                              data-session-id={session.id}
                              data-project={group.project}
                            >
                              <Pencil size={14} />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-600"
                              data-testid="desktop-chat-session-delete"
                              data-session-id={session.id}
                              data-project={group.project}
                              onClick={() =>
                                setDeleteTarget({
                                  project: group.project,
                                  id: session.id,
                                  name: session.name,
                                })
                              }
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </section>
              ))
            )}
          </div>
        </Card>

        <Card className="flex flex-col min-h-0">
          <div className="pb-4 border-b border-gray-200/80 dark:border-white/[0.08]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2
                  className="text-lg font-semibold text-gray-900 dark:text-white"
                  data-testid="desktop-chat-active-title"
                >
                  {activeSessionName || branding.activeConversationFallback}
                </h2>
                <div className="flex items-center gap-2 mt-1 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
                  {selectedProject ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-white/[0.06] px-2 py-0.5">
                      {selectedProject}
                    </span>
                  ) : (
                    <span>{branding.startConversationLabel}</span>
                  )}
                  {showSessionKey && activeSessionKey ? <span>{activeSessionKey}</span> : null}
                  <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-white/[0.06] px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-300">
                    {formatRuntimePhase(runtime?.phase)}
                  </span>
                  {transportReady ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <Circle size={6} className="fill-current" /> {branding.runtimeOnlineLabel}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <WifiOff size={12} /> {branding.runtimeOfflineLabel}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-6 space-y-5">
            {renderedMessages.length === 0 ? (
              <p className="text-center text-sm text-gray-400 py-12">
                {branding.emptyConversationLabel}
              </p>
            ) : (
              renderedMessages.map((message) => {
                const isUser = message.role === 'user';
                return (
                  <div key={message.id} className={cn('flex gap-3', isUser ? 'justify-end' : 'justify-start')}>
                    {!isUser && (
                      <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-1">
                        <Bot size={16} className="text-accent" />
                      </div>
                    )}
                    <div
                      data-testid="desktop-chat-message"
                      data-role={message.role}
                      data-kind={message.kind || 'final'}
                      data-order={String(message.order)}
                      data-timestamp={message.timestamp || ''}
                      className={cn(
                        'rounded-2xl px-5 py-3.5 text-sm',
                        isUser
                          ? 'max-w-[70%] bg-accent text-black rounded-br-md'
                          : message.kind === 'progress'
                            ? 'max-w-[85%] bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 text-amber-900 dark:text-amber-100 rounded-bl-md shadow-sm'
                            : 'max-w-[85%] bg-white dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700/60 text-gray-900 dark:text-gray-100 rounded-bl-md shadow-sm',
                      )}
                    >
                      <div className={cn('mb-2 flex items-center gap-2 text-[10px]', isUser ? 'justify-end text-black/70' : 'text-gray-400 dark:text-gray-500')}>
                        {!isUser && message.kind === 'progress' && (
                          <span className="uppercase tracking-wide text-amber-600 dark:text-amber-300">
                            process
                          </span>
                        )}
                        {formatMessageTimestamp(message.timestamp) && (
                          <span data-testid="desktop-chat-message-timestamp">{formatMessageTimestamp(message.timestamp)}</span>
                        )}
                      </div>
                      <ChatMarkdown content={message.content} isUser={isUser} />
                      {!isUser && message.actions && message.actions.length > 0 && (
                        <div className="mt-4 space-y-2">
                          {message.actions.map((row, rowIndex) => (
                            <div key={`${message.id}-actions-${rowIndex}`} className="flex flex-wrap gap-2">
                              {row.map((action) => (
                                <Button
                                  key={`${message.id}-${action.data || action.text}`}
                                  size="sm"
                                  variant={String(action.data || '').includes('deny') ? 'danger' : 'secondary'}
                                  onClick={() => void handleBridgeAction(message, action)}
                                  disabled={Boolean(message.actionPending || pendingBridgeActionId)}
                                  loading={pendingBridgeActionId === message.id}
                                  data-testid="desktop-chat-action-button"
                                >
                                  {action.text || action.data}
                                </Button>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                      {!isUser && message.actionStatus && (
                        <p
                          className={cn(
                            'mt-3 text-xs',
                            message.actionInteractive
                              ? 'text-gray-500 dark:text-gray-400'
                              : 'text-amber-700 dark:text-amber-200',
                          )}
                          data-testid="desktop-chat-action-status"
                        >
                          {message.actionStatus}
                        </p>
                      )}
                      {message.preview && (
                        <p className="mt-2 text-[10px] uppercase tracking-wide text-accent">stream preview</p>
                      )}
                    </div>
                    {isUser && (
                      <div className="w-8 h-8 rounded-lg bg-gray-200 dark:bg-gray-700 flex items-center justify-center shrink-0 mt-1">
                        <User size={16} className="text-gray-500" />
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {taskHint && (
              <div className="flex items-center gap-2 text-sm text-gray-400" data-testid="desktop-chat-task-hint">
                <Circle size={8} className="fill-current animate-pulse" /> {taskHint}
              </div>
            )}
            {bridgeError && (
              <div
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200"
                data-testid="desktop-chat-bridge-error"
              >
                {bridgeError}
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="border-t border-gray-200/80 dark:border-white/[0.08] pt-4">
            <div className="flex gap-3">
              <Textarea
                data-testid="desktop-chat-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !taskRunning) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                rows={4}
                placeholder={!serviceRunning ? branding.startFirstPlaceholder : !transportReady ? branding.waitingRuntimePlaceholder : taskRunning ? 'Task is running. Click stop to interrupt.' : branding.sendPlaceholder}
                disabled={!serviceRunning || !transportReady || sending || !selectedProject || taskRunning}
                className="min-h-[112px] resize-none"
              />
              {taskRunning ? (
                <Button
                  variant="danger"
                  onClick={() => void handleStopTask()}
                  disabled={(!activeSessionKey && !activeRunId) || taskState === 'stopping'}
                  data-testid="desktop-chat-stop-task"
                  className="min-w-[112px]"
                >
                  {taskState === 'stopping' ? (
                    <>
                      <LoaderCircle size={16} className="animate-spin" /> Stopping…
                    </>
                  ) : (
                    <>
                      <LoaderCircle size={16} className="animate-spin" /> Stop task
                    </>
                  )}
                </Button>
              ) : (
                <Button
                  onClick={() => void handleSend()}
                  disabled={!draft.trim() || !serviceRunning || !transportReady || sending || !selectedProject}
                  data-testid="desktop-chat-send"
                  className="min-w-[48px]"
                >
                  <Send size={16} />
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>

      <Modal open={Boolean(renameTarget)} onClose={() => setRenameTarget(null)} title="Rename session">
        <div className="space-y-4">
          <Input
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onInput={(event) => setRenameDraft((event.target as HTMLInputElement).value)}
            placeholder="Session name"
            data-testid="desktop-chat-rename-input"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRenameTarget(null)} data-testid="desktop-chat-rename-cancel">
              Cancel
            </Button>
            <Button
              onClick={() => void handleRenameSession()}
              loading={pendingSessionAction === 'rename'}
              disabled={!renameDraft.trim()}
              data-testid="desktop-chat-rename-save"
            >
              Save name
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete session">
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Delete <span className="font-medium text-gray-900 dark:text-white">{deleteTarget?.name}</span>? This removes the
            saved conversation history for that session.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)} data-testid="desktop-chat-delete-cancel">
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleDeleteSession()}
              loading={pendingSessionAction === 'delete'}
              data-testid="desktop-chat-delete-confirm"
            >
              Delete session
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
