// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Deterministic offline tests for the standalone Core image's first-boot
// credential bootstrap (deploy/railway/core-first-boot.mjs).
//
// These pin the Docker quickstart's owner-gating contract:
//   - no PDPP_OWNER_PASSWORD -> generate, persist to the data dir, banner once;
//   - subsequent boots reuse the persisted password and never reprint it;
//   - the PDPP_OWNER_PASSWORD environment variable always wins;
//   - SQLite (quickstart) boots provision a credential encryption key file,
//     Postgres (managed-platform) boots keep the explicit fail-closed key
//     contract;
//   - the password is never emitted through the log/warn channels — the
//     one-time banner is the only print surface.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildFirstBootBanner,
  CREDENTIAL_KEY_FILENAME,
  OWNER_PASSWORD_FILENAME,
  prepareFirstBoot,
  resolveDataDir,
} from '../deploy/railway/core-first-boot.mjs';

function makeDataDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdpp-first-boot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

test('first boot generates, persists, and banners an owner password', (t) => {
  const dataDir = makeDataDir(t);
  const logs = capture();
  const result = prepareFirstBoot({ env: {}, dataDir: dataDir, log: logs.log, warn: logs.log });

  const password = result.env.PDPP_OWNER_PASSWORD;
  assert.ok(password && password.length >= 20, 'generates a high-entropy password');

  const passwordFile = path.join(dataDir, OWNER_PASSWORD_FILENAME);
  assert.equal(readFileSync(passwordFile, 'utf8').trim(), password);
  assert.equal(statSync(passwordFile).mode & 0o777, 0o600, 'password file is owner-only');

  const banner = result.bannerLines.join('\n');
  assert.match(banner, /First boot/);
  assert.ok(banner.includes(password), 'banner carries the generated password');
  assert.match(banner, /http:\/\/localhost:3000\//);
  assert.match(banner, /PDPP_OWNER_PASSWORD/);

  // The banner is the ONLY surface that carries the password.
  assert.ok(
    logs.lines.every((line) => !line.includes(password)),
    'log/warn channels never carry the password',
  );
});

test('restart reuses the persisted password and never reprints the banner', (t) => {
  const dataDir = makeDataDir(t);
  const first = prepareFirstBoot({ env: {}, dataDir: dataDir, log: () => {}, warn: () => {} });

  const logs = capture();
  const second = prepareFirstBoot({ env: {}, dataDir: dataDir, log: logs.log, warn: logs.log });

  assert.equal(second.env.PDPP_OWNER_PASSWORD, first.env.PDPP_OWNER_PASSWORD);
  assert.deepEqual(second.bannerLines, [], 'no banner after the first boot');
  assert.ok(
    logs.lines.some((line) => line.includes(OWNER_PASSWORD_FILENAME)),
    'logs a non-secret pointer to the persisted password file',
  );
  assert.ok(
    logs.lines.every((line) => !line.includes(first.env.PDPP_OWNER_PASSWORD)),
    'the password itself is never re-logged',
  );
});

test('the PDPP_OWNER_PASSWORD environment variable always wins', (t) => {
  const dataDir = makeDataDir(t);
  // Pre-existing persisted password from an earlier unconfigured boot.
  writeFileSync(path.join(dataDir, OWNER_PASSWORD_FILENAME), 'persisted-password\n');

  const result = prepareFirstBoot({
    env: { PDPP_OWNER_PASSWORD: 'operator-supplied' },
    dataDir: dataDir,
    log: () => {},
    warn: () => {},
  });

  assert.equal(result.env.PDPP_OWNER_PASSWORD, undefined, 'no override of the operator env');
  assert.deepEqual(result.bannerLines, []);
  assert.equal(
    readFileSync(path.join(dataDir, OWNER_PASSWORD_FILENAME), 'utf8').trim(),
    'persisted-password',
    'the persisted file is left untouched',
  );
});

test('a blank persisted file is treated as first boot', (t) => {
  const dataDir = makeDataDir(t);
  writeFileSync(path.join(dataDir, OWNER_PASSWORD_FILENAME), '  \n');

  const result = prepareFirstBoot({ env: {}, dataDir: dataDir, log: () => {}, warn: () => {} });

  assert.ok(result.env.PDPP_OWNER_PASSWORD);
  assert.ok(result.bannerLines.length > 0, 'banner prints for the regenerated password');
});

test('an unpersistable data dir still gates the boot and warns honestly', (t) => {
  const dataDir = makeDataDir(t);
  // A path under a regular FILE cannot be created -> deterministic ENOTDIR.
  const blockedDir = path.join(dataDir, 'blocker', 'sub');
  writeFileSync(path.join(dataDir, 'blocker'), 'not a directory\n');

  const warned = capture();
  const result = prepareFirstBoot({ env: {}, dataDir: blockedDir, log: () => {}, warn: warned.log });

  assert.ok(result.env.PDPP_OWNER_PASSWORD, 'owner data stays gated even without persistence');
  const banner = result.bannerLines.join('\n');
  assert.match(banner, /could not be persisted|WARNING/);
  assert.ok(warned.lines.some((line) => /could not persist/.test(line)));
});

test('sqlite boots provision a stable credential encryption key file', (t) => {
  const dataDir = makeDataDir(t);
  const first = prepareFirstBoot({ env: {}, dataDir: dataDir, log: () => {}, warn: () => {} });

  const keyFile = path.join(dataDir, CREDENTIAL_KEY_FILENAME);
  assert.equal(first.env.PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE, keyFile);
  const key = readFileSync(keyFile, 'utf8').trim();
  assert.equal(key.length, 64, '32 random bytes hex-encoded, like the Railway template secret(64)');
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);

  const second = prepareFirstBoot({ env: {}, dataDir: dataDir, log: () => {}, warn: () => {} });
  assert.equal(readFileSync(keyFile, 'utf8').trim(), key, 'key is stable across boots');
  assert.equal(second.env.PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE, keyFile);

  const banner = first.bannerLines.join('\n');
  assert.ok(!banner.includes(key), 'the key is never printed');
});

