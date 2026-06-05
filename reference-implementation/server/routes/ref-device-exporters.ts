// HTTP adapter for the reference-only `/_ref/device-exporters` route family —
// enrollment-codes, enroll, list, source-instances, diagnostics, revoke,
// heartbeat, ingest-batches, source-instance state, and local-collector-gaps.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§2.6). Each `mount...`
// function registers one route or one closely-related route pair at the same
// point in registration order where `server/index.js` previously registered
// it inline. Owner-session posture, device-credential posture, contract
// metadata, response envelopes, status codes, error mapping, and middleware
// order are unchanged.
//
// Module-level helpers (`optionalObject`, `requireNonEmptyString`,
// `hashDeviceSecret`, `sanitize*`, `normalizeHeartbeat*`,
// `normalizeDeviceIngestRecords`, `referenceLocalDeviceStorageTarget`,
// `sameConnectorType`, `deviceExporterSourceBindingIdentity`,
// `buildDeviceExporterDiagnostics`, `deriveSourceInstanceOutboxState`,
// `resolveAuthorizedDeviceSource`) move here from `server/index.js` because
// all their call sites are within this route family. Infrastructure reads
// (store access, connector instance store, gap store, sync state, record
// ingest, canonical connector key, connector instance source binding key)
// are host-injected via ctx so the adapter never imports the substrate
// directly.

import { deriveReferenceFreshness } from "../freshness.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";
import {
  type EnrolledSourceKind,
  resolveEnrolledSourceKind,
  type SourceKindManifestLike,
} from "./connector-source-kind.ts";

interface RouteRequest {
  readonly body?: unknown;
  deviceExporter?: DeviceRow;
  deviceExporterCredential?: CredentialRow;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  end(): unknown;
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  put(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

// ─── Minimal substrate shapes ────────────────────────────────────────────────

interface DeviceRow {
  readonly collectorProtocolVersion?: string | null;
  readonly createdAt: string;
  readonly deviceId: string;
  readonly displayName: string | null;
  readonly lastError?: unknown;
  readonly lastHeartbeatAt?: string | null;
  readonly ownerSubjectId: string;
  readonly revokedAt?: string | null;
  readonly status: string;
  readonly updatedAt: string;
}

interface CredentialRow {
  readonly credentialId: string;
  readonly deviceId: string;
  readonly status: string;
}

interface SourceInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string | null;
  readonly createdAt: string;
  readonly deviceId: string;
  readonly displayName: string | null;
  readonly lastError?: unknown;
  readonly lastHeartbeatAt?: string | null;
  readonly lastHeartbeatStatus?: string | null;
  readonly localBindingId: string;
  readonly outboxDiagnostics?: unknown;
  readonly recordsPending?: number | null;
  readonly sourceInstanceId: string;
  readonly status?: string;
  readonly updatedAt: string;
}

interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly ownerSubjectId: string;
  readonly sourceBindingKey?: string | null;
  readonly sourceKind?: string | null;
  readonly status: string;
}

interface BatchOutcomeRow {
  readonly bodyHash: string;
  readonly createdAt: string;
  readonly response?: { accepted_record_count?: number; rejected_record_count?: number } | null;
  readonly sourceInstanceId: string;
  readonly status: string;
}

interface GapRow {
  readonly attempt_count: number;
  readonly discovered_run_id?: string | null;
  readonly gap_id: string;
  readonly last_run_id?: string | null;
  readonly reason?: string;
  readonly source?: unknown;
  readonly status: string;
  readonly stream: string;
  readonly updated_at: string;
}

interface StorageTarget {
  readonly connector_id: string;
  readonly connector_instance_id: string;
}

interface SyncStateProjection {
  readonly state?: Record<string, unknown> | null;
  readonly updated_at?: string | null;
}

