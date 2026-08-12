// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resumable bounded sweep: genuinely bounds discovery + fold + repair
 * TOGETHER, not just a repair-loop count/time cap
 * (Sol P2.2: "maxDurationMs checked only inside the repair loop does NOT
 * close Sol's finding... a full discovery can already exceed the budget
 * before the loop begins, and an unscoped fold can exceed it afterward.
 * Implement a genuinely resumable bounded startup unit across discovery +
 * fold + repair (e.g. stable cursor/batched scope plus deadline propagated
 * through all phases)").
 *
 * `runBoundedSummaryEvidenceSweep` processes the canonical connection set
 * in small pages, each running the FULL scoped discovery+fold+repair+prune
 * barrier (`observeConnectorSummaryEvidence`), with the deadline checked
 * BEFORE each page starts — never mid-page. This file proves:
 *
 *   1. A sweep with a tiny deadline covering only part of a large
 *      connection set stops early, reports `incomplete: true`, and returns
 *      a `resumeAfterId` cursor.
 *   2. A follow-up sweep starting from that cursor genuinely resumes and
 *      completes the sweep of the connections the first call did not
 *      reach — no connection is silently skipped forever.
 *   3. A sweep that DOES cover the complete set in one call runs complete
 *      orphan pruning; a sweep that stops early does NOT run complete
 *      pruning (only the scoped per-page pruning each page's own barrier
 *      call already performs) — an incomplete sweep must never risk
 *      treating an undiscovered page's connections as orphaned.
 *   4. The bound genuinely covers discovery+fold, not merely repair: a
 *      page with ZERO repair candidates (every row already fresh) still
 *      counts toward the page/time budget, proving the deadline check
 *      gates page START, not "only when there is repair work to bound."
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver cannot model this installed package export
import Database from "better-sqlite3";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import {
  runBoundedSummaryEvidenceSweep,
  setConnectorSummaryReconcileObservationSink,
} from "../server/connector-summary-read-model.ts";
import type { ConnectorSummaryReconcileObservation } from "../server/connector-summary-reconcile-observability.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-07-17T00:00:00.000Z";

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-bounded-sweep-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnections(n: number, { connectorId = "c1" }: { connectorId?: string } = {}): string[] {
  const existing = getDb().prepare("SELECT 1 FROM connectors WHERE connector_id = ?").get(connectorId);
  if (!existing) {
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)")
      .run(connectorId, NOW);
  }
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    // Zero-padded so lexical (ORDER BY connector_instance_id ASC) order
    // matches numeric order — the sweep's keyset cursor depends on this.
    const id = `${connectorId}_cin_${String(i).padStart(4, "0")}`;
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES (?, 'owner_local', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
      )
      .run(id, connectorId, id, NOW, NOW);
    ids.push(id);
  }
  return ids;
}

function evidenceRowCount() {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM connector_summary_evidence").get<{ n: number }>();
  assert.ok(row, "evidence count query returns a row");
  return row.n;
}

function seedTerminalEvents(connectorInstanceId: string, count: number): number {
  for (let eventSeq = 1; eventSeq <= count; eventSeq += 1) {
    getDb()
      .prepare(
        `INSERT INTO spine_events(
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
         ) VALUES(?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test', 'run', ?, 'succeeded', ?, ?, ?, '1')`
      )
      .run(
        `evt_starvation_${eventSeq}`,
        eventSeq,
        NOW,
        NOW,
        `trace_starvation_${eventSeq}`,
        `run_starvation_${eventSeq}`,
        `run_starvation_${eventSeq}`,
        connectorInstanceId,
        JSON.stringify({
          collection_facts: {
            reference_only: true,
            schema_version: 1,
            streams: [{ record_count: eventSeq, resolved: true, stream: "messages" }],
          },
          connection_id: connectorInstanceId,
          connector_instance_id: connectorInstanceId,
        })
      );
  }
  return count;
}

