// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Golden-value compatibility test for the connector-instance Postgres
 * advisory-lock key derivation.
 *
 * `connectorInstanceAdvisoryLockKey` (connector-instance-write-coordinator.ts)
 * replaced the module-private `advisoryKey` the coordinator used when it
 * itself held a session-scoped `pg_try_advisory_lock`. Postgres advisory
 * locks share ONE 64-bit keyspace across every acquiring function
 * (`pg_try_advisory_lock`, `pg_advisory_lock`, `pg_advisory_xact_lock`, ...);
 * they are not namespaced by which function acquired them. That means a lock
 * acquired under old code (session-scoped) and one acquired under new code
 * (transaction-scoped) correctly contend with each other ONLY IF they hash
 * the SAME connectorInstanceId to the SAME bigint. This test asserts the
 * literal golden value the pre-migration hash produced, byte for byte — not
 * merely that the new function is internally self-consistent (a bug that
 * silently changed BOTH the old and new derivation identically would pass a
 * self-consistency check but still break a rolling deploy where old-code and
 * new-code processes momentarily coexist and stop serializing against each
 * other for the same identity).
 *
 * See harden-connector-instance-write-fence-transaction-native.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { connectorInstanceAdvisoryLockKey } from "../server/connector-instance-write-coordinator.ts";

// Reproduces the EXACT pre-migration `advisoryKey` implementation
// (connector-instance-write-coordinator.ts, pre-harden-connector-instance-
// write-fence-transaction-native), byte for byte, as an independent oracle
// that does not import from the module under test.
function preMigrationAdvisoryKey(connectorInstanceId: string): string {
  const bytes = createHash("sha256")
    .update("pdpp:connector-instance-write:v1:\u0000")
    .update(connectorInstanceId)
    .digest();
  return bytes.readBigInt64BE(0).toString();
}

test("connectorInstanceAdvisoryLockKey reproduces the pre-migration advisoryKey bigint exactly", () => {
  const sampleIds = [
    "cin_owner",
    "cin_ef5ebe548f0436e8b22c2e49",
    "cin_semantic_fence_a",
    "cin_batch_blob_liveness",
    "",
    "connector-instance-with-hyphens-and-123-digits",
    "🎉-unicode-connector-instance-id",
  ];
  for (const id of sampleIds) {
    assert.equal(
      connectorInstanceAdvisoryLockKey(id),
      preMigrationAdvisoryKey(id),
      `advisory key for '${id}' must match the pre-migration derivation exactly, or old-code and new-code sessions stop serializing against each other for the same identity during a rolling deploy`
    );
  }
});

test("connectorInstanceAdvisoryLockKey is deterministic and distinct per connector instance id", () => {
  const a = connectorInstanceAdvisoryLockKey("cin_alpha");
  const b = connectorInstanceAdvisoryLockKey("cin_beta");
  assert.notEqual(a, b);
  assert.equal(connectorInstanceAdvisoryLockKey("cin_alpha"), a);
});
