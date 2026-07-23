// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(packageRoot, 'dist');

await rm(distDir, { force: true, recursive: true });
await execFileAsync('pnpm', ['exec', 'tsc', '--project', 'tsconfig.build.json', '--noEmit'], {
  cwd: packageRoot,
});
await mkdir(distDir, { recursive: true });
await copyFile(path.join(packageRoot, 'src/index.js'), path.join(distDir, 'index.js'));
