import type {
  ConfigFileState,
  DesktopBridgeEvent,
  DesktopBridgeSendInput,
  DesktopBridgeSendResult,
  DesktopRuntimeStatus,
  DesktopSettings,
  DesktopSettingsInput,
} from '../../shared/desktop';
import { isDesktopApp } from '@/app/runtime';

function requireDesktop() {
  if (!window.desktop) {
    throw new Error('Desktop APIs are unavailable in the browser build');
  }
  return window.desktop;
}

export const getRuntimeStatus = (): Promise<DesktopRuntimeStatus> => requireDesktop().getRuntimeStatus();
export const startDesktopService = () => requireDesktop().startService();
export const stopDesktopService = () => requireDesktop().stopService();
export const restartDesktopService = () => requireDesktop().restartService();
export const getDesktopLogs = (limit?: number) => requireDesktop().getLogs(limit);
export const readConfigFile = (): Promise<ConfigFileState> => requireDesktop().readConfigFile();
export const saveRawConfigFile = (raw: string): Promise<ConfigFileState> => requireDesktop().saveRawConfigFile(raw);
export const saveStructuredConfigFile = (config: unknown): Promise<ConfigFileState> =>
  requireDesktop().saveStructuredConfigFile(config);
export const saveDesktopSettings = (input: DesktopSettingsInput): Promise<DesktopSettings> =>
  requireDesktop().saveSettings(input);
export const bridgeConnect = () => requireDesktop().bridgeConnect();
export const bridgeDisconnect = () => requireDesktop().bridgeDisconnect();
export const bridgeSendMessage = (input: DesktopBridgeSendInput): Promise<DesktopBridgeSendResult> =>
  requireDesktop().bridgeSendMessage(input);
export const onRuntimeEvent = (listener: (runtime: DesktopRuntimeStatus) => void) =>
  requireDesktop().onRuntimeEvent(listener);
export const onBridgeEvent = (listener: (event: DesktopBridgeEvent) => void) =>
  requireDesktop().onBridgeEvent(listener);
