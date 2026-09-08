import type { MonitorProviderRuntime } from '@cc/plugin-sdk';

export class WebhookMonitorProvider implements MonitorProviderRuntime {
  readonly sourceType = 'webhook';
  readonly modes = ['webhook' as const];

  validateConfig(config: Record<string, unknown>): void {
    if (config.hookId !== undefined && (typeof config.hookId !== 'string' || !config.hookId.trim())) {
      throw new Error('webhook monitor requires sourceConfig.hookId to be a non-empty string.');
    }
    if (config.token !== undefined && (typeof config.token !== 'string' || !config.token.trim())) {
      throw new Error('webhook monitor requires sourceConfig.token to be a non-empty string.');
    }
  }
}
