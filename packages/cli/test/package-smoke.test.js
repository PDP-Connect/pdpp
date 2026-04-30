import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getFileMode, getPdppCacheLayout, writePdppSecretFile } from '../src/cache-layout.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

test('package manifest stays intentionally narrow', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(manifest.name, '@pdpp/cli');
  assert.deepEqual(manifest.bin, { pdpp: './bin/pdpp.js' });
  assert.equal(manifest.publishConfig.tag, 'beta');
  assert.equal(manifest.publishConfig.provenance, false);
  assert.equal(Object.hasOwn(manifest, 'dependencies'), false);
  assert.equal(Object.hasOwn(manifest, 'main'), false);
  assert.equal(Object.hasOwn(manifest, 'directories'), false);
  assert.equal(Object.hasOwn(manifest, 'author'), false);
});

test('npm package contents stay narrowly allowlisted', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);

  const [pack] = JSON.parse(result.stdout);
  const files = pack.files.map((file) => file.path).sort();
  assert.deepEqual(files, [
    'README.md',
    'bin/pdpp.js',
    'package.json',
    'src/cache-layout.js',
    ...(files.includes('src/connect/flow.js') ? ['src/connect/flow.js'] : []),
    'src/index.js',
    'src/package-info.d.ts',
    'src/package-info.js',
  ]);

  for (const file of files) {
    assert.doesNotMatch(file, /^\.env/);
    assert.doesNotMatch(file, /^\.pdpp\//);
    assert.doesNotMatch(file, /^server\//);
    assert.doesNotMatch(file, /^test\//);
    assert.doesNotMatch(file, /sqlite|fixture|capture|screenshot/i);
  }
});

test('cache layout is explicit and secret files are owner-only', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pdpp-cli-cache-'));
  try {
    const layout = getPdppCacheLayout(join(tempRoot, '.pdpp'));
    assert.equal(layout.clientsDir, join(tempRoot, '.pdpp', 'clients'));
    assert.equal(layout.grantsDir, join(tempRoot, '.pdpp', 'grants'));
    assert.equal(layout.secretsDir, join(tempRoot, '.pdpp', 'secrets'));

    const secretPath = layout.secretFile('grant-1');
    writePdppSecretFile(secretPath, 'secret-value');
    assert.equal(getFileMode(secretPath), 0o600);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test('packed CLI installs and starts in an empty project', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pdpp-cli-pack-'));
  const packageDir = join(tempRoot, 'package');

  try {
    mkdirSync(packageDir);

    const packResult = spawnSync('npm', ['pack', '--json', '--pack-destination', tempRoot], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    assert.equal(packResult.status, 0, packResult.stderr);

    const [pack] = JSON.parse(packResult.stdout);
    const tarball = join(tempRoot, pack.filename);

    assert.equal(spawnSync('npm', ['init', '-y'], { cwd: packageDir }).status, 0);
    const installResult = spawnSync('npm', ['install', tarball], {
      cwd: packageDir,
      encoding: 'utf8',
    });
    assert.equal(installResult.status, 0, installResult.stderr);

    const helpResult = spawnSync(join(packageDir, 'node_modules/.bin/pdpp'), ['--help'], {
      encoding: 'utf8',
    });
    assert.equal(helpResult.status, 0, helpResult.stderr);
    assert.match(helpResult.stdout, /PDPP CLI/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});
