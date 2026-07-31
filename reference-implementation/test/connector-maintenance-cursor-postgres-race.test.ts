// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Real-PostgreSQL fence for a stale bounded-maintenance owner. */
import assert from "node:assert/strict";
import test from "node:test";

import { createResumableConnectorMaintenanceSweep } from "../server/connector-maintenance-sweep.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createConnectorMaintenanceCursorStore } from "../server/stores/connector-maintenance-cursor-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const T0 = "2026-07-30T00:00:00.000Z";
const T1 = "2026-07-30T00:00:01.000Z";
const T2 = "2026-07-30T00:00:02.000Z";
const CURSOR_NAME = "connector_summary_evidence";
const INVALID_RESUMABLE_RESULT = /invalid resumable result/;

function runner(
  nowIso: string,
  runEvidenceSweep: (afterId: string | null | undefined) => Promise<unknown>,
  evidenceSweepLeaseDurationMs = 30_000
) {
  return createResumableConnectorMaintenanceSweep(
    {
      evidenceSweepLeaseDurationMs,
      evidenceSweepMaxDurationMs: 1,
      nowIso: () => nowIso,
      runEvidenceSweep: ({ afterId }) => runEvidenceSweep(afterId),
    },
    createConnectorMaintenanceCursorStore()
  );
}

async function expireCurrentLease(): Promise<void> {
  await postgresQuery(
    `UPDATE connector_maintenance_cursor
       SET lease_expires_at = (clock_timestamp() - INTERVAL '1 millisecond')::text
     WHERE name = $1`,
    [CURSOR_NAME]
  );
}

test("real PostgreSQL lease ownership ignores replica clock skew and recovers a database-expired owner", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL ?? "" });
  try {
    await postgresQuery("DELETE FROM connector_maintenance_cursor WHERE name = $1", [CURSOR_NAME]);
    const replicaA = createConnectorMaintenanceCursorStore();
    const replicaB = createConnectorMaintenanceCursorStore();
    const owner = await replicaA.acquire({ leaseDurationMs: 25, nowIso: T0 });
    assert.ok(owner);

    const aheadReplica = await replicaB.acquire({ leaseDurationMs: 25, nowIso: "2099-01-01T00:00:00.000Z" });
    assert.equal(aheadReplica, null, "a fast replica clock must not steal a database-live lease");

    await postgresQuery("SELECT pg_sleep($1::double precision)", [0.05]);
    const recovered = await replicaB.acquire({ leaseDurationMs: 25, nowIso: "1900-01-01T00:00:00.000Z" });
    assert.ok(recovered, "a slow replica clock must recover after the database lease expires");
    assert.equal(recovered.generation, owner.generation + 1);
    await replicaB.release(recovered);
  } finally {
    await closePostgresStorage();
  }
});

test("real PostgreSQL retries a heavy first-page fold across restart and completes it", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL ?? "" });
  try {
    await postgresQuery("DELETE FROM connector_maintenance_cursor WHERE name = $1", [CURSOR_NAME]);
    const received: Array<string | null | undefined> = [];
    const firstProcess = runner(T0, (afterId) => {
      received.push(afterId);
      return Promise.resolve({ incomplete: true, resumeAfterId: null });
    });
    assert.deepEqual(await firstProcess.runEvidenceSweepRound({ maxDurationMs: 1 }), {
      incomplete: true,
      resumeAfterId: null,
    });

    await closePostgresStorage();
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL ?? "" });
    let remainingFoldBatches = 2;
    const restartedProcess = runner(T1, (afterId) => {
      received.push(afterId);
      remainingFoldBatches -= 1;
      return Promise.resolve(
        remainingFoldBatches === 0
          ? { incomplete: false, resumeAfterId: null }
          : { incomplete: true, resumeAfterId: null }
      );
    });
    await restartedProcess.runEvidenceSweepRound({ maxDurationMs: 1 });
    await restartedProcess.runEvidenceSweepRound({ maxDurationMs: 1 });

    assert.deepEqual(received, [null, null, null]);
    assert.equal(remainingFoldBatches, 0, "repeated PostgreSQL rounds complete the first-page fold");
  } finally {
    await closePostgresStorage();
  }
});

test("real PostgreSQL rejects a null cursor that would lose non-null progress", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL ?? "" });
  try {
    await postgresQuery("DELETE FROM connector_maintenance_cursor WHERE name = $1", [CURSOR_NAME]);
    const seeded = runner(T0, () => Promise.resolve({ incomplete: true, resumeAfterId: "cin_keep" }));
    await seeded.runEvidenceSweepRound({ maxDurationMs: 1 });

    const invalid = runner(T1, () => Promise.resolve({ incomplete: true, resumeAfterId: null }));
    await assert.rejects(invalid.runEvidenceSweepRound({ maxDurationMs: 1 }), INVALID_RESUMABLE_RESULT);

    const resumed = runner(T2, (afterId) => {
      assert.equal(afterId, "cin_keep");
      return Promise.resolve({ incomplete: false, resumeAfterId: null });
    });
    await resumed.runEvidenceSweepRound({ maxDurationMs: 1 });
  } finally {
    await closePostgresStorage();
  }
});

test("real PostgreSQL dual runners fence a stale incomplete cursor after a later complete owner clears it (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL ?? "" });
  try {
    await postgresQuery("DELETE FROM connector_maintenance_cursor WHERE name = $1", [CURSOR_NAME]);
    const seed = runner(T0, () => Promise.resolve({ incomplete: true, resumeAfterId: "cin_a" }));
    await seed.runEvidenceSweepRound({ maxDurationMs: 1 });

    let releaseStale: (() => void) | null = null;
    let staleStarted: (() => void) | null = null;
    const staleReady = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });
    const stale = runner(T0, async (afterId) => {
      assert.equal(afterId, "cin_a");
      staleStarted?.();
      await new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      return { incomplete: true, resumeAfterId: "cin_b" };
    });
    const staleRound = stale.runEvidenceSweepRound({ maxDurationMs: 1 });
    await staleReady;
    await expireCurrentLease();

    const current = runner(T1, (afterId) => {
      assert.equal(afterId, "cin_a");
      return Promise.resolve({ incomplete: false, resumeAfterId: null });
    });
    const currentResult = await current.runEvidenceSweepRound({ maxDurationMs: 1 });
    assert.deepEqual(currentResult, { incomplete: false, resumeAfterId: null });

    const release = releaseStale as (() => void) | null;
    assert.ok(release, "the stale owner must be paused after acquiring its lease");
    release();
    assert.equal(
      await staleRound,
      null,
      "a stale incomplete owner loses its fencing token and cannot replace the completed NULL cursor"
    );

    const verifier = createConnectorMaintenanceCursorStore();
    const completed = await verifier.acquire({ leaseDurationMs: 1, nowIso: T2 });
    assert.ok(completed);
    assert.equal(completed.resumeAfterId, null);
    await verifier.release(completed);
  } finally {
    await closePostgresStorage();
  }
});
