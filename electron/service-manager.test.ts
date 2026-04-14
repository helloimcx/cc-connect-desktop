import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import type { DesktopConnectConfig } from '../shared/desktop.js';
import { ServiceManager } from './service-manager.js';

function withTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-connect-service-manager-'));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function buildConfig(workDir: string): DesktopConnectConfig {
  return {
    projects: [
      {
        name: 'workspace-a',
        agent: {
          type: 'codex',
          options: {
            work_dir: workDir,
          },
        },
        platforms: [],
      },
    ],
  };
}

test('writeStructuredConfig generates the bundled knowledge skill files', async () => {
  const temp = withTempDir();
  try {
    const manager = new ServiceManager(temp.dir);
    const saved = await manager.writeStructuredConfig(buildConfig('project-alpha'));
    const workDir = join(temp.dir, 'runtime', 'project-alpha');
    const skillPath = join(workDir, '.agents', 'skills', 'knowledge-base', 'SKILL.md');
    const scriptPath = join(workDir, '.agents', 'skills', 'knowledge-base', 'scripts', 'search-knowledge.sh');

    assert.deepEqual(saved.warnings || [], []);
    assert.equal(existsSync(skillPath), true);
    assert.equal(existsSync(scriptPath), true);
    accessSync(scriptPath, constants.X_OK);
    assert.match(readFileSync(skillPath, 'utf8'), /Selected Knowledge Bases/);
    assert.match(readFileSync(scriptPath, 'utf8'), /knowledge\/bases\/\$KB_ID\/search/);
  } finally {
    temp.cleanup();
  }
});

test('writeStructuredConfig returns warnings when a knowledge skill directory cannot be created', async () => {
  const temp = withTempDir();
  try {
    const manager = new ServiceManager(temp.dir);
    const blockedPath = join(temp.dir, 'runtime', 'blocked');
    mkdirSync(join(temp.dir, 'runtime'), { recursive: true });
    writeFileSync(blockedPath, 'not-a-directory', 'utf8');

    const saved = await manager.writeStructuredConfig(buildConfig('blocked/subdir'));

    assert.equal(Array.isArray(saved.warnings), true);
    assert.equal((saved.warnings || []).length, 1);
    assert.match(saved.warnings?.[0] || '', /Knowledge skill was not written/);
    assert.equal(existsSync(saved.path), true);
  } finally {
    temp.cleanup();
  }
});
