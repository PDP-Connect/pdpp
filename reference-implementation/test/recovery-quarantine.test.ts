// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-item recovery quarantine + crash-honest attempt accounting.
 *
 * OpenSpec `add-connector-neutral-recovery-governor`:
 *   - task 1.6  - per-item quarantine helpers and tests: a poison item reaches
 *     its per-item threshold, is quarantined with evidence and a terminal class,
 *     remains visible in accounting, and siblings keep draining.
 *   - task 2.5  - idempotency + crash-accounting: a re-attempt after an
 *     interrupted attempt does not duplicate records; interrupted attempts count
 *     and repeated interruption escalates to a connector/system issue.
 *   - runtime part of task 3.4 - repeated transient no-progress becomes a durable
 *     connector/system issue rather than owner retry busywork.
 *
 * The pure decision (`evaluateQuarantine`) has no store; the effectful wrapper
 * (`maybeQuarantineGap`) mirrors `maybeTerminateGap` and terminalizes via the
 * existing durable `terminal` status with a distinct `quarantined` class. The
 * recovery-decision classifier routes `quarantined` to `connector_defect` /
 * `system_issue` (no owner retry).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyRecoveryGap, classifyRecoveryReason, resolveRecoveryAdmission } from "../runtime/recovery-decision.ts";
import { DEFAULT_QUARANTINE_POLICY, evaluateQuarantine, QUARANTINE_CLASS } from "../runtime/recovery-quarantine.ts";
import { closeDb, initDb } from "../server/db.ts";
import { createSqliteConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import { maybeQuarantineGap } from "../server/stores/terminal-gap-classifier.ts";

test("evaluateQuarantine: item under its no-progress budget is not quarantined", () => {
  const decision = evaluateQuarantine({ attempt_count: 3, status: "pending" }, { maxNoProgressAttempts: 8 });
  assert.equal(decision.quarantine, false);
  assert.equal(decision.reason, "under_budget");
});

test("evaluateQuarantine: item at its no-progress budget is quarantined with the crossing evidence", () => {
  const decision = evaluateQuarantine({ attempt_count: 8, status: "pending" }, { maxNoProgressAttempts: 8 });
  assert.equal(decision.quarantine, true);
  assert.equal(decision.attemptCount, 8);
  assert.equal(decision.threshold, 8);
});

test("evaluateQuarantine: recovered / terminal items are never quarantined (recovery already concluded)", () => {
  assert.deepEqual(evaluateQuarantine({ attempt_count: 99, status: "recovered" }, { maxNoProgressAttempts: 2 }), {
    quarantine: false,
    reason: "recovered",
  });
  assert.deepEqual(evaluateQuarantine({ attempt_count: 99, status: "terminal" }, { maxNoProgressAttempts: 2 }), {
    quarantine: false,
    reason: "already_terminal",
  });
});

test("evaluateQuarantine: a finite positive budget is mandatory - a poison item can never opt out", () => {
  assert.throws(() => evaluateQuarantine({ attempt_count: 1, status: "pending" }, { maxNoProgressAttempts: 0 }));
  assert.throws(() => Reflect.apply(evaluateQuarantine, undefined, [{ attempt_count: 1, status: "pending" }, {}]));
  assert.throws(() => evaluateQuarantine({ attempt_count: 1, status: "pending" }, { maxNoProgressAttempts: -1 }));
});

test("DEFAULT_QUARANTINE_POLICY is a finite positive integer budget", () => {
  assert.ok(
    Number.isInteger(DEFAULT_QUARANTINE_POLICY.maxNoProgressAttempts) &&
      DEFAULT_QUARANTINE_POLICY.maxNoProgressAttempts > 0
  );
});

test("a quarantined gap classifies as connector_defect and is denied as a system_issue (no owner retry)", () => {
  const row = {
    attempt_count: 8,
    connector_id: "amazon",
    connector_instance_id: "amazon:default",
    reason: QUARANTINE_CLASS,
    status: "terminal",
    stream: "order_items",
  };
  assert.equal(classifyRecoveryGap(row).recoveryClass, "connector_defect");
  const admission = resolveRecoveryAdmission(row);
  assert.equal(admission.ok, false);
  assert.equal(admission.reason, "system_issue");
});

test("quarantine gate: planned run-cap and provider-pressure re-defers are NOT quarantine-eligible; no-progress classes are", () => {
  const eligible = (reason: string | null) => {
    const c = classifyRecoveryReason(reason);
    return c !== "run_cap_deferred" && c !== "provider_pressure" && c !== "owner_required" && c !== "informational";
  };
  assert.equal(eligible("run_cap_deferred"), false);
  assert.equal(eligible("rate_limited"), false);
  assert.equal(eligible("upstream_pressure"), false);
  assert.equal(eligible("auth_failure"), false);
  assert.equal(eligible("out_of_scope"), false);
  assert.equal(eligible("temporary_unavailable"), true);
  assert.equal(eligible("retry_exhausted"), true);
  assert.equal(eligible(null), true, "unknown/absent reason is treated as generic no-progress recovery work");
});

function withTempDb(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-recovery-quarantine-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn(dir);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

const CONNECTOR_INSTANCE_ID = "amazon:default";

async function seedGap(
  store: ReturnType<typeof createSqliteConnectorDetailGapStore>,
  recordKey: string,
  overrides: Record<string, unknown> = {}
) {
  const gap = await store.upsertPendingGap({
    connectorId: "amazon",
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    detailLocator: { kind: "amazon.order", order_id: recordKey },
    grantId: "grant_test",
    reason: "temporary_unavailable",
    recordKey,
    stream: "order_items",
    ...overrides,
  });
  assert.ok(gap);
  return gap;
}

function quarantineStore(
  store: ReturnType<typeof createSqliteConnectorDetailGapStore>
): Parameters<typeof maybeQuarantineGap>[0] {
  return {
    getGapById: async (gapId) => {
      const gap = await store.getGapById(gapId);
      return gap ? { ...gap, attempt_count: gap.attempt_count } : null;
    },
    markGapStatus: async (gapId, status, options) => {
      const gap = await store.markGapStatus(gapId, status, options);
      return gap ? { ...gap, attempt_count: gap.attempt_count } : null;
    },
  };
}

function evidenceRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected evidence object");
  }
  return value as Record<string, unknown>;
}

