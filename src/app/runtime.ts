export type AppMode = 'desktop' | 'web';

function hasDesktopBridge() {
  return typeof window !== 'undefined' && Boolean(window.desktop);
}

export function getAppMode(): AppMode {
  return hasDesktopBridge() ? 'desktop' : 'web';
}

export function isDesktopApp() {
  return getAppMode() === 'desktop';
}

export function isWebApp() {
  return getAppMode() === 'web';
}

export function supportsDesktopRuntime() {
  return isDesktopApp();
}

export function supportsDesktopChat() {
  return isDesktopApp();
}

export function supportsDesktopWorkspace() {
  return isDesktopApp();
}
