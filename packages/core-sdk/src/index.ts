import type {
  ConfigFileState,
  DesktopBridgeEvent,
  DesktopBridgeSendInput,
  DesktopBridgeSendResult,
  DesktopRuntimeStatus,
  DesktopSettings,
  DesktopSettingsInput,
  KnowledgeBase,
  KnowledgeBaseCreateInput,
  KnowledgeBaseUpdateInput,
  KnowledgeConfig,
  KnowledgeFile,
  KnowledgeFolder,
  KnowledgeFolderCreateInput,
  KnowledgeFolderUpdateInput,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  DesktopServiceState,
  KnowledgeSource,
  LocalCoreCapabilities,
  LocalCoreEvent,
  ThreadDetail,
  ThreadSummary,
  WorkspaceSummary,
} from '../../contracts/src';

export const LOCAL_AI_CORE_ORIGIN = 'http://127.0.0.1:9831';
export const LOCAL_AI_CORE_BASE = `${LOCAL_AI_CORE_ORIGIN}/api/local/v1`;

type JsonEnvelope<T> = {
  ok: boolean;
  data: T;
  error?: string;
};

const listeners = new Set<(event: LocalCoreEvent) => void>();
let eventSource: EventSource | null = null;

async function coreRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${LOCAL_AI_CORE_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json() as JsonEnvelope<T>;
  if (!response.ok || !json.ok) {
    throw new Error(json.error || `Local AI Core request failed: ${response.status}`);
  }
  return json.data;
}

function ensureEventSource() {
  if (eventSource || typeof window === 'undefined') {
    return;
  }
  eventSource = new EventSource(`${LOCAL_AI_CORE_BASE}/events`);
  const forward = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as LocalCoreEvent;
      listeners.forEach((listener) => listener(payload));
    } catch {
      // Ignore malformed payloads from a local dev server.
    }
  };
  [
    'runtime.updated',
    'thread.updated',
    'message.created',
    'message.updated',
    'run.updated',
    'presence.updated',
    'bridge.updated',
  ].forEach((eventName) => {
    eventSource?.addEventListener(eventName, forward as EventListener);
  });
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    if (listeners.size > 0) {
      window.setTimeout(() => ensureEventSource(), 1000);
    }
  };
}

