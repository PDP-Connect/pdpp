// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { NODE_MATRIX, PACKAGE_NAMES, assertReceipt, assertReplayMatches, assertRepositoryRuntimeConfiguration, receiptDigest } from './release-package-matrix.mjs';

const snapshot = {
  baseSha: 'base',
  headSha: 'head',
  sourceClosure: { files: ['package.json'], sha256: 'closure' },
  packageManager: { name: 'pnpm', version: '10.33.0', integrity: 'sha512-test' },
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function candidateContract(name) {
  const manifestPath = join(repositoryRoot, 'packages', name.slice('@pdpp/'.length), 'package.json');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  return {
    name,
    version: manifest.version,
    contract: { exportSubpaths: Object.keys(manifest.exports ?? {}).sort(), bins: Object.keys(manifest.bin ?? {}).sort() },
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  };
}

function row(row) {
  const candidates = PACKAGE_NAMES.map((name, index) => ({
    ...candidateContract(name),
    source: { baseSha: snapshot.baseSha, headSha: snapshot.headSha, sourceClosureSha256: snapshot.sourceClosure.sha256 },
    tarball: { filename: `${name.slice('@pdpp/'.length)}-0.0.0.tgz`, sha256: String.fromCharCode(98 + index).repeat(64), files: ['package.json'] },
  }));
  const commands = [
    { command: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--offline', '--store-dir', '/pdpp-pnpm-store'], cwd: '/workspace' },
    ...PACKAGE_NAMES.map((name) => ({ command: ['pnpm', '--filter', name, 'run', 'build'], cwd: '/workspace' })),
    ...candidates.map(({ name }) => ({ command: ['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', '/workspace/.release-matrix/candidates'], cwd: `/workspace/packages/${name.slice('@pdpp/'.length)}` })),
    { command: ['npm', 'init', '--yes'], cwd: '/workspace/.release-matrix/consumer' },
    { command: ['npm', 'install', '--ignore-scripts', '--offline', ...candidates.map(({ tarball }) => `/workspace/.release-matrix/candidates/${tarball.filename}`)], cwd: '/workspace/.release-matrix/consumer' },
    { command: ['npm', 'ls', '--all', '--json'], cwd: '/workspace/.release-matrix/consumer' },
    { command: ['/usr/local/bin/node', '/workspace/.release-matrix/consumer/candidate-probe.mjs'], cwd: '/workspace/.release-matrix/consumer' },
  ];
  if (row.exactFloor) {
    commands.splice(1, 0,
      { command: ['pnpm', '--filter', '@pdpp/cli', 'run', 'pack-install-run:node-22.14'], cwd: '/workspace' },
      { command: ['pnpm', '--filter', '@pdpp/read-core', 'run', 'verify:node-22.14'], cwd: '/workspace' });
  }
  const recordedCommands = commands.map((command) => ({
    ...command,
    exitCode: 0,
    resultSha256: 'a'.repeat(64),
  }));
  return {
    row,
    runner: { tag: `pdpp-release-matrix-${row.id}-head`, imageId: `sha256:${'c'.repeat(64)}`, identity: 'f'.repeat(64) },
    runtime: { nodeVersion: row.nodeVersion, nodePath: '/usr/local/bin/node', npmVersion: '10.9.2', npmPath: '/usr/local/bin/npm' },
    packageManager: { path: '/usr/local/bin/pnpm', realpath: '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs', sha256: 'b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9', version: '10.33.0', integrity: 'sha512-test' },
    candidates,
    consumer: {
      network: 'none',
      npmConfig: { offline: 'true', registry: 'http://127.0.0.1:9' },
      tree: { dependencies: Object.fromEntries(candidates.map((candidate) => [candidate.name, { version: candidate.version, resolved: `file:/workspace/.release-matrix/candidates/${candidate.tarball.filename}` }])) },
      probe: candidates.map((candidate) => ({
        name: candidate.name,
        root: `node_modules/${candidate.name}`,
        resolutions: candidate.contract.exportSubpaths.map((subpath) => ({ specifier: subpath === '.' ? candidate.name : `${candidate.name}/${subpath.slice(2)}`, resolved: `node_modules/${candidate.name}/dist/index.js`, exports: [] })),
        bins: candidate.contract.bins.map((bin) => ({ bin, executable: `node_modules/${candidate.name}/dist/bin/${bin}.js`, helpSha256: 'e'.repeat(64) })),
      })),
    },
    commands: recordedCommands,
  };
}

function receipt() {
  const value = { version: 2, snapshot, endSnapshot: snapshot, rows: NODE_MATRIX.map(row) };
  return { ...value, receiptSha256: receiptDigest(value) };
}

function reseal(value) {
  value.receiptSha256 = receiptDigest(value);
}

test('receipt accepts the complete pinned matrix', () => {
  assert.doesNotThrow(() => assertReceipt(receipt(), snapshot));
});

test('receipt rejects source-closure replay or mutation', () => {
  const value = receipt();
  value.snapshot = { ...snapshot, sourceClosure: { ...snapshot.sourceClosure, sha256: 'replayed' } };
  reseal(value);
  assert.throws(() => assertReceipt(value, snapshot), /replayed or drifted/);
  const mutated = receipt();
  mutated.endSnapshot = { ...snapshot, headSha: 'mutated' };
  reseal(mutated);
  assert.throws(() => assertReceipt(mutated, snapshot), /mutated or drifted/);
});

test('receipt rejects image, package-manager, consumer, and tarball drift', () => {
  const image = receipt();
  image.rows[0].row = { ...image.rows[0].row, image: 'node:latest' };
  reseal(image);
  assert.throws(() => assertReceipt(image, snapshot), /drifted/);
  const manager = receipt();
  manager.rows[0].packageManager.version = '10.34.0';
  reseal(manager);
  assert.throws(() => assertReceipt(manager, snapshot), /pnpm version drifted/);
  const network = receipt();
  network.rows[0].consumer.network = 'bridge';
  reseal(network);
  assert.throws(() => assertReceipt(network, snapshot), /networking disabled/);
  const tarball = receipt();
  tarball.rows[0].candidates[0].tarball.sha256 = 'not-a-hash';
  reseal(tarball);
  assert.throws(() => assertReceipt(tarball, snapshot), /tarball hash/);
  const tarballReplay = receipt();
  tarballReplay.rows[0].candidates[0].tarball.sha256 = 'f'.repeat(64);
  reseal(tarballReplay);
  assert.throws(() => assertReceipt(tarballReplay, snapshot), /across runtime rows/);
  const pnpmBytes = receipt();
  pnpmBytes.rows[0].packageManager.sha256 = 'f'.repeat(64);
  reseal(pnpmBytes);
  assert.throws(() => assertReceipt(pnpmBytes, snapshot), /pnpm bytes drifted/);
  const probe = receipt();
  probe.rows[0].consumer.probe = [];
  reseal(probe);
  assert.throws(() => assertReceipt(probe, snapshot), /probe package set drifted/);
  const exportProbe = receipt();
  exportProbe.rows[0].consumer.probe[0].resolutions = [];
  reseal(exportProbe);
  assert.throws(() => assertReceipt(exportProbe, snapshot), /export probe drifted/);
  const binProbe = receipt();
  binProbe.rows[0].consumer.probe[0].bins = [];
  reseal(binProbe);
  assert.throws(() => assertReceipt(binProbe, snapshot), /bin probe drifted/);
  const contractAndProbe = receipt();
  contractAndProbe.rows[0].candidates[0].contract.bins = [];
  contractAndProbe.rows[0].consumer.probe[0].bins = [];
  reseal(contractAndProbe);
  assert.throws(() => assertReceipt(contractAndProbe, snapshot), /export\/bin contract drifted/);
  const command = receipt();
  command.rows[0].commands = [];
  reseal(command);
  assert.throws(() => assertReceipt(command, snapshot), /executed commands/);
  const commandOrder = receipt();
  commandOrder.rows[0].commands.push({ command: ['echo', 'unbound'], cwd: '/workspace' });
  reseal(commandOrder);
  assert.throws(() => assertReceipt(commandOrder, snapshot), /(command sequence drifted|must bind successful command results)/);
  const digest = receipt();
  digest.rows[0].consumer.network = 'bridge';
  assert.throws(() => assertReceipt(digest, snapshot), /digest mismatch/);
});

test('replay comparison rejects resealed command, runtime, file-list, and cross-row tarball forgeries', () => {
  const expected = receipt();
  const command = receipt();
  command.rows[0].commands[0].resultSha256 = 'f'.repeat(64);
  reseal(command);
  assert.throws(() => assertReplayMatches(command, expected), /deterministic replay differs/);

  const runtime = receipt();
  runtime.rows[0].runtime.npmVersion = '99.99.99';
  reseal(runtime);
  assert.throws(() => assertReplayMatches(runtime, expected), /deterministic replay differs/);

  const fileList = receipt();
  fileList.rows[0].candidates[0].tarball.files = ['forged.js'];
  reseal(fileList);
  assert.throws(() => assertReplayMatches(fileList, expected), /deterministic replay differs/);

  const tarball = receipt();
  for (const matrixRow of tarball.rows) matrixRow.candidates[0].tarball.sha256 = 'f'.repeat(64);
  reseal(tarball);
  assert.throws(() => assertReplayMatches(tarball, expected), /deterministic replay differs/);
});

test('repository Docker runtime must stay digest- and package-manager-pinned', () => {
  const dockerfile = [
    'ARG NODE_VERSION=25.8.2-bookworm-slim@sha256:71be4054ee7a5fc8d0b2a66060705988b09a782025d70ba9318b29ff1a931fc0',
    'ARG PNPM_VERSION=10.33.0',
    'ARG PNPM_INTEGRITY=sha512-EFaLtKavtYyes2MNqQzJUWQXq+vT+rvmc58K55VyjaFJHp21pUTHatjrdXD1xLs9bGN7LLQb/c20f6gjyGSTGQ==',
    'RUN npm pack --ignore-scripts --loglevel=error --pack-destination /tmp "pnpm@${PNPM_VERSION}" && pnpm integrity drift',
  ].join('\n');
  assert.deepEqual(assertRepositoryRuntimeConfiguration({ dockerfile, nvmrc: 'v25.8.2\n', packageManager: 'pnpm@10.33.0' }), { name: 'pnpm', version: '10.33.0', integrity: 'sha512-EFaLtKavtYyes2MNqQzJUWQXq+vT+rvmc58K55VyjaFJHp21pUTHatjrdXD1xLs9bGN7LLQb/c20f6gjyGSTGQ==' });
  assert.throws(() => assertRepositoryRuntimeConfiguration({ dockerfile: dockerfile.replace('71be', 'dead'), nvmrc: 'v25.8.2', packageManager: 'pnpm@10.33.0' }), /Dockerfile Node base/);
  assert.throws(() => assertRepositoryRuntimeConfiguration({ dockerfile, nvmrc: 'v25.8.3', packageManager: 'pnpm@10.33.0' }), /must match \.nvmrc/);
  assert.throws(() => assertRepositoryRuntimeConfiguration({ dockerfile, nvmrc: 'v25.8.2', packageManager: 'pnpm@10.34.0' }), /Dockerfile pnpm version/);
  assert.throws(() => assertRepositoryRuntimeConfiguration({ dockerfile: dockerfile.replace('EFaL', 'dead'), nvmrc: 'v25.8.2', packageManager: 'pnpm@10.33.0' }), /pnpm integrity/);
  assert.throws(() => assertRepositoryRuntimeConfiguration({ dockerfile: `${dockerfile}\nRUN npm install -g corepack`, nvmrc: 'v25.8.2', packageManager: 'pnpm@10.33.0' }), /Corepack/);
});
