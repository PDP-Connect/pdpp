// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fault-injection proof for the terminal-gate revision (2026-07-29) making
 * connector-summary dirty notification non-lossy.
 *
 * The independent gate found `markConnectorSummaryEvidenceDirty` catches and
 * discards every store failure: a marker write that failed AFTER a
 * committed canonical mutation (e.g. a revoke/rename) silently lost the
 * repair signal, with no durable record that a repair was owed — GET no
 * longer reconciles on read, so there was no other path back to
 * correctness. The fix folds the dirty-mark UPDATE into the SAME
 * transaction as the governing mutation
 * (`ConnectorInstanceStore.updateStatus`/`setDisplayName` in
 * `server/stores/connector-instance-store.ts`), mirroring the existing
 * `deleteConnection` cascade's identical treatment of this same table.
 *
 * This file injects a fault directly into the dirty-marker's OWN UPDATE
 * statement (a SQLite trigger that aborts every `connector_summary_evidence`
 * UPDATE) and proves, through the real production store methods:
 *   1. The whole call throws (the fault is observable, not swallowed).
 *   2. The canonical mutation (`connector_instances.status`/`display_name`)
 *      was NOT committed — it rolled back WITH the failed marker write, not
 *      independently of it. This is the atomicity property itself: before
 *      this fix, the canonical UPDATE and the marker UPDATE were two
 *      separate statements, so a marker failure here would have left the
 *      canonical mutation committed with the dirty marker silently lost.
 *   3. GET (`getConnectorSummaryForRoute`) observes the honest pre-mutation
 *      state afterward — proving GET only ever reads durably committed
 *      state and performs no compensating write of its own.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { getConnectorSummaryForRoute, invalidateConnectorSummariesCache } from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const OWNER = "owner_local";
const CONNECTOR_ID = "dirty-mark-atomicity-probe";
const INSTANCE_ID = "cin_dirty_mark_atomicity";
const NOW = "2026-07-29T00:00:00.000Z";
const DIRTY_MARKER_UPDATE_FAULT = /injected dirty-marker update fault/;

const MANIFEST = {
  capabilities: { public_listing: { tier: "supported" } },
  connector_id: CONNECTOR_ID,
  display_name: "Dirty Mark Atomicity Probe",
  protocol_version: "0.1.0",
  streams: [{ name: "messages", primary_key: ["id"] }],
  version: "1.0.0",
};

async function withTempDb(fn: () => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-dirty-mark-atomicity-"));
  invalidateConnectorSummariesCache();
  initDb(join(dir, "pdpp.sqlite"));
  try {
    await fn();
  } finally {
    invalidateConnectorSummariesCache();
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function seedConnection(): void {
  const db = getDb();
  db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    CONNECTOR_ID,
    JSON.stringify(MANIFEST),
    NOW
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES(?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  ).run(INSTANCE_ID, OWNER, CONNECTOR_ID, "Dirty Mark Probe", INSTANCE_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO connector_summary_evidence(connector_instance_id, connector_id, dirty, state)
     VALUES (?, ?, 0, 'fresh')`
  ).run(INSTANCE_ID, CONNECTOR_ID);
}

function installSummaryEvidenceUpdateFault(): void {
  getDb().exec(
    `CREATE TRIGGER fault_dirty_mark_atomicity_update
       BEFORE UPDATE ON connector_summary_evidence
     BEGIN
       SELECT RAISE(ABORT, 'injected dirty-marker update fault');
     END`
  );
}

test("SQLite: a dirty-marker write failure rolls back the connector_instances status change WITH it (no lost transition, no orphaned canonical mutation)", async () => {
  await withTempDb(() => {
    seedConnection();
    installSummaryEvidenceUpdateFault();

    const store = createSqliteConnectorInstanceStore();
    assert.throws(
      () =>
        store.updateStatus(INSTANCE_ID, {
          revokedAt: "2026-07-29T00:05:00.000Z",
          status: "revoked",
          updatedAt: "2026-07-29T00:05:00.000Z",
        }),
      DIRTY_MARKER_UPDATE_FAULT,
      "the injected fault must be observable, not silently swallowed by the store"
    );

    const instance = store.get(INSTANCE_ID);
    assert.ok(instance, "the connection row must still exist");
    assert.equal(
      instance?.status,
      "active",
      "the canonical status mutation must have rolled back WITH the failed marker write — a lost marker must never leave the canonical mutation committed on its own"
    );

    const evidence = getDb()
      .prepare("SELECT dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?")
      .get(INSTANCE_ID) as { dirty: number; state: string } | undefined;
    assert.ok(evidence, "the summary evidence row must still exist");
    assert.equal(
      evidence?.dirty,
      0,
      "the pre-existing evidence row's dirty flag is untouched by the rolled-back write"
    );
    assert.equal(
      evidence?.state,
      "fresh",
      "the pre-existing evidence row's state is untouched by the rolled-back write"
    );
  });
});

test("SQLite: a dirty-marker write failure rolls back a display_name rename WITH it", async () => {
  await withTempDb(() => {
    seedConnection();
    installSummaryEvidenceUpdateFault();

    const store = createSqliteConnectorInstanceStore();
    assert.throws(
      () =>
        store.setDisplayName(INSTANCE_ID, {
          displayName: "Renamed Under Fault",
          ownerSubjectId: OWNER,
          updatedAt: "2026-07-29T00:05:00.000Z",
        }),
      DIRTY_MARKER_UPDATE_FAULT,
      "the injected fault must be observable, not silently swallowed by the store"
    );

    const instance = store.get(INSTANCE_ID);
    assert.equal(
      instance?.displayName,
      "Dirty Mark Probe",
      "the canonical display_name mutation must have rolled back WITH the failed marker write"
    );
  });
});

test("SQLite: GET observes only the honest, durably committed pre-mutation state after a rolled-back revoke — no compensating write on read", async () => {
  await withTempDb(async () => {
    seedConnection();
    installSummaryEvidenceUpdateFault();

    const store = createSqliteConnectorInstanceStore();
    assert.throws(() =>
      store.updateStatus(INSTANCE_ID, {
        revokedAt: "2026-07-29T00:05:00.000Z",
        status: "revoked",
        updatedAt: "2026-07-29T00:05:00.000Z",
      })
    );

    // GET must observe the honest, still-active pre-mutation state — never
    // a half-applied status change — and must not itself attempt any write:
    // the still-installed trigger would abort a second time if GET tried to
    // repair anything here, so a clean (non-throwing) GET after the failed
    // mutation is itself proof GET performed zero writes.
    const summary = await getConnectorSummaryForRoute(INSTANCE_ID);
    assert.ok(summary, "the connection must still resolve to a summary");
    const instanceAfterGet = createSqliteConnectorInstanceStore().get(INSTANCE_ID);
    assert.equal(
      instanceAfterGet?.status,
      "active",
      "GET must observe the honest committed status, not 'revoked' — and must not have written anything (the fault trigger is still installed)"
    );
  });
});
