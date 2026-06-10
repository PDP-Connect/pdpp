import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeDb, getDb, initDb } from '../server/db.js';
import { createSqliteConnectorInstanceCredentialStore } from '../server/stores/connector-instance-credential-store.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { resolveStaticSecretRunEnv } from '../server/stores/static-secret-run-credentials.js';
import {
  ENV_CREDENTIAL_SOURCES,
  EnvCredentialMigrationError,
  EXIT_REFUSED_EXISTING,
  migrateEnvCredential,
} from './migrate-env-credentials.mjs';

// The REAL injection registry + mapping (not a stand-in): the point of this
// suite is to prove the migrated row is what the production run path resolves.
// Node >= 23.6 strips types natively; the server imports this file the same way.
const injectionModule = await import('../../packages/polyfill-connectors/src/static-secret-injection.ts');
const injection = {
  isStaticSecretConnector: injectionModule.isStaticSecretConnector,
  buildConnectionScopedSecretEnv: injectionModule.buildConnectionScopedSecretEnv,
  registry: injectionModule.STATIC_SECRET_CONNECTOR_REGISTRY,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, 'migrate-env-credentials.mjs');
const TEST_KEY = 'test-operator-key-do-not-use-in-prod';
// Synthetic credential values. Never real secrets.
const GMAIL_SECRET = 'aaaa bbbb cccc dddd';
const GITHUB_SECRET = 'ghp_synthetic_token_for_tests_0000';
const YNAB_SECRET = 'ynab_synthetic_pat_0000';
const SLACK_WORKSPACE = 'T12345';
const SLACK_TOKEN = 'xoxc-synthetic-token';
const SLACK_COOKIE = 'd=synthetic-cookie';
const REDDIT_USERNAME = 'dondochaka';
const REDDIT_PASSWORD = 'synthetic-password';
const REDDIT_CLIENT_ID = 'synthetic-client-id';
const REDDIT_CLIENT_SECRET = 'synthetic-client-secret';

function seedConnectorInstance({ connectorInstanceId, connectorId, status = 'active', sourceBindingJson = '{}' }) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)`).run(
    connectorId,
    JSON.stringify({ connector_id: connectorId }),
    '2026-06-10T00:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, 'owner_local', ?, ?, ?, 'account', ?, ?, '2026-06-10T00:00:00.000Z', '2026-06-10T00:00:00.000Z', NULL)`,
  ).run(connectorInstanceId, connectorId, connectorInstanceId, status, connectorInstanceId, sourceBindingJson);
}

function makeStores() {
  const env = { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY };
  return {
    credentialStore: createSqliteConnectorInstanceCredentialStore({ env }),
    connectorInstanceStore: createSqliteConnectorInstanceStore(),
  };
}

function withDb(fn) {
  return async () => {
    initDb(':memory:');
    try {
      await fn();
    } finally {
      closeDb();
    }
  };
}

function collectingLog(lines) {
  return (line) => lines.push(String(line));
}

test(
  'capture writes the env-sourced secret into the store; the run seam resolves the STORE value with the env var absent',
  withDb(async () => {
    const { credentialStore, connectorInstanceStore } = makeStores();
    seedConnectorInstance({ connectorInstanceId: 'cin_gmail_test', connectorId: 'gmail' });

    const lines = [];
    const result = await migrateEnvCredential({
      connectorKey: 'gmail',
      connectorInstanceId: 'cin_gmail_test',
      env: { GOOGLE_APP_PASSWORD_PDPP: GMAIL_SECRET },
      credentialStore,
      connectorInstanceStore,
      injection,
      log: collectingLog(lines),
    });

    assert.equal(result.action, 'capture');
    assert.equal(result.envVarName, 'GOOGLE_APP_PASSWORD_PDPP');
    assert.equal(result.verified, true);
    assert.equal(result.metadata.credentialKind, 'app_password');
    assert.equal(result.metadata.status, 'active');

    // Resolution-order proof, half 1: the run seam is store-only. Resolve the
    // run env fragment through the REAL production path with NO env var in
    // sight — the store value must come back.
    const fragment = await resolveStaticSecretRunEnv({
      connectorId: 'gmail',
      connectorInstanceId: 'cin_gmail_test',
      ownerSubjectId: 'owner_local',
      sourceBinding: null,
      credentialStore,
      isStaticSecretConnector: injection.isStaticSecretConnector,
      buildConnectionScopedSecretEnv: injection.buildConnectionScopedSecretEnv,
    });
    assert.equal(fragment.GOOGLE_APP_PASSWORD_PDPP, GMAIL_SECRET);
    assert.equal(fragment.GMAIL_APP_PASSWORD, GMAIL_SECRET);

    // Resolution-order proof, half 2: the collector runner merges the fragment
    // LAST over the process env (collector-runner.ts:2464:
    //   `{ ...process.env, ...buildCollectorChildEnv(...), ...connector.env }`),
    // so even a conflicting stale process-env value loses to the store value.
    const staleProcessEnv = { GOOGLE_APP_PASSWORD_PDPP: 'stale-process-env-value' };
    const childEnv = { ...staleProcessEnv, ...fragment };
    assert.equal(childEnv.GOOGLE_APP_PASSWORD_PDPP, GMAIL_SECRET);

    // Secret hygiene: nothing the script reports may carry the value.
    assert.ok(!lines.join('\n').includes(GMAIL_SECRET), 'log output must not contain the secret');
    assert.ok(!JSON.stringify(result.metadata).includes(GMAIL_SECRET), 'metadata must not contain the secret');
  }),
);

