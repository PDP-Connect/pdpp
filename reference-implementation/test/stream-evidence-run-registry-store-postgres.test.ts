// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PostgreSQL half of `claimStreamEvidenceForRunId` (see
 * `test/stream-evidence-run-registry-store.test.ts` for the SQLite half).
 *
 * Independent review (STREAM-EVIDENCE-P1-2-ROUND4-INDEPENDENT-REVIEW.md, P2)
 * found the PostgreSQL branch (`createPostgresStreamEvidenceRunRegistryStore`,
 * `server/stores/stream-evidence-run-registry-store.ts`) had no live-database
 * proof: the query shape (`ON CONFLICT (run_id, stream) DO NOTHING RETURNING
 * run_id`) was correct by inspection only. This file proves it against a real
 * PostgreSQL instance, including the same concurrent-claim race the SQLite
 * suite proves. It honestly skips when `PDPP_TEST_POSTGRES_URL` is unset
 * (no live PostgreSQL available) rather than silently passing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresStreamEvidenceRunRegistryStore,
  getStreamEvidenceRollbackGateStatus,
  streamEvidencePayloadDigest,
  streamEvidenceTerminalEventId,
} from "../server/stores/stream-evidence-run-registry-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const DIGEST_MISMATCH_PATTERN = /digest mismatch/i;
const LEGACY_CLAIM_PATTERN = /no recoverable normalized payload/;
const TERMINAL_EVENT_ID_PATTERN = /terminal event identity mismatch/;

function payload(runId: string, stream: string, variant = "same") {
  const replayIdentityJson = JSON.stringify({
    considered: 0,
    outcomes: { emitted: 0, gapped: 0, unaccounted: 0, unchanged: 0 },
    reference_only: true,
    stream,
    variant,
  });
  const normalizedPayloadJson = JSON.stringify({
    ...JSON.parse(replayIdentityJson),
    connection_id: "connection_a",
    grant_id: "grant_a",
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

async function cleanupRegistryRowsFor(connectorInstanceIdPrefix: string) {
  await postgresQuery("DELETE FROM stream_evidence_run_registry WHERE connector_instance_id LIKE $1", [
    `${connectorInstanceIdPrefix}%`,
  ]);
}

test("postgres claimStreamEvidenceForRunId: concurrent claims for the SAME (run_id, stream) — exactly one wins", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  t.after(async () => {
    await cleanupRegistryRowsFor("cin_pg_concurrency");
    await closePostgresStorage();
  });
  await cleanupRegistryRowsFor("cin_pg_concurrency");

  const store = createPostgresStreamEvidenceRunRegistryStore();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.claimStreamEvidenceForRunId(
        "cin_pg_concurrency",
        "run_pg_race",
        "messages",
        payload("run_pg_race", "messages")
      )
    )
  );
  const wins = results.filter((claimed) => claimed.claimed === true).length;
  const losses = results.filter((claimed) => claimed.claimed === false).length;
  assert.equal(
    wins,
    1,
    "exactly one of 8 concurrent claims for the same (run_id, stream) must win against real PostgreSQL"
  );
  assert.equal(losses, 7, "every other concurrent claim for the same (run_id, stream) must lose");
});

test("postgres claimStreamEvidenceForRunId: a second SEQUENTIAL claim for the same (run_id, stream) loses", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  t.after(async () => {
    await cleanupRegistryRowsFor("cin_pg_sequential");
    await closePostgresStorage();
  });
  await cleanupRegistryRowsFor("cin_pg_sequential");

  const store = createPostgresStreamEvidenceRunRegistryStore();
  const claimPayload = payload("run_pg_a", "messages");
  const first = await store.claimStreamEvidenceForRunId("cin_pg_sequential", "run_pg_a", "messages", claimPayload);
  const second = await store.claimStreamEvidenceForRunId("cin_pg_sequential", "run_pg_a", "messages", claimPayload);
  assert.equal(first.claimed, true, "the first claim for a fresh (run_id, stream) must win");
  assert.equal(second.claimed, false, "a later claim for the SAME (run_id, stream) must lose, even sequentially");
});

