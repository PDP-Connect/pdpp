// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-connection progress isolation (2026-08-03 fairness fix — live symptom
 * on `5a8049afc`'s fleet stream-health audit): a page's terminal-event fold
 * used to run ONE `foldStreamFactsBestEffort(pageIds, {...})` call sharing
 * the whole page's scope. Inside that single call,
 * `foldConnectorSummaryStreamFacts`'s own `sinceSeq = Math.min(every
 * participant's checkpoint)` floors the shared drain's start position at
 * whichever participant is furthest behind — observed live: one connection
 * whose checkpoint sat ~97,000 events behind the fleet's terminal high-
 * water mark (having last folded a week earlier) floored the drain for
 * every OTHER co-scoped participant too, including a near-current
 * participant whose own checkpoint was only a few hundred events behind.
 * Because the page's write phase shares the same deadline as the read
 * phase, the straggler's huge gap alone could exhaust the whole page's
 * bounded budget before ANY participant's checkpoint write landed, every
 * single sweep tick, forever.
 *
 * The fix (`foldParticipantsFairly`/`rotateForFairTurn` in
 * connector-summary-read-model.ts) does NOT touch the fold engine itself —
 * `foldTerminalEventFacts`, `seedFoldState`, `drainTerminalEventBatches`,
 * the CAS write path, and unscoped legacy-event handling are all
 * byte-for-byte unchanged. It composes the EXISTING singleton-scoped
 * `foldStreamFactsBestEffort([oneId], {...})` call once per page
 * participant, in fair rotation order, instead of one call sharing the
 * whole page's scope. Rotation reuses the SAME durable, fenced,
 * monotonic `phaseTurnGeneration` the maintenance sweep already threads
 * through for fold/repair phase-order alternation — no new durable state.
 *
 * This file proves:
 *   1. `rotateForFairTurn` (pure): the durable round-robin ordering
 *      primitive — deterministic, wraps correctly, and a later generation
 *      rotates a different participant to the front, which is what turns
 *      "isolation" into "isolation + eventual service" rather than a fixed
 *      priority order.
 *   2. `foldParticipantsFairly` (pure scheduler, real singleton fold calls
 *      against a disposable SQLite DB): given a persisted precondition
 *      seeded DIRECTLY at the exact checkpoint/maxSeq relationship the live
 *      incident had (laggard far behind, near-current close to the fleet
 *      high-water mark, both scoped on the same call, real attributable
 *      events pending in both), a tight shared event budget still lands
 *      the near-current participant's own convergence, and a later
 *      generation still gives the laggard first claim on the budget
 *      (eventual service).
 *   3. One production-path integration oracle: the SAME precondition
 *      driven through the real `runBoundedSummaryEvidenceSweep` entry
 *      point (the actual maintenance-tick call, not a direct scheduler
 *      call) reaches the identical durable outcome.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  foldParticipantsFairly,
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
  rotateForFairTurn,
  runBoundedSummaryEvidenceSweep,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-07-17T00:00:00.000Z";

// ─── 1. Pure rotation oracle ────────────────────────────────────────────

test("pure: rotateForFairTurn wraps and rotates deterministically", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(rotateForFairTurn(ids, 0), ["a", "b", "c", "d"], "generation 0 starts at index 0, unchanged order");
  assert.deepEqual(rotateForFairTurn(ids, 1), ["b", "c", "d", "a"], "generation 1 rotates to start at index 1");
  assert.deepEqual(rotateForFairTurn(ids, 4), ["a", "b", "c", "d"], "generation 4 wraps back to index 0 (4 % 4 = 0)");
  assert.deepEqual(rotateForFairTurn(ids, 5), ["b", "c", "d", "a"], "generation 5 wraps to index 1 (5 % 4 = 1)");
  assert.deepEqual(
    rotateForFairTurn(ids, -1),
    ["d", "a", "b", "c"],
    "a negative seed still wraps to a valid positive index (-1 % 4 = -1, normalized to 3)"
  );
});

