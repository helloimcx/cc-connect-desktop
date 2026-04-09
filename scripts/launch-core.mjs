import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const rootDir = process.cwd();
const entry = path.join(rootDir, 'dist-electron', 'services', 'local-ai-core', 'src', 'standalone.js');

if (!fs.existsSync(entry)) {
  console.error('[core] Missing compiled Local AI Core entry. Run `pnpm build:electron` first.');
  process.exit(1);
}

await import(pathToFileURL(entry).href);
