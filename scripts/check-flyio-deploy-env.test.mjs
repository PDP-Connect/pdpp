import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluateFlyioCoreEnv,
  isPlaceholder,
  parseEnv,
} from './check-flyio-deploy-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function validCoreEnv(overrides = {}) {
  return {
    PDPP_REFERENCE_ORIGIN: 'https://pdpp-core.fly.dev',
    PDPP_OWNER_PASSWORD: 's3cret-owner-pw',
    PDPP_DATABASE_URL: 'postgres://user:pass@host:5432/pdpp',
    ...overrides,
  };
}

test('isPlaceholder treats empty, missing, and angle-bracket templates as unset', () => {
  assert.equal(isPlaceholder(undefined), true);
  assert.equal(isPlaceholder(null), true);
  assert.equal(isPlaceholder(''), true);
  assert.equal(isPlaceholder('   '), true);
  assert.equal(isPlaceholder('https://<app-name>.fly.dev'), true);
  assert.equal(isPlaceholder('https://pdpp-core.fly.dev'), false);
});

test('parseEnv ignores comments and blanks and strips quotes', () => {
  const env = parseEnv(
    [
      '# comment',
      '',
      'PDPP_REFERENCE_ORIGIN=https://pdpp-core.fly.dev',
      'PDPP_OWNER_PASSWORD="quoted-secret"',
      "PDPP_DATABASE_URL='postgres://user:pass@host/db?sslmode=require'",
      'NO_EQUALS_LINE',
    ].join('\n'),
  );
  assert.equal(env.PDPP_REFERENCE_ORIGIN, 'https://pdpp-core.fly.dev');
  assert.equal(env.PDPP_OWNER_PASSWORD, 'quoted-secret');
  assert.equal(env.PDPP_DATABASE_URL, 'postgres://user:pass@host/db?sslmode=require');
  assert.equal('NO_EQUALS_LINE' in env, false);
});

test('a fully configured Fly Core env satisfies the contract', () => {
  assert.deepEqual(evaluateFlyioCoreEnv(validCoreEnv()), []);
});

test('missing public origin is a violation', () => {
  const violations = evaluateFlyioCoreEnv(validCoreEnv({ PDPP_REFERENCE_ORIGIN: '' }));
  assert.equal(violations.some((v) => v.includes('PDPP_REFERENCE_ORIGIN is not set')), true);
});

test('non-HTTPS public origin is a violation', () => {
  const violations = evaluateFlyioCoreEnv(
    validCoreEnv({ PDPP_REFERENCE_ORIGIN: 'http://pdpp-core.fly.dev' }),
  );
  assert.equal(violations.some((v) => v.includes('must be an https:// origin')), true);
});

test('empty owner password is a violation', () => {
  const violations = evaluateFlyioCoreEnv(validCoreEnv({ PDPP_OWNER_PASSWORD: '' }));
  assert.equal(violations.some((v) => v.includes('PDPP_OWNER_PASSWORD is empty')), true);
});

test('missing database URL is a violation', () => {
  const violations = evaluateFlyioCoreEnv(validCoreEnv({ PDPP_DATABASE_URL: '' }));
  assert.equal(violations.some((v) => v.includes('No durable database URL is set')), true);
});

test('standard DATABASE_URL satisfies the database requirement when PDPP_DATABASE_URL is absent', () => {
  const violations = evaluateFlyioCoreEnv(
    validCoreEnv({
      PDPP_DATABASE_URL: '',
      DATABASE_URL: 'postgres://user:pass@host:5432/pdpp',
    }),
  );
  assert.deepEqual(violations, []);
});

test('forbids topology variables owned by the platform-core image', () => {
  const violations = evaluateFlyioCoreEnv(
    validCoreEnv({
      PORT: '3000',
      AS_PORT: '7662',
      RS_PORT: '7663',
      PDPP_AS_URL: 'http://127.0.0.1:7662',
      PDPP_RS_URL: 'http://127.0.0.1:7663',
    }),
  );
  assert.equal(violations.some((v) => v.includes('core PORT must not be set')), true);
  assert.equal(violations.some((v) => v.includes('core AS_PORT must not be set')), true);
  assert.equal(violations.some((v) => v.includes('core RS_PORT must not be set')), true);
  assert.equal(violations.some((v) => v.includes('core PDPP_AS_URL must not be set')), true);
  assert.equal(violations.some((v) => v.includes('core PDPP_RS_URL must not be set')), true);
});

test('committed core env template fails only because values are intentionally unfilled', () => {
  const coreText = readFileSync(path.join(repoRoot, 'deploy/flyio/core.env.example'), 'utf8');
  const violations = evaluateFlyioCoreEnv(parseEnv(coreText));
  assert.equal(violations.some((v) => v.includes('PDPP_REFERENCE_ORIGIN is not set')), true);
  assert.equal(violations.some((v) => v.includes('PDPP_OWNER_PASSWORD is empty')), true);
  assert.equal(violations.some((v) => v.includes('No durable database URL is set')), true);
  assert.equal(violations.some((v) => v.includes('PDPP_AS_URL')), false);
  assert.equal(violations.some((v) => v.includes('PDPP_RS_URL')), false);
});