test(
  "maybeQuarantineGap: poison item reaches its per-item threshold -> terminal quarantined with evidence, still counted",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const gap = await seedGap(store, "order_poison");
    const policy = { maxNoProgressAttempts: 3 };

    await store.markGapStatus(gap.gap_id, "in_progress");
    await store.markGapStatus(gap.gap_id, "pending");
    await store.markGapStatus(gap.gap_id, "in_progress");
    const qStore = quarantineStore(store);
    let outcome = await maybeQuarantineGap(qStore, gap.gap_id, { failure_class: "transient_no_progress" }, policy);
    assert.equal(outcome.quarantined, false, "below budget: not quarantined");
    await store.markGapStatus(gap.gap_id, "pending");
    assert.equal(
      (
        await store.listPendingGaps({
          connectorId: "amazon",
          connectorInstanceId: CONNECTOR_INSTANCE_ID,
          grantId: "grant_test",
        })
      ).length,
      1,
      "still fillable while under budget"
    );

    await store.markGapStatus(gap.gap_id, "in_progress");
    outcome = await maybeQuarantineGap(qStore, gap.gap_id, { failure_class: "transient_no_progress" }, policy);
    assert.equal(outcome.quarantined, true, "budget crossed: quarantined");

    const quarantined = outcome.gap;
    assert.ok(quarantined);
    const lastError = evidenceRecord(quarantined.last_error);
    assert.equal(quarantined.status, "terminal", "quarantine uses the durable terminal status");
    assert.equal(quarantined.reason, QUARANTINE_CLASS, "durable class the classifier reads is `quarantined`");
    assert.equal(lastError.class, "quarantined", "evidence trail carries the quarantine class");
    assert.equal(lastError.attempt_count, 3, "evidence records the crossing attempt count");
    assert.equal(lastError.failure_class, "transient_no_progress", "evidence preserves the connector signal");

    assert.equal(
      await store.countGapsByStatusForConnector("amazon", { status: "terminal" }),
      1,
      "quarantined item is counted"
    );
    assert.equal(
      (
        await store.listPendingGaps({
          connectorId: "amazon",
          connectorInstanceId: CONNECTOR_INSTANCE_ID,
          grantId: "grant_test",
        })
      ).length,
      0,
      "not in fillable-pending"
    );
  })
);

