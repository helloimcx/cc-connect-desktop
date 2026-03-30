import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import Layout from '@/components/Layout/Layout';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import DesktopChat from '@/pages/Desktop/Chat';
import DesktopWorkspace from '@/pages/Desktop/Workspace';
import ProjectList from '@/pages/Projects/ProjectList';
import ProjectDetail from '@/pages/Projects/ProjectDetail';
import SessionList from '@/pages/Sessions/SessionList';
import SessionChat from '@/pages/Sessions/SessionChat';
import CronList from '@/pages/Cron/CronList';
import BridgeAdapters from '@/pages/Bridge/BridgeAdapters';
import SystemConfig from '@/pages/System/Config';
import SystemLogs from '@/pages/System/Logs';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function DesktopProjectRedirect() {
  const { name } = useParams<{ name: string }>();
  const desktopManaged = useAuthStore((s) => s.desktopManaged);
  if (!desktopManaged) {
    return <ProjectDetail />;
  }
  return <Navigate to={name ? `/workspace?project=${encodeURIComponent(name)}` : '/workspace'} replace />;
}

export default function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const desktopManaged = useAuthStore((s) => s.desktopManaged);

  return (
    <Routes>
      <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <Login />} />
      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="chat" element={<DesktopChat />} />
        <Route path="workspace" element={<DesktopWorkspace />} />
        <Route path="projects" element={desktopManaged ? <Navigate to="/workspace" replace /> : <ProjectList />} />
        <Route path="projects/:name" element={<DesktopProjectRedirect />} />
        <Route path="sessions" element={<SessionList />} />
        <Route path="sessions/:project/:id" element={<SessionChat />} />
        <Route path="cron" element={<CronList />} />
        <Route path="bridge" element={<BridgeAdapters />} />
        <Route path="system" element={<SystemConfig />} />
        <Route path="system/logs" element={<SystemLogs />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      <Route path="*" element={<Navigate to={isAuthenticated ? '/' : '/login'} replace />} />
    </Routes>
  );
}
