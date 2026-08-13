// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Polyfill manifest reconciliation must invalidate prior-shape records on
 * the narrow seed/reference-fixture → polyfill transition, and MUST preserve
 * records on every other manifest evolution. The trust contract is at
 * openspec/changes/reconcile-invalidates-stale-records/.
 *
 * The motivating bug: `pdpp seed` registers reference fixture manifests
 * under the same connector_id as the shipped polyfill manifests and emits
 * seed-fake records (Taylor Swift, Adele, etc.). Without invalidation, the
 * next reference startup overwrites the persisted manifest with the
 * polyfill version but leaves the seed-fake records sitting in the RS,
 * where the dashboard advertises them as fresh real data.
 *
 * The opposite failure mode is just as bad: deleting an owner's real
 * records on every ordinary manifest update (semantic_fields, descriptions,
 * range filters, view additions). The fingerprint-gated transition keeps
 * the destructive path narrow.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getConnectorManifest as getConnectorManifestUntyped,
  registerConnector as registerConnectorUntyped,
} from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { reconcilePolyfillManifests } from "../server/polyfill-manifest-reconcile.ts";
import { ingestRecord as ingestRecordUntyped } from "../server/records.ts";

const REGEXP_1 = /seed-flip/;
const REGEXP_2 = /2 record/;
const REGEXP_3 = /seed-flip/;

// server/auth.ts (registerConnector, getConnectorManifest) and
// server/records.js (ingestRecord) are untyped JS (allowJs,
// checkJs:false). This suite's manifests are deep, deliberately-mutated
// fixture literals (see referenceFixtureManifest/shippedPolyfillManifest
// below) so `Manifest` is intentionally loose (`[key: string]: unknown`)
// rather than mirroring the full protocol schema.
interface Manifest {
  capabilities?: {
    public_listing?: { listed?: boolean; status?: string };
    [key: string]: unknown;
  };
  connector_id: string;
  streams: { name: string; query?: Record<string, unknown>; [key: string]: unknown }[];
  [key: string]: unknown;
}

const registerConnector = registerConnectorUntyped as (
  manifest: Manifest,
  options?: { backfillRetrievalIndexes?: boolean }
) => Promise<unknown>;
const getConnectorManifest = getConnectorManifestUntyped as (connectorId: string) => Promise<Manifest | null>;
const ingestRecord = ingestRecordUntyped as (
  connectorId: string,
  record: { stream: string; key: string; data: Record<string, unknown>; emitted_at: string }
) => Promise<unknown>;

const CONNECTOR_ID = "seed-flip";

function referenceFixtureManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    connector_id: CONNECTOR_ID,
    connector_key: CONNECTOR_ID,
    display_name: "Seed flip fixture (reference shape)",
    manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        cursor_field: "source_updated_at",
        name: "top_artists",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            source_updated_at: { format: "date-time", type: "string" },
          },
          required: ["id", "source_updated_at"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
    ...overrides,
  };
}

function shippedPolyfillManifest(overrides: Partial<Manifest> = {}): Manifest {
  // Same connector_id but different (version, sorted-stream-names)
  // fingerprint, matching the real spotify reference→polyfill drift shape.
  return {
    connector_id: CONNECTOR_ID,
    connector_key: CONNECTOR_ID,
    display_name: "Seed flip fixture (polyfill shape)",
    manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        cursor_field: "source_updated_at",
        name: "top_artists",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            source_updated_at: { format: "date-time", type: "string" },
          },
          required: ["id", "source_updated_at"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        cursor_field: "saved_at",
        name: "saved_tracks",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            saved_at: { format: "date-time", type: "string" },
          },
          required: ["id", "saved_at"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
    ...overrides,
  };
}

function withTmpDb(fn: (ctx: { dir: string }) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-reconcile-invalidate-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn({ dir });
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function writeManifestsDir(rootDir: string, subdir: string, manifests: Record<string, Manifest>): string {
  const dir = join(rootDir, subdir);
  mkdirSync(dir, { recursive: true });
  for (const [filename, manifest] of Object.entries(manifests)) {
    writeFileSync(join(dir, filename), JSON.stringify(manifest, null, 2));
  }
  return dir;
}

function recordCount(connectorId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM records WHERE connector_id = ?").get(connectorId) as {
    count: number;
  };
  return row.count;
}

