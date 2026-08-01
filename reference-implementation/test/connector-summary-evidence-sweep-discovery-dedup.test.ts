// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live symptom (2026-08-01, live 53c8f155a/f1dfcf7e3/b3f492f74/b572603b6
 * deployed): after the round-robin fairness fix, `list_summary_projection_state`
 * still went stale for 163s+ on a live/active connection (`peregrine Claude
 * Code`), exceeding the accepted 120s two-turn bound. Live logs showed a
 * SINGLE bounded page never converges within one 60s tick on an active
 * fleet — `repair_duration_ms` routinely 1.4-2.6s against the 2000ms shared
 * deadline — even when `candidate_reason_counts` is empty or has just one
 * entry, with `incomplete: true` reported almost every tick.
 *
 * Root cause: `runBoundedObservationPhases` (connector-summary-read-model.ts)
 * runs the `missing` repair phase and the `generic` repair phase as two
 * SEPARATE calls into `reconcileConnectorSummaryEvidence`, and each call
 * independently paid its own full `discoverCandidates` round-trip against
 * the page's ids — two complete discovery scans per page, every tick,
 * regardless of how many (if any) candidates either phase finds. On a live
 * connection whose evidence dirties faster than the page's own 60-120s
 * round-robin turn, this doubled discovery cost was frequently enough on
 * its own to exhaust the page's 2000ms deadline before repair work
 * finished, `skip`-ping a newly-dirtied candidate — deferred a full extra
 * round-robin turn with no rewind protection (`skipped`, unlike `starved`,
 * does not rewind the sweep cursor; see `resolveBoundedSweepOutcome`).
 *
 * Fix: `missing` and `GENERIC_REPAIR_CANDIDATE_REASONS` are mutually
 * exclusive per row (`classifyCandidate` returns exactly one reason,
 * `missing` first when no evidence row exists yet), so both phases can
 * safely share ONE discovery pass per page
 * (`reconcileConnectorSummaryEvidence`'s new `precomputedDiscovery` option).
 *
 * This test proves discovery now runs exactly once per bounded page via
 * `testOnlyDiscoverCandidatesCallCounter` — a plain call counter, not SQL
 * query-count instrumentation. `Database.prototype.prepare` patching (the
 * technique `connector-summary-evidence-bounded-sweep.test.ts` uses for its
 * N-slope proof) does not reliably observe the repair loop's own prepared
 * statements in this test harness, so it cannot isolate discovery's own
 * call count from a page that also does real repair work — verified by
 * direct inline instrumentation showing `0` intercepted calls for a
 * `reconcileConnectorSummaryEvidence` invocation that indisputably
 * performed 5 real repairs. A direct counter has no such blind spot.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverCandidates,
  reconcileConnectorSummaryEvidence,
  testOnlyDiscoverCandidatesCallCounter,
} from "../server/connector-summary-evidence-engine.ts";
import { runBoundedSummaryEvidenceSweep } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-07-17T00:00:00.000Z";

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-sweep-discovery-dedup-"));
    testOnlyDiscoverCandidatesCallCounter.count = 0;
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

test(
  "a bounded page with candidates in BOTH the missing and generic phases calls discoverCandidates exactly once, not twice",
  withTempDb(async () => {
    // Half the page is genuinely `missing` (no evidence row yet), half is
    // genuinely `dirty` (a generic candidate) — both repair phases do real
    // work this call, matching the live shape where an active connection
    // has ordinary generic churn on the same page as a cold connection.
    const ids = seedConnections(10);
    const dirtyIds = ids.slice(0, 5);
    await reconcileConnectorSummaryEvidence(dirtyIds);
    for (const id of dirtyIds) {
      getDb().prepare("UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id = ?").run(id);
    }
    // The other 5 ids never had reconcileConnectorSummaryEvidence run for
    // them, so they have no connector_summary_evidence row at all: genuine
    // `missing` candidates.
    testOnlyDiscoverCandidatesCallCounter.count = 0;

    const result = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, maxPages: 1, pageSize: 10 });

    assert.equal(result.discovered, ids.length, "the page covered every seeded connection");
    assert.equal(result.repaired, ids.length, "every candidate in both phases was actually repaired this call");
    assert.equal(
      testOnlyDiscoverCandidatesCallCounter.count,
      1,
      "the missing and generic repair phases must share ONE discovery pass per page, not one each — the live 2026-08-01 fairness gap this closes"
    );
  })
);

test(
  "a bounded page with candidates in only ONE phase still calls discoverCandidates exactly once",
  withTempDb(async () => {
    // Every row already fresh/current except one dirty (generic-only) row —
    // `missing`'s phase finds nothing, `generic`'s phase finds one
    // candidate. Proves the shared-discovery fix holds even when only one
    // phase has real work (the common live case: one connection's ordinary
    // dirty churn on an otherwise-clean page).
    const ids = seedConnections(10);
    await reconcileConnectorSummaryEvidence(null);
    getDb().prepare("UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id = ?").run(ids[0]);
    testOnlyDiscoverCandidatesCallCounter.count = 0;

    const result = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, maxPages: 1, pageSize: 10 });

    assert.equal(result.discovered, ids.length, "the page covered every seeded connection");
    assert.equal(result.repaired, 1, "exactly the one dirty candidate was repaired");
    assert.equal(
      testOnlyDiscoverCandidatesCallCounter.count,
      1,
      "discovery ran once even though only the generic phase had a candidate to repair"
    );
  })
);

test(
  "reconcileConnectorSummaryEvidence's precomputedDiscovery option skips its own discoverCandidates call entirely",
  withTempDb(async () => {
    const ids = seedConnections(5);
    await reconcileConnectorSummaryEvidence(null);
    getDb().prepare("UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id = ?").run(ids[0]);

    testOnlyDiscoverCandidatesCallCounter.count = 0;
    const discovery = await discoverCandidates(ids);
    assert.equal(testOnlyDiscoverCandidatesCallCounter.count, 1, "the explicit discovery call itself counts once");

    const result = await reconcileConnectorSummaryEvidence(ids, {
      candidateReasons: ["dirty", "identity_mismatch", "manifest_mismatch", "record_checkpoint_mismatch"],
      precomputedDiscovery: discovery,
    });

    assert.equal(result.repaired, 1, "the one dirty candidate was genuinely repaired via the reused discovery");
    assert.equal(
      testOnlyDiscoverCandidatesCallCounter.count,
      1,
      "reconcileConnectorSummaryEvidence must not call discoverCandidates again when precomputedDiscovery is supplied"
    );
  })
);

test(
  "reconcileConnectorSummaryEvidence still calls discoverCandidates when precomputedDiscovery is omitted (no regression for existing callers)",
  withTempDb(async () => {
    const ids = seedConnections(5);
    testOnlyDiscoverCandidatesCallCounter.count = 0;

    const result = await reconcileConnectorSummaryEvidence(ids);

    assert.equal(result.repaired, ids.length, "every missing row was repaired");
    assert.equal(
      testOnlyDiscoverCandidatesCallCounter.count,
      1,
      "an ordinary call with no precomputedDiscovery still discovers exactly once, unchanged from before this fix"
    );
  })
);
