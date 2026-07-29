// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  expectedLocalCoverageStoreDescriptors,
  expectedLocalCoverageStores,
} from "../../packages/polyfill-connectors/src/local-source-inventory.ts";
import { auditStreamHealth } from "../../scripts/stream-health-audit/audit.ts";
import type { CollectionRateSnapshot, CoverageAxis, OutboxAxis } from "../runtime/connection-health.ts";
import {
  __setConnectorInstanceWritePhaseHookForTest,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { composeFleetHealthVerdict } from "../server/fleet-health.ts";
import { deriveReferenceFreshness, type ReferenceFreshness } from "../server/freshness.ts";
import { readCommittedLocalCoverageDiagnostics } from "../server/records.ts";
import {
  type ConnectorRunSummary,
  deriveLocalCoverageAxis,
  getConnectorSummaryForRoute,
  listConnectorSummaries,
  projectConnectorSummaryConnectionHealth,
} from "../server/ref-control.ts";
import { rebuildRetainedSize } from "../server/retained-size-read-model.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { getDefaultConnectorStateStore } from "../server/stores/connector-state-store.ts";
import { getDefaultDeviceExporterStore } from "../server/stores/device-exporter-store.ts";
import type { ActiveRunRecord } from "../server/stores/scheduler-store.ts";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";

// Mirrors the live 2026-06-03 evidence: a local collector source instance that
// is healthy and fully drained (pending=0, dead_letter=0, stale_leases=0) yet
// the `/_ref/connectors` rollup projects `SourceCoverageComplete:coverage_unknown`
// because local collectors have no spine run history to derive coverage from.
//
// These tests exercise the SERVER ROLLUP PATH (`listConnectorSummaries`), not a
// pure helper, so they prove the projection the dashboard actually consumes.

// `readCommittedLocalCoverageDiagnostics` lives in the untyped `records.js`
// module (`checkJs` is off for that legacy slice), so TS only infers a
// structural type from its call sites. This local type honestly documents
// the real return shape (see `parseCoverageDiagnosticsStateSnapshot` in
// `packages/polyfill-connectors/src/local-source-inventory.ts`, spread into
// the extra `state`/`updatedAt`/`manifestGeneration`/`stateManifestGeneration`
// fields `readCommittedLocalCoverageDiagnostics` adds) and lets the test read
// those fields without fighting the inferred union.
interface TestLocalCoverageProof {
  readonly duplicateStores: readonly string[];
  readonly hasAuthoritativeInventory: boolean;
  readonly hasCommittedSnapshot: boolean;
  readonly malformed: boolean;
  readonly manifestGeneration: number | null;
  readonly missingStores: readonly string[];
  readonly rows: readonly { readonly status?: unknown; readonly store?: unknown; readonly stream?: unknown }[];
  readonly state: unknown;
  readonly stateManifestGeneration: number | null;
  readonly unexpectedStores: readonly string[];
  readonly updatedAt: string | null;
}

async function readProof(target: {
  connector_id: string;
  connector_instance_id: string;
}): Promise<TestLocalCoverageProof> {
  return (await readCommittedLocalCoverageDiagnostics(target)) as TestLocalCoverageProof;
}

const CONNECTOR_ID = "claude-code";
const CONNECTOR_INSTANCE_ID = "cin_local_coverage_green";
const DEVICE_ID = "dev_local_coverage_green";
const SOURCE_INSTANCE_ID = "src_local_coverage_green";
const OWNER = "owner_local";
const NOW = "2026-06-03T12:00:00.000Z";
// A heartbeat well within the 30-minute stale window so a drained collector
// reads as `idle`, not `stalled` (the live evidence is freshly healthy).
const HEARTBEAT_AT = "2026-06-03T11:59:00.000Z";
const STALE_HISTORICAL_RUN_AT = "2026-05-22T14:31:18.319Z";
const STATE_CONNECTOR_ID = CONNECTOR_ID;

function withTmpDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-local-coverage-green-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

interface TestManifestCapabilities {
  public_listing: { listed: boolean; status: string };
  refresh_policy?: { maximum_staleness_seconds: number };
}

function seedConnector({
  refreshPolicy = null,
}: {
  refreshPolicy?: { maximum_staleness_seconds: number } | null;
} = {}) {
  const capabilities: TestManifestCapabilities = { public_listing: { listed: true, status: "test" } };
  if (refreshPolicy) {
    capabilities.refresh_policy = refreshPolicy;
  }
  const manifest = {
    capabilities,
    connector_id: CONNECTOR_ID,
    display_name: "Local Coverage Collector",
    protocol_version: "0.1.0",
    streams: [
      { coverage_strategy: "checkpoint_window", name: "sessions", primary_key: ["id"] },
      { coverage_strategy: "checkpoint_window", name: "messages", primary_key: ["id"], state_stream: "sessions" },
      { coverage_strategy: "checkpoint_window", name: "attachments", primary_key: ["id"], state_stream: "sessions" },
      { coverage_strategy: "snapshot_import_receipt", name: "coverage_diagnostics", primary_key: ["id"] },
    ],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

async function seedInstance() {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    createdAt: NOW,
    displayName: "laptop Claude Code",
    ownerSubjectId: OWNER,
    sourceBinding: { device: "laptop", kind: "local_device" },
    sourceBindingKey: "laptop",
    sourceKind: "local_device",
    status: "active",
    updatedAt: NOW,
  });
}

function seedRecord({
  stream,
  key,
  data,
  emittedAt,
  version = 1,
}: {
  stream: string;
  key: string;
  data: Record<string, unknown>;
  emittedAt: string;
  version?: number;
}) {
  getDb()
    .prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(CONNECTOR_ID, CONNECTOR_INSTANCE_ID, stream, key, JSON.stringify(data), emittedAt, version);
}

// Row shape accepted by `seedCoverage`. `status` intentionally accepts any
// string (not just `CoverageStatus`) because several tests below seed
// deliberately invalid statuses (e.g. `'surprise_status'`) to prove the
// server fails closed on malformed diagnostics rather than crashing.
interface TestCoverageRow {
  status: string;
  store: string;
  stream?: string | null;
}

// Seed one `coverage_diagnostics` record per known store. The connector emits
// these on a successful full local run; they are the durable, honest signal of
// what was and was not collected.
function seedCoverage(rows: readonly TestCoverageRow[], { includeExpected = true } = {}) {
  const expected = expectedLocalCoverageStoreDescriptors(CONNECTOR_ID);
  assert.ok(expected, "the production local connector must declare a fixed inventory");
  const supplied = new Map(rows.map((row) => [row.store, row]));
  const completeRows: readonly TestCoverageRow[] = includeExpected
    ? expected.map(({ store, stream }) => ({
        status: supplied.get(store)?.status ?? "inventory_only",
        store,
        stream,
      }))
    : rows;
  const extras = includeExpected ? rows.filter((row) => !expected.some((entry) => entry.store === row.store)) : [];
  [...completeRows, ...extras].forEach((row, index) => {
    seedRecord({
      data: { id: `coverage:${row.store}`, status: row.status, store: row.store, stream: row.stream ?? null },
      emittedAt: `2026-06-03T11:5${index}:00.000Z`,
      key: `coverage:${row.store}`,
      stream: "coverage_diagnostics",
    });
  });
  getDb()
    .prepare(
      `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
       VALUES (?, ?, 'coverage_diagnostics', ?, ?)`
    )
    .run(
      STATE_CONNECTOR_ID,
      CONNECTOR_INSTANCE_ID,
      JSON.stringify({
        fetched_at: "2026-06-03T11:58:30.000Z",
        stores: [...completeRows, ...extras].map(({ store, stream, status }) => ({
          status,
          store,
          stream: stream ?? null,
        })),
      }),
      "2026-06-03T11:58:31.000Z"
    );
}

function seedHistoricalSchedulerRun({ completedAt = STALE_HISTORICAL_RUN_AT } = {}) {
  getDb()
    .prepare(
      `INSERT INTO scheduler_run_history(
         connector_instance_id, connector_id, source_json, status, records_emitted,
         known_gaps_json, run_id, started_at, completed_at, attempt
       )
       VALUES (?, ?, ?, 'succeeded', 1, '[]', 'run_stale_history', ?, ?, 1)`
    )
    .run(CONNECTOR_INSTANCE_ID, CONNECTOR_ID, "{}", completedAt, completedAt);
}

async function seedHealthyDrainedHeartbeat() {
  const store = getDefaultDeviceExporterStore();
  await store.createDevice({
    createdAt: NOW,
    deviceId: DEVICE_ID,
    displayName: "laptop",
    ownerSubjectId: OWNER,
    status: "active",
    updatedAt: NOW,
  });
  await store.upsertSourceInstance({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    createdAt: NOW,
    deviceId: DEVICE_ID,
    displayName: "laptop Claude Code",
    localBindingId: "laptop",
    sourceInstanceId: SOURCE_INSTANCE_ID,
    status: "active",
    updatedAt: NOW,
  });
  // Healthy + fully drained: pending=0, dead_letter=0, stale_leases=0.
  await store.markSourceInstanceHeartbeat(DEVICE_ID, SOURCE_INSTANCE_ID, {
    lastError: null,
    outboxDiagnostics: { dead_letter: 0, pending: 0, stale_leases: 0, succeeded: 12, total: 12 },
    receivedAt: HEARTBEAT_AT,
    recordsPending: 0,
    status: "healthy",
  });
}

async function seedActiveDrainingHeartbeat({ receivedAt = new Date().toISOString() } = {}) {
  const store = getDefaultDeviceExporterStore();
  await store.createDevice({
    createdAt: NOW,
    deviceId: DEVICE_ID,
    displayName: "laptop",
    ownerSubjectId: OWNER,
    status: "active",
    updatedAt: NOW,
  });
  await store.upsertSourceInstance({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    createdAt: NOW,
    deviceId: DEVICE_ID,
    displayName: "laptop Claude Code",
    localBindingId: "laptop",
    sourceInstanceId: SOURCE_INSTANCE_ID,
    status: "active",
    updatedAt: NOW,
  });
  // Active + making progress: pending work exists, but the collector is checking
  // in recently and has no dead letters or stale leases.
  await store.markSourceInstanceHeartbeat(DEVICE_ID, SOURCE_INSTANCE_ID, {
    lastError: null,
    outboxDiagnostics: { dead_letter: 0, pending: 5, stale_leases: 0, succeeded: 7, total: 12 },
    receivedAt,
    recordsPending: 5,
    status: "retrying",
  });
  return receivedAt;
}

// A blocked heartbeat carrying failed-upload records: the outbox axis derives
// to `stalled` with cause `dead_letter_backlog`, so the verdict must not fire.
async function seedDeadLetterHeartbeat() {
  const store = getDefaultDeviceExporterStore();
  await store.createDevice({
    createdAt: NOW,
    deviceId: DEVICE_ID,
    displayName: "laptop",
    ownerSubjectId: OWNER,
    status: "active",
    updatedAt: NOW,
  });
  await store.upsertSourceInstance({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    createdAt: NOW,
    deviceId: DEVICE_ID,
    displayName: "laptop Claude Code",
    localBindingId: "laptop",
    sourceInstanceId: SOURCE_INSTANCE_ID,
    status: "active",
    updatedAt: NOW,
  });
  await store.markSourceInstanceHeartbeat(DEVICE_ID, SOURCE_INSTANCE_ID, {
    lastError: { classes: { "400 invalid_request": 3 }, kind: "dead_letter_backlog" },
    outboxDiagnostics: { dead_letter: 3, pending: 0, stale_leases: 0, succeeded: 9, total: 12 },
    receivedAt: HEARTBEAT_AT,
    recordsPending: 3,
    status: "blocked",
  });
}

async function projectConnection() {
  const summaries = await listConnectorSummaries();
  const row = summaries.find((summary) => summary.connector_instance_id === CONNECTOR_INSTANCE_ID);
  assert.ok(row, "expected the local-device connection to project a summary row");
  return row;
}

test(
  "healthy drained local collector with full coverage diagnostics projects coverage=complete (no longer unknown)",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedRecord({
      data: { id: "msg_1", text: "collected message" },
      emittedAt: "2026-06-03T11:58:00.000Z",
      key: "msg_1",
      stream: "messages",
    });
    // Every known store is accounted for (collected / inventory-only / excluded).
    // The real local collectors emit one diagnostic for the parent project/session
    // store; co-emitted child streams inherit that coverage through `state_stream`.
    seedCoverage([
      { status: "collected", store: "projects", stream: "sessions" },
      { status: "inventory_only", store: "cache", stream: null },
      { status: "excluded", store: "auth", stream: null },
    ]);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    // The durable coverage evidence proves complete coverage, so the projection
    // must NOT remain coverage_unknown. This is the core fix: the live symptom
    // was `SourceCoverageComplete:coverage_unknown` on a drained collector.
    assert.equal(health.axes.coverage, "complete");
    assert.equal(health.axes.outbox, "idle");

    const reportByStream = Object.fromEntries(row.collection_report.map((entry) => [entry.stream, entry]));
    assert.equal(
      reportByStream.messages?.coverage_condition,
      "complete",
      "local coverage diagnostics should prove child-stream coverage through the state_stream parent"
    );
    assert.equal(
      reportByStream.attachments?.coverage_condition,
      "complete",
      "co-emitted local child streams inherit coverage from their declared parent stream"
    );
    assert.equal(
      reportByStream.coverage_diagnostics?.coverage_condition,
      "complete",
      "coverage_diagnostics proves itself complete once durable diagnostic rows exist"
    );
    assert.equal(
      reportByStream.sessions?.coverage_condition,
      "complete",
      "local coverage diagnostics should prove per-stream coverage even when the stream emitted no retained records"
    );
    assert.notEqual(reportByStream.messages?.forward_disposition, "unmeasured");
    assert.notEqual(reportByStream.sessions?.forward_disposition, "unmeasured");

    const coverageCondition = health.conditions.find((c) => c.type === "SourceCoverageComplete");
    assert.ok(coverageCondition);
    assert.equal(coverageCondition.status, "true");
    assert.notEqual(coverageCondition.reason, "coverage_unknown");

    // Headline: this connector declares NO refresh policy, so freshness is
    // `unknown` and the local-device collection verdict is not established. The
    // honest headline is `idle` (the device-ingest-state rung from the
    // "Local-device connection without scheduler run" spec scenario), NOT
    // `unknown` and NOT a fabricated `healthy`. Coverage no longer drags the
    // projection to unknown.
    assert.equal(health.state, "idle");
    assert.notEqual(health.state, "unknown");

    const retainedByStream = Object.fromEntries(row.stream_records.map((entry) => [entry.stream, entry.record_count]));
    assert.equal(retainedByStream.messages, 1, "retained per-stream counts ride on the connector summary");
    const expectedStoresForRetainedCount = expectedLocalCoverageStores(CONNECTOR_ID);
    assert.ok(expectedStoresForRetainedCount, "the production local connector must declare a fixed inventory");
    assert.equal(
      retainedByStream.coverage_diagnostics,
      expectedStoresForRetainedCount.length,
      "every fixed-inventory diagnostic remains visible instead of collapsing into the source total"
    );
    // `sessions` and `attachments` are manifest-declared streams with NO
    // retained records in this fixture. The retained-size projection was
    // rebuilt (proven fresh/clean) above, so the exact-zero-stream-counts join
    // synthesizes a genuine `0` for them instead of leaving them absent — the
    // console can show "0 records" for `sessions` even though its coverage is
    // proven complete purely from `coverage_diagnostics`, not retained rows.
    assert.equal(
      retainedByStream.sessions,
      0,
      "a declared stream proven covered via local diagnostics still gets an exact retained-size zero"
    );
    assert.equal(retainedByStream.attachments, 0, "co-emitted zero-record declared streams also synthesize exact zero");
  })
);