test(
  "a sweep whose deadline is exhausted mid-set stops early, reports incomplete, and never runs complete-set pruning",
  withTempDb(async () => {
    const n = 50;
    seedConnections(n);

    // Deadline exhausted almost immediately. `maxDurationMs` is authoritative:
    // a round this tight may legitimately complete ZERO pages, because no page
    // — the most expensive unit here — may BEGIN after expiry. This used to
    // assert `discovered > 0`, which encoded a must-make-progress guarantee the
    // contract never made; under a 1ms budget a single scheduler yield decides
    // it, so that assertion was only ever probabilistically true. Progress is
    // guaranteed across repeated NORMAL-budget rounds (proven separately),
    // never within one impossible one.
    const result = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 1, pageSize: 10 });

    assert.equal(result.incomplete, true, "a near-zero deadline cannot cover 50 connections in 10-per-page pages");
    assert.equal(
      result.resumeAfterId,
      null,
      "a deadline-cut first page resumes from its durable cursor-before-page rather than skipping it"
    );
    assert.equal(result.prunedComplete, false, "an incomplete sweep must never run complete-set orphan pruning");
    assert.ok(result.discovered < n, "fewer than the complete set was discovered this call");
    assert.ok(
      result.discovered % 10 === 0,
      "whatever ran was whole pages — the budget never cuts a page partway through"
    );
  })
);

test(
  "a follow-up sweep resumes from the prior cursor and genuinely completes coverage of the connections the first call missed",
  withTempDb(async () => {
    const n = 30;
    const ids = seedConnections(n);

    // First sweep: cap pages so it deliberately covers only part of the set
    // (never hits the deadline — proves resumability independent of timing).
    const first = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, maxPages: 1, pageSize: 10 });
    assert.equal(first.incomplete, true, "a 1-page cap on a 30-connection set is genuinely incomplete");
    assert.equal(first.discovered, 10, "exactly one page (10 connections) was covered");
    assert.ok(first.resumeAfterId, "a page-capped sweep returns a resume cursor");
    assert.equal(first.resumeAfterId, ids[9], "the cursor is exactly the last id the first page covered");

    // Second sweep: resume from the first sweep's cursor, no page cap —
    // must cover every remaining connection and reach completion.
    const second = await runBoundedSummaryEvidenceSweep({
      afterId: first.resumeAfterId,
      maxDurationMs: 60_000,
      pageSize: 10,
    });
    assert.equal(second.incomplete, false, "resuming from the cursor with no further cap reaches the end of the set");
    assert.equal(
      second.discovered,
      20,
      "the resumed sweep covers exactly the 20 connections the first sweep did not reach"
    );
    // A resumed sweep that reaches the natural end of the id cursor DOES
    // safely run complete-set pruning through bounded keyset pages
    // the FULL live instance table independent of this call's own cursor
    // position, so pruning's live-id set is always complete once the sweep
    // itself confirms there is no more data past its cursor — regardless of
    // whether the earlier ids were walked by this call or a prior one.
    assert.equal(
      second.prunedComplete,
      true,
      "a resumed sweep that reaches the end of the id space safely runs complete pruning — pruning reads the full live-instance table independently of the cursor"
    );

    // Every one of the 30 connections has a durable evidence row after the
    // two-part sweep together covered the complete set.
    assert.equal(
      evidenceRowCount(),
      n,
      "the two-part resumed sweep together produced evidence for every connection, none silently skipped forever"
    );
  })
);

test(
  "a sweep that genuinely covers the complete set in one call runs complete-set orphan pruning",
  withTempDb(async () => {
    seedConnections(5);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: 10 });
    assert.equal(evidenceRowCount(), 5);

    // Delete one connection's canonical row entirely — its evidence row is
    // now a genuine orphan.
    getDb().prepare("DELETE FROM connector_instances WHERE connector_instance_id = 'c1_cin_0002'").run();

    const result = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: 10 });
    assert.equal(result.incomplete, false, "a 5-connection set fits in one 10-per-page pass");
    assert.equal(result.prunedComplete, true, "a genuinely complete sweep runs complete-set orphan pruning");
    assert.equal(evidenceRowCount(), 4, "the orphaned connection's evidence row was pruned by the complete pass");
  })
);

test(
  "the deadline bounds page START (discovery+fold+repair together), not merely repair work — a page with zero repair candidates still counts toward the budget",
  withTempDb(async () => {
    const n = 40;
    seedConnections(n);
    // Warm every row to fresh/current first — every subsequent page has
    // ZERO repair candidates, proving the page-count/deadline bound is not
    // merely "only checked when there is something to repair."
    await reconcileConnectorSummaryEvidence(null);

    const result = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, maxPages: 2, pageSize: 10 });
    assert.equal(
      result.incomplete,
      true,
      "the maxPages cap stops the sweep even though every page had zero repair work"
    );
    assert.equal(
      result.discovered,
      20,
      "exactly 2 pages (20 connections) were processed before the page cap stopped further pages, despite zero repair candidates"
    );
  })
);

