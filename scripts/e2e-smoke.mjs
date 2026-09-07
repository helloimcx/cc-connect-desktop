import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const rootDir = process.cwd();
function log(message) {
  process.stdout.write(`[e2e] ${message}\n`);
}

async function waitForFile(filePath, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for smoke result at ${filePath}`);
}

function writeSettings(userDataDir, settings) {
  const runtimeDir = path.join(userDataDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, 'local-core-settings.json'),
    `${JSON.stringify({
      defaultProject: 'default',
      autoStartService: true,
      plugins: {},
      ...settings,
    }, null, 2)}\n`,
    'utf8',
  );
}

function assertSmokeSnapshot(name, result, options = {}) {
  const capabilities = result.capabilities?.data || result.capabilities;
  const pluginDiagnostics = result.pluginDiagnostics?.data || result.pluginDiagnostics;
  if (!capabilities?.agents?.some((capability) => capability.agentType === 'localcore-acp')) {
    throw new Error(`Smoke scenario ${name} did not expose localcore-acp in the capability snapshot`);
  }
  if (!pluginDiagnostics?.plugins?.length) {
    throw new Error(`Smoke scenario ${name} did not include plugin diagnostics`);
  }
  if (options.degradedPluginId) {
    const plugin = pluginDiagnostics.plugins.find((entry) => entry.pluginId === options.degradedPluginId);
    if (!plugin || plugin.health?.status !== 'degraded') {
      throw new Error(`Smoke scenario ${name} did not report degraded plugin ${options.degradedPluginId}`);
    }
  }
}

async function runScenario(name, extraEnv = {}, options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `agentdock-e2e-${name}-`));
  const userDataDir = path.join(tempRoot, 'user-data');
  const outputPath = path.join(tempRoot, 'smoke-result.json');
  options.setup?.(userDataDir);
  log(`scenario=${name} userDataDir=${userDataDir}`);
  const child = spawn('node', ['scripts/launch-electron.mjs', '.'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      AI_WORKSTATION_USER_DATA_DIR: userDataDir,
      AI_WORKSTATION_SMOKE_OUTPUT: outputPath,
      ...extraEnv,
    },
  });

  const [result, exitCode] = await Promise.all([
    waitForFile(outputPath),
    new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1))),
  ]);

  log(`scenario=${name} electron exit code=${exitCode}`);
  log(`scenario=${name} result: ${JSON.stringify(result, null, 2)}`);

  fs.rmSync(tempRoot, { recursive: true, force: true });

  if (!result.ok || exitCode !== 0) {
    throw new Error(`Smoke test failed for scenario ${name}`);
  }
  assertSmokeSnapshot(name, result, options);
}

async function main() {
  await runScenario('default');
  await runScenario('bootstrap-error', {
    AI_WORKSTATION_SMOKE_SCENARIO: 'bootstrap-error',
    AI_WORKSTATION_FORCE_RUNTIME_STATUS_ERROR: '1',
  });
  await runScenario('degraded-plugin', {}, {
    degradedPluginId: 'builtin.scheduler-lark',
    setup(userDataDir) {
      writeSettings(userDataDir, {
        plugins: {
          'builtin.scheduler-lark': { enabled: false },
        },
      });
    },
  });
}

main().catch((error) => {
  process.stderr.write(`[e2e] FAILED: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
