// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  ConnectorInstanceCredentialError,
  CREDENTIAL_KINDS,
  createSqliteConnectorInstanceCredentialStore,
} from "../server/stores/connector-instance-credential-store.ts";
import {
  CREDENTIAL_ENCRYPTION_KEY_ENV,
  CredentialEncryptionError,
  createCredentialCipher,
  createCredentialCipherFromEnv,
  fingerprintsEqual,
  isCredentialEncryptionConfigured,
  resolveCredentialEncryptionKey,
} from "../server/stores/credential-encryption.ts";

const NOW = "2026-06-01T12:00:00.000Z";
const LATER = "2026-06-01T12:05:00.000Z";
const LATEST = "2026-06-01T12:10:00.000Z";
const TEST_KEY = "test-operator-key-do-not-use-in-prod";
const APP_PASSWORD = "abcd efgh ijkl mnop"; // Gmail app-password shape (synthetic).
const ROTATED_PASSWORD = "zzzz yyyy xxxx wwww";

// Local mirrors of the untyped `connector-instance-credential-store.ts` /
// `db.js` shapes this test exercises. `checkJs` is off, so these modules'
// exports are `any`; these interfaces exist only so THIS test file's own
// intermediate values narrow correctly under strict mode. Fields match the
// module's `projectMetadata` / `capture` / `recoverSecret` / `markRejected`
// implementations exactly (see server/stores/connector-instance-credential-store.ts).
interface CredentialMetadata {
  capturedAt: string;
  connectorInstanceId: string;
  credentialKind: string;
  fingerprint: string | null;
  ownerSubjectId: string;
  present: boolean;
  rejected: boolean;
  rejectedAt: string | null;
  rejectionReason: string | null;
  revokedAt: string | null;
  rotatedAt: string | null;
  status: string;
}

interface RecoveredSecret {
  credentialKind: string;
  secret: string;
}

interface SchemaMigrationEvent {
  backfilledRows?: number;
  changes?: number;
  droppedProviderId?: boolean;
  name: string;
  rebuilt?: boolean;
  [key: string]: unknown;
}

interface SeedConnectorInstanceArgs {
  connectorId: string;
  connectorInstanceId: string;
  ownerSubjectId: string;
}

interface CredentialRow {
  fingerprint: string | null;
  sealed_secret: string;
}

// Mirrors createSqliteConnectorInstanceCredentialStore's real return shape
// (server/stores/connector-instance-credential-store.ts `buildStore`).
// `ownerSubjectId` is required on recoverSecret so every plaintext recovery is
// owner-scoped before the sealed value is opened.
interface ConnectorInstanceCredentialStore {
  capture: (args: {
    connectorInstanceId: string;
    ownerSubjectId: string;
    credentialKind: string;
    secret: string;
    now: string;
  }) => Promise<CredentialMetadata | null>;
  delete: (connectorInstanceId: string) => Promise<boolean>;
  getMetadata: (connectorInstanceId: string) => Promise<CredentialMetadata | null>;
  hasActiveCredential: (connectorInstanceId: string) => Promise<boolean>;
  markRejected: (args: {
    connectorInstanceId: string;
    rejectedAt: string;
    reason?: string | null;
  }) => Promise<CredentialMetadata | null>;
  recoverSecret: (args: { connectorInstanceId: string; ownerSubjectId: string }) => Promise<RecoveredSecret>;
  revoke: (args: { connectorInstanceId: string; now: string }) => Promise<CredentialMetadata | null>;
}

type CreateStoreFn = (args: { env: Record<string, string | undefined> }) => ConnectorInstanceCredentialStore;
const createStore = createSqliteConnectorInstanceCredentialStore as CreateStoreFn;

function seedConnectorInstance({ connectorInstanceId, ownerSubjectId, connectorId }: SeedConnectorInstanceArgs) {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    connectorId,
    JSON.stringify({ connector_id: connectorId }),
    NOW
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  ).run(connectorInstanceId, ownerSubjectId, connectorId, connectorInstanceId, connectorInstanceId, NOW, NOW);
}

