import { useCallback } from 'react';
import { deleteThreadKnowledgeBases } from '@/api/desktop';
import { deleteSession, renameSession } from '@/api/sessions';
import {
  createThread,
  deleteThread as deleteCoreThread,
  renameThread,
  updateThreadKnowledgeBases as updateCoreThreadKnowledgeBases,
} from '../../../packages/core-sdk/src';
import type { ChatThreadSummary, ThreadActionTarget } from './thread-chat-model';
import type {
  ThreadChatConversationRefs,
  ThreadChatIdentitySetters,
  ThreadChatModalSetters,
  ThreadChatSearchParamsSetter,
  ThreadChatSharedActionContext,
} from './thread-chat-action-types';

type UseThreadChatThreadActionsInput = {
  activeThreadId: string;
  brandingNewThreadLabel: string;
  deleteTarget: ThreadActionTarget | null;
  renameDraft: string;
  renameTarget: ThreadActionTarget | null;
  searchParams: URLSearchParams;
  selectedKnowledgeBaseIds: string[];
  setSearchParams: ThreadChatSearchParamsSetter;
} & Pick<ThreadChatSharedActionContext, 'runtimeProvider' | 'selectedProject' | 'updateTaskState'> &
  Pick<ThreadChatSharedActionContext, 'applyLocalCoreThreadDetail' | 'clearLocalCorePolling' | 'clearReplyTimeout'> &
  Pick<ThreadChatSharedActionContext, 'refreshSessionsForProject' | 'setBridgeError' | 'setMessages' | 'setTyping'> &
  Pick<ThreadChatIdentitySetters, 'setActiveRunId' | 'setActiveSessionAgentType' | 'setActiveSessionId' | 'setActiveSessionKey' | 'setActiveSessionName'> &
  Pick<ThreadChatModalSetters, 'setDeleteTarget' | 'setPendingSessionAction' | 'setRenameDraft' | 'setRenameTarget'> &
  Pick<ThreadChatConversationRefs, 'holdBlankComposerRef' | 'nextMessageOrderRef' | 'pendingTurnRef' | 'progressSequenceByTurnRef'>;

export function useThreadChatThreadActions({
  activeThreadId,
  brandingNewThreadLabel,
  deleteTarget,
  renameDraft,
  renameTarget,
  runtimeProvider,
  searchParams,
  selectedKnowledgeBaseIds,
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
        if (selectedKnowledgeBaseIds.length > 0) {
          const persistedIds = (await updateCoreThreadKnowledgeBases(detail.id, selectedKnowledgeBaseIds)).knowledgeBaseIds;
          detail.selectedKnowledgeBaseIds = persistedIds;
        } else {
          detail.selectedKnowledgeBaseIds = [];
        }
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
    selectedKnowledgeBaseIds,
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
      if (renameTarget.id === activeThreadId) {
        setActiveSessionName(name);
      }
      await refreshSessionsForProject(renameTarget.project);
      setRenameTarget(null);
      setRenameDraft('');
    } finally {
      setPendingSessionAction(null);
    }
  }, [
    activeThreadId,
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
        await deleteThreadKnowledgeBases(deleteTarget.project, deleteTarget.id).catch(() => ({ deleted: false }));
      }
      if (deleteTarget.id === activeThreadId) {
        resetBlankConversation();
      }
      await refreshSessionsForProject(deleteTarget.project);
      setDeleteTarget(null);
    } finally {
      setPendingSessionAction(null);
    }
  }, [
    activeThreadId,
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
