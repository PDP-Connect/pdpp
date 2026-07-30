// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import { CONNECTION_CONDITION_REASONS } from "../runtime/connection-health.ts";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { rebuildConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  type CollectionReportEntry,
  getConnectorSummaryForRoute,
  invalidateConnectorSummariesCache,
  listConnectorSummaries,
  type RuntimeCollectionFact,
} from "../server/ref-control.ts";
import { rebuildRetainedSize } from "../server/retained-size-read-model.ts";
import { getDefaultConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../server/stores/credential-encryption.ts";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";

const CONNECTOR_ID = "https://test.pdpp.dev/connectors/connection-first-records";
const STATIC_SECRET_CONNECTOR_ID = "https://test.pdpp.dev/connectors/connection-first-static-secret";
const WORK_INSTANCE_ID = "cin_test_connection_first_work";
const PERSONAL_INSTANCE_ID = "cin_test_connection_first_personal";
const REVOKED_INSTANCE_ID = "cin_test_connection_first_revoked";
const STATIC_SECRET_INSTANCE_ID = "cin_test_connection_first_static_secret";
const NOW = "2026-05-20T12:00:00.000Z";
const REVOKED_AT = "2026-06-10T19:10:28.476Z";
const TEST_CREDENTIAL_KEY = "ref-connectors-connection-projection-test-key";
const REJECTED_PATTERN = /rejected/i;

// `getDefaultConnectorDetailGapStore()` returns `unknown` (server/stores/
// connector-detail-gap-store.ts) because the SQLite/Postgres backends are
// not modeled as a shared exported interface. This test only calls the two
// methods below; type them honestly against the real per-backend
// implementations' signatures (both `async upsertPendingGap(input): Promise<DetailGap | null>`
// and `async markGapStatus(gapId, status, options): Promise<DetailGap | null>`).
interface DetailGapForTest {
  readonly gap_id: string;
}

interface DetailGapStoreForTest {
  markGapStatus: (
    gapId: string,
    status: string,
    options?: { runId?: string; error?: { class: string } }
  ) => Promise<DetailGapForTest | null>;
  upsertPendingGap: (input: {
    connectorId: string;
    connectorInstanceId: string;
    grantId?: string;
    stream: string;
    parentStream?: string;
    recordKey: string;
    reason: string;
  }) => Promise<DetailGapForTest | null>;
}

function getTestDetailGapStore(): DetailGapStoreForTest {
  return getDefaultConnectorDetailGapStore() as DetailGapStoreForTest;
}

function withTmpDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-ref-connectors-connection-"));
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
    capabilities: {
      public_listing: { listed: true, status: "test" },
    },
    connector_id: CONNECTOR_ID,
    display_name: "Connection First Records",
    protocol_version: "0.1.0",
    streams: [
      { name: "messages", primary_key: ["id"] },
      { name: "files", primary_key: ["id"] },
    ],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

// A static-secret-capable connector manifest (declares `setup.credential_capture`),
// so `staticSecretCredentialCaptureFromManifest` resolves non-null and the
// connection-summary projection consults the real credential store.
function seedStaticSecretConnector() {
  const manifest = {
    capabilities: {
      public_listing: { listed: true, status: "test" },
    },
    connector_id: STATIC_SECRET_CONNECTOR_ID,
    display_name: "Connection First Static Secret",
    protocol_version: "0.1.0",
    setup: {
      credential_capture: {
        fields: [{ label: "App password", name: "app_password", secret: true }],
        kind: "app_password",
      },
    },
    streams: [{ name: "messages", primary_key: ["id"] }],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(STATIC_SECRET_CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

async function withCredentialKey<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = value;
  try {
    return await fn();
  } finally {
    if (old === undefined) {
      delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
    } else {
      process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = old;
    }
  }
}

async function seedInstances({ sourceKind = "local_device" }: { sourceKind?: string } = {}): Promise<void> {
  await seedInstance({
    connectorInstanceId: WORK_INSTANCE_ID,
    displayName: "Work laptop",
    sourceBinding: { device: "work", kind: sourceKind },
    sourceBindingKey: "work",
    sourceKind,
  });
  await seedInstance({
    connectorInstanceId: PERSONAL_INSTANCE_ID,
    displayName: "Personal laptop",
    sourceBinding: { device: "personal", kind: sourceKind },
    sourceBindingKey: "personal",
    sourceKind,
  });
}

interface SeedInstanceOptions {
  connectorId?: string;
  connectorInstanceId: string;
  displayName: string;
  sourceBinding: unknown;
  sourceBindingKey: string;
  sourceKind?: string;
  status?: string;
}

async function seedInstance({
  connectorInstanceId,
  connectorId = CONNECTOR_ID,
  displayName,
  sourceKind = "local_device",
  sourceBindingKey,
  sourceBinding,
  status = "active",
}: SeedInstanceOptions): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName,
    ownerSubjectId: "owner_local",
    sourceBinding,
    sourceBindingKey,
    sourceKind,
    status,
    updatedAt: NOW,
  });
}

interface SeedRecordOptions {
  connectorId?: string;
  connectorInstanceId: string;
  data: unknown;
  emittedAt: string;
  key: string;
  stream: string;
  version: number;
}

function seedRecord({
  connectorId = CONNECTOR_ID,
  connectorInstanceId,
  stream,
  key,
  data,
  emittedAt,
  version,
}: SeedRecordOptions): void {
  getDb()
    .prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(connectorId, connectorInstanceId, stream, key, JSON.stringify(data), emittedAt, version);
  getDb()
    .prepare(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(connectorId, connectorInstanceId, stream, key, version, JSON.stringify(data), emittedAt);
}

interface SeedBrowserSurfaceRunOptions {
  connectorInstanceId: string;
  occurredAt: string;
  runId: string;
  status: string;
  waitReason?: string | null;
}

async function seedBrowserSurfaceRun({
  connectorInstanceId,
  runId,
  status,
  occurredAt,
  waitReason = null,
}: SeedBrowserSurfaceRunOptions): Promise<void> {
  const profileKey = `${CONNECTOR_ID}:${connectorInstanceId}`;
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      browser_surface: {
        browser_surface_lease_id: `lease_${runId}`,
        browser_surface_profile_key: profileKey,
        browser_surface_status: status,
        browser_surface_wait_reason: waitReason ?? undefined,
        pending_run_id: runId,
      },
      connector_id: CONNECTOR_ID,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_type: status === "succeeded" ? "run.browser_surface_released" : "run.browser_surface_failed",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    source_id: CONNECTOR_ID,
    source_kind: "connector",
    status: status === "succeeded" ? "succeeded" : status,
    trace_id: `trc_${runId}`,
  });
}

interface SeedSchedulerRunHistoryOptions {
  completedAt: string;
  connectorInstanceId: string;
  runId: string;
  startedAt: string;
  status?: "cancelled" | "failed" | "skipped" | "succeeded";
}

async function seedSchedulerRunHistory({
  connectorInstanceId,
  runId,
  status = "succeeded",
  startedAt,
  completedAt,
}: SeedSchedulerRunHistoryOptions): Promise<void> {
  const store = createSqliteSchedulerStore();
  await Promise.resolve(
    store.appendRunHistory({
      attempt: 1,
      checkpointSummary: { streams: 1 },
      completedAt,
      connectorError: null,
      connectorId: CONNECTOR_ID,
      connectorInstanceId,
      failureReason: null,
      knownGaps: [],
      recordsEmitted: 1,
      reportedRecordsEmitted: 1,
      runId,
      source: { id: CONNECTOR_ID, kind: "connector" },
      startedAt,
      status,
      terminalReason: null,
      traceId: `trc_${runId}`,
    })
  );
  await Promise.resolve(
    store.upsertLastRunTime(connectorInstanceId, Date.parse(completedAt), completedAt, CONNECTOR_ID)
  );
}

interface SeedRunWithCollectionFactsOptions {
  connectorInstanceId: string;
  occurredAt: string;
  runId: string;
  streams: readonly RuntimeCollectionFact[];
}

