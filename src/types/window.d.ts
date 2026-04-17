import type {
  ConfigFileState,
  DesktopBridgeEvent,
  DesktopBridgeSendInput,
  DesktopBridgeSendResult,
  DesktopRuntimeStatus,
  DesktopSettings,
  DesktopSettingsInput,
  DesktopServiceState,
} from '../../shared/desktop';
import type { WorkspaceStreamingProbeResult } from '../../packages/contracts/src';

declare global {
  interface Window {
    desktop?: {
      getRuntimeStatus: () => Promise<DesktopRuntimeStatus>;
      startService: () => Promise<DesktopServiceState>;
      stopService: () => Promise<DesktopServiceState>;
      restartService: () => Promise<DesktopServiceState>;
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
  }
}

export {};
