// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Gate finding (2026-08-02): dd5f957d5's bounded-sweep fix
 * (connector-summary-evidence-sweep-page-starvation.test.ts) was proven
 * ONLY by calling `runBoundedSummaryEvidenceSweep` directly — it never went
 * through `createResumableConnectorMaintenanceSweep` /
 * `readResumableEvidenceSweepResult`, the ACTUAL wrapper both the periodic
 * timer and the startup multi-round walk use in production
 * (server/index.ts wires `runBoundedSummaryEvidenceSweep` as the
 * `runEvidenceSweep` callback passed to
 * `createResumableConnectorMaintenanceSweep`, and
 * `connectorMaintenanceSweep.runEvidenceSweepRound` as the `runSweep`
 * callback passed to `runStartupSummaryEvidenceSweepToCompletion`).
 *
 * That wrapper's guard (`readResumableEvidenceSweepResult` in
 * connector-maintenance-sweep.ts) rejected the fix's new legitimate shape:
 * a mid-fleet-started call (`currentCursor !== null`, i.e. resuming a prior
 * round) that reaches the true end of keyset order reports
 * `{incomplete: true, resumeAfterId: null}` — a deliberate round-robin
 * WRAP forcing a validation pass, per `runBoundedSummaryEvidenceSweep`'s
 * "clean full pass" contract. The guard's existing rule ("an incomplete
 * `null` cursor resuming from a non-null position is invalid — it would
 * lose known-good progress") could not distinguish that legitimate wrap
 * from a genuinely malformed/fabricated `null`, because `{incomplete,
 * resumeAfterId}` alone carries no such signal. Every real periodic tick
 * or startup round that reached the tail from a resumed (non-null)
 * position threw `"Maintenance evidence sweep returned an invalid
 * resumable result."` — a production-blocking regression neither
 * dd5f957d5's own tests nor the pre-existing wrapper tests (which all use
 * hand-written fake adapters, never the real bounded sweep) could catch.
 *
 * The correction adds `reachedKeysetTail: boolean` to
 * `BoundedSweepResult` — true exactly when THIS call's own page-walk
 * reached the true end of keyset order (regardless of whether every page
 * along the way converged) — and the guard now accepts an incomplete
 * `null` cursor resuming from a non-null position ONLY when the adapter
 * result explicitly asserts `reachedKeysetTail: true`. Without that proof,
 * the exact same rejection as before still applies.
 *
 * This file proves, through the REAL production wrapper (no fake
 * adapters — `createResumableConnectorMaintenanceSweep` wired directly to
 * the real `runBoundedSummaryEvidenceSweep`, and
 * `runStartupSummaryEvidenceSweepToCompletion` imported from
 * server/index.ts, the same functions server/index.ts actually wires
 * together):
 *
 *   1. A mid-fleet reaching-tail round no longer throws — it wraps to
 *      `resumeAfterId: null` cleanly.
 *   2. A genuinely malformed adapter result that would lose non-null
 *      progress (no `reachedKeysetTail` proof) is STILL rejected.
 *   3. The periodic-tick call shape (repeated direct
 *      `runEvidenceSweepRound` calls) converges a real permanently-slow
 *      fleet without ever throwing.
 *   4. The startup call shape (`runStartupSummaryEvidenceSweepToCompletion`
 *      driving `runEvidenceSweepRound` in a bounded multi-round walk)
 *      converges the same fleet without ever throwing.
 *   5. The OLD (pre-correction) guard logic, exercised directly, throws on
 *      the exact legitimate wrap shape — proving the gate's finding was
 *      real and this fix is what closes it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createResumableConnectorMaintenanceSweep } from "../server/connector-maintenance-sweep.ts";
import { runBoundedSummaryEvidenceSweep } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { runStartupSummaryEvidenceSweepToCompletion as runStartupSummaryEvidenceSweepToCompletionUntyped } from "../server/index.ts";