async function seedManualRunWithCollectionFacts({
  connectorInstanceId,
  runId,
  occurredAt,
  streams,
}: SeedRunWithCollectionFactsOptions): Promise<void> {
  const profileKey = `${CONNECTOR_ID}:${connectorInstanceId}`;
  // Manual/direct runs bind to a connection through spine lifecycle facts, not
  // scheduler_run_history. This mirrors controller.runNow.
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      browser_surface: {
        browser_surface_lease_id: `lease_${runId}`,
        browser_surface_profile_key: profileKey,
        browser_surface_status: "released",
      },
      connector_id: CONNECTOR_ID,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_type: "run.browser_surface_released",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    source_id: CONNECTOR_ID,
    source_kind: "connector",
    status: "succeeded",
    trace_id: `trc_${runId}`,
  });
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      collection_facts: { streams },
      connector_id: CONNECTOR_ID,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_type: "run.completed",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    source_id: CONNECTOR_ID,
    source_kind: "connector",
    status: "succeeded",
    trace_id: `trc_${runId}`,
  });
}

async function seedConnectionRunWithCollectionFacts({
  connectorInstanceId,
  runId,
  occurredAt,
  streams,
}: SeedRunWithCollectionFactsOptions): Promise<void> {
  // API/static/manual connectors may have no browser-surface profile key. They
  // still need exact connection identity so a run for one account does not
  // disappear when a sibling connection of the same connector exists.
  const baseData = {
    connection_id: connectorInstanceId,
    connector_instance_id: connectorInstanceId,
    source: { id: CONNECTOR_ID, kind: "connector" },
  };
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      ...baseData,
      boot_epoch: "00000000-0000-4000-8000-000000000004",
      seq: 1,
    },
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    source_id: CONNECTOR_ID,
    source_kind: "connector",
    status: "started",
    trace_id: `trc_${runId}`,
  });
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      ...baseData,
      collection_facts: { streams },
    },
    event_type: "run.completed",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    source_id: CONNECTOR_ID,
    source_kind: "connector",
    status: "succeeded",
    trace_id: `trc_${runId}`,
  });
}

function collectionReportByStream(
  report: readonly CollectionReportEntry[] | null | undefined
): Record<string, CollectionReportEntry> {
  return Object.fromEntries((report ?? []).map((entry) => [entry.stream, entry]));
}

test(
  "a manual run with browser-profile + collection_facts on the spine (no scheduler_run_history) feeds collection_report on list and detail",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance({
      connectorInstanceId: WORK_INSTANCE_ID,
      displayName: "Chase (manual run)",
      sourceBinding: { account: "chase", kind: "browser_collector" },
      sourceBindingKey: "chase-manual",
      sourceKind: "browser_collector",
    });
    // A sibling connection proves the run binds to the exact profile key instead
    // of borrowing connector-wide history.
    await seedInstance({
      connectorInstanceId: PERSONAL_INSTANCE_ID,
      displayName: "Chase (sibling, no run)",
      sourceBinding: { account: "chase-personal", kind: "browser_collector" },
      sourceBindingKey: "chase-sibling",
      sourceKind: "browser_collector",
    });

    await seedManualRunWithCollectionFacts({
      connectorInstanceId: WORK_INSTANCE_ID,
      occurredAt: "2026-05-20T12:05:00.000Z",
      runId: "run_chase_manual_direct",
      streams: [
        {
          checkpoint: "committed",
          collected: 1145,
          considered: null,
          covered: null,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "messages",
        },
        {
          checkpoint: "committed",
          collected: 3,
          considered: null,
          covered: null,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "files",
        },
      ],
    });

    // Guard the premise: the projection below must derive collection_report purely
    // from spine facts.
    const historyRows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM scheduler_run_history WHERE connector_id = ?")
      .get<{ n: number }>(CONNECTOR_ID);
    assert.ok(historyRows, "premise: scheduler_run_history query returns a count row");
    assert.equal(historyRows.n, 0, "premise: the manual run left no scheduler_run_history row");

    const summaries = await listConnectorSummaries();
    const listWork = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID
    );
    assert.ok(listWork, "the manual-run connection projects a source-list summary");
    assert.equal(listWork.last_run?.run_id, "run_chase_manual_direct");
    assert.equal(listWork.last_run?.status, "succeeded");
    assert.ok(listWork.last_run?.collection_facts, "last_run carries the terminal collection_facts block");

    const listByStream = collectionReportByStream(listWork.collection_report);
    assert.deepEqual(
      Object.keys(listByStream).sort(),
      ["files", "messages"],
      "collection_report has one entry per stream from the manual run fact block"
    );
    const { messages: listMessages, files: listFiles } = listByStream;
    assert.ok(listMessages, "the messages stream has a collection_report entry");
    assert.ok(listFiles, "the files stream has a collection_report entry");
    assert.equal(listMessages.collected, 1145, "collected count rides through from spine terminal facts");
    assert.equal(listFiles.collected, 3, "second stream collected count rides through");
    assert.equal(listMessages.considered, "unknown");
    assert.equal(listMessages.coverage_condition, "unknown");
    assert.notEqual(listMessages.coverage_condition, "complete");

    const detail = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);
    assert.ok(detail, "the manual-run connection resolves a source-detail summary");
    assert.equal(detail.last_run?.run_id, "run_chase_manual_direct");
    const detailByStream = collectionReportByStream(detail.collection_report);
    const { messages: detailMessages } = detailByStream;
    assert.ok(detailMessages, "the detail surface has a messages collection_report entry");
    assert.equal(detailMessages.collected, 1145, "detail surface derives the same collected count from the spine");
    assert.equal(detailMessages.coverage_condition, "unknown");
    assert.deepEqual(
      detailMessages,
      listMessages,
      "detail and list derive an identical collection_report entry from the spine terminal facts"
    );

    const sibling = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === PERSONAL_INSTANCE_ID
    );
    assert.ok(sibling, "the sibling connection projects a summary");
    assert.equal(sibling.last_run, null, "the sibling has no run of its own to borrow");
    const siblingByStream = collectionReportByStream(sibling.collection_report);
    const siblingMessages = siblingByStream.messages;
    assert.ok(siblingMessages, "the sibling has a messages collection_report entry");
    assert.notEqual(siblingMessages.collected, 1145, "sibling must not inherit the manual run collected count");
  })
);

test(
  "a manual run with explicit considered/covered stays complete even when collected is 0",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "manual" });

    await seedManualRunWithCollectionFacts({
      connectorInstanceId: WORK_INSTANCE_ID,
      occurredAt: "2026-05-20T12:06:00.000Z",
      runId: "run_zero_collected_complete",
      streams: [
        {
          checkpoint: "committed",
          collected: 0,
          considered: 1,
          covered: 1,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "messages",
        },
      ],
    });

    // The maintenance sweep (not the read itself) is what makes a required
    // stream's coverage evidence authoritative — including folding this
    // run's terminal collection_facts into `terminal_facts`. Simulate the
    // full sweep barrier having already run before this read, same as
    // production between sweeps.
    await rebuildConnectorSummaryEvidence();

    const summaries = await listConnectorSummaries();
    const work = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID
    );
    assert.ok(work, "the zero-emission connection projects a source-list summary");
    const reportByStream = collectionReportByStream(work.collection_report);
    const { messages } = reportByStream;
    assert.ok(messages, "the messages stream has a collection_report entry");
    assert.equal(messages.collected, 0, "no records were emitted");
    assert.equal(messages.considered, 1, "the denominator stays explicit");
    assert.equal(messages.covered, 1, "the explicit numerator keeps the stream complete");
    assert.equal(messages.coverage_condition, "complete");
  })
);

