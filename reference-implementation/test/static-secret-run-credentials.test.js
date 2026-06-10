import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';

// The orchestration seam takes the connector-package injection helpers as
// injected dependencies (it does not hard-wire a cross-package import). The
// reference test suite runs under bare `node --test` (no tsx), so it cannot load
// the connector package's `.ts` runner barrel; instead it injects local stand-ins
// that mirror the real registry shape. The REAL `buildConnectionScopedSecretEnv`
// / `isStaticSecretConnector` are proven directly, including a live spawn-path
// run, in packages/polyfill-connectors/src/static-secret-injection.test.ts. This
// suite proves the store<->seam fail-closed contract.
const STATIC_SECRET_REGISTRY = {
  gmail: { credentialKind: 'app_password', secretEnvVars: ['GOOGLE_APP_PASSWORD_PDPP', 'GMAIL_APP_PASSWORD'] },
  github: { credentialKind: 'personal_access_token', secretEnvVars: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN'] },
};
function isStaticSecretConnector(connectorId) {
  return Object.hasOwn(STATIC_SECRET_REGISTRY, connectorId);
}
function buildConnectionScopedSecretEnv(connectorId, recovered) {
  const descriptor = STATIC_SECRET_REGISTRY[connectorId];
  const fragment = {};
  for (const envVar of descriptor.secretEnvVars) {
    fragment[envVar] = recovered.secret;
  }
  return fragment;
}
import {
  ConnectorInstanceCredentialError,
  createSqliteConnectorInstanceCredentialStore,
} from '../server/stores/connector-instance-credential-store.js';
import {
  resolveStaticSecretRunEnv,
  StaticSecretRunCredentialError,
} from '../server/stores/static-secret-run-credentials.js';

const NOW = '2026-06-01T12:00:00.000Z';
const LATER = '2026-06-01T12:05:00.000Z';
const LATEST = '2026-06-01T12:10:00.000Z';
const TEST_KEY = 'test-operator-key-do-not-use-in-prod';
const APP_PASSWORD = 'abcd efgh ijkl mnop';
const ROTATED = 'zzzz yyyy xxxx wwww';

function seedConnectorInstance({ connectorInstanceId, ownerSubjectId, connectorId }) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)`).run(
    connectorId,
    JSON.stringify({ connector_id: connectorId }),
    NOW,
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`,
  ).run(connectorInstanceId, ownerSubjectId, connectorId, connectorInstanceId, connectorInstanceId, NOW, NOW);
}

function withStore(fn) {
  return async () => {
    initDb(':memory:');
    try {
      const store = createSqliteConnectorInstanceCredentialStore({
        env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY },
      });
      await fn(store);
    } finally {
      closeDb();
    }
  };
}

function resolveEnv(store, { connectorId, connectorInstanceId, ownerSubjectId }) {
  return resolveStaticSecretRunEnv({
    connectorId,
    connectorInstanceId,
    ownerSubjectId,
    credentialStore: store,
    isStaticSecretConnector,
    buildConnectionScopedSecretEnv,
  });
}

test(
  'an active credential resolves a connection-scoped run env fragment',
  withStore(async (store) => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: APP_PASSWORD,
      now: NOW,
    });
    const env = await resolveEnv(store, { connectorId: 'gmail', connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1' });
    assert.equal(env.GOOGLE_APP_PASSWORD_PDPP, APP_PASSWORD);
    assert.equal(env.GMAIL_APP_PASSWORD, APP_PASSWORD);
  }),
);

test(
  'a missing credential fails the run closed (no env fragment)',
  withStore(async (store) => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    await assert.rejects(
      () => resolveEnv(store, { connectorId: 'gmail', connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1' }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === 'credential_not_found',
    );
  }),
);

test(
  'a revoked credential fails the run closed; a run cannot authenticate with a stale secret',
  withStore(async (store) => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: APP_PASSWORD,
      now: NOW,
    });
    await store.revoke({ connectorInstanceId: 'cin_a', now: LATER });
    await assert.rejects(
      () => resolveEnv(store, { connectorId: 'gmail', connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1' }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === 'credential_revoked',
    );
  }),
);

test(
  'a deleted credential fails the run closed and does not resurrect',
  withStore(async (store) => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: APP_PASSWORD,
      now: NOW,
    });
    await store.delete('cin_a');
    await assert.rejects(
      () => resolveEnv(store, { connectorId: 'gmail', connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1' }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === 'credential_not_found',
    );
  }),
);

test(
  'after an explicit re-capture, the run resolves the new secret (not the revoked one)',
  withStore(async (store) => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: APP_PASSWORD,
      now: NOW,
    });
    await store.revoke({ connectorInstanceId: 'cin_a', now: LATER });
    await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: ROTATED,
      now: LATEST,
    });
    const env = await resolveEnv(store, { connectorId: 'gmail', connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1' });
    assert.equal(env.GOOGLE_APP_PASSWORD_PDPP, ROTATED);
  }),
);

test(
  'two connections resolve two distinct run envs (no process-global collision at the seam)',
  withStore(async (store) => {
    seedConnectorInstance({ connectorInstanceId: 'cin_personal', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    seedConnectorInstance({ connectorInstanceId: 'cin_work', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    await store.capture({
      connectorInstanceId: 'cin_personal',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: 'personal one here',
      now: NOW,
    });
    await store.capture({
      connectorInstanceId: 'cin_work',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: 'work two distinct',
      now: NOW,
    });
    const personal = await resolveEnv(store, { connectorId: 'gmail', connectorInstanceId: 'cin_personal' });
    const work = await resolveEnv(store, { connectorId: 'gmail', connectorInstanceId: 'cin_work' });
    assert.equal(personal.GOOGLE_APP_PASSWORD_PDPP, 'personal one here');
    assert.equal(work.GOOGLE_APP_PASSWORD_PDPP, 'work two distinct');
    assert.notEqual(personal.GOOGLE_APP_PASSWORD_PDPP, work.GOOGLE_APP_PASSWORD_PDPP);
  }),
);

test(
  'a non-static-secret connector is refused at the seam',
  withStore(async (store) => {
    await assert.rejects(
      () => resolveEnv(store, { connectorId: 'amazon', connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1' }),
      (err) => err instanceof StaticSecretRunCredentialError && err.code === 'not_a_static_secret_connector',
    );
  }),
);
