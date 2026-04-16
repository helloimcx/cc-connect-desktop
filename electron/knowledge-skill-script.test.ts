import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

function runScript(args: string[], env: Record<string, string>) {
  const scriptPath = join(process.cwd(), 'electron', 'managed-skills', 'knowledge-base', 'scripts', 'search-knowledge.sh');
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile('sh', [scriptPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

test('knowledge skill script formats multi-base search results, no results, and API failures', async () => {
  const server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.url.endsWith('/knowledge/bases/kb-a/search')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        ok: true,
        data: {
          results: [
            {
              id: 'r1',
              knowledgeBaseId: 'kb-a',
              fileId: 'f1',
              fileName: 'doc-a.md',
              title: 'AI 前沿 · doc-a.md',
              snippet: 'hello knowledge',
              score: 0.98,
              chunkOffset: 0,
              content: 'hello knowledge',
            },
            {
              id: 'r2',
              knowledgeBaseId: 'kb-a',
              fileId: 'f2',
              fileName: 'doc-b.md',
              title: 'AI 前沿 · doc-b.md',
              snippet: 'second result',
              score: 0.52,
              chunkOffset: 1,
              content: 'second result',
            },
          ],
        },
      }));
      return;
    }
    if (req.url.endsWith('/knowledge/bases/kb-empty/search')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        ok: true,
        data: {
          results: [],
        },
      }));
      return;
    }
    if (req.url.endsWith('/knowledge/bases/kb-error/search')) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        ok: false,
        error: 'knowledge api unavailable',
      }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not determine test server address');
    }
    const { stdout, stderr } = await runScript(
      ['hello', 'kb-a', 'kb-empty', 'kb-error'],
      {
        KNOWLEDGE_API_BASE_URL: `http://127.0.0.1:${address.port}/api/local/v1`,
      },
    );

    assert.equal(stderr, '');
    assert.match(stdout, /=== Knowledge Base: kb-a ===/);
    assert.match(stdout, /- Title: AI 前沿 · doc-a\.md/);
    assert.match(stdout, /File: doc-a\.md/);
    assert.match(stdout, /Score: 0.98/);
    assert.match(stdout, /Snippet: hello knowledge/);
    assert.match(stdout, /- Title: AI 前沿 · doc-b\.md/);
    assert.match(stdout, /=== Knowledge Base: kb-empty ===/);
    assert.match(stdout, /No results/);
    assert.match(stdout, /=== Knowledge Base: kb-error ===/);
    assert.match(stdout, /Error:/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
