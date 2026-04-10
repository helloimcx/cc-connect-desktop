import type {
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
  KnowledgeSource,
  KnowledgeUploadResult,
} from '../../contracts/src/index.js';
import { AiVectorKnowledgeProvider, defaultKnowledgeConfig } from './ai-vector-provider.js';

export interface KnowledgeProvider {
  listSources(): Promise<KnowledgeSource[]>;
  getConfig(): Promise<KnowledgeConfig>;
  updateConfig(input: Partial<KnowledgeConfig>): Promise<KnowledgeConfig>;
  listFolders(): Promise<KnowledgeFolder[]>;
  createFolder(input: KnowledgeFolderCreateInput): Promise<KnowledgeFolder>;
  updateFolder(id: string, input: KnowledgeFolderUpdateInput): Promise<KnowledgeFolder>;
  deleteFolder(id: string): Promise<{ deleted: boolean }>;
  listKnowledgeBases(): Promise<KnowledgeBase[]>;
  getKnowledgeBase(id: string): Promise<KnowledgeBase>;
  createKnowledgeBase(input: KnowledgeBaseCreateInput): Promise<KnowledgeBase>;
  updateKnowledgeBase(id: string, input: KnowledgeBaseUpdateInput): Promise<KnowledgeBase>;
  deleteKnowledgeBase(id: string): Promise<{ deleted: boolean }>;
  listKnowledgeBaseFiles(knowledgeBaseId: string): Promise<KnowledgeFile[]>;
  uploadKnowledgeBaseFiles(
    knowledgeBaseId: string,
    request: { contentType: string; body: Uint8Array },
  ): Promise<KnowledgeUploadResult[]>;
  deleteKnowledgeBaseFile(knowledgeBaseId: string, fileId: string): Promise<{ deleted: boolean }>;
  searchKnowledgeBase(knowledgeBaseId: string, input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]>;
}

export class NoopKnowledgeProvider implements KnowledgeProvider {
  async listSources(): Promise<KnowledgeSource[]> {
    return [];
  }

  async getConfig(): Promise<KnowledgeConfig> {
    return defaultKnowledgeConfig();
  }

  async updateConfig(): Promise<KnowledgeConfig> {
    return defaultKnowledgeConfig();
  }

  async listFolders(): Promise<KnowledgeFolder[]> {
    return [];
  }

  async createFolder(): Promise<KnowledgeFolder> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async updateFolder(): Promise<KnowledgeFolder> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async deleteFolder(): Promise<{ deleted: boolean }> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async listKnowledgeBases(): Promise<KnowledgeBase[]> {
    return [];
  }

  async getKnowledgeBase(): Promise<KnowledgeBase> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async createKnowledgeBase(): Promise<KnowledgeBase> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async updateKnowledgeBase(): Promise<KnowledgeBase> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async deleteKnowledgeBase(): Promise<{ deleted: boolean }> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async listKnowledgeBaseFiles(): Promise<KnowledgeFile[]> {
    return [];
  }

  async uploadKnowledgeBaseFiles(): Promise<KnowledgeUploadResult[]> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async deleteKnowledgeBaseFile(): Promise<{ deleted: boolean }> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async searchKnowledgeBase(): Promise<KnowledgeSearchResult[]> {
    return [];
  }
}

export { AiVectorKnowledgeProvider, defaultKnowledgeConfig };
