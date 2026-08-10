// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  buildRecordVersionStatsEnvelope,
  classifyRecordVersionChurn,
  isVersionChurnCandidate,
  listRecordVersionGroundTruthForKeys,
  listRecordVersionGroundTruthStreams,
} from "../server/record-version-stats.ts";
import { ingestRecord } from "../server/records.ts";
import { rebuildRetainedSize } from "../server/retained-size-read-model.ts";
import {
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";
import { resetReviewedCompactionResidueCacheForTests } from "../server/version-disposition.ts";

// Real reviewed-at timestamp used by the tests below, matching the operator
// runtime-state fixture seeded via withReviewedCompactionResidueFixture. Not
// read from any committed file — ri-zero-knowledge-terminal-revise-0810
// moved this out of RI-committed JSON into operator runtime state, so these
// tests own their own fixture value instead of importing one.
const USAA_ACCOUNTS_REVIEWED_AT = "2026-06-05T13:57:05.707Z";
const USAA_STATEMENTS_REVIEWED_AT = "2026-06-05T13:57:05.707Z";
const CHASE_STATEMENTS_REVIEWED_AT = "2026-06-05T13:57:05.707Z";

// Seed a temp PDPP_COMPACTION_RESIDUE_REVIEW_PATH file with the operator
// reviewed-residue fixture these tests rely on, run `fn`, then restore the
// env var and reset version-disposition.ts's read-once cache. Mirrors the
// prior REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT import, but as real operator
// runtime state rather than an RI-committed constant.
async function withReviewedCompactionResidueFixture<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
  const dir = mkdtempSync(join(tmpdir(), "record-version-stats-residue-"));
  const filePath = join(dir, "review.json");
  writeFileSync(
    filePath,
    JSON.stringify({
      "chase/statements": {
        pendingRemediation: "content_fingerprint_pending",
        reviewedAt: CHASE_STATEMENTS_REVIEWED_AT,
      },
      "usaa/accounts": { pendingRemediation: "owner_migration_pending", reviewedAt: USAA_ACCOUNTS_REVIEWED_AT },
      "usaa/statements": { pendingRemediation: "content_fingerprint_pending", reviewedAt: USAA_STATEMENTS_REVIEWED_AT },
    })
  );
  process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH = filePath;
  resetReviewedCompactionResidueCacheForTests();
  try {
    return await fn();
  } finally {
    rmSync(dir, { force: true, recursive: true });
    if (previous === undefined) {
      delete process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
    } else {
      process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH = previous;
    }
    resetReviewedCompactionResidueCacheForTests();
  }
}

// Test-only manifest-backed compactionClass resolver: reads the REAL manifest
// JSON files from disk (the same static-file pattern connector-key.test.ts
// already uses), NOT the runtime DB-catalog getConnectorManifest production
// code path — this file never seeds the connectors table with github/slack/
// ynab/claude-code/codex/usaa/chase manifests, so injecting this resolver via
// buildRecordVersionStatsEnvelope's resolveConnectorManifest collaborator
// lets the disposition tests exercise the real compaction_class values those
// connectors' shipped manifests declare, without requiring a DB seed per
// connector under test.
//
// packages/polyfill-connectors/manifests/ is checked FIRST: it is the real
// first-party manifest source registerConnector()/polyfill-manifest-
// reconcile.ts registers into the DB catalog at runtime (see
// defaultPolyfillManifestsDir in polyfill-manifest-reconcile.ts), so it is
// the one production getConnectorManifest actually resolves for a real
// connection. reference-implementation/manifests/ is a SEPARATE, older
// "reference fixture" set used only by `pdpp seed`'s demo connectors
// (defaultReferenceFixturesDir) and must not shadow the real manifest here.
const MANIFEST_ROOTS_FOR_TEST = [
  fileURLToPath(new URL("../../packages/polyfill-connectors/manifests", import.meta.url)),
  fileURLToPath(new URL("../manifests", import.meta.url)),
];

// biome-ignore lint/suspicious/useAwait: localized test double preserves the real resolver's async contract.
async function manifestBackedCompactionClassResolver(connectorId: unknown): Promise<Record<string, unknown> | null> {
  if (typeof connectorId !== "string" || !connectorId) {
    return null;
  }
  for (const root of MANIFEST_ROOTS_FOR_TEST) {
    const candidatePath = join(root, `${connectorId.replace(/-/g, "_")}.json`);
    try {
      return JSON.parse(readFileSync(candidatePath, "utf8"));
    } catch {
      // Not this root / not this filename convention; try the next root.
    }
  }
  return null;
}

const CONNECTOR_ID = "https://test.pdpp.dev/connectors/version-churn";
const CONNECTOR_INSTANCE_ID = "cin_test_version_churn";
const NOW = "2026-05-26T12:00:00.000Z";

// A raw database row (column-keyed) crossing the untyped db.js/postgres
// boundary, matching the shape record-version-stats.ts's own internal `Row`
// uses for the same kind of value.
type Row = Record<string, unknown>;

// A `(connector_instance_id, stream)` candidate key, matching the shape of
// record-version-stats.ts's internal (non-exported) `StreamKey`.
interface StreamKey {
  connectorInstanceId: string;
  stream: string;
}

// Forces the legacy full-scan seam by disabling the bounded
// listGroundTruthForKeys helper. `null` (not omitted/undefined) is required:
// listGroundTruthForKeys is a JS default parameter, so an `undefined` value
// would trigger the default (the real bounded helper) instead of disabling
// it, whereas `null` defeats the callee's own
// `typeof listGroundTruthForKeys === "function"` check while bypassing the
// default. The real collaborators parameter type is internal to
// record-version-stats.ts and structurally excludes `null` on that field
// (exactOptionalPropertyTypes + no shared base with the real inferred
// signature block a direct cast, verified: neither a same-hop cast nor a
// widened local interface satisfies both constraints at once), so this
// narrow, single-purpose wrapper isolates the one JS-interop boundary that
// needs it, widening only its own parameter type rather than the shared
// `buildRecordVersionStatsEnvelope` symbol used everywhere else in this file.
// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
async function buildEnvelopeWithGroundTruthForKeysDisabled(): Promise<VersionStatsEnvelope> {
  const untyped = buildRecordVersionStatsEnvelope as (
    params: Record<string, unknown>,
    collaborators: Record<string, unknown>
  ) => Promise<VersionStatsEnvelope>;
  return untyped({}, { listGroundTruthForKeys: null });
}

// One row of the envelope's `data` array, as shaped by
// buildRecordVersionStatsEnvelope's per-row return object.
interface VersionStatsRow {
  connector_id: string | null;
  connector_instance_id: string;
  current_record_count: number;
  display_name: string | null;
  last_current_at: string | null;
  last_history_at: string | null;
  projection_authority: string;
  projection_dirty: boolean;
  projection_missing: boolean;
  record_history_count: number;
  record_key_count: number | null;
  risk_level: string;
  risk_reasons: string[];
  stream: string;
  version_disposition: string;
  version_remediation: string;
  versions_per_record: number;
}

