// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
// biome-ignore lint/correctness/noUnresolvedImports: Node 22 provides node:sqlite; Biome resolves the reference package against older ambient types.
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { appendSqliteSpineEventInTransaction } from "../lib/spine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  __setTerminalRunCommitFaultHookForTest,
  commitTerminalRun,
  type ResolvedTerminalRunCommit,
  TerminalRunCommitConflictError,
} from "../server/stores/terminal-run-commit-store.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const NOW = "2026-08-11T12:00:00.000Z";

function seedConnection(): void {
  getDb().prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)").run("codex", NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at
       ) VALUES ('cin_terminal', 'owner_local', 'codex', 'Codex', 'active',
         'local_device', 'device:source', '{}', ?, ?)`
    )
    .run(NOW, NOW);
}

function seedOtherConnection(): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at
       ) VALUES ('cin_terminal_other', 'owner_local', 'codex', 'Codex Other', 'active',
         'local_device', 'device:source-other', '{}', ?, ?)`
    )
    .run(NOW, NOW);
}

function input(overrides: Partial<ResolvedTerminalRunCommit> = {}): ResolvedTerminalRunCommit {
  return {
    collectionBoundary: "unscoped",
    commitId: "commit-terminal-1",
    connectorId: "codex",
    connectorInstanceId: "cin_terminal",
    deviceId: "dev_terminal",
    envelopeHash: "a".repeat(64),
    normalizedFacts: [{ checkpoint: "committed", collected: 0, coverage_statuses: ["collected"], stream: "sessions" }],
    runId: "run_terminal_1",
    sourceInstanceId: "src_terminal",
    stateDelta: { sessions: { cursor: "c1" }, threads: { cursor: "t1" } },
    ...overrides,
  };
}

function count(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("SQLite terminal commit is atomic and exact replay ignores later state", async () => {
  initDb(makeTemporaryDbPath("pdpp-terminal-commit-sqlite-"));
  try {
    seedConnection();
    const first = await commitTerminalRun(input());
    assert.equal(first.replayed, false);
    assert.equal(count("spine_events"), 1);
    assert.equal(count("run_history"), 1);
    assert.equal(count("connector_state"), 2);

    getDb()
      .prepare("UPDATE connector_state SET state_json = ? WHERE connector_instance_id = ? AND stream = ?")
      .run(JSON.stringify({ cursor: "later" }), "cin_terminal", "sessions");
    const replay = await commitTerminalRun(input());
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.response, first.response);
    assert.equal(count("spine_events"), 1);
    assert.equal(count("run_history"), 1);

    await assert.rejects(
      commitTerminalRun(input({ envelopeHash: "b".repeat(64), stateDelta: { sessions: { cursor: "evil" } } })),
      TerminalRunCommitConflictError
    );
    const state = getDb()
      .prepare("SELECT state_json FROM connector_state WHERE connector_instance_id = ? AND stream = ?")
      .get("cin_terminal", "sessions") as { state_json: string };
    assert.deepEqual(JSON.parse(state.state_json), { cursor: "later" });
  } finally {
    __setTerminalRunCommitFaultHookForTest(null);
    closeDb();
  }
});

test("SQLite scopes equal caller commit ids to the full authorized binding", async () => {
  initDb(makeTemporaryDbPath("pdpp-terminal-commit-binding-sqlite-"));
  try {
    seedConnection();
    seedOtherConnection();
    const first = await commitTerminalRun(input());
    const other = await commitTerminalRun(
      input({
        connectorInstanceId: "cin_terminal_other",
        deviceId: "dev_terminal_other",
        envelopeHash: "b".repeat(64),
        sourceInstanceId: "src_terminal_other",
      })
    );
    assert.equal(first.replayed, false);
    assert.equal(other.replayed, false);
    assert.notEqual(first.response.terminal_event_id, other.response.terminal_event_id);
    assert.equal(count("spine_events"), 2);
    assert.equal(count("run_history"), 2);
  } finally {
    closeDb();
  }
});

