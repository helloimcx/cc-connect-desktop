import { EventEmitter } from 'node:events';
import type {
  DesktopConnectConfig,
  DesktopRuntimeStatus,
  DesktopServiceState,
  DesktopSettings,
  DesktopSettingsInput,
  LocalCoreDoctorResult,
  LocalCorePluginDiagnostics,
  RuntimeConfigState,
} from '@cc/superai-contracts';
import type { KnowledgeRuntime } from '@cc/plugin-sdk';
import { deriveDesktopRuntimeRoles, type DesktopBridgeEvent } from '@cc/superai-contracts';
import { bootstrapLocalCoreRuntime, type LocalCoreKernel, type LocalCoreRuntimeBootstrap } from '../kernel/bootstrap.js';
import { LocalCoreError, LocalCoreErrorReporter, toLocalCoreErrorInfo } from '../kernel/local-core-errors.js';
import type { WorkspaceRouter } from '../router/workspace-router.js';
import type { LocalCoreRuntimeState } from './local-core-runtime-state.js';
import type { ScheduledJobApplicationService } from '../scheduler/scheduled-job-application-service.js';
import type { AutomationMonitorService } from '../automation/automation-monitor-service.js';
import type { AutomationService } from '../automation/automation-service.js';
import type { AutomationActionExecutor } from '../automation/automation-action-executor.js';
import { DecisionLogService } from '../automation/decision-log-service.js';
import { CostService } from '../cost/cost-service.js';
import { RuntimeDetectionService, type RuntimeDetectionEvent } from './runtime-detection-service.js';
import type { LocalCoreAcpStore } from '../acp/local-core-acp-store.js';
import { ChannelService } from './channel-service.js';
import { ExternalService } from './external-service.js';
import { runDeploymentDiagnostics } from './deployment-diagnostics.js';
import { normalizeWorkspaceIds, syncWorkspaceRegistry } from './workspace-project-registry.js';

export class LocalCoreController extends EventEmitter {
  readonly store: LocalCoreAcpStore;
  readonly workspaceRouter: WorkspaceRouter;
  readonly knowledgeProvider: KnowledgeRuntime;
  readonly channelService: ChannelService;
  readonly externalService: ExternalService;
  readonly scheduledJobs: ScheduledJobApplicationService;
  readonly automationMonitors: AutomationMonitorService;
  readonly automations: AutomationService;
  readonly automationActionExecutor?: AutomationActionExecutor;
  readonly decisionLogService: DecisionLogService;
  readonly costService: CostService;
  readonly runtimeDetection: RuntimeDetectionService;
  readonly kernel: LocalCoreKernel;
  readonly errorReporter: LocalCoreErrorReporter;

  private readonly state: LocalCoreRuntimeState;
  private readonly runtime: LocalCoreRuntimeBootstrap;
  private readonly busUnsubscribers: Array<() => void> = [];
  private readonly pendingLogs: string[] = [];
  private handlingLog = false;

