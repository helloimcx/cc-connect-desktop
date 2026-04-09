import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listProjects } from '@/api/projects';
import { createSession, deleteSession, getSession, listSessions, renameSession } from '@/api/sessions';
import {
  bridgeConnect,
  bridgeSendMessage,
  onBridgeEvent,
} from '@/api/desktop';
import { getRuntimeBranding } from '@/lib/runtime-branding';
import { sessionLabel } from '@/lib/session-utils';
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
import type { ThreadDetail } from '../../../packages/contracts/src';
import type {
  DesktopBridgeButtonOption,
  DesktopBridgeEvent,
} from '../../../shared/desktop';
import {
  normalizePermissionResponse,
  supportsInteractivePermission,
} from '../../../shared/desktop';
import {
  ASSISTANT_REPLY_TIMEOUT_MS,
  chatThreadMatchesSearch,
  formatTaskHint,
  isInternalProgressMessage,
  isPermissionActionRow,
  normalizeBridgeActionRows,
  sessionMatchesDesktop,
  sessionProjectFromKey,
  sortChatMessages,
  sortChatThreadsByLiveAndUpdated,
  toChatThreadSummary,
  toCoreChatThreadSummary,
  toMessages,
  toMessagesFromThread,
  upsertSessionGroup,
  upsertThreadInGroup,
  type ChatMessage,
  type ChatTaskState,
  type ChatThreadSummary,
  type SessionActionTarget,
  type SessionGroup,
} from './thread-chat-model';
import { useThreadChatRuntimeState } from './useThreadChatRuntimeState';

function permissionSupportMessage(agentType?: string) {
  const name = agentType || 'This agent';
  const branding = getRuntimeBranding();
  if (branding.permissionUnsupportedLabel.startsWith('This agent')) {
    return branding.permissionUnsupportedLabel;
  }
  return `${name} ${branding.permissionUnsupportedLabel.replace(/^This agent\s+/i, '')}`;
}

export function useThreadChatController() {
  const [searchParams, setSearchParams] = useSearchParams();
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

  const {
    loading,
    refreshRuntime,
    runtime,
    runtimeProvider,
    serviceRunning,
    showSessionKey,
    transportReady,
  } = useThreadChatRuntimeState({
    requestedProject,
    selectedProject,
    setSelectedProject,
    clearReplyTimeout,
    updateTaskState,
    setTyping,
  });

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
    setActiveSessionName(sessionLabel(detail));
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
    const stopBridge = onBridgeEvent((event) => {
      handleBridgeEvent(event);
    });
    return () => {
      clearLocalCorePolling();
      clearReplyTimeout();
      stopBridge();
    };
  }, [clearLocalCorePolling, clearReplyTimeout, handleBridgeEvent]);

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
    setActiveSessionName(sessionLabel(created));
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

  return {
    activeRunId,
    activeSessionId,
    activeSessionKey,
    activeSessionName,
    bridgeError,
    branding,
    deleteTarget,
    draft,
    endRef,
    filteredSessionGroups,
    handleBridgeAction,
    handleCreateNew,
    handleDeleteSession,
    handleRenameSession,
    handleSend,
    handleStopTask,
    loadActiveSession,
    loading,
    openRenameModal,
    pendingBridgeActionId,
    pendingSessionAction,
    projects,
    refreshRuntime,
    renameDraft,
    renameTarget,
    renderedMessages,
    runtime,
    sending,
    serviceRunning,
    sessionSearch,
    selectedProject,
    setDeleteTarget,
    setDraft,
    setRenameDraft,
    setRenameTarget,
    setSelectedProject,
    setSessionSearch,
    showSessionKey,
    taskHint,
    taskRunning,
    taskState,
    transportReady,
  };
}
