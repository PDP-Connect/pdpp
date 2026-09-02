// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Polyfill-mode startup manifest reconciliation.
 *
 * The reference persists connector manifests in the DB
 * (`connectors.manifest`). After shipping fixes to a first-party
 * manifest JSON, existing databases must self-heal on next startup —
 * otherwise assistant-critical streams will keep using stale schema
 * declarations (and keep breaking records pagination).
 *
 * Scope:
 *   - Only first-party manifests under
 *     `packages/polyfill-connectors/manifests/` are reconciled. Connectors
 *     that are NOT in this shipped set are left alone so user-custom
 *     manifests are never overwritten.
 *   - Comparison is a deep structural equality against the persisted
 *     manifest; any difference triggers a fresh `registerConnector()`
 *     call, which is idempotent and runs the full validation + lexical
 *     backfill path.
 *
 * Disable for tests by passing `{ enabled: false }` or setting
 * `PDPP_SKIP_MANIFEST_RECONCILE=1` in the environment.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const JSON_EXTENSION_RE = /\.json$/;

// auth.js is still JavaScript; the imported functions are typed
// loosely below since their full signatures land with the auth.js
// migration slice. Until then we narrow the surface used here.
import { getConnectorManifest, normalizeConnectorManifestForStorage, registerConnector } from "./auth.ts";
// records.js is also still JavaScript. The invalidation helper is
// scoped to the reconciliation flip path; see the design notes under
// openspec/changes/reconcile-invalidates-stale-records/.
import {
  deleteAllRecordsForConnector,
  listRecordIdentityGenerationsByConnector,
  setRecordIdentityGeneration,
} from "./records.ts";

// Auth.js wires these as untyped JS functions; until that file
// migrates, we re-declare the narrow shape this module relies on so
// the reconciliation code stays type-checked end to end.
type GetConnectorManifest = (connectorId: string) => Promise<unknown>;
type RegisterConnector = (
  manifest: PolyfillManifest,
  options?: { backfillRetrievalIndexes?: boolean }
) => Promise<unknown>;
type DeleteAllRecordsForConnector = (
  connectorId: string,
  instanceIdFilter?: ReadonlySet<string>
) => Promise<{ deletedCount: number; streams: string[] }>;

const getConnectorManifestTyped: GetConnectorManifest = getConnectorManifest as GetConnectorManifest;
const registerConnectorTyped: RegisterConnector = registerConnector as RegisterConnector;
const deleteAllRecordsForConnectorTyped: DeleteAllRecordsForConnector =
  deleteAllRecordsForConnector as DeleteAllRecordsForConnector;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the shipped polyfill-connectors manifests directory relative
 * to this file's location. Kept explicit so the reference doesn't
 * wander into arbitrary user directories.
 */
export function defaultPolyfillManifestsDir(): string {
  // server/polyfill-manifest-reconcile.ts → ../../packages/polyfill-connectors/manifests
  return resolve(__dirname, "..", "..", "packages", "polyfill-connectors", "manifests");
}

/**
 * Resolve the shipped reference-fixture manifests directory. These are
 * the fixture manifests that the seed connector serves and that
 * `pdpp seed` registers under shared connector_ids (spotify, github,
 * reddit). We only need their fingerprints; we never re-register them
 * here. Kept overridable for tests.
 */
export function defaultReferenceFixturesDir(): string {
  // server/polyfill-manifest-reconcile.ts → ../fixtures/seed-manifests
  return resolve(__dirname, "..", "fixtures", "seed-manifests");
}

// Manifest JSON files are user-authored; we only require a
// `connector_id` to drive the reconciliation key. Everything else is
// passed through to registerConnector unchanged.
export interface PolyfillManifest {
  connector_id?: unknown;
  [field: string]: unknown;
}

async function readManifestJson(path: string): Promise<PolyfillManifest> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as PolyfillManifest;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      const source = v as Record<string, unknown>;
      for (const k of Object.keys(source).sort()) {
        sorted[k] = source[k];
      }
      return sorted;
    }
    return v;
  });
}

function manifestsEqual(a: unknown, b: unknown): boolean {
  if (!(a && b)) {
    return false;
  }
  return canonicalize(a) === canonicalize(b);
}

