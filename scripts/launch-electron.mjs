import { spawn } from 'node:child_process';
import process from 'node:process';
import { getElectronBinaryPath } from './electron-bin.mjs';

const child = spawn(getElectronBinaryPath(), process.argv.slice(2), {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
