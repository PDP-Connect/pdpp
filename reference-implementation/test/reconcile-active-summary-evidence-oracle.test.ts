const TOP_LEVEL_REGEX_1 = /messages/;
const TOP_LEVEL_REGEX_2 = /messages/;
const TOP_LEVEL_REGEX_3 = /messages/;
const TOP_LEVEL_REGEX_4 = /messages/;
const TOP_LEVEL_REGEX_5 = /messages/;
const TOP_LEVEL_REGEX_6 = /messages/;
const TOP_LEVEL_REGEX_7 = /messages/;
const TOP_LEVEL_REGEX_8 = /messages/;
const TOP_LEVEL_REGEX_9 = /messages/;
const TOP_LEVEL_REGEX_10 = /messages/;
const TOP_LEVEL_REGEX_11 = /messages/;
const TOP_LEVEL_REGEX_12 = /messages/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __setRegisterConnectorPhaseHookForTest, registerConnector as registerConnectorTyped } from "../server/auth.ts";
import { reconcileConnectorSummaryEvidence as reconcileConnectorSummaryEvidenceTyped } from "../server/connector-summary-evidence-engine.ts";
import {
  __testOnlySetFoldPauseHook as __testOnlySetFoldPauseHookTyped,
  __testOnlyUpdateStreamFactsCasWrite as __testOnlyUpdateStreamFactsCasWriteTyped,
  getConnectorSummaryEvidence as getConnectorSummaryEvidenceTyped,
  rebuildConnectorSummaryEvidence as rebuildConnectorSummaryEvidenceTyped,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb as getDbTyped, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery as postgresQueryTyped,
} from "../server/postgres-storage.ts";
import { recordCurrentGenerationUndeclaredWrite as recordCurrentGenerationUndeclaredWriteTyped } from "../server/records.ts";
import {
  decideConnectorSummariesCacheRead as decideConnectorSummariesCacheReadTyped,
  getConnectorSummaryForRoute as getConnectorSummaryForRouteTyped,
  invalidateConnectorSummariesCache,
  listConnectorSummaries as listConnectorSummariesTyped,
} from "../server/ref-control.ts";
import { rebuildRetainedSize as rebuildRetainedSizeTyped } from "../server/retained-size-read-model.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const OWNER = "owner_local";
const NOW = "2026-07-16T12:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/summary-evidence-oracle";
const INSTANCE_ID = "cin_summary_evidence_oracle";
const STREAM = "messages";
const EMPTY_STREAM = "empty_stream";
const UNEXPECTED_STREAM = "legacy_stream";
const MANIFEST: any = {
  capabilities: {
    public_listing: { listed: true, status: "test" },
    refresh_policy: {
      maximum_staleness_seconds: 3_153_600_000,
      rationale: "Dedicated evidence-oracle fixture has no automatic refresh.",
      recommended_mode: "manual",
    },
  },
  connector_id: CONNECTOR_ID,
  display_name: "Summary Evidence Oracle",
  protocol_version: "0.1.0",
  streams: [
    {
      coverage_strategy: "full_inventory",
      name: STREAM,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
    {
      coverage_strategy: "full_inventory",
      name: EMPTY_STREAM,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
  version: "1.0.0",
};

const MANIFEST_JSON = JSON.stringify(MANIFEST);
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function requirePostgresUrl(): string {
  assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL is required for this test");
  return POSTGRES_URL;
}

function firstRow<T>(rows: readonly T[], description: string): T {
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const row = rows[0];
  assert.ok(row, description);
  return row;
}

function requireRow<T>(row: T | undefined, description: string): T {
  assert.ok(row, description);
  return row;
}
const getDb = getDbTyped;
const postgresQuery = postgresQueryTyped;
const registerConnector = registerConnectorTyped;
const rebuildConnectorSummaryEvidence = rebuildConnectorSummaryEvidenceTyped;
const reconcileConnectorSummaryEvidence = reconcileConnectorSummaryEvidenceTyped;
const getConnectorSummaryForRoute = getConnectorSummaryForRouteTyped;
const listConnectorSummaries = listConnectorSummariesTyped;
const rebuildRetainedSize = rebuildRetainedSizeTyped;
const recordCurrentGenerationUndeclaredWrite = recordCurrentGenerationUndeclaredWriteTyped;
const __testOnlyUpdateStreamFactsCasWrite = __testOnlyUpdateStreamFactsCasWriteTyped;
const __testOnlySetFoldPauseHook = __testOnlySetFoldPauseHookTyped;
const decideConnectorSummariesCacheRead = decideConnectorSummariesCacheReadTyped;

async function getConnectorSummaryEvidence(connectorInstanceId: string) {
  const evidence = await getConnectorSummaryEvidenceTyped(connectorInstanceId);
  if (evidence === null) {
    throw new TypeError(`Expected summary evidence for ${connectorInstanceId}`);
  }
  return evidence;
}

type JsonRecord = Record<string, unknown>;

function requireJsonRecord(value: unknown, description: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  const record: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
}

function requireNumber(value: unknown, description: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`${description} must be a number`);
  }
  return value;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${description} must be a string`);
  }
  return value;
}

interface RetainedBytes {
  blob_bytes: number;
  record_changes_json_bytes: number;
  record_json_bytes: number;
  total_bytes: number;
}

function requireRetainedBytes(value: unknown, description: string): RetainedBytes {
  const bytes = requireJsonRecord(value, description);
  const fields = ["blob_bytes", "record_changes_json_bytes", "record_json_bytes", "total_bytes"] as const;
  for (const field of fields) {
    if (typeof bytes[field] !== "number") {
      throw new TypeError(`${description}.${field} must be a number`);
    }
  }
  return {
    blob_bytes: requireNumber(bytes.blob_bytes, `${description}.blob_bytes`),
    record_changes_json_bytes: requireNumber(
      bytes.record_changes_json_bytes,
      `${description}.record_changes_json_bytes`
    ),
    record_json_bytes: requireNumber(bytes.record_json_bytes, `${description}.record_json_bytes`),
    total_bytes: requireNumber(bytes.total_bytes, `${description}.total_bytes`),
  };
}

function seedConnectorSqlite(manifest: any = MANIFEST) {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, typeof manifest === "string" ? manifest : JSON.stringify(manifest), NOW);
}

function seedInstanceSqlite({
  connectorInstanceId = INSTANCE_ID,
  status = "active",
  sourceKind = "account",
}: any = {}) {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, NULL)`
    )
    .run(
      connectorInstanceId,
      OWNER,
      CONNECTOR_ID,
      "Summary evidence oracle",
      status,
      sourceKind,
      connectorInstanceId,
      NOW,
      NOW
    );
}

function seedCanonicalRecordSqlite({
  connectorInstanceId = INSTANCE_ID,
  stream = STREAM,
  recordKey,
  version = 1,
  emittedAt = NOW,
}: any = {}) {
  getDb()
    .prepare(
      `INSERT INTO records(
         connector_id, connector_instance_id, stream, record_key, record_json,
         emitted_at, semantic_time, version, deleted
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(
      CONNECTOR_ID,
      connectorInstanceId,
      stream,
      recordKey,
      JSON.stringify({ id: recordKey, stream }),
      emittedAt,
      emittedAt,
      version
    );
}

function seedRetainedConnectionSqlite({ dirty = 0, computedAt = NOW }: any = {}) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_connection(
         connector_instance_id, connector_id, current_record_json_bytes,
         record_history_json_bytes, blob_bytes, record_count, dirty, computed_at
       ) VALUES (?, ?, 100, 10, 5, 0, ?, ?)`
    )
    .run(INSTANCE_ID, CONNECTOR_ID, dirty, computedAt);
}

