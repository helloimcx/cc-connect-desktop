export const DEFAULT_DESKTOP_AGENT_TYPE = 'pi';
export const DEFAULT_DESKTOP_OPENCODE_MODEL = 'opencode/minimax-m2.5-free';
export const DEFAULT_DESKTOP_CLAUDECODE_MODEL = '';
export const DESKTOP_PI_ACP_PACKAGE = 'pi-acp';
export const DESKTOP_PI_CODING_AGENT_PACKAGE = '@mariozechner/pi-coding-agent';
export const DESKTOP_CODEX_ACP_PACKAGE = '@zed-industries/codex-acp';
export const DESKTOP_CLAUDECODE_ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp';
export const DESKTOP_LARK_SDK_PACKAGE = '@larksuiteoapi/node-sdk';
export const DESKTOP_AGENT_TYPE_OPTIONS = [
  'pi',
  'opencode',
  'codex',
  'claudecode',
  'cursor',
  'gemini',
  'qoder',
  'iflow',
  'hermes',
  'localcore-acp',
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
export const DESKTOP_INTERACTIVE_PERMISSION_AGENT_TYPES = ['pi', 'opencode', 'codex', 'claudecode', 'hermes', 'acp', 'localcore-acp'] as const;
export const LOCALCORE_ACP_AGENT_TYPE = 'localcore-acp';

const PERMISSION_RESPONSE_MAP: Record<string, 'allow' | 'deny' | 'allow all'> = {
  allow: 'allow',
  deny: 'deny',
  'allow all': 'allow all',
  allowall: 'allow all',
  allow_all: 'allow all',
  allow_always: 'allow all',
  always: 'allow all',
  always_allow: 'allow all',
  'always allow': 'allow all',
  'allow always': 'allow all',
  '始终允许': 'allow all',
  '永久允许': 'allow all',
  'perm:allow': 'allow',
  'perm:deny': 'deny',
  'perm:allow_all': 'allow all',
  'perm:allow_always': 'allow all',
  'perm:always': 'allow all',
};

export type DesktopServiceStatus = 'stopped' | 'starting' | 'running' | 'error';
export type DesktopRuntimePhase = 'stopped' | 'starting' | 'api_ready' | 'error';

export interface DesktopSettings {
  binaryPath: string;
  /** @deprecated Project runtime config is stored in local-core.db. */
  configPath?: string;
  autoStartService: boolean;
  defaultProject: string;
  managementPort: number;
  managementToken: string;
  bridgePort: number;
  bridgeToken: string;
  bridgePath: string;
  plugins: Record<string, DesktopPluginSettings>;
}

export interface DesktopServiceState {
  status: DesktopServiceStatus;
  pid?: number;
  startedAt?: string;
  lastError?: string;
}

export interface DesktopRuntimeRoleState {
  status: DesktopServiceStatus;
  label: string;
  lastError?: string;
  service?: DesktopServiceState;
}

export interface DesktopRuntimeRoles {
  conversation: DesktopRuntimeRoleState;
  platformGateway: DesktopRuntimeRoleState;
  larkGateway?: DesktopRuntimeRoleState;
}

export interface DesktopRuntimeStatus {
  mode: 'desktop';
  phase: DesktopRuntimePhase;
  pendingRestart: boolean;
  service: DesktopServiceState;
  roles: DesktopRuntimeRoles;
  settings: DesktopSettings;
  runtimeConfig: RuntimeConfigState;
  logs: string[];
  pluginDiagnostics?: DesktopRuntimePluginDiagnostics;
}

export interface DesktopRuntimePluginDiagnostics {
  pluginCount: number;
  enabledPluginCount: number;
  plugins: DesktopRuntimePluginDiagnostic[];
}

export interface DesktopRuntimePluginDiagnostic {
  pluginId: string;
  enabled: boolean;
  manifest: {
    id: string;
    kind: string;
    version: string;
    dependsOn?: string[];
    provides: string[];
    configSchema?: {
      fields: Array<{
        key: string;
        type: string;
        label?: string;
        description?: string;
        defaultValue?: unknown;
      }>;
    };
  };
  health: {
    status: 'healthy' | 'degraded' | 'failed';
    summary?: string;
    details?: Record<string, unknown>;
  };
}

export function deriveDesktopRuntimePhase(service: DesktopServiceState): DesktopRuntimePhase {
  if (service.status === 'starting') {
    return 'starting';
  }
  return 'api_ready';
}

export function deriveDesktopRuntimeRoles(service: DesktopServiceState): DesktopRuntimeRoles {
  return {
    conversation: {
      status: 'running',
      label: 'Local AI Core',
    },
    platformGateway: {
      status: service.status,
      label: 'Native Platform Gateway',
      service,
    },
  };
}

export function normalizeDesktopPlatformType(platformType?: string | null) {
  const normalized = String(platformType || '').trim().toLowerCase();
  if (normalized === 'feishu') {
    return 'lark';
  }
  return normalized;
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
  const normalized = String(input).trim().toLowerCase();
  const mapped = PERMISSION_RESPONSE_MAP[normalized];
  if (mapped) {
    return mapped;
  }
  if (
    normalized.includes('allow_all') ||
    normalized.includes('allow-always') ||
    normalized.includes('allow_always') ||
    normalized.includes('allow always') ||
    normalized.includes('always allow') ||
    normalized.includes('allow all') ||
    normalized.includes('始终允许') ||
    normalized.includes('永久允许')
  ) {
    return 'allow all';
  }
  if (normalized.startsWith('reject') || normalized.startsWith('deny')) {
    return 'deny';
  }
  if (normalized.startsWith('allow')) {
    return 'allow';
  }
  return null;
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

export function isAcpAgentType(agentType?: string | null) {
  const normalized = String(agentType || '').trim().toLowerCase();
  return normalized === 'acp'
    || normalized === 'pi'
    || normalized === 'opencode'
    || normalized === 'codex'
    || normalized === 'claudecode'
    || normalized === 'hermes'
    || normalized === LOCALCORE_ACP_AGENT_TYPE;
}

export interface DesktopBridgeToolCall {
  id?: string;
  name: string;
  status: string;
  input?: unknown;
  output: string;
  label?: string;
  detail?: string;
}

export type DesktopBridgeEventKind =
  | 'assistant'
  | 'thought'
  | 'plan'
  | 'tool'
  | 'status'
  | 'permission';

export type DesktopBridgeStatus =
  | 'awaiting_input';

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
  bridgeKind?: DesktopBridgeEventKind;
  bridgeStatus?: DesktopBridgeStatus;
  content?: string;
  messageId?: string;
  toolCall?: DesktopBridgeToolCall;
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
  /** @deprecated Project runtime config is stored in local-core.db. */
  configPath?: string;
  autoStartService?: boolean;
  defaultProject?: string;
  plugins?: Record<string, Partial<DesktopPluginSettings>>;
}

export interface DesktopPluginSettings {
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface DesktopPlatformConfig {
  type: string;
  options?: Record<string, unknown>;
}

export interface DesktopProviderModelConfig {
  model: string;
  alias?: string;
  unit_price_in?: number;
  unit_price_out?: number;
  unit_price_cache?: number;
}

export interface DesktopProviderConfig {
  name: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  models?: DesktopProviderModelConfig[];
  thinking?: string;
  env?: Record<string, string>;
  unit_price_in?: number;
  unit_price_out?: number;
  unit_price_cache?: number;
}

export interface DesktopModelProvider extends DesktopProviderConfig {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopModelProviderInput extends DesktopProviderConfig {
  id?: string;
}

export interface DesktopModelProviderListResponse {
  providers: DesktopModelProvider[];
}

export const CUSTOM_SELECT_VALUE = '__custom__';

export const PROVIDER_PRESETS: Array<DesktopProviderConfig & { id: string; label: string }> = [
  {
    id: 'openai',
    label: 'OpenAI',
    name: 'openai',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    models: [
      { model: 'gpt-4o', alias: 'GPT-4o', unit_price_in: 2.5, unit_price_out: 10.0, unit_price_cache: 1.25 },
      { model: 'gpt-4o-mini', alias: 'GPT-4o mini', unit_price_in: 0.15, unit_price_out: 0.6, unit_price_cache: 0.075 },
      { model: 'o3-mini', alias: 'o3-mini', unit_price_in: 1.1, unit_price_out: 4.4, unit_price_cache: 0.55 },
      { model: 'o1', alias: 'o1', unit_price_in: 15.0, unit_price_out: 60.0, unit_price_cache: 7.5 },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    name: 'deepseek',
    base_url: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    models: [
      { model: 'deepseek-chat', alias: 'DeepSeek V3 (Chat)', unit_price_in: 0.27, unit_price_out: 1.1, unit_price_cache: 0.07 },
      { model: 'deepseek-reasoner', alias: 'DeepSeek R1 (Reasoner)', unit_price_in: 0.55, unit_price_out: 2.19, unit_price_cache: 0.14 },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    name: 'anthropic',
    base_url: 'https://api.anthropic.com/v1',
    model: 'claude-3-7-sonnet-latest',
    models: [
      { model: 'claude-3-7-sonnet-latest', alias: 'Claude 3.7 Sonnet', unit_price_in: 3.0, unit_price_out: 15.0, unit_price_cache: 0.375 },
      { model: 'claude-3-5-sonnet-latest', alias: 'Claude 3.5 Sonnet', unit_price_in: 3.0, unit_price_out: 15.0, unit_price_cache: 0.375 },
      { model: 'claude-3-5-haiku-latest', alias: 'Claude 3.5 Haiku', unit_price_in: 0.8, unit_price_out: 4.0, unit_price_cache: 0.08 },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    name: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o',
    models: [
      { model: 'openai/gpt-4o', alias: 'GPT-4o (OpenRouter)' },
      { model: 'anthropic/claude-3.7-sonnet', alias: 'Claude 3.7 Sonnet (OpenRouter)' },
      { model: 'deepseek/deepseek-chat', alias: 'DeepSeek V3 (OpenRouter)' },
      { model: 'deepseek/deepseek-r1', alias: 'DeepSeek R1 (OpenRouter)' },
    ],
  },
  {
    id: 'minimax',
    label: 'Minimax',
    name: 'minimax',
    base_url: 'https://api.minimax.chat/v1',
    model: 'MiniMax-M2.5',
    models: [
      { model: 'MiniMax-M2.5', alias: 'MiniMax M2.5' },
      { model: 'MiniMax-Text-01', alias: 'MiniMax Text-01' },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    name: 'ollama',
    base_url: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5-coder:7b',
    models: [
      { model: 'qwen2.5-coder:7b', alias: 'Qwen 2.5 Coder 7B' },
      { model: 'deepseek-r1:8b', alias: 'DeepSeek R1 8B' },
      { model: 'llama3.3:70b', alias: 'Llama 3.3 70B' },
    ],
  },
];

export function getProviderPresetValue(provider: DesktopProviderConfig) {
  return PROVIDER_PRESETS.find((preset) =>
    provider.name === preset.name ||
    (preset.base_url && provider.base_url === preset.base_url),
  )?.id || CUSTOM_SELECT_VALUE;
}

export function applyProviderPreset(provider: DesktopProviderConfig, presetId: string): DesktopProviderConfig {
  const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
  if (!preset) return provider;
  return {
    ...provider,
    name: preset.name,
    base_url: preset.base_url,
    model: preset.model,
    models: Array.isArray(preset.models) ? JSON.parse(JSON.stringify(preset.models)) : (provider.models || []),
  };
}

export function providerToDraft(provider: DesktopModelProvider): DesktopModelProviderInput {
  return {
    id: provider.id,
    name: provider.name,
    api_key: provider.api_key || '',
    base_url: provider.base_url || '',
    model: provider.model || '',
    models: Array.isArray(provider.models) ? JSON.parse(JSON.stringify(provider.models)) : [],
    thinking: provider.thinking || '',
    env: provider.env ? JSON.parse(JSON.stringify(provider.env)) : {},
    unit_price_in: provider.unit_price_in,
    unit_price_out: provider.unit_price_out,
    unit_price_cache: provider.unit_price_cache,
  };
}

export type DesktopSandboxStateScope = 'user' | 'project' | 'thread' | 'run';
export type DesktopDeploymentProfileId = 'local-desktop' | 'docker-compose' | 'remote-cloud';
export type DesktopSandboxTransport = 'http-ndjson';
export type DesktopSandboxLifecycle = 'per_run' | 'per_thread';

export interface DesktopDeploymentProfile {
  id: DesktopDeploymentProfileId;
  label: string;
  corePublicOrigin: string;
  coreBindHost: string;
  openSandboxServerUrl: string;
  defaultWorkspaceRoot: string;
  sandboxImagePrefix: string;
  workspaceMountPath: string;
  stateMountPath: string;
  defaultSandboxProviderId: string;
}

export interface DesktopSandboxProviderConfig {
  id: string;
  type: 'opensandbox' | (string & {});
  name: string;
  server_url: string;
  api_key_env?: string;
}

export interface DesktopSandboxRuntimeImage {
  id: string;
  agent_type: string;
  image: string;
  transport?: DesktopSandboxTransport;
  acp_port: number;
  entrypoint?: string[];
  runtime_command?: string;
  runtime_args?: string[];
  workspace_mount_path?: string;
  state_mount_path?: string;
}

export const DEFAULT_SANDBOX_PROVIDER_ID = 'opensandbox-default';
export const DEFAULT_SANDBOX_RUNTIME_IMAGE_ID = 'pi-acp-local';
export const DEFAULT_SANDBOX_WORKSPACE_MOUNT_PATH = '/workspace';
export const DEFAULT_SANDBOX_STATE_MOUNT_PATH = '/agent-state';

export const DESKTOP_DEPLOYMENT_PROFILES: DesktopDeploymentProfile[] = [
  {
    id: 'local-desktop',
    label: 'Local Desktop',
    corePublicOrigin: 'http://127.0.0.1:9831',
    coreBindHost: '127.0.0.1',
    openSandboxServerUrl: 'http://127.0.0.1:8080',
    defaultWorkspaceRoot: '',
    sandboxImagePrefix: 'agentdock',
    workspaceMountPath: DEFAULT_SANDBOX_WORKSPACE_MOUNT_PATH,
    stateMountPath: DEFAULT_SANDBOX_STATE_MOUNT_PATH,
    defaultSandboxProviderId: DEFAULT_SANDBOX_PROVIDER_ID,
  },
  {
    id: 'docker-compose',
    label: 'Docker Compose',
    corePublicOrigin: 'http://127.0.0.1:9831',
    coreBindHost: '0.0.0.0',
    openSandboxServerUrl: 'http://opensandbox-server:8080',
    defaultWorkspaceRoot: '/workspace',
    sandboxImagePrefix: 'agentdock',
    workspaceMountPath: DEFAULT_SANDBOX_WORKSPACE_MOUNT_PATH,
    stateMountPath: DEFAULT_SANDBOX_STATE_MOUNT_PATH,
    defaultSandboxProviderId: DEFAULT_SANDBOX_PROVIDER_ID,
  },
  {
    id: 'remote-cloud',
    label: 'Remote Cloud',
    corePublicOrigin: '',
    coreBindHost: '0.0.0.0',
    openSandboxServerUrl: '',
    defaultWorkspaceRoot: '/workspace',
    sandboxImagePrefix: 'agentdock',
    workspaceMountPath: DEFAULT_SANDBOX_WORKSPACE_MOUNT_PATH,
    stateMountPath: DEFAULT_SANDBOX_STATE_MOUNT_PATH,
    defaultSandboxProviderId: DEFAULT_SANDBOX_PROVIDER_ID,
  },
];

export const DEFAULT_SANDBOX_RUNTIME_IMAGES: DesktopSandboxRuntimeImage[] = [
  {
    id: DEFAULT_SANDBOX_RUNTIME_IMAGE_ID,
    agent_type: 'pi',
    image: 'agentdock/pi-acp:local',
    transport: 'http-ndjson',
    acp_port: 8080,
    entrypoint: ['node', '/opt/agentdock/acp-bridge.mjs'],
    workspace_mount_path: DEFAULT_SANDBOX_WORKSPACE_MOUNT_PATH,
    state_mount_path: DEFAULT_SANDBOX_STATE_MOUNT_PATH,
  },
];

export function getDesktopDeploymentProfile(profileId?: string | null) {
  const normalized = String(profileId || '').trim();
  return DESKTOP_DEPLOYMENT_PROFILES.find((profile) => profile.id === normalized) || DESKTOP_DEPLOYMENT_PROFILES[0];
}

export function defaultSandboxProviderForProfile(profileId?: string | null): DesktopSandboxProviderConfig {
  const profile = getDesktopDeploymentProfile(profileId);
  return {
    id: profile.defaultSandboxProviderId,
    type: 'opensandbox',
    name: 'OpenSandbox',
    server_url: profile.openSandboxServerUrl,
    api_key_env: 'OPEN_SANDBOX_API_KEY',
  };
}

export function defaultSandboxRuntimeImage(agentType?: string | null): DesktopSandboxRuntimeImage {
  const normalized = String(agentType || '').trim().toLowerCase() || 'pi';
  return DEFAULT_SANDBOX_RUNTIME_IMAGES.find((image) => image.agent_type === normalized) || {
    id: `${normalized}-acp-local`,
    agent_type: normalized,
    image: `agentdock/${normalized}-acp:local`,
    transport: 'http-ndjson',
    acp_port: 8080,
    entrypoint: ['node', '/opt/agentdock/acp-bridge.mjs'],
    workspace_mount_path: DEFAULT_SANDBOX_WORKSPACE_MOUNT_PATH,
    state_mount_path: DEFAULT_SANDBOX_STATE_MOUNT_PATH,
  };
}

export interface DesktopSandboxOptions {
  enabled?: boolean;
  provider?: 'opensandbox' | (string & {});
  provider_id?: string;
  runtime_image_id?: string;
  deployment_profile?: DesktopDeploymentProfileId | (string & {});
  /** @deprecated Prefer config-level sandbox_providers plus sandbox.provider_id. */
  server_url?: string;
  /** @deprecated Prefer config-level sandbox_runtime_images plus sandbox.runtime_image_id. */
  image?: string;
  /** @deprecated Prefer config-level sandbox_runtime_images plus sandbox.runtime_image_id. */
  transport?: DesktopSandboxTransport;
  /** @deprecated Prefer config-level sandbox_providers plus sandbox.provider_id. */
  api_key_env?: string;
  state_scope?: DesktopSandboxStateScope;
  timeout_seconds?: number;
  sandbox_lifecycle?: DesktopSandboxLifecycle;
  idle_seconds?: number;
  warm_pool_size?: number;
  cpu?: string;
  memory?: string;
  /** @deprecated Prefer config-level sandbox_runtime_images. */
  workspace_mount_path?: string;
  /** @deprecated Prefer config-level sandbox_runtime_images. */
  state_mount_path?: string;
  /** @deprecated Prefer config-level sandbox_runtime_images. */
  acp_port?: number;
  /** @deprecated Prefer config-level sandbox_runtime_images. */
  entrypoint?: string[];
}

export type DesktopMcpTransportType = 'stdio' | 'sse' | 'http';

export interface DesktopMcpServerOptions {
  /** Unique server name passed through to the agent via ACP mcpServers. */
  name: string;
  type?: DesktopMcpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface DesktopProjectConfig {
  /** Stable Local AI Core identity. Display-name changes must not change this value. */
  workspace_id?: string;
  name: string;
  agent: {
    type: string;
    options?: Record<string, unknown> & {
      provider_id?: string;
      sandbox?: DesktopSandboxOptions;
      mcp_servers?: DesktopMcpServerOptions[];
    };
    /** @deprecated Providers are stored independently and projects should reference options.provider_id. */
    providers?: DesktopProviderConfig[];
  };
  platforms: DesktopPlatformConfig[];
  admin_from?: string;
  disabled_commands?: string[];
}

export interface DesktopConnectConfig {
  config_version?: number;
  data_dir?: string;
  language?: string;
  deployment_profile?: DesktopDeploymentProfileId | (string & {});
  sandbox_providers?: DesktopSandboxProviderConfig[];
  sandbox_runtime_images?: DesktopSandboxRuntimeImage[];
  bridge?: Record<string, unknown>;
  management?: Record<string, unknown>;
  projects?: DesktopProjectConfig[];
  [key: string]: unknown;
}

export interface RuntimeConfigState {
  storage: 'sqlite';
  databasePath: string;
  baseDir: string;
  config: DesktopConnectConfig;
  error?: string;
  warnings?: string[];
  updatedAt?: string;
}
