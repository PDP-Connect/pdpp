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
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

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
    public_listing?: { tier?: "supported" | "preview" | "development" };
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
const ingestRecordForInstance = ingestRecordUntyped as (
  storageTarget: { connector_id: string; connector_instance_id: string },
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

// ─── Generic, connector-agnostic record-identity-generation transition ─────
//
// RI holds ZERO connector/provider knowledge. Instead of a hardcoded
// (connectorId, fromVersion, toVersion) allowlist (the prior
// isBreakingIdSchemeTransition design -- see git history for the WhatsApp
// case that motivated this), a connector AUTHOR declares
// `capabilities.record_identity.generation: <integer>` in their OWN
// manifest and bumps it whenever their record_key derivation changes in a
// way that breaks idempotency against previously-emitted records. RI's
// reconcile logic only ever compares two integers -- a shipped manifest's
// declared generation vs. each INSTANCE's own last-reconciled checkpoint
// (`connector_instances.record_identity_generation`) -- with zero
// awareness of what "generation" means for any given connector.
//
// Critically, invalidation is PER INSTANCE, never connector-wide: only
// instances whose checkpoint is behind the shipped generation are touched
// (via deleteAllRecordsForConnector's instanceIdFilter); sibling instances
// of the same connector type that are already caught up are left
// completely untouched, including their data.

const GENERATION_CONNECTOR_ID = "generation-fixture";
const GENERATION_STORAGE_CONNECTOR_ID = "generation-fixture";

function generationManifestV1(overrides: Partial<Manifest> = {}): Manifest {
  const connectorId = overrides.connector_id ?? GENERATION_CONNECTOR_ID;
  return {
    connector_id: connectorId,
    connector_key: connectorId,
    display_name: "Generation fixture connector",
    manifest_uri: `https://registry.pdpp.dev/connectors/${connectorId}`,
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { filesystem: { required: true } } },
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: { content: { type: "string" }, id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "0.1.0",
    ...overrides,
  };
}

function generationManifestV2(overrides: Partial<Manifest> = {}): Manifest {
  return generationManifestV1({
    capabilities: { record_identity: { generation: 1 } },
    version: "0.2.0",
    ...overrides,
  });
}

async function ingestOldGenerationItems(storageTarget: { connector_id: string; connector_instance_id: string }) {
  const items = [
    { content: "first", id: "old-scheme:0" },
    { content: "second", id: "old-scheme:1" },
  ];
  for (const data of items) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    await ingestRecordForInstance(storageTarget, {
      data,
      emitted_at: "2026-06-05T09:15:22Z",
      key: data.id,
      stream: "items",
    });
  }
}

function seedGenerationInstance(
  connectorInstanceId: string,
  sourceBindingKey: string,
  connectorId: string = GENERATION_STORAGE_CONNECTOR_ID
): Promise<unknown> {
  const store = createSqliteConnectorInstanceStore();
  return Promise.resolve(
    store.upsert({
      connectorId,
      connectorInstanceId,
      createdAt: "2026-06-01T00:00:00Z",
      displayName: connectorInstanceId,
      ownerSubjectId: "owner-generation-test",
      sourceBinding: { account_hint: sourceBindingKey },
      sourceBindingKey,
      sourceKind: "account",
      status: "active",
      updatedAt: "2026-06-01T00:00:00Z",
    })
  );
}

