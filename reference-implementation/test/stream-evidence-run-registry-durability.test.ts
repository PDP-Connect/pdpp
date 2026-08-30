// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Durability boundary for the STREAM_EVIDENCE accepted-claim registry.
 *
 * `stream_evidence_run_registry` holds the accepted `(run_id, stream)` claims
 * that enforce spec-collection-profile.md rule 5 ("at most one accepted
 * STREAM_EVIDENCE per stream per run_id"). Rule 5 defines "same run" strictly
 * by the caller-chosen `run_id` and grants no restart exception — which is why
 * the registry was moved out of an in-memory Map in the first place.
 *
 * A backup/restore boundary is the same kind of discontinuity as a process
 * restart, only wider: if the table were treated as transient (dropped from a
 * backup, or rebuilt empty on restore), a `run_id` that was already accepted
 * before the backup would claim successfully again after the restore, and the
 * runtime would admit duplicate authority for a pair rule 5 says is spent.
 *
 * The inventory classification in `server/backup-table-policy.ts` is the
 * declaration; these tests are the executable proof that the declaration
 * matches the behavior the store actually needs. `backup-table-inventory.test.ts`
 * proves the table is PRESENT in a backup artifact — this file proves the
 * ROWS carry the rejection across, which presence alone does not establish.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BACKUP_TABLE_INVENTORY,
  POSTGRES_STORAGE_TABLES,
  SQLITE_LAZY_STORAGE_TABLES,
} from "../server/backup-table-policy.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  createSqliteStreamEvidenceRunRegistryStore,
  streamEvidencePayloadDigest,
  streamEvidenceTerminalEventId,
} from "../server/stores/stream-evidence-run-registry-store.ts";

const REGISTRY_TABLE = "stream_evidence_run_registry";

function payload(runId: string, stream: string) {
  const normalizedPayloadJson = JSON.stringify({
    considered: 0,
    outcomes: { emitted: 0, gapped: 0, unaccounted: 0, unchanged: 0 },
    reference_only: true,
    stream,
  });
  const replayIdentityJson = normalizedPayloadJson;
  const payloadDigest = streamEvidencePayloadDigest(replayIdentityJson);
  return {
    normalizedPayloadJson,
    payloadDigest,
    replayIdentityJson,
    terminalEventId: streamEvidenceTerminalEventId(runId, stream, payloadDigest),
  };
}

test("the accepted-claim registry is declared durable, not transient", () => {
  const entry = BACKUP_TABLE_INVENTORY[REGISTRY_TABLE];
  assert.ok(entry, `${REGISTRY_TABLE} must be classified in BACKUP_TABLE_INVENTORY`);
  // Not merely "classified": rule 5 has no restore exception, so the only
  // classification whose semantics preserve the invariant is backup_required.
  // `derived_rebuildable` would assert the claims can be recomputed (nothing
  // else records them) and `ephemeral_crash_reconciled` would assert they may
  // be safely lost (losing one re-opens a spent run_id).
  assert.equal(
    entry.classification,
    "backup_required",
    `${REGISTRY_TABLE} claims cannot be rebuilt or safely lost; a dropped claim re-opens a spent run_id`
  );
});

test("the accepted-claim registry is not excluded from the durable storage seam", () => {
  // A table can be classified and still be carved out of what actually gets
  // persisted. Both carve-outs must exclude the registry.
  // Widened deliberately: the export is a narrow literal tuple, so a direct
  // `.includes` would be a compile error rather than a runtime assertion, and
  // would stop checking the moment the registry were added to that tuple.
  assert.equal(
    (SQLITE_LAZY_STORAGE_TABLES as readonly string[]).includes(REGISTRY_TABLE),
    false,
    `${REGISTRY_TABLE} must be bootstrapped, not lazily created`
  );
  assert.ok(
    POSTGRES_STORAGE_TABLES.includes(REGISTRY_TABLE),
    `${REGISTRY_TABLE} must be part of the Postgres storage seam`
  );
});

test("an accepted (run_id, stream) claim survives a backup/restore boundary and still blocks re-acceptance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-durability-"));
  const sourcePath = join(dir, "source.sqlite");
  const restoredPath = join(dir, "restored.sqlite");
  try {
    // Accept once against the source database.
    initDb(sourcePath);
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const claimPayload = payload("run_durable", "messages");
    const firstAccept = await store.claimStreamEvidenceForRunId("cin_durable", "run_durable", "messages", claimPayload);
    assert.equal(firstAccept.claimed, true, "the first claim must win");

    // Take the backup the operator would take, then drop the live database
    // entirely — the restore must stand on the artifact alone.
    getDb().prepare("VACUUM INTO ?").run(restoredPath);
    closeDb();
    rmSync(sourcePath, { force: true });

    // Restore and replay the SAME run_id, as a retry spanning the boundary would.
    initDb(restoredPath);
    const restoredStore = createSqliteStreamEvidenceRunRegistryStore();
    const replayAccept = await restoredStore.claimStreamEvidenceForRunId(
      "cin_durable",
      "run_durable",
      "messages",
      claimPayload
    );
    assert.equal(
      replayAccept.claimed,
      false,
      "a run_id accepted before the backup must still be spent after restore; accepting again is duplicate authority"
    );

    // The boundary must not over-reject either: an unrelated pair still claims.
    const freshAccept = await restoredStore.claimStreamEvidenceForRunId(
      "cin_durable",
      "run_other",
      "messages",
      payload("run_other", "messages")
    );
    assert.equal(freshAccept.claimed, true, "restore must not poison unrelated (run_id, stream) pairs");
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("the registry's uniqueness scope survives restore as exactly (run_id, stream)", async () => {
  // Rule 5's scope is the pair, not the connection. If a restore rebuilt the
  // table under a connector-scoped key, a different connector_instance_id
  // would wrongly re-claim a spent pair; if it were run-only, a distinct
  // stream would be wrongly blocked. Pin both directions across the boundary.
  const dir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-scope-"));
  const sourcePath = join(dir, "source.sqlite");
  const restoredPath = join(dir, "restored.sqlite");
  try {
    initDb(sourcePath);
    const store = createSqliteStreamEvidenceRunRegistryStore();
    assert.equal(
      (await store.claimStreamEvidenceForRunId("cin_a", "run_scope", "messages", payload("run_scope", "messages")))
        .claimed,
      true
    );
    getDb().prepare("VACUUM INTO ?").run(restoredPath);
    closeDb();
    rmSync(sourcePath, { force: true });

    initDb(restoredPath);
    const restored = createSqliteStreamEvidenceRunRegistryStore();
    assert.equal(
      (
        await restored.claimStreamEvidenceForRunId(
          "cin_DIFFERENT",
          "run_scope",
          "messages",
          payload("run_scope", "messages")
        )
      ).claimed,
      false,
      "a different connector_instance_id must not re-claim a spent (run_id, stream) after restore"
    );
    assert.equal(
      (
        await restored.claimStreamEvidenceForRunId(
          "cin_a",
          "run_scope",
          "attachments",
          payload("run_scope", "attachments")
        )
      ).claimed,
      true,
      "a different stream under the same run_id must remain claimable after restore"
    );
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});
