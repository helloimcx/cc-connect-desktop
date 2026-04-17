import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  ConfigFileState,
  DesktopBridgeEvent,
  DesktopBridgeSendInput,
  DesktopBridgeSendResult,
  DesktopProjectConfig,
  LocalCoreCapabilities,
  WorkspaceStreamingProbeEvent,
  WorkspaceStreamingProbeResult,
  ThreadDetail,
  ThreadMessage,
  ThreadSummary,
  WorkspaceSummary,
} from '../../../packages/contracts/src/index.js';
import {
  LOCALCORE_ACP_AGENT_TYPE,
  type DesktopBridgeButtonOption,
  normalizeDesktopBridgeButtonOption,
} from '../../../shared/desktop.js';
import type { KnowledgeProvider } from '../../../packages/knowledge-api/src/index.js';

export function encodeThreadId(workspaceId: string, sessionId: string) {
  return `${encodeURIComponent(workspaceId)}::${encodeURIComponent(sessionId)}`;
}

export function decodeThreadId(threadId: string) {
  const [workspacePart, sessionPart] = threadId.split('::');
  if (!workspacePart || !sessionPart) {
    throw new Error(`Invalid thread id: ${threadId}`);
  }
  return {
    workspaceId: decodeURIComponent(workspacePart),
    sessionId: decodeURIComponent(sessionPart),
  };
}

type ManagementSession = {
  id: string;
  session_key: string;
  name: string;
  platform: string;
  agent_type: string;
  active: boolean;
  live: boolean;
  created_at: string;
  updated_at: string;
  history_count: number;
  last_message: { content: string } | null;
  user_name?: string;
  chat_name?: string;
};

type ManagementSessionDetail = ManagementSession & {
  history: Array<{ role: string; content: string; kind?: string; timestamp: string }>;
};

type ManagementProject = {
  name: string;
  agent_type: string;
  platforms: string[];
  sessions_count: number;
  heartbeat_enabled: boolean;
};

type WorkspaceRouterOptions = {
  userDataPath: string;
  readConfigState: () => Promise<ConfigFileState>;
  managementRequest: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  bridgeSendMessage: (input: DesktopBridgeSendInput) => Promise<DesktopBridgeSendResult>;
  subscribeToBridgeEvents?: (listener: (event: DesktopBridgeEvent) => void) => () => void;
  knowledgeProvider: KnowledgeProvider;
  emitBridge: (event: DesktopBridgeEvent) => void;
  log?: (message: string) => void;
};

type LocalThreadRow = {
  id: string;
  workspace_id: string;
  session_id: string;
  bridge_session_key: string;
  title: string;
  agent_type: string;
  created_at: string;
  updated_at: string;
  history_count: number;
  excerpt: string;
  acp_session_id: string | null;
  acp_supports_load: number;
};

type LocalMessageRow = {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  kind: 'final' | 'progress' | 'system';
  seq: number;
};

type LocalRunRow = {
  id: string;
  thread_id: string;
  status: 'queued' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'interrupted';
  started_at: string;
  updated_at: string;
};

type RunningPermissionRequest = {
  requestId: number | string;
  options: Array<{
    optionId: string;
    name: string;
    kind: string;
    normalizedAction: string;
  }>;
};

type RunningTurn = {
  runId: string;
  replyCtx: string;
  previewHandle: string;
  assistantText: string;
  typingStarted: boolean;
  previewStarted: boolean;
  permission?: RunningPermissionRequest | null;
};

type AcpSessionState = {
  child: ChildProcessWithoutNullStreams;
  requestId: number;
  stdoutBuffer: string;
  pending: Map<number | string, { resolve: (value: any) => void; reject: (error: Error) => void }>;
  sessionId: string;
  supportsLoad: boolean;
  workspaceId: string;
  threadId: string;
  bridgeSessionKey: string;
  currentRunId: string | null;
  currentTurn: RunningTurn | null;
  loadReplayMode: boolean;
  pendingPermissionByRun: Map<string, RunningPermissionRequest>;
  closed: boolean;
  promptPromise: Promise<{ stopReason?: string }> | null;
};

type LocalCoreProjectConfig = {
  workspaceId: string;
  workDir: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  model: string;
};

type WorkspaceRoute =
  | {
      kind: 'localcore-acp';
      agentType: string;
      config: LocalCoreProjectConfig;
    }
  | {
      kind: 'cc-connect';
      agentType: string;
    };

type ProbeCollector = {
  startedAt: string;
  events: WorkspaceStreamingProbeEvent[];
  sawTypingStart: boolean;
  sawTypingStop: boolean;
  sawReply: boolean;
  sawPreviewLike: boolean;
  firstPreviewAt: number | null;
  firstReplyAt: number | null;
  updateMessageCount: number;
  cumulativeUpdates: boolean;
  lastPreviewContent: string;
};

function normalizePlatformTypes(project?: DesktopProjectConfig | null) {
  return Array.isArray(project?.platforms)
    ? project!.platforms.map((platform) => String(platform?.type || '').trim()).filter(Boolean)
    : [];
}

function normalizeMessageContent(content?: string | null) {
  return String(content || '').replace(/\n/g, ' ').trim();
}

function toThreadMessages(history: ManagementSessionDetail['history']): ThreadMessage[] {
  return history.map((message, index) => ({
    id: `${message.timestamp || index}-${message.role}-${index}`,
    role: message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system',
    content: message.content,
    timestamp: message.timestamp,
    kind: message.kind === 'progress' ? 'progress' : message.role === 'system' ? 'system' : 'final',
  }));
}

