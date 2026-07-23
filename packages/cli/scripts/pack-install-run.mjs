// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNpmPackOutput } from './package-contract.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const tempRoot = mkdtempSync(join(tmpdir(), 'pdpp-cli-consumer-'));
const consumerRoot = join(tempRoot, 'consumer');
const packRoot = join(tempRoot, 'pack');
const env = {
  ...process.env,
  HOME: join(tempRoot, 'home'),
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_offline: 'true',
  npm_config_update_notifier: 'false',
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    env,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

function runFailure(command, args, options = {}) {
  try {
    run(command, args, options);
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert.fail(`${command} ${args.join(' ')} unexpectedly succeeded`);
}

try {
  mkdirSync(consumerRoot, { recursive: true });
  mkdirSync(packRoot, { recursive: true });
  const packResult = parseNpmPackOutput(
    run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packRoot], { cwd: packageRoot }),
  )[0];
  const tarball = join(packRoot, packResult.filename);

  run('npm', ['init', '-y'], { cwd: consumerRoot });
  run('npm', ['install', '--ignore-scripts', '--offline', tarball], { cwd: consumerRoot });

  const tree = JSON.parse(run('npm', ['ls', '--all', '--json'], { cwd: consumerRoot }));
  assert.equal(tree.dependencies?.['@pdpp/cli']?.version, manifest.version, 'consumer resolved the candidate CLI');
  assert.equal(existsSync(join(consumerRoot, 'node_modules', '@pdpp', 'local-collector')), false, 'CLI-only consumer must not contain the optional collector');

  const exportSpecifiers = Object.keys(manifest.exports).map((subpath) =>
    subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
  );
  run(
    process.execPath,
    ['--input-type=module', '--eval', `await Promise.all(${JSON.stringify(exportSpecifiers)}.map((specifier) => import(specifier)));`],
    { cwd: consumerRoot },
  );

  const resolvedRoot = run(
    process.execPath,
    ['--input-type=module', '--eval', `console.log(import.meta.resolve(${JSON.stringify(manifest.name)}));`],
    { cwd: consumerRoot },
  ).trim();
  assert.match(resolvedRoot, /node_modules\/@pdpp\/cli\/dist\/src\/index\.js$/, 'consumer must resolve emitted CLI JS');

  const help = run('npx', ['--no-install', 'pdpp', '--help'], { cwd: consumerRoot });
  assert.match(help, /PDPP CLI/, 'installed pdpp help must run through npx without download');

  const collectorFailure = runFailure('npx', ['--no-install', 'pdpp', 'collector', 'advertise'], { cwd: consumerRoot });
  assert.match(collectorFailure, /@pdpp\/local-collector/, 'CLI-only collector failure must name the optional package');
  assert.match(collectorFailure, /npm i -g @pdpp\/local-collector|npx -y @pdpp\/local-collector/);
  assert.doesNotMatch(collectorFailure, /not distributed with @pdpp\/cli yet/);
  process.stdout.write(`Installed CLI consumer passed: ${exportSpecifiers.length} exports, pdpp --help, offline collector failure.\n`);
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}
