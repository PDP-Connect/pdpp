// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the 2026-08-18 production incident: 16
 * connections sat `dirty` behind `summary_evidence_dirty_backstop` forever,
 * with every maintenance-sweep pass reporting
 * `repaired: 0, incomplete: true, duration_ms` 2-3.5x over its 2000ms
 * budget. Root cause: `runScopedConnectorReconciliation`'s `discover(ids)`
 * call is NOT deadline-checked (it is one indivisible batched read, not a
 * per-candidate loop) — a discovery read slow enough to exceed the round's
 * entire budget (contention from unrelated heavy I/O in production) left
 * `Date.now() >= deadline` already true before `repairCandidates`'s loop
 * ever called `repair()` for candidate #1, so EVERY selected candidate was
 * reported `skipped` with zero attempts, every round, forever — the exact
 * backlog-is-stable-not-draining shape observed live (dirty stayed at 16,
 * repaired stayed 0, over a 110s window).
 *
 * The fix (`connector-summary-evidence-bounded-reconciliation.ts`'s
 * `repairCandidates`): the FIRST selected candidate is always attempted
 * regardless of the deadline — a discovery read that already consumed the
 * round's real time must not also forfeit the one repair unit that work
 * was for. Every candidate after the first still obeys the ordinary
 * cooperative-deadline contract.
 *
 * This file proves the fix directly at `runScopedConnectorReconciliation`,
 * the exact call site of the bug, with fake `discover`/`repair`/`prune`
 * callbacks — no real slow query needed to reproduce the failure
 * deterministically.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runScopedConnectorReconciliation } from "../server/connector-summary-evidence-bounded-reconciliation.ts";

type Reason = "dirty";

function fakeRepairSucceeds(repairedIds: Set<string>) {
  return (id: string) => {
    repairedIds.add(id);
    return Promise.resolve({ deferred: false, failed: false, persisted: true, row: { connector_instance_id: id } });
  };
}

test("a discovery read slower than the round's own deadline still lets the round repair its first candidate, not zero", async () => {
  const ids = Array.from({ length: 16 }, (_, i) => `cin_${String(i).padStart(2, "0")}`);
  const candidates = new Map<string, Reason>(ids.map((id) => [id, "dirty" as const]));
  const repairedIds = new Set<string>();

  // The round's deadline is set BEFORE discovery runs, exactly like
  // `reconcileConnectorSummaryEvidence`'s `resolveReconcileDeadline`. A
  // discovery read that takes longer than the whole round's budget (the
  // production shape: one slow, contended, indivisible batched query)
  // means the deadline has ALREADY PASSED by the time discovery returns.
  const deadline = Date.now() + 5;
  const discover = async (requestedIds: readonly string[]) => {
    // Simulate a discovery read slow enough to blow the round's budget —
    // deliberately longer than `deadline - Date.now()` at call time.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(Date.now() >= deadline, "sanity: the round's deadline has genuinely already expired post-discovery");
    return {
      candidates: new Map(requestedIds.map((id) => [id, candidates.get(id) as Reason])),
      instanceRows: requestedIds.map((id) => ({ connector_instance_id: id })),
    };
  };

  const result = await runScopedConnectorReconciliation<{ connector_instance_id: string }, Reason, unknown>({
    candidateReasons: undefined,
    connectorInstanceIds: ids,
    deadline,
    discover,
    maxCandidates: undefined,
    prune: async () => 0,
    repair: fakeRepairSucceeds(repairedIds),
  });

  assert.equal(
    result.repaired,
    1,
    "the round repairs exactly its first candidate even though the deadline expired during discovery — the bug reported repaired: 0 here, forever"
  );
  assert.equal(result.skipped, 15, "the remaining 15 candidates are genuinely deferred to a later round, not lost");
  assert.equal(result.candidatesInspected, 16, "discovery still classified the complete requested scope");
});

test("a dirty backlog LARGER than one pass can drain converges across repeated passes, never stalling at a fixed repaired: 0", async () => {
  const ids = Array.from({ length: 16 }, (_, i) => `cin_${String(i).padStart(2, "0")}`);
  const dirty = new Set(ids);
  const repairedOrder: string[] = [];

  async function runOnePass(): Promise<{ repaired: number; skipped: number }> {
    const remaining = ids.filter((id) => dirty.has(id));
    const candidates = new Map<string, Reason>(remaining.map((id) => [id, "dirty" as const]));
    // Every pass's discovery is slow enough to consume the ENTIRE 2000ms
    // maintenance-sweep budget on its own (the production shape) —
    // modeled here as a deadline that has already elapsed by the time
    // `discover` returns, on every single pass, not just the first.
    const deadline = Date.now();
    const discover = async (requestedIds: readonly string[]) => ({
      candidates: new Map(requestedIds.filter((id) => candidates.has(id)).map((id) => [id, "dirty" as const])),
      instanceRows: requestedIds.map((id) => ({ connector_instance_id: id })),
    });
    const result = await runScopedConnectorReconciliation<{ connector_instance_id: string }, Reason, unknown>({
      candidateReasons: undefined,
      connectorInstanceIds: remaining,
      deadline,
      discover,
      maxCandidates: undefined,
      prune: async () => 0,
      repair: (id: string) => {
        repairedOrder.push(id);
        dirty.delete(id);
        return Promise.resolve({
          deferred: false,
          failed: false,
          persisted: true,
          row: { connector_instance_id: id },
        });
      },
    });
    return { repaired: result.repaired, skipped: result.skipped };
  }

  let passes = 0;
  const maxPasses = 32;
  while (dirty.size > 0 && passes < maxPasses) {
    // biome-ignore lint/performance/noAwaitInLoops: Each pass must observe the previous pass's durable progress before deciding whether another pass is needed.
    const { repaired } = await runOnePass();
    assert.ok(
      repaired >= 1,
      `pass ${passes} made zero repair progress with ${dirty.size} candidates still dirty — the backlog cannot converge`
    );
    passes += 1;
  }

  assert.equal(dirty.size, 0, `the backlog must fully drain; ${dirty.size} candidates never repaired`);
  assert.equal(passes, ids.length, "each pass under a permanently-expired deadline repairs exactly one candidate");
  assert.deepEqual(
    repairedOrder,
    ids,
    "candidates drain in the order discovery returned them, one guaranteed repair per pass"
  );
});
