// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded-work oracle for polyfill manifest reconciliation — Postgres driver
 * (env-gated on `PDPP_TEST_POSTGRES_URL`).
 *
 * Production incident context: on 2026-07-17 a live deploy's manifest
 * reconciliation pass exceeded Docker's health budget (>8 minutes) because
 * byte-identical shipped manifests were wrongly treated as CHANGED on every
 * startup. `registerConnector` unconditionally re-runs
 * `postgresBackfillRecordSortPositionsForManifest`, which paginates every
 * record of every stream for every connector instance (256 rows/page) under
 * the per-instance writer fence — O(records), not O(connectors). Root cause:
 * `manifestsEqual` compared the raw shipped manifest file (long-form
 * `connector_id`, e.g. `https://registry.pdpp.org/connectors/amazon`)
 * against the PERSISTED row, which `registerConnector` always rewrites to
 * the short canonical key (`amazon`) before storing. Those two shapes can
 * never be byte-equal, so every first-party manifest reconciled as
 * "changed" on every single startup, forever. See
 * `normalizeForComparison` in `polyfill-manifest-reconcile.ts`.
 *
 * This oracle proves the fix holds at production-ish record scale: an
 * ordinary startup reconcile pass over an already-registered, unchanged
 * connector with thousands of persisted records issues ZERO SQL statements
 * against the `records` table (the backfill pagination is the O(records)
 * cost; skipping it is the whole point of detecting "unchanged" correctly).
 * It measures Postgres query COUNT, not wall-clock, and is non-vacuous: with
 * the fix reverted (comparing raw shipped bytes instead of the
 * normalized-for-storage shape), this test fails because the backfill
 * pagination loop runs and issues real `records` queries.
 *
 * Target for local runs:
 *   docker run --rm -d --name pg-pilot -p 55463:5432 \
 *     -e POSTGRES_USER=pdpp -e POSTGRES_PASSWORD=pdpp \
 *     -e POSTGRES_DB=pdpp_pilot \
 *     pgvector/pgvector:pg16
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55463/pdpp_pilot \
 *     node --import tsx --test test/polyfill-manifest-reconcile-bounded-work-postgres.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { reconcilePolyfillManifests } from "../server/polyfill-manifest-reconcile.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (POSTGRES_URL) {
  const CONNECTOR_ID = "amazon";
  const CONNECTOR_INSTANCE_ID = `cin_bounded_work_${Date.now()}`;
  // Production-scale: several multiples of the 256-row pagination window
  // across two streams, so an unbounded fix would issue dozens of SELECT +
  // UPDATE round-trips instead of zero.
  const RECORDS_PER_STREAM = 1200;

  function shippedAmazonManifest() {
    return {
      connector_id: `https://registry.pdpp.org/connectors/${CONNECTOR_ID}`,
      connector_key: CONNECTOR_ID,
      display_name: "Amazon",
      manifest_uri: `https://registry.pdpp.org/connectors/${CONNECTOR_ID}`,
      protocol_version: "0.1.0",
      runtime_requirements: { bindings: { network: { required: true } } },
      streams: [
        {
          cursor_field: "order_date",
          name: "orders",
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              order_date: { format: "date-time", type: "string" },
            },
            required: ["id", "order_date"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
        {
          cursor_field: "order_date",
          name: "order_items",
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              order_date: { format: "date-time", type: "string" },
            },
            required: ["id", "order_date"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
      ],
      version: "1.0.0",
    };
  }

  async function seedRecords(stream: string, count: number): Promise<void> {
    const rows: { id: string; emittedAt: string }[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = `${stream}-${String(i).padStart(6, "0")}`;
      const emittedAt = new Date(2026, 0, 1, 0, 0, i).toISOString();
      rows.push({ emittedAt, id });
    }
    // Batch-insert in chunks so seeding itself stays fast; this is setup,
    // not part of the measured reconcile pass.
    const CHUNK = 500;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [];
      chunk.forEach((row, idx) => {
        const base = idx * 9;
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`
        );
        params.push(
          CONNECTOR_ID,
          CONNECTOR_INSTANCE_ID,
          stream,
          row.id,
          JSON.stringify({ id: row.id, order_date: row.emittedAt }),
          row.emittedAt,
          row.emittedAt,
          row.emittedAt,
          row.id
        );
      });
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      await postgresQuery(
        `INSERT INTO records(
           connector_id, connector_instance_id, stream, record_key, record_json,
           emitted_at, semantic_time, cursor_value, primary_key_text
         ) VALUES ${values.join(", ")}`,
        params
      );
    }
  }

  function countPostgresQueries() {
    const pool = getPostgresPool();
    const ownQueryDescriptor = Object.getOwnPropertyDescriptor(pool, "query");
    const original = pool.query.bind(pool);
    let count = 0;
    const recordsStatements: string[] = [];
    Object.defineProperty(pool, "query", {
      configurable: true,
      value: (...args: Parameters<typeof original>) => {
        count += 1;
        // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
        const first = args[0];
        const sql = first;
        // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
        if (typeof sql === "string" && /\bFROM\s+records\b|\bUPDATE\s+records\b/i.test(sql)) {
          recordsStatements.push(sql.trim().slice(0, 120));
        }
        return original(...args);
      },
    });
    return {
      recordsStatements: () => recordsStatements.slice(),
      restore: () => {
        if (ownQueryDescriptor) {
          Object.defineProperty(pool, "query", ownQueryDescriptor);
        } else {
          Reflect.deleteProperty(pool, "query");
        }
      },
      total: () => count,
    };
  }

  test("reconciling an unchanged, already-registered manifest issues zero records-table queries at production-ish scale", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    const dir = mkdtempSync(join(tmpdir(), "pdpp-bounded-work-"));
    try {
      const shipped = shippedAmazonManifest();

      // 1. Ordinary first registration (as reconciliation would do on a
      //    fresh DB, or as the operator flow does on connect).
      await registerConnector(shipped, { backfillRetrievalIndexes: false });

      // 2. Seed production-ish record volume across both streams — the
      //    exact records the unbounded backfill would paginate through.
      await seedRecords("orders", RECORDS_PER_STREAM);
      await seedRecords("order_items", RECORDS_PER_STREAM);

      const totalRecords = RECORDS_PER_STREAM * 2;
      // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
      const countRow = (
        await postgresQuery("SELECT COUNT(*) AS n FROM records WHERE connector_id = $1", [CONNECTOR_ID])
      ).rows[0];
      assert.ok(countRow, "seeded records count query returns a row");
      assert.equal(countRow.n, String(totalRecords), "baseline: production-ish record volume seeded");

      // 3. Ship the BYTE-IDENTICAL manifest (same shape reconciliation reads
      //    from disk on ordinary startup) and reconcile.
      const manifestsDir = join(dir, "manifests");
      mkdirSync(manifestsDir, { recursive: true });
      writeFileSync(join(manifestsDir, "amazon.json"), JSON.stringify(shippedAmazonManifest(), null, 2));
      const referenceFixturesDir = join(dir, "reference");
      mkdirSync(referenceFixturesDir, { recursive: true });

      const spy = countPostgresQueries();
      // biome-ignore lint/suspicious/noEvolvingTypes: localized test assertion preserves its explicit contract.
      // biome-ignore lint/suspicious/noImplicitAnyLet: localized test assertion preserves its explicit contract.
      let summary;
      try {
        summary = await reconcilePolyfillManifests({
          enabled: true,
          // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
          log: () => {},
          manifestsDir,
          referenceFixturesDir,
        });
      } finally {
        spy.restore();
      }

      assert.equal(summary.scanned, 1);
      assert.equal(summary.unchanged, 1, "reconciliation must detect the byte-identical manifest as unchanged");
      assert.equal(summary.updated, 0, "an unchanged manifest must not trigger re-registration");
      assert.equal(summary.errors, 0);

      // The bounded-work assertion: NO queries against `records` at all.
      // The backfill pagination issues a SELECT + conditional UPDATE per
      // 256-row page per stream per connector instance; at 1200 rows/stream
      // × 2 streams that is >=10 page-reads if it ran at all. Zero proves
      // the expensive path was skipped entirely, not merely fast.
      assert.deepEqual(
        spy.recordsStatements(),
        [],
        `expected zero queries against the records table, got: ${JSON.stringify(spy.recordsStatements())}`
      );
    } finally {
      // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
      await postgresQuery("DELETE FROM records WHERE connector_id = $1", [CONNECTOR_ID]).catch(() => {});
      // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
      await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]).catch(() => {});
      rmSync(dir, { force: true, recursive: true });
      await closePostgresStorage();
      closeDb();
    }
  });
} else {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
  test("manifest-reconcile bounded-work oracle (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {});
}
