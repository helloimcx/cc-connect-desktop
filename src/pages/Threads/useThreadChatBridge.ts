import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ChatMessage, ChatTaskState } from './thread-chat-model';
import { useThreadChatBridgeActions } from './useThreadChatBridgeActions';
import { useThreadChatBridgeEvents } from './useThreadChatBridgeEvents';

type UseThreadChatBridgeInput = {
  activeAgentType: string;
  activeBridgeSessionKey: string;
  activeThreadId: string;
  activeRunId: string;
  messages: ChatMessage[];
  runtimeProvider: 'electron' | 'local_core' | 'web_remote';
  selectedWorkspaceId: string;
  clearActionStatuses: () => void;
  clearLocalCorePolling: () => void;
  clearReplyTimeout: () => void;
  finalizeTurnMessages: (turnKey?: string) => void;
  nextProgressMessageId: (replyCtx?: string) => string;
  refreshThreadsForWorkspace: (workspaceId: string) => Promise<unknown>;
  reserveAssistantMessageOrder: (sessionKey?: string) => number;
  reserveNextMessageOrder: () => number;
  setActiveRunId: Dispatch<SetStateAction<string>>;
  setBridgeError: Dispatch<SetStateAction<string>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setPendingBridgeActionId: Dispatch<SetStateAction<string | null>>;
  setTyping: Dispatch<SetStateAction<boolean>>;
  startLocalCoreThreadPolling: (threadId: string, baselineAssistantCount: number) => void;
  updateTaskState: (next: ChatTaskState) => void;
  armReplyTimeout: (mode?: 'reply' | 'permission_continue') => void;
  pendingTurnRef: MutableRefObject<{ sessionKey: string; userOrder: number } | null>;
  progressSequenceByTurnRef: MutableRefObject<Record<string, number>>;
  sendAction: (threadId: string, action: string) => Promise<{ runId: string }>;
  taskStateRef: MutableRefObject<ChatTaskState>;
};

export function useThreadChatBridge(input: UseThreadChatBridgeInput) {
  useThreadChatBridgeEvents({
    activeAgentType: input.activeAgentType,
    activeBridgeSessionKey: input.activeBridgeSessionKey,
    activeThreadId: input.activeThreadId,
    armReplyTimeout: input.armReplyTimeout,
    clearActionStatuses: input.clearActionStatuses,
    clearLocalCorePolling: input.clearLocalCorePolling,
    clearReplyTimeout: input.clearReplyTimeout,
    finalizeTurnMessages: input.finalizeTurnMessages,
    messages: input.messages,
    nextProgressMessageId: input.nextProgressMessageId,
    pendingTurnRef: input.pendingTurnRef,
    progressSequenceByTurnRef: input.progressSequenceByTurnRef,
    refreshThreadsForWorkspace: input.refreshThreadsForWorkspace,
    reserveAssistantMessageOrder: input.reserveAssistantMessageOrder,
    setBridgeError: input.setBridgeError,
    setMessages: input.setMessages,
    setTyping: input.setTyping,
    updateTaskState: input.updateTaskState,
  });

  const { handleBridgeAction } = useThreadChatBridgeActions({
    activeAgentType: input.activeAgentType,
    activeBridgeSessionKey: input.activeBridgeSessionKey,
    activeRunId: input.activeRunId,
    activeThreadId: input.activeThreadId,
    armReplyTimeout: input.armReplyTimeout,
    clearActionStatuses: input.clearActionStatuses,
    clearReplyTimeout: input.clearReplyTimeout,
    messages: input.messages,
    reserveNextMessageOrder: input.reserveNextMessageOrder,
    runtimeProvider: input.runtimeProvider,
    selectedWorkspaceId: input.selectedWorkspaceId,
    sendAction: input.sendAction,
    setActiveRunId: input.setActiveRunId,
    setBridgeError: input.setBridgeError,
    setMessages: input.setMessages,
    setPendingBridgeActionId: input.setPendingBridgeActionId,
    setTyping: input.setTyping,
    startLocalCoreThreadPolling: input.startLocalCoreThreadPolling,
    updateTaskState: input.updateTaskState,
    taskStateRef: input.taskStateRef,
  });

  return {
    handleBridgeAction,
  };
}
