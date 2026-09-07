import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNoopKnowledgePlugin,
  NoopKnowledgeProvider,
  NoopThreadKnowledgeAttachmentStore,
  defaultKnowledgeConfig,
} from '../src/index.js';

test('noop knowledge provider returns safe defaults without throwing for queries', async () => {
  const provider = new NoopKnowledgeProvider();
  assert.deepEqual(await provider.listSources(), []);
  assert.deepEqual(await provider.listFolders(), []);
  assert.deepEqual(await provider.listKnowledgeBases(), []);
  assert.deepEqual(await provider.listKnowledgeBaseFiles('kb-1'), []);
  assert.deepEqual(await provider.searchKnowledgeBase('kb-1', { query: 'test' }), []);

  const config = await provider.getConfig();
  assert.equal(config.baseUrl, '');
  assert.equal(config.authMode, 'none');

  const updatedConfig = await provider.updateConfig();
  assert.deepEqual(updatedConfig, defaultKnowledgeConfig());

  await assert.rejects(
    async () => provider.getKnowledgeBase('kb-1'),
    /Knowledge provider is unavailable/,
  );
});

test('noop thread knowledge attachment store returns safe empty arrays', async () => {
  const store = new NoopThreadKnowledgeAttachmentStore();
  assert.deepEqual(await store.listThreadKnowledgeBaseIds(), []);
  assert.deepEqual(await store.updateThreadKnowledgeBaseIds(), []);
  assert.deepEqual(await store.deleteThreadKnowledgeBaseLinks(), { deleted: true });
});

test('createNoopKnowledgePlugin creates disabled capability and runtime', async () => {
  const plugin = createNoopKnowledgePlugin();
  assert.equal(plugin.manifest.id, 'knowledge.noop');
  assert.equal(plugin.capabilities?.knowledge?.[0]?.enabled, false);
  assert.equal(plugin.capabilities?.knowledge?.[0]?.sourceType, 'noop');

  const runtime = await plugin.createRuntime?.({} as any);
  assert.ok(runtime);
  assert.ok('provider' in runtime && runtime.provider);
  assert.ok('attachments' in runtime && runtime.attachments);
  assert.deepEqual(plugin.healthCheck?.(), { status: 'healthy' });
});
