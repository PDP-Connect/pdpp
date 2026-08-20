// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector-summary read-model dirty-hook wiring tests.
 *
 * Pins the write-hook slice of `maintain-connector-summary-read-model`
 * (tasks 2.1 / 2.2): the maintained connector-summary evidence read model is
 * marked dirty from the seams that already invalidate connector summaries or
 * retained-size evidence.
 *
 *   - Record ingest (`ingestRecord`) dirties the matching connection's summary
 *     evidence, colocated with the retained-size delta — proving the record
 *     ingest hook (task 2.2).
 *   - Record delete (`deleteRecord`) and bulk stream delete (`deleteAllRecords`)
 *     dirty the matching connection's summary evidence and ONLY that connection,
 *     while a no-op delete leaves evidence clean — proving the record-mutation
 *     delete hooks (task 2.2).
 *   - The owner revoke route (`POST /v1/owner/connections/:id/revoke`) and the
 *     owner rename route (`PATCH /v1/owner/connections/:id`, a non-revoke owner
 *     mutation) each dirty that exact connection's summary evidence after the
 *     mutation commits — proving the owner-mutation route seams (task 2.1).
 *
 * These hooks are scoped (`markConnectorSummaryEvidenceDirty` with a known
 * `connector_instance_id`), awaited at their call sites, and best-effort: the
 * marker is an `UPDATE ... WHERE connector_instance_id = ?`, so it is a no-op
 * until the read model has a row for the connection (warmed by a rebuild).
 * Each test warms the evidence with `rebuildConnectorSummaryEvidence()` first
 * so the marker has a row to flip — which mirrors the steady state once the
 * read model backs the hot path.
 *
 * Falsifiability: deleting the `markConnectorSummaryEvidenceDirty` call from the
 * `ingestRecord` after-commit block (or from the revoke route after the cache
 * invalidation) makes the corresponding assertion fail because the evidence row
 * stays `dirty = false` / `state = 'fresh'`.
 *
 * Spec: openspec/changes/maintain-connector-summary-read-model/
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import {
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { deleteAllRecords, deleteAllRecordsForConnector, deleteRecord, ingestRecord } from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const OWNER_CLIENT_ID = "cli_longview";
const NOW = "2026-06-17T00:00:00.000Z";

// ── Record-ingest seam (task 2.2): no server needed ─────────────────────────

// Use a real reference manifest so the after-commit lexical-index step (which
// loads and validates the connector manifest) succeeds. A synthetic
// `{ connector_id }` stub fails manifest validation; `connector_instances` also
// FK-references `connectors`, so the row must exist. The spotify manifest is a
// stable, committed fixture with declared streams.
const SPOTIFY_MANIFEST = JSON.parse(
  readFileSync(join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests", "spotify.json"), "utf8")
);
const SPOTIFY_CONNECTOR_KEY = canonicalConnectorKey(SPOTIFY_MANIFEST.connector_id);
if (!SPOTIFY_CONNECTOR_KEY) {
  throw new Error("the Spotify fixture must have a canonical connector key");
}
const SPOTIFY_STREAM = SPOTIFY_MANIFEST.streams[0].name;

function seedInstanceSqlite({
  connectorInstanceId,
  displayName = "Spotify source",
}: {
  connectorInstanceId: string;
  displayName?: string;
}) {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(SPOTIFY_CONNECTOR_KEY, JSON.stringify(SPOTIFY_MANIFEST), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       VALUES(?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, OWNER_SUBJECT_ID, SPOTIFY_CONNECTOR_KEY, displayName, connectorInstanceId, NOW, NOW);
}

function storageTargetFor(connectorInstanceId: string) {
  const connectorId = SPOTIFY_CONNECTOR_KEY;
  if (!connectorId) {
    throw new Error("the Spotify fixture must have a canonical connector key");
  }
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

test("record ingest dirties the matching connection summary evidence", async () => {
  initDb();
  try {
    const instanceId = "cin_summary_ingest_a";
    seedInstanceSqlite({ connectorInstanceId: instanceId });

    // Warm the read model so the scoped marker has a row to flip.
    await rebuildConnectorSummaryEvidence();
    const before = await getConnectorSummaryEvidence(instanceId);
    assert.ok(before, "evidence row must exist after rebuild");
    assert.equal(before.dirty, false, "evidence is clean immediately after rebuild");
    assert.equal(before.state, "fresh");

    // A changed record write moves this connection's count evidence.
    const result = await ingestRecord(storageTargetFor(instanceId), {
      data: { id: "rec_1", name: "first" },
      emitted_at: NOW,
      key: "rec_1",
      stream: SPOTIFY_STREAM,
    });
    assert.equal(result.changed, true, "a new record is a changed write");

    const after = await getConnectorSummaryEvidence(instanceId);
    assert.ok(after, "evidence row must exist after ingest");
    assert.equal(after.dirty, true, "record ingest marks the connection evidence dirty");
    assert.equal(after.state, "stale");
  } finally {
    closeDb();
  }
});

test("record ingest only dirties the connection that received the record", async () => {
  initDb();
  try {
    const ingested = "cin_summary_ingest_target";
    const untouched = "cin_summary_ingest_other";
    seedInstanceSqlite({ connectorInstanceId: ingested, displayName: "Target" });
    seedInstanceSqlite({ connectorInstanceId: untouched, displayName: "Other" });
    await rebuildConnectorSummaryEvidence();

    await ingestRecord(storageTargetFor(ingested), {
      data: { id: "rec_1" },
      emitted_at: NOW,
      key: "rec_1",
      stream: SPOTIFY_STREAM,
    });

    const ingestedEvidence = await getConnectorSummaryEvidence(ingested);
    assert.ok(ingestedEvidence, "ingested connection evidence row must exist");
    assert.equal(ingestedEvidence.dirty, true);
    const untouchedEvidence = await getConnectorSummaryEvidence(untouched);
    assert.ok(untouchedEvidence, "untouched connection evidence row must exist");
    assert.equal(
      untouchedEvidence.dirty,
      false,
      "a sibling connection that received no record stays clean (scoped marker, not a full sweep)"
    );
  } finally {
    closeDb();
  }
});

test("no-op re-ingest does not dirty summary evidence", async () => {
  initDb();
  try {
    const instanceId = "cin_summary_ingest_noop";
    seedInstanceSqlite({ connectorInstanceId: instanceId });
    const storageTarget = storageTargetFor(instanceId);
    await ingestRecord(storageTarget, {
      data: { id: "rec_1", name: "first" },
      emitted_at: NOW,
      key: "rec_1",
      stream: SPOTIFY_STREAM,
    });

    // Rebuild AFTER the first ingest so evidence is clean, then re-ingest the
    // identical payload (a no-op). The marker only fires for changed writes.
    await rebuildConnectorSummaryEvidence();
    const beforeReingest = await getConnectorSummaryEvidence(instanceId);
    assert.ok(beforeReingest, "evidence row must exist after rebuild");
    assert.equal(beforeReingest.dirty, false);

    const result = await ingestRecord(storageTarget, {
      data: { id: "rec_1", name: "first" },
      emitted_at: NOW,
      key: "rec_1",
      stream: SPOTIFY_STREAM,
    });
    assert.equal(result.changed, false, "identical re-ingest is a no-op");
    const afterReingest = await getConnectorSummaryEvidence(instanceId);
    assert.ok(afterReingest, "evidence row must exist after re-ingest");
    assert.equal(afterReingest.dirty, false, "a no-op re-ingest must not dirty summary evidence");
  } finally {
    closeDb();
  }
});

// ── Record-delete seams (task 2.2): no server needed ─────────────────────────

test("deleteRecord dirties the matching connection summary evidence", async () => {
  initDb();
  try {
    const instanceId = "cin_summary_delete_record";
    seedInstanceSqlite({ connectorInstanceId: instanceId });
    const storageTarget = storageTargetFor(instanceId);

    // Seed a record, then rebuild so evidence is clean before the delete.
    await ingestRecord(storageTarget, {
      data: { id: "rec_1", name: "first" },
      emitted_at: NOW,
      key: "rec_1",
      stream: SPOTIFY_STREAM,
    });
    await rebuildConnectorSummaryEvidence();
    const beforeDelete = await getConnectorSummaryEvidence(instanceId);
    assert.ok(beforeDelete, "evidence row must exist after rebuild");
    assert.equal(beforeDelete.dirty, false);

    // Deleting the record moves this connection's count evidence.
    const deleted = await deleteRecord(storageTarget, SPOTIFY_STREAM, "rec_1");
    assert.equal(deleted, 1, "an existing record delete reports one row removed");

    const after = await getConnectorSummaryEvidence(instanceId);
    assert.ok(after, "evidence row must exist after delete");
    assert.equal(after.dirty, true, "record delete marks the connection evidence dirty");
    assert.equal(after.state, "stale");
  } finally {
    closeDb();
  }
});

test("deleteRecord of a missing record does not dirty summary evidence", async () => {
  initDb();
  try {
    const instanceId = "cin_summary_delete_missing";
    seedInstanceSqlite({ connectorInstanceId: instanceId });
    const storageTarget = storageTargetFor(instanceId);
    await rebuildConnectorSummaryEvidence();
    const beforeDelete = await getConnectorSummaryEvidence(instanceId);
    assert.ok(beforeDelete, "evidence row must exist after rebuild");
    assert.equal(beforeDelete.dirty, false);

    // No such record → the delete is a no-op and must not dirty evidence.
    const deleted = await deleteRecord(storageTarget, SPOTIFY_STREAM, "rec_absent");
    assert.equal(deleted, 0, "deleting a missing record is a no-op");
    const afterDelete = await getConnectorSummaryEvidence(instanceId);
    assert.ok(afterDelete, "evidence row must exist after no-op delete");
    assert.equal(afterDelete.dirty, false, "a no-op record delete must not dirty summary evidence");
  } finally {
    closeDb();
  }
});

test("deleteAllRecords dirties only the connection whose stream was cleared", async () => {
  initDb();
  try {
    const cleared = "cin_summary_delete_all_target";
    const untouched = "cin_summary_delete_all_other";
    seedInstanceSqlite({ connectorInstanceId: cleared, displayName: "Cleared" });
    seedInstanceSqlite({ connectorInstanceId: untouched, displayName: "Other" });

    await ingestRecord(storageTargetFor(cleared), {
      data: { id: "rec_1", name: "first" },
      emitted_at: NOW,
      key: "rec_1",
      stream: SPOTIFY_STREAM,
    });
    await rebuildConnectorSummaryEvidence();
    const clearedBefore = await getConnectorSummaryEvidence(cleared);
    assert.ok(clearedBefore, "cleared connection evidence row must exist");
    assert.equal(clearedBefore.dirty, false);
    const untouchedBefore = await getConnectorSummaryEvidence(untouched);
    assert.ok(untouchedBefore, "untouched connection evidence row must exist");
    assert.equal(untouchedBefore.dirty, false);

    const deletedCount = await deleteAllRecords(storageTargetFor(cleared), SPOTIFY_STREAM);
    assert.equal(deletedCount, 1, "one record was cleared from the stream");

    const clearedAfter = await getConnectorSummaryEvidence(cleared);
    assert.ok(clearedAfter, "cleared connection evidence row must exist after delete");
    assert.equal(clearedAfter.dirty, true, "bulk stream delete marks the cleared connection evidence dirty");
    const untouchedAfter = await getConnectorSummaryEvidence(untouched);
    assert.ok(untouchedAfter, "untouched connection evidence row must exist after delete");
    assert.equal(
      untouchedAfter.dirty,
      false,
      "a sibling connection whose records were untouched stays clean (scoped marker)"
    );
  } finally {
    closeDb();
  }
});

test("deleteAllRecords on an empty stream does not dirty summary evidence", async () => {
  initDb();
  try {
    const instanceId = "cin_summary_delete_all_empty";
    seedInstanceSqlite({ connectorInstanceId: instanceId });
    await rebuildConnectorSummaryEvidence();
    const beforeEmptyDelete = await getConnectorSummaryEvidence(instanceId);
    assert.ok(beforeEmptyDelete, "evidence row must exist after rebuild");
    assert.equal(beforeEmptyDelete.dirty, false);

    const deletedCount = await deleteAllRecords(storageTargetFor(instanceId), SPOTIFY_STREAM);
    assert.equal(deletedCount, 0, "no records to clear is a no-op");
    const afterEmptyDelete = await getConnectorSummaryEvidence(instanceId);
    assert.ok(afterEmptyDelete, "evidence row must exist after no-op bulk delete");
    assert.equal(afterEmptyDelete.dirty, false, "a no-op bulk delete must not dirty summary evidence");
  } finally {
    closeDb();
  }
});

// ── Connector-wide bulk delete seam (Perf-2026-07-29 parity fix) ────────────
//
// `deleteAllRecordsForConnector` (the CONNECTOR-WIDE variant, distinct from
// the per-connection `deleteAllRecords` above) dirties every instance whose
// records were cleared. The Postgres arm previously omitted this call
// entirely (SQLite always had it) — a real backend-parity gap the batched
// connector-summary read path surfaced once it started trusting the
// evidence table's dirty/checkpoint state for connections it had never
// scoped-repaired before.

test("deleteAllRecordsForConnector (SQLite) dirties every instance it clears", async () => {
  initDb();
  try {
    const clearedA = "cin_summary_delete_all_connector_a";
    const clearedB = "cin_summary_delete_all_connector_b";
    seedInstanceSqlite({ connectorInstanceId: clearedA, displayName: "Cleared A" });
    seedInstanceSqlite({ connectorInstanceId: clearedB, displayName: "Cleared B" });

    await ingestRecord(storageTargetFor(clearedA), {
      data: { id: "rec_a", name: "a" },
      emitted_at: NOW,
      key: "rec_a",
      stream: SPOTIFY_STREAM,
    });
    await ingestRecord(storageTargetFor(clearedB), {
      data: { id: "rec_b", name: "b" },
      emitted_at: NOW,
      key: "rec_b",
      stream: SPOTIFY_STREAM,
    });
    await rebuildConnectorSummaryEvidence();
    const aBefore = await getConnectorSummaryEvidence(clearedA);
    const bBefore = await getConnectorSummaryEvidence(clearedB);
    assert.ok(aBefore && bBefore, "both connections' evidence rows must exist after rebuild");
    assert.equal(aBefore.dirty, false);
    assert.equal(bBefore.dirty, false);

    const { deletedCount } = await deleteAllRecordsForConnector(SPOTIFY_CONNECTOR_KEY);
    assert.equal(deletedCount, 2, "both connections' records were cleared");

    const aAfter = await getConnectorSummaryEvidence(clearedA);
    const bAfter = await getConnectorSummaryEvidence(clearedB);
    assert.ok(aAfter && bAfter, "both connections' evidence rows must exist after connector-wide delete");
    assert.equal(aAfter.dirty, true, "connector-wide delete marks connection A evidence dirty");
    assert.equal(bAfter.dirty, true, "connector-wide delete marks connection B evidence dirty");
  } finally {
    closeDb();
  }
});

test("deleteAllRecordsForConnector (PostgreSQL) dirties every instance it clears", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const connectorId = "pg_summary_delete_all_connector";
  const clearedA = "cin_pg_summary_delete_all_a";
  const clearedB = "cin_pg_summary_delete_all_b";
  try {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ANY($1::text[])", [
      [clearedA, clearedB],
    ]);
    await postgresQuery("DELETE FROM records WHERE connector_instance_id = ANY($1::text[])", [[clearedA, clearedB]]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = ANY($1::text[])", [
      [clearedA, clearedB],
    ]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
           VALUES($1, $2::jsonb, $3) ON CONFLICT(connector_id) DO NOTHING`,
      [connectorId, JSON.stringify({ connector_id: connectorId }), NOW]
    );
    for (const instanceId of [clearedA, clearedB]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture setup, not the code path under test.
      await postgresQuery(
        `INSERT INTO connector_instances(
             connector_instance_id, owner_subject_id, connector_id, display_name, status,
             source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
           )
           VALUES($1, $2, $3, $1, 'active', 'account', $1, '{}'::jsonb, $4, $4, NULL)`,
        [instanceId, OWNER_SUBJECT_ID, connectorId, NOW]
      );
      await postgresQuery(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
             VALUES($1, $2, $3, 'rec_1', '{}'::jsonb, $4, 1, false, 'rec_1')`,
        [connectorId, instanceId, SPOTIFY_STREAM, NOW]
      );
    }
    await rebuildConnectorSummaryEvidence();
    const aBefore = await getConnectorSummaryEvidence(clearedA);
    const bBefore = await getConnectorSummaryEvidence(clearedB);
    assert.ok(aBefore && bBefore, "both connections' evidence rows must exist after rebuild");
    assert.equal(aBefore.dirty, false);
    assert.equal(bBefore.dirty, false);

    const { deletedCount } = await deleteAllRecordsForConnector(connectorId);
    assert.equal(deletedCount, 2, "both connections' records were cleared");

    const aAfter = await getConnectorSummaryEvidence(clearedA);
    const bAfter = await getConnectorSummaryEvidence(clearedB);
    assert.ok(aAfter && bAfter, "both connections' evidence rows must exist after connector-wide delete");
    assert.equal(aAfter.dirty, true, "Postgres connector-wide delete marks connection A evidence dirty");
    assert.equal(bAfter.dirty, true, "Postgres connector-wide delete marks connection B evidence dirty");
  } finally {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ANY($1::text[])", [
      [clearedA, clearedB],
    ]);
    await postgresQuery("DELETE FROM records WHERE connector_instance_id = ANY($1::text[])", [[clearedA, clearedB]]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = ANY($1::text[])", [
      [clearedA, clearedB],
    ]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
    await closePostgresStorage();
  }
});