// The full envelope shape returned by buildRecordVersionStatsEnvelope, and
// (byte-identically) served over HTTP by /_ref/records/version-stats.
interface VersionStatsEnvelope {
  data: VersionStatsRow[];
  meta: {
    returned: number;
    total_matching: number;
    has_more: boolean;
    limit: number;
    filters: { connector_instance_id: string | null; stream: string | null; risk: string | null };
    source: string;
    risk_thresholds: {
      watch_versions_per_record: number;
      high_versions_per_record: number;
      high_history_count: number;
      high_history_versions_per_record: number;
    };
    disposition_affects_thresholds: boolean;
    remediation_affects_thresholds: boolean;
  };
  object: string;
  projection: { computed_at: string | null; dirty: boolean; metadata: Row | null };
}

// startServer is imported from checkJs:false JS; TS's structural inference
// for app.listen()'s return widens asServer/rsServer to a type missing
// closeAllConnections (a real Node http.Server method the source's own
// shutdown path uses elsewhere -- opts here never requests TLS, so at
// runtime this is always a plain http.Server). Overriding just those two
// members on the real inferred return type (rather than a wholly separate
// interface) keeps enough structural overlap for a single-hop cast. Mirrors
// the established pattern in test/records-cursor-fallback.test.ts.
interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
};

function oneMillisecondAfter(iso: string): string {
  return new Date(new Date(iso).getTime() + 1).toISOString();
}

async function closeServer(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function fetchJson<T = Row>(url: string): Promise<{ status: number; body: T | null }> {
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await resp.text();
  return { body: text ? JSON.parse(text) : null, status: resp.status };
}

function seedConnector() {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(
      CONNECTOR_ID,
      JSON.stringify({
        connector_id: CONNECTOR_ID,
        display_name: "Version Churn Fixture",
        protocol_version: "0.1.0",
        streams: [{ name: "sessions", primary_key: ["id"] }],
      }),
      NOW
    );
}

async function seedConnection() {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    createdAt: NOW,
    displayName: "Version churn fixture",
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: true },
    sourceBindingKey: "fixture",
    sourceKind: "manual",
    updatedAt: NOW,
  });
}