interface DeviceExporterStore {
  consumeEnrollmentCode(enrollmentCodeId: string, deviceId: string, at: string): Promise<boolean>;
  createCredential(params: {
    credentialId: string;
    deviceId: string;
    tokenHash: string;
    createdAt: string;
  }): Promise<void>;
  createDevice(params: {
    deviceId: string;
    ownerSubjectId: string;
    displayName: string;
    collectorProtocolVersion: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  createEnrollmentCode(params: {
    enrollmentCodeId: string;
    codeHash: string;
    ownerSubjectId: string;
    connectorId: string;
    localBindingId: string;
    displayName: string | null;
    createdAt: string;
    expiresAt: string;
  }): Promise<void>;
  findCredentialByTokenHash(hash: string): Promise<CredentialRow | null>;
  findEnrollmentByCodeHash(hash: string): Promise<{
    enrollmentCodeId: string;
    ownerSubjectId: string;
    connectorId: string;
    localBindingId: string;
    displayName: string | null;
    status: string;
    expiresAt: string;
  } | null>;
  getBatchOutcome(
    deviceId: string,
    batchId: string
  ): Promise<{ bodyHash: string; response?: BatchOutcomeRow["response"] } | null>;
  getDevice(deviceId: string): Promise<DeviceRow | null>;
  getSourceInstance(deviceId: string, sourceInstanceId: string): Promise<SourceInstanceRow | null>;
  listBatchOutcomes(options: { limit: number }): Promise<BatchOutcomeRow[]>;
  listDevices(ownerSubjectId: string): Promise<DeviceRow[]>;
  listSourceInstances(): Promise<SourceInstanceRow[]>;
  markCredentialUsed(credentialId: string, at: string): Promise<void>;
  markDeviceHeartbeat(
    deviceId: string,
    params: { receivedAt: string; agentVersion: string | null; lastError: unknown }
  ): Promise<void>;
  markSourceInstanceHeartbeat(
    deviceId: string,
    sourceInstanceId: string,
    params: {
      receivedAt: string;
      lastError: unknown;
      status: string | null;
      recordsPending: number | null;
      outboxDiagnostics: unknown;
    }
  ): Promise<void>;
  recordBatchOutcome(params: {
    deviceId: string;
    batchId: string;
    bodyHash: string;
    sourceInstanceId: string;
    status: string;
    httpStatus: number;
    response: unknown;
    createdAt: string;
  }): Promise<void>;
  revokeDevice(deviceId: string, at: string): Promise<void>;
  revokeEnrollmentCode(id: string, at: string): Promise<void>;
  upsertSourceInstance(params: {
    sourceInstanceId: string;
    deviceId: string;
    connectorId: string;
    connectorInstanceId: string;
    localBindingId: string;
    displayName: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
}

interface ConnectorInstanceStore {
  get(connectorInstanceId: string): Promise<ConnectorInstanceRow | null>;
  getByBinding(params: {
    ownerSubjectId: string;
    connectorId: string;
    sourceKind: string;
    sourceBindingKey: string;
  }): Promise<ConnectorInstanceRow | null>;
  listByOwner(ownerSubjectId: string): Promise<ConnectorInstanceRow[]>;
  updateStatus(
    connectorInstanceId: string,
    params: { status: string; updatedAt: string; revokedAt: string }
  ): Promise<void>;
  upsert(params: {
    ownerSubjectId: string;
    connectorId: string;
    displayName: string;
    status: string;
    sourceKind: string;
    sourceBindingKey: string;
    sourceBinding: unknown;
    createdAt: string;
    updatedAt: string;
  }): Promise<ConnectorInstanceRow>;
}

interface ConnectorDetailGapStore {
  listPendingGaps?(options: {
    connectorId: string;
    connectorInstanceId: string;
    grantId?: string | null;
    limit?: number;
    streams?: readonly string[] | null;
  }): Promise<GapRow[]>;
  listPendingGapsForConnector?(connectorId: string, options: { limit: number }): Promise<GapRow[]>;
  markGapStatus(gapId: string, status: string, options: { runId?: string }): Promise<GapRow>;
  upsertPendingGap(params: {
    connectorId: string;
    connectorInstanceId: string;
    stream: string;
    source: unknown;
    detailLocator: unknown;
    reason: string;
    lastError: unknown;
    discoveredRunId?: string;
    lastRunId?: string;
  }): Promise<GapRow>;
}

export interface MountRefDeviceExportersContext {
  acceptedCollectorProtocolVersions: readonly string[];

  // Canonical key resolution
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;

  // Error class for batch conflict detection
  DeviceBatchConflictError: new (
    message: string
  ) => Error;

  // Stores (created fresh per-request, matching existing pattern)
  deviceExporterStore: DeviceExporterStore;

  // Collector protocol enforcement (returns true if 409 was written)
  enforceCollectorProtocolVersion(req: unknown, res: unknown): boolean;

  // Catalog entry registration at enroll time
  ensureReferenceConnectorCatalogEntry(connectorId: string, displayName: string | null): Promise<void>;
  generateReferenceSecret(prefix: string, bytes: number): string;

  // ID generation
  generateSpineId(prefix: string): string;
  // Resolves a registered connector manifest by key, or `null` for an unknown
  // connector. Used to derive the enrolled source kind from the manifest
  // bindings. Async to match the host's `getConnectorManifest`.
  getConnectorManifest(connectorId: string): Promise<SourceKindManifestLike | null> | SourceKindManifestLike | null;
  getDefaultConnectorDetailGapStore(): ConnectorDetailGapStore;
  getOwnerSubjectId(req: unknown): string;
  getSyncState(storageTarget: StorageTarget, options: { grantId: null }): Promise<SyncStateProjection>;
  handleError(res: unknown, err: unknown): void;

  // Hashing and sanitization
  hashDeviceSecret(value: string): string;

  // Record ingest and sync state
  ingestRecord(storageTarget: StorageTarget, record: unknown): Promise<void>;

  // Safe local-collector coverage read (Section 5.3). Returns only the
  // `{ store, stream, status }` triple per store — never paths, payloads,
  // the coverage `reason` text, or secrets.
  listLocalCoverageDiagnostics(storageTarget: StorageTarget): Promise<LocalCoverageRow[]>;
  makeConnectorInstanceSourceBindingKey(identity: { kind: string; local_binding_name: string }): string;
  pdppError: PdppErrorFn;
  putSyncState(
    storageTarget: StorageTarget,
    stateMap: Record<string, unknown>,
    options: { grantId: null }
  ): Promise<SyncStateProjection>;
  readCollectorProtocolHeader(headers: unknown): string | null;
  // Resolves a local-collector catalog manifest (claude-code, codex) by key, or
  // `null` for connectors not in the local-collector catalog. Mirrors the
  // intent route so the enroll path classifies a local-collector connector even
  // before any registered connector manifest exists.
  readReferenceLocalConnectorCatalogManifest(connectorId: string): SourceKindManifestLike | null;
  requireDeviceExporterCredential: MiddlewareHandler;
  // Auth middleware
  requireOwnerSession: MiddlewareHandler;
  sanitizeDeviceExporterDiagnostic(value: unknown, depth?: number): unknown;
  sanitizeLocalCollectorGapDetails(value: unknown): string | null;
}

// ─── Module-level helpers moved from server/index.js ────────────────────────
// All call sites are within this route family; the implementations are
// identical to the originals.

function optionalObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function requireNonEmptyString(value: unknown, param: string): string {
  if (typeof value !== "string" || !value.trim()) {
    const err = new Error(`${param} is required`) as Error & { code: string; param: string };
    err.code = "invalid_request";
    err.param = param;
    throw err;
  }
  return value.trim();
}

function referenceLocalDeviceStorageTarget(
  ctx: MountRefDeviceExportersContext,
  connectorId: string,
  connectorInstanceId: string
): StorageTarget {
  const connectorKey = ctx.canonicalConnectorKey(connectorId) ?? connectorId;
  return { connector_id: connectorKey, connector_instance_id: connectorInstanceId };
}

function sameConnectorType(ctx: MountRefDeviceExportersContext, a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const ka = ctx.canonicalConnectorKey(a) ?? a;
  const kb = ctx.canonicalConnectorKey(b) ?? b;
  return ka === kb;
}

// The source-binding identity for a device-exporter enrollment. `kind` defaults
// to `local_device` so the legacy binding-fallback resolution paths (which only
// fire for older rows whose `connector_instance_id` column is null and which are
// always filesystem-collected) keep their existing behaviour. The enroll write
// path passes the manifest-resolved kind explicitly so a `browser_collector`
// binding is namespaced under its own source kind.
function deviceExporterSourceBindingIdentity(
  localBindingName: string,
  kind: EnrolledSourceKind = "local_device"
): {
  kind: EnrolledSourceKind;
  local_binding_name: string;
} {
  return { kind, local_binding_name: localBindingName };
}

// Resolve the manifest for a connector being enrolled, then derive the enrolled
// source kind from its bindings. Resolves the local-collector catalog first (so
// claude-code/codex classify before any registered manifest exists), then falls
// back to a registered connector manifest — mirroring the intent route's
// resolution order so enroll and intent agree on the same manifest-derived
// signal. Throws `SourceKindResolutionError` (mapped to 400 by `handleError`)
// when the source kind cannot be resolved or a requested kind contradicts the
// manifest. See add-browser-collector-enrollment-primitive design Decision 2.
async function resolveEnrollmentSourceKind(
  ctx: MountRefDeviceExportersContext,
  connectorKey: string,
  requestedSourceKind?: string | null
): Promise<EnrolledSourceKind> {
  const localManifest = ctx.readReferenceLocalConnectorCatalogManifest(connectorKey);
  const manifest = localManifest ?? (await ctx.getConnectorManifest(connectorKey));
  return resolveEnrolledSourceKind({ connectorId: connectorKey, manifest, requestedSourceKind });
}

// Read `capabilities.refresh_policy.maximum_staleness_seconds` off a connector
// manifest, returning a positive number of seconds or `null`. This is the same
// policy value the connection-health freshness projection consumes in
// `ref-control.ts` (`getMaximumStalenessSeconds`); the admin device-exporter
// staleness badge reads it from here so the two surfaces agree on when a
// collector is overdue rather than the badge hard-coding its own window.
function extractManifestMaximumStalenessSeconds(manifest: unknown): number | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const caps = (manifest as { capabilities?: unknown }).capabilities;
  if (!caps || typeof caps !== "object") {
    return null;
  }
  const refreshPolicy = (caps as { refresh_policy?: unknown }).refresh_policy;
  if (!refreshPolicy || typeof refreshPolicy !== "object" || Array.isArray(refreshPolicy)) {
    return null;
  }
  const value = (refreshPolicy as { maximum_staleness_seconds?: unknown }).maximum_staleness_seconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// Resolve the manifest-declared maximum-staleness window (seconds) for a
// connector key, mirroring `resolveEnrollmentSourceKind`'s resolution order:
// the local-collector catalog first (claude-code/codex), then a registered
// connector manifest. Returns `null` when no manifest resolves or the manifest
// declares no positive `maximum_staleness_seconds`, so the caller can keep an
// honest "unknown" posture instead of inventing a freshness window.
async function resolveConnectorMaximumStalenessSeconds(
  ctx: MountRefDeviceExportersContext,
  connectorId: string
): Promise<number | null> {
  const connectorKey = ctx.canonicalConnectorKey(connectorId) ?? connectorId;
  const localManifest = ctx.readReferenceLocalConnectorCatalogManifest(connectorKey);
  if (localManifest) {
    return extractManifestMaximumStalenessSeconds(localManifest);
  }
  try {
    const manifest = await ctx.getConnectorManifest(connectorKey);
    return extractManifestMaximumStalenessSeconds(manifest);
  } catch {
    return null;
  }
}

// Build a connector-id → maximum-staleness-seconds map for the connectors a set
// of source instances reference. Reads each distinct connector's manifest once.
async function resolveStalenessWindowsByConnector(
  ctx: MountRefDeviceExportersContext,
  connectorIds: Iterable<string>
): Promise<Map<string, number | null>> {
  const windows = new Map<string, number | null>();
  for (const connectorId of new Set(connectorIds)) {
    windows.set(connectorId, await resolveConnectorMaximumStalenessSeconds(ctx, connectorId));
  }
  return windows;
}

// A device hosts one or more source instances, each potentially for a different
// connector. Pick the device's staleness window as the most lenient (largest)
// policy across its source instances: a heartbeat is only "stale" once it
// exceeds the longest legitimate refresh window any of the device's connectors
// declares, so a single short-window connector cannot over-alarm a device whose
// other connectors refresh slowly. Returns `null` when no source instance
// resolves a policy, so the device stays honestly non-stale rather than falling
// back to a hard-coded window.
function deviceMaximumStalenessSeconds(
  sourceList: readonly unknown[],
  windowsByConnector: Map<string, number | null>
): number | null {
  let maxSeconds: number | null = null;
  for (const source of sourceList) {
    const connectorId = (source as { connector_id?: unknown }).connector_id;
    if (typeof connectorId !== "string") {
      continue;
    }
    const seconds = windowsByConnector.get(connectorId) ?? null;
    if (seconds != null && (maxSeconds == null || seconds > maxSeconds)) {
      maxSeconds = seconds;
    }
  }
  return maxSeconds;
}

function deriveSourceInstanceOutboxState(diagnostics: unknown): string {
  if (!diagnostics || typeof diagnostics !== "object") {
    return "unknown";
  }
  const d = diagnostics as Record<string, number | undefined>;
  if ((d.dead_letter ?? 0) > 0) {
    return "dead_letter";
  }
  if ((d.stale_leases ?? 0) > 0) {
    return "stale";
  }
  if ((d.retrying ?? 0) > 0) {
    return "retrying";
  }
  if ((d.pending ?? 0) > 0) {
    return "pending";
  }
  if ((d.backlog_open ?? 0) > 0) {
    return "backlog";
  }
  return "drained";
}

function isDrainedHealthyLocalHeartbeat(status: string | null, recordsPending: number | null, outbox: unknown): boolean {
  return status === "healthy" && (recordsPending == null || recordsPending === 0) && deriveSourceInstanceOutboxState(outbox) === "drained";
}

function isLocalCollectorPolicyBudgetStream(stream: string): boolean {
  return stream === "local-collector/policy_budget" || stream.startsWith("local-collector/policy_budget/");
}

async function recoverDrainedPolicyBudgetGaps(
  ctx: MountRefDeviceExportersContext,
  connectorId: string,
  connectorInstanceId: string
): Promise<void> {
  const detailGapStore = ctx.getDefaultConnectorDetailGapStore();
  if (typeof detailGapStore.listPendingGaps !== "function") {
    return;
  }
  const gaps = await detailGapStore.listPendingGaps({
    connectorId,
    connectorInstanceId,
    grantId: null,
    limit: 500,
  });
  for (const gap of gaps) {
    if (gap.reason === "policy_budget" && isLocalCollectorPolicyBudgetStream(gap.stream)) {
      await detailGapStore.markGapStatus(gap.gap_id, "recovered", {});
    }
  }
}

function normalizeHeartbeatSourceInstances(body: Record<string, unknown>): unknown[] {
  if (Array.isArray(body.source_instances)) {
    return body.source_instances as unknown[];
  }
  if (typeof body.source_instance_id === "string") {
    return [
      {
        source_instance_id: body.source_instance_id,
        last_error: body.last_error ?? null,
        status: typeof body.status === "string" ? body.status : null,
        records_pending: typeof body.records_pending === "number" ? body.records_pending : null,
        outbox: body.outbox ?? null,
      },
    ];
  }
  return [];
}

function normalizeDeviceIngestRecords(body: Record<string, unknown>): unknown[] {
  if (!Array.isArray(body.records) || body.records.length === 0) {
    const err = new Error("records must be a non-empty array") as Error & { code: string; param: string };
    err.code = "invalid_request";
    err.param = "records";
    throw err;
  }
  return (body.records as unknown[]).map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      const err = new Error(`records[${index}] must be an object`) as Error & { code: string; param: string };
      err.code = "invalid_request";
      err.param = "records";
      throw err;
    }
    const r = record as Record<string, unknown>;
    const key = r.record_key ?? r.key;
    if (key == null || (typeof key !== "string" && !Array.isArray(key))) {
      const err = new Error(`records[${index}].record_key is required`) as Error & { code: string; param: string };
      err.code = "invalid_request";
      err.param = "records";
      throw err;
    }
    return {
      stream: requireNonEmptyString(r.stream, `records[${index}].stream`),
      key,
      emitted_at: typeof r.emitted_at === "string" ? r.emitted_at : undefined,
      data: optionalObject(r.data) || {},
    };
  });
}

type GapStatMap = Map<string, { pending: number; lastUpdatedAt: string | null; reasons: Set<string> }>;
type OutcomeStatMap = Map<string, { accepted: number; rejected: number; lastIngestAt: string | null }>;

/** Safe per-store coverage triple read from `coverage_diagnostics` records. */
export interface LocalCoverageRow {
  status: string;
  store: string;
  stream: string | null;
}

/**
 * Per-source-instance local-completeness projection surfaced in the
 * device-exporter diagnostics (Section 5.3). Carries only safe coverage
 * statuses and counts; never raw paths, payloads, reasons, or secrets.
 * `observed` is false when the instance has no coverage records yet (no run
 * has requested `coverage_diagnostics`), so absence reads as absence.
 */
interface LocalCoverageProjection {
  by_store: Record<string, string>;
  counts_by_status: Record<string, number>;
  fully_accounted: boolean;
  observed: boolean;
  store_count: number;
  unaccounted_stores: string[];
}

const COVERAGE_STATUSES = [
  "collected",
  "inventory_only",
  "excluded",
  "deferred",
  "missing",
  "unsupported",
  "unaccounted",
] as const;

function summarizeLocalCoverage(rows: readonly LocalCoverageRow[]): LocalCoverageProjection {
  const countsByStatus: Record<string, number> = {};
  for (const status of COVERAGE_STATUSES) {
    countsByStatus[status] = 0;
  }
  const byStore: Record<string, string> = {};
  const unaccountedStores: string[] = [];
  for (const row of rows) {
    const status = (COVERAGE_STATUSES as readonly string[]).includes(row.status) ? row.status : "unaccounted";
    countsByStatus[status] = (countsByStatus[status] ?? 0) + 1;
    byStore[row.store] = status;
    if (status === "unaccounted") {
      unaccountedStores.push(row.store);
    }
  }
  return {
    by_store: byStore,
    counts_by_status: countsByStatus,
    // `fully_accounted` requires actually observing coverage. An empty
    // coverage set is "nothing seen", not "everything accounted for".
    fully_accounted: rows.length > 0 && unaccountedStores.length === 0,
    observed: rows.length > 0,
    store_count: rows.length,
    unaccounted_stores: unaccountedStores.sort(),
  };
}

function accumulateGapRow(stats: GapStatMap, gap: GapRow): void {
  if (!gap || gap.status !== "pending") {
    return;
  }
  const src = gap.source && typeof gap.source === "object" ? (gap.source as Record<string, unknown>) : null;
  if (!src || src.kind !== "local_device") {
    return;
  }
  const sourceInstanceId = typeof src.source_instance_id === "string" ? src.source_instance_id : null;
  if (!sourceInstanceId) {
    return;
  }
  const current = stats.get(sourceInstanceId) ?? { pending: 0, lastUpdatedAt: null, reasons: new Set<string>() };
  current.pending += 1;
  if (!current.lastUpdatedAt || (gap.updated_at && gap.updated_at > current.lastUpdatedAt)) {
    current.lastUpdatedAt = gap.updated_at ?? current.lastUpdatedAt;
  }
  if (typeof gap.reason === "string" && gap.reason) {
    current.reasons.add(gap.reason);
  }
  stats.set(sourceInstanceId, current);
}

async function aggregateLocalCollectorGapStats(
  ctx: MountRefDeviceExportersContext,
  connectorIds: Set<string>
): Promise<{ stats: GapStatMap; unreliableIds: Set<string> }> {
  const stats: GapStatMap = new Map();
  const unreliableIds = new Set<string>();
  const detailGapStore = ctx.getDefaultConnectorDetailGapStore();
  if (typeof detailGapStore.listPendingGapsForConnector !== "function") {
    return { stats, unreliableIds };
  }
  for (const connectorId of connectorIds) {
    let gaps: GapRow[] = [];
    try {
      gaps = await detailGapStore.listPendingGapsForConnector?.(connectorId, { limit: 500 });
    } catch {
      unreliableIds.add(connectorId);
      gaps = [];
    }
    for (const gap of gaps) {
      accumulateGapRow(stats, gap);
    }
  }
  return { stats, unreliableIds };
}

/**
 * Resolve the connector instance for a source instance using the same
 * binding fallback as the projection, so coverage attaches to exactly the
 * instance whose storage holds the records.
 */
function resolveConnectorInstanceForSource(
  ctx: MountRefDeviceExportersContext,
  source: SourceInstanceRow,
  devicesById: Map<string, DeviceRow>,
  connectorInstancesById: Map<string, ConnectorInstanceRow>,
  connectorInstancesByBinding: Map<string, ConnectorInstanceRow>
): ConnectorInstanceRow | undefined {
  if (source.connectorInstanceId) {
    return connectorInstancesById.get(source.connectorInstanceId);
  }
  if (!devicesById.get(source.deviceId)) {
    return;
  }
  const identityKey = ctx.makeConnectorInstanceSourceBindingKey(
    deviceExporterSourceBindingIdentity(source.localBindingId)
  );
  return connectorInstancesByBinding.get(`${source.connectorId}\nlocal_device\n${identityKey}`);
}

/**
 * Read safe local coverage diagnostics once per distinct connector instance
 * referenced by the owner's source instances. Failures to read one
 * instance must not break the whole diagnostics response, so a read error
 * yields no coverage for that instance (observed=false) rather than
 * throwing.
 */
async function aggregateLocalCoverage(
  ctx: MountRefDeviceExportersContext,
  sourceInstances: readonly SourceInstanceRow[],
  maps: {
    connectorInstancesById: Map<string, ConnectorInstanceRow>;
    connectorInstancesByBinding: Map<string, ConnectorInstanceRow>;
  }
): Promise<Map<string, LocalCoverageProjection>> {
  const devicesById = new Map<string, DeviceRow>();
  // projectSourceInstance only checks for device presence via the same
  // map; build a presence-only view from the source rows themselves.
  for (const source of sourceInstances) {
    if (!devicesById.has(source.deviceId)) {
      devicesById.set(source.deviceId, { deviceId: source.deviceId } as DeviceRow);
    }
  }

  const targets = new Map<string, { connectorId: string; connectorInstanceId: string }>();
  for (const source of sourceInstances) {
    const instance = resolveConnectorInstanceForSource(
      ctx,
      source,
      devicesById,
      maps.connectorInstancesById,
      maps.connectorInstancesByBinding
    );
    if (instance?.connectorInstanceId && !targets.has(instance.connectorInstanceId)) {
      targets.set(instance.connectorInstanceId, {
        connectorId: source.connectorId,
        connectorInstanceId: instance.connectorInstanceId,
      });
    }
  }

  const coverage = new Map<string, LocalCoverageProjection>();
  for (const { connectorId, connectorInstanceId } of targets.values()) {
    try {
      const rows = await ctx.listLocalCoverageDiagnostics(
        referenceLocalDeviceStorageTarget(ctx, connectorId, connectorInstanceId)
      );
      coverage.set(connectorInstanceId, summarizeLocalCoverage(rows));
    } catch {
      // Leave unset → EMPTY_LOCAL_COVERAGE (observed=false) in projection.
    }
  }
  return coverage;
}

function aggregateOutcomeStats(outcomes: BatchOutcomeRow[]): OutcomeStatMap {
  const map: OutcomeStatMap = new Map();
  for (const outcome of outcomes) {
    const key = outcome.sourceInstanceId;
    const current = map.get(key) ?? { accepted: 0, rejected: 0, lastIngestAt: null };
    if (outcome.status === "accepted") {
      current.accepted += outcome.response?.accepted_record_count ?? 0;
    } else if (outcome.status === "rejected") {
      current.rejected += outcome.response?.rejected_record_count ?? 0;
    }
    if (!current.lastIngestAt || outcome.createdAt > current.lastIngestAt) {
      current.lastIngestAt = outcome.createdAt;
    }
    map.set(key, current);
  }
  return map;
}

function projectSourceInstance(
  ctx: MountRefDeviceExportersContext,
  source: SourceInstanceRow,
  devicesById: Map<string, DeviceRow>,
  connectorInstancesById: Map<string, ConnectorInstanceRow>,
  connectorInstancesByBinding: Map<string, ConnectorInstanceRow>,
  outcomeStats: OutcomeStatMap,
  gapStats: GapStatMap,
  unreliableIds: Set<string>,
  coverageByConnectorInstance: Map<string, LocalCoverageProjection>
): unknown {
  const stats = outcomeStats.get(source.sourceInstanceId) ?? { accepted: 0, rejected: 0, lastIngestAt: null };
  const device = devicesById.get(source.deviceId);
  const identityKey = ctx.makeConnectorInstanceSourceBindingKey(
    deviceExporterSourceBindingIdentity(source.localBindingId)
  );
  let connectorInstance: ConnectorInstanceRow | undefined;
  if (source.connectorInstanceId) {
    connectorInstance = connectorInstancesById.get(source.connectorInstanceId);
  } else if (device) {
    connectorInstance = connectorInstancesByBinding.get(`${source.connectorId}\nlocal_device\n${identityKey}`);
  }
  const gap = gapStats.get(source.sourceInstanceId) ?? null;
  const outboxDiagnostics = source.outboxDiagnostics ?? null;
  return {
    object: "device_source_instance",
    source_instance_id: source.sourceInstanceId,
    connector_instance_id: connectorInstance?.connectorInstanceId ?? null,
    device_id: source.deviceId,
    connector_id: source.connectorId,
    local_binding_name: source.localBindingId,
    display_name: source.displayName,
    created_at: source.createdAt,
    last_ingest_at: stats.lastIngestAt,
    accepted_record_count: stats.accepted,
    rejected_record_count: stats.rejected,
    last_heartbeat_at: source.lastHeartbeatAt ?? null,
    last_heartbeat_status: source.lastHeartbeatStatus ?? null,
    records_pending: source.recordsPending ?? null,
    outbox_diagnostics: outboxDiagnostics,
    outbox_state: deriveSourceInstanceOutboxState(outboxDiagnostics),
    local_collector_gaps: {
      pending_count: gap ? gap.pending : 0,
      reasons: gap ? [...gap.reasons].sort() : [],
      last_updated_at: gap ? gap.lastUpdatedAt : null,
      unreliable: unreliableIds.has(source.connectorId),
    },
    local_collector_coverage:
      (connectorInstance?.connectorInstanceId
        ? coverageByConnectorInstance.get(connectorInstance.connectorInstanceId)
        : null) ?? EMPTY_LOCAL_COVERAGE,
    last_error: source.lastError,
  };
}

/**
 * Coverage projection for a source instance that has no coverage records
 * yet (or whose connector instance could not be resolved). `observed`
 * false is the honest "no completeness signal seen" state.
 */
const EMPTY_LOCAL_COVERAGE: LocalCoverageProjection = Object.freeze({
  by_store: Object.freeze({}) as Record<string, string>,
  counts_by_status: Object.freeze(Object.fromEntries(COVERAGE_STATUSES.map((status) => [status, 0]))) as Record<
    string,
    number
  >,
  fully_accounted: false,
  observed: false,
  store_count: 0,
  unaccounted_stores: Object.freeze([]) as unknown as string[],
});

function projectDeviceExporter(
  device: DeviceRow,
  sourceList: unknown[],
  now: number,
  maximumStalenessSeconds: number | null
): unknown {
  const lastIngestAt = sourceList.reduce((latest: string | null, source) => {
    const s = source as { last_ingest_at?: string | null };
    return !latest || (s.last_ingest_at && s.last_ingest_at > latest) ? (s.last_ingest_at ?? latest) : latest;
  }, null);
  const lastHeartbeatAt = device.lastHeartbeatAt ?? null;
  // Policy-aware staleness: a heartbeat is "stale" once it exceeds the
  // connector's declared `maximum_staleness_seconds`, the same policy the
  // connection-health freshness projection uses. `deriveReferenceFreshness`
  // anchors freshness on the heartbeat timestamp (there is no scheduler run for
  // a push-mode local collector) and returns `unknown` — never `stale` — when
  // no policy resolves, so an unknown-policy device is honestly not flagged
  // rather than alarmed on a hard-coded window.
  const stale =
    deriveReferenceFreshness({
      recordLastUpdatedAt: lastHeartbeatAt,
      maximumStalenessSeconds,
      now,
    }).status === "stale";
  return {
    object: "device_exporter",
    device_id: device.deviceId,
    subject_id: device.ownerSubjectId,
    display_name: device.displayName,
    status: device.status,
    created_at: device.createdAt,
    last_heartbeat_at: lastHeartbeatAt,
    last_ingest_at: lastIngestAt,
    revoked_at: device.revokedAt,
    stale,
    source_instances: sourceList,
    last_error: device.lastError,
  };
}

async function buildDeviceExporterDiagnostics(
  ctx: MountRefDeviceExportersContext,
  ownerSubjectId: string
): Promise<unknown[]> {
  const store = ctx.deviceExporterStore;
  const [devices, sourceInstances, outcomes] = await Promise.all([
    store.listDevices(ownerSubjectId),
    store.listSourceInstances(),
    store.listBatchOutcomes({ limit: 5000 }),
  ]);
  const now = Date.now();
  const connectorInstances = await ctx.createRequestConnectorInstanceStore().listByOwner(ownerSubjectId);
  const devicesById = new Map(devices.map((d) => [d.deviceId, d]));
  const connectorInstancesById = new Map(connectorInstances.map((i) => [i.connectorInstanceId, i]));
  const connectorInstancesByBinding = new Map(
    connectorInstances.map((i) => [`${i.connectorId}\n${i.sourceKind}\n${i.sourceBindingKey}`, i])
  );
  const connectorIds = new Set(sourceInstances.map((s) => s.connectorId).filter(Boolean));
  const { stats: gapStats, unreliableIds } = await aggregateLocalCollectorGapStats(ctx, connectorIds);
  const outcomeStats = aggregateOutcomeStats(outcomes);
  const stalenessWindowsByConnector = await resolveStalenessWindowsByConnector(ctx, connectorIds);
  const coverageByConnectorInstance = await aggregateLocalCoverage(ctx, sourceInstances, {
    connectorInstancesById,
    connectorInstancesByBinding,
  });

  const sourcesByDevice = new Map<string, unknown[]>();
  for (const source of sourceInstances) {
    const projected = projectSourceInstance(
      ctx,
      source,
      devicesById,
      connectorInstancesById,
      connectorInstancesByBinding,
      outcomeStats,
      gapStats,
      unreliableIds,
      coverageByConnectorInstance
    );
    const list = sourcesByDevice.get(source.deviceId) ?? [];
    list.push(projected);
    sourcesByDevice.set(source.deviceId, list);
  }
  return devices.map((device) => {
    const sourceList = sourcesByDevice.get(device.deviceId) ?? [];
    return projectDeviceExporter(
      device,
      sourceList,
      now,
      deviceMaximumStalenessSeconds(sourceList, stalenessWindowsByConnector)
    );
  });
}

async function resolveAuthorizedDeviceSource(
  ctx: MountRefDeviceExportersContext,
  req: RouteRequest,
  res: RouteResponse,
  deviceId: string,
  sourceInstanceId: string,
  { notFoundStatus = 400 } = {}
): Promise<{ sourceInstance: SourceInstanceRow; connectorInstance: ConnectorInstanceRow } | null> {
  const store = ctx.deviceExporterStore;
  const sourceInstance = await store.getSourceInstance(deviceId, sourceInstanceId);
  if (!sourceInstance || sourceInstance.status !== "active") {
    ctx.pdppError(
      res,
      notFoundStatus,
      notFoundStatus === 404 ? "not_found" : "invalid_request",
      `Unknown source_instance_id '${sourceInstanceId}'`,
      "source_instance_id"
    );
    return null;
  }
  const ownerSubjectId = req.deviceExporter?.ownerSubjectId ?? "";
  const connectorInstance = await resolveActiveDeviceConnectorInstance(ctx, deviceId, ownerSubjectId, sourceInstance);
  if (!connectorInstance || connectorInstance.ownerSubjectId !== ownerSubjectId) {
    ctx.pdppError(
      res,
      403,
      "permission_error",
      "source_instance_id is not authorized for an active connector instance",
      "source_instance_id"
    );
    return null;
  }
  return { sourceInstance, connectorInstance };
}

async function resolveActiveDeviceConnectorInstance(
  ctx: MountRefDeviceExportersContext,
  _deviceId: string,
  ownerSubjectId: string,
  sourceInstance: SourceInstanceRow
): Promise<ConnectorInstanceRow | null> {
  const store = ctx.createRequestConnectorInstanceStore();
  if (sourceInstance.connectorInstanceId) {
    const instance = await store.get(sourceInstance.connectorInstanceId);
    if (
      instance &&
      instance.status === "active" &&
      instance.ownerSubjectId === ownerSubjectId &&
      sameConnectorType(ctx, instance.connectorId, sourceInstance.connectorId)
    ) {
      return instance;
    }
    return null;
  }
  const identity = deviceExporterSourceBindingIdentity(sourceInstance.localBindingId);
  const instance = await store.getByBinding({
    ownerSubjectId,
    connectorId: ctx.canonicalConnectorKey(sourceInstance.connectorId) ?? sourceInstance.connectorId,
    sourceKind: "local_device",
    sourceBindingKey: ctx.makeConnectorInstanceSourceBindingKey(identity),
  });
  if (!instance || instance.status !== "active") {
    return null;
  }
  return instance;
}

// ─── Route mounts ────────────────────────────────────────────────────────────

// POST /_ref/device-exporters/enrollment-codes
// Owner-authenticated enrollment code creation.
export function mountRefDeviceExporterEnrollmentCodes(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.post(
    "/_ref/device-exporters/enrollment-codes",
    { contract: "refCreateDeviceExporterEnrollmentCode" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const body = (req.body as Record<string, unknown>) || {};
        const connectorId = requireNonEmptyString(body.connector_id, "connector_id");
        const localBindingId = requireNonEmptyString(body.local_binding_name, "local_binding_name");
        // Resolve the manifest-derived source kind up front so a connector with
        // no resolvable binding — or a caller-supplied `source_kind` that
        // contradicts the manifest — is rejected before a code is minted, rather
        // than failing only at enroll time. Throws SourceKindResolutionError
        // (mapped to 400 by handleError).
        const enrollConnectorKey = ctx.canonicalConnectorKey(connectorId) ?? connectorId;
        await resolveEnrollmentSourceKind(
          ctx,
          enrollConnectorKey,
          typeof body.source_kind === "string" ? body.source_kind : null
        );
        const now = new Date();
        const expiresInSeconds = Number.isInteger(body.expires_in_seconds)
          ? (body.expires_in_seconds as number)
          : 15 * 60;
        if (expiresInSeconds < 60 || expiresInSeconds > 86_400) {
          ctx.pdppError(
            res,
            400,
            "invalid_request",
            "expires_in_seconds must be between 60 and 86400",
            "expires_in_seconds"
          );
          return;
        }
        const enrollmentCode = ctx.generateReferenceSecret("lde", 18);
        const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
        await ctx.deviceExporterStore.createEnrollmentCode({
          enrollmentCodeId: ctx.generateSpineId("denroll"),
          codeHash: ctx.hashDeviceSecret(enrollmentCode),
          ownerSubjectId: ctx.getOwnerSubjectId(req),
          connectorId,
          localBindingId,
          displayName:
            typeof body.display_name === "string" && (body.display_name as string).trim()
              ? (body.display_name as string).trim()
              : null,
          createdAt: now.toISOString(),
          expiresAt,
        });
        res.status(201).json({
          object: "device_exporter_enrollment_code",
          enrollment_code: enrollmentCode,
          expires_at: expiresAt,
          connector_id: connectorId,
          local_binding_name: localBindingId,
        });
      } catch (err) {
        ctx.handleError(res, err);
        return;
      }
    }
  );
}

