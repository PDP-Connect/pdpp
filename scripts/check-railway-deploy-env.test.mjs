import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluateRailwayDeployEnv,
  isPlaceholder,
  isRailwayReference,
  parseEnv,
  UNMOUNTED_SQLITE_DEFAULT,
} from './check-railway-deploy-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fully-configured Postgres deploy that should satisfy the contract.
function validPostgresEnv(overrides = {}) {
  return {
    PDPP_REFERENCE_ORIGIN: 'https://pdpp.example.com',
    PDPP_OWNER_PASSWORD: 's3cret-owner-pw',
    PDPP_AS_URL: 'http://reference.railway.internal:7662',
    PDPP_RS_URL: 'http://reference.railway.internal:7663',
    PDPP_STORAGE_BACKEND: 'postgres',
    PDPP_DATABASE_URL: '${{Postgres.DATABASE_URL}}',
    ...overrides,
  };
}

function validSqliteEnv(overrides = {}) {
  return {
    PDPP_REFERENCE_ORIGIN: 'https://pdpp.example.com',
    PDPP_OWNER_PASSWORD: 's3cret-owner-pw',
    PDPP_AS_URL: 'http://reference.railway.internal:7662',
    PDPP_RS_URL: 'http://reference.railway.internal:7663',
    PDPP_STORAGE_BACKEND: 'sqlite',
    PDPP_DB_PATH: '/data/pdpp.sqlite',
    ...overrides,
  };
}

test('isPlaceholder treats empty, missing, and angle-bracket templates as unset', () => {
  assert.equal(isPlaceholder(undefined), true);
  assert.equal(isPlaceholder(''), true);
  assert.equal(isPlaceholder('   '), true);
  assert.equal(isPlaceholder('https://<your-console-domain>'), true);
  assert.equal(isPlaceholder('https://pdpp.example.com'), false);
});

test('isRailwayReference recognizes ${{...}} bindings only', () => {
  assert.equal(isRailwayReference('${{Postgres.DATABASE_URL}}'), true);
  assert.equal(isRailwayReference('postgres://u:p@host/db'), false);
  assert.equal(isRailwayReference(''), false);
});

test('parseEnv ignores comments and blanks and strips quotes', () => {
  const env = parseEnv(
    [
      '# a comment',
      '',
      'PDPP_REFERENCE_ORIGIN=https://pdpp.example.com',
      'PDPP_OWNER_PASSWORD="quoted-secret"',
      "PDPP_AS_URL='http://reference.railway.internal:7662'",
      'NO_EQUALS_LINE',
    ].join('\n'),
  );
  assert.equal(env.PDPP_REFERENCE_ORIGIN, 'https://pdpp.example.com');
  assert.equal(env.PDPP_OWNER_PASSWORD, 'quoted-secret');
  assert.equal(env.PDPP_AS_URL, 'http://reference.railway.internal:7662');
  assert.equal('NO_EQUALS_LINE' in env, false);
});

test('a fully-configured Postgres env satisfies the contract', () => {
  assert.deepEqual(evaluateRailwayDeployEnv(validPostgresEnv()), []);
});

test('a fully-configured SQLite-on-volume env satisfies the contract', () => {
  assert.deepEqual(evaluateRailwayDeployEnv(validSqliteEnv()), []);
});

test('missing public origin is a violation', () => {
  const violations = evaluateRailwayDeployEnv(validPostgresEnv({ PDPP_REFERENCE_ORIGIN: '' }));
  assert.equal(violations.some((v) => v.includes('PDPP_REFERENCE_ORIGIN is not set')), true);
});

test('non-HTTPS public origin is a violation', () => {
  const violations = evaluateRailwayDeployEnv(
    validPostgresEnv({ PDPP_REFERENCE_ORIGIN: 'http://pdpp.example.com' }),
  );
  assert.equal(violations.some((v) => v.includes('must be an https:// origin')), true);
});

test('empty owner password is a violation', () => {
  const violations = evaluateRailwayDeployEnv(validPostgresEnv({ PDPP_OWNER_PASSWORD: '' }));
  assert.equal(violations.some((v) => v.includes('PDPP_OWNER_PASSWORD is empty')), true);
});

test('missing private AS/RS targets are violations', () => {
  const violations = evaluateRailwayDeployEnv(
    validPostgresEnv({ PDPP_AS_URL: '', PDPP_RS_URL: '' }),
  );
  assert.equal(violations.some((v) => v.includes('PDPP_AS_URL is not set')), true);
  assert.equal(violations.some((v) => v.includes('PDPP_RS_URL is not set')), true);
});

test('postgres backend without a database URL is a violation', () => {
  const violations = evaluateRailwayDeployEnv(validPostgresEnv({ PDPP_DATABASE_URL: '' }));
  assert.equal(violations.some((v) => v.includes('requires PDPP_DATABASE_URL')), true);
});

test('sqlite backend at the unmounted default path is a violation', () => {
  const violations = evaluateRailwayDeployEnv(
    validSqliteEnv({ PDPP_DB_PATH: UNMOUNTED_SQLITE_DEFAULT }),
  );
  assert.equal(violations.some((v) => v.includes('mounted persistent volume')), true);
});

test('sqlite backend with no path is a violation', () => {
  const violations = evaluateRailwayDeployEnv(validSqliteEnv({ PDPP_DB_PATH: '' }));
  assert.equal(violations.some((v) => v.includes('mounted persistent volume')), true);
});

test('an unset or unknown storage backend is a violation', () => {
  const unset = evaluateRailwayDeployEnv(validPostgresEnv({ PDPP_STORAGE_BACKEND: '' }));
  assert.equal(unset.some((v) => v.includes('must be "postgres" or "sqlite"')), true);
  const unknown = evaluateRailwayDeployEnv(validPostgresEnv({ PDPP_STORAGE_BACKEND: 'mysql' }));
  assert.equal(unknown.some((v) => v.includes('must be "postgres" or "sqlite"')), true);
});

test('the committed env.example is a template and fails the contract with placeholder/empty findings', () => {
  // The example uses placeholders for the operator to fill in; running the
  // check against it must report the placeholder origin and empty owner
  // password (it is not a ready-to-deploy file by design).
  const text = readFileSync(path.join(repoRoot, 'deploy/railway/env.example'), 'utf8');
  const violations = evaluateRailwayDeployEnv(parseEnv(text));
  assert.equal(violations.some((v) => v.includes('PDPP_REFERENCE_ORIGIN is not set')), true);
  assert.equal(violations.some((v) => v.includes('PDPP_OWNER_PASSWORD is empty')), true);
});
