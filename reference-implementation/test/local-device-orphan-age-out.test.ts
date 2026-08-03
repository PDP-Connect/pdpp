// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage (real `getConnectorSummaryForRoute` projection, real
 * SQLite) for the never-activated `local_device` draft age-out
 * (`isNeverActivatedDraftAgedOut`, `server/ref-control.ts`).
 *
 * Live incident: an abandoned duplicate Codex CLI enrollment
 * (`connector_instances.status === "active"`, `device_source_instances`
 * rows present, zero heartbeats/ingests ever) permanently read
 * `owner_state.resolver: "setup_in_progress"` — "Finish connecting this
 * source to start its first sync." — with no way to ever stop demanding
 * owner attention, even though a healthy sibling connection already exists.
 * `isNeverActivatedDraftAgedOut`'s unit coverage
 * (`never-activated-draft-age-out.test.ts`) proves the pure boundary check;
 * this file proves the real projection actually stops nagging once an
 * instance ages past it, without ever mutating the stored `active` status
 * or fabricating a false-healthy verdict.
 *
 * Follows the direct-DB fixture pattern `ref-connectors-connection-
 * projection.test.ts` / `active-run-summary-zero-spine.test.ts` already
 * use for this exact function — no live server, no HTTP round trip.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { getConnectorSummaryForRoute } from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const CONNECTOR_ID = "codex";
const FRESH_ORPHAN_INSTANCE_ID = "cin_test_fresh_never_activated";
const STALE_ORPHAN_INSTANCE_ID = "cin_test_stale_never_activated";
const SEED_TIME = "2026-05-20T12:00:00.000Z";

function withTmpDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-local-device-orphan-age-out-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnector() {
  const manifest = {
    capabilities: { public_listing: { listed: true, status: "test" } },
    connector_id: CONNECTOR_ID,
    display_name: "Codex CLI",
    protocol_version: "0.1.0",
    streams: [{ name: "messages", primary_key: ["id"] }],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(manifest), SEED_TIME);
}

interface SeedOrphanOptions {
  connectorInstanceId: string;
  createdAt: string;
  localBindingKey: string;
}

// A never-activated `local_device` instance: `status: "active"` (the
// pre-fix / legacy enrollment shape dcb557788 already targets), a real
// `device_exporters` + `device_source_instances` row bound to it, and ZERO
// heartbeats/ingest batches ever — the exact live shape of an abandoned
// duplicate enrollment.
function seedNeverActivatedOrphan({ connectorInstanceId, createdAt, localBindingKey }: SeedOrphanOptions): void {
  const store = createSqliteConnectorInstanceStore();
  store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId,
    createdAt,
    displayName: `Orphan ${localBindingKey}`,
    ownerSubjectId: "owner_local",
    sourceBinding: { device: localBindingKey, kind: "local_device" },
    sourceBindingKey: localBindingKey,
    sourceKind: "local_device",
    status: "active",
    updatedAt: createdAt,
  });
  const deviceId = `dev_${localBindingKey}`;
  getDb()
    .prepare(
      `INSERT INTO device_exporters(
         device_id, owner_subject_id, display_name, status, created_at, updated_at
       ) VALUES (?, 'owner_local', ?, 'active', ?, ?)`
    )
    .run(deviceId, `Orphan device ${localBindingKey}`, createdAt, createdAt);
  getDb()
    .prepare(
      `INSERT INTO device_source_instances(
         source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id,
         source_kind, status, last_heartbeat_at, last_heartbeat_status, records_pending,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'local_device', 'active', NULL, NULL, 0, ?, ?)`
    )
    .run(`dsi_${localBindingKey}`, deviceId, CONNECTOR_ID, connectorInstanceId, localBindingKey, createdAt, createdAt);
}

test(
  "a never-activated local_device instance still WITHIN the age-out window reads setup_in_progress (unchanged pre-fix behavior)",
  withTmpDb(async () => {
    seedConnector();
    // `createdAt` a few minutes before real wall-clock `now` — well inside
    // the 72h age-out window regardless of when this test actually runs.
    seedNeverActivatedOrphan({
      connectorInstanceId: FRESH_ORPHAN_INSTANCE_ID,
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      localBindingKey: "fresh-orphan",
    });

    const summary = await getConnectorSummaryForRoute(FRESH_ORPHAN_INSTANCE_ID);
    assert.ok(summary, "expected a summary for the fresh never-activated instance");
    assert.equal(
      summary.owner_state.resolver,
      "setup_in_progress",
      "a recent enrollment attempt must still read as in-progress, not silently dropped"
    );
  })
);

test(
  "a never-activated local_device instance PAST the age-out window stops reading setup_in_progress, and stored status is untouched",
  withTmpDb(async () => {
    seedConnector();
    // 100 hours ago — comfortably past the 72h `NEVER_ACTIVATED_DRAFT_AGE_OUT_MS`
    // boundary.
    const staleCreatedAt = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    seedNeverActivatedOrphan({
      connectorInstanceId: STALE_ORPHAN_INSTANCE_ID,
      createdAt: staleCreatedAt,
      localBindingKey: "stale-orphan",
    });

    const summary = await getConnectorSummaryForRoute(STALE_ORPHAN_INSTANCE_ID);
    assert.ok(summary, "expected a summary for the stale never-activated instance");
    assert.notEqual(
      summary.owner_state.resolver,
      "setup_in_progress",
      "an abandoned enrollment past the age-out window must stop demanding 'Finish connecting'"
    );
    assert.notEqual(
      summary.owner_state.resolver,
      "healthy",
      "aging out must never fabricate a false-healthy verdict for a connection with no proof of activation"
    );
    assert.notEqual(
      summary.owner_state.owner_of_state,
      "owner",
      "an aged-out orphan with nothing left to say must not keep asking the owner to act"
    );

    const storedStatus = getDb()
      .prepare("SELECT status FROM connector_instances WHERE connector_instance_id = ?")
      .get(STALE_ORPHAN_INSTANCE_ID) as { status: string } | undefined;
    assert.equal(
      storedStatus?.status,
      "active",
      "aging out is a read-time-only projection; the stored connector_instances.status row must never be mutated"
    );
  })
);
