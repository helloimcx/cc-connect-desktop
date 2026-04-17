import type {
  ConfigFileState,
  DesktopBridgeEvent,
  DesktopBridgeSendInput,
  DesktopBridgeSendResult,
  DesktopRuntimeStatus,
  DesktopSettings,
  DesktopSettingsInput,
} from '../../shared/desktop';
import type { WorkspaceStreamingProbeResult } from '../../packages/contracts/src';
import {
  coreBridgeConnect,
  coreBridgeDisconnect,
  coreBridgeSendMessage,
  detectLocalAiCore,
  getThread as getCoreThread,
  getCoreLogs,
  getCoreRuntime,
  onBridgeUpdated,
  onRuntimeUpdated,
  probeWorkspaceStreaming as probeCoreWorkspaceStreaming,
  readCoreConfigFile,
  restartCoreService,
  saveCoreRawConfigFile,
  saveCoreSettings,
  saveCoreStructuredConfigFile,
  startCoreService,
  stopCoreService,
  updateThreadKnowledgeBases as updateCoreThreadKnowledgeBases,
} from '../../packages/core-sdk/src';
import { getRuntimeProvider, setRuntimeProvider, type RuntimeProvider } from '@/app/runtime';

type DesktopProvider = {
  getRuntimeStatus: () => Promise<DesktopRuntimeStatus>;
  startService: () => Promise<unknown>;
  stopService: () => Promise<unknown>;
  restartService: () => Promise<unknown>;
  getLogs: (limit?: number) => Promise<string[]>;
  readConfigFile: () => Promise<ConfigFileState>;
  saveRawConfigFile: (raw: string) => Promise<ConfigFileState>;
  saveStructuredConfigFile: (config: unknown) => Promise<ConfigFileState>;
  getThreadKnowledgeBases: (workspaceId: string, threadId: string) => Promise<string[]>;
  updateThreadKnowledgeBases: (workspaceId: string, threadId: string, knowledgeBaseIds: string[]) => Promise<string[]>;
  deleteThreadKnowledgeBases: (workspaceId: string, threadId: string) => Promise<{ deleted: boolean }>;
  saveSettings: (input: DesktopSettingsInput) => Promise<DesktopSettings>;
  bridgeConnect: () => Promise<unknown>;
  bridgeDisconnect: () => Promise<unknown>;
  bridgeSendMessage: (input: DesktopBridgeSendInput) => Promise<DesktopBridgeSendResult>;
  probeWorkspaceStreaming: (workspaceId: string) => Promise<WorkspaceStreamingProbeResult>;
  onRuntimeEvent: (listener: (runtime: DesktopRuntimeStatus) => void) => () => void;
  onBridgeEvent: (listener: (event: DesktopBridgeEvent) => void) => () => void;
};

function requireDesktopBridge() {
  if (!window.desktop) {
    throw new Error('Desktop APIs are unavailable in the browser build');
  }
  return window.desktop;
}

const electronProvider: DesktopProvider = {
  getRuntimeStatus: () => requireDesktopBridge().getRuntimeStatus(),
  startService: () => requireDesktopBridge().startService(),
  stopService: () => requireDesktopBridge().stopService(),
  restartService: () => requireDesktopBridge().restartService(),
  getLogs: (limit?: number) => requireDesktopBridge().getLogs(limit),
  readConfigFile: () => requireDesktopBridge().readConfigFile(),
  saveRawConfigFile: (raw: string) => requireDesktopBridge().saveRawConfigFile(raw),
  saveStructuredConfigFile: (config: unknown) => requireDesktopBridge().saveStructuredConfigFile(config),
  getThreadKnowledgeBases: (workspaceId: string, threadId: string) =>
    requireDesktopBridge().getThreadKnowledgeBases(workspaceId, threadId),
  updateThreadKnowledgeBases: (workspaceId: string, threadId: string, knowledgeBaseIds: string[]) =>
    requireDesktopBridge().updateThreadKnowledgeBases(workspaceId, threadId, knowledgeBaseIds),
  deleteThreadKnowledgeBases: (workspaceId: string, threadId: string) =>
    requireDesktopBridge().deleteThreadKnowledgeBases(workspaceId, threadId),
  saveSettings: (input: DesktopSettingsInput) => requireDesktopBridge().saveSettings(input),
  bridgeConnect: () => requireDesktopBridge().bridgeConnect(),
  bridgeDisconnect: () => requireDesktopBridge().bridgeDisconnect(),
  bridgeSendMessage: (input: DesktopBridgeSendInput) => requireDesktopBridge().bridgeSendMessage(input),
  probeWorkspaceStreaming: (workspaceId: string) => requireDesktopBridge().probeWorkspaceStreaming(workspaceId),
  onRuntimeEvent: (listener) => requireDesktopBridge().onRuntimeEvent(listener),
  onBridgeEvent: (listener) => onBridgeUpdated(listener),
};