test('postgres boots keep the explicit fail-closed credential key contract', (t) => {
  const dataDir = makeDataDir(t);
  for (const env of [
    { DATABASE_URL: 'postgresql://pdpp@db:5432/pdpp' },
    { PDPP_DATABASE_URL: 'postgresql://pdpp@db:5432/pdpp' },
    { PDPP_STORAGE_BACKEND: 'postgres', PDPP_DATABASE_URL: 'postgresql://pdpp@db:5432/pdpp' },
  ]) {
    const result = prepareFirstBoot({ env, dataDir: dataDir, log: () => {}, warn: () => {} });
    assert.equal(result.env.PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE, undefined);
  }
});

test('a configured credential key provider is never shadowed', (t) => {
  const dataDir = makeDataDir(t);
  for (const env of [
    { PDPP_CREDENTIAL_ENCRYPTION_KEY: 'operator-key' },
    { PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE: '/run/secrets/pdpp-key' },
  ]) {
    const result = prepareFirstBoot({ env, dataDir: dataDir, log: () => {}, warn: () => {} });
    assert.equal(result.env.PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE, undefined);
  }
});

test('banner respects a configured reference origin', (t) => {
  const dataDir = makeDataDir(t);
  const result = prepareFirstBoot({
    env: { PDPP_REFERENCE_ORIGIN: 'https://pdpp.example.com/' },
    dataDir: dataDir,
    log: () => {},
    warn: () => {},
  });
  assert.match(result.bannerLines.join('\n'), /https:\/\/pdpp\.example\.com\//);
});

test('data dir defaults beside the configured SQLite database', () => {
  assert.equal(resolveDataDir({ PDPP_DB_PATH: '/var/lib/pdpp/pdpp.sqlite' }), '/var/lib/pdpp');
  assert.equal(resolveDataDir({ PDPP_DB_PATH: ':memory:' }), '/var/lib/pdpp');
  assert.equal(resolveDataDir({}), '/var/lib/pdpp');
});

test('buildFirstBootBanner prefixes every line for the supervisor log stream', () => {
  const lines = buildFirstBootBanner({
    origin: 'http://localhost:3000',
    password: 'pw',
    passwordFile: '/var/lib/pdpp/owner-password',
    persisted: true,
  });
  assert.ok(lines.every((line) => line.startsWith('[railway-core]')));
});
