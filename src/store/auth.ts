import { create } from 'zustand';
import { api } from '@/api/client';

interface AuthState {
  token: string;
  serverUrl: string;
  isAuthenticated: boolean;
  desktopManaged: boolean;
  login: (token: string, serverUrl?: string) => void;
  setDesktopSession: (token: string, serverUrl: string) => void;
  logout: () => void;
  init: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: '',
  serverUrl: '',
  isAuthenticated: false,
  desktopManaged: false,
  login: (token: string, serverUrl?: string) => {
    api.setToken(token);
    if (serverUrl) api.setBaseUrl(serverUrl);
    localStorage.setItem('cc_token', token);
    if (serverUrl) localStorage.setItem('cc_server_url', serverUrl);
    set({ token, serverUrl: serverUrl || '', isAuthenticated: true, desktopManaged: false });
  },
  setDesktopSession: (token: string, serverUrl: string) => {
    api.setToken(token);
    api.setBaseUrl(serverUrl);
    set({ token, serverUrl, isAuthenticated: true, desktopManaged: true });
  },
  logout: () => {
    const current = useAuthStore.getState();
    if (current.desktopManaged) {
      return;
    }
    api.setToken('');
    api.setBaseUrl('');
    localStorage.removeItem('cc_token');
    localStorage.removeItem('cc_server_url');
    set({ token: '', serverUrl: '', isAuthenticated: false, desktopManaged: false });
  },
  init: () => {
    const token = localStorage.getItem('cc_token') || '';
    const serverUrl = localStorage.getItem('cc_server_url') || '';
    if (token) {
      api.setToken(token);
      if (serverUrl) {
        api.setBaseUrl(serverUrl);
      }
      set({ token, serverUrl, isAuthenticated: true, desktopManaged: false });
    }
  },
}));
