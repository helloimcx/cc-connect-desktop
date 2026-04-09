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