test("SQLite permits only one terminal commit for an authorized run binding", async () => {
  initDb(makeTemporaryDbPath("pdpp-terminal-one-commit-sqlite-"));
  try {
    seedConnection();
    const first = await commitTerminalRun(input());
    await assert.rejects(
      commitTerminalRun(
        input({
          commitId: "commit-terminal-2",
          envelopeHash: "b".repeat(64),
          stateDelta: { sessions: { cursor: "second" } },
        })
      ),
      TerminalRunCommitConflictError
    );
    assert.equal(count("spine_events"), 1);
    assert.equal(count("run_history"), 1);
    assert.equal(count("connector_state"), 2);
    assert.deepEqual(
      JSON.parse(
        (
          getDb()
            .prepare("SELECT state_json FROM connector_state WHERE connector_instance_id = ? AND stream = ?")
            .get("cin_terminal", "sessions") as { state_json: string }
        ).state_json
      ),
      { cursor: "c1" }
    );
    assert.equal((await commitTerminalRun(input())).response.terminal_event_id, first.response.terminal_event_id);

    const concurrent = await Promise.allSettled([
      Promise.resolve().then(() =>
        commitTerminalRun(
          input({
            commitId: "commit-terminal-race-a",
            envelopeHash: "c".repeat(64),
            runId: "run_terminal_race",
            stateDelta: { sessions: { cursor: "race-a" } },
          })
        )
      ),
      Promise.resolve().then(() =>
        commitTerminalRun(
          input({
            commitId: "commit-terminal-race-b",
            envelopeHash: "d".repeat(64),
            runId: "run_terminal_race",
            stateDelta: { sessions: { cursor: "race-b" } },
          })
        )
      ),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof TerminalRunCommitConflictError);
    assert.equal(count("spine_events"), 2);
    assert.equal(count("run_history"), 2);
    assert.equal(count("connector_state"), 2);
    const storedCursor = JSON.parse(
      (
        getDb()
          .prepare("SELECT state_json FROM connector_state WHERE connector_instance_id = ? AND stream = ?")
          .get("cin_terminal", "sessions") as { state_json: string }
      ).state_json
    ) as { cursor: string };
    assert.ok(storedCursor.cursor === "race-a" || storedCursor.cursor === "race-b");
  } finally {
    closeDb();
  }
});

test("SQLite empty-state terminal evidence survives backup and exact replay", async () => {
  const originalPath = makeTemporaryDbPath("pdpp-terminal-backup-source-");
  const restoredPath = makeTemporaryDbPath("pdpp-terminal-backup-restored-");
  initDb(originalPath);
  let first: Awaited<ReturnType<typeof commitTerminalRun>> | null = null;
  try {
    seedConnection();
    first = await commitTerminalRun(input({ stateDelta: {} }));
    assert.equal(count("connector_state"), 0);
    assert.equal(count("spine_events"), 1);
    assert.equal(count("run_history"), 1);
  } finally {
    closeDb();
  }
  copyFileSync(originalPath, restoredPath);
  assert.ok(first);
  initDb(restoredPath);
  try {
    const replay = await commitTerminalRun(input({ stateDelta: {} }));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.response, first.response);
    assert.equal(count("spine_events"), 1);
    assert.equal(count("run_history"), 1);
  } finally {
    closeDb();
  }
});

for (const faultPoint of [
  "after_state_write:sessions",
  "after_state_write:threads",
  "after_event_insert",
  "after_run_history_write",
] as const) {
  test(`SQLite terminal commit rolls back every surface at ${faultPoint}`, async () => {
    initDb(makeTemporaryDbPath(`pdpp-terminal-rollback-${faultPoint.replaceAll(":", "-")}-`));
    try {
      seedConnection();
      __setTerminalRunCommitFaultHookForTest((point) => {
        if (point === faultPoint) {
          throw new Error(`fault:${point}`);
        }
      });
      await assert.rejects(commitTerminalRun(input()), new RegExp(`fault:${faultPoint}`));
      assert.equal(count("connector_state"), 0);
      assert.equal(count("spine_events"), 0);
      assert.equal(count("run_history"), 0);
      __setTerminalRunCommitFaultHookForTest(null);
      const retry = await commitTerminalRun(input());
      assert.equal(retry.replayed, false);
    } finally {
      __setTerminalRunCommitFaultHookForTest(null);
      closeDb();
    }
  });
}

test("SQLite transaction-aware spine seam uses only the supplied handle", () => {
  initDb(makeTemporaryDbPath("pdpp-terminal-global-control-"));
  const supplied = new DatabaseSync(":memory:");
  try {
    supplied.exec(`
      CREATE TABLE spine_events (
        event_id TEXT PRIMARY KEY, event_seq INTEGER, event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, scenario_id TEXT NOT NULL,
        trace_id TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
        subject_type TEXT, subject_id TEXT, object_type TEXT NOT NULL, object_id TEXT NOT NULL,
        status TEXT NOT NULL, request_id TEXT, grant_id TEXT, run_id TEXT, source_kind TEXT,
        source_id TEXT, client_id TEXT, stream_id TEXT, token_id TEXT, interaction_id TEXT,
        connector_instance_id TEXT, data_json TEXT NOT NULL, version TEXT NOT NULL
      );
      CREATE TABLE run_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, connector_instance_id TEXT,
        connector_id TEXT NOT NULL, trigger_kind TEXT, source_json TEXT NOT NULL,
        status TEXT NOT NULL, known_gaps_json TEXT NOT NULL, started_at TEXT NOT NULL,
        completed_at TEXT, records_emitted INTEGER NOT NULL DEFAULT 0,
        connector_error_json TEXT, failure_reason TEXT, terminal_reason TEXT,
        facts_json TEXT, attempt INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX run_history_identity ON run_history(run_id, connector_instance_id) WHERE run_id IS NOT NULL;
    `);
    supplied.exec("BEGIN IMMEDIATE");
    try {
      appendSqliteSpineEventInTransaction(
        {
          data: { connector_instance_id: "cin_supplied" },
          event_id: "evt_supplied",
          event_type: "run.completed",
          object_id: "run_supplied",
          object_type: "run",
          run_id: "run_supplied",
          source_id: "codex",
          source_kind: "connector",
          status: "succeeded",
        },
        supplied as unknown as Parameters<typeof appendSqliteSpineEventInTransaction>[1]
      );
      supplied.exec("COMMIT");
    } catch (error) {
      supplied.exec("ROLLBACK");
      throw error;
    }
    assert.equal((supplied.prepare("SELECT COUNT(*) AS n FROM spine_events").get() as { n: number }).n, 1);
    assert.equal((supplied.prepare("SELECT COUNT(*) AS n FROM run_history").get() as { n: number }).n, 1);
    assert.equal(count("spine_events"), 0);
    assert.equal(count("run_history"), 0);
  } finally {
    supplied.close();
    closeDb();
  }
});