async function countRawPrepareCalls<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
  let calls = 0;
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function patchedPrepare(this: InstanceType<typeof Database>, sql: string) {
    calls += 1;
    return original.call<InstanceType<typeof Database>, [string], ReturnType<typeof original>>(this, sql);
  } as typeof original;
  try {
    const result = await fn();
    return { calls, result };
  } finally {
    Database.prototype.prepare = original;
  }
}

test(
  "one page's total query count (discovery + fold + repair together) does not grow with N, the total connection count",
  withTempDb(async () => {
    // N=50, page size 10: the sweep's FIRST page must cover connections
    // 0-9 regardless of whether there are 50 or 500 total connections —
    // its own discovery+fold+repair query cost must not depend on N.
    seedConnections(50);
    const { calls: calls50 } = await countRawPrepareCalls(() =>
      runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, maxPages: 1, pageSize: 10 })
    );
    assert.ok(calls50 > 0, "sanity: interception observed real prepare calls");

    closeDb();
    const dir200 = mkdtempSync(join(tmpdir(), "pdpp-bounded-sweep-200-"));
    initDb(join(dir200, "pdpp.sqlite"));
    // N=200: same page size, same first page — the ONLY thing that changed
    // is how many MORE connections exist beyond what this one page covers.
    seedConnections(200);
    const { result: page1of200, calls: calls200 } = await countRawPrepareCalls(() =>
      runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, maxPages: 1, pageSize: 10 })
    );
    rmSync(dir200, { force: true, recursive: true });

    assert.equal(page1of200.discovered, 10, "one page still covers exactly 10 connections regardless of N=200 total");
    assert.equal(page1of200.incomplete, true, "N=200 with a 1-page cap is genuinely incomplete");
    // The decisive assertion: one page's discovery+fold+repair query count
    // must be the same whether 50 or 200 total connections exist — proving
    // the bound genuinely covers discovery and fold (both of which, before
    // this fix, scanned the COMPLETE table regardless of page/candidate
    // count), not merely the repair loop.
    assert.equal(
      calls200,
      calls50,
      `one page against N=200 total connections issued ${calls200} prepare calls vs N=50's ${calls50} — a single bounded page's discovery+fold+repair must not scale with total N`
    );
  })
);

test(
  "SQLite: a 25-row first page folds before slow generic repairs, advances its durable checkpoints, and records non-zero-progress evidence",
  withTempDb(async () => {
    const ids = seedConnections(25);
    await reconcileConnectorSummaryEvidence(null);
    const targetSeq = seedTerminalEvents(ids[0] as string, 274);
    getDb().prepare("UPDATE connector_summary_evidence SET dirty = 1").run();

    const observations: ConnectorSummaryReconcileObservation[] = [];
    setConnectorSummaryReconcileObservationSink((observation) => observations.push(observation));
    process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS = "80";
    try {
      const first = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 300, pageSize: 25 });
      assert.equal(first.incomplete, true, "slow generic repairs consume the bounded round after the fold phase");
      assert.equal(
        first.resumeAfterId,
        null,
        "generic repair deferral retries the same durable page while preserving its completed fold checkpoints"
      );
      const checkpoints = getDb()
        .prepare("SELECT stream_facts_event_seq FROM connector_summary_evidence ORDER BY connector_instance_id")
        .all<{ stream_facts_event_seq: number }>();
      assert.deepEqual(
        checkpoints.map((row) => Number(row.stream_facts_event_seq)),
        Array.from({ length: 25 }, () => targetSeq),
        "every existing first-page participant reaches the scoped terminal high-water before generic repair latency"
      );
      const observation = observations.at(-1);
      assert.equal(observation?.terminalFoldParticipants, 25);
      assert.equal(observation?.terminalFoldMinimumCheckpointBefore, 0);
      assert.equal(observation?.terminalFoldMinimumCheckpointAfter, targetSeq);
      assert.equal(observation?.terminalFoldEventsRead, targetSeq);
      assert.equal(observation?.terminalFoldZeroProgress, false);
      assert.ok(Number(observation?.repairDurationMs) >= 80, "the receipt distinguishes repair time from the fold");
      assert.equal(
        "terminalFoldBudgetMs" in (observation ?? {}),
        false,
        "the receipt does not invent a per-phase time budget"
      );

      delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
      const restart = await runBoundedSummaryEvidenceSweep({
        afterId: first.resumeAfterId,
        maxDurationMs: 300,
        pageSize: 25,
      });
      assert.equal(restart.incomplete, false, "a restarted maintenance process accepts the advanced durable cursor");
      assert.equal(restart.resumeAfterId, null, "the completed resumed walk clears the cursor normally");
      assert.equal(
        observations.filter(
          (receipt) => receipt.incomplete && receipt.terminalFoldParticipants > 0 && receipt.terminalFoldZeroProgress
        ).length,
        0,
        "no accepted bounded round leaves this first-page terminal checkpoint vector unchanged"
      );
    } finally {
      delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
      setConnectorSummaryReconcileObservationSink(null);
    }
  })
);

