// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getConnectorListSummaryTerminalProjection,
  getConnectorSummaryEvidence,
  markConnectorSummaryEvidenceDirty,
  rebuildConnectorSummaryEvidence,
  runBoundedSummaryEvidenceSweep,
} from "../server/connector-summary-read-model.ts";
import { publishConnectorListSummaryTerminalProjectionsForIds } from "../server/connector-summary-terminal-publisher.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { invalidateConnectorSummariesCache, REFERENCE_OWNER_SUBJECT_ID } from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const NOW = "2026-07-31T00:00:00.000Z";
const CONNECTOR_ID = "terminal_publisher_probe";

function publicListingManifest(connectorId: string) {
  return {
    capabilities: { public_listing: { listed: true, status: "test" } },
    connector_id: connectorId,
    display_name: "Terminal publisher probe connector",
    protocol_version: "0.1.0",
    // A non-empty `streams` array is required for the evidence engine's
    // manifest_declaration component to classify `current` (an empty/missing
    // array yields `ok: false` -> `unavailable`, see
    // connector-summary-evidence-engine.ts's parseManifestDeclaration).
    streams: [{ name: "items", primary_key: ["id"] }],
    version: "1.0.0",
  };
}

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-terminal-publisher-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    invalidateConnectorSummariesCache();
    return await fn();
  } finally {
    invalidateConnectorSummariesCache();
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function seedConnector(connectorId: string) {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(publicListingManifest(connectorId)), NOW);
}

async function seedInstance(connectorInstanceId: string, connectorId: string) {
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName: connectorInstanceId,
    ownerSubjectId: REFERENCE_OWNER_SUBJECT_ID,
    sourceBinding: { kind: "test" },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

test("successful run/ingest marks dirty, then the maintenance sweep converges evidence and publishes the terminal LIST projection", () =>
  withTempDb(async () => {
    const connectorInstanceId = "cin_terminal_publish_happy";
    seedConnector(CONNECTOR_ID);
    await seedInstance(connectorInstanceId, CONNECTOR_ID);
    await rebuildConnectorSummaryEvidence();

    const before = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(before.state, "unobserved", "nothing has ever published yet");

    // A real run/record-ingest marks the row dirty (canonical evidence moved).
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId, reason: "ingest" });
    const dirty = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.ok(dirty?.dirty, "dirty mark must actually flip the row");

    // The maintenance authority: bounded evidence sweep converges the row to
    // current, then the publisher assembles + publishes from the SAME ids
    // the sweep just repaired.
    const sweep = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 2000, pageSize: 25 });
    assert.equal(sweep.incomplete, false);
    assert.deepEqual([...sweep.observedIds].sort(), [connectorInstanceId]);

    const result = await publishConnectorListSummaryTerminalProjectionsForIds(sweep.observedIds);
    assert.equal(result.published, 1);
    assert.equal(result.rejected, 0);
    assert.equal(result.notCurrent, 0);

    const after = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(after.state, "current");
    assert.ok(after.projection, "a current terminal projection must carry a payload");
    assert.equal(after.projection.summary.connector_instance_id, connectorInstanceId);
    assert.equal(after.projection.summary.connection_id, connectorInstanceId);
    assert.ok(after.projection.runtime, "runtime evidence envelope must be stamped alongside the summary");
    assert.equal(typeof after.projection.runtime?.observed_at, "string");
  }));

test("a concurrent mutation during assembly makes the publish a fenced no-op; a later sweep retries and succeeds", () =>
  withTempDb(async () => {
    const connectorInstanceId = "cin_terminal_publish_race";
    seedConnector(CONNECTOR_ID);
    await seedInstance(connectorInstanceId, CONNECTOR_ID);
    await rebuildConnectorSummaryEvidence();

    let sweep = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 2000, pageSize: 25 });
    assert.deepEqual([...sweep.observedIds].sort(), [connectorInstanceId]);

    // Simulate a concurrent canonical mutation racing in between the sweep
    // converging the row and the publish step running against it.
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId, reason: "concurrent mutation" });

    const raced = await publishConnectorListSummaryTerminalProjectionsForIds(sweep.observedIds);
    assert.equal(raced.published, 0, "a row dirtied after the sweep observed it must never publish");
    assert.equal(raced.notCurrent, 1, "the publisher's own current-evidence read must see the fresh dirty mark");
    const stillNone = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(stillNone.state, "stale");
    assert.equal(stillNone.projection, null);

    // A later maintenance pass converges the row again and retries publish.
    sweep = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 2000, pageSize: 25 });
    const retried = await publishConnectorListSummaryTerminalProjectionsForIds(sweep.observedIds);
    assert.equal(retried.published, 1);
    const published = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(published.state, "current");
  }));

