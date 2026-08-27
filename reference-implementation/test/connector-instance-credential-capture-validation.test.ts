// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Capture must refuse a value that cannot be a real secret.
 *
 * Reproduced 2026-08-26 against the REAL sqlite credential store: of four
 * masked/placeholder values driven through `capture()` — `"{}"`, `"••••••••"`,
 * `"unchanged"`, and eight spaces — **every one was ACCEPTED and sealed**, and
 * `recoverSecret()` then returned the placeholder as though it were the
 * owner's password. Zero refusals.
 *
 * The only guard was `secret.length === 0`, which none of those trip.
 *
 * Why it matters, in the owner's terms: a login then runs with eight spaces as
 * the password. The provider rejects it, the connection reads as broken
 * credentials, and the owner is asked to re-enter a password that was never
 * actually stored — while the real one may still be sitting in the form,
 * masked. Worse, repeated automated attempts with a junk secret are how an
 * account gets locked or rate-limited.
 *
 * A mask is a rendering of a secret, never a secret. Sealing one is the
 * system lying to itself about holding a credential.
 *
 * These tests are the reproduction, inverted: what was accepted must now be
 * refused, and a real secret must still be accepted unchanged.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { codeToStatus } from "../server/routes/ref-error-status.ts";
import {
  ConnectorInstanceCredentialError,
  createSqliteConnectorInstanceCredentialStore,
} from "../server/stores/connector-instance-credential-store.ts";

// Hoisted per lint/performance/useTopLevelRegex.
const MASK_MESSAGE_LEAK = /•|\*{4}|unchanged|redacted/;
const NOW = "2026-08-26T12:00:00.000Z";
const OWNER = "owner_capture_validation";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/capture-validation";
const INSTANCE_ID = "cin_capture_validation";
const REAL_SECRET = "correct horse battery staple";

interface CredentialStore {
  capture: (args: {
    connectorInstanceId: string;
    credentialKind: string;
    now: string;
    ownerSubjectId: string;
    secret: string;
  }) => Promise<unknown>;
  recoverSecret: (args: {
    connectorInstanceId: string;
    ownerSubjectId: string;
  }) => Promise<{ credentialKind: string; secret: string }>;
}

function seed(): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    CONNECTOR_ID,
    JSON.stringify({ connector_id: CONNECTOR_ID }),
    NOW
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  ).run(INSTANCE_ID, OWNER, CONNECTOR_ID, INSTANCE_ID, INSTANCE_ID, NOW, NOW);
}

function withStore(run: (store: CredentialStore) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-capture-validation-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      seed();
      const env = { ...process.env, PDPP_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64) };
      await run(createSqliteConnectorInstanceCredentialStore({ env }) as unknown as CredentialStore);
    } finally {
      closeDb();
    }
  };
}

async function captureSecret(store: CredentialStore, secret: string): Promise<void> {
  await store.capture({
    connectorInstanceId: INSTANCE_ID,
    credentialKind: "username_password",
    now: NOW,
    ownerSubjectId: OWNER,
    secret,
  });
}

/**
 * Every value the 2026-08-26 reproduction sealed, plus the mask shapes a form
 * round-trip realistically produces. Named individually so a failure says
 * WHICH shape slipped through rather than "one of the list".
 */
const REFUSED_VALUES: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: "eight spaces (sealed by the reproduction)", value: "        " },
  { label: "a single space", value: " " },
  { label: "tab and newline only", value: "\t\n" },
  { label: "bullet mask (sealed by the reproduction)", value: "••••••••" },
  { label: "asterisk mask", value: "********" },
  { label: "the literal 'unchanged' (sealed by the reproduction)", value: "unchanged" },
  { label: "empty-JSON placeholder (sealed by the reproduction)", value: "{}" },
  { label: "bracketed redaction marker", value: "[redacted]" },
  { label: "the literal 'null'", value: "null" },
  { label: "the literal 'undefined'", value: "undefined" },
];

for (const { label, value } of REFUSED_VALUES) {
  test(
    `capture refuses ${label}`,
    withStore(async (store) => {
      await assert.rejects(
        () => captureSecret(store, value),
        (err: unknown) => {
          assert.ok(
            err instanceof ConnectorInstanceCredentialError,
            `expected a typed ConnectorInstanceCredentialError, got ${String(err)}`
          );
          assert.equal(
            (err as ConnectorInstanceCredentialError).code,
            "credential_secret_invalid",
            "refusal must use the existing typed code so callers need no new branch"
          );
          // The refusal must not echo the rejected value: a mask is harmless,
          // but this path also sees near-miss real secrets (a password with a
          // stray trailing space is refused here too).
          assert.doesNotMatch(
            (err as ConnectorInstanceCredentialError).message,
            MASK_MESSAGE_LEAK,
            "the refusal message must not quote the rejected value back"
          );
          return true;
        }
      );
    })
  );
}

test("the refusal reaches the owner as a 400, not an opaque 500", () => {
  // Unmapped codes fall through to 500 (`codeToStatus[code] || 500`). A 500
  // would tell the owner the server broke, for something he can fix by typing
  // the real value — the refusal is only useful if it arrives as his mistake
  // to correct, not ours.
  assert.equal(codeToStatus.credential_secret_invalid, 400);
});

test(
  "a real secret is still accepted and recovers byte-identical",
  withStore(async (store) => {
    await captureSecret(store, REAL_SECRET);
    const { secret: secretOut } = await store.recoverSecret({
      connectorInstanceId: INSTANCE_ID,
      ownerSubjectId: OWNER,
    });
    assert.equal(secretOut, REAL_SECRET, "validation must not alter or reject a genuine secret");
  })
);

test(
  "a secret that merely CONTAINS a placeholder word is accepted",
  withStore(async (store) => {
    // The rule is shape-based, not substring-based. "unchanged" alone is a
    // form artifact; "myUnchangedP@ss" is a password someone actually chose,
    // and refusing it would be a new defect wearing a fix's clothes.
    const secret = "myUnchangedP@ss•word";
    await captureSecret(store, secret);
    const { secret: secretOut } = await store.recoverSecret({
      connectorInstanceId: INSTANCE_ID,
      ownerSubjectId: OWNER,
    });
    assert.equal(secretOut, secret);
  })
);

test(
  "a weak-but-real password is accepted — this guard does not judge strength",
  withStore(async (store) => {
    // "password" is a bad password, not a mask. If that is genuinely what a
    // provider account uses, refusing to store it would lock the owner out of
    // his own data to make a point about password strength. This guard exists
    // to stop the system sealing a value that CANNOT be a credential, not to
    // grade the ones that can. Pinned so it is not "helpfully" tightened later.
    await captureSecret(store, "password");
    const { secret: secretOut } = await store.recoverSecret({
      connectorInstanceId: INSTANCE_ID,
      ownerSubjectId: OWNER,
    });
    assert.equal(secretOut, "password");
  })
);

test(
  "a real secret with surrounding whitespace is preserved, not trimmed",
  withStore(async (store) => {
    // Trimming would silently change the owner's credential. Refuse
    // whitespace-ONLY values; never edit a value that has real content.
    const secret = " s3cret ";
    await captureSecret(store, secret);
    const { secret: secretOut } = await store.recoverSecret({
      connectorInstanceId: INSTANCE_ID,
      ownerSubjectId: OWNER,
    });
    assert.equal(secretOut, secret, "capture must store exactly what the owner typed");
  })
);
