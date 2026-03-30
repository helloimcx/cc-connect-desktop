import { EventEmitter } from 'node:events';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { DEFAULT_DESKTOP_AGENT_TYPE, DEFAULT_DESKTOP_OPENCODE_MODEL } from '../shared/desktop.js';
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

const DEFAULT_CONFIG_TEMPLATE = `# Managed by cc-connect-desktop
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

[projects.agent.options]
model = "${DEFAULT_DESKTOP_OPENCODE_MODEL}"
work_dir = "."
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
  private readonly logs: string[] = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: DesktopServiceState = { status: 'stopped' };
  private settings: DesktopSettings;

  constructor(private readonly userDataPath: string) {
    super();
    const runtimeDir = join(userDataPath, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    this.settingsPath = join(runtimeDir, 'desktop-settings.json');
    this.settings = this.loadSettings();
  }

  getSettings() {
    return clone(this.settings);
  }

  updateSettings(input: DesktopSettingsInput) {
    this.settings = {
      ...this.settings,
      ...input,
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
      return { path, exists: true, raw, parsed };
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
    writeFileSync(this.settings.configPath, TOML.stringify(config as any), 'utf8');
    this.emit('state');
    return this.readConfigState();
  }

  async ensureConfigFile() {
    if (existsSync(this.settings.configPath)) {
      return this.readConfigState();
    }
    mkdirSync(dirname(this.settings.configPath), { recursive: true });
    writeFileSync(this.settings.configPath, DEFAULT_CONFIG_TEMPLATE, 'utf8');
    return this.readConfigState();
  }

  async start() {
    if (this.child && this.state.status === 'running') {
      return this.getServiceState();
    }

    await this.ensureConfigFile();
    const configState = await this.readConfigState();
    if (!configState.parsed) {
      this.state = {
        status: 'error',
        lastError: configState.error || 'Config file is invalid TOML',
      };
      this.emit('state');
      return this.getServiceState();
    }

    const managed = this.normalizeConfig(configState.parsed);
    await this.writeStructuredConfig(managed);

    const binaryPath = this.resolveBinaryPath();
    this.pushLog(`Starting cc-connect using ${binaryPath}`);
    this.state = { status: 'starting' };
    this.emit('state');

    try {
      const child = spawn(binaryPath, ['--config', this.settings.configPath], {
        env: process.env,
        stdio: 'pipe',
      });
      this.child = child;

      child.stdout.on('data', (chunk) => this.pushLog(String(chunk).trimEnd()));
      child.stderr.on('data', (chunk) => this.pushLog(String(chunk).trimEnd()));

      child.on('spawn', () => {
        this.state = {
          status: 'running',
          pid: child.pid,
          startedAt: new Date().toISOString(),
        };
        this.emit('state');
      });

      child.on('exit', (code, signal) => {
        this.child = null;
        this.state = {
          status: code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error',
          lastError:
            code === 0 || signal === 'SIGTERM'
              ? undefined
              : `cc-connect exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`,
        };
        this.emit('state');
      });

      child.on('error', (error) => {
        this.child = null;
        this.state = { status: 'error', lastError: error.message };
        this.pushLog(error.message);
        this.emit('state');
      });
    } catch (error) {
      this.state = {
        status: 'error',
        lastError: error instanceof Error ? error.message : String(error),
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
    child.kill('SIGTERM');
    this.child = null;
    this.state = { status: 'stopped' };
    this.emit('state');
    return this.getServiceState();
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async getRuntimeStatus(): Promise<DesktopRuntimeStatus> {
    return {
      mode: 'desktop',
      service: this.getServiceState(),
      bridge: { status: 'disconnected' },
      settings: this.getSettings(),
      managementBaseUrl: this.getManagementBaseUrl(),
      configFile: await this.readConfigState(),
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

  private normalizeConfig(config: DesktopConnectConfig): DesktopConnectConfig {
    const next = this.withManagedSections(config);
    if (!Array.isArray(next.projects)) {
      return next;
    }

    next.projects = next.projects.map((project) => {
      if (
        project?.name !== DEFAULT_PROJECT_NAME ||
        !Array.isArray(project.platforms) ||
        project.platforms.length !== 1 ||
        project.platforms[0]?.type !== 'telegram' ||
        project.platforms[0]?.options?.bot_token !== 'replace-me'
      ) {
        return project;
      }

      return {
        ...project,
        platforms: [],
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
}