  constructor(
    private readonly userDataPath: string,
    runtime?: LocalCoreRuntimeBootstrap,
  ) {
    super();
    this.runtime = runtime || bootstrapLocalCoreRuntime({
      userDataPath,
      localCoreBase: 'http://127.0.0.1:9831/api/local/v1',
      log: (message) => this.handleLog(message),
    });
    this.state = this.runtime.state;
    this.store = this.runtime.store;
    this.kernel = this.runtime.kernel;
    this.costService = this.runtime.costService || new CostService({
      store: this.store,
      eventBus: this.kernel.context.bus,
      log: (message) => this.handleLog(message),
    });
    this.knowledgeProvider = this.runtime.knowledgeProvider;
    this.workspaceRouter = this.runtime.workspaceRouter;
    const runtimeChannels = this.runtime.channelRuntimes || [this.runtime.channelRuntime, this.runtime.weixinChannelRuntime];
    const channelRuntimes = new Map(
      runtimeChannels.filter(Boolean).map((ch) => [ch.platform, ch]),
    );
    this.channelService = new ChannelService(channelRuntimes);
    this.externalService = new ExternalService(
      this.store,
      this.workspaceRouter,
      {
        readRuntimeConfig: () => this.readRuntimeConfig(),
        saveRuntimeConfig: (config) => this.saveRuntimeConfig(config),
      },
      userDataPath,
    );
    this.scheduledJobs = this.runtime.scheduledJobs;
    this.automationMonitors = this.runtime.automationMonitors || {
      listMonitors: () => [],
      getMonitor: () => undefined,
      createMonitor: () => { throw new Error('Automation monitor service is not available.'); },
      updateMonitor: () => { throw new Error('Automation monitor service is not available.'); },
      deleteMonitor: () => ({ deleted: false }),
      runMonitorNow: async () => { throw new Error('Automation monitor service is not available.'); },
      listRuns: () => [],
    } as unknown as AutomationMonitorService;
    this.automations = this.runtime.automations || {
      list: () => [],
      get: () => undefined,
      create: () => { throw new Error('Automation service is not available.'); },
      update: () => { throw new Error('Automation service is not available.'); },
      delete: () => ({ deleted: false }),
      checkNow: async () => { throw new Error('Automation service is not available.'); },
      listEvaluations: () => [],
      listRuns: () => [],
      getRuntimeStatus: () => ({ status: 'stopped' }),
    } as unknown as AutomationService;
    this.automationActionExecutor = this.runtime.automationActionExecutor;
    this.decisionLogService = this.runtime.decisionLogService || new DecisionLogService(this.store);
    this.errorReporter = new LocalCoreErrorReporter((message) => this.handleLog(message));
    this.runtimeDetection = new RuntimeDetectionService({
      userDataPath,
      readConfig: async () => (await this.readRuntimeConfig()).config,
      log: (message) => this.handleLog(message),
      emit: (event) => this.handleRuntimeDetectionEvent(event),
    });
    this.flushPendingLogs();
    this.busUnsubscribers.push(
      this.kernel.context.bus.on('platform.bridge.updated', (event) => {
        this.emit('bridge', event);
      }),
      this.kernel.context.bus.on('thread.session.activated', (event) => {
        this.emit('thread-session-activated', event);
      }),
      this.kernel.context.bus.on('scheduler.job.updated', (job) => {
        this.emit('scheduler-job', job);
      }),
      this.kernel.context.bus.on('scheduler.run.updated', (run) => {
        this.emit('scheduler-run', run);
      }),
      this.kernel.context.bus.on('cost.event.recorded', (event) => {
        this.emit('cost-event', event);
      }),
      this.kernel.context.bus.on('budget.threshold.reached', (event) => {
        this.emit('budget-threshold', event);
      }),
      this.kernel.context.bus.on('budget.limit.exceeded', (event) => {
        this.emit('budget-limit-exceeded', event);
      }),
      this.kernel.context.bus.on('automation.monitor.updated', (monitor) => {
        this.emit('automation-monitor', monitor);
      }),
      this.kernel.context.bus.on('automation.monitor.run.updated', (run) => {
        this.emit('automation-monitor-run', run);
      }),
      this.kernel.context.bus.on('automation.definition.updated', (automation) => {
        this.emit('automation-definition', automation);
      }),
      this.kernel.context.bus.on('automation.evaluation.updated', (evaluation) => {
        this.emit('automation-evaluation', evaluation);
      }),
      this.kernel.context.bus.on('automation.run.updated', (run) => {
        this.emit('automation-run', run);
      }),
      this.kernel.context.bus.on('runtime.state.changed', () => {
        void this.emitRuntime();
      }),
      this.kernel.context.bus.on('localcore.error', (event) => {
        const errorInfo = this.errorReporter.report(
          String(event.scope || 'local-ai-core'),
          event.errorInfo || event.error || 'Unknown error',
          event.context || {},
        );
        const runtimeId = String(event.context?.runtimeId || event.context?.agentType || '').trim();
        if (runtimeId) {
          this.runtimeDetection.recordLaunchError(runtimeId, errorInfo);
        }
      }),
    );
  }

  async init() {
    await this.runtime.start();
    // Bind and start channel gateways (e.g. Lark WS) now that plugins are registered.
    // Without this, channels only (re)connect when runtime_config is later re-saved,
    // so a fresh process boot silently leaves every channel disconnected.
    await this.channelService.refreshBindings();
    await this.emitRuntime();
    setTimeout(() => {
      void this.runtimeDetection.refreshOnStartup();
    }, 5000);
  }

  async close() {
    for (const unsubscribe of this.busUnsubscribers) {
      unsubscribe();
    }
    await this.runtime.stop();
  }

