// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { createHash } from "node:crypto";
import type { CollectionScope } from "@pdpp/reference-contract/evidence";
import {
  handleLocalDeviceTerminalCollection,
  handleLocalDeviceTerminalRunCommit,
} from "../../operations/local-device-terminal-collection.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import { type DeviceAttemptContext, fingerprintDeviceAttemptManifest } from "../device-ingest-attempt-context.ts";
import { parseDeviceScopeRequest, resolveEnrollmentScope } from "../enrollment-scope-narrowing.ts";
import { deriveReferenceFreshness } from "../freshness.ts";
import { presentHeartbeatHealth } from "../heartbeat-lease.ts";
import { buildStoredCollectionScope, COLLECTION_SCOPE_STATE_KEY } from "../local-collection-scope.ts";
import { assertRecordIdentity, normalizePrimaryKey } from "../record-expand-helpers.ts";
import { commitTerminalRun } from "../stores/terminal-run-commit-store.ts";
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
  end: () => unknown;
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
  put: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const DEFAULT_FINAL_INDEX_PLAN_CONCURRENCY = 4;
const DEFAULT_BATCH_ATTEMPT_DEADLINE_MS = 60_000;

let deviceIngestStoreFaultHook: ((point: string) => void) | null = null;
let deviceIngestPhaseFaultHook: ((point: string, inputIndex?: number) => void | Promise<void>) | null = null;

export function __setDeviceIngestStoreFaultHookForTest(hook: ((point: string) => void) | null): void {
  deviceIngestStoreFaultHook = typeof hook === "function" ? hook : null;
}

/**
 * Deterministic, test-only interruption seam for the durable device attempt
 * state machine. The production route never installs this hook. Keeping its
 * phases adjacent to their committed boundaries lets the conformance oracle
 * prove restart behavior without replacing shipped route dependencies.
 */
export function __setDeviceIngestPhaseFaultHookForTest(
  hook: ((point: string, inputIndex?: number) => void | Promise<void>) | null
): void {
  deviceIngestPhaseFaultHook = typeof hook === "function" ? hook : null;
}

function maybeDeviceIngestStoreFault(point: string): void {
  deviceIngestStoreFaultHook?.(point);
}

async function maybeDeviceIngestPhaseFault(point: string, inputIndex?: number): Promise<void> {
  await deviceIngestPhaseFaultHook?.(point, inputIndex);
}

// Serializes concurrent HTTP attempts for the SAME (deviceId, batchId) — an
// in-process, batch-identity-scoped lock, DELIBERATELY NOT the
// connector-instance write coordinator. Two simultaneous retries of the
// identical batch (a collector retry racing the original attempt after a
// transport hiccup) must collapse onto one real execution -- one embedding
// run, one durable write sequence -- rather than each redoing the same work
// concurrently. Scoping this to the batch identity, not the connector
// instance, is what keeps it from also blocking an unrelated writer (a
// different batch, a blob upload) on the SAME connector instance: that
// exclusion is what the connector-instance fence remains responsible for
// (now per-record, not batch-duration), and it does not need to expand to
// cover this. See harden-connector-instance-write-fence-transaction-native.
const deviceIngestBatchAttemptTails = new Map<string, Promise<void>>();

async function withDeviceIngestBatchAttempt<T>(deviceId: string, batchId: string, operation: () => Promise<T>) {
  const key = `${deviceId}:${batchId}`;
  const previous = deviceIngestBatchAttemptTails.get(key) ?? Promise.resolve();
  const attempt = previous.then(operation, operation);
  const tail = attempt.then(
    () => undefined,
    () => undefined
  );
  deviceIngestBatchAttemptTails.set(key, tail);
  try {
    return await attempt;
  } finally {
    if (deviceIngestBatchAttemptTails.get(key) === tail) {
      deviceIngestBatchAttemptTails.delete(key);
    }
  }
}

let enrollPhaseFaultHook: ((point: string) => void | Promise<void>) | null = null;

/**
 * Deterministic, test-only interruption seam for the first-time enrollment
 * write sequence. Production never installs this hook. Lets the D5 partial-
 * write oracle (fix-enroll-pending-code-partial-write-idempotency) fail a
 * real first attempt AFTER identity creation (device, connector instance,
 * source instance) but BEFORE the code is consumed — the exact durable
 * partial state a live writer-pressure failure or transport drop leaves —
 * without faking storage errors.
 */
export function __setEnrollPhaseFaultHookForTest(hook: ((point: string) => void | Promise<void>) | null): void {
  enrollPhaseFaultHook = typeof hook === "function" ? hook : null;
}

async function maybeEnrollPhaseFault(point: string): Promise<void> {
  await enrollPhaseFaultHook?.(point);
}

// ─── Minimal substrate shapes ────────────────────────────────────────────────

interface DeviceRow {
  readonly agentVersion?: string | null;
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
  readonly acceptedAt?: string | null;
  readonly batchId?: string;
  readonly batchSeq?: number;
  readonly bodyHash: string;
  readonly connectorId?: string;
  readonly connectorInstanceId?: string;
  readonly createdAt: string;
  readonly durablePrefixCount?: number;
  readonly httpStatus?: number | null;
  readonly manifestFingerprint?: string;
  readonly recordCount?: number;
  readonly response?: { accepted_record_count?: number; rejected_record_count?: number } | null;
  readonly semanticCapabilityIdentity?: string;
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
  completeProcessingBatch: (params: {
    deviceId: string;
    batchId: string;
    bodyHash: string;
    sourceInstanceId: string;
    connectorInstanceId: string;
    connectorId: string;
    batchSeq: number;
    acceptedAt: string;
    httpStatus: number;
    response: unknown;
    manifestFingerprint: string;
    semanticCapabilityIdentity: string;
    getCurrentSemanticCapabilityIdentity: () => string;
  }) => Promise<BatchOutcomeRow>;
  consumeEnrollmentCode: (enrollmentCodeId: string, deviceId: string, at: string) => Promise<boolean>;
  createCredential: (params: {
    credentialId: string;
    deviceId: string;
    tokenHash: string;
    createdAt: string;
  }) => Promise<void>;
  createDevice: (params: {
    deviceId: string;
    ownerSubjectId: string;
    displayName: string;
    collectorProtocolVersion: string | null;
    createdAt: string;
    updatedAt: string;
  }) => Promise<void>;
  createEnrollmentCode: (params: {
    enrollmentCodeId: string;
    codeHash: string;
    ownerSubjectId: string;
    connectorId: string;
    localBindingId: string;
    displayName: string | null;
    createdAt: string;
    expiresAt: string;
    collectionScope?: CollectionScope | null;
  }) => Promise<void>;
  ensureProcessingBatch: (params: {
    deviceId: string;
    batchId: string;
    bodyHash: string;
    sourceInstanceId: string;
    connectorInstanceId: string;
    connectorId: string;
    batchSeq: number;
    recordCount: number;
    createdAt: string;
    manifestFingerprint: string;
    semanticCapabilityIdentity: string;
  }) => Promise<BatchOutcomeRow>;
  findCredentialByTokenHash: (hash: string) => Promise<CredentialRow | null>;
  findEnrollmentByCodeHash: (hash: string) => Promise<{
    enrollmentCodeId: string;
    ownerSubjectId: string;
    connectorId: string;
    localBindingId: string;
    displayName: string | null;
    deviceId: string | null;
    status: string;
    expiresAt: string;
    consumedAt: string | null;
    collectionScope?: { since?: string; source_roots?: string[] } | null;
  } | null>;
  getBatchOutcome: (deviceId: string, batchId: string) => Promise<BatchOutcomeRow | null>;
  getDevice: (deviceId: string) => Promise<DeviceRow | null>;
  getSourceInstance: (deviceId: string, sourceInstanceId: string) => Promise<SourceInstanceRow | null>;
  listBatchOutcomes: (options: { limit: number }) => Promise<BatchOutcomeRow[]>;
  listDevices: (ownerSubjectId: string) => Promise<DeviceRow[]>;
  listSourceInstances: (options?: { deviceId?: string | null }) => Promise<SourceInstanceRow[]>;
  markCredentialUsed: (credentialId: string, at: string) => Promise<void>;
  markDeviceHeartbeat: (
    deviceId: string,
    params: { receivedAt: string; agentVersion: string | null; lastError: unknown }
  ) => Promise<void>;
  markSourceInstanceHeartbeat: (
    deviceId: string,
    sourceInstanceId: string,
    params: {
      receivedAt: string;
      lastError: unknown;
      status: string | null;
      recordsPending: number | null;
      outboxDiagnostics: unknown;
    }
  ) => Promise<void>;
  recordBatchOutcome: (params: {
    deviceId: string;
    batchId: string;
    bodyHash: string;
    sourceInstanceId: string;
    status: string;
    httpStatus: number;
    response: unknown;
    createdAt: string;
  }) => Promise<void>;
  refreshProcessingAttemptContext: (params: {
    deviceId: string;
    batchId: string;
    bodyHash: string;
    sourceInstanceId: string;
    connectorInstanceId: string;
    connectorId: string;
    batchSeq: number;
    manifestFingerprint: string;
    semanticCapabilityIdentity: string;
  }) => Promise<BatchOutcomeRow>;
  // Design D6 (fix-enroll-stable-binding-identity-key), qualified by
  // sourceKind per D7 (fix-enroll-source-kind-identity-gap). Atomically
  // resolves the device + placeholder source-instance identity a
  // first-time enroll for this (owner, connector, sourceKind, binding)
  // should use: adopts an existing ORPHANED device (identity created by a
  // prior code's partial write that never had a code successfully
  // consumed, under the SAME sourceKind) if exactly one exists, otherwise
  // creates `candidateDeviceId`/`candidateSourceInstanceId` as a fresh
  // device + placeholder source-instance row (connector_instance_id NULL —
  // the caller's own upsertSourceInstance fills it in afterward via its
  // existing ON CONFLICT target). The placeholder source-instance row MUST
  // be created inside the SAME lock as the device: the orphan lookup
  // requires a device_source_instances row to exist, so creating it outside
  // the lock would leave a window where a concurrent second attempt sees no
  // orphan and creates an independent second device for the same binding.
  // Serialized by a durable Postgres advisory-transaction lock keyed on the
  // (owner, connector, sourceKind, binding) tuple — see the Postgres
  // implementation's doc comment for why this must not be a process-local
  // lock, and why sourceKind is part of the lock/orphan key (a local-device
  // orphan must never be adopted by a browser-collector enrollment sharing
  // the same owner/connector/binding, and vice versa). A device with at
  // least one consumed code (a live, already-completed enrollment) is never
  // adopted here. Callers MUST resolve sourceKind BEFORE calling this
  // method — it is never derived internally.
  resolveOrCreateEnrollmentDevice: (params: {
    ownerSubjectId: string;
    connectorId: string;
    sourceKind: string;
    localBindingId: string;
    candidateDeviceId: string;
    candidateSourceInstanceId: string;
    displayName: string;
    collectorProtocolVersion: string | null;
    now: string;
  }) => Promise<{ deviceId: string; sourceInstanceId: string; adopted: boolean }>;
  revokeDevice: (deviceId: string, at: string) => Promise<void>;
  revokeEnrollmentCode: (id: string, at: string) => Promise<void>;
  // Revoke every non-revoked credential for the device and install exactly one
  // fresh credential (idempotent re-enroll rotation). See
  // decouple-device-enrollment-from-ingest-writer-admission design D2.
  rotateDeviceCredential: (params: {
    credentialId: string;
    deviceId: string;
    tokenHash: string;
    createdAt: string;
    rotatedAt: string;
  }) => Promise<void>;
  upsertSourceInstance: (params: {
    sourceInstanceId: string;
    deviceId: string;
    connectorId: string;
    connectorInstanceId: string;
    localBindingId: string;
    sourceKind: string;
    displayName: string | null;
    createdAt: string;
    updatedAt: string;
  }) => Promise<void>;
}

