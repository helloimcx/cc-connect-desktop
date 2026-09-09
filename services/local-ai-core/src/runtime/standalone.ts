import process from 'node:process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LocalCoreController } from './local-core-controller.js';
import { LocalAiCoreServer } from './server.js';

async function main() {
  const userDataPath = process.env.AI_WORKSTATION_USER_DATA_DIR?.trim() || join(process.cwd(), '.agentdock-core');
  const host = process.env.AI_WORKSTATION_HOST?.trim() || '127.0.0.1';
  mkdirSync(userDataPath, { recursive: true });
  const controller = new LocalCoreController(userDataPath);
  const server = new LocalAiCoreServer({
    controller,
    channelService: controller.channelService,
    externalService: controller.externalService,
    workspaceRouter: controller.workspaceRouter,
    knowledgeProvider: controller.knowledgeProvider,
    scheduledJobs: controller.scheduledJobs,
    automationMonitors: controller.automationMonitors,
    automations: controller.automations,
    decisionLogService: controller.decisionLogService,
    store: controller.store,
    runtimeDetection: controller.runtimeDetection,
    kernel: controller.kernel,
    errorReporter: controller.errorReporter,
  }, { host });
  controller.on('logs', (line: string) => {
    if (!line) {
      return;
    }
    process.stdout.write(`[local-ai-core] ${line}\n`);
  });
  controller.on('bridge', (event: unknown) => {
    process.stdout.write(`[local-ai-core bridge] ${JSON.stringify(event)}\n`);
  });
  await server.start();
  await controller.init();
  process.on('SIGINT', async () => {
    await server.stop();
    await controller.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await server.stop();
    await controller.close();
    process.exit(0);
  });
}

void main().catch((error) => {
  const code = typeof error === 'object' && error ? (error as { code?: string }).code : '';
  if (code === 'EADDRINUSE') {
    process.stderr.write('[local-ai-core] Port 9831 is already in use; another Local AI Core process is listening.\n');
    process.exit(0);
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
