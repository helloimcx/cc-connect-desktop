export type AppMode = 'desktop' | 'web';
export type RuntimeProvider = 'electron' | 'local_core' | 'web_remote';

let runtimeProvider: RuntimeProvider =
  typeof window !== 'undefined' && Boolean(window.desktop) ? 'electron' : 'web_remote';

function hasDesktopBridge() {
  return typeof window !== 'undefined' && Boolean(window.desktop);
}

export function getRuntimeProvider(): RuntimeProvider {
  return runtimeProvider;
}

export function setRuntimeProvider(next: RuntimeProvider) {
  runtimeProvider = next;
}

export function getAppMode(): AppMode {
  return runtimeProvider === 'web_remote' ? 'web' : 'desktop';
}

export function isDesktopApp() {
  return runtimeProvider === 'electron';
}

export function isLocalCoreApp() {
  return runtimeProvider === 'local_core';
}

export function isWebApp() {
  return runtimeProvider === 'web_remote';
}

export function supportsDesktopRuntime() {
  return runtimeProvider === 'electron' || runtimeProvider === 'local_core';
}

export function supportsDesktopChat() {
  return supportsDesktopRuntime();
}

export function supportsChatRoute() {
  return true;
}

export function supportsDesktopWorkspace() {
  return supportsDesktopRuntime();
}
