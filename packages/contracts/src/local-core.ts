import type { DesktopBridgeEvent, DesktopRuntimeStatus } from '../../../shared/desktop';

export interface WorkspaceSummary {
  id: string;
  name: string;
  agentType: string;
  platforms: string[];
  sessionsCount: number;
  heartbeatEnabled: boolean;
}

export interface ThreadSummary {
  id: string;
  workspaceId: string;
  title: string;
  live: boolean;
  updatedAt: string;
  createdAt: string;
  historyCount: number;
  excerpt: string;
  participantName?: string;
  runId?: string;
  bridgeSessionKey?: string;
  agentType?: string;
}

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  kind?: 'final' | 'progress' | 'system';
}

export interface ThreadDetail extends ThreadSummary {
  messages: ThreadMessage[];
}

export interface RunSummary {
  id: string;
  threadId: string;
  status: 'queued' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  updatedAt: string;
}

export interface KnowledgeSource {
  id: string;
  name: string;
  type: string;
  status: 'ready' | 'indexing' | 'error';
  description?: string;
  fileCount?: number;
  wordCount?: number;
}

export interface KnowledgeFolder {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  folderId: string | null;
  creatorName: string;
  icon: string;
  fileCount: number;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeFile {
  knowledgebaseId?: string | null;
  fileId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  folder?: string | null;
  createTime: string;
  wordCount?: number | null;
  metadata?: Record<string, unknown> | null;
  abstract?: string | null;
  fullContent?: string | null;
}

export interface KnowledgeSearchResult {
  id: string;
  knowledgeBaseId: string;
  fileId: string;
  fileName: string;
  title: string;
  snippet: string;
  score: number;
  chunkOffset: number;
  content: string;
}

export interface KnowledgeUploadResult {
  fileId: string;
  fileName: string;
  fileType: string;
  success: boolean;
  message: string;
  wordCount?: number | null;
}

export interface KnowledgeConfig {
  baseUrl: string;
  authMode: 'none' | 'bearer' | 'header';
  token: string;
  headerName: string;
  defaultCollection: string;
}

export interface KnowledgeFolderCreateInput {
  name: string;
  parentId?: string | null;
}

export interface KnowledgeFolderUpdateInput {
  name: string;
}

export interface KnowledgeBaseCreateInput {
  name: string;
  description?: string;
  folderId?: string | null;
  creatorName?: string;
  icon?: string;
}

export interface KnowledgeBaseUpdateInput {
  name?: string;
  description?: string;
  folderId?: string | null;
  creatorName?: string;
  icon?: string;
}

export interface KnowledgeSearchInput {
  query: string;
  limit?: number;
}

export interface LocalCoreCapabilities {
  adapters: {
    channels: string[];
    agents: string[];
    knowledge: boolean;
  };
}

export interface LocalCoreHealth {
  name: string;
  version: string;
}

export type LocalCoreEvent =
  | { type: 'runtime.updated'; runtime: DesktopRuntimeStatus }
  | { type: 'thread.updated'; thread: ThreadSummary }
  | { type: 'message.created'; threadId: string; message: ThreadMessage; bridge?: DesktopBridgeEvent }
  | { type: 'message.updated'; threadId: string; message: Partial<ThreadMessage>; bridge?: DesktopBridgeEvent }
  | { type: 'run.updated'; run: RunSummary; bridge?: DesktopBridgeEvent }
  | { type: 'presence.updated'; threadId?: string; live: boolean; bridge?: DesktopBridgeEvent }
  | { type: 'bridge.updated'; bridge: DesktopBridgeEvent };
