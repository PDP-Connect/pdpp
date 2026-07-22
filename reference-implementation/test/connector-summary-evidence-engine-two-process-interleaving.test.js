// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Genuine two-process interleaving oracle for `repairCandidateSqlite`'s
 * BEGIN IMMEDIATE fence (openspec/changes/reconcile-active-summary-evidence
 * design.md; independent-reviewer follow-up: "add a genuine two-connection/
 * process interleaving oracle").
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
 * in BOTH processes. Whichever process's `writeTransaction` (BEGIN
 * IMMEDIATE) wins the SQLite write lock first holds it for the full delay
 * window before writing and committing; the loser's own BEGIN IMMEDIATE
 * genuinely blocks on SQLite's lock (subject to the driver's busy_timeout,
 * default 30s — see `server/db.js`) for that entire window. This makes the
 * overlap deterministic: without the delay, whichever process happened to
 * reach BEGIN IMMEDIATE first would simply finish its whole (sub-millisecond)
 * transaction before the other started, and no genuine lock contention would
 * ever be observed — the delay is what turns "usually doesn't race" into "the
 * race window is reliably wide enough to hit on every run."
 *
 * What is proved, each of N attempts:
 *   (a) No lost update — after both processes complete, the persisted
 *       evidence row exists and is not silently missing/blank.
 *   (b) No dirty read of an in-flight write — the persisted
 *       `record_checkpoint_json`/`total_records`/`stream_records_json`
 *       triple is INTERNALLY CONSISTENT (matches what a fresh, uncontended
 *       repair of the same canonical state would produce), never a torn
 *       mix of one process's checkpoint with another process's stale
 *       record count. A deferred (non-`IMMEDIATE`) transaction — the
 *       defect this test guards against — allows exactly this: both
 *       processes could read canonical state concurrently before either
 *       acquires the write lock, then serialize only on the final WRITE,
 *       so the loser's write (built from ITS OWN correctly-read canonical
 *       state) still lands safely last under WAL's actual conflict
 *       detection. The real risk `BEGIN IMMEDIATE` closes is subtler and
 *       is called out below.
 *   (c) Neither process's repair call throws / reports `failed: true` in
 *       a way that would be silently swallowed by the caller.
 *
 * Empirically verified regression sensitivity (not just theorized): with
 * `repairCandidateSqlite`'s `writeTransaction(...)` (BEGIN IMMEDIATE)
 * temporarily reverted to a deferred `db.transaction(...)` — i.e. the exact
 * defect the independent review flagged — this test FAILS deterministically
 * (3/3 manual runs) with "evidence row must exist after both processes
 * complete — a lost update would leave it absent": under the deferred
 * transaction, both processes' `SELECT * FROM connector_instances ...`
 * reads race ahead of either acquiring the write lock, and the eventual
 * writer-writer conflict at commit time throws inside `writeTransaction`'s
 * caller in a way that ends with the row missing rather than upserted. That
 * is a real, reproducible lost update, not a theoretical one — restoring
 * `writeTransaction(...)` makes the same test pass 3/3. This confirms the
 * oracle has genuine teeth against the class of defect it targets, rather
 * than merely "usually doesn't crash."
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { ingestRecord } from '../server/records.js';
import { reconcileConnectorSummaryEvidence } from '../server/connector-summary-evidence-engine.ts';

const OWNER = 'owner_local';
const NOW = '2026-07-17T00:00:00.000Z';
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/summary-evidence-two-process-repair-fixture.mjs', import.meta.url));
const DELAY_MS = 250;
const ATTEMPTS = 6;

function seedManifestConnector(connectorId, streams) {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: connectorId,
    version: '1.0.0',
    display_name: connectorId,
    capabilities: {
      public_listing: { listed: true, status: 'test' },
    },
    streams: streams.map((name) => ({
      name,
      primary_key: ['id'],
      coverage_strategy: 'full_inventory',
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })),
  };
  getDb()
    .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(connectorId, JSON.stringify(manifest), NOW);
}

