import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  bridgeConnect,
} from '@/api/desktop';
import { getRuntimeBranding } from '@/lib/runtime-branding';
import {
  sendAction,
} from '../../../packages/core-sdk/src';
import {
  type ThreadActionTarget,
  type ThreadGroup,
} from './thread-chat-model';
import { useThreadChatRuntimeState } from './useThreadChatRuntimeState';
import { useThreadChatSessionBrowser } from './useThreadChatSessionBrowser';
import { useThreadChatBridge } from './useThreadChatBridge';
import { useThreadChatActions } from './useThreadChatActions';
import { useThreadChatConversationState } from './useThreadChatConversationState';

export function useThreadChatController() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [threadGroups, setThreadGroups] = useState<ThreadGroup[]>([]);
  const [activeThreadId, setActiveThreadId] = useState('');
  const [activeBridgeSessionKey, setActiveBridgeSessionKey] = useState('');
  const [activeThreadName, setActiveThreadName] = useState('');
  const [activeAgentType, setActiveAgentType] = useState('');
  const [activeRunId, setActiveRunId] = useState('');
  const [draft, setDraft] = useState('');
  const [threadSearch, setThreadSearch] = useState('');
  const [renameTarget, setRenameTarget] = useState<ThreadActionTarget | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ThreadActionTarget | null>(null);
  const [pendingSessionAction, setPendingSessionAction] = useState<'rename' | 'delete' | null>(null);
  const [pendingBridgeActionId, setPendingBridgeActionId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [bridgeError, setBridgeError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const requestedWorkspaceId = searchParams.get('project') || '';
  const requestedThreadId = searchParams.get('session') || '';
  const branding = getRuntimeBranding();
  const {
    applyLocalCoreThreadDetail,
    armReplyTimeout,
    clearActionStatuses,
    clearLocalCorePolling,
    clearReplyTimeout,
    finalizeTurnMessages,
    holdBlankComposerRef,
    lastSessionByProjectRef,
    messages,
    nextMessageOrderRef,
    nextProgressMessageId,
    pendingTurnRef,
    progressSequenceByTurnRef,
    renderedMessages,
    reserveAssistantMessageOrder,
    reserveNextMessageOrder,
    setMessages,
    setTyping,
    startLocalCoreThreadPolling,
    taskHint,
    taskRunning,
    taskState,
    taskStateRef,
    typing,
    updateTaskState,
  } = useThreadChatConversationState({
    activeThreadId,
    brandingReplyTimeoutLabel: branding.replyTimeoutLabel,
    setActiveRunId,
    setActiveSessionAgentType: setActiveAgentType,
    setActiveSessionId: setActiveThreadId,
    setActiveSessionKey: setActiveBridgeSessionKey,
    setActiveSessionName: setActiveThreadName,
    setBridgeError,
    setSelectedProject: setSelectedWorkspaceId,
    setThreadGroups,
  });

  const {
    loading,
    refreshRuntime,
    runtime,
    runtimeProvider,
    serviceRunning,
    showSessionKey,
    transportReady,
  } = useThreadChatRuntimeState({
    requestedProject: requestedWorkspaceId,
    selectedProject: selectedWorkspaceId,
    setSelectedProject: setSelectedWorkspaceId,
    clearReplyTimeout,
    updateTaskState,
    setTyping,
  });

  const {
    filteredThreadGroups,
    loadActiveThread,
    refreshThreadsForWorkspace,
  } = useThreadChatSessionBrowser({
    activeThreadId,
    requestedWorkspaceId,
    requestedThreadId,
    runtimeDefaultWorkspaceId: runtime?.settings.defaultProject,
    runtimeProvider,
    searchParams,
    selectedWorkspaceId,
    serviceRunning,
    workspaceIds,
    threadGroups,
    threadSearch,
    setActiveRunId,
    setActiveSessionAgentType: setActiveAgentType,
    setActiveSessionId: setActiveThreadId,
    setActiveSessionKey: setActiveBridgeSessionKey,
    setActiveSessionName: setActiveThreadName,
    setBridgeError,
    setMessages,
    setProjects: setWorkspaceIds,
    setSearchParams,
    setSelectedProject: setSelectedWorkspaceId,
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
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [renderedMessages, typing]);

  useEffect(() => {
    if (serviceRunning) {
      void bridgeConnect();
    }
  }, [serviceRunning]);

  const { handleBridgeAction } = useThreadChatBridge({
    activeAgentType,
    activeThreadId,
    activeRunId,
    activeBridgeSessionKey,
    messages,
    runtimeProvider,
    selectedWorkspaceId,
    clearActionStatuses,
    clearLocalCorePolling,
    clearReplyTimeout,
    finalizeTurnMessages,
    nextProgressMessageId,
    refreshThreadsForWorkspace,
    reserveAssistantMessageOrder,
    reserveNextMessageOrder,
    setActiveRunId,
    setBridgeError,
    setMessages,
    setPendingBridgeActionId,
    setTyping,
    startLocalCoreThreadPolling,
    updateTaskState,
    armReplyTimeout,
    pendingTurnRef,
    progressSequenceByTurnRef,
    sendAction,
    taskStateRef,
  });

  const {
    handleCreateNew,
    handleDeleteSession,
    handleRenameSession,
    handleSend,
    handleStopTask,
    openRenameModal,
  } = useThreadChatActions({
    activeRunId,
    activeThreadId,
    activeBridgeSessionKey,
    brandingNewThreadLabel: branding.newThreadLabel,
    deleteTarget,
    draft,
    loadActiveThread,
    messages,
    renameDraft,
    renameTarget,
    runtimeProvider,
    searchParams,
    selectedWorkspaceId,
    taskState,
    updateTaskState,
    applyLocalCoreThreadDetail,
    armReplyTimeout,
    clearLocalCorePolling,
    clearReplyTimeout,
    refreshSessionsForProject: refreshThreadsForWorkspace,
    reserveNextMessageOrder,
    setActiveRunId,
    setActiveSessionAgentType: setActiveAgentType,
    setActiveSessionId: setActiveThreadId,
    setActiveSessionKey: setActiveBridgeSessionKey,
    setActiveSessionName: setActiveThreadName,
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
  });

  return {
    activeRunId,
    activeSessionId: activeThreadId,
    activeSessionKey: activeBridgeSessionKey,
    activeSessionName: activeThreadName,
    bridgeError,
    branding,
    deleteTarget,
    draft,
    endRef,
    filteredSessionGroups: filteredThreadGroups,
    handleBridgeAction,
    handleCreateNew,
    handleDeleteSession,
    handleRenameSession,
    handleSend,
    handleStopTask,
    loadActiveSession: loadActiveThread,
    loading,
    openRenameModal,
    pendingBridgeActionId,
    pendingSessionAction,
    projects: workspaceIds,
    refreshRuntime,
    renameDraft,
    renameTarget,
    renderedMessages,
    runtime,
    sending,
    serviceRunning,
    sessionSearch: threadSearch,
    selectedProject: selectedWorkspaceId,
    setDeleteTarget,
    setDraft,
    setRenameDraft,
    setRenameTarget,
    setSelectedProject: setSelectedWorkspaceId,
    setSessionSearch: setThreadSearch,
    showSessionKey,
    taskHint,
    taskRunning,
    taskState,
    transportReady,
  };
}
