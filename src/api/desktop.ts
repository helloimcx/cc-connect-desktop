import type {
  ConfigFileState,
  DesktopBridgeEvent,
  DesktopBridgeSendInput,
  DesktopBridgeSendResult,
  DesktopRuntimeStatus,
  DesktopSettings,
  DesktopSettingsInput,
} from '../../shared/desktop';
import {
  coreBridgeConnect,
  coreBridgeDisconnect,
  coreBridgeSendMessage,
  detectLocalAiCore,
  getCoreLogs,
  getCoreRuntime,
  onBridgeUpdated,
  onRuntimeUpdated,
  readCoreConfigFile,
  restartCoreService,
  saveCoreRawConfigFile,
  saveCoreSettings,
  saveCoreStructuredConfigFile,
  startCoreService,
  stopCoreService,
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
  saveSettings: (input: DesktopSettingsInput) => Promise<DesktopSettings>;
  bridgeConnect: () => Promise<unknown>;
  bridgeDisconnect: () => Promise<unknown>;
  bridgeSendMessage: (input: DesktopBridgeSendInput) => Promise<DesktopBridgeSendResult>;
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
  saveSettings: (input: DesktopSettingsInput) => requireDesktopBridge().saveSettings(input),
  bridgeConnect: () => requireDesktopBridge().bridgeConnect(),
  bridgeDisconnect: () => requireDesktopBridge().bridgeDisconnect(),
  bridgeSendMessage: (input: DesktopBridgeSendInput) => requireDesktopBridge().bridgeSendMessage(input),
  onRuntimeEvent: (listener) => requireDesktopBridge().onRuntimeEvent(listener),
  onBridgeEvent: (listener) => requireDesktopBridge().onBridgeEvent(listener),
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
  saveSettings: (input: DesktopSettingsInput) => saveCoreSettings(input),
  bridgeConnect: () => coreBridgeConnect(),
  bridgeDisconnect: () => coreBridgeDisconnect(),
  bridgeSendMessage: (input: DesktopBridgeSendInput) => coreBridgeSendMessage(input),
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
export const saveDesktopSettings = (input: DesktopSettingsInput): Promise<DesktopSettings> => requireProvider().saveSettings(input);
export const bridgeConnect = () => requireProvider().bridgeConnect();
export const bridgeDisconnect = () => requireProvider().bridgeDisconnect();
export const bridgeSendMessage = (input: DesktopBridgeSendInput): Promise<DesktopBridgeSendResult> => requireProvider().bridgeSendMessage(input);
export const onRuntimeEvent = (listener: (runtime: DesktopRuntimeStatus) => void) => requireProvider().onRuntimeEvent(listener);
export const onBridgeEvent = (listener: (event: DesktopBridgeEvent) => void) => requireProvider().onBridgeEvent(listener);
