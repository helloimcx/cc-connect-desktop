import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import type { DesktopConnectConfig } from '../shared/desktop.js';
import { ServiceManager } from './service-manager.js';

function withTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstation-service-manager-'));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function withTempHome() {
  const previousHome = process.env.HOME;
  const temp = withTempDir();
  process.env.HOME = temp.dir;
  return {
    dir: temp.dir,
    cleanup() {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      temp.cleanup();
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
  const home = withTempHome();
  try {
    const manager = new ServiceManager(temp.dir);
    const workDir = join(temp.dir, 'runtime', 'project-alpha');
    const customSkillPath = join(workDir, '.agents', 'skills', 'custom-tool', 'SKILL.md');
    mkdirSync(join(workDir, '.agents', 'skills', 'custom-tool'), { recursive: true });
    writeFileSync(customSkillPath, 'custom skill', 'utf8');
    const saved = await manager.writeStructuredConfig(buildConfig('project-alpha'));
    const sharedSkillDir = join(home.dir, '.ai-workstation', 'skills', 'knowledge-base');
    const sharedSkillPath = join(sharedSkillDir, 'SKILL.md');
    const sharedScriptPath = join(sharedSkillDir, 'scripts', 'search-knowledge.sh');
    const agentSkillPath = join(workDir, '.agents', 'skills', 'knowledge-base');
    const claudeSkillPath = join(workDir, '.claude', 'skills', 'knowledge-base');

    assert.deepEqual(saved.warnings || [], []);
    assert.equal(existsSync(sharedSkillPath), true);
    assert.equal(existsSync(sharedScriptPath), true);
    accessSync(sharedScriptPath, constants.X_OK);
    assert.equal(lstatSync(agentSkillPath).isSymbolicLink(), true);
    assert.equal(lstatSync(claudeSkillPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(agentSkillPath), sharedSkillDir);
    assert.equal(readlinkSync(claudeSkillPath), sharedSkillDir);
    assert.match(readFileSync(sharedSkillPath, 'utf8'), /Selected Knowledge Bases/);
    assert.match(readFileSync(sharedScriptPath, 'utf8'), /knowledge\/bases\/\$KB_ID\/search/);
    assert.equal(readFileSync(customSkillPath, 'utf8'), 'custom skill');
  } finally {
    home.cleanup();
    temp.cleanup();
  }
});

test('writeStructuredConfig backs up old workspace skill directories before linking shared skills', async () => {
  const temp = withTempDir();
  const home = withTempHome();
  try {
    const manager = new ServiceManager(temp.dir);
    const workDir = join(temp.dir, 'runtime', 'project-alpha');
    const oldAgentSkillDir = join(workDir, '.agents', 'skills', 'knowledge-base');
    const oldClaudeSkillDir = join(workDir, '.claude', 'skills', 'knowledge-base');
    mkdirSync(oldAgentSkillDir, { recursive: true });
    mkdirSync(oldClaudeSkillDir, { recursive: true });
    writeFileSync(join(oldAgentSkillDir, 'SKILL.md'), 'legacy agent skill', 'utf8');
    writeFileSync(join(oldClaudeSkillDir, 'SKILL.md'), 'legacy claude skill', 'utf8');

    const saved = await manager.writeStructuredConfig(buildConfig('project-alpha'));
    const sharedSkillDir = join(home.dir, '.ai-workstation', 'skills', 'knowledge-base');

    assert.deepEqual(saved.warnings || [], []);
    assert.equal(existsSync(`${oldAgentSkillDir}.bak`), true);
    assert.equal(existsSync(`${oldClaudeSkillDir}.bak`), true);
    assert.match(readFileSync(join(`${oldAgentSkillDir}.bak`, 'SKILL.md'), 'utf8'), /legacy agent skill/);
    assert.match(readFileSync(join(`${oldClaudeSkillDir}.bak`, 'SKILL.md'), 'utf8'), /legacy claude skill/);
    assert.equal(lstatSync(oldAgentSkillDir).isSymbolicLink(), true);
    assert.equal(lstatSync(oldClaudeSkillDir).isSymbolicLink(), true);
    assert.equal(readlinkSync(oldAgentSkillDir), sharedSkillDir);
    assert.equal(readlinkSync(oldClaudeSkillDir), sharedSkillDir);
  } finally {
    home.cleanup();
    temp.cleanup();
  }
});

test('writeStructuredConfig returns warnings when the shared skill directory cannot be created', async () => {
  const temp = withTempDir();
  const home = withTempHome();
  try {
    const manager = new ServiceManager(temp.dir);
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(join(home.dir, '.ai-workstation'), 'not-a-directory', 'utf8');

    const saved = await manager.writeStructuredConfig(buildConfig('project-alpha'));

    assert.equal(Array.isArray(saved.warnings), true);
    assert.equal((saved.warnings || []).length, 1);
    assert.match(saved.warnings?.[0] || '', /Managed bundled skill "knowledge-base" was not written to shared directory/);
  } finally {
    home.cleanup();
    temp.cleanup();
  }
});

test('writeStructuredConfig returns warnings when a workspace skill link cannot be created', async () => {
  const temp = withTempDir();
  const home = withTempHome();
  try {
    const manager = new ServiceManager(temp.dir);
    const blockedPath = join(temp.dir, 'runtime', 'blocked');
    mkdirSync(join(temp.dir, 'runtime'), { recursive: true });
    writeFileSync(blockedPath, 'not-a-directory', 'utf8');

    const saved = await manager.writeStructuredConfig(buildConfig('blocked/subdir'));

    assert.equal(Array.isArray(saved.warnings), true);
    assert.equal((saved.warnings || []).length, 1);
    assert.match(saved.warnings?.[0] || '', /Managed bundled skill "knowledge-base" was not linked for project/);
    assert.equal(existsSync(saved.path), true);
  } finally {
    home.cleanup();
    temp.cleanup();
  }
});