function recordKeys(connectorId: string): string[] {
  return (
    getDb()
      .prepare("SELECT record_key FROM records WHERE connector_id = ? ORDER BY record_key ASC")
      .all(connectorId) as { record_key: string }[]
  ).map((row) => row.record_key);
}

async function mustGetConnectorManifest(connectorId: string): Promise<Manifest> {
  const persisted = await getConnectorManifest(connectorId);
  assert.ok(persisted, `expected a persisted manifest for ${connectorId}`);
  return persisted;
}

function mustFirstStream(manifest: Manifest): {
  name: string;
  query?: Record<string, unknown>;
  [key: string]: unknown;
} {
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const stream = manifest.streams[0];
  assert.ok(stream, `expected at least one stream on ${manifest.connector_id}`);
  return stream;
}

function insertRawConnectorManifest(connectorId: string, manifest: Manifest): void {
  getDb()
    .prepare(
      `INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)
       ON CONFLICT(connector_id) DO UPDATE SET manifest = excluded.manifest`
    )
    .run(connectorId, JSON.stringify(manifest), new Date().toISOString());
}

async function ingestSeedFakeArtists(connectorId: string): Promise<void> {
  // Same fixture identities the real reference seed connector emits.
  const artists = [
    { id: "spotify:artist:0L8ExT028jH3ddEcZwqJJ5", name: "Taylor Swift", source_updated_at: "2026-04-20T00:00:00Z" },
    { id: "spotify:artist:4dpARuHxo51G3z768sgnrY", name: "Adele", source_updated_at: "2026-04-15T00:00:00Z" },
  ];
  for (const data of artists) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    await ingestRecord(connectorId, {
      data,
      emitted_at: data.source_updated_at,
      key: data.id,
      stream: "top_artists",
    });
  }
}

async function ingestRealOwnerArtists(connectorId: string): Promise<void> {
  const artists = [
    { id: "spotify:artist:owner-real-1", name: "Real Owner Artist 1", source_updated_at: "2026-04-25T00:00:00Z" },
    { id: "spotify:artist:owner-real-2", name: "Real Owner Artist 2", source_updated_at: "2026-04-25T00:00:00Z" },
    { id: "spotify:artist:owner-real-3", name: "Real Owner Artist 3", source_updated_at: "2026-04-25T00:00:00Z" },
  ];
  for (const data of artists) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    await ingestRecord(connectorId, {
      data,
      emitted_at: data.source_updated_at,
      key: data.id,
      stream: "top_artists",
    });
  }
}

test(
  "reconciliation invalidates seed-fake records on the reference-fixture → polyfill transition",
  withTmpDb(async ({ dir }) => {
    // 1. Persist the reference-fixture-shape manifest, then ingest seed-fake
    //    records under it (the `pdpp seed` flow against reference fixtures).
    await registerConnector(referenceFixtureManifest());
    await ingestSeedFakeArtists(CONNECTOR_ID);
    assert.equal(recordCount(CONNECTOR_ID), 2, "baseline: seed-fake records present");
    assert.deepEqual(
      recordKeys(CONNECTOR_ID),
      ["spotify:artist:0L8ExT028jH3ddEcZwqJJ5", "spotify:artist:4dpARuHxo51G3z768sgnrY"],
      "baseline: the two seed-fake artists are persisted"
    );

    // 2. Stand up a shipped-manifests directory with the polyfill-shape
    //    manifest and a reference-fixtures dir containing the fixture manifest.
    //    The reference-fixtures dir is what makes reconciliation recognize
    //    that the persisted manifest fingerprint belongs to the seed flow.
    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": shippedPolyfillManifest() });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {
      "seed-flip.json": referenceFixtureManifest(),
    });

    // 3. Run reconciliation. Persisted matches the reference-fixture
    //    fingerprint → narrow transition → invalidate.
    const lines: string[] = [];
    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: (line) => lines.push(line),
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(recordCount(CONNECTOR_ID), 0, "no records remain for the flipped connector");
    assert.equal(summary.invalidatedConnectors, 1, "summary counts the connector as invalidated");
    assert.equal(summary.invalidatedRecords, 2, "summary counts deleted records");
    assert.equal(summary.updated, 1, "manifest was re-registered to the polyfill shape");
    assert.equal(summary.errors, 0, "no reconciliation errors");

    const persisted = await mustGetConnectorManifest(CONNECTOR_ID);
    assert.equal(persisted.version, "0.1.0", "persisted manifest is the shipped polyfill version");
    // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
    const streamNames = persisted.streams.map((s) => s.name).sort();
    assert.deepEqual(streamNames, ["saved_tracks", "top_artists"], "persisted manifest is the polyfill shape");

    const invalidationLine = lines.find((line) => line.includes("invalidated"));
    assert.ok(invalidationLine, "reconciliation emits an invalidation log line");
    assert.match(invalidationLine, REGEXP_1);
    assert.match(invalidationLine, REGEXP_2);
  })
);