test(
  "a connection-id run without browser profile feeds only the addressed account summary",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "manual" });

    await seedConnectionRunWithCollectionFacts({
      connectorInstanceId: WORK_INSTANCE_ID,
      occurredAt: "2026-05-20T12:08:00.000Z",
      runId: "run_api_direct_work",
      streams: [
        {
          checkpoint: "committed",
          collected: 7,
          considered: 7,
          covered: 7,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "messages",
        },
        {
          checkpoint: "committed",
          collected: 0,
          considered: 0,
          covered: 0,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "files",
        },
      ],
    });

    // Simulate the maintenance sweep having already run before this read
    // (repair + terminal-facts fold both), so required-stream coverage
    // evidence is authoritative — matches production between sweeps, not an
    // inline-reconcile-on-read that no longer exists.
    await rebuildConnectorSummaryEvidence();

    const summaries = await listConnectorSummaries();
    const work = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID
    );
    const personal = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === PERSONAL_INSTANCE_ID
    );
    assert.ok(work);
    assert.ok(personal);
    assert.equal(work.last_run?.run_id, "run_api_direct_work");
    assert.equal(work.last_run?.status, "succeeded");
    const { messages: workMessages } = collectionReportByStream(work.collection_report);
    assert.ok(workMessages, "the messages stream has a collection_report entry");
    assert.equal(workMessages.coverage_condition, "complete");
    assert.equal(personal.last_run, null, "sibling connection must not borrow the connection-id run");
  })
);

test(
  "a succeeded run with partial stream coverage does not render the connection healthy",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance({
      connectorInstanceId: WORK_INSTANCE_ID,
      displayName: "GitHub-shaped partial coverage",
      sourceBinding: { account: "github", kind: "browser_collector" },
      sourceBindingKey: "github-partial",
      sourceKind: "browser_collector",
    });

    await seedManualRunWithCollectionFacts({
      connectorInstanceId: WORK_INSTANCE_ID,
      occurredAt: "2026-05-20T12:10:00.000Z",
      runId: "run_partial_stream_success",
      streams: [
        {
          checkpoint: "committed",
          collected: 2,
          considered: 10,
          covered: null,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "messages",
        },
        {
          checkpoint: "committed",
          collected: 3,
          considered: 3,
          covered: null,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "files",
        },
      ],
    });

    // Simulate the maintenance sweep having already run before this read
    // (repair + terminal-facts fold both), so required-stream coverage
    // evidence is authoritative — matches production between sweeps, not an
    // inline-reconcile-on-read that no longer exists.
    await rebuildConnectorSummaryEvidence();

    const summaries = await listConnectorSummaries();
    const summary = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID
    );
    assert.ok(summary, "the partial-coverage connection projects a source-list summary");
    const reportByStream = collectionReportByStream(summary.collection_report);
    const { messages: partialMessages } = reportByStream;
    assert.ok(partialMessages, "the messages stream has a collection_report entry");
    assert.equal(partialMessages.coverage_condition, "partial");
    assert.equal(partialMessages.forward_disposition, "resumable");
    assert.equal(summary.connection_health.axes.coverage, "partial");
    assert.equal(summary.connection_health.state, "degraded");
    assert.equal(summary.rendered_verdict.pill.label, "Degraded");

    const detail = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);
    assert.ok(detail, "the partial-coverage connection resolves a source-detail summary");
    assert.equal(detail.connection_health.axes.coverage, "partial");
    assert.equal(detail.rendered_verdict.pill.label, "Degraded");
  })
);

test(
  "terminal detail gaps downgrade the connection verdict and stream coverage",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance({
      connectorInstanceId: WORK_INSTANCE_ID,
      displayName: "Amazon-shaped terminal detail gaps",
      sourceBinding: { account: "amazon", kind: "browser_collector" },
      sourceBindingKey: "amazon-terminal",
      sourceKind: "browser_collector",
    });

    const gapStore = getTestDetailGapStore();
    const terminalGap = await gapStore.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: WORK_INSTANCE_ID,
      grantId: "grant_1",
      parentStream: "messages",
      reason: "temporary_unavailable",
      recordKey: "file_never_loaded",
      stream: "files",
    });
    assert.ok(terminalGap, "upsertPendingGap returns the created gap");
    await gapStore.markGapStatus(terminalGap.gap_id, "terminal", {
      error: { class: "quarantined" },
      runId: "run_terminal_detail_gap",
    });

    await seedManualRunWithCollectionFacts({
      connectorInstanceId: WORK_INSTANCE_ID,
      occurredAt: "2026-05-20T12:11:00.000Z",
      runId: "run_terminal_detail_gap",
      streams: [
        {
          checkpoint: "not_staged",
          collected: 2,
          considered: null,
          covered: null,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "messages",
        },
        {
          checkpoint: "not_staged",
          collected: 1,
          considered: null,
          covered: null,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "files",
        },
      ],
    });

    const summaries = await listConnectorSummaries();
    const summary = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID
    );
    assert.ok(summary, "the terminal-gap connection projects a source-list summary");
    const reportByStream = collectionReportByStream(summary.collection_report);
    const { messages: gapMessages, files: gapFiles } = reportByStream;
    assert.ok(gapMessages, "the messages stream has a collection_report entry");
    assert.ok(gapFiles, "the files stream has a collection_report entry");
    assert.equal(gapMessages.coverage_condition, "unknown");
    assert.equal(gapFiles.coverage_condition, "terminal_gap");
    assert.equal(gapFiles.forward_disposition, "terminal");
    assert.equal(summary.connection_health.axes.coverage, "terminal_gap");
    assert.notEqual(summary.connection_health.state, "healthy");
    assert.notEqual(summary.rendered_verdict.pill.label, "Healthy");

    const detail = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);
    assert.ok(detail, "the terminal-gap connection resolves a source-detail summary");
    assert.equal(detail.connection_health.axes.coverage, "terminal_gap");
    const { files: detailGapFiles } = collectionReportByStream(detail.collection_report);
    assert.ok(detailGapFiles, "the detail surface has a files collection_report entry");
    assert.equal(detailGapFiles.coverage_condition, "terminal_gap");
    assert.notEqual(detail.rendered_verdict.pill.label, "Healthy");
  })
);

test(
  "reference connector summaries project concrete connection rows with instance-scoped records",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "manual" });

    seedRecord({
      connectorInstanceId: WORK_INSTANCE_ID,
      data: { id: "msg_1", text: "work message" },
      emittedAt: "2026-05-20T12:01:00.000Z",
      key: "msg_1",
      stream: "messages",
      version: 1,
    });
    seedRecord({
      connectorInstanceId: WORK_INSTANCE_ID,
      data: { id: "file_1", name: "brief.pdf" },
      emittedAt: "2026-05-20T12:02:00.000Z",
      key: "file_1",
      stream: "files",
      version: 1,
    });
    seedRecord({
      connectorInstanceId: PERSONAL_INSTANCE_ID,
      data: { id: "msg_2", text: "personal message" },
      emittedAt: "2026-05-20T12:03:00.000Z",
      key: "msg_2",
      stream: "messages",
      version: 1,
    });
    getDb()
      .prepare(
        `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run("blob_work_1", CONNECTOR_ID, WORK_INSTANCE_ID, "files", "file_1", "application/pdf", 4096, "abc123");
    getDb()
      .prepare(
        `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES (?, ?, ?, ?, ?, '@record')`
      )
      .run("blob_work_1", CONNECTOR_ID, WORK_INSTANCE_ID, "files", "file_1");
    await rebuildRetainedSize();
    // Simulate the maintenance sweep having already run before this read, so
    // `stream_count` reads from the reconciled evidence row (streams with
    // real records) instead of falling back to the manifest's declared
    // stream count.
    await reconcileConnectorSummaryEvidence(null);

    const summaries = await listConnectorSummaries();
    const rows = summaries.filter((row) => row.connector_id === CONNECTOR_ID);
    assert.equal(rows.length, 2);

    const work = rows.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
    const personal = rows.find((row) => row.connector_instance_id === PERSONAL_INSTANCE_ID);
    assert.ok(work);
    assert.ok(personal);

    assert.equal(work.connection_id, WORK_INSTANCE_ID);
    assert.equal(work.connector_id, CONNECTOR_ID);
    assert.equal(work.display_name, "Work laptop");
    assert.equal(work.connector_display_name, "Connection First Records");
    assert.equal(work.total_records, 2);
    assert.equal(work.stream_count, 2);
    const workRetainedBytes = work.total_retained_bytes;
    assert.ok(typeof workRetainedBytes === "number", "work connection has retained-byte evidence");
    assert.ok(workRetainedBytes >= 4096);

    assert.equal(personal.connection_id, PERSONAL_INSTANCE_ID);
    assert.equal(personal.total_records, 1);
    assert.equal(personal.stream_count, 1);
    const personalRetainedBytes = personal.total_retained_bytes;
    assert.ok(typeof personalRetainedBytes === "number", "personal connection has retained-byte evidence");
    assert.ok(personalRetainedBytes > 0);
    assert.ok(personalRetainedBytes < workRetainedBytes);
  })
);

test(
  "reference connector summaries project local-device storage records under public connection rows",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances();

    // Local-device records are stored under the bare connector key (the live
    // ingest path writes `recordStorageConnectorIdForConnection(instance)` ===
    // instance.connectorId), with connection isolation carried by
    // connector_instance_id. See canonicalize-connector-keys design Decision 7.
    const storageConnectorId = CONNECTOR_ID;
    seedRecord({
      connectorId: storageConnectorId,
      connectorInstanceId: WORK_INSTANCE_ID,
      data: { id: "local_msg_1", text: "stored through local-device namespace" },
      emittedAt: "2026-05-20T12:04:00.000Z",
      key: "local_msg_1",
      stream: "messages",
      version: 1,
    });
    getDb()
      .prepare(
        `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        "blob_local_device_1",
        storageConnectorId,
        WORK_INSTANCE_ID,
        "messages",
        "local_msg_1",
        "text/plain",
        2048,
        "def456"
      );
    getDb()
      .prepare(
        `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES (?, ?, ?, ?, ?, '@record')`
      )
      .run("blob_local_device_1", storageConnectorId, WORK_INSTANCE_ID, "messages", "local_msg_1");
    await rebuildRetainedSize();
    // Simulate the maintenance sweep having already run before this read, so
    // `stream_count` reads from the reconciled evidence row (streams with
    // real records) instead of falling back to the manifest's declared
    // stream count.
    await reconcileConnectorSummaryEvidence(null);

    const summaries = await listConnectorSummaries();
    const work = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID
    );
    const personal = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === PERSONAL_INSTANCE_ID
    );
    assert.ok(work);
    assert.ok(personal);

    assert.equal(work.connector_id, CONNECTOR_ID);
    assert.equal(work.connector_instance_id, WORK_INSTANCE_ID);
    assert.equal(work.total_records, 1);
    assert.equal(work.stream_count, 1);
    const localDeviceRetainedBytes = work.total_retained_bytes;
    assert.ok(typeof localDeviceRetainedBytes === "number", "work connection has retained-byte evidence");
    assert.ok(localDeviceRetainedBytes >= 2048);

    assert.equal(personal.total_records, 0);
    assert.equal(personal.stream_count, 0);
  })
);

