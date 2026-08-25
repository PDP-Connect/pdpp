// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The acknowledgement must be DURABLE and ATTRIBUTED — a fact in the database
 * with who established it and when, not knowledge trapped in an agent ledger.
 *
 * These tests prove the round trip through the real store: stamp, survive a
 * process restart (close + reopen a file-backed DB), read back verbatim, and
 * project into the rendered verdict.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acknowledgedLossStatement, readAcknowledgedLoss } from "../runtime/acknowledged-loss.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const NOW = "2026-08-23T20:00:00.000Z";

const HEB_PURGE = {
  acknowledgedAt: "2026-08-21T00:00:00.000Z",
  acknowledgedBy: "Tim Nunamaker",
  cause: "provider_deleted_upstream",
  note: "H-E-B purged the order history; heb.com no longer shows those orders.",
  scope: "total",
} as const;

function seed(store: ReturnType<typeof createSqliteConnectorInstanceStore>, connectorInstanceId: string) {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES(?, ?, ?)")
    .run("heb", JSON.stringify({ connector_id: "heb" }), NOW);
  return store.upsert({
    connectorId: "heb",
    connectorInstanceId,
    createdAt: NOW,
    displayName: "HEB - owner@example.com",
    ownerSubjectId: "owner_local",
    sourceBinding: { kind: "account", local_binding_name: "primary" },
    sourceBindingKey: "acknowledged-loss-test",
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

test("acknowledged-loss store: a stamped acknowledgement survives a process restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-acknowledged-loss-"));
  const dbPath = join(dir, "test.db");
  const id = "cin_acknowledged_loss_restart";
  try {
    initDb(dbPath);
    let store = createSqliteConnectorInstanceStore();
    seed(store, id);

    // Before stamping there is nothing to read — and nothing is inferred.
    assert.equal(readAcknowledgedLoss((await store.get(id))?.sourceBinding), null);

    store.updateSourceBindingPatch(id, {
      sourceBindingPatch: { acknowledged_loss: HEB_PURGE },
      updatedAt: NOW,
    });

    // Restart the process against the same file.
    closeDb();
    initDb(dbPath);
    store = createSqliteConnectorInstanceStore();

    const reread = readAcknowledgedLoss((await store.get(id))?.sourceBinding);
    assert.ok(reread, "the acknowledgement must survive a restart");
    assert.equal(reread.acknowledgedBy, "Tim Nunamaker");
    assert.equal(reread.acknowledgedAt, "2026-08-21T00:00:00.000Z");
    assert.equal(reread.cause, "provider_deleted_upstream");
    assert.equal(
      acknowledgedLossStatement(reread),
      "Provider deleted this data upstream — owner-confirmed 2026-08-21. H-E-B purged the order history; heb.com no longer shows those orders."
    );
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("acknowledged-loss store: stamping does not change status and does not clobber sibling binding keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-acknowledged-loss-merge-"));
  const dbPath = join(dir, "test.db");
  const id = "cin_acknowledged_loss_merge";
  try {
    initDb(dbPath);
    const store = createSqliteConnectorInstanceStore();
    seed(store, id);

    store.updateSourceBindingPatch(id, {
      sourceBindingPatch: { acknowledged_loss: HEB_PURGE },
      updatedAt: NOW,
    });

    const row = await store.get(id);
    assert.ok(row);
    // An acknowledged permanent loss is NOT a revocation: the source keeps
    // whatever it holds and keeps collecting anything still reachable.
    assert.equal(row.status, "active");
    // The merge preserved the pre-existing binding identity keys.
    const binding = row.sourceBinding as Record<string, unknown>;
    assert.equal(binding.kind, "account");
    assert.equal(binding.local_binding_name, "primary");
    assert.ok(readAcknowledgedLoss(binding));
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});
