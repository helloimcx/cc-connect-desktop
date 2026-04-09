import type { KnowledgeSource } from '../../contracts/src';

export interface KnowledgeSearchResult {
  id: string;
  sourceId: string;
  title: string;
  snippet: string;
  score: number;
}

export interface KnowledgeCitation {
  sourceId: string;
  title: string;
  snippet: string;
}

export interface KnowledgeProvider {
  listSources(): Promise<KnowledgeSource[]>;
  ingestSource(input: { name: string; type: string; uri: string }): Promise<{ id: string }>;
  search(query: string): Promise<KnowledgeSearchResult[]>;
  cite(resultIds: string[]): Promise<KnowledgeCitation[]>;
}

export class NoopKnowledgeProvider implements KnowledgeProvider {
  async listSources(): Promise<KnowledgeSource[]> {
    return [];
  }

  async ingestSource(): Promise<{ id: string }> {
    return { id: 'noop-source' };
  }

  async search(): Promise<KnowledgeSearchResult[]> {
    return [];
  }

  async cite(): Promise<KnowledgeCitation[]> {
    return [];
  }
}
