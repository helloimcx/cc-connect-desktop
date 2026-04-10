import type { Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ThreadDetail } from '../../../packages/contracts/src';
import type { RuntimeProvider } from '@/app/runtime';
import type { ChatMessage, ChatTaskState, SessionActionTarget } from './thread-chat-model';
import { useThreadChatSendingActions } from './useThreadChatSendingActions';
import { useThreadChatThreadActions } from './useThreadChatThreadActions';

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
  const { handleSend, handleStopTask } = useThreadChatSendingActions({
    activeRunId,
    activeSessionId,
    activeSessionKey,
    brandingNewThreadLabel,
    draft,
    loadActiveSession,
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
  });

  const {
    handleCreateNew,
    handleDeleteSession,
    handleRenameSession,
    openRenameModal,
  } = useThreadChatThreadActions({
    activeSessionId,
    brandingNewThreadLabel,
    deleteTarget,
    renameDraft,
    renameTarget,
    runtimeProvider,
    searchParams,
    selectedProject,
    updateTaskState,
    applyLocalCoreThreadDetail,
    clearLocalCorePolling,
    clearReplyTimeout,
    refreshSessionsForProject,
    setActiveRunId,
    setActiveSessionAgentType,
    setActiveSessionId,
    setActiveSessionKey,
    setActiveSessionName,
    setBridgeError,
    setDeleteTarget,
    setMessages,
    setPendingSessionAction,
    setRenameDraft,
    setRenameTarget,
    setSearchParams,
    setTyping,
    holdBlankComposerRef,
    nextMessageOrderRef,
    pendingTurnRef,
    progressSequenceByTurnRef,
  });

  return {
    handleCreateNew,
    handleDeleteSession,
    handleRenameSession,
    handleSend,
    handleStopTask,
    openRenameModal,
  };
}