// POST /_ref/device-exporters/enroll
// Public (no owner session); exchanges enrollment code for device credentials.
export function mountRefDeviceExporterEnroll(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.post(
    "/_ref/device-exporters/enroll",
    { contract: "refExchangeDeviceExporterEnrollmentCode" },
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        if (ctx.enforceCollectorProtocolVersion(req, res)) {
          return;
        }
        const body = (req.body as Record<string, unknown>) || {};
        const enrollmentCode = requireNonEmptyString(body.enrollment_code, "enrollment_code");
        const enrollment = await ctx.deviceExporterStore.findEnrollmentByCodeHash(ctx.hashDeviceSecret(enrollmentCode));
        const now = new Date();
        if (!enrollment || enrollment.status !== "pending") {
          ctx.pdppError(res, 400, "invalid_request", "Enrollment code is invalid or already used", "enrollment_code");
          return;
        }
        if (Date.parse(enrollment.expiresAt) <= now.getTime()) {
          await ctx.deviceExporterStore.revokeEnrollmentCode(enrollment.enrollmentCodeId, now.toISOString());
          ctx.pdppError(res, 410, "invalid_request", "Enrollment code has expired", "enrollment_code");
          return;
        }

        const collectorProtocolVersion = ctx.readCollectorProtocolHeader(req.headers);

        const deviceId = ctx.generateSpineId("dexp");
        const credentialId = ctx.generateSpineId("dcred");
        const sourceInstanceId = ctx.generateSpineId("dsrc");
        const deviceToken = ctx.generateReferenceSecret("ldt", 32);
        const displayName =
          typeof body.device_label === "string" && (body.device_label as string).trim()
            ? (body.device_label as string).trim()
            : enrollment.displayName || enrollment.localBindingId;

        await ctx.deviceExporterStore.createDevice({
          deviceId,
          ownerSubjectId: enrollment.ownerSubjectId,
          displayName,
          collectorProtocolVersion,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await ctx.deviceExporterStore.createCredential({
          credentialId,
          deviceId,
          tokenHash: ctx.hashDeviceSecret(deviceToken),
          createdAt: now.toISOString(),
        });
        // Canonicalize connector id at the enroll boundary. See
        // canonicalize-connector-keys design Decision 7.
        const enrollConnectorKey = ctx.canonicalConnectorKey(enrollment.connectorId) ?? enrollment.connectorId;
        // Derive the enrolled source kind from the connector manifest bindings
        // rather than hardcoding `local_device`: a `filesystem` connector enrolls
        // as `local_device`, a `browser` connector as `browser_collector`, and a
        // connector with no resolvable binding is rejected. See
        // add-browser-collector-enrollment-primitive design Decision 2.
        const sourceKind = await resolveEnrollmentSourceKind(ctx, enrollConnectorKey);
        await ctx.ensureReferenceConnectorCatalogEntry(enrollConnectorKey, enrollment.displayName || displayName);
        const sourceBindingIdentity = deviceExporterSourceBindingIdentity(enrollment.localBindingId, sourceKind);
        const connectorInstance = await ctx.createRequestConnectorInstanceStore().upsert({
          ownerSubjectId: enrollment.ownerSubjectId,
          connectorId: enrollConnectorKey,
          displayName,
          status: "active",
          sourceKind,
          sourceBindingKey: ctx.makeConnectorInstanceSourceBindingKey(sourceBindingIdentity),
          sourceBinding: {
            kind: sourceKind,
            device_id: deviceId,
            local_binding_name: enrollment.localBindingId,
            source_instance_id: sourceInstanceId,
          },
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        await ctx.deviceExporterStore.upsertSourceInstance({
          sourceInstanceId,
          deviceId,
          connectorId: enrollConnectorKey,
          connectorInstanceId: connectorInstance.connectorInstanceId,
          localBindingId: enrollment.localBindingId,
          displayName: enrollment.displayName,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        const consumed = await ctx.deviceExporterStore.consumeEnrollmentCode(
          enrollment.enrollmentCodeId,
          deviceId,
          now.toISOString()
        );
        if (!consumed) {
          await ctx.deviceExporterStore.revokeDevice(deviceId, now.toISOString());
          await ctx.createRequestConnectorInstanceStore().updateStatus(connectorInstance.connectorInstanceId, {
            status: "revoked",
            updatedAt: now.toISOString(),
            revokedAt: now.toISOString(),
          });
          ctx.pdppError(
            res,
            409,
            "invalid_request",
            "Enrollment code was consumed by another device",
            "enrollment_code"
          );
          return;
        }

        res.status(201).json({
          object: "device_exporter_enrollment",
          device_id: deviceId,
          connector_instance_id: connectorInstance.connectorInstanceId,
          source_instance_id: sourceInstanceId,
          device_token: deviceToken,
          connector_id: enrollConnectorKey,
          local_binding_name: enrollment.localBindingId,
        });
      } catch (err) {
        ctx.handleError(res, err);
        return;
      }
    }
  );
}

// GET /_ref/device-exporters
export function mountRefDeviceExportersList(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.get(
    "/_ref/device-exporters",
    { contract: "refListDeviceExporters" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        res.json({
          object: "list",
          data: await buildDeviceExporterDiagnostics(ctx, ctx.getOwnerSubjectId(req)),
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// GET /_ref/device-exporters/source-instances
export function mountRefDeviceExporterSourceInstances(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.get(
    "/_ref/device-exporters/source-instances",
    { contract: "refListDeviceExporterSourceInstances" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const diagnostics = await buildDeviceExporterDiagnostics(ctx, ctx.getOwnerSubjectId(req));
        const requestedDeviceId =
          typeof req.query.device_id === "string" && (req.query.device_id as string).trim()
            ? (req.query.device_id as string).trim()
            : null;
        const requestedConnectorInstanceId =
          typeof req.query.connector_instance_id === "string" && (req.query.connector_instance_id as string).trim()
            ? (req.query.connector_instance_id as string).trim()
            : null;
        const data = (diagnostics as Array<{ source_instances: unknown[] }>)
          .flatMap((device) => device.source_instances)
          .filter((source) => {
            const s = source as { device_id: string };
            return !requestedDeviceId || s.device_id === requestedDeviceId;
          })
          .filter((source) => {
            const s = source as { connector_instance_id: string };
            return !requestedConnectorInstanceId || s.connector_instance_id === requestedConnectorInstanceId;
          });
        res.json({ object: "list", data });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// GET /_ref/device-exporters/diagnostics
export function mountRefDeviceExporterDiagnostics(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.get(
    "/_ref/device-exporters/diagnostics",
    { contract: "refListDeviceExporterDiagnostics" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        res.json({
          object: "list",
          data: await buildDeviceExporterDiagnostics(ctx, ctx.getOwnerSubjectId(req)),
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// POST /_ref/device-exporters/:deviceId/revoke
export function mountRefDeviceExporterRevoke(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.post(
    "/_ref/device-exporters/:deviceId/revoke",
    { contract: "refRevokeDeviceExporter" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId as string);
        const device = await ctx.deviceExporterStore.getDevice(deviceId);
        if (!device || device.ownerSubjectId !== ctx.getOwnerSubjectId(req)) {
          ctx.pdppError(res, 404, "not_found", "Device exporter not found");
          return;
        }
        const revokedAt = new Date().toISOString();
        await ctx.deviceExporterStore.revokeDevice(deviceId, revokedAt);
        res.json({ object: "device_exporter_revocation", device_id: deviceId, revoked_at: revokedAt });
      } catch (err) {
        ctx.handleError(res, err);
        return;
      }
    }
  );
}

// POST /_ref/device-exporters/:deviceId/heartbeat
export function mountRefDeviceExporterHeartbeat(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.post(
    "/_ref/device-exporters/:deviceId/heartbeat",
    { contract: "refHeartbeatDeviceExporter" },
    ctx.requireDeviceExporterCredential,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId as string);
        if (deviceId !== req.deviceExporter?.deviceId) {
          ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
          return;
        }
        const body = (req.body as Record<string, unknown>) || {};
        const receivedAt = new Date().toISOString();
        await ctx.deviceExporterStore.markDeviceHeartbeat(deviceId, {
          receivedAt,
          agentVersion: typeof body.agent_version === "string" ? body.agent_version : null,
          lastError: ctx.sanitizeDeviceExporterDiagnostic(body.last_error),
        });
        for (const source of normalizeHeartbeatSourceInstances(body)) {
          const s = source as Record<string, unknown>;
          const sourceInstanceId = requireNonEmptyString(s.source_instance_id, "source_instance_id");
          const authorized = await resolveAuthorizedDeviceSource(ctx, req, res, deviceId, sourceInstanceId);
          if (!authorized) {
            return;
          }
          const status = typeof s.status === "string" ? s.status : null;
          const recordsPending = typeof s.records_pending === "number" ? s.records_pending : null;
          const outboxDiagnostics = (s.outbox as unknown) ?? null;
          await ctx.deviceExporterStore.markSourceInstanceHeartbeat(deviceId, sourceInstanceId, {
            receivedAt,
            lastError: ctx.sanitizeDeviceExporterDiagnostic(s.last_error),
            status,
            recordsPending,
            outboxDiagnostics,
          });
          if (
            isDrainedHealthyLocalHeartbeat(status, recordsPending, outboxDiagnostics)
            && authorized.connectorInstance.connectorInstanceId
          ) {
            await recoverDrainedPolicyBudgetGaps(
              ctx,
              authorized.sourceInstance.connectorId,
              authorized.connectorInstance.connectorInstanceId
            );
          }
        }
        res.json({
          object: "device_exporter_heartbeat",
          device_id: deviceId,
          received_at: receivedAt,
          status: "accepted",
        });
      } catch (err) {
        ctx.handleError(res, err);
        return;
      }
    }
  );
}

// POST /_ref/device-exporters/:deviceId/ingest-batches
export function mountRefDeviceExporterIngestBatches(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.post(
    "/_ref/device-exporters/:deviceId/ingest-batches",
    { contract: "refIngestDeviceExporterBatch" },
    ctx.requireDeviceExporterCredential,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId as string);
        if (deviceId !== req.deviceExporter?.deviceId) {
          ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
          return;
        }
        const body = (req.body as Record<string, unknown>) || {};
        const bodyDeviceId = requireNonEmptyString(body.device_id, "device_id");
        if (bodyDeviceId !== deviceId) {
          ctx.pdppError(res, 400, "invalid_request", "body device_id must match path deviceId", "device_id");
          return;
        }
        const sourceInstanceId = requireNonEmptyString(body.source_instance_id, "source_instance_id");
        const batchId = requireNonEmptyString(body.batch_id, "batch_id");
        const bodyHash = requireNonEmptyString(body.body_hash, "body_hash");
        const connectorId = requireNonEmptyString(body.connector_id, "connector_id");
        if (!Number.isInteger(body.batch_seq) || (body.batch_seq as number) < 0) {
          ctx.pdppError(res, 400, "invalid_request", "batch_seq must be a non-negative integer", "batch_seq");
          return;
        }
        const authorized = await resolveAuthorizedDeviceSource(ctx, req, res, deviceId, sourceInstanceId);
        if (!authorized) {
          return;
        }
        const { sourceInstance, connectorInstance } = authorized;
        if (!sameConnectorType(ctx, sourceInstance.connectorId, connectorId)) {
          ctx.pdppError(res, 400, "invalid_request", "connector_id does not match source_instance_id", "connector_id");
          return;
        }

        await processDeviceIngestBatch(ctx, res, {
          deviceId,
          connectorId,
          sourceInstanceId,
          batchId,
          bodyHash,
          connectorInstanceId: connectorInstance.connectorInstanceId,
          records: normalizeDeviceIngestRecords(body),
        });
      } catch (err) {
        if (err instanceof ctx.DeviceBatchConflictError) {
          ctx.pdppError(res, 409, "device_batch_conflict", (err as Error).message);
          return;
        }
        ctx.handleError(res, err);
        return;
      }
    }
  );
}

async function processDeviceIngestBatch(
  ctx: MountRefDeviceExportersContext,
  res: RouteResponse,
  params: {
    deviceId: string;
    connectorId: string;
    sourceInstanceId: string;
    batchId: string;
    bodyHash: string;
    connectorInstanceId: string;
    records: unknown[];
  }
): Promise<void> {
  const { deviceId, connectorId, sourceInstanceId, batchId, bodyHash, connectorInstanceId, records } = params;
  const existing = await ctx.deviceExporterStore.getBatchOutcome(deviceId, batchId);
  if (existing) {
    if (existing.bodyHash !== bodyHash) {
      ctx.pdppError(
        res,
        409,
        "device_batch_conflict",
        `Device ingest batch '${batchId}' already exists with a different body hash`
      );
      return;
    }
    res.status(200).json({
      object: "device_ingest_batch_result",
      device_id: deviceId,
      connector_instance_id: connectorInstanceId,
      source_instance_id: sourceInstanceId,
      batch_id: batchId,
      body_hash: bodyHash,
      status: "replayed",
      accepted_record_count: existing.response?.accepted_record_count ?? records.length,
      rejected_record_count: existing.response?.rejected_record_count ?? 0,
    });
    return;
  }
  const storageTarget = referenceLocalDeviceStorageTarget(ctx, connectorId, connectorInstanceId);
  for (const record of records) {
    await ctx.ingestRecord(storageTarget, record);
  }
  const response = {
    object: "device_ingest_batch_result",
    device_id: deviceId,
    connector_instance_id: connectorInstanceId,
    source_instance_id: sourceInstanceId,
    batch_id: batchId,
    body_hash: bodyHash,
    status: "accepted",
    accepted_record_count: records.length,
    rejected_record_count: 0,
  };
  await ctx.deviceExporterStore.recordBatchOutcome({
    deviceId,
    batchId,
    bodyHash,
    sourceInstanceId,
    status: "accepted",
    httpStatus: 201,
    response,
    createdAt: new Date().toISOString(),
  });
  res.status(201).json(response);
}

// GET /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state
export function mountRefDeviceExporterSourceInstanceStateGet(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.get(
    "/_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state",
    { contract: "refGetDeviceExporterSourceInstanceState" },
    ctx.requireDeviceExporterCredential,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId as string);
        if (deviceId !== req.deviceExporter?.deviceId) {
          ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
          return;
        }
        const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId as string);
        const authorized = await resolveAuthorizedDeviceSource(ctx, req, res, deviceId, sourceInstanceId, {
          notFoundStatus: 404,
        });
        if (!authorized) {
          return;
        }
        const { sourceInstance, connectorInstance } = authorized;
        const storageTarget = referenceLocalDeviceStorageTarget(
          ctx,
          sourceInstance.connectorId,
          connectorInstance.connectorInstanceId
        );
        const projection = await ctx.getSyncState(storageTarget, { grantId: null });
        res.json({
          object: "device_source_instance_state",
          device_id: deviceId,
          connector_instance_id: connectorInstance.connectorInstanceId,
          source_instance_id: sourceInstanceId,
          state: projection.state ?? {},
          updated_at: projection.updated_at ?? null,
        });
      } catch (err) {
        ctx.handleError(res, err);
        return;
      }
    }
  );
}

// PUT /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state
export function mountRefDeviceExporterSourceInstanceStatePut(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.put(
    "/_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state",
    { contract: "refPutDeviceExporterSourceInstanceState" },
    ctx.requireDeviceExporterCredential,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId as string);
        if (deviceId !== req.deviceExporter?.deviceId) {
          ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
          return;
        }
        const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId as string);
        const authorized = await resolveAuthorizedDeviceSource(ctx, req, res, deviceId, sourceInstanceId, {
          notFoundStatus: 404,
        });
        if (!authorized) {
          return;
        }
        const { sourceInstance, connectorInstance } = authorized;
        const stateMap = optionalObject((req.body as Record<string, unknown> | null)?.state);
        if (!stateMap) {
          ctx.pdppError(res, 400, "invalid_request", "state body must be an object map of streams to cursors", "state");
          return;
        }
        const storageTarget = referenceLocalDeviceStorageTarget(
          ctx,
          sourceInstance.connectorId,
          connectorInstance.connectorInstanceId
        );
        const projection = await ctx.putSyncState(storageTarget, stateMap, { grantId: null });
        res.json({
          object: "device_source_instance_state",
          device_id: deviceId,
          connector_instance_id: connectorInstance.connectorInstanceId,
          source_instance_id: sourceInstanceId,
          state: projection.state ?? {},
          updated_at: projection.updated_at ?? null,
        });
      } catch (err) {
        ctx.handleError(res, err);
        return;
      }
    }
  );
}

// Shared body-parsing helpers for the two local-collector-gap routes.
// Extracted to reduce cognitive complexity of each handler.

interface GapBodyBase {
  connectorId: string;
  detailLocator: Record<string, unknown>;
  reason: string;
  source: { kind: string; device_id: string; source_instance_id: string };
  streamBoundary: string | null;
  streamName: string | null;
  syntheticStream: string;
}

function parseGapBodyBase(
  ctx: MountRefDeviceExportersContext,
  res: RouteResponse,
  body: Record<string, unknown>,
  sourceInstance: SourceInstanceRow,
  sourceInstanceId: string,
  deviceId: string
): GapBodyBase | null {
  const bodySourceInstanceId = requireNonEmptyString(body.source_instance_id, "source_instance_id");
  if (bodySourceInstanceId !== sourceInstanceId) {
    ctx.pdppError(
      res,
      400,
      "invalid_request",
      "body source_instance_id must match path sourceInstanceId",
      "source_instance_id"
    );
    return null;
  }
  const connectorId = requireNonEmptyString(body.connector_id, "connector_id");
  if (!sameConnectorType(ctx, sourceInstance.connectorId, connectorId)) {
    ctx.pdppError(res, 400, "invalid_request", "connector_id does not match source_instance_id", "connector_id");
    return null;
  }
  const reason = requireNonEmptyString(body.reason, "reason");
  if (reason !== "policy_budget" && reason !== "connector_child_failure") {
    ctx.pdppError(
      res,
      400,
      "invalid_request",
      "reason must be one of: policy_budget, connector_child_failure",
      "reason"
    );
    return null;
  }
  const streamName =
    typeof body.stream === "string" && (body.stream as string).trim() ? (body.stream as string).trim() : null;
  const streamBoundary =
    typeof body.stream_boundary === "string" && (body.stream_boundary as string).trim()
      ? (body.stream_boundary as string).trim()
      : null;
  const syntheticStream = streamName ? `local-collector/${reason}/${streamName}` : `local-collector/${reason}`;
  const detailLocator: Record<string, unknown> = {
    kind: "local_collector_gap",
    reason,
    ...(streamName ? { stream: streamName } : {}),
    ...(streamBoundary ? { stream_boundary: streamBoundary } : {}),
  };
  const source = { kind: "local_device", device_id: deviceId, source_instance_id: sourceInstanceId };
  return { connectorId, reason, streamName, streamBoundary, syntheticStream, detailLocator, source };
}

function validateGapReportFields(
  ctx: MountRefDeviceExportersContext,
  res: RouteResponse,
  body: Record<string, unknown>
): { firstSeenAt: string; details: string | null } | null {
  const firstSeenAt = requireNonEmptyString(body.first_seen_at, "first_seen_at");
  if (Number.isNaN(Date.parse(firstSeenAt))) {
    ctx.pdppError(res, 400, "invalid_request", "first_seen_at must be an ISO timestamp", "first_seen_at");
    return null;
  }
  if (typeof body.retryable !== "boolean") {
    ctx.pdppError(res, 400, "invalid_request", "retryable must be a boolean", "retryable");
    return null;
  }
  if (!Number.isFinite(body.next_attempt_backoff_ms) || (body.next_attempt_backoff_ms as number) < 0) {
    ctx.pdppError(
      res,
      400,
      "invalid_request",
      "next_attempt_backoff_ms must be a non-negative number",
      "next_attempt_backoff_ms"
    );
    return null;
  }
  const details = ctx.sanitizeLocalCollectorGapDetails(body.details);
  return { firstSeenAt, details };
}

async function reportLocalCollectorGap(
  ctx: MountRefDeviceExportersContext,
  res: RouteResponse,
  base: GapBodyBase,
  fields: { firstSeenAt: string; details: string | null },
  body: Record<string, unknown>,
  deviceId: string,
  sourceInstanceId: string,
  connectorInstanceId: string
): Promise<void> {
  const { connectorId, reason, syntheticStream, detailLocator, source } = base;
  const { firstSeenAt, details } = fields;
  const firstSeenRunId =
    typeof body.first_seen_run_id === "string" && (body.first_seen_run_id as string).trim()
      ? (body.first_seen_run_id as string).trim()
      : null;
  const lastRunId =
    typeof body.last_run_id === "string" && (body.last_run_id as string).trim()
      ? (body.last_run_id as string).trim()
      : firstSeenRunId;
  const lastError = {
    first_seen_at: firstSeenAt,
    next_attempt_backoff_ms: body.next_attempt_backoff_ms,
    ...(details ? { details } : {}),
  };
  const store = ctx.getDefaultConnectorDetailGapStore();
  const gap = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId,
    stream: syntheticStream,
    source,
    detailLocator,
    reason,
    lastError,
    ...(firstSeenRunId ? { discoveredRunId: firstSeenRunId } : {}),
    ...(lastRunId ? { lastRunId } : {}),
  });
  res.status(201).json({
    object: "device_local_collector_gap",
    device_id: deviceId,
    connector_id: connectorId,
    connector_instance_id: connectorInstanceId,
    source_instance_id: sourceInstanceId,
    gap_id: gap.gap_id,
    stream: syntheticStream,
    reason,
    retryable: body.retryable,
    status: gap.status,
    attempt_count: gap.attempt_count,
    first_seen_at: firstSeenAt,
    first_seen_run_id: firstSeenRunId,
    last_run_id: gap.last_run_id ?? lastRunId,
    updated_at: gap.updated_at,
  });
}