test(
  "reconciliation preserves owner records when polyfill manifest evolves with new semantic_fields only",
  withTmpDb(async ({ dir }) => {
    // Persist the polyfill manifest and ingest real owner records under it.
    // Then ship an evolution that adds `query.search.semantic_fields` to a
    // stream — a structural diff, but NOT a fixture→polyfill transition.
    // Owner records MUST survive.
    await registerConnector(shippedPolyfillManifest());
    await ingestRealOwnerArtists(CONNECTOR_ID);
    assert.equal(recordCount(CONNECTOR_ID), 3);

    const evolved = shippedPolyfillManifest();
    mustFirstStream(evolved).query = {
      search: { semantic_fields: ["name"] },
    };

    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": evolved });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {
      "seed-flip.json": referenceFixtureManifest(),
    });

    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: () => {
        /* intentionally empty */
      },
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.updated, 1, "manifest evolution still re-registers");
    assert.equal(summary.invalidatedConnectors, 0, "semantic_fields-only update must not invalidate");
    assert.equal(summary.invalidatedRecords, 0);
    assert.equal(recordCount(CONNECTOR_ID), 3, "all owner records survive a semantic_fields update");

    const persisted = await mustGetConnectorManifest(CONNECTOR_ID);
    const persistedQuery = mustFirstStream(persisted).query as { search?: { semantic_fields?: string[] } } | undefined;
    assert.deepEqual(
      persistedQuery?.search?.semantic_fields,
      ["name"],
      "persisted manifest carries the new semantic_fields"
    );
  })
);

test(
  "reconciliation preserves owner records when polyfill manifest evolves with display_name/description only",
  withTmpDb(async ({ dir }) => {
    await registerConnector(shippedPolyfillManifest());
    await ingestRealOwnerArtists(CONNECTOR_ID);
    assert.equal(recordCount(CONNECTOR_ID), 3);

    const evolved = shippedPolyfillManifest({
      display_name: "Seed flip fixture (polyfill, copy revised)",
    });

    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": evolved });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {
      "seed-flip.json": referenceFixtureManifest(),
    });

    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: () => {
        /* intentionally empty */
      },
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.updated, 1);
    assert.equal(summary.invalidatedConnectors, 0, "description-only update must not invalidate");
    assert.equal(summary.invalidatedRecords, 0);
    assert.equal(recordCount(CONNECTOR_ID), 3, "all owner records survive a copy-only update");
  })
);

test(
  "reconciliation preserves owner records when polyfill manifest version bumps but stream set is unchanged",
  withTmpDb(async ({ dir }) => {
    // Polyfill v0.1.0 → v0.2.0 with the same stream set is the common
    // "schema additions / view additions" path. Persisted fingerprint
    // (`v0.1.0`, top_artists+saved_tracks) does not match the reference
    // fixture fingerprint (`v1.0.0`, top_artists). No invalidation.
    await registerConnector(shippedPolyfillManifest());
    await ingestRealOwnerArtists(CONNECTOR_ID);
    assert.equal(recordCount(CONNECTOR_ID), 3);

    const evolved = shippedPolyfillManifest({ version: "0.2.0" });

    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": evolved });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {
      "seed-flip.json": referenceFixtureManifest(),
    });

    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: () => {
        /* intentionally empty */
      },
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.updated, 1);
    assert.equal(summary.invalidatedConnectors, 0, "polyfill version bump alone must not invalidate");
    assert.equal(summary.invalidatedRecords, 0);
    assert.equal(recordCount(CONNECTOR_ID), 3, "all owner records survive a polyfill version bump");
  })
);

