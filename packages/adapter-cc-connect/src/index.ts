import { EventEmitter } from 'node:events';
import type {
  ConfigFileState,
  DesktopBridgeEvent,
  DesktopBridgeSendInput,
  DesktopBridgeSendResult,
  DesktopConnectConfig,
  DesktopRuntimeStatus,
  DesktopSettings,
  DesktopSettingsInput,
  DesktopServiceState,
  LocalCoreCapabilities,
  KnowledgeSource,
  KnowledgeBase,
  KnowledgeBaseCreateInput,
  KnowledgeBaseUpdateInput,
  KnowledgeConfig,
  KnowledgeFile,
  KnowledgeFolder,
  KnowledgeFolderCreateInput,
  KnowledgeFolderUpdateInput,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeUploadResult,
  WorkspaceStreamingProbeResult,
  ThreadDetail,
  ThreadMessage,
  ThreadSummary,
  WorkspaceSummary,
} from '../../contracts/src/index.js';
import { deriveDesktopRuntimePhase } from '../../contracts/src/index.js';
import { AiVectorKnowledgeProvider, type KnowledgeProvider } from '../../knowledge-api/src/index.js';
import { BridgeAdapter } from '../../../electron/bridge-adapter.js';
import { ServiceManager } from '../../../electron/service-manager.js';
import { createWorkspaceRouter, decodeThreadId, encodeThreadId } from '../../../services/local-ai-core/src/workspace-router.js';

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

function threadTitle(session: ManagementSession | ManagementSessionDetail) {
  return String(session.name || session.user_name || session.chat_name || session.id).trim();
}

function threadExcerpt(session: ManagementSession | ManagementSessionDetail) {
  return session.last_message?.content?.replace(/\n/g, ' ') || '';
}

