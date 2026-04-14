import { useCallback, useEffect, useMemo } from 'react';
import { getThreadKnowledgeBases } from '@/api/desktop';
import { listProjects } from '@/api/projects';
import { getSession, listSessions } from '@/api/sessions';
import { getThread, listThreads, listWorkspaces } from '../../../packages/core-sdk/src';
import type { ThreadGroup } from './thread-chat-model';
import {
  chatThreadMatchesSearch,
  sessionMatchesDesktop,
  sortChatThreadsByLiveAndUpdated,
  toChatThreadSummary,
  toCoreChatThreadSummary,
  toMessages,
  upsertThreadGroup,
  upsertThreadInGroup,
} from './thread-chat-model';
import type {
  ThreadChatBrowserSetters,
  ThreadChatConversationRefs,
  ThreadChatIdentitySetters,
  ThreadChatSendingRefs,
  ThreadChatSharedHookContext,
} from './thread-chat-action-types';

type UseThreadChatSessionBrowserInput = {
  activeThreadId: string;
  requestedWorkspaceId: string;
  requestedThreadId: string;
  runtimeDefaultWorkspaceId?: string;
  searchParams: URLSearchParams;
  serviceRunning: boolean;
  selectedWorkspaceId: string;
  workspaceIds: string[];
  threadGroups: ThreadGroup[];
  threadSearch: string;
  setSelectedKnowledgeBaseIds: (ids: string[]) => void;
} & Pick<ThreadChatSharedHookContext, 'runtimeProvider' | 'updateTaskState'> &
  Pick<ThreadChatSharedHookContext, 'applyLocalCoreThreadDetail' | 'clearLocalCorePolling' | 'clearReplyTimeout'> &
  Pick<ThreadChatSharedHookContext, 'setBridgeError' | 'setMessages' | 'setTyping'> &
  Pick<ThreadChatConversationRefs, 'holdBlankComposerRef' | 'nextMessageOrderRef' | 'pendingTurnRef' | 'progressSequenceByTurnRef'> &
  Pick<ThreadChatSendingRefs, 'lastSessionByProjectRef'> &
  Pick<ThreadChatIdentitySetters, 'setActiveRunId' | 'setActiveSessionAgentType' | 'setActiveSessionId' | 'setActiveSessionKey' | 'setActiveSessionName'> &
  Pick<ThreadChatBrowserSetters, 'setProjects' | 'setSelectedProject' | 'setThreadGroups' | 'setSearchParams'>;

