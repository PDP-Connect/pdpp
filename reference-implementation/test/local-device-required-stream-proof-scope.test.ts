// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A local-device connection's committed coverage proof is only ever a claim
// about the region it was MEASURED in. The declared boundary lives in its own
// reserved `connector_state` row (`$collection_scope`), while the coverage
// snapshot lives in the `coverage_diagnostics` row. Both readers used to
// project ONLY the latter, so `deriveLocalCoverageAxis` read the declared
// boundary off a payload that structurally cannot contain it and every
// connection resolved to `unscoped` — the comparison that declassifies stale
// evidence (`collectionEvidenceScopeIsStale`) then trivially agreed, and a
// bounded/sample run's partial evidence proved every required stream complete.
//
// These tests pin the connector-agnostic contract across the four states a
// real local collector actually reaches: complete-empty, complete-nonempty,
// truncated sample, and interrupted collector. They exercise the SERVER
// rollup (`listConnectorSummaries`) and the shipped `claude_code` / `codex`
// manifests, so they prove the projection the dashboard consumes rather than
// a helper in isolation.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expectedLocalCoverageStoreDescriptors } from "../../packages/polyfill-connectors/src/local-source-inventory.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { COLLECTION_SCOPE_STATE_KEY } from "../server/local-collection-scope.ts";
import { putSyncState, readCommittedLocalCoverageDiagnostics } from "../server/records.ts";
import { deriveLocalCoverageAxis, listConnectorSummaries } from "../server/ref-control.ts";
import { rebuildRetainedSize } from "../server/retained-size-read-model.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { getDefaultDeviceExporterStore } from "../server/stores/device-exporter-store.ts";

const NOW = "2026-06-03T12:00:00.000Z";
const HEARTBEAT_AT = "2026-06-03T11:59:00.000Z";
const OWNER = "owner_local";
const DEVICE_ID = "dev_scope_proof";
const SOURCE_INSTANCE_ID = "src_scope_proof";
const CONNECTOR_INSTANCE_ID = "cin_scope_proof";

/** The bounded horizon a `--sample`/since-bounded local run actually declares. */
const SAMPLE_SCOPE = { since: "2026-06-01T00:00:00.000Z" } as const;
const SAMPLE_FINGERPRINT = "since=2026-06-01T00:00:00.000Z";

// Both shipped local-device collectors, so the contract is proven
// connector-agnostic rather than pinned to one manifest's stream list.
const LOCAL_COLLECTORS = ["claude_code", "codex"] as const;

interface TestManifest {
  readonly connector_id: string;
  readonly streams: readonly { readonly name: string; readonly required?: boolean }[];
}

function readManifest(name: string): TestManifest {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  ) as TestManifest;
}

/** Manifest-required streams — the denominator this suite must never shrink. */
function requiredStreams(manifest: TestManifest): readonly string[] {
  return manifest.streams.filter((stream) => stream.required !== false).map((stream) => stream.name);
}

function withTmpDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-local-scope-proof-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedRecord(connectorId: string, stream: string, key: string, data: unknown, emittedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`
    )
    .run(connectorId, CONNECTOR_INSTANCE_ID, stream, key, JSON.stringify(data), emittedAt);
}

/**
 * Seed one fully-collected local run.
 *
 * `measuredScope` stamps the boundary the evidence was measured under onto the
 * coverage rows themselves (where the real collector writes it), and
 * `declaredScope` writes the connection's currently-declared boundary into its
 * own reserved state row. `commitSnapshot: false` models an interrupted
 * collector: records reached the server but the coverage checkpoint never did.
 */
async function seedLocalRun({
  manifest,
  measuredScope = null,
  declaredScope = null,
  commitSnapshot = true,
  emitRecords = true,
}: {
  manifest: TestManifest;
  measuredScope?: string | null;
  declaredScope?: typeof SAMPLE_SCOPE | null;
  commitSnapshot?: boolean;
  emitRecords?: boolean;
}): Promise<void> {
  const connectorId = manifest.connector_id;
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    createdAt: NOW,
    displayName: "laptop collector",
    ownerSubjectId: OWNER,
    sourceBinding: { device: "laptop", kind: "local_device" },
    sourceBindingKey: "laptop",
    sourceKind: "local_device",
    status: "active",
    updatedAt: NOW,
  });

  const descriptors = expectedLocalCoverageStoreDescriptors(connectorId);
  assert.ok(descriptors, `${connectorId} must declare an authoritative local inventory`);

  // Every expected store collected: the strongest coverage claim a local run
  // can make. Whether it PROVES the required streams is the question each test
  // below asks against the declared boundary.
  descriptors.forEach((descriptor, index) => {
    seedRecord(
      connectorId,
      "coverage_diagnostics",
      `coverage:${descriptor.store}`,
      {
        ...(measuredScope ? { collection_scope: measuredScope } : {}),
        id: `coverage:${descriptor.store}`,
        status: "collected",
        store: descriptor.store,
        stream: descriptor.stream ?? null,
      },
      `2026-06-03T11:5${index % 10}:00.000Z`
    );
  });

  if (commitSnapshot) {
    getDb()
      .prepare(
        `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
         VALUES (?, ?, 'coverage_diagnostics', ?, ?)`
      )
      .run(
        connectorId,
        CONNECTOR_INSTANCE_ID,
        JSON.stringify({
          fetched_at: "2026-06-03T11:58:30.000Z",
          stores: descriptors.map((descriptor) => ({
            ...(measuredScope ? { collection_scope: measuredScope } : {}),
            status: "collected",
            store: descriptor.store,
            stream: descriptor.stream ?? null,
          })),
        }),
        "2026-06-03T11:58:31.000Z"
      );
  }

  if (declaredScope) {
    // Declare the boundary through the same `putSyncState` path the owner-facing
    // scope route uses, so the row lands under the canonical connector key a
    // read resolves to. A raw INSERT keyed by the manifest's registry-URL
    // `connector_id` would be written where no production read looks.
    await putSyncState(
      { connector_id: connectorId, connector_instance_id: CONNECTOR_INSTANCE_ID },
      { [COLLECTION_SCOPE_STATE_KEY]: { declared_at: NOW, fingerprint: SAMPLE_FINGERPRINT, scope: declaredScope } },
      { grantId: null }
    );
  }

  if (emitRecords) {
    for (const stream of manifest.streams.map((entry) => entry.name)) {
      if (stream === "coverage_diagnostics") {
        continue;
      }
      seedRecord(connectorId, stream, `${stream}_1`, { id: `${stream}_1` }, "2026-06-03T11:58:00.000Z");
    }
  }

  const devices = getDefaultDeviceExporterStore();
  await devices.createDevice({
    createdAt: NOW,
    deviceId: DEVICE_ID,
    displayName: "laptop",
    ownerSubjectId: OWNER,
    status: "active",
    updatedAt: NOW,
  });
  await devices.upsertSourceInstance({
    connectorId,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    createdAt: NOW,
    deviceId: DEVICE_ID,
    displayName: "laptop collector",
    localBindingId: "laptop",
    sourceInstanceId: SOURCE_INSTANCE_ID,
    status: "active",
    updatedAt: NOW,
  });
  await devices.markSourceInstanceHeartbeat(DEVICE_ID, SOURCE_INSTANCE_ID, {
    lastError: null,
    outboxDiagnostics: { dead_letter: 0, pending: 0, stale_leases: 0, succeeded: 12, total: 12 },
    receivedAt: HEARTBEAT_AT,
    recordsPending: 0,
    status: "healthy",
  });
  await rebuildRetainedSize();
}

interface TestReportEntry {
  readonly coverage_condition?: unknown;
  readonly forward_disposition?: unknown;
  readonly stream: string;
}

async function projectReport(): Promise<{
  coverageAxis: unknown;
  entryFor: (stream: string) => TestReportEntry | undefined;
}> {
  await reconcileDirtyConnectorSummaryEvidence(null);
  const summaries = await listConnectorSummaries();
  const row = summaries.find((summary) => summary.connector_instance_id === CONNECTOR_INSTANCE_ID);
  assert.ok(row, "expected the local-device connection to project a summary row");
  const byStream = new Map((row.collection_report as readonly TestReportEntry[]).map((e) => [e.stream, e]));
  return {
    coverageAxis: row.connection_health.axes.coverage,
    entryFor: (stream: string) => byStream.get(stream),
  };
}

for (const name of LOCAL_COLLECTORS) {
  // ---------------------------------------------------------------------
  // The defect this suite exists for. A connection whose owner declared a
  // BOUNDED horizon, holding evidence measured over the WHOLE corpus, must
  // not read that evidence as proof of the declared region.
  // ---------------------------------------------------------------------
  test(
    `${name}: declared bounded horizon reaches the coverage axis instead of defaulting to unscoped`,
    withTmpDb(async () => {
      const manifest = readManifest(name);
      await seedLocalRun({ declaredScope: SAMPLE_SCOPE, manifest, measuredScope: null });

      const proof = await readCommittedLocalCoverageDiagnostics({
        connector_id: manifest.connector_id,
        connector_instance_id: CONNECTOR_INSTANCE_ID,
      });
      const axis = deriveLocalCoverageAxis(proof as Parameters<typeof deriveLocalCoverageAxis>[0]);

      // Fail-before: the reader projected only the coverage_diagnostics row, so
      // the declared boundary was structurally invisible and read `unscoped`.
      assert.equal(
        axis.declaredCollectionScope,
        SAMPLE_FINGERPRINT,
        "the connection's declared boundary must reach the coverage axis"
      );
    })
  );

  test(
    `${name}: whole-corpus evidence never proves a required stream under a declared bounded horizon`,
    withTmpDb(async () => {
      const manifest = readManifest(name);
      // Evidence measured over everything (no per-row boundary: a pre-scope /
      // full-pass collector), but the owner now declares a narrow horizon.
      await seedLocalRun({ declaredScope: SAMPLE_SCOPE, manifest, measuredScope: null });

      const { entryFor } = await projectReport();
      for (const stream of requiredStreams(manifest)) {
        assert.notEqual(
          entryFor(stream)?.coverage_condition,
          "complete",
          `${stream}: evidence measured outside the declared boundary must not read complete`
        );
      }
    })
  );

  // ---------------------------------------------------------------------
  // Truncated sample: the collector really did enforce the bound, and the
  // owner really is asking about that bounded region. The boundaries agree,
  // so the evidence is honest proof OF THAT REGION — the bounded horizon is
  // supported, not punished.
  // ---------------------------------------------------------------------
  test(
    `${name}: truncated sample run proves its required streams within the boundary it measured`,
    withTmpDb(async () => {
      const manifest = readManifest(name);
      await seedLocalRun({ declaredScope: SAMPLE_SCOPE, manifest, measuredScope: SAMPLE_FINGERPRINT });

      const { coverageAxis, entryFor } = await projectReport();
      assert.equal(coverageAxis, "complete");
      for (const stream of requiredStreams(manifest)) {
        assert.equal(
          entryFor(stream)?.coverage_condition,
          "complete",
          `${stream}: a sample run that enforced the declared bound proves that region`
        );
      }
    })
  );

  // ---------------------------------------------------------------------
  // Complete NONEMPTY: an unbounded full pass with records. Every required
  // stream proves complete — the denominator is never gamed down.
  // ---------------------------------------------------------------------
  test(
    `${name}: complete nonempty full pass proves every required stream`,
    withTmpDb(async () => {
      const manifest = readManifest(name);
      await seedLocalRun({ manifest });

      const { coverageAxis, entryFor } = await projectReport();
      assert.equal(coverageAxis, "complete");
      const required = requiredStreams(manifest);
      assert.ok(required.length > 0, "the shipped manifest must declare required streams");
      for (const stream of required) {
        assert.equal(entryFor(stream)?.coverage_condition, "complete", `${stream} must prove complete`);
      }
    })
  );

  // ---------------------------------------------------------------------
  // Complete EMPTY: a full pass that legitimately found no records still
  // proves coverage — verified emptiness is a real result, not a gap.
  // ---------------------------------------------------------------------
  test(
    `${name}: complete empty full pass still proves every required stream`,
    withTmpDb(async () => {
      const manifest = readManifest(name);
      await seedLocalRun({ emitRecords: false, manifest });

      const { coverageAxis, entryFor } = await projectReport();
      assert.equal(coverageAxis, "complete");
      for (const stream of requiredStreams(manifest)) {
        assert.equal(
          entryFor(stream)?.coverage_condition,
          "complete",
          `${stream}: a measured empty pass is proven coverage, not a gap`
        );
      }
    })
  );

  // ---------------------------------------------------------------------
  // Interrupted collector: records arrived, the coverage checkpoint never
  // did. Absence of proof is never promoted to proof.
  // ---------------------------------------------------------------------
  test(
    `${name}: interrupted collector proves nothing despite thousands of delivered records`,
    withTmpDb(async () => {
      const manifest = readManifest(name);
      await seedLocalRun({ commitSnapshot: false, manifest });

      const { coverageAxis, entryFor } = await projectReport();
      assert.equal(coverageAxis, "unknown", "an uncommitted coverage checkpoint proves nothing");
      for (const stream of requiredStreams(manifest)) {
        assert.notEqual(
          entryFor(stream)?.coverage_condition,
          "complete",
          `${stream}: delivered records without a committed checkpoint are not coverage proof`
        );
      }
    })
  );
}