// ── Owner revoke seam (task 2.1): exercised end-to-end over the route ────────

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http/https servers (the framework never
// negotiates ALPN in this reference stack) — so `closeAllConnections` (added
// Node 18.2+) and the single-error-arg `close` callback genuinely exist and
// are safe to declare here. Matches the established pattern in
// connector-failure-diagnostics-control-plane.test.ts.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<{ body: T | null; status: number }> {
  const resp = await fetch(url, opts);
  const parsed: unknown = await resp.json().catch(() => null);
  return { body: parsed as T | null, status: resp.status };
}

async function withServer(fn: (ctx: { asUrl: string; rsUrl: string; server: TestServer }) => Promise<void>) {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  try {
    await fn({
      asUrl: `http://localhost:${server.asPort}`,
      rsUrl: `http://localhost:${server.rsPort}`,
      server,
    });
  } finally {
    await closeServer(server);
  }
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  assert.ok(device, "device_authorization should return a body");
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: OWNER_SUBJECT_ID, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tok } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: OWNER_CLIENT_ID,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(tok?.access_token, "device exchange should issue an owner token");
  return tok.access_token;
}

function loadReferenceManifest(name: string): { connector_id: string } {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests", `${name}.json`), "utf8"));
}

async function registerConnector(asUrl: string, manifest: { connector_id: string }) {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status}`);
  return manifest;
}

async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
}: {
  connectorInstanceId: string;
  connectorId: string;
  displayName: string;
  sourceBindingKey: string;
}) {
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName,
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: sourceBindingKey },
    sourceBindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

test("owner revoke route dirties the revoked connection summary evidence", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "spotify manifest must resolve to a canonical connector key");
    const instanceId = "cin_spotify_revoke_summary";
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: instanceId,
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    // Warm the read model so the revoke seam's scoped marker has a row to flip.
    await rebuildConnectorSummaryEvidence();
    const before = await getConnectorSummaryEvidence(instanceId);
    assert.ok(before, "evidence row must exist after rebuild");
    assert.equal(before.dirty, false);

    const ownerToken = await issueOwnerToken(asUrl);
    const revoke = await fetchJson<{ status: string }>(`${rsUrl}/v1/owner/connections/${instanceId}/revoke`, {
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(revoke.status, 200, "owner revoke should succeed");
    assert.ok(revoke.body, "revoke response should return a body");
    assert.equal(revoke.body.status, "revoked");

    const after = await getConnectorSummaryEvidence(instanceId);
    assert.ok(after, "evidence row must exist after revoke");
    assert.equal(after.dirty, true, "revoke marks the connection summary evidence dirty");
    assert.equal(after.state, "stale");
  });
});

// ── A non-revoke owner-mutation seam (task 2.1): rename over the route ────────
//
// Proves the scoped marker fires for an owner mutation that is NOT revoke. The
// rename route (`PATCH /v1/owner/connections/:connectionId`) is the simplest
// such seam — it touches only the connector-instance store (no controller) and
// changes durable summary evidence (display_name), so it isolates the
// markConnectorSummaryEvidenceDirty wiring from run/schedule controller setup.
test("owner rename route dirties the renamed connection summary evidence", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "spotify manifest must resolve to a canonical connector key");
    const instanceId = "cin_spotify_rename_summary";
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: instanceId,
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    // Warm the read model so the rename seam's scoped marker has a row to flip.
    await rebuildConnectorSummaryEvidence();
    const before = await getConnectorSummaryEvidence(instanceId);
    assert.ok(before, "evidence row must exist after rebuild");
    assert.equal(before.dirty, false);

    const ownerToken = await issueOwnerToken(asUrl);
    const renamed = await fetchJson(`${rsUrl}/v1/owner/connections/${instanceId}`, {
      body: JSON.stringify({ display_name: "the owner personal" }),
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      method: "PATCH",
    });
    assert.equal(renamed.status, 200, "owner rename should succeed");

    const after = await getConnectorSummaryEvidence(instanceId);
    assert.ok(after, "evidence row must exist after rename");
    assert.equal(after.dirty, true, "rename marks the connection summary evidence dirty");
    assert.equal(after.state, "stale");
  });
});