test(
  "connection summaries do not smear browser-surface runs across sibling connections",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "browser_collector" });

    await seedBrowserSurfaceRun({
      connectorInstanceId: WORK_INSTANCE_ID,
      occurredAt: "2026-05-20T12:01:00.000Z",
      runId: "run_work_surface_failed",
      status: "surface_failed",
      waitReason: "surface_unhealthy",
    });
    await seedBrowserSurfaceRun({
      connectorInstanceId: PERSONAL_INSTANCE_ID,
      occurredAt: "2026-05-20T12:02:00.000Z",
      runId: "run_personal_surface_failed",
      status: "surface_failed",
      waitReason: "capacity_full",
    });

    const summaries = await listConnectorSummaries();
    const work = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID
    );
    const personal = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === PERSONAL_INSTANCE_ID
    );
    assert.ok(work);
    assert.ok(personal);

    assert.equal(work.last_run?.run_id, "run_work_surface_failed");
    assert.equal(work.last_run?.failure_reason, "surface_unhealthy");
    assert.equal(personal.last_run?.run_id, "run_personal_surface_failed");
    assert.equal(personal.last_run?.failure_reason, "capacity_full");
  })
);

test(
  "full-list shallow option omits run history while scoped summaries keep it",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "browser_collector" });

    await seedBrowserSurfaceRun({
      connectorInstanceId: WORK_INSTANCE_ID,
      occurredAt: "2026-05-20T12:01:00.000Z",
      runId: "run_work_surface_failed",
      status: "surface_failed",
      waitReason: "surface_unhealthy",
    });

    const shallowSummaries = await listConnectorSummaries(null, { includeRunSummaries: false });
    const shallowWork = shallowSummaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID
    );
    assert.ok(shallowWork);
    assert.equal(shallowWork.last_run, null);
    assert.equal(shallowWork.last_successful_run, null);
    assert.ok(shallowWork.rendered_verdict, "shallow overview still carries the rendered verdict");

    const scopedWork = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);
    assert.ok(scopedWork);
    assert.equal(scopedWork.last_run?.run_id, "run_work_surface_failed");
    assert.equal(scopedWork.last_run?.failure_reason, "surface_unhealthy");
  })
);

test(
  "singleton-active overview hydrates only unambiguous active source run history",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance({
      connectorInstanceId: WORK_INSTANCE_ID,
      displayName: "Work laptop",
      sourceBinding: { device: "work", kind: "browser_collector" },
      sourceBindingKey: "work",
      sourceKind: "browser_collector",
    });
    await seedBrowserSurfaceRun({
      connectorInstanceId: WORK_INSTANCE_ID,
      occurredAt: "2026-05-20T12:01:00.000Z",
      runId: "run_work_surface_failed",
      status: "surface_failed",
      waitReason: "surface_unhealthy",
    });

    const singleton = await listConnectorSummaries(null, { includeRunSummaries: "singleton-active" });
    const singletonWork = singleton.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
    assert.ok(singletonWork);
    assert.equal(
      singletonWork.last_run?.run_id,
      "run_work_surface_failed",
      "singleton active source keeps enough evidence to avoid false Checking"
    );

    await seedInstance({
      connectorInstanceId: PERSONAL_INSTANCE_ID,
      displayName: "Personal laptop",
      sourceBinding: { device: "personal", kind: "browser_collector" },
      sourceBindingKey: "personal",
      sourceKind: "browser_collector",
    });
    invalidateConnectorSummariesCache();
    const ambiguous = await listConnectorSummaries(null, { includeRunSummaries: "singleton-active" });
    const ambiguousWork = ambiguous.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
    assert.ok(ambiguousWork);
    assert.equal(
      ambiguousWork.last_run?.run_id,
      "run_work_surface_failed",
      "duplicate active sources keep exact scoped run history without borrowing connector-wide runs"
    );
  })
);

test(
  "multi-account overview hydrates exact scheduler run history per connection",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "manual" });
    await seedSchedulerRunHistory({
      completedAt: "2026-05-20T12:02:00.000Z",
      connectorInstanceId: WORK_INSTANCE_ID,
      runId: "run_work_scheduler_history",
      startedAt: "2026-05-20T12:01:00.000Z",
    });
    await seedSchedulerRunHistory({
      completedAt: "2026-05-20T12:04:00.000Z",
      connectorInstanceId: PERSONAL_INSTANCE_ID,
      runId: "run_personal_scheduler_history",
      startedAt: "2026-05-20T12:03:00.000Z",
    });

    const summaries = await listConnectorSummaries(null, { includeRunSummaries: "singleton-active" });
    const work = summaries.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
    const personal = summaries.find((row) => row.connector_instance_id === PERSONAL_INSTANCE_ID);

    assert.ok(work);
    assert.ok(personal);
    assert.equal(
      work.last_run?.run_id,
      "run_work_scheduler_history",
      "duplicate active sources use exact scheduler history instead of rendering unknown"
    );
    assert.equal(work.last_successful_run?.run_id, "run_work_scheduler_history");
    assert.equal(
      personal.last_run?.run_id,
      "run_personal_scheduler_history",
      "sibling source keeps its own latest scheduler evidence"
    );
    assert.equal(personal.last_successful_run?.run_id, "run_personal_scheduler_history");
  })
);

