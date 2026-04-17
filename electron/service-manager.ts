import { EventEmitter } from 'node:events';
import {
  accessSync,
  chmodSync,
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { DEFAULT_DESKTOP_AGENT_TYPE, LOCALCORE_ACP_AGENT_TYPE, normalizeDesktopAgentModel } from '../shared/desktop.js';
import type {
  ConfigFileState,
  DesktopConnectConfig,
  DesktopRuntimeStatus,
  DesktopServiceState,
  DesktopSettings,
  DesktopSettingsInput,
} from '../shared/desktop.js';
import * as TOML from '@iarna/toml';

const DEFAULT_PROJECT_NAME = 'desktop-demo';
const MANAGEMENT_READY_TIMEOUT_MS = 20000;
const MANAGEMENT_READY_POLL_MS = 300;
const STOP_TIMEOUT_MS = 5000;
const AI_WORKSTATION_ROOT = '.ai-workstation';
const MANAGED_SKILLS_ROOT = join(AI_WORKSTATION_ROOT, 'skills');
const MANAGED_SKILLS_PACKAGES_DIR = join(MANAGED_SKILLS_ROOT, 'packages');
const MANAGED_SKILLS_ACTIVE_DIR = join(MANAGED_SKILLS_ROOT, 'active');
const MANAGED_STATE_PATH = join(AI_WORKSTATION_ROOT, 'state', 'managed-skills.json');
const AGENTS_SKILL_DIR = join('.agents', 'skills');
const CLAUDE_SKILL_DIR = join('.claude', 'skills');

type ManagedSkillMountTarget = 'agents' | 'claude';

interface ManagedSkillManifestEntry {
  id: string;
  version: string;
  sourceType: 'bundled';
  bundlePath: string;
  mountTargets: ManagedSkillMountTarget[];
  requiredPaths: string[];
  requiredCommand?: string;
  executablePaths: string[];
}

interface ManagedSkillStateRecord {
  version: string;
  installedAt?: string;
  activePath?: string;
  checkedAt?: string;
  status?: 'ready' | 'warning';
  lastError?: string;
  commandName?: string;
}

interface ManagedSkillsState {
  skills: Record<string, ManagedSkillStateRecord>;
}

const MANAGED_SKILLS: ManagedSkillManifestEntry[] = [
  {
    id: 'knowledge-base',
    version: '1.0.0',
    sourceType: 'bundled',
    bundlePath: resolve(process.cwd(), 'electron', 'managed-skills', 'knowledge-base'),
    mountTargets: ['agents', 'claude'],
    requiredPaths: ['SKILL.md', join('scripts', 'search-knowledge.sh')],
    executablePaths: [join('scripts', 'search-knowledge.sh')],
  },
  {
    id: 'agent-browser',
    version: '0.25.4',
    sourceType: 'bundled',
    bundlePath: resolve(process.cwd(), 'electron', 'managed-skills', 'agent-browser'),
    mountTargets: ['agents', 'claude'],
    requiredPaths: [
      'SKILL.md',
      join('references', 'commands.md'),
      join('templates', 'capture-workflow.sh'),
    ],
    requiredCommand: 'agent-browser',
    executablePaths: [
      join('templates', 'authenticated-session.sh'),
      join('templates', 'capture-workflow.sh'),
      join('templates', 'form-automation.sh'),
    ],
  },
];

const DEFAULT_CONFIG_TEMPLATE = `# Managed by AI-WorkStation
[log]
level = "info"

[management]
enabled = true
port = 9820
token = ""
cors_origins = ["null", "http://localhost:5173", "http://127.0.0.1:5173"]

[bridge]
enabled = true
port = 9810
token = ""
path = "/bridge/ws"

[[projects]]
name = "${DEFAULT_PROJECT_NAME}"

[projects.agent]
type = "${DEFAULT_DESKTOP_AGENT_TYPE}"
`;

const LOG_LIMIT = 400;

function randomToken() {
  return randomBytes(16).toString('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export class ServiceManager extends EventEmitter {
  private readonly settingsPath: string;
  private readonly generatedConfigPath: string;
  private readonly logs: string[] = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: DesktopServiceState = { status: 'stopped' };
  private settings: DesktopSettings;
  private startPromise: Promise<DesktopServiceState> | null = null;
  private stopping = false;
  private terminatingForStartupError = false;
  private appliedBinaryPath = '';
  private appliedConfigPath = '';
  private appliedConfigRaw = '';
  private appliedRuntimeConfigRaw = '';

  constructor(private readonly userDataPath: string) {
    super();
    const runtimeDir = join(userDataPath, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    this.settingsPath = join(runtimeDir, 'desktop-settings.json');
    this.generatedConfigPath = join(runtimeDir, 'generated-config.toml');
    this.settings = this.loadSettings();
  }

  getSettings() {
    return clone(this.settings);
  }

  updateSettings(input: DesktopSettingsInput) {
    const nextKnowledge = input.knowledge
      ? {
          ...this.settings.knowledge,
          ...input.knowledge,
        }
      : this.settings.knowledge;
    this.settings = {
      ...this.settings,
      ...input,
      knowledge: nextKnowledge,
    };
    this.persistSettings();
    this.emit('state');
    return this.getSettings();
  }

  getServiceState() {
    return clone(this.state);
  }

  getLogs(limit = 200) {
    return this.logs.slice(-Math.max(limit, 1));
  }

  getManagementBaseUrl() {
    return `http://127.0.0.1:${this.settings.managementPort}/api/v1`;
  }

  getGeneratedConfigPath() {
    return this.generatedConfigPath;
  }

  async readConfigState(): Promise<ConfigFileState> {
    const path = this.settings.configPath;
    if (!existsSync(path)) {
      return {
        path,
        exists: false,
        raw: '',
        parsed: null,
      };
    }

    const raw = readFileSync(path, 'utf8');
    try {
      const parsed = TOML.parse(raw) as DesktopConnectConfig;
      const normalized = this.normalizeLogicalConfig(parsed);
      const normalizedRaw = TOML.stringify(normalized as any);
      if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
        writeFileSync(path, normalizedRaw, 'utf8');
        return { path, exists: true, raw: normalizedRaw, parsed: normalized };
      }
      return { path, exists: true, raw, parsed: normalized };
    } catch (error) {
      return {
        path,
        exists: true,
        raw,
        parsed: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async writeRawConfig(raw: string) {
    mkdirSync(dirname(this.settings.configPath), { recursive: true });
    writeFileSync(this.settings.configPath, raw, 'utf8');
    this.emit('state');
    return this.readConfigState();
  }

  async writeStructuredConfig(config: DesktopConnectConfig) {
    mkdirSync(dirname(this.settings.configPath), { recursive: true });
    const normalized = this.normalizeLogicalConfig(config);
    writeFileSync(this.settings.configPath, TOML.stringify(normalized as any), 'utf8');
    const warnings = this.syncManagedSkills(normalized);
    this.emit('state');
    const nextState = await this.readConfigState();
    return warnings.length > 0 ? { ...nextState, warnings } : nextState;
  }

  async ensureConfigFile() {
    if (existsSync(this.settings.configPath)) {
      return this.readConfigState();
    }
    mkdirSync(dirname(this.settings.configPath), { recursive: true });
    writeFileSync(this.settings.configPath, DEFAULT_CONFIG_TEMPLATE, 'utf8');
    return this.readConfigState();
  }

  private syncManagedSkills(config: DesktopConnectConfig) {
    const projects = Array.isArray(config.projects) ? config.projects : [];
    const configDir = dirname(this.settings.configPath);
    const warnings: string[] = [];
    const state = this.loadManagedSkillsState();

    for (const skill of MANAGED_SKILLS) {
      try {
        warnings.push(...this.ensureManagedSkillInstalled(skill, state));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(
          `Managed bundled skill "${skill.id}" was not installed from ${skill.bundlePath}: ${detail}`,
        );
        state.skills[skill.id] = {
          version: skill.version,
          installedAt: state.skills[skill.id]?.installedAt,
          activePath: state.skills[skill.id]?.activePath,
          checkedAt: new Date().toISOString(),
          status: 'warning',
          lastError: detail,
          commandName: skill.requiredCommand,
        };
      }
    }

    projects.forEach((project) => {
      const projectName = String(project.name || '').trim() || 'unnamed-project';
      const rawWorkDir = String(project.agent?.options?.work_dir || '.').trim() || '.';
      const workDir = isAbsolute(rawWorkDir) ? rawWorkDir : resolve(configDir, rawWorkDir);
      for (const skill of MANAGED_SKILLS) {
        try {
          const activeSkillDir = this.getManagedSkillActivePath(skill.id);
          if (!this.pathExists(activeSkillDir)) {
            continue;
          }
          for (const mountTarget of skill.mountTargets) {
            this.ensureWorkspaceSkillLink(workDir, this.resolveSkillMountRoot(mountTarget), skill.id, activeSkillDir);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          warnings.push(
            `Managed bundled skill "${skill.id}" was not linked for project "${projectName}" at ${workDir}: ${detail}`,
          );
        }
      }
    });

    try {
      this.saveManagedSkillsState(state);
    } catch (error) {
      this.pushLog(`Failed to write managed skills state: ${error instanceof Error ? error.message : String(error)}`);
    }
    return warnings;
  }

  private ensureManagedSkillInstalled(skill: ManagedSkillManifestEntry, state: ManagedSkillsState) {
    this.ensureBundledSkillPackage(skill);
    const packagePath = this.getManagedSkillPackagePath(skill.id, skill.version);
    const activePath = this.getManagedSkillActivePath(skill.id);
    mkdirSync(dirname(activePath), { recursive: true });
    this.replaceWithSymlink(activePath, packagePath);
    const validationError = this.validateManagedSkill(skill, packagePath, activePath);

    state.skills[skill.id] = {
      version: skill.version,
      installedAt: new Date().toISOString(),
      activePath,
      checkedAt: new Date().toISOString(),
      status: validationError ? 'warning' : 'ready',
      lastError: validationError,
      commandName: skill.requiredCommand,
    };
    return validationError ? [validationError] : [];
  }

  private ensureBundledSkillPackage(skill: ManagedSkillManifestEntry) {
    if (!this.pathExists(skill.bundlePath)) {
      throw new Error(`bundle path does not exist: ${skill.bundlePath}`);
    }
    const packagePath = this.getManagedSkillPackagePath(skill.id, skill.version);
    rmSync(packagePath, { recursive: true, force: true });
    mkdirSync(dirname(packagePath), { recursive: true });
    this.copyDirectory(skill.bundlePath, packagePath);
    for (const relativePath of skill.executablePaths) {
      const executablePath = join(packagePath, relativePath);
      if (this.pathExists(executablePath)) {
        chmodSync(executablePath, 0o755);
      }
    }
  }

  private ensureWorkspaceSkillLink(workDir: string, skillRoot: string, skillName: string, targetPath: string) {
    const linkPath = join(workDir, skillRoot, skillName);
    mkdirSync(dirname(linkPath), { recursive: true });
    this.replaceWithSymlink(linkPath, targetPath, true);
  }

  private validateManagedSkill(skill: ManagedSkillManifestEntry, packagePath: string, activePath: string) {
    for (const relativePath of skill.requiredPaths) {
      const requiredPath = join(packagePath, relativePath);
      if (!this.pathExists(requiredPath)) {
        const message = `Managed bundled skill "${skill.id}" is missing required file ${requiredPath}.`;
        this.pushLog(message);
        return message;
      }
    }
    if (!this.isSymlinkTo(activePath, packagePath)) {
      const message = `Managed bundled skill "${skill.id}" active link is invalid: ${activePath}.`;
      this.pushLog(message);
      return message;
    }
    if (skill.requiredCommand) {
      const probe = spawnSync(skill.requiredCommand, ['--version'], { encoding: 'utf8' });
      if (probe.status !== 0) {
        const detail = String(probe.stderr || probe.stdout || 'command not available').trim();
        const message = `Managed bundled skill "${skill.id}" requires command "${skill.requiredCommand}", but it is not available: ${detail}.`;
        this.pushLog(message);
        return message;
      }
    }
    this.pushLog(`Managed bundled skill "${skill.id}" is ready at ${packagePath}`);
    return '';
  }

  private resolveSkillMountRoot(target: ManagedSkillMountTarget) {
    return target === 'agents' ? AGENTS_SKILL_DIR : CLAUDE_SKILL_DIR;
  }

  private getManagedSkillsRoot() {
    return join(homedir(), MANAGED_SKILLS_ROOT);
  }

  private getManagedSkillPackagePath(skillId: string, version: string) {
    return join(homedir(), MANAGED_SKILLS_PACKAGES_DIR, skillId, version);
  }

  private getManagedSkillActivePath(skillId: string) {
    return join(homedir(), MANAGED_SKILLS_ACTIVE_DIR, skillId);
  }

  private getManagedStatePath() {
    return join(homedir(), MANAGED_STATE_PATH);
  }

  private copyDirectory(sourcePath: string, targetPath: string) {
    const sourceStat = statSync(sourcePath);
    if (!sourceStat.isDirectory()) {
      throw new Error(`bundle path is not a directory: ${sourcePath}`);
    }
    mkdirSync(targetPath, { recursive: true });
    for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
      const sourceEntryPath = join(sourcePath, entry.name);
      const targetEntryPath = join(targetPath, entry.name);
      if (entry.isDirectory()) {
        this.copyDirectory(sourceEntryPath, targetEntryPath);
      } else if (entry.isFile()) {
        mkdirSync(dirname(targetEntryPath), { recursive: true });
        copyFileSync(sourceEntryPath, targetEntryPath);
      }
    }
  }

  private loadManagedSkillsState(): ManagedSkillsState {
    const path = this.getManagedStatePath();
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ManagedSkillsState>;
      return {
        skills: raw.skills && typeof raw.skills === 'object' ? raw.skills as ManagedSkillsState['skills'] : {},
      };
    } catch {
      return { skills: {} };
    }
  }

  private saveManagedSkillsState(state: ManagedSkillsState) {
    const path = this.getManagedStatePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
  }

  private replaceWithSymlink(linkPath: string, targetPath: string, backupExisting = false) {
    if (this.isSymlinkTo(linkPath, targetPath)) {
      return;
    }
    if (this.pathExists(linkPath)) {
      if (backupExisting) {
        this.backupExistingPath(linkPath);
      } else {
        rmSync(linkPath, { recursive: true, force: true });
      }
    }
    symlinkSync(targetPath, linkPath, 'dir');
  }

  private isSymlinkTo(linkPath: string, targetPath: string) {
    try {
      const stat = lstatSync(linkPath);
      if (!stat.isSymbolicLink()) {
        return false;
      }
      return resolve(dirname(linkPath), readlinkSync(linkPath)) === resolve(targetPath);
    } catch {
      return false;
    }
  }

  private pathExists(path: string) {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  }

  private backupExistingPath(path: string) {
    const backupPath = this.nextBackupPath(path);
    renameSync(path, backupPath);
  }

  private nextBackupPath(path: string) {
    let index = 0;
    while (true) {
      const candidate = `${path}.bak${index === 0 ? '' : `-${index}`}`;
      if (!this.pathExists(candidate)) {
        return candidate;
      }
      index += 1;
    }
  }

  async start() {
    if (this.child && (this.stopping || this.state.status === 'starting' || this.state.status === 'running')) {
      return this.getServiceState();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart() {
    await this.ensureConfigFile();
    await this.ensureAvailablePorts();
    const configState = await this.readConfigState();
    if (!configState.parsed) {
      this.state = {
        status: 'error',
        lastError: configState.error || 'Config file is invalid TOML',
      };
      this.emit('state');
      return this.getServiceState();
    }

    const runtimeConfig = this.deriveRuntimeConfig(configState.parsed);
    const runtimeConfigRaw = TOML.stringify(runtimeConfig as any);
    mkdirSync(dirname(this.generatedConfigPath), { recursive: true });
    writeFileSync(this.generatedConfigPath, runtimeConfigRaw, 'utf8');

    const binaryPath = this.resolveBinaryPath();
    this.pushLog(`Starting cc-connect using ${binaryPath}`);
    this.state = { status: 'starting' };
    this.emit('state');

    try {
      const startedAt = new Date().toISOString();
      const child = spawn(binaryPath, ['--config', this.generatedConfigPath], {
        env: process.env,
        stdio: 'pipe',
      });
      this.child = child;

      child.stdout.on('data', (chunk) => this.pushLog(String(chunk).trimEnd()));
      child.stderr.on('data', (chunk) => this.pushLog(String(chunk).trimEnd()));

      child.on('spawn', () => {
        if (this.child !== child) {
          return;
        }
        this.state = {
          status: 'starting',
          pid: child.pid,
          startedAt,
        };
        this.emit('state');
      });

      child.on('exit', (code, signal) => {
        if (this.child !== child) {
          return;
        }
        const stopping = this.stopping;
        const terminatingForStartupError = this.terminatingForStartupError;
        this.stopping = false;
        this.terminatingForStartupError = false;
        this.child = null;
        if (terminatingForStartupError) {
          this.emit('state');
          return;
        }
        this.state = stopping || code === 0 || signal === 'SIGTERM'
          ? { status: 'stopped' }
          : {
              status: 'error',
              lastError: `cc-connect exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`,
            };
        this.emit('state');
      });

      child.on('error', (error) => {
        if (this.child !== child) {
          return;
        }
        this.child = null;
        this.stopping = false;
        this.terminatingForStartupError = false;
        this.state = { status: 'error', lastError: error.message };
        this.pushLog(error.message);
        this.emit('state');
      });

      await this.waitForManagementReady();
      this.appliedBinaryPath = this.settings.binaryPath;
      this.appliedConfigPath = this.settings.configPath;
      this.appliedConfigRaw = configState.raw;
      this.appliedRuntimeConfigRaw = runtimeConfigRaw;
      this.state = {
        status: 'running',
        pid: child.pid,
        startedAt,
      };
      this.emit('state');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushLog(message);
      if (this.child) {
        this.terminatingForStartupError = true;
        this.child.kill('SIGTERM');
        this.child = null;
      }
      this.state = {
        status: 'error',
        lastError: message,
      };
      this.emit('state');
    }

    return this.getServiceState();
  }

  async stop() {
    if (!this.child) {
      this.state = { status: 'stopped' };
      this.emit('state');
      return this.getServiceState();
    }

    const child = this.child;
    this.stopping = true;
    try {
      child.kill('SIGTERM');
    } catch (error) {
      this.child = null;
      this.stopping = false;
      this.state = {
        status: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      };
      this.emit('state');
      return this.getServiceState();
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for cc-connect to stop'));
      }, STOP_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
      };

      const onExit = () => {
        cleanup();
        resolve();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      child.once('exit', onExit);
      child.once('error', onError);
    });

    return this.getServiceState();
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async getRuntimeStatus(): Promise<DesktopRuntimeStatus> {
    const configFile = await this.readConfigState();
    return {
      mode: 'desktop',
      phase: 'stopped',
      pendingRestart: this.computePendingRestart(configFile),
      service: this.getServiceState(),
      bridge: { status: 'disconnected' },
      settings: this.getSettings(),
      managementBaseUrl: this.getManagementBaseUrl(),
      configFile,
      logs: this.getLogs(),
    };
  }

  private withManagedSections(config: DesktopConnectConfig): DesktopConnectConfig {
    const next = clone(config);
    next.management = {
      ...(next.management || {}),
      enabled: true,
      port: this.settings.managementPort,
      token: this.settings.managementToken,
      cors_origins: ['null', 'http://localhost:5173', 'http://127.0.0.1:5173'],
    };
    next.bridge = {
      ...(next.bridge || {}),
      enabled: true,
      port: this.settings.bridgePort,
      token: this.settings.bridgeToken,
      path: this.settings.bridgePath,
    };
    return next;
  }

  private loadSettings(): DesktopSettings {
    const defaults = this.defaultSettings();
    if (!existsSync(this.settingsPath)) {
      writeFileSync(this.settingsPath, JSON.stringify(defaults, null, 2), 'utf8');
      return defaults;
    }
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<DesktopSettings>;
      const next = {
        ...defaults,
        ...raw,
        knowledge: {
          ...defaults.knowledge,
          ...(raw.knowledge || {}),
        },
      };
      let changed = false;

      if ((!raw.binaryPath || raw.binaryPath === 'cc-connect') && defaults.binaryPath !== 'cc-connect') {
        next.binaryPath = defaults.binaryPath;
        changed = true;
      }

      if (!raw.defaultProject && defaults.defaultProject) {
        next.defaultProject = defaults.defaultProject;
        changed = true;
      }

      if (changed) {
        writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), 'utf8');
      }

      return next;
    } catch {
      writeFileSync(this.settingsPath, JSON.stringify(defaults, null, 2), 'utf8');
      return defaults;
    }
  }

  private defaultSettings(): DesktopSettings {
    const runtimeDir = join(this.userDataPath, 'runtime');
    return {
      binaryPath: this.detectBinaryPath(),
      configPath: join(runtimeDir, 'config.toml'),
      autoStartService: false,
      defaultProject: DEFAULT_PROJECT_NAME,
      managementPort: 9820,
      managementToken: randomToken(),
      bridgePort: 9810,
      bridgeToken: randomToken(),
      bridgePath: '/bridge/ws',
      knowledge: {
        baseUrl: '',
        authMode: 'none',
        token: '',
        headerName: 'X-API-Key',
        defaultCollection: 'personal_knowledge',
      },
    };
  }

  private detectBinaryPath() {
    const envBinaryPath = process.env.CC_CONNECT_BIN;
    if (envBinaryPath && this.isExecutablePath(envBinaryPath)) {
      return envBinaryPath;
    }
    const probe = spawnSync('which', ['cc-connect'], { encoding: 'utf8' });
    if (probe.status === 0 && this.isExecutablePath(probe.stdout.trim())) {
      return probe.stdout.trim();
    }
    const candidates = [
      join(process.cwd(), 'cc-connect'),
      join(process.cwd(), '..', 'cc-connect', 'cc-connect'),
      join(process.cwd(), '..', 'github', 'cc-connect', 'cc-connect'),
      process.env.HOME ? join(process.env.HOME, 'code', 'github', 'cc-connect', 'cc-connect') : '',
    ];
    const match = candidates.find((candidate) => this.isExecutablePath(candidate));
    if (match) {
      return match;
    }
    return 'cc-connect';
  }

  private resolveBinaryPath() {
    return this.settings.binaryPath || 'cc-connect';
  }

  private deriveRuntimeConfig(config: DesktopConnectConfig): DesktopConnectConfig {
    const next = this.withManagedSections(this.normalizeLogicalConfig(config));
    if (!Array.isArray(next.projects)) {
      return next;
    }

    next.projects = next.projects.flatMap((project) => {
      if (project?.agent) {
        const agentType = String(project.agent.type || '').trim().toLowerCase();

        if (agentType === LOCALCORE_ACP_AGENT_TYPE) {
          // localcore-acp workspaces are executed by the local AI core router, not by cc-connect itself.
          return [];
        }

        // Transform opencode agent to use ACP adapter for permission support
        if (agentType === 'opencode') {
          const model = normalizeDesktopAgentModel('opencode', String(project.agent.options?.model || ''));
          const opencodeConfig = model ? JSON.stringify({ model }) : '{}';
          project = {
            ...project,
            agent: {
              ...project.agent,
              type: 'acp',
              options: {
                command: 'opencode',
                args: ['acp'],
                env: {
                  OPENCODE_CONFIG_CONTENT: opencodeConfig,
                },
                work_dir: project.agent.options?.work_dir || '.',
              },
            },
          };
        } else {
          const nextOptions = {
            ...(project.agent.options || {}),
          };
          nextOptions.model = normalizeDesktopAgentModel(project.agent.type, String(nextOptions.model || ''));
          project = {
            ...project,
            agent: {
              ...project.agent,
              options: nextOptions,
            },
          };
        }
      }

      if (
        project?.name !== DEFAULT_PROJECT_NAME ||
        !Array.isArray(project.platforms) ||
        project.platforms.length !== 1 ||
        project.platforms[0]?.type !== 'telegram' ||
        project.platforms[0]?.options?.bot_token !== 'replace-me'
      ) {
        return [project];
      }

      return [{
        ...project,
        platforms: [],
      }];
    });

    return next;
  }

  private normalizeLogicalConfig(config: DesktopConnectConfig): DesktopConnectConfig {
    const next = clone(config);
    if (!Array.isArray(next.projects)) {
      return next;
    }

    next.projects = next.projects.map((project) => {
      if (!project?.agent) {
        return project;
      }

      let nextAgent = clone(project.agent);
      const currentType = String(nextAgent.type || '').trim().toLowerCase();

      if (
        currentType === 'acp' &&
        String(nextAgent.options?.command || '').trim() === 'opencode' &&
        Array.isArray(nextAgent.options?.args) &&
        nextAgent.options?.args?.length === 1 &&
        nextAgent.options?.args?.[0] === 'acp'
      ) {
        const rawEnv = nextAgent.options?.env;
        const env = rawEnv && typeof rawEnv === 'object' ? { ...(rawEnv as Record<string, unknown>) } : {};
        let recoveredModel = '';
        if (typeof env.OPENCODE_CONFIG_CONTENT === 'string') {
          try {
            const parsedConfig = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
            recoveredModel = typeof parsedConfig.model === 'string' ? parsedConfig.model : '';
          } catch {
            recoveredModel = '';
          }
        }
        delete env.OPENCODE_CONFIG_CONTENT;

        const nextOptions: Record<string, unknown> = {
          work_dir: nextAgent.options?.work_dir || '.',
        };
        const normalizedModel = normalizeDesktopAgentModel('opencode', recoveredModel);
        if (normalizedModel) {
          nextOptions.model = normalizedModel;
        }
        if (Object.keys(env).length > 0) {
          nextOptions.env = env;
        }

        nextAgent = {
          ...nextAgent,
          type: 'opencode',
          options: nextOptions,
        };
      } else {
        const nextOptions = {
          ...(nextAgent.options || {}),
        };
        if (Object.prototype.hasOwnProperty.call(nextOptions, 'model')) {
          const normalizedModel = normalizeDesktopAgentModel(nextAgent.type, String(nextOptions.model || ''));
          if (normalizedModel) {
            nextOptions.model = normalizedModel;
          } else {
            delete nextOptions.model;
          }
        }
        nextAgent = {
          ...nextAgent,
          options: nextOptions,
        };
      }

      return {
        ...project,
        agent: nextAgent,
      };
    });

    return next;
  }

  private isExecutablePath(path?: string) {
    if (!path) {
      return false;
    }
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private persistSettings() {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8');
  }

  private pushLog(line: string) {
    if (!line) {
      return;
    }
    this.logs.push(line);
    if (this.logs.length > LOG_LIMIT) {
      this.logs.splice(0, this.logs.length - LOG_LIMIT);
    }
    this.emit('logs', this.getLogs());
  }

  private computePendingRestart(configFile: ConfigFileState) {
    if (this.state.status !== 'running') {
      return false;
    }
    let nextRuntimeConfigRaw = this.appliedRuntimeConfigRaw;
    if (!configFile.parsed) {
      return true;
    }
    nextRuntimeConfigRaw = TOML.stringify(this.deriveRuntimeConfig(configFile.parsed) as any);
    return (
      this.settings.binaryPath !== this.appliedBinaryPath ||
      this.settings.configPath !== this.appliedConfigPath ||
      configFile.raw !== this.appliedConfigRaw ||
      nextRuntimeConfigRaw !== this.appliedRuntimeConfigRaw
    );
  }

  private async waitForManagementReady() {
    const started = Date.now();
    while (Date.now() - started < MANAGEMENT_READY_TIMEOUT_MS) {
      if (!this.child) {
        throw new Error('cc-connect exited before the management API became ready');
      }
      if (this.state.status === 'error') {
        throw new Error(this.state.lastError || 'cc-connect failed while starting');
      }
      try {
        const response = await fetch(`${this.getManagementBaseUrl()}/status`, {
          headers: {
            Authorization: `Bearer ${this.settings.managementToken}`,
          },
        });
        if (response.ok) {
          const payload = await response.json().catch(() => null);
          if (payload?.ok) {
            return;
          }
        }
      } catch {
        // Keep polling until the management API becomes available or startup fails.
      }
      await new Promise((resolve) => setTimeout(resolve, MANAGEMENT_READY_POLL_MS));
    }
    throw new Error('Timed out waiting for the management API to become ready');
  }

  private async ensureAvailablePorts() {
    const nextManagementPort = await this.resolveAvailablePort(this.settings.managementPort, []);
    const nextBridgePort = await this.resolveAvailablePort(this.settings.bridgePort, [nextManagementPort]);
    if (
      nextManagementPort === this.settings.managementPort &&
      nextBridgePort === this.settings.bridgePort
    ) {
      return;
    }
    this.settings = {
      ...this.settings,
      managementPort: nextManagementPort,
      bridgePort: nextBridgePort,
    };
    this.persistSettings();
    this.pushLog(`Adjusted desktop runtime ports to management=${nextManagementPort}, bridge=${nextBridgePort}`);
    this.emit('state');
  }

  private async resolveAvailablePort(preferredPort: number, exclude: number[]) {
    if (!exclude.includes(preferredPort) && await this.isPortAvailable(preferredPort)) {
      return preferredPort;
    }
    return this.findEphemeralPort(exclude);
  }

  private async isPortAvailable(port: number) {
    return new Promise<boolean>((resolve) => {
      const server = createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen(port, () => {
        server.close(() => resolve(true));
      });
    });
  }

  private async findEphemeralPort(exclude: number[]) {
    return new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(async () => {
          if (!port) {
            reject(new Error('Could not allocate an ephemeral port'));
            return;
          }
          if (exclude.includes(port)) {
            try {
              resolve(await this.findEphemeralPort(exclude));
            } catch (error) {
              reject(error);
            }
            return;
          }
          resolve(port);
        });
      });
    });
  }
}
