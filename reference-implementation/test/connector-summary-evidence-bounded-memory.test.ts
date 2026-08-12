// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver cannot model this installed package export
import Database from "better-sqlite3";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-08-12T00:00:00.000Z";
const PAGE_SIZE = 25;

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-memory-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function seedConnections(count: number): void {
  getDb().prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('c1', '{}', ?)").run(NOW);
  const insert = getDb().prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, 'owner_local', 'c1', ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  );
  for (let i = 0; i < count; i += 1) {
    const id = `cin_memory_${String(i).padStart(4, "0")}`;
    insert.run(id, `connection ${i}`, id, NOW, NOW);
  }
}

function withResultCardinalityGuard<T>(maxRows: number, fn: () => Promise<T>): Promise<T> {
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function guardedPrepare(this: Database.Database, ...args: Parameters<typeof original>) {
    const statement = original.apply(this, args);
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "all") {
          return (...bindArgs: unknown[]) => {
            const rows = Reflect.apply(target.all, target, bindArgs) as unknown[];
            assert.ok(rows.length <= maxRows, `SQLite returned ${rows.length} rows; page bound is ${maxRows}`);
            return rows;
          };
        }
        if (property === "iterate") {
          return (...bindArgs: unknown[]) => {
            const iterator = Reflect.apply(target.iterate, target, bindArgs) as Iterable<unknown>;
            return (function* guardedRows() {
              let rows = 0;
              for (const row of iterator) {
                rows += 1;
                assert.ok(rows <= maxRows, `SQLite yielded ${rows} rows; page bound is ${maxRows}`);
                yield row;
              }
            })();
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  } as typeof original;
  return fn().finally(() => {
    Database.prototype.prepare = original;
  });
}

test("unscoped reconciliation converges a high-cardinality fleet with page-bounded results", () =>
  withTempDb(async () => {
    const count = PAGE_SIZE * 4 + 3;
    seedConnections(count);

    await withResultCardinalityGuard(PAGE_SIZE, async () => {
      const result = await reconcileConnectorSummaryEvidence(null);
      assert.equal(result.discovered, count);
      assert.equal(result.candidatesInspected, count);
      assert.equal(result.repaired, count);
      assert.equal(result.skipped, 0);
      assert.equal(
        (getDb().prepare("SELECT COUNT(*) AS count FROM connector_summary_evidence").get() as { count: number }).count,
        count
      );
    });
  }));