test(
  "reference connector summaries keep revoked connections visible for owner manageability",
  withTmpDb(async () => {
    seedConnector();
    const store = createSqliteConnectorInstanceStore();
    await store.upsert({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: REVOKED_INSTANCE_ID,
      createdAt: NOW,
      displayName: "Revoked account",
      ownerSubjectId: "owner_local",
      revokedAt: REVOKED_AT,
      sourceBinding: { account: "revoked", kind: "manual" },
      sourceBindingKey: "revoked",
      sourceKind: "manual",
      status: "revoked",
      updatedAt: REVOKED_AT,
    });

    const summaries = await listConnectorSummaries();
    const revoked = summaries.find((row) => row.connector_instance_id === REVOKED_INSTANCE_ID);
    assert.ok(revoked, "revoked connection remains in the owner connector summary list");
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revoked_at, REVOKED_AT);
    assert.equal(revoked.connection_id, REVOKED_INSTANCE_ID);

    const scoped = await getConnectorSummaryForRoute(REVOKED_INSTANCE_ID);
    assert.ok(scoped, "revoked connection remains resolvable by its detail/list route id");
    assert.equal(scoped.status, "revoked");
    assert.equal(scoped.revoked_at, REVOKED_AT);
  })
);

test(
  "reference connector summaries hide retired setup shells from sources",
  withTmpDb(async () => {
    seedConnector();
    const store = createSqliteConnectorInstanceStore();
    await store.upsert({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: REVOKED_INSTANCE_ID,
      createdAt: NOW,
      displayName: "Expired browser setup",
      ownerSubjectId: "owner_local",
      revokedAt: REVOKED_AT,
      sourceBinding: {
        enrollment_expires_at: "2026-06-10T10:00:00.000Z",
        kind: "browser_enrollment_shell",
      },
      sourceBindingKey: "expired-browser-shell",
      sourceKind: "browser_collector",
      status: "revoked",
      updatedAt: REVOKED_AT,
    });

    const summaries = await listConnectorSummaries();
    assert.equal(
      summaries.some((row) => row.connector_instance_id === REVOKED_INSTANCE_ID),
      false,
      "retired setup shells must not appear as revoked configured sources"
    );

    const scoped = await getConnectorSummaryForRoute(REVOKED_INSTANCE_ID);
    assert.equal(scoped, null, "retired setup shells are not resolvable as source detail rows");
  })
);

// `observed_at` on connection-health condition rows is stamped at projection
// call time, so two projections of the same connection taken a millisecond apart
// differ only in that timestamp. Normalize it before asserting structural
// equality so the drift check compares the load-bearing projection, not the wall
// clock.
function withoutObservedAt(summary: unknown): unknown {
  return stripObservedAt(summary);
}

function stripObservedAt(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripObservedAt);
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === "observed_at") {
        continue;
      }
      output[key] = stripObservedAt(nested);
    }
    return output;
  }
  return value;
}

test(
  "getConnectorSummaryForRoute resolves one connection by stable identity and matches its list entry",
  withTmpDb(async () => {
    // Two connections share CONNECTOR_ID. A record subpage routed to the WORK
    // connection must get exactly that connection's summary — and it must be
    // structurally identical (modulo the projection timestamp) to the entry the
    // all-connector list produces, since both go through the same per-connection
    // projection (no drift).
    seedConnector();
    await seedInstances({ sourceKind: "manual" });
    seedRecord({
      connectorInstanceId: WORK_INSTANCE_ID,
      data: { id: "msg_1", text: "work message" },
      emittedAt: "2026-05-20T12:01:00.000Z",
      key: "msg_1",
      stream: "messages",
      version: 1,
    });
    await rebuildRetainedSize();

    const scoped = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);
    assert.ok(scoped, "a known connection id resolves to a summary");
    assert.equal(scoped.connector_instance_id, WORK_INSTANCE_ID);
    assert.equal(scoped.connection_id, WORK_INSTANCE_ID);
    assert.equal(scoped.total_records, 1);

    const summaries = await listConnectorSummaries();
    const listEntry = summaries.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
    assert.deepEqual(
      withoutObservedAt(scoped),
      withoutObservedAt(listEntry),
      "scoped summary is identical to the connection list entry (shared projection, no drift)"
    );
  })
);

test(
  "getConnectorSummaryForRoute scopes retained records to the resolved connection",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "manual" });
    seedRecord({
      connectorInstanceId: WORK_INSTANCE_ID,
      data: { id: "work_msg", text: "work scoped message" },
      emittedAt: "2026-05-20T12:10:00.000Z",
      key: "work_msg",
      stream: "messages",
      version: 1,
    });
    seedRecord({
      connectorInstanceId: PERSONAL_INSTANCE_ID,
      data: { id: "personal_msg", text: "personal sibling message" },
      emittedAt: "2026-05-20T12:11:00.000Z",
      key: "personal_msg",
      stream: "messages",
      version: 1,
    });
    await rebuildRetainedSize();
    // Terminal-gate revision (2026-07-29): the observation barrier no longer
    // runs inline on a read — only the maintenance sweep (startup + periodic)
    // reconciles `connector_summary_evidence`. Simulate the sweep having
    // already run before this read, exactly as it would have in production.
    await reconcileConnectorSummaryEvidence(null);

    const scoped = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);

    assert.ok(scoped, "a known connection id resolves to a summary");
    assert.equal(scoped.connection_id, WORK_INSTANCE_ID);
    assert.equal(scoped.connector_instance_id, WORK_INSTANCE_ID);
    assert.equal(scoped.connector_id, CONNECTOR_ID);
    assert.equal(scoped.total_records, 1, "scoped route must not include sibling connection records");
    // `files` is a manifest-declared stream with no live canonical records for
    // this connection. The maintenance sweep already completed this
    // connection's canonical snapshot before this read, so `files` reads as
    // an exact, genuine `known_zero` — never a fabricated value, and never
    // smeared with the sibling connection's `messages` record.
    assert.deepEqual(
      [...scoped.stream_records]
        .sort((a, b) => a.stream.localeCompare(b.stream))
        .map((entry) => ({
          count_state: entry.count_state,
          record_count: entry.record_count,
          stream: entry.stream,
        })),
      [
        { count_state: "known_zero", record_count: 0, stream: "files" },
        { count_state: "known", record_count: 1, stream: "messages" },
      ]
    );
  })
);

test(
  "getConnectorSummaryForRoute keeps canonical stream counts current even while retained-byte evidence is dirty",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "manual" });
    seedRecord({
      connectorInstanceId: WORK_INSTANCE_ID,
      data: { id: "work_msg", text: "work scoped message" },
      emittedAt: "2026-05-20T12:10:00.000Z",
      key: "work_msg",
      stream: "messages",
      version: 1,
    });
    await rebuildRetainedSize();
    // Simulate a write landing after rebuild but before reconcile catches up:
    // the connection's retained-size row is mid-flight dirty.
    getDb()
      .prepare("UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = ?")
      .run(WORK_INSTANCE_ID);
    // Terminal-gate revision (2026-07-29): simulate the maintenance sweep
    // having already reconciled this connection's canonical snapshot before
    // this read (the barrier no longer runs inline during GET).
    await reconcileConnectorSummaryEvidence(null);

    const scoped = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);

    assert.ok(scoped, "a known connection id resolves to a summary");
    assert.equal(scoped.total_records, 1);
    // design.md "Explicit stream evidence": retained-size dirtiness affects
    // retained BYTE evidence only, never canonical record counts. Canonical
    // `records` is the count authority independent of the retained-size
    // projection's own dirty state, so `messages` (1 live record) and `files`
    // (0) both stay visible with their exact canonical counts; only
    // `retained_bytes`/`retained_record_count` degrade for the dirty row.
    assert.deepEqual(
      [...scoped.stream_records]
        .sort((a, b) => a.stream.localeCompare(b.stream))
        .map((entry) => ({
          count_state: entry.count_state,
          record_count: entry.record_count,
          stream: entry.stream,
        })),
      [
        { count_state: "known_zero", record_count: 0, stream: "files" },
        { count_state: "known", record_count: 1, stream: "messages" },
      ]
    );
    assert.equal(scoped.retained_bytes, null, "retained bytes are unavailable while the row is dirty");
  })
);