interface ConnectorInstanceStore {
  get: (connectorInstanceId: string) => Promise<ConnectorInstanceRow | null>;
  getByBinding: (params: {
    ownerSubjectId: string;
    connectorId: string;
    sourceKind: string;
    sourceBindingKey: string;
  }) => Promise<ConnectorInstanceRow | null>;
  listByOwner: (ownerSubjectId: string) => Promise<ConnectorInstanceRow[]>;
  updateStatus: (
    connectorInstanceId: string,
    params: { status: string; updatedAt: string; revokedAt: string }
  ) => Promise<void>;
  upsert: (params: {
    ownerSubjectId: string;
    connectorId: string;
    displayName: string;
    status: string;
    sourceKind: string;
    sourceBindingKey: string;
    sourceBinding: unknown;
    createdAt: string;
    updatedAt: string;
  }) => Promise<ConnectorInstanceRow>;
  upsertForEnrollment: (params: {
    ownerSubjectId: string;
    connectorId: string;
    displayName: string;
    status: string;
    sourceKind: string;
    sourceBindingKey: string;
    sourceBinding: unknown;
    createdAt: string;
    updatedAt: string;
  }) => Promise<ConnectorInstanceRow>;
}

interface ConnectorDetailGapStore {
  listPendingGaps?: (options: {
    connectorId: string;
    connectorInstanceId: string;
    grantId?: string | null;
    limit?: number;
    streams?: readonly string[] | null;
  }) => Promise<GapRow[]>;
  listPendingGapsForConnector?: (connectorId: string, options: { limit: number }) => Promise<GapRow[]>;
  markGapStatus: (gapId: string, status: string, options: { runId?: string }) => Promise<GapRow>;
  upsertPendingGap: (params: {
    connectorId: string;
    connectorInstanceId: string;
    stream: string;
    source: unknown;
    detailLocator: unknown;
    reason: string;
    lastError: unknown;
    discoveredRunId?: string;
    lastRunId?: string;
  }) => Promise<GapRow>;
}

export interface MountRefDeviceExportersContext {
  acceptedCollectorProtocolVersions: readonly string[];

  // Canonical key resolution
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  commitTerminalRun?: typeof commitTerminalRun;
  createRequestConnectorInstanceStore: () => ConnectorInstanceStore;

  // Error class for batch conflict detection
  DeviceBatchConflictError: new (
    message: string
  ) => Error;

  // Stores (created fresh per-request, matching existing pattern)
  deviceExporterStore: DeviceExporterStore;

  // Audit-receipt emission (spine). Used to record idempotent re-enroll
  // credential rotation. See decouple-device-enrollment-from-ingest-writer-admission design D2.
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;

  // Collector protocol enforcement (returns true if 409 was written)
  enforceCollectorProtocolVersion: (req: unknown, res: unknown) => boolean;

  // Record ingest and sync state
  // Schedules an operation onto the SAME per-connector-instance ordered index
  // lane every other writer's derived-index maintenance uses — see
  // `enqueueDeviceIndexMaintenance`'s header in server/records.ts.
  enqueueDeviceIndexMaintenance: (connectorInstanceId: string, operation: () => Promise<void>) => Promise<void>;

  // Catalog entry registration at enroll time
  ensureReferenceConnectorCatalogEntry: (connectorId: string, displayName: string | null) => Promise<void>;
  generateReferenceSecret: (prefix: string, bytes: number) => string;

  // ID generation
  generateSpineId: (prefix: string) => string;
  // Resolves a registered connector manifest by key, or `null` for an unknown
  // connector. Used to derive the enrolled source kind from the manifest
  // bindings. Async to match the host's `getConnectorManifest`.
  getConnectorManifest: (connectorId: string) => Promise<SourceKindManifestLike | null> | SourceKindManifestLike | null;
  getDefaultConnectorDetailGapStore: () => ConnectorDetailGapStore;
  getOwnerSubjectId: (req: unknown) => string;
  getSemanticCapabilityIdentity: () => string;
  getSyncState: (storageTarget: StorageTarget, options: { grantId: null }) => Promise<SyncStateProjection>;
  handleError: (res: unknown, err: unknown) => void;

  // Hashing and sanitization
  hashDeviceSecret: (value: string) => string;
  ingestRecord: (storageTarget: StorageTarget, record: unknown, options?: unknown) => Promise<unknown>;
  isDeviceSemanticAttemptSupported: () => boolean;

