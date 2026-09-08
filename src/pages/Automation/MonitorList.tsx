import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Check, Copy, Plus } from 'lucide-react';
import { subscribeEvents } from '@cc/core-sdk/runtime';
import {
  createAutomationMonitor as createMonitor,
  deleteAutomationMonitor as deleteMonitor,
  listAutomationMonitors as listMonitors,
  runAutomationMonitor as runMonitorNow,
  updateAutomationMonitor as updateMonitor,
} from '@cc/core-sdk/automation';
import { listWorkspaces } from '@cc/core-sdk/threads';
import type { AutomationMonitor as Monitor, AutomationMonitorCreateInput as MonitorCreateInput } from '@cc/superai-contracts';
import { Badge, Button, Card, EmptyState, PageHeader, RowActions } from '@/components/ui';
import { formatTime } from '@/lib/utils';
import MonitorModal, { conditionToText, sourceDefinitions } from './MonitorModal';

export default function MonitorList() {
  const { t } = useTranslation();
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingMonitor, setEditingMonitor] = useState<Monitor | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchMonitors = useCallback(async () => {
    setLoading(true);
    try {
      const [monitorData, workspaceData] = await Promise.all([
        listMonitors(),
        listWorkspaces().then((data) => data.workspaces),
      ]);
      setMonitors(monitorData.monitors || []);
      setWorkspaces(workspaceData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMonitors();
    const dispose = subscribeEvents((event) => {
      if (event.type === 'automation.monitor.updated' || event.type === 'automation.monitor.run.updated') {
        void fetchMonitors();
      }
    });
    return () => dispose();
  }, [fetchMonitors]);

  const openCreate = () => {
    setEditingMonitor(null);
    setShowModal(true);
  };

  const openEdit = (monitor: Monitor) => {
    setEditingMonitor(monitor);
    setShowModal(true);
  };

  const handleSave = async (payload: MonitorCreateInput) => {
    if (editingMonitor) {
      await updateMonitor(editingMonitor.id, payload);
    } else {
      await createMonitor(payload);
    }
    await fetchMonitors();
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('common.confirmDelete'))) return;
    await deleteMonitor(id);
    await fetchMonitors();
  };

  const handleRun = async (id: string) => {
    await runMonitorNow(id);
    await fetchMonitors();
  };

  const handleCopyCurl = (monitor: Monitor) => {
    const hookId = String(monitor.sourceConfig.hookId || '');
    const token = String(monitor.sourceConfig.token || '');
    const tokenHeader = token ? ` -H "Authorization: Bearer ${token}"` : '';
    const cmd = `curl -X POST http://127.0.0.1:9831/api/local/v1/automation/hooks/${encodeURIComponent(hookId)}${tokenHeader} -H "Content-Type: application/json" -d '{"event":"ping"}'`;
    void navigator.clipboard.writeText(cmd);
    setCopiedId(monitor.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  if (loading && monitors.length === 0) {
    return <div className="flex h-64 items-center justify-center text-gray-400 animate-pulse">{t('common.loading')}</div>;
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <PageHeader
        title={t('monitors.title')}
        description="Create event monitors that trigger agent analysis and stream results back to channels."
        actions={<Button onClick={openCreate}><Plus size={16} /> {t('monitors.add')}</Button>}
      />

      {monitors.length === 0 ? (
        <EmptyState message={t('monitors.noMonitors')} icon={Bell} />
      ) : (
        <div className="space-y-3">
          {monitors.map((monitor) => (
            <Card key={monitor.id} className="app-panel">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{monitor.title}</span>
                    <Badge variant={monitor.enabled ? 'success' : 'default'}>{monitor.enabled ? t('monitors.enabled') : 'disabled'}</Badge>
                    <Badge variant="default">{monitor.sourceType}</Badge>
                    <Badge variant="default">{monitor.platform}</Badge>
                    {monitor.lastStatus && <Badge variant={monitor.lastStatus === 'failed' ? 'danger' : 'default'}>{monitor.lastStatus}</Badge>}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                    <span><strong>Workspace:</strong> {monitor.workspaceId}</span>
                    <span><strong>Subject:</strong> {sourceDefinitions[monitor.sourceType as keyof typeof sourceDefinitions]?.renderSummary(monitor) || monitor.sourceType}</span>
                    <span><strong>Condition:</strong> {conditionToText(monitor)}</span>
                    <span><strong>Execution:</strong> {monitor.executionMode}</span>
                    <span><strong>Cooldown:</strong> {Math.round(monitor.cooldownMs / 60000)}m</span>
                    {monitor.lastTriggeredAt && <span><strong>{t('monitors.lastRun')}:</strong> {formatTime(monitor.lastTriggeredAt)}</span>}
                  </div>
                  {monitor.sourceType === 'webhook' && Boolean(monitor.sourceConfig.hookId) && (
                    <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-black/5 bg-black/[0.02] px-3 py-1.5 text-xs dark:border-white/5 dark:bg-white/[0.02]">
                      <span className="font-mono text-gray-600 dark:text-gray-300">
                        Endpoint: <code>/api/local/v1/automation/hooks/{String(monitor.sourceConfig.hookId)}</code>
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyCurl(monitor)}
                        className="inline-flex items-center gap-1 font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                        title="Copy curl command"
                      >
                        {copiedId === monitor.id ? <Check size={12} /> : <Copy size={12} />}
                        {copiedId === monitor.id ? 'Copied' : 'Copy curl'}
                      </button>
                    </div>
                  )}
                  <p className="mt-3 line-clamp-3 rounded-[16px] bg-black/[0.035] px-3 py-2 text-sm leading-6 text-gray-700 dark:bg-white/[0.05] dark:text-gray-300">{monitor.promptTemplate}</p>
                  {monitor.lastError && <p className="mt-2 text-xs text-red-500">{monitor.lastError}</p>}
                </div>
                <RowActions
                  labels={{ run: t('monitors.run'), edit: t('monitors.edit'), delete: t('common.delete') }}
                  onRun={() => handleRun(monitor.id)}
                  onEdit={() => openEdit(monitor)}
                  onDelete={() => handleDelete(monitor.id)}
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      {showModal && (
        <MonitorModal
          open={showModal}
          editingMonitor={editingMonitor}
          workspaces={workspaces}
          onClose={() => setShowModal(false)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