test(
  "repair-lock failure reaches health, required-report authority, and fleet without degrading optional local policy semantics",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedCoverage([{ status: "collected", store: "projects", stream: "sessions" }]);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    // Establish current evidence, then change the canonical record checkpoint so
    // the next owner read must repair under the shared instance writer fence.
    await projectConnection();
    seedRecord({
      data: { id: "repair-lock-probe" },
      emittedAt: NOW,
      key: "repair-lock-probe",
      stream: "messages",
      version: 2,
    });

    const previousWait = process.env.PDPP_INGEST_LOCK_WAIT_MS;
    process.env.PDPP_INGEST_LOCK_WAIT_MS = "10";
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    let releaseHolder: () => void = () => {};
    const acquired = new Promise<void>((resolve) => {
      __setConnectorInstanceWritePhaseHookForTest((stage, { connectorInstanceId }) => {
        if (stage === "after_acquire" && connectorInstanceId === CONNECTOR_INSTANCE_ID) {
          resolve();
        }
      });
    });
    const release = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withConnectorInstanceWrite(CONNECTOR_INSTANCE_ID, async () => release);

    try {
      await acquired;
      const row = await projectConnection();
      const report = new Map(row.collection_report.map((entry) => [entry.stream, entry]));

      assert.equal(row.connection_health.state, "unknown");
      assert.deepEqual(row.connection_health.unknown_reasons, ["repair_lock_unavailable"]);
      for (const stream of ["sessions", "messages", "attachments", "coverage_diagnostics"]) {
        const entry = report.get(stream);
        assert.equal(entry?.considered, "unknown", `${stream} has no authoritative denominator`);
        assert.equal(entry?.covered, "unknown", `${stream} has no authoritative numerator`);
        assert.equal(entry?.checkpoint, "unknown", `${stream} has no authoritative checkpoint`);
        assert.equal(entry?.coverage_condition, "unknown", `${stream} cannot present as complete after failed repair`);
      }

      const fleet = composeFleetHealthVerdict({
        coverageAudit: { status: "pass" },
        inventory: [
          {
            connectorId: CONNECTOR_ID,
            connectorInstanceId: CONNECTOR_INSTANCE_ID,
            displayName: "laptop Claude Code",
            revokedAt: null,
            status: "active",
          },
        ],
        runtime: { ok: true },
        summaries: [row],
      });
      assert.equal(fleet.state, "indeterminate");
      assert.deepEqual(
        fleet.dimensions.unknown_evidence.map((entry) => entry.connection_id),
        [CONNECTOR_INSTANCE_ID]
      );
    } finally {
      releaseHolder();
      await holder;
      __setConnectorInstanceWritePhaseHookForTest(null);
      if (previousWait === undefined) {
        delete process.env.PDPP_INGEST_LOCK_WAIT_MS;
      } else {
        process.env.PDPP_INGEST_LOCK_WAIT_MS = previousWait;
      }
    }
  })
);

