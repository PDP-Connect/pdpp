// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { handleLocalDeviceTerminalRunCommit } from "../operations/local-device-terminal-collection.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  __setTerminalRunCommitFaultHookForTest,
  commitTerminalRun,
  type ResolvedTerminalRunCommit,
  TerminalRunCommitConflictError,
} from "../server/stores/terminal-run-commit-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset";
const CONNECTOR_ID = "terminal_commit_pg";
const CONNECTOR_INSTANCE_ID = "cin_terminal_commit_pg";
const OTHER_CONNECTOR_INSTANCE_ID = "cin_terminal_commit_pg_other";

function storageConfig(): { backend: "postgres"; databaseUrl: string } {
  assert.ok(POSTGRES_URL, "Postgres test requires PDPP_TEST_POSTGRES_URL");
  return { backend: "postgres", databaseUrl: POSTGRES_URL };
}

function terminalInput(overrides: Partial<ResolvedTerminalRunCommit> = {}): ResolvedTerminalRunCommit {
  return {
    collectionBoundary: "unscoped",
    commitId: "commit-terminal-pg-1",
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    deviceId: "dev-terminal-pg",
    envelopeHash: "a".repeat(64),
    normalizedFacts: [{ checkpoint: "committed", collected: 0, coverage_statuses: ["collected"], stream: "sessions" }],
    runId: "run-terminal-pg-1",
    sourceInstanceId: "src-terminal-pg",
    stateDelta: { sessions: { cursor: "c1" }, threads: { cursor: "t1" } },
    ...overrides,
  };
}

async function cleanup(): Promise<void> {
  await postgresQuery("DELETE FROM run_history WHERE connector_instance_id = ANY($1::text[])", [
    [CONNECTOR_INSTANCE_ID, OTHER_CONNECTOR_INSTANCE_ID],
  ]);
  await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = ANY($1::text[])", [
    [CONNECTOR_INSTANCE_ID, OTHER_CONNECTOR_INSTANCE_ID],
  ]);
  await postgresQuery("DELETE FROM connector_state WHERE connector_instance_id = ANY($1::text[])", [
    [CONNECTOR_INSTANCE_ID, OTHER_CONNECTOR_INSTANCE_ID],
  ]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = ANY($1::text[])", [
    [CONNECTOR_INSTANCE_ID, OTHER_CONNECTOR_INSTANCE_ID],
  ]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

async function seedConnection(): Promise<void> {
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ($1, '{}'::jsonb, $2)", [
    CONNECTOR_ID,
    "2026-08-12T12:00:00.000Z",
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at
     ) VALUES ($1, 'owner_local', $2, 'Terminal PG', 'active',
       'local_device', 'device:terminal-pg', '{}'::jsonb, $3, $3)`,
    [CONNECTOR_INSTANCE_ID, CONNECTOR_ID, "2026-08-12T12:00:00.000Z"]
  );
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at
     ) VALUES ($1, 'owner_local', $2, 'Terminal PG Other', 'active',
       'local_device', 'device:terminal-pg-other', '{}'::jsonb, $3, $3)`,
    [OTHER_CONNECTOR_INSTANCE_ID, CONNECTOR_ID, "2026-08-12T12:00:00.000Z"]
  );
}