test(
  'github capture uses personal_access_token kind and the documented env aliases',
  withDb(async () => {
    const { credentialStore, connectorInstanceStore } = makeStores();
    seedConnectorInstance({ connectorInstanceId: 'cin_github_test', connectorId: 'github' });

    // Alias order: GITHUB_PERSONAL_ACCESS_TOKEN preferred over GITHUB_TOKEN.
    const result = await migrateEnvCredential({
      connectorKey: 'github',
      connectorInstanceId: 'cin_github_test',
      env: { GITHUB_TOKEN: GITHUB_SECRET },
      credentialStore,
      connectorInstanceStore,
      injection,
      log: () => {},
    });
    assert.equal(result.envVarName, 'GITHUB_TOKEN');
    assert.equal(result.metadata.credentialKind, 'personal_access_token');

    const fragment = await resolveStaticSecretRunEnv({
      connectorId: 'github',
      connectorInstanceId: 'cin_github_test',
      ownerSubjectId: 'owner_local',
      sourceBinding: null,
      credentialStore,
      isStaticSecretConnector: injection.isStaticSecretConnector,
      buildConnectionScopedSecretEnv: injection.buildConnectionScopedSecretEnv,
    });
    assert.equal(fragment.GITHUB_PERSONAL_ACCESS_TOKEN, GITHUB_SECRET);
    assert.equal(fragment.GITHUB_TOKEN, GITHUB_SECRET);
  }),
);

test(
  'ynab capture uses personal_access_token kind and both PAT aliases',
  withDb(async () => {
    const { credentialStore, connectorInstanceStore } = makeStores();
    seedConnectorInstance({ connectorInstanceId: 'cin_ynab_test', connectorId: 'ynab' });

    const result = await migrateEnvCredential({
      connectorKey: 'ynab',
      connectorInstanceId: 'cin_ynab_test',
      env: { YNAB_PAT: YNAB_SECRET },
      credentialStore,
      connectorInstanceStore,
      injection,
      log: () => {},
    });
    assert.equal(result.envVarName, 'YNAB_PAT');
    assert.equal(result.metadata.credentialKind, 'personal_access_token');

    const fragment = await resolveStaticSecretRunEnv({
      connectorId: 'ynab',
      connectorInstanceId: 'cin_ynab_test',
      ownerSubjectId: 'owner_local',
      sourceBinding: null,
      credentialStore,
      isStaticSecretConnector: injection.isStaticSecretConnector,
      buildConnectionScopedSecretEnv: injection.buildConnectionScopedSecretEnv,
    });
    assert.equal(fragment.YNAB_PERSONAL_ACCESS_TOKEN, YNAB_SECRET);
    assert.equal(fragment.YNAB_PAT, YNAB_SECRET);
  }),
);

