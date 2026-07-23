// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

function assertInsideDist(packageRoot, target, label) {
  assert.equal(typeof target, 'string', `${label} must be a string target`);
  assert.equal(target.startsWith('./dist/'), true, `${label} must point into ./dist/: ${target}`);

  const distRoot = resolve(packageRoot, 'dist');
  const targetPath = resolve(packageRoot, target);
  const targetRelative = relative(distRoot, targetPath);
  assert.equal(
    targetRelative === '' || (!targetRelative.startsWith(`..${sep}`) && targetRelative !== '..'),
    true,
    `${label} escapes dist/: ${target}`,
  );
  assert.equal(existsSync(targetPath), true, `${label} is missing: ${target}`);
  return { target, targetPath };
}

function collectExportTargets(value, label, targets) {
  if (typeof value === 'string') {
    targets.push({ label, target: value });
    return;
  }
  assert.equal(value !== null && typeof value === 'object' && !Array.isArray(value), true, `${label} is invalid`);
  for (const [condition, target] of Object.entries(value)) {
    collectExportTargets(target, `${label}.${condition}`, targets);
  }
}

export function assertManifestTargets(manifest, packageRoot) {
  assert.equal(manifest?.name, '@pdpp/cli', 'package manifest must identify @pdpp/cli');
  assert.equal(Array.isArray(manifest.files), true, 'package manifest must have a files allowlist');
  assert.equal(manifest.files.includes('dist/'), true, 'package files must include dist/');
  for (const forbidden of ['src/', 'bin/', 'test/']) {
    assert.equal(manifest.files.includes(forbidden), false, `package files must not publish ${forbidden}`);
  }

  const exportTargets = [];
  assert.equal(manifest.exports !== null && typeof manifest.exports === 'object', true, 'package must declare exports');
  for (const [subpath, value] of Object.entries(manifest.exports)) {
    collectExportTargets(value, `exports[${JSON.stringify(subpath)}]`, exportTargets);
  }
  assert.ok(exportTargets.length > 0, 'package must expose at least one export');

  for (const { label, target } of exportTargets) {
    const { targetPath } = assertInsideDist(packageRoot, target, label);
    assert.equal(
      target.endsWith('.js') || target.endsWith('.d.ts'),
      true,
      `${label} must point to emitted JavaScript or declarations: ${target}`,
    );
    assert.equal(statSync(targetPath).isFile(), true, `${label} must resolve to a file: ${target}`);
  }

  assert.equal(manifest.bin !== null && typeof manifest.bin === 'object', true, 'package must declare a bin map');
  for (const [name, target] of Object.entries(manifest.bin)) {
    const { targetPath } = assertInsideDist(packageRoot, target, `bin.${name}`);
    assert.equal(target.endsWith('.js'), true, `bin.${name} must point to emitted JavaScript: ${target}`);
    assert.equal(statSync(targetPath).isFile(), true, `bin.${name} must resolve to a file: ${target}`);
    assert.notEqual(statSync(targetPath).mode & 0o111, 0, `bin.${name} must be executable: ${target}`);
    assert.equal(
      readFileSync(targetPath, 'utf8').startsWith('#!/usr/bin/env node'),
      true,
      `bin.${name} must retain its node shebang: ${target}`,
    );
  }
}

export function assertPackedFiles(manifest, packedFiles) {
  const files = new Set(packedFiles);
  for (const file of files) {
    assert.equal(file.startsWith('src/'), false, `source file leaked into package: ${file}`);
    assert.equal(file.startsWith('bin/'), false, `source bin leaked into package: ${file}`);
    assert.equal(file.startsWith('test/'), false, `test file leaked into package: ${file}`);
    assert.equal(/(^|\/)\.?.+\.test\.(?:js|mjs|cjs|ts|mts|cts)$/.test(file), false, `test artifact leaked into package: ${file}`);
    assert.equal(file.endsWith('.ts') && !file.endsWith('.d.ts'), false, `raw TypeScript leaked into package: ${file}`);
  }

  const exportTargets = [];
  for (const [subpath, value] of Object.entries(manifest.exports)) {
    collectExportTargets(value, `exports[${JSON.stringify(subpath)}]`, exportTargets);
  }
  for (const { target } of exportTargets) {
    assert.equal(files.has(target.slice(2)), true, `packed export target is missing: ${target}`);
  }
  for (const [name, target] of Object.entries(manifest.bin)) {
    assert.equal(files.has(target.slice(2)), true, `packed bin target is missing: ${name} -> ${target}`);
  }
}

// npm 10 and 11 differ on whether a local package's prepare output is mixed
// into `npm pack --json` stdout even with --ignore-scripts. Parse the trailing
// machine-readable payload so the artifact gate is stable across supported
// Node/npm pairings.
export function parseNpmPackOutput(output) {
  const match = output.match(/(\[\s*\{[\s\S]*\])\s*$/);
  assert.ok(match, 'npm pack did not produce a trailing JSON payload');
  return JSON.parse(match[1]);
}