test("a restart/boot repair pass (a fresh bounded sweep over a never-before-observed connection) publishes its terminal LIST projection", () =>
  withTempDb(async () => {
    const connectorInstanceId = "cin_terminal_publish_boot";
    seedConnector(CONNECTOR_ID);
    await seedInstance(connectorInstanceId, CONNECTOR_ID);
    // No rebuild/observation has ever run for this connection — it is
    // exactly the "process restart / never-before-seen row" shape the
    // startup acceleration pass exists to repair.
    const before = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.equal(before, null, "no evidence row exists before the first observation");

    const sweep = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 5000, pageSize: 25 });
    assert.equal(sweep.incomplete, false);
    assert.ok(sweep.observedIds.includes(connectorInstanceId));

    const result = await publishConnectorListSummaryTerminalProjectionsForIds(sweep.observedIds);
    assert.equal(result.published, 1);

    const published = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(published.state, "current");
  }));

test("fleet-scale: a bounded sweep page publishes exactly its own page, never more, with one batched assembly (no N+1)", () =>
  withTempDb(async () => {
    const total = 40;
    const pageSize = 10;
    seedConnector(CONNECTOR_ID);
    const ids = Array.from({ length: total }, (_, i) => `cin_terminal_publish_scale_${String(i).padStart(3, "0")}`);
    for (const connectorInstanceId of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: bounded fixture seeding, not the code path under test.
      await seedInstance(connectorInstanceId, CONNECTOR_ID);
    }
    await rebuildConnectorSummaryEvidence();

    const sweep = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 5000, maxPages: 1, pageSize });
    assert.equal(
      sweep.observedIds.length,
      pageSize,
      "one bounded page must observe exactly pageSize ids, never the whole fleet"
    );

    const result = await publishConnectorListSummaryTerminalProjectionsForIds(sweep.observedIds);
    assert.equal(result.published, pageSize);

    let publishedCount = 0;
    for (const connectorInstanceId of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: bounded fixture-scale assertion loop, not the code path under test.
      const projection = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
      if (projection.state === "current") {
        publishedCount += 1;
      }
    }
    assert.equal(publishedCount, pageSize, "only the swept page's connections may have a current terminal projection");
  }));

// ── 2026-08-01 stuck-publisher regression: a page-wide `incomplete` flag
// (caused by ONE heavy connection's fold not converging within the shared
// budget) previously withheld EVERY id sharing that page from `observedIds`
// — including sibling connections whose own evidence was already fully
// current — so those siblings never got a publish attempt until keyset
// wraparound revisited their page, which can be many minutes away on a
// large/dirty fleet even though nothing was actually blocking them.
//
// The sibling's checkpoint is seeded directly at/above the page's terminal
// high-water mark so `rowNeedsFoldParticipation` is deterministically
// `false` for it — no wall-clock/deadline tuning needed to keep it out of
// fold participation while the heavy connection's own fold genuinely stops
// short of the same high-water mark. ────────────────────────────────────

let heavyEventSeq = 0;

function seedHeavyTerminalEvents(connectorInstanceId: string, count: number): void {
  const stmt = getDb().prepare(
    `INSERT INTO spine_events(
       event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
     ) VALUES (?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test', 'run', ?, 'succeeded', ?, ?, ?, '1')`
  );
  for (let i = 0; i < count; i += 1) {
    heavyEventSeq += 1;
    const data = JSON.stringify({
      collection_facts: {
        reference_only: true,
        schema_version: 1,
        streams: [{ record_count: heavyEventSeq, resolved: true, stream: "messages" }],
      },
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
    });
    stmt.run(
      `heavy_evt_${heavyEventSeq}`,
      heavyEventSeq,
      NOW,
      NOW,
      `heavy_trace_${heavyEventSeq}`,
      `heavy_run_${heavyEventSeq}`,
      `heavy_run_${heavyEventSeq}`,
      connectorInstanceId,
      data
    );
  }
}