function seedRetainedStreamSqlite({ stream, recordCount, dirty = 0, computedAt = NOW }: any = {}) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream, record_count, dirty, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(INSTANCE_ID, CONNECTOR_ID, stream, recordCount, dirty, computedAt);
}

function seedHealthyRetainedSnapshotSqlite({ streamCount = 1 }: any = {}) {
  seedRetainedConnectionSqlite({ dirty: 0 });
  seedRetainedStreamSqlite({ dirty: 0, recordCount: streamCount, stream: STREAM });
}

function seedTerminalCollectionFactSqlite({ eventSeq, stream = STREAM, eventId = `evt_${eventSeq}` }: any) {
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       ) VALUES (?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, ?, ?, '1')`
    )
    .run(
      eventId,
      eventSeq,
      NOW,
      NOW,
      `trace_${eventSeq}`,
      `run_${eventSeq}`,
      `run_${eventSeq}`,
      INSTANCE_ID,
      JSON.stringify({
        collection_facts: {
          reference_only: true,
          schema_version: 1,
          streams: [{ checkpoint: "committed", collected: 1, stream }],
        },
        connection_id: INSTANCE_ID,
        connector_instance_id: INSTANCE_ID,
      })
    );
}

async function withSqlite(fn: (context: { databasePath: string }) => Promise<any>): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-evidence-oracle-"));
  const databasePath = join(dir, "pdpp.sqlite");
  invalidateConnectorSummariesCache();
  initDb(databasePath);
  try {
    return await fn({ databasePath });
  } finally {
    invalidateConnectorSummariesCache();
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

// biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
async function listBypassCache() {
  return listConnectorSummaries(null, {
    concurrency: 1,
    includeRunSummaries: false,
  });
}

function summaryFor(summaries: any[], instanceId = INSTANCE_ID): any {
  const summary = summaries.find((row: any) => row.connector_instance_id === instanceId);
  assert.ok(summary, `summary for ${instanceId} must be visible`);
  return summary;
}

function streamEntry(summary: any, stream: string): any {
  const entry = summary.stream_records.find((row: any) => row.stream === stream);
  assert.ok(entry, `stream ${stream} must be visible in the exhaustive stream set`);
  return entry;
}

test("observation barrier creates missing evidence for an active connection before synthesis", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();

    const summaries = await listBypassCache();
    summaryFor(summaries);
    const evidence = await getConnectorSummaryEvidence(INSTANCE_ID);

    assert.ok(evidence, "a direct summary consumer must create missing active evidence");
    assert.equal(evidence.state, "fresh");
  }));

test("lost dirty marker cannot hide changed canonical ingest from the next observation", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "record_1" });
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    await rebuildConnectorSummaryEvidence();

    seedCanonicalRecordSqlite({ emittedAt: "2026-07-16T12:01:00.000Z", recordKey: "record_2" });
    const summaries = await listBypassCache();
    const summary = summaryFor(summaries);

    assert.equal(summary.total_records, 2, "record snapshot must detect changed ingest without a dirty hook");
    assert.equal(streamEntry(summary, STREAM).record_count, 2);
  }));

test("declared empty stream exposes known_zero only after a current canonical snapshot", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    await rebuildRetainedSize();

    const summary = summaryFor(await listBypassCache());
    const empty = streamEntry(summary, EMPTY_STREAM);
    assert.equal(empty.count_state, "known_zero");
    assert.equal(empty.record_count, 0);
  }));

test("canonical and retained-only streams become dormant diagnostic evidence", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "canonical_orphan", stream: UNEXPECTED_STREAM });
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    seedRetainedStreamSqlite({ dirty: 0, recordCount: 2, stream: UNEXPECTED_STREAM });
    await rebuildConnectorSummaryEvidence();

    const summary = summaryFor(await listBypassCache());
    const dormant = streamEntry(summary, UNEXPECTED_STREAM);
    assert.equal(dormant.declaration_state, "dormant");
    assert.equal(dormant.record_count, 1, "canonical current count remains diagnostic evidence");
    assert.equal(dormant.retained_record_count, 2, "retained-only evidence remains separately visible");
    assert.equal(summary.total_records, 0, "dormant canonical rows are excluded from active totals");
  }));

test("only explicit current-generation undeclared-write provenance becomes unexpected", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "historical-only", stream: UNEXPECTED_STREAM });
    await listBypassCache();
    assert.equal(
      streamEntry(summaryFor(await listBypassCache()), UNEXPECTED_STREAM).declaration_state,
      "dormant",
      "retained/canonical history alone is never an undeclared-write accusation"
    );

    await recordCurrentGenerationUndeclaredWrite(
      { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE_ID },
      { provenance: "test_rejected_current_write", stream: UNEXPECTED_STREAM }
    );
    const summary = summaryFor(await listBypassCache());
    assert.equal(streamEntry(summary, UNEXPECTED_STREAM).declaration_state, "unexpected");
    assert.equal(summary.connection_health.state, "unknown", "unexpected evidence fails ProjectionReliable closed");
  }));

test("unobserved manifest remove-readd advances twice and never replays terminal history", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedTerminalCollectionFactSqlite({ eventSeq: 1 });
    await listBypassCache();
    assert.match(
      JSON.stringify((await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts),
      TOP_LEVEL_REGEX_9,
      "the original declared generation has terminal evidence"
    );

    const withoutMessages = { ...MANIFEST, streams: [MANIFEST.streams[1]] };
    await registerConnector(withoutMessages, { backfillRetrievalIndexes: false });
    await registerConnector(MANIFEST, { backfillRetrievalIndexes: false });
    const readded = summaryFor(await listBypassCache());
    const readdedEvidence = await getConnectorSummaryEvidence(INSTANCE_ID);
    const readdedGeneration = requireRow(
      getDb()
        .prepare("SELECT manifest_generation FROM connector_instances WHERE connector_instance_id = ?")
        .get<{ manifest_generation: number }>(INSTANCE_ID),
      "re-added connector instance exists"
    );
    assert.equal(readdedGeneration.manifest_generation, 2);
    assert.equal(readdedEvidence.stream_latest_facts, null, "re-add must not restore pre-removal terminal evidence");
    assert.notEqual(
      readded.connection_health.state,
      "healthy",
      "without a post-boundary fact the re-added stream fails closed"
    );

    seedTerminalCollectionFactSqlite({ eventSeq: 2 });
    await listBypassCache();
    assert.match(
      JSON.stringify((await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts),
      TOP_LEVEL_REGEX_10,
      "only a later collection terminal event repopulates the new generation"
    );
  }));

test("SQLite rebuild refuses pre-generation terminal facts and accepts a post-mutation terminal", () =>
  withSqlite(async ({ databasePath }: { databasePath: string }) => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedTerminalCollectionFactSqlite({ eventId: "evt_generation_zero", eventSeq: 1 });
    await listBypassCache();

    await registerConnector({ ...MANIFEST, streams: [MANIFEST.streams[1]] }, { backfillRetrievalIndexes: false });
    await registerConnector(MANIFEST, { backfillRetrievalIndexes: false });
    const readdedGeneration = requireRow(
      getDb()
        .prepare("SELECT manifest_generation FROM connector_instances WHERE connector_instance_id = ?")
        .get<{ manifest_generation: number }>(INSTANCE_ID),
      "re-added connector instance exists"
    );
    assert.equal(readdedGeneration.manifest_generation, 2);

    await registerConnector(
      {
        capabilities: MANIFEST.capabilities,
        connector_id: MANIFEST.connector_id,
        display_name: MANIFEST.display_name,
        protocol_version: MANIFEST.protocol_version,
        streams: MANIFEST.streams,
        version: MANIFEST.version,
      },
      { backfillRetrievalIndexes: false }
    );
    const reorderedGeneration = requireRow(
      getDb()
        .prepare("SELECT manifest_generation FROM connector_instances WHERE connector_instance_id = ?")
        .get<{ manifest_generation: number }>(INSTANCE_ID),
      "reordered connector instance exists"
    );
    assert.equal(reorderedGeneration.manifest_generation, 2, "semantic key reorder is a no-op");

    // Simulate a pre-column database: its terminal row has a source identity
    // but no durable generation. Boot migration recreates the trigger, but
    // deliberately never invents provenance for the old event.
    getDb().exec("DROP TRIGGER stamp_terminal_manifest_generation");
    seedTerminalCollectionFactSqlite({ eventId: "evt_legacy_unstamped", eventSeq: 2 });
    const legacyEvent = requireRow(
      getDb()
        .prepare("SELECT manifest_generation FROM spine_events WHERE event_id = ?")
        .get<{ manifest_generation: number | null }>("evt_legacy_unstamped"),
      "legacy terminal event exists"
    );
    assert.equal(legacyEvent.manifest_generation, null, "legacy terminal rows retain absent provenance");

    getDb().prepare("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?").run(INSTANCE_ID);
    closeDb();
    initDb(databasePath);
    invalidateConnectorSummariesCache();

    const rebuilt = summaryFor(await listBypassCache());
    assert.equal((await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts, null);
    assert.notEqual(rebuilt.connection_health.state, "healthy");
    assert.equal(rebuilt.terminal_facts.state, "stale", "legacy generationless facts remain historical, not current");

    seedTerminalCollectionFactSqlite({ eventId: "evt_generation_two", eventSeq: 3 });
    await listBypassCache();
    assert.match(
      JSON.stringify((await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts),
      TOP_LEVEL_REGEX_11
    );
  }));

test("SQLite: pre-provenance fact event straddled by later stamped recovery-only fact-less events stays current, sourced from the pre-provenance run", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();

    // The pre-provenance (unstamped) fact-carrying terminal event — a
    // never-advanced connection's only real evidence.
    seedTerminalCollectionFactSqlite({ eventId: "evt_straddle_pre_provenance", eventSeq: 1 });
    getDb()
      .prepare("UPDATE spine_events SET manifest_generation = NULL WHERE event_id = ?")
      .run("evt_straddle_pre_provenance");
    await listBypassCache();
    const preProvenanceFacts = (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts;
    assert.match(
      JSON.stringify(preProvenanceFacts),
      TOP_LEVEL_REGEX_12,
      "the pre-provenance event is consumed as current (never-advanced, generation 0)"
    );

    // Two LATER, correctly-stamped (generation 0) recovery-only events: no
    // `collection_facts` block at all — `parseTerminalFactEvent` returns
    // null for these, so `foldTerminalEventFacts` returns before the
    // generation gate even runs (§1.3 fact 1 of the design review). They
    // must neither heal (unnecessary — the pre-provenance facts are already
    // current) nor poison (they carry no facts to poison with) the gate.
    const insertRecoveryOnlyEvent = (eventSeq: number, eventId: string) => {
      getDb()
        .prepare(
          `INSERT INTO spine_events(
             event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
             actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, manifest_generation, data_json, version
           ) VALUES (?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, ?, 0, ?, '1')`
        )
        .run(
          eventId,
          eventSeq,
          NOW,
          NOW,
          `trace_${eventSeq}`,
          `run_${eventSeq}`,
          `run_${eventSeq}`,
          INSTANCE_ID,
          JSON.stringify({
            connection_id: INSTANCE_ID,
            connector_instance_id: INSTANCE_ID,
            recovery_only: true,
          })
        );
    };
    insertRecoveryOnlyEvent(2, "evt_straddle_recovery_only_1");
    insertRecoveryOnlyEvent(3, "evt_straddle_recovery_only_2");

    const afterRecoveryOnly = summaryFor(await listBypassCache());
    assert.equal(
      afterRecoveryOnly.terminal_facts.state,
      "current",
      "recovery-only fact-less events do not disturb the current pre-provenance verdict"
    );
    assert.equal(afterRecoveryOnly.terminal_facts.reason_code, null);
    assert.deepEqual(
      (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts,
      preProvenanceFacts,
      "the current fact map is still sourced from the pre-provenance run, unchanged by the fact-less recovery-only events"
    );
  }));

test("SQLite warm v3 terminal projection is invalidated and replayed, now accepting generationless history for a never-advanced connection", () =>
  withSqlite(async ({ databasePath }: { databasePath: string }) => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedTerminalCollectionFactSqlite({ eventId: "evt_v3_warm_upgrade", eventSeq: 1 });

    // This is the pre-upgrade projection: its source event was stamped while
    // the current binary is running, then its durable row is made to look
    // exactly like the version-3 binary's already-refused (historical) map —
    // v3 refused this event outright because it treated EVERY NULL stamp as
    // historical regardless of the connection's generation (fix-pre-
    // provenance-terminal-generation-semantics' whole point). Blanking the
    // stamp to NULL models "this event predates generation provenance."
    await getConnectorSummaryForRoute(INSTANCE_ID);
    assert.match(
      JSON.stringify((await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts),
      TOP_LEVEL_REGEX_1
    );
    getDb()
      .prepare(
        "UPDATE connector_summary_evidence SET stream_facts_fold_version = 3, terminal_facts_state = 'stale', terminal_facts_reason_code = 'terminal_facts_historical', stream_latest_facts_json = NULL WHERE connector_instance_id = ?"
      )
      .run(INSTANCE_ID);
    getDb().prepare("UPDATE spine_events SET manifest_generation = NULL WHERE event_id = ?").run("evt_v3_warm_upgrade");

    // Model the fold-contract upgrade: the source row is legacy (v3) but the
    // disposable v3 projection survives deployment. The first real route
    // read after restart must replay it under v4 semantics — the connection
    // has never advanced past generation 0, so the unstamped event is now
    // consumed as CURRENT evidence, healing the false-historical projection
    // without any data migration.
    closeDb();
    initDb(databasePath);
    invalidateConnectorSummariesCache();
    const warmRead = await getConnectorSummaryForRoute(INSTANCE_ID);
    const warmEvidence = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(warmRead?.terminal_facts.state, "current");
    assert.equal(warmRead?.terminal_facts.reason_code, null);
    assert.match(JSON.stringify(warmEvidence.stream_latest_facts), TOP_LEVEL_REGEX_2);
    assert.equal(
      Number(
        requireRow(
          getDb()
            .prepare("SELECT stream_facts_fold_version FROM connector_summary_evidence WHERE connector_instance_id = ?")
            .get<{ stream_facts_fold_version: number }>(INSTANCE_ID),
          "warm summary evidence exists"
        ).stream_facts_fold_version
      ),
      4
    );

    const healedProjection = {
      facts: warmEvidence.stream_latest_facts,
      reason: warmRead?.terminal_facts.reason_code,
      state: warmRead?.terminal_facts.state,
    };
    closeDb();
    initDb(databasePath);
    invalidateConnectorSummariesCache();
    const repeatedRestart = await getConnectorSummaryForRoute(INSTANCE_ID);
    assert.deepEqual(
      {
        facts: (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts,
        reason: repeatedRestart?.terminal_facts.reason_code,
        state: repeatedRestart?.terminal_facts.state,
      },
      healedProjection,
      "the healed current projection is stable across repeated restarts"
    );

    // Deleting the projector cannot change the source-derived verdict — the
    // invalidate-and-replay contract produces the same verdict as delete/rebuild.
    getDb().prepare("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?").run(INSTANCE_ID);
    closeDb();
    initDb(databasePath);
    invalidateConnectorSummariesCache();
    const rebuilt = await getConnectorSummaryForRoute(INSTANCE_ID);
    assert.deepEqual(
      {
        facts: (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts,
        reason: rebuilt?.terminal_facts.reason_code,
        state: rebuilt?.terminal_facts.state,
      },
      healedProjection,
      "first warm-upgrade read and delete/rebuild have identical terminal evidence"
    );
  }));

test("SQLite route retries a lost v4 replay before trusting a mixed-version v2 terminal map", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedTerminalCollectionFactSqlite({ eventId: "evt_mixed_v2_messages", eventSeq: 1 });
    await getConnectorSummaryForRoute(INSTANCE_ID);
    const oldFacts = (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts;
    getDb()
      .prepare("UPDATE connector_summary_evidence SET stream_facts_fold_version = 2 WHERE connector_instance_id = ?")
      .run(INSTANCE_ID);
    getDb()
      .prepare("UPDATE spine_events SET manifest_generation = NULL WHERE event_id = ?")
      .run("evt_mixed_v2_messages");

    let signalPaused: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      signalPaused = resolve;
    });
    let releaseReplay: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    __testOnlySetFoldPauseHook(async (point: string) => {
      if (point === "after_seed_before_read") {
        signalPaused?.();
        await release;
      }
    });
    try {
      const routePromise = getConnectorSummaryForRoute(INSTANCE_ID);
      await paused;
      seedTerminalCollectionFactSqlite({ eventId: "evt_mixed_v2_empty", eventSeq: 2, stream: EMPTY_STREAM });
      const v2WriteAccepted = await __testOnlyUpdateStreamFactsCasWrite({
        baselineEventSeq: 1,
        baselineFoldVersion: 2,
        connectorInstanceId: INSTANCE_ID,
        eventSeq: 2,
        factsJson: JSON.stringify({
          ...requireJsonRecord(oldFacts, "previous stream facts"),
          [EMPTY_STREAM]: {
            event_seq: 2,
            evidence_as_of: NOW,
            fact: { checkpoint: "committed", collected: 1, stream: EMPTY_STREAM },
            run_id: "run_2",
          },
        }),
        foldVersion: 2,
      });
      assert.equal(v2WriteAccepted, true, "premise: the realistic v2 delta wins before v4 owns the row");
      __testOnlySetFoldPauseHook(null);
      releaseReplay?.();
      const firstRoute = await routePromise;
      const firstEvidence = await getConnectorSummaryEvidence(INSTANCE_ID);
      assert.equal(firstRoute?.terminal_facts.state, "current");
      assert.equal(
        Number(
          requireRow(
            getDb()
              .prepare(
                "SELECT stream_facts_fold_version FROM connector_summary_evidence WHERE connector_instance_id = ?"
              )
              .get<{ stream_facts_fold_version: number }>(INSTANCE_ID),
            "first-route summary evidence exists"
          ).stream_facts_fold_version
        ),
        4
      );
      // fix-pre-provenance-terminal-generation-semantics: the connection has
      // never advanced past generation 0, so BOTH the v2 delta's EMPTY_STREAM
      // fact AND the replayed unstamped `messages` event are consumed.
      assert.deepEqual(Object.keys(firstEvidence.stream_latest_facts ?? {}).sort(), [EMPTY_STREAM, STREAM].sort());

      const firstProjection = {
        facts: firstEvidence.stream_latest_facts,
        reason: firstRoute?.terminal_facts.reason_code,
        state: firstRoute?.terminal_facts.state,
      };
      getDb().prepare("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?").run(INSTANCE_ID);
      const rebuiltRoute = await getConnectorSummaryForRoute(INSTANCE_ID);
      assert.deepEqual(
        {
          facts: (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts,
          reason: rebuiltRoute?.terminal_facts.reason_code,
          state: rebuiltRoute?.terminal_facts.state,
        },
        firstProjection,
        "the first route result equals delete/rebuild after the mixed-version race"
      );
      const laterV2WriteAccepted = await __testOnlyUpdateStreamFactsCasWrite({
        baselineEventSeq: 2,
        baselineFoldVersion: 2,
        connectorInstanceId: INSTANCE_ID,
        eventSeq: 2,
        factsJson: JSON.stringify(oldFacts),
        foldVersion: 2,
      });
      assert.equal(laterV2WriteAccepted, false, "v2 cannot overwrite the converged v4 row");
    } finally {
      __testOnlySetFoldPauseHook(null);
    }
  }));

test("SQLite route fails terminal facts closed when bounded v3 replay contention does not converge", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedTerminalCollectionFactSqlite({ eventId: "evt_contention_v2_messages", eventSeq: 1 });
    await getConnectorSummaryForRoute(INSTANCE_ID);
    const oldFacts = (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts;
    getDb()
      .prepare("UPDATE connector_summary_evidence SET stream_facts_fold_version = 2 WHERE connector_instance_id = ?")
      .run(INSTANCE_ID);
    getDb()
      .prepare("UPDATE spine_events SET manifest_generation = NULL WHERE event_id = ?")
      .run("evt_contention_v2_messages");
    seedTerminalCollectionFactSqlite({ eventId: "evt_contention_v3_empty", eventSeq: 2, stream: EMPTY_STREAM });

    let v2Wins = 0;
    __testOnlySetFoldPauseHook(async (point: any) => {
      if (point !== "before_cas_write") {
        return;
      }
      if (v2Wins === 1) {
        seedTerminalCollectionFactSqlite({ eventId: "evt_contention_v2_empty_2", eventSeq: 3, stream: EMPTY_STREAM });
      }
      const eventSeq = v2Wins === 0 ? 2 : 3;
      const baselineEventSeq = eventSeq - 1;
      const accepted = await __testOnlyUpdateStreamFactsCasWrite({
        baselineEventSeq,
        baselineFoldVersion: 2,
        connectorInstanceId: INSTANCE_ID,
        eventSeq,
        factsJson: JSON.stringify({
          ...requireJsonRecord(oldFacts, "previous stream facts"),
          [EMPTY_STREAM]: {
            event_seq: eventSeq,
            evidence_as_of: NOW,
            fact: { checkpoint: "committed", collected: eventSeq - 1, stream: EMPTY_STREAM },
            run_id: `run_${eventSeq}`,
          },
        }),
        foldVersion: 2,
      });
      assert.equal(accepted, true, `v2 contender ${v2Wins} must win before the corresponding v3 CAS`);
      v2Wins += 1;
    });
    try {
      const route = await getConnectorSummaryForRoute(INSTANCE_ID);
      assert.equal(v2Wins, 2, "the route made exactly its bounded two replay attempts");
      assert.equal(route?.terminal_facts.state, "stale");
      assert.equal(route?.terminal_facts.reason_code, "terminal_fold_contention");
      assert.match(
        JSON.stringify((await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts),
        TOP_LEVEL_REGEX_3,
        "the raw durable v2 row may still contain history, but the same route cannot trust it"
      );
    } finally {
      __testOnlySetFoldPauseHook(null);
    }
  }));

test("SQLite event after an unobserved mutation is current while pre-mutation history stays historical", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    // No evidence row exists yet: this is the disposable-projector case in
    // its strongest form, before the first repair has ever run.
    seedTerminalCollectionFactSqlite({ eventId: "evt_before_unobserved_mutation", eventSeq: 1 });
    await registerConnector({ ...MANIFEST, streams: [MANIFEST.streams[1]] }, { backfillRetrievalIndexes: false });
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    __setRegisterConnectorPhaseHookForTest(async (point: any) => {
      if (point === "after-manifest-persisted") {
        seedTerminalCollectionFactSqlite({ eventId: "evt_after_unobserved_mutation", eventSeq: 2 });
      }
    });
    try {
      await registerConnector(MANIFEST, { backfillRetrievalIndexes: false });
    } finally {
      __setRegisterConnectorPhaseHookForTest(null);
    }

    const mutationGeneration = requireRow(
      getDb()
        .prepare("SELECT manifest_generation FROM connector_instances WHERE connector_instance_id = ?")
        .get<{ manifest_generation: number }>(INSTANCE_ID),
      "mutated connector instance exists"
    );
    assert.equal(mutationGeneration.manifest_generation, 2);
    const beforeMutationEvent = requireRow(
      getDb()
        .prepare("SELECT manifest_generation FROM spine_events WHERE event_id = ?")
        .get<{ manifest_generation: number }>("evt_before_unobserved_mutation"),
      "pre-mutation event exists"
    );
    assert.equal(beforeMutationEvent.manifest_generation, 0);
    const afterMutationEvent = requireRow(
      getDb()
        .prepare("SELECT manifest_generation FROM spine_events WHERE event_id = ?")
        .get<{ manifest_generation: number }>("evt_after_unobserved_mutation"),
      "post-mutation event exists"
    );
    assert.equal(afterMutationEvent.manifest_generation, 2);
    const summary = summaryFor(await listBypassCache());
    assert.match(
      JSON.stringify((await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts),
      TOP_LEVEL_REGEX_4
    );
    assert.equal(summary.terminal_facts.event_seq, 2, "only the post-mutation event is current evidence");
  }));

test("malformed manifest preserves connection and stream evidence as declaration unavailable", () =>
  withSqlite(async () => {
    seedConnectorSqlite("not-json");
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "manifest_unavailable", stream: UNEXPECTED_STREAM });

    const summary = summaryFor(await listBypassCache());
    assert.equal(summary.manifest_declaration.state, "unavailable");
    assert.equal(streamEntry(summary, UNEXPECTED_STREAM).declaration_state, "unavailable");
  }));

test("retained-byte failure does not erase a current canonical count", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "current_record" });
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    await rebuildRetainedSize();
    getDb()
      .prepare(
        `UPDATE retained_size_connection SET dirty = 1, computed_at = NULL
          WHERE connector_instance_id = ?`
      )
      .run(INSTANCE_ID);

    const summary = summaryFor(await listBypassCache());
    assert.equal(summary.total_records, 1);
    assert.equal(streamEntry(summary, STREAM).count_state, "known");
    assert.equal(summary.retained_bytes, null);
  }));

// ---------------------------------------------------------------------------
// Retained-bytes missing→clean and clean-value-changed convergence
// (P1 finding: `classifyCandidate`'s original `retainedDirty && current`
// check could never detect a clean retained row appearing AFTER the
// evidence was already stamped `stale` — see `retainedBytesNeedsRepair` in
// connector-summary-evidence-engine.ts).
// ---------------------------------------------------------------------------

test("retained bytes missing→clean convergence: a later clean retained row is detected and repaired without any unrelated dirty hint", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "current_record" });

    // First reconciliation pass: no retained_size_connection row exists yet
    // for this connection, so the repair correctly stamps `stale` (no data
    // observed) rather than a fabricated clean value.
    const firstPass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(firstPass.repaired, 1, "first pass creates+repairs the missing row");
    const afterFirstPass = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(afterFirstPass.retained_bytes_evidence.state, "stale");
    assert.equal(afterFirstPass.retained_bytes, null);

    // A clean retained row now appears (e.g. the retained-size projection
    // observed this connection for the first time), WITHOUT touching
    // connector_summary_evidence's dirty flag at all — the exact scenario
    // the original `retainedDirty && storedRetainedState === "current"`
    // check could never detect, because `storedRetainedState` was already
    // `stale`, not `current`.
    seedRetainedConnectionSqlite({ dirty: 0 });

    const secondPass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(
      secondPass.repaired,
      1,
      "the clean retained row appearing must classify as a repair candidate even though nothing marked it dirty"
    );

    const evidence = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(evidence.retained_bytes_evidence.state, "current");
    assert.equal(evidence.retained_bytes_evidence.reason_code, null);
    assert.ok(evidence.retained_bytes, "the real byte values must now be visible");
    const retainedBytes = requireRetainedBytes(evidence.retained_bytes, "retained evidence bytes");
    assert.equal(retainedBytes.record_json_bytes, 100);
    assert.equal(retainedBytes.record_changes_json_bytes, 10);
    assert.equal(retainedBytes.blob_bytes, 5);
    assert.equal(retainedBytes.total_bytes, 115);
    assert.equal(evidence.total_retained_bytes, 115);

    const summary = summaryFor(await listBypassCache());
    assert.equal(summary.retained_bytes_evidence.state, "current");
    assert.ok(summary.retained_bytes, "the shaped summary must also expose the real bytes");
    assert.equal(summary.retained_bytes.total_bytes, 115);
  }));

test("retained bytes clean-value-changed convergence: new clean values are detected and repaired even when the dirty flag never fired", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "current_record" });
    seedRetainedConnectionSqlite({ dirty: 0 });

    const firstPass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(firstPass.repaired, 1);
    const before = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(before.retained_bytes_evidence.state, "current");
    assert.equal(requireRetainedBytes(before.retained_bytes, "initial retained bytes").total_bytes, 115);

    // The source row's clean values change, but `dirty` is explicitly left
    // (re-set) at 0 to simulate a flag that never fired for this change —
    // the "clean-value-changed convergence" case that a dirty-flag-only
    // check can never catch.
    getDb()
      .prepare(
        `UPDATE retained_size_connection
            SET current_record_json_bytes = ?, record_history_json_bytes = ?, blob_bytes = ?, dirty = 0
          WHERE connector_instance_id = ?`
      )
      .run(9000, 800, 700, INSTANCE_ID);

    const secondPass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(
      secondPass.repaired,
      1,
      "a changed clean value must classify as a candidate even though the dirty flag stayed 0"
    );

    const evidence = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(evidence.retained_bytes_evidence.state, "current");
    const changedBytes = requireRetainedBytes(evidence.retained_bytes, "changed retained bytes");
    assert.equal(changedBytes.record_json_bytes, 9000);
    assert.equal(changedBytes.record_changes_json_bytes, 800);
    assert.equal(changedBytes.blob_bytes, 700);
    assert.equal(changedBytes.total_bytes, 10_500);
  }));

test("retained bytes convergence is stable: two back-to-back passes after convergence both repair zero", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "current_record" });

    // Pass 1: creates the row, no retained data yet -> stale.
    await reconcileConnectorSummaryEvidence(null);

    // Clean retained data appears; pass 2 detects and repairs it (the
    // missing→clean convergence proven above).
    seedRetainedConnectionSqlite({ dirty: 0 });
    const convergePass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(convergePass.repaired, 1, "pass 2 converges the retained-bytes component to current");

    const afterConverge = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(afterConverge.retained_bytes_evidence.state, "current");

    // Two further passes with NOTHING changed must both report zero repair
    // work for this connection: convergence must be stable, not an
    // unbounded "state isn't current forever" churn loop.
    const stablePass1 = await reconcileConnectorSummaryEvidence(null);
    assert.equal(stablePass1.repaired, 0, "no repair work once genuinely converged (pass 3)");
    const stablePass2 = await reconcileConnectorSummaryEvidence(null);
    assert.equal(stablePass2.repaired, 0, "no repair work once genuinely converged (pass 4)");

    const finalEvidence = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(finalEvidence.retained_bytes_evidence.state, "current");
    assert.equal(requireRetainedBytes(finalEvidence.retained_bytes, "final retained bytes").total_bytes, 115);
  }));

test("retained bytes evidence component is exposed on the summary distinct from the byte-value field", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "current_record" });

    // Never-observed: no retained_size_connection row at all.
    const summaryBefore = summaryFor(await listBypassCache());
    assert.equal(summaryBefore.retained_bytes_evidence.state, "stale");
    assert.equal(summaryBefore.retained_bytes ?? null, null);

    seedRetainedConnectionSqlite({ dirty: 0 });
    await rebuildConnectorSummaryEvidence();
    const summaryAfter = summaryFor(await listBypassCache());
    assert.equal(summaryAfter.retained_bytes_evidence.state, "current");
    assert.ok(summaryAfter.retained_bytes, "byte-value payload present once current");

    // The typed component must never feed connection_health/ProjectionReliable
    // (design.md "Health boundary"): a clean, current retained-bytes
    // component alone must not itself force a healthy connection unknown,
    // and this connection has no other unreliable source.
    assert.notEqual(summaryAfter.connection_health.state, "unknown");
  }));

test("terminal facts distinguish never-observed from checkpointed-empty history", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    // The one observation barrier fully converges in ONE call: discovery
    // creates the missing evidence row, then the fold runs against that
    // now-existing row in the same pass, so even a never-before-seen
    // connection's terminal history is genuinely checkpointed (empty) by
    // the time this call returns — never requiring a second call to reach
    // `current`.
    const converged = summaryFor(await listBypassCache());
    assert.equal(converged.terminal_facts.state, "current");
    assert.equal(converged.terminal_facts.event_seq, 0);

    // `unobserved` is reserved for when the fold has GENUINELY never
    // completed — e.g. it failed outright — not merely deferred by call
    // ordering. Force a fold failure (spine_events unreadable) against a
    // FRESH connection so its evidence row is created by discovery but the
    // same barrier call's fold cannot complete for it.
    seedInstanceSqlite({ connectorInstanceId: "cin_never_observed" });
    getDb().exec("ALTER TABLE spine_events RENAME TO spine_events_hidden");
    try {
      const failed = summaryFor(await listBypassCache(), "cin_never_observed");
      assert.equal(
        failed.terminal_facts.state,
        "unobserved",
        "a genuinely failed fold leaves terminal facts unobserved, not fabricated current"
      );
    } finally {
      getDb().exec("ALTER TABLE spine_events_hidden RENAME TO spine_events");
    }

    // Once the fold can read again, the NEXT single call fully converges
    // this connection too — proving `unobserved` was never a permanent or
    // call-order artifact.
    const recovered = summaryFor(await listBypassCache(), "cin_never_observed");
    assert.equal(recovered.terminal_facts.state, "current");
  }));

// One-call conformance (design.md "One internal observation barrier"): a
// never-before-seen connection with a genuine (non-empty) terminal history
// on the spine reaches record_snapshot=current, terminal_facts=current with
// the correct high-water event_seq, and manifest_declaration=current — ALL
// from exactly one consumer call. No caller may ever need a second call (or
// an explicit rebuild) to converge a healthy connection; regressing the
// barrier back to a discover-only-then-fold-next-time ordering would make
// this fail even though the earlier tests in this file could still pass.
test("a single observation fully converges every evidence component for a never-before-seen connection", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "one_call_record" });
    getDb()
      .prepare(
        `INSERT INTO spine_events(
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
         ) VALUES ('evt_one_call', 1, 'run.completed', ?, ?, 'test', 'trace_one_call', 'runtime', 'test-connector', 'run', 'run_one_call', 'succeeded', 'run_one_call', ?, '1')`
      )
      .run(
        NOW,
        NOW,
        JSON.stringify({
          collection_facts: {
            reference_only: true,
            schema_version: 1,
            streams: [{ checkpoint: "committed", collected: 1, stream: STREAM }],
          },
          connection_id: INSTANCE_ID,
          connector_instance_id: INSTANCE_ID,
        })
      );

    const summary = summaryFor(await listBypassCache());
    assert.equal(summary.record_snapshot.state, "current", "one call converges record_snapshot");
    assert.equal(summary.terminal_facts.state, "current", "one call converges terminal_facts");
    assert.equal(summary.terminal_facts.event_seq, 1, "the fold reaches the real high-water seq in the same call");
    assert.equal(summary.manifest_declaration.state, "current", "one call converges manifest_declaration");
    assert.equal(summary.total_records, 1);
  }));

test("summary read failure never becomes an empty healthy result, and reads a reason code distinct from a merely-missing row", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    await rebuildConnectorSummaryEvidence();
    getDb().exec("ALTER TABLE connector_summary_evidence RENAME TO connector_summary_evidence_unavailable");
    try {
      const summary = summaryFor(await listBypassCache());
      assert.notEqual(summary.connection_health.state, "healthy");
      const projection = summary.connection_health.conditions.find(
        (condition: any) => condition.type === "ProjectionReliable"
      );
      assert.equal(projection?.status, "false");
      // A total read failure (the whole table is unreachable) must be
      // distinguishable from the ordinary "no evidence row exists yet"
      // case (`summary_missing`) — design.md task 5.4. Both would
      // otherwise read as the exact same reason code.
      assert.equal(projection?.reason_code, "summary_evidence_read_failed");
    } finally {
      getDb().exec("ALTER TABLE connector_summary_evidence_unavailable RENAME TO connector_summary_evidence");
    }
  }));

test("cache decisions cannot return a prior value before observation reconciliation", () => {
  const entry = {
    freshUntil: 2000,
    generation: 1,
    staleUntil: 10_000,
    value: [{ connector_instance_id: INSTANCE_ID, total_records: 1 }],
  };
  assert.notEqual(decideConnectorSummariesCacheRead(entry), "return_fresh");
  assert.notEqual(decideConnectorSummariesCacheRead(entry), "return_stale_refresh");
});

test("warm list and scoped consumers converge after canonical state changes", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "before_cache" });
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    await rebuildRetainedSize();
    const warm = summaryFor(await listConnectorSummaries());
    assert.equal(warm.total_records, 1);

    getDb()
      .prepare("UPDATE retained_size_stream SET record_count = 2 WHERE connector_instance_id = ? AND stream = ?")
      .run(INSTANCE_ID, STREAM);
    getDb()
      .prepare("UPDATE retained_size_connection SET record_count = 2, computed_at = ? WHERE connector_instance_id = ?")
      .run("2026-07-16T12:02:00.000Z", INSTANCE_ID);
    seedCanonicalRecordSqlite({ emittedAt: "2026-07-16T12:02:00.000Z", recordKey: "after_cache" });

    const listResult = summaryFor(await listConnectorSummaries());
    const scopedResult = await getConnectorSummaryForRoute(INSTANCE_ID);
    assert.equal(listResult.total_records, 2, "the exact default list path must not return stale cached evidence");
    assert.equal(scopedResult?.total_records, 2, "scoped detail must use the same converged evidence");
  }));

test("dedicated PostgreSQL manifest generations fence historical facts and undeclared-write provenance", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: requirePostgresUrl() });
  try {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      CONNECTOR_ID,
      MANIFEST_JSON,
      NOW,
    ]);
    await postgresQuery(
      `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
      [INSTANCE_ID, OWNER, CONNECTOR_ID, "Summary evidence oracle", NOW]
    );

    const summaries = await rebuildConnectorSummaryEvidence();
    if (!Array.isArray(summaries)) {
      throw new TypeError("summary rebuild result must be an array");
    }
    const evidence = summaries
      .map((row) => requireJsonRecord(row, "PostgreSQL summary row"))
      .find((row) => row.connector_instance_id === INSTANCE_ID);
    assert.ok(evidence, "real PostgreSQL rebuild must materialize the active connection");
    const recordSnapshot =
      evidence.record_snapshot === undefined
        ? undefined
        : requireJsonRecord(evidence.record_snapshot, "PostgreSQL record snapshot");
    assert.equal(recordSnapshot?.state, "current");
    if (!Array.isArray(evidence.stream_records)) {
      throw new TypeError("PostgreSQL stream records must be an array");
    }
    assert.deepEqual(
      evidence.stream_records
        .map((entry) => requireJsonRecord(entry, "PostgreSQL stream record"))
        .map((entry) => ({
          count_state: entry.count_state,
          declaration_state: entry.declaration_state,
          record_count: entry.record_count,
          stream: requireString(entry.stream, "PostgreSQL stream record.stream"),
        }))
        .sort((a, b) => a.stream.localeCompare(b.stream)),
      [
        {
          count_state: "known_zero",
          declaration_state: "declared",
          record_count: 0,
          stream: EMPTY_STREAM,
        },
        {
          count_state: "known_zero",
          declaration_state: "declared",
          record_count: 0,
          stream: STREAM,
        },
      ]
    );

    const sequenceResult = await postgresQuery("SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM spine_events");
    const firstSeq = Number(firstRow(sequenceResult.rows, "PostgreSQL sequence query returns a row").next_seq);
    const insertTerminal = async (eventSeq: number) => {
      await postgresQuery(
        `INSERT INTO spine_events(
             event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
             actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
           ) VALUES($1, $2, 'run.completed', $3, $3, 'test', $4, 'runtime', 'test-connector', 'run', $5, 'succeeded', $5, $6, $7::jsonb, '1')`,
        [
          `evt_readd_pg_${eventSeq}`,
          eventSeq,
          NOW,
          `trace_readd_pg_${eventSeq}`,
          `run_readd_pg_${eventSeq}`,
          INSTANCE_ID,
          JSON.stringify({
            collection_facts: {
              reference_only: true,
              schema_version: 1,
              streams: [{ checkpoint: "committed", collected: 1, stream: STREAM }],
            },
            connection_id: INSTANCE_ID,
            connector_instance_id: INSTANCE_ID,
          }),
        ]
      );
    };
    await insertTerminal(firstSeq);
    await listBypassCache();
    assert.match(
      JSON.stringify((await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts),
      TOP_LEVEL_REGEX_5
    );

    const withoutMessages = { ...MANIFEST, streams: [MANIFEST.streams[1]] };
    await registerConnector(withoutMessages, { backfillRetrievalIndexes: false });
    await listBypassCache();
    const dormant = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(dormant.stream_latest_facts, null, "Postgres clears old terminal facts at the manifest boundary");
    assert.equal(dormant.stream_facts_event_seq, firstSeq);
    assert.equal(dormant.manifest_generation, 1, "the production manifest write advances the durable generation");

    await registerConnector(MANIFEST, { backfillRetrievalIndexes: false });
    await listBypassCache();
    const readded = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(readded.stream_latest_facts, null, "Postgres re-add withholds historical proof");
    assert.equal(readded.manifest_generation, 2, "unobserved remove-readd advances twice at the mutation boundary");

    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await closePostgresStorage();
    await initPostgresStorage({ backend: "postgres", databaseUrl: requirePostgresUrl() });
    const rebuilt = summaryFor(await listBypassCache());
    assert.equal(
      (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts,
      null,
      "projection rebuild cannot replay generation-zero terminal facts"
    );
    assert.notEqual(rebuilt.connection_health.state, "healthy");

    await insertTerminal(firstSeq + 1);
    await listBypassCache();
    assert.match(
      JSON.stringify((await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts),
      TOP_LEVEL_REGEX_6
    );

    await recordCurrentGenerationUndeclaredWrite(
      { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE_ID },
      { provenance: "postgres_current_generation_rejected_write", stream: UNEXPECTED_STREAM }
    );
    const unexpected = summaryFor(await listBypassCache());
    assert.equal(streamEntry(unexpected, UNEXPECTED_STREAM).declaration_state, "unexpected");

    const reordered = {
      capabilities: MANIFEST.capabilities,
      connector_id: MANIFEST.connector_id,
      display_name: MANIFEST.display_name,
      protocol_version: MANIFEST.protocol_version,
      streams: MANIFEST.streams,
      version: MANIFEST.version,
    };
    await registerConnector(reordered, { backfillRetrievalIndexes: false });
    const reorderedGeneration = await postgresQuery(
      "SELECT manifest_generation FROM connector_instances WHERE connector_instance_id = $1",
      [INSTANCE_ID]
    );
    assert.equal(
      Number(firstRow(reorderedGeneration.rows, "reordered PostgreSQL connector instance exists").manifest_generation),
      2,
      "semantic key reorder is a no-op"
    );

    // A real semantic change starts another durable generation. The old
    // violation must remain historical even though streams are unchanged.
    await registerConnector({ ...MANIFEST, version: "1.0.1" }, { backfillRetrievalIndexes: false });
    const nextGenerationResult = await postgresQuery(
      "SELECT manifest_generation FROM connector_instances WHERE connector_instance_id = $1",
      [INSTANCE_ID]
    );
    assert.equal(
      Number(firstRow(nextGenerationResult.rows, "next PostgreSQL connector generation exists").manifest_generation),
      3
    );
    const nextGeneration = summaryFor(await listBypassCache());
    assert.notEqual(
      nextGeneration.stream_records.find((entry: any) => entry.stream === UNEXPECTED_STREAM)?.declaration_state,
      "unexpected",
      "a violation from an older generation cannot resurrect after a manifest rewrite"
    );
  } finally {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
    await closePostgresStorage();
  }
});