test(
  "getConnectorSummaryForRoute exposes known_zero for declared streams once the canonical snapshot is current",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "manual" });
    // No records seeded, no rebuildRetainedSize() call: the connection has no
    // retained_size_connection row at all (never ingested, never rebuilt).
    // Under the reconcile-active-summary-evidence contract (design.md "Explicit
    // stream evidence"), canonical `records` is the count authority
    // independent of retained-size: a declared stream absent from a COMPLETED
    // canonical snapshot is `declared + known_zero`, not a synthesized-absence
    // gap. Terminal-gate revision (2026-07-29): the barrier no longer runs
    // inline during a read — simulate the maintenance sweep having already
    // completed that snapshot before this read, so `known_zero` is exact
    // truth here, not a fabricated value.
    await reconcileConnectorSummaryEvidence(null);

    const scoped = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);

    assert.ok(scoped, "a known connection id resolves to a summary");
    assert.equal(scoped.total_records, 0);
    assert.deepEqual(
      [...scoped.stream_records]
        .sort((a, b) => a.stream.localeCompare(b.stream))
        .map((entry) => ({
          count_state: entry.count_state,
          declaration_state: entry.declaration_state,
          record_count: entry.record_count,
          stream: entry.stream,
        })),
      [
        { count_state: "known_zero", declaration_state: "declared", record_count: 0, stream: "files" },
        { count_state: "known_zero", declaration_state: "declared", record_count: 0, stream: "messages" },
      ]
    );
  })
);

test(
  "getConnectorSummaryForRoute allows connector_id fallback only when unambiguous",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance({
      connectorInstanceId: WORK_INSTANCE_ID,
      displayName: "Work laptop",
      sourceBinding: { device: "work", kind: "manual" },
      sourceBindingKey: "work",
      sourceKind: "manual",
    });

    const scoped = await getConnectorSummaryForRoute(CONNECTOR_ID);
    assert.ok(scoped, "a connector_id-only route resolves when there is exactly one configured source");
    assert.equal(scoped.connector_id, CONNECTOR_ID);
    assert.equal(scoped.connector_instance_id, WORK_INSTANCE_ID);
  })
);

test(
  "getConnectorSummaryForRoute refuses ambiguous connector_id fallback",
  withTmpDb(async () => {
    // Connector-type route fallback must not pick the first configured source
    // when several accounts/devices share a connector. Otherwise a source detail
    // page can attach sibling run evidence to the wrong source.
    seedConnector();
    await seedInstances({ sourceKind: "manual" });

    const scoped = await getConnectorSummaryForRoute(CONNECTOR_ID);
    assert.equal(scoped, null);
  })
);

test(
  "getConnectorSummaryForRoute returns null when nothing resolves",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "manual" });
    const scoped = await getConnectorSummaryForRoute("cin_does_not_exist");
    assert.equal(scoped, null);
  })
);

// End-to-end proof for `surface-source-pressure-detail-gap-backlog` task 2.3:
// the snapshot's `detail_gap_backlog.recovered` is populated from the store's
// reason-scoped count-by-status aggregate (not fabricated, not aliased to
// pending). This drives the REAL default detail-gap store through
// `getConnectorDetailGapProjection`, so it proves the store → projection →
// snapshot wiring, not just the pure derivation (covered separately in
// connection-health-source-pressure-backlog.test.js).
test(
  "connection summary surfaces a recovered count from the durable count-by-status aggregate",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "manual" });

    const gapStore = getTestDetailGapStore();
    // Two still-pending source-pressure gaps on the WORK connection...
    await gapStore.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: WORK_INSTANCE_ID,
      grantId: "grant_1",
      reason: "upstream_pressure",
      recordKey: "pending_conv",
      stream: "messages",
    });
    await gapStore.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: WORK_INSTANCE_ID,
      grantId: "grant_1",
      reason: "rate_limited",
      recordKey: "pending_conv_2",
      stream: "messages",
    });
    // ...two recovered source-pressure gaps across sibling connections. The WORK
    // summary must count only the WORK row.
    await Promise.all(
      (
        [
          [WORK_INSTANCE_ID, "recovered_conv_1"],
          [PERSONAL_INSTANCE_ID, "recovered_conv_2"],
        ] as const
      ).map(async ([instanceId, recordKey]) => {
        const gap = await gapStore.upsertPendingGap({
          connectorId: CONNECTOR_ID,
          connectorInstanceId: instanceId,
          grantId: "grant_1",
          reason: "rate_limited",
          recordKey,
          stream: "messages",
        });
        assert.ok(gap, "upsertPendingGap returns the created gap");
        await gapStore.markGapStatus(gap.gap_id, "recovered", { runId: "run_recovery" });
      })
    );
    // ...and a recovered NON-source-pressure gap that must NOT inflate the count.
    const offReason = await gapStore.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: WORK_INSTANCE_ID,
      grantId: "grant_1",
      reason: "temporary_unavailable",
      recordKey: "off_reason_conv",
      stream: "messages",
    });
    assert.ok(offReason, "upsertPendingGap returns the created gap");
    await gapStore.markGapStatus(offReason.gap_id, "recovered", { runId: "run_recovery" });

    const summaries = await listConnectorSummaries();
    const work = summaries.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
    assert.ok(work, "work connection projects a summary");

    const backlog = work.connection_health.detail_gap_backlog;
    assert.notEqual(backlog, null, "a readable store yields a non-null backlog rollup");
    assert.ok(backlog, "a readable store yields a non-null backlog rollup");
    assert.equal(backlog.recovered, 1, "recovered counts only source-pressure gaps for the projected connection");
    assert.equal(backlog.pending, 2, "pending is the still-pending source-pressure gap count, distinct from recovered");
    // recovered must be a real count, never aliased to pending.
    assert.notEqual(backlog.recovered, backlog.pending);

    assert.ok(work.rendered_verdict, "owner wire summary carries the synthesized rendered_verdict");
    const renderedBacklog = work.rendered_verdict.detail.detail_gap_backlog;
    assert.ok(renderedBacklog, "rendered_verdict detail carries a non-null backlog rollup");
    assert.equal(
      renderedBacklog.recovered,
      1,
      "owner-only rendered_verdict detail carries the recovered backlog count"
    );
    assert.equal(
      work.rendered_verdict.progress.gaps_drained_last_run,
      null,
      "all-time recovered count is not mislabeled as last-run progress"
    );
  })
);

// Proves the credential-evidence WIRING (not just the pure projection, which
// `connection-health.test.js` already covers): a static-secret-capable
// connection with no stored credential row must project `credential_required`
// through the real `listConnectorSummaries` / `getConnectorSummaryForRoute`
// read model, which reads non-secret metadata from the real credential store
// (`getConnectorCredentialStore().getMetadata`) inside
// `projectConnectorSummaryForInstance`.
test(
  "connection summary projects credential_required for a static-secret connection with no stored credential",
  withTmpDb(async () => {
    seedStaticSecretConnector();
    await seedInstance({
      connectorId: STATIC_SECRET_CONNECTOR_ID,
      connectorInstanceId: STATIC_SECRET_INSTANCE_ID,
      displayName: "Static secret account",
      sourceBinding: { kind: "account" },
      sourceBindingKey: "static-secret",
      sourceKind: "account",
    });

    const summaries = await listConnectorSummaries();
    const work = summaries.find((row) => row.connector_instance_id === STATIC_SECRET_INSTANCE_ID);
    assert.ok(work, "static-secret connection projects a summary");

    const credentials = work.connection_health.conditions?.find(
      (c) => c.type === "CredentialsValid" && c.status === "false"
    );
    assert.ok(credentials, "a CredentialsValid=false condition is projected");
    assert.equal(credentials.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED);
    assert.equal(credentials.remediation?.action, "refresh_credentials");

    // The scoped route resolves through the same projection and must agree.
    const scoped = await getConnectorSummaryForRoute(STATIC_SECRET_INSTANCE_ID);
    assert.ok(scoped);
    const scopedCredentials = scoped.connection_health.conditions?.find(
      (c) => c.type === "CredentialsValid" && c.status === "false"
    );
    assert.equal(scopedCredentials?.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED);
  })
);

