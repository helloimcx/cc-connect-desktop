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
  type SessionActionTarget,
  type SessionGroup,
} from './thread-chat-model';
import { useThreadChatRuntimeState } from './useThreadChatRuntimeState';
import { useThreadChatSessionBrowser } from './useThreadChatSessionBrowser';
import { useThreadChatBridge } from './useThreadChatBridge';
import { useThreadChatActions } from './useThreadChatActions';
import { useThreadChatConversationState } from './useThreadChatConversationState';

export function useThreadChatController() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [sessionGroups, setSessionGroups] = useState<SessionGroup[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [activeSessionKey, setActiveSessionKey] = useState('');
  const [activeSessionName, setActiveSessionName] = useState('');
  const [activeSessionAgentType, setActiveSessionAgentType] = useState('');
  const [activeRunId, setActiveRunId] = useState('');
  const [draft, setDraft] = useState('');
  const [sessionSearch, setSessionSearch] = useState('');
  const [renameTarget, setRenameTarget] = useState<SessionActionTarget | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SessionActionTarget | null>(null);
  const [pendingSessionAction, setPendingSessionAction] = useState<'rename' | 'delete' | null>(null);
  const [pendingBridgeActionId, setPendingBridgeActionId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [bridgeError, setBridgeError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const requestedProject = searchParams.get('project') || '';
  const requestedSessionId = searchParams.get('session') || '';
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
    activeSessionId,
    brandingReplyTimeoutLabel: branding.replyTimeoutLabel,
    setActiveRunId,
    setActiveSessionAgentType,
    setActiveSessionId,
    setActiveSessionKey,
    setActiveSessionName,
    setBridgeError,
    setSelectedProject,
    setSessionGroups,
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
    requestedProject,
    selectedProject,
    setSelectedProject,
    clearReplyTimeout,
    updateTaskState,
    setTyping,
  });

  const {
    filteredSessionGroups,
    loadActiveSession,
    refreshSessionsForProject,
  } = useThreadChatSessionBrowser({
    activeSessionId,
    requestedProject,
    requestedSessionId,
    runtimeDefaultProject: runtime?.settings.defaultProject,
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
    activeSessionAgentType,
    activeSessionId,
    activeSessionKey,
    messages,
    runtimeProvider,
    selectedProject,
    clearActionStatuses,
    clearLocalCorePolling,
    clearReplyTimeout,
    finalizeTurnMessages,
    nextProgressMessageId,
    refreshSessionsForProject,
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
    activeSessionId,
    activeSessionKey,
    brandingNewThreadLabel: branding.newThreadLabel,
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
  });

  return {
    activeRunId,
    activeSessionId,
    activeSessionKey,
    activeSessionName,
    bridgeError,
    branding,
    deleteTarget,
    draft,
    endRef,
    filteredSessionGroups,
    handleBridgeAction,
    handleCreateNew,
    handleDeleteSession,
    handleRenameSession,
    handleSend,
    handleStopTask,
    loadActiveSession,
    loading,
    openRenameModal,
    pendingBridgeActionId,
    pendingSessionAction,
    projects,
    refreshRuntime,
    renameDraft,
    renameTarget,
    renderedMessages,
    runtime,
    sending,
    serviceRunning,
    sessionSearch,
    selectedProject,
    setDeleteTarget,
    setDraft,
    setRenameDraft,
    setRenameTarget,
    setSelectedProject,
    setSessionSearch,
    showSessionKey,
    taskHint,
    taskRunning,
    taskState,
    transportReady,
  };
}