test(
  "reconciliation preserves owner records when no reference-fixture manifest exists for the connector_id",
  withTmpDb(async ({ dir }) => {
    // Polyfill-only connectors (no reference-fixture collision) cannot be in
    // the seed→polyfill transition. A manifest diff must never invalidate
    // their records.
    await registerConnector(shippedPolyfillManifest());
    await ingestRealOwnerArtists(CONNECTOR_ID);
    assert.equal(recordCount(CONNECTOR_ID), 3);

    const evolved = shippedPolyfillManifest({ version: "0.2.0" });

    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": evolved });
    // Empty reference-fixtures dir (mimics a polyfill-only connector).
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: () => {
        /* intentionally empty */
      },
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.updated, 1);
    assert.equal(summary.invalidatedConnectors, 0);
    assert.equal(recordCount(CONNECTOR_ID), 3, "records survive evolution of a polyfill-only connector");
  })
);

test(
  "reconciliation preserves records when the persisted manifest content matches the shipped manifest",
  withTmpDb(async ({ dir }) => {
    await registerConnector(shippedPolyfillManifest());
    await ingestRecord(CONNECTOR_ID, {
      data: { id: "spotify:artist:real", name: "Real Artist", source_updated_at: "2026-04-25T00:00:00Z" },
      emitted_at: "2026-04-25T00:00:00Z",
      key: "spotify:artist:real",
      stream: "top_artists",
    });
    assert.equal(recordCount(CONNECTOR_ID), 1, "baseline: one record persisted under polyfill manifest");

    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": shippedPolyfillManifest() });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {
      "seed-flip.json": referenceFixtureManifest(),
    });
    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: () => {
        /* intentionally empty */
      },
      manifestsDir,
      referenceFixturesDir,
    });
    // Persisted rows now carry the generated SourceDeclaration snapshot, so
    // byte comparison with the shipped legacy fixture remains an update even
    // when the operational manifest content is unchanged. The update must
    // still preserve records; a future storage-normalization fix can tighten
    // this back to `unchanged` without changing the data-safety assertion.
    assert.equal(summary.updated, 1, "reconciliation refreshes the derived declaration snapshot");
    assert.equal(summary.invalidatedConnectors, 0, "no invalidation when fingerprints match");
    assert.equal(summary.invalidatedRecords, 0, "no records counted as invalidated");
    assert.equal(recordCount(CONNECTOR_ID), 1, "records survive a no-op reconciliation");
  })
);

test(
  "reconciliation repairs an invalid persisted first-party manifest without deleting records",
  withTmpDb(async ({ dir }) => {
    await registerConnector(shippedPolyfillManifest());
    await ingestRecord(CONNECTOR_ID, {
      data: { id: "spotify:artist:real", name: "Real Artist", source_updated_at: "2026-04-25T00:00:00Z" },
      emitted_at: "2026-04-25T00:00:00Z",
      key: "spotify:artist:real",
      stream: "top_artists",
    });
    const invalidPersisted = shippedPolyfillManifest();
    mustFirstStream(invalidPersisted).query = {
      aggregations: {
        count: true,
        time_bucket: ["source_updated_at"],
      },
    };
    insertRawConnectorManifest(CONNECTOR_ID, invalidPersisted);
    assert.equal(recordCount(CONNECTOR_ID), 1, "baseline: owner record persisted under stale manifest row");

    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": shippedPolyfillManifest() });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {
      "seed-flip.json": referenceFixtureManifest(),
    });
    const lines: string[] = [];

    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: (line) => lines.push(line),
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.updated, 1, "invalid stale manifest row is overwritten by the shipped manifest");
    assert.equal(summary.errors, 0, "repairable stale manifest is not counted as a reconciliation error");
    assert.equal(summary.invalidatedConnectors, 0, "invalid stale manifest repair must not invalidate records");
    assert.equal(summary.invalidatedRecords, 0);
    assert.equal(recordCount(CONNECTOR_ID), 1, "owner record survives stale manifest repair");

    const persisted = await mustGetConnectorManifest(CONNECTOR_ID);
    assert.equal(persisted.version, "0.1.0");
    const persistedQuery = mustFirstStream(persisted).query as { aggregations?: { time_bucket?: unknown } } | undefined;
    assert.equal(persistedQuery?.aggregations?.time_bucket, undefined);
    assert.ok(
      lines.some((line) => line.includes("lookup failed")),
      "repair logs the invalid persisted lookup"
    );
    assert.ok(
      lines.some((line) => line.includes("updated")),
      "repair logs the shipped manifest update"
    );
  })
);

