import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Save, Trash2, Wrench } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, Input, Select, Textarea } from '@/components/ui';
import {
  getRuntimeStatus,
  onRuntimeEvent,
  readConfigFile,
  restartDesktopService,
  saveDesktopSettings,
  saveRawConfigFile,
  saveStructuredConfigFile,
  startDesktopService,
  stopDesktopService,
} from '@/api/desktop';
import {
  DESKTOP_AGENT_TYPE_OPTIONS,
  DESKTOP_PLATFORM_TYPE_OPTIONS,
  DESKTOP_PROVIDER_THINKING_OPTIONS,
  DEFAULT_DESKTOP_AGENT_TYPE,
  getDefaultDesktopAgentModel,
  normalizeDesktopAgentModel,
} from '../../../shared/desktop';
import type {
  DesktopConnectConfig,
  DesktopProviderConfig,
  DesktopProjectConfig,
  DesktopRuntimeStatus,
} from '../../../shared/desktop';

type EditorTab = 'visual' | 'raw';
const CUSTOM_SELECT_VALUE = '__custom__';
type WorkspaceAction = 'save-settings' | 'save-visual' | 'save-raw' | 'save-restart' | 'restart' | 'start' | 'stop';
type WorkspaceNoticeTone = 'success' | 'warning' | 'error';
type PlatformFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select';

interface PlatformFieldDefinition {
  key: string;
  label: string;
  type: PlatformFieldType;
  placeholder?: string;
  options?: string[];
}

interface WorkspaceNotice {
  tone: WorkspaceNoticeTone;
  title: string;
  detail: string;
}

interface PersistedDesktopSettings {
  binaryPath: string;
  configPath: string;
  autoStartService: boolean;
  defaultProject: string;
  knowledgeBaseUrl: string;
  knowledgeAuthMode: 'none' | 'bearer' | 'header';
  knowledgeToken: string;
  knowledgeHeaderName: string;
  knowledgeDefaultCollection: string;
}

const PROGRESS_STYLE_OPTIONS = ['legacy', 'compact', 'card'] as const;
const PROVIDER_PRESET_DEFINITIONS = [
  {
    id: 'openai',
    label: 'OpenAI',
    name: 'openai',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    name: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4.1-mini',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    name: 'anthropic',
    base_url: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-haiku-latest',
    thinking: 'enabled',
  },
  {
    id: 'minimax',
    label: 'Minimax',
    name: 'minimax',
    base_url: 'https://api.minimax.chat/v1',
    model: 'MiniMax-M2.5',
  },
  {
    id: 'zhipuai',
    label: 'ZhipuAI',
    name: 'zhipuai',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5-air',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    name: 'deepseek',
    base_url: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    name: 'siliconflow',
    base_url: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    name: 'moonshot',
    base_url: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    name: 'ollama',
    base_url: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5-coder:7b',
  },
] as const;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizeProjectAgent(project: DesktopProjectConfig): DesktopProjectConfig {
  const options = {
    ...(project.agent?.options || {}),
  };
  options.model = normalizeDesktopAgentModel(project.agent?.type, String(options.model || ''));
  return {
    ...project,
    agent: {
      ...project.agent,
      options,
    },
  };
}

function normalizeDesktopConfigDraft(config: DesktopConnectConfig): DesktopConnectConfig {
  const next = clone(config);
  if (!Array.isArray(next.projects)) {
    return next;
  }
  next.projects = next.projects.map((project) => normalizeProjectAgent(project));
  return next;
}

function ensureProjects(config: DesktopConnectConfig) {
  if (!Array.isArray(config.projects)) {
    config.projects = [];
  }
  return config.projects;
}

function createProjectDraft(index: number): DesktopProjectConfig {
  return {
    name: `project-${index}`,
    agent: {
      type: DEFAULT_DESKTOP_AGENT_TYPE,
      options: {
        model: getDefaultDesktopAgentModel(DEFAULT_DESKTOP_AGENT_TYPE),
        work_dir: '.',
      },
      providers: [],
    },
    platforms: [],
    admin_from: '',
    disabled_commands: [],
  };
}

function formatRuntimePhase(phase?: DesktopRuntimeStatus['phase']) {
  switch (phase) {
    case 'starting':
      return 'starting';
    case 'api_ready':
      return 'management API ready';
    case 'bridge_ready':
      return 'bridge ready';
    case 'error':
      return 'error';
    default:
      return 'stopped';
  }
}

function getSelectValue(value: string, options: readonly string[]) {
  return options.includes(value as any) ? value : CUSTOM_SELECT_VALUE;
}

function getProviderPresetValue(provider: DesktopProviderConfig) {
  const matchedPreset = PROVIDER_PRESET_DEFINITIONS.find(
    (preset) =>
      provider.name === preset.name ||
      (preset.base_url && provider.base_url === preset.base_url) ||
      (preset.model && provider.model === preset.model && provider.name === preset.name),
  );
  return matchedPreset?.id || CUSTOM_SELECT_VALUE;
}

function applyProviderPreset(provider: DesktopProviderConfig, presetId: string): DesktopProviderConfig {
  const preset = PROVIDER_PRESET_DEFINITIONS.find((item) => item.id === presetId);
  if (!preset) {
    return provider;
  }
  return {
    ...provider,
    name: preset.name,
    base_url: preset.base_url,
    model: preset.model,
    thinking: preset.thinking || '',
    env: preset.env ? { ...preset.env } : provider.env || {},
  };
}

