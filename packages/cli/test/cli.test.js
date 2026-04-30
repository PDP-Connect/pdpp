import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createPdppCliCommand,
  getPdppCliPackageInfo,
  PDPP_CLI_PACKAGE_NAME,
  PDPP_CLI_PACKAGE_SPECIFIER,
} from '../src/package-info.js';
import { normalizeProviderUrl, runCli } from '../src/index.js';

const binPath = fileURLToPath(new URL('../bin/pdpp.js', import.meta.url));

test('package info is the CLI source of truth', () => {
  assert.equal(PDPP_CLI_PACKAGE_NAME, '@pdpp/cli');
  assert.equal(PDPP_CLI_PACKAGE_SPECIFIER, '@pdpp/cli@beta');
  assert.deepEqual(getPdppCliPackageInfo('https://example.test'), {
    packageName: '@pdpp/cli',
    packageSpecifier: '@pdpp/cli@beta',
    binName: 'pdpp',
    versionPolicy: 'beta',
    runCommand: 'npx -y @pdpp/cli@beta connect https://example.test',
    noOwnerToken: true,
  });
  assert.equal(createPdppCliCommand(), 'npx -y @pdpp/cli@beta connect <provider-url>');
});

test('help starts from an installed-style bin invocation', () => {
  const result = spawnSync(process.execPath, [binPath, '--help'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /PDPP CLI/);
  assert.match(result.stdout, /npx -y @pdpp\/cli@beta connect <provider-url>/);
  assert.equal(result.stderr, '');
});

test('package-info command prints machine-readable install metadata', async () => {
  let stdout = '';
  let stderr = '';

  const code = await runCli(['package-info', '--provider-url', 'https://pdpp.example'], {
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });

  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).runCommand, 'npx -y @pdpp/cli@beta connect https://pdpp.example');
});

test('connect validates provider URLs but remains gated', async () => {
  let stderr = '';

  const code = await runCli(['connect', 'peregrine-dev.vivid.fish'], {
    stdout: { write: () => {} },
    stderr: { write: (chunk) => (stderr += chunk) },
  });

  assert.equal(code, 69);
  assert.match(stderr, /not enabled yet/);
  assert.equal(normalizeProviderUrl('peregrine-dev.vivid.fish'), 'https://peregrine-dev.vivid.fish');
});