function withDb(fn: () => Promise<void> | void) {
  return async () => {
    initDb(":memory:");
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

test("cipher round-trips and never returns plaintext in the sealed token", () => {
  const cipher = createCredentialCipher(TEST_KEY);
  const sealed = cipher.seal(APP_PASSWORD);
  assert.equal(typeof sealed, "string");
  assert.ok(sealed.startsWith("v1:"), "sealed token is versioned");
  assert.ok(!sealed.includes(APP_PASSWORD), "sealed token must not contain plaintext");
  assert.equal(cipher.open(sealed), APP_PASSWORD);
});

test("two seals of the same plaintext differ (fresh salt+iv) but both open", () => {
  const cipher = createCredentialCipher(TEST_KEY);
  const a = cipher.seal(APP_PASSWORD);
  const b = cipher.seal(APP_PASSWORD);
  assert.notEqual(a, b, "ciphertext must be non-deterministic");
  assert.equal(cipher.open(a), APP_PASSWORD);
  assert.equal(cipher.open(b), APP_PASSWORD);
});

test("wrong key fails authentication without leaking which", () => {
  const sealed = createCredentialCipher(TEST_KEY).seal(APP_PASSWORD);
  assert.throws(
    () => createCredentialCipher("a-different-operator-key").open(sealed),
    (err) => err instanceof CredentialEncryptionError && err.code === "credential_decrypt_failed"
  );
});

test("tampered ciphertext fails authentication", () => {
  const cipher = createCredentialCipher(TEST_KEY);
  const sealed = cipher.seal(APP_PASSWORD);
  const parts = sealed.split(":");
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const ciphertextSegment = parts[4];
  assert.ok(ciphertextSegment, "sealed token has a ciphertext segment");
  // Flip a byte in the ciphertext segment.
  const ct = Buffer.from(ciphertextSegment, "base64");
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const firstByte = ct[0];
  assert.ok(firstByte !== undefined, "ciphertext has at least one byte");
  // biome-ignore lint/suspicious/noBitwiseOperators: bit mask is the protocol representation
  ct[0] = firstByte ^ 0xff;
  parts[4] = ct.toString("base64");
  assert.throws(
    () => cipher.open(parts.join(":")),
    (err) => err instanceof CredentialEncryptionError && err.code === "credential_decrypt_failed"
  );
});

test("fingerprint is stable per (key, plaintext), changes with plaintext, hides bytes", () => {
  const cipher = createCredentialCipher(TEST_KEY);
  const fp1 = cipher.fingerprint(APP_PASSWORD);
  const fp2 = cipher.fingerprint(APP_PASSWORD);
  const fp3 = cipher.fingerprint(ROTATED_PASSWORD);
  assert.ok(fingerprintsEqual(fp1, fp2), "same secret -> same fingerprint");
  assert.ok(!fingerprintsEqual(fp1, fp3), "different secret -> different fingerprint");
  assert.ok(fp1, "fingerprint of a non-empty secret is never null");
  assert.ok(!fp1.includes(APP_PASSWORD));
  // Fingerprint must be 16 bytes wide (32 hex chars) — S-7 fix.
  assert.equal(fp1.length, 32, "fingerprint must be 32 hex chars (16 bytes / 128-bit)");
});

test("from-env fails closed with a clear, secret-free error when key absent", () => {
  assert.equal(isCredentialEncryptionConfigured({}), false);
  assert.equal(resolveCredentialEncryptionKey({}), null);
  assert.throws(
    () => createCredentialCipherFromEnv({}),
    (err) => {
      assert.ok(err instanceof CredentialEncryptionError);
      assert.equal(err.code, "credential_encryption_key_missing");
      assert.ok(!err.message.includes(APP_PASSWORD));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Store: capture / read no-leakage / recover
// ---------------------------------------------------------------------------

test(
  "capture seals at rest; no read surface returns plaintext",
  withDb(async () => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    const store = createStore({ env: envWithKey() });
    const meta: CredentialMetadata | null = await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    assert.ok(meta, "capture returns the new metadata projection");
    // Metadata projection carries only non-secret fields.
    assert.equal(meta.connectorInstanceId, "cin_a");
    assert.equal(meta.credentialKind, "app_password");
    assert.equal(meta.status, "active");
    assert.equal(meta.present, true);
    assert.equal(meta.capturedAt, NOW);
    assert.equal(meta.rotatedAt, null);
    assert.ok(!Object.hasOwn(meta, "sealedSecret"), "metadata must not expose sealed_secret");
    assert.ok(!JSON.stringify(meta).includes(APP_PASSWORD), "metadata JSON must not contain plaintext");

    // The stored row holds only the sealed token, never plaintext.
    const row = getDb()
      .prepare("SELECT sealed_secret, fingerprint FROM connector_instance_credentials WHERE connector_instance_id = ?")
      .get("cin_a") as CredentialRow | undefined;
    assert.ok(row, "credential row exists after capture");
    assert.ok(!row.sealed_secret.includes(APP_PASSWORD), "at-rest column must not contain plaintext");
    assert.ok(row.sealed_secret.startsWith("v1:"));

    // Orchestrator can recover for injection.
    const recovered: RecoveredSecret = await store.recoverSecret({
      connectorInstanceId: "cin_a",
      ownerSubjectId: "owner_1",
    });
    assert.equal(recovered.secret, APP_PASSWORD);
    assert.equal(recovered.credentialKind, "app_password");
  })
);

test(
  "two connections for the same connector hold two distinct, non-colliding secrets",
  withDb(async () => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_personal", ownerSubjectId: "owner_1" });
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_work", ownerSubjectId: "owner_1" });
    const store = createStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: "cin_personal",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: "personal pass word here",
    });
    await store.capture({
      connectorInstanceId: "cin_work",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: "work pass word distinct",
    });
    const personal = await store.recoverSecret({ connectorInstanceId: "cin_personal", ownerSubjectId: "owner_1" });
    const work = await store.recoverSecret({ connectorInstanceId: "cin_work", ownerSubjectId: "owner_1" });
    assert.equal(personal.secret, "personal pass word here");
    assert.equal(work.secret, "work pass word distinct");
    assert.notEqual(personal.secret, work.secret, "mailboxes must not collide on one secret");
  })
);

test(
  "store accepts every supported credential kind",
  withDb(async () => {
    assert.deepEqual(CREDENTIAL_KINDS, [
      "access_token",
      "api_key",
      "app_password",
      "personal_access_token",
      "secret_bundle",
      "username_password",
    ]);
    const store = createStore({ env: envWithKey() });
    const cases = [
      { connectorId: "gmail", id: "cin_app_password", kind: "app_password", secret: APP_PASSWORD },
      { connectorId: "ynab", id: "cin_pat", kind: "personal_access_token", secret: "ynab_pat_value" },
      { connectorId: "groupme", id: "cin_access_token", kind: "access_token", secret: "groupme_token_value" },
      { connectorId: "jellyfin", id: "cin_api_key", kind: "api_key", secret: "jellyfin_api_key_value" },
      {
        connectorId: "slack",
        id: "cin_bundle",
        kind: "secret_bundle",
        secret: JSON.stringify({ slack_cookie: "d=cookie", slack_token: "xoxc-token" }),
      },
      {
        connectorId: "amazon",
        id: "cin_userpass",
        kind: "username_password",
        secret: JSON.stringify({ password: "provider-password", username: "owner@example.com" }),
      },
    ];
    for (const item of cases) {
      seedConnectorInstance({
        connectorId: item.connectorId,
        connectorInstanceId: item.id,
        ownerSubjectId: "owner_1",
      });
      // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
      const meta = await store.capture({
        connectorInstanceId: item.id,
        credentialKind: item.kind,
        now: NOW,
        ownerSubjectId: "owner_1",
        secret: item.secret,
      });
      assert.ok(meta, "capture returns metadata for every supported credential kind");
      assert.equal(meta.credentialKind, item.kind);
      const recovered = await store.recoverSecret({ connectorInstanceId: item.id, ownerSubjectId: "owner_1" });
      assert.equal(recovered.credentialKind, item.kind);
      assert.equal(recovered.secret, item.secret);
    }
  })
);

test("initDb widens legacy credential_kind CHECK without dropping stored credentials", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-credential-kind-migration-")), "ref.sqlite");
  initDb(dbPath);
  try {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_existing", ownerSubjectId: "owner_1" });
    const firstStore = createStore({ env: envWithKey() });
    await firstStore.capture({
      connectorInstanceId: "cin_existing",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    getDb().exec(`
      ALTER TABLE connector_instance_credentials RENAME TO connector_instance_credentials_new_kind;
      DROP INDEX IF EXISTS idx_connector_instance_credentials_owner_status;

      CREATE TABLE connector_instance_credentials (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id      TEXT NOT NULL,
        credential_kind       TEXT NOT NULL CHECK (credential_kind IN ('app_password', 'personal_access_token')),
        sealed_secret         TEXT NOT NULL,
        fingerprint           TEXT,
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        captured_at           TEXT NOT NULL,
        rotated_at            TEXT,
        revoked_at            TEXT,
        FOREIGN KEY(connector_instance_id) REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE
      );

      INSERT INTO connector_instance_credentials(
        connector_instance_id,
        owner_subject_id,
        credential_kind,
        sealed_secret,
        fingerprint,
        status,
        captured_at,
        rotated_at,
        revoked_at
      )
      SELECT
        connector_instance_id,
        owner_subject_id,
        credential_kind,
        sealed_secret,
        fingerprint,
        status,
        captured_at,
        rotated_at,
        revoked_at
      FROM connector_instance_credentials_new_kind;

      DROP TABLE connector_instance_credentials_new_kind;
      CREATE INDEX IF NOT EXISTS idx_connector_instance_credentials_owner_status
        ON connector_instance_credentials(owner_subject_id, status);
    `);
  } finally {
    closeDb();
  }

  const migrations: SchemaMigrationEvent[] = [];
  initDb(dbPath, {
    onSchemaMigration: (event: SchemaMigrationEvent) => {
      migrations.push(event);
    },
  });
  try {
    assert.ok(
      migrations.some((event) => event.name === "connector_credential_kind_check" && event.rebuilt === true),
      "legacy CHECK should be widened on boot"
    );
    const store = createStore({ env: envWithKey() });
    assert.equal(
      (await store.recoverSecret({ connectorInstanceId: "cin_existing", ownerSubjectId: "owner_1" })).secret,
      APP_PASSWORD
    );
    seedConnectorInstance({ connectorId: "slack", connectorInstanceId: "cin_bundle", ownerSubjectId: "owner_1" });
    const captured = await store.capture({
      connectorInstanceId: "cin_bundle",
      credentialKind: "secret_bundle",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: JSON.stringify({ slack_cookie: "d=cookie", slack_token: "xoxc-token" }),
    });
    assert.ok(captured, "capture returns metadata after the legacy CHECK migration");
    assert.equal(captured.credentialKind, "secret_bundle");
  } finally {
    closeDb();
  }
});

test("initDb widens legacy credential_kind CHECK to admit access_token and api_key without dropping stored credentials", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-credential-kind-token-migration-")), "ref.sqlite");
  initDb(dbPath);
  try {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_existing", ownerSubjectId: "owner_1" });
    const firstStore = createStore({ env: envWithKey() });
    await firstStore.capture({
      connectorInstanceId: "cin_existing",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    getDb().exec(`
      ALTER TABLE connector_instance_credentials RENAME TO connector_instance_credentials_new_kind_token;
      DROP INDEX IF EXISTS idx_connector_instance_credentials_owner_status;

      CREATE TABLE connector_instance_credentials (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id      TEXT NOT NULL,
        credential_kind       TEXT NOT NULL CHECK (credential_kind IN ('app_password', 'personal_access_token', 'secret_bundle', 'username_password')),
        sealed_secret         TEXT NOT NULL,
        fingerprint           TEXT,
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'rejected')),
        captured_at           TEXT NOT NULL,
        rotated_at            TEXT,
        revoked_at            TEXT,
        rejected_at           TEXT,
        rejection_reason      TEXT,
        FOREIGN KEY(connector_instance_id) REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE
      );

      INSERT INTO connector_instance_credentials(
        connector_instance_id,
        owner_subject_id,
        credential_kind,
        sealed_secret,
        fingerprint,
        status,
        captured_at,
        rotated_at,
        revoked_at,
        rejected_at,
        rejection_reason
      )
      SELECT
        connector_instance_id,
        owner_subject_id,
        credential_kind,
        sealed_secret,
        fingerprint,
        status,
        captured_at,
        rotated_at,
        revoked_at,
        rejected_at,
        rejection_reason
      FROM connector_instance_credentials_new_kind_token;

      DROP TABLE connector_instance_credentials_new_kind_token;
      CREATE INDEX IF NOT EXISTS idx_connector_instance_credentials_owner_status
        ON connector_instance_credentials(owner_subject_id, status);
    `);
  } finally {
    closeDb();
  }

  const migrations: SchemaMigrationEvent[] = [];
  initDb(dbPath, {
    onSchemaMigration: (event: SchemaMigrationEvent) => {
      migrations.push(event);
    },
  });
  try {
    assert.ok(
      migrations.some(
        (event) => event.name === "connector_credential_kind_check_access_token_api_key" && event.rebuilt === true
      ),
      "legacy CHECK should be widened on boot to admit access_token/api_key"
    );
    const store = createStore({ env: envWithKey() });
    assert.equal(
      (await store.recoverSecret({ connectorInstanceId: "cin_existing", ownerSubjectId: "owner_1" })).secret,
      APP_PASSWORD
    );
    seedConnectorInstance({
      connectorId: "groupme",
      connectorInstanceId: "cin_access_token",
      ownerSubjectId: "owner_1",
    });
    const captured = await store.capture({
      connectorInstanceId: "cin_access_token",
      credentialKind: "access_token",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: "groupme_token_value",
    });
    assert.ok(captured, "capture returns metadata after the access_token/api_key CHECK migration");
    assert.equal(captured.credentialKind, "access_token");
    assert.equal(
      (await store.recoverSecret({ connectorInstanceId: "cin_access_token", ownerSubjectId: "owner_1" })).secret,
      "groupme_token_value"
    );
  } finally {
    closeDb();
  }

  const rerunMigrations: SchemaMigrationEvent[] = [];
  initDb(dbPath, {
    onSchemaMigration: (event: SchemaMigrationEvent) => {
      rerunMigrations.push(event);
    },
  });
  try {
    assert.ok(
      !rerunMigrations.some((event) => event.name === "connector_credential_kind_check_access_token_api_key"),
      "re-running initDb against an already-widened DB must be a no-op — no migration event fires, matching the sibling migrations' convergence-guard convention"
    );
    const store = createStore({ env: envWithKey() });
    assert.equal(
      (await store.recoverSecret({ connectorInstanceId: "cin_existing", ownerSubjectId: "owner_1" })).secret,
      APP_PASSWORD,
      "pre-migration row must survive an idempotent re-run byte-identical"
    );
    assert.equal(
      (await store.recoverSecret({ connectorInstanceId: "cin_access_token", ownerSubjectId: "owner_1" })).secret,
      "groupme_token_value",
      "row captured post-migration must survive an idempotent re-run byte-identical"
    );
  } finally {
    closeDb();
  }
});

test("initDb widens legacy credential status CHECK and preserves stored credentials", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-credential-status-migration-")), "ref.sqlite");
  initDb(dbPath);
  try {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_existing", ownerSubjectId: "owner_1" });
    const firstStore = createStore({ env: envWithKey() });
    await firstStore.capture({
      connectorInstanceId: "cin_existing",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    getDb().exec(`
      ALTER TABLE connector_instance_credentials RENAME TO connector_instance_credentials_new_status;
      DROP INDEX IF EXISTS idx_connector_instance_credentials_owner_status;

      CREATE TABLE connector_instance_credentials (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id      TEXT NOT NULL,
        credential_kind       TEXT NOT NULL CHECK (credential_kind IN ('app_password', 'personal_access_token', 'secret_bundle', 'username_password')),
        sealed_secret         TEXT NOT NULL,
        fingerprint           TEXT,
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        captured_at           TEXT NOT NULL,
        rotated_at            TEXT,
        revoked_at            TEXT,
        FOREIGN KEY(connector_instance_id) REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE
      );

      INSERT INTO connector_instance_credentials(
        connector_instance_id,
        owner_subject_id,
        credential_kind,
        sealed_secret,
        fingerprint,
        status,
        captured_at,
        rotated_at,
        revoked_at
      )
      SELECT
        connector_instance_id,
        owner_subject_id,
        credential_kind,
        sealed_secret,
        fingerprint,
        status,
        captured_at,
        rotated_at,
        revoked_at
      FROM connector_instance_credentials_new_status;

      DROP TABLE connector_instance_credentials_new_status;
      CREATE INDEX IF NOT EXISTS idx_connector_instance_credentials_owner_status
        ON connector_instance_credentials(owner_subject_id, status);
    `);
  } finally {
    closeDb();
  }

  const migrations: SchemaMigrationEvent[] = [];
  initDb(dbPath, {
    onSchemaMigration: (event: SchemaMigrationEvent) => {
      migrations.push(event);
    },
  });
  try {
    assert.ok(
      migrations.some((event) => event.name === "connector_credential_status_rejected" && event.rebuilt === true),
      "legacy status CHECK should be widened on boot"
    );
    const store = createStore({ env: envWithKey() });
    assert.equal(
      (await store.recoverSecret({ connectorInstanceId: "cin_existing", ownerSubjectId: "owner_1" })).secret,
      APP_PASSWORD
    );
    const rejected = await store.markRejected({
      connectorInstanceId: "cin_existing",
      reason: "provider rejected stored credential",
      rejectedAt: LATER,
    });
    assert.ok(rejected, "markRejected returns metadata after the legacy status CHECK migration");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejectedAt, LATER);
  } finally {
    closeDb();
  }
});

// ---------------------------------------------------------------------------
// Lifecycle: rotate / revoke / delete — no resurrection
// ---------------------------------------------------------------------------

test(
  "rotation replaces the secret, preserves capturedAt, stamps rotatedAt, re-activates",
  withDb(async () => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    const store = createStore({ env: envWithKey() });
    const first = await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    const rotated = await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: LATER,
      ownerSubjectId: "owner_1",
      secret: ROTATED_PASSWORD,
    });
    assert.ok(first, "first capture returns metadata");
    assert.ok(rotated, "rotation capture returns metadata");
    assert.equal(rotated.capturedAt, NOW, "rotation preserves original capture time");
    assert.equal(rotated.rotatedAt, LATER, "rotation stamps a rotation time");
    assert.notEqual(rotated.fingerprint, first.fingerprint, "fingerprint changes with the new secret");
    const recovered = await store.recoverSecret({ connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    assert.equal(recovered.secret, ROTATED_PASSWORD, "recovers the rotated secret, not the old one");
  })
);

test(
  "revoke fails runs closed; recovery throws; row + metadata survive",
  withDb(async () => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    const store = createStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    const revoked = await store.revoke({ connectorInstanceId: "cin_a", now: LATER });
    assert.ok(revoked, "revoke returns the resulting metadata");
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revokedAt, LATER);
    assert.equal(await store.hasActiveCredential("cin_a"), false);
    await assert.rejects(
      () => store.recoverSecret({ connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_revoked"
    );
    // Metadata still readable (row not deleted) — credential lifecycle is distinct
    // from connection lifecycle.
    const meta = await store.getMetadata("cin_a");
    assert.ok(meta, "metadata survives revoke");
    assert.equal(meta.status, "revoked");
  })
);

test(
  "provider rejection fails runs closed; recovery throws; row + metadata survive",
  withDb(async () => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    const store = createStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    const rejected = await store.markRejected({
      connectorInstanceId: "cin_a",
      reason: "provider rejected stored credential",
      rejectedAt: LATER,
    });
    assert.ok(rejected, "markRejected returns the resulting metadata");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejected, true);
    assert.equal(rejected.rejectedAt, LATER);
    assert.equal(rejected.rejectionReason, "provider rejected stored credential");
    assert.equal(await store.hasActiveCredential("cin_a"), false);
    await assert.rejects(
      () => store.recoverSecret({ connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_rejected"
    );
    const meta = await store.getMetadata("cin_a");
    assert.ok(meta, "metadata survives provider rejection");
    assert.equal(meta.status, "rejected");
  })
);

test(
  "a revoked credential does not implicitly resurrect; only explicit re-capture restores it",
  withDb(async () => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    const store = createStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    await store.revoke({ connectorInstanceId: "cin_a", now: LATER });
    // Re-reading does not flip status back.
    const afterRevoke = await store.getMetadata("cin_a");
    assert.ok(afterRevoke, "metadata survives revoke");
    assert.equal(afterRevoke.status, "revoked");
    assert.equal(await store.hasActiveCredential("cin_a"), false);
    // Explicit re-capture is the only sanctioned resurrection.
    const recaptured = await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: LATEST,
      ownerSubjectId: "owner_1",
      secret: ROTATED_PASSWORD,
    });
    assert.ok(recaptured, "re-capture returns metadata");
    assert.equal(recaptured.status, "active");
    assert.equal(recaptured.revokedAt, null);
    assert.equal(
      (await store.recoverSecret({ connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" })).secret,
      ROTATED_PASSWORD
    );
  })
);

test(
  "a rejected credential does not implicitly resurrect; explicit re-capture clears rejection",
  withDb(async () => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    const store = createStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    await store.markRejected({
      connectorInstanceId: "cin_a",
      reason: "provider rejected stored credential",
      rejectedAt: LATER,
    });
    const afterRejection = await store.getMetadata("cin_a");
    assert.ok(afterRejection, "metadata survives provider rejection");
    assert.equal(afterRejection.status, "rejected");
    const recaptured = await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: LATEST,
      ownerSubjectId: "owner_1",
      secret: ROTATED_PASSWORD,
    });
    assert.ok(recaptured, "re-capture returns metadata");
    assert.equal(recaptured.status, "active");
    assert.equal(recaptured.rejected, false);
    assert.equal(recaptured.rejectedAt, null);
    assert.equal(recaptured.rejectionReason, null);
    assert.equal(
      (await store.recoverSecret({ connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" })).secret,
      ROTATED_PASSWORD
    );
  })
);

test(
  "delete removes the row so no orphaned secret survives; recovery fails closed",
  withDb(async () => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    const store = createStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    assert.equal(await store.delete("cin_a"), true);
    assert.equal(await store.getMetadata("cin_a"), null);
    const row = getDb()
      .prepare("SELECT connector_instance_id FROM connector_instance_credentials WHERE connector_instance_id = ?")
      .get("cin_a");
    assert.equal(row, undefined, "no credential row addressable after delete");
    await assert.rejects(
      () => store.recoverSecret({ connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_not_found"
    );
  })
);

test(
  "deleting the connector instance cascades the credential away (FK ON DELETE CASCADE)",
  withDb(async () => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    const store = createStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    // Simulate a connection delete at the connector_instances level.
    getDb().prepare("DELETE FROM connector_instances WHERE connector_instance_id = ?").run("cin_a");
    const row = getDb()
      .prepare("SELECT connector_instance_id FROM connector_instance_credentials WHERE connector_instance_id = ?")
      .get("cin_a");
    assert.equal(row, undefined, "credential must not survive a deleted connection");
  })
);

test(
  "recovery enforces owner scoping",
  withDb(async () => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    const store = createStore({ env: envWithKey() });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    await assert.rejects(
      () => store.recoverSecret({ connectorInstanceId: "cin_a", ownerSubjectId: "owner_2" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_owner_mismatch"
    );
  })
);

test(
  "capture fails closed when the operator key is unconfigured (no plaintext stored)",
  withDb(async () => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    const store = createStore({ env: {} });
    await assert.rejects(
      () =>
        store.capture({
          connectorInstanceId: "cin_a",
          credentialKind: "app_password",
          now: NOW,
          ownerSubjectId: "owner_1",
          secret: APP_PASSWORD,
        }),
      (err) => err instanceof CredentialEncryptionError && err.code === "credential_encryption_key_missing"
    );
    const row = getDb()
      .prepare("SELECT connector_instance_id FROM connector_instance_credentials WHERE connector_instance_id = ?")
      .get("cin_a");
    assert.equal(row, undefined, "nothing is written when encryption is unconfigured");
  })
);
