// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Scoped-consumer query bounds
 * (openspec/changes/reconcile-active-summary-evidence/design.md "Central
 * consumer and cache boundary" / the reconcile-summary-evidence follow-up
 * closing the "scoped consumers always run a complete census" defect).
 *
 * `connector-summary-evidence-engine-n-slope.test.js` already proves the
 * engine's own COMPLETE (`null`) census is a fixed small query count
 * regardless of N. This file proves the DIFFERENT, previously-unproven
 * property: a CONSUMER that already knows exactly which one connection it
 * needs —
 *
 *   1. `reconcileConnectorSummaryEvidence([oneId])` (the read model's now-
 *      threaded scope, and `ref-control.ts`'s `getConnectorSummaryForRoute`
 *      path that calls it under the hood) issues a query count that does
 *      NOT grow with N, the total number of OTHER unrelated connections in
 *      the database — only with the size of the requested scope itself.
 *   2. The scoped discovery phase issues a FIXED, small number of queries
 *      for K requested ids — proving Part 2's batching (one `IN (...)`
 *      query per table, not one query PER requested id) — by comparing
 *      K=5 against K=15 and asserting the count does not scale with K.
 *   3. A scoped call for connection A never reads (and never repairs) a
 *      sibling connection B's evidence row, even when B also has a pending
 *      repair candidate — proving the scoping is genuinely narrow, not
 *      merely "narrow at the instance-row level but still touches every
 *      other table completely."
 *
 * Query-counting methodology: install instrumentation before database
 * initialization, wrap every real statement returned by the raw
 * better-sqlite3 prototype, and count statement executions plus rows read.
 * This observes cache hits as well as misses and resets only after complete
 * warm-up. It measures query work, not prepared-statement cache accidents.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import Database from "better-sqlite3";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { getConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { getConnectorSummaryForRoute } from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const NOW = "2026-07-17T00:00:00.000Z";

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-scoped-consumer-"));
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
    const id = `${connectorId}_cin_${i}`;
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

interface SqliteReadMetrics {
  readonly executions: number;
  readonly maxRows: number;
  readonly rows: number;
}

async function withSqliteReadMetrics<T>(
  fn: (reset: () => void, read: () => SqliteReadMetrics) => Promise<T>
): Promise<T> {
  let executions = 0;
  let rows = 0;
  let maxRows = 0;
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function patchedPrepare(this: InstanceType<typeof Database>, sql: string) {
    const statement = original.call<InstanceType<typeof Database>, [string], ReturnType<typeof original>>(this, sql);
    return new Proxy(statement, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver);
        if (property === "all") {
          return (...args: unknown[]) => {
            const result = Reflect.apply(method as (...values: unknown[]) => unknown, target, args) as unknown[];
            executions += 1;
            rows += result.length;
            maxRows = Math.max(maxRows, result.length);
            return result;
          };
        }
        if (property === "get") {
          return (...args: unknown[]) => {
            const result = Reflect.apply(method as (...values: unknown[]) => unknown, target, args);
            executions += 1;
            rows += result === undefined ? 0 : 1;
            maxRows = Math.max(maxRows, result === undefined ? 0 : 1);
            return result;
          };
        }
        if (property === "iterate") {
          return (...args: unknown[]) => {
            const iterator = Reflect.apply(
              method as (...values: unknown[]) => unknown,
              target,
              args
            ) as Iterable<unknown>;
            return (function* () {
              let yielded = 0;
              for (const row of iterator) {
                yielded += 1;
                rows += 1;
                yield row;
              }
              executions += 1;
              maxRows = Math.max(maxRows, yielded);
            })();
          };
        }
        return typeof method === "function" ? method.bind(target) : method;
      },
    });
  } as typeof original;
  try {
    return await fn(
      () => {
        executions = 0;
        rows = 0;
        maxRows = 0;
      },
      () => ({ executions, maxRows, rows })
    );
  } finally {
    Database.prototype.prepare = original;
  }
}

