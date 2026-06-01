import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  createCredentialCipher,
  createCredentialCipherFromEnv,
  CredentialEncryptionError,
  fingerprintsEqual,
  isCredentialEncryptionConfigured,
  resolveCredentialEncryptionKey,
  CREDENTIAL_ENCRYPTION_KEY_ENV,
} from '../server/stores/credential-encryption.js';
import {
  ConnectorInstanceCredentialError,
  createSqliteConnectorInstanceCredentialStore,
} from '../server/stores/connector-instance-credential-store.js';

const NOW = '2026-06-01T12:00:00.000Z';
const LATER = '2026-06-01T12:05:00.000Z';
const LATEST = '2026-06-01T12:10:00.000Z';
const TEST_KEY = 'test-operator-key-do-not-use-in-prod';
const APP_PASSWORD = 'abcd efgh ijkl mnop'; // Gmail app-password shape (synthetic).
const ROTATED_PASSWORD = 'zzzz yyyy xxxx wwww';

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
  ).run(
    connectorInstanceId,
    ownerSubjectId,
    connectorId,
    connectorInstanceId,
    connectorInstanceId,
    NOW,
    NOW,
  );
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

function envWithKey(key = TEST_KEY) {
  return { [CREDENTIAL_ENCRYPTION_KEY_ENV]: key };
}

// ---------------------------------------------------------------------------
// Encryption primitive
// ---------------------------------------------------------------------------

test('cipher round-trips and never returns plaintext in the sealed token', () => {
  const cipher = createCredentialCipher(TEST_KEY);
  const sealed = cipher.seal(APP_PASSWORD);
  assert.equal(typeof sealed, 'string');
  assert.ok(sealed.startsWith('v1:'), 'sealed token is versioned');
  assert.ok(!sealed.includes(APP_PASSWORD), 'sealed token must not contain plaintext');
  assert.equal(cipher.open(sealed), APP_PASSWORD);
});

test('two seals of the same plaintext differ (fresh salt+iv) but both open', () => {
  const cipher = createCredentialCipher(TEST_KEY);
  const a = cipher.seal(APP_PASSWORD);
  const b = cipher.seal(APP_PASSWORD);
  assert.notEqual(a, b, 'ciphertext must be non-deterministic');
  assert.equal(cipher.open(a), APP_PASSWORD);
  assert.equal(cipher.open(b), APP_PASSWORD);
});

test('wrong key fails authentication without leaking which', () => {
  const sealed = createCredentialCipher(TEST_KEY).seal(APP_PASSWORD);
  assert.throws(
    () => createCredentialCipher('a-different-operator-key').open(sealed),
    (err) => err instanceof CredentialEncryptionError && err.code === 'credential_decrypt_failed',
  );
});

test('tampered ciphertext fails authentication', () => {
  const cipher = createCredentialCipher(TEST_KEY);
  const sealed = cipher.seal(APP_PASSWORD);
  const parts = sealed.split(':');
  // Flip a byte in the ciphertext segment.
  const ct = Buffer.from(parts[4], 'base64');
  ct[0] ^= 0xff;
  parts[4] = ct.toString('base64');
  assert.throws(
    () => cipher.open(parts.join(':')),
    (err) => err instanceof CredentialEncryptionError && err.code === 'credential_decrypt_failed',
  );
});

test('fingerprint is stable per (key, plaintext), changes with plaintext, hides bytes', () => {
  const cipher = createCredentialCipher(TEST_KEY);
  const fp1 = cipher.fingerprint(APP_PASSWORD);
  const fp2 = cipher.fingerprint(APP_PASSWORD);
  const fp3 = cipher.fingerprint(ROTATED_PASSWORD);
  assert.ok(fingerprintsEqual(fp1, fp2), 'same secret -> same fingerprint');
  assert.ok(!fingerprintsEqual(fp1, fp3), 'different secret -> different fingerprint');
  assert.ok(!fp1.includes(APP_PASSWORD));
});

