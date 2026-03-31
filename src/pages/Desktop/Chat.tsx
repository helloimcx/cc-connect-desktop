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

const ASSISTANT_REPLY_TIMEOUT_MS = 90000;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind?: 'final' | 'progress';
  order: number;
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
  sessions: Session[];
}

interface SessionActionTarget {
  id: string;
  name: string;
  project: string;
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
  }));
}

function sortChatMessages(messages: ChatMessage[]) {
  return [...messages].sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.id.localeCompare(b.id);
  });
}

function sortDesktopSessions(a: Session, b: Session) {
  if (a.live !== b.live) {
    return a.live ? -1 : 1;
  }
  return (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '');
}

function timeAgo(iso: string) {
  if (!iso) {
    return '';
  }
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) {
    return 'just now';
  }
  if (mins < 60) {
    return `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
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

function sessionLabel(session: Session) {
  return session.name || session.user_name || session.chat_name || `Session ${session.id.slice(0, 8)}`;
}

function sessionMatchesSearch(session: Session, query: string) {
  if (!query) {
    return true;
  }
  const haystack = [
    sessionLabel(session),
    session.session_key,
    session.last_message?.content || '',
    session.user_name || '',
    session.chat_name || '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
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

function upsertSessionGroup(groups: SessionGroup[], project: string, sessions: Session[]) {
  const next = groups.filter((group) => group.project !== project);
  next.push({ project, sessions });
  return next.sort((a, b) => a.project.localeCompare(b.project));
}

function isPermissionActionRow(rows: DesktopBridgeButtonOption[][]) {
  return rows.some((row) => row.some((action) => isPermissionButtonOption(action)));
}

function permissionSupportMessage(agentType?: string) {
  const name = agentType || 'This agent';
  return `${name} cannot continue interactive permission approvals in Desktop Chat. Switch to claudecode/acp or adjust the agent permissions/work_dir before retrying.`;
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

export default function DesktopChat() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [runtime, setRuntime] = useState<DesktopRuntimeStatus | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [sessionGroups, setSessionGroups] = useState<SessionGroup[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [activeSessionKey, setActiveSessionKey] = useState('');
  const [activeSessionName, setActiveSessionName] = useState('');
  const [activeSessionAgentType, setActiveSessionAgentType] = useState('');
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
  const requestedProject = searchParams.get('project') || '';
  const requestedSessionId = searchParams.get('session') || '';

  const serviceRunning = runtime?.phase === 'api_ready' || runtime?.phase === 'bridge_ready';
  const bridgeConnected = runtime?.bridge.status === 'connected';
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
          sessionMatchesSearch(session, query),
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
          ? 'Permission response was sent, but the agent did not continue. This agent or request may not support desktop continuation.'
          : 'Agent did not respond in time. Check Desktop Runtime logs or adjust the model/provider.',
      );
    }, ASSISTANT_REPLY_TIMEOUT_MS);
  }, [clearReplyTimeout, updateTaskState]);

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

  const handleBridgeAction = useCallback(async (message: ChatMessage, action: DesktopBridgeButtonOption) => {
    if (!activeSessionKey) {
      return;
    }
    const [, project = selectedProject, chatId = 'main'] = activeSessionKey.split(':');
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
        { id: actionMessageId, role: 'user', content: actionLabel, order: userOrder },
      ]);
      await bridgeSendMessage({
        project,
        chatId,
        content: actionContent,
      });
      sent = true;
      setBridgeError('');
      setTyping(true);
      clearReplyTimeout();
      clearActionStatuses();
      if (message.actionMode === 'permission' && message.actionInteractive) {
        updateTaskState('permission_submitted');
        armReplyTimeout('permission_continue');
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
        armReplyTimeout();
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
    activeSessionKey,
    armReplyTimeout,
    clearActionStatuses,
    clearReplyTimeout,
    reserveNextMessageOrder,
    selectedProject,
    updateTaskState,
  ]);

  const refreshSessionsForProject = useCallback(async (project: string) => {
    if (!project || !serviceRunning) {
      return [];
    }
    const data = await listSessions(project);
    const nextSessions = (data.sessions || []).filter(sessionMatchesDesktop).sort(sortDesktopSessions);
    const activeSession = nextSessions.find((session) => session.id === activeSessionId);
    if (activeSession?.agent_type) {
      setActiveSessionAgentType(activeSession.agent_type);
    }
    setSessionGroups((current) => upsertSessionGroup(current, project, nextSessions));
    return nextSessions;
  }, [activeSessionId, serviceRunning]);

  const refreshProjectsAndSessions = useCallback(async () => {
    if (!serviceRunning) {
      setProjects([]);
      setSessionGroups([]);
      return [];
    }
    const result = await listProjects();
    const names = (result.projects || []).map((project) => project.name);
    setProjects(names);
    const groups = (
      await Promise.all(
        names.map(async (project) => {
          const data = await listSessions(project);
          return {
            project,
            sessions: (data.sessions || []).filter(sessionMatchesDesktop).sort(sortDesktopSessions),
          };
        }),
      )
    ).sort((a, b) => a.project.localeCompare(b.project));
    setSessionGroups(groups);
    setSelectedProject((current) => current || requestedProject || runtime?.settings.defaultProject || names[0] || '');
    return groups;
  }, [requestedProject, runtime?.settings.defaultProject, serviceRunning]);

  const loadActiveSession = useCallback(async (project: string, sessionId: string) => {
    if (!project || !sessionId || !serviceRunning) {
      return;
    }
    const detail = await getSession(project, sessionId, 200);
    lastSessionByProjectRef.current[project] = detail.id;
    setSelectedProject(project);
    setActiveSessionId(detail.id);
    setActiveSessionKey(detail.session_key);
    setActiveSessionName(detail.name);
    setActiveSessionAgentType(detail.agent_type || '');
    holdBlankComposerRef.current = false;
    progressSequenceByTurnRef.current = {};
    const nextMessages = toMessages(detail.history || []);
    nextMessageOrderRef.current = nextMessages.length;
    pendingTurnRef.current = null;
    updateTaskState(detail.live ? 'running' : 'idle');
    setTyping(false);
    setMessages(nextMessages);
  }, [serviceRunning, updateTaskState]);

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
      setBridgeError('');
      pendingTurnRef.current = null;
      nextMessageOrderRef.current = 0;
      progressSequenceByTurnRef.current = {};
      updateTaskState('idle');
      setTyping(false);
      clearReplyTimeout();
      return;
    }
    void refreshProjectsAndSessions();
    void bridgeConnect();
  }, [clearReplyTimeout, refreshProjectsAndSessions, serviceRunning, updateTaskState]);

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
    setMessages([]);
    pendingTurnRef.current = null;
    nextMessageOrderRef.current = 0;
    progressSequenceByTurnRef.current = {};
  }, [
    activeSessionId,
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
      clearReplyTimeout();
      stopRuntime();
      stopBridge();
    };
  }, [clearReplyTimeout, handleBridgeEvent, refreshRuntime, updateTaskState]);

  const ensureSession = useCallback(async () => {
    if (!selectedProject) {
      throw new Error('Choose a project first');
    }
    if (activeSessionId && activeSessionKey && sessionProjectFromKey(activeSessionKey) === selectedProject) {
      return { id: activeSessionId, sessionKey: activeSessionKey };
    }

    const chatId = crypto.randomUUID().slice(0, 8);
    const sessionKey = `desktop:${selectedProject}:${chatId}`;
    const created = await createSession(selectedProject, {
      session_key: sessionKey,
      name: `Desktop ${new Date().toLocaleTimeString()}`,
    });
    const nextSessions = await refreshSessionsForProject(selectedProject);
    const matched = nextSessions.find((session) => session.session_key === sessionKey);
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
  }, [activeSessionId, activeSessionKey, loadActiveSession, refreshSessionsForProject, selectedProject]);

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
        { id: `${crypto.randomUUID()}-user`, role: 'user', content, order: userOrder },
      ]);
      updateTaskState('running');
      setTyping(true);
      setBridgeError('');
      armReplyTimeout();
      await bridgeSendMessage({
        project: selectedProject,
        chatId: ensured.sessionKey.split(':')[2] || 'main',
        content,
      });
    } catch (error) {
      clearReplyTimeout();
      pendingTurnRef.current = null;
      setTyping(false);
      updateTaskState('idle');
      setBridgeError(error instanceof Error ? error.message : 'Failed to send the message.');
    } finally {
      setSending(false);
    }
  }, [armReplyTimeout, clearReplyTimeout, draft, ensureSession, reserveNextMessageOrder, selectedProject, updateTaskState]);

  const handleStopTask = useCallback(async () => {
    if (!selectedProject || !activeSessionKey || taskState === 'stopping') {
      return;
    }
    const [, project = selectedProject, chatId = 'main'] = activeSessionKey.split(':');
    setBridgeError('');
    clearReplyTimeout();
    setTyping(false);
    updateTaskState('stopping');
    try {
      await bridgeSendMessage({
        project,
        chatId,
        content: '/stop',
      });
      window.setTimeout(() => {
        if (taskStateRef.current === 'stopping') {
          updateTaskState('idle');
        }
      }, 1500);
    } catch (error) {
      updateTaskState('idle');
      setBridgeError(error instanceof Error ? error.message : 'Failed to stop the current task.');
    }
  }, [activeSessionKey, clearReplyTimeout, selectedProject, taskState, updateTaskState]);

  const handleCreateNew = useCallback(() => {
    holdBlankComposerRef.current = true;
    setActiveSessionId('');
    setActiveSessionKey('');
    setActiveSessionName('');
    setActiveSessionAgentType('');
    setMessages([]);
    setTyping(false);
    updateTaskState('idle');
    setBridgeError('');
    pendingTurnRef.current = null;
    nextMessageOrderRef.current = 0;
    progressSequenceByTurnRef.current = {};
    clearReplyTimeout();
    const next = new URLSearchParams(searchParams);
    next.delete('session');
    setSearchParams(next, { replace: true });
  }, [clearReplyTimeout, searchParams, setSearchParams, updateTaskState]);

  const openRenameModal = useCallback((project: string, session: Session) => {
    setRenameTarget({ project, id: session.id, name: sessionLabel(session) });
    setRenameDraft(sessionLabel(session));
  }, []);

  const handleRenameSession = useCallback(async () => {
    if (!renameTarget) {
      return;
    }
    setPendingSessionAction('rename');
    try {
      const name = renameDraft.trim();
      await renameSession(renameTarget.project, renameTarget.id, { name });
      if (renameTarget.id === activeSessionId) {
        setActiveSessionName(name);
      }
      await refreshSessionsForProject(renameTarget.project);
      setRenameTarget(null);
      setRenameDraft('');
    } finally {
      setPendingSessionAction(null);
    }
  }, [activeSessionId, refreshSessionsForProject, renameDraft, renameTarget]);

  const handleDeleteSession = useCallback(async () => {
    if (!deleteTarget) {
      return;
    }
    setPendingSessionAction('delete');
    try {
      await deleteSession(deleteTarget.project, deleteTarget.id);
      if (deleteTarget.id === activeSessionId) {
        setActiveSessionId('');
        setActiveSessionKey('');
        setActiveSessionName('');
        setActiveSessionAgentType('');
        setMessages([]);
        setTyping(false);
        updateTaskState('idle');
      }
      await refreshSessionsForProject(deleteTarget.project);
      setDeleteTarget(null);
    } finally {
      setPendingSessionAction(null);
    }
  }, [activeSessionId, deleteTarget, refreshSessionsForProject, updateTaskState]);

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
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Desktop Chat</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Search sessions, jump across projects, and keep one live desktop conversation open.
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => void refreshRuntime()}>
                <RotateCw size={14} />
              </Button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Compose in project</label>
              <select
                value={selectedProject}
                onChange={(event) => setSelectedProject(event.target.value)}
                data-testid="desktop-chat-project-select"
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300/90 dark:border-white/[0.1] bg-white/90 dark:bg-[rgba(0,0,0,0.45)] text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent/45 focus:border-accent"
              >
                <option value="">Select a project</option>
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
                placeholder="Search sessions, users, or message preview"
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
                {serviceRunning ? formatRuntimePhase(runtime?.phase) : runtime?.phase === 'starting' ? 'Starting…' : 'Start Service'}
              </Button>
              <Button size="sm" variant="secondary" onClick={handleCreateNew} data-testid="desktop-chat-new-chat">
                <MessageSquarePlus size={14} /> New chat
              </Button>
            </div>

            {runtime?.service.lastError && (
              <div className="text-xs rounded-lg border border-red-200 bg-red-50 text-red-600 px-3 py-2 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
                {runtime.service.lastError}
              </div>
            )}
            {runtime?.pendingRestart && (
              <div className="text-xs rounded-lg border border-amber-200 bg-amber-50 text-amber-700 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
                The latest config is already saved, but this chat is still using the previous runtime state. Restart the
                desktop service to apply it.
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            {!selectedProject && filteredSessionGroups.length === 0 ? (
              <EmptyState message="Select a project to start messaging." />
            ) : filteredSessionGroups.length === 0 ? (
              <EmptyState message="No matching sessions." />
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
                      <p className="text-[10px] uppercase tracking-wide opacity-70">{group.sessions.length} sessions</p>
                    </div>
                    {group.project === selectedProject && (
                      <span className="text-[10px] uppercase tracking-wide text-accent">active project</span>
                    )}
                  </button>

                  {group.sessions.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-gray-200/80 dark:border-white/[0.08] px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      No desktop sessions yet.
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
                                  {sessionLabel(session)}
                                </span>
                                <p className="text-[10px] text-gray-400 mt-1">
                                  {timeAgo(session.updated_at || session.created_at)}
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
                            {session.last_message?.content && (
                              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2 line-clamp-2">
                                {session.last_message.content.replace(/\n/g, ' ')}
                              </p>
                            )}
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-1">
                              {session.session_key}
                            </p>
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
                                  name: sessionLabel(session),
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
                  {activeSessionName || 'New desktop conversation'}
                </h2>
                <div className="flex items-center gap-2 mt-1 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
                  {selectedProject ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-white/[0.06] px-2 py-0.5">
                      {selectedProject}
                    </span>
                  ) : (
                    <span>Select a project to start chatting.</span>
                  )}
                  {activeSessionKey ? <span>{activeSessionKey}</span> : null}
                  <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-white/[0.06] px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-300">
                    {formatRuntimePhase(runtime?.phase)}
                  </span>
                  {bridgeConnected ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <Circle size={6} className="fill-current" /> bridge online
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <WifiOff size={12} /> bridge offline
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-6 space-y-5">
            {renderedMessages.length === 0 ? (
              <p className="text-center text-sm text-gray-400 py-12">
                Send a message to create a desktop session in the selected project.
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
                      className={cn(
                        'rounded-2xl px-5 py-3.5 text-sm',
                        isUser
                          ? 'max-w-[70%] bg-accent text-black rounded-br-md'
                          : message.kind === 'progress'
                            ? 'max-w-[85%] bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 text-amber-900 dark:text-amber-100 rounded-bl-md shadow-sm'
                            : 'max-w-[85%] bg-white dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700/60 text-gray-900 dark:text-gray-100 rounded-bl-md shadow-sm',
                      )}
                    >
                      {!isUser && message.kind === 'progress' && (
                        <p className="mb-2 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-300">
                          process
                        </p>
                      )}
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
                placeholder={!serviceRunning ? 'Start the service first' : !bridgeConnected ? 'Waiting for the desktop bridge to connect' : taskRunning ? 'Task is running. Click stop to interrupt.' : 'Send a message to the desktop channel'}
                disabled={!serviceRunning || !bridgeConnected || sending || !selectedProject || taskRunning}
                className="min-h-[112px] resize-none"
              />
              {taskRunning ? (
                <Button
                  variant="danger"
                  onClick={() => void handleStopTask()}
                  disabled={!activeSessionKey || taskState === 'stopping'}
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
                  disabled={!draft.trim() || !serviceRunning || !bridgeConnected || sending || !selectedProject}
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