export interface ReconcileSummary {
  /**
   * Why this run scanned nothing (`scanned === 0`), or `null` when the run
   * actually scanned the manifests dir (whether or not it found any files).
   * Set on every early-return path — disabled by options, disabled by the
   * `PDPP_SKIP_MANIFEST_RECONCILE` env escape hatch, or the manifests dir
   * itself being unavailable — so callers/tests can assert *why* nothing
   * happened instead of inferring it from a bare zero count.
   */
  disabled_reason: string | null;
  errors: number;
  invalidatedConnectors: number;
  invalidatedRecords: number;
  registered: number;
  scanned: number;
  skipped: number;
  unchanged: number;
  updated: number;
}

export interface ReconcileOptions {
  enabled?: boolean;
  /** Register shipped unlisted manifests for an explicit UAT deployment. */
  includeUnlisted?: boolean;
  log?: (line: string) => void;
  manifestsDir?: string;
  /**
   * Directory containing the reference-fixture manifests served by the
   * deterministic seed connector (`reference-implementation/fixtures/seed-manifests/`).
   * Used to detect the narrow fixture→polyfill transition that requires
   * record invalidation. Override only in tests; defaults to the canonical
   * dir resolved from this file's location.
   */
  referenceFixturesDir?: string;
}

interface ManifestFingerprint {
  readonly streams: string;
  readonly version: string;
}

/**
 * Cheap, stable summary of a manifest's identity for shape comparison:
 * `(version, sorted-stream-names)`. Strong enough to distinguish the
 * shipped reference fixture from the shipped polyfill manifest for
 * connectors that share a `connector_id` (spotify/github/reddit), and
 * cheap enough to compute on every reconcile pass.
 *
 * Mirrors `fingerprintManifest` in
 * `reference-implementation/runtime/controller.ts`. Kept duplicated here
 * rather than imported because the controller pulls in runtime types we
 * deliberately keep out of the server reconcile module.
 */
function fingerprintManifest(manifest: unknown): ManifestFingerprint | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const versionRaw = (manifest as { version?: unknown }).version;
  const version = typeof versionRaw === "string" ? versionRaw : "";
  const rawStreams = (manifest as { streams?: unknown }).streams;
  const streamNames: string[] = [];
  if (Array.isArray(rawStreams)) {
    for (const stream of rawStreams) {
      const name = (stream as { name?: unknown } | null)?.name;
      if (typeof name === "string" && name.trim()) {
        streamNames.push(name.trim());
      }
    }
  }
  // biome-ignore lint/suspicious/useArraySortCompare: Input ordering is intentionally the runtime’s established default string order.
  streamNames.sort();
  return { streams: streamNames.join(","), version };
}

function fingerprintsEqual(a: ManifestFingerprint | null, b: ManifestFingerprint | null): boolean {
  return !!(a && b && a.version === b.version && a.streams === b.streams);
}

/**
 * Load the fingerprint of every reference-fixture manifest under
 * `referenceFixturesDir`, keyed by `connector_id`. Errors and malformed
 * files are ignored silently — the worst case is that we miss a
 * fixture→polyfill transition for one connector, which falls back to the
 * conservative no-invalidation behavior.
 */
async function loadReferenceFixtureFingerprints(
  referenceFixturesDir: string
): Promise<Map<string, ManifestFingerprint>> {
  const fingerprints = new Map<string, ManifestFingerprint>();
  let entries: Dirent<string>[];
  try {
    entries = await readdir(referenceFixturesDir, { encoding: "utf8", withFileTypes: true });
  } catch {
    return fingerprints;
  }
  for (const entry of entries) {
    if (!(entry.isFile() && JSON_EXTENSION_RE.test(entry.name))) {
      continue;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      const manifest = await readManifestJson(join(referenceFixturesDir, entry.name));
      const connectorId = manifest.connector_id;
      if (typeof connectorId !== "string" || !connectorId.trim()) {
        continue;
      }
      const fp = fingerprintManifest(manifest);
      if (fp) {
        fingerprints.set(connectorId.trim(), fp);
      }
    } catch {
      // Ignore malformed reference-fixture manifests; they are not
      // load-bearing for the reconcile flow.
    }
  }
  return fingerprints;
}