  // Safe local-collector coverage read (Section 5.3). Returns only the
  // `{ store, stream, status }` triple per store — never paths, payloads,
  // the coverage `reason` text, or secrets.
  listLocalCoverageDiagnostics: (storageTarget: StorageTarget) => Promise<LocalCoverageRow[]>;
  maintainRecordIndexes: (
    storageTarget: StorageTarget,
    record: unknown,
    expectedVersion: number,
    options?: unknown
  ) => Promise<unknown>;
  makeConnectorInstanceSourceBindingKey: (identity: { kind: string; local_binding_name: string }) => string;
  pdppError: PdppErrorFn;
  prepareDeviceFinalRecords: (
    storageTarget: StorageTarget,
    plan: readonly { inputIndex: number; record: unknown }[],
    attemptContext: DeviceAttemptContext,
    durablePrefixCount: number,
    ownership?: unknown
  ) => Promise<{ inputIndex: number; record: unknown; version?: number }[]>;
  putSyncState: (
    storageTarget: StorageTarget,
    stateMap: Record<string, unknown>,
    options: { grantId: null }
  ) => Promise<SyncStateProjection>;
  readCollectorProtocolHeader: (headers: unknown) => string | null;
  // Resolves a local-collector catalog manifest (claude-code, codex) by key, or
  // `null` for connectors not in the local-collector catalog. Mirrors the
  // intent route so the enroll path classifies a local-collector connector even
  // before any registered connector manifest exists.
  readReferenceLocalConnectorCatalogManifest: (connectorId: string) => SourceKindManifestLike | null;
  requireDeviceExporterCredential: MiddlewareHandler;
  // Auth middleware
  requireOwnerSession: MiddlewareHandler;
  sanitizeDeviceExporterDiagnostic: (value: unknown, depth?: number) => unknown;
  sanitizeLocalCollectorGapDetails: (value: unknown) => string | null;
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

interface ReEnrollableEnrollment {
  collectionScope?: { since?: string; source_roots?: string[] } | null;
  connectorId: string;
  consumedAt: string | null;
  deviceId: string | null;
  displayName: string | null;
  enrollmentCodeId: string;
  expiresAt: string;
  localBindingId: string;
  ownerSubjectId: string;
  status: string;
}

// Idempotent re-enroll (design D2, extended by D5). A retry of an enrollment
// code that already has a live device/binding — whether the code is
// `consumed` (the original transport-failure recovery case: boundDeviceId
// comes from `enrollment.deviceId`) or still `pending` with an already-created
// device row from a first attempt that failed after identity creation but
// before consume (D5: boundDeviceId comes from the code's deterministic
// device id) — is honored ONLY when it resolves to the same device and
// binding. In that case the device credential is atomically rotated (prior
// token invalidated, one fresh token issued), the enrollment code is consumed
// if it is not already, and the existing device/source/connector-instance are
// reused. Returns "handled" after writing a response, or "not_handled" so the
// caller rejects a replay that is not a legitimate same-device/binding retry.
async function handleIdempotentReEnroll(
  ctx: MountRefDeviceExportersContext,
  res: RouteResponse,
  enrollment: ReEnrollableEnrollment,
  boundDeviceId: string | null,
  now: Date
): Promise<"handled" | "not_handled"> {
  if (!boundDeviceId) {
    // No device bound yet for this code: not a recoverable retry target.
    return "not_handled";
  }
  const device = await ctx.deviceExporterStore.getDevice(boundDeviceId);
  if (!device || device.status === "revoked" || device.revokedAt) {
    // The device was revoked; a rotated credential would be meaningless.
    return "not_handled";
  }
  const enrollConnectorKey = ctx.canonicalConnectorKey(enrollment.connectorId) ?? enrollment.connectorId;
  const sourceInstances = await ctx.deviceExporterStore.listSourceInstances({ deviceId: boundDeviceId });
  // Match the SAME binding the code was consumed for. connectorId is compared
  // canonically so a legacy-alias code cannot cross to a different connector.
  const sourceInstance = sourceInstances.find((source) => {
    const sourceConnectorKey = ctx.canonicalConnectorKey(source.connectorId) ?? source.connectorId;
    return (
      source.localBindingId === enrollment.localBindingId &&
      sourceConnectorKey === enrollConnectorKey &&
      source.status !== "revoked" &&
      source.connectorInstanceId
    );
  });
  if (!sourceInstance?.connectorInstanceId) {
    // No live source instance for this binding: cannot prove same-binding retry.
    return "not_handled";
  }

  const credentialId = ctx.generateSpineId("dcred");
  const deviceToken = ctx.generateReferenceSecret("ldt", 32);
  await ctx.deviceExporterStore.rotateDeviceCredential({
    createdAt: now.toISOString(),
    credentialId,
    deviceId: boundDeviceId,
    rotatedAt: now.toISOString(),
    tokenHash: ctx.hashDeviceSecret(deviceToken),
  });

  // D5: a still-pending code reaching this path means a prior attempt created
  // identity but failed before consume — consume it now, bound to the SAME
  // deterministic device this retry resolved to. `WHERE status = 'pending'`
  // makes this a no-op if a concurrent retry already consumed it (exactly-once
  // consume is preserved regardless of how many retries race here).
  if (enrollment.status === "pending") {
    await ctx.deviceExporterStore.consumeEnrollmentCode(enrollment.enrollmentCodeId, boundDeviceId, now.toISOString());
  }

  // Audit receipt: record that a re-enroll retry rotated the device credential.
  await ctx.emitSpineEvent({
    actor_id: boundDeviceId,
    actor_type: "device_enrollment",
    data: {
      connector_id: enrollConnectorKey,
      connector_instance_id: sourceInstance.connectorInstanceId,
      credential_id: credentialId,
      device_id: boundDeviceId,
      local_binding_name: enrollment.localBindingId,
      reason: "idempotent_re_enroll",
      source_instance_id: sourceInstance.sourceInstanceId,
    },
    event_type: "device.enroll.credential_rotated",
    object_id: boundDeviceId,
    object_type: "device_exporter",
    status: "success",
    subject_id: enrollment.ownerSubjectId,
    subject_type: "subject",
    trace_id: ctx.generateSpineId("trace"),
  });

  res.status(201).json({
    connector_id: enrollConnectorKey,
    connector_instance_id: sourceInstance.connectorInstanceId,
    device_id: boundDeviceId,
    device_token: deviceToken,
    local_binding_name: enrollment.localBindingId,
    object: "device_exporter_enrollment",
    source_instance_id: sourceInstance.sourceInstanceId,
  });
  return "handled";
}

// Map an enroll failure to a response. Transient connector-instance write
// pressure is retryable backpressure, not a server fault: return a typed 503
// with Retry-After instead of the misleading untyped 500 that
// `connector_instance_busy` would otherwise become. After the D1 decoupling the
// enroll path should not reach the writer fence at all; this is defense-in-depth.
// See decouple-device-enrollment-from-ingest-writer-admission design D3.
function respondEnrollError(ctx: MountRefDeviceExportersContext, res: RouteResponse, err: unknown): void {
  if ((err as { code?: unknown } | null)?.code === "connector_instance_busy") {
    res.setHeader("Retry-After", "2");
    ctx.pdppError(
      res,
      503,
      "connector_instance_busy",
      "Enrollment is temporarily unavailable due to write pressure; retry shortly",
      null,
      { retry_after_seconds: 2, retryable: true }
    );
    return;
  }
  // Defense-in-depth (design D5, fix-enroll-pending-code-partial-write-idempotency):
  // the deterministic-identity + idempotent-resume path above should make a
  // raw Postgres unique-violation unreachable on this route, but if an
  // untried collision surfaces here it must not read as an owner-facing
  // server fault. Postgres's raw pg driver error code for unique_violation is
  // "23505" regardless of which constraint fired.
  if ((err as { code?: unknown } | null)?.code === "23505") {
    res.setHeader("Retry-After", "1");
    ctx.pdppError(
      res,
      503,
      "enrollment_identity_conflict",
      "Enrollment hit a concurrent identity write; retry the same code",
      null,
      { retry_after_seconds: 1, retryable: true }
    );
    return;
  }
  ctx.handleError(res, err);
}

// First-time enrollment: materialize device, credential, connector instance,
// and source instance, then consume the code as the terminal write. Extracted
// from the enroll handler to keep that handler within the complexity budget;
// the D2 idempotent-retry path (a CONSUMED code) is handled separately by
// handleIdempotentReEnroll.
//
// Identity (design D6, fix-enroll-stable-binding-identity-key): the device
// identity for this (owner, connector, binding) is resolved via
// resolveOrCreateEnrollmentDevice, which EITHER adopts an existing orphaned
// device (identity created by a prior code's partial write that failed
// before consume — never had any code successfully consumed) OR mints a
// fresh device_id, atomically, under a durable Postgres advisory-transaction
// lock keyed on the binding (not a process-local lock — see that method's
// doc comment for why the naive "check then create" sequence races under
// real concurrency). A genuinely NEW enrollment for an already-COMPLETED
// binding (a live device with at least one consumed code) is intentionally
// NOT adopted: that always mints a fresh device, resuming only the stable
// connector_instance (see "re-enrolling the same connector +
// local_binding_name resumes one stable connector_instance" in
// device-exporter-routes.test.js). Every write below is written to be safe
// whether the resolved deviceId was adopted or freshly created: createDevice
// is idempotent (ON CONFLICT DO NOTHING) so re-running it for an adopted
// device is a no-op; the connector-instance/source-instance upserts and the
// credential rotation are unconditionally safe under concurrency by
// construction (see their own comments below).
async function performFirstEnrollment(
  ctx: MountRefDeviceExportersContext,
  req: RouteRequest,
  res: RouteResponse,
  body: Record<string, unknown>,
  enrollment: ReEnrollableEnrollment,
  now: Date,
  effectiveScope: CollectionScope | null
): Promise<void> {
  const collectorProtocolVersion = ctx.readCollectorProtocolHeader(req.headers);
  const candidateDeviceId = ctx.generateSpineId("dexp");
  const candidateSourceInstanceId = ctx.generateSpineId("dsrc");
  const displayName =
    typeof body.device_label === "string" && (body.device_label as string).trim()
      ? (body.device_label as string).trim()
      : enrollment.displayName || enrollment.localBindingId;

  // Canonicalize connector id at the enroll boundary. See
  // canonicalize-connector-keys design Decision 7. Resolved BEFORE the
  // locked resolveOrCreateEnrollmentDevice call so the orphan lookup/create
  // uses the SAME canonical key upsertSourceInstance uses below — otherwise
  // a legacy-alias vs. canonical-key mismatch would defeat
  // upsertSourceInstance's ON CONFLICT(device_id, connector_id,
  // local_binding_id) target against the placeholder row
  // resolveOrCreateEnrollmentDevice creates.
  const enrollConnectorKey = ctx.canonicalConnectorKey(enrollment.connectorId) ?? enrollment.connectorId;

  // Design D7 (fix-enroll-source-kind-identity-gap). sourceKind is derived
  // from the connector manifest bindings BEFORE the identity decision — a
  // `filesystem` connector enrolls as `local_device`, a `browser` connector
  // as `browser_collector`, and a connector with no resolvable binding is
  // rejected (see add-browser-collector-enrollment-primitive design
  // Decision 2) — so it can be included in resolveOrCreateEnrollmentDevice's
  // lock key and orphan-eligibility predicate. Resolving it AFTER identity
  // resolution (the pre-D7 order) would let a local-device orphan be
  // adopted by a browser-collector enrollment sharing the same
  // owner/connector/binding, since the identity decision would have no way
  // to distinguish them.
  const sourceKind = await resolveEnrollmentSourceKind(ctx, enrollConnectorKey);

  const resolved = await ctx.deviceExporterStore.resolveOrCreateEnrollmentDevice({
    candidateDeviceId,
    candidateSourceInstanceId,
    collectorProtocolVersion,
    connectorId: enrollConnectorKey,
    displayName,
    localBindingId: enrollment.localBindingId,
    now: now.toISOString(),
    ownerSubjectId: enrollment.ownerSubjectId,
    sourceKind,
  });
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const deviceId = resolved.deviceId;
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const sourceInstanceId = resolved.sourceInstanceId;

  await ctx.ensureReferenceConnectorCatalogEntry(enrollConnectorKey, enrollment.displayName || displayName);
  const sourceBindingIdentity = deviceExporterSourceBindingIdentity(enrollment.localBindingId, sourceKind);
  const connectorInstance = await ctx.createRequestConnectorInstanceStore().upsertForEnrollment({
    connectorId: enrollConnectorKey,
    createdAt: now.toISOString(),
    displayName,
    ownerSubjectId: enrollment.ownerSubjectId,
    sourceBinding: {
      device_id: deviceId,
      kind: sourceKind,
      local_binding_name: enrollment.localBindingId,
      source_instance_id: sourceInstanceId,
    },
    sourceBindingKey: ctx.makeConnectorInstanceSourceBindingKey(sourceBindingIdentity),
    sourceKind,
    status: "active",
    updatedAt: now.toISOString(),
  });
  await ctx.deviceExporterStore.upsertSourceInstance({
    connectorId: enrollConnectorKey,
    connectorInstanceId: connectorInstance.connectorInstanceId,
    createdAt: now.toISOString(),
    deviceId,
    displayName: enrollment.displayName,
    localBindingId: enrollment.localBindingId,
    sourceInstanceId,
    sourceKind,
    updatedAt: now.toISOString(),
  });

  // Apply the EFFECTIVE boundary the route already resolved (server-declared
  // narrowed-or-honored by the device's request, or the honest recent-history
  // default when neither side declared anything — see
  // `enrollment-scope-narrowing.ts`/`resolveEffectiveEnrollmentScope`). This
  // is the FIRST write to `connector_state.$collection_scope` for this
  // connection, so there is no prior proof to declassify — unlike
  // `owner-connection-collection-scope.ts`'s PUT handler, which changes an
  // already-declared boundary. `effectiveScope: null` is itself a real,
  // deliberate declaration (an explicit full pass), written the same way as
  // any other boundary — never left unwritten, which is why this call is
  // unconditional rather than gated on truthiness.
  const scopeTarget = referenceLocalDeviceStorageTarget(ctx, enrollConnectorKey, connectorInstance.connectorInstanceId);
  const storedScope = buildStoredCollectionScope(effectiveScope, now.toISOString());
  await ctx.putSyncState(scopeTarget, { [COLLECTION_SCOPE_STATE_KEY]: storedScope }, { grantId: null });

  // Test-only interruption point: identity (device, connector instance,
  // source instance) is now fully durable; the code is still pending. This is
  // the exact partial state a live writer-pressure failure or transport drop
  // leaves before consume. Production never installs this hook.
  await maybeEnrollPhaseFault("after_identity_before_consume");

  // Credential is rotated, not plain-inserted: two genuinely concurrent
  // first attempts for the same still-empty binding could otherwise both
  // INSERT a distinct active credential for the SAME resolved device (both
  // resolveOrCreateEnrollmentDevice calls serialize on the binding lock and
  // could both legitimately adopt/create the identical device across two
  // separate lock acquisitions if, e.g., the first created it and released
  // the lock before the second's transaction began). On Postgres,
  // rotateDeviceCredential's transaction locks the device's OWN identity row
  // (SELECT ... FOR UPDATE on device_exporters) before revoking/inserting —
  // NOT just the row locks the revoke UPDATE happens to touch, which take no
  // lock at all when the device has zero prior credential rows (exactly the
  // first-attempt case here). Locking the device row is what makes exactly-
  // one-active-credential a database-enforced invariant across concurrent
  // attempts, including the empty-credential-row case — the same guarantee
  // D2 already gives a retried CONSUMED code.
  const credentialId = ctx.generateSpineId("dcred");
  const deviceToken = ctx.generateReferenceSecret("ldt", 32);
  await ctx.deviceExporterStore.rotateDeviceCredential({
    createdAt: now.toISOString(),
    credentialId,
    deviceId,
    rotatedAt: now.toISOString(),
    tokenHash: ctx.hashDeviceSecret(deviceToken),
  });

  // Test-only interruption point: this attempt's own credential rotation has
  // committed; the code is still pending. Lets a test observe the exact
  // post-rotation, pre-consume database state — before the `!consumed`
  // fallback below (which itself calls rotateDeviceCredential again) can run
  // and mask a rotation-serialization defect by cleaning it up. Production
  // never installs this hook.
  await maybeEnrollPhaseFault("after_rotation_before_consume");

  const consumed = await ctx.deviceExporterStore.consumeEnrollmentCode(
    enrollment.enrollmentCodeId,
    deviceId,
    now.toISOString()
  );
  if (!consumed) {
    // A concurrent attempt for the SAME code already consumed it first. Two
    // distinct shapes are possible, both legitimate under real concurrency:
    //
    //   1. The winner's resolveOrCreateEnrollmentDevice ran BEFORE this
    //      attempt's own — the winner's device was still an unconsumed
    //      orphan when THIS attempt's binding-locked lookup ran, so this
    //      attempt adopted the SAME device (deviceId === the winner's). No
    //      orphan was created; resolve it exactly like a genuine retry:
    //      rotate again (this attempt's token was never returned to any
    //      client, so invalidating it here is free) and return 201 with a
    //      token this response actually delivers.
    //   2. The winner had ALREADY consumed its code by the time this
    //      attempt's lookup ran — this attempt's device no longer showed as
    //      an orphan (a device with a consumed code is excluded), so this
    //      attempt minted a genuinely SEPARATE, now-orphaned device. That
    //      device must not be left dangling with an active credential
    //      nothing will ever revoke; revoke it before rejecting.
    //
    // Re-read the code's row to see which device actually won the consume
    // race — deviceId matching that winner is the ONLY valid signal for
    // shape 1. Do NOT infer shape 1 from "handleIdempotentReEnroll found a
    // live source instance for this binding": performFirstEnrollment always
    // creates a source instance for enrollment.localBindingId on THIS
    // attempt's own device too, so that check alone cannot distinguish "this
    // IS the winner's device" from "this is a same-binding orphan that
    // happens to look valid" — it would incorrectly treat shape 2 as shape 1
    // and rotate/return a credential for an abandoned device nothing will
    // ever clean up.
    const winningEnrollment = await ctx.deviceExporterStore.findEnrollmentByCodeHash(
      ctx.hashDeviceSecret(requireNonEmptyString(body.enrollment_code, "enrollment_code"))
    );
    if (winningEnrollment?.deviceId === deviceId) {
      const retry = await handleIdempotentReEnroll(ctx, res, enrollment, deviceId, now);
      if (retry === "handled") {
        return;
      }
    }
    // Not shape 1 (or handleIdempotentReEnroll declined even the confirmed
    // winner, e.g. a revoke raced in): this attempt's device is not the one
    // that actually won the code. Revoke it so no active credential for an
    // abandoned device survives this request.
    await ctx.deviceExporterStore.revokeDevice(deviceId, now.toISOString());
    ctx.pdppError(res, 409, "invalid_request", "Enrollment code was consumed by another device", "enrollment_code");
    return;
  }

  res.status(201).json({
    connector_id: enrollConnectorKey,
    connector_instance_id: connectorInstance.connectorInstanceId,
    device_id: deviceId,
    device_token: deviceToken,
    local_binding_name: enrollment.localBindingId,
    object: "device_exporter_enrollment",
    source_instance_id: sourceInstanceId,
  });
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
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
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
    if (seconds !== null && (maxSeconds === null || seconds > maxSeconds)) {
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

function isDrainedHealthyLocalHeartbeat(
  status: string | null,
  recordsPending: number | null,
  outbox: unknown
): boolean {
  return (
    status === "healthy" &&
    (recordsPending === null || recordsPending === 0) &&
    deriveSourceInstanceOutboxState(outbox) === "drained"
  );
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
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
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
        last_error: body.last_error ?? null,
        outbox: body.outbox ?? null,
        records_pending: typeof body.records_pending === "number" ? body.records_pending : null,
        source_instance_id: body.source_instance_id,
        status: typeof body.status === "string" ? body.status : null,
      },
    ];
  }
  return [];
}