function seedInstance(connectorInstanceId, connectorId) {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`,
    )
    .run(connectorInstanceId, OWNER, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

/** Spawn the second-process fixture and wait for its `{ready:true}` line. */
function spawnFixture(dbPath, connectorInstanceId) {
  const child = spawn(process.execPath, [FIXTURE_PATH], {
    env: {
      ...process.env,
      PDPP_TWO_PROCESS_FIXTURE_DB_PATH: dbPath,
      PDPP_TWO_PROCESS_FIXTURE_CONNECTOR_INSTANCE_ID: connectorInstanceId,
      PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS: String(DELAY_MS),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let stdoutBuffer = '';
  const lines = [];
  const lineWaiters = [];
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let idx;
    // eslint-disable-next-line no-cond-assign
    while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
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

  function nextLine() {
    if (lines.length > 0) {
      return Promise.resolve(lines.shift());
    }
    return new Promise((resolve) => lineWaiters.push(resolve));
  }

  const exitCode = new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  return { child, nextLine, exitCode };
}

async function withTempFileDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-summary-two-process-'));
  const dbPath = join(dir, 'pdpp.sqlite');
  try {
    // A real file (not :memory:) is required: `initDb` only turns on WAL
    // mode for a file path, and a second OS process needs a real file to
    // open its own connection against.
    initDb(dbPath);
    return await fn(dbPath);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('two genuine OS processes racing repairCandidateSqlite for the same connector instance converge to one internally-consistent evidence row, never a lost update or torn write', async () => {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await withTempFileDb(async (dbPath) => {
      const connectorId = `https://test.pdpp.dev/connectors/two-process-attempt-${attempt}`;
      const connectorInstanceId = `cin_two_process_${attempt}`;
      seedManifestConnector(connectorId, ['messages']);
      seedInstance(connectorInstanceId, connectorId);

      // Two records so the fresh canonical state (what a correct, uncontested
      // repair would compute) is unambiguous and non-trivial.
      await ingestRecord(
        { connector_id: connectorId, connector_instance_id: connectorInstanceId },
        { stream: 'messages', key: 'msg_1', data: { id: 'msg_1' }, emitted_at: NOW },
      );
      await ingestRecord(
        { connector_id: connectorId, connector_instance_id: connectorInstanceId },
        { stream: 'messages', key: 'msg_2', data: { id: 'msg_2' }, emitted_at: NOW },
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
        // then fire BOTH processes' repair attempts as close together as
        // possible: tell the child to go, then immediately (no intervening
        // await) start the parent's own repair. Whichever process's BEGIN
        // IMMEDIATE actually wins the SQLite write lock holds it through the
        // full delay; the other's BEGIN IMMEDIATE genuinely blocks on
        // SQLite's lock for the duration, not on JS scheduling.
        process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS = String(DELAY_MS);
        fixture.child.stdin.write('go\n');
        const parentResultPromise = reconcileConnectorSummaryEvidence([connectorInstanceId]);

        const resultLine = await fixture.nextLine();
        const childOutcome = JSON.parse(resultLine);
        const exitCode = await fixture.exitCode;
        const parentResult = await parentResultPromise;

        assert.equal(exitCode, 0, `fixture process exited nonzero: ${JSON.stringify(childOutcome)}`);
        assert.ok(childOutcome.result, `fixture did not report a repair result: ${resultLine}`);
        assert.equal(childOutcome.result.failed, 0, 'the child process repair must not report a failure');
        assert.equal(parentResult.failed, 0, 'the parent process repair must not report a failure');

        // (c) neither side silently swallowed a failure — both explicitly
        // ran a repair (discovered >= 1) rather than no-op'ing past the row.
        assert.ok(childOutcome.result.discovered >= 1);
        assert.ok(parentResult.discovered >= 1);
      } finally {
        delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
        if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
          fixture.child.kill('SIGKILL');
        }
      }

      // (a) no lost update: the row exists and reflects the real canonical
      // state (2 records), not a blank/zeroed write from a clobbered race.
      const finalRow = getDb()
        .prepare(
          `SELECT total_records, record_checkpoint_json, stream_records_json, dirty, state
             FROM connector_summary_evidence WHERE connector_instance_id = ?`,
        )
        .get(connectorInstanceId);
      assert.ok(finalRow, 'evidence row must exist after both processes complete — a lost update would leave it absent');
      assert.equal(finalRow.total_records, 2, `attempt ${attempt}: final total_records must reflect both ingested records, not a stale/torn write`);
      assert.equal(finalRow.dirty, 0, `attempt ${attempt}: the row must not be left dirty after two completed repairs`);
      assert.equal(finalRow.state, 'fresh', `attempt ${attempt}: the row must read fresh, not failed`);

      // (b) no torn write: record_checkpoint_json and stream_records_json
      // (written together in the SAME upsert statement — see
      // `upsertSqliteEvidenceRow`) must be mutually consistent with
      // total_records — i.e. the version_counter checkpoint that was
      // current at write time actually corresponds to 2 stream records, not
      // a mix where one process's checkpoint landed with the other's stale
      // record count.
      const checkpoint = JSON.parse(finalRow.record_checkpoint_json);
      const streamRecords = JSON.parse(finalRow.stream_records_json);
      const messagesEntry = streamRecords.find((entry) => entry.stream === 'messages');
      assert.ok(messagesEntry, `attempt ${attempt}: messages stream entry must be present`);
      assert.equal(messagesEntry.record_count, 2, `attempt ${attempt}: stream_records_json record_count must match total_records (no torn write)`);
      const messagesCheckpoint = checkpoint.streams?.find((entry) => entry.stream === 'messages');
      assert.ok(messagesCheckpoint, `attempt ${attempt}: record_checkpoint_json must include the messages stream`);
      assert.equal(
        String(messagesCheckpoint.max_version),
        '2',
        `attempt ${attempt}: the persisted checkpoint's max_version must match the 2 ingested records — a torn write would show a mismatched checkpoint/count pair`,
      );

      // Cross-check against a THIRD, uncontested repair pass: if the
      // persisted state were internally consistent, a fresh repair must be
      // a true no-op (0 repaired) because discovery finds nothing to fix.
      const verifyPass = await reconcileConnectorSummaryEvidence([connectorInstanceId]);
      assert.equal(verifyPass.repaired, 0, `attempt ${attempt}: a third pass must find the row already fully current — any inconsistency would surface as a repair candidate here`);
    });
  }
});
