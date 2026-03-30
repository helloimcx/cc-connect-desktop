import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export function writeElectronPackageMetadata(rootDir = process.cwd()) {
  const distElectronDir = path.join(rootDir, 'dist-electron');
  fs.mkdirSync(distElectronDir, { recursive: true });
  fs.writeFileSync(
    path.join(distElectronDir, 'package.json'),
    `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
    'utf8',
  );
}

writeElectronPackageMetadata();
