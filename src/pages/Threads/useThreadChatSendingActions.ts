import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { bridgeSendMessage } from '@/api/desktop';
import { createSession, listSessions } from '@/api/sessions';
import { createThread, interruptRun, sendMessage as sendThreadMessage, updateThreadKnowledgeBases as updateCoreThreadKnowledgeBases } from '../../../packages/core-sdk/src';
import type { KnowledgeBase } from '../../../packages/contracts/src';
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
  availableKnowledgeBases: KnowledgeBase[];
  brandingNewThreadLabel: string;
  draft: string;
  loadActiveThread: (workspaceId: string, threadId: string) => Promise<void>;
  messages: ChatMessage[];
  selectedKnowledgeBaseIds: string[];
  taskState: ChatTaskState;
  armReplyTimeout: (mode?: 'reply' | 'permission_continue') => void;
  reserveNextMessageOrder: () => number;
  settlePreviewMessages: (turnKey?: string) => void;
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
  availableKnowledgeBases,
  brandingNewThreadLabel,
  draft,
  loadActiveThread,
  messages,
  selectedKnowledgeBaseIds,
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
  settlePreviewMessages,
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
  const usesManagedThreadApi = runtimeProvider !== 'web_remote';
  const canFallbackToDesktopBridge = runtimeProvider === 'electron';
  const encodeManagedThreadId = useCallback((workspaceId: string, sessionId: string) => (
    `${encodeURIComponent(workspaceId)}::${encodeURIComponent(sessionId)}`
  ), []);
  const buildMessageContent = useCallback((content: string) => {
    if (selectedKnowledgeBaseIds.length === 0) {
      return content;
    }
    const selectedBases = selectedKnowledgeBaseIds
      .map((knowledgeBaseId) => availableKnowledgeBases.find((base) => base.id === knowledgeBaseId))
      .filter((base): base is KnowledgeBase => Boolean(base));
    if (selectedBases.length === 0) {
      return content;
    }
    return [
      '[Selected Knowledge Bases]',
      ...selectedBases.map((base) => `- id: ${base.id} | name: ${base.name}`),
      '[/Selected Knowledge Bases]',
      '',
      '[User Message]',
      content,
      '[/User Message]',
    ].join('\n');
  }, [availableKnowledgeBases, selectedKnowledgeBaseIds]);

  const ensureSession = useCallback(async () => {
    if (!selectedProject) {
      throw new Error('Choose a project first');
    }
    if (activeThreadId) {
      return { id: activeThreadId, sessionKey: activeBridgeSessionKey };
    }

    if (!usesManagedThreadApi) {
      throw new Error('Managed desktop thread transport is unavailable.');
    }

    try {
      const detail = await createThread(selectedProject, `${brandingNewThreadLabel} ${new Date().toLocaleTimeString()}`);
      applyLocalCoreThreadDetail(detail);
      await refreshSessionsForProject(selectedProject);
      return { id: detail.id, sessionKey: detail.bridgeSessionKey || '' };
    } catch (error) {
      if (!canFallbackToDesktopBridge) {
        throw error;
      }
      const fallbackTitle = `${brandingNewThreadLabel} ${new Date().toLocaleTimeString()}`;
      const fallbackChatId = `core-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const fallbackSessionKey = `desktop:${selectedProject}:${fallbackChatId}`;
      const created = await createSession(selectedProject, {
        session_key: fallbackSessionKey,
        name: fallbackTitle,
      });
      const sessions = await listSessions(selectedProject);
      const matchedSession =
        (sessions.sessions || []).find((session) => session.id === created.id) ||
        (sessions.sessions || []).find((session) => session.session_key === fallbackSessionKey);
      if (!matchedSession?.id) {
        throw new Error('Desktop session was created but could not be reloaded.');
      }
      const managedThreadId = encodeManagedThreadId(selectedProject, matchedSession.id);
      setActiveSessionId(managedThreadId);
      setActiveSessionKey(matchedSession.session_key || fallbackSessionKey);
      setActiveSessionName(matchedSession.name || fallbackTitle);
      await refreshSessionsForProject(selectedProject);
      return {
        id: managedThreadId,
        sessionKey: matchedSession.session_key || fallbackSessionKey,
      };
    }
  }, [
    activeBridgeSessionKey,
    activeThreadId,
    applyLocalCoreThreadDetail,
    brandingNewThreadLabel,
    canFallbackToDesktopBridge,
    encodeManagedThreadId,
    refreshSessionsForProject,
    selectedProject,
    setActiveSessionId,
    setActiveSessionKey,
    setActiveSessionName,
    usesManagedThreadApi,
  ]);

  const handleSend = useCallback(async () => {
    if (!draft.trim() || !selectedProject) {
      return;
    }
    const content = draft.trim();
    const payloadContent = buildMessageContent(content);
    const userOrder = reserveNextMessageOrder();
    setDraft('');
    setSending(true);

    try {
      const ensured = await ensureSession();
      console.info('[desktop-chat] send', {
        runtimeProvider,
        selectedProject,
        threadId: ensured.id,
        sessionKey: ensured.sessionKey,
        selectedKnowledgeBaseIds,
      });
      pendingTurnRef.current = { sessionKey: ensured.sessionKey, userOrder };
      setMessages((current) => [
        ...current,
        { id: `${crypto.randomUUID()}-user`, role: 'user', content, order: userOrder, timestamp: new Date().toISOString() },
      ]);
      updateTaskState('running', 'send-started');
      setTyping(usesManagedThreadApi);
      setBridgeError('');
      if (usesManagedThreadApi && ensured.id) {
        await updateCoreThreadKnowledgeBases(ensured.id, selectedKnowledgeBaseIds);
      }
      armReplyTimeout();
      if (usesManagedThreadApi && ensured.id) {
        try {
          const result = await sendThreadMessage(ensured.id, payloadContent);
          setActiveRunId(result.runId);
        } catch (error) {
          if (!canFallbackToDesktopBridge) {
            throw error;
          }
          const [, fallbackProject = selectedProject, fallbackChatId = 'main'] = ensured.sessionKey.split(':');
          const bridgeResult = await bridgeSendMessage({
            project: fallbackProject,
            chatId: fallbackChatId,
            content: payloadContent,
          });
          pendingTurnRef.current = { sessionKey: bridgeResult.sessionKey, userOrder };
          let bridgedThread: Awaited<ReturnType<typeof refreshSessionsForProject>>[number] | undefined;
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const refreshedThreads = await refreshSessionsForProject(selectedProject);
            bridgedThread = refreshedThreads.find((thread) => thread.bridgeSessionKey === bridgeResult.sessionKey);
            if (bridgedThread) {
              break;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 750));
          }
          if (bridgedThread) {
            await loadActiveThread(selectedProject, bridgedThread.id);
          }
          setActiveRunId('');
        }
      } else if (canFallbackToDesktopBridge) {
        const [, fallbackProject = selectedProject, fallbackChatId = 'main'] = ensured.sessionKey.split(':');
        const bridgeResult = await bridgeSendMessage({
          project: fallbackProject,
          chatId: fallbackChatId,
          content: payloadContent,
        });
        pendingTurnRef.current = { sessionKey: bridgeResult.sessionKey, userOrder };
        let bridgedThread: Awaited<ReturnType<typeof refreshSessionsForProject>>[number] | undefined;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const refreshedThreads = await refreshSessionsForProject(selectedProject);
          bridgedThread = refreshedThreads.find((thread) => thread.bridgeSessionKey === bridgeResult.sessionKey);
          if (bridgedThread) {
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 750));
        }
        if (bridgedThread) {
          await loadActiveThread(selectedProject, bridgedThread.id);
        }
        setActiveRunId('');
      } else {
        throw new Error('Managed desktop thread transport is unavailable.');
      }
    } catch (error) {
      clearReplyTimeout();
      clearLocalCorePolling();
      pendingTurnRef.current = null;
      settlePreviewMessages();
      setTyping(false);
      updateTaskState('error', 'send-failed');
      setBridgeError(error instanceof Error ? error.message : 'Failed to send the message.');
    } finally {
      setSending(false);
    }
  }, [
    armReplyTimeout,
    buildMessageContent,
    clearLocalCorePolling,
    clearReplyTimeout,
    draft,
    ensureSession,
    canFallbackToDesktopBridge,
    loadActiveThread,
    pendingTurnRef,
    refreshSessionsForProject,
    reserveNextMessageOrder,
    selectedKnowledgeBaseIds,
    selectedProject,
    setActiveRunId,
    setBridgeError,
    setDraft,
    setMessages,
    setSending,
    settlePreviewMessages,
    setTyping,
    updateTaskState,
    usesManagedThreadApi,
  ]);

  const handleStopTask = useCallback(async () => {
    if (!selectedProject || taskState === 'stopping') {
      return;
    }
    setBridgeError('');
    clearReplyTimeout();
    clearLocalCorePolling();
    settlePreviewMessages();
    setTyping(false);
    updateTaskState('stopping', 'stop-requested');
    try {
      if (usesManagedThreadApi && activeRunId) {
        await interruptRun(activeRunId);
      } else {
        throw new Error('No active run to stop.');
      }
      window.setTimeout(() => {
        if (taskStateRef.current === 'stopping') {
          updateTaskState('idle', 'stop-timeout-complete');
        }
      }, 1500);
    } catch (error) {
      updateTaskState('error', 'stop-failed');
      setBridgeError(error instanceof Error ? error.message : 'Failed to stop the current task.');
    }
  }, [
    activeRunId,
    clearLocalCorePolling,
    clearReplyTimeout,
    setBridgeError,
    settlePreviewMessages,
    setTyping,
    selectedProject,
    taskState,
    taskStateRef,
    updateTaskState,
    usesManagedThreadApi,
  ]);

  return {
    handleSend,
    handleStopTask,
  };
}