test(
  "a direct registerConnector call with a different manifest does not delete records",
  withTmpDb(async () => {
    await registerConnector(referenceFixtureManifest());
    await ingestSeedFakeArtists(CONNECTOR_ID);
    assert.equal(recordCount(CONNECTOR_ID), 2);

    await registerConnector(shippedPolyfillManifest());
    assert.equal(
      recordCount(CONNECTOR_ID),
      2,
      "records survive a direct re-register (only reconciliation invalidates)"
    );
  })
);

test(
  "reconciliation skips unlisted connectors that are not yet registered (no record invalidation, no auto-seed)",
  withTmpDb(async ({ dir }) => {
    // The shipped fixture used here does not declare
    // `capabilities.public_listing.listed: true`, so reconciliation MUST
    // NOT auto-seed it. This preserves the long-standing "don't surprise
    // owners with a custom-looking connector_id" guarantee for unlisted /
    // unproven manifests and keeps the destructive invalidation path
    // unreachable on first registration.
    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": shippedPolyfillManifest() });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {
      "seed-flip.json": referenceFixtureManifest(),
    });
    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: () => {
        /* intentionally empty */
      },
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.skipped, 1, "unlisted connector with no persisted manifest is skipped");
    assert.equal(summary.registered, 0, "unlisted manifests are not auto-registered");
    assert.equal(summary.updated, 0);
    assert.equal(summary.invalidatedConnectors, 0);
    assert.equal(summary.invalidatedRecords, 0);

    const persisted = await getConnectorManifest(CONNECTOR_ID);
    assert.equal(persisted, null, "no connectors row is created for an unlisted shipped manifest");
  })
);

test(
  "reconciliation auto-registers listed=true first-party manifests so the operator catalog can show them on a fresh DB",
  withTmpDb(async ({ dir }) => {
    // Catalog completeness: a first-party manifest that declares
    // `capabilities.public_listing.listed: true` must be present in the
    // connectors table on startup so `GET /_ref/connectors` and the
    // reference dashboard can surface it before the first schedule or run
    // row exists. See
    // openspec/changes/add-connector-public-listing-honesty/.
    const listedManifest = shippedPolyfillManifest({
      capabilities: {
        public_listing: { listed: true, status: "proven" },
        refresh_policy: {
          background_safe: false,
          rationale: "Listed first-party manifest must be visible on the operator catalog even with no schedule.",
          recommended_mode: "manual",
        },
      },
    });
    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": listedManifest });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

    const lines: string[] = [];
    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: (line) => lines.push(line),
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.registered, 1, "listed first-party manifest is auto-registered");
    assert.equal(summary.skipped, 0, "not skipped — the listed gate fires");
    assert.equal(summary.updated, 0, "registration is not an update");
    assert.equal(summary.invalidatedConnectors, 0, "first-time registration must not invalidate records");
    assert.equal(summary.invalidatedRecords, 0);
    assert.equal(summary.errors, 0);

    const persisted = await mustGetConnectorManifest(CONNECTOR_ID);
    assert.ok(persisted, "connector is persisted in the DB after reconciliation");
    assert.equal(persisted.connector_id, CONNECTOR_ID);
    assert.equal(persisted.capabilities?.public_listing?.listed, true);

    const registeredLine = lines.find((line) => line.includes("registered listed first-party manifest"));
    assert.ok(registeredLine, "reconciliation emits a register log line");
    assert.match(registeredLine, REGEXP_3);
  })
);