function seedRetainedSizeProjection() {
  getDb()
    .prepare(
      `INSERT INTO retained_size_global(
         projection_key, current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count, dirty, computed_at, metadata_json
       ) VALUES ('global', 10, 20000, 0, 2, 20000, 0, 0, ?, ?)`
    )
    .run(NOW, JSON.stringify({ last_error: null, rebuild_status: "idle", stale_since: null, state: "fresh" }));
  getDb()
    .prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count, dirty, computed_at
       ) VALUES (?, ?, 'sessions', 10, 20000, 0, 2, 20000, 0, 0, ?)`
    )
    .run(CONNECTOR_INSTANCE_ID, CONNECTOR_ID, NOW);
}

test("record version churn classifier uses simple watch/high thresholds", () => {
  assert.deepEqual(classifyRecordVersionChurn({ currentRecordCount: 10, recordHistoryCount: 10 }), {
    riskLevel: "normal",
    riskReasons: [],
    versionsPerRecord: 1,
  });
  assert.deepEqual(classifyRecordVersionChurn({ currentRecordCount: 10, recordHistoryCount: 50 }), {
    riskLevel: "watch",
    riskReasons: ["versions_per_record_ge_5"],
    versionsPerRecord: 5,
  });
  assert.deepEqual(classifyRecordVersionChurn({ currentRecordCount: 2, recordHistoryCount: 20_000 }), {
    riskLevel: "high",
    riskReasons: ["versions_per_record_ge_50", "history_ge_10000_and_versions_per_record_ge_10"],
    versionsPerRecord: 10_000,
  });
  assert.deepEqual(
    classifyRecordVersionChurn({ currentRecordCount: 2, recordHistoryCount: 20_000, recordKeyCount: 100 }),
    {
      riskLevel: "high",
      riskReasons: ["versions_per_record_ge_50", "history_ge_10000_and_versions_per_record_ge_10"],
      versionsPerRecord: 200,
    }
  );
});

test("record version stats envelope returns grouped projection rows without payloads", async () => {
  const envelope = await buildRecordVersionStatsEnvelope(
    {
      risk: "high",
    },
    {
      connectorInstanceStore: null,
      getProjection: async () => ({ computed_at: NOW, dirty: false, metadata: { state: "fresh" } }),
      listGroundTruthForKeys: async () => [],
      listGroundTruthStreams: async () => [],
      listStreams: async () => [
        {
          computed_at: NOW,
          connector_id: CONNECTOR_ID,
          connector_instance_id: CONNECTOR_INSTANCE_ID,
          dirty: false,
          record_count: 2,
          record_history_count: 20_000,
          stream: "sessions",
        },
      ],
    }
  );

  assert.equal(envelope.object, "ref_record_version_stats");
  assert.equal(envelope.data.length, 1);
  const [row] = envelope.data;
  assert.ok(row);
  assert.equal(row.risk_level, "high");
  assert.equal(row.last_current_at, null);
  assert.equal(row.last_history_at, null);
  assert.equal(row.record_key_count, null);
  assert.equal(row.projection_authority, "retained_size_projection");
  assert.equal(row.projection_missing, false);
  assert.equal("record_json" in row, false);
  assert.equal("record_changes" in row, false);
});

test("scoped record version stats envelope surfaces ground-truth rows missing from the projection", async () => {
  let receivedScope: { connectorInstanceId?: string | undefined; stream?: string | undefined } | undefined;
  const envelope = await buildRecordVersionStatsEnvelope(
    {
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      stream: "messages",
    },
    {
      connectorInstanceStore: null,
      getProjection: async () => ({ computed_at: NOW, dirty: true, metadata: { state: "rebuilding" } }),
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      listGroundTruthStreams: async (scope) => {
        receivedScope = scope;
        return [
          {
            connector_id: CONNECTOR_ID,
            connector_instance_id: CONNECTOR_INSTANCE_ID,
            current_record_count: 2,
            last_current_at: NOW,
            last_history_at: NOW,
            record_history_count: 50,
            record_key_count: 10,
            stream: "messages",
          },
        ];
      },
      listStreams: async () => [],
    }
  );

  assert.deepEqual(receivedScope, { connectorInstanceId: CONNECTOR_INSTANCE_ID, stream: "messages" });
  assert.equal(envelope.data.length, 1);
  const [row] = envelope.data;
  assert.ok(row);
  assert.equal(row.stream, "messages");
  assert.equal(row.current_record_count, 2);
  assert.equal(row.record_history_count, 50);
  assert.equal(row.record_key_count, 10);
  assert.equal(row.versions_per_record, 5);
  assert.equal(row.projection_authority, "record_changes_ground_truth");
  assert.equal(row.projection_missing, true);
  assert.equal(row.projection_dirty, false);
  assert.equal(row.risk_level, "watch");
  assert.deepEqual(row.risk_reasons, ["versions_per_record_ge_5", "projection_missing"]);
});

test("scoped record version stats envelope keeps normal-range projection-missing rows normal", async () => {
  const envelope = await buildRecordVersionStatsEnvelope(
    {
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      stream: "reactions",
    },
    {
      connectorInstanceStore: null,
      getProjection: async () => ({ computed_at: NOW, dirty: true, metadata: { state: "rebuilding" } }),
      listGroundTruthStreams: async () => [
        {
          connector_id: CONNECTOR_ID,
          connector_instance_id: CONNECTOR_INSTANCE_ID,
          current_record_count: 100,
          last_current_at: NOW,
          last_history_at: NOW,
          record_history_count: 100,
          record_key_count: 100,
          stream: "reactions",
        },
      ],
      listStreams: async () => [],
    }
  );

  assert.equal(envelope.data.length, 1);
  const [row] = envelope.data;
  assert.ok(row);
  assert.equal(row.stream, "reactions");
  assert.equal(row.projection_missing, true);
  assert.equal(row.projection_authority, "record_changes_ground_truth");
  assert.equal(row.risk_level, "normal");
  assert.ok(row.risk_reasons.includes("projection_missing"));
});

test("record version stats envelope keeps normal-range projection-dirty rows normal", async () => {
  const envelope = await buildRecordVersionStatsEnvelope(
    {},
    {
      connectorInstanceStore: null,
      getProjection: async () => ({ computed_at: NOW, dirty: true, metadata: { state: "rebuilding" } }),
      listGroundTruthStreams: async () => [],
      listStreams: async () => [
        {
          computed_at: NOW,
          connector_id: CONNECTOR_ID,
          connector_instance_id: CONNECTOR_INSTANCE_ID,
          dirty: true,
          record_count: 100,
          record_history_count: 100,
          stream: "sessions",
        },
      ],
    }
  );

  assert.equal(envelope.data.length, 1);
  const [row] = envelope.data;
  assert.ok(row);
  assert.equal(row.stream, "sessions");
  assert.equal(row.projection_dirty, true);
  assert.equal(row.projection_missing, false);
  assert.equal(row.projection_authority, "retained_size_projection");
  assert.equal(row.risk_level, "normal");
  assert.ok(row.risk_reasons.includes("projection_dirty"));
});

test("record version stats risk filter excludes projection-only normal rows", async () => {
  const envelope = await buildRecordVersionStatsEnvelope(
    { risk: "watch" },
    {
      connectorInstanceStore: null,
      getProjection: async () => ({ computed_at: NOW, dirty: true, metadata: { state: "rebuilding" } }),
      listGroundTruthStreams: async () => [],
      listStreams: async () => [
        {
          computed_at: NOW,
          connector_id: CONNECTOR_ID,
          connector_instance_id: CONNECTOR_INSTANCE_ID,
          dirty: true,
          record_count: 100,
          record_history_count: 111,
          stream: "repositories",
        },
      ],
    }
  );

  assert.equal(envelope.data.length, 0);
  assert.equal(envelope.meta.total_matching, 0);
});

test("record version stats envelope keeps high risk when projection is also dirty", async () => {
  const envelope = await buildRecordVersionStatsEnvelope(
    {},
    {
      connectorInstanceStore: null,
      getProjection: async () => ({ computed_at: NOW, dirty: true, metadata: { state: "rebuilding" } }),
      listGroundTruthStreams: async () => [],
      listStreams: async () => [
        {
          computed_at: NOW,
          connector_id: CONNECTOR_ID,
          connector_instance_id: CONNECTOR_INSTANCE_ID,
          dirty: true,
          record_count: 2,
          record_history_count: 20_000,
          stream: "sessions",
        },
      ],
    }
  );

  assert.equal(envelope.data.length, 1);
  const [row] = envelope.data;
  assert.ok(row);
  assert.equal(row.risk_level, "high");
  assert.equal(row.projection_dirty, true);
  assert.ok(row.risk_reasons.includes("projection_dirty"));
});

test("record version stats envelope prefers ground-truth counts over stale projection counts", async () => {
  const envelope = await buildRecordVersionStatsEnvelope(
    {},
    {
      connectorInstanceStore: null,
      getProjection: async () => ({ computed_at: NOW, dirty: false, metadata: { state: "fresh" } }),
      listGroundTruthForKeys: async () => [
        {
          connector_id: CONNECTOR_ID,
          connector_instance_id: CONNECTOR_INSTANCE_ID,
          current_record_count: 9,
          last_current_at: NOW,
          last_history_at: NOW,
          record_history_count: 3_155_820,
          record_key_count: 12_334,
          stream: "threads",
        },
      ],
      listStreams: async () => [
        {
          computed_at: NOW,
          connector_id: CONNECTOR_ID,
          connector_instance_id: CONNECTOR_INSTANCE_ID,
          dirty: false,
          record_count: 9,
          record_history_count: 468_532,
          stream: "threads",
        },
      ],
    }
  );

  assert.equal(envelope.data.length, 1);
  const [row] = envelope.data;
  assert.ok(row);
  assert.equal(row.record_history_count, 3_155_820);
  assert.equal(row.record_key_count, 12_334);
  assert.equal(row.versions_per_record, 255.863);
  assert.equal(row.projection_authority, "record_changes_ground_truth");
  assert.equal(row.projection_missing, false);
});

// ─── version_disposition derivation (OpenSpec add-version-disposition-…) ─────

// A projection-shaped stream row, matching the shape `listRetainedSizeStreams`
// (and the test doubles standing in for it) produce.
interface ProjectionStreamRow {
  computed_at: string;
  connector_id: string;
  connector_instance_id: string;
  dirty: boolean;
  record_count: number;
  record_history_count: number;
  stream: string;
}

// A ground-truth-shaped row, matching `shapeGroundTruthRow`'s output in
// record-version-stats.ts.
interface GroundTruthRow {
  connector_id: string;
  connector_instance_id: string;
  current_record_count: number;
  last_current_at: string;
  last_history_at: string;
  record_history_count: number;
  record_key_count: number;
  stream: string;
}

function dispositionRow(overrides: Partial<ProjectionStreamRow> = {}): ProjectionStreamRow {
  return {
    computed_at: NOW,
    connector_id: overrides.connector_id ?? "github",
    connector_instance_id: overrides.connector_instance_id ?? "cin_disp",
    dirty: false,
    record_count: overrides.record_count ?? 2,
    record_history_count: overrides.record_history_count ?? 20_000,
    stream: overrides.stream ?? "user",
  };
}

// Inject BOTH ground-truth seams so the unfiltered candidate path (which calls
// listGroundTruthForKeys, not listGroundTruthStreams) is driven by the test
// doubles rather than the real DB. The for-keys double returns the same rows
// filtered to the requested candidate keys, exactly as the bounded helper does.
function groundTruthForKeysFromRows(groundTruthRows: GroundTruthRow[]) {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  return async ({ keys }: { keys?: StreamKey[] } = {}): Promise<GroundTruthRow[]> => {
    const wanted = new Set((keys || []).map((k) => `${k.connectorInstanceId}\n${k.stream}`));
    return groundTruthRows.filter((row) => wanted.has(`${row.connector_instance_id}\n${row.stream}`));
  };
}

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
async function envelopeFor(
  streamRows: ProjectionStreamRow[],
  groundTruthRows: GroundTruthRow[] = []
): Promise<VersionStatsEnvelope> {
  return buildRecordVersionStatsEnvelope(
    {},
    {
      connectorInstanceStore: null,
      getProjection: async () => ({ computed_at: NOW, dirty: false, metadata: { state: "fresh" } }),
      listGroundTruthForKeys: groundTruthForKeysFromRows(groundTruthRows),
      listGroundTruthStreams: async () => groundTruthRows,
      listStreams: async () => streamRows,
      resolveConnectorManifest: manifestBackedCompactionClassResolver,
    }
  ) as Promise<VersionStatsEnvelope>;
}

test("AC-1: every version-stats row carries a version_disposition enum value", async () => {
  const envelope = await envelopeFor([
    dispositionRow({ connector_id: "github", connector_instance_id: "cin_gh", stream: "user" }),
    dispositionRow({ connector_id: "gmail", connector_instance_id: "cin_gm", stream: "labels" }),
    dispositionRow({ connector_id: "mystery", connector_instance_id: "cin_my", stream: "widgets" }),
  ]);
  const allowed = new Set([
    "active_defect_or_unclassified",
    "reviewed_historical_residue",
    "point_in_time_retained_history",
    "lossless_compaction_candidate",
    "recurring_point_in_time_snapshot",
  ]);
  assert.equal(envelope.data.length, 3);
  for (const row of envelope.data) {
    assert.ok("version_disposition" in row, "each row must carry version_disposition");
    assert.ok(allowed.has(row.version_disposition), `unexpected disposition ${row.version_disposition}`);
  }
  // No payloads leak alongside the new field.
  for (const row of envelope.data) {
    assert.equal("record_json" in row, false);
    assert.equal("record_changes" in row, false);
  }
});

test("AC-2: disposition does not change risk_thresholds and the meta asserts independence", async () => {
  const envelope = await envelopeFor([dispositionRow()]);
  // Byte-identical thresholds to the documented contract.
  assert.deepEqual(envelope.meta.risk_thresholds, {
    high_history_count: 10_000,
    high_history_versions_per_record: 10,
    high_versions_per_record: 50,
    watch_versions_per_record: 5,
  });
  assert.equal(envelope.meta.disposition_affects_thresholds, false);
  // risk_level/risk_reasons computed exactly as the numeric classifier would,
  // independent of the derived disposition.
  const [row] = envelope.data;
  assert.ok(row);
  const numeric = classifyRecordVersionChurn({ currentRecordCount: 2, recordHistoryCount: 20_000 });
  assert.equal(row.risk_level, numeric.riskLevel);
  assert.deepEqual(row.risk_reasons, numeric.riskReasons);
});

test("AC-3: an unknown high/watch stream classifies active_defect_or_unclassified", async () => {
  const envelope = await envelopeFor([dispositionRow({ connector_id: "mystery", stream: "widgets" })]);
  const [row] = envelope.data;
  assert.ok(row);
  assert.equal(row.version_disposition, "active_defect_or_unclassified");
});

// Projection row mirroring a ground-truth row, so the unfiltered candidate path
// scans the stream (vpr-from-current >= watch → candidate) and the ground-truth
// last_history_at drives the disposition. Models the realistic production state:
// the stream HAS a projection row; ground truth refines its distinct/timestamp
// facts.
function projectionRowFor(gt: GroundTruthRow): ProjectionStreamRow {
  return {
    computed_at: NOW,
    connector_id: gt.connector_id,
    connector_instance_id: gt.connector_instance_id,
    dirty: false,
    record_count: gt.current_record_count,
    record_history_count: gt.record_history_count,
    stream: gt.stream,
  };
}

test("AC-4: reviewed residue re-alarms to lossless_compaction_candidate after the review timestamp", async () => {
  await withReviewedCompactionResidueFixture(async () => {
    const reviewedAt = USAA_ACCOUNTS_REVIEWED_AT;
    // Within window → reviewed_historical_residue.
    const withinGt = {
      connector_id: "usaa",
      connector_instance_id: "cin_usaa",
      current_record_count: 4,
      last_current_at: NOW,
      last_history_at: reviewedAt,
      record_history_count: 80,
      record_key_count: 4,
      stream: "accounts",
    };
    const within = await envelopeFor([projectionRowFor(withinGt)], [withinGt]);
    const [withinRow] = within.data;
    assert.ok(withinRow);
    assert.equal(withinRow.version_disposition, "reviewed_historical_residue");

    // After window → re-alarm.
    const afterGt = {
      connector_id: "usaa",
      connector_instance_id: "cin_usaa",
      current_record_count: 4,
      last_current_at: NOW,
      last_history_at: oneMillisecondAfter(reviewedAt),
      record_history_count: 80,
      record_key_count: 4,
      stream: "accounts",
    };
    const after = await envelopeFor([projectionRowFor(afterGt)], [afterGt]);
    const [afterRow] = after.data;
    assert.ok(afterRow);
    assert.equal(afterRow.version_disposition, "lossless_compaction_candidate");
  });
});

test("AC-5: sessions classify recurring_point_in_time_snapshot and do not re-alarm on growth", async () => {
  for (const connector_id of ["claude-code", "codex", "local-device:claude-code"]) {
    const gt: GroundTruthRow = {
      connector_id,
      connector_instance_id: "cin_sessions",
      current_record_count: 60,
      last_current_at: NOW,
      // Far in the future relative to any prior review timestamp.
      last_history_at: "2027-01-01T00:00:00.000Z",
      record_history_count: 600,
      record_key_count: 60,
      stream: "sessions",
    };
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    const grown = await envelopeFor([projectionRowFor(gt)], [gt]);
    const [row] = grown.data;
    assert.ok(row);
    assert.equal(
      row.version_disposition,
      "recurring_point_in_time_snapshot",
      `${connector_id}/sessions must stay #5 even after history grows`
    );
  }
});

