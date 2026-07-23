// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parsePackInfo } from './validate-package.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicExportNames = [
  'binaryFieldMetadata',
  'buildRecordContentLadder',
  'buildRecordSetContentLadder',
  'decodeContentHandle',
  'defaultEncodeResourceUri',
  'encodeContentHandle',
  'extractRecordRows',
  'formatEnvelopeHandles',
  'sanitizeRecordForEvidence',
  'stableInlineJson',
  'summarizeFieldWindowEvidence',
  'summarizeRecordEvidence',
  'truncateText',
];

async function run(command, args, options) {
  return execFileAsync(command, args, { maxBuffer: 1024 * 1024, ...options });
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const { stdout } = await run('npm', ['pack', '--json', '--ignore-scripts'], { cwd: packageRoot });
  const packInfo = parsePackInfo(stdout);
  const tarballPath = path.join(packageRoot, packInfo.filename);
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'pdpp-read-core-pack-'));
  const projectDir = path.join(tempRoot, 'consumer');

  try {
    await mkdir(projectDir, { recursive: true });
    await run('npm', ['init', '--yes'], { cwd: projectDir });
    await run('npm', ['install', '--ignore-scripts', '--offline', tarballPath], { cwd: projectDir });

    const { stdout: dependencyTree } = await run('npm', ['ls', '--json', '--all'], { cwd: projectDir });
    const installed = JSON.parse(dependencyTree).dependencies?.[manifest.name];
    assert.equal(installed?.version, manifest.version, 'consumer must resolve the candidate package version');

    const probePath = path.join(projectDir, 'probe.mjs');
    const probeSource = [
      "import assert from 'node:assert/strict';",
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      `const resolved = require.resolve(${JSON.stringify(manifest.name)});`,
      'assert.match(resolved, /node_modules\\/@pdpp\\/read-core\\/dist\\/index\\.js$/);',
      `const readCore = await import(${JSON.stringify(manifest.name)});`,
      `assert.deepEqual(Object.keys(readCore).sort(), ${JSON.stringify(publicExportNames)}.sort());`,
      `for (const name of ${JSON.stringify(publicExportNames)}) {`,
      "  assert.equal(typeof readCore[name], 'function', 'missing imported export: ' + name);",
      '}',
      "process.stdout.write('resolved=' + resolved + '\\nexports=' + Object.keys(readCore).sort().join(',') + '\\n');",
      '',
    ].join('\n');
    await writeFile(probePath, probeSource);
    const { stdout: probeOutput } = await run(process.execPath, [probePath], { cwd: projectDir });
    process.stdout.write(`Installed consumer proof:\n${probeOutput}`);
  } finally {
    await rm(tarballPath, { force: true });
    await rm(tempRoot, { force: true, recursive: true });
  }
}

await main();