test(
  'slack and reddit migrations seal multi-field credential bundles and verify the run seam',
  withDb(async () => {
    const { credentialStore, connectorInstanceStore } = makeStores();
    seedConnectorInstance({ connectorInstanceId: 'cin_slack_test', connectorId: 'slack' });
    seedConnectorInstance({ connectorInstanceId: 'cin_reddit_test', connectorId: 'reddit' });

    const slack = await migrateEnvCredential({
      connectorKey: 'slack',
      connectorInstanceId: 'cin_slack_test',
      env: {
        SLACK_WORKSPACE,
        SLACK_TOKEN,
        SLACK_COOKIE,
      },
      credentialStore,
      connectorInstanceStore,
      injection,
      log: () => {},
    });
    assert.equal(slack.metadata.credentialKind, 'secret_bundle');
    assert.equal(slack.verified, true);
    assert.equal(slack.envVarName, 'SLACK_WORKSPACE, SLACK_TOKEN, SLACK_COOKIE');
    const slackFragment = await resolveStaticSecretRunEnv({
      connectorId: 'slack',
      connectorInstanceId: 'cin_slack_test',
      ownerSubjectId: 'owner_local',
      sourceBinding: null,
      credentialStore,
      isStaticSecretConnector: injection.isStaticSecretConnector,
      buildConnectionScopedSecretEnv: injection.buildConnectionScopedSecretEnv,
    });
    assert.deepEqual(slackFragment, {
      SLACK_WORKSPACE,
      SLACK_TOKEN,
      SLACK_COOKIE,
    });

    const reddit = await migrateEnvCredential({
      connectorKey: 'reddit',
      connectorInstanceId: 'cin_reddit_test',
      env: {
        REDDIT_USERNAME,
        REDDIT_PASSWORD,
        REDDIT_CLIENT_ID,
        REDDIT_CLIENT_SECRET,
      },
      credentialStore,
      connectorInstanceStore,
      injection,
      log: () => {},
    });
    assert.equal(reddit.metadata.credentialKind, 'secret_bundle');
    assert.equal(reddit.verified, true);
    assert.equal(
      reddit.envVarName,
      'REDDIT_USERNAME, REDDIT_PASSWORD, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET',
    );
    const redditFragment = await resolveStaticSecretRunEnv({
      connectorId: 'reddit',
      connectorInstanceId: 'cin_reddit_test',
      ownerSubjectId: 'owner_local',
      sourceBinding: null,
      credentialStore,
      isStaticSecretConnector: injection.isStaticSecretConnector,
      buildConnectionScopedSecretEnv: injection.buildConnectionScopedSecretEnv,
    });
    assert.deepEqual(redditFragment, {
      REDDIT_USERNAME,
      REDDIT_PASSWORD,
      REDDIT_CLIENT_ID,
      REDDIT_CLIENT_SECRET,
    });
  }),
);