test("pure: rotateForFairTurn — a later generation gives the LAGGARD (last in original order) first claim", () => {
  // Mirrors the live incident's actual keyset order: the laggard sorted
  // FIRST alphabetically in the real audit (`cin_86538195...` was early in
  // `connector_instance_id` ascending order), so this fixture puts the
  // laggard LAST to prove rotation — not original position — decides who
  // goes first.
  const pageIds = ["cin_near_current", "cin_other_a", "cin_other_b", "cin_laggard"];
  assert.equal(rotateForFairTurn(pageIds, 0)[0], "cin_near_current", "generation 0: original first id goes first");
  assert.equal(
    rotateForFairTurn(pageIds, 3)[0],
    "cin_laggard",
    "generation 3: rotation gives the laggard first claim on this round's budget"
  );
});

// ─── 2. Pure scheduler (real singleton fold calls) ─────────────────────

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-fold-fair-rotation-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnection(connectorInstanceId: string, connectorId = "c1"): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, "{}", NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_local', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, connectorId, connectorInstanceId, NOW, NOW);
}

let sqliteEventSeq = 0;

/** Seeds `count` attributable terminal events, continuing the shared monotonic `event_seq` sequence. Returns the last `event_seq` written. */
function seedTerminalEvents(connectorInstanceId: string, count: number): number {
  const stmt = getDb().prepare(
    `INSERT INTO spine_events(
       event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
     ) VALUES (?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test', 'run', ?, 'succeeded', ?, ?, ?, '1')`
  );
  let last = sqliteEventSeq;
  for (let i = 0; i < count; i += 1) {
    sqliteEventSeq += 1;
    const data = JSON.stringify({
      collection_facts: {
        reference_only: true,
        schema_version: 1,
        streams: [{ record_count: sqliteEventSeq, resolved: true, stream: "messages" }],
      },
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
    });
    stmt.run(
      `evt_${sqliteEventSeq}`,
      sqliteEventSeq,
      NOW,
      NOW,
      `trace_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      connectorInstanceId,
      data
    );
    last = sqliteEventSeq;
  }
  return last;
}

/**
 * Seed the exact persisted evidence-row precondition directly, bypassing
 * event-order choreography: an evidence row whose durable
 * `stream_facts_event_seq` checkpoint sits at exactly `checkpoint`.
 * Requires the row to already exist (`rebuildConnectorSummaryEvidence`).
 * Mirrors `connector-summary-terminal-publisher.test.ts`'s own direct
 * `UPDATE connector_summary_evidence SET stream_facts_event_seq = ?`
 * pattern — the behavior under test begins from already-persisted fold
 * state, not from a fresh bootstrap, so direct fixture setup (not
 * event-order choreography) is the correct oracle here.
 */
function seedEvidenceCheckpoint(connectorInstanceId: string, checkpoint: number): void {
  getDb()
    .prepare(
      "UPDATE connector_summary_evidence SET stream_facts_event_seq = ?, terminal_facts_state = 'stale' WHERE connector_instance_id = ?"
    )
    .run(checkpoint, connectorInstanceId);
}

async function checkpointOf(connectorInstanceId: string): Promise<number> {
  const evidence = await getConnectorSummaryEvidence(connectorInstanceId);
  return evidence ? Number(evidence.stream_facts_event_seq) : 0;
}

const LAGGARD_ID = "cin_laggard";
const NEAR_CURRENT_ID = "cin_near_current";
/** Matches the live incident's own ~140x ratio (97k-behind laggard vs. ~700-behind near-current), scaled down for fast deterministic CI execution. */
const LAGGARD_REMAINING_EVENTS = 9700;
const NEAR_CURRENT_REMAINING_EVENTS = 70;
const TIGHT_BUDGET = 200;

/** Registers both connections. Their evidence rows are bootstrapped separately, via one unscoped `rebuildConnectorSummaryEvidence()` call, before either has any terminal events. */
function seedFairnessConnections(): void {
  seedConnection(LAGGARD_ID);
  seedConnection(NEAR_CURRENT_ID);
}

test(
  "pure scheduler: foldParticipantsFairly isolates a near-current participant from a co-scoped laggard within a tight shared budget",
  withTempDb(async () => {
    seedFairnessConnections();
    await rebuildConnectorSummaryEvidence();

    seedTerminalEvents(LAGGARD_ID, LAGGARD_REMAINING_EVENTS);
    const maxSeq = seedTerminalEvents(NEAR_CURRENT_ID, NEAR_CURRENT_REMAINING_EVENTS);
    seedEvidenceCheckpoint(LAGGARD_ID, maxSeq - LAGGARD_REMAINING_EVENTS - NEAR_CURRENT_REMAINING_EVENTS);
    seedEvidenceCheckpoint(NEAR_CURRENT_ID, maxSeq - NEAR_CURRENT_REMAINING_EVENTS);

    const laggardCheckpointBefore = await checkpointOf(LAGGARD_ID);
    const nearCurrentCheckpointBefore = await checkpointOf(NEAR_CURRENT_ID);
    assert.equal(
      maxSeq - laggardCheckpointBefore,
      LAGGARD_REMAINING_EVENTS + NEAR_CURRENT_REMAINING_EVENTS,
      "sanity: the seeded precondition matches the live incident's laggard gap exactly"
    );
    assert.equal(
      maxSeq - nearCurrentCheckpointBefore,
      NEAR_CURRENT_REMAINING_EVENTS,
      "sanity: the seeded precondition matches the live incident's near-current gap exactly"
    );

    // Generation 0 rotates the near-current id to the front (it is first in
    // the array passed below) — the ordinary case where the near-current
    // participant is served first this tick.
    const deadline = Date.now() + 60_000;
    const outcome = await foldParticipantsFairly([NEAR_CURRENT_ID, LAGGARD_ID], deadline, TIGHT_BUDGET, 0);

    assert.equal(
      outcome.incomplete,
      true,
      "the fair-rotation pass as a whole is incomplete — the laggard did not converge"
    );

    const nearCurrentCheckpoint = await checkpointOf(NEAR_CURRENT_ID);
    assert.equal(
      nearCurrentCheckpoint,
      maxSeq,
      "FAIL-BEFORE/PASS-AFTER: the near-current participant's checkpoint durably reaches the true high-water mark " +
        "within the tight shared budget — composing per-participant singleton calls means its own drain is never " +
        "floored by the laggard's low checkpoint, unlike the pre-fix single shared-scope call."
    );

    const laggardCheckpoint = await checkpointOf(LAGGARD_ID);
    // The near-current participant (rotated first) consumes exactly its
    // own NEAR_CURRENT_REMAINING_EVENTS-sized gap; the laggard inherits
    // only whatever budget is left over (TIGHT_BUDGET - NEAR_CURRENT_REMAINING_EVENTS),
    // NOT the full TIGHT_BUDGET a naive "everyone gets the full budget"
    // implementation would give it.
    assert.equal(
      laggardCheckpoint - laggardCheckpointBefore,
      TIGHT_BUDGET - NEAR_CURRENT_REMAINING_EVENTS,
      "MUTATION EVIDENCE: the laggard's progress this round is exactly the LEFTOVER budget after the near-current " +
        "participant's own convergence — proving the budget is a genuinely shrinking shared pool across " +
        "participants (a total ceiling for the page), not each participant independently re-granted the full " +
        "TIGHT_BUDGET (which would be the bug: the page's total bounded-work contract silently multiplied by " +
        "participant count)"
    );
    assert.ok(
      laggardCheckpoint < maxSeq,
      "the laggard has not converged this round — its own ~9,700-event gap is far larger than any leftover budget"
    );
  })
);

test(
  "pure scheduler: foldParticipantsFairly's rotation gives the laggard first claim on a later generation — eventual service",
  withTempDb(async () => {
    seedFairnessConnections();
    await rebuildConnectorSummaryEvidence();

    seedTerminalEvents(LAGGARD_ID, LAGGARD_REMAINING_EVENTS);
    const maxSeq = seedTerminalEvents(NEAR_CURRENT_ID, NEAR_CURRENT_REMAINING_EVENTS);
    seedEvidenceCheckpoint(LAGGARD_ID, maxSeq - LAGGARD_REMAINING_EVENTS - NEAR_CURRENT_REMAINING_EVENTS);
    seedEvidenceCheckpoint(NEAR_CURRENT_ID, maxSeq - NEAR_CURRENT_REMAINING_EVENTS);

    const laggardCheckpointBefore = await checkpointOf(LAGGARD_ID);

    // Generation 1 rotates [NEAR_CURRENT_ID, LAGGARD_ID] to
    // [LAGGARD_ID, NEAR_CURRENT_ID] — the laggard now gets first claim.
    const deadline = Date.now() + 60_000;
    const outcome = await foldParticipantsFairly([NEAR_CURRENT_ID, LAGGARD_ID], deadline, TIGHT_BUDGET, 1);

    assert.equal(outcome.incomplete, true, "the laggard still cannot fully converge within one tight-budget round");
    const laggardCheckpoint = await checkpointOf(LAGGARD_ID);
    assert.ok(
      laggardCheckpoint > laggardCheckpointBefore,
      "eventual service: rotated to first claim, the laggard's checkpoint DOES advance this round — it is not " +
        "starved forever by a persistently near-current page-mate; a fixed (non-rotating) priority order would " +
        "instead always serve the same participant first"
    );
  })
);

// ─── 3. Production-path integration oracle ─────────────────────────────

test(
  "production path: runBoundedSummaryEvidenceSweep composes the fair rotation and isolates a near-current participant from a co-scoped laggard",
  withTempDb(async () => {
    seedFairnessConnections();
    await rebuildConnectorSummaryEvidence();

    seedTerminalEvents(LAGGARD_ID, LAGGARD_REMAINING_EVENTS);
    const maxSeq = seedTerminalEvents(NEAR_CURRENT_ID, NEAR_CURRENT_REMAINING_EVENTS);
    seedEvidenceCheckpoint(LAGGARD_ID, maxSeq - LAGGARD_REMAINING_EVENTS - NEAR_CURRENT_REMAINING_EVENTS);
    seedEvidenceCheckpoint(NEAR_CURRENT_ID, maxSeq - NEAR_CURRENT_REMAINING_EVENTS);

    // The real maintenance-tick entry point — both connections land on the
    // same keyset page (pageSize comfortably covers both ids), exactly the
    // live incident's own co-batching shape. `readInstanceIdPage` orders
    // ids ASCENDING by connector_instance_id — "cin_laggard" < "cin_near_current"
    // alphabetically, so generation 0 (no rotation) would serve the
    // laggard FIRST here; `phaseTurnGeneration: 1` rotates the 2-id page
    // to put the near-current participant first, matching this test's
    // intent (isolating the near-current participant's own convergence).
    const sweep = await runBoundedSummaryEvidenceSweep({
      maxDurationMs: 60_000,
      maxEventsPerFold: TIGHT_BUDGET,
      pageSize: 25,
      phaseTurnGeneration: 1,
    });

    assert.equal(sweep.incomplete, true, "the sweep is incomplete — the laggard's own fold did not converge");

    const nearCurrentCheckpoint = await checkpointOf(NEAR_CURRENT_ID);
    assert.equal(
      nearCurrentCheckpoint,
      maxSeq,
      "production-path oracle: the near-current participant's checkpoint durably reaches the true high-water mark " +
        "via the REAL runBoundedSummaryEvidenceSweep entry point, not merely the scheduler called directly"
    );

    const laggardCheckpoint = await checkpointOf(LAGGARD_ID);
    assert.ok(
      laggardCheckpoint < maxSeq,
      "the laggard has not converged this tick — its own huge gap does not fit the shared bounded budget"
    );
  })
);