const EMPTY_SUMMARY: ReconcileSummary = {
  disabled_reason: null,
  errors: 0,
  invalidatedConnectors: 0,
  invalidatedRecords: 0,
  registered: 0,
  scanned: 0,
  skipped: 0,
  unchanged: 0,
  updated: 0,
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Some I/O errors carry a `.code` (`ENOENT`, etc.) on the Error
    // object directly; surface that when present, otherwise fall back
    // to the message.
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
    return err.message;
  }
  return String(err);
}

type ReconcileLog = (line: string) => void;

interface EntryDelta {
  errors?: number;
  invalidatedConnectors?: number;
  invalidatedRecords?: number;
  registered?: number;
  skipped?: number;
  unchanged?: number;
  updated?: number;
}

function applyDelta(summary: ReconcileSummary, delta: EntryDelta): void {
  summary.errors += delta.errors ?? 0;
  summary.invalidatedConnectors += delta.invalidatedConnectors ?? 0;
  summary.invalidatedRecords += delta.invalidatedRecords ?? 0;
  summary.registered += delta.registered ?? 0;
  summary.skipped += delta.skipped ?? 0;
  summary.unchanged += delta.unchanged ?? 0;
  summary.updated += delta.updated ?? 0;
}

async function loadShippedManifest(
  manifestsDir: string,
  entryName: string,
  log: ReconcileLog
): Promise<PolyfillManifest | null> {
  try {
    return await readManifestJson(join(manifestsDir, entryName));
  } catch (err) {
    log(`[manifest-reconcile] skipping malformed manifest ${entryName}: ${errorMessage(err)}`);
    return null;
  }
}

async function invalidatePriorRecords(
  connectorId: string,
  log: ReconcileLog,
  instanceIdFilter?: ReadonlySet<string>
): Promise<{ ok: true; invalidatedConnectors: number; invalidatedRecords: number } | { ok: false }> {
  try {
    const invalidation = await deleteAllRecordsForConnectorTyped(connectorId, instanceIdFilter);
    if (invalidation.deletedCount > 0) {
      log(
        `[manifest-reconcile] invalidated ${connectorId}: ${invalidation.deletedCount} record(s) across streams [${invalidation.streams.join(", ")}] before applying new manifest`
      );
      return { invalidatedConnectors: 1, invalidatedRecords: invalidation.deletedCount, ok: true };
    }
    return { invalidatedConnectors: 0, invalidatedRecords: 0, ok: true };
  } catch (err) {
    log(`[manifest-reconcile] invalidation failed for ${connectorId}: ${errorMessage(err)}`);
    return { ok: false };
  }
}

async function applyShippedManifest(
  shipped: PolyfillManifest,
  connectorId: string,
  entryName: string,
  log: ReconcileLog
): Promise<{ ok: boolean }> {
  try {
    await registerConnectorTyped(shipped, { backfillRetrievalIndexes: false });
    log(`[manifest-reconcile] updated ${connectorId} from ${entryName}`);
    return { ok: true };
  } catch (err) {
    // Include the validation detail, not just the error code. A bare
    // "invalid_request" names the class of failure and nothing about which
    // field caused it, so a manifest that the registry rejects gives an
    // operator no way to fix it -- diagnosing one such rejection on
    // 2026-08-17 took several build-and-deploy cycles of guessing.
    const detail = (err as { param?: unknown })?.param;
    log(
      `[manifest-reconcile] update failed for ${connectorId}: ${errorMessage(err)}` +
        (detail ? ` (param: ${String(detail)})` : "") +
        (err instanceof Error && err.message ? ` -- ${err.message}` : "")
    );
    return { ok: false };
  }
}

interface EntryContext {
  includeUnlisted: boolean;
  log: ReconcileLog;
  manifestsDir: string;
  referenceFixtureFingerprints: Map<string, ManifestFingerprint>;
}

/**
 * Decide whether the persisted→shipped diff represents the narrow
 * fixture→polyfill transition that requires record invalidation.
 *
 * The criterion is conservative: invalidation fires only when the
 * persisted manifest's `(version, sorted-stream-names)` fingerprint
 * matches the shipped reference-fixture manifest's fingerprint for the
 * same connector_id, AND the shipped polyfill manifest has a different
 * fingerprint. This is the exact shape of `pdpp seed`'s footprint, and
 * the only case where the persisted records were emitted by the seed
 * connector against fixture identities. Ordinary polyfill manifest
 * evolution (adding semantic_fields, fixing a description, adding a
 * stream view) trips the structural diff but NOT the fingerprint
 * transition, so records are preserved.
 */