export function useThreadChatSessionBrowser({
  activeThreadId,
  requestedWorkspaceId,
  requestedThreadId,
  runtimeDefaultWorkspaceId,
  runtimeProvider,
  searchParams,
  serviceRunning,
  selectedWorkspaceId,
  workspaceIds,
  threadGroups,
  threadSearch,
  setSelectedKnowledgeBaseIds,
  setActiveRunId,
  setActiveSessionAgentType,
  setActiveSessionId,
  setActiveSessionKey,
  setActiveSessionName,
  setBridgeError,
  setMessages,
  setProjects,
  setSearchParams,
  setSelectedProject,
  setThreadGroups,
  setTyping,
  applyLocalCoreThreadDetail,
  clearLocalCorePolling,
  clearReplyTimeout,
  updateTaskState,
  holdBlankComposerRef,
  lastSessionByProjectRef,
  nextMessageOrderRef,
  pendingTurnRef,
  progressSequenceByTurnRef,
}: UseThreadChatSessionBrowserInput) {
  const threadsForSelectedWorkspace = useMemo(
    () => threadGroups.find((group) => group.project === selectedWorkspaceId)?.sessions || [],
    [selectedWorkspaceId, threadGroups],
  );

  const filteredThreadGroups = useMemo(() => {
    const query = threadSearch.trim().toLowerCase();
    return workspaceIds
      .map((workspaceId) => {
        const threads = (threadGroups.find((group) => group.project === workspaceId)?.sessions || []).filter((thread) =>
          chatThreadMatchesSearch(thread, query),
        );
        return { project: workspaceId, sessions: threads };
      })
      .filter((group) => group.sessions.length > 0 || (!query && group.project === selectedWorkspaceId));
  }, [selectedWorkspaceId, threadGroups, threadSearch, workspaceIds]);

  const refreshThreadsForWorkspace = useCallback(async (workspaceId: string) => {
    if (!workspaceId || !serviceRunning) {
      return [];
    }
    const nextThreads = runtimeProvider === 'local_core'
      ? sortChatThreadsByLiveAndUpdated((await listThreads(workspaceId)).threads.map((thread) => toCoreChatThreadSummary(thread)))
      : sortChatThreadsByLiveAndUpdated(
          ((await listSessions(workspaceId)).sessions || [])
            .filter(sessionMatchesDesktop)
            .map((session) => toChatThreadSummary(workspaceId, session)),
        );
    const activeThread = nextThreads.find((thread) => thread.id === activeThreadId);
    if (activeThread?.agentType) {
      setActiveSessionAgentType(activeThread.agentType);
    }
    setThreadGroups((current) => upsertThreadGroup(current, workspaceId, nextThreads));
    return nextThreads;
  }, [activeThreadId, runtimeProvider, serviceRunning, setActiveSessionAgentType, setThreadGroups]);

  const refreshWorkspacesAndThreads = useCallback(async () => {
    if (!serviceRunning) {
      setProjects([]);
      setThreadGroups([]);
      setSelectedKnowledgeBaseIds([]);
      return [];
    }
    const nextWorkspaceIds = runtimeProvider === 'local_core'
      ? (await listWorkspaces()).workspaces.map((workspace) => workspace.id)
      : (await listProjects()).projects.map((project) => project.name);
    setProjects(nextWorkspaceIds);
    const nextGroups = (
      await Promise.all(
        nextWorkspaceIds.map(async (workspaceId) => ({
          project: workspaceId,
          sessions: await refreshThreadsForWorkspace(workspaceId),
        })),
      )
    ).sort((a, b) => a.project.localeCompare(b.project));
    setThreadGroups(nextGroups);
    setSelectedProject((current) => current || requestedWorkspaceId || runtimeDefaultWorkspaceId || nextWorkspaceIds[0] || '');
    return nextGroups;
  }, [
    refreshThreadsForWorkspace,
    requestedWorkspaceId,
    runtimeDefaultWorkspaceId,
    runtimeProvider,
    serviceRunning,
    setProjects,
    setSelectedProject,
    setThreadGroups,
  ]);

  const loadActiveThread = useCallback(async (workspaceId: string, threadId: string) => {
    if (!workspaceId || !threadId || !serviceRunning) {
      return;
    }
    clearLocalCorePolling();
    updateTaskState('idle');
    setTyping(false);
    if (runtimeProvider === 'local_core') {
      const detail = await getThread(threadId);
      if (holdBlankComposerRef.current) {
        return;
      }
      applyLocalCoreThreadDetail(detail);
      return;
    }
    const detail = await getSession(workspaceId, threadId, 200);
    const selectedKnowledgeBaseIds = await getThreadKnowledgeBases(workspaceId, threadId).catch(() => []);
    if (holdBlankComposerRef.current) {
      return;
    }
    lastSessionByProjectRef.current[workspaceId] = detail.id;
    setSelectedProject(workspaceId);
    setActiveSessionId(detail.id);
    setActiveSessionKey(detail.session_key);
    setActiveSessionName(toChatThreadSummary(workspaceId, detail).name);
    setActiveSessionAgentType(detail.agent_type || '');
    setSelectedKnowledgeBaseIds(selectedKnowledgeBaseIds);
    setActiveRunId('');
    setThreadGroups((current) => upsertThreadInGroup(current, workspaceId, toChatThreadSummary(workspaceId, detail)));
    holdBlankComposerRef.current = false;
    progressSequenceByTurnRef.current = {};
    const nextMessages = toMessages(detail.history || []);
    nextMessageOrderRef.current = nextMessages.length;
    pendingTurnRef.current = null;
    setMessages(nextMessages);
  }, [
    applyLocalCoreThreadDetail,
    clearLocalCorePolling,
    holdBlankComposerRef,
    lastSessionByProjectRef,
    nextMessageOrderRef,
    pendingTurnRef,
    progressSequenceByTurnRef,
    runtimeProvider,
    serviceRunning,
    setActiveRunId,
    setActiveSessionAgentType,
    setActiveSessionId,
    setActiveSessionKey,
    setActiveSessionName,
    setSelectedKnowledgeBaseIds,
    setMessages,
    setSelectedProject,
    setThreadGroups,
    setTyping,
    updateTaskState,
  ]);

  useEffect(() => {
    if (!serviceRunning) {
      setThreadGroups([]);
      setMessages([]);
      setSelectedKnowledgeBaseIds([]);
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
    void refreshWorkspacesAndThreads();
  }, [
    clearLocalCorePolling,
    clearReplyTimeout,
    nextMessageOrderRef,
    pendingTurnRef,
    progressSequenceByTurnRef,
    refreshWorkspacesAndThreads,
    serviceRunning,
    setActiveRunId,
    setActiveSessionAgentType,
    setBridgeError,
    setMessages,
    setSelectedKnowledgeBaseIds,
    setThreadGroups,
    setTyping,
    updateTaskState,
  ]);

  useEffect(() => {
    if (!selectedWorkspaceId || !serviceRunning) {
      return;
    }

    const activeInWorkspace = threadsForSelectedWorkspace.find((thread) => thread.id === activeThreadId);
    if (activeInWorkspace) {
      return;
    }

    const preferredThreadId = requestedWorkspaceId === selectedWorkspaceId ? requestedThreadId : '';
    const rememberedThreadId = lastSessionByProjectRef.current[selectedWorkspaceId];
    if (!activeThreadId && holdBlankComposerRef.current) {
      return;
    }
    const targetThread =
      threadsForSelectedWorkspace.find((thread) => thread.id === preferredThreadId) ||
      threadsForSelectedWorkspace.find((thread) => thread.id === rememberedThreadId) ||
      threadsForSelectedWorkspace[0];

    if (targetThread) {
      setTyping(false);
      updateTaskState('idle');
      setBridgeError('');
      clearLocalCorePolling();
      clearReplyTimeout();
      void loadActiveThread(selectedWorkspaceId, targetThread.id);
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
    activeThreadId,
    clearLocalCorePolling,
    clearReplyTimeout,
    holdBlankComposerRef,
    lastSessionByProjectRef,
    loadActiveThread,
    nextMessageOrderRef,
    pendingTurnRef,
    progressSequenceByTurnRef,
    requestedThreadId,
    requestedWorkspaceId,
    selectedWorkspaceId,
    serviceRunning,
    setActiveRunId,
    setActiveSessionAgentType,
    setActiveSessionId,
    setActiveSessionKey,
    setActiveSessionName,
    setBridgeError,
    setMessages,
    setTyping,
    threadsForSelectedWorkspace,
    updateTaskState,
  ]);

  useEffect(() => {
    if (!selectedWorkspaceId && !activeThreadId) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    if (selectedWorkspaceId) {
      next.set('project', selectedWorkspaceId);
    } else {
      next.delete('project');
    }
    if (activeThreadId) {
      next.set('session', activeThreadId);
    } else {
      next.delete('session');
    }
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [activeThreadId, searchParams, selectedWorkspaceId, setSearchParams]);

  return {
    filteredThreadGroups,
    loadActiveThread,
    refreshThreadsForWorkspace,
    refreshWorkspacesAndThreads,
  };
}
