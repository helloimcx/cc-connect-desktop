import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import App from './App';
import AppErrorBoundary from './components/AppErrorBoundary';
import './index.css';
import './i18n';
import { useAuthStore } from './store/auth';
import { useThemeStore } from './store/theme';
import { isDesktopApp, getRuntimeStatus } from './api/desktop';
import { api } from './api/client';

useAuthStore.getState().init();
useThemeStore.getState().init();

async function bootstrap() {
  if (isDesktopApp()) {
    try {
      const runtime = await getRuntimeStatus();
      api.setBaseUrl(runtime.managementBaseUrl);
      api.setToken(runtime.settings.managementToken);
      useAuthStore.getState().setDesktopSession(runtime.settings.managementToken, runtime.managementBaseUrl);
    } catch {
      // Keep the renderer usable even if preload/runtime initialization fails.
    }
  }

  const Router = isDesktopApp() ? HashRouter : BrowserRouter;
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <Router>
          <App />
        </Router>
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