function recordIdentityGeneration(connectorInstanceId: string): number {
  const row = getDb()
    .prepare("SELECT record_identity_generation AS generation FROM connector_instances WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as { generation: number } | undefined;
  assert.ok(row, `expected a connector_instances row for ${connectorInstanceId}`);
  return row.generation;
}

test(
  "reconciliation invalidates prior-generation records for an instance behind the shipped manifest's declared record_identity.generation",
  withTmpDb(async ({ dir }) => {
    await registerConnector(generationManifestV1());
    await seedGenerationInstance("cin_gen_solo", "solo@example.com");
    assert.equal(recordIdentityGeneration("cin_gen_solo"), 0, "baseline: fresh instance checkpoint starts at 0");

    await ingestOldGenerationItems({
      connector_id: GENERATION_STORAGE_CONNECTOR_ID,
      connector_instance_id: "cin_gen_solo",
    });
    assert.equal(recordCount(GENERATION_STORAGE_CONNECTOR_ID), 2, "baseline: old-generation items persisted");

    const manifestsDir = writeManifestsDir(dir, "polyfill", { "generation-fixture.json": generationManifestV2() });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

    const lines: string[] = [];
    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: (line) => lines.push(line),
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(
      recordCount(GENERATION_STORAGE_CONNECTOR_ID),
      0,
      "old-generation records are invalidated, not left to duplicate"
    );
    assert.equal(summary.invalidatedConnectors, 1);
    assert.equal(summary.invalidatedRecords, 2);
    assert.equal(summary.updated, 1, "manifest was re-registered to v0.2.0");
    assert.equal(summary.errors, 0);
    assert.equal(recordIdentityGeneration("cin_gen_solo"), 1, "instance checkpoint advances to the shipped generation");

    const persisted = await mustGetConnectorManifest(GENERATION_CONNECTOR_ID);
    assert.equal(persisted.version, "0.2.0");

    const invalidationLine = lines.find((line) => line.includes("invalidated"));
    assert.ok(invalidationLine, "reconciliation emits an invalidation log line for the generation transition");
  })
);

test(
  "reconciliation with two instances of the same connector invalidates ONLY the instance behind the declared generation; the caught-up sibling and its data survive untouched",
  withTmpDb(async ({ dir }) => {
    // cin_gen_behind is created under manifest v1 (declared generation 0
    // implicitly) and ingests data under the OLD scheme.
    await registerConnector(generationManifestV1());
    await seedGenerationInstance("cin_gen_behind", "behind@example.com");
    await ingestOldGenerationItems({
      connector_id: GENERATION_STORAGE_CONNECTOR_ID,
      connector_instance_id: "cin_gen_behind",
    });

    // The connector's manifest is bumped to v2 (generation 1) and
    // reconciled once, invalidating cin_gen_behind and advancing its
    // checkpoint to 1.
    const manifestsDirV2 = writeManifestsDir(dir, "polyfill-v2", {
      "generation-fixture.json": generationManifestV2(),
    });
    await reconcilePolyfillManifests({
      enabled: true,
      log: () => {
        /* intentionally empty */
      },
      manifestsDir: manifestsDirV2,
      referenceFixturesDir: writeManifestsDir(dir, "reference-v2", {}),
    });
    assert.equal(recordCount(GENERATION_STORAGE_CONNECTOR_ID), 0, "cin_gen_behind's old-generation data is gone");
    assert.equal(recordIdentityGeneration("cin_gen_behind"), 1);

    // cin_gen_caught_up is created AFTER the manifest is already at
    // generation 1 -- its checkpoint is seeded to 1 at creation time (see
    // insert.sql), NOT left at the column default of 0. It ingests real
    // data under the CURRENT (generation-1) scheme.
    await seedGenerationInstance("cin_gen_caught_up", "caught-up@example.com");
    assert.equal(
      recordIdentityGeneration("cin_gen_caught_up"),
      1,
      "an instance created after the manifest already declared generation 1 is seeded at 1, not 0"
    );
    await ingestRecordForInstance(
      { connector_id: GENERATION_STORAGE_CONNECTOR_ID, connector_instance_id: "cin_gen_caught_up" },
      {
        data: { content: "current-scheme", id: "current-scheme:0" },
        emitted_at: "2026-06-06T09:15:22Z",
        key: "current-scheme:0",
        stream: "items",
      }
    );
    assert.equal(recordCount(GENERATION_STORAGE_CONNECTOR_ID), 1, "baseline: only the caught-up instance has data");

    // An UNRELATED manifest edit (a new description) bumps content but not
    // the declared generation. Reconciliation fires (manifest changed) and
    // must find zero instances behind generation 1 -- the caught-up
    // instance is not touched, and cin_gen_behind (already at 1) is not
    // touched again either.
    const evolved = generationManifestV2({ display_name: "Generation fixture connector (v2, copy revised)" });
    const manifestsDirV3 = writeManifestsDir(dir, "polyfill-v3", { "generation-fixture.json": evolved });
    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: () => {
        /* intentionally empty */
      },
      manifestsDir: manifestsDirV3,
      referenceFixturesDir: writeManifestsDir(dir, "reference-v3", {}),
    });

    assert.equal(summary.updated, 1, "manifest copy edit still re-registers");
    assert.equal(
      summary.invalidatedConnectors,
      0,
      "no instance is behind generation 1 -- the caught-up sibling must NOT be invalidated"
    );
    assert.equal(summary.invalidatedRecords, 0);
    assert.equal(
      recordCount(GENERATION_STORAGE_CONNECTOR_ID),
      1,
      "the caught-up instance's current-generation record survives untouched"
    );
    assert.equal(recordIdentityGeneration("cin_gen_behind"), 1, "already-reconciled sibling checkpoint is unchanged");
    assert.equal(recordIdentityGeneration("cin_gen_caught_up"), 1, "caught-up instance checkpoint is unchanged");

    // Prove the sibling is not just present in the DB but genuinely still
    // collectable (not left in some half-torn-down state).
    await ingestRecordForInstance(
      { connector_id: GENERATION_STORAGE_CONNECTOR_ID, connector_instance_id: "cin_gen_caught_up" },
      {
        data: { content: "still collectable", id: "current-scheme:1" },
        emitted_at: "2026-06-07T09:15:22Z",
        key: "current-scheme:1",
        stream: "items",
      }
    );
    assert.equal(recordCount(GENERATION_STORAGE_CONNECTOR_ID), 2, "caught-up instance remains fully collectable");
  })
);