/**
 * Read a manifest's own declared `capabilities.record_identity.generation`
 * — an integer a connector AUTHOR bumps when their record_key derivation
 * changes in a way that breaks idempotency against previously-emitted
 * records (see B2 in the manual-upload-large-artifact task report for a
 * worked example). Absent/malformed resolves to 0, matching a legacy
 * manifest that never declared this field.
 *
 * RI holds NO knowledge of what a "record-identity-generation transition"
 * means for any specific connector; this function only extracts a plain
 * integer from a manifest object. All connector-specific semantics
 * (chatId schemes, content-hash message ids, whatever a future connector
 * invents) live entirely in that connector's own manifest + code, never
 * in RI.
 */
function declaredRecordIdentityGeneration(manifest: unknown): number {
  const capabilitiesRaw = (manifest as { capabilities?: unknown } | null)?.capabilities;
  if (!capabilitiesRaw || typeof capabilitiesRaw !== "object" || Array.isArray(capabilitiesRaw)) {
    return 0;
  }
  const recordIdentityRaw = (capabilitiesRaw as { record_identity?: unknown }).record_identity;
  if (!recordIdentityRaw || typeof recordIdentityRaw !== "object" || Array.isArray(recordIdentityRaw)) {
    return 0;
  }
  const generationRaw = (recordIdentityRaw as { generation?: unknown }).generation;
  return typeof generationRaw === "number" && Number.isInteger(generationRaw) && generationRaw >= 0 ? generationRaw : 0;
}

/**
 * Reconcile every instance of `connectorId` against the shipped manifest's
 * declared record-identity generation. For each instance whose OWN
 * `record_identity_generation` checkpoint is behind the shipped value:
 * invalidate ONLY that instance's records (via `deleteAllRecordsForConnector`'s
 * `instanceIdFilter`, never the whole connector type), then advance its
 * checkpoint to the shipped generation. Instances already caught up are
 * left completely untouched — no read, no write, no fence. Instances that
 * are AHEAD (shipped generation lower than an instance's checkpoint, e.g. a
 * manifest rollback) are also left untouched: this function only closes a
 * behind-checkpoint gap, it never regresses one.
 *
 * A connector that has never declared this field, and a shipped manifest
 * that still doesn't declare it either, is the (0, 0) steady state: every
 * instance's checkpoint is 0, the shipped generation is 0, nothing is ever
 * behind, so this reconcile pass is a pure no-op for every connector that
 * doesn't use the mechanism. Bumping the shipped manifest's declared
 * generation is the ONLY way to opt an instance in; ordinary manifest
 * evolution (new streams, semantic_fields, description fixes) never
 * touches `capabilities.record_identity.generation` and so never
 * invalidates anything.
 */
// Test-only, opt-in delay between reading each instance's checkpoint and
// acting on it (delete + advance) — widens the read-then-write window a
// concurrent-reconcile race must land in to be deterministically
// reproducible rather than a timing-luck flake, matching
// testOnlyUpsertTombstoneCheckDelay in connector-instance-store.ts. A
// complete no-op unless PDPP_TEST_RECORD_IDENTITY_RECONCILE_DELAY_MS is set
// to a positive integer (never set in production). See
// test/polyfill-manifest-reconcile-invalidation-postgres.test.ts.
async function testOnlyRecordIdentityReconcileDelay(): Promise<void> {
  const raw = process.env.PDPP_TEST_RECORD_IDENTITY_RECONCILE_DELAY_MS;
  const ms = raw ? Number.parseInt(raw, 10) : 0;
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await new Promise((done) => setTimeout(done, ms));
}

