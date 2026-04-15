import { app, BrowserWindow, ipcMain } from 'electron';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  DesktopBridgeEvent,
  DesktopBridgeSendInput,
  DesktopConnectConfig,
  DesktopRuntimeStatus,
  DesktopSettingsInput,
} from '../shared/desktop.js';
import { deriveDesktopRuntimePhase, normalizeDesktopBridgeButtonOption, supportsInteractivePermission } from '../shared/desktop.js';
import type {
  KnowledgeBase,
  KnowledgeBaseCreateInput,
  KnowledgeBaseUpdateInput,
  KnowledgeConfig,
  KnowledgeFile,
  KnowledgeFolder,
  KnowledgeFolderCreateInput,
  KnowledgeFolderUpdateInput,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeSource,
  KnowledgeUploadResult,
} from '../packages/contracts/src/index.js';
import type { LocalAiCoreBindings } from '../services/local-ai-core/src/server.js';
import { LocalAiCoreServer } from '../services/local-ai-core/src/server.js';
import { ServiceManager } from './service-manager.js';
import { BridgeAdapter } from './bridge-adapter.js';
import { AiVectorKnowledgeProvider } from '../packages/knowledge-api/src/index.js';

let mainWindow: InstanceType<typeof BrowserWindow> | null = null;
let serviceManager: ServiceManager;
let bridgeAdapter: BridgeAdapter;
let desktopKnowledgeProvider: AiVectorKnowledgeProvider;
let localAiCoreServer: LocalAiCoreServer | null = null;
let localAiCoreBindings: LocalAiCoreBindings | null = null;
const smokeBridgeSendInputs: DesktopBridgeSendInput[] = [];
const coreRunThreadMap = new Map<string, string>();

const userDataOverride = process.env.AI_WORKSTATION_USER_DATA_DIR?.trim();
const smokeOutputPath = process.env.AI_WORKSTATION_SMOKE_OUTPUT?.trim();
const smokeScenario = process.env.AI_WORKSTATION_SMOKE_SCENARIO?.trim() || 'default';
const forceRuntimeStatusError = process.env.AI_WORKSTATION_FORCE_RUNTIME_STATUS_ERROR === '1';
if (userDataOverride) {
  mkdirSync(userDataOverride, { recursive: true });
  app.setPath('userData', userDataOverride);
}

function getServiceManager() {
  if (!serviceManager) {
    throw new Error('service manager is not initialized');
  }
  return serviceManager;
}

function getBridgeAdapter() {
  if (!bridgeAdapter) {
    throw new Error('bridge adapter is not initialized');
  }
  return bridgeAdapter;
}

function getDesktopKnowledgeProvider() {
  if (!desktopKnowledgeProvider) {
    throw new Error('knowledge provider is not initialized');
  }
  return desktopKnowledgeProvider;
}

function encodeThreadId(project: string, sessionId: string) {
  return `${encodeURIComponent(project)}::${encodeURIComponent(sessionId)}`;
}

function decodeThreadId(threadId: string) {
  const [workspacePart, sessionPart] = threadId.split('::');
  if (!workspacePart || !sessionPart) {
    throw new Error(`Invalid thread id: ${threadId}`);
  }
  return {
    workspaceId: decodeURIComponent(workspacePart),
    sessionId: decodeURIComponent(sessionPart),
  };
}

function buildRuntimeStatus(bridge: ReturnType<BridgeAdapter['getState']>): Promise<DesktopRuntimeStatus> {
  return getServiceManager().getRuntimeStatus().then((runtime) => ({
    ...runtime,
    phase: deriveDesktopRuntimePhase(runtime.service, bridge),
    bridge,
  }));
}

async function broadcastRuntime() {
  const runtime = await buildRuntimeStatus(getBridgeAdapter().getState());
  localAiCoreBindings?.emit('runtime', runtime);
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('desktop:runtime', runtime);
  });
}

function syncBridgeWithServiceState() {
  const serviceState = getServiceManager().getServiceState();
  const bridgeState = getBridgeAdapter().getState();

  if (serviceState.status === 'running') {
    if (bridgeState.status === 'disconnected' || bridgeState.status === 'error') {
      void getBridgeAdapter().connect();
    }
    return;
  }

  if (bridgeState.status !== 'disconnected') {
    getBridgeAdapter().disconnect();
  }
}