test('from-env fails closed with a clear, secret-free error when key absent', () => {
  assert.equal(isCredentialEncryptionConfigured({}), false);
  assert.equal(resolveCredentialEncryptionKey({}), null);
  assert.throws(
    () => createCredentialCipherFromEnv({}),
    (err) => {
      assert.ok(err instanceof CredentialEncryptionError);
      assert.equal(err.code, 'credential_encryption_key_missing');
      assert.ok(!err.message.includes(APP_PASSWORD));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Store: capture / read no-leakage / recover
// ---------------------------------------------------------------------------

test(
  'capture seals at rest; no read surface returns plaintext',
  withDb(async () => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    const store = createSqliteConnectorInstanceCredentialStore({ env: envWithKey() });
    const meta = await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: APP_PASSWORD,
      now: NOW,
    });
    // Metadata projection carries only non-secret fields.
    assert.equal(meta.connectorInstanceId, 'cin_a');
    assert.equal(meta.credentialKind, 'app_password');
    assert.equal(meta.status, 'active');
    assert.equal(meta.present, true);
    assert.equal(meta.capturedAt, NOW);
    assert.equal(meta.rotatedAt, null);
    assert.ok(!Object.prototype.hasOwnProperty.call(meta, 'sealedSecret'), 'metadata must not expose sealed_secret');
    assert.ok(!JSON.stringify(meta).includes(APP_PASSWORD), 'metadata JSON must not contain plaintext');

    // The stored row holds only the sealed token, never plaintext.
    const row = getDb()
      .prepare(`SELECT sealed_secret, fingerprint FROM connector_instance_credentials WHERE connector_instance_id = ?`)
      .get('cin_a');
    assert.ok(!row.sealed_secret.includes(APP_PASSWORD), 'at-rest column must not contain plaintext');
    assert.ok(row.sealed_secret.startsWith('v1:'));

    // Orchestrator can recover for injection.
    const recovered = await store.recoverSecret({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1' });
    assert.equal(recovered.secret, APP_PASSWORD);
    assert.equal(recovered.credentialKind, 'app_password');
  }),
);

test(
  'two connections for the same connector hold two distinct, non-colliding secrets',
  withDb(async () => {
    seedConnectorInstance({ connectorInstanceId: 'cin_personal', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    seedConnectorInstance({ connectorInstanceId: 'cin_work', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    const store = createSqliteConnectorInstanceCredentialStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: 'cin_personal',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: 'personal pass word here',
      now: NOW,
    });
    await store.capture({
      connectorInstanceId: 'cin_work',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: 'work pass word distinct',
      now: NOW,
    });
    const personal = await store.recoverSecret({ connectorInstanceId: 'cin_personal' });
    const work = await store.recoverSecret({ connectorInstanceId: 'cin_work' });
    assert.equal(personal.secret, 'personal pass word here');
    assert.equal(work.secret, 'work pass word distinct');
    assert.notEqual(personal.secret, work.secret, 'mailboxes must not collide on one secret');
  }),
);

// ---------------------------------------------------------------------------
// Lifecycle: rotate / revoke / delete — no resurrection
// ---------------------------------------------------------------------------

test(
  'rotation replaces the secret, preserves capturedAt, stamps rotatedAt, re-activates',
  withDb(async () => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    const store = createSqliteConnectorInstanceCredentialStore({ env: envWithKey() });
    const first = await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: APP_PASSWORD,
      now: NOW,
    });
    const rotated = await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: ROTATED_PASSWORD,
      now: LATER,
    });
    assert.equal(rotated.capturedAt, NOW, 'rotation preserves original capture time');
    assert.equal(rotated.rotatedAt, LATER, 'rotation stamps a rotation time');
    assert.notEqual(rotated.fingerprint, first.fingerprint, 'fingerprint changes with the new secret');
    const recovered = await store.recoverSecret({ connectorInstanceId: 'cin_a' });
    assert.equal(recovered.secret, ROTATED_PASSWORD, 'recovers the rotated secret, not the old one');
  }),
);