test("postgres claimStreamEvidenceForRunId: a DIFFERENT stream under the same run_id is an independent claim", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  t.after(async () => {
    await cleanupRegistryRowsFor("cin_pg_control");
    await closePostgresStorage();
  });
  await cleanupRegistryRowsFor("cin_pg_control");

  const store = createPostgresStreamEvidenceRunRegistryStore();
  const messages = await store.claimStreamEvidenceForRunId(
    "cin_pg_control",
    "run_pg_shared",
    "messages",
    payload("run_pg_shared", "messages")
  );
  const bodies = await store.claimStreamEvidenceForRunId(
    "cin_pg_control",
    "run_pg_shared",
    "bodies",
    payload("run_pg_shared", "bodies")
  );
  assert.equal(messages.claimed, true, "the first stream under this run_id must win its own claim");
  assert.equal(bodies.claimed, true, "a different stream under the SAME run_id must win an independent claim");
});

test("postgres claimStreamEvidenceForRunId: the SAME stream under a DIFFERENT run_id is an independent claim", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  t.after(async () => {
    await cleanupRegistryRowsFor("cin_pg_control_runs");
    await closePostgresStorage();
  });
  await cleanupRegistryRowsFor("cin_pg_control_runs");

  const store = createPostgresStreamEvidenceRunRegistryStore();
  const runOne = await store.claimStreamEvidenceForRunId(
    "cin_pg_control_runs",
    "run_pg_one",
    "messages",
    payload("run_pg_one", "messages")
  );
  const runTwo = await store.claimStreamEvidenceForRunId(
    "cin_pg_control_runs",
    "run_pg_two",
    "messages",
    payload("run_pg_two", "messages")
  );
  assert.equal(runOne.claimed, true, "the first run_id claiming this stream must win");
  assert.equal(runTwo.claimed, true, "a different run_id claiming the SAME stream must win an independent claim");
});

test("postgres claimStreamEvidenceForRunId: a divergent replay payload is rejected by digest", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  t.after(async () => {
    await cleanupRegistryRowsFor("cin_pg_digest");
    await closePostgresStorage();
  });
  await cleanupRegistryRowsFor("cin_pg_digest");

  const store = createPostgresStreamEvidenceRunRegistryStore();
  await store.claimStreamEvidenceForRunId(
    "cin_pg_digest",
    "run_pg_digest",
    "messages",
    payload("run_pg_digest", "messages", "first")
  );
  await assert.rejects(
    store.claimStreamEvidenceForRunId(
      "cin_pg_digest",
      "run_pg_digest",
      "messages",
      payload("run_pg_digest", "messages", "different")
    ),
    DIGEST_MISMATCH_PATTERN
  );
});

test("postgres claimStreamEvidenceForRunId: changing grant/connection provenance recovers the first claim", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  t.after(async () => {
    await cleanupRegistryRowsFor("cin_pg_metadata");
    await closePostgresStorage();
  });
  await cleanupRegistryRowsFor("cin_pg_metadata");

  const store = createPostgresStreamEvidenceRunRegistryStore();
  const firstPayload = payload("run_pg_metadata", "messages");
  const replayPayload = {
    ...payload("run_pg_metadata", "messages"),
    normalizedPayloadJson: JSON.stringify({
      ...JSON.parse(payload("run_pg_metadata", "messages").replayIdentityJson),
      connection_id: "connection_b",
      grant_id: "grant_b",
      source: { id: "connector_b", kind: "connector" },
    }),
  };
  const first = await store.claimStreamEvidenceForRunId(
    "cin_pg_metadata_a",
    "run_pg_metadata",
    "messages",
    firstPayload
  );
  const replay = await store.claimStreamEvidenceForRunId(
    "cin_pg_metadata_b",
    "run_pg_metadata",
    "messages",
    replayPayload
  );
  assert.equal(first.claimed, true);
  assert.equal(replay.claimed, false);
  assert.equal(replay.claim.normalizedPayloadJson, first.claim.normalizedPayloadJson);
});

test("postgres claimStreamEvidenceForRunId: the store enforces deterministic terminal event identity", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  t.after(async () => {
    await cleanupRegistryRowsFor("cin_pg_event_id");
    await closePostgresStorage();
  });
  await cleanupRegistryRowsFor("cin_pg_event_id");

  const claimPayload = payload("run_pg_event_id", "messages");
  await assert.rejects(
    createPostgresStreamEvidenceRunRegistryStore().claimStreamEvidenceForRunId(
      "cin_pg_event_id",
      "run_pg_event_id",
      "messages",
      { ...claimPayload, terminalEventId: "evt_not_derived" }
    ),
    TERMINAL_EVENT_ID_PATTERN
  );
});

