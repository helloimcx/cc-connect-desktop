import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { bridgeSendMessage } from '@/api/desktop';
import {
  normalizePermissionResponse,
  type DesktopBridgeButtonOption,
} from '../../../shared/desktop';
import type { ChatMessage, ChatTaskState } from './thread-chat-model';
import type {
  ThreadChatActiveThreadIdentity,
  ThreadChatSendingRefs,
  ThreadChatSharedHookContext,
} from './thread-chat-action-types';

type UseThreadChatBridgeActionsInput = {
  messages: ChatMessage[];
  reserveNextMessageOrder: () => number;
  startLocalCoreThreadPolling: (threadId: string, baselineAssistantCount: number) => void;
  armReplyTimeout: (mode?: 'reply' | 'permission_continue') => void;
  clearActionStatuses: () => void;
  setPendingBridgeActionId: Dispatch<SetStateAction<string | null>>;
  sendAction: (threadId: string, action: string) => Promise<{ runId: string }>;
} & Pick<ThreadChatSharedHookContext, 'runtimeProvider' | 'selectedWorkspaceId' | 'updateTaskState'> &
  Pick<ThreadChatSharedHookContext, 'clearReplyTimeout' | 'setBridgeError' | 'setMessages' | 'setTyping'> &
  Pick<ThreadChatActiveThreadIdentity, 'activeThreadId' | 'activeBridgeSessionKey'> &
  Pick<ThreadChatSendingRefs, 'taskStateRef'> &
  {
    activeAgentType: string;
  };

export function useThreadChatBridgeActions({
  activeAgentType: _activeAgentType,
  activeBridgeSessionKey,
  activeThreadId,
  armReplyTimeout,
  clearActionStatuses,
  clearReplyTimeout,
  messages,
  reserveNextMessageOrder,
  runtimeProvider,
  selectedWorkspaceId,
  sendAction,
  setActiveRunId,
  setBridgeError,
  setMessages,
  setPendingBridgeActionId,
  setTyping,
  startLocalCoreThreadPolling,
  updateTaskState,
}: UseThreadChatBridgeActionsInput & Pick<ThreadChatActiveThreadIdentity, 'activeRunId'> & { setActiveRunId: Dispatch<SetStateAction<string>> }) {
  const handleBridgeAction = useCallback(async (message: ChatMessage, action: DesktopBridgeButtonOption) => {
    if (!activeThreadId) {
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
        const result = await sendAction(activeThreadId, actionContent);
        setActiveRunId(result.runId);
        const assistantCount = messages.filter((item) => item.role === 'assistant').length;
        startLocalCoreThreadPolling(activeThreadId, assistantCount);
      } else {
        const [, workspaceId = selectedWorkspaceId, chatId = 'main'] = activeBridgeSessionKey.split(':');
        await bridgeSendMessage({
          project: workspaceId,
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
        updateTaskState('permission_submitted', 'bridge-permission-submitted');
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
        updateTaskState('running', 'bridge-action-submitted');
        if (runtimeProvider !== 'local_core') {
          armReplyTimeout();
        }
      }
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : 'Failed to send permission response.');
      setMessages((current) => current.filter((item) => item.id !== actionMessageId));
      updateTaskState(
        message.actionMode === 'permission' && message.actionInteractive ? 'awaiting_permission' : 'error',
        message.actionMode === 'permission' && message.actionInteractive
          ? 'bridge-permission-submit-failed'
          : 'bridge-action-submit-failed',
      );
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
    activeBridgeSessionKey,
    activeThreadId,
    armReplyTimeout,
    clearActionStatuses,
    clearReplyTimeout,
    messages,
    reserveNextMessageOrder,
    runtimeProvider,
    selectedWorkspaceId,
    sendAction,
    setActiveRunId,
    setBridgeError,
    setMessages,
    setPendingBridgeActionId,
    setTyping,
    startLocalCoreThreadPolling,
    updateTaskState,
  ]);

  return {
    handleBridgeAction,
  };
}
