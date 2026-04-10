import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { createSession } from '@/api/sessions';
import { bridgeSendMessage } from '@/api/desktop';
import { sessionLabel } from '@/lib/session-utils';
import { createThread, interruptRun, sendMessage as sendThreadMessage } from '../../../packages/core-sdk/src';
import type { ChatMessage, ChatTaskState } from './thread-chat-model';
import type {
  ThreadChatIdentitySetters,
  ThreadChatSendingRefs,
  ThreadChatSharedActionContext,
} from './thread-chat-action-types';

type UseThreadChatSendingActionsInput = {
  activeRunId: string;
  activeThreadId: string;
  activeBridgeSessionKey: string;
  brandingNewThreadLabel: string;
  draft: string;
  loadActiveThread: (workspaceId: string, threadId: string) => Promise<void>;
  messages: ChatMessage[];
  taskState: ChatTaskState;
  armReplyTimeout: (mode?: 'reply' | 'permission_continue') => void;
  reserveNextMessageOrder: () => number;
  setDraft: Dispatch<SetStateAction<string>>;
  setSending: Dispatch<SetStateAction<boolean>>;
  startLocalCoreThreadPolling: (threadId: string, baselineAssistantCount: number) => void;
} & Pick<ThreadChatSharedActionContext, 'runtimeProvider' | 'selectedProject' | 'updateTaskState'> &
  Pick<ThreadChatSharedActionContext, 'applyLocalCoreThreadDetail' | 'clearLocalCorePolling' | 'clearReplyTimeout'> &
  Pick<ThreadChatSharedActionContext, 'refreshSessionsForProject' | 'setBridgeError' | 'setMessages' | 'setTyping'> &
  Pick<ThreadChatIdentitySetters, 'setActiveRunId' | 'setActiveSessionId' | 'setActiveSessionKey' | 'setActiveSessionName'> &
  Pick<ThreadChatSendingRefs, 'holdBlankComposerRef' | 'lastSessionByProjectRef' | 'nextMessageOrderRef' | 'pendingTurnRef' | 'progressSequenceByTurnRef' | 'taskStateRef'>;

export function useThreadChatSendingActions({
  activeRunId,
  activeThreadId,
  activeBridgeSessionKey,
  brandingNewThreadLabel,
  draft,
  loadActiveThread,
  messages,
  runtimeProvider,
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
  setActiveSessionId,
  setActiveSessionKey,
  setActiveSessionName,
  setBridgeError,
  setDraft,
  setMessages,
  setSending,
  setTyping,
  startLocalCoreThreadPolling,
  holdBlankComposerRef,
  lastSessionByProjectRef,
  nextMessageOrderRef,
  pendingTurnRef,
  progressSequenceByTurnRef,
  taskStateRef,
}: UseThreadChatSendingActionsInput) {
  const ensureSession = useCallback(async () => {
    if (!selectedProject) {
      throw new Error('Choose a project first');
    }
    if (activeThreadId) {
      return { id: activeThreadId, sessionKey: activeBridgeSessionKey };
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
      await loadActiveThread(selectedProject, nextId);
    } else {
      setMessages([]);
      pendingTurnRef.current = null;
      nextMessageOrderRef.current = 0;
      progressSequenceByTurnRef.current = {};
    }
    return { id: nextId, sessionKey };
  }, [
    activeBridgeSessionKey,
    activeThreadId,
    applyLocalCoreThreadDetail,
    brandingNewThreadLabel,
    holdBlankComposerRef,
    lastSessionByProjectRef,
    loadActiveThread,
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
      } else if (activeBridgeSessionKey) {
        const [, project = selectedProject, chatId = 'main'] = activeBridgeSessionKey.split(':');
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
    activeBridgeSessionKey,
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

  return {
    handleSend,
    handleStopTask,
  };
}