test("postgres claimStreamEvidenceForRunId: rollback gate requires no in-flight recoverable claim", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  t.after(async () => {
    await cleanupRegistryRowsFor("cin_pg_rollback");
    await closePostgresStorage();
  });
  await cleanupRegistryRowsFor("cin_pg_rollback");
  assert.deepEqual(await getStreamEvidenceRollbackGateStatus(), { inFlightNewFormatClaims: 0, safe: true });
  await createPostgresStreamEvidenceRunRegistryStore().claimStreamEvidenceForRunId(
    "cin_pg_rollback",
    "run_pg_rollback",
    "messages",
    payload("run_pg_rollback", "messages")
  );
  assert.deepEqual(await getStreamEvidenceRollbackGateStatus(), { inFlightNewFormatClaims: 1, safe: false });
});

async function insertTerminalEvidenceEvent(runId: string, stream: string, eventId: string): Promise<void> {
  await postgresQuery(
    `INSERT INTO spine_events (
       event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id,
       source_kind, source_id, stream_id, connector_instance_id, data_json, version
     ) VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17)`,
    [
      eventId,
      "run.stream_evidence_declared",
      "2026-08-29T00:00:00.000Z",
      "test",
      `trace_${runId}`,
      "runtime",
      "connector_a",
      "run",
      runId,
      "succeeded",
      runId,
      "connector",
      "connector_a",
      stream,
      "cin_pg_crash",
      JSON.stringify({ stream }),
      1,
    ]
  );
}

test("postgres claimStreamEvidenceForRunId: claim-before-terminal recovery survives a connection restart", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  t.after(async () => {
    await cleanupRegistryRowsFor("cin_pg_crash");
    await closePostgresStorage();
  });
  await cleanupRegistryRowsFor("cin_pg_crash");

  const claimPayload = payload("run_pg_crash", "messages");
  const eventId = claimPayload.terminalEventId;
  const firstStore = createPostgresStreamEvidenceRunRegistryStore();
  assert.equal(
    (await firstStore.claimStreamEvidenceForRunId("cin_pg_crash", "run_pg_crash", "messages", claimPayload)).claimed,
    true
  );
  await closePostgresStorage();

  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  const restartedStore = createPostgresStreamEvidenceRunRegistryStore();
  const replay = await restartedStore.claimStreamEvidenceForRunId(
    "cin_pg_crash",
    "run_pg_crash",
    "messages",
    claimPayload
  );
  assert.equal(replay.claimed, false);
  assert.equal(replay.claim.terminalEvidencePersisted, false, "the crash window has no terminal event yet");

  await insertTerminalEvidenceEvent("run_pg_crash", "messages", eventId);
  const recovered = await restartedStore.getStreamEvidenceClaim("run_pg_crash", "messages", claimPayload);
  assert.ok(recovered);
  assert.equal(recovered.terminalEvidencePersisted, true);
  assert.equal(recovered.terminalEventId, eventId);
});

test("postgres claimStreamEvidenceForRunId: legacy key-only rows remain spent after migration and fail closed", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  t.after(async () => {
    await cleanupRegistryRowsFor("cin_pg_legacy");
    await closePostgresStorage();
  });
  await cleanupRegistryRowsFor("cin_pg_legacy");
  await postgresQuery(
    "ALTER TABLE stream_evidence_run_registry DROP COLUMN IF EXISTS replay_identity_json, DROP COLUMN IF EXISTS payload_json, DROP COLUMN IF EXISTS payload_digest, DROP COLUMN IF EXISTS event_id"
  );
  await postgresQuery(
    "INSERT INTO stream_evidence_run_registry (connector_instance_id, run_id, stream) VALUES ($1, $2, $3)",
    ["cin_pg_legacy", "run_pg_legacy", "messages"]
  );
  await closePostgresStorage();

  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  await assert.rejects(
    createPostgresStreamEvidenceRunRegistryStore().claimStreamEvidenceForRunId(
      "cin_pg_legacy",
      "run_pg_legacy",
      "messages",
      payload("run_pg_legacy", "messages")
    ),
    LEGACY_CLAIM_PATTERN
  );
});