const runStartupSummaryEvidenceSweepToCompletion = runStartupSummaryEvidenceSweepToCompletionUntyped as (args: {
  runSweep: (sweepArgs: {
    afterId?: string | null;
    maxDurationMs?: number;
    pageSize?: number;
  }) => Promise<Record<string, unknown> | null>;
  maxDurationMs?: number;
  pageSize?: number;
  maxRounds?: number;
}) => Promise<Record<string, unknown>[]>;

const NOW = "2026-07-17T00:00:00.000Z";
const INVALID_RESUMABLE_RESULT = /invalid resumable result/;

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-sweep-tail-wrap-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnections(n: number): string[] {
  getDb().prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('c1', '{}', ?)").run(NOW);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `c1_cin_${String(i).padStart(4, "0")}`;
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES (?, 'owner_local', 'c1', 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
      )
      .run(id, id, NOW, NOW);
    ids.push(id);
  }
  return ids;
}

function evidenceRowCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM connector_summary_evidence").get<{ n: number }>();
  assert.ok(row, "evidence count query returns a row");
  return row.n;
}

async function withSustainedSlowRepair<T>(delayMs: number, fn: () => Promise<T>): Promise<T> {
  process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS = String(delayMs);
  try {
    return await fn();
  } finally {
    delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
  }
}

/**
 * The pre-correction guard logic, copied verbatim from
 * connector-maintenance-sweep.ts's `readResumableEvidenceSweepResult`
 * BEFORE this fix (no `reachedKeysetTail` exception) — kept ONLY to prove
 * this specific gate finding was a real regression, not a hypothetical.
 */
function preCorrectionGuard(value: unknown, currentCursor: string | null): unknown {
  if (!(value && typeof value === "object")) {
    return null;
  }
  const result = value as Record<string, unknown>;
  if (typeof result.incomplete !== "boolean") {
    return null;
  }
  if (result.resumeAfterId !== null && typeof result.resumeAfterId !== "string") {
    return null;
  }
  if (!result.incomplete && result.resumeAfterId !== null) {
    return null;
  }
  if (result.incomplete && (result.resumeAfterId === "" || (result.resumeAfterId === null && currentCursor !== null))) {
    return null;
  }
  return { incomplete: result.incomplete, resumeAfterId: result.resumeAfterId as string | null };
}

test(
  "PRE-CORRECTION guard: the exact legitimate tail-wrap shape from a resumed cursor is rejected as malformed",
  withTempDb(() =>
    withSustainedSlowRepair(250, async () => {
      seedConnections(30);
      // Round 1 against the real bounded sweep, resuming from a non-null
      // cursor, whose own walk genuinely reaches the tail — the exact
      // shape the gate found production throwing on.
      const first = await runBoundedSummaryEvidenceSweep({ afterId: null, maxDurationMs: 100, pageSize: 16 });
      assert.ok(first.resumeAfterId, "sanity: the first round leaves a non-null cursor to resume from");
      const second = await runBoundedSummaryEvidenceSweep({
        afterId: first.resumeAfterId,
        maxDurationMs: 100,
        pageSize: 16,
      });
      assert.equal(second.reachedKeysetTail, true, "sanity: the second round's own walk reaches the tail");
      assert.equal(second.resumeAfterId, null, "sanity: the tail-wrap reports a null cursor");

      // The OLD guard, given the REAL bounded-sweep result and the REAL
      // non-null resuming cursor, rejects it — reproducing the gate's
      // exact production-blocking finding.
      const rejected = preCorrectionGuard(second, first.resumeAfterId);
      assert.equal(
        rejected,
        null,
        "the pre-correction guard rejects the legitimate tail-wrap shape as malformed — this is the gate's exact finding"
      );
    })
  )
);

test(
  "production wrapper: a mid-fleet reaching-tail round wraps to null without throwing",
  withTempDb(() =>
    withSustainedSlowRepair(250, async () => {
      seedConnections(30);
      const sweep = createResumableConnectorMaintenanceSweep({
        evidenceSweepMaxDurationMs: 100,
        evidenceSweepPageSize: 16,
        runEvidenceSweep: (args) => runBoundedSummaryEvidenceSweep(args),
      });

      const first = await sweep.runEvidenceSweepRound({ maxDurationMs: 100, pageSize: 16 });
      assert.ok(first, "the first round is admitted (no concurrent lease holder)");
      assert.equal(first?.incomplete, true);
      assert.ok(first?.resumeAfterId, "the first round leaves a non-null durable cursor");

      // The second round resumes from that non-null cursor and — through
      // the REAL wrapper, not a mock — must not throw even when its own
      // walk reaches the tail.
      await assert.doesNotReject(
        () => sweep.runEvidenceSweepRound({ maxDurationMs: 100, pageSize: 16 }),
        "a mid-fleet round reaching the keyset tail must wrap cleanly through the production wrapper, never throw"
      );
    })
  )
);

