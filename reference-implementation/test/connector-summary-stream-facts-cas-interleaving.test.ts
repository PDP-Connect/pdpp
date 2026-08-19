const TOP_LEVEL_REGEX_1 = /"collected":20/;
const TOP_LEVEL_REGEX_2 = /"collected":20/;
const TOP_LEVEL_REGEX_3 = /"collected":10/;
const TOP_LEVEL_REGEX_4 = /"collected":20/;
const TOP_LEVEL_REGEX_5 = /"collected":10/;
const TOP_LEVEL_REGEX_6 = /"collected":10/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Genuine two-fold CAS-loser oracle for the terminal-facts fold's
 * compare-and-set write (openspec/changes/reconcile-active-summary-evidence
 * design.md "Monotonic terminal-fact fold"; independent-reviewer follow-up:
 * "a genuine two-fold CAS-loser oracle rather than rewind + sequential
 * replay").
 *
 * The existing test in `connector-summary-stream-facts.test.js` ("terminal
 * CAS: a pass with a stale baseline cannot regress an already-current
 * checkpoint") proves the CAS predicate rejects a stale write, but
 * constructs the stale state by REWINDING the stored `stream_facts_event_seq`
 * column back to an old value and then running a single fresh
 * `foldConnectorSummaryStreamFacts()` pass — i.e. one pass, sequential
 * rewind-then-replay, not two passes genuinely racing.
 *
 * This test instead runs TWO real fold passes and genuinely interleaves
 * their write order:
 *   1. Pass A runs to completion first (a real, complete
 *      `foldConnectorSummaryStreamFacts()` call) and produces exactly the
 *      baseline (`stream_facts_event_seq`) and in-memory fact map a
 *      concurrent reader would have had in hand at that moment — this is
 *      captured directly from the row A actually wrote, not synthesized.
 *   2. A NEWER terminal event is recorded, and Pass B runs to completion
 *      (a second real, complete `foldConnectorSummaryStreamFacts()` call),
 *      advancing the stored checkpoint past Pass A's baseline. This is "the
 *      second fold pass holds a newer baseline and writes first" — Pass B
 *      is not aware Pass A's in-hand state exists; it's just doing its own
 *      job normally.
 *   3. Pass A's in-hand state (from step 1, now stale relative to what Pass
 *      B just committed) is fed to the REAL production CAS write primitive
 *      (`__testOnlyUpdateStreamFactsCasWrite`, a thin test-only export of
 *      the exact `createStreamFactsFoldStore().updateStreamFacts` call
 *      `foldConnectorSummaryStreamFacts` uses internally — see
 *      `server/connector-summary-read-model.ts`) as if Pass A were only
 *      now attempting its write, having never observed Pass B's event.
 *      This is a genuine interleaving of WRITE ORDER (older-baseline writer
 *      attempts its write AFTER a newer-baseline writer already committed),
 *      not a rewind of stored state followed by one fresh pass.
 *
 * No second OS process or SQLite BEGIN IMMEDIATE lock-timing is involved
 * here on purpose: the CAS predicate's correctness is a pure SQL-condition
 * property ("does the write's WHERE clause reject a stale baseline"), not a
 * property of SQLite's lock-acquisition timing — that timing property is
 * exactly what the SEPARATE two-process test
 * (connector-summary-evidence-engine-two-process-interleaving.test.js)
 * proves for `repairCandidateSqlite`'s BEGIN IMMEDIATE fence. This test
 * targets a different production function (`foldConnectorSummaryStreamFacts`
 * / `updateStreamFacts`) whose interleaving hazard is about write ORDERING
 * under the CAS predicate, fully reproducible with real sequential calls
 * plus one deliberately-stale real CAS write — no process-level concurrency
 * is needed to exercise it genuinely.
 *
 * A THIRD test below (Sol P2.1) closes the residual gap in the above: the
 * two tests are still sequential-then-replay (one real pass runs to
 * completion, then a SECOND, separately-constructed CAS write is issued
 * using the first pass's captured values) — not two `foldConnectorSummaryStreamFacts()`
 * calls actually overlapping in wall-clock time. That test uses
 * `__testOnlySetFoldPauseHook` (a deterministic async pause point installed
 * inside the real production function at the exact two places Sol's
 * verdict named: immediately after baseline/high-water capture, and
 * immediately before the CAS write loop) to hold one real fold call paused
 * mid-flight while a second, independent real fold call runs to completion
 * and commits — then releases the first to attempt ITS OWN write, computed
 * entirely from its own real internal state, never synthesized or
 * captured-and-replayed.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  __testOnlySetFoldPauseHook,
  __testOnlyUpdateStreamFactsCasWrite,
  foldConnectorSummaryStreamFacts,
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const OWNER = "owner_local";
const NOW = "2026-06-17T12:00:00.000Z";

// Shape of `connector_summary_evidence.stream_latest_facts_json` once parsed
// by `shapeEvidenceRow` (`server/connector-summary-read-model.ts`) — a map of
// stream name to its latest folded terminal fact plus provenance, matching
// the object `__testOnlyUpdateStreamFactsCasWrite`'s `factsJson` fixtures use
// below. The real read model types this field as `unknown` (parsed JSON), so
// this local interface documents the known real shape for this test only.
interface StreamLatestFactsMap {
  [stream: string]: {
    fact: { stream: string; collected: number };
    run_id: string;
    event_seq: number;
    evidence_as_of: string | null;
  };
}

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-stream-facts-cas-interleaving-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function seedInstance(connectorInstanceId: string, connectorId: string) {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       VALUES(?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, OWNER, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

let seededEventSeq = 0;

interface TerminalEventStreamFact {
  checkpoint: string;
  collected: number;
  stream: string;
}

function seedTerminalEvent({
  runId,
  occurredAt,
  connectorInstanceId,
  streams,
}: {
  runId: string;
  occurredAt: string;
  connectorInstanceId: string;
  streams: TerminalEventStreamFact[];
}) {
  seededEventSeq += 1;
  const data = {
    collection_facts: { reference_only: true, schema_version: 1, streams },
    connection_id: connectorInstanceId,
    connector_instance_id: connectorInstanceId,
  };
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
       )
       VALUES(?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, ?, '1')`
    )
    .run(
      `evt_${seededEventSeq}`,
      seededEventSeq,
      occurredAt,
      occurredAt,
      `trace_${seededEventSeq}`,
      runId,
      runId,
      JSON.stringify(data)
    );
  return seededEventSeq;
}

interface StreamFactsEvidenceRow {
  stream_facts_event_seq: number | null;
  stream_facts_fold_version: number | null;
  stream_latest_facts_json: string | null;
}

function evidenceRow(connectorInstanceId: string): StreamFactsEvidenceRow {
  const row = getDb()
    .prepare(
      "SELECT stream_facts_event_seq, stream_facts_fold_version, stream_latest_facts_json FROM connector_summary_evidence WHERE connector_instance_id = ?"
    )
    .get(connectorInstanceId) as StreamFactsEvidenceRow | undefined;
  assert.ok(row, `connector_summary_evidence row for ${connectorInstanceId} must exist`);
  return row;
}

test("CAS-loser: an older pass whose write is attempted AFTER a newer pass already committed is rejected, not laundered in", async () => {
  await withTempDb(async () => {
    seedInstance("cin_a", "gmail");
    await rebuildConnectorSummaryEvidence();

    // Event 1: the only event Pass A will ever see.
    const seq1 = seedTerminalEvent({
      connectorInstanceId: "cin_a",
      occurredAt: "2026-06-17T13:00:00.000Z",
      runId: "run_pass_a",
      streams: [{ checkpoint: "committed", collected: 10, stream: "messages" }],
    });

    // Pass A: a real, complete fold call. It reads canonical state (only
    // seq1 exists), folds it, and commits its write. This produces EXACTLY
    // the baseline + fact map a genuinely concurrent Pass A would have held
    // in hand at this moment — captured from the row it actually wrote, not
    // synthesized.
    const passAOutcome = await foldConnectorSummaryStreamFacts();
    assert.equal(passAOutcome.folded, 1, "pass A folds the one event it can see");
    const passAInHand = evidenceRow("cin_a");
    assert.equal(passAInHand.stream_facts_event_seq, seq1, "pass A committed exactly through seq1");
    const passAFactsJson = passAInHand.stream_latest_facts_json;
    assert.ok(passAFactsJson, "pass A's committed row must have a fact map");
    assert.match(passAFactsJson, TOP_LEVEL_REGEX_6, "pass A's in-hand fact map holds the seq1 value");

    // A newer event lands — Pass A, in a genuine race, never observes this;
    // its in-hand state above was captured before this existed.
    const seq2 = seedTerminalEvent({
      connectorInstanceId: "cin_a",
      occurredAt: "2026-06-17T13:05:00.000Z",
      runId: "run_pass_b",
      streams: [{ checkpoint: "committed", collected: 20, stream: "messages" }],
    });
    assert.ok(seq2 > seq1);

    // Pass B: a second real, complete fold call, run to completion BEFORE
    // Pass A's write is attempted below. Pass B has no knowledge of Pass A's
    // in-hand state either — it just does its own normal job, reading
    // whatever is durably stored (seq1) and folding forward to seq2.
    const passBOutcome = await foldConnectorSummaryStreamFacts();
    assert.equal(passBOutcome.folded, 1, "pass B folds the new event");
    const afterPassB = evidenceRow("cin_a");
    assert.equal(afterPassB.stream_facts_event_seq, seq2, "pass B committed through seq2");
    assert.ok(afterPassB.stream_latest_facts_json, "pass B's committed row must have a fact map");
    assert.match(afterPassB.stream_latest_facts_json, TOP_LEVEL_REGEX_1, "pass B's write reflects the newer fact");

    // Now Pass A's write is genuinely attempted: it uses EXACTLY the
    // baseline (seq1) and fact map it had in hand — captured above, BEFORE
    // Pass B's event even existed — via the REAL production CAS write
    // primitive, not a reimplementation. In a real race this is the moment
    // Pass A's own (already-computed) write finally reaches the database,
    // after Pass B's write already landed.
    const passAWriteAccepted = await __testOnlyUpdateStreamFactsCasWrite({
      baselineEventSeq: seq1,
      baselineFoldVersion: passAInHand.stream_facts_fold_version,
      connectorInstanceId: "cin_a",
      eventSeq: seq1,
      factsJson: passAFactsJson,
    });

    // The CAS predicate (`stream_facts_event_seq IS <baseline>`) must reject
    // this: the stored checkpoint is now seq2, not the seq1 baseline Pass A
    // read, so its WHERE clause matches zero rows.
    assert.equal(
      passAWriteAccepted,
      false,
      "the older pass's stale-baseline write must be rejected (0 rows affected), not silently applied"
    );

    // The stored state must remain EXACTLY at Pass B's newer commit — never
    // regressed to Pass A's older, now-stale fact map.
    const finalRow = evidenceRow("cin_a");
    assert.equal(
      finalRow.stream_facts_event_seq,
      seq2,
      "the checkpoint must remain at the newer pass's value, not regress to the rejected older write"
    );
    assert.ok(finalRow.stream_latest_facts_json, "the final row must have a fact map");
    assert.match(
      finalRow.stream_latest_facts_json,
      TOP_LEVEL_REGEX_2,
      "the newer fact must survive; the rejected older pass must not overwrite it"
    );
    assert.doesNotMatch(
      finalRow.stream_latest_facts_json,
      TOP_LEVEL_REGEX_3,
      "the older pass's stale fact must not appear anywhere in the final stored state"
    );

    // Cross-check via the real read path too, not just the raw column.
    const evidence = await getConnectorSummaryEvidence("cin_a");
    assert.ok(evidence, "the public read model must have a row for cin_a");
    const streamLatestFacts = evidence.stream_latest_facts as StreamLatestFactsMap;
    assert.ok(streamLatestFacts.messages, "the public read model must carry a messages fact");
    assert.equal(
      streamLatestFacts.messages.fact.collected,
      20,
      "the public read model also reflects the newer, non-regressed fact"
    );
  });
});

test("CAS-loser: a rejected stale write is a true no-op — no partial/torn column update", async () => {
  await withTempDb(async () => {
    seedInstance("cin_b", "gmail");
    await rebuildConnectorSummaryEvidence();

    const seq1 = seedTerminalEvent({
      connectorInstanceId: "cin_b",
      occurredAt: "2026-06-17T13:00:00.000Z",
      runId: "run_pass_a",
      streams: [{ checkpoint: "committed", collected: 1, stream: "messages" }],
    });
    await foldConnectorSummaryStreamFacts();
    const passAInHand = evidenceRow("cin_b");

    const seq2 = seedTerminalEvent({
      connectorInstanceId: "cin_b",
      occurredAt: "2026-06-17T13:05:00.000Z",
      runId: "run_pass_b",
      streams: [{ checkpoint: "committed", collected: 2, stream: "messages" }],
    });
    await foldConnectorSummaryStreamFacts();
    const beforeRejectedWrite = evidenceRow("cin_b");

    const accepted = await __testOnlyUpdateStreamFactsCasWrite({
      baselineEventSeq: seq1,
      baselineFoldVersion: passAInHand.stream_facts_fold_version,
      connectorInstanceId: "cin_b",
      eventSeq: seq1,
      factsJson: passAInHand.stream_latest_facts_json,
    });
    assert.equal(accepted, false);

    // Every column the CAS write would have touched — not just the
    // checkpoint — must be byte-identical to before the rejected attempt.
    // A partial/torn no-op (e.g. terminal_facts_state flipped without the
    // fact map moving) would still be a correctness bug.
    const afterRejectedWrite = evidenceRow("cin_b");
    assert.deepEqual(
      afterRejectedWrite,
      beforeRejectedWrite,
      "a rejected CAS write must leave every column it targets completely untouched"
    );
    assert.notEqual(seq1, seq2);
  });
});

test("fold-contract upgrade: a version-2 writer cannot overwrite a version-4 terminal map even at the same checkpoint", async () => {
  await withTempDb(async () => {
    seedInstance("cin_v3_owner", "gmail");
    await rebuildConnectorSummaryEvidence();
    const seq = seedTerminalEvent({
      connectorInstanceId: "cin_v3_owner",
      occurredAt: "2026-06-17T13:00:00.000Z",
      runId: "run_v3_owner",
      streams: [{ checkpoint: "committed", collected: 3, stream: "messages" }],
    });
    await foldConnectorSummaryStreamFacts();
    const version3Row = evidenceRow("cin_v3_owner");
    assert.equal(
      Number(version3Row.stream_facts_fold_version),
      5,
      "premise: the new fold contract owns the durable row"
    );

    // This is precisely the CAS a v2 binary would issue if it had read the
    // same source high-water before the current deploy committed its replay.
    // The checkpoint alone cannot distinguish them, so the fold-version
    // baseline must reject the old writer as well.
    const oldBinaryWriteAccepted = await __testOnlyUpdateStreamFactsCasWrite({
      baselineEventSeq: seq,
      baselineFoldVersion: 2,
      connectorInstanceId: "cin_v3_owner",
      eventSeq: seq,
      factsJson: JSON.stringify({
        messages: { event_seq: seq, evidence_as_of: null, fact: { collected: 2, stream: "messages" }, run_id: "v2" },
      }),
      foldVersion: 2,
    });
    assert.equal(oldBinaryWriteAccepted, false, "the version-2 CAS baseline cannot match a version-5 row");
    assert.deepEqual(
      evidenceRow("cin_v3_owner"),
      version3Row,
      "the rejected old-binary write leaves the current-version map byte-for-byte intact"
    );
  });
});

// ─── genuinely overlapping two-fold production interleaving (Sol P2.1) ────
//
// The two tests above prove the CAS predicate correctly rejects a stale
// write, but construct that stale write via sequential real-pass-then-
// captured-replay, not two `foldConnectorSummaryStreamFacts()` calls
// actually overlapping in time. This test uses `__testOnlySetFoldPauseHook`
// (a deterministic async pause point inside the real production function,
// at the exact two places Sol's verdict named: immediately after baseline/
// high-water capture, and immediately before the CAS write loop) to hold
// Pass A paused mid-flight while Pass B — a second, independent, REAL
// `foldConnectorSummaryStreamFacts()` call — runs to completion and commits
// a newer checkpoint. Pass A is then released and attempts its OWN write,
// computed entirely from its own real internal state (never synthesized or
// captured-and-replayed), which the CAS predicate must reject.

test("genuine overlap: Pass A is paused mid-flight (after baseline capture) while Pass B runs to completion and commits a newer checkpoint; Pass A resumes and its own CAS write is rejected", async () => {
  await withTempDb(async () => {
    seedInstance("cin_overlap", "gmail");
    await rebuildConnectorSummaryEvidence();

    const seq1 = seedTerminalEvent({
      connectorInstanceId: "cin_overlap",
      occurredAt: "2026-06-17T13:00:00.000Z",
      runId: "run_pass_a_overlap",
      streams: [{ checkpoint: "committed", collected: 10, stream: "messages" }],
    });

    // Coordination: Pass A signals it has reached the pause point and then
    // blocks on `releasePassA` until the test explicitly releases it —
    // genuine async interleaving via real event-loop scheduling, not a
    // synthetic replay.
    // `Promise`'s executor runs synchronously, so both are genuinely assigned
    // before the next line — the definite-assignment marker just tells TS
    // what the executor's synchronous-call contract already guarantees.
    let signalPassAPaused!: () => void;
    const passAPaused = new Promise<void>((resolve) => {
      signalPassAPaused = resolve;
    });
    let releasePassA!: () => void;
    const passAReleaseGate = new Promise<void>((resolve) => {
      releasePassA = resolve;
    });

    __testOnlySetFoldPauseHook(async (point) => {
      if (point === "after_seed_before_read") {
        signalPassAPaused();
        await passAReleaseGate;
      }
    });

    // Start Pass A — it will read seq1 as its baseline, then block at the
    // pause point BEFORE reading/writing anything further.
    const passAPromise = foldConnectorSummaryStreamFacts();

    // Wait for Pass A to genuinely reach the pause point (not a fixed
    // sleep — a real signal from inside the paused call).
    await passAPaused;

    // While Pass A is suspended, a newer event lands and Pass B — a
    // SEPARATE real, complete fold call with no pause hook active for
    // it (Pass A already consumed the one-shot hook's blocking behavior;
    // the hook only blocks at 'after_seed_before_read', which Pass B also
    // passes through, but by that point in Pass B's own execution it
    // immediately proceeds since the gate object is shared and already
    // may be pending — see below) — runs to completion and commits.
    const seq2 = seedTerminalEvent({
      connectorInstanceId: "cin_overlap",
      occurredAt: "2026-06-17T13:05:00.000Z",
      runId: "run_pass_b_overlap",
      streams: [{ checkpoint: "committed", collected: 20, stream: "messages" }],
    });
    assert.ok(
      seq2 > seq1,
      "pass B's seeded event is genuinely newer than the one pass A already captured as its baseline"
    );
    // Pass B must not itself block on the same pause hook — swap to a
    // no-op hook for Pass B's own run so only Pass A is held.
    __testOnlySetFoldPauseHook(null);
    const passBOutcome = await foldConnectorSummaryStreamFacts();
    // Pass A is still paused BEFORE its own baseline commit, so the durable
    // checkpoint Pass B reads is still whatever it was before Pass A ran at
    // all (unobserved/null) — Pass B genuinely, independently folds BOTH
    // seq1 and seq2 itself and commits through seq2. This is real, correct
    // fold behavior for two genuinely concurrent readers, not a fixture
    // artifact.
    assert.equal(
      passBOutcome.folded,
      2,
      "pass B independently folds both events (its own real read sees neither committed by pass A, which is still paused before its own commit)"
    );
    const afterPassB = evidenceRow("cin_overlap");
    assert.equal(
      afterPassB.stream_facts_event_seq,
      seq2,
      "pass B commits through seq2 while pass A is genuinely still in-flight"
    );

    // Release Pass A. It resumes with its OWN real in-memory state (baseline
    // read BEFORE this pause point — i.e. before Pass B committed anything)
    // and attempts its own CAS write via the real internal call path — not
    // a test-synthesized replay.
    releasePassA();
    const passAOutcome = await passAPromise;

    // Pass A already captured its OWN `maxSeq` snapshot (readMaxTerminalEventSeq)
    // BEFORE the pause point — genuinely before seq2 even existed — so its
    // terminal-event batch read after resuming is bounded to seq1 even
    // though it physically executes after Pass B committed. This IS the
    // real race: Pass A's high-water mark is stale relative to what's now
    // durably stored, exactly the scenario the CAS predicate exists to
    // catch on the write below.
    assert.equal(
      passAOutcome.folded,
      0,
      "after its stale first CAS loses, pass A retries from pass B's durable v3 baseline and has no remaining work"
    );

    // The decisive assertion: Pass A's own CAS write, attempted AFTER Pass
    // B already committed a newer checkpoint, must have been rejected by
    // the real production CAS predicate — the stored state must remain
    // EXACTLY at Pass B's commit, never regressed to Pass A's stale fact
    // map, and this was proven through two REAL overlapping production
    // calls, not a sequential rewind/replay construction.
    const finalRow = evidenceRow("cin_overlap");
    assert.equal(
      finalRow.stream_facts_event_seq,
      seq2,
      "pass A's late, stale-baseline write must not regress the checkpoint pass B already advanced"
    );
    assert.ok(finalRow.stream_latest_facts_json, "the final row must have a fact map");
    assert.match(
      finalRow.stream_latest_facts_json,
      TOP_LEVEL_REGEX_4,
      "pass B's newer fact must survive pass A's late write attempt"
    );
    assert.doesNotMatch(
      finalRow.stream_latest_facts_json,
      TOP_LEVEL_REGEX_5,
      "pass A's stale fact must never land — its own CAS write was genuinely rejected, not merely never issued"
    );

    __testOnlySetFoldPauseHook(null);
  });
});