function normalizeDeviceIngestRecord(record: unknown, index: number) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    const err = new Error(`records[${index}] must be an object`) as Error & { code: string; param: string };
    err.code = "invalid_request";
    err.param = "records";
    throw err;
  }
  const r = record as Record<string, unknown>;
  const key = r.record_key ?? r.key;
  if (key === null || (typeof key !== "string" && !Array.isArray(key))) {
    const err = new Error(`records[${index}].record_key is required`) as Error & { code: string; param: string };
    err.code = "invalid_request";
    err.param = "records";
    throw err;
  }
  const op = r.op === undefined ? "upsert" : r.op;
  if (op !== "upsert" && op !== "delete") {
    const err = new Error(`records[${index}].op must be 'upsert' or 'delete'`) as Error & {
      code: string;
      param: string;
    };
    err.code = "invalid_request";
    err.param = "records";
    throw err;
  }
  const hasData = Object.hasOwn(r, "data");
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const data = r.data;
  if (op === "upsert") {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      const err = new Error(`records[${index}].data must be an object for upsert`) as Error & {
        code: string;
        param: string;
      };
      err.code = "invalid_request";
      err.param = "records";
      throw err;
    }
  } else if (hasData && (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length > 0)) {
    const err = new Error(`records[${index}].data must be omitted or {} for delete`) as Error & {
      code: string;
      param: string;
    };
    err.code = "invalid_request";
    err.param = "records";
    throw err;
  }
  return {
    data: op === "delete" ? {} : data,
    emitted_at: typeof r.emitted_at === "string" ? r.emitted_at : undefined,
    key,
    op,
    stream: requireNonEmptyString(r.stream, `records[${index}].stream`),
  };
}

function normalizeDeviceIngestRecords(records: unknown): unknown[] {
  if (!Array.isArray(records) || records.length === 0) {
    const err = new Error("records must be a non-empty array") as Error & { code: string; param: string };
    err.code = "invalid_request";
    err.param = "records";
    throw err;
  }
  return records.map(normalizeDeviceIngestRecord);
}

function attemptContextError(message: string): Error {
  const err = new Error(message) as Error & { code: string; param: string };
  err.code = "invalid_request";
  err.param = "records";
  return err;
}

function retryableSemanticAttemptError(): Error {
  const err = new Error("required semantic indexing is temporarily unavailable") as Error & { code: string };
  err.code = "semantic_attempt_unavailable";
  return err;
}

function retryableBatchAttemptDeadlineError(): Error {
  const err = new Error("device ingest batch attempt deadline elapsed") as Error & { code: string };
  err.code = "device_ingest_retryable";
  return err;
}

function safeDeviceIngestAttemptError(): Error {
  const err = new Error("Device ingest is temporarily unavailable; retry the same batch") as Error & { code: string };
  err.code = "device_ingest_retryable";
  return err;
}

function declaredFields(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((field): field is string => typeof field === "string" && field.length > 0)
    : [];
}

function attemptStreamFacts(rawStreams: unknown[]): Record<string, DeviceAttemptContext["streams"][string]> {
  const streams: Record<string, DeviceAttemptContext["streams"][string]> = {};
  for (const value of rawStreams) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const stream = value as Record<string, unknown>;
    if (typeof stream.name !== "string" || !stream.name) {
      continue;
    }
    const query = stream.query as Record<string, unknown> | null;
    const search =
      query && typeof query.search === "object" && !Array.isArray(query.search)
        ? (query.search as Record<string, unknown>)
        : null;
    streams[stream.name] = {
      consentTimeField:
        typeof stream.consent_time_field === "string" && stream.consent_time_field ? stream.consent_time_field : null,
      cursorField: typeof stream.cursor_field === "string" && stream.cursor_field ? stream.cursor_field : null,
      lexicalFields: declaredFields(search?.lexical_fields),
      primaryKey: normalizePrimaryKey(stream.primary_key),
      semanticFields: declaredFields(search?.semantic_fields),
    };
  }
  return streams;
}

function validateAttemptRecords(records: unknown[], streams: DeviceAttemptContext["streams"]): void {
  for (const [index, value] of records.entries()) {
    const record = value as { stream?: unknown; key?: unknown; data?: unknown };
    const facts = typeof record.stream === "string" ? streams[record.stream] : null;
    if (!facts) {
      throw attemptContextError(`records[${index}].stream is not declared by the connector manifest`);
    }
    try {
      assertRecordIdentity(facts.primaryKey, record.key, record.data);
    } catch {
      // Identity guards are intentionally detailed for general server writes,
      // but device envelopes must never reflect key/data values or raw guard
      // messages. The index is enough to repair the collector payload.
      // biome-ignore lint/style/useErrorCause: This compatibility path preserves the established error shape and propagation.
      throw attemptContextError(`records[${index}] has invalid record identity`);
    }
  }
}

/**
 * Pure except for the one manifest read: validate every record and reduce the
 * manifest to the exact facts the durable and index seams require.  This is
 * deliberately performed before `ensureProcessingBatch`; malformed new input
 * therefore cannot leave a resumable reservation behind.
 */
