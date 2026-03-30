import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const rootDir = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-connect-desktop-e2e-'));
const userDataDir = path.join(tempRoot, 'user-data');
const outputPath = path.join(tempRoot, 'smoke-result.json');

function log(message) {
  process.stdout.write(`[e2e] ${message}\n`);
}

async function waitForFile(filePath, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for smoke result at ${filePath}`);
}

async function main() {
  log(`userDataDir=${userDataDir}`);

  const child = spawn('node', ['scripts/launch-electron.mjs', '.'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      CC_CONNECT_DESKTOP_USER_DATA_DIR: userDataDir,
      CC_CONNECT_DESKTOP_SMOKE_OUTPUT: outputPath,
    },
  });

  const [result, exitCode] = await Promise.all([
    waitForFile(outputPath),
    new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1))),
  ]);

  log(`electron exit code=${exitCode}`);
  log(`result: ${JSON.stringify(result, null, 2)}`);

  fs.rmSync(tempRoot, { recursive: true, force: true });

  if (!result.ok || exitCode !== 0) {
    throw new Error('Smoke test failed');
  }
}

main().catch((error) => {
  process.stderr.write(`[e2e] FAILED: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