async function reconcileRecordIdentityGeneration(
  connectorId: string,
  shippedGeneration: number,
  log: ReconcileLog
): Promise<{ ok: boolean; invalidatedConnectors: number; invalidatedRecords: number }> {
  if (shippedGeneration <= 0) {
    return { invalidatedConnectors: 0, invalidatedRecords: 0, ok: true };
  }
  let instances: Array<{ connectorInstanceId: string; generation: number }>;
  try {
    instances = await listRecordIdentityGenerationsByConnector(connectorId);
  } catch (err) {
    log(`[manifest-reconcile] record-identity-generation lookup failed for ${connectorId}: ${errorMessage(err)}`);
    return { invalidatedConnectors: 0, invalidatedRecords: 0, ok: false };
  }
  await testOnlyRecordIdentityReconcileDelay();
  const behindInstanceIds = new Set(
    instances
      .filter((instance) => instance.generation < shippedGeneration)
      .map((instance) => instance.connectorInstanceId)
  );
  if (behindInstanceIds.size === 0) {
    return { invalidatedConnectors: 0, invalidatedRecords: 0, ok: true };
  }
  const invalidation = await invalidatePriorRecords(connectorId, log, behindInstanceIds);
  if (!invalidation.ok) {
    return { invalidatedConnectors: 0, invalidatedRecords: 0, ok: false };
  }
  for (const connectorInstanceId of behindInstanceIds) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential to keep each instance's checkpoint write clearly attributable if one fails.
      await setRecordIdentityGeneration(connectorInstanceId, shippedGeneration);
    } catch (err) {
      log(
        `[manifest-reconcile] failed to advance record_identity_generation for instance ${connectorInstanceId}: ${errorMessage(err)}`
      );
      return {
        invalidatedConnectors: invalidation.invalidatedConnectors,
        invalidatedRecords: invalidation.invalidatedRecords,
        ok: false,
      };
    }
  }
  log(
    `[manifest-reconcile] advanced record_identity_generation to ${shippedGeneration} for ${behindInstanceIds.size} instance(s) of ${connectorId}`
  );
  return {
    invalidatedConnectors: invalidation.invalidatedConnectors,
    invalidatedRecords: invalidation.invalidatedRecords,
    ok: true,
  };
}

function isFixtureToPolyfillTransition(
  connectorId: string,
  persisted: unknown,
  shipped: PolyfillManifest,
  referenceFixtureFingerprints: Map<string, ManifestFingerprint>
): boolean {
  const fixtureFp = referenceFixtureFingerprints.get(connectorId);
  if (!fixtureFp) {
    return false;
  }
  const persistedFp = fingerprintManifest(persisted);
  if (!fingerprintsEqual(persistedFp, fixtureFp)) {
    return false;
  }
  const shippedFp = fingerprintManifest(shipped);
  return !fingerprintsEqual(shippedFp, fixtureFp);
}

/**
 * Supported and Preview manifests are owner-visible and therefore need to be
 * registered on a fresh instance. Development manifests remain absent from
 * the add-connection catalog unless an explicit UAT reconciliation opts in.
 *
 * Catalog honesty: owner-visible manifests must be visible in the catalog
 * even on a fresh database, before any schedule or run row exists. Hidden
 * or unproven manifests stay opaque to the operator until they are
 * explicitly promoted by a manifest edit. See
 * openspec/changes/add-connector-public-listing-honesty/.
 */
function isPubliclyListedShippedManifest(manifest: PolyfillManifest): boolean {
  const capabilitiesRaw = (manifest as { capabilities?: unknown }).capabilities;
  if (!capabilitiesRaw || typeof capabilitiesRaw !== "object" || Array.isArray(capabilitiesRaw)) {
    return false;
  }
  const publicListingRaw = (capabilitiesRaw as { public_listing?: unknown }).public_listing;
  if (!publicListingRaw || typeof publicListingRaw !== "object" || Array.isArray(publicListingRaw)) {
    return false;
  }
  const tier = (publicListingRaw as { tier?: unknown }).tier;
  return tier === "supported" || tier === "preview";
}

function isUnprovenShippedManifest(manifest: PolyfillManifest): boolean {
  const capabilities = (manifest as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return false;
  }
  const listing = (capabilities as { public_listing?: unknown }).public_listing;
  if (!listing || typeof listing !== "object" || Array.isArray(listing)) {
    return false;
  }
  return (listing as { tier?: unknown }).tier === "development";
}

type ManifestEntryBranch =
  | { kind: "invalid"; delta: EntryDelta }
  | { kind: "valid"; shipped: PolyfillManifest; connectorId: string };