test(
  "SQLite coverage reader enforces the shared production inventory exactly",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedCoverage([{ status: "collected", store: "projects", stream: "sessions" }]);

    const proof = await readProof({
      connector_id: STATE_CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
    });
    assert.deepEqual(proof.missingStores, []);
    assert.deepEqual(proof.unexpectedStores, []);
    assert.deepEqual(proof.duplicateStores, []);
    assert.equal(proof.malformed, false);
    assert.equal(proof.hasAuthoritativeInventory, true);
    assert.equal(proof.hasCommittedSnapshot, true);

    seedRecord({
      data: { id: "coverage:foreign", status: "inventory_only", store: "foreign", stream: null },
      emittedAt: "2026-06-03T11:58:59.000Z",
      key: "coverage:foreign",
      stream: "coverage_diagnostics",
    });
    const foreignProof = await readProof({
      connector_id: CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
    });
    assert.deepEqual(foreignProof.unexpectedStores, []);
    assert.equal(foreignProof.hasCommittedSnapshot, true, "retained diagnostic RECORDs cannot alter committed proof");
  })
);

test(
  "manifest-generation boundary withholds old local STATE until a no-op proof commit advances it",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedCoverage([{ status: "collected", store: "projects", stream: "sessions" }]);
    getDb()
      .prepare(
        `INSERT INTO connector_summary_evidence(
       connector_instance_id, connector_id, display_name, manifest_generation
     ) VALUES (?, ?, '', ?)`
      )
      .run(CONNECTOR_INSTANCE_ID, CONNECTOR_ID, 0);
    getDb()
      .prepare("UPDATE connector_instances SET manifest_generation = 1 WHERE connector_instance_id = ?")
      .run(CONNECTOR_INSTANCE_ID);

    const target = { connector_id: CONNECTOR_ID, connector_instance_id: CONNECTOR_INSTANCE_ID };
    const before = await readProof(target);
    assert.equal(deriveLocalCoverageAxis(before).axis, "unknown", "pre-boundary STATE is stale after manifest re-add");

    const stateStore = getDefaultConnectorStateStore();
    await stateStore.putState(
      { connectorId: CONNECTOR_ID, connectorInstanceId: CONNECTOR_INSTANCE_ID },
      { coverage_diagnostics: before.state }
    );
    const after = await readProof(target);
    assert.equal(
      after.stateManifestGeneration,
      after.manifestGeneration,
      "no-op successful STATE PUT commits the current durable generation"
    );
    assert.equal(deriveLocalCoverageAxis(after).axis, "complete");
  })
);

