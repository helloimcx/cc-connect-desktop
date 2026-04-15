import process from 'node:process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CcConnectController } from '../../../packages/adapter-cc-connect/src/index.js';
import { LocalAiCoreServer } from './server.js';

async function main() {
  const userDataPath = process.env.AI_WORKSTATION_USER_DATA_DIR?.trim() || join(process.cwd(), '.ai-workstation-core');
  mkdirSync(userDataPath, { recursive: true });
  const controller = new CcConnectController(userDataPath);
  await controller.init();
  const server = new LocalAiCoreServer(controller);
  await server.start();
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

void main();