function validateOrReconcileInvalidManifestEntry(shipped: PolyfillManifest | null): ManifestEntryBranch {
  if (!shipped) {
    return { delta: { errors: 1 }, kind: "invalid" };
  }
  const connectorIdRaw = shipped.connector_id;
  if (typeof connectorIdRaw !== "string" || connectorIdRaw.length === 0) {
    return { delta: { skipped: 1 }, kind: "invalid" };
  }
  return { connectorId: connectorIdRaw, kind: "valid", shipped };
}

async function reconcileInvalidPersistedManifestEntry(
  shipped: PolyfillManifest,
  connectorId: string,
  entryName: string,
  log: ReconcileLog
): Promise<EntryDelta> {
  const registration = await applyShippedManifest(shipped, connectorId, entryName, log);
  return {
    errors: registration.ok ? 0 : 1,
    updated: registration.ok ? 1 : 0,
  };
}

async function reconcileMissingManifestEntry(
  shipped: PolyfillManifest,
  connectorId: string,
  entryName: string,
  ctx: Pick<EntryContext, "includeUnlisted" | "log">
): Promise<EntryDelta> {
  const isListed = isPubliclyListedShippedManifest(shipped);
  const isUatCandidate = ctx.includeUnlisted && isUnprovenShippedManifest(shipped);
  if (!(isListed || isUatCandidate)) {
    return { skipped: 1 };
  }
  const registration = await applyShippedManifest(shipped, connectorId, entryName, ctx.log);
  if (!registration.ok) {
    return { errors: 1 };
  }
  ctx.log(
    `[manifest-reconcile] registered ${isListed ? "listed" : "UAT"} first-party manifest ${connectorId} from ${entryName}`
  );
  return { registered: 1 };
}

function reconcileUnchangedManifestEntry(): EntryDelta {
  return { unchanged: 1 };
}

async function reconcileChangedManifestEntry(
  shipped: PolyfillManifest,
  persisted: unknown,
  connectorId: string,
  entryName: string,
  ctx: EntryContext
): Promise<EntryDelta> {
  const fixtureTransition = isFixtureToPolyfillTransition(
    connectorId,
    persisted,
    shipped,
    ctx.referenceFixtureFingerprints
  );
  let invalidatedConnectors = 0;
  let invalidatedRecords = 0;
  if (fixtureTransition) {
    const invalidation = await invalidatePriorRecords(connectorId, ctx.log);
    if (!invalidation.ok) {
      return { errors: 1 };
    }
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    invalidatedConnectors = invalidation.invalidatedConnectors;
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    invalidatedRecords = invalidation.invalidatedRecords;
  }
  // Generic, connector-agnostic record-identity-generation reconcile: runs
  // independently of the fixture-transition check above (both can fire on
  // the same pass; `deleteAllRecordsForConnector`'s per-instance fencing
  // makes a second, instance-filtered invalidation call safe even if the
  // fixture-transition branch above already touched this connector type).
  const shippedGeneration = declaredRecordIdentityGeneration(shipped);
  const generationReconcile = await reconcileRecordIdentityGeneration(connectorId, shippedGeneration, ctx.log);
  if (!generationReconcile.ok) {
    return { errors: 1, invalidatedConnectors, invalidatedRecords };
  }
  invalidatedConnectors += generationReconcile.invalidatedConnectors;
  invalidatedRecords += generationReconcile.invalidatedRecords;
  const registration = await applyShippedManifest(shipped, connectorId, entryName, ctx.log);
  return {
    errors: registration.ok ? 0 : 1,
    invalidatedConnectors,
    invalidatedRecords,
    updated: registration.ok ? 1 : 0,
  };
}