async function recoverLocalCollectorGap(
  ctx: MountRefDeviceExportersContext,
  res: RouteResponse,
  base: GapBodyBase,
  recoveredRunId: string | null,
  deviceId: string,
  sourceInstanceId: string,
  connectorInstanceId: string
): Promise<void> {
  const { connectorId, reason, syntheticStream, detailLocator, source } = base;
  const store = ctx.getDefaultConnectorDetailGapStore();
  const gap = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId,
    stream: syntheticStream,
    source,
    detailLocator,
    reason,
    lastError: { recovered_by: "local_collector", recovered_at: new Date().toISOString() },
    ...(recoveredRunId ? { discoveredRunId: recoveredRunId, lastRunId: recoveredRunId } : {}),
  });
  const recovered = await store.markGapStatus(gap.gap_id, "recovered", {
    ...(recoveredRunId ? { runId: recoveredRunId } : {}),
  });
  res.status(200).json({
    object: "device_local_collector_gap",
    device_id: deviceId,
    connector_id: connectorId,
    connector_instance_id: connectorInstanceId,
    source_instance_id: sourceInstanceId,
    gap_id: recovered.gap_id,
    stream: syntheticStream,
    reason,
    retryable: false,
    status: recovered.status,
    attempt_count: recovered.attempt_count,
    first_seen_at: null,
    first_seen_run_id: recovered.discovered_run_id ?? null,
    last_run_id: recovered.last_run_id ?? recoveredRunId,
    updated_at: recovered.updated_at,
  });
}

