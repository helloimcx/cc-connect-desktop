import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Cable, Layers, Play, RotateCw, Server, Wrench } from 'lucide-react';
import { Badge, Button, Card, EmptyState, StatCard } from '@/components/ui';
import { getStatus, type SystemStatus } from '@/api/status';
import { listProjects, type ProjectSummary } from '@/api/projects';
import {
  getRuntimeStatus,
  onRuntimeEvent,
  restartDesktopService,
  startDesktopService,
} from '@/api/desktop';
import { formatUptime } from '@/lib/utils';
import type { DesktopRuntimeStatus } from '../../shared/desktop';
import { isDesktopApp, supportsDesktopRuntime, supportsDesktopWorkspace } from '@/app/runtime';

function formatRuntimePhase(phase?: DesktopRuntimeStatus['phase']) {
  switch (phase) {
    case 'starting':
      return 'starting';
    case 'api_ready':
      return 'API ready';
    case 'bridge_ready':
      return 'bridge ready';
    case 'error':
      return 'error';
    default:
      return 'stopped';
  }
}

export default function Dashboard() {
  const { t } = useTranslation();
  const [runtime, setRuntime] = useState<DesktopRuntimeStatus | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const desktop = isDesktopApp();
  const desktopRuntime = supportsDesktopRuntime();
  const desktopWorkspace = supportsDesktopWorkspace();

  const fetchData = useCallback(async (runtimeOverride?: DesktopRuntimeStatus | null) => {
    try {
      setLoading(true);
      setError('');
      let nextRuntime = runtimeOverride ?? null;
      if (desktop) {
        nextRuntime = runtimeOverride ?? await getRuntimeStatus();
        setRuntime(nextRuntime);
        if (nextRuntime.phase !== 'api_ready' && nextRuntime.phase !== 'bridge_ready') {
          setStatus(null);
          setProjects([]);
          return;
        }
      }
      const [s, p] = await Promise.all([getStatus(), listProjects()]);
      setStatus(s);
      setProjects(p.projects || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [desktop]);

  useEffect(() => {
    void fetchData();
    const handler = () => fetchData();
    window.addEventListener('cc:refresh', handler);
    const stopRuntime = desktop ? onRuntimeEvent((nextRuntime) => {
      setRuntime(nextRuntime);
      if (nextRuntime.phase === 'api_ready' || nextRuntime.phase === 'bridge_ready') {
        void fetchData(nextRuntime);
        return;
      }
      setStatus(null);
      setProjects([]);
      setError(nextRuntime.service.lastError || '');
    }) : () => {};
    return () => {
      window.removeEventListener('cc:refresh', handler);
      stopRuntime();
    };
  }, [desktop, fetchData]);

  if (loading && !status) {
    return <div className="flex items-center justify-center h-64 text-gray-400"><Activity className="animate-pulse" size={24} /></div>;
  }

  if (error && !desktop) {
    return <div className="text-center py-16 text-red-500">{error}</div>;
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {desktopRuntime && (
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Desktop Runtime</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Local `cc-connect` process, management API, and desktop bridge status.
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void startDesktopService().then(() => fetchData())} disabled={runtime?.phase === 'starting' || runtime?.phase === 'api_ready' || runtime?.phase === 'bridge_ready'}>
                <Play size={14} /> Start
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void restartDesktopService().then(() => fetchData())}>
                <RotateCw size={14} /> Restart
              </Button>
              {desktopWorkspace && (
                <Link to="/workspace">
                  <Button size="sm" variant="secondary">
                    <Wrench size={14} /> Workspace
                  </Button>
                </Link>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
            <StatCard label="Runtime" value={formatRuntimePhase(runtime?.phase)} accent={runtime?.phase === 'bridge_ready'} />
            <StatCard label="Bridge" value={runtime?.bridge.status || '-'} accent={runtime?.bridge.status === 'connected'} />
            <StatCard
              label="Config"
              value={!runtime?.configFile.exists ? 'Missing' : runtime?.pendingRestart ? 'Restart needed' : 'Ready'}
              accent={Boolean(runtime?.configFile.exists && !runtime?.pendingRestart)}
            />
          </div>

          {runtime?.pendingRestart && (
            <div className="mt-4 text-sm rounded-lg border border-amber-200 bg-amber-50 text-amber-700 px-4 py-3 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
              Config changes are already saved to disk, but the running desktop service is still using the previous state.
              Restart the service to apply the latest config.
            </div>
          )}

          {runtime?.service.lastError && (
            <div className="mt-4 text-sm rounded-lg border border-red-200 bg-red-50 text-red-600 px-4 py-3 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300">
              {runtime.service.lastError}
            </div>
          )}
          {error && (
            <div className="mt-4 text-sm rounded-lg border border-amber-200 bg-amber-50 text-amber-700 px-4 py-3 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
              {error}
            </div>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label={t('dashboard.version')} value={status?.version || '-'} accent />
        <StatCard label={t('dashboard.uptime')} value={status ? formatUptime(status.uptime_seconds) : '-'} />
        <StatCard label={t('dashboard.platforms')} value={status?.connected_platforms?.length ?? 0} />
        <StatCard label={t('dashboard.projects')} value={status?.projects_count ?? 0} />
      </div>

      {/* Bridge adapters */}
      {status?.bridge_adapters && status.bridge_adapters.length > 0 && (
        <Card>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">{t('dashboard.bridgeAdapters')}</h3>
          <div className="flex flex-wrap gap-2">
            {status.bridge_adapters.map((a, i) => (
              <Badge key={i} variant="info">{a.platform} → {a.project}</Badge>
            ))}
          </div>
        </Card>
      )}

      {/* Project list */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('nav.projects')}</h3>
          <Link to={desktop ? '/workspace' : '/projects'} className="text-xs text-accent hover:underline">{t('common.viewAll')}</Link>
        </div>
        {projects.length === 0 ? (
          <EmptyState message={t('projects.noProjects')} icon={Layers} />
        ) : (
          <div className="space-y-2">
            {projects.map((p) => (
              <Link
                key={p.name}
                to={desktop ? `/workspace?project=${encodeURIComponent(p.name)}` : `/projects/${p.name}`}
                className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                    <Server size={16} className="text-gray-500 dark:text-gray-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{p.name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {p.agent_type} · {p.platforms?.join(', ')} · {p.sessions_count} {t('nav.sessions').toLowerCase()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {p.heartbeat_enabled && <Badge variant="success">heartbeat</Badge>}
                  <ArrowRight size={16} className="text-gray-300 dark:text-gray-600 group-hover:text-accent transition-colors" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>

      {desktopRuntime && (
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Desktop Channel</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Open the dedicated chat UI to use this app as the `desktop` bridge channel.
              </p>
            </div>
            <Link to="/chat">
              <Button size="sm">
                <Cable size={14} /> Open Chat
              </Button>
            </Link>
          </div>
        </Card>
      )}

      {!desktopRuntime && (
        <Card>
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-2xl bg-sky-100 dark:bg-sky-950/30 text-sky-600 dark:text-sky-300 flex items-center justify-center shrink-0">
              <Server size={18} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Web Admin</h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                This browser build manages a remote `cc-connect` instance. Desktop runtime controls, desktop chat, and workspace runtime settings stay in the desktop app.
              </p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