test("AC-6: split residual entity streams classify point_in_time_retained_history (no compaction offered)", async () => {
  const pointInTimeStreams: [string, string][] = [
    ["github", "user"],
    ["slack", "channels"],
    ["ynab", "accounts"],
  ];
  for (const [connector_id, stream] of pointInTimeStreams) {
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    const envelope = await envelopeFor([
      dispositionRow({ connector_id, connector_instance_id: `cin_${connector_id}`, stream }),
    ]);
    const [row] = envelope.data;
    assert.ok(row);
    assert.equal(
      row.version_disposition,
      "point_in_time_retained_history",
      `${connector_id}/${stream} must be point_in_time_retained_history`
    );
  }
});

test("AC-7: a connector-authored field in the source row cannot alter version_disposition", async () => {
  // The stream row carries a hostile self-declared disposition; the server must
  // ignore it and derive from reference signals only (unknown stream → #1).
  // The extra `version_disposition`/`semantics` fields model connector-authored
  // input the source must disregard, hence the widened row type here.
  const hostileRow: ProjectionStreamRow & Record<string, unknown> = {
    ...dispositionRow({ connector_id: "mystery", stream: "widgets" }),
    semantics: "append",
    version_disposition: "point_in_time_retained_history",
  };
  const envelope = await envelopeFor([hostileRow]);
  const [row] = envelope.data;
  assert.ok(row);
  assert.equal(row.version_disposition, "active_defect_or_unclassified");
});