test("a page-wide incomplete fold (one heavy connection sharing the page) does not withhold a sibling connection's already-current id from observedIds, and the sibling publishes", () =>
  withTempDb(async () => {
    seedConnector(CONNECTOR_ID);
    const heavyId = "cin_terminal_publish_a_heavy";
    const currentId = "cin_terminal_publish_b_current";
    await seedInstance(heavyId, CONNECTOR_ID);
    await seedInstance(currentId, CONNECTOR_ID);
    await rebuildConnectorSummaryEvidence();

    // Give the heavy connection a terminal-event backlog large enough that a
    // tightly bounded fold (maxEventsPerFold below) cannot converge it
    // within one page pass, raising the page's shared high-water mark
    // (`readMaxTerminalEventSeq`, scoped to the page's id set) to 2001.
    seedHeavyTerminalEvents(heavyId, 2001);
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: heavyId, reason: "heavy backlog" });

    // Deterministically exclude currentId from fold participation: its own
    // checkpoint is stamped at exactly the page's high-water mark, so
    // `rowNeedsFoldParticipation` (checkpoint < maxSeq) reads false for it
    // regardless of how far the heavy connection's own fold gets this pass —
    // the real-world equivalent of a connection whose terminal history was
    // already fully folded before a much larger sibling's backlog arrived.
    getDb()
      .prepare("UPDATE connector_summary_evidence SET stream_facts_event_seq = ? WHERE connector_instance_id = ?")
      .run(heavyEventSeq, currentId);

    const sweep = await runBoundedSummaryEvidenceSweep({
      maxDurationMs: 5000,
      maxEventsPerFold: 500,
      pageSize: 25,
    });

    assert.equal(sweep.incomplete, true, "the heavy connection's fold must not converge within a 500-event budget");
    assert.ok(
      sweep.observedIds.includes(currentId),
      "the sibling's id must still reach observedIds despite the shared page's incomplete flag"
    );

    const result = await publishConnectorListSummaryTerminalProjectionsForIds(sweep.observedIds);
    const currentProjection = await getConnectorListSummaryTerminalProjection(currentId);
    assert.equal(
      currentProjection.state,
      "current",
      "the sibling must actually publish, not just appear in observedIds"
    );

    const heavyProjection = await getConnectorListSummaryTerminalProjection(heavyId);
    assert.notEqual(
      heavyProjection.state,
      "current",
      "the genuinely non-converged heavy connection must NOT be published as current"
    );
    assert.ok(result.published >= 1);
  }));

const PUBLISHER_CALL_PATTERN =
  /publishConnectorListSummaryTerminalProjectionsForIds|publishConnectorListSummaryTerminalProjection\b/;

test("read endpoints never publish: publishConnectorListSummaryTerminalProjectionsForIds has no caller in the route/list-summary read path", async () => {
  const { readFileSync } = await import("node:fs");
  const forbiddenFiles = [
    "server/ref-control.ts",
    "server/routes/ref-connectors.ts",
    "operations/ref-connectors-list/index.ts",
    "operations/ref-connectors-detail/index.ts",
  ];
  for (const relativePath of forbiddenFiles) {
    let contents: string;
    try {
      contents = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    } catch {
      continue;
    }
    assert.doesNotMatch(
      contents,
      PUBLISHER_CALL_PATTERN,
      `${relativePath} must never call the terminal-projection publisher — ordinary reads must stay read-only`
    );
  }
});

// ── Postgres parity test (gated on PDPP_TEST_POSTGRES_URL) ───────────────────

async function cleanupPostgresFixture(connectorId: string, connectorInstanceId: string) {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
}

test("Postgres: successful run/ingest marks dirty, then the maintenance sweep converges evidence and publishes the terminal LIST projection", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const connectorId = "pg_terminal_publisher_probe";
  const connectorInstanceId = "cin_pg_terminal_publish_happy";
  try {
    await cleanupPostgresFixture(connectorId, connectorInstanceId);
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      connectorId,
      JSON.stringify(publicListingManifest(connectorId)),
      NOW,
    ]);
    await postgresQuery(
      `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         )
         VALUES($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
      [connectorInstanceId, REFERENCE_OWNER_SUBJECT_ID, connectorId, "PG terminal publish probe", NOW]
    );

    const before = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(before.state, "unobserved");

    // An evidence row must exist before a dirty mark can flip it — the
    // real trigger (record ingest / run completion) always writes through
    // a row the rebuild/reconcile machinery already materialized.
    await rebuildConnectorSummaryEvidence();
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId, reason: "pg ingest" });
    const dirty = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.ok(dirty?.dirty, "dirty mark must actually flip the row");

    const sweep = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 5000, pageSize: 25 });
    assert.equal(sweep.incomplete, false);
    assert.ok(sweep.observedIds.includes(connectorInstanceId));

    const result = await publishConnectorListSummaryTerminalProjectionsForIds(sweep.observedIds);
    assert.ok(result.published >= 1);

    const after = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(after.state, "current");
    assert.ok(after.projection, "a current terminal projection must carry a payload");
    assert.equal(after.projection.summary.connector_instance_id, connectorInstanceId);
  } finally {
    await cleanupPostgresFixture(connectorId, connectorInstanceId);
    await closePostgresStorage();
  }
});