  async getRuntimeStatus(): Promise<DesktopRuntimeStatus> {
    const service: DesktopServiceState = {
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    const runtimeConfig = await this.readRuntimeConfig();
    const settings = this.state.getSettings();
    const workspaceIds = Array.isArray(runtimeConfig.config?.projects)
      ? runtimeConfig.config.projects
          .map((project) => String(project?.workspace_id || '').trim())
          .filter(Boolean)
      : [];
    const configuredDefault = runtimeConfig.config.projects?.find((project) =>
      project.workspace_id === settings.defaultProject || project.name === settings.defaultProject
    )?.workspace_id;
    const defaultProject = configuredDefault || workspaceIds[0] || '';
    return {
      mode: 'desktop',
      phase: 'api_ready',
      pendingRestart: false,
      service,
      roles: deriveDesktopRuntimeRoles(service),
      settings: {
        ...settings,
        defaultProject,
      },
      runtimeConfig,
      logs: this.getLogs(200),
      pluginDiagnostics: await this.getPluginDiagnostics(),
    };
  }

  async startService() {
    return { status: 'running' as const };
  }

  async stopService() {
    return { status: 'running' as const };
  }

  async restartService() {
    await this.channelService.refreshBindings();
    await this.emitRuntime();
    return { status: 'running' as const };
  }

  getLogs(limit = 200): string[] {
    return this.state.getLogs(limit);
  }

  getLogEntries(level = 'sys', limit = 200) {
    return this.state.getLogEntries(level, limit);
  }

  async readRuntimeConfig(): Promise<RuntimeConfigState> {
    return this.store.readRuntimeConfig();
  }

  async saveRuntimeConfig(config: DesktopConnectConfig): Promise<RuntimeConfigState> {
    const normalized = normalizeWorkspaceIds(this.store, Array.isArray(config.projects) ? config.projects : []);
    const next = this.store.saveRuntimeConfig({ ...config, projects: normalized });
    // The store may apply config normalization (e.g. sandbox defaults) on save;
    // keep the registry mirror and the returned state consistent with what was
    // actually persisted.
    syncWorkspaceRegistry(this.store, next.config.projects || []);
    await this.channelService.refreshBindings();
    await this.emitRuntime();
    return next;
  }

  async saveSettings(input: DesktopSettingsInput): Promise<DesktopSettings> {
    const settings = await this.state.saveSettings(input);
    await this.channelService.refreshBindings();
    await this.emitRuntime();
    return settings;
  }

  async getPluginDiagnostics(): Promise<LocalCorePluginDiagnostics> {
    return this.kernel.diagnostics.snapshot();
  }

  async runDiagnosticsDoctor(): Promise<LocalCoreDoctorResult> {
    const checkedAt = new Date().toISOString();
    const runtimeConfig = await this.readRuntimeConfig();
    const runtimeChecks = await this.runtimeDetection.refresh().catch((error) => {
      const errorInfo = toLocalCoreErrorInfo(error, 'internal_error');
      return [{
        agentType: 'runtime',
        runtimeId: 'runtime',
        displayName: 'Runtime Detection',
        status: 'error' as const,
        installed: false,
        detectedAt: checkedAt,
        summary: errorInfo.userMessage,
        issues: [{ code: errorInfo.code, severity: errorInfo.severity, message: errorInfo.message, help: errorInfo.suggestedAction }],
        recommendedActions: errorInfo.suggestedAction ? [{ label: 'Fix runtime detection', description: errorInfo.suggestedAction }] : [],
        source: 'path' as const,
        error: errorInfo.message,
        readiness: 'failed' as const,
        lastLaunchError: errorInfo,
      }];
    });
    const channelStatuses = await this.channelService.listStatuses().catch(() => []);
    const checks = [
      runtimeConfig.error
        ? {
            id: 'config',
            label: 'Runtime Configuration',
            status: 'fail' as const,
            summary: runtimeConfig.error,
            errorInfo: new LocalCoreError('config_invalid', runtimeConfig.error).info,
          }
        : {
            id: 'config',
            label: 'Runtime Configuration',
            status: 'pass' as const,
            summary: `Runtime configuration is stored in SQLite at ${runtimeConfig.databasePath}.`,
          },
      {
        id: 'runtime-detection',
        label: 'Runtime Detection',
        status: runtimeChecks.some((runtime) => runtime.status === 'error') ? 'fail' as const : 'pass' as const,
        summary: `${runtimeChecks.length} runtime(s) checked.`,
      },
      {
        id: 'channels',
        label: 'Channel Gateways',
        status: channelStatuses.some((status) => status.status === 'error') ? 'warn' as const : 'pass' as const,
        summary: `${channelStatuses.length} channel gateway status record(s) checked.`,
        errorInfo: channelStatuses.find((status) => status.lastErrorInfo)?.lastErrorInfo,
      },
      {
        id: 'logs',
        label: 'Logs',
        status: 'pass' as const,
        summary: 'Local AI Core log reader is available.',
      },
    ];
    const status = checks.some((check) => check.status === 'fail')
      ? 'fail'
      : checks.some((check) => check.status === 'warn')
        ? 'warn'
        : 'pass';
    return { status, checkedAt, checks };
  }

  async runDeploymentDiagnostics(): Promise<LocalCoreDoctorResult> {
    const runtimeConfig = await this.readRuntimeConfig();
    return runDeploymentDiagnostics({ config: runtimeConfig.config });
  }

  emitBridge(event: DesktopBridgeEvent) {
    this.emit('bridge', event);
  }

  private async emitRuntime() {
    this.emit('runtime', await this.getRuntimeStatus());
  }

  private handleRuntimeDetectionEvent(event: RuntimeDetectionEvent) {
    this.emit('runtime-detection', event);
  }

  private handleLog(message: string) {
    if (this.handlingLog) {
      return;
    }
    const state = (this as unknown as { state?: LocalCoreRuntimeState }).state;
    if (!state) {
      this.pendingLogs.push(message);
      this.emit('logs', message);
      return;
    }
    this.handlingLog = true;
    try {
      state.pushLog?.(message);
    } finally {
      this.handlingLog = false;
    }
    this.emit('logs', message);
  }

  private flushPendingLogs() {
    if (this.pendingLogs.length === 0) {
      return;
    }
    const logs = this.pendingLogs.splice(0);
    this.handlingLog = true;
    try {
      for (const message of logs) {
        this.state.pushLog?.(message);
      }
    } finally {
      this.handlingLog = false;
    }
  }
}