test(
  "SQLite persisted private coverage STATE is malformed, cannot project complete, and never reaches summary or audit output",
  withTmpDb(async () => {
    const privacySentinel = "/private/local-coverage-sentinel";
    seedConnector();
    await seedInstance();
    seedCoverage([{ status: "collected", store: "projects", stream: "sessions" }]);
    const expectedDescriptorsForPrivacyTest = expectedLocalCoverageStoreDescriptors(CONNECTOR_ID);
    assert.ok(expectedDescriptorsForPrivacyTest, "the production local connector must declare a fixed inventory");
    getDb()
      .prepare(
        `UPDATE connector_state SET state_json = ? WHERE connector_id = ? AND connector_instance_id = ? AND stream = 'coverage_diagnostics'`
      )
      .run(
        JSON.stringify({
          fetched_at: "2026-06-03T11:58:30.000Z",
          stores: expectedDescriptorsForPrivacyTest.map(({ store, stream }) => ({
            secret_path: privacySentinel,
            status: "inventory_only",
            store,
            stream,
          })),
        }),
        STATE_CONNECTOR_ID,
        CONNECTOR_INSTANCE_ID
      );
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const proof = await readProof({
      connector_id: STATE_CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
    });
    const summary = await projectConnection();
    const audit = auditStreamHealth([summary]);

    assert.equal(proof.malformed, true);
    assert.equal(proof.hasCommittedSnapshot, false);
    assert.equal(summary.connection_health.axes.coverage, "unknown");
    assert.equal(JSON.stringify({ audit, summary }).includes(privacySentinel), false);
  })
);

test(
  "unsupported local inventory cannot turn an arbitrary singleton into complete report or audit pass",
  withTmpDb(async () => {
    const connectorId = "unsupported-local-proof-gate";
    const instanceId = "cin_unsupported_local_proof";
    const deviceId = "dev_unsupported_local_proof";
    const sourceInstanceId = "src_unsupported_local_proof";
    const manifest = {
      capabilities: { public_listing: { listed: true, status: "test" } },
      connector_id: connectorId,
      display_name: "Unsupported local proof",
      protocol_version: "0.1.0",
      streams: [
        { coverage_strategy: "checkpoint_window", name: "messages", primary_key: ["id"] },
        { coverage_strategy: "snapshot_import_receipt", name: "coverage_diagnostics", primary_key: ["id"] },
      ],
      version: "1.0.0",
    };
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
      .run(connectorId, JSON.stringify(manifest), NOW);
    await createSqliteConnectorInstanceStore().upsert({
      connectorId,
      connectorInstanceId: instanceId,
      createdAt: NOW,
      displayName: "unknown local",
      ownerSubjectId: OWNER,
      sourceBinding: { kind: "local_device" },
      sourceBindingKey: "unknown-local",
      sourceKind: "local_device",
      status: "active",
      updatedAt: NOW,
    });
    for (const [stream, key, data] of [
      ["messages", "m1", { id: "m1" }],
      [
        "coverage_diagnostics",
        "coverage:any",
        { id: "coverage:any", status: "collected", store: "any-single-store", stream: "messages" },
      ],
    ]) {
      getDb()
        .prepare(
          "INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted) VALUES (?, ?, ?, ?, ?, ?, 1, 0)"
        )
        .run(connectorId, instanceId, stream, key, JSON.stringify(data), HEARTBEAT_AT);
    }
    getDb()
      .prepare(
        `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at) VALUES (?, ?, 'coverage_diagnostics', ?, ?)`
      )
      .run(connectorId, instanceId, JSON.stringify({ fetched_at: HEARTBEAT_AT }), HEARTBEAT_AT);
    const devices = getDefaultDeviceExporterStore();
    await devices.createDevice({
      createdAt: NOW,
      deviceId,
      displayName: "unknown local",
      ownerSubjectId: OWNER,
      status: "active",
      updatedAt: NOW,
    });
    await devices.upsertSourceInstance({
      connectorId,
      connectorInstanceId: instanceId,
      createdAt: NOW,
      deviceId,
      displayName: "unknown local",
      localBindingId: "unknown-local",
      sourceInstanceId,
      status: "active",
      updatedAt: NOW,
    });
    await devices.markSourceInstanceHeartbeat(deviceId, sourceInstanceId, {
      lastError: null,
      outboxDiagnostics: { dead_letter: 0, pending: 0, stale_leases: 0, succeeded: 0, total: 0 },
      receivedAt: HEARTBEAT_AT,
      recordsPending: 0,
      status: "healthy",
    });
    await rebuildRetainedSize();
    const row = (await listConnectorSummaries()).find((summary) => summary.connector_instance_id === instanceId);
    assert.ok(row);
    assert.equal(row.connection_health.axes.coverage, "unknown");
    assert.notEqual(row.collection_report.find((entry) => entry.stream === "messages")?.coverage_condition, "complete");
    assert.notEqual(auditStreamHealth([row]).status, "pass");
  })
);