// ─── version_remediation derivation (OpenSpec add-version-remediation-…) ──────
//
// The envelope-level companions to the pure-classifier tests in
// version-disposition.test.ts. They prove buildRecordVersionStatsEnvelope wires
// the orthogonal remediation onto every row, keeps it consistent with the
// disposition, and never lets it touch the numeric risk path.

// A reviewed-residue ground-truth row for `connector/stream`: its last_history_at
// sits at the fixture's reviewed-at timestamp (see withReviewedCompactionResidueFixture)
// so the disposition resolves to reviewed_historical_residue (the precondition
// for the statement/accounts remediations). Only valid for the three
// connector/stream pairs the fixture seeds.
const REVIEWED_RESIDUE_FIXTURE_TIMESTAMPS: Record<string, string> = {
  "chase/statements": CHASE_STATEMENTS_REVIEWED_AT,
  "usaa/accounts": USAA_ACCOUNTS_REVIEWED_AT,
  "usaa/statements": USAA_STATEMENTS_REVIEWED_AT,
};

function reviewedResidueGt(connector_id: string, stream: string): GroundTruthRow {
  const reviewedAt = REVIEWED_RESIDUE_FIXTURE_TIMESTAMPS[`${connector_id}/${stream}`];
  assert.ok(reviewedAt, `expected a reviewed-at fixture entry for ${connector_id}/${stream}`);
  return {
    connector_id,
    connector_instance_id: `cin_${connector_id}_${stream}`,
    current_record_count: 4,
    last_current_at: NOW,
    last_history_at: reviewedAt,
    record_history_count: 80,
    record_key_count: 4,
    stream,
  };
}

test("AC-1(remediation): every version-stats row carries a version_remediation enum value", async () => {
  const envelope = await envelopeFor([
    dispositionRow({ connector_id: "github", connector_instance_id: "cin_gh", stream: "user" }),
    dispositionRow({ connector_id: "gmail", connector_instance_id: "cin_gm", stream: "labels" }),
    dispositionRow({ connector_id: "mystery", connector_instance_id: "cin_my", stream: "widgets" }),
  ]);
  const allowed = new Set(["none", "content_fingerprint_pending", "owner_migration_pending", "owner_retention_policy"]);
  assert.equal(envelope.data.length, 3);
  for (const row of envelope.data) {
    assert.ok("version_remediation" in row, "each row must carry version_remediation");
    assert.ok(allowed.has(row.version_remediation), `unexpected remediation ${row.version_remediation}`);
  }
});

test("AC-2(remediation): the meta asserts remediation does not affect thresholds", async () => {
  const envelope = await envelopeFor([dispositionRow()]);
  assert.equal(envelope.meta.remediation_affects_thresholds, false);
  // Disposition assertion and thresholds remain byte-identical — remediation is
  // strictly additive and never disturbs the existing numeric contract.
  assert.equal(envelope.meta.disposition_affects_thresholds, false);
  assert.deepEqual(envelope.meta.risk_thresholds, {
    high_history_count: 10_000,
    high_history_versions_per_record: 10,
    high_versions_per_record: 50,
    watch_versions_per_record: 5,
  });
});

test("AC-2(remediation): adding remediation leaves risk_level/risk_reasons/version_disposition unchanged", async () => {
  // Same fixture as the disposition AC-2: the numeric path and the disposition
  // are computed exactly as they were before remediation existed.
  const envelope = await envelopeFor([dispositionRow()]);
  const [row] = envelope.data;
  assert.ok(row);
  const numeric = classifyRecordVersionChurn({ currentRecordCount: 2, recordHistoryCount: 20_000 });
  assert.equal(row.risk_level, numeric.riskLevel);
  assert.deepEqual(row.risk_reasons, numeric.riskReasons);
  // github/user is a point-in-time split residual → disposition unchanged, and
  // it is on no remediation list → remediation none.
  assert.equal(row.version_disposition, "point_in_time_retained_history");
  assert.equal(row.version_remediation, "none");
});

test("AC-3(remediation): chase/statements and usaa/statements are content_fingerprint_pending", async () => {
  await withReviewedCompactionResidueFixture(async () => {
    for (const connector_id of ["chase", "usaa"]) {
      const gt = reviewedResidueGt(connector_id, "statements");
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const envelope = await envelopeFor([projectionRowFor(gt)], [gt]);
      const [row] = envelope.data;
      assert.ok(row);
      assert.equal(row.version_disposition, "reviewed_historical_residue");
      assert.equal(
        row.version_remediation,
        "content_fingerprint_pending",
        `${connector_id}/statements must be content_fingerprint_pending`
      );
    }
  });
});

test("AC-4(remediation): usaa/accounts is owner_migration_pending, distinct from the statement rows", async () => {
  await withReviewedCompactionResidueFixture(async () => {
    const accountsGt = reviewedResidueGt("usaa", "accounts");
    const accountsEnv = await envelopeFor([projectionRowFor(accountsGt)], [accountsGt]);
    const [accountsRow] = accountsEnv.data;
    assert.ok(accountsRow);
    assert.equal(accountsRow.version_disposition, "reviewed_historical_residue");
    assert.equal(accountsRow.version_remediation, "owner_migration_pending");

    // Same disposition as the statement rows, different remediation — the row is
    // distinguishable from a fingerprint-pending residue row.
    const statementsGt = reviewedResidueGt("usaa", "statements");
    const statementsEnv = await envelopeFor([projectionRowFor(statementsGt)], [statementsGt]);
    const [statementsRow] = statementsEnv.data;
    assert.ok(statementsRow);
    assert.equal(statementsRow.version_disposition, accountsRow.version_disposition);
    assert.notEqual(statementsRow.version_remediation, accountsRow.version_remediation);
  });
});

test("AC-5(remediation): claude-code/codex sessions are owner_retention_policy", async () => {
  for (const connector_id of ["claude-code", "codex", "local-device:claude-code"]) {
    const gt: GroundTruthRow = {
      connector_id,
      connector_instance_id: "cin_sessions",
      current_record_count: 60,
      last_current_at: NOW,
      last_history_at: "2027-01-01T00:00:00.000Z",
      record_history_count: 600,
      record_key_count: 60,
      stream: "sessions",
    };
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    const envelope = await envelopeFor([projectionRowFor(gt)], [gt]);
    const [row] = envelope.data;
    assert.ok(row);
    assert.equal(row.version_disposition, "recurring_point_in_time_snapshot");
    assert.equal(
      row.version_remediation,
      "owner_retention_policy",
      `${connector_id}/sessions must be owner_retention_policy`
    );
    // The retention-policy row is expected recurring history — its disposition
    // is NOT active_defect_or_unclassified, so it does not count as needs-review.
    assert.notEqual(row.version_disposition, "active_defect_or_unclassified");
  }
});

