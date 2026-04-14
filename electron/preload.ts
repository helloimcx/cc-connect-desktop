import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopBridgeEvent,
  DesktopBridgeSendInput,
  DesktopSettingsInput,
} from '../shared/desktop.js';

contextBridge.exposeInMainWorld('desktop', {
  getRuntimeStatus: () => ipcRenderer.invoke('desktop:get-runtime-status'),
  startService: () => ipcRenderer.invoke('desktop:start-service'),
  stopService: () => ipcRenderer.invoke('desktop:stop-service'),
  restartService: () => ipcRenderer.invoke('desktop:restart-service'),
  getLogs: (limit?: number) => ipcRenderer.invoke('desktop:get-logs', limit),
  readConfigFile: () => ipcRenderer.invoke('desktop:read-config'),
  saveRawConfigFile: (raw: string) => ipcRenderer.invoke('desktop:save-config-raw', raw),
  saveStructuredConfigFile: (config: unknown) => ipcRenderer.invoke('desktop:save-config-structured', config),
  getThreadKnowledgeBases: (workspaceId: string, threadId: string) =>
    ipcRenderer.invoke('desktop:get-thread-knowledge-bases', workspaceId, threadId),
  updateThreadKnowledgeBases: (workspaceId: string, threadId: string, knowledgeBaseIds: string[]) =>
    ipcRenderer.invoke('desktop:update-thread-knowledge-bases', workspaceId, threadId, knowledgeBaseIds),
  deleteThreadKnowledgeBases: (workspaceId: string, threadId: string) =>
    ipcRenderer.invoke('desktop:delete-thread-knowledge-bases', workspaceId, threadId),
  saveSettings: (input: DesktopSettingsInput) => ipcRenderer.invoke('desktop:save-settings', input),
  bridgeConnect: () => ipcRenderer.invoke('desktop:bridge-connect'),
  bridgeDisconnect: () => ipcRenderer.invoke('desktop:bridge-disconnect'),
  bridgeSendMessage: (input: DesktopBridgeSendInput) => ipcRenderer.invoke('desktop:bridge-send-message', input),
  onRuntimeEvent: (listener: (runtime: any) => void) => {
    const wrapped = (_event: unknown, payload: any) => listener(payload);
    ipcRenderer.on('desktop:runtime', wrapped);
    return () => ipcRenderer.removeListener('desktop:runtime', wrapped);
  },
  onBridgeEvent: (listener: (event: DesktopBridgeEvent) => void) => {
    const wrapped = (_event: unknown, payload: DesktopBridgeEvent) => listener(payload);
    ipcRenderer.on('desktop:bridge', wrapped);
    return () => ipcRenderer.removeListener('desktop:bridge', wrapped);
  },
});
