import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { createSession, deleteSession, renameSession } from '@/api/sessions';
import { bridgeSendMessage } from '@/api/desktop';
import { sessionLabel } from '@/lib/session-utils';
import {
  createThread,
  deleteThread as deleteCoreThread,
  interruptRun,
  renameThread,
  sendMessage as sendThreadMessage,
} from '../../../packages/core-sdk/src';
import type { ThreadDetail } from '../../../packages/contracts/src';
import type { RuntimeProvider } from '@/app/runtime';
import type { ChatMessage, ChatTaskState, ChatThreadSummary, SessionActionTarget } from './thread-chat-model';

type UseThreadChatActionsInput = {
  activeRunId: string;
  activeSessionId: string;
  activeSessionKey: string;
  brandingNewThreadLabel: string;
  deleteTarget: SessionActionTarget | null;
  draft: string;
  loadActiveSession: (project: string, sessionId: string) => Promise<void>;
  messages: ChatMessage[];
  renameDraft: string;
  renameTarget: SessionActionTarget | null;
  runtimeProvider: RuntimeProvider;
  searchParams: URLSearchParams;
  selectedProject: string;
  taskState: ChatTaskState;
  updateTaskState: (next: ChatTaskState) => void;
  applyLocalCoreThreadDetail: (detail: ThreadDetail) => void;
  armReplyTimeout: (mode?: 'reply' | 'permission_continue') => void;
  clearLocalCorePolling: () => void;
  clearReplyTimeout: () => void;
  refreshSessionsForProject: (project: string) => Promise<Array<{ id: string; bridgeSessionKey?: string }>>;
  reserveNextMessageOrder: () => number;
  setActiveRunId: Dispatch<SetStateAction<string>>;
  setActiveSessionAgentType: Dispatch<SetStateAction<string>>;
  setActiveSessionId: Dispatch<SetStateAction<string>>;
  setActiveSessionKey: Dispatch<SetStateAction<string>>;
  setActiveSessionName: Dispatch<SetStateAction<string>>;
  setBridgeError: Dispatch<SetStateAction<string>>;
  setDeleteTarget: Dispatch<SetStateAction<SessionActionTarget | null>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setPendingSessionAction: Dispatch<SetStateAction<'rename' | 'delete' | null>>;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  setRenameTarget: Dispatch<SetStateAction<SessionActionTarget | null>>;
  setSearchParams: (nextInit: URLSearchParams, navigateOptions?: { replace?: boolean }) => void;
  setSending: Dispatch<SetStateAction<boolean>>;
  setTyping: Dispatch<SetStateAction<boolean>>;
  startLocalCoreThreadPolling: (threadId: string, baselineAssistantCount: number) => void;
  holdBlankComposerRef: MutableRefObject<boolean>;
  lastSessionByProjectRef: MutableRefObject<Record<string, string>>;
  nextMessageOrderRef: MutableRefObject<number>;
  pendingTurnRef: MutableRefObject<{ sessionKey: string; userOrder: number } | null>;
  progressSequenceByTurnRef: MutableRefObject<Record<string, number>>;
  taskStateRef: MutableRefObject<ChatTaskState>;
};

export function useThreadChatActions({
  activeRunId,
  activeSessionId,
  activeSessionKey,
  brandingNewThreadLabel,
  deleteTarget,
  draft,
  loadActiveSession,
  messages,
  renameDraft,
  renameTarget,
  runtimeProvider,
  searchParams,
  selectedProject,
  taskState,
  updateTaskState,
  applyLocalCoreThreadDetail,
  armReplyTimeout,
  clearLocalCorePolling,
  clearReplyTimeout,
  refreshSessionsForProject,
  reserveNextMessageOrder,
  setActiveRunId,
  setActiveSessionAgentType,
  setActiveSessionId,
  setActiveSessionKey,
  setActiveSessionName,
  setBridgeError,
  setDeleteTarget,
  setDraft,
  setMessages,
  setPendingSessionAction,
  setRenameDraft,
  setRenameTarget,
  setSearchParams,
  setSending,
  setTyping,
  startLocalCoreThreadPolling,
  holdBlankComposerRef,
  lastSessionByProjectRef,
  nextMessageOrderRef,
  pendingTurnRef,
  progressSequenceByTurnRef,
  taskStateRef,
}: UseThreadChatActionsInput) {
  const ensureSession = useCallback(async () => {
    if (!selectedProject) {
      throw new Error('Choose a project first');
    }
    if (activeSessionId) {
      return { id: activeSessionId, sessionKey: activeSessionKey };
    }

    if (runtimeProvider === 'local_core') {
      const detail = await createThread(selectedProject, `${brandingNewThreadLabel} ${new Date().toLocaleTimeString()}`);
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
    brandingNewThreadLabel,
    holdBlankComposerRef,
    lastSessionByProjectRef,
    loadActiveSession,
    nextMessageOrderRef,
    pendingTurnRef,
    progressSequenceByTurnRef,
    refreshSessionsForProject,
    runtimeProvider,
    selectedProject,
    setActiveSessionId,
    setActiveSessionKey,
    setActiveSessionName,
    setMessages,
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
    pendingTurnRef,
    reserveNextMessageOrder,
    runtimeProvider,
    selectedProject,
    setActiveRunId,
    setBridgeError,
    setDraft,
    setMessages,
    setSending,
    setTyping,
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
  }, [
    activeRunId,
    activeSessionKey,
    clearLocalCorePolling,
    clearReplyTimeout,
    runtimeProvider,
    selectedProject,
    setBridgeError,
    setTyping,
    taskState,
    taskStateRef,
    updateTaskState,
  ]);

  const handleCreateNew = useCallback(async () => {
    if (!selectedProject) {
      return;
    }
    if (runtimeProvider === 'local_core') {
      setPendingSessionAction('rename');
      try {
        const detail = await createThread(selectedProject, `${brandingNewThreadLabel} ${new Date().toLocaleTimeString()}`);
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
    brandingNewThreadLabel,
    clearLocalCorePolling,
    clearReplyTimeout,
    holdBlankComposerRef,
    nextMessageOrderRef,
    pendingTurnRef,
    progressSequenceByTurnRef,
    refreshSessionsForProject,
    runtimeProvider,
    searchParams,
    selectedProject,
    setActiveRunId,
    setActiveSessionAgentType,
    setActiveSessionId,
    setActiveSessionKey,
    setActiveSessionName,
    setBridgeError,
    setMessages,
    setPendingSessionAction,
    setSearchParams,
    setTyping,
    updateTaskState,
  ]);

  const openRenameModal = useCallback((project: string, session: ChatThreadSummary) => {
    setRenameTarget({ project, id: session.id, name: session.name });
    setRenameDraft(session.name);
  }, [setRenameDraft, setRenameTarget]);

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
  }, [
    activeSessionId,
    refreshSessionsForProject,
    renameDraft,
    renameTarget,
    runtimeProvider,
    setActiveSessionName,
    setPendingSessionAction,
    setRenameDraft,
    setRenameTarget,
  ]);

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
  }, [
    activeSessionId,
    deleteTarget,
    refreshSessionsForProject,
    runtimeProvider,
    setActiveRunId,
    setActiveSessionAgentType,
    setActiveSessionId,
    setActiveSessionKey,
    setActiveSessionName,
    setDeleteTarget,
    setMessages,
    setPendingSessionAction,
    setTyping,
    updateTaskState,
  ]);

  return {
    handleCreateNew,
    handleDeleteSession,
    handleRenameSession,
    handleSend,
    handleStopTask,
    openRenameModal,
  };
}