// POST /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/local-collector-gaps
export function mountRefDeviceExporterLocalCollectorGaps(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.post(
    "/_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/local-collector-gaps",
    ctx.requireDeviceExporterCredential,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId as string);
        if (deviceId !== req.deviceExporter?.deviceId) {
          ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
          return;
        }
        const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId as string);
        const authorized = await resolveAuthorizedDeviceSource(ctx, req, res, deviceId, sourceInstanceId, {
          notFoundStatus: 404,
        });
        if (!authorized) {
          return;
        }
        const { sourceInstance, connectorInstance } = authorized;

        const body = (req.body as Record<string, unknown>) || {};
        const base = parseGapBodyBase(ctx, res, body, sourceInstance, sourceInstanceId, deviceId);
        if (!base) {
          return;
        }
        const fields = validateGapReportFields(ctx, res, body);
        if (!fields) {
          return;
        }

        await reportLocalCollectorGap(
          ctx,
          res,
          base,
          fields,
          body,
          deviceId,
          sourceInstanceId,
          connectorInstance.connectorInstanceId
        );
      } catch (err) {
        if (err && (err as { code?: string }).code === "invalid_request") {
          ctx.pdppError(res, 400, "invalid_request", (err as Error).message, (err as { param?: string }).param || null);
          return;
        }
        ctx.handleError(res, err);
        return;
      }
    }
  );
}