// ChatGPT-shaped case (Tim's live symptom): a connector that is BOTH
// static-secret-capable AND browser-bound, enrolled with a `browser_collector`
// binding, with no stored credential. The steady-state repair the owner is
// routed to MUST be a durable credential reauth/capture action — NOT a
// browser-stream action. (The one-off browser stream was a *runtime* behavior,
// fixed in auto-login/chatgpt.ts; the projection here proves the owner-facing
// CTA is credential capture, and that no browser-session action kind exists to
// be selected instead.)
const CHATGPT_SHAPED_CONNECTOR_ID = "connection_first_browser_static_secret";
const CHATGPT_SHAPED_INSTANCE_ID = "cin_browser_static_secret";

function seedBrowserBoundStaticSecretConnector({ browserRequired = true } = {}) {
  const manifest = {
    capabilities: { public_listing: { listed: true, status: "test" } },
    connector_id: CHATGPT_SHAPED_CONNECTOR_ID,
    display_name: "Browser + Static Secret",
    protocol_version: "0.1.0",
    // Browser-bound: requires a browser runtime binding (like chatgpt.json).
    runtime_requirements: { bindings: { browser: { required: browserRequired }, network: { required: true } } },
    // Static-secret-capable: has a credential_capture surface.
    setup: {
      credential_capture: {
        fields: [
          { label: "Email", name: "username", secret: true },
          { label: "Password", name: "password", secret: true },
        ],
        kind: "username_password",
      },
      modality: "static_secret",
    },
    streams: [{ name: "messages", primary_key: ["id"] }],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CHATGPT_SHAPED_CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

async function appendSessionRequiredRun({
  connectorInstanceId,
  runId,
}: {
  connectorInstanceId: string;
  runId: string;
}): Promise<void> {
  const scheduler = createSqliteSchedulerStore();
  await Promise.resolve(
    scheduler.appendRunHistory({
      attempt: 1,
      checkpointSummary: null,
      completedAt: NOW,
      connectorError: null,
      connectorId: CHATGPT_SHAPED_CONNECTOR_ID,
      connectorInstanceId,
      failureReason: "session_required",
      knownGaps: [],
      recordsEmitted: 0,
      reportedRecordsEmitted: 0,
      runId,
      source: { id: CHATGPT_SHAPED_CONNECTOR_ID, kind: "connector" },
      startedAt: NOW,
      status: "failed",
      terminalReason: "session_required",
      traceId: `trc_${runId}`,
    })
  );
  await Promise.resolve(
    scheduler.upsertLastRunTime(connectorInstanceId, Date.parse(NOW), NOW, CHATGPT_SHAPED_CONNECTOR_ID)
  );
}

test(
  "ChatGPT-shaped static-secret connection with an unrejected credential and no surface rows projects browser_session repair",
  withTmpDb(async () => {
    seedBrowserBoundStaticSecretConnector();
    await seedInstance({
      connectorId: CHATGPT_SHAPED_CONNECTOR_ID,
      connectorInstanceId: CHATGPT_SHAPED_INSTANCE_ID,
      displayName: "ChatGPT - idle runtime session repair",
      sourceBinding: { kind: "account" },
      sourceBindingKey: "account-static-secret",
      sourceKind: "account",
    });

    await withCredentialKey(TEST_CREDENTIAL_KEY, async () => {
      const credentialStore = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_CREDENTIAL_KEY },
      });
      await credentialStore.capture({
        connectorInstanceId: CHATGPT_SHAPED_INSTANCE_ID,
        credentialKind: "username_password",
        now: NOW,
        ownerSubjectId: "owner_local",
        secret: "synthetic-username-password-bundle",
      });

      const scheduler = createSqliteSchedulerStore();
      await Promise.resolve(
        scheduler.appendRunHistory({
          attempt: 1,
          checkpointSummary: null,
          completedAt: NOW,
          connectorError: null,
          connectorId: CHATGPT_SHAPED_CONNECTOR_ID,
          connectorInstanceId: CHATGPT_SHAPED_INSTANCE_ID,
          failureReason: "session_required",
          knownGaps: [],
          recordsEmitted: 0,
          reportedRecordsEmitted: 0,
          runId: "run_chatgpt_idle_session",
          source: { id: CHATGPT_SHAPED_CONNECTOR_ID, kind: "connector" },
          startedAt: NOW,
          status: "failed",
          terminalReason: "session_required",
          traceId: "trc_chatgpt_idle_session",
        })
      );
      await Promise.resolve(
        scheduler.upsertLastRunTime(CHATGPT_SHAPED_INSTANCE_ID, Date.parse(NOW), NOW, CHATGPT_SHAPED_CONNECTOR_ID)
      );

      // No browser-surface rows are seeded: the live idle runtime shape has no
      // active surface, while the manifest's browser binding still proves the
      // browser-session repair capability.
      const scoped = await getConnectorSummaryForRoute(CHATGPT_SHAPED_INSTANCE_ID);
      assert.ok(scoped);
      const credentials = scoped.connection_health.conditions?.find((c) => c.type === "CredentialsValid");
      assert.equal(credentials?.status, "false");
      assert.equal(credentials?.reason, "session_required");
      assert.equal(credentials?.remediation?.surface?.kind, "browser_session");
      assert.equal(credentials?.message, "The authenticated browser session is not active.");
      assert.doesNotMatch(credentials?.message ?? "", REJECTED_PATTERN);
      assert.equal(
        scoped.rendered_verdict.required_actions.find((action) => action.kind === "reauth")?.surface?.kind,
        "browser_session"
      );
    });
  })
);

test(
  "ChatGPT-shaped browser_collector connection with no credential does NOT project credential_required (binding-first: session repair, not static-secret capture)",
  withTmpDb(async () => {
    seedBrowserBoundStaticSecretConnector();
    // Mirror the live dondochaka shape exactly: source_kind is `account`, and the
    // browser_collector fact lives in source_binding.kind (not source_kind). This
    // connection logs in via the browser session (e.g. Google SSO), so an absent
    // credential row is normal — NOT a "capture a username/password" repair need.
    await seedInstance({
      connectorId: CHATGPT_SHAPED_CONNECTOR_ID,
      connectorInstanceId: CHATGPT_SHAPED_INSTANCE_ID,
      displayName: "ChatGPT - dondochaka-like",
      sourceBinding: { device: "personal", kind: "browser_collector" },
      sourceBindingKey: "browser-static-secret",
      sourceKind: "account",
    });
    await appendSessionRequiredRun({
      connectorInstanceId: CHATGPT_SHAPED_INSTANCE_ID,
      runId: "run_browser_bound_absent_credential",
    });

    const scoped = await getConnectorSummaryForRoute(CHATGPT_SHAPED_INSTANCE_ID);
    assert.ok(scoped, "the browser_collector connection projects a summary");

    // Binding-first: the connection is browser-session-bound, so credential-store
    // absence MUST NOT project credential_required (that would route the owner to
    // static-secret credential capture for a connection with no stored credential
    // to capture — the SSO case). Its repair is browser/session repair.
    const credentialRequired = scoped.connection_health.conditions?.find(
      (c) => c.type === "CredentialsValid" && c.reason === CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED
    );
    assert.equal(credentialRequired, undefined, "browser-session connection must not project credential_required");
    assert.equal(
      scoped.connection_health.conditions?.find((c) => c.type === "CredentialsValid")?.remediation?.surface?.kind,
      "browser_session",
      "a session-required browser binding repairs the browser session even though no stored credential exists"
    );

    // The connection carries its browser-session binding so owner surfaces route
    // repair binding-first (browser/session repair, not static-secret capture).
    assert.equal(scoped.source_binding_kind, "browser_collector");
  })
);

test(
  "static-secret-BOUND connection with no credential DOES project credential_required (capture path preserved)",
  withTmpDb(async () => {
    // Same static-secret-capable + browser-bound connector, but this connection is
    // bound as `account` (NOT browser_collector) — the static-secret path, like
    // ChatGPT - everyone@ (default_account). Here credential capture IS the repair.
    seedBrowserBoundStaticSecretConnector();
    await seedInstance({
      connectorId: CHATGPT_SHAPED_CONNECTOR_ID,
      connectorInstanceId: "cin_account_static_secret",
      displayName: "ChatGPT - account static secret",
      sourceBinding: { kind: "account" },
      sourceBindingKey: "account-static-secret",
      sourceKind: "account",
    });
    await appendSessionRequiredRun({
      connectorInstanceId: "cin_account_static_secret",
      runId: "run_static_secret_absent_credential",
    });

    const scoped = await getConnectorSummaryForRoute("cin_account_static_secret");
    assert.ok(scoped);
    const credentials = scoped.connection_health.conditions?.find(
      (c) => c.type === "CredentialsValid" && c.status === "false"
    );
    assert.ok(credentials, "a CredentialsValid=false condition is projected");
    assert.equal(credentials.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED);
    assert.equal(scoped.source_binding_kind, "account");
  })
);

