import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

interface AiVectorKnowledgeProviderOptions {
  userDataPath: string;
  getConfig: () => KnowledgeConfig;
  setConfig: (input: Partial<KnowledgeConfig>) => Promise<KnowledgeConfig> | KnowledgeConfig;
}

interface KnowledgeStore {
  folders: KnowledgeFolder[];
  knowledgeBases: KnowledgeBase[];
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
  private readonly storePath: string;
  private readonly getConfigValue: () => KnowledgeConfig;
  private readonly setConfigValue: (input: Partial<KnowledgeConfig>) => Promise<KnowledgeConfig> | KnowledgeConfig;

  constructor(options: AiVectorKnowledgeProviderOptions) {
    this.storePath = join(options.userDataPath, 'runtime', 'knowledge-store.json');
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
    return this.readStore().folders.sort((left, right) => {
      if (left.path === right.path) {
        return left.sortOrder - right.sortOrder;
      }
      return left.path.localeCompare(right.path);
    });
  }

  async createFolder(input: KnowledgeFolderCreateInput): Promise<KnowledgeFolder> {
    const name = String(input.name || '').trim();
    if (!name) {
      throw new Error('Folder name is required.');
    }

    const store = this.readStore();
    const parent = input.parentId ? store.folders.find((folder) => folder.id === input.parentId) : null;
    if (input.parentId && !parent) {
      throw new Error('Parent folder does not exist.');
    }

    const siblings = store.folders.filter((folder) => folder.parentId === (input.parentId || null));
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
    store.folders.push(nextFolder);
    this.writeStore(store);
    return nextFolder;
  }

  async updateFolder(id: string, input: KnowledgeFolderUpdateInput): Promise<KnowledgeFolder> {
    const name = String(input.name || '').trim();
    if (!name) {
      throw new Error('Folder name is required.');
    }

    const store = this.readStore();
    const folderIndex = store.folders.findIndex((folder) => folder.id === id);
    if (folderIndex < 0) {
      throw new Error('Folder does not exist.');
    }

    const folder = store.folders[folderIndex];
    const parent = folder.parentId ? store.folders.find((entry) => entry.id === folder.parentId) || null : null;
    const previousPath = folder.path;
    const nextPath = this.buildFolderPath(name, parent);
    store.folders[folderIndex] = {
      ...folder,
      name,
      path: nextPath,
      updatedAt: nowIso(),
    };

    // Keep descendant paths in sync after a rename.
    store.folders = store.folders.map((entry) => {
      if (entry.id === id || !entry.path.startsWith(`${previousPath}/`)) {
        return entry;
      }
      return {
        ...entry,
        path: entry.path.replace(previousPath, nextPath),
        updatedAt: nowIso(),
      };
    });
    this.writeStore(store);
    return clone(store.folders[folderIndex]);
  }

  async deleteFolder(id: string): Promise<{ deleted: boolean }> {
    const store = this.readStore();
    const hasChildren = store.folders.some((folder) => folder.parentId === id);
    if (hasChildren) {
      throw new Error('Delete or move child folders before removing this folder.');
    }
    const hasBases = store.knowledgeBases.some((base) => base.folderId === id);
    if (hasBases) {
      throw new Error('Delete or move knowledge bases before removing this folder.');
    }
    const nextFolders = store.folders.filter((folder) => folder.id !== id);
    if (nextFolders.length === store.folders.length) {
      throw new Error('Folder does not exist.');
    }
    store.folders = nextFolders;
    this.writeStore(store);
    return { deleted: true };
  }