test(
  "maybeQuarantineGap: a poison item does not block its siblings - siblings keep draining",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const poison = await seedGap(store, "order_poison");
    await seedGap(store, "order_healthy_a");
    await seedGap(store, "order_healthy_b");
    const policy = { maxNoProgressAttempts: 2 };

    await store.markGapStatus(poison.gap_id, "in_progress");
    await store.markGapStatus(poison.gap_id, "in_progress");
    const outcome = await maybeQuarantineGap(
      quarantineStore(store),
      poison.gap_id,
      { failure_class: "parse_missing" },
      policy
    );
    assert.equal(outcome.quarantined, true);

    const pending = await store.listPendingGaps({
      connectorId: "amazon",
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      grantId: "grant_test",
    });
    // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
    const keys = pending.map((g) => g.record_key).sort();
    assert.deepEqual(
      keys,
      ["order_healthy_a", "order_healthy_b"],
      "siblings keep draining; poison item quarantined out"
    );

    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const sibling = pending[0];
    assert.ok(sibling);
    await store.markGapStatus(sibling.gap_id, "recovered", { runId: "run_ok" });
    assert.equal(await store.countGapsByStatusForConnector("amazon", { status: "recovered" }), 1);
    assert.equal(await store.countGapsByStatusForConnector("amazon", { status: "terminal" }), 1);
  })
);

test(
  "maybeQuarantineGap: quarantine is sticky - re-upsert does not revive a quarantined item",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const gap = await seedGap(store, "order_sticky");
    const policy = { maxNoProgressAttempts: 1 };

    await store.markGapStatus(gap.gap_id, "in_progress");
    await maybeQuarantineGap(quarantineStore(store), gap.gap_id, null, policy);
    assert.equal(await store.countGapsByStatusForConnector("amazon", { status: "terminal" }), 1);

    await seedGap(store, "order_sticky");
    assert.equal(
      (
        await store.listPendingGaps({
          connectorId: "amazon",
          connectorInstanceId: CONNECTOR_INSTANCE_ID,
          grantId: "grant_test",
        })
      ).length,
      0,
      "quarantined item not revived"
    );
    assert.equal(await store.countGapsByStatusForConnector("amazon", { status: "terminal" }), 1);

    const again = await maybeQuarantineGap(quarantineStore(store), gap.gap_id, null, policy);
    assert.equal(again.quarantined, false, "terminal is sticky; no double-quarantine");
  })
);

test(
  "interrupted explicit attempts survive expired-lease reclaim",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const gap = await seedGap(store, "order_crash");

    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let i = 0; i < 3; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.claimPendingGaps([gap.gap_id], {
        leaseExpiresAt: "2020-01-01T00:00:00.000Z",
        leaseId: `crashed_lease_${i}`,
        runId: `crashed_run_${i}`,
      });
      await store.markLeasedGapAttempt({ gapId: gap.gap_id, leaseId: `crashed_lease_${i}`, runId: `crashed_run_${i}` });
      await store.reclaimStrandedInProgressGaps({
        connectorId: "amazon",
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        currentRunId: `later_run_${i}`,
        grantId: "grant_test",
      });
    }

    const after = await store.getGapById(gap.gap_id);
    assert.ok(after);
    assert.equal(after.status, "pending", "reclaimed back to pending for the next attempt");
    assert.equal(after.attempt_count, 3, "each explicit interrupted attempt is retained");
  })
);

test(
  "repeated interruption escalates to quarantine exactly like repeated deterministic failure",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const gap = await seedGap(store, "order_crashloop");
    const policy = { maxNoProgressAttempts: 3 };

    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let i = 0; i < policy.maxNoProgressAttempts; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.markGapStatus(gap.gap_id, "in_progress");
      await store.markGapStatus(gap.gap_id, "pending");
    }

    const outcome = await maybeQuarantineGap(
      quarantineStore(store),
      gap.gap_id,
      { failure_class: "interrupted" },
      policy
    );
    assert.equal(outcome.quarantined, true, "a crash loop converges to a connector/system issue, not infinite retry");
    assert.ok(outcome.gap);
    assert.equal(outcome.gap.reason, QUARANTINE_CLASS);
  })
);

test(
  "record emission is idempotent on durable identity: re-emitting the same key does not create a duplicate row",
  withTempDb(async () => {
    const { getDb } = await import("../server/db.ts");
    const { ingestRecord } = await import("../server/records.ts");
    const connectorId = "https://test.pdpp.dev/connectors/amazon";
    const stream = "order_items";
    const record = {
      data: { id: "order_dup", total: "10.00" },
      emitted_at: "2026-07-06T00:00:00.000Z",
      key: "order_dup",
      op: "upsert" as const,
      stream,
    };

    const first = await ingestRecord(connectorId, record);
    assert.equal(first.changed, true, "first emit writes the record");

    const second = await ingestRecord(connectorId, record);
    assert.equal(second.changed, false, "byte-identical re-emit is a no-op, not a second row");

    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM records WHERE connector_id = ? AND stream = ? AND record_key = ?")
      .get(connectorId, stream, "order_dup");
    assert.ok(row, "idempotent record query returns a count row");
    assert.equal(row.n, 1, "re-attempt must not produce a duplicate record visible to reads");
  })
);
