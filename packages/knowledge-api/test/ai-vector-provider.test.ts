import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeConfig } from '../../contracts/src/index.js';
import { AiVectorKnowledgeProvider, defaultKnowledgeConfig } from '../src/ai-vector-provider.js';
import { KnowledgeSqliteStore } from '../src/sqlite-store.js';

function withTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstation-kb-'));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('migrates legacy knowledge-store.json into sqlite and keeps a backup', () => {
  const temp = withTempDir();
  try {
    const runtimeDir = join(temp.dir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'knowledge-store.json'), JSON.stringify({
      folders: [
        {
          id: 'folder-1',
          name: '运营',
          parentId: null,
          path: '运营',
          sortOrder: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      knowledgeBases: [
        {
          id: 'kb-1',
          name: '运营知识库',
          description: 'desc',
          folderId: 'folder-1',
          creatorName: '系统管理员',
          icon: 'book',
          fileCount: 0,
          wordCount: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }), 'utf8');

    const store = new KnowledgeSqliteStore({ userDataPath: temp.dir });
    try {
      assert.equal(store.listFolders().length, 1);
      assert.equal(store.listKnowledgeBases().length, 1);
      assert.equal(store.getKnowledgeBase('kb-1')?.name, '运营知识库');
      assert.equal(existsSync(join(runtimeDir, 'knowledge-store.json')), false);
      assert.equal(existsSync(join(runtimeDir, 'knowledge-store.json.bak')), true);
      assert.equal(existsSync(join(runtimeDir, 'knowledge.db')), true);
    } finally {
      store.close();
    }
  } finally {
    temp.cleanup();
  }
});

test('uses uploaded file cache when remote list is empty', async () => {
  const temp = withTempDir();
  const config: KnowledgeConfig = {
    ...defaultKnowledgeConfig(),
    baseUrl: 'http://vector.example.com',
  };
  let knowledgeBaseId = '';
  const provider = new AiVectorKnowledgeProvider({
    userDataPath: temp.dir,
    getConfig: () => config,
    setConfig: (input) => ({ ...config, ...input }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/qdrant/file')) {
      return new Response(JSON.stringify({
        resultCode: 0,
        resultMsg: 'success',
        data: [
          {
            knowledgebase_id: knowledgeBaseId,
            file_id: 'file-1',
            file_name: 'doc.md',
            file_type: 'md',
            file_size: 12,
            folder: null,
            create_time: '2026-01-02T00:00:00.000Z',
            word_count: 5,
            metadata: { source: 'upload' },
            abstract: 'summary',
            full_content: 'hello world',
            success: true,
          },
        ],
      }));
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const base = await provider.createKnowledgeBase({
      name: '运营知识库',
      description: 'desc',
    });
    knowledgeBaseId = base.id;

    const upload = await provider.uploadKnowledgeBaseFiles(knowledgeBaseId, {
      contentType: 'multipart/form-data; boundary=test',
      body: new Uint8Array([1, 2, 3]),
    });
    const files = await provider.listKnowledgeBaseFiles(knowledgeBaseId);
    const nextBase = await provider.getKnowledgeBase(knowledgeBaseId);

    assert.equal(upload.length, 1);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.fileId, 'file-1');
    assert.equal(files[0]?.wordCount, 5);
    assert.equal(nextBase.fileCount, 1);
    assert.equal(nextBase.wordCount, 5);
  } finally {
    globalThis.fetch = originalFetch;
    temp.cleanup();
  }
});

test('reads file lists and stats from sqlite without calling remote list', async () => {
  const temp = withTempDir();
  const config: KnowledgeConfig = {
    ...defaultKnowledgeConfig(),
    baseUrl: 'http://vector.example.com',
  };
  let knowledgeBaseId = '';
  const provider = new AiVectorKnowledgeProvider({
    userDataPath: temp.dir,
    getConfig: () => config,
    setConfig: (input) => ({ ...config, ...input }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/qdrant/file')) {
      return new Response(JSON.stringify({
        resultCode: 0,
        resultMsg: 'success',
        data: [
          {
            knowledgebase_id: knowledgeBaseId,
            file_id: 'file-1',
            file_name: 'doc.md',
            file_type: 'md',
            file_size: 12,
            folder: null,
            create_time: '2026-01-02T00:00:00.000Z',
            word_count: 5,
            metadata: null,
            abstract: null,
            full_content: 'hello world',
            success: true,
          },
        ],
      }));
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const base = await provider.createKnowledgeBase({
      name: '运营知识库',
      description: 'desc',
    });
    knowledgeBaseId = base.id;
    await provider.uploadKnowledgeBaseFiles(knowledgeBaseId, {
      contentType: 'multipart/form-data; boundary=test',
      body: new Uint8Array([1, 2, 3]),
    });

    globalThis.fetch = (async (input: string | URL | Request) => {
      throw new Error(`No remote read expected: ${String(input)}`);
    }) as typeof fetch;

    const files = await provider.listKnowledgeBaseFiles(knowledgeBaseId);
    const nextBase = await provider.getKnowledgeBase(knowledgeBaseId);
    const bases = await provider.listKnowledgeBases();

    assert.equal(files.length, 1);
    assert.equal(files[0]?.fileId, 'file-1');
    assert.equal(nextBase.fileCount, 1);
    assert.equal(nextBase.wordCount, 5);
    assert.equal(bases[0]?.fileCount, 1);
    assert.equal(bases[0]?.wordCount, 5);
  } finally {
    globalThis.fetch = originalFetch;
    temp.cleanup();
  }
});

test('supports raw ai_vector search responses without envelope', async () => {
  const temp = withTempDir();
  const config: KnowledgeConfig = {
    ...defaultKnowledgeConfig(),
    baseUrl: 'http://vector.example.com',
  };
  const provider = new AiVectorKnowledgeProvider({
    userDataPath: temp.dir,
    getConfig: () => config,
    setConfig: (input) => ({ ...config, ...input }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/qdrant/query')) {
      return new Response(JSON.stringify({
        intent: 'CHAT',
        documents: [
          {
            id: 'result-1',
            score: 0.9,
            metadata: {
              file_id: 'file-1',
              file_name: 'doc.md',
              document: 'hello knowledge',
              chunk_offset: 2,
            },
          },
        ],
      }));
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const base = await provider.createKnowledgeBase({
      name: '运营知识库',
      description: 'desc',
    });
    const results = await provider.searchKnowledgeBase(base.id, { query: 'hello', limit: 3 });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.fileId, 'file-1');
    assert.equal(results[0]?.chunkOffset, 2);
    assert.match(results[0]?.snippet || '', /hello knowledge/);
  } finally {
    globalThis.fetch = originalFetch;
    temp.cleanup();
  }
});

test('stores selected knowledge-base bindings per thread in sqlite', async () => {
  const temp = withTempDir();
  const provider = new AiVectorKnowledgeProvider({
    userDataPath: temp.dir,
    getConfig: () => defaultKnowledgeConfig(),
    setConfig: (input) => ({ ...defaultKnowledgeConfig(), ...input }),
  });

  try {
    const firstBase = await provider.createKnowledgeBase({ name: '知识库 A' });
    const secondBase = await provider.createKnowledgeBase({ name: '知识库 B' });

    const storedIds = await provider.updateThreadKnowledgeBaseIds('thread-1', [
      firstBase.id,
      secondBase.id,
      firstBase.id,
    ]);

    assert.deepEqual(storedIds, [firstBase.id, secondBase.id]);
    assert.deepEqual(await provider.listThreadKnowledgeBaseIds('thread-1'), [firstBase.id, secondBase.id]);

    await provider.deleteThreadKnowledgeBaseLinks('thread-1');
    assert.deepEqual(await provider.listThreadKnowledgeBaseIds('thread-1'), []);
  } finally {
    temp.cleanup();
  }
});

test('deletes remote vector data for cached-miss knowledge bases before removing local base', async () => {
  const temp = withTempDir();
  const config: KnowledgeConfig = {
    ...defaultKnowledgeConfig(),
    baseUrl: 'http://vector.example.com',
  };
  let knowledgeBaseId = '';
  let batchDeletePayload: Record<string, unknown> | null = null;
  const provider = new AiVectorKnowledgeProvider({
    userDataPath: temp.dir,
    getConfig: () => config,
    setConfig: (input) => ({ ...config, ...input }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/qdrant/query')) {
      return new Response(JSON.stringify({
        intent: 'CHAT',
        documents: [
          {
            id: 'result-1',
            metadata: {
              file_id: 'file-a',
              file_name: 'doc-a.md',
            },
          },
          {
            id: 'result-2',
            metadata: {
              file_id: 'file-b',
              file_name: 'doc-b.md',
            },
          },
          {
            id: 'result-3',
            metadata: {
              file_id: 'file-a',
              file_name: 'doc-a.md',
            },
          },
        ],
      }));
    }
    if (url.endsWith('/qdrant/batchDelete')) {
      batchDeletePayload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      return new Response(JSON.stringify({
        resultCode: 0,
        resultMsg: 'success',
        data: { success: true },
      }));
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const base = await provider.createKnowledgeBase({
      name: '运营知识库',
      description: 'desc',
    });
    knowledgeBaseId = base.id;

    const result = await provider.deleteKnowledgeBase(knowledgeBaseId);

    assert.equal(result.deleted, true);
    assert.deepEqual(batchDeletePayload, {
      collection: 'personal_knowledge',
      knowledgebase_id: knowledgeBaseId,
      file_ids: ['file-a', 'file-b'],
    });
    await assert.rejects(() => provider.getKnowledgeBase(knowledgeBaseId), /Knowledge base does not exist/);
  } finally {
    globalThis.fetch = originalFetch;
    temp.cleanup();
  }
});
