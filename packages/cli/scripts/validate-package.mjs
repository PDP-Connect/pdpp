// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertManifestTargets, assertPackedFiles, parseNpmPackOutput } from './package-contract.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const tempRoot = mkdtempSync(join(tmpdir(), 'pdpp-cli-artifact-'));

try {
  assertManifestTargets(manifest, packageRoot);
  const output = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', tempRoot],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  const [pack] = parseNpmPackOutput(output);
  const tarball = join(tempRoot, pack.filename);
  const packedFiles = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//, ''))
    .filter(Boolean)
    .sort();
  assertPackedFiles(manifest, packedFiles);

  const extractionRoot = join(tempRoot, 'extracted');
  mkdirSync(extractionRoot);
  execFileSync('tar', ['-xzf', tarball, '-C', extractionRoot], { encoding: 'utf8' });
  assertManifestTargets(manifest, join(extractionRoot, 'package'));
  process.stdout.write(`Validated ${pack.filename} (${packedFiles.length} files).\n`);
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}
