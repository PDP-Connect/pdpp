// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  createSqliteStreamEvidenceRunRegistryStore,
  getStreamEvidenceRollbackGateStatus,
  streamEvidencePayloadDigest,
  streamEvidenceTerminalEventId,
} from "../server/stores/stream-evidence-run-registry-store.ts";

const DIGEST_MISMATCH_PATTERN = /digest mismatch/i;
const LEGACY_CLAIM_PATTERN = /no recoverable normalized payload/i;
const TERMINAL_EVENT_ID_PATTERN = /terminal event identity mismatch/;

function payload(
  runId: string,
  stream: string,
  variant = "same",
  metadata: { grantId?: string; connectionId?: string } = {}
): {
  normalizedPayloadJson: string;
  replayIdentityJson: string;
  payloadDigest: string;
  terminalEventId: string;
} {
  const replayIdentityJson = JSON.stringify({
    considered: 0,
    outcomes: { emitted: 0, gapped: 0, unaccounted: 0, unchanged: 0 },
    reference_only: true,
    stream,
    variant,
  });
  const normalizedPayloadJson = JSON.stringify({
    ...JSON.parse(replayIdentityJson),
    connection_id: metadata.connectionId || "connection_a",
    grant_id: metadata.grantId || "grant_a",
    source: { id: "connector_a", kind: "connector" },
  });
  const payloadDigest = streamEvidencePayloadDigest(replayIdentityJson);
  return {
    normalizedPayloadJson,
    payloadDigest,
    replayIdentityJson,
    terminalEventId: streamEvidenceTerminalEventId(runId, stream, payloadDigest),
  };
}

function withTempDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-run-registry-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

test(
  "claimStreamEvidenceForRunId: concurrent claims for the SAME (run_id, stream) — exactly one wins",
  withTempDb(async () => {
    // Independent exact-head re-review: a separate has()-then-mark() pair is
    // a TOCTOU race under concurrent invocations. This proves the single
    // atomic claim actually serializes: of N concurrent calls for the same
    // (run_id, stream), exactly one must observe `claimed: true`.
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.claimStreamEvidenceForRunId("cin_concurrency", "run_race", "messages", payload("run_race", "messages"))
      )
    );
    const wins = results.filter((claimed) => claimed.claimed === true).length;
    const losses = results.filter((claimed) => claimed.claimed === false).length;
    assert.equal(wins, 1, "exactly one of the concurrent claims for the same (run_id, stream) must win");
    assert.equal(losses, 7, "every other concurrent claim for the same (run_id, stream) must lose");
  })
);

test(
  "claimStreamEvidenceForRunId: a second SEQUENTIAL claim for the same (run_id, stream) loses",
  withTempDb(async () => {
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const claimPayload = payload("run_a", "messages");
    const first = await store.claimStreamEvidenceForRunId("cin_sequential", "run_a", "messages", claimPayload);
    const second = await store.claimStreamEvidenceForRunId("cin_sequential", "run_a", "messages", claimPayload);
    assert.equal(first.claimed, true, "the first claim for a fresh (run_id, stream) must win");
    assert.equal(second.claimed, false, "a later claim for the SAME (run_id, stream) must lose, even sequentially");
  })
);

test(
  "claimStreamEvidenceForRunId: a DIFFERENT stream under the same run_id is an independent claim",
  withTempDb(async () => {
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const messages = await store.claimStreamEvidenceForRunId(
      "cin_control",
      "run_shared",
      "messages",
      payload("run_shared", "messages")
    );
    const bodies = await store.claimStreamEvidenceForRunId(
      "cin_control",
      "run_shared",
      "bodies",
      payload("run_shared", "bodies")
    );
    assert.equal(messages.claimed, true, "the first stream under this run_id must win its own claim");
    assert.equal(bodies.claimed, true, "a different stream under the SAME run_id must win an independent claim");
  })
);

test(
  "claimStreamEvidenceForRunId: the SAME stream under a DIFFERENT run_id is an independent claim",
  withTempDb(async () => {
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const runOne = await store.claimStreamEvidenceForRunId(
      "cin_control",
      "run_one",
      "messages",
      payload("run_one", "messages")
    );
    const runTwo = await store.claimStreamEvidenceForRunId(
      "cin_control",
      "run_two",
      "messages",
      payload("run_two", "messages")
    );
    assert.equal(runOne.claimed, true, "the first run_id claiming this stream must win");
    assert.equal(runTwo.claimed, true, "a different run_id claiming the SAME stream must win an independent claim");
  })
);

test(
  "claimStreamEvidenceForRunId: changing grant/connection provenance does not change replay identity",
  withTempDb(async () => {
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const first = await store.claimStreamEvidenceForRunId(
      "cin_metadata_a",
      "run_metadata",
      "messages",
      payload("run_metadata", "messages")
    );
    const replay = await store.claimStreamEvidenceForRunId(
      "cin_metadata_b",
      "run_metadata",
      "messages",
      payload("run_metadata", "messages", "same", { connectionId: "connection_b", grantId: "grant_b" })
    );
    assert.equal(first.claimed, true);
    assert.equal(replay.claimed, false, "metadata changes must not create a second claim");
    assert.equal(
      replay.claim.normalizedPayloadJson,
      first.claim.normalizedPayloadJson,
      "replay must use the first claim's exact terminal provenance payload"
    );
  })
);

