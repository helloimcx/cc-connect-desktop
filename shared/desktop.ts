export const DEFAULT_DESKTOP_AGENT_TYPE = 'opencode';
export const DEFAULT_DESKTOP_OPENCODE_MODEL = 'opencode/minimax-m2.5-free';

export type DesktopServiceStatus = 'stopped' | 'starting' | 'running' | 'error';
export type DesktopBridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface DesktopSettings {
  binaryPath: string;
  configPath: string;
  autoStartService: boolean;
  defaultProject: string;
  managementPort: number;
  managementToken: string;
  bridgePort: number;
  bridgeToken: string;
  bridgePath: string;
}

export interface DesktopServiceState {
  status: DesktopServiceStatus;
  pid?: number;
  startedAt?: string;
  lastError?: string;
}

export interface DesktopBridgeState {
  status: DesktopBridgeStatus;
  lastError?: string;
  connectedAt?: string;
}

export interface DesktopRuntimeStatus {
  mode: 'desktop';
  service: DesktopServiceState;
  bridge: DesktopBridgeState;
  settings: DesktopSettings;
  managementBaseUrl: string;
  configFile: ConfigFileState;
  logs: string[];
}

export interface DesktopBridgeSendInput {
  project: string;
  chatId: string;
  content: string;
  userId?: string;
  userName?: string;
}

export interface DesktopBridgeSendResult {
  messageId: string;
  sessionKey: string;
}

export interface DesktopBridgeEvent {
  type:
    | 'register_ack'
    | 'reply'
    | 'preview_start'
    | 'update_message'
    | 'delete_message'
    | 'typing_start'
    | 'typing_stop'
    | 'card'
    | 'buttons'
    | 'status';
  sessionKey?: string;
  replyCtx?: string;
  previewHandle?: string;
  content?: string;
  messageId?: string;
  ok?: boolean;
  error?: string;
  card?: Record<string, unknown>;
  buttons?: unknown;
}

export interface DesktopRuntimeEvent {
  type: 'runtime';
  runtime: DesktopRuntimeStatus;
}

export interface DesktopSettingsInput {
  binaryPath?: string;
  configPath?: string;
  autoStartService?: boolean;
  defaultProject?: string;
}

export interface DesktopPlatformConfig {
  type: string;
  options?: Record<string, unknown>;
}

export interface DesktopProviderConfig {
  name: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  thinking?: string;
  env?: Record<string, string>;
}

export interface DesktopProjectConfig {
  name: string;
  agent: {
    type: string;
    options?: Record<string, unknown>;
    providers?: DesktopProviderConfig[];
  };
  platforms: DesktopPlatformConfig[];
  admin_from?: string;
  disabled_commands?: string[];
}

export interface DesktopConnectConfig {
  data_dir?: string;
  language?: string;
  bridge?: Record<string, unknown>;
  management?: Record<string, unknown>;
  projects?: DesktopProjectConfig[];
  [key: string]: unknown;
}

export interface ConfigFileState {
  path: string;
  exists: boolean;
  raw: string;
  parsed: DesktopConnectConfig | null;
  error?: string;
}