test(
  "shipped ChatGPT account projection keeps every required stream unmeasured after a session-required scheduler failure",
  withTmpDb(async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../packages/polyfill-connectors/manifests/chatgpt.json", import.meta.url), "utf8")
    ) as { connector_id: string; streams: readonly { name: string }[] };
    const connectorId = manifest.connector_id;
    const instanceId = "cin_shipped_chatgpt_session_required";
    const requiredStreams = manifest.streams.map((stream) => stream.name).sort();

    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
      .run(connectorId, JSON.stringify(manifest), NOW);
    await createSqliteConnectorInstanceStore().upsert({
      connectorId,
      connectorInstanceId: instanceId,
      createdAt: NOW,
      displayName: "ChatGPT browser account",
      ownerSubjectId: OWNER,
      sourceBinding: { device: "laptop", kind: "browser_collector" },
      sourceBindingKey: "chatgpt-browser-account",
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });

    const scheduler = createSqliteSchedulerStore();
    await scheduler.appendRunHistory({
      attempt: 1,
      checkpointSummary: null,
      completedAt: NOW,
      connectorError: null,
      connectorId,
      connectorInstanceId: instanceId,
      failureReason: "session_required",
      knownGaps: [],
      recordsEmitted: 0,
      reportedRecordsEmitted: 0,
      runId: "run_shipped_chatgpt_session_required",
      source: { id: connectorId, kind: "connector" },
      startedAt: NOW,
      status: "failed",
      terminalReason: "session_required",
      traceId: "trc_shipped_chatgpt_session_required",
    });
    await scheduler.upsertLastRunTime(instanceId, Date.parse(NOW), NOW, connectorId);

    const summary = await getConnectorSummaryForRoute(instanceId);
    assert.ok(summary, "the production route projection resolves the persisted account instance");
    assert.equal(
      summary.connection_health.conditions?.find((condition) => condition.type === "CredentialsValid")?.reason,
      "session_required",
      "the production projection must retain the persisted scheduler failure reason"
    );
    const reportByStream = new Map(summary.collection_report.map((entry) => [entry.stream, entry]));
    assert.deepEqual([...reportByStream.keys()].sort(), requiredStreams);
    for (const stream of requiredStreams) {
      const entry = reportByStream.get(stream);
      assert.equal(entry?.coverage_condition, "unknown", `${stream} must remain unknown`);
      assert.equal(entry?.forward_disposition, "unmeasured", `${stream} must remain unmeasured`);
    }

    const audit = auditStreamHealth([summary]);
    assert.equal(audit.status, "fail");
    assert.deepEqual(
      // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
      [...(audit.failures[0]?.streams ?? [])].sort((a, b) => a.stream.localeCompare(b.stream)),
      requiredStreams.map((stream) => ({ class: "runtime_evidence_missing", stream })),
      "each shipped required stream is red until runtime evidence is committed"
    );
  })
);

// A century-long staleness window so the fixed-timestamp heartbeat reads as
// `current` regardless of real wall-clock time when the test runs (the server
// rollup uses `new Date()` for `now`; no injection seam exists here).
const ALWAYS_FRESH_REFRESH_POLICY = { maximum_staleness_seconds: 100 * 365 * 24 * 60 * 60 };

test(
  "local committed coverage supports a healthy local-device verdict",
  withTmpDb(async () => {
    // Same fully-green device evidence as the idle case above, but the manifest
    // now declares a refresh policy that the recent healthy heartbeat satisfies.
    // With trusted idle outbox + complete coverage + fresh freshness, the
    // A committed coverage STATE plus a fresh drained device proves a healthy
    // local-device result without relying on scheduler run history.
    seedConnector({ refreshPolicy: ALWAYS_FRESH_REFRESH_POLICY });
    await seedInstance();
    seedRecord({
      data: { id: "msg_1", text: "collected message" },
      emittedAt: "2026-06-03T11:58:00.000Z",
      key: "msg_1",
      stream: "messages",
    });
    seedCoverage([
      { status: "collected", store: "projects", stream: "sessions" },
      { status: "inventory_only", store: "cache", stream: null },
      { status: "excluded", store: "auth", stream: null },
    ]);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    assert.equal(health.axes.coverage, "complete");
    assert.equal(health.axes.outbox, "idle");
    assert.equal(health.axes.freshness, "fresh");
    assert.equal(health.state, "healthy");

    const collection = health.conditions.find((c) => c.type === "CollectionSucceeded");
    assert.ok(collection);
    assert.equal(collection.status, "true");
    assert.equal(collection.origin, "local_device");
  })
);

test(
  "healthy drained local collector uses heartbeat freshness even with stale historical scheduler history",
  withTmpDb(async () => {
    // Mirrors live local-device connections after machine restarts: the collector
    // has checked in and drained, but an old scheduler row remains on the
    // connection. Push-mode freshness must use trusted local progress rather than
    // letting stale scheduler history force a degraded headline.
    seedConnector({ refreshPolicy: ALWAYS_FRESH_REFRESH_POLICY });
    await seedInstance();
    seedRecord({
      data: { id: "msg_1", text: "collected message" },
      emittedAt: "2026-06-03T11:58:00.000Z",
      key: "msg_1",
      stream: "messages",
    });
    seedCoverage([
      { status: "collected", store: "projects", stream: "sessions" },
      { status: "inventory_only", store: "cache", stream: null },
      { status: "excluded", store: "auth", stream: null },
    ]);
    seedHistoricalSchedulerRun();
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    assert.equal(row.last_run, null, "local-device authority must not hydrate stale scheduler history");
    assert.equal(row.freshness.status, "current");
    assert.equal(row.freshness.captured_at, HEARTBEAT_AT);
    assert.equal(health.axes.freshness, "fresh");
    assert.equal(health.axes.coverage, "complete");
    assert.equal(health.axes.outbox, "idle");
    assert.equal(health.state, "healthy");
  })
);

test(
  "active local collector uses heartbeat freshness while outbox axis carries draining work",
  withTmpDb(async () => {
    // Mirrors post-crash recovery while a local collector is still uploading:
    // recent heartbeat + active outbox means the owner does not need to repair
    // the source. The outbox axis carries "still syncing"; stale historical run
    // history must not turn that into degraded/manual repair.
    seedConnector({ refreshPolicy: ALWAYS_FRESH_REFRESH_POLICY });
    await seedInstance();
    seedRecord({
      data: { id: "msg_1", text: "collected message" },
      emittedAt: "2026-06-03T11:58:00.000Z",
      key: "msg_1",
      stream: "messages",
    });
    seedCoverage([
      { status: "collected", store: "projects", stream: "sessions" },
      { status: "inventory_only", store: "cache", stream: null },
      { status: "excluded", store: "auth", stream: null },
    ]);
    seedHistoricalSchedulerRun();
    const activeHeartbeatAt = await seedActiveDrainingHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    assert.equal(row.local_device_progress?.records_pending, 5);
    assert.equal(row.freshness.status, "current");
    assert.equal(row.freshness.captured_at, activeHeartbeatAt);
    assert.equal(health.axes.freshness, "fresh");
    assert.equal(health.axes.outbox, "active");
    assert.notEqual(health.state, "healthy");
  })
);

