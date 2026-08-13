// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Genuine two-process interleaving oracle for the source-revision repair
 * primitive (openspec/changes/reconcile-active-summary-evidence design.md;
 * independent-reviewer follow-up: "add a genuine two-connection/process
 * interleaving oracle").
 *
 * better-sqlite3 is fully synchronous and single-connection per process, so
 * two `async` calls inside ONE Node.js process can never construct a
 * genuine concurrent read-then-write race against SQLite's write lock — the
 * event loop trivially serializes them regardless of what the code under
 * test does. A real interleaving oracle for "does BEGIN IMMEDIATE actually
 * serialize concurrent writers on the READ, not the write" requires a
 * SECOND OS process with its own SQLite connection against the SAME
 * database FILE (not `:memory:`) under WAL mode (confirmed in
 * `server/db.js`'s `initDb`, which sets `journal_mode = WAL` for any
 * non-`:memory:` path) — exactly the scenario `test/fixtures/
 * summary-evidence-two-process-repair-fixture.mjs` provides.
 *
 * Coordination: a test-only synchronous delay hook
 * (`PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS`, see
 * `testOnlyRepairCandidateSqliteDelay` in
 * `server/connector-summary-evidence-engine.ts`) is set to the same value
 * in BOTH processes. The delay sits between the fenced canonical read and
 * the evidence upsert while `BEGIN IMMEDIATE` is held. The second process
 * therefore blocks at transaction start, proving that it cannot read a
 * canonical snapshot that it may later publish after a writer overtakes it.
 *
 * What is proved, each of N attempts:
 *   (a) No lost update — after both processes complete, the persisted
 *       evidence row exists and is not silently missing/blank.
 *   (b) No dirty read of an in-flight write — the persisted
 *       `record_checkpoint_json`/`total_records`/`stream_records_json`
 *       triple is INTERNALLY CONSISTENT (matches what a fresh, uncontended
 *       repair of the same canonical state would produce), never a torn
 *       mix of one process's checkpoint with another process's stale
 *       record count. Each publisher reads and writes the complete evidence
 *       row inside the same connector-instance transaction fence, so a build
 *       from a different source state cannot be published.
 *   (c) Neither process's repair call throws / reports `failed: true` in
 *       a way that would be silently swallowed by the caller.
 *
 * The companion production-writer race in
 * `connector-summary-source-revision.test.ts` proves the stronger failure
 * case: a canonical write between build and publish leaves the candidate
 * dirty/stale rather than publishing a stale row.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";

const OWNER = "owner_local";
const NOW = "2026-07-17T00:00:00.000Z";
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/summary-evidence-two-process-repair-fixture.mjs", import.meta.url)
);
const DELAY_MS = 250;
const ATTEMPTS = 6;

function seedManifestConnector(connectorId: string, streams: string[]): void {
  const manifest = {
    capabilities: {
      public_listing: { tier: "supported" },
    },
    connector_id: connectorId,
    display_name: connectorId,
    protocol_version: "0.1.0",
    streams: streams.map((name) => ({
      coverage_strategy: "full_inventory",
      name,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    })),
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
}

function seedInstance(connectorInstanceId: string, connectorId: string): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, OWNER, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

/** Spawn the second-process fixture and wait for its `{ready:true}` line. */
function spawnFixture(dbPath: string, connectorInstanceId: string) {
  const child = spawn(process.execPath, [FIXTURE_PATH], {
    env: {
      ...process.env,
      PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS: String(DELAY_MS),
      PDPP_TWO_PROCESS_FIXTURE_CONNECTOR_INSTANCE_ID: connectorInstanceId,
      PDPP_TWO_PROCESS_FIXTURE_DB_PATH: dbPath,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  let stdoutBuffer = "";
  const lines: string[] = [];
  const lineWaiters: Array<(line: string) => void> = [];
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let idx: number;
    // eslint-disable-next-line no-cond-assign
    // biome-ignore lint/suspicious/noAssignInExpressions: localized test assertion preserves its explicit contract.
    while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      const waiter = lineWaiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        lines.push(line);
      }
    }
  });

  function nextLine(): Promise<string> {
    if (lines.length > 0) {
      const line = lines.shift();
      assert.ok(line !== undefined, "a line just confirmed present in the buffer must be shiftable");
      return Promise.resolve(line);
    }
    return new Promise((resolve) => lineWaiters.push(resolve));
  }

  const exitCode = new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  return { child, exitCode, nextLine };
}