// POST /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/local-collector-gaps/recovered
export function mountRefDeviceExporterLocalCollectorGapsRecovered(
  app: AppLike,
  ctx: MountRefDeviceExportersContext
): void {
  app.post(
    "/_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/local-collector-gaps/recovered",
    ctx.requireDeviceExporterCredential,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId as string);
        if (deviceId !== req.deviceExporter?.deviceId) {
          ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
          return;
        }
        const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId as string);
        const authorized = await resolveAuthorizedDeviceSource(ctx, req, res, deviceId, sourceInstanceId, {
          notFoundStatus: 404,
        });
        if (!authorized) {
          return;
        }
        const { sourceInstance, connectorInstance } = authorized;

        const body = (req.body as Record<string, unknown>) || {};
        const base = parseGapBodyBase(ctx, res, body, sourceInstance, sourceInstanceId, deviceId);
        if (!base) {
          return;
        }

        const recoveredRunId =
          typeof body.recovered_run_id === "string" && (body.recovered_run_id as string).trim()
            ? (body.recovered_run_id as string).trim()
            : null;
        await recoverLocalCollectorGap(
          ctx,
          res,
          base,
          recoveredRunId,
          deviceId,
          sourceInstanceId,
          connectorInstance.connectorInstanceId
        );
      } catch (err) {
        if (err && (err as { code?: string }).code === "invalid_request") {
          ctx.pdppError(res, 400, "invalid_request", (err as Error).message, (err as { param?: string }).param || null);
          return;
        }
        ctx.handleError(res, err);
        return;
      }
    }
  );
}