test(
  "stalled local collector with a satisfied freshness policy stays degraded, never healthy",
  withTmpDb(async () => {
    // A refresh policy is satisfied and coverage is complete, but the outbox is
    // NOT idle — a dead-letter backlog. The verdict must not fire; the stalled
    // axis degrades the headline. Proves the freshness policy alone cannot green
    // a connection whose device work is stuck.
    seedConnector({ refreshPolicy: ALWAYS_FRESH_REFRESH_POLICY });
    await seedInstance();
    seedRecord({
      data: { id: "msg_1", text: "collected message" },
      emittedAt: "2026-06-03T11:58:00.000Z",
      key: "msg_1",
      stream: "messages",
    });
    seedCoverage([{ status: "collected", store: "projects", stream: "sessions" }]);
    await seedDeadLetterHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    assert.equal(health.axes.outbox, "stalled");
    assert.equal(health.state, "degraded");
    assert.notEqual(health.state, "healthy");
  })
);

test(
  "local coverage stays unknown without its committed coverage STATE even when diagnostic records look complete",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedRecord({
      data: { id: "coverage:sessions", status: "collected", store: "sessions", stream: "sessions" },
      emittedAt: "2026-06-03T11:58:00.000Z",
      key: "coverage:sessions",
      stream: "coverage_diagnostics",
    });
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    assert.equal(row.connection_health.axes.coverage, "unknown");
    assert.notEqual(row.connection_health.state, "healthy");
  })
);

test(
  "duplicate local coverage stores and malformed committed STATE fail closed",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedCoverage([{ status: "collected", store: "projects", stream: "sessions" }]);
    seedRecord({
      data: { id: "coverage:projects-duplicate", status: "collected", store: "projects", stream: "sessions" },
      emittedAt: "2026-06-03T11:58:01.000Z",
      key: "coverage:projects-duplicate",
      stream: "coverage_diagnostics",
    });
    getDb()
      .prepare(
        `UPDATE connector_state SET state_json = ? WHERE connector_id = ? AND connector_instance_id = ? AND stream = 'coverage_diagnostics'`
      )
      .run(JSON.stringify({ fetched_at: "not-a-timestamp" }), STATE_CONNECTOR_ID, CONNECTOR_INSTANCE_ID);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    assert.equal(row.connection_health.axes.coverage, "unknown");
    assert.notEqual(row.connection_health.state, "healthy");
  })
);

const STATE_MUTATION_CASES: readonly (readonly [string, () => unknown])[] = [
  [
    "null STATE",
    () =>
      getDb()
        .prepare(
          `UPDATE connector_state SET state_json = 'null' WHERE connector_id = ? AND connector_instance_id = ? AND stream = 'coverage_diagnostics'`
        )
        .run(STATE_CONNECTOR_ID, CONNECTOR_INSTANCE_ID),
  ],
  [
    "malformed cursor",
    () =>
      getDb()
        .prepare(
          `UPDATE connector_state SET state_json = ? WHERE connector_id = ? AND connector_instance_id = ? AND stream = 'coverage_diagnostics'`
        )
        .run(JSON.stringify({ fetched_at: "not-a-date" }), STATE_CONNECTOR_ID, CONNECTOR_INSTANCE_ID),
  ],
  [
    "future cursor",
    () =>
      getDb()
        .prepare(
          `UPDATE connector_state SET state_json = ?, updated_at = ? WHERE connector_id = ? AND connector_instance_id = ? AND stream = 'coverage_diagnostics'`
        )
        .run(
          JSON.stringify({ fetched_at: "2100-01-01T00:00:00.000Z" }),
          "2100-01-01T00:00:00.000Z",
          STATE_CONNECTOR_ID,
          CONNECTOR_INSTANCE_ID
        ),
  ],
];

for (const [name, mutate] of STATE_MUTATION_CASES) {
  test(
    `local ${name} cannot publish complete coverage rows`,
    withTmpDb(async () => {
      seedConnector();
      await seedInstance();
      seedCoverage([{ status: "collected", store: "projects", stream: "sessions" }]);
      mutate();
      await seedHealthyDrainedHeartbeat();
      await rebuildRetainedSize();

      const row = await projectConnection();
      const coverageCondition = row.connection_health.conditions.find(
        (condition) => condition.type === "SourceCoverageComplete"
      );
      assert.equal(row.connection_health.axes.coverage, "unknown");
      assert.ok(coverageCondition);
      assert.equal(coverageCondition.status, "unknown");
      assert.notEqual(row.connection_health.state, "healthy");
    })
  );
}

test(
  "missing fixed-inventory coverage store cannot publish complete coverage rows",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    const expected = expectedLocalCoverageStores(CONNECTOR_ID);
    assert.ok(expected);
    seedCoverage(
      expected
        .filter((store) => store !== "auth")
        .map((store) => ({
          status: "inventory_only",
          store,
          stream: store === "projects" ? "sessions" : null,
        })),
      { includeExpected: false }
    );
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    assert.equal(row.connection_health.axes.coverage, "unknown");
    assert.notEqual(row.connection_health.state, "healthy");
  })
);

test("coverage proof eligibility ignores wall-clock ordering when generations match", () => {
  const base = {
    duplicateStores: [],
    hasAuthoritativeInventory: true,
    hasCommittedSnapshot: true,
    malformed: false,
    manifestGeneration: 4,
    missingStores: [],
    nowIso: "2026-06-03T12:00:00.000Z",
    rows: [{ status: "collected", store: "projects", stream: "sessions" }],
    state: { fetched_at: "2026-06-03T12:05:01.000Z" },
    stateManifestGeneration: 4,
    unexpectedStores: [],
    updatedAt: "2026-06-03T12:05:01.000Z",
  };
  assert.equal(deriveLocalCoverageAxis(base).reliable, true);
  assert.equal(deriveLocalCoverageAxis({ ...base, manifestGeneration: 5 }).reliable, false);
});

