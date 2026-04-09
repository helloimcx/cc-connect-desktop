import { spawn } from 'node:child_process';
import process from 'node:process';
import { getElectronBinaryPath } from './electron-bin.mjs';

const BENIGN_MACOS_ELECTRON_STDERR_PATTERNS = [
  'TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit',
  'error messaging the mach port for IMKCFRunLoopWakeUpReliable',
];

function isBenignElectronStderrLine(line) {
  return BENIGN_MACOS_ELECTRON_STDERR_PATTERNS.some((pattern) => line.includes(pattern));
}

const child = spawn(getElectronBinaryPath(), process.argv.slice(2), {
  stdio: ['inherit', 'inherit', 'pipe'],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
  },
});

let stderrBuffer = '';
child.stderr?.setEncoding('utf8');
child.stderr?.on('data', (chunk) => {
  stderrBuffer += chunk;
  const lines = stderrBuffer.split(/\r?\n/);
  stderrBuffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line || isBenignElectronStderrLine(line)) {
      continue;
    }
    process.stderr.write(`${line}\n`);
  }
});

child.on('exit', (code, signal) => {
  if (stderrBuffer && !isBenignElectronStderrLine(stderrBuffer)) {
    process.stderr.write(stderrBuffer);
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