function getPlatformFieldDefinitions(platformType: string, options: Record<string, unknown> = {}): PlatformFieldDefinition[] {
  switch (platformType) {
    case 'telegram':
      return [
        { key: 'token', label: 'Bot token', type: 'password' },
        { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
        { key: 'group_reply_all', label: 'Reply to all group messages', type: 'boolean' },
        { key: 'share_session_in_channel', label: 'Share one session in group/channel', type: 'boolean' },
      ];
    case 'slack':
      return [
        { key: 'bot_token', label: 'Bot token', type: 'password' },
        { key: 'app_token', label: 'App token', type: 'password' },
        { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
        { key: 'share_session_in_channel', label: 'Share one session in channel', type: 'boolean' },
      ];
    case 'discord':
      return [
        { key: 'token', label: 'Bot token', type: 'password' },
        { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
        { key: 'guild_id', label: 'Guild ID', type: 'text' },
        { key: 'group_reply_all', label: 'Reply to all guild messages', type: 'boolean' },
        { key: 'share_session_in_channel', label: 'Share one session in channel', type: 'boolean' },
        { key: 'thread_isolation', label: 'Use thread isolation', type: 'boolean' },
        { key: 'respond_to_at_everyone_and_here', label: 'Respond to @everyone/@here', type: 'boolean' },
      ];
    case 'feishu':
      return [
        { key: 'app_id', label: 'App ID', type: 'text' },
        { key: 'app_secret', label: 'App secret', type: 'password' },
        { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
        { key: 'reaction_emoji', label: 'Reaction emoji', type: 'text', placeholder: 'OnIt' },
        { key: 'enable_feishu_card', label: 'Enable Feishu cards', type: 'boolean' },
        { key: 'group_reply_all', label: 'Reply to all group messages', type: 'boolean' },
        { key: 'share_session_in_channel', label: 'Share one session in channel', type: 'boolean' },
        { key: 'thread_isolation', label: 'Use thread isolation', type: 'boolean' },
        { key: 'reply_to_trigger', label: 'Reply to trigger message', type: 'boolean' },
        { key: 'progress_style', label: 'Progress style', type: 'select', options: [...PROGRESS_STYLE_OPTIONS] },
      ];
    case 'lark':
      return [
        { key: 'app_id', label: 'App ID', type: 'text' },
        { key: 'app_secret', label: 'App secret', type: 'password' },
        { key: 'port', label: 'Webhook port', type: 'number', placeholder: '8080' },
        { key: 'callback_path', label: 'Webhook path', type: 'text', placeholder: '/feishu/webhook' },
        { key: 'encrypt_key', label: 'Encrypt key', type: 'password' },
        { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
        { key: 'reaction_emoji', label: 'Reaction emoji', type: 'text', placeholder: 'OnIt' },
        { key: 'enable_feishu_card', label: 'Enable cards', type: 'boolean' },
        { key: 'progress_style', label: 'Progress style', type: 'select', options: [...PROGRESS_STYLE_OPTIONS] },
      ];
    case 'dingtalk':
      return [
        { key: 'client_id', label: 'Client ID', type: 'text' },
        { key: 'client_secret', label: 'Client secret', type: 'password' },
        { key: 'robot_code', label: 'Robot code', type: 'text' },
        { key: 'agent_id', label: 'Agent ID', type: 'number' },
        { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
        { key: 'share_session_in_channel', label: 'Share one session in channel', type: 'boolean' },
      ];
    case 'wecom':
      if (options.mode === 'websocket') {
        return [
          { key: 'mode', label: 'Mode', type: 'select', options: ['websocket', 'http'] },
          { key: 'bot_id', label: 'Bot ID', type: 'text' },
          { key: 'bot_secret', label: 'Bot secret', type: 'password' },
          { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
        ];
      }
      return [
        { key: 'mode', label: 'Mode', type: 'select', options: ['http', 'websocket'] },
        { key: 'corp_id', label: 'Corp ID', type: 'text' },
        { key: 'corp_secret', label: 'Corp secret', type: 'password' },
        { key: 'agent_id', label: 'Agent ID', type: 'text' },
        { key: 'callback_token', label: 'Callback token', type: 'password' },
        { key: 'callback_aes_key', label: 'Callback AES key', type: 'password' },
        { key: 'port', label: 'Webhook port', type: 'number', placeholder: '8081' },
        { key: 'callback_path', label: 'Webhook path', type: 'text', placeholder: '/wecom/callback' },
        { key: 'enable_markdown', label: 'Enable markdown', type: 'boolean' },
        { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
        { key: 'proxy', label: 'Proxy URL', type: 'text' },
        { key: 'proxy_username', label: 'Proxy username', type: 'text' },
        { key: 'proxy_password', label: 'Proxy password', type: 'password' },
      ];
    case 'line':
      return [
        { key: 'channel_secret', label: 'Channel secret', type: 'password' },
        { key: 'channel_token', label: 'Channel token', type: 'password' },
        { key: 'port', label: 'Webhook port', type: 'number', placeholder: '8080' },
        { key: 'callback_path', label: 'Webhook path', type: 'text', placeholder: '/callback' },
        { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
      ];
    case 'weixin':
      return [
        { key: 'token', label: 'Bearer token', type: 'password' },
        { key: 'base_url', label: 'Base URL', type: 'text', placeholder: 'https://ilinkai.weixin.qq.com' },
        { key: 'cdn_base_url', label: 'CDN base URL', type: 'text' },
        { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
        { key: 'account_id', label: 'Account ID', type: 'text', placeholder: 'default' },
        { key: 'route_tag', label: 'Route tag', type: 'text' },
        { key: 'long_poll_timeout_ms', label: 'Long poll timeout (ms)', type: 'number', placeholder: '35000' },
        { key: 'state_dir', label: 'State dir', type: 'text' },
        { key: 'proxy', label: 'Proxy URL', type: 'text' },
        { key: 'proxy_username', label: 'Proxy username', type: 'text' },
        { key: 'proxy_password', label: 'Proxy password', type: 'password' },
      ];
    case 'qq':
      return [
        { key: 'ws_url', label: 'WebSocket URL', type: 'text', placeholder: 'ws://127.0.0.1:3001' },
        { key: 'token', label: 'Access token', type: 'password' },
        { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
        { key: 'share_session_in_channel', label: 'Share one session in group', type: 'boolean' },
      ];
    case 'qqbot':
      return [
        { key: 'app_id', label: 'App ID', type: 'text' },
        { key: 'app_secret', label: 'App secret', type: 'password' },
        { key: 'sandbox', label: 'Use sandbox', type: 'boolean' },
        { key: 'allow_from', label: 'Allow from', type: 'text', placeholder: '*' },
        { key: 'share_session_in_channel', label: 'Share one session in channel', type: 'boolean' },
        { key: 'markdown_support', label: 'Enable markdown support', type: 'boolean' },
      ];
    default:
      return [];
  }
}

function coercePlatformOptionValue(type: PlatformFieldType, rawValue: string | boolean) {
  if (type === 'boolean') {
    return Boolean(rawValue);
  }
  if (type === 'number') {
    const text = String(rawValue).trim();
    return text === '' ? '' : Number(text);
  }
  return String(rawValue);
}

function noticeClasses(tone: WorkspaceNoticeTone) {
  switch (tone) {
    case 'success':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/30 dark:bg-emerald-950/20 dark:text-emerald-300';
    case 'warning':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/30 dark:bg-amber-950/20 dark:text-amber-300';
    default:
      return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/30 dark:bg-red-950/20 dark:text-red-300';
  }
}

function stableSerialize(value: unknown) {
  return JSON.stringify(value ?? null);
}

export default function DesktopWorkspace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [runtime, setRuntime] = useState<DesktopRuntimeStatus | null>(null);
  const [configDraft, setConfigDraft] = useState<DesktopConnectConfig | null>(null);
  const [rawDraft, setRawDraft] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingAction, setPendingAction] = useState<WorkspaceAction | null>(null);
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null);
  const [persistedSettings, setPersistedSettings] = useState<PersistedDesktopSettings | null>(null);
  const [persistedConfigSerialized, setPersistedConfigSerialized] = useState('');
  const [persistedRawDraft, setPersistedRawDraft] = useState('');
  const [restartPending, setRestartPending] = useState(false);
  const [tab, setTab] = useState<EditorTab>('visual');
  const [binaryPath, setBinaryPath] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [autoStartService, setAutoStartService] = useState(false);
  const [defaultProject, setDefaultProject] = useState('');
  const [knowledgeBaseUrl, setKnowledgeBaseUrl] = useState('');
  const [knowledgeAuthMode, setKnowledgeAuthMode] = useState<'none' | 'bearer' | 'header'>('none');
  const [knowledgeToken, setKnowledgeToken] = useState('');
  const [knowledgeHeaderName, setKnowledgeHeaderName] = useState('X-API-Key');
  const [knowledgeDefaultCollection, setKnowledgeDefaultCollection] = useState('personal_knowledge');
  const requestedProject = searchParams.get('project') || '';
  const requestedProjectRef = useRef(requestedProject);
  const runtimeReady = runtime?.phase === 'api_ready' || runtime?.phase === 'bridge_ready';
  const settingsDirty = useMemo(() => {
    if (!persistedSettings) {
      return false;
    }
    return (
      binaryPath !== persistedSettings.binaryPath ||
      configPath !== persistedSettings.configPath ||
      autoStartService !== persistedSettings.autoStartService ||
      defaultProject !== persistedSettings.defaultProject ||
      knowledgeBaseUrl !== persistedSettings.knowledgeBaseUrl ||
      knowledgeAuthMode !== persistedSettings.knowledgeAuthMode ||
      knowledgeToken !== persistedSettings.knowledgeToken ||
      knowledgeHeaderName !== persistedSettings.knowledgeHeaderName ||
      knowledgeDefaultCollection !== persistedSettings.knowledgeDefaultCollection
    );
  }, [
    autoStartService,
    binaryPath,
    configPath,
    defaultProject,
    knowledgeAuthMode,
    knowledgeBaseUrl,
    knowledgeDefaultCollection,
    knowledgeHeaderName,
    knowledgeToken,
    persistedSettings,
  ]);
  const visualDirty = useMemo(
    () => stableSerialize(configDraft || { projects: [] }) !== persistedConfigSerialized,
    [configDraft, persistedConfigSerialized],
  );
  const rawDirty = rawDraft !== persistedRawDraft;

  useEffect(() => {
    requestedProjectRef.current = requestedProject;
  }, [requestedProject]);

  const loadAll = useCallback(async () => {
    const [nextRuntime, nextConfig] = await Promise.all([getRuntimeStatus(), readConfigFile()]);
    setRuntime(nextRuntime);
    setRestartPending(nextRuntime.pendingRestart);
    setRawDraft(nextConfig.raw);
    setPersistedRawDraft(nextConfig.raw);
    setConfigDraft(nextConfig.parsed ? clone(nextConfig.parsed) : { projects: [] });
    setPersistedConfigSerialized(stableSerialize(nextConfig.parsed ? clone(nextConfig.parsed) : { projects: [] }));
    setBinaryPath(nextRuntime.settings.binaryPath);
    setConfigPath(nextRuntime.settings.configPath);
    setAutoStartService(nextRuntime.settings.autoStartService);
    setDefaultProject(nextRuntime.settings.defaultProject);
    setKnowledgeBaseUrl(nextRuntime.settings.knowledge.baseUrl || '');
    setKnowledgeAuthMode(nextRuntime.settings.knowledge.authMode || 'none');
    setKnowledgeToken(nextRuntime.settings.knowledge.token || '');
    setKnowledgeHeaderName(nextRuntime.settings.knowledge.headerName || 'X-API-Key');
    setKnowledgeDefaultCollection(nextRuntime.settings.knowledge.defaultCollection || 'personal_knowledge');
    setPersistedSettings({
      binaryPath: nextRuntime.settings.binaryPath,
      configPath: nextRuntime.settings.configPath,
      autoStartService: nextRuntime.settings.autoStartService,
      defaultProject: nextRuntime.settings.defaultProject,
      knowledgeBaseUrl: nextRuntime.settings.knowledge.baseUrl || '',
      knowledgeAuthMode: nextRuntime.settings.knowledge.authMode || 'none',
      knowledgeToken: nextRuntime.settings.knowledge.token || '',
      knowledgeHeaderName: nextRuntime.settings.knowledge.headerName || 'X-API-Key',
      knowledgeDefaultCollection: nextRuntime.settings.knowledge.defaultCollection || 'personal_knowledge',
    });
    setSelectedIndex((current) => {
      const projects = nextConfig.parsed?.projects || [];
      const total = projects.length;
      const preferredProject = requestedProjectRef.current;
      if (preferredProject) {
        const matchedIndex = projects.findIndex((project) => project.name === preferredProject);
        if (matchedIndex >= 0) {
          return matchedIndex;
        }
      }
      return total === 0 ? 0 : Math.min(current, total - 1);
    });
  }, []);

  useEffect(() => {
    void loadAll();
    const stop = onRuntimeEvent((nextRuntime) => {
      setRuntime(nextRuntime);
      setRestartPending(nextRuntime.pendingRestart);
    });
    return () => stop();
  }, [loadAll]);

  const projects = configDraft?.projects || [];
  const selectedProject = projects[selectedIndex];

  const projectNames = useMemo(() => projects.map((project) => project.name), [projects]);

  useEffect(() => {
    if (visualDirty) {
      return;
    }
    if (!requestedProject) {
      return;
    }
    const matchedIndex = projects.findIndex((project) => project.name === requestedProject);
    if (matchedIndex >= 0 && matchedIndex !== selectedIndex) {
      setSelectedIndex(matchedIndex);
    }
  }, [projects, requestedProject, visualDirty]);

  useEffect(() => {
    if (visualDirty) {
      return;
    }
    if (!selectedProject?.name) {
      return;
    }
    if (searchParams.get('project') === selectedProject.name) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('project', selectedProject.name);
    setSearchParams(next, { replace: true });
  }, [searchParams, selectedProject?.name, setSearchParams, visualDirty]);

  const updateSelectedProject = useCallback((updater: (project: DesktopProjectConfig) => DesktopProjectConfig) => {
    setNotice(null);
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = clone(current);
      const project = ensureProjects(next)[selectedIndex];
      if (!project) {
        return current;
      }
      ensureProjects(next)[selectedIndex] = updater(project);
      return next;
    });
  }, [selectedIndex]);

  const updateSelectedProvider = useCallback((providerIndex: number, updater: (provider: DesktopProviderConfig) => DesktopProviderConfig) => {
    updateSelectedProject((project) => {
      const providers = [...(project.agent.providers || [])];
      const provider = providers[providerIndex];
      if (!provider) {
        return project;
      }
      providers[providerIndex] = updater(provider);
      return {
        ...project,
        agent: {
          ...project.agent,
          providers,
        },
      };
    });
  }, [updateSelectedProject]);

  const handleSaveSettings = useCallback(async () => {
    setPendingAction('save-settings');
    try {
      const restartRequired =
        binaryPath !== (runtime?.settings.binaryPath || '') || configPath !== (runtime?.settings.configPath || '');
      await saveDesktopSettings({
        binaryPath,
        configPath,
        autoStartService,
        defaultProject,
        knowledge: {
          baseUrl: knowledgeBaseUrl,
          authMode: knowledgeAuthMode,
          token: knowledgeToken,
          headerName: knowledgeHeaderName,
          defaultCollection: knowledgeDefaultCollection,
        },
      });
      await loadAll();
      setNotice({
        tone: restartRequired && runtimeReady ? 'warning' : 'success',
        title: restartRequired && runtimeReady ? 'Desktop settings saved' : 'Desktop settings updated',
        detail:
          restartRequired && runtimeReady
            ? 'The new binary or config path is saved. Restart the service to run with the new runtime files.'
            : 'Desktop settings were written successfully.',
      });
      setRestartPending(Boolean(restartRequired && runtimeReady));
    } catch (error) {
      setNotice({
        tone: 'error',
        title: 'Could not save desktop settings',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(null);
    }
  }, [
    autoStartService,
    binaryPath,
    configPath,
    defaultProject,
    knowledgeAuthMode,
    knowledgeBaseUrl,
    knowledgeDefaultCollection,
    knowledgeHeaderName,
    knowledgeToken,
    loadAll,
    runtime?.settings.binaryPath,
    runtime?.settings.configPath,
    runtimeReady,
  ]);

  const handleSaveVisual = useCallback(async () => {
    if (!configDraft) {
      return;
    }
    setPendingAction('save-visual');
    try {
      const normalized = normalizeDesktopConfigDraft(configDraft);
      const saved = await saveStructuredConfigFile(normalized);
      setRawDraft(saved.raw);
      setConfigDraft(saved.parsed ? clone(saved.parsed) : normalized);
      await loadAll();
      const warningDetail = saved.warnings?.join(' ') || '';
      setNotice({
        tone: saved.warnings?.length ? 'warning' : runtimeReady ? 'warning' : 'success',
        title: saved.warnings?.length ? 'Workspace config saved with warnings' : 'Workspace config saved',
        detail: saved.warnings?.length
          ? warningDetail
          : runtimeReady
            ? 'The updated config is on disk. Restart the service to apply these changes to the running desktop runtime.'
            : 'The workspace config is saved and will be used the next time the service starts.',
      });
      setRestartPending(Boolean(runtimeReady));
    } catch (error) {
      setNotice({
        tone: 'error',
        title: 'Could not save workspace config',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(null);
    }
  }, [configDraft, loadAll, runtimeReady]);

  const handleSaveRaw = useCallback(async () => {
    setPendingAction('save-raw');
    try {
      const saved = await saveRawConfigFile(rawDraft);
      setRawDraft(saved.raw);
      setConfigDraft(saved.parsed ? clone(saved.parsed) : configDraft);
      await loadAll();
      setNotice({
        tone: runtimeReady ? 'warning' : 'success',
        title: 'Raw TOML saved',
        detail: runtimeReady
          ? 'The config file was updated. Restart the service to apply the new TOML to the running desktop runtime.'
          : 'The raw TOML is saved and ready for the next service start.',
      });
      setRestartPending(Boolean(runtimeReady));
    } catch (error) {
      setNotice({
        tone: 'error',
        title: 'Could not save raw TOML',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(null);
    }
  }, [configDraft, loadAll, rawDraft, runtimeReady]);

  const handleAddProject = useCallback(() => {
    const nextProjectIndex = projects.length + 1;
    setConfigDraft((current) => {
      const next = clone(current || {});
      ensureProjects(next).push(createProjectDraft(nextProjectIndex));
      return next;
    });
    setNotice(null);
    setSelectedIndex(nextProjectIndex - 1);
  }, [projects.length]);

  const handleRemoveProject = useCallback((index: number) => {
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = clone(current);
      ensureProjects(next).splice(index, 1);
      return next;
    });
    setSelectedIndex((current) => Math.max(0, current - (current >= index ? 1 : 0)));
  }, []);

  const handleSaveAndRestart = useCallback(async () => {
    if (!configDraft) {
      return;
    }
    setPendingAction('save-restart');
    try {
      const normalized = normalizeDesktopConfigDraft(configDraft);
      const saved = await saveStructuredConfigFile(normalized);
      setRawDraft(saved.raw);
      setConfigDraft(saved.parsed ? clone(saved.parsed) : normalized);
      await restartDesktopService();
      await loadAll();
      const warningDetail = saved.warnings?.join(' ') || '';
      setNotice({
        tone: saved.warnings?.length ? 'warning' : 'success',
        title: saved.warnings?.length ? 'Workspace config applied with warnings' : 'Workspace config applied',
        detail: saved.warnings?.length
          ? warningDetail
          : 'The config was written to disk and the desktop service restarted with the new settings.',
      });
      setRestartPending(false);
    } catch (error) {
      setNotice({
        tone: 'error',
        title: 'Could not apply workspace config',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(null);
    }
  }, [configDraft, loadAll]);

  const handleRestartService = useCallback(async () => {
    setPendingAction('restart');
    try {
      await restartDesktopService();
      await loadAll();
      setNotice({
        tone: 'success',
        title: 'Desktop service restarted',
        detail: 'The runtime restarted successfully and is now using the current config on disk.',
      });
      setRestartPending(false);
    } catch (error) {
      setNotice({
        tone: 'error',
        title: 'Could not restart desktop service',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(null);
    }
  }, [loadAll]);

  const handleStartService = useCallback(async () => {
    setPendingAction('start');
    try {
      await startDesktopService();
      await loadAll();
      setNotice({
        tone: 'success',
        title: 'Desktop service started',
        detail: 'The local cc-connect process is running and ready for management or chat traffic.',
      });
      setRestartPending(false);
    } catch (error) {
      setNotice({
        tone: 'error',
        title: 'Could not start desktop service',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(null);
    }
  }, [loadAll]);

  const handleStopService = useCallback(async () => {
    setPendingAction('stop');
    try {
      await stopDesktopService();
      await loadAll();
      setNotice({
        tone: 'success',
        title: 'Desktop service stopped',
        detail: 'The local cc-connect process has been stopped.',
      });
      setRestartPending(false);
    } catch (error) {
      setNotice({
        tone: 'error',
        title: 'Could not stop desktop service',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(null);
    }
  }, [loadAll]);

  return (
    <div className="space-y-6 animate-fade-in">
      {notice && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${noticeClasses(notice.tone)}`}>
          <p className="font-medium">{notice.title}</p>
          <p className="mt-1">{notice.detail}</p>
        </div>
      )}
      {(settingsDirty || visualDirty || rawDirty || restartPending) && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            restartPending
              ? noticeClasses('warning')
              : 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/30 dark:bg-sky-950/20 dark:text-sky-300'
          }`}
        >
          <p className="font-medium">
            {restartPending ? 'Saved to disk, restart still needed' : 'You have unsaved changes'}
          </p>
          <p className="mt-1">
            {restartPending
              ? 'The newest settings are already on disk, but the running desktop service is still using the previous runtime state. Restart to apply them.'
              : [
                  settingsDirty ? 'desktop settings changed' : '',
                  visualDirty ? 'visual config changed' : '',
                  rawDirty ? 'raw TOML changed' : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-6">
        <Card className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Desktop Runtime</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Manage the local `cc-connect` process and where this app stores its runtime files.
            </p>
          </div>

          <Input label="cc-connect binary" value={binaryPath} onChange={(event) => setBinaryPath(event.target.value)} />
          <Input label="Config file" value={configPath} onChange={(event) => setConfigPath(event.target.value)} />
          <Input label="Default chat project" value={defaultProject} onChange={(event) => setDefaultProject(event.target.value)} />

          <div className="rounded-xl border border-gray-200/80 p-4 dark:border-white/[0.08]">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Knowledge / ai_vector</h3>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Local AI Core uses these settings to upload files and query the external ai_vector RAG service.
              </p>
            </div>
            <div className="space-y-3">
              <Input
                label="ai_vector base URL"
                value={knowledgeBaseUrl}
                onChange={(event) => setKnowledgeBaseUrl(event.target.value)}
                placeholder="http://127.0.0.1:16007"
              />
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Auth mode"
                  value={knowledgeAuthMode}
                  onChange={(event) => setKnowledgeAuthMode(event.target.value as 'none' | 'bearer' | 'header')}
                >
                  <option value="none">none</option>
                  <option value="bearer">bearer</option>
                  <option value="header">header</option>
                </Select>
                <Input
                  label="Default collection"
                  value={knowledgeDefaultCollection}
                  onChange={(event) => setKnowledgeDefaultCollection(event.target.value)}
                  placeholder="personal_knowledge"
                />
              </div>
              {knowledgeAuthMode !== 'none' && (
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label={knowledgeAuthMode === 'bearer' ? 'Bearer token' : 'Auth token'}
                    type="password"
                    value={knowledgeToken}
                    onChange={(event) => setKnowledgeToken(event.target.value)}
                  />
                  {knowledgeAuthMode === 'header' ? (
                    <Input
                      label="Header name"
                      value={knowledgeHeaderName}
                      onChange={(event) => setKnowledgeHeaderName(event.target.value)}
                      placeholder="X-API-Key"
                    />
                  ) : (
                    <Input
                      label="Header name"
                      value="Authorization"
                      readOnly
                    />
                  )}
                </div>
              )}
            </div>
          </div>

          <label className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={autoStartService}
              onChange={(event) => setAutoStartService(event.target.checked)}
            />
            Auto-start `cc-connect` when the desktop app opens
          </label>

          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => void handleSaveSettings()}
              loading={pendingAction === 'save-settings'}
              disabled={!settingsDirty && pendingAction !== 'save-settings'}
            >
              <Save size={14} /> Save desktop settings
            </Button>
            <Button
              variant="secondary"
              onClick={() => void handleStartService()}
              loading={pendingAction === 'start'}
              disabled={runtime?.phase === 'starting' || runtime?.phase === 'api_ready' || runtime?.phase === 'bridge_ready'}
            >
              Start
            </Button>
            <Button
              variant="secondary"
              onClick={() => void handleStopService()}
              loading={pendingAction === 'stop'}
              disabled={runtime?.phase === 'stopped'}
            >
              Stop
            </Button>
          </div>

          <div className="rounded-xl border border-gray-200/80 dark:border-white/[0.08] px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
            <p className="font-medium text-gray-900 dark:text-white">How runtime actions apply</p>
            <p className="mt-1">
              `Save desktop settings` updates this app&apos;s local paths and defaults. `Start`, `Stop`, and `Restart`
              control the local `cc-connect` process directly.
            </p>
          </div>

          <div className="rounded-xl border border-gray-200/80 dark:border-white/[0.08] px-4 py-3 text-sm">
            <p className="font-medium text-gray-900 dark:text-white">
              Runtime status: <span className="text-accent">{formatRuntimePhase(runtime?.phase)}</span>
            </p>
            <p className="text-gray-500 dark:text-gray-400 mt-1 break-all">
              Management API: {runtime?.managementBaseUrl || '-'}
            </p>
            {runtime?.service.lastError && (
              <p className="text-red-500 mt-2">{runtime.service.lastError}</p>
            )}
          </div>
        </Card>

        <Card className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Workspace Config</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Unified desktop configuration for runtime, projects, providers, and platforms. Keep advanced option maps in raw TOML.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant={tab === 'visual' ? 'primary' : 'secondary'} size="sm" onClick={() => setTab('visual')}>
                Visual
              </Button>
              <Button variant={tab === 'raw' ? 'primary' : 'secondary'} size="sm" onClick={() => setTab('raw')}>
                Raw TOML
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200/80 dark:border-white/[0.08] px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
            <p className="font-medium text-gray-900 dark:text-white">How config changes apply</p>
            <p className="mt-1">
              `Save config` only writes `config.toml`. `Save and restart service` writes the file and immediately
              restarts `cc-connect`, so the new config takes effect right away.
            </p>
          </div>

          {tab === 'visual' ? (
            <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-5 min-h-[560px]">
              <div className="space-y-3 border-r border-gray-200/80 dark:border-white/[0.08] pr-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium text-gray-900 dark:text-white">Projects</h3>
                  <Button size="sm" onClick={handleAddProject} data-testid="desktop-workspace-add-project">
                    <Plus size={14} /> Add
                  </Button>
                </div>
                <div className="space-y-2">
                  {projects.map((project, index) => (
                    <div
                      key={`${project.name}-${index}`}
                      data-testid={`desktop-workspace-project-card-${index}`}
                      className={`w-full text-left rounded-xl px-4 py-3 border transition-colors ${
                        index === selectedIndex
                          ? 'border-accent/40 bg-accent/10'
                          : 'border-transparent bg-gray-100/70 dark:bg-white/[0.04] hover:bg-gray-100 dark:hover:bg-white/[0.08]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedIndex(index)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="font-medium text-gray-900 dark:text-white truncate block">{project.name}</span>
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                            {project.agent?.type || 'unknown'} · {project.platforms?.length || 0} platforms
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveProject(index)}
                          className="text-gray-400 hover:text-red-500"
                          aria-label={`Remove project ${project.name || index + 1}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-5">
                {!selectedProject ? (
                  <div className="h-full flex items-center justify-center text-sm text-gray-400">
                    Add a project to begin editing.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label="Project name"
                        data-testid="desktop-workspace-project-name"
                        value={selectedProject.name}
                        onChange={(event) =>
                          updateSelectedProject((project) => ({ ...project, name: event.target.value }))
                        }
                      />
                      <div className="space-y-3">
                        <Select
                          label="Agent type"
                          value={getSelectValue(selectedProject.agent?.type || '', DESKTOP_AGENT_TYPE_OPTIONS)}
                          onChange={(event) =>
                            updateSelectedProject((project) => {
                              const nextType = event.target.value === CUSTOM_SELECT_VALUE ? '' : event.target.value;
                              const currentModel = String(project.agent?.options?.model || '');
                              const nextModel = nextType === project.agent?.type
                                ? currentModel
                                : normalizeDesktopAgentModel(nextType, currentModel);
                              return {
                                ...project,
                                agent: {
                                  ...project.agent,
                                  type: nextType,
                                  options: {
                                    ...(project.agent.options || {}),
                                    model: nextModel,
                                  },
                                },
                              };
                            })
                          }
                        >
                          {DESKTOP_AGENT_TYPE_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                          <option value={CUSTOM_SELECT_VALUE}>custom</option>
                        </Select>
                        {getSelectValue(selectedProject.agent?.type || '', DESKTOP_AGENT_TYPE_OPTIONS) === CUSTOM_SELECT_VALUE && (
                          <Input
                            label="Custom agent type"
                            value={selectedProject.agent?.type || ''}
                            onChange={(event) =>
                              updateSelectedProject((project) => ({
                                ...project,
                                agent: { ...project.agent, type: event.target.value },
                              }))
                            }
                            placeholder="Enter an agent type supported by cc-connect"
                          />
                        )}
                        {selectedProject.agent?.type === 'opencode' && (
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            Desktop runs <code>opencode</code> through the ACP adapter at runtime so permission controls work, but your saved config stays on <code>opencode</code>.
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label="Work dir"
                        value={String(selectedProject.agent?.options?.work_dir || '')}
                        onChange={(event) =>
                          updateSelectedProject((project) => ({
                            ...project,
                            agent: {
                              ...project.agent,
                              options: {
                                ...(project.agent.options || {}),
                                work_dir: event.target.value,
                              },
                            },
                          }))
                        }
                      />
                      <Input
                        label="Admin from"
                        value={selectedProject.admin_from || ''}
                        onChange={(event) =>
                          updateSelectedProject((project) => ({ ...project, admin_from: event.target.value }))
                        }
                      />
                    </div>

                    <Input
                      label="Agent model"
                      value={String(selectedProject.agent?.options?.model || '')}
                      placeholder={
                        selectedProject.agent?.type === 'opencode'
                          ? getDefaultDesktopAgentModel('opencode')
                          : selectedProject.agent?.type === 'claudecode'
                            ? 'Leave blank to use the Claude CLI default model'
                            : 'Optional agent model override'
                      }
                      onChange={(event) =>
                        updateSelectedProject((project) => ({
                          ...project,
                          agent: {
                            ...project.agent,
                            options: {
                              ...(project.agent.options || {}),
                              model: event.target.value,
                            },
                          },
                        }))
                      }
                    />

                    <Input
                      label="Disabled commands"
                      value={(selectedProject.disabled_commands || []).join(', ')}
                      onChange={(event) =>
                        updateSelectedProject((project) => ({
                          ...project,
                          disabled_commands: event.target.value
                            .split(',')
                            .map((item) => item.trim())
                            .filter(Boolean),
                        }))
                      }
                    />

                    <section className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-medium text-gray-900 dark:text-white">Providers</h3>
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                            Use presets for common endpoints, then fill the API key and any extra environment overrides.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          data-testid="desktop-workspace-add-provider"
                          onClick={() =>
                            updateSelectedProject((project) => ({
                              ...project,
                              agent: {
                                ...project.agent,
                                providers: [
                                  ...(project.agent.providers || []),
                                  { name: `provider-${(project.agent.providers || []).length + 1}`, env: {} },
                                ],
                              },
                            }))
                          }
                        >
                          <Plus size={14} /> Provider
                        </Button>
                      </div>
                      {(selectedProject.agent.providers || []).map((provider, index) => (
                        <div
                          key={`${provider.name}-${index}`}
                          className="rounded-2xl border border-gray-200/80 dark:border-white/[0.08] p-4 space-y-4"
                          data-testid={`desktop-workspace-provider-${index}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="font-medium text-gray-900 dark:text-white">{provider.name || `provider-${index + 1}`}</p>
                              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Configure a named upstream provider for this project.
                              </p>
                            </div>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() =>
                                updateSelectedProject((project) => {
                                  const providers = [...(project.agent.providers || [])];
                                  providers.splice(index, 1);
                                  return { ...project, agent: { ...project.agent, providers } };
                                })
                              }
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <Select
                              label="Preset"
                              value={getProviderPresetValue(provider)}
                              data-testid={`desktop-workspace-provider-preset-${index}`}
                              onChange={(event) =>
                                updateSelectedProvider(index, (currentProvider) =>
                                  event.target.value === CUSTOM_SELECT_VALUE
                                    ? currentProvider
                                    : applyProviderPreset(currentProvider, event.target.value),
                                )
                              }
                            >
                              {PROVIDER_PRESET_DEFINITIONS.map((preset) => (
                                <option key={preset.id} value={preset.id}>
                                  {preset.label}
                                </option>
                              ))}
                              <option value={CUSTOM_SELECT_VALUE}>custom</option>
                            </Select>
                            <Input
                              label="Name"
                              value={provider.name}
                              data-testid={`desktop-workspace-provider-name-${index}`}
                              onChange={(event) =>
                                updateSelectedProvider(index, (currentProvider) => ({
                                  ...currentProvider,
                                  name: event.target.value,
                                }))
                              }
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <Input
                              label="API key"
                              type="password"
                              value={provider.api_key || ''}
                              data-testid={`desktop-workspace-provider-api-key-${index}`}
                              onChange={(event) =>
                                updateSelectedProvider(index, (currentProvider) => ({
                                  ...currentProvider,
                                  api_key: event.target.value,
                                }))
                              }
                            />
                            <Input
                              label="Base URL"
                              value={provider.base_url || ''}
                              data-testid={`desktop-workspace-provider-base-url-${index}`}
                              onChange={(event) =>
                                updateSelectedProvider(index, (currentProvider) => ({
                                  ...currentProvider,
                                  base_url: event.target.value,
                                }))
                              }
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <Input
                              label="Default model"
                              value={provider.model || ''}
                              data-testid={`desktop-workspace-provider-model-${index}`}
                              onChange={(event) =>
                                updateSelectedProvider(index, (currentProvider) => ({
                                  ...currentProvider,
                                  model: event.target.value,
                                }))
                              }
                            />
                            <Select
                              label="Thinking override"
                              value={provider.thinking || ''}
                              data-testid={`desktop-workspace-provider-thinking-${index}`}
                              onChange={(event) =>
                                updateSelectedProvider(index, (currentProvider) => ({
                                  ...currentProvider,
                                  thinking: event.target.value,
                                }))
                              }
                            >
                              {DESKTOP_PROVIDER_THINKING_OPTIONS.map((option) => (
                                <option key={option || 'inherit'} value={option}>
                                  {option || 'inherit agent default'}
                                </option>
                              ))}
                            </Select>
                          </div>

                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-sm font-medium text-gray-900 dark:text-white">Available models</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                  Optional model shortcuts exposed by this provider. Alias is what users can switch to at runtime.
                                </p>
                              </div>
                              <Button
                                size="sm"
                                variant="secondary"
                                data-testid={`desktop-workspace-provider-add-model-${index}`}
                                onClick={() =>
                                  updateSelectedProvider(index, (currentProvider) => ({
                                    ...currentProvider,
                                    models: [...(currentProvider.models || []), { model: '', alias: '' }],
                                  }))
                                }
                              >
                                <Plus size={14} /> Model
                              </Button>
                            </div>

                            {(provider.models || []).length === 0 ? (
                              <div className="rounded-xl border border-dashed border-gray-200/80 dark:border-white/[0.08] px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                                No named models yet.
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {(provider.models || []).map((modelEntry, modelIndex) => (
                                  <div
                                    key={`${modelEntry.model || 'model'}-${modelEntry.alias || 'alias'}-${modelIndex}`}
                                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,180px)_40px] gap-3"
                                  >
                                    <Input
                                      label={modelIndex === 0 ? 'Model ID' : undefined}
                                      value={modelEntry.model || ''}
                                      data-testid={`desktop-workspace-provider-model-id-${index}-${modelIndex}`}
                                      onChange={(event) =>
                                        updateSelectedProvider(index, (currentProvider) => {
                                          const models = [...(currentProvider.models || [])];
                                          models[modelIndex] = { ...models[modelIndex], model: event.target.value };
                                          return { ...currentProvider, models };
                                        })
                                      }
                                    />
                                    <Input
                                      label={modelIndex === 0 ? 'Alias' : undefined}
                                      value={modelEntry.alias || ''}
                                      placeholder="optional"
                                      data-testid={`desktop-workspace-provider-model-alias-${index}-${modelIndex}`}
                                      onChange={(event) =>
                                        updateSelectedProvider(index, (currentProvider) => {
                                          const models = [...(currentProvider.models || [])];
                                          models[modelIndex] = { ...models[modelIndex], alias: event.target.value };
                                          return { ...currentProvider, models };
                                        })
                                      }
                                    />
                                    <div className="flex items-end">
                                      <Button
                                        variant="danger"
                                        size="sm"
                                        onClick={() =>
                                          updateSelectedProvider(index, (currentProvider) => {
                                            const models = [...(currentProvider.models || [])];
                                            models.splice(modelIndex, 1);
                                            return { ...currentProvider, models };
                                          })
                                        }
                                      >
                                        <Trash2 size={14} />
                                      </Button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            <Textarea
                              label="Current models JSON"
                              readOnly
                              rows={3}
                              value={JSON.stringify(provider.models || [], null, 2)}
                              className="font-mono text-xs"
                            />
                          </div>

                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-sm font-medium text-gray-900 dark:text-white">Environment overrides</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                  Extra variables such as custom auth headers or provider-specific toggles.
                                </p>
                              </div>
                              <Button
                                size="sm"
                                variant="secondary"
                                data-testid={`desktop-workspace-provider-add-env-${index}`}
                                onClick={() =>
                                  updateSelectedProvider(index, (currentProvider) => {
                                    const env = { ...(currentProvider.env || {}) };
                                    let nextKey = `ENV_VAR_${Object.keys(env).length + 1}`;
                                    while (env[nextKey] !== undefined) {
                                      nextKey = `ENV_VAR_${Object.keys(env).length + 2}`;
                                    }
                                    env[nextKey] = '';
                                    return { ...currentProvider, env };
                                  })
                                }
                              >
                                <Plus size={14} /> Env
                              </Button>
                            </div>

                            {Object.entries(provider.env || {}).length === 0 ? (
                              <div className="rounded-xl border border-dashed border-gray-200/80 dark:border-white/[0.08] px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                                No environment overrides yet.
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {Object.entries(provider.env || {}).map(([envKey, envValue], envIndex) => (
                                  <div
                                    key={`${envKey}-${envIndex}`}
                                    className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_40px] gap-3"
                                  >
                                    <Input
                                      label={envIndex === 0 ? 'Key' : undefined}
                                      value={envKey}
                                      data-testid={`desktop-workspace-provider-env-key-${index}-${envIndex}`}
                                      onChange={(event) =>
                                        updateSelectedProvider(index, (currentProvider) => {
                                          const nextKey = event.target.value.trim();
                                          const env = { ...(currentProvider.env || {}) };
                                          const currentValue = env[envKey] || '';
                                          delete env[envKey];
                                          env[nextKey || envKey] = currentValue;
                                          return { ...currentProvider, env };
                                        })
                                      }
                                    />
                                    <Input
                                      label={envIndex === 0 ? 'Value' : undefined}
                                      value={String(envValue || '')}
                                      data-testid={`desktop-workspace-provider-env-value-${index}-${envIndex}`}
                                      onChange={(event) =>
                                        updateSelectedProvider(index, (currentProvider) => ({
                                          ...currentProvider,
                                          env: {
                                            ...(currentProvider.env || {}),
                                            [envKey]: event.target.value,
                                          },
                                        }))
                                      }
                                    />
                                    <div className="flex items-end">
                                      <Button
                                        variant="danger"
                                        size="sm"
                                        onClick={() =>
                                          updateSelectedProvider(index, (currentProvider) => {
                                            const env = { ...(currentProvider.env || {}) };
                                            delete env[envKey];
                                            return { ...currentProvider, env };
                                          })
                                        }
                                      >
                                        <Trash2 size={14} />
                                      </Button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            <Textarea
                              label="Current env JSON"
                              readOnly
                              rows={3}
                              value={JSON.stringify(provider.env || {}, null, 2)}
                              className="font-mono text-xs"
                            />
                          </div>
                        </div>
                      ))}
                    </section>

                    <section className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="font-medium text-gray-900 dark:text-white">Platforms</h3>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            updateSelectedProject((project) => ({
                              ...project,
                              platforms: [...(project.platforms || []), { type: 'telegram', options: {} }],
                            }))
                          }
                        >
                          <Plus size={14} /> Platform
                        </Button>
                      </div>
                      {(selectedProject.platforms || []).map((platform, index) => (
                        <div key={`${platform.type}-${index}`} className="grid grid-cols-[240px_minmax(0,1fr)_40px] gap-3">
                          <div className="space-y-3">
                            <Select
                              label="Type"
                              value={getSelectValue(platform.type, DESKTOP_PLATFORM_TYPE_OPTIONS)}
                              onChange={(event) =>
                                updateSelectedProject((project) => {
                                  const platforms = [...(project.platforms || [])];
                                  platforms[index] = {
                                    ...platforms[index],
                                    type: event.target.value === CUSTOM_SELECT_VALUE ? '' : event.target.value,
                                  };
                                  return { ...project, platforms };
                                })
                              }
                            >
                              {DESKTOP_PLATFORM_TYPE_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                              <option value={CUSTOM_SELECT_VALUE}>custom</option>
                            </Select>
                            {getSelectValue(platform.type, DESKTOP_PLATFORM_TYPE_OPTIONS) === CUSTOM_SELECT_VALUE && (
                              <Input
                                label="Custom platform type"
                                value={platform.type}
                                onChange={(event) =>
                                  updateSelectedProject((project) => {
                                    const platforms = [...(project.platforms || [])];
                                    platforms[index] = { ...platforms[index], type: event.target.value };
                                    return { ...project, platforms };
                                  })
                                }
                                placeholder="Enter a platform type supported by cc-connect"
                              />
                            )}
                          </div>
                          <div className="space-y-3">
                            {getPlatformFieldDefinitions(platform.type, platform.options || {}).length > 0 ? (
                              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                                {getPlatformFieldDefinitions(platform.type, platform.options || {}).map((field) => {
                                  const optionValue = platform.options?.[field.key];
                                  if (field.type === 'boolean') {
                                    return (
                                      <label
                                        key={field.key}
                                        className="flex items-center gap-3 rounded-lg border border-gray-200/80 dark:border-white/[0.08] px-3 py-2 text-sm text-gray-700 dark:text-gray-300"
                                      >
                                        <input
                                          type="checkbox"
                                          checked={Boolean(optionValue)}
                                          onChange={(event) =>
                                            updateSelectedProject((project) => {
                                              const platforms = [...(project.platforms || [])];
                                              const current = { ...(platforms[index].options || {}) };
                                              current[field.key] = event.target.checked;
                                              platforms[index] = { ...platforms[index], options: current };
                                              return { ...project, platforms };
                                            })
                                          }
                                        />
                                        {field.label}
                                      </label>
                                    );
                                  }

                                  if (field.type === 'select') {
                                    return (
                                      <Select
                                        key={field.key}
                                        label={field.label}
                                        value={String(optionValue ?? field.options?.[0] ?? '')}
                                        onChange={(event) =>
                                          updateSelectedProject((project) => {
                                            const platforms = [...(project.platforms || [])];
                                            const current = { ...(platforms[index].options || {}) };
                                            current[field.key] = event.target.value;
                                            platforms[index] = { ...platforms[index], options: current };
                                            return { ...project, platforms };
                                          })
                                        }
                                      >
                                        {(field.options || []).map((option) => (
                                          <option key={option} value={option}>
                                            {option}
                                          </option>
                                        ))}
                                      </Select>
                                    );
                                  }

                                  return (
                                    <Input
                                      key={field.key}
                                      label={field.label}
                                      type={field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text'}
                                      value={optionValue === undefined || optionValue === null ? '' : String(optionValue)}
                                      placeholder={field.placeholder}
                                      onChange={(event) =>
                                        updateSelectedProject((project) => {
                                          const platforms = [...(project.platforms || [])];
                                          const current = { ...(platforms[index].options || {}) };
                                          current[field.key] = coercePlatformOptionValue(field.type, event.target.value);
                                          platforms[index] = { ...platforms[index], options: current };
                                          return { ...project, platforms };
                                        })
                                      }
                                    />
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="rounded-xl border border-dashed border-gray-200/80 dark:border-white/[0.08] px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                                No guided fields for this platform type yet. Use Raw TOML for advanced setup.
                              </div>
                            )}
                            <Textarea
                              label="Current options JSON"
                              value={JSON.stringify(platform.options || {}, null, 2)}
                              readOnly
                              rows={6}
                              className="font-mono text-[12px]"
                            />
                          </div>
                          <div className="flex items-end">
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() =>
                                updateSelectedProject((project) => {
                                  const platforms = [...(project.platforms || [])];
                                  platforms.splice(index, 1);
                                  return { ...project, platforms };
                                })
                              }
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </section>

                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/30 dark:bg-amber-950/20 dark:text-amber-300">
                      Visual editing covers the stable fields for v1. Keep complex option maps, speech/TTS, webhook, and relay sections in the raw TOML editor.
                    </div>

                    <div className="flex gap-2">
                      <Button
                        onClick={() => void handleSaveVisual()}
                        loading={pendingAction === 'save-visual'}
                        disabled={!visualDirty && pendingAction !== 'save-visual'}
                      >
                        <Save size={14} /> Save config
                      </Button>
                      <Button
                        variant="secondary"
                        data-testid="desktop-workspace-save-restart"
                        onClick={() => void handleSaveAndRestart()}
                        loading={pendingAction === 'save-restart'}
                        disabled={!visualDirty && !restartPending && pendingAction !== 'save-restart'}
                      >
                        <Wrench size={14} /> Save and restart service
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <Textarea
                label="config.toml"
                rows={28}
                value={rawDraft}
                onChange={(event) => setRawDraft(event.target.value)}
                className="font-mono text-[13px]"
              />
              <div className="flex gap-2">
                <Button
                  onClick={() => void handleSaveRaw()}
                  loading={pendingAction === 'save-raw'}
                  disabled={!rawDirty && pendingAction !== 'save-raw'}
                >
                  <Save size={14} /> Save raw config
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void handleRestartService()}
                  loading={pendingAction === 'restart'}
                  disabled={!runtimeReady && !restartPending && pendingAction !== 'restart'}
                >
                  Restart service
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Project summary</h3>
        <div className="flex flex-wrap gap-2">
          {projectNames.length === 0 ? (
            <span className="text-sm text-gray-400">No projects configured.</span>
          ) : (
            projectNames.map((name) => (
              <span
                key={name}
                className="px-3 py-1.5 rounded-full bg-gray-100 dark:bg-white/[0.06] text-sm text-gray-700 dark:text-gray-300"
              >
                {name}
              </span>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