test(
  "local collector with unaccounted stores projects coverage gaps with actionable reason, not unknown",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedRecord({
      data: { id: "msg_1", text: "collected message" },
      emittedAt: "2026-06-03T11:58:00.000Z",
      key: "msg_1",
      stream: "messages",
    });
    // One store the collector discovered but could not classify -> unaccounted.
    seedCoverage([{ status: "unaccounted", store: "projects", stream: "sessions" }]);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    // Coverage must surface the gap honestly rather than hiding it behind green
    // or behind a generic unknown.
    assert.notEqual(health.axes.coverage, "unknown");
    assert.notEqual(health.axes.coverage, "complete");

    const coverageCondition = health.conditions.find((c) => c.type === "SourceCoverageComplete");
    assert.ok(coverageCondition);
    assert.equal(coverageCondition.status, "false");
    // Reason/remediation must be actionable and name the coverage shortfall.
    assert.ok(coverageCondition.remediation);
    assert.notEqual(coverageCondition.reason, "coverage_unknown");

    // Degraded, not silently healthy.
    assert.equal(health.state, "degraded");
  })
);

test(
  "local collector with malformed coverage status fails closed, never complete",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedRecord({
      data: { id: "msg_1", text: "collected message" },
      emittedAt: "2026-06-03T11:58:00.000Z",
      key: "msg_1",
      stream: "messages",
    });
    seedCoverage([{ status: "surprise_status", store: "projects", stream: "sessions" }]);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    assert.equal(health.axes.coverage, "unknown");
    const coverageCondition = health.conditions.find((c) => c.type === "SourceCoverageComplete");
    assert.ok(coverageCondition);
    assert.equal(coverageCondition.status, "unknown");
  })
);

test(
  "healthy drained local collector with NO coverage diagnostics stays unknown (empty outbox is not complete)",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedRecord({
      data: { id: "msg_1", text: "collected message" },
      emittedAt: "2026-06-03T11:58:00.000Z",
      key: "msg_1",
      stream: "messages",
    });
    // No coverage_diagnostics records: a run never proved its coverage.
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    // An empty/drained outbox is NOT proof of complete coverage. Without durable
    // coverage evidence, coverage stays unknown rather than being painted green.
    assert.equal(health.axes.coverage, "unknown");
    const coverageCondition = health.conditions.find((c) => c.type === "SourceCoverageComplete");
    assert.ok(coverageCondition);
    assert.equal(coverageCondition.status, "unknown");
    assert.equal(coverageCondition.reason, "coverage_unknown");
    assert.notEqual(health.state, "healthy");
  })
);

const FRESH_FRESHNESS: ReferenceFreshness = { captured_at: "2026-06-03T11:58:00.000Z", status: "current" };

// Minimal-but-honest `LocalCoverageDiagnosticAxis` fixture: `evidenceAsOf`/
// `reliable` are load-bearing fields on the real type but not read by the
// assertions in the tests below, which only exercise the `axis`/
// `unaccountedStores` fallback-selection behavior.
function fakeLocalCoverage(axis: CoverageAxis) {
  return { axis, evidenceAsOf: null, reliable: true, unaccountedStores: [] as readonly string[] };
}

// Minimal-but-honest `ConnectorRunSummary` fixture for the pure-projection
// tests below: `collection_facts`/`recovery_only`/`terminal_reason` are real
// fields on the type but not read by the run-precedence assertions here.
function fakeRunSummary(overrides: {
  run_id: string;
  status: string;
  failure_reason: string | null;
  known_gaps: unknown[];
}): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 1,
    failure_reason: overrides.failure_reason,
    finished_at: NOW,
    first_at: NOW,
    known_gaps: overrides.known_gaps,
    last_at: NOW,
    recovery_only: false,
    run_id: overrides.run_id,
    started_at: NOW,
    status: overrides.status,
    terminal_reason: null,
  };
}

test("run-derived coverage wins over local coverage diagnostics when a spine run exists", () => {
  // A connector WITH a terminal spine-run gap must not have that gap masked by
  // stale `coverage_diagnostics` records claiming completeness. Local coverage
  // is a fallback only when the run path yields `unknown`.
  const lastRun = fakeRunSummary({
    failure_reason: null,
    known_gaps: [{ reason: "owner_must_reauthorize", severity: "actionable" }],
    run_id: "run_1",
    status: "succeeded",
  });
  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun,
    lastSuccessfulRun: lastRun,
    localCoverage: fakeLocalCoverage("complete"),
    manifestStreams: [{ name: "messages" }],
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  // The actionable known gap must win: coverage is terminal_gap, not complete.
  assert.equal(health.axes.coverage, "terminal_gap");
  assert.notEqual(health.axes.coverage, "complete");
});

test("local coverage diagnostics fill the gap only when the run path is unknown", () => {
  // No spine run (local collector): run-derived coverage is `unknown`, so the
  // durable local coverage axis is adopted.
  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun: null,
    lastSuccessfulRun: null,
    localCoverage: fakeLocalCoverage("complete"),
    manifestStreams: [{ name: "messages" }],
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  assert.equal(health.axes.coverage, "complete");

  // And a null/unobserved local coverage leaves the run-derived `unknown` axis
  // untouched — an empty outbox is never silently promoted to complete.
  const unknownHealth = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun: null,
    lastSuccessfulRun: null,
    localCoverage: fakeLocalCoverage("unknown"),
    manifestStreams: [{ name: "messages" }],
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  assert.equal(unknownHealth.axes.coverage, "unknown");
});

test("local-device health quarantines foreign active-run and scheduler facts", () => {
  const activeRun: ActiveRunRecord = {
    connector_id: CONNECTOR_ID,
    connector_instance_id: CONNECTOR_INSTANCE_ID,
    run_generation: 1,
    run_id: "foreign-active-run",
    scenario_id: "foreign-scenario",
    started_at: NOW,
    trace_id: "trc_foreign-active-run",
  };
  const collectionRate: CollectionRateSnapshot = {
    ceiling_interval_ms: 1000,
    ceiling_rate_per_min: 60,
    current_interval_ms: 2000,
    effective_rate_per_min: 30,
    last_backoff: { at_interval_ms: 2000, reason: "backing_off" },
  };
  const health = projectConnectorSummaryConnectionHealth({
    activeRun,
    collectionRate,
    freshness: FRESH_FRESHNESS,
    lastRun: fakeRunSummary({
      failure_reason: "foreign_failure",
      known_gaps: [],
      run_id: "foreign-run",
      status: "failed",
    }),
    lastSuccessfulRun: null,
    localCoverage: fakeLocalCoverage("complete"),
    localDeviceBacked: true,
    manifestStreams: [{ name: "messages" }],
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true, next_run_at: NOW },
  });
  assert.equal(health.badges.syncing, false);
  assert.equal(health.axes.coverage, "complete");
  assert.notEqual(health.reason_code, "foreign_failure");
});

