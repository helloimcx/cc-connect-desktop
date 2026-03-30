import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import net from 'node:net';
import { writeElectronPackageMetadata } from './write-electron-package.mjs';
import { getElectronBinaryPath } from './electron-bin.mjs';

const rootDir = process.cwd();
const distElectronDir = path.join(rootDir, 'dist-electron');
const devServerUrl = process.env.CC_CONNECT_DESKTOP_DEV_SERVER_URL ?? 'http://127.0.0.1:5173';
const isWindows = process.platform === 'win32';
const electronBinary = getElectronBinaryPath();

let electronProcess = null;
let shuttingDown = false;
let restartTimer = null;
let electronReady = false;
let serverReady = false;
let watchStarted = false;

writeElectronPackageMetadata(rootDir);

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
    shell: isWindows,
    ...options,
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }
    console.error(`[dev] ${command} exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
    shutdown(code ?? 1);
  });

  return child;
}

const viteProcess = spawnManaged('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5173']);
const tscProcess = spawnManaged('pnpm', ['exec', 'tsc', '-p', 'tsconfig.electron.json', '--watch', '--preserveWatchOutput']);

function isPortOpen(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForDevServer() {
  const url = new URL(devServerUrl);
  while (!shuttingDown) {
    if (await isPortOpen(Number(url.port || 80), url.hostname)) {
      serverReady = true;
      maybeLaunchElectron();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function maybeLaunchElectron() {
  if (shuttingDown || electronProcess || !electronReady || !serverReady) {
    return;
  }

  electronProcess = spawn(electronBinary, ['.'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      CC_CONNECT_DESKTOP_DEV_SERVER_URL: devServerUrl,
      NODE_ENV: 'development',
      ELECTRON_RUN_AS_NODE: undefined,
    },
  });

  electronProcess.on('exit', (code, signal) => {
    electronProcess = null;
    if (shuttingDown) {
      return;
    }
    if (code === 0 || signal === 'SIGTERM') {
      return;
    }
    console.error(`[dev] electron exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
    shutdown(code ?? 1);
  });
}

function restartElectron() {
  if (shuttingDown || !electronProcess) {
    maybeLaunchElectron();
    return;
  }

  const current = electronProcess;
  electronProcess = null;
  current.once('exit', () => {
    if (!shuttingDown) {
      maybeLaunchElectron();
    }
  });
  current.kill('SIGTERM');
}

function scheduleElectronRestart() {
  if (!watchStarted) {
    watchElectronOutput();
  }
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartElectron();
  }, 250);
}

function watchElectronOutput() {
  if (watchStarted) {
    return;
  }
  watchStarted = true;

  const watchTarget = fs.existsSync(distElectronDir) ? distElectronDir : rootDir;
  fs.watch(watchTarget, { recursive: true }, (_eventType, filename) => {
    if (!filename) {
      return;
    }
    const normalized = filename.replace(/\\/g, '/');
    if (!normalized.startsWith('electron/') && !normalized.startsWith('shared/')) {
      return;
    }
    if (!normalized.endsWith('.js')) {
      return;
    }
    if (fs.existsSync(path.join(distElectronDir, 'electron', 'main.js'))) {
      electronReady = true;
      scheduleElectronRestart();
    }
  });
}

function waitForElectronBuild() {
  const electronEntry = path.join(distElectronDir, 'electron', 'main.js');
  if (fs.existsSync(electronEntry)) {
    electronReady = true;
    watchElectronOutput();
    maybeLaunchElectron();
    return;
  }

  watchElectronOutput();
  const interval = setInterval(() => {
    if (shuttingDown) {
      clearInterval(interval);
      return;
    }
    if (!fs.existsSync(electronEntry)) {
      return;
    }
    clearInterval(interval);
    electronReady = true;
    maybeLaunchElectron();
  }, 300);
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (electronProcess) {
    electronProcess.kill('SIGTERM');
  }
  tscProcess.kill('SIGTERM');
  viteProcess.kill('SIGTERM');

  setTimeout(() => {
    process.exit(code);
  }, 100);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

waitForElectronBuild();
void waitForDevServer();