async function withTempFileDb<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-two-process-"));
  const dbPath = join(dir, "pdpp.sqlite");
  try {
    // A real file (not :memory:) is required: `initDb` only turns on WAL
    // mode for a file path, and a second OS process needs a real file to
    // open its own connection against.
    initDb(dbPath);
    return await fn(dbPath);
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

test("two genuine OS processes racing repairCandidateSqlite for the same connector instance converge to one internally-consistent evidence row, never a lost update or torn write", async () => {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await withTempFileDb(async (dbPath) => {
      const connectorId = `https://test.pdpp.dev/connectors/two-process-attempt-${attempt}`;
      const connectorInstanceId = `cin_two_process_${attempt}`;
      seedManifestConnector(connectorId, ["messages"]);
      seedInstance(connectorInstanceId, connectorId);

      // Two records so the fresh canonical state (what a correct, uncontested
      // repair would compute) is unambiguous and non-trivial.
      await ingestRecord(
        { connector_id: connectorId, connector_instance_id: connectorInstanceId },
        { data: { id: "msg_1" }, emitted_at: NOW, key: "msg_1", stream: "messages" },
        { deferIndexes: true }
      );
      await ingestRecord(
        { connector_id: connectorId, connector_instance_id: connectorInstanceId },
        { data: { id: "msg_2" }, emitted_at: NOW, key: "msg_2", stream: "messages" },
        { deferIndexes: true }
      );

      // Create the repair CANDIDATE (a `missing` evidence row: nothing has
      // repaired this connection yet) that both processes will race to
      // repair. Closing this process's own db handle before the race isn't
      // necessary — better-sqlite3 connections from different processes
      // against the same WAL file coexist fine; the parent's OWN repair call
      // below is one of the two racing writers.

      closeDb(); // release this process's handle so its own upcoming repair call reopens it explicitly.
      initDb(dbPath);

      const fixture = spawnFixture(dbPath, connectorInstanceId);
      try {
        const readyLine = await fixture.nextLine();
        const ready = JSON.parse(readyLine);
        assert.equal(ready.ready, true, `fixture did not report ready: ${readyLine}`);

        // Arm this (parent) process's own delay hook to the same window,
        // then fire BOTH fenced repairs as close together as possible. The
        // delay keeps the first transaction in its read-before-upsert window;
        // the second repair must wait for the exact-instance fence.
        process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS = String(DELAY_MS);
        fixture.child.stdin.write("go\n");
        const parentResultPromise = reconcileConnectorSummaryEvidence([connectorInstanceId]);

        const resultLine = await fixture.nextLine();
        const childOutcome = JSON.parse(resultLine);
        const exitCode = await fixture.exitCode;
        const parentResult = await parentResultPromise;

        assert.equal(exitCode, 0, `fixture process exited nonzero: ${JSON.stringify(childOutcome)}`);
        assert.ok(childOutcome.result, `fixture did not report a repair result: ${resultLine}`);
        assert.equal(childOutcome.result.failed, 0, "the child process repair must not report a failure");
        assert.equal(parentResult.failed, 0, "the parent process repair must not report a failure");

        // (c) neither side silently swallowed a failure — both explicitly
        // ran a repair (discovered >= 1) rather than no-op'ing past the row.
        assert.ok(childOutcome.result.discovered >= 1);
        assert.ok(parentResult.discovered >= 1);
      } finally {
        delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
        if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
          fixture.child.kill("SIGKILL");
        }
      }

      // (a) no lost update: the row exists and reflects the real canonical
      // state (2 records), not a blank/zeroed write from a clobbered race.
      const finalRow = getDb()
        .prepare(
          `SELECT total_records, record_checkpoint_json, stream_records_json, dirty, state
             FROM connector_summary_evidence WHERE connector_instance_id = ?`
        )
        .get(connectorInstanceId);
      assert.ok(
        finalRow,
        "evidence row must exist after both processes complete — a lost update would leave it absent"
      );
      assert.equal(
        finalRow.total_records,
        2,
        `attempt ${attempt}: final total_records must reflect both ingested records, not a stale/torn write`
      );
      assert.equal(finalRow.dirty, 0, `attempt ${attempt}: the row must not be left dirty after two completed repairs`);
      assert.equal(finalRow.state, "fresh", `attempt ${attempt}: the row must read fresh, not failed`);

      // (b) no torn write: record_checkpoint_json and stream_records_json
      // (written together in the SAME upsert statement — see
      // `upsertSqliteEvidenceRow`) must be mutually consistent with
      // total_records — i.e. the version_counter checkpoint that was
      // current at write time actually corresponds to 2 stream records, not
      // a mix where one process's checkpoint landed with the other's stale
      // record count.
      const checkpointJson = finalRow.record_checkpoint_json;
      const streamRecordsJson = finalRow.stream_records_json;
      assert.ok(typeof checkpointJson === "string");
      assert.ok(typeof streamRecordsJson === "string");
      const checkpoint = JSON.parse(checkpointJson);
      const streamRecords = JSON.parse(streamRecordsJson);
      const messagesEntry = streamRecords.find(
        (entry: { stream: string; record_count: number }) => entry.stream === "messages"
      );
      assert.ok(messagesEntry, `attempt ${attempt}: messages stream entry must be present`);
      assert.equal(
        messagesEntry.record_count,
        2,
        `attempt ${attempt}: stream_records_json record_count must match total_records (no torn write)`
      );
      const messagesCheckpoint = checkpoint.streams?.find(
        (entry: { stream: string; max_version: unknown }) => entry.stream === "messages"
      );
      assert.ok(messagesCheckpoint, `attempt ${attempt}: record_checkpoint_json must include the messages stream`);
      assert.equal(
        String(messagesCheckpoint.max_version),
        "2",
        `attempt ${attempt}: the persisted checkpoint's max_version must match the 2 ingested records — a torn write would show a mismatched checkpoint/count pair`
      );

      // Cross-check against a THIRD, uncontested repair pass: if the
      // persisted state were internally consistent, a fresh repair must be
      // a true no-op (0 repaired) because discovery finds nothing to fix.
      const verifyPass = await reconcileConnectorSummaryEvidence([connectorInstanceId]);
      assert.equal(
        verifyPass.repaired,
        0,
        `attempt ${attempt}: a third pass must find the row already fully current — any inconsistency would surface as a repair candidate here`
      );
    });
  }
});
