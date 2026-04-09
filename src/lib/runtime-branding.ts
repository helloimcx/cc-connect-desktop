import { getRuntimeProvider } from '@/app/runtime';

export interface RuntimeBranding {
  chatTitle: string;
  chatHeading: string;
  chatDescription: string;
  scopeLabel: string;
  scopeSelectPlaceholder: string;
  searchPlaceholder: string;
  startRuntimeLabel: string;
  startingRuntimeLabel: string;
  newThreadLabel: string;
  pendingRestartLabel: string;
  emptySelectionLabel: string;
  emptyThreadsLabel: string;
  emptySearchLabel: string;
  collectionLabel: string;
  activeScopeLabel: string;
  activeConversationFallback: string;
  startConversationLabel: string;
  runtimeOnlineLabel: string;
  runtimeOfflineLabel: string;
  emptyConversationLabel: string;
  startFirstPlaceholder: string;
  waitingRuntimePlaceholder: string;
  sendPlaceholder: string;
  permissionUnsupportedLabel: string;
  replyTimeoutLabel: string;
}

export function getRuntimeBranding(): RuntimeBranding {
  const provider = getRuntimeProvider();
  if (provider === 'local_core') {
    return {
      chatTitle: 'Chat',
      chatHeading: 'Chat',
      chatDescription: 'Browse threads, switch workspaces, and stay in sync with your local AI Core.',
      scopeLabel: 'Compose in workspace',
      scopeSelectPlaceholder: 'Select a workspace',
      searchPlaceholder: 'Search threads, contacts, or message preview',
      startRuntimeLabel: 'Start Runtime',
      startingRuntimeLabel: 'Starting…',
      newThreadLabel: 'New thread',
      pendingRestartLabel: 'The latest config is already saved, but this chat is still using the previous runtime state. Restart the runtime to apply it.',
      emptySelectionLabel: 'Select a workspace to start messaging.',
      emptyThreadsLabel: 'No threads yet.',
      emptySearchLabel: 'No matching threads.',
      collectionLabel: 'threads',
      activeScopeLabel: 'active workspace',
      activeConversationFallback: 'New conversation',
      startConversationLabel: 'Select a workspace to start chatting.',
      runtimeOnlineLabel: 'runtime online',
      runtimeOfflineLabel: 'runtime offline',
      emptyConversationLabel: 'Send a message to create a new thread in the selected workspace.',
      startFirstPlaceholder: 'Start the runtime first',
      waitingRuntimePlaceholder: 'Waiting for the runtime channel to connect',
      sendPlaceholder: 'Send a message to this thread',
      permissionUnsupportedLabel: 'This agent cannot continue interactive approvals in the current chat. Switch to a supported agent or adjust the runtime permissions before retrying.',
      replyTimeoutLabel: 'Permission response was sent, but the agent did not continue. This request may not support local runtime continuation.',
    };
  }

  return {
    chatTitle: 'Desktop Chat',
    chatHeading: 'Desktop Chat',
    chatDescription: 'Search sessions, jump across projects, and keep one live desktop conversation open.',
    scopeLabel: 'Compose in project',
    scopeSelectPlaceholder: 'Select a project',
    searchPlaceholder: 'Search sessions, users, or message preview',
    startRuntimeLabel: 'Start Service',
    startingRuntimeLabel: 'Starting…',
    newThreadLabel: 'New chat',
    pendingRestartLabel: 'The latest config is already saved, but this chat is still using the previous runtime state. Restart the desktop service to apply it.',
    emptySelectionLabel: 'Select a project to start messaging.',
    emptyThreadsLabel: 'No desktop sessions yet.',
    emptySearchLabel: 'No matching sessions.',
    collectionLabel: 'sessions',
    activeScopeLabel: 'active project',
    activeConversationFallback: 'New desktop conversation',
    startConversationLabel: 'Select a project to start chatting.',
    runtimeOnlineLabel: 'bridge online',
    runtimeOfflineLabel: 'bridge offline',
    emptyConversationLabel: 'Send a message to create a desktop session in the selected project.',
    startFirstPlaceholder: 'Start the service first',
    waitingRuntimePlaceholder: 'Waiting for the desktop bridge to connect',
    sendPlaceholder: 'Send a message to the desktop channel',
    permissionUnsupportedLabel: 'This agent cannot continue interactive permission approvals in Desktop Chat. Switch to opencode, claudecode, or acp, or adjust the agent permissions/work_dir before retrying.',
    replyTimeoutLabel: 'Permission response was sent, but the agent did not continue. This agent or request may not support desktop continuation.',
  };
}