test(
  'revoke fails runs closed; recovery throws; row + metadata survive',
  withDb(async () => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    const store = createSqliteConnectorInstanceCredentialStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: APP_PASSWORD,
      now: NOW,
    });
    const revoked = await store.revoke({ connectorInstanceId: 'cin_a', now: LATER });
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.revokedAt, LATER);
    assert.equal(await store.hasActiveCredential('cin_a'), false);
    await assert.rejects(
      () => store.recoverSecret({ connectorInstanceId: 'cin_a' }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === 'credential_revoked',
    );
    // Metadata still readable (row not deleted) — credential lifecycle is distinct
    // from connection lifecycle.
    const meta = await store.getMetadata('cin_a');
    assert.equal(meta.status, 'revoked');
  }),
);

test(
  'a revoked credential does not implicitly resurrect; only explicit re-capture restores it',
  withDb(async () => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    const store = createSqliteConnectorInstanceCredentialStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: APP_PASSWORD,
      now: NOW,
    });
    await store.revoke({ connectorInstanceId: 'cin_a', now: LATER });
    // Re-reading does not flip status back.
    assert.equal((await store.getMetadata('cin_a')).status, 'revoked');
    assert.equal(await store.hasActiveCredential('cin_a'), false);
    // Explicit re-capture is the only sanctioned resurrection.
    const recaptured = await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: ROTATED_PASSWORD,
      now: LATEST,
    });
    assert.equal(recaptured.status, 'active');
    assert.equal(recaptured.revokedAt, null);
    assert.equal((await store.recoverSecret({ connectorInstanceId: 'cin_a' })).secret, ROTATED_PASSWORD);
  }),
);

test(
  'delete removes the row so no orphaned secret survives; recovery fails closed',
  withDb(async () => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    const store = createSqliteConnectorInstanceCredentialStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: APP_PASSWORD,
      now: NOW,
    });
    assert.equal(await store.delete('cin_a'), true);
    assert.equal(await store.getMetadata('cin_a'), null);
    const row = getDb()
      .prepare(`SELECT connector_instance_id FROM connector_instance_credentials WHERE connector_instance_id = ?`)
      .get('cin_a');
    assert.equal(row, undefined, 'no credential row addressable after delete');
    await assert.rejects(
      () => store.recoverSecret({ connectorInstanceId: 'cin_a' }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === 'credential_not_found',
    );
  }),
);

test(
  'deleting the connector instance cascades the credential away (FK ON DELETE CASCADE)',
  withDb(async () => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    const store = createSqliteConnectorInstanceCredentialStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: APP_PASSWORD,
      now: NOW,
    });
    // Simulate a connection delete at the connector_instances level.
    getDb().prepare(`DELETE FROM connector_instances WHERE connector_instance_id = ?`).run('cin_a');
    const row = getDb()
      .prepare(`SELECT connector_instance_id FROM connector_instance_credentials WHERE connector_instance_id = ?`)
      .get('cin_a');
    assert.equal(row, undefined, 'credential must not survive a deleted connection');
  }),
);

test(
  'recovery enforces owner scoping',
  withDb(async () => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    const store = createSqliteConnectorInstanceCredentialStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_1',
      credentialKind: 'app_password',
      secret: APP_PASSWORD,
      now: NOW,
    });
    await assert.rejects(
      () => store.recoverSecret({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_2' }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === 'credential_owner_mismatch',
    );
  }),
);

test(
  'capture fails closed when the operator key is unconfigured (no plaintext stored)',
  withDb(async () => {
    seedConnectorInstance({ connectorInstanceId: 'cin_a', ownerSubjectId: 'owner_1', connectorId: 'gmail' });
    const store = createSqliteConnectorInstanceCredentialStore({ env: {} });
    await assert.rejects(
      () =>
        store.capture({
          connectorInstanceId: 'cin_a',
          ownerSubjectId: 'owner_1',
          credentialKind: 'app_password',
          secret: APP_PASSWORD,
          now: NOW,
        }),
      (err) => err instanceof CredentialEncryptionError && err.code === 'credential_encryption_key_missing',
    );
    const row = getDb()
      .prepare(`SELECT connector_instance_id FROM connector_instance_credentials WHERE connector_instance_id = ?`)
      .get('cin_a');
    assert.equal(row, undefined, 'nothing is written when encryption is unconfigured');
  }),
);
