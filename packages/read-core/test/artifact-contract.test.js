// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertRunnableTestFiles, discoverTestFiles } from '../scripts/discover-tests.mjs';
import { assertManifestTargets, assertPackedFiles } from '../scripts/validate-package.mjs';

test('artifact validation rejects a missing emitted export target', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pdpp-read-core-missing-target-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await assert.rejects(
    assertManifestTargets({ exports: { '.': './dist/missing.js' } }, root),
    /ENOENT/,
  );
});

test('artifact validation rejects source-only package contents', () => {
  assert.throws(
    () => assertPackedFiles(['README.md', 'package.json', 'src/index.js'], { exports: { '.': './src/index.js' } }),
    /missing packed export target|source file leaked/,
  );
});

test('test discovery finds a renamed TypeScript test and refuses to silently skip it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pdpp-read-core-discovery-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const testDir = path.join(root, 'test');
  await mkdir(testDir);
  const names = [
    'legacy-artifact-contract.test.cjs',
    'renamed-artifact-contract.test.cts',
    'legacy-artifact-contract.test.js',
    'legacy-artifact-contract.test.mjs',
    'renamed-artifact-contract.test.mts',
    'renamed-artifact-contract.test.ts',
  ];
  await Promise.all(names.map((name) => writeFile(path.join(testDir, name), 'export {};\n')));

  const discovered = await discoverTestFiles(root);
  assert.deepEqual(
    discovered.map((file) => path.basename(file)),
    [...names].sort(),
  );
  assert.throws(() => assertRunnableTestFiles(discovered), /without a configured runtime/);
});