test(
  "claimStreamEvidenceForRunId: store rejects a non-derived terminal event identity",
  withTempDb(async () => {
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const claimPayload = payload("run_event_id", "messages");
    await assert.rejects(
      store.claimStreamEvidenceForRunId("cin_event_id", "run_event_id", "messages", {
        ...claimPayload,
        terminalEventId: "evt_not_derived",
      }),
      TERMINAL_EVENT_ID_PATTERN
    );
  })
);

test(
  "claimStreamEvidenceForRunId: rollback gate is closed while a recoverable claim has no terminal event",
  withTempDb(async () => {
    const store = createSqliteStreamEvidenceRunRegistryStore();
    assert.deepEqual(await getStreamEvidenceRollbackGateStatus(), { inFlightNewFormatClaims: 0, safe: true });
    await store.claimStreamEvidenceForRunId(
      "cin_rollback",
      "run_rollback",
      "messages",
      payload("run_rollback", "messages")
    );
    assert.deepEqual(await getStreamEvidenceRollbackGateStatus(), { inFlightNewFormatClaims: 1, safe: false });
  })
);

test(
  "claimStreamEvidenceForRunId: durability — a claim recorded before closeDb()/initDb() (simulating a process restart) is still honored",
  withTempDb(async () => {
    // This is the exact scenario independent exact-head re-review flagged:
    // an in-memory registry loses the fact on process restart. Here the
    // underlying SQLite FILE (not `:memory:`) persists across a close/reopen
    // of the same path, standing in for a runtime process restart while the
    // durable store's backing file survives.
    const dir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-run-registry-restart-"));
    const dbPath = join(dir, "pdpp.sqlite");
    try {
      initDb(dbPath);
      const store = createSqliteStreamEvidenceRunRegistryStore();
      const claimPayload = payload("run_restart", "messages");
      const before = await store.claimStreamEvidenceForRunId("cin_restart", "run_restart", "messages", claimPayload);
      assert.equal(before.claimed, true, "the pre-restart claim must win");
      closeDb();

      // Reopen the SAME database file, standing in for a fresh process
      // lifetime after a restart.
      initDb(dbPath);
      const storeAfterRestart = createSqliteStreamEvidenceRunRegistryStore();
      const after = await storeAfterRestart.claimStreamEvidenceForRunId(
        "cin_restart",
        "run_restart",
        "messages",
        claimPayload
      );
      assert.equal(
        after.claimed,
        false,
        "re-claiming the SAME (run_id, stream) after a simulated process restart must still lose " +
          "— the durable claim from before the restart must still be honored"
      );
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  })
);

test(
  "claimStreamEvidenceForRunId: a divergent replay payload is rejected by digest",
  withTempDb(async () => {
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const firstPayload = payload("run_digest", "messages", "first");
    await store.claimStreamEvidenceForRunId("cin_digest", "run_digest", "messages", firstPayload);
    await assert.rejects(
      store.claimStreamEvidenceForRunId(
        "cin_digest",
        "run_digest",
        "messages",
        payload("run_digest", "messages", "different")
      ),
      DIGEST_MISMATCH_PATTERN
    );
  })
);

test(
  "claimStreamEvidenceForRunId: a legacy key-only claim fails closed without inventing evidence",
  withTempDb(async () => {
    getDb()
      .prepare("INSERT INTO stream_evidence_run_registry (connector_instance_id, run_id, stream) VALUES (?, ?, ?)")
      .run("cin_legacy", "run_legacy", "messages");
    const store = createSqliteStreamEvidenceRunRegistryStore();
    await assert.rejects(
      store.claimStreamEvidenceForRunId("cin_legacy", "run_legacy", "messages", payload("run_legacy", "messages")),
      LEGACY_CLAIM_PATTERN
    );
  })
);

test(
  "claimStreamEvidenceForRunId: a 14767dd claim supports exact replay after the identity migration",
  withTempDb(async () => {
    const claimPayload = payload("run_pre_identity", "messages");
    const oldPayloadDigest = streamEvidencePayloadDigest(claimPayload.normalizedPayloadJson);
    const oldEventId = streamEvidenceTerminalEventId("run_pre_identity", "messages", oldPayloadDigest);
    getDb()
      .prepare(
        "INSERT INTO stream_evidence_run_registry (connector_instance_id, run_id, stream, payload_json, payload_digest, event_id) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        "cin_pre_identity",
        "run_pre_identity",
        "messages",
        claimPayload.normalizedPayloadJson,
        oldPayloadDigest,
        oldEventId
      );
    const replay = await createSqliteStreamEvidenceRunRegistryStore().claimStreamEvidenceForRunId(
      "cin_pre_identity",
      "run_pre_identity",
      "messages",
      claimPayload
    );
    assert.equal(replay.claimed, false);
    assert.equal(replay.claim.terminalEventId, oldEventId, "old claim identity remains authoritative on replay");
  })
);