async function rowCount(table: "connector_state" | "run_history" | "spine_events"): Promise<number> {
  const { rows } = await postgresQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE connector_instance_id = $1`,
    [CONNECTOR_INSTANCE_ID]
  );
  return Number(rows[0]?.n ?? 0);
}

function routeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    collection_boundary: "unscoped",
    commit_id: "commit-terminal-route-pg",
    connector_id: CONNECTOR_ID,
    connector_instance_id: CONNECTOR_INSTANCE_ID,
    device_id: "dev-terminal-pg",
    run_id: "run-terminal-route-pg",
    source_instance_id: "src-terminal-pg",
    state_delta: { sessions: { cursor: "c1" } },
    terminal_facts: [{ coverage_statuses: ["collected"], stream: "sessions" }],
    version: 1,
    ...overrides,
  };
}

async function invokeRoute(body: Record<string, unknown>, authenticatedDeviceId = "dev-terminal-pg") {
  let status = 0;
  let responseBody: unknown;
  let resolved = false;
  const response = {
    json(value: unknown) {
      responseBody = value;
      return value;
    },
    status(code: number) {
      status = code;
      return this;
    },
  };
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey: () => CONNECTOR_ID,
      commitTerminalRun,
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, codeStatus, code, message) => response.status(codeStatus).json({ code, message }),
    },
    req: {
      body,
      deviceExporter: { deviceId: authenticatedDeviceId },
      params: { deviceId: "dev-terminal-pg", sourceInstanceId: "src-terminal-pg" },
    },
    res: response,
    resolveAuthorizedSource: () => {
      resolved = true;
      return Promise.resolve({
        connectorInstance: { connectorInstanceId: CONNECTOR_INSTANCE_ID },
        sourceInstance: { connectorId: CONNECTOR_ID },
      });
    },
  });
  return { body: responseBody, resolved, status };
}

test("real PostgreSQL route operation authorizes before 201, exact replay, and non-disclosing conflict", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(storageConfig());
  try {
    await cleanup();
    await seedConnection();
    const unauthorized = await invokeRoute(routeBody(), "other-device");
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.resolved, false);
    assert.equal(await rowCount("spine_events"), 0);

    const first = await invokeRoute(routeBody());
    const replay = await invokeRoute(routeBody());
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);

    const conflict = await invokeRoute(routeBody({ state_delta: { sessions: { cursor: "different" } } }));
    assert.equal(conflict.status, 409);
    assert.equal(JSON.stringify(conflict.body).includes("envelope_hash"), false);
    assert.equal(await rowCount("spine_events"), 1);
    assert.equal(await rowCount("run_history"), 1);
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL terminal commit is atomic, concurrent, and exactly replayable", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(storageConfig());
  try {
    await cleanup();
    await seedConnection();

    const concurrent = await Promise.all([commitTerminalRun(terminalInput()), commitTerminalRun(terminalInput())]);
    assert.deepEqual(concurrent.map((result) => result.replayed).sort(), [false, true]);
    assert.deepEqual(concurrent[0]?.response, concurrent[1]?.response);
    assert.equal(await rowCount("spine_events"), 1);
    assert.equal(await rowCount("run_history"), 1);
    assert.equal(await rowCount("connector_state"), 2);

    await postgresQuery(
      "UPDATE connector_state SET state_json = $1::jsonb WHERE connector_instance_id = $2 AND stream = 'sessions'",
      [JSON.stringify({ cursor: "later" }), CONNECTOR_INSTANCE_ID]
    );
    const replay = await commitTerminalRun(terminalInput());
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.response, concurrent[0]?.response, "response-loss retry returns the stored response bytes");

    await assert.rejects(
      commitTerminalRun(terminalInput({ envelopeHash: "b".repeat(64), stateDelta: { sessions: { cursor: "evil" } } })),
      TerminalRunCommitConflictError
    );
    const { rows: stateRows } = await postgresQuery<{ state_json: unknown }>(
      "SELECT state_json FROM connector_state WHERE connector_instance_id = $1 AND stream = 'sessions'",
      [CONNECTOR_INSTANCE_ID]
    );
    assert.deepEqual(stateRows[0]?.state_json, { cursor: "later" });

    const concurrentConflict = await Promise.allSettled([
      commitTerminalRun(terminalInput({ commitId: "commit-terminal-pg-race", runId: "run-terminal-pg-race" })),
      commitTerminalRun(
        terminalInput({
          commitId: "commit-terminal-pg-race",
          envelopeHash: "c".repeat(64),
          runId: "run-terminal-pg-race",
          stateDelta: { sessions: { cursor: "divergent" } },
        })
      ),
    ]);
    assert.equal(concurrentConflict.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = concurrentConflict.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof TerminalRunCommitConflictError);
    assert.equal(JSON.stringify(rejected.reason).includes("envelopeHash"), false);
    assert.equal(await rowCount("spine_events"), 2);
    assert.equal(await rowCount("run_history"), 2);

    const otherBinding = await commitTerminalRun(
      terminalInput({
        commitId: "commit-terminal-pg-1",
        connectorInstanceId: OTHER_CONNECTOR_INSTANCE_ID,
        deviceId: "dev-terminal-pg-other",
        envelopeHash: "d".repeat(64),
        sourceInstanceId: "src-terminal-pg-other",
      })
    );
    assert.equal(otherBinding.replayed, false);
    assert.notEqual(otherBinding.response.terminal_event_id, replay.response.terminal_event_id);
  } finally {
    __setTerminalRunCommitFaultHookForTest(null);
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL permits only one terminal commit for an authorized run binding", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(storageConfig());
  try {
    await cleanup();
    await seedConnection();
    await commitTerminalRun(terminalInput());
    await assert.rejects(
      commitTerminalRun(
        terminalInput({
          commitId: "commit-terminal-pg-2",
          envelopeHash: "b".repeat(64),
          stateDelta: { sessions: { cursor: "second" } },
        })
      ),
      TerminalRunCommitConflictError
    );
    assert.equal(await rowCount("spine_events"), 1);
    assert.equal(await rowCount("run_history"), 1);
    assert.equal(await rowCount("connector_state"), 2);

    const concurrent = await Promise.allSettled([
      commitTerminalRun(
        terminalInput({
          commitId: "commit-terminal-pg-race-a",
          envelopeHash: "c".repeat(64),
          runId: "run-terminal-pg-one-race",
          stateDelta: { sessions: { cursor: "race-a" } },
        })
      ),
      commitTerminalRun(
        terminalInput({
          commitId: "commit-terminal-pg-race-b",
          envelopeHash: "d".repeat(64),
          runId: "run-terminal-pg-one-race",
          stateDelta: { sessions: { cursor: "race-b" } },
        })
      ),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof TerminalRunCommitConflictError);
    assert.equal(await rowCount("spine_events"), 2);
    assert.equal(await rowCount("run_history"), 2);
    assert.equal(await rowCount("connector_state"), 2);
    const { rows } = await postgresQuery<{ state_json: unknown }>(
      "SELECT state_json FROM connector_state WHERE connector_instance_id = $1 AND stream = 'sessions'",
      [CONNECTOR_INSTANCE_ID]
    );
    assert.ok(
      JSON.stringify(rows[0]?.state_json) === JSON.stringify({ cursor: "race-a" }) ||
        JSON.stringify(rows[0]?.state_json) === JSON.stringify({ cursor: "race-b" })
    );
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

for (const faultPoint of [
  "after_state_write:sessions",
  "after_state_write:threads",
  "after_event_insert",
  "after_run_history_write",
] as const) {
  test(`real PostgreSQL terminal commit rolls back every surface at ${faultPoint}`, {
    skip: POSTGRES_SKIP,
  }, async () => {
    await initPostgresStorage(storageConfig());
    try {
      await cleanup();
      await seedConnection();
      __setTerminalRunCommitFaultHookForTest((point) => {
        if (point === faultPoint) {
          throw new Error(`fault:${point}`);
        }
      });
      await assert.rejects(commitTerminalRun(terminalInput()), new RegExp(`fault:${faultPoint}`));
      assert.equal(await rowCount("connector_state"), 0);
      assert.equal(await rowCount("spine_events"), 0);
      assert.equal(await rowCount("run_history"), 0);
      __setTerminalRunCommitFaultHookForTest(null);
      assert.equal((await commitTerminalRun(terminalInput())).replayed, false);
    } finally {
      __setTerminalRunCommitFaultHookForTest(null);
      await cleanup();
      await closePostgresStorage();
    }
  });
}