function toThreadSummary(workspaceId: string, session: ManagementSession): ThreadSummary {
  const id = encodeThreadId(workspaceId, session.id);
  return {
    id,
    workspaceId,
    title: String(session.name || session.user_name || session.chat_name || session.id).trim(),
    live: Boolean(session.live || session.active),
    updatedAt: session.updated_at,
    createdAt: session.created_at,
    historyCount: session.history_count,
    excerpt: normalizeMessageContent(session.last_message?.content),
    participantName: session.user_name || session.chat_name,
    runId: session.live ? `run:${id}` : undefined,
    bridgeSessionKey: session.session_key,
    agentType: session.agent_type,
  };
}

function toThreadDetail(
  workspaceId: string,
  session: ManagementSessionDetail,
  selectedKnowledgeBaseIds: string[] = [],
): ThreadDetail {
  return {
    ...toThreadSummary(workspaceId, session),
    messages: toThreadMessages(session.history || []),
    selectedKnowledgeBaseIds,
  };
}

function normalizePermissionAction(kind?: string | null) {
  const normalized = String(kind || '').trim().toLowerCase();
  if (normalized === 'allow_always') {
    return 'allow all';
  }
  if (normalized.startsWith('allow')) {
    return 'allow';
  }
  if (normalized.startsWith('reject')) {
    return 'deny';
  }
  return '';
}

function formatToolCallContent(toolCall: Record<string, unknown> | null | undefined) {
  if (!toolCall || typeof toolCall !== 'object') {
    return 'Permission required before continuing.';
  }
  const title = typeof toolCall.title === 'string' ? toolCall.title.trim() : '';
  const content = Array.isArray(toolCall.content)
    ? toolCall.content
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return '';
          }
          if (typeof (entry as { text?: unknown }).text === 'string') {
            return String((entry as { text?: unknown }).text).trim();
          }
          const nested = (entry as { content?: { type?: string; text?: string } }).content;
          return nested?.type === 'text' ? String(nested.text || '').trim() : '';
        })
        .filter(Boolean)
        .join('\n')
    : '';
  return [title, content].filter(Boolean).join('\n\n') || 'Permission required before continuing.';
}

class LocalCoreAcpStore {
  private readonly db: DatabaseSync;

