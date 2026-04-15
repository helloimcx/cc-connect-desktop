import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import { cn } from '@/lib/utils';
import { getRuntimeProvider, supportsDesktopChat } from '@/app/runtime';

export default function Layout() {
  const { pathname } = useLocation();
  const compactDesktopChatLayout =
    pathname.startsWith('/chat') && supportsDesktopChat() && getRuntimeProvider() === 'electron';

  return (
    <div
      className={cn(
        'flex h-screen overflow-hidden',
        'bg-gradient-to-br from-gray-100 via-white to-gray-100',
        'dark:from-gray-950 dark:via-[#0a0a0c] dark:to-gray-950'
      )}
    >
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {compactDesktopChatLayout ? null : <Header />}
        <main className={cn(
          'flex-1',
          compactDesktopChatLayout ? 'overflow-hidden p-0' : 'overflow-y-auto p-6',
        )}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