// ---------------------------------------------------------------------------
// Real-manifest regression guard.
//
// The tests above synthesize an `ALWAYS_FRESH_REFRESH_POLICY` to prove the
// `idle → healthy` upgrade mechanism. That proves the projection logic but NOT
// that the *shipped* local-collector manifests actually declare a staleness
// window that greens a recently-heartbeating collector. `maximum_staleness_seconds`
// is optional at the registry validator, so a manifest edit could drop it and
// silently regress `claude_code`/`codex` from `healthy` back to `idle` with no
// other test failing. These guards pin the real manifests: they derive freshness
// from the actual declared policy (no synthetic window) and assert it greens a
// fresh heartbeat and degrades a stale one, exactly as
// `openspec/changes/add-local-device-collection-verdict/` requires.
// ---------------------------------------------------------------------------

const LOCAL_COLLECTOR_MANIFEST_NAMES = ["claude_code", "codex"] as const;

interface TestRefreshPolicy {
  readonly maximum_staleness_seconds?: unknown;
  readonly recommended_mode?: unknown;
}

function readRealRefreshPolicy(name: string): TestRefreshPolicy | null {
  const manifest = JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  ) as { capabilities?: { refresh_policy?: TestRefreshPolicy } };
  return manifest.capabilities?.refresh_policy ?? null;
}

// Derive freshness the same way the server rollup does: heartbeat timestamp as
// the freshness anchor, the manifest's declared `maximum_staleness_seconds` as
// the window, and a fixed `now`. This exercises the REAL policy value with no
// wall-clock dependency, unlike the rollup path which reads `new Date()`.
function freshnessFromRealPolicy({
  name,
  heartbeatAt,
  nowIso,
}: {
  name: string;
  heartbeatAt: string;
  nowIso: string;
}): ReferenceFreshness {
  const policy = readRealRefreshPolicy(name);
  const maximumStalenessSeconds =
    typeof policy?.maximum_staleness_seconds === "number" ? policy.maximum_staleness_seconds : null;
  return deriveReferenceFreshness({
    lastAttemptedAt: null,
    lastAttemptStatus: null,
    lastSuccessfulRunAt: null,
    maximumStalenessSeconds,
    now: nowIso,
    recordLastUpdatedAt: heartbeatAt,
  });
}

function projectLocalDeviceHealth({
  freshness,
  outboxAxis = "idle",
  coverageAxis = "complete",
  nowIso,
}: {
  freshness: ReferenceFreshness;
  outboxAxis?: OutboxAxis;
  coverageAxis?: CoverageAxis;
  nowIso: string;
}) {
  return projectConnectorSummaryConnectionHealth({
    freshness,
    lastRun: null,
    lastSuccessfulRun: null,
    localCoverage: fakeLocalCoverage(coverageAxis),
    localDeviceBacked: true,
    manifestStreams: [{ name: "messages" }],
    nowIso,
    outbox: { axis: outboxAxis },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
}

for (const name of LOCAL_COLLECTOR_MANIFEST_NAMES) {
  test(`${name}: shipped manifest declares a refresh policy with a positive maximum_staleness_seconds`, () => {
    const policy = readRealRefreshPolicy(name);
    assert.ok(policy, `${name} manifest must declare capabilities.refresh_policy`);
    assert.equal(policy.recommended_mode, "automatic", `${name} is a local collector and should refresh automatically`);
    assert.equal(
      typeof policy.maximum_staleness_seconds,
      "number",
      `${name} must declare maximum_staleness_seconds so a fresh heartbeat can green the collector`
    );
    const maximumStalenessSeconds = policy.maximum_staleness_seconds;
    assert.ok(
      typeof maximumStalenessSeconds === "number" &&
        Number.isFinite(maximumStalenessSeconds) &&
        maximumStalenessSeconds > 0,
      `${name}: maximum_staleness_seconds must be positive (got ${String(maximumStalenessSeconds)})`
    );
  });

  test(`${name}: drained + complete + heartbeat inside the real staleness window projects healthy`, () => {
    const policy = readRealRefreshPolicy(name);
    assert.ok(policy, `${name} manifest must declare capabilities.refresh_policy`);
    const maximumStalenessSeconds = policy.maximum_staleness_seconds;
    assert.equal(typeof maximumStalenessSeconds, "number", `${name} must declare a numeric maximum_staleness_seconds`);
    assert.ok(typeof maximumStalenessSeconds === "number");
    const nowIso = "2026-06-03T12:00:00.000Z";
    // One second inside the declared window: still fresh.
    const heartbeatAt = new Date(Date.parse(nowIso) - (maximumStalenessSeconds - 1) * 1000).toISOString();

    const freshness = freshnessFromRealPolicy({ heartbeatAt, name, nowIso });
    assert.equal(freshness.status, "current", `${name}: a heartbeat inside the window must read current`);

    const health = projectLocalDeviceHealth({ freshness, nowIso });
    assert.equal(health.axes.freshness, "fresh");
    assert.equal(health.axes.outbox, "idle");
    assert.equal(health.axes.coverage, "complete");
    assert.equal(health.state, "healthy");

    const collection = health.conditions.find((c) => c.type === "CollectionSucceeded");
    assert.ok(collection, `${name}: expected a CollectionSucceeded condition`);
    assert.equal(collection.status, "true");
    assert.equal(collection.origin, "local_device");
  });

  test(`${name}: heartbeat past the real staleness window goes stale and is never healthy`, () => {
    const policy = readRealRefreshPolicy(name);
    assert.ok(policy, `${name} manifest must declare capabilities.refresh_policy`);
    const maximumStalenessSeconds = policy.maximum_staleness_seconds;
    assert.equal(typeof maximumStalenessSeconds, "number", `${name} must declare a numeric maximum_staleness_seconds`);
    assert.ok(typeof maximumStalenessSeconds === "number");
    const nowIso = "2026-06-03T12:00:00.000Z";
    // One second past the declared window: stale.
    const heartbeatAt = new Date(Date.parse(nowIso) - (maximumStalenessSeconds + 1) * 1000).toISOString();

    const freshness = freshnessFromRealPolicy({ heartbeatAt, name, nowIso });
    assert.equal(freshness.status, "stale", `${name}: a heartbeat past the window must read stale`);

    const health = projectLocalDeviceHealth({ freshness, nowIso });
    assert.equal(health.axes.freshness, "stale");
    // A stale collector with otherwise-green axes must NOT be greened by the
    // verdict — the freshness gate is load-bearing.
    assert.notEqual(health.state, "healthy");

    const collection = health.conditions.find((c) => c.type === "CollectionSucceeded");
    assert.ok(collection);
    assert.notEqual(collection.status, "true");
  });
}
