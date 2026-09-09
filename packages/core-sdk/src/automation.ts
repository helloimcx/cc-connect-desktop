import type {
  AutomationDecisionRecord,
  AutomationMonitor,
  AutomationMonitorCreateInput,
  AutomationMonitorRun,
  AutomationMonitorUpdateInput,
} from '@cc/superai-contracts/automation';
import { buildQuery, coreRequest } from './request.js';

export function listAutomationMonitors(workspaceId?: string) {
  const suffix = buildQuery({ workspace_id: workspaceId });
  return coreRequest<{ monitors: AutomationMonitor[] }>('GET', `/automation/monitors${suffix}`);
}

export function getAutomationMonitor(monitorId: string) {
  return coreRequest<AutomationMonitor>('GET', `/automation/monitors/${encodeURIComponent(monitorId)}`);
}

export function createAutomationMonitor(input: AutomationMonitorCreateInput) {
  return coreRequest<AutomationMonitor>('POST', '/automation/monitors', input);
}

export function updateAutomationMonitor(monitorId: string, input: AutomationMonitorUpdateInput) {
  return coreRequest<AutomationMonitor>('PATCH', `/automation/monitors/${encodeURIComponent(monitorId)}`, input);
}

export function deleteAutomationMonitor(monitorId: string) {
  return coreRequest<{ deleted: boolean }>('DELETE', `/automation/monitors/${encodeURIComponent(monitorId)}`);
}

export function runAutomationMonitor(monitorId: string) {
  return coreRequest<AutomationMonitorRun>('POST', `/automation/monitors/${encodeURIComponent(monitorId)}/run`);
}

export function listAutomationMonitorRuns(monitorId: string) {
  return coreRequest<{ runs: AutomationMonitorRun[] }>('GET', `/automation/monitors/${encodeURIComponent(monitorId)}/runs`);
}

export function listAutomationMonitorDecisions(monitorId: string) {
  return coreRequest<{ decisions: AutomationDecisionRecord[] }>('GET', `/automation/monitors/${encodeURIComponent(monitorId)}/decisions`);
}
