import type { MonitorPlugin, MonitorRuntimeRegistration } from '@cc/plugin-sdk';
import { WebhookMonitorProvider } from '../../automation/webhook-provider.js';

export function createBuiltinWebhookMonitorPlugin(): MonitorPlugin {
  return {
    manifest: {
      id: 'builtin.monitor-webhook',
      kind: 'monitor',
      version: '0.1.0',
      provides: ['monitor.source.webhook'],
    },
    capabilities: {
      monitors: [
        {
          id: 'monitor.source.webhook',
          sourceTypes: ['webhook'],
          modes: ['webhook'],
          enabled: true,
          displayName: 'Inbound Webhook Monitor',
        },
      ],
    },
    createRuntime(): MonitorRuntimeRegistration {
      return {
        providers: [new WebhookMonitorProvider()],
      };
    },
  };
}