  async listKnowledgeBases(): Promise<KnowledgeBase[]> {
    const store = this.readStore();
    const config = normalizeConfig(this.getConfigValue());
    if (!config.baseUrl) {
      return clone(store.knowledgeBases).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    const withStats = await Promise.all(
      store.knowledgeBases.map(async (base) => {
        try {
          const files = await this.listKnowledgeBaseFiles(base.id);
          return {
            ...base,
            fileCount: files.length,
            wordCount: files.reduce((sum, file) => sum + Number(file.wordCount || 0), 0),
          };
        } catch {
          return base;
        }
      }),
    );
    return withStats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getKnowledgeBase(id: string): Promise<KnowledgeBase> {
    const localBase = this.findLocalKnowledgeBase(id);
    const config = normalizeConfig(this.getConfigValue());
    if (!config.baseUrl) {
      return localBase;
    }
    try {
      const files = await this.listKnowledgeBaseFiles(id);
      return {
        ...localBase,
        fileCount: files.length,
        wordCount: files.reduce((sum, file) => sum + Number(file.wordCount || 0), 0),
      };
    } catch {
      return localBase;
    }
  }

  async createKnowledgeBase(input: KnowledgeBaseCreateInput): Promise<KnowledgeBase> {
    const name = String(input.name || '').trim();
    if (!name) {
      throw new Error('Knowledge base name is required.');
    }

    const store = this.readStore();
    if (input.folderId && !store.folders.some((folder) => folder.id === input.folderId)) {
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
    store.knowledgeBases.push(nextBase);
    this.writeStore(store);
    return nextBase;
  }

  async updateKnowledgeBase(id: string, input: KnowledgeBaseUpdateInput): Promise<KnowledgeBase> {
    const store = this.readStore();
    const index = store.knowledgeBases.findIndex((base) => base.id === id);
    if (index < 0) {
      throw new Error('Knowledge base does not exist.');
    }
    if (input.folderId && !store.folders.some((folder) => folder.id === input.folderId)) {
      throw new Error('Selected folder does not exist.');
    }

    const current = store.knowledgeBases[index];
    const next: KnowledgeBase = {
      ...current,
      name: input.name === undefined ? current.name : String(input.name || '').trim() || current.name,
      description: input.description === undefined ? current.description : String(input.description || '').trim(),
      folderId: input.folderId === undefined ? current.folderId : input.folderId || null,
      creatorName: input.creatorName === undefined ? current.creatorName : String(input.creatorName || '').trim() || current.creatorName,
      icon: input.icon === undefined ? current.icon : String(input.icon || '').trim() || current.icon,
      updatedAt: nowIso(),
    };
    store.knowledgeBases[index] = next;
    this.writeStore(store);
    return next;
  }

  async deleteKnowledgeBase(id: string): Promise<{ deleted: boolean }> {
    const store = this.readStore();
    const base = store.knowledgeBases.find((entry) => entry.id === id);
    if (!base) {
      throw new Error('Knowledge base does not exist.');
    }

    try {
      const files = await this.listKnowledgeBaseFiles(id);
      if (files.length > 0) {
        const config = this.requireConfigured();
        await this.aiVectorRequest('/qdrant/batchDelete', {
          method: 'POST',
          body: JSON.stringify({
            collection: config.defaultCollection,
            file_ids: files.map((file) => file.fileId),
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

    store.knowledgeBases = store.knowledgeBases.filter((entry) => entry.id !== id);
    this.writeStore(store);
    return { deleted: true };
  }

  async listKnowledgeBaseFiles(knowledgeBaseId: string): Promise<KnowledgeFile[]> {
    this.findLocalKnowledgeBase(knowledgeBaseId);
    const config = this.requireConfigured();
    const response = await this.aiVectorRequest<AiVectorFileRecord[]>(
      `/qdrant/list?knowledgebase_id=${encodeURIComponent(knowledgeBaseId)}&collection=${encodeURIComponent(config.defaultCollection)}`,
      {
        method: 'GET',
      },
    );
    return (response || []).map((file) => this.mapFile(file));
  }

  async uploadKnowledgeBaseFiles(
    knowledgeBaseId: string,
    request: { contentType: string; body: Uint8Array },
  ): Promise<KnowledgeUploadResult[]> {
    await this.getKnowledgeBase(knowledgeBaseId);
    this.requireConfigured();
    const response = await this.aiVectorRequest<any[]>(
      '/qdrant/file',
      {
        method: 'POST',
        body: request.body,
        headers: {
          'Content-Type': request.contentType,
        },
      },
    );
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
    await this.getKnowledgeBase(knowledgeBaseId);
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
    return { deleted: Boolean(response?.success) };
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

  private readStore(): KnowledgeStore {
    const defaults: KnowledgeStore = {
      folders: [],
      knowledgeBases: [],
    };
    if (!existsSync(this.storePath)) {
      this.writeStore(defaults);
      return defaults;
    }
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as Partial<KnowledgeStore>;
      return {
        folders: Array.isArray(raw.folders) ? raw.folders : [],
        knowledgeBases: Array.isArray(raw.knowledgeBases) ? raw.knowledgeBases : [],
      };
    } catch {
      this.writeStore(defaults);
      return defaults;
    }
  }

  private writeStore(store: KnowledgeStore) {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  }

  private buildFolderPath(name: string, parent: KnowledgeFolder | null) {
    return parent ? `${parent.path}/${name}` : name;
  }

  private findLocalKnowledgeBase(id: string) {
    const base = this.readStore().knowledgeBases.find((entry) => entry.id === id);
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
    const payload = text ? JSON.parse(text) as AiVectorEnvelope<T> : {};
    if (!response.ok || Number(payload.resultCode || 0) !== 0) {
      throw new Error(String(payload.resultMsg || `ai_vector request failed: ${response.status}`));
    }
    return payload.data as T;
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