test(
  "an optional browser binding does not authorize browser-session repair",
  withTmpDb(async () => {
    seedBrowserBoundStaticSecretConnector({ browserRequired: false });
    const connectorInstanceId = "cin_optional_browser_static_secret";
    await seedInstance({
      connectorId: CHATGPT_SHAPED_CONNECTOR_ID,
      connectorInstanceId,
      displayName: "Optional browser static secret",
      sourceBinding: { kind: "account" },
      sourceBindingKey: "account-static-secret",
      sourceKind: "account",
    });

    await withCredentialKey(TEST_CREDENTIAL_KEY, async () => {
      const credentialStore = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_CREDENTIAL_KEY },
      });
      await credentialStore.capture({
        connectorInstanceId,
        credentialKind: "username_password",
        now: NOW,
        ownerSubjectId: "owner_local",
        secret: "synthetic-username-password-bundle",
      });
      await appendSessionRequiredRun({ connectorInstanceId, runId: "run_optional_browser_session_required" });

      const scoped = await getConnectorSummaryForRoute(connectorInstanceId);
      assert.ok(scoped);
      const credentials = scoped.connection_health.conditions?.find((c) => c.type === "CredentialsValid");
      assert.equal(credentials?.status, "unknown");
      assert.equal(credentials?.remediation, null);
      assert.doesNotMatch(credentials?.message ?? "", REJECTED_PATTERN);
    });
  })
);

// False-positive guard: a credential-store READ FAILURE must NOT be read as
// "no stored credential". Only a successful getMetadata returning null means
// no row. A transient store/DB error must fall back to prior run-reason-derived
// behavior (evidence unavailable), never a false owner "reconnect" prompt.
test(
  'credential-store read failure does NOT project credential_required (evidence unavailable, not "no credential")',
  withTmpDb(async () => {
    seedBrowserBoundStaticSecretConnector();
    await seedInstance({
      connectorId: CHATGPT_SHAPED_CONNECTOR_ID,
      connectorInstanceId: CHATGPT_SHAPED_INSTANCE_ID,
      displayName: "ChatGPT - store read failure",
      sourceBinding: { device: "personal", kind: "browser_collector" },
      sourceBindingKey: "browser-static-secret",
      sourceKind: "account",
    });

    // Force the credential-store read to throw: drop the credential table so
    // `getMetadata`'s SELECT fails. This is the read-failure path, distinct from
    // "no row" (an empty-but-present table).
    getDb().prepare("DROP TABLE connector_instance_credentials").run();
    invalidateConnectorSummariesCache();

    const scoped = await getConnectorSummaryForRoute(CHATGPT_SHAPED_INSTANCE_ID);
    assert.ok(scoped, "the summary still projects (store failure is non-fatal)");

    // The credential axis must NOT be projected as blocked/credential_required on
    // a mere read failure. With no credential-shaped run evidence either, the
    // honest projection is unknown (not-probed) — never a false reconnect prompt.
    const credentialRequired = scoped.connection_health.conditions?.find(
      (c) => c.type === "CredentialsValid" && c.reason === CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED
    );
    assert.equal(credentialRequired, undefined, "a store read failure must not surface credential_required");

    const credentialsFalse = scoped.connection_health.conditions?.find(
      (c) => c.type === "CredentialsValid" && c.status === "false"
    );
    assert.equal(credentialsFalse, undefined, "no CredentialsValid=false condition from a read failure alone");

    // And no owner reauth CTA is fabricated from the read failure.
    for (const action of scoped.rendered_verdict.required_actions) {
      assert.notEqual(action.kind, "reauth");
    }
  })
);

// Same wiring, the rejected-credential branch: a captured-then-rejected
// credential must project `credential_rejected`, distinct from
// `credential_required`, proving the projection reads the store's `rejected`
// status rather than only presence.
test(
  "connection summary projects credential_rejected for a static-secret connection whose stored credential was rejected",
  withTmpDb(async () => {
    seedStaticSecretConnector();
    await seedInstance({
      connectorId: STATIC_SECRET_CONNECTOR_ID,
      connectorInstanceId: STATIC_SECRET_INSTANCE_ID,
      displayName: "Static secret account",
      sourceBinding: { kind: "account" },
      sourceBindingKey: "static-secret",
      sourceKind: "account",
    });

    await withCredentialKey(TEST_CREDENTIAL_KEY, async () => {
      const credentialStore = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_CREDENTIAL_KEY },
      });
      await credentialStore.capture({
        connectorInstanceId: STATIC_SECRET_INSTANCE_ID,
        credentialKind: "app_password",
        now: NOW,
        ownerSubjectId: "owner_local",
        secret: "synthetic-app-password",
      });
      await credentialStore.markRejected({
        connectorInstanceId: STATIC_SECRET_INSTANCE_ID,
        reason: "provider_rejected_synthetic",
        rejectedAt: "2026-05-20T12:05:00.000Z",
      });

      const summaries = await listConnectorSummaries();
      const work = summaries.find((row) => row.connector_instance_id === STATIC_SECRET_INSTANCE_ID);
      assert.ok(work, "static-secret connection projects a summary");

      const credentials = work.connection_health.conditions?.find(
        (c) => c.type === "CredentialsValid" && c.status === "false"
      );
      assert.ok(credentials, "a CredentialsValid=false condition is projected");
      assert.equal(credentials.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REJECTED);
      assert.equal(credentials.remediation?.action, "refresh_credentials");
    });
  })
);

test(
  "listConnectorSummaries replays one schedule-list snapshot with output equivalent to direct per-connection reads",
  withTmpDb(async () => {
    seedConnector();
    await seedInstances({ sourceKind: "account" });

    const schedules = [
      {
        connector_id: CONNECTOR_ID,
        connector_instance_id: WORK_INSTANCE_ID,
        enabled: true,
        interval_seconds: 3600,
      },
      {
        connector_id: CONNECTOR_ID,
        connector_instance_id: PERSONAL_INSTANCE_ID,
        enabled: false,
        interval_seconds: 7200,
      },
    ];
    const directCalls = { getSchedule: 0 };
    const directController = {
      getSchedule(_connectorId: string, options?: { connectorInstanceId?: string }) {
        directCalls.getSchedule += 1;
        return Promise.resolve(
          schedules.find((schedule) => schedule.connector_instance_id === options?.connectorInstanceId) ?? null
        );
      },
    };

    const originalToISOString = Date.prototype.toISOString;
    Date.prototype.toISOString = () => NOW;
    try {
      const before = await listConnectorSummaries(directController);
      assert.equal(directCalls.getSchedule, 2, "before: one direct schedule read per connection");

      const batchedCalls = { getSchedule: 0, listSchedulesForConnections: 0 };
      const batchedController = {
        getSchedule() {
          batchedCalls.getSchedule += 1;
          return Promise.reject(new Error("the batched list projection must not call getSchedule"));
        },
        listSchedulesForConnections(connectorInstanceIds: readonly string[]) {
          batchedCalls.listSchedulesForConnections += 1;
          const result = new Map<string, (typeof schedules)[number]>();
          for (const schedule of schedules) {
            if (connectorInstanceIds.includes(schedule.connector_instance_id)) {
              result.set(schedule.connector_instance_id, schedule);
            }
          }
          return Promise.resolve(result);
        },
      };

      const after = await listConnectorSummaries(batchedController);

      assert.deepEqual(after, before, "the batched schedule snapshot preserves every summary byte-for-byte");
      assert.deepEqual(
        batchedCalls,
        { getSchedule: 0, listSchedulesForConnections: 1 },
        "after: one existing list read replays schedule evidence for both connections (2 -> 1)"
      );
    } finally {
      Date.prototype.toISOString = originalToISOString;
    }
  })
);
