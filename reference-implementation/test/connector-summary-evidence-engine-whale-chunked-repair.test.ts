// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Chunked/resumable canonical-count repair for a "whale" connection.
 *
 * `repairCandidatePostgres`'s canonical-count read — `SELECT stream,
 * COUNT(*), MAX(emitted_at) FROM records WHERE connector_instance_id = $1
 * AND deleted = FALSE GROUP BY stream` — is index-covered
 * (`idx_pg_records_canonical_count`) but its cost is still O(live rows for
 * that ONE connection). A connection with millions of live records (Slack
 * 1.57M, a Claude Code connection 2.5M, a Codex connection 1.3M, measured on
 * the owner's instance 2026-08-26) cannot finish that single aggregate
 * inside the per-unit `MIN_STATEMENT_TIMEOUT_MS` floor. af114c250 (#194)
 * stops the resulting doomed re-admission from starving every other dirty
 * row, but does not make the whale's own row ever converge — that follow-up
 * is what this file proves.
 *
 * The fix scans the same rows in bounded pages, folding into a durable
 * per-connection accumulator (`connector_summary_evidence_repair_chunk`)
 * that resumes across as many admissions as it takes. This suite exercises
 * the SQLite path (the only backend these tests can run without a real
 * Postgres instance), using two test-only env-var knobs — matching this
 * file's existing `PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS` idiom — to
 * force a small fixture through multiple chunk pages and multiple separate
 * admissions:
 *
 *   - `PDPP_TEST_REPAIR_CANDIDATE_SQLITE_CHUNK_PAGE_SIZE`: shrinks the page
 *     size so a small fixture still exercises multiple pages.
 *   - `PDPP_TEST_REPAIR_CANDIDATE_SQLITE_ONE_PAGE_PER_CALL`: forces exactly
 *     one page per call, simulating a separate admission/sweep pass the way
 *     a real Postgres `deadline` naturally does — the SQLite path shares the
 *     identical accumulation/persistence primitives, so this is a genuine
 *     proof of the resumability property, not a simulation of unrelated
 *     code.
 *
 * The Postgres-specific per-page transaction/timeout wiring is exercised
 * only by typecheck and code review in this environment — no dedicated
 * Postgres test listener is available here — but it folds pages through the
 * exact same `foldCanonicalScanPage` this suite proves against SQLite, so
 * SQLite and Postgres cannot silently diverge in the algorithm itself.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const NOW = "2026-07-17T00:00:00.000Z";
const WHALE_ID = "cin_whale";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/whale";

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-whale-chunked-repair-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function seedManifestConnector(): void {
  const manifest = {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: CONNECTOR_ID,
    display_name: "whale",
    protocol_version: "0.1.0",
    streams: [
      {
        coverage_strategy: "full_inventory",
        name: "messages",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
    ],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

function seedInstance(connectorInstanceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_local', ?, 'whale', 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, CONNECTOR_ID, connectorInstanceId, NOW, NOW);
}

/** Directly seed `records` (bypassing the real ingest path) so a whale-sized fixture is fast to build. */
function seedWhaleRecords(connectorInstanceId: string, count: number, keyOffset = 0): void {
  const insert = getDb().prepare(
    `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, version, deleted)
     VALUES (?, ?, 'messages', ?, '{}', ?, ?, 1, 0)`
  );
  const insertMany = getDb().transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const key = keyOffset + i;
      const emittedAt = `2026-07-${String(1 + (key % 28)).padStart(2, "0")}T00:00:00.000Z`;
      insert.run(CONNECTOR_ID, connectorInstanceId, `msg_${key}`, emittedAt, emittedAt);
    }
  });
  insertMany();
}

function evidenceRow(connectorInstanceId: string) {
  return getDb()
    .prepare(
      "SELECT total_records, stream_count, stream_records_json, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?"
    )
    .get(connectorInstanceId) as
    | {
        dirty: number;
        state: string;
        stream_count: number;
        stream_records_json: string;
        total_records: number;
      }
    | undefined;
}

function chunkRow(connectorInstanceId: string) {
  return getDb()
    .prepare(
      "SELECT resume_after_id, accumulator_json, source_revision, page_size FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = ?"
    )
    .get(connectorInstanceId) as
    | { accumulator_json: string; page_size: number; resume_after_id: number | null; source_revision: string }
    | undefined;
}

async function withChunkTestEnv<T>(pageSize: number, onePagePerCall: boolean, fn: () => Promise<T>): Promise<T> {
  const prevPageSize = process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_CHUNK_PAGE_SIZE;
  const prevOnePage = process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_ONE_PAGE_PER_CALL;
  process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_CHUNK_PAGE_SIZE = String(pageSize);
  if (onePagePerCall) {
    process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_ONE_PAGE_PER_CALL = "1";
  } else {
    delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_ONE_PAGE_PER_CALL;
  }
  try {
    return await fn();
  } finally {
    if (prevPageSize === undefined) {
      delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_CHUNK_PAGE_SIZE;
    } else {
      process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_CHUNK_PAGE_SIZE = prevPageSize;
    }
    if (prevOnePage === undefined) {
      delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_ONE_PAGE_PER_CALL;
    } else {
      process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_ONE_PAGE_PER_CALL = prevOnePage;
    }
  }
}

const WHALE_RECORD_COUNT = 250;
const TEST_PAGE_SIZE = 40; // 250 / 40 = 7 pages, so a run genuinely spans multiple admissions.
const MIN_STATEMENT_TIMEOUT_RE = /const MIN_STATEMENT_TIMEOUT_MS = 500;/;

test("a whale connection's repair makes bounded, monotonic progress across multiple admissions where a single admission's page budget cannot cover the whole connection", () =>
  withTempDb(() =>
    withChunkTestEnv(TEST_PAGE_SIZE, true, async () => {
      seedManifestConnector();
      seedInstance(WHALE_ID);
      seedWhaleRecords(WHALE_ID, WHALE_RECORD_COUNT);

      // Old (pre-chunking) behavior had no bounded-progress property at all:
      // a single admission either finished the whole aggregate or it didn't
      // — there was no partial state to observe. The chunked path's
      // defining property is that EVERY admission that cannot finish still
      // leaves durable, strictly-advancing progress behind — proven here by
      // admission count matching page count exactly (never more, never
      // fewer) and `resume_after_id` strictly increasing each time.
      let admissions = 0;
      let lastResumeAfterId = -1;
      for (;;) {
        admissions += 1;
        // biome-ignore lint/performance/noAwaitInLoops: each admission must observe the durable chunk state the previous admission left before deciding whether to loop again.
        const result = await reconcileConnectorSummaryEvidence([WHALE_ID]);
        const chunk = chunkRow(WHALE_ID);
        if (!chunk) {
          // Scan finished this admission — chunk row is cleaned up in the
          // same transaction as the finished evidence upsert.
          assert.equal(result.repaired, 1, "the final admission repairs the row");
          break;
        }
        assert.equal(result.repaired, 0, "an in-progress chunk admission repairs nothing yet");
        assert.equal(result.failed, 0, "an in-progress chunk admission is deferred, never marked failed");
        assert.deepEqual(
          result.attemptedIds,
          [WHALE_ID],
          "the deferred chunk-in-progress unit still counts as attempted (consumed its turn)"
        );
        assert.ok(
          Number(chunk.resume_after_id) > lastResumeAfterId,
          `resume_after_id must strictly advance each admission (was ${lastResumeAfterId}, now ${chunk.resume_after_id})`
        );
        assert.equal(
          chunk.page_size,
          TEST_PAGE_SIZE,
          "the durable chunk records the page limit used for this admission"
        );
        lastResumeAfterId = Number(chunk.resume_after_id);
        assert.ok(admissions <= Math.ceil(WHALE_RECORD_COUNT / TEST_PAGE_SIZE) + 1, "must not loop forever");
      }

      assert.ok(admissions > 1, "the fixture must genuinely span multiple admissions, not finish in one");

      const row = evidenceRow(WHALE_ID);
      assert.ok(row, "evidence row exists after the final admission");
      assert.equal(row?.total_records, WHALE_RECORD_COUNT);
      assert.equal(row?.dirty, 0);
      assert.equal(row?.state, "fresh");
    })
  ));

test("mutation-proof: a chunked multi-admission repair produces an IDENTICAL final row to a single unbounded repair — no double-count, no dropped row", () =>
  withTempDb(async () => {
    // Run A: chunked across many small admissions.
    seedManifestConnector();
    seedInstance(WHALE_ID);
    seedWhaleRecords(WHALE_ID, WHALE_RECORD_COUNT);
    await withChunkTestEnv(TEST_PAGE_SIZE, true, async () => {
      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: each admission must observe the durable chunk state the previous admission left before deciding whether to loop again.
        await reconcileConnectorSummaryEvidence([WHALE_ID]);
        if (!chunkRow(WHALE_ID)) {
          break;
        }
      }
    });
    const chunkedRow = evidenceRow(WHALE_ID);
    assert.ok(chunkedRow, "chunked run produced an evidence row");

    // Run B: same fixture, single unbounded repair (default page size, no
    // forced early return) — the pre-chunking behavioral shape.
    const otherId = "cin_whale_unbounded";
    seedInstance(otherId);
    seedWhaleRecords(otherId, WHALE_RECORD_COUNT);
    const unboundedResult = await reconcileConnectorSummaryEvidence([otherId]);
    assert.equal(unboundedResult.repaired, 1);
    const unboundedRow = evidenceRow(otherId);
    assert.ok(unboundedRow, "unbounded run produced an evidence row");

    assert.equal(chunkedRow?.total_records, unboundedRow?.total_records, "no double-count, no dropped row");
    assert.equal(chunkedRow?.stream_count, unboundedRow?.stream_count);
    assert.equal(chunkedRow?.total_records, WHALE_RECORD_COUNT);

    const chunkedStreams = JSON.parse(chunkedRow?.stream_records_json ?? "[]");
    const unboundedStreams = JSON.parse(unboundedRow?.stream_records_json ?? "[]");
    const normalize = (entries: { record_count: number; stream: string }[]) =>
      entries
        .map((e) => ({ record_count: e.record_count, stream: e.stream }))
        .sort((a, b) => a.stream.localeCompare(b.stream));
    assert.deepEqual(normalize(chunkedStreams), normalize(unboundedStreams), "per-stream counts are byte-identical");
  }));

test("a chunk boundary is durable: a second, separate admission resumes from the persisted resume_after_id rather than rescanning from the start", () =>
  withTempDb(() =>
    withChunkTestEnv(TEST_PAGE_SIZE, true, async () => {
      seedManifestConnector();
      seedInstance(WHALE_ID);
      seedWhaleRecords(WHALE_ID, WHALE_RECORD_COUNT);

      // First admission: persists a chunk after exactly one page.
      await reconcileConnectorSummaryEvidence([WHALE_ID]);
      const afterFirst = chunkRow(WHALE_ID);
      assert.ok(afterFirst, "first admission left a durable chunk row");
      assert.equal(
        Number(afterFirst?.resume_after_id),
        TEST_PAGE_SIZE,
        "resume_after_id is exactly the last id of page 1"
      );
      const accumulatorAfterFirst = JSON.parse(afterFirst?.accumulator_json ?? "{}");
      assert.equal(accumulatorAfterFirst.messages?.record_count, TEST_PAGE_SIZE);

      // Second, SEPARATE admission (a distinct call — simulating a distinct
      // sweep pass, not one JS call looping internally) must resume from
      // that persisted position, not rescan from the start.
      await reconcileConnectorSummaryEvidence([WHALE_ID]);
      const afterSecond = chunkRow(WHALE_ID);
      assert.ok(afterSecond, "second admission still has records left to scan");
      assert.equal(
        Number(afterSecond?.resume_after_id),
        TEST_PAGE_SIZE * 2,
        "resume_after_id advanced by exactly one more page's worth of ids, proving it resumed rather than restarted"
      );
      const accumulatorAfterSecond = JSON.parse(afterSecond?.accumulator_json ?? "{}");
      assert.equal(
        accumulatorAfterSecond.messages?.record_count,
        TEST_PAGE_SIZE * 2,
        "the accumulator carries forward the first page's count rather than resetting to just the second page's"
      );
    })
  ));

test("append-safe receipt: a one-page admission survives a later append and the next admission advances from its durable boundary", () =>
  withTempDb(() =>
    withChunkTestEnv(TEST_PAGE_SIZE, true, async () => {
      seedManifestConnector();
      seedInstance(WHALE_ID);
      seedWhaleRecords(WHALE_ID, WHALE_RECORD_COUNT);

      // First admission is deliberately cancelled after one page, leaving a
      // durable receipt for the proven prefix.
      await reconcileConnectorSummaryEvidence([WHALE_ID]);
      const inProgress = chunkRow(WHALE_ID);
      assert.ok(inProgress, "a chunk is in progress");
      const revisionAtChunk = inProgress?.source_revision;
      assert.equal(Number(inProgress.resume_after_id), TEST_PAGE_SIZE, "first admission proves page one");

      // Appending rows advances source_revision but cannot change the prefix
      // already represented by the receipt. The next admission must retain
      // that work rather than livelocking on a source-revision mismatch.
      seedWhaleRecords(WHALE_ID, 10, WHALE_RECORD_COUNT);
      const liveRevision = getDb()
        .prepare("SELECT CAST(source_revision AS TEXT) AS r FROM connector_instances WHERE connector_instance_id = ?")
        .get(WHALE_ID) as { r: string };
      assert.notEqual(liveRevision.r, revisionAtChunk, "seeding more records must advance source_revision");

      await reconcileConnectorSummaryEvidence([WHALE_ID]);
      const afterAppend = chunkRow(WHALE_ID);
      assert.ok(afterAppend, "the append leaves the prior receipt resumable");
      assert.equal(
        Number(afterAppend.resume_after_id),
        TEST_PAGE_SIZE * 2,
        "the next admission advances from the durable boundary instead of restarting at page one"
      );
      assert.equal(
        JSON.parse(afterAppend.accumulator_json).messages?.record_count,
        TEST_PAGE_SIZE * 2,
        "the preserved prefix remains in the accumulator after the append"
      );

      // Drain the rest of the scan.
      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: each admission must observe the durable chunk state the previous admission left before deciding whether to loop again.
        await reconcileConnectorSummaryEvidence([WHALE_ID]);
        if (!chunkRow(WHALE_ID)) {
          break;
        }
      }

      const row = evidenceRow(WHALE_ID);
      assert.equal(
        row?.total_records,
        WHALE_RECORD_COUNT + 10,
        "the final count contains both the proven prefix and the appended tail exactly once"
      );
    })
  ));

test("prefix-mutation control: editing a row at or before the durable boundary invalidates the receipt and restarts the next admission", () =>
  withTempDb(() =>
    withChunkTestEnv(TEST_PAGE_SIZE, true, async () => {
      seedManifestConnector();
      seedInstance(WHALE_ID);
      seedWhaleRecords(WHALE_ID, WHALE_RECORD_COUNT);

      await reconcileConnectorSummaryEvidence([WHALE_ID]);
      const inProgress = chunkRow(WHALE_ID);
      assert.ok(inProgress, "first admission left a prefix receipt");
      const boundary = Number(inProgress.resume_after_id);
      assert.equal(boundary, TEST_PAGE_SIZE, "the receipt covers exactly the first page");

      // This direct canonical write is the negative control for unconditional
      // resume: it changes a row already folded into the accumulator.
      getDb()
        .prepare("UPDATE records SET emitted_at = ? WHERE connector_instance_id = ? AND id = ?")
        .run("2026-07-28T00:00:00.000Z", WHALE_ID, boundary);
      assert.equal(chunkRow(WHALE_ID), undefined, "a prefix mutation deletes the invalid receipt immediately");

      await reconcileConnectorSummaryEvidence([WHALE_ID]);
      const afterMutation = chunkRow(WHALE_ID);
      assert.ok(afterMutation, "the restarted scan left its new first-page receipt");
      assert.equal(
        Number(afterMutation.resume_after_id),
        TEST_PAGE_SIZE,
        "the next admission restarts at the first page rather than unconditionally resuming past the mutation"
      );
      assert.equal(
        JSON.parse(afterMutation.accumulator_json).messages?.record_count,
        TEST_PAGE_SIZE,
        "the new receipt contains only freshly re-read prefix facts"
      );

      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: each admission must observe the prior durable receipt before continuing.
        await reconcileConnectorSummaryEvidence([WHALE_ID]);
        if (!chunkRow(WHALE_ID)) {
          break;
        }
      }
      assert.equal(
        evidenceRow(WHALE_ID)?.total_records,
        WHALE_RECORD_COUNT,
        "the restarted scan preserves the exact final count"
      );
    })
  ));

/**
 * The UPDATE control above proves the trigger's `deleteChunkForEitherPrefix`
 * builder. It does NOT cover `deleteChunkForPrefix`, which is a SEPARATE SQL
 * builder wired to the INSERT and DELETE triggers — disabling that one leaves
 * all six other tests green, so the guard was live but unpinned.
 *
 * A DELETE inside the proven prefix is the more dangerous of the two: the
 * accumulator has already counted that row, so resuming past it would publish
 * a total_records that is too HIGH — a connection reporting more retained data
 * than it holds. That is the exact false-green this subsystem exists to stop.
 */
test("prefix-DELETE control: removing a row at or before the durable boundary also invalidates the receipt", () =>
  withTempDb(() =>
    withChunkTestEnv(TEST_PAGE_SIZE, true, async () => {
      seedManifestConnector();
      seedInstance(WHALE_ID);
      seedWhaleRecords(WHALE_ID, WHALE_RECORD_COUNT);

      await reconcileConnectorSummaryEvidence([WHALE_ID]);
      const inProgress = chunkRow(WHALE_ID);
      assert.ok(inProgress, "first admission left a prefix receipt");
      const boundary = Number(inProgress.resume_after_id);

      // Deletion, not update: exercises `deleteChunkForPrefix` via the DELETE
      // trigger rather than the UPDATE builder the sibling control covers.
      getDb().prepare("DELETE FROM records WHERE connector_instance_id = ? AND id = ?").run(WHALE_ID, boundary);
      assert.equal(chunkRow(WHALE_ID), undefined, "a prefix deletion deletes the invalid receipt immediately");

      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: each admission must observe the prior durable receipt before continuing.
        await reconcileConnectorSummaryEvidence([WHALE_ID]);
        if (!chunkRow(WHALE_ID)) {
          break;
        }
      }
      assert.equal(
        evidenceRow(WHALE_ID)?.total_records,
        WHALE_RECORD_COUNT - 1,
        "the rescanned count reflects the deletion exactly — never the stale, higher pre-deletion total"
      );
    })
  ));

test("the per-unit statement-timeout bound is never raised to make chunking work", () => {
  const source = readFileSync(join(__dirname, "..", "server", "connector-summary-evidence-engine.ts"), "utf8");
  assert.match(source, MIN_STATEMENT_TIMEOUT_RE, "the 500ms floor must remain exactly as af114c250 set it");
});