test("AC-6(remediation): candidate / unlisted point-in-time / defect rows are remediation none", async () => {
  // lossless_compaction_candidate: a policied stream not on any remediation list.
  const candidate = await envelopeFor([dispositionRow({ connector_id: "gmail", stream: "labels" })]);
  const [candidateRow] = candidate.data;
  assert.ok(candidateRow);
  assert.equal(candidateRow.version_disposition, "lossless_compaction_candidate");
  assert.equal(candidateRow.version_remediation, "none");

  // point_in_time_retained_history not on the migration list.
  const pointInTime = await envelopeFor([dispositionRow({ connector_id: "slack", stream: "channels" })]);
  const [pointInTimeRow] = pointInTime.data;
  assert.ok(pointInTimeRow);
  assert.equal(pointInTimeRow.version_disposition, "point_in_time_retained_history");
  assert.equal(pointInTimeRow.version_remediation, "none");

  // active_defect_or_unclassified.
  const defect = await envelopeFor([dispositionRow({ connector_id: "mystery", stream: "widgets" })]);
  const [defectRow] = defect.data;
  assert.ok(defectRow);
  assert.equal(defectRow.version_disposition, "active_defect_or_unclassified");
  assert.equal(defectRow.version_remediation, "none");
});

test("AC-7(remediation): a connector-authored field in the source row cannot alter version_remediation", async () => {
  // The hostile row both self-declares a remediation AND sits on no list. The
  // server ignores the declared value and derives none from the disposition.
  // The extra `version_remediation`/`remediation` fields model connector-
  // authored input the source must disregard, hence the widened row type here.
  const hostileRow: ProjectionStreamRow & Record<string, unknown> = {
    ...dispositionRow({ connector_id: "mystery", stream: "widgets" }),
    remediation: "content_fingerprint_pending",
    version_remediation: "owner_retention_policy",
  };
  const envelope = await envelopeFor([hostileRow]);
  const [row] = envelope.data;
  assert.ok(row);
  assert.equal(row.version_remediation, "none");
});

test("AC-8(remediation): owner_retention_policy rows always have the recurring-snapshot disposition", async () => {
  await withReviewedCompactionResidueFixture(async () => {
    // Scan a mixed fixture: every row that comes back owner_retention_policy must
    // also be recurring_point_in_time_snapshot, and no row gets a remediation that
    // contradicts its disposition.
    const sessionsGt: GroundTruthRow = {
      connector_id: "claude-code",
      connector_instance_id: "cin_sessions",
      current_record_count: 60,
      last_current_at: NOW,
      last_history_at: "2027-01-01T00:00:00.000Z",
      record_history_count: 600,
      record_key_count: 60,
      stream: "sessions",
    };
    const statementsGt = reviewedResidueGt("chase", "statements");
    const accountsGt = reviewedResidueGt("usaa", "accounts");
    const envelope = await envelopeFor(
      [
        projectionRowFor(sessionsGt),
        projectionRowFor(statementsGt),
        projectionRowFor(accountsGt),
        dispositionRow({ connector_id: "mystery", connector_instance_id: "cin_my", stream: "widgets" }),
      ],
      [sessionsGt, statementsGt, accountsGt]
    );
    for (const row of envelope.data) {
      if (row.version_remediation === "owner_retention_policy") {
        assert.equal(row.version_disposition, "recurring_point_in_time_snapshot");
      }
      if (
        row.version_disposition === "active_defect_or_unclassified" ||
        row.version_disposition === "lossless_compaction_candidate"
      ) {
        assert.equal(row.version_remediation, "none");
      }
    }
  });
});

test("/_ref/records/version-stats reads projection-backed high-churn rows", async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  try {
    seedConnector();
    await seedConnection();
    seedRetainedSizeProjection();

    const { status, body } = await fetchJson<VersionStatsEnvelope>(
      `http://localhost:${server.asPort}/_ref/records/version-stats?risk=high&limit=1`
    );

    assert.equal(status, 200);
    assert.ok(body);
    assert.equal(body.object, "ref_record_version_stats");
    assert.equal(body.meta.source, "retained_size_projection_with_record_changes_ground_truth");
    assert.equal(body.meta.returned, 1);
    const [row] = body.data;
    assert.ok(row);
    assert.equal(row.connector_instance_id, CONNECTOR_INSTANCE_ID);
    assert.equal(row.display_name, "Version churn fixture");
    assert.equal(row.stream, "sessions");
    assert.equal(row.risk_level, "high");
    assert.equal(row.current_record_count, 2);
    assert.equal(row.record_history_count, 20_000);
  } finally {
    await closeServer(server);
  }
});

// ─── projection-backed hot path (serve-version-stats-from-projection) ─────────
//
// These tests use a REAL in-memory DB and real ingest so the candidate-narrowing
// path is exercised end-to-end against canonical state, then assert it produces
// the SAME rows the unbounded full scan would.

const GT_CONNECTOR = "https://test.pdpp.dev/connectors/vstats-hotpath";
const GT_INSTANCE = makeDefaultAccountConnectorInstanceId("owner_local", GT_CONNECTOR);

function ingestUpsert(stream: string, id: string, payload: Record<string, unknown>, emittedAt: string) {
  return ingestRecord(GT_CONNECTOR, {
    data: { id, ...payload },
    emitted_at: emittedAt,
    key: id,
    op: "upsert",
    stream,
  });
}

// Build a corpus with a deliberate spread of churn shapes:
//   - high-churn stream `hot`: 1 key, many versions (vpr huge → candidate)
//   - normal stream `cold`: many keys, 1 version each (vpr 1 → NOT a candidate)
async function seedHotpathCorpus() {
  // hot: one key churned 30 times → 30 history versions, 1 current, 1 distinct key.
  for (let v = 1; v <= 30; v += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await ingestUpsert("hot", "h1", { v }, `2026-05-01T00:00:${String(v).padStart(2, "0")}.000Z`);
  }
  // cold: 12 distinct keys, one version each → 12 history, 12 current, vpr 1.
  for (let i = 0; i < 12; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await ingestUpsert("cold", `c${i}`, { i }, `2026-05-02T00:00:${String(i).padStart(2, "0")}.000Z`);
  }
  await rebuildRetainedSize();
}

function streamRow<T extends { stream: string }>(rows: T[], stream: string): T | undefined {
  return rows.find((r) => r.stream === stream);
}

// Raw column-shaped read of a single `retained_size_stream` row, used only by
// the plain SQL SELECT below (record-version-stats.ts's own `shapeGroundTruthRow`
// covers the ORM-level ground-truth reads elsewhere in this file).
interface RetainedSizeStreamProjectionRow {
  dirty: number;
  record_count: number;
  record_history_count: number;
}

test("projection record_history_count is exact and clean after ingest+rebuild", async () => {
  initDb();
  try {
    await seedHotpathCorpus();
    // Ground truth straight from record_changes.
    const gt = await listRecordVersionGroundTruthStreams({});
    const hotGt = streamRow(gt, "hot");
    assert.ok(hotGt);
    assert.equal(hotGt.record_history_count, 30);
    assert.equal(hotGt.record_key_count, 1);
    assert.equal(hotGt.current_record_count, 1);

    // Projection row for the same stream matches and is clean.
    const proj = getDb()
      .prepare(
        `SELECT record_history_count, record_count, dirty
           FROM retained_size_stream
          WHERE connector_instance_id = ? AND stream = 'hot'`
      )
      .get(GT_INSTANCE) as RetainedSizeStreamProjectionRow | undefined;
    assert.ok(proj);
    assert.equal(Number(proj.record_history_count), 30, "projection history count is exact");
    assert.equal(Number(proj.record_count), 1, "projection current count is exact");
    assert.equal(Number(proj.dirty), 0, "clean projection row carries dirty = 0");
  } finally {
    closeDb();
  }
});