test(
  'idempotency: a second migration refuses without --force and rotates with it',
  withDb(async () => {
    const { credentialStore, connectorInstanceStore } = makeStores();
    seedConnectorInstance({ connectorInstanceId: 'cin_github_test', connectorId: 'github' });

    const base = {
      connectorKey: 'github',
      connectorInstanceId: 'cin_github_test',
      credentialStore,
      connectorInstanceStore,
      injection,
      log: () => {},
    };
    await migrateEnvCredential({ ...base, env: { GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_SECRET } });

    await assert.rejects(
      migrateEnvCredential({ ...base, env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_rotated_synthetic_1111' } }),
      (err) =>
        err instanceof EnvCredentialMigrationError && err.code === 'credential_already_present',
    );
    // Refusal left the original secret in place.
    const unchanged = await credentialStore.recoverSecret({ connectorInstanceId: 'cin_github_test' });
    assert.equal(unchanged.secret, GITHUB_SECRET);

    const rotated = await migrateEnvCredential({
      ...base,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_rotated_synthetic_1111' },
      force: true,
    });
    assert.equal(rotated.action, 'rotate');
    assert.ok(rotated.metadata.rotatedAt, 'rotation must stamp rotated_at');
    const after = await credentialStore.recoverSecret({ connectorInstanceId: 'cin_github_test' });
    assert.equal(after.secret, 'ghp_rotated_synthetic_1111');
  }),
);

test(
  'dry-run writes nothing',
  withDb(async () => {
    const { credentialStore, connectorInstanceStore } = makeStores();
    seedConnectorInstance({ connectorInstanceId: 'cin_gmail_test', connectorId: 'gmail' });

    const lines = [];
    const result = await migrateEnvCredential({
      connectorKey: 'gmail',
      connectorInstanceId: 'cin_gmail_test',
      dryRun: true,
      env: { GOOGLE_APP_PASSWORD_PDPP: GMAIL_SECRET },
      credentialStore,
      connectorInstanceStore,
      injection,
      log: collectingLog(lines),
    });
    assert.equal(result.action, 'dry_run');
    assert.equal(result.plannedAction, 'capture');
    assert.equal(await credentialStore.getMetadata('cin_gmail_test'), null);
    assert.ok(!lines.join('\n').includes(GMAIL_SECRET));
  }),
);

test(
  'guards: connector/instance mismatch, unknown connector, missing env var, inactive instance',
  withDb(async () => {
    const { credentialStore, connectorInstanceStore } = makeStores();
    seedConnectorInstance({ connectorInstanceId: 'cin_github_test', connectorId: 'github' });
    seedConnectorInstance({ connectorInstanceId: 'cin_revoked', connectorId: 'gmail', status: 'revoked' });

    const base = { credentialStore, connectorInstanceStore, injection, log: () => {} };

    await assert.rejects(
      migrateEnvCredential({
        ...base,
        connectorKey: 'gmail',
        connectorInstanceId: 'cin_github_test',
        env: { GOOGLE_APP_PASSWORD_PDPP: GMAIL_SECRET },
      }),
      (err) => err.code === 'connector_instance_mismatch',
    );
    await assert.rejects(
      migrateEnvCredential({
        ...base,
        connectorKey: 'notion',
        connectorInstanceId: 'cin_github_test',
        env: { NOTION_API_TOKEN: 'synthetic' },
      }),
      (err) => err.code === 'unknown_connector',
    );
    await assert.rejects(
      migrateEnvCredential({
        ...base,
        connectorKey: 'github',
        connectorInstanceId: 'cin_github_test',
        env: {},
      }),
      (err) => err.code === 'env_secret_missing',
    );
    await assert.rejects(
      migrateEnvCredential({
        ...base,
        connectorKey: 'gmail',
        connectorInstanceId: 'cin_revoked',
        env: { GOOGLE_APP_PASSWORD_PDPP: GMAIL_SECRET },
      }),
      (err) => err.code === 'connector_instance_inactive',
    );
    assert.equal(await credentialStore.getMetadata('cin_github_test'), null);
  }),
);

test('script mapping table matches the real STATIC_SECRET_CONNECTOR_REGISTRY', () => {
  assert.deepEqual(Object.keys(ENV_CREDENTIAL_SOURCES).sort(), Object.keys(injection.registry).sort());
  for (const [key, source] of Object.entries(ENV_CREDENTIAL_SOURCES)) {
    assert.equal(source.credentialKind, injection.registry[key].credentialKind, key);
    assert.deepEqual([...(source.secretEnvVars ?? [])], [...(injection.registry[key].secretEnvVars ?? [])], key);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(source.secretFieldEnvVars ?? {}).map(([field, names]) => [field, [...names]]),
      ),
      Object.fromEntries(
        Object.entries(injection.registry[key].secretFieldEnvVars ?? {}).map(([field, names]) => [field, [...names]]),
      ),
      key,
    );
  }
});

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI end-to-end against a throwaway SQLite file: dry-run, capture, idempotent refusal; no secret in output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-migrate-env-credentials-'));
  const dbPath = join(dir, 'throwaway.db');
  try {
    initDb(dbPath);
    seedConnectorInstance({ connectorInstanceId: 'cin_github_cli', connectorId: 'github' });
    closeDb();

    const cliEnv = {
      PDPP_DB_PATH: dbPath,
      PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY,
      GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_SECRET,
    };
    const baseArgs = ['--connector', 'github', '--instance', 'cin_github_cli'];

    const dry = await runCli([...baseArgs, '--dry-run'], cliEnv);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /\[dry-run\] would capture 'personal_access_token'/);

    const real = await runCli(baseArgs, cliEnv);
    assert.equal(real.code, 0, real.stderr);
    assert.match(real.stdout, /captured 'personal_access_token' credential for cin_github_cli/);
    assert.match(real.stdout, /store round-trip: verified/);

    const repeat = await runCli(baseArgs, cliEnv);
    assert.equal(repeat.code, EXIT_REFUSED_EXISTING);
    assert.match(repeat.stderr, /credential_already_present/);

    for (const output of [dry, real, repeat]) {
      assert.ok(!`${output.stdout}${output.stderr}`.includes(GITHUB_SECRET), 'CLI output must never contain the secret');
    }

    // The captured row decrypts to the env-sourced value (verified in-process).
    initDb(dbPath);
    try {
      const store = createSqliteConnectorInstanceCredentialStore({
        env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY },
      });
      const recovered = await store.recoverSecret({ connectorInstanceId: 'cin_github_cli' });
      assert.equal(recovered.secret, GITHUB_SECRET);
      assert.equal(recovered.credentialKind, 'personal_access_token');
    } finally {
      closeDb();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