test("dedicated PostgreSQL warm v3 terminal projection is invalidated and replayed, now accepting generationless history for a never-advanced connection (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: requirePostgresUrl() });
  try {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      CONNECTOR_ID,
      MANIFEST_JSON,
      NOW,
    ]);
    await postgresQuery(
      `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
      [INSTANCE_ID, OWNER, CONNECTOR_ID, "Summary evidence oracle", NOW]
    );
    const nextSequence = await postgresQuery("SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM spine_events");
    const eventSeq = Number(firstRow(nextSequence.rows, "PostgreSQL sequence query returns a row").next_seq);
    await postgresQuery(
      `INSERT INTO spine_events(
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
         ) VALUES($1, $2, 'run.completed', $3, $3, 'test', $4, 'runtime', 'test-connector', 'run', $5, 'succeeded', $5, $6, $7::jsonb, '1')`,
      [
        "evt_v2_warm_upgrade_pg",
        eventSeq,
        NOW,
        "trace_v2_warm_upgrade_pg",
        "run_v2_warm_upgrade_pg",
        INSTANCE_ID,
        JSON.stringify({
          collection_facts: {
            reference_only: true,
            schema_version: 1,
            streams: [{ checkpoint: "committed", collected: 1, stream: STREAM }],
          },
          connection_id: INSTANCE_ID,
          connector_instance_id: INSTANCE_ID,
        }),
      ]
    );
    await getConnectorSummaryForRoute(INSTANCE_ID);
    assert.match(
      JSON.stringify((await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts),
      TOP_LEVEL_REGEX_7
    );
    await postgresQuery(
      "UPDATE connector_summary_evidence SET stream_facts_fold_version = 3, terminal_facts_state = 'stale', terminal_facts_reason_code = 'terminal_facts_historical', stream_latest_facts_json = NULL WHERE connector_instance_id = $1",
      [INSTANCE_ID]
    );
    await postgresQuery("UPDATE spine_events SET manifest_generation = NULL WHERE event_id = $1", [
      "evt_v2_warm_upgrade_pg",
    ]);

    // The fold-contract upgrade replays the v3 row under v4 semantics: the
    // connection has never advanced past generation 0, so its unstamped
    // event is now consumed as current evidence — no data migration.
    await closePostgresStorage();
    await initPostgresStorage({ backend: "postgres", databaseUrl: requirePostgresUrl() });
    invalidateConnectorSummariesCache();
    const warmRead = await getConnectorSummaryForRoute(INSTANCE_ID);
    const warmEvidence = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(warmRead?.terminal_facts.state, "current");
    assert.equal(warmRead?.terminal_facts.reason_code, null);
    assert.match(JSON.stringify(warmEvidence.stream_latest_facts), TOP_LEVEL_REGEX_8);
    const warmEvidenceVersion = await postgresQuery(
      "SELECT stream_facts_fold_version FROM connector_summary_evidence WHERE connector_instance_id = $1",
      [INSTANCE_ID]
    );
    assert.equal(
      Number(firstRow(warmEvidenceVersion.rows, "warm PostgreSQL summary evidence exists").stream_facts_fold_version),
      4
    );

    const healedProjection = {
      facts: warmEvidence.stream_latest_facts,
      reason: warmRead?.terminal_facts.reason_code,
      state: warmRead?.terminal_facts.state,
    };
    await closePostgresStorage();
    await initPostgresStorage({ backend: "postgres", databaseUrl: requirePostgresUrl() });
    invalidateConnectorSummariesCache();
    const repeatedRestart = await getConnectorSummaryForRoute(INSTANCE_ID);
    assert.deepEqual(
      {
        facts: (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts,
        reason: repeatedRestart?.terminal_facts.reason_code,
        state: repeatedRestart?.terminal_facts.state,
      },
      healedProjection,
      "the healed current projection is stable across repeated restarts on PostgreSQL"
    );

    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await closePostgresStorage();
    await initPostgresStorage({ backend: "postgres", databaseUrl: requirePostgresUrl() });
    invalidateConnectorSummariesCache();
    const rebuilt = await getConnectorSummaryForRoute(INSTANCE_ID);
    assert.deepEqual(
      {
        facts: (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts,
        reason: rebuilt?.terminal_facts.reason_code,
        state: rebuilt?.terminal_facts.state,
      },
      healedProjection,
      "first warm-upgrade read and delete/rebuild have identical terminal evidence on PostgreSQL"
    );
  } finally {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
    await closePostgresStorage();
  }
});

test("dedicated PostgreSQL route retries a lost v4 replay before trusting a mixed-version v2 terminal map (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: requirePostgresUrl() });
  try {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      CONNECTOR_ID,
      MANIFEST_JSON,
      NOW,
    ]);
    await postgresQuery(
      `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
      [INSTANCE_ID, OWNER, CONNECTOR_ID, "Summary evidence oracle", NOW]
    );
    const nextSequence = await postgresQuery("SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM spine_events");
    const firstSeq = Number(firstRow(nextSequence.rows, "PostgreSQL sequence query returns a row").next_seq);
    const insertTerminal = async ({ eventId, eventSeq, stream, collected }: any) => {
      await postgresQuery(
        `INSERT INTO spine_events(
             event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
             actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
           ) VALUES($1, $2, 'run.completed', $3, $3, 'test', $4, 'runtime', 'test-connector', 'run', $5, 'succeeded', $5, $6, $7::jsonb, '1')`,
        [
          eventId,
          eventSeq,
          NOW,
          `trace_${eventId}`,
          `run_${eventId}`,
          INSTANCE_ID,
          JSON.stringify({
            collection_facts: {
              reference_only: true,
              schema_version: 1,
              streams: [{ checkpoint: "committed", collected, stream }],
            },
            connection_id: INSTANCE_ID,
            connector_instance_id: INSTANCE_ID,
          }),
        ]
      );
    };
    await insertTerminal({ collected: 1, eventId: "evt_mixed_v2_messages_pg", eventSeq: firstSeq, stream: STREAM });
    await getConnectorSummaryForRoute(INSTANCE_ID);
    const oldFacts = (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts;
    await postgresQuery(
      "UPDATE connector_summary_evidence SET stream_facts_fold_version = 2 WHERE connector_instance_id = $1",
      [INSTANCE_ID]
    );
    await postgresQuery("UPDATE spine_events SET manifest_generation = NULL WHERE event_id = $1", [
      "evt_mixed_v2_messages_pg",
    ]);

    let signalPaused: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      signalPaused = resolve;
    });
    let releaseReplay: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    __testOnlySetFoldPauseHook(async (point: string) => {
      if (point === "after_seed_before_read") {
        signalPaused?.();
        await release;
      }
    });
    try {
      const routePromise = getConnectorSummaryForRoute(INSTANCE_ID);
      await paused;
      await insertTerminal({
        collected: 1,
        eventId: "evt_mixed_v2_empty_pg",
        eventSeq: firstSeq + 1,
        stream: EMPTY_STREAM,
      });
      const v2WriteAccepted = await __testOnlyUpdateStreamFactsCasWrite({
        baselineEventSeq: firstSeq,
        baselineFoldVersion: 2,
        connectorInstanceId: INSTANCE_ID,
        eventSeq: firstSeq + 1,
        factsJson: JSON.stringify({
          ...requireJsonRecord(oldFacts, "previous stream facts"),
          [EMPTY_STREAM]: {
            event_seq: firstSeq + 1,
            evidence_as_of: NOW,
            fact: { checkpoint: "committed", collected: 1, stream: EMPTY_STREAM },
            run_id: "run_evt_mixed_v2_empty_pg",
          },
        }),
        foldVersion: 2,
      });
      assert.equal(v2WriteAccepted, true, "premise: the realistic v2 delta wins before v4 owns the PostgreSQL row");
      __testOnlySetFoldPauseHook(null);
      releaseReplay?.();
      const firstRoute = await routePromise;
      const firstEvidence = await getConnectorSummaryEvidence(INSTANCE_ID);
      assert.equal(firstRoute?.terminal_facts.state, "current");
      const firstRouteEvidenceVersion = await postgresQuery(
        "SELECT stream_facts_fold_version FROM connector_summary_evidence WHERE connector_instance_id = $1",
        [INSTANCE_ID]
      );
      assert.equal(
        Number(
          firstRow(firstRouteEvidenceVersion.rows, "first-route PostgreSQL summary evidence exists")
            .stream_facts_fold_version
        ),
        4
      );
      // fix-pre-provenance-terminal-generation-semantics: the connection
      // has never advanced past generation 0, so BOTH the v2 delta's
      // EMPTY_STREAM fact AND the replayed unstamped `messages` event are
      // consumed.
      assert.deepEqual(Object.keys(firstEvidence.stream_latest_facts ?? {}).sort(), [EMPTY_STREAM, STREAM].sort());

      const firstProjection = {
        facts: firstEvidence.stream_latest_facts,
        reason: firstRoute?.terminal_facts.reason_code,
        state: firstRoute?.terminal_facts.state,
      };
      await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
      const rebuiltRoute = await getConnectorSummaryForRoute(INSTANCE_ID);
      assert.deepEqual(
        {
          facts: (await getConnectorSummaryEvidence(INSTANCE_ID)).stream_latest_facts,
          reason: rebuiltRoute?.terminal_facts.reason_code,
          state: rebuiltRoute?.terminal_facts.state,
        },
        firstProjection,
        "the first PostgreSQL route result equals delete/rebuild after the mixed-version race"
      );
      const laterV2WriteAccepted = await __testOnlyUpdateStreamFactsCasWrite({
        baselineEventSeq: firstSeq + 1,
        baselineFoldVersion: 2,
        connectorInstanceId: INSTANCE_ID,
        eventSeq: firstSeq + 1,
        factsJson: JSON.stringify(oldFacts),
        foldVersion: 2,
      });
      assert.equal(laterV2WriteAccepted, false, "v2 cannot overwrite the converged v4 PostgreSQL row");
    } finally {
      __testOnlySetFoldPauseHook(null);
    }
  } finally {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
    await closePostgresStorage();
  }
});