test(
  "production wrapper: a malformed result that would lose non-null progress is still rejected",
  withTempDb(async () => {
    seedConnections(5);
    const sweep = createResumableConnectorMaintenanceSweep({
      evidenceSweepMaxDurationMs: 60_000,
      evidenceSweepPageSize: 25,
      runEvidenceSweep: () => Promise.resolve({ incomplete: true, resumeAfterId: "cin_keep" }),
    });
    await sweep.runEvidenceSweepRound({ maxDurationMs: 60_000 });

    const malformed = createResumableConnectorMaintenanceSweep({
      evidenceSweepMaxDurationMs: 60_000,
      evidenceSweepPageSize: 25,
      // No `reachedKeysetTail` proof accompanies this null cursor — it
      // must still be rejected exactly like before this fix.
      runEvidenceSweep: () => Promise.resolve({ incomplete: true, resumeAfterId: null }),
    });
    await assert.rejects(
      () => malformed.runEvidenceSweepRound({ maxDurationMs: 60_000 }),
      INVALID_RESUMABLE_RESULT,
      "an incomplete null cursor with no reachedKeysetTail proof, resuming from a non-null position, is still rejected"
    );
  })
);

test(
  "periodic-tick shape: repeated runEvidenceSweepRound calls converge a permanently-slow fleet without ever throwing",
  withTempDb(() =>
    withSustainedSlowRepair(80, async () => {
      const n = 30;
      seedConnections(n);
      const sweep = createResumableConnectorMaintenanceSweep({
        evidenceSweepMaxDurationMs: 100,
        evidenceSweepPageSize: 16,
        runEvidenceSweep: (args) => runBoundedSummaryEvidenceSweep(args),
      });

      let lastResult: Awaited<ReturnType<typeof sweep.runEvidenceSweepRound>> = null;
      for (let tick = 0; tick < 60; tick += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Each simulated periodic tick must observe the previous tick's committed durable cursor.
        lastResult = await sweep.runEvidenceSweepRound({ maxDurationMs: 100, pageSize: 16 });
        if (lastResult && !lastResult.incomplete) {
          break;
        }
      }
      assert.equal(lastResult?.incomplete, false, "the periodic-tick shape genuinely converges within 60 ticks");
      assert.equal(evidenceRowCount(), n, "every connection has a durable evidence row once converged");
    })
  )
);

test(
  "startup shape: runStartupSummaryEvidenceSweepToCompletion driving the real wrapper converges without ever throwing",
  withTempDb(() =>
    withSustainedSlowRepair(80, async () => {
      const n = 30;
      seedConnections(n);
      const sweep = createResumableConnectorMaintenanceSweep({
        evidenceSweepMaxDurationMs: 100,
        evidenceSweepPageSize: 16,
        runEvidenceSweep: (args) => runBoundedSummaryEvidenceSweep(args),
      });

      const rounds = await runStartupSummaryEvidenceSweepToCompletion({
        maxDurationMs: 100,
        maxRounds: 60,
        pageSize: 16,
        runSweep: (args) =>
          sweep.runEvidenceSweepRound({
            ...args,
            maxDurationMs: args.maxDurationMs ?? 100,
          }) as Promise<Record<string, unknown> | null>,
      });

      const last = rounds.at(-1);
      assert.ok(last, "the startup walk ran at least one round");
      assert.equal(last?.incomplete, false, "the startup multi-round walk genuinely converges within its round cap");
      assert.equal(evidenceRowCount(), n, "every connection has a durable evidence row once converged");
    })
  )
);
