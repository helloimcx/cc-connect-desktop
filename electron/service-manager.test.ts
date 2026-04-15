import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
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

function withFakeNpm() {
  const previousPath = process.env.PATH;
  const temp = withTempDir();
  const npmPath = join(temp.dir, 'npm');
  writeFileSync(
    npmPath,
    `#!/bin/sh
set -eu

if [ "$#" -ge 1 ] && [ "$1" = "--version" ]; then
  echo "10.0.0"
  exit 0
fi

if [ "$#" -ge 1 ] && [ "$1" = "install" ]; then
  mkdir -p "$PWD/node_modules/.bin"
  cat > "$PWD/node_modules/.bin/agent-browser" <<'EOF'
#!/bin/sh
set -eu
if [ "$#" -ge 1 ] && [ "$1" = "install" ]; then
  exit 0
fi
echo "agent-browser $@"
EOF
  chmod +x "$PWD/node_modules/.bin/agent-browser"
  exit 0
fi

echo "unsupported npm invocation: $*" >&2
exit 1
`,
    'utf8',
  );
  chmodSync(npmPath, 0o755);
  process.env.PATH = `${temp.dir}:${previousPath || ''}`;
  return {
    cleanup() {
      process.env.PATH = previousPath;
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
  const fakeNpm = withFakeNpm();
  try {
    const manager = new ServiceManager(temp.dir);
    const workDir = join(temp.dir, 'runtime', 'project-alpha');
    const customSkillPath = join(workDir, '.agents', 'skills', 'custom-tool', 'SKILL.md');
    mkdirSync(join(workDir, '.agents', 'skills', 'custom-tool'), { recursive: true });
    writeFileSync(customSkillPath, 'custom skill', 'utf8');
    const saved = await manager.writeStructuredConfig(buildConfig('project-alpha'));
    const knowledgePackageDir = join(home.dir, '.ai-workstation', 'skills', 'packages', 'knowledge-base', '1.0.0');
    const knowledgeActiveDir = join(home.dir, '.ai-workstation', 'skills', 'active', 'knowledge-base');
    const browserPackageDir = join(home.dir, '.ai-workstation', 'skills', 'packages', 'agent-browser', '0.25.4');
    const browserActiveDir = join(home.dir, '.ai-workstation', 'skills', 'active', 'agent-browser');
    const knowledgeSkillPath = join(knowledgePackageDir, 'SKILL.md');
    const knowledgeScriptPath = join(knowledgePackageDir, 'scripts', 'search-knowledge.sh');
    const browserSkillPath = join(browserPackageDir, 'SKILL.md');
    const browserWrapperPath = join(browserPackageDir, 'scripts', 'agent-browser.sh');
    const agentKnowledgeLinkPath = join(workDir, '.agents', 'skills', 'knowledge-base');
    const claudeKnowledgeLinkPath = join(workDir, '.claude', 'skills', 'knowledge-base');
    const agentBrowserLinkPath = join(workDir, '.agents', 'skills', 'agent-browser');
    const claudeBrowserLinkPath = join(workDir, '.claude', 'skills', 'agent-browser');
    const managedToolWrapper = join(home.dir, '.ai-workstation', 'tools', 'agent-browser', '0.25.4', 'bin', 'agent-browser');
    const managedToolCurrent = join(home.dir, '.ai-workstation', 'tools', 'agent-browser', 'current');
    const managedStatePath = join(home.dir, '.ai-workstation', 'state', 'managed-skills.json');

    assert.deepEqual(saved.warnings || [], []);
    assert.equal(existsSync(knowledgeSkillPath), true);
    assert.equal(existsSync(knowledgeScriptPath), true);
    assert.equal(existsSync(browserSkillPath), true);
    assert.equal(existsSync(browserWrapperPath), true);
    accessSync(knowledgeScriptPath, constants.X_OK);
    accessSync(browserWrapperPath, constants.X_OK);
    accessSync(managedToolWrapper, constants.X_OK);
    assert.equal(lstatSync(knowledgeActiveDir).isSymbolicLink(), true);
    assert.equal(lstatSync(browserActiveDir).isSymbolicLink(), true);
    assert.equal(readlinkSync(knowledgeActiveDir), knowledgePackageDir);
    assert.equal(readlinkSync(browserActiveDir), browserPackageDir);
    assert.equal(lstatSync(agentKnowledgeLinkPath).isSymbolicLink(), true);
    assert.equal(lstatSync(claudeKnowledgeLinkPath).isSymbolicLink(), true);
    assert.equal(lstatSync(agentBrowserLinkPath).isSymbolicLink(), true);
    assert.equal(lstatSync(claudeBrowserLinkPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(agentKnowledgeLinkPath), knowledgeActiveDir);
    assert.equal(readlinkSync(claudeKnowledgeLinkPath), knowledgeActiveDir);
    assert.equal(readlinkSync(agentBrowserLinkPath), browserActiveDir);
    assert.equal(readlinkSync(claudeBrowserLinkPath), browserActiveDir);
    assert.equal(readlinkSync(managedToolCurrent), join(home.dir, '.ai-workstation', 'tools', 'agent-browser', '0.25.4'));
    assert.match(readFileSync(knowledgeSkillPath, 'utf8'), /Selected Knowledge Bases/);
    assert.match(readFileSync(knowledgeScriptPath, 'utf8'), /knowledge\/bases\/\$KB_ID\/search/);
    assert.match(readFileSync(browserSkillPath, 'utf8'), /browser or Electron UI automation/);
    assert.match(readFileSync(browserWrapperPath, 'utf8'), /tools\/agent-browser\/current\/bin\/agent-browser/);
    assert.match(readFileSync(managedStatePath, 'utf8'), /"agent-browser"/);
    assert.equal(readFileSync(customSkillPath, 'utf8'), 'custom skill');
  } finally {
    fakeNpm.cleanup();
    home.cleanup();
    temp.cleanup();
  }
});

test('writeStructuredConfig backs up old workspace skill directories before linking shared skills', async () => {
  const temp = withTempDir();
  const home = withTempHome();
  const fakeNpm = withFakeNpm();
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
    const sharedSkillDir = join(home.dir, '.ai-workstation', 'skills', 'active', 'knowledge-base');

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
    fakeNpm.cleanup();
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
    assert.equal((saved.warnings || []).length, 2);
    assert.match(saved.warnings?.[0] || '', /Managed bundled skill "knowledge-base" was not installed from/);
    assert.match(saved.warnings?.[1] || '', /Managed bundled skill "agent-browser" was not installed from/);
  } finally {
    home.cleanup();
    temp.cleanup();
  }
});

test('writeStructuredConfig returns warnings when a workspace skill link cannot be created', async () => {
  const temp = withTempDir();
  const home = withTempHome();
  const fakeNpm = withFakeNpm();
  try {
    const manager = new ServiceManager(temp.dir);
    const blockedPath = join(temp.dir, 'runtime', 'blocked');
    mkdirSync(join(temp.dir, 'runtime'), { recursive: true });
    writeFileSync(blockedPath, 'not-a-directory', 'utf8');

    const saved = await manager.writeStructuredConfig(buildConfig('blocked/subdir'));

    assert.equal(Array.isArray(saved.warnings), true);
    assert.equal((saved.warnings || []).length, 2);
    assert.match(saved.warnings?.[0] || '', /Managed bundled skill "knowledge-base" was not linked for project/);
    assert.match(saved.warnings?.[1] || '', /Managed bundled skill "agent-browser" was not linked for project/);
    assert.equal(existsSync(saved.path), true);
  } finally {
    fakeNpm.cleanup();
    home.cleanup();
    temp.cleanup();
  }
});
