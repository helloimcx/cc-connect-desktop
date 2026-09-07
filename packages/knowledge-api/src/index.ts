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
} from '@cc/superai-contracts';
import type {
  KnowledgePlugin,
  KnowledgeRuntime,
  KnowledgeRuntimeRegistration,
  PluginContext,
  ThreadKnowledgeAttachmentStore,
} from '@cc/plugin-sdk';

export interface KnowledgeProvider extends KnowledgeRuntime {}

export interface KnowledgeAttachmentStore extends ThreadKnowledgeAttachmentStore {}

export interface KnowledgePluginRuntime extends KnowledgeRuntimeRegistration {}

const DEFAULT_CONFIG: KnowledgeConfig = {
  baseUrl: '',
  authMode: 'none',
  token: '',
  headerName: 'X-API-Key',
  defaultCollection: 'personal_knowledge',
};

export function defaultKnowledgeConfig(): KnowledgeConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

export class NoopThreadKnowledgeAttachmentStore implements KnowledgeAttachmentStore {
  async listThreadKnowledgeBaseIds(): Promise<string[]> {
    return [];
  }

  async updateThreadKnowledgeBaseIds(): Promise<string[]> {
    return [];
  }

  async deleteThreadKnowledgeBaseLinks(): Promise<{ deleted: boolean }> {
    return { deleted: true };
  }
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

  async createFolder(_input: KnowledgeFolderCreateInput): Promise<KnowledgeFolder> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async updateFolder(_id: string, _input: KnowledgeFolderUpdateInput): Promise<KnowledgeFolder> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async deleteFolder(_id: string): Promise<{ deleted: boolean }> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async listKnowledgeBases(): Promise<KnowledgeBase[]> {
    return [];
  }

  async getKnowledgeBase(_id: string): Promise<KnowledgeBase> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async createKnowledgeBase(_input: KnowledgeBaseCreateInput): Promise<KnowledgeBase> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async updateKnowledgeBase(_id: string, _input: KnowledgeBaseUpdateInput): Promise<KnowledgeBase> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async deleteKnowledgeBase(_id: string): Promise<{ deleted: boolean }> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async listKnowledgeBaseFiles(_knowledgeBaseId: string): Promise<KnowledgeFile[]> {
    return [];
  }

  async uploadKnowledgeBaseFiles(
    _knowledgeBaseId: string,
    _request: { contentType: string; body: Uint8Array },
  ): Promise<KnowledgeUploadResult[]> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async deleteKnowledgeBaseFile(_knowledgeBaseId: string, _fileId: string): Promise<{ deleted: boolean }> {
    throw new Error('Knowledge provider is unavailable.');
  }

  async searchKnowledgeBase(_knowledgeBaseId: string, _input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]> {
    return [];
  }
}

export function createNoopKnowledgePlugin(): KnowledgePlugin {
  let provider: KnowledgeProvider | null = null;
  let attachments: KnowledgeAttachmentStore | null = null;

  return {
    manifest: {
      id: 'knowledge.noop',
      kind: 'knowledge',
      version: '0.1.0',
      provides: ['knowledge:noop'],
    },
    capabilities: {
      knowledge: [
        {
          id: 'knowledge.noop',
          sourceType: 'noop',
          enabled: false,
          displayName: 'Disabled Knowledge',
        },
      ],
    },
    createRuntime(_ctx: PluginContext): KnowledgePluginRuntime {
      provider ??= new NoopKnowledgeProvider();
      attachments ??= new NoopThreadKnowledgeAttachmentStore();
      return { provider, attachments };
    },
    healthCheck() {
      return { status: 'healthy' as const };
    },
  };
}
