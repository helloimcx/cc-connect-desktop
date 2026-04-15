import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { RuntimeProvider } from '@/app/runtime';
import type { ThreadDetail } from '../../../packages/contracts/src';
import type { ChatMessage, ChatTaskState, ThreadActionTarget, ThreadGroup } from './thread-chat-model';

export type ThreadChatSearchParamsSetter = (
  nextInit: URLSearchParams,
  navigateOptions?: { replace?: boolean },
) => void;

export type ThreadChatRefreshSessionsForProject = (
  project: string,
) => Promise<Array<{ id: string; bridgeSessionKey?: string }>>;

export type ThreadChatRefreshThreadsForWorkspace = (
  workspaceId: string,
) => Promise<Array<{ id: string; bridgeSessionKey?: string }>>;

export type ThreadChatPendingTurnRef = MutableRefObject<{ sessionKey: string; userOrder: number } | null>;

export type ThreadChatConversationRefs = {
  holdBlankComposerRef: MutableRefObject<boolean>;
  nextMessageOrderRef: MutableRefObject<number>;
  pendingTurnRef: ThreadChatPendingTurnRef;
  progressSequenceByTurnRef: MutableRefObject<Record<string, number>>;
};

export type ThreadChatSendingRefs = ThreadChatConversationRefs & {
  lastSessionByProjectRef: MutableRefObject<Record<string, string>>;
  taskStateRef: MutableRefObject<ChatTaskState>;
};

export type ThreadChatCoreSetters = {
  setBridgeError: Dispatch<SetStateAction<string>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setTyping: Dispatch<SetStateAction<boolean>>;
};

export type ThreadChatIdentitySetters = {
  setActiveRunId: Dispatch<SetStateAction<string>>;
  setActiveSessionAgentType: Dispatch<SetStateAction<string>>;
  setActiveSessionId: Dispatch<SetStateAction<string>>;
  setActiveSessionKey: Dispatch<SetStateAction<string>>;
  setActiveSessionName: Dispatch<SetStateAction<string>>;
};

export type ThreadChatModalSetters = {
  setDeleteTarget: Dispatch<SetStateAction<ThreadActionTarget | null>>;
  setPendingSessionAction: Dispatch<SetStateAction<'rename' | 'delete' | null>>;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  setRenameTarget: Dispatch<SetStateAction<ThreadActionTarget | null>>;
};

export type ThreadChatSharedActionContext = {
  runtimeProvider: RuntimeProvider;
  selectedProject: string;
  updateTaskState: (next: ChatTaskState, reason?: string) => void;
  applyLocalCoreThreadDetail: (detail: ThreadDetail) => void;
  clearLocalCorePolling: () => void;
  clearReplyTimeout: () => void;
  refreshSessionsForProject: ThreadChatRefreshSessionsForProject;
} & ThreadChatCoreSetters &
  ThreadChatConversationRefs;

export type ThreadChatSharedHookContext = {
  runtimeProvider: RuntimeProvider;
  selectedWorkspaceId: string;
  updateTaskState: (next: ChatTaskState, reason?: string) => void;
  applyLocalCoreThreadDetail: (detail: ThreadDetail) => void;
  clearLocalCorePolling: () => void;
  clearReplyTimeout: () => void;
  refreshThreadsForWorkspace: ThreadChatRefreshThreadsForWorkspace;
} & ThreadChatCoreSetters &
  ThreadChatConversationRefs;

export type ThreadChatActiveThreadIdentity = {
  activeThreadId: string;
  activeBridgeSessionKey: string;
  activeAgentType: string;
  activeRunId: string;
};

export type ThreadChatBrowserSetters = {
  setActiveRunId: Dispatch<SetStateAction<string>>;
  setActiveSessionAgentType: Dispatch<SetStateAction<string>>;
  setActiveSessionId: Dispatch<SetStateAction<string>>;
  setActiveSessionKey: Dispatch<SetStateAction<string>>;
  setActiveSessionName: Dispatch<SetStateAction<string>>;
  setProjects: Dispatch<SetStateAction<string[]>>;
  setSelectedProject: Dispatch<SetStateAction<string>>;
  setThreadGroups: Dispatch<SetStateAction<ThreadGroup[]>>;
  setSearchParams: ThreadChatSearchParamsSetter;
};