function toThreadSummary(workspaceId: string, session: ManagementSession): ThreadSummary {
  const id = encodeThreadId(workspaceId, session.id);
  return {
    id,
    workspaceId,
    title: threadTitle(session),
    live: Boolean(session.live || session.active),
    updatedAt: session.updated_at,
    createdAt: session.created_at,
    historyCount: session.history_count,
    excerpt: threadExcerpt(session),
    participantName: session.user_name || session.chat_name,
    runId: session.live ? `run:${id}` : undefined,
    bridgeSessionKey: session.session_key,
    agentType: session.agent_type,
  };
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

export class CcConnectController extends EventEmitter {
  private readonly serviceManager: ServiceManager;
  private readonly bridgeAdapter: BridgeAdapter;
  private readonly knowledgeProvider: KnowledgeProvider;
  private readonly workspaceRouter;

  constructor(private readonly userDataPath: string) {
    super();
    this.serviceManager = new ServiceManager(userDataPath);
    this.bridgeAdapter = new BridgeAdapter(
      () => this.serviceManager.getSettings(),
      () => this.serviceManager.getServiceState().status === 'running',
    );
    this.knowledgeProvider = new AiVectorKnowledgeProvider({
      userDataPath,
      getConfig: () => this.serviceManager.getSettings().knowledge,
      setConfig: async (input) => {
        const settings = this.serviceManager.updateSettings({
          knowledge: input,
        });
        await this.emitRuntime();
        return settings.knowledge;
      },
    });
    this.workspaceRouter = createWorkspaceRouter({
      userDataPath,
      readConfigState: () => this.serviceManager.readConfigState(),
      managementRequest: (method, path, body) => this.managementRequest(method, path, body),
      bridgeSendMessage: (input) => this.bridgeAdapter.sendMessage(input),
      subscribeToBridgeEvents: (listener) => {
        this.bridgeAdapter.on('event', listener);
        return () => {
          this.bridgeAdapter.removeListener('event', listener);
        };
      },
      knowledgeProvider: this.knowledgeProvider,
      emitBridge: (event) => this.emit('bridge', event),
      log: (message) => this.emit('logs', message),
    });
  }

  async init() {
    this.serviceManager.on('state', () => {
      this.syncBridgeWithServiceState();
      void this.emitRuntime();
    });
    this.serviceManager.on('logs', () => {
      void this.emitRuntime();
    });
    this.bridgeAdapter.on('state', () => {
      void this.emitRuntime();
    });
    this.bridgeAdapter.on('event', (event: DesktopBridgeEvent) => {
      this.emit('bridge', event);
    });
    const settings = this.serviceManager.getSettings();
    if (settings.autoStartService) {
      const result = await this.serviceManager.start();
      if (result.status === 'running') {
        void this.bridgeAdapter.connect();
      }
    } else {
      await this.serviceManager.ensureConfigFile();
    }
    await this.emitRuntime();
  }

  async getRuntimeStatus(): Promise<DesktopRuntimeStatus> {
    const bridge = this.bridgeAdapter.getState();
    const runtime = await this.serviceManager.getRuntimeStatus();
    return {
      ...runtime,
      phase: deriveDesktopRuntimePhase(runtime.service, bridge),
      bridge,
    };
  }

  async startService(): Promise<DesktopServiceState> {
    const result = await this.serviceManager.start();
    if (result.status === 'running') {
      void this.bridgeAdapter.connect();
    }
    await this.emitRuntime();
    return result;
  }

  async stopService(): Promise<DesktopServiceState> {
    this.bridgeAdapter.disconnect();
    const result = await this.serviceManager.stop();
    await this.emitRuntime();
    return result;
  }

  async restartService(): Promise<DesktopServiceState> {
    this.bridgeAdapter.disconnect();
    const result = await this.serviceManager.restart();
    if (result.status === 'running') {
      void this.bridgeAdapter.connect();
    }
    await this.emitRuntime();
    return result;
  }

  getLogs(limit?: number) {
    return this.serviceManager.getLogs(limit);
  }

  readConfigFile(): Promise<ConfigFileState> {
    return this.serviceManager.readConfigState();
  }

  saveRawConfigFile(raw: string): Promise<ConfigFileState> {
    return this.serviceManager.writeRawConfig(raw);
  }

  saveStructuredConfigFile(config: DesktopConnectConfig): Promise<ConfigFileState> {
    return this.serviceManager.writeStructuredConfig(config);
  }

  async saveSettings(input: DesktopSettingsInput): Promise<DesktopSettings> {
    const settings = this.serviceManager.updateSettings(input);
    await this.emitRuntime();
    return settings;
  }

  async bridgeConnect() {
    const result = await this.bridgeAdapter.connect();
    await this.emitRuntime();
    return result;
  }

  async bridgeDisconnect() {
    const result = this.bridgeAdapter.disconnect();
    await this.emitRuntime();
    return result;
  }

  async bridgeSendMessage(input: DesktopBridgeSendInput): Promise<DesktopBridgeSendResult> {
    return this.bridgeAdapter.sendMessage(input);
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.workspaceRouter.listWorkspaces();
  }

  async listThreads(workspaceId: string): Promise<ThreadSummary[]> {
    return this.workspaceRouter.listThreads(workspaceId);
  }

  async createThread(workspaceId: string, title?: string): Promise<ThreadDetail> {
    return this.workspaceRouter.createThread(workspaceId, title);
  }

  async getThread(threadId: string): Promise<ThreadDetail> {
    return this.workspaceRouter.getThread(threadId);
  }

  async renameThread(threadId: string, title: string): Promise<ThreadDetail> {
    return this.workspaceRouter.renameThread(threadId, title);
  }

  async deleteThread(threadId: string): Promise<{ deleted: boolean }> {
    return this.workspaceRouter.deleteThread(threadId);
  }

  async updateThreadKnowledgeBases(threadId: string, knowledgeBaseIds: string[]): Promise<{ knowledgeBaseIds: string[] }> {
    return this.workspaceRouter.updateThreadKnowledgeBases(threadId, knowledgeBaseIds);
  }

  async sendThreadMessage(threadId: string, content: string): Promise<{ runId: string }> {
    return this.workspaceRouter.sendThreadMessage(threadId, content);
  }

  async sendThreadAction(threadId: string, content: string) {
    return this.workspaceRouter.sendThreadAction(threadId, content);
  }

  async interruptRun(runId: string): Promise<{ interrupted: boolean }> {
    return this.workspaceRouter.interruptRun(runId);
  }

  async listKnowledgeSources(): Promise<KnowledgeSource[]> {
    return this.knowledgeProvider.listSources();
  }

  async getKnowledgeConfig(): Promise<KnowledgeConfig> {
    return this.knowledgeProvider.getConfig();
  }

  async updateKnowledgeConfig(input: Partial<KnowledgeConfig>): Promise<KnowledgeConfig> {
    return this.knowledgeProvider.updateConfig(input);
  }

  async listKnowledgeFolders(): Promise<KnowledgeFolder[]> {
    return this.knowledgeProvider.listFolders();
  }

  async createKnowledgeFolder(input: KnowledgeFolderCreateInput): Promise<KnowledgeFolder> {
    return this.knowledgeProvider.createFolder(input);
  }

  async updateKnowledgeFolder(id: string, input: KnowledgeFolderUpdateInput): Promise<KnowledgeFolder> {
    return this.knowledgeProvider.updateFolder(id, input);
  }

  async deleteKnowledgeFolder(id: string): Promise<{ deleted: boolean }> {
    return this.knowledgeProvider.deleteFolder(id);
  }

  async listKnowledgeBases(): Promise<KnowledgeBase[]> {
    return this.knowledgeProvider.listKnowledgeBases();
  }

  async getKnowledgeBase(id: string): Promise<KnowledgeBase> {
    return this.knowledgeProvider.getKnowledgeBase(id);
  }

  async createKnowledgeBase(input: KnowledgeBaseCreateInput): Promise<KnowledgeBase> {
    return this.knowledgeProvider.createKnowledgeBase(input);
  }

  async updateKnowledgeBase(id: string, input: KnowledgeBaseUpdateInput): Promise<KnowledgeBase> {
    return this.knowledgeProvider.updateKnowledgeBase(id, input);
  }

  async deleteKnowledgeBase(id: string): Promise<{ deleted: boolean }> {
    return this.knowledgeProvider.deleteKnowledgeBase(id);
  }

  async listKnowledgeBaseFiles(knowledgeBaseId: string): Promise<KnowledgeFile[]> {
    return this.knowledgeProvider.listKnowledgeBaseFiles(knowledgeBaseId);
  }

  async uploadKnowledgeBaseFiles(
    knowledgeBaseId: string,
    request: { contentType: string; body: Uint8Array },
  ): Promise<KnowledgeUploadResult[]> {
    return this.knowledgeProvider.uploadKnowledgeBaseFiles(knowledgeBaseId, request);
  }

  async deleteKnowledgeBaseFile(knowledgeBaseId: string, fileId: string): Promise<{ deleted: boolean }> {
    return this.knowledgeProvider.deleteKnowledgeBaseFile(knowledgeBaseId, fileId);
  }

  async searchKnowledgeBase(
    knowledgeBaseId: string,
    input: KnowledgeSearchInput,
  ): Promise<KnowledgeSearchResult[]> {
    return this.knowledgeProvider.searchKnowledgeBase(knowledgeBaseId, input);
  }

  async getCapabilities(): Promise<LocalCoreCapabilities> {
    return this.workspaceRouter.getCapabilities();
  }

  async probeWorkspaceStreaming(workspaceId: string): Promise<WorkspaceStreamingProbeResult> {
    return this.workspaceRouter.probeWorkspaceStreaming(workspaceId);
  }

  async close() {
    this.workspaceRouter.close();
    try {
      await this.serviceManager.stop();
    } catch {
      // Best effort shutdown for a local dev helper process.
    }
    this.bridgeAdapter.disconnect();
    this.serviceManager.removeAllListeners();
    this.bridgeAdapter.removeAllListeners();
  }

  private async emitRuntime() {
    this.emit('runtime', await this.getRuntimeStatus());
  }

  private syncBridgeWithServiceState() {
    const serviceState = this.serviceManager.getServiceState();
    const bridgeState = this.bridgeAdapter.getState();
    if (serviceState.status === 'running') {
      if (bridgeState.status === 'disconnected' || bridgeState.status === 'error') {
        void this.bridgeAdapter.connect();
      }
      return;
    }
    if (bridgeState.status !== 'disconnected') {
      this.bridgeAdapter.disconnect();
    }
  }

  private async managementGet<T>(path: string): Promise<T> {
    return this.managementRequest<T>('GET', path);
  }

  private async managementPost<T>(path: string, body: unknown): Promise<T> {
    return this.managementRequest<T>('POST', path, body);
  }

  private async managementRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const runtime = await this.getRuntimeStatus();
    const response = await fetch(`${runtime.managementBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${runtime.settings.managementToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json() as { ok?: boolean; data?: T; error?: string };
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `cc-connect request failed: ${response.status}`);
    }
    return payload.data as T;
  }
}
