import {
  type KnowledgeBase,
  type KnowledgeBaseCreateInput,
  type KnowledgeBaseUpdateInput,
  type KnowledgeConfig,
  type KnowledgeFile,
  type KnowledgeFolder,
  type KnowledgeFolderCreateInput,
  type KnowledgeFolderUpdateInput,
  type KnowledgeSearchInput,
  type KnowledgeSearchResult,
  type KnowledgeSource,
  type KnowledgeUploadResult,
} from '../../contracts/src/index.js';
import { KnowledgeSqliteStore } from './sqlite-store.js';

interface AiVectorKnowledgeProviderOptions {
  userDataPath: string;
  getConfig: () => KnowledgeConfig;
  setConfig: (input: Partial<KnowledgeConfig>) => Promise<KnowledgeConfig> | KnowledgeConfig;
}

type AiVectorEnvelope<T> = {
  data?: T;
  resultCode?: number;
  resultMsg?: string;
};

type AiVectorFileRecord = {
  knowledgebase_id?: string | null;
  file_id: string;
  file_name: string;
  file_type: string;
  file_size: number;
  folder?: string | null;
  create_time: string;
  word_count?: number | null;
  metadata?: Record<string, unknown> | null;
  abstract?: string | null;
  full_content?: string | null;
};

type AiVectorSearchRecord = {
  id: string;
  score?: number;
  metadata?: {
    file_id?: string;
    file_name?: string;
    document?: string;
    chunk_offset?: number;
  };
};

type AiVectorUploadRecord = AiVectorFileRecord & {
  success?: boolean;
  msg?: string | null;
};

const DEFAULT_CONFIG: KnowledgeConfig = {
  baseUrl: '',
  authMode: 'none',
  token: '',
  headerName: 'X-API-Key',
  defaultCollection: 'personal_knowledge',
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeConfig(input?: Partial<KnowledgeConfig> | null): KnowledgeConfig {
  return {
    baseUrl: String(input?.baseUrl || '').trim(),
    authMode:
      input?.authMode === 'bearer' || input?.authMode === 'header'
        ? input.authMode
        : 'none',
    token: String(input?.token || '').trim(),
    headerName: String(input?.headerName || DEFAULT_CONFIG.headerName).trim() || DEFAULT_CONFIG.headerName,
    defaultCollection: String(input?.defaultCollection || DEFAULT_CONFIG.defaultCollection).trim() || DEFAULT_CONFIG.defaultCollection,
  };
}

function normalizeBaseUrl(baseUrl: string) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/ai/vector/v1') ? trimmed : `${trimmed}/ai/vector/v1`;
}

