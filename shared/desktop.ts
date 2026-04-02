export const DEFAULT_DESKTOP_AGENT_TYPE = 'opencode';
export const DEFAULT_DESKTOP_OPENCODE_MODEL = 'opencode/minimax-m2.5-free';
export const DEFAULT_DESKTOP_CLAUDECODE_MODEL = '';
export const DESKTOP_AGENT_TYPE_OPTIONS = [
  'opencode',
  'codex',
  'claudecode',
  'cursor',
  'gemini',
  'qoder',
  'iflow',
] as const;
export const DESKTOP_PLATFORM_TYPE_OPTIONS = [
  'telegram',
  'feishu',
  'lark',
  'discord',
  'slack',
  'dingtalk',
  'wecom',
  'weixin',
  'qq',
  'qqbot',
  'line',
] as const;
export const DESKTOP_PROVIDER_PRESET_OPTIONS = [
  'openai',
  'openrouter',
  'anthropic',
  'minimax',
  'zhipuai',
  'deepseek',
  'siliconflow',
  'moonshot',
  'ollama',
] as const;
export const DESKTOP_PROVIDER_THINKING_OPTIONS = ['', 'enabled', 'disabled'] as const;
export const DESKTOP_INTERACTIVE_PERMISSION_AGENT_TYPES = ['claudecode', 'acp'] as const;

const PERMISSION_RESPONSE_MAP: Record<string, 'allow' | 'deny' | 'allow all'> = {
  allow: 'allow',
  deny: 'deny',
  'allow all': 'allow all',
  allowall: 'allow all',
  'perm:allow': 'allow',
  'perm:deny': 'deny',
  'perm:allow_all': 'allow all',
};

export type DesktopServiceStatus = 'stopped' | 'starting' | 'running' | 'error';
export type DesktopBridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type DesktopRuntimePhase = 'stopped' | 'starting' | 'api_ready' | 'bridge_ready' | 'error';

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
  phase: DesktopRuntimePhase;
  pendingRestart: boolean;
  service: DesktopServiceState;
  bridge: DesktopBridgeState;
  settings: DesktopSettings;
  managementBaseUrl: string;
  configFile: ConfigFileState;
  logs: string[];
}

export function deriveDesktopRuntimePhase(
  service: DesktopServiceState,
  bridge: DesktopBridgeState,
): DesktopRuntimePhase {
  if (service.status === 'error' || bridge.status === 'error') {
    return 'error';
  }
  if (service.status === 'stopped') {
    return 'stopped';
  }
  if (service.status === 'starting') {
    return 'starting';
  }
  if (bridge.status === 'connected') {
    return 'bridge_ready';
  }
  return 'api_ready';
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

export interface DesktopBridgeButtonOption {
  text: string;
  data: string;
}

export function getDefaultDesktopAgentModel(agentType?: string | null) {
  switch (String(agentType || '').trim().toLowerCase()) {
    case 'opencode':
      return DEFAULT_DESKTOP_OPENCODE_MODEL;
    case 'claudecode':
      return DEFAULT_DESKTOP_CLAUDECODE_MODEL;
    default:
      return '';
  }
}

export function normalizeDesktopAgentModel(agentType?: string | null, model?: string | null) {
  const normalizedType = String(agentType || '').trim().toLowerCase();
  const normalizedModel = String(model || '').trim();
  if (!normalizedType) {
    return normalizedModel;
  }
  if (normalizedType === 'opencode') {
    return normalizedModel || DEFAULT_DESKTOP_OPENCODE_MODEL;
  }
  if (normalizedType === 'claudecode' && normalizedModel.startsWith('opencode/')) {
    return '';
  }
  return normalizedModel;
}

export function normalizePermissionResponse(input?: string | null) {
  if (!input) {
    return null;
  }
  return PERMISSION_RESPONSE_MAP[String(input).trim().toLowerCase()] || null;
}

export function isPermissionButtonOption(option?: Pick<DesktopBridgeButtonOption, 'data'> | null) {
  return Boolean(normalizePermissionResponse(option?.data));
}

export function normalizeDesktopBridgeButtonOption(input: unknown): DesktopBridgeButtonOption | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Record<string, unknown>;
  const rawText = typeof record.text === 'string'
    ? record.text
    : typeof record.Text === 'string'
      ? record.Text
      : '';
  const rawData = typeof record.data === 'string'
    ? record.data
    : typeof record.Data === 'string'
      ? record.Data
      : '';
  if (!rawText || !rawData) {
    return null;
  }
  const permissionResponse = normalizePermissionResponse(rawData);
  if (permissionResponse) {
    return {
      text: permissionResponse,
      data: permissionResponse,
    };
  }
  return {
    text: rawText,
    data: rawData,
  };
}

export function supportsInteractivePermission(agentType?: string | null) {
  if (!agentType) {
    return false;
  }
  return (DESKTOP_INTERACTIVE_PERMISSION_AGENT_TYPES as readonly string[]).includes(String(agentType).trim().toLowerCase());
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
  buttonRows?: DesktopBridgeButtonOption[][];
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

export interface DesktopProviderModelConfig {
  model: string;
  alias?: string;
}

export interface DesktopProviderConfig {
  name: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  models?: DesktopProviderModelConfig[];
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