async function waitFor<T>(
  check: () => Promise<T | null> | T | null,
  { timeoutMs = 30000, intervalMs = 300, label = 'condition' } = {},
): Promise<T> {
  const started = Date.now();
  let lastError: unknown = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result) {
        return result;
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError instanceof Error) {
    throw new Error(`Timed out waiting for ${label}: ${lastError.message}`);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function writeSmokeResult(payload: Record<string, unknown>) {
  if (!smokeOutputPath) {
    return;
  }
  mkdirSync(dirname(smokeOutputPath), { recursive: true });
  writeFileSync(smokeOutputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function recordSmokeBridgeSend(input: DesktopBridgeSendInput) {
  if (!smokeOutputPath) {
    return;
  }
  smokeBridgeSendInputs.push({ ...input });
}

function emitSmokeBridgeEvent(payload: DesktopBridgeEvent) {
  if (!smokeOutputPath) {
    return;
  }
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('desktop:bridge', payload);
  });
}

async function managementRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const runtime = await buildRuntimeStatus(getBridgeAdapter().getState());
  const response = await fetch(`${runtime.managementBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${runtime.settings.managementToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json() as { ok?: boolean; data?: T; error?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `cc-connect request failed: ${response.status}`);
  }
  return payload.data as T;
}

function createLocalAiCoreBindings(): LocalAiCoreBindings {
  const bindings = new EventEmitter() as LocalAiCoreBindings;
  const knowledgeProvider = getDesktopKnowledgeProvider();

  bindings.getRuntimeStatus = () => buildRuntimeStatus(getBridgeAdapter().getState());
  bindings.startService = async () => {
    const result = await getServiceManager().start();
    if (result.status === 'running') {
      void getBridgeAdapter().connect();
    }
    await broadcastRuntime();
    return result;
  };
  bindings.stopService = async () => {
    getBridgeAdapter().disconnect();
    const result = await getServiceManager().stop();
    await broadcastRuntime();
    return result;
  };
  bindings.restartService = async () => {
    getBridgeAdapter().disconnect();
    const result = await getServiceManager().restart();
    if (result.status === 'running') {
      void getBridgeAdapter().connect();
    }
    await broadcastRuntime();
    return result;
  };
  bindings.getLogs = (limit?: number) => getServiceManager().getLogs(limit);
  bindings.readConfigFile = () => getServiceManager().readConfigState();
  bindings.saveRawConfigFile = (raw: string) => getServiceManager().writeRawConfig(raw);
  bindings.saveStructuredConfigFile = (config: DesktopConnectConfig) => getServiceManager().writeStructuredConfig(config);
  bindings.saveSettings = async (input: DesktopSettingsInput) => {
    const settings = getServiceManager().updateSettings(input);
    await broadcastRuntime();
    return settings;
  };
  bindings.bridgeConnect = async () => {
    const result = await getBridgeAdapter().connect();
    await broadcastRuntime();
    return result;
  };
  bindings.bridgeDisconnect = async () => {
    const result = getBridgeAdapter().disconnect();
    await broadcastRuntime();
    return result;
  };
  bindings.bridgeSendMessage = (input: DesktopBridgeSendInput) => getBridgeAdapter().sendMessage(input);
  bindings.listWorkspaces = async () => {
    const payload = await managementRequest<{ projects: Array<{
      name: string;
      agent_type: string;
      platforms: string[];
      sessions_count: number;
      heartbeat_enabled: boolean;
    }> }>('GET', '/projects');
    return (payload.projects || []).map((project) => ({
      id: project.name,
      name: project.name,
      agentType: project.agent_type,
      platforms: project.platforms || [],
      sessionsCount: project.sessions_count,
      heartbeatEnabled: Boolean(project.heartbeat_enabled),
    }));
  };
  bindings.listThreads = async (workspaceId: string) => {
    const payload = await managementRequest<{ sessions: Array<any> }>('GET', `/projects/${encodeURIComponent(workspaceId)}/sessions`);
    return (payload.sessions || []).map((session) => ({
      id: encodeThreadId(workspaceId, session.id),
      workspaceId,
      title: String(session.name || session.user_name || session.chat_name || session.id),
      live: Boolean(session.live || session.active),
      updatedAt: session.updated_at,
      createdAt: session.created_at,
      historyCount: session.history_count,
      excerpt: session.last_message?.content?.replace(/\n/g, ' ') || '',
      participantName: session.user_name || session.chat_name,
      runId: session.live ? `run:${encodeThreadId(workspaceId, session.id)}` : undefined,
    }));
  };
  bindings.createThread = async (workspaceId: string, title?: string) => {
    const chatId = `core-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionKey = `desktop:${workspaceId}:${chatId}`;
    const created = await managementRequest<{ id?: string }>('POST', `/projects/${encodeURIComponent(workspaceId)}/sessions`, {
      session_key: sessionKey,
      name: title || `New thread ${new Date().toLocaleTimeString()}`,
    });
    const sessions = await managementRequest<{ sessions: Array<any> }>('GET', `/projects/${encodeURIComponent(workspaceId)}/sessions`);
    const matched =
      (sessions.sessions || []).find((session) => session.id === created.id) ||
      (sessions.sessions || []).find((session) => session.session_key === sessionKey);
    if (!matched) {
      throw new Error('Created thread could not be loaded');
    }
    return bindings.getThread(encodeThreadId(workspaceId, matched.id));
  };
  bindings.getThread = async (threadId: string) => {
    const { workspaceId, sessionId } = decodeThreadId(threadId);
    const detail = await managementRequest<any>(
      'GET',
      `/projects/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}?history_limit=200`,
    );
    const selectedKnowledgeBaseIds = await knowledgeProvider.listThreadKnowledgeBaseIds(threadId);
    return {
      id: threadId,
      workspaceId,
      title: String(detail.name || detail.user_name || detail.chat_name || detail.id),
      live: Boolean(detail.live || detail.active),
      updatedAt: detail.updated_at,
      createdAt: detail.created_at,
      historyCount: detail.history_count,
      excerpt: detail.last_message?.content?.replace(/\n/g, ' ') || '',
      participantName: detail.user_name || detail.chat_name,
      runId: detail.live ? `run:${threadId}` : undefined,
      selectedKnowledgeBaseIds,
      messages: (detail.history || []).map((message: any, index: number) => ({
        id: `${message.timestamp || index}-${message.role}-${index}`,
        role: message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system',
        content: message.content,
        timestamp: message.timestamp,
        kind: message.kind === 'progress' ? 'progress' : message.role === 'system' ? 'system' : 'final',
      })),
    };
  };
  bindings.renameThread = async (threadId: string, title: string) => {
    const { workspaceId, sessionId } = decodeThreadId(threadId);
    await managementRequest('PATCH', `/projects/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, {
      name: title,
    });
    return bindings.getThread(threadId);
  };
  bindings.updateThreadKnowledgeBases = async (threadId: string, knowledgeBaseIds: string[]) => ({
    knowledgeBaseIds: await knowledgeProvider.updateThreadKnowledgeBaseIds(threadId, knowledgeBaseIds),
  });
  bindings.deleteThread = async (threadId: string) => {
    const { workspaceId, sessionId } = decodeThreadId(threadId);
    await managementRequest('DELETE', `/projects/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`);
    await knowledgeProvider.deleteThreadKnowledgeBaseLinks(threadId);
    return { deleted: true };
  };
  bindings.sendThreadMessage = async (threadId: string, content: string) => {
    const { workspaceId, sessionId } = decodeThreadId(threadId);
    const detail = await managementRequest<any>(
      'GET',
      `/projects/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}?history_limit=1`,
    );
    const sessionKey = String(detail.session_key || '');
    if (sessionKey.startsWith('desktop:')) {
      const [, project = workspaceId, chatId = 'main'] = sessionKey.split(':');
      const result = await getBridgeAdapter().sendMessage({ project, chatId, content });
      coreRunThreadMap.set(result.messageId, threadId);
      return { runId: result.messageId };
    }
    await managementRequest('POST', `/projects/${encodeURIComponent(workspaceId)}/sessions/switch`, {
      session_key: detail.session_key,
      session_id: detail.id,
    }).catch(() => undefined);
    await managementRequest('POST', `/projects/${encodeURIComponent(workspaceId)}/send`, {
      session_key: detail.session_key,
      message: content,
    });
    const runId = `run:${threadId}:${Date.now()}`;
    coreRunThreadMap.set(runId, threadId);
    return { runId };
  };
  bindings.sendThreadAction = (threadId: string, content: string) => bindings.sendThreadMessage(threadId, content);
  bindings.interruptRun = async (runId: string) => {
    const threadId = coreRunThreadMap.get(runId);
    if (!threadId) {
      return { interrupted: false };
    }
    const { workspaceId, sessionId } = decodeThreadId(threadId);
    const detail = await managementRequest<any>(
      'GET',
      `/projects/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}?history_limit=1`,
    );
    const sessionKey = String(detail.session_key || '');
    if (!sessionKey.startsWith('desktop:')) {
      return { interrupted: false };
    }
    const [, project = workspaceId, chatId = 'main'] = sessionKey.split(':');
    await getBridgeAdapter().sendMessage({ project, chatId, content: '/stop' });
    return { interrupted: true };
  };
  bindings.listKnowledgeSources = async (): Promise<KnowledgeSource[]> => knowledgeProvider.listSources();
  bindings.getKnowledgeConfig = async (): Promise<KnowledgeConfig> => knowledgeProvider.getConfig();
  bindings.updateKnowledgeConfig = async (input: Partial<KnowledgeConfig>): Promise<KnowledgeConfig> =>
    knowledgeProvider.updateConfig(input);
  bindings.listKnowledgeFolders = async (): Promise<KnowledgeFolder[]> => knowledgeProvider.listFolders();
  bindings.createKnowledgeFolder = async (input: KnowledgeFolderCreateInput): Promise<KnowledgeFolder> =>
    knowledgeProvider.createFolder(input);
  bindings.updateKnowledgeFolder = async (
    id: string,
    input: KnowledgeFolderUpdateInput,
  ): Promise<KnowledgeFolder> => knowledgeProvider.updateFolder(id, input);
  bindings.deleteKnowledgeFolder = async (id: string) => knowledgeProvider.deleteFolder(id);
  bindings.listKnowledgeBases = async (): Promise<KnowledgeBase[]> => knowledgeProvider.listKnowledgeBases();
  bindings.getKnowledgeBase = async (id: string): Promise<KnowledgeBase> => knowledgeProvider.getKnowledgeBase(id);
  bindings.createKnowledgeBase = async (input: KnowledgeBaseCreateInput): Promise<KnowledgeBase> =>
    knowledgeProvider.createKnowledgeBase(input);
  bindings.updateKnowledgeBase = async (
    id: string,
    input: KnowledgeBaseUpdateInput,
  ): Promise<KnowledgeBase> => knowledgeProvider.updateKnowledgeBase(id, input);
  bindings.deleteKnowledgeBase = async (id: string) => knowledgeProvider.deleteKnowledgeBase(id);
  bindings.listKnowledgeBaseFiles = async (knowledgeBaseId: string): Promise<KnowledgeFile[]> =>
    knowledgeProvider.listKnowledgeBaseFiles(knowledgeBaseId);
  bindings.uploadKnowledgeBaseFiles = async (
    knowledgeBaseId: string,
    request: { contentType: string; body: Uint8Array },
  ): Promise<KnowledgeUploadResult[]> => knowledgeProvider.uploadKnowledgeBaseFiles(knowledgeBaseId, request);
  bindings.deleteKnowledgeBaseFile = async (knowledgeBaseId: string, fileId: string) =>
    knowledgeProvider.deleteKnowledgeBaseFile(knowledgeBaseId, fileId);
  bindings.searchKnowledgeBase = async (
    knowledgeBaseId: string,
    input: KnowledgeSearchInput,
  ): Promise<KnowledgeSearchResult[]> => knowledgeProvider.searchKnowledgeBase(knowledgeBaseId, input);
  bindings.getCapabilities = async () => ({
    adapters: {
      channels: ['cc-connect'],
      agents: ['opencode', 'codex', 'claudecode', 'cursor', 'gemini', 'qoder', 'iflow'],
      knowledge: true,
    },
  });
  return bindings;
}

async function runSmokeTest() {
  if (!smokeOutputPath) {
    return;
  }

  const result: Record<string, unknown> = {
    started_at: new Date().toISOString(),
    ok: false,
    steps: [] as Array<Record<string, unknown>>,
  };
  const steps = result.steps as Array<Record<string, unknown>>;
  const record = (step: string, data?: Record<string, unknown>) => {
    steps.push({
      step,
      at: new Date().toISOString(),
      ...(data || {}),
    });
  };

  try {
    const window = await waitFor(
      () => {
        const current = BrowserWindow.getAllWindows()[0];
        return current ?? null;
      },
      { label: 'browser window' },
    );
    record('window_ready');

    if (smokeScenario === 'bootstrap-error') {
      const failureText = await waitFor(
        async () => {
          const bodyText = await window.webContents.executeJavaScript('document.body?.innerText || ""', true);
          return typeof bodyText === 'string' && bodyText.includes('AI-WorkStation 运行时初始化失败')
            ? bodyText
            : null;
        },
        { timeoutMs: 30000, label: 'bootstrap failure screen' },
      );
      record('bootstrap_failure_screen', { body: failureText });
      result.ok = true;
      result.finished_at = new Date().toISOString();
      writeSmokeResult(result);
      setTimeout(() => app.exit(0), 200);
      return;
    }

    await waitFor(
      async () => {
        const bodyText = await window.webContents.executeJavaScript('document.body?.innerText || ""', true);
        return typeof bodyText === 'string' && bodyText.includes('AI-WorkStation 运行时') ? bodyText : null;
      },
      { timeoutMs: 45000, label: 'dashboard render' },
    );
    record('dashboard_rendered');

    let runtime = await buildRuntimeStatus(getBridgeAdapter().getState());
    record('initial_runtime', {
      service: runtime.service.status,
      bridge: runtime.bridge.status,
    });

    if (runtime.service.status !== 'running') {
      const clicked = await window.webContents.executeJavaScript(
        `(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const target = buttons.find((button) =>
            button.textContent?.includes('启动服务') ||
            button.textContent?.includes('启动运行时') ||
            button.textContent?.includes('启动') ||
            button.textContent?.includes('Start'),
          );
          if (target) {
            target.click();
            return true;
          }
          if (window.desktop?.startService) {
            void window.desktop.startService();
            return true;
          }
          return false;
        })()`,
        true,
      );
      if (!clicked) {
        throw new Error('Smoke test could not find service start button');
      }
      record('service_start_clicked');
    }

    runtime = await waitFor(
      async () => {
        const current = await buildRuntimeStatus(getBridgeAdapter().getState());
        return current.service.status === 'running' ? current : null;
      },
      { timeoutMs: 45000, label: 'service running' },
    );
    record('service_running', {
      management_base_url: runtime.managementBaseUrl,
      config_path: runtime.configFile.path,
    });

    const statusPayload = await waitFor(
      async () => {
        const current = await buildRuntimeStatus(getBridgeAdapter().getState());
        const response = await fetch(`${current.managementBaseUrl}/status`, {
          headers: {
            Authorization: `Bearer ${current.settings.managementToken}`,
          },
        });
        if (!response.ok) {
          return null;
        }
        const payload = await response.json();
        return payload?.ok ? payload.data : null;
      },
      { label: 'management status payload' },
    );
    record('management_status', { payload: statusPayload });

    const projectsPayload = await waitFor(
      async () => {
        const current = await buildRuntimeStatus(getBridgeAdapter().getState());
        const response = await fetch(`${current.managementBaseUrl}/projects`, {
          headers: {
            Authorization: `Bearer ${current.settings.managementToken}`,
          },
        });
        if (!response.ok) {
          return null;
        }
        const payload = await response.json();
        return payload?.ok ? payload.data : null;
      },
      { label: 'management projects payload' },
    );
    record('management_projects', { payload: projectsPayload });

    const bridgeState = await waitFor(
      () => {
        const state = getBridgeAdapter().getState();
        return state.status === 'connected' ? state : null;
      },
      { timeoutMs: 30000, label: 'bridge connected' },
    );
    record('bridge_connected', { bridge: bridgeState });

    await waitFor(
      async () => {
        const bodyText = await window.webContents.executeJavaScript('document.body?.innerText || ""', true);
        return typeof bodyText === 'string' && !bodyText.includes('Failed to fetch') && bodyText.includes('desktop-demo')
          ? bodyText
          : null;
      },
      { timeoutMs: 30000, label: 'dashboard content settled' },
    );
    record('dashboard_data_visible');

    await window.webContents.executeJavaScript('window.location.hash = "#/workspace"; true;', true);
    record('workspace_navigation_requested');

    await waitFor(
      async () => {
        const bodyText = await window.webContents.executeJavaScript('document.body?.innerText || ""', true);
        return typeof bodyText === 'string' && bodyText.includes('Workspace Config') ? bodyText : null;
      },
      { timeoutMs: 30000, label: 'workspace route render' },
    );
    record('workspace_rendered');

    const workspaceAgentSelectVisible = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const select = Array.from(document.querySelectorAll('select')).find((node) => {
              const container = node.closest('label, div');
              return Boolean(container?.textContent?.includes('Agent type'));
            });
            const customInput = Array.from(document.querySelectorAll('input')).find((node) => {
              const container = node.closest('label, div');
              return Boolean(container?.textContent?.includes('Custom agent type'));
            });
            return select instanceof HTMLSelectElement && select.value === 'opencode' && !(customInput instanceof HTMLInputElement)
              ? { value: select.value }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 15000, label: 'workspace logical agent type visible' },
    );
    record('workspace_agent_type_visible', workspaceAgentSelectVisible);

    await waitFor(
      async () => {
        const ready = await window.webContents.executeJavaScript(
          `(() => {
            const button = document.querySelector('[data-testid="desktop-workspace-add-project"]');
            return button instanceof HTMLButtonElement ? true : null;
          })()`,
          true,
        );
        return ready ? true : null;
      },
      { timeoutMs: 30000, label: 'workspace project controls ready' },
    );
    record('workspace_project_controls_ready');

    const projectAdded = await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('[data-testid="desktop-workspace-add-project"]');
        if (!(button instanceof HTMLButtonElement)) {
          return false;
        }
        button.click();
        return true;
      })()`,
      true,
    );
    if (!projectAdded) {
      throw new Error('Smoke test could not add a project in Workspace');
    }

    const projectRendered = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const projects = Array.from(document.querySelectorAll('[data-testid^="desktop-workspace-project-card-"]'));
            const projectNameInput = document.querySelector('[data-testid="desktop-workspace-project-name"]');
            const bodyText = document.body?.innerText || '';
            return projectNameInput instanceof HTMLInputElement
              ? {
                  count: projects.length,
                  projectName: projectNameInput.value,
                  dirty: bodyText.includes('You have unsaved changes'),
                }
              : null;
          })()`,
          true,
        );
        return result?.count === 2 &&
          result?.projectName === 'project-2' &&
          result?.dirty
          ? result
          : null;
      },
      { timeoutMs: 30000, label: 'workspace project added' },
    );
    record('workspace_project_added', projectRendered);

    const projectPersistedAfterUrlSync = await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        window.setTimeout(() => {
          const projects = Array.from(document.querySelectorAll('[data-testid^="desktop-workspace-project-card-"]'));
          const projectNameInput = document.querySelector('[data-testid="desktop-workspace-project-name"]');
          resolve(
            projectNameInput instanceof HTMLInputElement
              ? {
                  count: projects.length,
                  projectName: projectNameInput.value,
                  hash: window.location.hash || '',
                }
              : null,
          );
        }, 300);
      })`,
      true,
    );
    if (
      !projectPersistedAfterUrlSync ||
      projectPersistedAfterUrlSync.count !== 2 ||
      projectPersistedAfterUrlSync.projectName !== 'project-2'
    ) {
      throw new Error('Workspace project add did not persist after selection sync');
    }
    record('workspace_project_add_persisted', projectPersistedAfterUrlSync);

    const projectReselected = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const card = document.querySelector('[data-testid="desktop-workspace-project-card-0"]');
            const selectButton = card?.querySelector('button');
            const projectNameInput = document.querySelector('[data-testid="desktop-workspace-project-name"]');
            if (!(selectButton instanceof HTMLButtonElement)) {
              return null;
            }
            selectButton.click();
            return projectNameInput instanceof HTMLInputElement ? projectNameInput.value : null;
          })()`,
          true,
        );
        return result === 'desktop-demo' ? result : null;
      },
      { timeoutMs: 30000, label: 'workspace project reselected' },
    );
    record('workspace_project_reselected', { projectName: projectReselected });

    const workspaceConfigApplied = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const button = document.querySelector('[data-testid="desktop-workspace-save-restart"]');
            const bodyText = document.body?.innerText || '';
            if (!(button instanceof HTMLButtonElement)) {
              return null;
            }
            if (!bodyText.includes('Workspace config applied')) {
              button.click();
              return null;
            }
            const projects = Array.from(document.querySelectorAll('[data-testid^="desktop-workspace-project-card-"]'));
            return {
              bodyText,
              projects: projects.length,
            };
          })()`,
          true,
        );
        return result?.projects === 2 && result?.bodyText?.includes('Workspace config applied') ? result : null;
      },
      { timeoutMs: 45000, label: 'workspace config saved and restarted' },
    );
    record('workspace_config_applied', { projects: workspaceConfigApplied.projects });

    const workspaceProjectSelectionStable = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const card = document.querySelector('[data-testid="desktop-workspace-project-card-1"]');
            const selectButton = card?.querySelector('button');
            const projectNameInput = document.querySelector('[data-testid="desktop-workspace-project-name"]');
            if (!(selectButton instanceof HTMLButtonElement) || !(projectNameInput instanceof HTMLInputElement)) {
              return null;
            }
            if (projectNameInput.value !== 'project-2') {
              selectButton.click();
              return null;
            }
            return {
              projectName: projectNameInput.value,
            };
          })()`,
          true,
        );
        return result?.projectName === 'project-2' ? result : null;
      },
      { timeoutMs: 15000, label: 'workspace project selection stable' },
    );

    const workspaceProjectSelectionPersisted = await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        window.setTimeout(() => {
          const projectNameInput = document.querySelector('[data-testid="desktop-workspace-project-name"]');
          resolve(
            projectNameInput instanceof HTMLInputElement
              ? { projectName: projectNameInput.value }
              : null,
          );
        }, 300);
      })`,
      true,
    );
    if (workspaceProjectSelectionPersisted?.projectName !== 'project-2') {
      throw new Error('Workspace project selection did not persist after clicking project-2');
    }
    record('workspace_project_selection_stable', workspaceProjectSelectionStable);

    await waitFor(
      async () => {
        const ready = await window.webContents.executeJavaScript(
          `(() => {
            const button = document.querySelector('[data-testid="desktop-workspace-add-provider"]');
            return button instanceof HTMLButtonElement ? true : null;
          })()`,
          true,
        );
        return ready ? true : null;
      },
      { timeoutMs: 30000, label: 'workspace provider controls ready' },
    );
    record('workspace_provider_controls_ready');

    const providerAdded = await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('[data-testid="desktop-workspace-add-provider"]');
        if (!(button instanceof HTMLButtonElement)) {
          return false;
        }
        button.click();
        return true;
      })()`,
      true,
    );
    if (!providerAdded) {
      throw new Error('Smoke test could not add a provider in Workspace');
    }
    record('workspace_provider_added');

    const providerPresetApplied = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const presetSelects = Array.from(document.querySelectorAll('[data-testid^="desktop-workspace-provider-preset-"]'));
            const baseUrlInputs = Array.from(document.querySelectorAll('[data-testid^="desktop-workspace-provider-base-url-"]'));
            const modelInputs = Array.from(document.querySelectorAll('[data-testid^="desktop-workspace-provider-model-"]'));
            const preset = presetSelects[presetSelects.length - 1];
            const baseUrl = baseUrlInputs[baseUrlInputs.length - 1];
            const model = modelInputs[modelInputs.length - 1];
            if (!(preset instanceof HTMLSelectElement) || !(baseUrl instanceof HTMLInputElement) || !(model instanceof HTMLInputElement)) {
              return null;
            }
            if (preset.value !== 'minimax') {
              preset.value = 'minimax';
              preset.dispatchEvent(new Event('change', { bubbles: true }));
              return null;
            }
            return {
              preset: preset.value,
              baseUrl: baseUrl.value,
              model: model.value,
              dirty: (document.body?.innerText || '').includes('You have unsaved changes'),
            };
          })()`,
          true,
        );
        if (!result) {
          return null;
        }
        return result.preset === 'minimax' &&
          result.baseUrl === 'https://api.minimax.chat/v1' &&
          result.model === 'MiniMax-M2.5' &&
          result.dirty
          ? result
          : null;
      },
      { timeoutMs: 30000, label: 'workspace provider preset applied' },
    );
    record('workspace_provider_preset_applied', providerPresetApplied);

    const providerEnvAdded = await window.webContents.executeJavaScript(
      `(() => {
        const buttons = Array.from(document.querySelectorAll('[data-testid^="desktop-workspace-provider-add-env-"]'));
        const target = buttons[buttons.length - 1];
        if (!(target instanceof HTMLButtonElement)) {
          return false;
        }
        target.click();
        return true;
      })()`,
      true,
    );
    if (!providerEnvAdded) {
      throw new Error('Smoke test could not add a provider env row');
    }
    await waitFor(
      async () => {
        const envKeys = await window.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('[data-testid^="desktop-workspace-provider-env-key-"]')).length`,
          true,
        );
        return typeof envKeys === 'number' && envKeys > 0 ? envKeys : null;
      },
      { timeoutMs: 15000, label: 'workspace provider env row render' },
    );
    record('workspace_provider_env_added');

    const providerModelAdded = await window.webContents.executeJavaScript(
      `(() => {
        const buttons = Array.from(document.querySelectorAll('[data-testid^="desktop-workspace-provider-add-model-"]'));
        const target = buttons[buttons.length - 1];
        if (!(target instanceof HTMLButtonElement)) {
          return false;
        }
        target.click();
        return true;
      })()`,
      true,
    );
    if (!providerModelAdded) {
      throw new Error('Smoke test could not add a provider model row');
    }

    const providerModelConfigured = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const modelInput = document.querySelector('[data-testid="desktop-workspace-provider-model-id-0-0"]');
            const aliasInput = document.querySelector('[data-testid="desktop-workspace-provider-model-alias-0-0"]');
            if (!(modelInput instanceof HTMLInputElement) || !(aliasInput instanceof HTMLInputElement)) {
              return null;
            }
            const setValue = (input, value) => {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              setter?.call(input, value);
              input.dispatchEvent(new Event('input', { bubbles: true }));
            };
            if (modelInput.value !== 'MiniMax-M2.5') {
              setValue(modelInput, 'MiniMax-M2.5');
              return null;
            }
            if (aliasInput.value !== 'free') {
              setValue(aliasInput, 'free');
              return null;
            }
            return {
              model: modelInput.value,
              alias: aliasInput.value,
            };
          })()`,
          true,
        );
        return result?.model === 'MiniMax-M2.5' && result?.alias === 'free' ? result : null;
      },
      { timeoutMs: 15000, label: 'workspace provider model configured' },
    );
    record('workspace_provider_model_configured', providerModelConfigured);

    await window.webContents.executeJavaScript('window.location.hash = "#/chat"; true;', true);
    record('chat_navigation_requested');

    await waitFor(
      async () => {
        const bodyText = await window.webContents.executeJavaScript('document.body?.innerText || ""', true);
        return typeof bodyText === 'string' && bodyText.includes('desktop-demo') ? bodyText : null;
      },
      { timeoutMs: 30000, label: 'chat route render' },
    );
    record('chat_rendered');

    await waitFor(
      async () => {
        const ready = await window.webContents.executeJavaScript(
          `(() => {
            const input = document.querySelector('[data-testid="desktop-chat-input"]');
            const send = document.querySelector('[data-testid="desktop-chat-send"]');
            const project = document.querySelector('[data-testid="desktop-chat-project-select"]');
            const newChat = document.querySelector('[data-testid="desktop-chat-new-chat"]');
            return Boolean(input && send && newChat && project instanceof HTMLSelectElement && project.value);
          })()`,
          true,
        );
        return ready ? true : null;
      },
      { timeoutMs: 30000, label: 'chat composer ready' },
    );
    record('chat_composer_ready');

    const newChatStarted = await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('[data-testid="desktop-chat-new-chat"]');
        if (!(button instanceof HTMLButtonElement)) {
          return false;
        }
        button.click();
        return true;
      })()`,
      true,
    );
    if (!newChatStarted) {
      throw new Error('Smoke test could not create a new desktop chat');
    }
    record('chat_new_session_requested');

    const newChatBlankState = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const title = document.querySelector('[data-testid="desktop-chat-active-title"]')?.textContent?.trim() || '';
            const hash = window.location.hash || '';
            const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
            const session = new URLSearchParams(query).get('session');
            const bodyText = document.body?.innerText || '';
            return title === '新桌面对话' && !session && bodyText.includes('直接提问即可创建会话并开始对话')
              ? { title, session: session || '' }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 15000, label: 'new chat blank composer state' },
    );
    record('chat_new_session_blank_state', newChatBlankState);

    const messageSent = await window.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('[data-testid="desktop-chat-input"]');
        const send = document.querySelector('[data-testid="desktop-chat-send"]');
        if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || !(send instanceof HTMLButtonElement)) {
          return false;
        }
        const setter = input instanceof HTMLTextAreaElement
          ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'Reply with exactly OK.');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        send.click();
        return true;
      })()`,
      true,
    );
    if (!messageSent) {
      throw new Error('Smoke test could not send a desktop chat message');
    }
    record('chat_message_sent');

    const activeDesktopSessionId = await waitFor(
      async () => {
        const sessionId = await window.webContents.executeJavaScript(
          `(() => {
            const hash = window.location.hash || '';
            const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
            return new URLSearchParams(query).get('session');
          })()`,
          true,
        );
        return typeof sessionId === 'string' && sessionId ? sessionId : null;
      },
      { timeoutMs: 15000, label: 'active desktop session id after send' },
    );
    record('chat_session_created', { sessionId: activeDesktopSessionId });

    const typingVisible = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const bodyText = document.body?.innerText || '';
            return bodyText.includes('Agent is typing…') ? { visible: true } : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 10000, intervalMs: 200, label: 'typing indicator visible after send' },
    ).catch(() => ({ visible: false }));
    record('chat_typing_visible', typingVisible);

    const latestDesktopSessionDetail = async (sessionId = activeDesktopSessionId) => {
      const current = await buildRuntimeStatus(getBridgeAdapter().getState());
      if (!sessionId) {
        return null;
      }
      const detailResponse = await fetch(
        `${current.managementBaseUrl}/projects/desktop-demo/sessions/${sessionId}?history_limit=200`,
        {
          headers: {
            Authorization: `Bearer ${current.settings.managementToken}`,
          },
        },
      );
      if (!detailResponse.ok) {
        return null;
      }
      const detailPayload = (await detailResponse.json()) as {
        data?: { session_key?: string; history?: Array<{ role?: string; kind?: string; content?: string }> };
      };
      const history = detailPayload?.data?.history || [];
      const progressCount = history.filter(
        (entry: { role?: string; kind?: string; content?: string }) =>
          entry?.role === 'assistant' && entry?.kind === 'progress',
      ).length;
      const finalEntries = history.filter(
        (entry: { role?: string; kind?: string; content?: string }) =>
          entry?.role === 'assistant' && (!entry?.kind || entry?.kind === 'final'),
      );
      const reply = finalEntries.map((entry) => entry.content || '').filter(Boolean).pop();
      return {
        sessionId,
        sessionKey: detailPayload?.data?.session_key || '',
        progressCount,
        finalCount: finalEntries.length,
        reply,
      };
    };

    const assistantReply = await waitFor(
      async () => {
        const uiResult = await window.webContents.executeJavaScript(
          `(() => {
            const error = document.querySelector('[data-testid="desktop-chat-bridge-error"]')?.textContent?.trim();
            if (error) {
              return { source: 'ui', error };
            }
            const finalMessages = Array.from(document.querySelectorAll('[data-testid="desktop-chat-message"][data-role="assistant"][data-kind="final"]'));
            const progressMessages = Array.from(document.querySelectorAll('[data-testid="desktop-chat-message"][data-role="assistant"][data-kind="progress"]'));
            const reply = finalMessages.map((node) => node.textContent?.trim()).filter(Boolean).pop();
            return reply
              ? {
                  source: 'ui',
                  reply,
                  finalCount: finalMessages.length,
                  progressCount: progressMessages.length,
                  finalAfterProgress:
                    progressMessages.length === 0 ||
                    (progressMessages[progressMessages.length - 1].compareDocumentPosition(finalMessages[finalMessages.length - 1]) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
                }
              : null;
          })()`,
          true,
        );
        if (uiResult?.error || uiResult?.reply) {
          return uiResult || null;
        }
        const persistedResult = await latestDesktopSessionDetail();
        if (persistedResult?.reply) {
          return {
            source: 'persisted',
            reply: persistedResult.reply,
            finalCount: persistedResult.finalCount,
            progressCount: persistedResult.progressCount,
            sessionId: persistedResult.sessionId,
          };
        }
        return null;
      },
      { timeoutMs: 90000, intervalMs: 1000, label: 'assistant chat reply' },
    );
    if (assistantReply?.error) {
      throw new Error(`Desktop chat reported an error instead of a reply: ${assistantReply.error}`);
    }
    if (!assistantReply?.reply || String(assistantReply.reply).trim() === 'Reply with exactly OK.') {
      throw new Error(`Desktop chat returned unexpected final reply: ${assistantReply?.reply ?? 'missing'}`);
    }
    if (assistantReply?.finalAfterProgress === false) {
      throw new Error('Desktop chat rendered the final reply before progress messages');
    }
    record('chat_reply_received', {
      reply: assistantReply?.reply,
      progress_count: assistantReply?.progressCount ?? 0,
      source: assistantReply?.source,
    });

    await window.webContents.executeJavaScript('window.location.hash = "#/"; true;', true);
    await waitFor(
      async () => {
        const bodyText = await window.webContents.executeJavaScript('document.body?.innerText || ""', true);
        return typeof bodyText === 'string' && bodyText.includes('AI-WorkStation 运行时') ? bodyText : null;
      },
      { timeoutMs: 30000, label: 'dashboard rerender after reply' },
    );
    await window.webContents.executeJavaScript(`window.location.hash = "#/chat?project=desktop-demo&session=${activeDesktopSessionId}"; true;`, true);
    const completedTurnRestoredIdle = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const send = document.querySelector('[data-testid="desktop-chat-send"]');
            const stop = document.querySelector('[data-testid="desktop-chat-stop-task"]');
            const hint = document.querySelector('[data-testid="desktop-chat-task-hint"]')?.textContent?.trim() || '';
            return send instanceof HTMLButtonElement && !stop && !hint
              ? { restored: true }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 30000, label: 'completed turn stays idle after chat reload' },
    );
    record('chat_completed_turn_restored_idle', completedTurnRestoredIdle);

    const chatMessageOrderValid = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const messages = Array.from(document.querySelectorAll('[data-testid="desktop-chat-message"]')).map((node) => ({
              role: node.getAttribute('data-role') || '',
              kind: node.getAttribute('data-kind') || '',
              order: Number(node.getAttribute('data-order') || '0'),
              timestamp: node.getAttribute('data-timestamp') || '',
            }));
            const userOrders = messages.filter((message) => message.role === 'user').map((message) => message.order);
            const assistantOrders = messages
              .filter((message) => message.role === 'assistant' && (message.kind === 'progress' || message.kind === 'final'))
              .map((message) => message.order);
            if (!userOrders.length || !assistantOrders.length) {
              return null;
            }
            const lastUserOrder = userOrders[userOrders.length - 1];
            const firstAssistantAfterUser = assistantOrders.find((order) => order > lastUserOrder);
            const hasTimestamps = messages.every((message) => Boolean(message.timestamp));
            return firstAssistantAfterUser !== undefined && hasTimestamps
              ? { lastUserOrder, firstAssistantAfterUser, hasTimestamps }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 15000, label: 'chat messages remain ordered after reply' },
    );
    record('chat_message_order_valid', chatMessageOrderValid);

    const persistedProgressHistory = await waitFor(
      async () => {
        const detail = await latestDesktopSessionDetail();
        return detail && detail.finalCount > 0
          ? { progressCount: detail.progressCount, finalCount: detail.finalCount, sessionId: detail.sessionId }
          : null;
      },
      { timeoutMs: 15000, label: 'persisted assistant history' },
    );
    record('chat_progress_persisted', persistedProgressHistory);

    const normalizedPermissionButton = normalizeDesktopBridgeButtonOption({ Text: 'Allow', Data: 'perm:allow' });
    if (!normalizedPermissionButton || normalizedPermissionButton.text !== 'allow' || normalizedPermissionButton.data !== 'allow') {
      throw new Error('Permission button normalization did not produce lowercase allow');
    }
    if (!supportsInteractivePermission('claudecode') || !supportsInteractivePermission('opencode')) {
      throw new Error('Interactive permission support matrix is inconsistent');
    }
    record('chat_permission_normalization', {
      text: normalizedPermissionButton.text,
      data: normalizedPermissionButton.data,
    });

    const logicalConfigRaw = readFileSync(runtime.configFile.path, 'utf8');
    const generatedConfigPath = getServiceManager().getGeneratedConfigPath();
    const generatedConfigRaw = existsSync(generatedConfigPath) ? readFileSync(generatedConfigPath, 'utf8') : '';
    const logicalConfigKeptOpencode = logicalConfigRaw.includes('type = "opencode"') && !logicalConfigRaw.includes('type = "acp"');
    const runtimeConfigUsesAcpAdapter = generatedConfigRaw.includes('type = "acp"') &&
      generatedConfigRaw.includes('command = "opencode"') &&
      generatedConfigRaw.includes('"acp"');
    if (!logicalConfigKeptOpencode || !runtimeConfigUsesAcpAdapter) {
      throw new Error('Logical config/runtime adapter split is not preserved');
    }
    record('workspace_logical_agent_runtime_adapter_split', {
      logical_config_path: runtime.configFile.path,
      generated_config_path: generatedConfigPath,
    });

    const permissionSession = await waitFor(
      async () => {
        const detail = await latestDesktopSessionDetail();
        return detail?.sessionId && detail?.sessionKey ? detail : null;
      },
      { timeoutMs: 15000, label: 'active session detail for permission prompt' },
    );

    const permissionReplyCtx = `smoke-permission-${Date.now()}`;
    emitSmokeBridgeEvent({
      type: 'buttons',
      sessionKey: permissionSession.sessionKey,
      replyCtx: permissionReplyCtx,
      content: 'Permission required to continue. Choose how to proceed.',
      buttons: [
        [
          { Text: 'Allow', Data: 'perm:allow' },
          { Text: 'Deny', Data: 'perm:deny' },
        ],
        [{ Text: 'Allow all', Data: 'perm:allow_all' }],
      ],
    });
    record('chat_permission_prompt_injected', {
      sessionId: permissionSession.sessionId,
      sessionKey: permissionSession.sessionKey,
    });

    const supportedPermissionVisible = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const buttons = Array.from(document.querySelectorAll('[data-testid="desktop-chat-action-button"]'));
            const statuses = Array.from(document.querySelectorAll('[data-testid="desktop-chat-action-status"]')).map((node) => node.textContent?.trim() || '');
            const bodyText = document.body?.innerText || '';
            const labels = buttons.map((button) => button.textContent?.trim() || '');
            const unsupported = statuses.find((text) => text.includes('cannot continue interactive permission approvals'));
            return bodyText.includes('Permission required to continue.') && labels.includes('allow') && labels.includes('deny') && labels.includes('allow all') && !unsupported
              ? { labels }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 15000, label: 'interactive permission actions visible in chat' },
    );
    record('chat_permission_supported_visible', supportedPermissionVisible);

    const permissionAllowClicked = await window.webContents.executeJavaScript(
      `(() => {
        const buttons = Array.from(document.querySelectorAll('[data-testid="desktop-chat-action-button"]'));
        const target = buttons.find((button) => button.textContent?.trim() === 'allow');
        if (!(target instanceof HTMLButtonElement)) {
          return false;
        }
        target.click();
        return true;
      })()`,
      true,
    );
    if (!permissionAllowClicked) {
      throw new Error('Smoke test could not click allow for permission prompt');
    }
    record('chat_permission_allow_clicked');

    const permissionAllowSent = await waitFor(
      async () => {
        const sent = [...smokeBridgeSendInputs].reverse().find((input) => input.content === 'allow');
        return sent
          ? {
              content: sent.content,
              project: sent.project,
              chatId: sent.chatId,
            }
          : null;
      },
      { timeoutMs: 15000, label: 'permission allow bridge send' },
    );
    record('chat_permission_allow_sent', permissionAllowSent);

    emitSmokeBridgeEvent({
      type: 'reply',
      sessionKey: permissionSession.sessionKey,
      replyCtx: permissionReplyCtx,
      content: 'Permission accepted, continuing work.',
    });
    emitSmokeBridgeEvent({
      type: 'typing_stop',
      sessionKey: permissionSession.sessionKey,
      replyCtx: permissionReplyCtx,
    });

    emitSmokeBridgeEvent({
      type: 'typing_start',
      sessionKey: permissionSession.sessionKey,
      replyCtx: `smoke-stop-${Date.now()}`,
    });

    const stopButtonVisible = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const stop = document.querySelector('[data-testid="desktop-chat-stop-task"]');
            const hint = document.querySelector('[data-testid="desktop-chat-task-hint"]')?.textContent?.trim() || '';
            return stop instanceof HTMLButtonElement && hint
              ? { hint, text: stop.textContent?.trim() || '' }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 15000, label: 'stop task button visible while task running' },
    );
    record('chat_stop_button_visible', stopButtonVisible);

    const stopClicked = await window.webContents.executeJavaScript(
      `(() => {
        const stop = document.querySelector('[data-testid="desktop-chat-stop-task"]');
        if (!(stop instanceof HTMLButtonElement)) {
          return false;
        }
        stop.click();
        return true;
      })()`,
      true,
    );
    if (!stopClicked) {
      throw new Error('Smoke test could not click the stop task button');
    }
    record('chat_stop_clicked');

    const stopCommandSent = await waitFor(
      async () => {
        const sent = [...smokeBridgeSendInputs].reverse().find((input) => input.content === '/stop');
        return sent
          ? {
              content: sent.content,
              project: sent.project,
              chatId: sent.chatId,
            }
          : null;
      },
      { timeoutMs: 15000, label: 'stop command bridge send' },
    );
    record('chat_stop_command_sent', stopCommandSent);

    emitSmokeBridgeEvent({
      type: 'typing_stop',
      sessionKey: permissionSession.sessionKey,
      replyCtx: `smoke-stop-${Date.now()}`,
    });

    const stopResolved = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const send = document.querySelector('[data-testid="desktop-chat-send"]');
            const stop = document.querySelector('[data-testid="desktop-chat-stop-task"]');
            return send instanceof HTMLButtonElement && !stop
              ? { restored: true }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 15000, label: 'stop task restored send button' },
    );
    record('chat_stop_resolved', stopResolved);

    await window.webContents.executeJavaScript('window.location.hash = "#/"; true;', true);
    await waitFor(
      async () => {
        const bodyText = await window.webContents.executeJavaScript('document.body?.innerText || ""', true);
        return typeof bodyText === 'string' && bodyText.includes('AI-WorkStation 运行时') ? bodyText : null;
      },
      { timeoutMs: 30000, label: 'dashboard rerender after chat' },
    );
    await window.webContents.executeJavaScript('window.location.hash = "#/chat"; true;', true);
    await waitFor(
      async () => {
        const bodyText = await window.webContents.executeJavaScript('document.body?.innerText || ""', true);
        return typeof bodyText === 'string' && bodyText.includes('desktop-demo') ? bodyText : null;
      },
      { timeoutMs: 30000, label: 'chat rerender after history reload' },
    );
    const reloadedProgressVisible = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const progressMessages = Array.from(document.querySelectorAll('[data-testid="desktop-chat-message"][data-role="assistant"][data-kind="progress"]'));
            const finalMessages = Array.from(document.querySelectorAll('[data-testid="desktop-chat-message"][data-role="assistant"][data-kind="final"]'));
            return finalMessages.length > 0
              ? { progressCount: progressMessages.length, finalCount: finalMessages.length }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 30000, label: 'reloaded assistant history visible in chat' },
    );
    record('chat_progress_visible_after_reload', reloadedProgressVisible);

    await window.webContents.executeJavaScript(
      `window.location.hash = "#/sessions/desktop-demo/${activeDesktopSessionId}"; true;`,
      true,
    );
    await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const bodyText = document.body?.innerText || "";
            const project = document.querySelector('[data-testid="desktop-chat-project-select"]');
            const progressMessages = Array.from(document.querySelectorAll('[data-testid="desktop-chat-message"][data-kind="progress"]'));
            const finalMessages = Array.from(document.querySelectorAll('[data-testid="desktop-chat-message"][data-kind="final"]'));
            return bodyText.includes('桌面对话') && project instanceof HTMLSelectElement && project.value === 'desktop-demo' && finalMessages.length > 0
              ? { progressCount: progressMessages.length, finalCount: finalMessages.length }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 30000, label: 'sessions route redirected into desktop chat' },
    );
    record('sessions_route_redirected_to_chat');

    const renamedSessionName = `Smoke Session ${activeDesktopSessionId.slice(0, 6)}`;
    const renameOpened = await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('[data-testid="desktop-chat-session-rename"][data-session-id="${activeDesktopSessionId}"]');
        if (!(button instanceof HTMLButtonElement)) {
          return false;
        }
        button.click();
        return true;
      })()`,
      true,
    );
    if (!renameOpened) {
      throw new Error('Smoke test could not open the rename session modal');
    }
    record('chat_rename_opened');

    const renameApplied = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const input = document.querySelector('[data-testid="desktop-chat-rename-input"]');
            const save = document.querySelector('[data-testid="desktop-chat-rename-save"]');
            if (!(input instanceof HTMLInputElement) || !(save instanceof HTMLButtonElement)) {
              return null;
            }
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (input.value !== ${JSON.stringify(renamedSessionName)}) {
              setter?.call(input, ${JSON.stringify(renamedSessionName)});
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return null;
            }
            save.click();
            return { value: input.value };
          })()`,
          true,
        );
        return result?.value === renamedSessionName ? result : null;
      },
      { timeoutMs: 15000, label: 'rename session form submit' },
    );
    record('chat_rename_submitted', renameApplied);

    const renameVisible = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const title = document.querySelector('[data-testid="desktop-chat-active-title"]')?.textContent?.trim() || '';
            const row = document.querySelector('[data-testid="desktop-chat-session-row"][data-session-id="${activeDesktopSessionId}"]');
            const rowText = row?.textContent?.trim() || '';
            return title === ${JSON.stringify(renamedSessionName)} && rowText.includes(${JSON.stringify(renamedSessionName)})
              ? { title, rowText }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 15000, label: 'renamed session visible in chat list' },
    );
    record('chat_rename_visible', renameVisible);

    const renameSearchVisible = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const input = document.querySelector('[data-testid="desktop-chat-session-search"]');
            if (!(input instanceof HTMLInputElement)) {
              return null;
            }
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (input.value !== ${JSON.stringify(renamedSessionName)}) {
              setter?.call(input, ${JSON.stringify(renamedSessionName)});
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return null;
            }
            const rows = Array.from(document.querySelectorAll('[data-testid="desktop-chat-session-row"]'));
            return rows.length > 0 && rows.every((row) => (row.textContent || '').includes(${JSON.stringify(renamedSessionName)}))
              ? { count: rows.length }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 15000, label: 'session search filtered to renamed session' },
    );
    record('chat_search_filtered', renameSearchVisible);

    const renameSearchEmpty = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const input = document.querySelector('[data-testid="desktop-chat-session-search"]');
            if (!(input instanceof HTMLInputElement)) {
              return null;
            }
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (input.value !== '__definitely_missing_session__') {
              setter?.call(input, '__definitely_missing_session__');
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return null;
            }
            return (document.body?.innerText || '').includes('没有匹配的会话')
              ? { empty: true }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 15000, label: 'empty search state visible' },
    );
    record('chat_search_empty_state', renameSearchEmpty);

    const searchCleared = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const input = document.querySelector('[data-testid="desktop-chat-session-search"]');
            if (!(input instanceof HTMLInputElement)) {
              return null;
            }
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (input.value !== '') {
              setter?.call(input, '');
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return null;
            }
            const row = document.querySelector('[data-testid="desktop-chat-session-row"][data-session-id="${activeDesktopSessionId}"]');
            return row ? { restored: true } : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 15000, label: 'session search cleared' },
    );
    record('chat_search_cleared', searchCleared);

    const deleteOpened = await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('[data-testid="desktop-chat-session-delete"][data-session-id="${activeDesktopSessionId}"]');
        if (!(button instanceof HTMLButtonElement)) {
          return false;
        }
        button.click();
        return true;
      })()`,
      true,
    );
    if (!deleteOpened) {
      throw new Error('Smoke test could not open the delete session modal');
    }
    record('chat_delete_opened');

    const deleteConfirmed = await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('[data-testid="desktop-chat-delete-confirm"]');
        if (!(button instanceof HTMLButtonElement)) {
          return false;
        }
        button.click();
        return true;
      })()`,
      true,
    );
    if (!deleteConfirmed) {
      throw new Error('Smoke test could not confirm session deletion');
    }
    record('chat_delete_confirmed');

    const deleteApplied = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const row = document.querySelector('[data-testid="desktop-chat-session-row"][data-session-id="${activeDesktopSessionId}"]');
            const hash = window.location.hash || '';
            const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
            const currentSession = new URLSearchParams(query).get('session');
            return !row && currentSession !== ${JSON.stringify(activeDesktopSessionId)}
              ? { currentSession: currentSession || '', removed: true }
              : null;
          })()`,
          true,
        );
        return result || null;
      },
      { timeoutMs: 30000, label: 'deleted session removed from chat list' },
    );
    record('chat_delete_applied', deleteApplied);

    result.ok = true;
    result.finished_at = new Date().toISOString();
    result.runtime = await buildRuntimeStatus(getBridgeAdapter().getState());
    result.logs = getServiceManager().getLogs(200);
    writeSmokeResult(result);
    setTimeout(() => app.exit(0), 200);
  } catch (error) {
    result.ok = false;
    result.finished_at = new Date().toISOString();
    result.error = error instanceof Error ? error.stack || error.message : String(error);
    result.runtime = await buildRuntimeStatus(getBridgeAdapter().getState()).catch(() => null);
    result.logs = getServiceManager().getLogs(200);
    writeSmokeResult(result);
    setTimeout(() => app.exit(1), 200);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 780,
    show: false,
    title: 'AI-WorkStation',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    if (!smokeOutputPath) {
      mainWindow?.show();
    }
  });

  const devServerURL = process.env.AI_WORKSTATION_DEV_SERVER_URL;
  if (devServerURL) {
    void mainWindow.loadURL(devServerURL);
  } else {
    void mainWindow.loadFile(join(app.getAppPath(), 'dist/renderer/index.html'));
  }
}

function registerIPC() {
  ipcMain.handle('desktop:get-runtime-status', async () => {
    if (forceRuntimeStatusError) {
      throw new Error('Forced desktop runtime status failure for smoke testing');
    }
    return buildRuntimeStatus(getBridgeAdapter().getState());
  });
  ipcMain.handle('desktop:start-service', async () => {
    const result = await getServiceManager().start();
    if (result.status === 'running') {
      void getBridgeAdapter().connect();
    }
    await broadcastRuntime();
    return result;
  });
  ipcMain.handle('desktop:stop-service', async () => {
    getBridgeAdapter().disconnect();
    const result = await getServiceManager().stop();
    await broadcastRuntime();
    return result;
  });
  ipcMain.handle('desktop:restart-service', async () => {
    getBridgeAdapter().disconnect();
    const result = await getServiceManager().restart();
    if (result.status === 'running') {
      void getBridgeAdapter().connect();
    }
    await broadcastRuntime();
    return result;
  });
  ipcMain.handle('desktop:get-logs', (_event, limit?: number) => getServiceManager().getLogs(limit));
  ipcMain.handle('desktop:read-config', () => getServiceManager().readConfigState());
  ipcMain.handle('desktop:save-config-raw', (_event, raw: string) => getServiceManager().writeRawConfig(raw));
  ipcMain.handle('desktop:save-config-structured', (_event, config: DesktopConnectConfig) =>
    getServiceManager().writeStructuredConfig(config),
  );
  ipcMain.handle('desktop:get-thread-knowledge-bases', async (_event, workspaceId: string, threadId: string) =>
    getDesktopKnowledgeProvider().listThreadKnowledgeBaseIds(encodeThreadId(workspaceId, threadId)),
  );
  ipcMain.handle(
    'desktop:update-thread-knowledge-bases',
    async (_event, workspaceId: string, threadId: string, knowledgeBaseIds: string[]) =>
      getDesktopKnowledgeProvider().updateThreadKnowledgeBaseIds(
        encodeThreadId(workspaceId, threadId),
        Array.isArray(knowledgeBaseIds) ? knowledgeBaseIds : [],
      ),
  );
  ipcMain.handle('desktop:delete-thread-knowledge-bases', async (_event, workspaceId: string, threadId: string) =>
    getDesktopKnowledgeProvider().deleteThreadKnowledgeBaseLinks(encodeThreadId(workspaceId, threadId)),
  );
  ipcMain.handle('desktop:save-settings', async (_event, input: DesktopSettingsInput) => {
    const settings = getServiceManager().updateSettings(input);
    await broadcastRuntime();
    return settings;
  });
  ipcMain.handle('desktop:bridge-connect', async () => {
    const state = await getBridgeAdapter().connect();
    await broadcastRuntime();
    return state;
  });
  ipcMain.handle('desktop:bridge-disconnect', async () => {
    const state = getBridgeAdapter().disconnect();
    await broadcastRuntime();
    return state;
  });
  ipcMain.handle('desktop:bridge-send-message', (_event, input: DesktopBridgeSendInput) => {
    recordSmokeBridgeSend(input);
    return getBridgeAdapter().sendMessage(input);
  });
}

app.whenReady().then(async () => {
  serviceManager = new ServiceManager(app.getPath('userData'));
  bridgeAdapter = new BridgeAdapter(
    () => getServiceManager().getSettings(),
    () => getServiceManager().getServiceState().status === 'running',
  );
  desktopKnowledgeProvider = new AiVectorKnowledgeProvider({
    userDataPath: app.getPath('userData'),
    getConfig: () => getServiceManager().getSettings().knowledge,
    setConfig: async (input) => {
      const settings = getServiceManager().updateSettings({
        knowledge: input,
      });
      await broadcastRuntime();
      return settings.knowledge;
    },
  });
  localAiCoreBindings = createLocalAiCoreBindings();
  localAiCoreServer = new LocalAiCoreServer(localAiCoreBindings);

  registerIPC();
  createWindow();
  try {
    await localAiCoreServer.start();
  } catch (error: any) {
    if (error?.code === 'EADDRINUSE') {
      localAiCoreServer = null;
    } else {
      throw error;
    }
  }

  getServiceManager().on('state', () => {
    syncBridgeWithServiceState();
    void broadcastRuntime();
  });
  getServiceManager().on('logs', () => {
    void broadcastRuntime();
  });
  getBridgeAdapter().on('state', () => {
    void broadcastRuntime();
  });
  getBridgeAdapter().on('event', (payload) => {
    localAiCoreBindings?.emit('bridge', payload);
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('desktop:bridge', payload);
    });
  });

  const settings = getServiceManager().getSettings();
  if (settings.autoStartService) {
    const result = await getServiceManager().start();
    if (result.status === 'running') {
      void getBridgeAdapter().connect();
    }
  } else {
    await getServiceManager().ensureConfigFile();
  }

  await broadcastRuntime();
  void runSmokeTest();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    BrowserWindow.getAllWindows()[0]?.show();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  void localAiCoreServer?.stop().catch(() => undefined);
});
