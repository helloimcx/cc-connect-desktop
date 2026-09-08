import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCoreAcpStore } from '../../services/local-ai-core/src/acp/local-core-acp-store.js';
import { parseLocalAiCoreRoute } from '../../services/local-ai-core/src/runtime/server-routes.js';
import { bootstrapLocalCoreRuntime } from '../../services/local-ai-core/src/kernel/bootstrap.js';
import { LocalCoreController } from '../../services/local-ai-core/src/runtime/local-core-controller.js';

test('runtime config ignores legacy config.toml and stays sqlite-only', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-runtime-config-'));
  try {
    const runtimeDir = join(userDataPath, 'runtime');
    const legacyPath = join(runtimeDir, 'config.toml');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(legacyPath, `
[[projects]]
name = "legacy-workspace"

[projects.agent]
type = "pi"

[projects.agent.options]
work_dir = "relative-workspace"
`, 'utf8');

    const store = new LocalCoreAcpStore(userDataPath);
    const config = store.readRuntimeConfig();

    assert.equal(config.storage, 'sqlite');
    assert.equal(config.databasePath, join(runtimeDir, 'local-core.db'));
    assert.equal(config.baseDir, runtimeDir);
    assert.equal(config.config.config_version, 2);
    assert.deepEqual(config.config.projects, []);
    assert.equal(existsSync(legacyPath), true);
    store.close();

    const reopened = new LocalCoreAcpStore(userDataPath);
    const persisted = reopened.readRuntimeConfig();
    assert.deepEqual(persisted.config.projects, []);
    reopened.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('runtime config ignores legacy settings configPath and malformed toml', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-runtime-config-'));
  try {
    const runtimeDir = join(userDataPath, 'runtime');
    const legacyPath = join(runtimeDir, 'config.toml');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'local-core-settings.json'), JSON.stringify({
      configPath: join(userDataPath, 'custom-config', 'agentdock.toml'),
      defaultProject: '',
      autoStartService: true,
      plugins: {},
    }), 'utf8');
    writeFileSync(legacyPath, '[[projects]\nname = "broken"\n', 'utf8');

    const store = new LocalCoreAcpStore(userDataPath);
    const config = store.readRuntimeConfig();
    assert.equal(config.error, undefined);
    assert.deepEqual(config.config.projects, []);
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('runtime config defaults to an empty sqlite-backed desktop config', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-runtime-config-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    const config = store.readRuntimeConfig();
    assert.deepEqual(config.config.projects, []);
    assert.equal(config.config.config_version, 2);
    assert.equal(existsSync(join(userDataPath, 'runtime', 'config.toml')), false);
    store.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('runtime config save persists structured config across store reopen', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-runtime-config-'));
  try {
    const store = new LocalCoreAcpStore(userDataPath);
    store.saveRuntimeConfig({
      projects: [{
        name: 'sqlite-workspace',
        agent: {
          type: 'pi',
          options: { work_dir: '/tmp/sqlite-workspace' },
        },
        platforms: [],
      }],
      sandbox_providers: [{
        id: 'opensandbox-default',
        type: 'opensandbox',
        name: 'OpenSandbox',
        server_url: 'http://127.0.0.1:8080',
        api_key_env: 'OPEN_SANDBOX_API_KEY',
      }],
    });
    store.close();

    const reopened = new LocalCoreAcpStore(userDataPath);
    const config = reopened.readRuntimeConfig();
    assert.equal(config.config.projects?.[0]?.name, 'sqlite-workspace');
    assert.equal(config.config.sandbox_providers?.[0]?.id, 'opensandbox-default');
    reopened.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('runtime config routes expose sqlite config and reject raw toml save route', () => {
  assert.deepEqual(parseLocalAiCoreRoute('GET', '/api/local/v1/runtime/runtime-config'), {
    name: 'runtime.runtime-config.read',
  });
  assert.deepEqual(parseLocalAiCoreRoute('POST', '/api/local/v1/runtime/runtime-config'), {
    name: 'runtime.runtime-config.save',
  });
  assert.deepEqual(parseLocalAiCoreRoute('GET', '/api/local/v1/runtime/config'), {
    name: 'runtime.runtime-config.read',
  });
  assert.equal(parseLocalAiCoreRoute('POST', '/api/local/v1/runtime/config/raw'), null);
  assert.equal(parseLocalAiCoreRoute('POST', '/api/local/v1/runtime/config/structured'), null);
});

test('runtime config save stores the full config with projects in SQLite and reads it back', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentdock-runtime-config-'));
  try {
    const runtimeDir = join(userDataPath, 'runtime');
    const legacyPath = join(runtimeDir, 'config.toml');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(legacyPath, `
[[projects]]
name = "Obsidian-Personal"

[projects.agent]
type = "hermes"

[projects.agent.options]
provider_id = "deepseek"
`, 'utf8');

    const runtime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    const controller = new LocalCoreController(userDataPath, runtime);
    const initialConfig = await controller.readRuntimeConfig();
    // The legacy config.toml is never imported: SQLite starts empty.
    assert.deepEqual(initialConfig.config.projects, []);

    await controller.saveRuntimeConfig({
      config_version: 2,
      projects: [{
        name: 'Obsidian-Personal',
        platforms: [],
        agent: {
          type: 'hermes',
          options: { provider_id: 'opencode-go' },
        },
      }],
    });
    await runtime.stop();

    const reopenedRuntime = bootstrapLocalCoreRuntime({
      userDataPath,
    });
    const storeConfig = reopenedRuntime.store.readRuntimeConfig();
    assert.equal(storeConfig.storage, 'sqlite');
    assert.equal(storeConfig.config.projects?.[0]?.name, 'Obsidian-Personal');
    assert.equal(storeConfig.config.projects?.[0]?.agent?.options?.provider_id, 'opencode-go');

    const reopenedController = new LocalCoreController(userDataPath, reopenedRuntime);
    const readBack = await reopenedController.readRuntimeConfig();
    assert.equal(readBack.config.projects?.[0]?.agent?.options?.provider_id, 'opencode-go');
    await reopenedRuntime.stop();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