  constructor(userDataPath: string) {
    const dbPath = join(userDataPath, 'runtime', 'local-core.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        bridge_session_key TEXT NOT NULL,
        title TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        history_count INTEGER NOT NULL DEFAULT 0,
        excerpt TEXT NOT NULL DEFAULT '',
        acp_session_id TEXT,
        acp_supports_load INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_threads_workspace_updated ON threads (workspace_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        kind TEXT NOT NULL,
        seq INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages (thread_id, seq ASC);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_runs_thread_updated ON runs (thread_id, updated_at DESC);
    `);
  }

  close() {
    this.db.close();
  }

  listThreadSummaries(workspaceId: string): ThreadSummary[] {
    const rows = this.db.prepare(`
      SELECT id, workspace_id, session_id, bridge_session_key, title, agent_type, created_at, updated_at, history_count, excerpt
      FROM threads
      WHERE workspace_id = ?
      ORDER BY updated_at DESC
    `).all(workspaceId) as LocalThreadRow[];
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      live: false,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      historyCount: row.history_count,
      excerpt: row.excerpt,
      runId: undefined,
      bridgeSessionKey: row.bridge_session_key,
      agentType: row.agent_type,
    }));
  }

  countThreads(workspaceId: string) {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM threads WHERE workspace_id = ?').get(workspaceId) as { total: number } | undefined;
    return Number(row?.total || 0);
  }

  createThread(workspaceId: string, title: string): ThreadDetail {
    const sessionId = randomUUID();
    const threadId = encodeThreadId(workspaceId, sessionId);
    const now = new Date().toISOString();
    const bridgeSessionKey = `${LOCALCORE_ACP_AGENT_TYPE}:${workspaceId}:${sessionId}`;
    this.db.prepare(`
      INSERT INTO threads (id, workspace_id, session_id, bridge_session_key, title, agent_type, created_at, updated_at, history_count, excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '')
    `).run(threadId, workspaceId, sessionId, bridgeSessionKey, title, LOCALCORE_ACP_AGENT_TYPE, now, now);
    return {
      id: threadId,
      workspaceId,
      title,
      live: false,
      updatedAt: now,
      createdAt: now,
      historyCount: 0,
      excerpt: '',
      bridgeSessionKey,
      agentType: LOCALCORE_ACP_AGENT_TYPE,
      messages: [],
      selectedKnowledgeBaseIds: [],
    };
  }

  getThread(threadId: string, selectedKnowledgeBaseIds: string[]): ThreadDetail {
    const row = this.getThreadRow(threadId);
    if (!row) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    const messages = this.db.prepare(`
      SELECT id, thread_id, role, content, timestamp, kind, seq
      FROM messages
      WHERE thread_id = ?
      ORDER BY seq ASC
    `).all(threadId) as LocalMessageRow[];
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      live: false,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      historyCount: row.history_count,
      excerpt: row.excerpt,
      bridgeSessionKey: row.bridge_session_key,
      agentType: row.agent_type,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        kind: message.kind,
      })),
      selectedKnowledgeBaseIds,
    };
  }

  renameThread(threadId: string, title: string) {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?').run(title, now, threadId);
  }

  deleteThread(threadId: string) {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  }

  appendMessage(threadId: string, role: LocalMessageRow['role'], content: string, kind: LocalMessageRow['kind']) {
    const timestamp = new Date().toISOString();
    const nextSequenceRow = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE thread_id = ?').get(threadId) as { next_seq: number };
    const nextSeq = Number(nextSequenceRow?.next_seq || 0);
    const id = `${timestamp}-${role}-${nextSeq}`;
    const excerpt = normalizeMessageContent(content);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO messages (id, thread_id, role, content, timestamp, kind, seq)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, threadId, role, content, timestamp, kind, nextSeq);
      this.db.prepare(`
        UPDATE threads
        SET updated_at = ?, history_count = history_count + 1, excerpt = ?
        WHERE id = ?
      `).run(timestamp, excerpt, threadId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { id, timestamp };
  }

  updateRun(runId: string, threadId: string, status: LocalRunRow['status']) {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT id FROM runs WHERE id = ?').get(runId) as { id: string } | undefined;
    if (existing) {
      this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, runId);
      return;
    }
    this.db.prepare(`
      INSERT INTO runs (id, thread_id, status, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, threadId, status, now, now);
  }

  getThreadRow(threadId: string) {
    return this.db.prepare(`
      SELECT id, workspace_id, session_id, bridge_session_key, title, agent_type, created_at, updated_at, history_count, excerpt, acp_session_id, acp_supports_load
      FROM threads
      WHERE id = ?
    `).get(threadId) as LocalThreadRow | undefined;
  }

  updateThreadSession(threadId: string, sessionId: string, supportsLoad: boolean) {
    this.db.prepare(`
      UPDATE threads
      SET acp_session_id = ?, acp_supports_load = ?, updated_at = COALESCE(updated_at, ?)
      WHERE id = ?
    `).run(sessionId, supportsLoad ? 1 : 0, new Date().toISOString(), threadId);
  }
}

class WorkspaceRouter {
  private readonly store: LocalCoreAcpStore;
  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly runThreadMap = new Map<string, string>();
  private readonly bridgeSubscribers = new Set<(event: DesktopBridgeEvent) => void>();
  private readonly unsubscribeExternalBridge?: () => void;

  constructor(private readonly options: WorkspaceRouterOptions) {
    this.store = new LocalCoreAcpStore(options.userDataPath);
    this.unsubscribeExternalBridge = options.subscribeToBridgeEvents?.((event) => {
      this.notifyBridgeSubscribers(event);
    });
  }

  close() {
    for (const session of this.sessions.values()) {
      session.closed = true;
      session.child.kill('SIGTERM');
    }
    this.sessions.clear();
    this.unsubscribeExternalBridge?.();
    this.bridgeSubscribers.clear();
    this.store.close();
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const localProjects = await this.listLocalCoreProjects();
    let ccProjects: ManagementProject[] = [];
    try {
      const payload = await this.options.managementRequest<{ projects: ManagementProject[] }>('GET', '/projects');
      ccProjects = payload.projects || [];
    } catch {
      ccProjects = [];
    }
    const workspaceMap = new Map<string, WorkspaceSummary>();
    for (const project of ccProjects) {
      workspaceMap.set(project.name, {
        id: project.name,
        name: project.name,
        agentType: project.agent_type,
        platforms: project.platforms || [],
        sessionsCount: project.sessions_count,
        heartbeatEnabled: Boolean(project.heartbeat_enabled),
      });
    }
    for (const project of localProjects) {
      workspaceMap.set(project.name, {
        id: project.name,
        name: project.name,
        agentType: LOCALCORE_ACP_AGENT_TYPE,
        platforms: normalizePlatformTypes(project),
        sessionsCount: this.store.countThreads(project.name),
        heartbeatEnabled: false,
      });
    }
    return [...workspaceMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async listThreads(workspaceId: string): Promise<ThreadSummary[]> {
    const route = await this.getWorkspaceRoute(workspaceId);
    if (route.kind === 'localcore-acp') {
      return this.store.listThreadSummaries(workspaceId);
    }
    const payload = await this.options.managementRequest<{ sessions: ManagementSession[] }>(
      'GET',
      `/projects/${encodeURIComponent(workspaceId)}/sessions`,
    );
    return (payload.sessions || []).map((session) => toThreadSummary(workspaceId, session));
  }

  async createThread(workspaceId: string, title?: string): Promise<ThreadDetail> {
    const route = await this.getWorkspaceRoute(workspaceId);
    if (route.kind === 'localcore-acp') {
      const detail = this.store.createThread(workspaceId, title || `New thread ${new Date().toLocaleTimeString()}`);
      return this.withKnowledge(detail);
    }
    const chatId = `core-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionKey = `desktop:${workspaceId}:${chatId}`;
    const created = await this.options.managementRequest<{ id?: string }>(
      'POST',
      `/projects/${encodeURIComponent(workspaceId)}/sessions`,
      {
        session_key: sessionKey,
        name: title || `New thread ${new Date().toLocaleTimeString()}`,
      },
    );
    const sessions = await this.options.managementRequest<{ sessions: ManagementSession[] }>(
      'GET',
      `/projects/${encodeURIComponent(workspaceId)}/sessions`,
    );
    const matched =
      (sessions.sessions || []).find((session) => session.id === created.id) ||
      (sessions.sessions || []).find((session) => session.session_key === sessionKey);
    if (!matched) {
      throw new Error('Created thread could not be loaded');
    }
    return this.getThread(encodeThreadId(workspaceId, matched.id));
  }

  async getThread(threadId: string): Promise<ThreadDetail> {
    const { workspaceId, sessionId } = decodeThreadId(threadId);
    const route = await this.getWorkspaceRoute(workspaceId);
    if (route.kind === 'localcore-acp') {
      return this.withKnowledge(this.store.getThread(threadId, []));
    }
    const detail = await this.options.managementRequest<ManagementSessionDetail>(
      'GET',
      `/projects/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}?history_limit=200`,
    );
    return this.withKnowledge(toThreadDetail(workspaceId, detail));
  }

  async renameThread(threadId: string, title: string): Promise<ThreadDetail> {
    const { workspaceId, sessionId } = decodeThreadId(threadId);
    const route = await this.getWorkspaceRoute(workspaceId);
    if (route.kind === 'localcore-acp') {
      this.store.renameThread(threadId, title);
      return this.getThread(threadId);
    }
    await this.options.managementRequest(
      'PATCH',
      `/projects/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
      { name: title },
    );
    return this.getThread(threadId);
  }

  async updateThreadKnowledgeBases(threadId: string, knowledgeBaseIds: string[]) {
    return {
      knowledgeBaseIds: await this.options.knowledgeProvider.updateThreadKnowledgeBaseIds(threadId, knowledgeBaseIds),
    };
  }

  async deleteThread(threadId: string) {
    const { workspaceId, sessionId } = decodeThreadId(threadId);
    const route = await this.getWorkspaceRoute(workspaceId);
    if (route.kind === 'localcore-acp') {
      this.closeSession(threadId);
      this.store.deleteThread(threadId);
      await this.options.knowledgeProvider.deleteThreadKnowledgeBaseLinks(threadId);
      return { deleted: true };
    }
    await this.options.managementRequest('DELETE', `/projects/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`);
    await this.options.knowledgeProvider.deleteThreadKnowledgeBaseLinks(threadId);
    return { deleted: true };
  }

  async sendThreadMessage(threadId: string, content: string): Promise<{ runId: string }> {
    const { workspaceId, sessionId } = decodeThreadId(threadId);
    const route = await this.getWorkspaceRoute(workspaceId);
    if (route.kind === 'localcore-acp') {
      return this.sendLocalCoreAcpThreadMessage(threadId, route.config, content);
    }
    const detail = await this.options.managementRequest<any>(
      'GET',
      `/projects/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}?history_limit=1`,
    );
    const sessionKey = String(detail.session_key || '');
    if (sessionKey.startsWith('desktop:')) {
      const [, project = workspaceId, chatId = 'main'] = sessionKey.split(':');
      const result = await this.options.bridgeSendMessage({ project, chatId, content });
      this.runThreadMap.set(result.messageId, threadId);
      return { runId: result.messageId };
    }
    await this.options.managementRequest('POST', `/projects/${encodeURIComponent(workspaceId)}/sessions/switch`, {
      session_key: detail.session_key,
      session_id: detail.id,
    }).catch(() => undefined);
    await this.options.managementRequest('POST', `/projects/${encodeURIComponent(workspaceId)}/send`, {
      session_key: detail.session_key,
      message: content,
    });
    const runId = `run:${threadId}:${Date.now()}`;
    this.runThreadMap.set(runId, threadId);
    return { runId };
  }

  async sendThreadAction(threadId: string, content: string) {
    const { workspaceId } = decodeThreadId(threadId);
    const route = await this.getWorkspaceRoute(workspaceId);
    if (route.kind === 'localcore-acp') {
      return this.sendLocalCoreAcpThreadAction(threadId, content);
    }
    return this.sendThreadMessage(threadId, content);
  }

  async interruptRun(runId: string): Promise<{ interrupted: boolean }> {
    const threadId = this.runThreadMap.get(runId);
    if (!threadId) {
      return { interrupted: false };
    }
    const { workspaceId, sessionId } = decodeThreadId(threadId);
    const route = await this.getWorkspaceRoute(workspaceId);
    if (route.kind === 'localcore-acp') {
      const session = this.sessions.get(threadId);
      if (!session) {
        this.store.updateRun(runId, threadId, 'interrupted');
        return { interrupted: false };
      }
      const pendingPermission = session.pendingPermissionByRun.get(runId);
      if (pendingPermission) {
        this.sendRaw(session, {
          jsonrpc: '2.0',
          id: pendingPermission.requestId,
          result: {
            outcome: {
              outcome: 'cancelled',
            },
          },
        });
        session.pendingPermissionByRun.delete(runId);
      }
      this.sendRaw(session, {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: {
          sessionId: session.sessionId,
        },
      });
      this.store.updateRun(runId, threadId, 'interrupted');
      return { interrupted: true };
    }
    const detail = await this.options.managementRequest<any>(
      'GET',
      `/projects/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}?history_limit=1`,
    );
    const sessionKey = String(detail.session_key || '');
    if (!sessionKey.startsWith('desktop:')) {
      return { interrupted: false };
    }
    const [, project = workspaceId, chatId = 'main'] = sessionKey.split(':');
    await this.options.bridgeSendMessage({ project, chatId, content: '/stop' });
    return { interrupted: true };
  }

  getCapabilities(): LocalCoreCapabilities {
    return {
      adapters: {
        channels: ['cc-connect', LOCALCORE_ACP_AGENT_TYPE],
        agents: ['opencode', 'codex', 'claudecode', 'cursor', 'gemini', 'qoder', 'iflow', LOCALCORE_ACP_AGENT_TYPE],
        knowledge: true,
      },
    };
  }

  async probeWorkspaceStreaming(workspaceId: string): Promise<WorkspaceStreamingProbeResult> {
    const route = await this.getWorkspaceRoute(workspaceId);
    const normalizedAgentType = String(route.agentType || '').trim().toLowerCase();
    if (normalizedAgentType !== 'acp' && normalizedAgentType !== LOCALCORE_ACP_AGENT_TYPE) {
      throw new Error(`Workspace "${workspaceId}" is not configured as an ACP agent.`);
    }
    if (route.kind === 'localcore-acp') {
      return this.probeLocalCoreAcpWorkspace(workspaceId, route);
    }
    return this.probeCcConnectWorkspace(workspaceId, route);
  }

  private async withKnowledge(detail: ThreadDetail) {
    return {
      ...detail,
      selectedKnowledgeBaseIds: await this.options.knowledgeProvider.listThreadKnowledgeBaseIds(detail.id),
    };
  }

  private emitBridgeEvent(event: DesktopBridgeEvent) {
    this.notifyBridgeSubscribers(event);
    this.options.emitBridge(event);
  }

  private notifyBridgeSubscribers(event: DesktopBridgeEvent) {
    for (const listener of this.bridgeSubscribers) {
      listener(event);
    }
  }

  private subscribeBridge(listener: (event: DesktopBridgeEvent) => void) {
    this.bridgeSubscribers.add(listener);
    return () => {
      this.bridgeSubscribers.delete(listener);
    };
  }

  private createProbeCollector(): ProbeCollector {
    return {
      startedAt: new Date().toISOString(),
      events: [],
      sawTypingStart: false,
      sawTypingStop: false,
      sawReply: false,
      sawPreviewLike: false,
      firstPreviewAt: null,
      firstReplyAt: null,
      updateMessageCount: 0,
      cumulativeUpdates: true,
      lastPreviewContent: '',
    };
  }

  private recordProbeEvent(collector: ProbeCollector, event: DesktopBridgeEvent) {
    const at = Date.now();
    const content = String(event.content || '');
    collector.events.push({
      type: event.type,
      at: new Date(at).toISOString(),
      contentLength: content.length,
      previewHandle: event.previewHandle,
    });
    switch (event.type) {
      case 'typing_start':
        collector.sawTypingStart = true;
        break;
      case 'typing_stop':
        collector.sawTypingStop = true;
        break;
      case 'preview_start':
        collector.sawPreviewLike = true;
        collector.firstPreviewAt ??= at;
        collector.lastPreviewContent = content;
        break;
      case 'update_message':
        collector.sawPreviewLike = true;
        collector.firstPreviewAt ??= at;
        collector.updateMessageCount += 1;
        if (
          collector.lastPreviewContent &&
          content &&
          !content.startsWith(collector.lastPreviewContent)
        ) {
          collector.cumulativeUpdates = false;
        }
        collector.lastPreviewContent = content;
        break;
      case 'reply':
        collector.sawReply = true;
        collector.firstReplyAt ??= at;
        break;
      default:
        break;
    }
  }

  private finalizeProbeResult(
    workspaceId: string,
    agentType: string,
    transport: WorkspaceStreamingProbeResult['transport'],
    prompt: string,
    collector: ProbeCollector,
    options: {
      sessionKey?: string;
      threadId?: string;
      error?: string;
      timedOut?: boolean;
    } = {},
  ): WorkspaceStreamingProbeResult {
    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(collector.startedAt));
    const previewBeforeFinal = collector.sawPreviewLike && (
      collector.firstReplyAt == null ||
      (collector.firstPreviewAt != null && collector.firstPreviewAt <= collector.firstReplyAt)
    );
    const finalEvent = options.error
      ? 'error'
      : options.timedOut
        ? 'timeout'
        : collector.sawReply
          ? 'reply'
          : collector.sawTypingStop
            ? 'typing_stop'
            : 'none';
    const hungPreview = collector.sawPreviewLike && !collector.sawTypingStop;
    const passed = Boolean(
      collector.sawTypingStart &&
      collector.sawTypingStop &&
      previewBeforeFinal &&
      collector.updateMessageCount >= 2 &&
      collector.cumulativeUpdates &&
      !hungPreview &&
      !options.error &&
      !options.timedOut,
    );
    return {
      workspaceId,
      agentType,
      transport,
      prompt,
      passed,
      startedAt: collector.startedAt,
      completedAt,
      durationMs,
      threadId: options.threadId,
      sessionKey: options.sessionKey,
      error: options.error,
      criteria: {
        sawTypingStart: collector.sawTypingStart,
        sawTypingStop: collector.sawTypingStop,
        previewBeforeFinal,
        updateMessageCount: collector.updateMessageCount,
        cumulativeUpdates: collector.cumulativeUpdates,
        finalEvent,
        hungPreview,
      },
      events: collector.events,
    };
  }

  private waitForProbeSequence(
    sessionKey: string,
    timeoutMs: number,
    collector: ProbeCollector,
  ) {
    let active = true;
    let unsubscribe: () => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        active = false;
        unsubscribe();
        reject(new Error(`Timed out waiting for ACP streaming events after ${timeoutMs}ms`));
      }, timeoutMs);
      unsubscribe = this.subscribeBridge((event) => {
        if (!active) {
          return;
        }
        if (event.sessionKey !== sessionKey) {
          return;
        }
        this.recordProbeEvent(collector, event);
        if (event.type === 'typing_stop') {
          active = false;
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });
    return {
      promise,
      cancel: () => {
        if (!active) {
          return;
        }
        active = false;
        unsubscribe();
      },
    };
  }