test("scoped reconcile for one connection issues a query count independent of N other unrelated connections", async () =>
  withSqliteReadMetrics(async (reset, read) => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-scoped-consumer-measured-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      // N=1: one unrelated connection plus the one connection under test.
      seedConnections(1, { connectorId: "unrelated" });
      const [targetIn1] = seedConnections(1, { connectorId: "target" });
      assert.ok(targetIn1, "seedConnections(1, ...) must return exactly one id");
      await reconcileConnectorSummaryEvidence(null); // warm: create both rows
      reset();
      await reconcileConnectorSummaryEvidence([targetIn1]);
      const read1 = read();

      closeDb();
      const dir25 = mkdtempSync(join(tmpdir(), "pdpp-scoped-consumer-25-"));
      initDb(join(dir25, "pdpp.sqlite"));
      // N=25: twenty-five unrelated connections plus the SAME one connection under test.
      seedConnections(25, { connectorId: "unrelated" });
      const [targetIn25] = seedConnections(1, { connectorId: "target" });
      assert.ok(targetIn25, "seedConnections(1, ...) must return exactly one id");
      await reconcileConnectorSummaryEvidence(null); // warm: create all 26 rows
      reset();
      const steadyState25 = await reconcileConnectorSummaryEvidence([targetIn25]);
      const read25 = read();
      rmSync(dir25, { force: true, recursive: true });

      assert.equal(steadyState25.repaired, 0, "fixture premise: the one scoped connection is already current");
      assert.equal(steadyState25.discovered, 1, "scoped discovery reads exactly the one requested connection");
      // A complete-table scan would read 26 rows here while the one-id scope
      // must read the same bounded result shape as the one-unrelated fixture.
      assert.ok(
        read25.rows === read1.rows && read25.maxRows <= read1.maxRows,
        `scoped read work grew with unrelated fleet size: N=1 ${JSON.stringify(read1)}, N=25 ${JSON.stringify(read25)}`
      );
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  }));

test("scoped discovery issues a fixed query count for K requested ids, not one query per id (Part 2 batching)", async () =>
  withSqliteReadMetrics(async (reset, read) => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-scoped-consumer-k5-measured-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      const idsK5 = seedConnections(5, { connectorId: "batch" });
      await reconcileConnectorSummaryEvidence(null); // warm
      reset();
      await reconcileConnectorSummaryEvidence(idsK5);
      const readK5 = read();

      closeDb();
      const dir15 = mkdtempSync(join(tmpdir(), "pdpp-scoped-consumer-k15-"));
      initDb(join(dir15, "pdpp.sqlite"));
      const idsK15 = seedConnections(15, { connectorId: "batch" });
      await reconcileConnectorSummaryEvidence(null); // warm
      reset();
      const steadyStateK15 = await reconcileConnectorSummaryEvidence(idsK15);
      const readK15 = read();
      rmSync(dir15, { force: true, recursive: true });

      assert.equal(steadyStateK15.repaired, 0, "fixture premise: all K=15 requested connections are already current");
      assert.equal(steadyStateK15.discovered, 15);
      // A point-query implementation would execute once per requested id;
      // batched IN(...) discovery keeps execution count fixed as K grows.
      assert.ok(
        readK15.executions === readK5.executions,
        `K=15 scoped discovery executed ${readK15.executions} reads vs K=5's ${readK5.executions} — batched IN(...) discovery must not scale with K`
      );
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  }));

