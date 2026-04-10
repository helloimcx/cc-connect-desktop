import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { deleteSession, renameSession } from '@/api/sessions';
import { createThread, deleteThread as deleteCoreThread, renameThread } from '../../../packages/core-sdk/src';
import type { ThreadDetail } from '../../../packages/contracts/src';
import type { RuntimeProvider } from '@/app/runtime';
import type { ChatMessage, ChatTaskState, ChatThreadSummary, SessionActionTarget } from './thread-chat-model';

type UseThreadChatThreadActionsInput = {
  activeSessionId: string;
  brandingNewThreadLabel: string;
  deleteTarget: SessionActionTarget | null;
  renameDraft: string;
  renameTarget: SessionActionTarget | null;
  runtimeProvider: RuntimeProvider;
  searchParams: URLSearchParams;
  selectedProject: string;
  updateTaskState: (next: ChatTaskState) => void;
  applyLocalCoreThreadDetail: (detail: ThreadDetail) => void;
  clearLocalCorePolling: () => void;
  clearReplyTimeout: () => void;
  refreshSessionsForProject: (project: string) => Promise<Array<{ id: string; bridgeSessionKey?: string }>>;
  setActiveRunId: Dispatch<SetStateAction<string>>;
  setActiveSessionAgentType: Dispatch<SetStateAction<string>>;
  setActiveSessionId: Dispatch<SetStateAction<string>>;
  setActiveSessionKey: Dispatch<SetStateAction<string>>;
  setActiveSessionName: Dispatch<SetStateAction<string>>;
  setBridgeError: Dispatch<SetStateAction<string>>;
  setDeleteTarget: Dispatch<SetStateAction<SessionActionTarget | null>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setPendingSessionAction: Dispatch<SetStateAction<'rename' | 'delete' | null>>;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  setRenameTarget: Dispatch<SetStateAction<SessionActionTarget | null>>;
  setSearchParams: (nextInit: URLSearchParams, navigateOptions?: { replace?: boolean }) => void;
  setTyping: Dispatch<SetStateAction<boolean>>;
  holdBlankComposerRef: MutableRefObject<boolean>;
  nextMessageOrderRef: MutableRefObject<number>;
  pendingTurnRef: MutableRefObject<{ sessionKey: string; userOrder: number } | null>;
  progressSequenceByTurnRef: MutableRefObject<Record<string, number>>;
};

export function useThreadChatThreadActions({
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
}: UseThreadChatThreadActionsInput) {
  const resetBlankConversation = useCallback(() => {
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
  }, [
    clearLocalCorePolling,
    clearReplyTimeout,
    holdBlankComposerRef,
    nextMessageOrderRef,
    pendingTurnRef,
    progressSequenceByTurnRef,
    setActiveRunId,
    setActiveSessionAgentType,
    setActiveSessionId,
    setActiveSessionKey,
    setActiveSessionName,
    setBridgeError,
    setMessages,
    setTyping,
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
    resetBlankConversation();
    const next = new URLSearchParams(searchParams);
    next.delete('session');
    setSearchParams(next, { replace: true });
  }, [
    applyLocalCoreThreadDetail,
    brandingNewThreadLabel,
    refreshSessionsForProject,
    resetBlankConversation,
    runtimeProvider,
    searchParams,
    selectedProject,
    setPendingSessionAction,
    setSearchParams,
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
        resetBlankConversation();
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
    resetBlankConversation,
    runtimeProvider,
    setDeleteTarget,
    setPendingSessionAction,
  ]);

  return {
    handleCreateNew,
    handleDeleteSession,
    handleRenameSession,
    openRenameModal,
  };
}
