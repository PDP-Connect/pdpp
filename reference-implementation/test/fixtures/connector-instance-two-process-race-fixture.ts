/**
 * Genuine second-OS-process participant for the connector-instance
 * delete/upsert TOCTOU discriminator
 * (test/connector-instance-delete-upsert-two-process-race.test.js).
 *
 * withConnectorInstanceWrite's Postgres path serializes via a REAL
 * pg_try_advisory_lock keyed on connector_instance_id -- a cross-connection,
 * cross-process exclusion mechanism enforced by the Postgres server itself,
 * not anything in-process. Proving that requires two genuinely separate OS
 * processes each holding their OWN Postgres connection/session, racing the
 * SAME identity's lock. One Node process issuing two concurrent `async`
 * calls proves nothing about cross-process exclusion (the coordinator's
 * process-local `keyedGates` mutex would trivially serialize them even with
 * the advisory-lock code deleted).
 *
 * Protocol (stdio-based, matching
 * test/fixtures/summary-evidence-two-process-repair-fixture.mjs):
 *   1. Connects to Postgres via PDPP_TEST_POSTGRES_URL.
 *   2. Prints `{"ready":true,"pid":...}` to stdout.
 *   3. Blocks on stdin for the parent's "go" line, which carries the JSON
 *      op to perform: {"op":"delete"|"upsert", "connectorInstanceId",
 *      "ownerSubjectId", "connectorId", "sourceBindingKey", "sourceBinding"}.
 *   4. On "go", performs the requested store operation. For "upsert", this
 *      process's env carries PDPP_TEST_UPSERT_TOMBSTONE_CHECK_DELAY_MS,
 *      which widens the store's tombstone-check-to-INSERT window (see
 *      testOnlyUpsertTombstoneCheckDelay in
 *      server/stores/connector-instance-store.ts) so the race is
 *      deterministically reproducible rather than a timing-luck flake: the
 *      parent's concurrent delete gets a real chance to commit WHILE this
 *      process is inside that window, which is exactly the race the
 *      coordination lock must close.
 *   5. Prints one final JSON line with the outcome (`ok`, timestamps, and
 *      for upsert the resulting row's status/revokedAt), or `{"error":...}`
 *      on a thrown error, then exits 0/1.
 */
import { createInterface } from "node:readline";

import { closePostgresStorage, initPostgresStorage } from "../../server/postgres-storage.ts";
import { createPostgresConnectorInstanceStore } from "../../server/stores/connector-instance-store.ts";

interface GoPayload {
  connectorId: string;
  connectorInstanceId: string;
  now: string;
  op: "delete" | "upsert";
  ownerSubjectId: string;
  sourceBinding: Record<string, unknown>;
  sourceBindingKey: string;
}

const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
if (!databaseUrl) {
  throw new Error("connector-instance two-process race fixture requires PDPP_TEST_POSTGRES_URL");
}

function waitForGoLine(): Promise<GoPayload> {
  const rl = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: process.stdin });
  return new Promise((resolve) => {
    rl.once("line", (line) => {
      rl.close();
      resolve(JSON.parse(line) as GoPayload);
    });
  });
}

await initPostgresStorage({ backend: "postgres", databaseUrl });
process.stdout.write(`${JSON.stringify({ pid: process.pid, ready: true })}\n`);

try {
  const goPayload: GoPayload = await waitForGoLine();
  const store = createPostgresConnectorInstanceStore();

  const startedAt = Date.now();
  let outcome: unknown;
  if (goPayload.op === "delete") {
    const summary = await store.deleteConnection(goPayload.connectorInstanceId, {
      now: goPayload.now,
      ownerSubjectId: goPayload.ownerSubjectId,
      purge: {
        deleteRecordRowsPostgres: () => Promise.resolve(0),
        deleteRecordRowsSqlite: () => 0,
        enumerateStreams: () =>
          Promise.resolve({
            connectorId: goPayload.connectorId,
            connectorInstanceId: goPayload.connectorInstanceId,
            streams: [],
          }),
        teardownProjection: () => Promise.resolve(),
      },
    });
    outcome = { ok: true, op: "delete", summary };
  } else if (goPayload.op === "upsert") {
    const row = await store.upsert({
      connectorId: goPayload.connectorId,
      createdAt: goPayload.now,
      displayName: "Codex",
      ownerSubjectId: goPayload.ownerSubjectId,
      sourceBinding: goPayload.sourceBinding,
      sourceBindingKey: goPayload.sourceBindingKey,
      sourceKind: "local_device",
      status: "active",
      updatedAt: goPayload.now,
    });
    outcome = { ok: true, op: "upsert", row };
  } else {
    throw new Error(`unknown op ${goPayload.op}`);
  }
  const finishedAt = Date.now();
  process.stdout.write(`${JSON.stringify({ finishedAt, outcome, pid: process.pid, startedAt })}\n`);
  await closePostgresStorage();
  process.exit(0);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      code: error && typeof error === "object" && "code" in error ? error.code : undefined,
      error: error instanceof Error ? error.message : String(error),
      pid: process.pid,
    })}\n`
  );
  try {
    await closePostgresStorage();
  } catch {
    // Best-effort cleanup after a failed fixture run.
  }
  process.exit(1);
}
