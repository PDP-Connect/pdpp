import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluateRailwayDeployEnv,
  evaluateRailwayServiceEnvs,
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
    PDPP_AS_URL: 'http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:${{reference.PORT}}',
    PDPP_RS_URL: 'http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:7663',
    PDPP_DATABASE_URL: '${{Postgres.DATABASE_URL}}',
    ...overrides,
  };
}

function validSqliteEnv(overrides = {}) {
  return {
    PDPP_REFERENCE_ORIGIN: 'https://pdpp.example.com',
    PDPP_OWNER_PASSWORD: 's3cret-owner-pw',
    PDPP_AS_URL: 'http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:${{reference.PORT}}',
    PDPP_RS_URL: 'http://reference.railway.internal:7663',
    PDPP_STORAGE_BACKEND: 'sqlite',
    PDPP_DB_PATH: '/data/pdpp.sqlite',
    ...overrides,
  };
}

function validConsoleServiceEnv(overrides = {}) {
  return {
    PDPP_REFERENCE_ORIGIN: 'https://${{console.RAILWAY_PUBLIC_DOMAIN}}',
    PDPP_OWNER_PASSWORD: 's3cret-owner-pw',
    PDPP_AS_URL: 'http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:${{reference.PORT}}',
    PDPP_RS_URL: 'http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:7663',
    ...overrides,
  };
}

function validReferenceServiceEnv(overrides = {}) {
  return {
    PDPP_REFERENCE_ORIGIN: 'https://${{console.RAILWAY_PUBLIC_DOMAIN}}',
    PDPP_OWNER_PASSWORD: 's3cret-owner-pw',
    PDPP_DATABASE_URL: '${{Postgres.DATABASE_URL}}',
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
  assert.equal(isRailwayReference('http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:${{reference.PORT}}'), true);
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
      "PDPP_AS_URL='http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:${{reference.PORT}}'",
      'NO_EQUALS_LINE',
    ].join('\n'),
  );
  assert.equal(env.PDPP_REFERENCE_ORIGIN, 'https://pdpp.example.com');
  assert.equal(env.PDPP_OWNER_PASSWORD, 'quoted-secret');
  assert.equal(env.PDPP_AS_URL, 'http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:${{reference.PORT}}');
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

test('postgres storage without a database URL is a violation', () => {
  const violations = evaluateRailwayDeployEnv(
    validPostgresEnv({ PDPP_STORAGE_BACKEND: 'postgres', PDPP_DATABASE_URL: '' }),
  );
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

test('database URL infers Postgres when storage backend is unset', () => {
  assert.deepEqual(evaluateRailwayDeployEnv(validPostgresEnv({ PDPP_STORAGE_BACKEND: '' })), []);
});

test('missing database URL and storage backend is a violation', () => {
  const unset = evaluateRailwayDeployEnv(validPostgresEnv({ PDPP_STORAGE_BACKEND: '', PDPP_DATABASE_URL: '' }));
  assert.equal(unset.some((v) => v.includes('or PDPP_DATABASE_URL must be set')), true);
});

test('unknown storage backend is a violation', () => {
  const unknown = evaluateRailwayDeployEnv(validPostgresEnv({ PDPP_STORAGE_BACKEND: 'mysql' }));
  assert.equal(unknown.some((v) => v.includes('must be "postgres" or "sqlite"')), true);
});

test('the committed env.example is a template and fails the contract with placeholder/empty findings', () => {
  // The example uses Railway reference variables for topology, but intentionally
  // leaves the owner password empty because it is not a committed secret.
  const text = readFileSync(path.join(repoRoot, 'deploy/railway/env.example'), 'utf8');
  const violations = evaluateRailwayDeployEnv(parseEnv(text));
  assert.equal(violations.some((v) => v.includes('PDPP_REFERENCE_ORIGIN is not set')), false);
  assert.equal(violations.some((v) => v.includes('PDPP_OWNER_PASSWORD is empty')), true);
});

test('fully-configured service envs satisfy the Railway deploy contract', () => {
  assert.deepEqual(
    evaluateRailwayServiceEnvs({
      consoleEnv: validConsoleServiceEnv(),
      referenceEnv: validReferenceServiceEnv(),
    }),
    [],
  );
});

test('service env preflight rejects mismatched shared values', () => {
  const violations = evaluateRailwayServiceEnvs({
    consoleEnv: validConsoleServiceEnv({ PDPP_REFERENCE_ORIGIN: 'https://console.example.com' }),
    referenceEnv: validReferenceServiceEnv({ PDPP_REFERENCE_ORIGIN: 'https://reference.example.com' }),
  });
  assert.equal(violations.some((v) => v.includes('must match')), true);
});

test('service env preflight rejects console URLs that are not private Railway targets', () => {
  const violations = evaluateRailwayServiceEnvs({
    consoleEnv: validConsoleServiceEnv({ PDPP_RS_URL: 'http://127.0.0.1:7663' }),
    referenceEnv: validReferenceServiceEnv(),
  });
  assert.equal(
    violations.some((v) => v.includes('console PDPP_RS_URL must point at the private Railway reference RS')),
    true,
  );
});

test('service env preflight rejects setting PORT on the console service', () => {
  const violations = evaluateRailwayServiceEnvs({
    consoleEnv: validConsoleServiceEnv({ PORT: '3000' }),
    referenceEnv: validReferenceServiceEnv(),
  });
  assert.equal(violations.some((v) => v.includes('console PORT must not be set')), true);
});

test('service env preflight permits reference constants to come from image defaults', () => {
  assert.deepEqual(
    evaluateRailwayServiceEnvs({
      consoleEnv: validConsoleServiceEnv(),
      referenceEnv: validReferenceServiceEnv(),
    }),
    [],
  );
});

test('service env preflight rejects explicit reference PORT because Railway injects it', () => {
  const violations = evaluateRailwayServiceEnvs({
    consoleEnv: validConsoleServiceEnv(),
    referenceEnv: validReferenceServiceEnv({ PORT: '7662' }),
  });
  assert.equal(violations.some((v) => v.includes('reference PORT must not be set')), true);
});

test('service env preflight requires reference hosted-MCP self-calls to stay loopback', () => {
  const violations = evaluateRailwayServiceEnvs({
    consoleEnv: validConsoleServiceEnv(),
    referenceEnv: validReferenceServiceEnv({ PDPP_RS_URL: 'http://reference.railway.internal:7663' }),
  });
  assert.equal(
    violations.some((v) => v.includes('reference PDPP_RS_URL must be "http://127.0.0.1:7663"')),
    true,
  );
});

test('committed service env templates fail only because the owner secret is not committed', () => {
  const consoleText = readFileSync(path.join(repoRoot, 'deploy/railway/console.env.example'), 'utf8');
  const referenceText = readFileSync(path.join(repoRoot, 'deploy/railway/reference.env.example'), 'utf8');
  const violations = evaluateRailwayServiceEnvs({
    consoleEnv: parseEnv(consoleText),
    referenceEnv: parseEnv(referenceText),
  });
  assert.equal(violations.some((v) => v.includes('PDPP_REFERENCE_ORIGIN is not set')), false);
  assert.equal(violations.some((v) => v.includes('PDPP_OWNER_PASSWORD is not set')), true);
  assert.equal(violations.some((v) => v.includes('reference PORT must not be set')), false);
  assert.equal(violations.some((v) => v.includes('PDPP_DATABASE_URL')), false);
});