test(
  "reconciliation does NOT invalidate an unrelated connector's records when a different connector declares record_identity.generation",
  withTmpDb(async ({ dir }) => {
    const otherConnectorId = "some-other-connector";
    await registerConnector(generationManifestV1({ connector_id: otherConnectorId, connector_key: otherConnectorId }));
    await seedGenerationInstance("cin_other", "other@example.com", otherConnectorId);
    await ingestRecordForInstance(
      { connector_id: otherConnectorId, connector_instance_id: "cin_other" },
      {
        data: { content: "hi", id: "unrelated:0" },
        emitted_at: "2026-06-05T09:15:22Z",
        key: "unrelated:0",
        stream: "items",
      }
    );
    assert.equal(recordCount(otherConnectorId), 1);

    // A DIFFERENT connector (generation-fixture) declares generation 1 in
    // this same reconcile pass; the unrelated connector's own manifest is
    // untouched (still generation 0 implicitly) and must not be affected.
    const manifestsDir = writeManifestsDir(dir, "polyfill", {
      "generation-fixture.json": generationManifestV2(),
    });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

    const summary = await reconcilePolyfillManifests({
      enabled: true,
      log: () => {
        /* intentionally empty */
      },
      manifestsDir,
      referenceFixturesDir,
    });

    // generation-fixture.json is unlisted (no capabilities.public_listing),
    // so reconciliation skips auto-registering it rather than updating it
    // -- irrelevant to what this test proves either way.
    assert.equal(summary.skipped, 1, "generation-fixture is unlisted and not yet registered, so it is skipped");
    assert.equal(summary.invalidatedConnectors, 0, "an unrelated connector must not be touched");
    assert.equal(summary.invalidatedRecords, 0);
    assert.equal(recordCount(otherConnectorId), 1, "the unrelated connector's record survives");
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
    assert.equal(summary.unchanged, 1, "storage-normalized byte-identical manifests are unchanged");
    assert.equal(summary.updated, 0, "an unchanged manifest does not re-register or backfill records");
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
    // `capabilities.public_listing.tier: "supported"`, so reconciliation MUST
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
    // `capabilities.public_listing.tier: "supported"` must be present in the
    // connectors table on startup so `GET /_ref/connectors` and the
    // reference dashboard can surface it before the first schedule or run
    // row exists. See
    // openspec/changes/add-connector-public-listing-honesty/.
    const listedManifest = shippedPolyfillManifest({
      capabilities: {
        public_listing: { tier: "supported" },
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
    assert.equal(persisted.capabilities?.public_listing?.tier, "supported");

    const registeredLine = lines.find((line) => line.includes("registered listed first-party manifest"));
    assert.ok(registeredLine, "reconciliation emits a register log line");
    assert.match(registeredLine, REGEXP_3);
  })
);

test(
  "explicit UAT reconciliation registers an unlisted shipped manifest without changing the default",
  withTmpDb(async ({ dir }) => {
    const manifestsDir = writeManifestsDir(dir, "polyfill", {
      "seed-flip.json": shippedPolyfillManifest({
        capabilities: { public_listing: { tier: "development" } },
      }),
    });
    const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

    const summary = await reconcilePolyfillManifests({
      enabled: true,
      includeUnlisted: true,
      manifestsDir,
      referenceFixturesDir,
    });

    assert.equal(summary.registered, 1);
    assert.equal(summary.skipped, 0);
    assert.ok(await getConnectorManifest(CONNECTOR_ID));
  })
);

test(
  "explicit UAT reconciliation registers any valid Development manifest",
  withTmpDb(async ({ dir }) => {
    const manifestsDir = writeManifestsDir(dir, "polyfill", {
      "seed-flip.json": shippedPolyfillManifest({
        capabilities: { public_listing: { tier: "development" } },
      }),
    });
    const summary = await reconcilePolyfillManifests({
      enabled: true,
      includeUnlisted: true,
      manifestsDir,
      referenceFixturesDir: writeManifestsDir(dir, "reference", {}),
    });

    assert.equal(summary.registered, 1);
    assert.equal(summary.skipped, 0);
    assert.ok(await getConnectorManifest(CONNECTOR_ID));
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
        public_listing: { tier: "development" },
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