function summarizeSnippet(text: string, limit = 220) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit).trimEnd()}...`;
}

export class AiVectorKnowledgeProvider {
  private readonly store: KnowledgeSqliteStore;
  private readonly getConfigValue: () => KnowledgeConfig;
  private readonly setConfigValue: (input: Partial<KnowledgeConfig>) => Promise<KnowledgeConfig> | KnowledgeConfig;

  constructor(options: AiVectorKnowledgeProviderOptions) {
    this.store = new KnowledgeSqliteStore({ userDataPath: options.userDataPath });
    this.getConfigValue = options.getConfig;
    this.setConfigValue = options.setConfig;
  }

  async listSources(): Promise<KnowledgeSource[]> {
    const bases = await this.listKnowledgeBases();
    return bases.map((base) => ({
      id: base.id,
      name: base.name,
      type: 'knowledge-base',
      status: 'ready',
      description: base.description,
      fileCount: base.fileCount,
      wordCount: base.wordCount,
    }));
  }

  async getConfig(): Promise<KnowledgeConfig> {
    return normalizeConfig(this.getConfigValue());
  }

  async updateConfig(input: Partial<KnowledgeConfig>): Promise<KnowledgeConfig> {
    const merged = normalizeConfig({
      ...normalizeConfig(this.getConfigValue()),
      ...input,
    });
    return normalizeConfig(await this.setConfigValue(merged));
  }

  async listFolders(): Promise<KnowledgeFolder[]> {
    return this.store.listFolders();
  }

  async createFolder(input: KnowledgeFolderCreateInput): Promise<KnowledgeFolder> {
    const name = String(input.name || '').trim();
    if (!name) {
      throw new Error('Folder name is required.');
    }

    const folders = this.store.listFolders();
    const parent = input.parentId ? folders.find((folder) => folder.id === input.parentId) || null : null;
    if (input.parentId && !parent) {
      throw new Error('Parent folder does not exist.');
    }

    const siblings = folders.filter((folder) => folder.parentId === (input.parentId || null));
    const timestamp = nowIso();
    const nextFolder: KnowledgeFolder = {
      id: randomId('folder'),
      name,
      parentId: input.parentId || null,
      path: this.buildFolderPath(name, parent || null),
      sortOrder: siblings.length,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.store.insertFolder(nextFolder);
  }

  async updateFolder(id: string, input: KnowledgeFolderUpdateInput): Promise<KnowledgeFolder> {
    const name = String(input.name || '').trim();
    if (!name) {
      throw new Error('Folder name is required.');
    }

    const folder = this.store.getFolder(id);
    if (!folder) {
      throw new Error('Folder does not exist.');
    }

    const parent = folder.parentId ? this.store.getFolder(folder.parentId) : null;
    const previousPath = folder.path;
    const nextPath = this.buildFolderPath(name, parent);
    return this.store.renameFolder(id, {
      name,
      previousPath,
      nextPath,
      updatedAt: nowIso(),
    });
  }

  async deleteFolder(id: string): Promise<{ deleted: boolean }> {
    const hasChildren = this.store.hasFolderChildren(id);
    if (hasChildren) {
      throw new Error('Delete or move child folders before removing this folder.');
    }
    const hasBases = this.store.hasKnowledgeBasesInFolder(id);
    if (hasBases) {
      throw new Error('Delete or move knowledge bases before removing this folder.');
    }
    if (!this.store.getFolder(id)) {
      throw new Error('Folder does not exist.');
    }
    this.store.deleteFolder(id);
    return { deleted: true };
  }

  async listKnowledgeBases(): Promise<KnowledgeBase[]> {
    return this.store.listKnowledgeBases();
  }

  async getKnowledgeBase(id: string): Promise<KnowledgeBase> {
    return this.findLocalKnowledgeBase(id);
  }

  async createKnowledgeBase(input: KnowledgeBaseCreateInput): Promise<KnowledgeBase> {
    const name = String(input.name || '').trim();
    if (!name) {
      throw new Error('Knowledge base name is required.');
    }

    if (input.folderId && !this.store.getFolder(input.folderId)) {
      throw new Error('Selected folder does not exist.');
    }

    const timestamp = nowIso();
    const nextBase: KnowledgeBase = {
      id: randomId('kb'),
      name,
      description: String(input.description || '').trim(),
      folderId: input.folderId || null,
      creatorName: String(input.creatorName || '系统管理员').trim() || '系统管理员',
      icon: String(input.icon || 'book').trim() || 'book',
      fileCount: 0,
      wordCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.store.insertKnowledgeBase(nextBase);
  }

  async updateKnowledgeBase(id: string, input: KnowledgeBaseUpdateInput): Promise<KnowledgeBase> {
    const current = this.findLocalKnowledgeBase(id);
    if (input.folderId && !this.store.getFolder(input.folderId)) {
      throw new Error('Selected folder does not exist.');
    }
    const next: KnowledgeBase = {
      ...current,
      name: input.name === undefined ? current.name : String(input.name || '').trim() || current.name,
      description: input.description === undefined ? current.description : String(input.description || '').trim(),
      folderId: input.folderId === undefined ? current.folderId : input.folderId || null,
      creatorName: input.creatorName === undefined ? current.creatorName : String(input.creatorName || '').trim() || current.creatorName,
      icon: input.icon === undefined ? current.icon : String(input.icon || '').trim() || current.icon,
      updatedAt: nowIso(),
    };
    return this.store.updateKnowledgeBase(next);
  }

  async deleteKnowledgeBase(id: string): Promise<{ deleted: boolean }> {
    const base = this.store.getKnowledgeBase(id);
    if (!base) {
      throw new Error('Knowledge base does not exist.');
    }

    try {
      const files = await this.listKnowledgeBaseFiles(id);
      const remoteFileIds = files.length > 0
        ? files.map((file) => file.fileId)
        : await this.discoverKnowledgeBaseFileIds(id);
      if (remoteFileIds.length > 0) {
        const config = this.requireConfigured();
        await this.aiVectorRequest('/qdrant/batchDelete', {
          method: 'POST',
          body: JSON.stringify({
            collection: config.defaultCollection,
            file_ids: remoteFileIds,
            knowledgebase_id: id,
          }),
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }
    } catch {
      // Best effort remote cleanup. Local metadata is still the source of truth for this module.
    }

    this.store.deleteKnowledgeBase(id);
    return { deleted: true };
  }

  async listKnowledgeBaseFiles(knowledgeBaseId: string): Promise<KnowledgeFile[]> {
    this.findLocalKnowledgeBase(knowledgeBaseId);
    return this.store.listKnowledgeBaseFiles(knowledgeBaseId);
  }

  async uploadKnowledgeBaseFiles(
    knowledgeBaseId: string,
    request: { contentType: string; body: Uint8Array },
  ): Promise<KnowledgeUploadResult[]> {
    this.findLocalKnowledgeBase(knowledgeBaseId);
    this.requireConfigured();
    const response = await this.aiVectorRequest<AiVectorUploadRecord[]>(
      '/qdrant/file',
      {
        method: 'POST',
        body: request.body,
        headers: {
          'Content-Type': request.contentType,
        },
      },
    );
    const cachedFiles = (response || [])
      .filter((item) => Boolean(item.success))
      .map((item) => this.mapFile(item));
    if (cachedFiles.length > 0) {
      this.store.upsertKnowledgeBaseFiles(cachedFiles);
      this.store.touchKnowledgeBase(knowledgeBaseId, nowIso());
    }
    return (response || []).map((item) => ({
      fileId: String(item.file_id || ''),
      fileName: String(item.file_name || ''),
      fileType: String(item.file_type || ''),
      success: Boolean(item.success),
      message: String(item.msg || (item.success ? 'success' : 'Upload failed')),
      wordCount: typeof item.word_count === 'number' ? item.word_count : null,
    }));
  }

  async deleteKnowledgeBaseFile(knowledgeBaseId: string, fileId: string): Promise<{ deleted: boolean }> {
    this.findLocalKnowledgeBase(knowledgeBaseId);
    const config = this.requireConfigured();
    const response = await this.aiVectorRequest<{ success?: boolean }>(
      '/qdrant/delete',
      {
        method: 'POST',
        body: JSON.stringify({
          collection: config.defaultCollection,
          file_id: fileId,
          knowledgebase_id: knowledgeBaseId,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
    const deleted = Boolean(response?.success);
    if (deleted) {
      this.store.deleteKnowledgeBaseFile(fileId);
      this.store.touchKnowledgeBase(knowledgeBaseId, nowIso());
    }
    return { deleted };
  }

  async searchKnowledgeBase(knowledgeBaseId: string, input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]> {
    this.findLocalKnowledgeBase(knowledgeBaseId);
    const config = this.requireConfigured();
    const response = await this.aiVectorRequest<{ documents?: AiVectorSearchRecord[] }>(
      '/qdrant/query',
      {
        method: 'POST',
        body: JSON.stringify({
          collection: config.defaultCollection,
          query: String(input.query || '').trim(),
          knowledgebase_id: knowledgeBaseId,
          limit: Math.max(1, Number(input.limit || 8)),
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );

    return (response?.documents || []).map((item) => {
      const metadata = item.metadata || {};
      const content = String(metadata.document || '');
      return {
        id: String(item.id || randomId('result')),
        knowledgeBaseId,
        fileId: String(metadata.file_id || ''),
        fileName: String(metadata.file_name || '未命名文件'),
        title: String(metadata.file_name || '搜索结果'),
        snippet: summarizeSnippet(content),
        score: Number(item.score || 0),
        chunkOffset: Number(metadata.chunk_offset || 0),
        content,
      };
    });
  }

  async listThreadKnowledgeBaseIds(threadId: string): Promise<string[]> {
    return this.store.listThreadKnowledgeBaseIds(threadId);
  }

  async updateThreadKnowledgeBaseIds(threadId: string, knowledgeBaseIds: string[]): Promise<string[]> {
    return this.store.replaceThreadKnowledgeBaseIds(threadId, knowledgeBaseIds);
  }

  async deleteThreadKnowledgeBaseLinks(threadId: string): Promise<{ deleted: boolean }> {
    this.store.deleteThreadKnowledgeBaseLinks(threadId);
    return { deleted: true };
  }

  private buildFolderPath(name: string, parent: KnowledgeFolder | null) {
    return parent ? `${parent.path}/${name}` : name;
  }

  private findLocalKnowledgeBase(id: string) {
    const base = this.store.getKnowledgeBase(id);
    if (!base) {
      throw new Error('Knowledge base does not exist.');
    }
    return clone(base);
  }

  private requireConfigured() {
    const config = normalizeConfig(this.getConfigValue());
    if (!config.baseUrl) {
      throw new Error('Knowledge service is not configured. Set the ai_vector base URL in Workspace settings.');
    }
    return config;
  }

  private mapFile(file: AiVectorFileRecord): KnowledgeFile {
    return {
      knowledgebaseId: file.knowledgebase_id || null,
      fileId: String(file.file_id || ''),
      fileName: String(file.file_name || ''),
      fileType: String(file.file_type || ''),
      fileSize: Number(file.file_size || 0),
      folder: file.folder || null,
      createTime: String(file.create_time || ''),
      wordCount: typeof file.word_count === 'number' ? file.word_count : null,
      metadata: file.metadata || null,
      abstract: file.abstract || null,
      fullContent: file.full_content || null,
    };
  }

  private async discoverKnowledgeBaseFileIds(knowledgeBaseId: string): Promise<string[]> {
    const config = this.requireConfigured();
    const response = await this.aiVectorRequest<{ documents?: AiVectorSearchRecord[] }>(
      '/qdrant/query',
      {
        method: 'POST',
        body: JSON.stringify({
          collection: config.defaultCollection,
          query: '*',
          knowledgebase_id: knowledgeBaseId,
          limit: 200,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );

    return Array.from(new Set(
      (response?.documents || [])
        .map((item) => String(item.metadata?.file_id || '').trim())
        .filter(Boolean),
    ));
  }

  private async aiVectorRequest<T>(
    path: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: BodyInit;
    },
  ): Promise<T> {
    const config = this.requireConfigured();
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const headers: Record<string, string> = {
      ...(init.headers || {}),
      ...this.buildAuthHeaders(config),
    };
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as T | AiVectorEnvelope<T> : null;
    if (!response.ok) {
      if (payload && typeof payload === 'object' && 'resultMsg' in payload) {
        throw new Error(String((payload as AiVectorEnvelope<T>).resultMsg || `ai_vector request failed: ${response.status}`));
      }
      throw new Error(`ai_vector request failed: ${response.status}`);
    }
    if (payload && typeof payload === 'object' && ('resultCode' in payload || 'resultMsg' in payload || 'data' in payload)) {
      const envelope = payload as AiVectorEnvelope<T>;
      if (Number(envelope.resultCode || 0) !== 0) {
        throw new Error(String(envelope.resultMsg || `ai_vector request failed: ${response.status}`));
      }
      return envelope.data as T;
    }
    return payload as T;
  }

  private buildAuthHeaders(config: KnowledgeConfig) {
    if (config.authMode === 'bearer' && config.token) {
      return { Authorization: `Bearer ${config.token}` };
    }
    if (config.authMode === 'header' && config.token) {
      return { [config.headerName || DEFAULT_CONFIG.headerName]: config.token };
    }
    return {};
  }
}

export function defaultKnowledgeConfig() {
  return clone(DEFAULT_CONFIG);
}