async function compileDeviceAttemptContext(
  ctx: MountRefDeviceExportersContext,
  connectorId: string,
  records: unknown[]
): Promise<DeviceAttemptContext> {
  const manifest = await ctx.getConnectorManifest(connectorId);
  const rawManifest = manifest as (Record<string, unknown> & { streams?: unknown }) | null;
  const rawStreams = rawManifest && Array.isArray(rawManifest.streams) ? rawManifest.streams : null;
  if (!(rawManifest && rawStreams)) {
    throw attemptContextError("connector manifest is unavailable for device ingest");
  }
  const streams = attemptStreamFacts(rawStreams);
  validateAttemptRecords(records, streams);
  const requiresSemanticWork = records.some((record) => {
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const stream = (record as { stream?: unknown }).stream;
    return typeof stream === "string" && (streams[stream]?.semanticFields.length ?? 0) > 0;
  });
  if (requiresSemanticWork && !ctx.isDeviceSemanticAttemptSupported()) {
    throw retryableSemanticAttemptError();
  }
  return {
    manifestFingerprint: fingerprintDeviceAttemptManifest(rawManifest),
    semanticCapabilityIdentity: ctx.getSemanticCapabilityIdentity(),
    streams,
  };
}

function canonicalDeviceJson(value: unknown): string {
  return JSON.stringify(canonicalDeviceValue(value));
}

function canonicalDeviceHash(value: unknown): string {
  return createHash("sha256").update(canonicalDeviceJson(value)).digest("hex");
}

function canonicalDeviceValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalDeviceValue);
  }
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) {
      canonical[key] = canonicalDeviceValue(child);
    }
  }
  return canonical;
}

function canonicalDeviceRecords(records: unknown): { hash: string; records: unknown[] } {
  if (!Array.isArray(records)) {
    const err = new Error("records must be a non-empty array") as Error & { code: string; param: string };
    err.code = "invalid_request";
    err.param = "records";
    throw err;
  }
  const canonicalJson = canonicalDeviceJson(records);
  return {
    hash: createHash("sha256").update(canonicalJson).digest("hex"),
    records: JSON.parse(canonicalJson) as unknown[],
  };
}

/**
 * Reconstruct the hash emitted by the shipped durable collector. Its outbox
 * stores full LocalDeviceRecordEnvelope rows, hashes that array, and projects
 * those rows down to the wire `records` shape at send time. Every omitted
 * envelope field is present in the request identity, so the server can verify
 * this compatibility representation without trusting an opaque client hash.
 */
function canonicalCollectorEnvelopeHash(
  records: unknown[],
  identity: {
    batchId: string;
    batchSeq: number;
    connectorId: string;
    deviceId: string;
    sourceInstanceId: string;
  }
): string {
  const envelopes = records.map((value) => {
    const record =
      value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const body = {
      connector_id: identity.connectorId,
      data: record.data,
      emitted_at: record.emitted_at,
      record_key: String(record.record_key),
      stream: record.stream,
    };
    return {
      batch_id: identity.batchId,
      batch_seq: identity.batchSeq,
      body_hash: canonicalDeviceHash(body),
      device_id: identity.deviceId,
      source_instance_id: identity.sourceInstanceId,
      ...body,
    };
  });
  return canonicalDeviceHash(envelopes);
}

function finalIndexPlanConcurrency(): number {
  const requested = Number.parseInt(process.env.PDPP_INGEST_FINAL_INDEX_PLAN_CONCURRENCY || "", 10);
  return Number.isInteger(requested) && requested > 0 ? Math.min(requested, 8) : DEFAULT_FINAL_INDEX_PLAN_CONCURRENCY;
}

function batchAttemptDeadlineMs(): number {
  const requested = Number.parseInt(process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS || "", 10);
  if (!Number.isInteger(requested) || requested <= 0) {
    return DEFAULT_BATCH_ATTEMPT_DEADLINE_MS;
  }
  return Math.min(requested, 10 * 60_000);
}

function assertBatchAttemptBefore(deadline: number): void {
  if (performance.now() > deadline) {
    throw retryableBatchAttemptDeadlineError();
  }
}

function finalDeviceRecordPlan(records: unknown[], connectorInstanceId: string) {
  const finalRecords = new Map<string, { inputIndex: number; record: unknown }>();
  for (const [inputIndex, recordValue] of records.entries()) {
    const record = recordValue as { stream?: unknown; key?: unknown };
    const encodedKey = Array.isArray(record.key) ? JSON.stringify(record.key) : String(record.key);
    finalRecords.set(`${connectorInstanceId}\u0000${String(record.stream)}\u0000${encodedKey}`, {
      inputIndex,
      record: recordValue,
    });
  }
  return [...finalRecords.values()].sort((left, right) => left.inputIndex - right.inputIndex);
}

function deviceBatchIdentityMatches(
  outcome: BatchOutcomeRow,
  params: {
    bodyHash: string;
    sourceInstanceId: string;
    connectorInstanceId: string;
    connectorId: string;
    batchSeq: number;
  }
): boolean {
  if (!(outcome.connectorInstanceId || outcome.connectorId)) {
    return outcome.bodyHash === params.bodyHash && outcome.sourceInstanceId === params.sourceInstanceId;
  }
  return (
    outcome.bodyHash === params.bodyHash &&
    outcome.sourceInstanceId === params.sourceInstanceId &&
    outcome.connectorInstanceId === params.connectorInstanceId &&
    outcome.connectorId === params.connectorId &&
    outcome.batchSeq === params.batchSeq
  );
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
    // biome-ignore lint/suspicious/useArraySortCompare: Input ordering is intentionally the runtime’s established default string order.
    unaccounted_stores: unaccountedStores.sort(),
  };
}