const localCoreProvider: DesktopProvider = {
  getRuntimeStatus: () => getCoreRuntime(),
  startService: () => startCoreService(),
  stopService: () => stopCoreService(),
  restartService: () => restartCoreService(),
  getLogs: (limit?: number) => getCoreLogs(limit),
  readConfigFile: () => readCoreConfigFile(),
  saveRawConfigFile: (raw: string) => saveCoreRawConfigFile(raw),
  saveStructuredConfigFile: (config: unknown) => saveCoreStructuredConfigFile(config),
  getThreadKnowledgeBases: (_workspaceId: string, threadId: string) =>
    getCoreThread(threadId).then((thread) => thread.selectedKnowledgeBaseIds || []),
  updateThreadKnowledgeBases: (_workspaceId: string, threadId: string, knowledgeBaseIds: string[]) =>
    updateCoreThreadKnowledgeBases(threadId, knowledgeBaseIds).then((result) => result.knowledgeBaseIds),
  deleteThreadKnowledgeBases: (_workspaceId: string, threadId: string) =>
    updateCoreThreadKnowledgeBases(threadId, []).then(() => ({ deleted: true })),
  saveSettings: (input: DesktopSettingsInput) => saveCoreSettings(input),
  bridgeConnect: () => coreBridgeConnect(),
  bridgeDisconnect: () => coreBridgeDisconnect(),
  bridgeSendMessage: (input: DesktopBridgeSendInput) => coreBridgeSendMessage(input),
  probeWorkspaceStreaming: (workspaceId: string) => probeCoreWorkspaceStreaming(workspaceId),
  onRuntimeEvent: (listener) => onRuntimeUpdated(listener),
  onBridgeEvent: (listener) => onBridgeUpdated(listener),
};

let activeProvider: DesktopProvider | null = null;

function providerFor(kind: RuntimeProvider): DesktopProvider | null {
  if (kind === 'electron') {
    return window.desktop ? electronProvider : null;
  }
  if (kind === 'local_core') {
    return localCoreProvider;
  }
  return null;
}

async function detectProvider() {
  if (window.desktop) {
    setRuntimeProvider('electron');
    activeProvider = electronProvider;
    return activeProvider;
  }
  if (await detectLocalAiCore()) {
    setRuntimeProvider('local_core');
    activeProvider = localCoreProvider;
    return activeProvider;
  }
  setRuntimeProvider('web_remote');
  activeProvider = null;
  return null;
}

function requireProvider() {
  const provider = activeProvider || providerFor(getRuntimeProvider());
  if (!provider) {
    throw new Error('Managed desktop APIs are unavailable in this build');
  }
  activeProvider = provider;
  return provider;
}

export async function initializeDesktopProvider() {
  return detectProvider();
}

export const getRuntimeStatus = (): Promise<DesktopRuntimeStatus> => requireProvider().getRuntimeStatus();
export const startDesktopService = () => requireProvider().startService();
export const stopDesktopService = () => requireProvider().stopService();
export const restartDesktopService = () => requireProvider().restartService();
export const getDesktopLogs = (limit?: number) => requireProvider().getLogs(limit);
export const readConfigFile = (): Promise<ConfigFileState> => requireProvider().readConfigFile();
export const saveRawConfigFile = (raw: string): Promise<ConfigFileState> => requireProvider().saveRawConfigFile(raw);
export const saveStructuredConfigFile = (config: unknown): Promise<ConfigFileState> => requireProvider().saveStructuredConfigFile(config);
export const getThreadKnowledgeBases = (workspaceId: string, threadId: string): Promise<string[]> =>
  requireProvider().getThreadKnowledgeBases(workspaceId, threadId);
export const updateThreadKnowledgeBases = (
  workspaceId: string,
  threadId: string,
  knowledgeBaseIds: string[],
): Promise<string[]> => requireProvider().updateThreadKnowledgeBases(workspaceId, threadId, knowledgeBaseIds);
export const deleteThreadKnowledgeBases = (workspaceId: string, threadId: string): Promise<{ deleted: boolean }> =>
  requireProvider().deleteThreadKnowledgeBases(workspaceId, threadId);
export const saveDesktopSettings = (input: DesktopSettingsInput): Promise<DesktopSettings> => requireProvider().saveSettings(input);
export const bridgeConnect = () => requireProvider().bridgeConnect();
export const bridgeDisconnect = () => requireProvider().bridgeDisconnect();
export const bridgeSendMessage = (input: DesktopBridgeSendInput): Promise<DesktopBridgeSendResult> => requireProvider().bridgeSendMessage(input);
export const probeWorkspaceStreaming = (workspaceId: string): Promise<WorkspaceStreamingProbeResult> =>
  requireProvider().probeWorkspaceStreaming(workspaceId);
export const onRuntimeEvent = (listener: (runtime: DesktopRuntimeStatus) => void) => requireProvider().onRuntimeEvent(listener);
export const onBridgeEvent = (listener: (event: DesktopBridgeEvent) => void) => requireProvider().onBridgeEvent(listener);
