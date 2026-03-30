import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  DesktopConnectConfig,
  DesktopRuntimeStatus,
  DesktopSettingsInput,
} from '../shared/desktop.js';
import { ServiceManager } from './service-manager.js';
import { BridgeAdapter } from './bridge-adapter.js';

let mainWindow: InstanceType<typeof BrowserWindow> | null = null;
let serviceManager: ServiceManager;
let bridgeAdapter: BridgeAdapter;

const userDataOverride = process.env.CC_CONNECT_DESKTOP_USER_DATA_DIR?.trim();
const smokeOutputPath = process.env.CC_CONNECT_DESKTOP_SMOKE_OUTPUT?.trim();
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

function buildRuntimeStatus(bridge: ReturnType<BridgeAdapter['getState']>): Promise<DesktopRuntimeStatus> {
  return getServiceManager().getRuntimeStatus().then((runtime) => ({
    ...runtime,
    bridge,
  }));
}

async function broadcastRuntime() {
  const runtime = await buildRuntimeStatus(getBridgeAdapter().getState());
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

    await waitFor(
      async () => {
        const bodyText = await window.webContents.executeJavaScript('document.body?.innerText || ""', true);
        return typeof bodyText === 'string' && bodyText.includes('Desktop Runtime') ? bodyText : null;
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
          const target = buttons.find((button) => button.textContent?.includes('Start'));
          if (!target) return false;
          target.click();
          return true;
        })()`,
        true,
      );
      if (!clicked) {
        throw new Error('Smoke test could not find Start button');
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
            return Boolean(input && send && project instanceof HTMLSelectElement && project.value);
          })()`,
          true,
        );
        return ready ? true : null;
      },
      { timeoutMs: 30000, label: 'chat composer ready' },
    );
    record('chat_composer_ready');

    const messageSent = await window.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('[data-testid="desktop-chat-input"]');
        const send = document.querySelector('[data-testid="desktop-chat-send"]');
        if (!(input instanceof HTMLInputElement) || !(send instanceof HTMLButtonElement)) {
          return false;
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
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

    const assistantReply = await waitFor(
      async () => {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const error = document.querySelector('[data-testid="desktop-chat-bridge-error"]')?.textContent?.trim();
            if (error) {
              return { error };
            }
            const finalMessages = Array.from(document.querySelectorAll('[data-testid="desktop-chat-message"][data-role="assistant"][data-kind="final"]'));
            const progressMessages = Array.from(document.querySelectorAll('[data-testid="desktop-chat-message"][data-role="assistant"][data-kind="progress"]'));
            const reply = finalMessages.map((node) => node.textContent?.trim()).filter(Boolean).pop();
            return reply
              ? {
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
        return result || null;
      },
      { timeoutMs: 90000, intervalMs: 1000, label: 'assistant chat reply' },
    );
    if (assistantReply?.error) {
      throw new Error(`Desktop chat reported an error instead of a reply: ${assistantReply.error}`);
    }
    if (assistantReply?.finalCount !== 1) {
      throw new Error(`Desktop chat rendered ${assistantReply?.finalCount ?? 0} final assistant messages for a single turn`);
    }
    if (assistantReply?.finalAfterProgress === false) {
      throw new Error('Desktop chat rendered the final reply before progress messages');
    }
    record('chat_reply_received', {
      reply: assistantReply?.reply,
      progress_count: assistantReply?.progressCount ?? 0,
    });

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
    title: 'cc-connect Desktop',
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

  const devServerURL = process.env.CC_CONNECT_DESKTOP_DEV_SERVER_URL;
  if (devServerURL) {
    void mainWindow.loadURL(devServerURL);
  } else {
    void mainWindow.loadFile(join(app.getAppPath(), 'dist/renderer/index.html'));
  }
}

function registerIPC() {
  ipcMain.handle('desktop:get-runtime-status', async () => buildRuntimeStatus(getBridgeAdapter().getState()));
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
  ipcMain.handle('desktop:bridge-send-message', (_event, input) => getBridgeAdapter().sendMessage(input));
}

app.whenReady().then(async () => {
  serviceManager = new ServiceManager(app.getPath('userData'));
  bridgeAdapter = new BridgeAdapter(
    () => getServiceManager().getSettings(),
    () => getServiceManager().getServiceState().status === 'running',
  );

  registerIPC();
  createWindow();

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