function maybeCloseEventSource() {
  if (listeners.size === 0 && eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

export async function detectLocalAiCore(timeoutMs = 350) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${LOCAL_AI_CORE_BASE}/health`, { signal: controller.signal });
    const json = await response.json() as JsonEnvelope<{ name: string }>;
    return response.ok && json.ok && json.data?.name === 'local-ai-core';
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

export function subscribeEvents(listener: (event: LocalCoreEvent) => void) {
  listeners.add(listener);
  ensureEventSource();
  return () => {
    listeners.delete(listener);
    maybeCloseEventSource();
  };
}

export async function getCoreRuntime() {
  return coreRequest<DesktopRuntimeStatus>('GET', '/runtime');
}

export async function startCoreService() {
  return coreRequest<DesktopServiceState>('POST', '/runtime/service/start');
}

export async function stopCoreService() {
  return coreRequest<DesktopServiceState>('POST', '/runtime/service/stop');
}

export async function restartCoreService() {
  return coreRequest<DesktopServiceState>('POST', '/runtime/service/restart');
}

export async function getCoreLogs(limit?: number) {
  const suffix = typeof limit === 'number' ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return coreRequest<string[]>('GET', `/runtime/logs${suffix}`);
}

export async function readCoreConfigFile() {
  return coreRequest<ConfigFileState>('GET', '/runtime/config');
}

export async function saveCoreRawConfigFile(raw: string) {
  return coreRequest<ConfigFileState>('POST', '/runtime/config/raw', { raw });
}

export async function saveCoreStructuredConfigFile(config: unknown) {
  return coreRequest<ConfigFileState>('POST', '/runtime/config/structured', { config });
}

export async function saveCoreSettings(input: DesktopSettingsInput) {
  return coreRequest<DesktopSettings>('POST', '/runtime/settings', input);
}

export async function coreBridgeConnect() {
  return coreRequest<unknown>('POST', '/runtime/bridge/connect');
}

export async function coreBridgeDisconnect() {
  return coreRequest<unknown>('POST', '/runtime/bridge/disconnect');
}

export async function coreBridgeSendMessage(input: DesktopBridgeSendInput) {
  return coreRequest<DesktopBridgeSendResult>('POST', '/runtime/bridge/send-message', input);
}

export async function listWorkspaces() {
  return coreRequest<{ workspaces: WorkspaceSummary[] }>('GET', '/workspaces');
}

export async function listThreads(workspaceId: string) {
  return coreRequest<{ threads: ThreadSummary[] }>('GET', `/threads?workspace_id=${encodeURIComponent(workspaceId)}`);
}

export async function createThread(workspaceId: string, title?: string) {
  return coreRequest<ThreadDetail>('POST', '/threads', { workspaceId, title });
}

export async function getThread(threadId: string) {
  return coreRequest<ThreadDetail>('GET', `/threads/${encodeURIComponent(threadId)}`);
}

export async function renameThread(threadId: string, title: string) {
  return coreRequest<ThreadDetail>('PATCH', `/threads/${encodeURIComponent(threadId)}`, { title });
}

export async function deleteThread(threadId: string) {
  return coreRequest<{ deleted: boolean }>('DELETE', `/threads/${encodeURIComponent(threadId)}`);
}

export async function sendMessage(threadId: string, content: string) {
  return coreRequest<{ runId: string }>('POST', `/threads/${encodeURIComponent(threadId)}/messages`, { content });
}

export async function sendAction(threadId: string, content: string) {
  return coreRequest<{ runId: string }>('POST', `/threads/${encodeURIComponent(threadId)}/actions`, { content });
}

export async function interruptRun(runId: string) {
  return coreRequest<{ interrupted: boolean }>('POST', `/runs/${encodeURIComponent(runId)}/interrupt`);
}

export async function listKnowledgeSources() {
  return coreRequest<{ sources: KnowledgeSource[] }>('GET', '/knowledge/sources');
}

export async function getKnowledgeConfig() {
  return coreRequest<KnowledgeConfig>('GET', '/knowledge/config');
}

export async function saveKnowledgeConfig(input: Partial<KnowledgeConfig>) {
  return coreRequest<KnowledgeConfig>('POST', '/knowledge/config', input);
}

export async function listKnowledgeFolders() {
  return coreRequest<{ folders: KnowledgeFolder[] }>('GET', '/knowledge/folders');
}

export async function createKnowledgeFolder(input: KnowledgeFolderCreateInput) {
  return coreRequest<KnowledgeFolder>('POST', '/knowledge/folders', input);
}

export async function updateKnowledgeFolder(folderId: string, input: KnowledgeFolderUpdateInput) {
  return coreRequest<KnowledgeFolder>('PATCH', `/knowledge/folders/${encodeURIComponent(folderId)}`, input);
}

export async function deleteKnowledgeFolder(folderId: string) {
  return coreRequest<{ deleted: boolean }>('DELETE', `/knowledge/folders/${encodeURIComponent(folderId)}`);
}

export async function listKnowledgeBases() {
  return coreRequest<{ bases: KnowledgeBase[] }>('GET', '/knowledge/bases');
}

export async function createKnowledgeBase(input: KnowledgeBaseCreateInput) {
  return coreRequest<KnowledgeBase>('POST', '/knowledge/bases', input);
}

export async function getKnowledgeBase(knowledgeBaseId: string) {
  return coreRequest<KnowledgeBase>('GET', `/knowledge/bases/${encodeURIComponent(knowledgeBaseId)}`);
}

export async function updateKnowledgeBase(knowledgeBaseId: string, input: KnowledgeBaseUpdateInput) {
  return coreRequest<KnowledgeBase>('PATCH', `/knowledge/bases/${encodeURIComponent(knowledgeBaseId)}`, input);
}

export async function deleteKnowledgeBase(knowledgeBaseId: string) {
  return coreRequest<{ deleted: boolean }>('DELETE', `/knowledge/bases/${encodeURIComponent(knowledgeBaseId)}`);
}

export async function listKnowledgeBaseFiles(knowledgeBaseId: string) {
  return coreRequest<{ files: KnowledgeFile[] }>('GET', `/knowledge/bases/${encodeURIComponent(knowledgeBaseId)}/files`);
}

export async function uploadKnowledgeBaseFiles(
  knowledgeBaseId: string,
  input: {
    files: File[];
    collection: string;
    folder?: string;
  },
) {
  const formData = new FormData();
  formData.append('collection', input.collection);
  formData.append('knowledgebase_id', knowledgeBaseId);
  if (input.folder) {
    formData.append('folder', input.folder);
  }
  input.files.forEach((file) => {
    formData.append('files', file, file.name);
  });

  const response = await fetch(`${LOCAL_AI_CORE_BASE}/knowledge/bases/${encodeURIComponent(knowledgeBaseId)}/files`, {
    method: 'POST',
    body: formData,
  });
  const json = await response.json() as JsonEnvelope<{ results: Array<{
    fileId: string;
    fileName: string;
    fileType: string;
    success: boolean;
    message: string;
    wordCount?: number | null;
  }> }>;
  if (!response.ok || !json.ok) {
    throw new Error(json.error || `Local AI Core upload failed: ${response.status}`);
  }
  return json.data;
}

export async function deleteKnowledgeBaseFile(knowledgeBaseId: string, fileId: string) {
  return coreRequest<{ deleted: boolean }>(
    'DELETE',
    `/knowledge/bases/${encodeURIComponent(knowledgeBaseId)}/files/${encodeURIComponent(fileId)}`,
  );
}

export async function searchKnowledgeBase(knowledgeBaseId: string, input: KnowledgeSearchInput) {
  return coreRequest<{ results: KnowledgeSearchResult[] }>(
    'POST',
    `/knowledge/bases/${encodeURIComponent(knowledgeBaseId)}/search`,
    input,
  );
}

export async function getCapabilities() {
  return coreRequest<LocalCoreCapabilities>('GET', '/capabilities');
}

export function onRuntimeUpdated(listener: (runtime: DesktopRuntimeStatus) => void) {
  return subscribeEvents((event) => {
    if (event.type === 'runtime.updated') {
      listener(event.runtime);
    }
  });
}

export function onBridgeUpdated(listener: (event: DesktopBridgeEvent) => void) {
  return subscribeEvents((event) => {
    if (event.type === 'bridge.updated') {
      listener(event.bridge);
    }
    if (
      event.type === 'message.created' ||
      event.type === 'message.updated' ||
      event.type === 'run.updated' ||
      event.type === 'presence.updated'
    ) {
      if ('bridge' in event && event.bridge) {
        listener(event.bridge);
      }
    }
  });
}