test(
  "reconciliation does not auto-register hidden manifests even when the file is shipped",
  withTmpDb(async ({ dir }) => {
    // The hidden/unproven half of the catalog-completeness rule: a manifest
    // shipped under packages/polyfill-connectors/manifests/ with
    // listed=false stays invisible to the operator catalog on a fresh DB.
    const hiddenManifest = shippedPolyfillManifest({
      capabilities: {
        public_listing: { listed: false, status: "unproven" },
        refresh_policy: {
          background_safe: false,
          rationale: "Unproven; hidden from the operator catalog until a credentialed run.",
          recommended_mode: "manual",
        },
      },
    });
    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": hiddenManifest });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: () => {
        /* intentionally empty */
      },
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.registered, 0, "hidden manifest is not auto-registered");
    assert.equal(summary.skipped, 1, "hidden manifest is skipped");
    const persisted = await getConnectorManifest(CONNECTOR_ID);
    assert.equal(persisted, null, "no connectors row is created for a hidden shipped manifest");
  })
);

test(
  "reconciliation disabled by options logs and reports disabled_reason instead of silently scanning nothing",
  withTmpDb(async ({ dir }) => {
    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": shippedPolyfillManifest() });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

    const lines: string[] = [];
    const summary = await reconcilePolyfillManifests({
      enabled: false,
      log: (line) => lines.push(line),
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.scanned, 0, "a disabled run scans nothing");
    assert.equal(summary.disabled_reason, "disabled_by_options", "summary explains why nothing was scanned");
    assert.ok(
      lines.some((line) => line.includes("disabled by options")),
      "a disabled-by-options run logs through the log option instead of staying silent"
    );
  })
);

test(
  "reconciliation skipped via PDPP_SKIP_MANIFEST_RECONCILE logs and reports disabled_reason",
  withTmpDb(async ({ dir }) => {
    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": shippedPolyfillManifest() });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

    const prior = process.env.PDPP_SKIP_MANIFEST_RECONCILE;
    process.env.PDPP_SKIP_MANIFEST_RECONCILE = "1";
    const lines: string[] = [];
    // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
    // biome-ignore lint/suspicious/noImplicitAnyLet: Fixture accumulator is intentionally inferred from runtime test data.
    let summary;
    try {
      summary = await reconcilePolyfillManifests({
        enabled: true,
        log: (line) => lines.push(line),
        manifestsDir,
        referenceFixturesDir,
      });
    } finally {
      if (prior === undefined) {
        delete process.env.PDPP_SKIP_MANIFEST_RECONCILE;
      } else {
        process.env.PDPP_SKIP_MANIFEST_RECONCILE = prior;
      }
    }

    assert.equal(summary.scanned, 0, "an env-skipped run scans nothing");
    assert.equal(summary.disabled_reason, "env_skip", "summary explains why nothing was scanned");
    assert.ok(
      lines.some((line) => line.includes("PDPP_SKIP_MANIFEST_RECONCILE=1")),
      "an env-skipped run logs through the log option instead of staying silent"
    );
  })
);

test(
  "reconciliation with an unavailable manifests dir logs and reports disabled_reason",
  withTmpDb(async ({ dir }) => {
    const manifestsDir = join(dir, "does-not-exist");
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

    const lines: string[] = [];
    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: (line) => lines.push(line),
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.scanned, 0, "a run against a missing manifests dir scans nothing");
    assert.equal(summary.disabled_reason, "manifests_dir_unavailable", "summary explains why nothing was scanned");
    assert.ok(
      lines.some((line) => line.includes("manifests dir unavailable")),
      "a missing-manifests-dir run logs through the log option (pre-existing behavior)"
    );
  })
);

test(
  "reconciliation that actually scans reports disabled_reason: null",
  withTmpDb(async ({ dir }) => {
    const manifestsDir = writeManifestsDir(dir, "polyfill", { "seed-flip.json": shippedPolyfillManifest() });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: () => {
        /* intentionally empty */
      },
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.scanned, 1, "the manifest file was scanned");
    assert.equal(summary.disabled_reason, null, "a real scan carries no disabled_reason");
  })
);
