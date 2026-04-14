import type { Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { KnowledgeBase, ThreadDetail } from '../../../packages/contracts/src';
import type { RuntimeProvider } from '@/app/runtime';
import type { ChatMessage, ChatTaskState, ThreadActionTarget } from './thread-chat-model';
import type {
  ThreadChatCoreSetters,
  ThreadChatIdentitySetters,
  ThreadChatModalSetters,
  ThreadChatSendingRefs,
  ThreadChatSharedActionContext,
} from './thread-chat-action-types';
import { useThreadChatSendingActions } from './useThreadChatSendingActions';
import { useThreadChatThreadActions } from './useThreadChatThreadActions';

type UseThreadChatActionsInput = {
  activeRunId: string;
  activeThreadId: string;
  activeBridgeSessionKey: string;
  availableKnowledgeBases: KnowledgeBase[];
  brandingNewThreadLabel: string;
  deleteTarget: ThreadActionTarget | null;
  draft: string;
  loadActiveThread: (workspaceId: string, threadId: string) => Promise<void>;
  messages: ChatMessage[];
  renameDraft: string;
  renameTarget: ThreadActionTarget | null;
  runtimeProvider: RuntimeProvider;
  searchParams: URLSearchParams;
  selectedKnowledgeBaseIds: string[];
  selectedWorkspaceId: string;
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
  setDeleteTarget: Dispatch<SetStateAction<ThreadActionTarget | null>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setPendingSessionAction: Dispatch<SetStateAction<'rename' | 'delete' | null>>;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  setRenameTarget: Dispatch<SetStateAction<ThreadActionTarget | null>>;
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
  activeThreadId,
  activeBridgeSessionKey,
  availableKnowledgeBases,
  brandingNewThreadLabel,
  deleteTarget,
  draft,
  loadActiveThread,
  messages,
  renameDraft,
  renameTarget,
  runtimeProvider,
  searchParams,
  selectedKnowledgeBaseIds,
  selectedWorkspaceId,
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
  const sharedContext: ThreadChatSharedActionContext = {
    runtimeProvider,
    selectedProject: selectedWorkspaceId,
    updateTaskState,
    applyLocalCoreThreadDetail,
    clearLocalCorePolling,
    clearReplyTimeout,
    refreshSessionsForProject,
    setBridgeError,
    setMessages,
    setTyping,
    holdBlankComposerRef,
    nextMessageOrderRef,
    pendingTurnRef,
    progressSequenceByTurnRef,
  };

  const identitySetters: ThreadChatIdentitySetters = {
    setActiveRunId,
    setActiveSessionAgentType,
    setActiveSessionId,
    setActiveSessionKey,
    setActiveSessionName,
  };

  const modalSetters: ThreadChatModalSetters = {
    setDeleteTarget,
    setPendingSessionAction,
    setRenameDraft,
    setRenameTarget,
  };

  const sendingRefs: ThreadChatSendingRefs = {
    holdBlankComposerRef,
    lastSessionByProjectRef,
    nextMessageOrderRef,
    pendingTurnRef,
    progressSequenceByTurnRef,
    taskStateRef,
  };

  const coreSetters: ThreadChatCoreSetters = {
    setBridgeError,
    setMessages,
    setTyping,
  };

  const { handleSend, handleStopTask } = useThreadChatSendingActions({
    activeRunId,
    activeThreadId,
    activeBridgeSessionKey,
    availableKnowledgeBases,
    brandingNewThreadLabel,
    draft,
    loadActiveThread,
    messages,
    selectedKnowledgeBaseIds,
    taskState,
    armReplyTimeout,
    reserveNextMessageOrder,
    setDraft,
    setSending,
    startLocalCoreThreadPolling,
    ...sharedContext,
    ...identitySetters,
    ...coreSetters,
    ...sendingRefs,
  });

  const {
    handleCreateNew,
    handleDeleteSession,
    handleRenameSession,
    openRenameModal,
  } = useThreadChatThreadActions({
    activeThreadId,
    brandingNewThreadLabel,
    deleteTarget,
    renameDraft,
    renameTarget,
    searchParams,
    selectedKnowledgeBaseIds,
    setSearchParams,
    ...sharedContext,
    ...identitySetters,
    ...modalSetters,
    ...coreSetters,
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
