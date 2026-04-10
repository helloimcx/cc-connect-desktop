import { useCallback, useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { listProjects } from '@/api/projects';
import { getSession, listSessions } from '@/api/sessions';
import { listThreads, listWorkspaces, getThread } from '../../../packages/core-sdk/src';
import type { ThreadDetail } from '../../../packages/contracts/src';
import type { RuntimeProvider } from '@/app/runtime';
import type { ChatMessage, ChatTaskState, SessionGroup } from './thread-chat-model';
import {
  chatThreadMatchesSearch,
  sessionMatchesDesktop,
  sortChatThreadsByLiveAndUpdated,
  toChatThreadSummary,
  toCoreChatThreadSummary,
  toMessages,
  upsertSessionGroup,
  upsertThreadInGroup,
} from './thread-chat-model';

type UseThreadChatSessionBrowserInput = {
  activeSessionId: string;
  requestedProject: string;
  requestedSessionId: string;
  runtimeDefaultProject?: string;
  runtimeProvider: RuntimeProvider;
  searchParams: URLSearchParams;
  selectedProject: string;
  serviceRunning: boolean;
  projects: string[];
  sessionGroups: SessionGroup[];
  sessionSearch: string;
  setActiveRunId: Dispatch<SetStateAction<string>>;
  setActiveSessionAgentType: Dispatch<SetStateAction<string>>;
  setActiveSessionId: Dispatch<SetStateAction<string>>;
  setActiveSessionKey: Dispatch<SetStateAction<string>>;
  setActiveSessionName: Dispatch<SetStateAction<string>>;
  setBridgeError: Dispatch<SetStateAction<string>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setProjects: Dispatch<SetStateAction<string[]>>;
  setSearchParams: (nextInit: URLSearchParams, navigateOptions?: { replace?: boolean }) => void;
  setSelectedProject: Dispatch<SetStateAction<string>>;
  setSessionGroups: Dispatch<SetStateAction<SessionGroup[]>>;
  setTyping: Dispatch<SetStateAction<boolean>>;
  applyLocalCoreThreadDetail: (detail: ThreadDetail) => void;
  clearLocalCorePolling: () => void;
  clearReplyTimeout: () => void;
  updateTaskState: (next: ChatTaskState) => void;
  holdBlankComposerRef: MutableRefObject<boolean>;
  lastSessionByProjectRef: MutableRefObject<Record<string, string>>;
  nextMessageOrderRef: MutableRefObject<number>;
  pendingTurnRef: MutableRefObject<{ sessionKey: string; userOrder: number } | null>;
  progressSequenceByTurnRef: MutableRefObject<Record<string, number>>;
};

export function useThreadChatSessionBrowser({
  activeSessionId,
  requestedProject,
  requestedSessionId,
  runtimeDefaultProject,
  runtimeProvider,
  searchParams,
  selectedProject,
  serviceRunning,
  projects,
  sessionGroups,
  sessionSearch,
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
  setSessionGroups,
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
  const sessionsForSelectedProject = useMemo(
    () => sessionGroups.find((group) => group.project === selectedProject)?.sessions || [],
    [selectedProject, sessionGroups],
  );

  const filteredSessionGroups = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    return projects
      .map((project) => {
        const sessions = (sessionGroups.find((group) => group.project === project)?.sessions || []).filter((session) =>
          chatThreadMatchesSearch(session, query),
        );
        return { project, sessions };
      })
      .filter((group) => group.sessions.length > 0 || (!query && group.project === selectedProject));
  }, [projects, selectedProject, sessionGroups, sessionSearch]);

  const refreshSessionsForProject = useCallback(async (project: string) => {
    if (!project || !serviceRunning) {
      return [];
    }
    const nextSessions = runtimeProvider === 'local_core'
      ? sortChatThreadsByLiveAndUpdated((await listThreads(project)).threads.map((thread) => toCoreChatThreadSummary(thread)))
      : sortChatThreadsByLiveAndUpdated(
          ((await listSessions(project)).sessions || [])
            .filter(sessionMatchesDesktop)
            .map((session) => toChatThreadSummary(project, session)),
        );
    const activeSession = nextSessions.find((session) => session.id === activeSessionId);
    if (activeSession?.agentType) {
      setActiveSessionAgentType(activeSession.agentType);
    }
    setSessionGroups((current) => upsertSessionGroup(current, project, nextSessions));
    return nextSessions;
  }, [activeSessionId, runtimeProvider, serviceRunning, setActiveSessionAgentType, setSessionGroups]);

  const refreshProjectsAndSessions = useCallback(async () => {
    if (!serviceRunning) {
      setProjects([]);
      setSessionGroups([]);
      return [];
    }
    const names = runtimeProvider === 'local_core'
      ? (await listWorkspaces()).workspaces.map((workspace) => workspace.id)
      : (await listProjects()).projects.map((project) => project.name);
    setProjects(names);
    const groups = (
      await Promise.all(
        names.map(async (project) => {
          return {
            project,
            sessions: await refreshSessionsForProject(project),
          };
        }),
      )
    ).sort((a, b) => a.project.localeCompare(b.project));
    setSessionGroups(groups);
    setSelectedProject((current) => current || requestedProject || runtimeDefaultProject || names[0] || '');
    return groups;
  }, [
    refreshSessionsForProject,
    requestedProject,
    runtimeDefaultProject,
    runtimeProvider,
    serviceRunning,
    setProjects,
    setSelectedProject,
    setSessionGroups,
  ]);

  const loadActiveSession = useCallback(async (project: string, sessionId: string) => {
    if (!project || !sessionId || !serviceRunning) {
      return;
    }
    clearLocalCorePolling();
    updateTaskState('idle');
    setTyping(false);
    if (runtimeProvider === 'local_core') {
      const detail = await getThread(sessionId);
      applyLocalCoreThreadDetail(detail);
      return;
    }
    const detail = await getSession(project, sessionId, 200);
    lastSessionByProjectRef.current[project] = detail.id;
    setSelectedProject(project);
    setActiveSessionId(detail.id);
    setActiveSessionKey(detail.session_key);
    setActiveSessionName(toChatThreadSummary(project, detail).name);
    setActiveSessionAgentType(detail.agent_type || '');
    setActiveRunId('');
    setSessionGroups((current) => upsertThreadInGroup(current, project, toChatThreadSummary(project, detail)));
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
    setMessages,
    setSelectedProject,
    setSessionGroups,
    setTyping,
    updateTaskState,
  ]);

  useEffect(() => {
    if (!serviceRunning) {
      setSessionGroups([]);
      setMessages([]);
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
    void refreshProjectsAndSessions();
  }, [
    clearLocalCorePolling,
    clearReplyTimeout,
    nextMessageOrderRef,
    pendingTurnRef,
    progressSequenceByTurnRef,
    refreshProjectsAndSessions,
    serviceRunning,
    setActiveRunId,
    setActiveSessionAgentType,
    setBridgeError,
    setMessages,
    setSessionGroups,
    setTyping,
    updateTaskState,
  ]);

  useEffect(() => {
    if (!selectedProject || !serviceRunning) {
      return;
    }

    const activeInProject = sessionsForSelectedProject.find((session) => session.id === activeSessionId);
    if (activeInProject) {
      return;
    }

    const preferredSessionId = requestedProject === selectedProject ? requestedSessionId : '';
    const rememberedSessionId = lastSessionByProjectRef.current[selectedProject];
    if (!activeSessionId && holdBlankComposerRef.current) {
      return;
    }
    const targetSession =
      sessionsForSelectedProject.find((session) => session.id === preferredSessionId) ||
      sessionsForSelectedProject.find((session) => session.id === rememberedSessionId) ||
      sessionsForSelectedProject[0];

    if (targetSession) {
      setTyping(false);
      updateTaskState('idle');
      setBridgeError('');
      clearLocalCorePolling();
      clearReplyTimeout();
      void loadActiveSession(selectedProject, targetSession.id);
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
    activeSessionId,
    clearLocalCorePolling,
    clearReplyTimeout,
    holdBlankComposerRef,
    lastSessionByProjectRef,
    loadActiveSession,
    nextMessageOrderRef,
    pendingTurnRef,
    progressSequenceByTurnRef,
    requestedProject,
    requestedSessionId,
    selectedProject,
    serviceRunning,
    sessionsForSelectedProject,
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

  useEffect(() => {
    if (!selectedProject && !activeSessionId) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    if (selectedProject) {
      next.set('project', selectedProject);
    } else {
      next.delete('project');
    }
    if (activeSessionId) {
      next.set('session', activeSessionId);
    } else {
      next.delete('session');
    }
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [activeSessionId, searchParams, selectedProject, setSearchParams]);

  return {
    filteredSessionGroups,
    loadActiveSession,
    refreshProjectsAndSessions,
    refreshSessionsForProject,
  };
}