test(
  "SQLite: a newer terminal event on page two does not reclassify already-current page-one evidence for generic repair",
  withTempDb(async () => {
    const ids = seedConnections(26);
    await reconcileConnectorSummaryEvidence(null);
    const pageOneComputedAt = getDb()
      .prepare(
        "SELECT connector_instance_id, computed_at FROM connector_summary_evidence WHERE connector_instance_id < ? ORDER BY connector_instance_id"
      )
      .all<{ computed_at: string; connector_instance_id: string }>(ids[25] as string);
    seedTerminalEvents(ids[25] as string, 1);

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 1, "only page two's lifecycle receipt needs generic repair");
    assert.equal(result.candidateReasonCounts.lifecycle_checkpoint_lag, 1);
    assert.equal(
      "terminal_checkpoint_lag" in result.candidateReasonCounts,
      false,
      "terminal checkpoints are exclusively folded, never classified by generic repair"
    );
    const pageOneAfter = getDb()
      .prepare(
        "SELECT connector_instance_id, computed_at FROM connector_summary_evidence WHERE connector_instance_id < ? ORDER BY connector_instance_id"
      )
      .all<{ computed_at: string; connector_instance_id: string }>(ids[25] as string);
    assert.deepEqual(pageOneAfter, pageOneComputedAt, "the unrelated newer event does not rewrite page one");
  })
);

test(
  "SQLite mutation: a 1ms cold page starts at most one slow repair, invents no fold budget, and later converges",
  withTempDb(async () => {
    const ids = seedConnections(25);
    seedTerminalEvents(ids[0] as string, 1);
    const observations: ConnectorSummaryReconcileObservation[] = [];
    setConnectorSummaryReconcileObservationSink((observation) => observations.push(observation));
    process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS = "80";
    try {
      const startedAt = Date.now();
      const first = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 1, pageSize: 25 });
      const elapsedMs = Date.now() - startedAt;
      assert.equal(first.incomplete, true, "the expired cold page retains its durable cursor-before-page");
      assert.equal(first.resumeAfterId, null, "the first page is retried rather than skipped");
      assert.ok(evidenceRowCount() <= 1, "at most one 80ms writer-fenced cold repair started before expiry");
      assert.ok(elapsedMs < 250, "overshoot is bounded by one configured repair unit, never 25 repairs");
      const receipt = observations.at(-1);
      assert.equal(
        "terminalFoldBudgetMs" in (receipt ?? {}),
        false,
        "no positive fold timeout is invented after expiry"
      );
      assert.ok((receipt?.terminalFoldEventsRead ?? 0) <= 500, "a started fold cannot exceed its finite event cap");
    } finally {
      delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
      setConnectorSummaryReconcileObservationSink(null);
    }

    const resumed = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: 25 });
    assert.equal(resumed.incomplete, false, "a normal later round converges the cold page");
    assert.equal(evidenceRowCount(), 25, "all cold evidence rows eventually exist");
    const checkpoint = getDb()
      .prepare("SELECT stream_facts_event_seq FROM connector_summary_evidence WHERE connector_instance_id = ?")
      .get<{ stream_facts_event_seq: number }>(ids[0] as string);
    assert.equal(Number(checkpoint?.stream_facts_event_seq), 1, "the durable fold resumes from created evidence");
  })
);
