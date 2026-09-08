import type { PluginContext, PluginManifest, RuntimePlugin } from './runtime-types.js';

export interface MonitorCapability {
  id: string;
  sourceTypes: string[];
  modes?: Array<'poll' | 'subscribe' | 'webhook'>;
  enabled?: boolean;
  displayName?: string;
}

export type MonitorEvent = import('@cc/superai-contracts').AutomationMonitorEventSnapshot;

export interface MonitorProviderHandle {
  stop(): Promise<void> | void;
  getState?(): Record<string, unknown>;
}

export interface MonitorProviderRuntime {
  readonly sourceType: string;
  readonly modes: Array<'poll' | 'subscribe' | 'webhook'>;
  validateConfig?(config: Record<string, unknown>): void;
  poll?(input: {
    monitorId: string;
    workspaceId: string;
    sourceConfig: Record<string, unknown>;
    lastState?: Record<string, unknown>;
  }): Promise<MonitorEvent | null> | MonitorEvent | null;
  startMonitor?(input: {
    monitorId: string;
    workspaceId: string;
    sourceConfig: Record<string, unknown>;
    lastState?: Record<string, unknown>;
    emit: (event: MonitorEvent) => void | Promise<void>;
  }): Promise<MonitorProviderHandle> | MonitorProviderHandle;
}

export interface MonitorRuntimeRegistration {
  providers?: MonitorProviderRuntime[];
}

export interface MonitorPlugin extends RuntimePlugin {
  manifest: PluginManifest & { kind: 'monitor' | 'composite' };
  createRuntime?(ctx: PluginContext): Promise<MonitorRuntimeRegistration> | MonitorRuntimeRegistration;
}