test("candidate predicate selects hot churn and rejects flat streams", () => {
  // hot: 30 history / 1 current → candidate.
  assert.equal(isVersionChurnCandidate({ currentRecordCount: 1, dirty: false, recordHistoryCount: 30 }), true);
  // cold: 12 history / 12 current → vpr 1 → NOT a candidate.
  assert.equal(isVersionChurnCandidate({ currentRecordCount: 12, dirty: false, recordHistoryCount: 12 }), false);
  // Dirty rows remain projection-backed on the unfiltered dashboard advisory;
  // exact verification is available through scoped diagnostics.
  assert.equal(isVersionChurnCandidate({ currentRecordCount: 12, dirty: true, recordHistoryCount: 12 }), false);
  // Large flat streams with history >= 10k are NOT candidates when the
  // projection proves history/current is below the watch lower bound. The
  // high-history classifier arm also requires vpr >= 10, so the watch bound
  // safely covers it.
  assert.equal(isVersionChurnCandidate({ currentRecordCount: 9000, dirty: false, recordHistoryCount: 10_000 }), false);
  // High-history + high-ratio streams remain candidates.
  assert.equal(isVersionChurnCandidate({ currentRecordCount: 1000, dirty: false, recordHistoryCount: 10_000 }), true);
  // current == 0 with history → candidate (history_without_current_records).
  assert.equal(isVersionChurnCandidate({ currentRecordCount: 0, dirty: false, recordHistoryCount: 3 }), true);
});

test("bounded for-keys helper returns facts identical to the full scan", async () => {
  initDb();
  try {
    await seedHotpathCorpus();
    const full = await listRecordVersionGroundTruthStreams({});
    const fullHot = streamRow(full, "hot");
    const bounded = await listRecordVersionGroundTruthForKeys({
      keys: [{ connectorInstanceId: GT_INSTANCE, stream: "hot" }],
    });
    assert.equal(bounded.length, 1, "bounded helper returns only the requested key");
    assert.deepEqual(bounded[0], fullHot, "bounded facts byte-identical to full-scan facts");
  } finally {
    closeDb();
  }
});

test("unfiltered envelope candidate path equals the full-scan envelope", async () => {
  initDb();
  try {
    await seedHotpathCorpus();
    // Candidate path (production default): listGroundTruthForKeys is the bounded
    // helper; the clean global projection enables narrowing.
    const candidate = await buildRecordVersionStatsEnvelope({});
    // Force the legacy full-scan seam by disabling the bounded helper. This is a
    // test-only comparison; production unfiltered reads keep the bounded path
    // even when the global projection is dirty.
    const fullScan = await buildEnvelopeWithGroundTruthForKeysDisabled();

    // Both surface the hot stream with identical ground-truth facts.
    const candHot = streamRow(candidate.data, "hot");
    const fullHot = streamRow(fullScan.data, "hot");
    assert.ok(candHot, "candidate path surfaces the hot stream");
    assert.ok(fullHot, "full-scan path surfaces the hot stream");
    assert.deepEqual(
      {
        last_history_at: candHot.last_history_at,
        projection_authority: candHot.projection_authority,
        record_history_count: candHot.record_history_count,
        record_key_count: candHot.record_key_count,
        risk_level: candHot.risk_level,
        risk_reasons: candHot.risk_reasons,
        version_disposition: candHot.version_disposition,
        versions_per_record: candHot.versions_per_record,
      },
      {
        last_history_at: fullHot.last_history_at,
        projection_authority: fullHot.projection_authority,
        record_history_count: fullHot.record_history_count,
        record_key_count: fullHot.record_key_count,
        risk_level: fullHot.risk_level,
        risk_reasons: fullHot.risk_reasons,
        version_disposition: fullHot.version_disposition,
        versions_per_record: fullHot.versions_per_record,
      },
      "candidate-path hot row is identical to the full-scan hot row"
    );
    // The hot stream is high churn under both paths.
    assert.equal(candHot.record_history_count, 30);
    assert.equal(candHot.record_key_count, 1);
    assert.equal(candHot.versions_per_record, 30);

    // The cold (normal) stream is classified WITHOUT a ground-truth scan on the
    // candidate path: it keeps projection authority and null distinct/timestamp.
    const candCold = streamRow(candidate.data, "cold");
    assert.ok(candCold, "candidate path still lists the cold stream from the projection");
    assert.equal(candCold.risk_level, "normal");
    assert.equal(candCold.projection_authority, "retained_size_projection");
    assert.equal(candCold.record_key_count, null);
    assert.equal(candCold.last_history_at, null);
  } finally {
    closeDb();
  }
});

test("a dirty projection row stays bounded and advisory on the unfiltered route", async () => {
  initDb();
  try {
    await seedHotpathCorpus();
    // Corrupt the hot projection row to look NORMAL (history == current) but mark
    // it dirty. The unfiltered owner-dashboard route must not turn that dirty
    // bit into a whole-history scan; it surfaces the dirty advisory and leaves
    // exact verification to scoped diagnostics.
    getDb()
      .prepare(
        `UPDATE retained_size_stream
            SET record_history_count = 1, record_count = 1, dirty = 1
          WHERE connector_instance_id = ? AND stream = 'hot'`
      )
      .run(GT_INSTANCE);

    const envelope = await buildRecordVersionStatsEnvelope({});
    const hot = streamRow(envelope.data, "hot");
    assert.ok(hot, "dirty hot row is still surfaced");
    assert.equal(hot.record_history_count, 1, "unfiltered default uses the dirty projection facts");
    assert.equal(hot.record_key_count, null);
    assert.equal(hot.projection_authority, "retained_size_projection");
    assert.equal(hot.projection_dirty, true);
    assert.equal(hot.risk_level, "normal");
  } finally {
    closeDb();
  }
});

test("dirty global projection keeps the unfiltered request bounded", async () => {
  initDb();
  try {
    await seedHotpathCorpus();
    // Mark the global row dirty: the candidate path still handles the default
    // advisory. A dirty/rebuilding global projection is reported in metadata,
    // not repaired synchronously by a whole-history aggregate.
    getDb().prepare(`UPDATE retained_size_global SET dirty = 1 WHERE projection_key = 'global'`).run();

    let forKeysCalled = false;
    let fullScanCalled = false;
    const envelope = await buildRecordVersionStatsEnvelope(
      {},
      {
        // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
        listGroundTruthForKeys: async ({ keys }: { keys?: StreamKey[] } = {}) => {
          forKeysCalled = true;
          return listRecordVersionGroundTruthForKeys(keys ? { keys } : {});
        },
        // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
        listGroundTruthStreams: async () => {
          fullScanCalled = true;
          return [];
        },
      }
    );
    assert.equal(fullScanCalled, false, "dirty global must not force the unbounded full-scan helper");
    assert.equal(forKeysCalled, true, "clean hot candidates still use the bounded for-keys helper");
    const hot = streamRow(envelope.data, "hot");
    assert.ok(hot);
    assert.equal(hot.record_history_count, 30, "bounded candidate scan still produces correct hot facts");
    assert.equal(hot.projection_authority, "record_changes_ground_truth");
    assert.equal(envelope.projection.dirty, true);
  } finally {
    closeDb();
  }
});