function accumulateGapRow(stats: GapStatMap, gap: GapRow): void {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (gap?.status !== "pending") {
    return;
  }
  const src = gap.source && typeof gap.source === "object" ? (gap.source as Record<string, unknown>) : null;
  if (src?.kind !== "local_device") {
    return;
  }
  const sourceInstanceId = typeof src.source_instance_id === "string" ? src.source_instance_id : null;
  if (!sourceInstanceId) {
    return;
  }
  const current = stats.get(sourceInstanceId) ?? { lastUpdatedAt: null, pending: 0, reasons: new Set<string>() };
  current.pending += 1;
  if (!current.lastUpdatedAt || (gap.updated_at && gap.updated_at > current.lastUpdatedAt)) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
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
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
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
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
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
    const current = map.get(key) ?? { accepted: 0, lastIngestAt: null, rejected: 0 };
    if (outcome.status === "accepted") {
      current.accepted += outcome.response?.accepted_record_count ?? 0;
    } else if (outcome.status === "rejected") {
      current.rejected += outcome.response?.rejected_record_count ?? 0;
    }
    if (
      outcome.status === "accepted" &&
      outcome.acceptedAt &&
      (!current.lastIngestAt || outcome.acceptedAt > current.lastIngestAt)
    ) {
      current.lastIngestAt = outcome.acceptedAt;
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
  coverageByConnectorInstance: Map<string, LocalCoverageProjection>,
  now: number
): unknown {
  const stats = outcomeStats.get(source.sourceInstanceId) ?? { accepted: 0, lastIngestAt: null, rejected: 0 };
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
  // Last status without age is not current health. A one-shot collector that
  // was killed leaves its last lifecycle status in the column forever, so the
  // presented health is derived against the declared lease and the raw column
  // is kept alongside as evidence rather than as the answer.
  const heartbeatHealth = presentHeartbeatHealth({
    lastHeartbeatAt: source.lastHeartbeatAt,
    lastHeartbeatStatus: source.lastHeartbeatStatus,
    nowIso: new Date(now).toISOString(),
  });
  return {
    accepted_record_count: stats.accepted,
    connector_id: source.connectorId,
    connector_instance_id: connectorInstance?.connectorInstanceId ?? null,
    created_at: source.createdAt,
    device_id: source.deviceId,
    display_name: source.displayName,
    heartbeat_age_ms: heartbeatHealth.ageMs,
    // Presented health: the collector's status only while within lease,
    // otherwise `stale`/`unknown`. This is what a reader should render.
    heartbeat_health: heartbeatHealth.status,
    // The lease the age was judged against, so a reader can see the policy
    // that produced `heartbeat_health` instead of inferring it.
    heartbeat_lease_ms: heartbeatHealth.leaseMs,
    last_error: source.lastError,
    last_heartbeat_at: source.lastHeartbeatAt ?? null,
    // Raw last-observed column, retained as evidence. NOT current health —
    // read `heartbeat_health` for that.
    last_heartbeat_status: source.lastHeartbeatStatus ?? null,
    last_ingest_at: stats.lastIngestAt,
    local_binding_name: source.localBindingId,
    local_collector_coverage:
      (connectorInstance?.connectorInstanceId
        ? coverageByConnectorInstance.get(connectorInstance.connectorInstanceId)
        : null) ?? EMPTY_LOCAL_COVERAGE,
    local_collector_gaps: {
      last_updated_at: gap ? gap.lastUpdatedAt : null,
      pending_count: gap ? gap.pending : 0,
      reasons: gap ? [...gap.reasons].sort() : [],
      unreliable: unreliableIds.has(source.connectorId),
    },
    object: "device_source_instance",
    outbox_diagnostics: outboxDiagnostics,
    outbox_state: deriveSourceInstanceOutboxState(outboxDiagnostics),
    records_pending: source.recordsPending ?? null,
    rejected_record_count: stats.rejected,
    source_instance_id: source.sourceInstanceId,
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
      maximumStalenessSeconds,
      now,
      recordLastUpdatedAt: lastHeartbeatAt,
    }).status === "stale";
  return {
    // Build-derived agent version the device last reported on a heartbeat (e.g.
    // `0.0.0+43f63825f01a`), persisted on the device row. Owner-only diagnostic:
    // it lets an owner see which collector build a host is running — and catch
    // stale-build drift — without inspecting `dist/` mtimes on the machine.
    // Additive and nullable: a device that has never reported a version surfaces
    // `null` and is not alarmed on its absence.
    agent_version: device.agentVersion ?? null,
    created_at: device.createdAt,
    device_id: device.deviceId,
    display_name: device.displayName,
    last_error: device.lastError,
    last_heartbeat_at: lastHeartbeatAt,
    last_ingest_at: lastIngestAt,
    object: "device_exporter",
    revoked_at: device.revokedAt,
    source_instances: sourceList,
    stale,
    status: device.status,
    subject_id: device.ownerSubjectId,
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
    connectorInstancesByBinding,
    connectorInstancesById,
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
      coverageByConnectorInstance,
      now
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
  if (sourceInstance?.status !== "active") {
    ctx.pdppError(
      res,
      notFoundStatus,
      notFoundStatus === 404 ? "not_found" : "invalid_request",
      `Unknown source_instance_id '${sourceInstanceId}'`,
      "source_instance_id"
    );
    return null;
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
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
  return { connectorInstance, sourceInstance };
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
    connectorId: ctx.canonicalConnectorKey(sourceInstance.connectorId) ?? sourceInstance.connectorId,
    ownerSubjectId,
    sourceBindingKey: ctx.makeConnectorInstanceSourceBindingKey(identity),
    sourceKind: "local_device",
  });
  if (instance?.status !== "active") {
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
        // The owner minting this code (dashboard/owner-agent) MAY declare the
        // boundary the device should enroll within — the SAME
        // `{since?, source_roots?}` shape and reject-not-coerce validation
        // `enrollment-scope-narrowing.ts`'s `parseDeviceScopeRequest` already
        // enforces for what a device may separately REQUEST at enroll time.
        // Staged here on the code (mirroring `mintEnrollmentNextStep`'s
        // owner-bearer path) rather than written to `connector_state`
        // directly, because no connection exists yet to hold it.
        const parsedOwnerScope = parseDeviceScopeRequest(body.collection_scope);
        if (!parsedOwnerScope.ok) {
          ctx.pdppError(res, 400, "invalid_request", parsedOwnerScope.message, "collection_scope");
          return;
        }
        const ownerDeclaredScope = parsedOwnerScope.request.kind === "declared" ? parsedOwnerScope.request.scope : null;

        const enrollmentCode = ctx.generateReferenceSecret("lde", 18);
        const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
        await ctx.deviceExporterStore.createEnrollmentCode({
          codeHash: ctx.hashDeviceSecret(enrollmentCode),
          collectionScope: ownerDeclaredScope,
          connectorId,
          createdAt: now.toISOString(),
          displayName:
            typeof body.display_name === "string" && (body.display_name as string).trim()
              ? (body.display_name as string).trim()
              : null,
          enrollmentCodeId: ctx.generateSpineId("denroll"),
          expiresAt,
          localBindingId,
          ownerSubjectId: ctx.getOwnerSubjectId(req),
        });
        res.status(201).json({
          collection_scope: ownerDeclaredScope,
          connector_id: connectorId,
          enrollment_code: enrollmentCode,
          expires_at: expiresAt,
          local_binding_name: localBindingId,
          object: "device_exporter_enrollment_code",
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// Handles a CONSUMED enrollment code (design D2): the original transport-
// failure case, where the response was lost after the code was marked
// consumed and enrollment.deviceId is already fixed. Returns true when a
// response was written (either the D2 idempotent-resume succeeded, or the
// replay was explicitly rejected) — the caller must not proceed to
// performFirstEnrollment either way, since a CONSUMED code can never be
// claimed by consumeEnrollmentCode (`WHERE status = 'pending'`); letting a
// declined replay fall through would create a brand-new, unrelated,
// unclaimable device masked as success by ITS OWN
// resolveOrCreateEnrollmentDevice/rotateDeviceCredential succeeding before
// the doomed consume attempt is even reached. Returns false only for a
// PENDING code, which performFirstEnrollment handles (its partial-write /
// stable-binding resume, design D5/D6, is resolved separately and
// atomically inside performFirstEnrollment via resolveOrCreateEnrollmentDevice
// — a durable, lock-serialized decision; doing an orphan lookup here too
// would create exactly the check-then-act race that lock exists to prevent).
async function respondIfConsumedCodeReplay(
  ctx: MountRefDeviceExportersContext,
  res: RouteResponse,
  enrollment: ReEnrollableEnrollment,
  now: Date
): Promise<boolean> {
  if (enrollment.status !== "consumed") {
    return false;
  }
  const retry = await handleIdempotentReEnroll(ctx, res, enrollment, enrollment.deviceId, now);
  if (retry === "handled") {
    return true;
  }
  ctx.pdppError(res, 400, "invalid_request", "Enrollment code is invalid or already used", "enrollment_code");
  return true;
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
        if (!enrollment || (enrollment.status !== "pending" && enrollment.status !== "consumed")) {
          ctx.pdppError(res, 400, "invalid_request", "Enrollment code is invalid or already used", "enrollment_code");
          return;
        }
        // Expiry is enforced for BOTH first enrollment and idempotent retry: a
        // consumed-but-expired code is no longer a valid retry target.
        if (Date.parse(enrollment.expiresAt) <= now.getTime()) {
          if (enrollment.status === "pending") {
            await ctx.deviceExporterStore.revokeEnrollmentCode(enrollment.enrollmentCodeId, now.toISOString());
          }
          ctx.pdppError(res, 410, "invalid_request", "Enrollment code has expired", "enrollment_code");
          return;
        }

        // A device MAY offer a scope alongside the code (a `connect`-style
        // collector's --recent/--all/--since). It is validated and resolved
        // against whatever the enrollment code already declared BEFORE any
        // state changes, so a malformed or widening request is rejected with
        // nothing consumed or written — same fail-closed posture as an
        // invalid enrollment_code. See `enrollment-scope-narrowing.ts`.
        const parsedScope = parseDeviceScopeRequest(body.collection_scope);
        if (!parsedScope.ok) {
          ctx.pdppError(res, 400, "invalid_request", parsedScope.message, "collection_scope");
          return;
        }
        const scopeVerdict = resolveEnrollmentScope({
          device: parsedScope.request,
          now: now.toISOString(),
          serverDeclared: enrollment.collectionScope,
        });
        if (!scopeVerdict.accepted) {
          ctx.pdppError(res, 400, "invalid_request", scopeVerdict.reason, "collection_scope");
          return;
        }

        if (await respondIfConsumedCodeReplay(ctx, res, enrollment, now)) {
          return;
        }

        await performFirstEnrollment(ctx, req, res, body, enrollment, now, scopeVerdict.effective);
      } catch (err) {
        respondEnrollError(ctx, res, err);
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
          data: await buildDeviceExporterDiagnostics(ctx, ctx.getOwnerSubjectId(req)),
          object: "list",
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
        res.json({ data, object: "list" });
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
          data: await buildDeviceExporterDiagnostics(ctx, ctx.getOwnerSubjectId(req)),
          object: "list",
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
        res.json({ device_id: deviceId, object: "device_exporter_revocation", revoked_at: revokedAt });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// POST /_ref/device-exporters/:deviceId/self-revoke
//
// A device credential may revoke itself, never another device: auth is the
// device's own bearer token (not an owner session), and the path deviceId
// must match the credential that authenticated the request. This is the
// route `pdpp-local-collector logout` calls before deleting its local
// profile — without it, a local device has no way to close its own
// server-side lane, and logout could only ever delete local state while the
// device token stayed live against the reference deployment indefinitely.
export function mountRefDeviceExporterSelfRevoke(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.post(
    "/_ref/device-exporters/:deviceId/self-revoke",
    { contract: "refSelfRevokeDeviceExporter" },
    ctx.requireDeviceExporterCredential,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId as string);
        if (deviceId !== req.deviceExporter?.deviceId) {
          ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
          return;
        }
        const revokedAt = new Date().toISOString();
        await ctx.deviceExporterStore.revokeDevice(deviceId, revokedAt);
        res.json({ device_id: deviceId, object: "device_exporter_revocation", revoked_at: revokedAt });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

async function markHeartbeatSourceInstance(input: {
  ctx: MountRefDeviceExportersContext;
  deviceId: string;
  receivedAt: string;
  req: RouteRequest;
  res: RouteResponse;
  source: unknown;
}): Promise<boolean> {
  const { ctx, deviceId, receivedAt, req, res, source } = input;
  const s = source as Record<string, unknown>;
  const sourceInstanceId = requireNonEmptyString(s.source_instance_id, "source_instance_id");
  const authorized = await resolveAuthorizedDeviceSource(ctx, req, res, deviceId, sourceInstanceId);
  if (!authorized) {
    return false;
  }

  const status = typeof s.status === "string" ? s.status : null;
  const recordsPending = typeof s.records_pending === "number" ? s.records_pending : null;
  const outboxDiagnostics = (s.outbox as unknown) ?? null;
  await ctx.deviceExporterStore.markSourceInstanceHeartbeat(deviceId, sourceInstanceId, {
    lastError: ctx.sanitizeDeviceExporterDiagnostic(s.last_error),
    outboxDiagnostics,
    receivedAt,
    recordsPending,
    status,
  });
  if (
    isDrainedHealthyLocalHeartbeat(status, recordsPending, outboxDiagnostics) &&
    authorized.connectorInstance.connectorInstanceId
  ) {
    await recoverDrainedPolicyBudgetGaps(
      ctx,
      authorized.sourceInstance.connectorId,
      authorized.connectorInstance.connectorInstanceId
    );
  }
  return true;
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
          agentVersion: typeof body.agent_version === "string" ? body.agent_version : null,
          lastError: ctx.sanitizeDeviceExporterDiagnostic(body.last_error),
          receivedAt,
        });
        for (const source of normalizeHeartbeatSourceInstances(body)) {
          // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
          const accepted = await markHeartbeatSourceInstance({ ctx, deviceId, receivedAt, req, res, source });
          if (!accepted) {
            return;
          }
        }
        res.json({
          device_id: deviceId,
          object: "device_exporter_heartbeat",
          received_at: receivedAt,
          status: "accepted",
        });
      } catch (err) {
        ctx.handleError(res, err);
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
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this boundary deliberately keeps credential, identity, hash, and response precedence visible together.
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
        const requestConnectorId = requireNonEmptyString(body.connector_id, "connector_id");
        if (!Number.isInteger(body.batch_seq) || (body.batch_seq as number) < 0) {
          ctx.pdppError(res, 400, "invalid_request", "batch_seq must be a non-negative integer", "batch_seq");
          return;
        }
        const authorized = await resolveAuthorizedDeviceSource(ctx, req, res, deviceId, sourceInstanceId);
        if (!authorized) {
          return;
        }
        const { sourceInstance, connectorInstance } = authorized;
        const sourceConnectorMatches = sameConnectorType(ctx, sourceInstance.connectorId, requestConnectorId);
        // Reservation identity and attempt facts use the canonical connector
        // key, not the URL/legacy alias supplied by the collector. This keeps
        // aliases on one CAS/reservation namespace while preserving the
        // source-binding authorization check above.
        const connectorId = ctx.canonicalConnectorKey(requestConnectorId) ?? requestConnectorId;
        const canonical = canonicalDeviceRecords(body.records);
        const collectorEnvelopeHash = canonicalCollectorEnvelopeHash(canonical.records, {
          batchId,
          batchSeq: body.batch_seq as number,
          connectorId: requestConnectorId,
          deviceId,
          sourceInstanceId,
        });
        if (!SHA256_HEX.test(bodyHash) || (bodyHash !== canonical.hash && bodyHash !== collectorEnvelopeHash)) {
          ctx.pdppError(
            res,
            400,
            "device_batch_hash_mismatch",
            "body_hash does not match canonical records",
            "body_hash"
          );
          return;
        }

        await processDeviceIngestBatch(ctx, res, {
          batchId,
          batchSeq: body.batch_seq as number,
          bodyHash,
          connectorId,
          connectorInstanceId: connectorInstance.connectorInstanceId,
          deviceId,
          records: normalizeDeviceIngestRecords(canonical.records),
          sourceConnectorMatches,
          sourceInstanceId,
        });
      } catch (err) {
        if (err instanceof ctx.DeviceBatchConflictError) {
          ctx.pdppError(
            res,
            409,
            "device_batch_conflict",
            "Device ingest batch identity conflicts with an existing batch"
          );
          return;
        }
        const code = (err as { code?: unknown } | null)?.code;
        if (
          code === "connector_instance_busy" ||
          code === "device_ingest_retryable" ||
          code === "record_index_busy" ||
          code === "semantic_work_busy" ||
          code === "semantic_attempt_unavailable" ||
          code === "transformer_work_busy"
        ) {
          res.setHeader("Retry-After", "1");
          ctx.pdppError(
            res,
            503,
            "device_ingest_retryable",
            "Device ingest is temporarily unavailable; retry the same batch"
          );
          return;
        }
        if (code === "invalid_request") {
          // These messages are authored by the device preflight boundary and
          // contain no payload values. Unknown errors, including reservation
          // and manifest/storage failures, must use the fixed retry envelope.
          ctx.handleError(res, err);
          return;
        }
        res.setHeader("Retry-After", "1");
        ctx.pdppError(
          res,
          503,
          "device_ingest_retryable",
          "Device ingest is temporarily unavailable; retry the same batch"
        );
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
    batchSeq: number;
    connectorInstanceId: string;
    records: unknown[];
    sourceConnectorMatches: boolean;
  }
): Promise<void> {
  const {
    deviceId,
    connectorId,
    sourceInstanceId,
    batchId,
    bodyHash,
    batchSeq,
    connectorInstanceId,
    records,
    sourceConnectorMatches,
  } = params;
  const identity = { batchSeq, bodyHash, connectorId, connectorInstanceId, sourceInstanceId };
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this boundary keeps reservation, durable prefix, derived repair, and terminal response precedence visible.
  await withDeviceIngestBatchAttempt(deviceId, batchId, async () => {
    // Reservation bookkeeping (lookup, ensure/refresh the `processing` row) is
    // self-serialized on BATCH identity by `withDeviceIngestBatchAttempt`
    // above (an in-process, batch-scoped lock) and by the store's own
    // durable exclusion (`ensureProcessingBatch`'s INSERT-conflict on
    // `(device_id, batch_id)`, `completeProcessingBatch`'s `SELECT ... FOR
    // UPDATE` + `durable_prefix_count = record_count` CAS) — it never needs
    // the connector-instance-wide fence. No connector-instance fence is held
    // across this bookkeeping, so it can never make an unrelated
    // same-instance writer (e.g. a concurrent blob upload) queue behind it,
    // matching `ingestRecords`'s identical reasoning for the HTTP batch
    // path. See harden-connector-instance-write-fence-transaction-native.
    maybeDeviceIngestStoreFault("before-get-batch-outcome");
    const existing = await ctx.deviceExporterStore.getBatchOutcome(deviceId, batchId);
    if (existing) {
      if (!deviceBatchIdentityMatches(existing, identity)) {
        ctx.pdppError(
          res,
          409,
          "device_batch_conflict",
          "Device ingest batch identity conflicts with an existing batch"
        );
        return;
      }
      if (existing.status === "accepted") {
        res.status(existing.httpStatus ?? 201).json(existing.response ?? {});
        return;
      }
    }

    // New malformed candidates retain the historical 400, but an existing
    // device/batch reservation owns conflict precedence.
    if (!sourceConnectorMatches) {
      ctx.pdppError(res, 400, "invalid_request", "connector_id does not match source_instance_id", "connector_id");
      return;
    }

    // Accepted replays returned above intentionally do not consult the current
    // manifest or semantic backend. Every new/processing attempt does.
    const attemptContext = await compileDeviceAttemptContext(ctx, connectorId, records);

    maybeDeviceIngestStoreFault("before-ensure-processing-batch");
    let reservation = await ctx.deviceExporterStore.ensureProcessingBatch({
      batchId,
      batchSeq,
      bodyHash,
      connectorId,
      connectorInstanceId,
      createdAt: new Date().toISOString(),
      deviceId,
      manifestFingerprint: attemptContext.manifestFingerprint,
      recordCount: records.length,
      semanticCapabilityIdentity: attemptContext.semanticCapabilityIdentity,
      sourceInstanceId,
    });
    if (reservation.status === "accepted") {
      res.status(reservation.httpStatus ?? 201).json(reservation.response ?? {});
      return;
    }
    await maybeDeviceIngestPhaseFault("after-reservation");
    // A retry can find a processing row from a prior manifest/backend. Keep its
    // durable cursor intact, replace only frozen facts, and repair every final
    // key below under the rebuilt attempt context.
    if (
      reservation.manifestFingerprint !== attemptContext.manifestFingerprint ||
      reservation.semanticCapabilityIdentity !== attemptContext.semanticCapabilityIdentity
    ) {
      maybeDeviceIngestStoreFault("before-refresh-processing-attempt-context");
      reservation = await ctx.deviceExporterStore.refreshProcessingAttemptContext({
        batchId,
        batchSeq,
        bodyHash,
        connectorId,
        connectorInstanceId,
        deviceId,
        manifestFingerprint: attemptContext.manifestFingerprint,
        semanticCapabilityIdentity: attemptContext.semanticCapabilityIdentity,
        sourceInstanceId,
      });
    }
    // Hoisted so the catch boundary below can report how far the durable
    // prefix had advanced when the attempt failed — the single fact that
    // distinguishes a batch stuck with work remaining from one stranded
    // with every record already durable.
    const start = reservation.durablePrefixCount ?? 0;
    try {
      const storageTarget = referenceLocalDeviceStorageTarget(ctx, connectorId, connectorInstanceId);
      const attemptDeadline = performance.now() + batchAttemptDeadlineMs();
      const durableVersionByInputIndex = new Map<number, number>();
      for (let inputIndex = start; inputIndex < records.length; inputIndex += 1) {
        const record = records[inputIndex];
        assertBatchAttemptBefore(attemptDeadline);
        // EACH record acquires its own fresh, short-lived connector-instance
        // fence here — no batch-long `coordinatorOwnership` is threaded
        // through, unlike the old design. `requireConnectionAdmission: true`
        // re-checks the connector-instance row still exists inside THIS
        // record's own locked transaction, closing the delete/write TOCTOU
        // for every record in the batch, not only the first (mirrors
        // `ingestRecords`'s per-record HTTP-path fix). This is what keeps an
        // UNRELATED same-instance writer (e.g. a concurrent blob upload) from
        // queuing behind the whole batch's duration — see
        // harden-connector-instance-write-fence-transaction-native.
        // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
        const ingestOutcome = await ctx.ingestRecord(storageTarget, record, {
          attemptContext,
          deferIndexes: true,
          deviceReservation: {
            batchId,
            batchSeq,
            bodyHash,
            connectorId,
            connectorInstanceId,
            deviceId,
            inputIndex,
            sourceInstanceId,
          },
          requireConnectionAdmission: true,
        });
        // Captured for the final-plan's derived-index publish below: that
        // step needs to know the version EACH final key's content was
        // durably committed at, to gate lexical/semantic publication on it
        // still being current (see maintainRecordIndexesWithinPermit's
        // header). A no-op/unchanged write has no new version to capture —
        // the prior durable version for that key (if this input collapses
        // into a repeat within the same batch) or the reservation's replay
        // path already covers that case via prepareDeviceFinalRecords.
        if (
          ingestOutcome &&
          typeof ingestOutcome === "object" &&
          "version" in ingestOutcome &&
          typeof ingestOutcome.version === "number"
        ) {
          durableVersionByInputIndex.set(inputIndex, ingestOutcome.version);
        }
        await maybeDeviceIngestPhaseFault("after-durable-record", inputIndex);
        assertBatchAttemptBefore(attemptDeadline);
      }
      await maybeDeviceIngestPhaseFault("after-durable-phase");

      // From here on every record is durable, so all that remains is derived
      // repair/publish plus the reservation's status transition.
      //
      // The deadline still bounds THIS phase on an attempt that arrived with
      // durable work to do (`start < records.length`): abandoning it is safe
      // and cheap, because the prefix cursor it just advanced means the retry
      // resumes strictly closer to done.
      //
      // It must NOT bound a RESUMED attempt that arrived already fully
      // durable (`start === records.length`). Such an attempt has nothing
      // left to abandon — it re-runs the same final-plan repair and embedding
      // publish every time — so aborting it strands the reservation
      // `processing` with a FULL durable prefix in exactly the state it
      // started in. Nothing reaps such a row, so the collector retried the
      // identical batch, blew the identical deadline, and 503'd again,
      // forever: a self-sustaining livelock that wedged ~45% of live batches
      // (one row reached 1058 attempts over ~8 hours). Letting the resumed
      // attempt run to `completeProcessingBatch` is what makes an
      // already-durable reservation self-heal, including rows wedged by an
      // earlier build. See `runFullPrefixDeadlineOracle`.
      const resumedFullyDurable = start >= records.length;
      const settleDeadline = resumedFullyDurable ? Number.POSITIVE_INFINITY : attemptDeadline;

      const finalPlan = finalDeviceRecordPlan(records, connectorInstanceId);
      assertBatchAttemptBefore(settleDeadline);
      // No `coordinatorOwnership` passthrough here either: `prepareDeviceFinalRecords`
      // acquires its own fresh fence ONLY when it actually has repair work to
      // do (a retry whose durable prefix already covered some final keys) —
      // see its own short-circuit for the common first-attempt case.
      const preparedFinalPlan = await ctx.prepareDeviceFinalRecords(storageTarget, finalPlan, attemptContext, start);
      assertBatchAttemptBefore(settleDeadline);
      // A repaired (retry-repaired) entry already carries its own fresh
      // `version` from `prepareDeviceFinalRecords`'s reread. A fresh
      // (non-repaired) entry's version comes from THIS attempt's own durable
      // loop above, keyed by its final `inputIndex` (finalDeviceRecordPlan
      // collapses duplicate keys to the last input index that wrote them).
      const authoritativeFinalPlan = preparedFinalPlan.map((entry) => ({
        ...entry,
        version: typeof entry.version === "number" ? entry.version : durableVersionByInputIndex.get(entry.inputIndex),
      }));
      // Index maintenance stays SYNCHRONOUS (awaited before the HTTP
      // response), preserving the device-exporter contract that 201 implies
      // lexical/semantic state is already searchable — unlike `ingestRecords`,
      // which defers this work fire-and-forget. It does NOT run inside any
      // connector-instance FENCE: `maintainRecordIndexes` uses its own
      // unrelated admission semaphore (`withIndexWork`), never the write
      // coordinator, so running it here (after every record's fence has
      // already released) cannot make an unrelated same-instance writer
      // queue behind it. It runs on the shared per-instance ordered index
      // LANE (`enqueueDeviceIndexMaintenance`) every other writer uses for
      // THROUGHPUT/scheduling reasons only — keeping this batch's slow
      // embedding work off an unrelated same-instance writer's critical
      // path. Correctness against a same-instance direct writer racing this
      // batch's publish does NOT come from the lane's ordering: each
      // `maintainRecordIndexes` call below is gated on `records.version`
      // still matching the `version` captured above at the moment its own
      // short publish transaction commits (see
      // `maintainRecordIndexesWithinPermit`'s header) — a stale publish
      // silently no-ops regardless of enqueue/completion order. See
      // harden-connector-instance-write-fence-transaction-native.
      await ctx.enqueueDeviceIndexMaintenance(connectorInstanceId, async () => {
        await mapWithConcurrency(
          authoritativeFinalPlan,
          finalIndexPlanConcurrency(),
          async ({ record, inputIndex, version }) => {
            assertBatchAttemptBefore(settleDeadline);
            if (typeof version !== "number") {
              // No durable version could be resolved for this key (e.g. it was
              // never actually written this attempt and has no repair reread
              // either) — nothing to gate a publish against, so there is
              // nothing safe to publish. Left dirty for the reconcile sweep.
              return;
            }
            await ctx.maintainRecordIndexes(storageTarget, record, version, {
              attemptContext,
              deviceFinalInputIndex: inputIndex,
            });
            assertBatchAttemptBefore(settleDeadline);
          }
        );
      });
      // Deliberately NO deadline check between the last publish and
      // `completeProcessingBatch`: once the publish loop is done the only
      // remaining step is the status transition, and throwing there would
      // strand a fully-durable reservation for no benefit.
      const response = {
        accepted_record_count: records.length,
        batch_id: batchId,
        body_hash: bodyHash,
        connector_instance_id: connectorInstanceId,
        device_id: deviceId,
        object: "device_ingest_batch_result",
        rejected_record_count: 0,
        source_instance_id: sourceInstanceId,
        status: "accepted",
      };
      maybeDeviceIngestStoreFault("before-complete-processing-batch");
      await ctx.deviceExporterStore.completeProcessingBatch({
        acceptedAt: new Date().toISOString(),
        batchId,
        batchSeq,
        bodyHash,
        connectorId,
        connectorInstanceId,
        deviceId,
        getCurrentSemanticCapabilityIdentity: () => ctx.getSemanticCapabilityIdentity(),
        httpStatus: 201,
        manifestFingerprint: attemptContext.manifestFingerprint,
        response,
        semanticCapabilityIdentity: attemptContext.semanticCapabilityIdentity,
        sourceInstanceId,
      });
      await maybeDeviceIngestPhaseFault("after-accepted-commit");
      res.status(201).json(response);
    } catch (err) {
      // Server-log-only diagnosability, mirroring the ingest-rejection
      // contract proven by rs-ingest-systemic-failure-server-log.test.ts.
      // The collector's 503 envelope is a fixed, bounded template by design
      // (see the redaction rationale below), which previously left the real
      // cause of a stuck device batch visible NOWHERE: no client detail, no
      // server line. That silence is how a livelock wedging ~45% of live
      // batches ran for hours with 219 ingest POSTs in 12 minutes and not a
      // single error/warn line to point at it. Identifiers only — never
      // record content.
      const cause = err as { code?: unknown; message?: unknown } | null;
      console.error(
        `[device-ingest] batch attempt failed device_id=${deviceId} batch_id=${batchId} ` +
          `connector_instance_id=${connectorInstanceId} batch_seq=${batchSeq} record_count=${records.length} ` +
          `durable_prefix_start=${start} code=${String(cause?.code ?? "unknown")}: ${String(cause?.message ?? "unknown")}`
      );
      // Once a processing reservation exists, no storage/index/model/SQL
      // diagnostic is safe to expose to a collector. The reservation remains
      // sticky and the fixed retry envelope lets the next attempt resume it.
      // Deliberately NO `cause`: the real error is already on the server log
      // above, and attaching it here would risk it reaching the collector.
      throw safeDeviceIngestAttemptError();
    }
  });
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
          connector_instance_id: connectorInstance.connectorInstanceId,
          device_id: deviceId,
          object: "device_source_instance_state",
          source_instance_id: sourceInstanceId,
          state: projection.state ?? {},
          updated_at: projection.updated_at ?? null,
        });
      } catch (err) {
        ctx.handleError(res, err);
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
          connector_instance_id: connectorInstance.connectorInstanceId,
          device_id: deviceId,
          object: "device_source_instance_state",
          source_instance_id: sourceInstanceId,
          state: projection.state ?? {},
          updated_at: projection.updated_at ?? null,
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
  mountRefDeviceExporterTerminalCollection(app, ctx);
  mountRefDeviceExporterTerminalRunCommit(app, ctx);
}

// POST /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/terminal-collection
// A collector reports this only after successful DONE, full batch drain, and
// coverage-checkpoint acknowledgement. It is intentionally not synthesized
// from accepted batches or heartbeats: neither proves which streams ran.
export function mountRefDeviceExporterTerminalCollection(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.post(
    "/_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/terminal-collection",
    ctx.requireDeviceExporterCredential,
    async (req: RouteRequest, res: RouteResponse) =>
      await handleLocalDeviceTerminalCollection({
        ctx,
        req,
        res,
        resolveAuthorizedSource: async (deviceId, sourceInstanceId) =>
          await resolveAuthorizedDeviceSource(ctx, req, res, deviceId, sourceInstanceId, { notFoundStatus: 404 }),
        sameConnectorType: (left, right) => sameConnectorType(ctx, left, right),
      })
  );
}

// POST /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/terminal-run-commits
export function mountRefDeviceExporterTerminalRunCommit(app: AppLike, ctx: MountRefDeviceExportersContext): void {
  app.post(
    "/_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/terminal-run-commits",
    { contract: "refCommitDeviceExporterTerminalRun" },
    ctx.requireDeviceExporterCredential,
    async (req: RouteRequest, res: RouteResponse) =>
      await handleLocalDeviceTerminalRunCommit({
        ctx: {
          ...ctx,
          commitTerminalRun: ctx.commitTerminalRun ?? commitTerminalRun,
        },
        req,
        res,
        resolveAuthorizedSource: async (deviceId, sourceInstanceId) =>
          await resolveAuthorizedDeviceSource(ctx, req, res, deviceId, sourceInstanceId, { notFoundStatus: 404 }),
      })
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
  const source = { device_id: deviceId, kind: "local_device", source_instance_id: sourceInstanceId };
  return { connectorId, detailLocator, reason, source, streamBoundary, streamName, syntheticStream };
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
  return { details, firstSeenAt };
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
    detailLocator,
    lastError,
    reason,
    source,
    stream: syntheticStream,
    ...(firstSeenRunId ? { discoveredRunId: firstSeenRunId } : {}),
    ...(lastRunId ? { lastRunId } : {}),
  });
  res.status(201).json({
    attempt_count: gap.attempt_count,
    connector_id: connectorId,
    connector_instance_id: connectorInstanceId,
    device_id: deviceId,
    first_seen_at: firstSeenAt,
    first_seen_run_id: firstSeenRunId,
    gap_id: gap.gap_id,
    last_run_id: gap.last_run_id ?? lastRunId,
    object: "device_local_collector_gap",
    reason,
    retryable: body.retryable,
    source_instance_id: sourceInstanceId,
    status: gap.status,
    stream: syntheticStream,
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
    detailLocator,
    lastError: { recovered_at: new Date().toISOString(), recovered_by: "local_collector" },
    reason,
    source,
    stream: syntheticStream,
    ...(recoveredRunId ? { discoveredRunId: recoveredRunId, lastRunId: recoveredRunId } : {}),
  });
  const recovered = await store.markGapStatus(gap.gap_id, "recovered", {
    ...(recoveredRunId ? { runId: recoveredRunId } : {}),
  });
  res.status(200).json({
    attempt_count: recovered.attempt_count,
    connector_id: connectorId,
    connector_instance_id: connectorInstanceId,
    device_id: deviceId,
    first_seen_at: null,
    first_seen_run_id: recovered.discovered_run_id ?? null,
    gap_id: recovered.gap_id,
    last_run_id: recovered.last_run_id ?? recoveredRunId,
    object: "device_local_collector_gap",
    reason,
    retryable: false,
    source_instance_id: sourceInstanceId,
    status: recovered.status,
    stream: syntheticStream,
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
      }
    }
  );
}
