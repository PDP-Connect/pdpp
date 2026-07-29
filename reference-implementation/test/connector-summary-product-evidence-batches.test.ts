// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot model the package export.
import Database from "better-sqlite3";
import { closeDb, initDb } from "../server/db.ts";
import { readCommittedLocalCoverageDiagnosticsByConnectionIds } from "../server/records.ts";
import {
  listRetainedSizeConnectionsByInstanceIds,
  listRetainedSizeStreamsByInstanceIds,
} from "../server/retained-size-read-model.ts";
import { createSqliteAcquisitionBatchStore } from "../server/stores/acquisition-batch-store.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import { listSourceInstanceHeartbeatsByConnectionIds } from "../server/stores/device-exporter-store.ts";

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-product-evidence-batches-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

async function countRawPrepareCalls<T>(fn: () => Promise<T>): Promise<{ calls: number; result: T }> {
  let calls = 0;
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function patchedPrepare(this: Database.Database, ...args: Parameters<typeof original>) {
    calls += 1;
    return original.apply(this, args);
  } as typeof original;
  try {
    return { calls, result: await fn() };
  } finally {
    Database.prototype.prepare = original;
  }
}

function readAll(ids: readonly string[]) {
  const acquisition = createSqliteAcquisitionBatchStore();
  const credentials = createSqliteConnectorInstanceCredentialStore();
  return Promise.all([
    Promise.resolve(acquisition.listByConnectionIds(ids, { limit: 5 })),
    credentials.getMetadataByInstanceIds(ids),
    readCommittedLocalCoverageDiagnosticsByConnectionIds(ids),
    listSourceInstanceHeartbeatsByConnectionIds(ids),
    listRetainedSizeConnectionsByInstanceIds(ids),
    listRetainedSizeStreamsByInstanceIds(ids),
  ]);
}

test("product-evidence batches short-circuit an empty identity page without SQL", async () =>
  withTempDb(async () => {
    const measured = await countRawPrepareCalls(() => readAll([]));
    assert.equal(measured.calls, 0);
    for (const map of measured.result) {
      assert.equal(map.size, 0);
    }
  }));

test("product-evidence SQLite reads stay page-bounded and chunk above the bind floor", async () =>
  withTempDb(async () => {
    const one = await countRawPrepareCalls(() => readAll(["cin_0"]));
    const many = await countRawPrepareCalls(() => readAll(Array.from({ length: 1001 }, (_, index) => `cin_${index}`)));
    // Six axes each issue one query at N=1 and two chunks at N=1001. The
    // growth is therefore bounded by the number of axes, never the number of
    // connection ids; a per-connection read would be roughly 1000x larger.
    assert.ok(many.calls <= one.calls + 8, `expected chunk-bounded SQL, got N=1:${one.calls}, N=1001:${many.calls}`);
  }));