// ─── Postgres ground-truth parity (gated on PDPP_TEST_POSTGRES_URL) ───────────
//
// Drives the REAL exported listRecordVersionGroundTruthStreams /
// listRecordVersionGroundTruthForKeys in Postgres mode against a seeded
// records + record_changes corpus, asserting the same shaped ground-truth facts
// the SQLite full-scan path produces. The two functions are the only seams in
// record-version-stats.js that branch on isPostgresStorageBackend(); this
// harness pins their Postgres dialect path so the seam migration is
// behavior-preserving on BOTH backends.

const PG_GT_CONNECTOR = "https://test.pdpp.dev/connectors/vstats-pg";
const PG_GT_INSTANCE = "cin_vstats_pg";

async function cleanupGroundTruthPostgres() {
  await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = $1", [PG_GT_INSTANCE]);
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [PG_GT_INSTANCE]);
}

async function insertRecordChangePostgres(stream: string, recordKey: string, version: number, emittedAt: string) {
  await postgresQuery(
    `INSERT INTO record_changes(
       connector_id, connector_instance_id, stream, record_key, version,
       record_json, emitted_at, deleted, deleted_at
     )
     VALUES($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE, NULL)`,
    [
      PG_GT_CONNECTOR,
      PG_GT_INSTANCE,
      stream,
      recordKey,
      version,
      JSON.stringify({ id: recordKey, v: version }),
      emittedAt,
    ]
  );
}

async function upsertCurrentRecordPostgres(stream: string, recordKey: string, version: number, emittedAt: string) {
  await postgresQuery(
    `INSERT INTO records(
       connector_id, connector_instance_id, stream, record_key, record_json,
       emitted_at, version, deleted, deleted_at, primary_key_text
     )
     VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, NULL, $4)
     ON CONFLICT (connector_instance_id, stream, record_key) DO UPDATE SET
       record_json = EXCLUDED.record_json,
       emitted_at = EXCLUDED.emitted_at,
       version = EXCLUDED.version`,
    [
      PG_GT_CONNECTOR,
      PG_GT_INSTANCE,
      stream,
      recordKey,
      JSON.stringify({ id: recordKey, v: version }),
      emittedAt,
      version,
    ]
  );
}

// Mirror the SQLite seedHotpathCorpus shape directly into the Postgres
// records + record_changes tables (the two tables the ground-truth functions
// read), so the asserted facts are the byte-for-byte Postgres analogue of the
// SQLite full-scan facts:
//   - hot:  one key churned 30 times -> 30 history rows, 1 current row, 1 key
//   - cold: 12 distinct keys, 1 version each -> 12 history, 12 current, vpr 1
async function seedGroundTruthCorpusPostgres() {
  for (let v = 1; v <= 30; v += 1) {
    const emittedAt = `2026-05-01T00:00:${String(v).padStart(2, "0")}.000Z`;
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await insertRecordChangePostgres("hot", "h1", v, emittedAt);
    // The current record is the latest version only (upsert overwrites).
    await upsertCurrentRecordPostgres("hot", "h1", v, emittedAt);
  }
  for (let i = 0; i < 12; i += 1) {
    const emittedAt = `2026-05-02T00:00:${String(i).padStart(2, "0")}.000Z`;
    // record_changes PK is (connector_instance_id, stream, version): each cold
    // key is its own first version, so the version must be unique within the
    // stream. The record stays at one version per key (vpr 1).
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await insertRecordChangePostgres("cold", `c${i}`, i + 1, emittedAt);
    await upsertCurrentRecordPostgres("cold", `c${i}`, 1, emittedAt);
  }
}

test("Postgres ground-truth streams + for-keys produce the same shaped facts as SQLite", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    await cleanupGroundTruthPostgres();
    await seedGroundTruthCorpusPostgres();

    // Full-scan ground truth straight from record_changes on Postgres.
    const full = await listRecordVersionGroundTruthStreams({});
    const hotGt = streamRow(full, "hot");
    const coldGt = streamRow(full, "cold");
    assert.ok(hotGt, "postgres full scan surfaces the hot stream");
    assert.ok(coldGt, "postgres full scan surfaces the cold stream");

    // Hot stream facts match the SQLite full-scan facts exactly.
    assert.equal(hotGt.record_history_count, 30);
    assert.equal(hotGt.record_key_count, 1);
    assert.equal(hotGt.current_record_count, 1);
    assert.equal(hotGt.connector_id, PG_GT_CONNECTOR);
    assert.equal(hotGt.connector_instance_id, PG_GT_INSTANCE);
    assert.equal(hotGt.last_history_at, "2026-05-01T00:00:30.000Z");
    assert.equal(hotGt.last_current_at, "2026-05-01T00:00:30.000Z");

    // Cold (flat) stream: 12 history, 12 current, 12 keys.
    assert.equal(coldGt.record_history_count, 12);
    assert.equal(coldGt.record_key_count, 12);
    assert.equal(coldGt.current_record_count, 12);

    // Scoped full-scan: connectorInstanceId + stream filter narrows to one row.
    const scoped = await listRecordVersionGroundTruthStreams({
      connectorInstanceId: PG_GT_INSTANCE,
      stream: "hot",
    });
    assert.equal(scoped.length, 1, "scoped full scan returns only the requested stream");
    assert.deepEqual(scoped[0], hotGt, "scoped facts byte-identical to full-scan facts");

    // Bounded for-keys helper returns facts identical to the full scan, just
    // like the SQLite "bounded for-keys helper returns facts identical to the
    // full scan" test asserts.
    const bounded = await listRecordVersionGroundTruthForKeys({
      keys: [{ connectorInstanceId: PG_GT_INSTANCE, stream: "hot" }],
    });
    assert.equal(bounded.length, 1, "bounded helper returns only the requested key");
    assert.deepEqual(bounded[0], hotGt, "bounded facts byte-identical to full-scan facts");

    // for-keys with both streams returns both, matching the full scan rows.
    const both = await listRecordVersionGroundTruthForKeys({
      keys: [
        { connectorInstanceId: PG_GT_INSTANCE, stream: "hot" },
        { connectorInstanceId: PG_GT_INSTANCE, stream: "cold" },
      ],
    });
    assert.equal(both.length, 2);
    assert.deepEqual(streamRow(both, "hot"), hotGt);
    assert.deepEqual(streamRow(both, "cold"), coldGt);

    // Empty key list short-circuits to [] on the Postgres path too.
    const none = await listRecordVersionGroundTruthForKeys({ keys: [] });
    assert.deepEqual(none, []);
  } finally {
    await cleanupGroundTruthPostgres();
    await closePostgresStorage();
  }
});
