import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import AppErrorBoundary from './components/AppErrorBoundary';
import { Button } from './components/ui';
import './index.css';
import './i18n';
import { useAuthStore } from './store/auth';
import { useThemeStore } from './store/theme';
import { getDesktopLogs, getRuntimeStatus, onRuntimeEvent } from './api/desktop';
import { api } from './api/client';
import { isDesktopApp } from './app/runtime';

useAuthStore.getState().init();
useThemeStore.getState().init();

type BootstrapState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string; logs: string[] };

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-950 p-6">
      <div className="flex items-center gap-3 rounded-2xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 px-5 py-4 text-sm text-gray-600 dark:text-gray-300 shadow-sm">
        <RefreshCw size={16} className="animate-spin" />
        Initializing desktop runtime…
      </div>
    </div>
  );
}

function BootstrapFailureScreen({
  message,
  logs,
  onRetry,
}: {
  message: string;
  logs: string[];
  onRetry: () => void;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-950 p-6">
      <div className="max-w-2xl w-full rounded-3xl border border-red-200 dark:border-red-900/40 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
        <div className="px-6 py-5 border-b border-red-100 dark:border-red-900/30 bg-red-50/80 dark:bg-red-950/20">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-2xl bg-red-100 dark:bg-red-950/40 text-red-600 dark:text-red-300 flex items-center justify-center shrink-0">
              <AlertTriangle size={18} />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-red-700 dark:text-red-300">Desktop runtime failed to initialize</h1>
              <p className="mt-1 text-sm text-red-600 dark:text-red-400 break-words">{message}</p>
            </div>
          </div>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="rounded-2xl border border-gray-200 dark:border-white/[0.08] px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
            <p className="font-medium text-gray-900 dark:text-white">What we can do next</p>
            <p className="mt-1">
              Retry the desktop bootstrap first. If it still fails, check the runtime logs below and verify the local
              `cc-connect` binary path in your desktop settings.
            </p>
          </div>
          {logs.length > 0 && (
            <div className="rounded-2xl border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-gray-950/40 px-4 py-3">
              <p className="text-sm font-medium text-gray-900 dark:text-white">Recent desktop logs</p>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-600 dark:text-gray-300 font-mono">
                {logs.join('\n')}
              </pre>
            </div>
          )}
          <div className="flex gap-3">
            <Button onClick={onRetry}>
              <RefreshCw size={14} /> Retry bootstrap
            </Button>
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Reload app
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BootstrapApp() {
  const [state, setState] = useState<BootstrapState>({ status: 'loading' });

  const bootstrap = useCallback(async () => {
    setState({ status: 'loading' });
    if (isDesktopApp()) {
      try {
        const runtime = await getRuntimeStatus();
        api.setBaseUrl(runtime.managementBaseUrl);
        api.setToken(runtime.settings.managementToken);
        useAuthStore.getState().setDesktopSession(runtime.settings.managementToken, runtime.managementBaseUrl);
      } catch (error) {
        let logs: string[] = [];
        try {
          logs = await getDesktopLogs(80);
        } catch {
          logs = [];
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          logs,
        });
        return;
      }
    }

    setState({ status: 'ready' });
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!isDesktopApp()) {
      return;
    }
    return onRuntimeEvent((runtime) => {
      api.setBaseUrl(runtime.managementBaseUrl);
      api.setToken(runtime.settings.managementToken);
      useAuthStore.getState().setDesktopSession(runtime.settings.managementToken, runtime.managementBaseUrl);
    });
  }, []);

  if (state.status === 'loading') {
    return <LoadingScreen />;
  }
  if (state.status === 'error') {
    return <BootstrapFailureScreen message={state.message} logs={state.logs} onRetry={() => void bootstrap()} />;
  }

  return (
    <HashRouter>
      <App />
    </HashRouter>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <BootstrapApp />
  </AppErrorBoundary>,
);
