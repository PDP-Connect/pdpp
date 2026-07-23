// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverTestFiles } from '../scripts/discover-tests.mjs';
import { assertManifestTargets } from '../scripts/package-contract.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function makeManifest(overrides = {}) {
  return {
    name: '@pdpp/cli',
    bin: { pdpp: './dist/bin/pdpp.js' },
    exports: { '.': './dist/src/index.js' },
    files: ['dist/', 'README.md'],
    ...overrides,
  };
}

function emittedFixture({ executable = true, shebang = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pdpp-cli-artifact-contract-'));
  mkdirSync(join(root, 'dist', 'bin'), { recursive: true });
  mkdirSync(join(root, 'dist', 'src'), { recursive: true });
  writeFileSync(join(root, 'dist', 'src', 'index.js'), 'export const artifact = true;\n');
  writeFileSync(join(root, 'dist', 'bin', 'pdpp.js'), `${shebang ? '#!/usr/bin/env node\n' : ''}console.log('pdpp');\n`);
  chmodSync(join(root, 'dist', 'bin', 'pdpp.js'), executable ? 0o755 : 0o644);
  return root;
}

test('artifact contract rejects a missing declared export', () => {
  const root = emittedFixture();
  assert.throws(
    () => assertManifestTargets(makeManifest({ exports: { '.': './dist/src/missing.js' } }), root),
    /is missing/,
  );
});

test('artifact contract rejects a missing declared bin', () => {
  const root = emittedFixture();
  assert.throws(
    () => assertManifestTargets(makeManifest({ bin: { pdpp: './dist/bin/missing.js' } }), root),
    /is missing/,
  );
});

test('artifact contract rejects source-only package targets', () => {
  const root = emittedFixture();
  assert.throws(
    () => assertManifestTargets(makeManifest({ exports: { '.': './src/index.js' } }), root),
    /must point into \.\/dist\//,
  );
});

test('artifact contract rejects a bin that loses its executable mode', () => {
  const root = emittedFixture({ executable: false });
  assert.throws(() => assertManifestTargets(makeManifest(), root), /must be executable/);
});

test('artifact contract rejects a bin that loses its shebang', () => {
  const root = emittedFixture({ shebang: false });
  assert.throws(() => assertManifestTargets(makeManifest(), root), /must retain its node shebang/);
});

test('extension-complete discovery finds a renamed TypeScript test', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pdpp-cli-test-discovery-'));
  writeFileSync(join(root, 'renamed-contract.test.mts'), 'export {};\n');
  writeFileSync(join(root, 'legacy.test.js'), 'export {};\n');
  writeFileSync(join(root, 'not-a-test.ts'), 'export {};\n');

  const files = await discoverTestFiles(root);
  assert.deepEqual(files.map((file) => file.split('/').at(-1)), ['legacy.test.js', 'renamed-contract.test.mts']);
});

test('the checked-in package contract points only at emitted files', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => assertManifestTargets(manifest, packageRoot));
});