async function reconcileEntry(entryName: string, ctx: EntryContext): Promise<EntryDelta> {
  const shipped = await loadShippedManifest(ctx.manifestsDir, entryName, ctx.log);
  const loadedEntry = validateOrReconcileInvalidManifestEntry(shipped);
  if (loadedEntry.kind === "invalid") {
    return loadedEntry.delta;
  }
  const { connectorId } = loadedEntry;
  let persisted: unknown;
  try {
    persisted = await getConnectorManifestTyped(connectorId);
  } catch (err) {
    ctx.log(`[manifest-reconcile] lookup failed for ${connectorId}: ${errorMessage(err)}`);
    // A persisted first-party manifest can become invalid after the
    // reference tightens manifest validation (for example when a query
    // capability is removed or renamed). Treat that as a repairable
    // stale-row condition for shipped manifests: overwrite the DB row with
    // the checked-in manifest instead of letting the stale row poison
    // scheduler startup. Do not invalidate records here; we cannot safely
    // fingerprint an invalid persisted manifest, and ordinary capability
    // metadata repairs should preserve owner data.
    return reconcileInvalidPersistedManifestEntry(loadedEntry.shipped, connectorId, entryName, ctx.log);
  }
  if (!persisted) {
    // Connector not yet registered. Reconciliation is primarily about
    // repairing existing DB rows, but the operator catalog must also be
    // honest about which first-party manifests claim to be listable.
    // Register listed=true shipped manifests so the operator catalog can
    // show them on a fresh database before any schedule or run row
    // exists. Hidden / unproven manifests stay unregistered until they
    // are exercised (or explicitly promoted to listed=true via a future
    // manifest edit).
    //
    // Safety: this branch only runs for files inside the first-party
    // shipped manifests dir, so user-custom connectors are never
    // auto-seeded by reconciliation. Registration is NOT schedule
    // enablement — schedules still require an explicit operator action,
    // and the scheduler eligibility filter (refresh_policy.background_safe)
    // continues to gate background runs independently.
    return reconcileMissingManifestEntry(loadedEntry.shipped, connectorId, entryName, ctx);
  }
  const { storedManifest } = normalizeConnectorManifestForStorage(loadedEntry.shipped);
  if (manifestsEqual(storedManifest, persisted)) {
    return reconcileUnchangedManifestEntry();
  }
  // Default path: the manifest changed shape but the diff is ordinary
  // polyfill evolution (description, semantic_fields, schema additions,
  // stream views). Re-register without touching records — owner data is
  // preserved across manifest fixes.
  //
  // Narrow exception: when the persisted manifest fingerprint matches a
  // reference-fixture fingerprint AND the shipped polyfill fingerprint
  // is different, the records currently in the RS were emitted by the
  // seed connector against fixture identities (Taylor Swift, Adele,
  // seedowner/personal-site, ...). Those records are safe to drop and
  // unsafe to advertise as fresh real data. Spec:
  // openspec/changes/reconcile-invalidates-stale-records/.
  return reconcileChangedManifestEntry(loadedEntry.shipped, persisted, connectorId, entryName, ctx);
}

/**
 * Reconcile persisted connector manifests against the shipped
 * first-party set. Returns a summary counter for the caller's log.
 */
export async function reconcilePolyfillManifests(opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const {
    enabled = true,
    includeUnlisted = false,
    manifestsDir = defaultPolyfillManifestsDir(),
    referenceFixturesDir = defaultReferenceFixturesDir(),
    log = () => {
      /* default no-op logger */
    },
  } = opts;
  if (!enabled) {
    log("[manifest-reconcile] disabled by options");
    return { ...EMPTY_SUMMARY, disabled_reason: "disabled_by_options" };
  }
  if (process.env.PDPP_SKIP_MANIFEST_RECONCILE === "1") {
    log("[manifest-reconcile] skipped: PDPP_SKIP_MANIFEST_RECONCILE=1");
    return { ...EMPTY_SUMMARY, disabled_reason: "env_skip" };
  }

  // readdir's TS overload defaults the dirent buffer parameter to
  // NonSharedBuffer. We pass the encoding explicitly so the result
  // is typed as `Dirent<string>[]`, which is what the rest of this
  // function operates on (entry.name is a string).
  let entries: Dirent<string>[];
  try {
    entries = await readdir(manifestsDir, { encoding: "utf8", withFileTypes: true });
  } catch (err) {
    log(`[manifest-reconcile] manifests dir unavailable: ${errorMessage(err)}`);
    return { ...EMPTY_SUMMARY, disabled_reason: "manifests_dir_unavailable" };
  }

  const referenceFixtureFingerprints = await loadReferenceFixtureFingerprints(referenceFixturesDir);
  const ctx: EntryContext = { includeUnlisted, log, manifestsDir, referenceFixtureFingerprints };
  const summary: ReconcileSummary = { ...EMPTY_SUMMARY };

  for (const entry of entries) {
    if (!(entry.isFile() && JSON_EXTENSION_RE.test(entry.name))) {
      continue;
    }
    summary.scanned += 1;
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    applyDelta(summary, await reconcileEntry(entry.name, ctx));
  }
  return summary;
}