test(
  "a scoped reconcile for connection A does not read or repair sibling connection B, even when B also needs repair",
  withTempDb(async () => {
    const manifest = {
      capabilities: { public_listing: { tier: "supported" } },
      connector_id: "c1",
      display_name: "Sibling Isolation Test Connector",
      protocol_version: "0.1.0",
      streams: [{ name: "messages", primary_key: ["id"] }],
      version: "1.0.0",
    };
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
      .run("c1", JSON.stringify(manifest), NOW);
    const store = createSqliteConnectorInstanceStore();
    await store.upsert({
      connectorId: "c1",
      connectorInstanceId: "cin_a",
      createdAt: NOW,
      displayName: "A",
      ownerSubjectId: "owner_local",
      sourceBinding: {},
      sourceBindingKey: "a",
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });
    await store.upsert({
      connectorId: "c1",
      connectorInstanceId: "cin_b",
      createdAt: NOW,
      displayName: "B",
      ownerSubjectId: "owner_local",
      sourceBinding: {},
      sourceBindingKey: "b",
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });
    // Warm: create both evidence rows.
    await reconcileConnectorSummaryEvidence(null);
    const bBeforeScopedCall = await getConnectorSummaryEvidence("cin_b");
    assert.ok(bBeforeScopedCall, "fixture premise: B has an evidence row before the scoped call");
    const bComputedAtBefore = bBeforeScopedCall.computed_at;

    // Dirty BOTH A and B so both are genuine repair candidates.
    getDb()
      .prepare("UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id IN ('cin_a', 'cin_b')")
      .run();

    // Scoped reconcile for A ONLY.
    const result = await reconcileConnectorSummaryEvidence(["cin_a"]);
    assert.equal(result.discovered, 1, "scoped discovery reads exactly the requested connection, not B");
    assert.equal(result.repaired, 1, "scoped repair touches exactly the requested connection");

    const bAfterScopedCall = await getConnectorSummaryEvidence("cin_b");
    assert.ok(bAfterScopedCall, "B must still have an evidence row after the scoped call for A");
    assert.equal(
      bAfterScopedCall.dirty,
      true,
      "B's dirty flag must remain set — a scoped call for A must not silently repair or clean B"
    );
    assert.equal(
      bAfterScopedCall.computed_at,
      bComputedAtBefore,
      "B's evidence row must be byte-identical after a scoped call for A — the scoped call never touched B"
    );

    // Prove the SAME non-intersection through the real HTTP-facing consumer
    // path (getConnectorSummaryForRoute -> loadConnectorSummaryProjectionDeps
    // scoped -> reconcileDirtyConnectorSummaryEvidence scoped), not just the
    // engine primitive directly.
    const summaryA = await getConnectorSummaryForRoute("cin_a");
    assert.ok(summaryA, "getConnectorSummaryForRoute resolves the requested connection");
    const bAfterRouteCall = await getConnectorSummaryEvidence("cin_b");
    assert.ok(bAfterRouteCall, "B must still have an evidence row after getConnectorSummaryForRoute for A");
    assert.equal(
      bAfterRouteCall.dirty,
      true,
      "B must still read dirty after getConnectorSummaryForRoute('cin_a') — the consumer-facing scoped route must not touch B"
    );
  })
);

test(
  "a deferred scoped candidate is counted as skipped, independent of the deferred durable row",
  withTempDb(async () => {
    const [connectorInstanceId] = seedConnections(1, { connectorId: "deferred" });
    assert.ok(connectorInstanceId);
    await reconcileConnectorSummaryEvidence(null);
    getDb()
      .prepare("UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id = ?")
      .run(connectorInstanceId);
    getDb()
      .prepare(
        `INSERT INTO controller_active_runs(
           connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at
         ) VALUES (?, 'deferred', 'run_deferred', 'trace_deferred', 'scenario_deferred', ?)`
      )
      .run(connectorInstanceId, NOW);

    const result = await reconcileConnectorSummaryEvidence([connectorInstanceId]);
    assert.equal(result.repaired, 0, "the active run defers the candidate repair");
    assert.equal(result.skipped, 1, "a deferred candidate remains skipped for this pass");
  })
);

test(
  "scoped orphan pruning with zero candidates never makes skipped negative",
  withTempDb(async () => {
    const [connectorInstanceId] = seedConnections(1, { connectorId: "orphan" });
    assert.ok(connectorInstanceId);
    await reconcileConnectorSummaryEvidence(null);
    assert.ok(await getConnectorSummaryEvidence(connectorInstanceId));
    getDb().prepare("DELETE FROM connector_instances WHERE connector_instance_id = ?").run(connectorInstanceId);

    const result = await reconcileConnectorSummaryEvidence([connectorInstanceId]);
    assert.equal(result.discovered, 0, "the scoped census has no live connector instances");
    assert.equal(result.repaired, 1, "the orphan evidence row is pruned");
    assert.equal(result.skipped, 0, "orphan pruning is independent of skipped candidate accounting");
    assert.equal(await getConnectorSummaryEvidence(connectorInstanceId), null);
  })
);