  private buildProbePrompt() {
    return 'Reply with exactly three short plain-text lines: alpha, beta, gamma. Do not call tools or ask questions.';
  }

  private async probeCcConnectWorkspace(workspaceId: string, route: Extract<WorkspaceRoute, { kind: 'cc-connect' }>) {
    const prompt = this.buildProbePrompt();
    const probeChatId = `probe-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const sessionKey = `desktop:${workspaceId}:${probeChatId}`;
    const collector = this.createProbeCollector();
    let runId = '';
    const sequence = this.waitForProbeSequence(sessionKey, 20000, collector);
    try {
      const sent = await this.options.bridgeSendMessage({
        project: workspaceId,
        chatId: probeChatId,
        content: prompt,
      });
      runId = String(sent.messageId || '');
      await sequence.promise;
      return this.finalizeProbeResult(workspaceId, route.agentType, 'cc-connect', prompt, collector, {
        sessionKey,
      });
    } catch (error) {
      sequence.cancel();
      return this.finalizeProbeResult(workspaceId, route.agentType, 'cc-connect', prompt, collector, {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
        timedOut: error instanceof Error && error.message.includes('Timed out'),
      });
    } finally {
      if (runId) {
        await this.interruptRun(runId).catch(() => ({ interrupted: false }));
      }
      await this.cleanupProbeCcConnectSession(workspaceId, sessionKey);
    }
  }

  private async cleanupProbeCcConnectSession(workspaceId: string, sessionKey: string) {
    try {
      const payload = await this.options.managementRequest<{ sessions: ManagementSession[] }>(
        'GET',
        `/projects/${encodeURIComponent(workspaceId)}/sessions`,
      );
      const matched = (payload.sessions || []).find((session) => session.session_key === sessionKey);
      if (!matched) {
        return;
      }
      await this.options.managementRequest(
        'DELETE',
        `/projects/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(matched.id)}`,
      );
    } catch {
      // Best effort cleanup for probe sessions.
    }
  }

  private async probeLocalCoreAcpWorkspace(
    workspaceId: string,
    route: Extract<WorkspaceRoute, { kind: 'localcore-acp' }>,
  ) {
    const prompt = this.buildProbePrompt();
    const thread = this.store.createThread(workspaceId, `[probe] ${new Date().toISOString()}`);
    const collector = this.createProbeCollector();
    const sequence = this.waitForProbeSequence(thread.bridgeSessionKey || '', 20000, collector);
    try {
      const sent = await this.sendLocalCoreAcpThreadMessage(thread.id, route.config, prompt);
      await sequence.promise;
      await this.interruptRun(sent.runId).catch(() => ({ interrupted: false }));
      return this.finalizeProbeResult(workspaceId, route.agentType, 'localcore-acp', prompt, collector, {
        threadId: thread.id,
        sessionKey: thread.bridgeSessionKey,
      });
    } catch (error) {
      sequence.cancel();
      return this.finalizeProbeResult(workspaceId, route.agentType, 'localcore-acp', prompt, collector, {
        threadId: thread.id,
        sessionKey: thread.bridgeSessionKey,
        error: error instanceof Error ? error.message : String(error),
        timedOut: error instanceof Error && error.message.includes('Timed out'),
      });
    } finally {
      await this.deleteThread(thread.id).catch(() => ({ deleted: false }));
    }
  }

  private async sendLocalCoreAcpThreadMessage(threadId: string, config: LocalCoreProjectConfig, content: string) {
    const row = this.store.getThreadRow(threadId);
    if (!row) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    this.store.appendMessage(threadId, 'user', content, 'final');
    const runId = `run:${threadId}:${Date.now()}`;
    this.runThreadMap.set(runId, threadId);
    this.store.updateRun(runId, threadId, 'running');
    void this.runLocalCoreAcpPrompt(threadId, runId, row.bridge_session_key, config, content).catch((error) => {
      this.options.log?.(`localcore-acp prompt failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return { runId };
  }

  private async sendLocalCoreAcpThreadAction(threadId: string, content: string) {
    const session = this.sessions.get(threadId);
    if (!session?.currentRunId) {
      return this.sendThreadMessage(threadId, content);
    }
    const pendingPermission = session.pendingPermissionByRun.get(session.currentRunId);
    if (!pendingPermission) {
      return this.sendThreadMessage(threadId, content);
    }
    const action = String(content || '').trim().toLowerCase();
    const matched = pendingPermission.options.find((option) => option.normalizedAction === action || option.optionId === action);
    if (!matched) {
      throw new Error(`Unknown permission option: ${content}`);
    }
    this.sendRaw(session, {
      jsonrpc: '2.0',
      id: pendingPermission.requestId,
      result: {
        outcome: {
          outcome: 'selected',
          optionId: matched.optionId,
        },
      },
    });
    session.pendingPermissionByRun.delete(session.currentRunId);
    this.emitBridgeEvent({
      type: 'typing_start',
      sessionKey: session.bridgeSessionKey,
      replyCtx: session.currentRunId,
    });
    return { runId: session.currentRunId };
  }

  private async runLocalCoreAcpPrompt(
    threadId: string,
    runId: string,
    bridgeSessionKey: string,
    config: LocalCoreProjectConfig,
    content: string,
  ) {
    const session = await this.ensureAcpSession(threadId, bridgeSessionKey, config);
    session.currentRunId = runId;
    session.currentTurn = {
      runId,
      replyCtx: runId,
      previewHandle: randomUUID(),
      assistantText: '',
      typingStarted: false,
      previewStarted: false,
      permission: null,
    };
    this.emitBridgeEvent({
      type: 'typing_start',
      sessionKey: bridgeSessionKey,
      replyCtx: runId,
    });
    session.currentTurn.typingStarted = true;
    const promptPromise = this.request(session, 'session/prompt', {
      sessionId: session.sessionId,
      messageId: randomUUID(),
      prompt: [
        {
          type: 'text',
          text: content,
        },
      ],
    }) as Promise<{ stopReason?: string }>;
    session.promptPromise = promptPromise;
    try {
      const result = await promptPromise;
      const currentTurn = session.currentTurn;
      if (!currentTurn || currentTurn.runId !== runId) {
        return;
      }
      if (currentTurn.assistantText) {
        this.store.appendMessage(threadId, 'assistant', currentTurn.assistantText, 'final');
        if (!currentTurn.previewStarted) {
          this.emitBridgeEvent({
            type: 'reply',
            sessionKey: bridgeSessionKey,
            replyCtx: runId,
            content: currentTurn.assistantText,
          });
        }
      } else if (result?.stopReason === 'cancelled') {
        this.emitBridgeEvent({
          type: 'reply',
          sessionKey: bridgeSessionKey,
          replyCtx: runId,
          content: '⏳ Request cancelled.',
        });
      }
      const nextStatus = result?.stopReason === 'cancelled' ? 'interrupted' : 'completed';
      this.store.updateRun(runId, threadId, nextStatus);
      this.emitBridgeEvent({
        type: 'typing_stop',
        sessionKey: bridgeSessionKey,
        replyCtx: runId,
      });
    } catch (error) {
      this.store.updateRun(runId, threadId, 'failed');
      this.emitBridgeEvent({
        type: 'reply',
        sessionKey: bridgeSessionKey,
        replyCtx: runId,
        content: `Agent error: ${error instanceof Error ? error.message : String(error)}`,
      });
      this.emitBridgeEvent({
        type: 'typing_stop',
        sessionKey: bridgeSessionKey,
        replyCtx: runId,
      });
    } finally {
      if (session.currentRunId === runId) {
        session.currentRunId = null;
      }
      if (session.currentTurn?.runId === runId) {
        session.currentTurn = null;
      }
      session.promptPromise = null;
    }
  }

  private async ensureAcpSession(threadId: string, bridgeSessionKey: string, config: LocalCoreProjectConfig) {
    const existing = this.sessions.get(threadId);
    if (existing && !existing.closed) {
      return existing;
    }
    const child = spawn(config.command, config.args, {
      cwd: config.workDir,
      env: {
        ...process.env,
        ...config.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session: AcpSessionState = {
      child,
      requestId: 0,
      stdoutBuffer: '',
      pending: new Map(),
      sessionId: '',
      supportsLoad: false,
      workspaceId: config.workspaceId,
      threadId,
      bridgeSessionKey,
      currentRunId: null,
      currentTurn: null,
      loadReplayMode: false,
      pendingPermissionByRun: new Map(),
      closed: false,
      promptPromise: null,
    };
    this.sessions.set(threadId, session);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(session, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.options.log?.(`[localcore-acp:${threadId}] ${chunk.trimEnd()}`);
    });
    child.on('exit', (code, signal) => {
      session.closed = true;
      for (const pending of session.pending.values()) {
        pending.reject(new Error(`ACP agent exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`));
      }
      session.pending.clear();
      if (this.sessions.get(threadId) === session) {
        this.sessions.delete(threadId);
      }
    });
    const initResult = await this.request(session, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
      clientInfo: {
        name: 'ai-workstation',
        title: 'AI-WorkStation',
        version: '0.1.0',
      },
    }) as {
      agentCapabilities?: { loadSession?: boolean };
    };
    session.supportsLoad = Boolean(initResult?.agentCapabilities?.loadSession);
    const row = this.store.getThreadRow(threadId);
    if (row?.acp_session_id && row.acp_supports_load && session.supportsLoad) {
      try {
        session.loadReplayMode = true;
        await this.request(session, 'session/load', {
          sessionId: row.acp_session_id,
          cwd: config.workDir,
          mcpServers: [],
        });
        session.sessionId = row.acp_session_id;
      } catch (error) {
        this.options.log?.(`ACP loadSession failed for ${threadId}; creating a fresh session instead: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        session.loadReplayMode = false;
      }
    }
    if (!session.sessionId) {
      const created = await this.request(session, 'session/new', {
        cwd: config.workDir,
        mcpServers: [],
      }) as { sessionId: string };
      session.sessionId = String(created.sessionId || '').trim();
      if (!session.sessionId) {
        throw new Error('ACP session/new did not return a sessionId');
      }
      this.store.updateThreadSession(threadId, session.sessionId, session.supportsLoad);
    }
    return session;
  }

  private handleStdout(session: AcpSessionState, chunk: string) {
    session.stdoutBuffer += chunk;
    while (session.stdoutBuffer.includes('\n')) {
      const newlineIndex = session.stdoutBuffer.indexOf('\n');
      const line = session.stdoutBuffer.slice(0, newlineIndex).trim();
      session.stdoutBuffer = session.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      let payload: any;
      try {
        payload = JSON.parse(line);
      } catch (error) {
        this.options.log?.(`ACP stdout parse failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (payload.method && payload.id !== undefined) {
        this.handleAgentRequest(session, payload);
        continue;
      }
      if (payload.method) {
        this.handleAgentNotification(session, payload);
        continue;
      }
      if (payload.id !== undefined) {
        const pending = session.pending.get(payload.id);
        if (!pending) {
          continue;
        }
        session.pending.delete(payload.id);
        if (payload.error) {
          pending.reject(new Error(payload.error.message || `ACP request failed: ${payload.id}`));
        } else {
          pending.resolve(payload.result);
        }
      }
    }
  }

  private handleAgentRequest(session: AcpSessionState, payload: any) {
    if (payload.method !== 'session/request_permission') {
      this.sendRaw(session, {
        jsonrpc: '2.0',
        id: payload.id,
        error: {
          code: -32601,
          message: `Unsupported ACP client method: ${String(payload.method || '')}`,
        },
      });
      return;
    }
    const currentRunId = session.currentRunId;
    if (!currentRunId) {
      this.sendRaw(session, {
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          outcome: {
            outcome: 'cancelled',
          },
        },
      });
      return;
    }
    const options = Array.isArray(payload.params?.options)
      ? payload.params.options
          .map((option: any) => ({
            optionId: String(option?.optionId || '').trim(),
            name: String(option?.name || option?.optionId || '').trim(),
            kind: String(option?.kind || '').trim(),
            normalizedAction: normalizePermissionAction(option?.kind),
          }))
          .filter((option: { optionId: string }) => option.optionId)
      : [];
    const buttonRows: DesktopBridgeButtonOption[][] = [options.map((option: RunningPermissionRequest['options'][number]) => {
      const data = option.normalizedAction
        ? `perm:${option.normalizedAction.replace(/\s+/g, '_')}`
        : option.optionId;
      const normalized = normalizeDesktopBridgeButtonOption({
        text: option.normalizedAction || option.name,
        data,
      });
      return normalized || { text: option.name, data: option.optionId };
    })];
    const permissionRequest: RunningPermissionRequest = {
      requestId: payload.id,
      options,
    };
    session.pendingPermissionByRun.set(currentRunId, permissionRequest);
    if (session.currentTurn) {
      session.currentTurn.permission = permissionRequest;
    }
    this.store.updateRun(currentRunId, session.threadId, 'awaiting_input');
    this.emitBridgeEvent({
      type: 'buttons',
      sessionKey: session.bridgeSessionKey,
      replyCtx: currentRunId,
      content: formatToolCallContent(payload.params?.toolCall),
      buttonRows,
    });
  }

  private handleAgentNotification(session: AcpSessionState, payload: any) {
    if (session.loadReplayMode) {
      return;
    }
    if (payload.method !== 'session/update') {
      return;
    }
    const update = payload.params?.update;
    const currentTurn = session.currentTurn;
    const currentRunId = session.currentRunId;
    if (!update || !currentTurn || !currentRunId) {
      return;
    }
    switch (String(update.sessionUpdate || '')) {
      case 'agent_message_chunk': {
        if (update.content?.type !== 'text') {
          return;
        }
        currentTurn.assistantText += String(update.content.text || '');
        if (!currentTurn.previewStarted) {
          currentTurn.previewStarted = true;
          this.emitBridgeEvent({
            type: 'preview_start',
            sessionKey: session.bridgeSessionKey,
            replyCtx: currentRunId,
            previewHandle: currentTurn.previewHandle,
            content: currentTurn.assistantText,
          });
          return;
        }
        this.emitBridgeEvent({
          type: 'update_message',
          sessionKey: session.bridgeSessionKey,
          replyCtx: currentRunId,
          previewHandle: currentTurn.previewHandle,
          content: currentTurn.assistantText,
        });
        return;
      }
      case 'tool_call': {
        const title = String(update.title || 'Running tool').trim();
        this.emitBridgeEvent({
          type: 'reply',
          sessionKey: session.bridgeSessionKey,
          replyCtx: currentRunId,
          content: `🔧 ${title}`,
        });
        return;
      }
      case 'tool_call_update': {
        const title = String(update.title || 'Tool update').trim();
        const status = String(update.status || '').trim();
        const content = Array.isArray(update.content)
          ? update.content
              .map((entry: any) =>
                entry?.type === 'content' && entry?.content?.type === 'text'
                  ? String(entry.content.text || '')
                  : '')
              .filter(Boolean)
              .join('\n')
          : '';
        this.emitBridgeEvent({
          type: 'reply',
          sessionKey: session.bridgeSessionKey,
          replyCtx: currentRunId,
          content: `🔧 ${[title, status, content].filter(Boolean).join(' · ')}`,
        });
        return;
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        if (entries.length === 0) {
          return;
        }
        const summary = entries
          .map((entry: any) => String(entry?.content || '').trim())
          .filter(Boolean)
          .join(' | ');
        this.emitBridgeEvent({
          type: 'reply',
          sessionKey: session.bridgeSessionKey,
          replyCtx: currentRunId,
          content: `💭 ${summary}`,
        });
        return;
      }
      default:
        return;
    }
  }

  private request(session: AcpSessionState, method: string, params: unknown) {
    session.requestId += 1;
    const id = session.requestId;
    this.sendRaw(session, {
      jsonrpc: '2.0',
      id,
      method,
      params,
    });
    return new Promise((resolve, reject) => {
      session.pending.set(id, { resolve, reject });
    });
  }

  private sendRaw(session: AcpSessionState, payload: Record<string, unknown>) {
    if (session.closed || !session.child.stdin.writable) {
      throw new Error('ACP session is not writable');
    }
    session.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private closeSession(threadId: string) {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    session.closed = true;
    session.child.kill('SIGTERM');
    this.sessions.delete(threadId);
  }

  private async getWorkspaceRoute(workspaceId: string): Promise<WorkspaceRoute> {
    const configState = await this.options.readConfigState();
    const projects = Array.isArray(configState.parsed?.projects) ? configState.parsed!.projects! : [];
    const matched = projects.find((project) => String(project?.name || '').trim() === workspaceId);
    const agentType = String(matched?.agent?.type || '').trim();
    if (agentType.toLowerCase() === LOCALCORE_ACP_AGENT_TYPE) {
      return {
        kind: 'localcore-acp' as const,
        agentType,
        config: this.toLocalCoreProjectConfig(configState, matched!),
      };
    }
    return {
      kind: 'cc-connect' as const,
      agentType,
    };
  }

  private async listLocalCoreProjects() {
    const configState = await this.options.readConfigState();
    const projects = Array.isArray(configState.parsed?.projects) ? configState.parsed!.projects! : [];
    return projects.filter((project) => String(project?.agent?.type || '').trim().toLowerCase() === LOCALCORE_ACP_AGENT_TYPE);
  }

  private toLocalCoreProjectConfig(configState: ConfigFileState, project: DesktopProjectConfig): LocalCoreProjectConfig {
    const rawWorkDir = String(project.agent?.options?.work_dir || '.').trim() || '.';
    const configDir = dirname(configState.path);
    const workDir = isAbsolute(rawWorkDir) ? rawWorkDir : resolve(configDir, rawWorkDir);
    const rawArgs = project.agent?.options?.args;
    const args = Array.isArray(rawArgs)
      ? rawArgs.map((value) => String(value || '')).filter(Boolean)
      : [];
    const rawEnv = project.agent?.options?.env;
    const env = rawEnv && typeof rawEnv === 'object'
      ? Object.fromEntries(
          Object.entries(rawEnv as Record<string, unknown>)
            .filter(([key]) => key)
            .map(([key, value]) => [key, String(value ?? '')]),
        )
      : {};
    const command = String(project.agent?.options?.command || '').trim();
    if (!command) {
      throw new Error(`Workspace "${project.name}" requires [projects.agent.options].command for localcore-acp.`);
    }
    return {
      workspaceId: project.name,
      workDir,
      command,
      args,
      env,
      model: String(project.agent?.options?.model || '').trim(),
    };
  }
}

export function createWorkspaceRouter(options: WorkspaceRouterOptions) {
  return new WorkspaceRouter(options);
}
