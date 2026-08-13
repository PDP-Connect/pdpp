// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { parseCoverageDiagnosticsStateSnapshot } from "../../packages/polyfill-connectors/src/local-source-inventory.ts";
/**
 * PDPP Resource Server — record storage and grant-enforced query
 */
import { getDb } from "./db.ts";
import { assertGrantedManifestReadAuthority, assertManifestReadAuthority } from "./manifest-read-authority.ts";

// Optional post-commit hook for outbound client event subscriptions. The
// hook is invoked after a `record_changes` row has been durably committed
// for an `ingestRecord` call. It is intentionally untyped here so the
// records module stays decoupled from the subscriptions store; the host
// adapter installs the real implementation in `startServer`.
let __clientEventEnqueueHook: ClientEventEnqueueHook | null = null;
export function setClientEventEnqueueHook(fn: unknown): void {
  __clientEventEnqueueHook = isClientEventEnqueueHook(fn) ? fn : null;
}
function __invokeClientEventEnqueueHook(change: ClientEventChange): void {
  if (!__clientEventEnqueueHook) {
    return;
  }
  try {
    Promise.resolve(__clientEventEnqueueHook(change)).catch(() => {
      /* surfaced via attempt log */
    });
  } catch {
    /* hook errors must not retroactively roll back ingest */
  }
}

import {
  allowUnboundedReadAcknowledged,
  type BindValue,
  exec,
  execReturningOne,
  getOne,
  iterate,
  iterateDynamicSqlAcknowledged,
  type ReadOneQuery,
  referenceQueries,
  writeTransaction,
} from "../lib/db.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import {
  buildLimitClampedWarning,
  CANONICAL_WARNING_CODES,
  clampRecordsPageLimit,
  enforceConnectionNarrowing,
  resolveRequestConnectionId,
  validateConnectionAlias as validateConnectionAliasShared,
} from "./connection-id-request.ts";
import {
  AmbiguousConnectionError,
  projectBindingForWire,
  resolveRecordIdentityForBinding,
  resolveRequestBindings,
} from "./connection-identity.ts";
import { assertConnectorInstanceWritableStatus } from "./connector-instance-admission.ts";
import {
  type ConnectorInstanceWriteOwnership,
  withConnectorInstanceWrite,
} from "./connector-instance-write-coordinator.ts";
import { canonicalConnectorKey } from "./connector-key.ts";
import { markConnectorSummaryEvidenceDirty } from "./connector-summary-read-model.ts";
import { applyDatasetSummaryRecordDelta, markDatasetSummaryProjectionStale } from "./dataset-summary-read-model.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "./owner-auth.ts";
import {
  postgresDeleteAllRecords,
  postgresDeleteRecord,
  postgresGetDatasetBlobBytes,
  postgresGetDatasetRecordChangesBytes,
  postgresGetDatasetRecordsAggregate,
  postgresGetDatasetRecordTimeBounds,
  postgresGetRecord,
  postgresGetRecordFieldWindow,
  postgresIngestRecord,
  postgresListAllStreams,
  postgresListDatasetTopConnectorCandidates,
  postgresListStreams,
  postgresPrepareDeviceFinalRecords,
  postgresQueryRecords,
} from "./postgres-records.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "./postgres-storage.ts";
import {
  assertRecordIdentity,
  assertSafeJsonField,
  buildEffectiveFilter,
  type ExpandResult,
  invalidQueryError,
  normalizeExpandRequest,
  normalizePrimaryKey,
  parseIntegerValue,
} from "./record-expand-helpers.ts";
import {
  assertFieldPath,
  assertFieldVisibleToGrant,
  assertReadableStringField,
  buildWindowEnvelope,
  classifyFieldType,
  fieldWindowError,
  normalizeWindowSelector,
  sqliteFieldJsonPath,
} from "./record-field-window.ts";
import { type CompiledFilter, compileRequestFilters, passesRequestFilters, passesTimeRange } from "./record-filters.ts";
import {
  applyRetainedSizeRecordDelta,
  markRetainedSizeConnectionDirty,
  markRetainedSizeStreamDirty,
} from "./retained-size-read-model.ts";
import { createStorageBackend } from "./storage-backend.ts";
import {
  getChangeHistoryLimit,
  nowIso,
  resolveStorageConnectorId,
  resolveStorageConnectorInstanceId,
} from "./storage-utils.ts";
import { makeDefaultAccountConnectorInstanceId } from "./stores/connector-instance-store.ts";
import { getDefaultConnectorStateStore } from "./stores/connector-state-store.ts";
import { advanceSqliteDeviceIngestPrefix } from "./stores/device-exporter-store.ts";

export { resolveRecordIdentityForBinding } from "./connection-identity.ts";

// Search routes depend on auth, which in turn owns record routes. Index
// maintenance is a post-commit effect, so load these narrow write helpers at
// that boundary instead of creating a static route/import cycle.
const LEXICAL_INDEX_MODULE = "./search.ts";
const SEMANTIC_INDEX_MODULE = "./search-semantic.ts";
interface RecordIndexIdentity {
  connectorId: string;
  connectorInstanceId: string;
  recordKey: string;
  stream: string;
}

interface RecordIndexStreamIdentity {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
}

interface RecordIndexUpsert extends RecordIndexIdentity {
  data: unknown;
  declaredFields?: string[] | undefined;
}

async function lexicalIndexDelete(args: RecordIndexIdentity): Promise<void> {
  await (await import(LEXICAL_INDEX_MODULE)).lexicalIndexDelete(args);
}

async function lexicalIndexDeleteByConnectorStream(args: RecordIndexStreamIdentity): Promise<void> {
  await (await import(LEXICAL_INDEX_MODULE)).lexicalIndexDeleteByConnectorStream(args);
}

async function lexicalIndexUpsert(args: RecordIndexUpsert): Promise<void> {
  await (await import(LEXICAL_INDEX_MODULE)).lexicalIndexUpsert(args);
}

async function semanticIndexDelete(args: RecordIndexIdentity): Promise<void> {
  await (await import(SEMANTIC_INDEX_MODULE)).semanticIndexDelete(args);
}

async function semanticIndexDeleteByConnectorStream(args: RecordIndexStreamIdentity): Promise<void> {
  await (await import(SEMANTIC_INDEX_MODULE)).semanticIndexDeleteByConnectorStream(args);
}

async function semanticIndexUpsert(args: RecordIndexUpsert): Promise<void> {
  await (await import(SEMANTIC_INDEX_MODULE)).semanticIndexUpsert(args);
}

type HookContext = Record<string, unknown>;
type RecordStorageTarget =
  | string
  | {
      connector_id?: string;
      connectorId?: string;
      connector_instance_id?: string;
      connectorInstanceId?: string;
    }
  | null
  | undefined;
type RecordData = Record<string, unknown>;
interface RecordEnvelope {
  data?: unknown;
  emitted_at?: string | null | undefined;
  key: unknown;
  op?: "delete" | "upsert";
  stream: string;
}
interface AttemptStreamFacts {
  consentTimeField?: string | null;
  cursorField?: string | null;
  lexicalFields?: string[];
  primaryKey?: string[];
  semanticFields?: string[];
}
interface AttemptContext {
  streams?: Record<string, AttemptStreamFacts>;
}
type DeviceReservation = Record<string, unknown> & { inputIndex: number };
export interface RecordIngestOptions {
  attemptContext?: AttemptContext;
  coordinatorOwnership?: ConnectorInstanceWriteOwnership;
  deferIndexes?: boolean;
  deviceFinalInputIndex?: number;
  deviceReservation?: DeviceReservation;
  /**
   * Require a current, non-revoked connector-instance row before the durable
   * record mutation. Omitted callers keep the connector-agnostic storage
   * primitive behavior used by repair and compatibility paths.
   */
  requireConnectionAdmission?: boolean;
  /**
   * The run this write belongs to, when known. Present values are checked
   * inside the durable write transaction and fail closed unless the matching
   * run_history row for this connector instance is still running.
   */
  runId?: string | null;
}
interface CurrentRecordRow {
  deleted: boolean | number;
  emitted_at: string | null;
  record_json: string | null;
  version: number;
}
interface VersionAllocationRow {
  max_version: number;
}
type DurableIngestOutcome =
  | { kind: "noop" }
  | { kind: "changed"; op: "delete" | "upsert"; selfHeal: boolean; version: number };
interface RecordIngestOutcome {
  accepted: boolean;
  changed: boolean;
  retainedSizeDelta?: {
    connectorId: string;
    connectorInstanceId: string;
    currentRecordJsonBytesDelta: number;
    recordCountDelta: number;
    recordHistoryCountDelta: number;
    recordHistoryJsonBytesDelta: number;
    stream: string;
  };
  self_healed?: boolean;
  version?: number;
}
export interface ClassifiedIngestFailure {
  code: string;
  message: string;
  retryable: boolean;
}
type DeviceRecordPlanEntry = { inputIndex: number; record: RecordEnvelope } & Record<string, unknown>;
interface JsonSchema {
  format?: string;
  properties?: Record<string, JsonSchema>;
  type?: string | string[];
  [key: string]: unknown;
}
interface ManifestStream {
  consent_time_field?: string;
  cursor_field?: string;
  name?: string;
  primary_key?: unknown;
  query?: {
    aggregations?: Record<string, unknown> | null;
    expand?: Array<{ default_limit?: unknown; max_limit?: unknown; name: string }>;
    range_filters?: Record<string, string[]>;
    search?: { lexical_fields?: string[]; semantic_fields?: string[] };
  };
  relationships?: Array<{ cardinality: string; name: string; stream: string }>;
  schema?: JsonSchema & { required?: string[] };
}
type RequestParams = Record<string, unknown>;
interface StreamGrant {
  connection_id?: string;
  fields?: string[] | null;
  resources?: string[];
  time_range?: { since?: string; until?: string } | null;
}
interface EffectiveReadScope {
  fields: string[] | null;
  resources: string[] | null;
  timeRange: { since?: string; until?: string } | null;
}
interface StoredRecordRow {
  __fk?: unknown;
  emitted_at: string;
  record_json: string;
  record_key: string;
}
interface VisibleRecordRow {
  emitted_at: string;
  rawData: RecordData;
  record_key: string;
  sortPosition: Required<LogicalPosition>;
}
interface FetchVisibleRecordsArgs {
  compiledFilters?: readonly CompiledFilter[];
  connectorId: string;
  connectorInstanceId: string;
  cursorPosition: Required<LogicalPosition> | null;
  effective: EffectiveReadScope;
  limit: number;
  manifestStream: ManifestStream | null | undefined;
  order: PageOrder;
  stream: string;
}
interface RecordIdentity {
  connectionId?: string;
  displayName?: string;
}
interface ResponseRecord {
  connection_id?: string;
  connector_instance_id?: string;
  data?: RecordData;
  deleted?: boolean;
  deleted_at?: string | null;
  display_name?: string;
  emitted_at: string;
  expanded?: Record<string, unknown>;
  id: string;
  meta?: RecordResponseMeta;
  object: "record";
  stream: string;
}
type EffectiveParentRow = VisibleRecordRow & { responseRecord: ResponseRecord };
interface ExpansionChildArgs {
  cardinality: string;
  childEffective: EffectiveReadScope;
  childManifestStream: ManifestStream | null | undefined;
  childStream: string;
  connectorId: string;
  connectorInstanceId: string;
  foreignKeyField: string;
  limit: number;
  parentKeys: string[];
}
interface SnapshotRow {
  deleted: boolean | number;
  deleted_at: string | null;
  emitted_at: string;
  record_json: string | null;
  version: number;
}
interface RecordSnapshot {
  data: RecordData | null;
  deleted: boolean;
  deleted_at: string | null;
  emitted_at: string;
  record_key: string;
  version: number;
}
interface ChangesSinceCursor {
  kind?: "changes_since";
  version: number;
}
interface ReadGrant {
  streams: Array<StreamGrant & { name: string }>;
}
interface ReadManifest {
  streams?: ManifestStream[];
}
interface ListResponse {
  data: ResponseRecord[];
  has_more: boolean;
  meta?: RecordResponseMeta;
  next_changes_since?: string;
  next_cursor?: string;
  object: "list";
}
interface ChangeGroupRow {
  latest_version: number;
  record_key: string;
}
interface VersionCounterRow {
  max_version: number;
}
interface MinVersionRow {
  min_version: number | null;
}
interface AggregateRecordRow {
  record_json: string;
  record_key: string;
}
interface CountMeta {
  kind: "exact";
  value: number;
}
interface WindowMeta {
  earliest_at?: string;
  latest_at?: string;
  total: number;
}
type RecordResponseMeta = Record<string, unknown> & { count?: CountMeta; warnings?: unknown[]; window?: WindowMeta };
interface AggregateGroup {
  count: number;
  key: unknown;
}
interface AggregateResponse {
  approximate: boolean;
  field: string | null;
  filtered_record_count: number;
  granularity: string | null;
  group_by: string | null;
  group_by_time: string | null;
  groups?: AggregateGroup[];
  limit?: number;
  meta?: RecordResponseMeta;
  metric: string;
  object: "aggregation";
  other_count?: number;
  stream: string;
  time_zone: string | null;
  value?: unknown;
}
interface RecordFieldWindowRow {
  consent_time_value: unknown;
  field_type: string | null;
  match_pos: number | null;
  record_key: string;
  total_chars: number | null;
  window_text: string | null;
}
interface StreamSummaryRow {
  last_updated: string | null;
  record_count: number;
  stream: string;
}
interface StreamNamespaceRow {
  connector_instance_id: string;
  stream: string;
}
interface CountRow {
  count: number;
  [key: string]: unknown;
}
interface ConnectionStreamRow {
  stream: string;
}
interface PostgresClient {
  query: <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => Promise<{ rows: Row[] }>;
}
interface ConnectionStreamStore {
  listInstanceStreams: (connectorInstanceId: string) => Promise<readonly ConnectionStreamRow[]>;
}
interface ConnectionTeardown {
  connectorId: string;
  connectorInstanceId: string;
  deletedRecordCount: number;
  streams: readonly string[];
}
type WindowSelector =
  | { limit: number; limitClamped: boolean; mode: "offset"; offset: number }
  | {
      after: number;
      before: number;
      limit: number;
      limitClamped: boolean;
      mode: "query";
      offset: number;
      query: string;
    };
interface ReadBinding {
  connectorId: string;
  connectorInstanceId: string;
  displayName?: string | null;
}
interface ReadWarning {
  code?: string;
  detail?: unknown;
  message?: string;
  param?: string;
}
interface FanInOptions {
  concurrency?: unknown;
  extraWarnings?: ReadWarning[];
  onInFlightChange?: unknown;
  resolveBindingsForStream?: (streamGrant: StreamGrant & { name: string }) => Promise<ReadBinding[]>;
}
interface FieldWindowResponse {
  field_path: string;
  field_type: string;
  record_key: string;
  warnings: ReadWarning[];
  window: Record<string, unknown>;
}
type AggregateResponseShape = Pick<
  AggregateResponse,
  "approximate" | "field" | "granularity" | "group_by" | "group_by_time" | "metric" | "time_zone"
>;
interface AggregateFoldContext {
  aggregateFieldSchema: JsonSchema | null;
  isScalarGroup: boolean;
  isTimeBucket: boolean;
  metric: string;
}
interface AggregateAccumulator {
  bestComparable: number | string | null;
  filteredRecordCount: number;
  mergedBuckets: Map<string, AggregateGroup>;
  mergedLimit: number | null;
  meta: RecordResponseMeta | null;
  responseShape: AggregateResponseShape | null;
  value: unknown;
}
interface DatasetAggregateRow {
  connector_count: number | string | bigint | null;
  earliest_ingested_at: string | null;
  latest_ingested_at: string | null;
  record_count: number | string | bigint | null;
  record_json_bytes: number | string | bigint | null;
  stream_count: number | string | bigint | null;
}
interface DatasetBytesRow {
  blob_bytes?: number | string | bigint | null;
  record_changes_json_bytes?: number | string | bigint | null;
}
interface DatasetConnectorRow {
  connector_id: string;
  record_count: number | string | bigint | null;
}
interface DatasetTimeBoundsRow {
  max_time: string | null;
  min_time: string | null;
}
interface RegisteredConnectorRow {
  connector_id: string;
  manifest: string;
}
interface ConnectorManifestRow {
  manifest: string | null;
}
type StoredManifest = ReadManifest & { connector_id?: unknown; connector_key?: unknown };
interface SqliteDatasetProjectionRow {
  connector_id: string;
  dirty_record_time_bounds: number;
  earliest_ingested_at: string | null;
  latest_ingested_at: string | null;
  record_count: number | string;
  record_json_bytes: number | string;
  stream: string;
}
interface CoverageRecordRow {
  record_json: string;
}
interface CoverageGenerationRow {
  current_generation: number | string | null;
  state_generation: number | string | null;
}
type CodedReadError = Error & {
  available_connections?: unknown[];
  code: string;
  param?: string;
  retry_with?: string;
};
interface StorageBinding {
  connector_id?: string;
  connector_instance_id?: string;
}
interface ReadRequestBindingsArgs {
  grant: ReadGrant;
  nativeProviderStorage?: boolean;
  ownerSubjectId?: string;
  requestParams: RequestParams;
  storageBinding?: StorageBinding | null;
  streamName: string;
}
interface SyncStateOptions {
  allowedStreams?: Iterable<string> | null;
  grantId?: string | null;
}
interface StreamVisibleRow {
  emitted_at: string;
  record_json: string;
  record_key: string;
}
interface StreamListEntry {
  connection_id?: string;
  connector_instance_id?: string;
  display_name?: string;
  last_updated: string | null;
  name: string;
  object: "stream";
  record_count: number;
}
interface LogicalPosition {
  cursor_value?: unknown;
  primary_key?: unknown[];
}
type PageOrder = "ASC" | "DESC";
const SAFE_JSON_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
interface PaginationCursor {
  after_version?: number;
  cursor_value?: unknown;
  order?: unknown;
  primary_key?: unknown;
  session?: unknown;
  session_max_version?: number;
  since_version?: number;
}
type FaultHook = (point: string, context: HookContext) => void;
type AsyncFaultHook = (point: string, context: HookContext) => Promise<void> | void;
type InFlightChange = (inFlight: number) => void;

function buildEffectiveReadScope(
  streamGrant: Parameters<typeof buildEffectiveFilter>[0],
  requestParams: Parameters<typeof buildEffectiveFilter>[1],
  requiredFields: string[] = []
): EffectiveReadScope {
  const effective = buildEffectiveFilter(streamGrant, requestParams, requiredFields);
  const rawTimeRange = effective.timeRange;
  return {
    fields: Array.isArray(effective.fields)
      ? effective.fields.filter((field): field is string => typeof field === "string")
      : null,
    resources: Array.isArray(effective.resources)
      ? effective.resources.filter((resource): resource is string => typeof resource === "string")
      : null,
    timeRange: isRecordData(rawTimeRange)
      ? {
          ...(typeof rawTimeRange.since === "string" ? { since: rawTimeRange.since } : {}),
          ...(typeof rawTimeRange.until === "string" ? { until: rawTimeRange.until } : {}),
        }
      : null,
  };
}

interface IndexWorkWaiter {
  resolve: () => void;
  settled: boolean;
  timer: NodeJS.Timeout;
}
interface ClientEventChange {
  connectionId: string;
  connectorId: string;
  connectorInstanceId: string;
  emittedAt: string;
  stream: string;
  version: number | null;
}
type ClientEventEnqueueHook = (change: ClientEventChange) => Promise<void> | void;

function isClientEventEnqueueHook(value: unknown): value is ClientEventEnqueueHook {
  return typeof value === "function";
}

function isFaultHook(value: unknown): value is FaultHook {
  return typeof value === "function";
}

function isAsyncFaultHook(value: unknown): value is AsyncFaultHook {
  return typeof value === "function";
}

function isInFlightChange(value: unknown): value is InFlightChange {
  return typeof value === "function";
}

function isRecordData(value: unknown): value is RecordData {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function isResponseRecord(value: unknown): value is ResponseRecord {
  return (
    isRecordData(value) &&
    typeof value.id === "string" &&
    typeof value.emitted_at === "string" &&
    value.object === "record" &&
    typeof value.stream === "string"
  );
}

function requireResponseRecord(value: unknown): ResponseRecord {
  if (!isResponseRecord(value)) {
    throw new Error("[records] invalid record response from storage backend");
  }
  return value;
}

function isListResponse(value: unknown): value is ListResponse {
  return (
    isRecordData(value) &&
    Array.isArray(value.data) &&
    value.data.every(isResponseRecord) &&
    typeof value.has_more === "boolean" &&
    value.object === "list"
  );
}

function requireListResponse(value: unknown): ListResponse {
  if (!isListResponse(value)) {
    throw new Error("[records] invalid list response from storage backend");
  }
  return value;
}

function requireStreamList(value: unknown): StreamListEntry[] {
  if (!(Array.isArray(value) && value.every((entry) => isRecordData(entry) && typeof entry.name === "string"))) {
    throw new Error("[records] invalid stream-list response from storage backend");
  }
  return value as StreamListEntry[];
}

function parseStoredRecordData(recordJson: string): RecordData {
  const parsed: unknown = JSON.parse(recordJson);
  if (!isRecordData(parsed)) {
    throw new Error("[records] stored record_json must contain an object");
  }
  return parsed;
}

function asSqliteBindValue(value: unknown): BindValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  throw invalidQueryError("Malformed cursor", "invalid_cursor");
}

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function normalizeFieldWindowSelector(requestParams: RequestParams): WindowSelector {
  const raw = normalizeWindowSelector(requestParams);
  if (!isRecordData(raw) || typeof raw.mode !== "string" || typeof raw.limit !== "number") {
    throw new Error("[records] invalid field window selector");
  }
  if (raw.mode === "offset" && typeof raw.offset === "number" && typeof raw.limitClamped === "boolean") {
    return { limit: raw.limit, limitClamped: raw.limitClamped, mode: "offset", offset: raw.offset };
  }
  if (
    raw.mode === "query" &&
    typeof raw.query === "string" &&
    typeof raw.before === "number" &&
    typeof raw.after === "number" &&
    typeof raw.offset === "number" &&
    typeof raw.limitClamped === "boolean"
  ) {
    return {
      after: raw.after,
      before: raw.before,
      limit: raw.limit,
      limitClamped: raw.limitClamped,
      mode: "query",
      offset: raw.offset,
      query: raw.query,
    };
  }
  throw new Error("[records] invalid field window selector");
}

function isChangedRecordIngestOutcome(
  outcome: RecordIngestOutcome
): outcome is RecordIngestOutcome & { changed: true } {
  return outcome.changed;
}

function connectorIdForStorageTarget(storageTarget: RecordStorageTarget): string {
  const connectorId = resolveStorageConnectorId(storageTarget);
  if (connectorId) {
    return connectorId;
  }
  const error = new Error("connector_id is required for connector sync state.") as Error & { code?: string };
  error.code = "invalid_connector_id";
  throw error;
}
const FAN_IN_READ_CONCURRENCY = 8;
const DEFAULT_INDEX_WORK_LIMIT = 4;
const DEFAULT_INDEX_WORK_QUEUE_LIMIT = 32;
const DEFAULT_INDEX_WORK_ACQUIRE_DEADLINE_MS = 30_000;

export class RecordIndexAdmissionError extends Error {
  code: string;
  constructor() {
    super("record index work is saturated");
    this.name = "RecordIndexAdmissionError";
    this.code = "record_index_busy";
  }
}

const PERMANENT_INGEST_FAILURE_CODES: ReadonlySet<string> = new Set([
  "connector_instance_not_found",
  "connector_instance_not_writable",
  "invalid_record_identity",
]);

export function classifyIngestFailure(err: unknown): ClassifiedIngestFailure {
  const message = err instanceof Error ? err.message : String(err);
  const codeField = (err as { code?: unknown } | null)?.code;
  const code = typeof codeField === "string" ? codeField : null;
  if (code && PERMANENT_INGEST_FAILURE_CODES.has(code)) {
    return { code, message, retryable: false };
  }
  return { code: code || "ingest_storage_error", message, retryable: true };
}

export class RecordIngestRunTerminalError extends Error {
  code: string;

  constructor(runId: string) {
    super(`run ${runId} is already terminal; refusing to commit an ingest write admitted before cancellation`);
    this.name = "RecordIngestRunTerminalError";
    this.code = "run_terminal";
  }
}

let activeIndexWork = 0;
const indexWorkWaiters: IndexWorkWaiter[] = [];

function configuredIndexWorkLimit() {
  const parsed = Number.parseInt(process.env.PDPP_INGEST_INDEX_WORK_LIMIT || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 8) : DEFAULT_INDEX_WORK_LIMIT;
}

function configuredIndexWorkQueueLimit() {
  const parsed = Number.parseInt(process.env.PDPP_INGEST_INDEX_WORK_QUEUE_LIMIT || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INDEX_WORK_QUEUE_LIMIT;
}

function configuredIndexWorkAcquireDeadlineMs() {
  const parsed = Number.parseInt(process.env.PDPP_INGEST_INDEX_WORK_ACQUIRE_DEADLINE_MS || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INDEX_WORK_ACQUIRE_DEADLINE_MS;
}

function removeIndexWorkWaiter(waiter: IndexWorkWaiter): void {
  const index = indexWorkWaiters.indexOf(waiter);
  if (index >= 0) {
    indexWorkWaiters.splice(index, 1);
  }
}

async function acquireIndexWork(): Promise<void> {
  if (activeIndexWork < configuredIndexWorkLimit() && indexWorkWaiters.length === 0) {
    activeIndexWork += 1;
    return;
  }
  if (indexWorkWaiters.length >= configuredIndexWorkQueueLimit()) {
    throw new RecordIndexAdmissionError();
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: IndexWorkWaiter = {
      resolve: () => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        clearTimeout(waiter.timer);
        resolve();
      },
      settled: false,
      timer: setTimeout(() => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        removeIndexWorkWaiter(waiter);
        reject(new RecordIndexAdmissionError());
      }, configuredIndexWorkAcquireDeadlineMs()),
    };
    indexWorkWaiters.push(waiter);
  });
}

function releaseIndexWork(): void {
  while (indexWorkWaiters.length > 0) {
    const next = indexWorkWaiters.shift();
    if (!next || next.settled) {
      continue;
    }
    next.resolve();
    return;
  }
  activeIndexWork = Math.max(0, activeIndexWork - 1);
}

async function withIndexWork<T>(operation: () => Promise<T>): Promise<T> {
  await acquireIndexWork();
  try {
    return await operation();
  } finally {
    releaseIndexWork();
  }
}

export function recordIndexWorkStatsForTests(): { active: number; queued: number } {
  return { active: activeIndexWork, queued: indexWorkWaiters.length };
}

export function withRecordIndexWorkForTests<T>(operation: () => Promise<T>): Promise<T> {
  return withIndexWork(operation);
}

function fanInReadConcurrency(opts: { concurrency?: unknown } | null | undefined): number {
  const requested = Number(opts?.concurrency);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), FAN_IN_READ_CONCURRENCY)
    : FAN_IN_READ_CONCURRENCY;
}

function fanInMapOptions(opts: { onInFlightChange?: unknown } | null | undefined): {
  onInFlightChange?: InFlightChange;
} {
  return isInFlightChange(opts?.onInFlightChange) ? { onInFlightChange: opts.onInFlightChange } : {};
}

function byteLength(value: unknown): number {
  return value === null ? 0 : Buffer.byteLength(String(value));
}

function recordCountDelta(op: "delete" | "upsert", current: CurrentRecordRow | null): number {
  if (op === "delete") {
    return -1;
  }
  if (!current) {
    return 1;
  }
  return current.deleted ? 1 : 0;
}

function writeRecordChange({
  connectorId,
  connectorInstanceId,
  current,
  effectiveEmittedAt,
  nextVersion,
  op,
  recordJson,
  recordKey,
  semanticTime,
  stream,
}: {
  connectorId: string;
  connectorInstanceId: string;
  current: CurrentRecordRow | null;
  effectiveEmittedAt: string;
  nextVersion: number;
  op: "delete" | "upsert";
  recordJson: string | null;
  recordKey: string;
  semanticTime: string;
  stream: string;
}): void {
  if (op === "delete") {
    exec(referenceQueries.recordsIngestMarkRecordDeleted, [
      effectiveEmittedAt,
      nextVersion,
      connectorInstanceId,
      stream,
      recordKey,
    ]);
    exec(referenceQueries.recordsIngestInsertRecordChangeDeleted, [
      connectorId,
      connectorInstanceId,
      stream,
      recordKey,
      nextVersion,
      current?.record_json ?? null,
      effectiveEmittedAt,
      effectiveEmittedAt,
    ]);
    return;
  }
  exec(referenceQueries.recordsIngestUpsertRecord, [
    connectorId,
    connectorInstanceId,
    stream,
    recordKey,
    recordJson,
    effectiveEmittedAt,
    nextVersion,
    semanticTime,
  ]);
  exec(referenceQueries.recordsIngestInsertRecordChangeUpsert, [
    connectorId,
    connectorInstanceId,
    stream,
    recordKey,
    nextVersion,
    recordJson,
    effectiveEmittedAt,
  ]);
}

// The retained-size delta accounting MUST count/sum exactly the rows the prune
// DELETE will remove. Both helpers therefore carry the SAME anchor-preserving
// `NOT EXISTS` clause as `recordsIngestPruneRecordChanges` (see
// queries/records/ingest/prune-record-changes.sql). If these predicates ever
// diverge, the retained-size read model would over-report pruned bytes/rows
// for keys whose anchor we now keep. Kept in lockstep on purpose.
const PRUNE_ANCHOR_PRESERVE_CLAUSE = `
  AND NOT EXISTS (
    SELECT 1
      FROM records r
     WHERE r.connector_instance_id = record_changes.connector_instance_id
       AND r.stream = record_changes.stream
       AND r.record_key = record_changes.record_key
       AND r.version = record_changes.version
  )`;

function getPrunedRecordChangeJsonBytes(connectorInstanceId: string, stream: string, versionBefore: number): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS bytes
         FROM record_changes
        WHERE connector_instance_id = ?
          AND stream = ?
          AND version <= ?${PRUNE_ANCHOR_PRESERVE_CLAUSE}`
    )
    .get(connectorInstanceId, stream, versionBefore);
  return Number(row?.bytes || 0);
}

function getPrunedRecordChangeCount(connectorInstanceId: string, stream: string, versionBefore: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
         FROM record_changes
        WHERE connector_instance_id = ?
          AND stream = ?
          AND version <= ?${PRUNE_ANCHOR_PRESERVE_CLAUSE}`
    )
    .get(connectorInstanceId, stream, versionBefore);
  return Number(row?.count || 0);
}

/**
 * Encode a compound key to its canonical string form (minified JSON array or plain string)
 */
export function encodeKey(key: unknown): string {
  if (Array.isArray(key)) {
    return JSON.stringify(key);
  }
  return String(key);
}

/**
 * Decode a canonical key string back to string|string[]
 */
export function decodeKey(keyStr: string): string | string[] {
  try {
    const parsed = JSON.parse(keyStr);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return keyStr;
  } catch {
    return keyStr;
  }
}

// Test-only fault injection. Production callers never set these. Tests can
// install a hook via `__setIngestFaultHookForTest` /
// `__setDeleteFaultHookForTest` to throw between durable mutation steps and
// prove the surrounding transaction rolls the whole unit back. The hooks
// are invoked at well-named points inside the durable mutation transaction;
// if unset, they are no-ops. Ingest and direct-delete have separate hooks so
// each test pins the path it actually exercises.
let ingestFaultHook: FaultHook | null = null;
let deleteFaultHook: FaultHook | null = null;
let recordIndexFaultHook: FaultHook | null = null;
let sqliteRecordSortBackfillPhaseHook: AsyncFaultHook | null = null;
let admissionPreCheckPhaseHook: AsyncFaultHook | null = null;

export function __setIngestFaultHookForTest(hook: unknown): void {
  ingestFaultHook = isFaultHook(hook) ? hook : null;
}

export function __setDeleteFaultHookForTest(hook: unknown): void {
  deleteFaultHook = isFaultHook(hook) ? hook : null;
}

// Test-only fault seam for the post-commit derived phases. It is deliberately
// independent from the durable transaction hook above: a derived failure must
// leave the authoritative row and device reservation cursor available to
// repair on the same-identity retry.
export function __setRecordIndexFaultHookForTest(hook: unknown): void {
  recordIndexFaultHook = isFaultHook(hook) ? hook : null;
}

/** Test-only seam for deterministic manifest registration ordering. */
export function __setSqliteRecordSortBackfillPhaseHookForTest(hook: unknown): void {
  sqliteRecordSortBackfillPhaseHook = isAsyncFaultHook(hook) ? hook : null;
}

/** Test-only pause seam between the early admission check and durable write. */
export function __setAdmissionPreCheckPhaseHookForTest(hook: unknown): void {
  admissionPreCheckPhaseHook = isAsyncFaultHook(hook) ? hook : null;
}

async function maybeSqliteRecordSortBackfillPhaseForTest(point: string, context: HookContext): Promise<void> {
  await sqliteRecordSortBackfillPhaseHook?.(point, context);
}

async function maybeAfterAdmissionPreCheckPhase(point: string, context: HookContext): Promise<void> {
  await admissionPreCheckPhaseHook?.(point, context);
}

function assertSqliteRunStillAdmitted(runId: string | null | undefined, connectorInstanceId: string): void {
  if (!runId) {
    return;
  }
  const query = referenceQueries.controllerGetRunHistoryStatusForRun as ReadOneQuery;
  const runStatus = getOne<{ status: string }>(query, [runId, connectorInstanceId]);
  if (runStatus?.status !== "running") {
    throw new RecordIngestRunTerminalError(runId);
  }
}

function maybeFault(point: string, ctx: HookContext): void {
  if (ingestFaultHook) {
    ingestFaultHook(point, ctx);
  }
}

function maybeDeleteFault(point: string, ctx: HookContext): void {
  if (deleteFaultHook) {
    deleteFaultHook(point, ctx);
  }
}

function maybeRecordIndexFault(point: string, ctx: HookContext): void {
  if (recordIndexFaultHook) {
    recordIndexFaultHook(point, ctx);
  }
}

/**
 * Early refusal only. The transaction-native checks below are authoritative:
 * a revoke or delete can commit after this async read returns.
 */
export async function assertConnectorInstanceWritable(connectorInstanceId: string): Promise<void> {
  const status = isPostgresStorageBackend()
    ? ((
        await postgresQuery<{ status: string }>(
          "SELECT status FROM connector_instances WHERE connector_instance_id = $1",
          [connectorInstanceId]
        )
      ).rows[0]?.status ?? null)
    : ((getOne(referenceQueries.connectorInstancesGetById, [connectorInstanceId]) as { status?: string } | null)
        ?.status ?? null);
  assertConnectorInstanceWritableStatus(status, connectorInstanceId);
}

/**
 * SQLite's synchronous transaction callback leaves no await between this
 * status read and the record mutation it admits.
 */
export function assertSqliteConnectorInstanceWritableWithinTransaction(connectorInstanceId: string): void {
  const status =
    (getOne(referenceQueries.connectorInstancesGetById, [connectorInstanceId]) as { status?: string } | null)?.status ??
    null;
  assertConnectorInstanceWritableStatus(status, connectorInstanceId);
}

/**
 * Ingest a RECORD envelope (owner-authenticated).
 *
 * Atomicity: durable record mutation — current-state read, no-op decision,
 * atomic version allocation (`recordsIngestAllocateNextVersion` upserts
 * `version_counter` and returns the freshly-allocated `max_version` in one
 * statement), live `records` mutation, `record_changes` append, and history
 * pruning — runs inside one explicit SQLite `BEGIN IMMEDIATE` write
 * transaction (`writeTransaction`). The write lock is acquired at
 * transaction start so concurrent same-stream ingests serialize on the
 * read, not on the first write. The atomic allocator collapses the prior
 * read-then-write pattern so per-`(connector_id, stream)` versions are
 * unique under any writer model — including future PostgreSQL-compatible
 * adapters that do not rely on SQLite's serial writer guarantee. Lexical
 * and semantic index maintenance run after the durable commit and are
 * deliberately *not* part of the atomic unit; an index-maintenance failure
 * must not roll back the durable record write.
 *
 * Spec: openspec/changes/harden-record-version-allocation-atomicity/specs/
 *       reference-implementation-architecture/spec.md
 */
export async function ingestRecord(
  storageTarget: RecordStorageTarget,
  record: RecordEnvelope,
  options: RecordIngestOptions = {}
): Promise<RecordIngestOutcome> {
  const coordinationConnectorId = connectorIdForStorageTarget(storageTarget);
  const coordinationInstanceId = resolveStorageConnectorInstanceId(storageTarget, coordinationConnectorId);
  return await withConnectorInstanceWrite(
    coordinationInstanceId,
    async (coordinatorOwnership) => {
      if (options.requireConnectionAdmission) {
        await assertConnectorInstanceWritable(coordinationInstanceId);
        await maybeAfterAdmissionPreCheckPhase("after-admission-pre-check", {
          connectorInstanceId: coordinationInstanceId,
        });
      }
      return ingestRecordWithinCoordinator(storageTarget, record, { ...options, coordinatorOwnership });
    },
    options.coordinatorOwnership
  );
}

function ingestRecordWithinCoordinator(
  storageTarget: RecordStorageTarget,
  record: RecordEnvelope,
  options: RecordIngestOptions
): Promise<RecordIngestOutcome> {
  if (isPostgresStorageBackend()) {
    return ingestPostgresRecord(storageTarget, record, options);
  }

  return ingestSqliteRecord(storageTarget, record, options);
}

function toPostgresRecordInput(record: RecordEnvelope): {
  data?: RecordData;
  emitted_at?: string;
  key: unknown;
  op?: "delete" | "upsert";
  stream: string;
} {
  if (record.data !== undefined && record.data !== null && !isRecordData(record.data)) {
    throw new TypeError("Postgres record data must be an object when present");
  }
  if (record.emitted_at !== undefined && record.emitted_at !== null && typeof record.emitted_at !== "string") {
    throw new TypeError("Postgres record emitted_at must be a string when present");
  }
  return {
    key: record.key,
    stream: record.stream,
    ...(isRecordData(record.data) ? { data: record.data } : {}),
    ...(typeof record.emitted_at === "string" ? { emitted_at: record.emitted_at } : {}),
    ...(record.op ? { op: record.op } : {}),
  };
}

function toPostgresAttemptContext(context: AttemptContext | undefined) {
  if (!context?.streams) {
    return;
  }
  const streams: Record<
    string,
    { consentTimeField?: string | null; cursorField?: string | null; primaryKey?: string[] }
  > = {};
  for (const [stream, facts] of Object.entries(context.streams)) {
    streams[stream] = {
      ...(facts.consentTimeField === undefined ? {} : { consentTimeField: facts.consentTimeField }),
      ...(facts.cursorField === undefined ? {} : { cursorField: facts.cursorField }),
      ...(facts.primaryKey === undefined ? {} : { primaryKey: facts.primaryKey }),
    };
  }
  return { streams };
}

function toPostgresIngestOptions(options: RecordIngestOptions) {
  const attemptContext = toPostgresAttemptContext(options.attemptContext);
  return {
    ...(attemptContext ? { attemptContext } : {}),
    ...(options.deviceReservation ? { deviceReservation: options.deviceReservation } : {}),
    ...(options.requireConnectionAdmission ? { requireConnectionAdmission: true } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
  };
}

function isRetainedSizeDelta(value: unknown): value is NonNullable<RecordIngestOutcome["retainedSizeDelta"]> {
  if (!isRecordData(value)) {
    return false;
  }
  return (
    typeof value.connectorId === "string" &&
    typeof value.connectorInstanceId === "string" &&
    typeof value.currentRecordJsonBytesDelta === "number" &&
    typeof value.recordCountDelta === "number" &&
    typeof value.recordHistoryCountDelta === "number" &&
    typeof value.recordHistoryJsonBytesDelta === "number" &&
    typeof value.stream === "string"
  );
}

function toRecordIngestOutcome(outcome: {
  accepted: boolean;
  changed: boolean;
  retainedSizeDelta?: RecordData;
  self_healed?: boolean;
  version?: number;
}): RecordIngestOutcome {
  return {
    accepted: outcome.accepted,
    changed: outcome.changed,
    ...(isRetainedSizeDelta(outcome.retainedSizeDelta) ? { retainedSizeDelta: outcome.retainedSizeDelta } : {}),
    ...(typeof outcome.self_healed === "boolean" ? { self_healed: outcome.self_healed } : {}),
    ...(typeof outcome.version === "number" ? { version: outcome.version } : {}),
  };
}

async function ingestPostgresRecord(
  storageTarget: RecordStorageTarget,
  record: RecordEnvelope,
  options: RecordIngestOptions
): Promise<RecordIngestOutcome> {
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const outcome = toRecordIngestOutcome(
    await postgresIngestRecord(storageTarget, toPostgresRecordInput(record), toPostgresIngestOptions(options))
  );
  if (isChangedRecordIngestOutcome(outcome)) {
    const { stream } = record;
    if (outcome.retainedSizeDelta) {
      await applyRetainedSizeRecordDelta(outcome.retainedSizeDelta);
    } else {
      await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
    }
    // Colocated with the retained-size delta: a changed record write moved
    // this connection's count/stream evidence, so the maintained
    // connector-summary read model for this exact connection is now stale.
    // Scoped marker (instance id is known); best-effort and a no-op until the
    // read model is warmed, so it cannot fail the durable ingest.
    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId,
      reason: "record ingest changed connection count/stream evidence",
    });
    if (!options.deferIndexes) {
      await maintainRecordIndexes(
        storageTarget,
        record,
        options.attemptContext ? { attemptContext: options.attemptContext } : {}
      );
    }
    __invokeClientEventEnqueueHook({
      connectionId: connectorInstanceId,
      connectorId,
      connectorInstanceId,
      emittedAt: record.emitted_at ?? nowIso(),
      stream,
      version: outcome.version ?? null,
    });
  }
  return outcome;
}

interface UnchangedUpsertResolution {
  kind: "noop" | "self_heal";
}

function resolveUnchangedUpsert(
  connectorInstanceId: string,
  stream: string,
  recordKey: string,
  currentVersion: number,
  semanticTime: string,
  hasAttemptContext: boolean
): UnchangedUpsertResolution {
  const anchor = getOne<{ present: number }>(referenceQueries.recordsIngestGetRecordChangeAnchor, [
    connectorInstanceId,
    stream,
    recordKey,
    currentVersion,
  ]);
  if (anchor) {
    if (hasAttemptContext) {
      exec(referenceQueries.recordsIngestRepairCurrentDerivedFacts, [
        semanticTime,
        connectorInstanceId,
        stream,
        recordKey,
      ]);
    }
    return { kind: "noop" };
  }
  return { kind: "self_heal" };
}

interface HistoryPruneDeltas {
  prunedBytesForDelta: number;
  prunedRowsForDelta: number;
}

interface IngestDeltaArgs {
  connectorId: string;
  connectorInstanceId: string;
  consentTimeField: string | null;
  current: CurrentRecordRow | null;
  effectiveEmittedAt: string;
  insertedChangeJsonBytes: number;
  op: "upsert" | "delete";
  prunedBytesForDelta: number;
  prunedRowsForDelta: number;
  recordJson: string | null;
  stream: string;
}

function applyIngestRecordDeltas({
  connectorId,
  connectorInstanceId,
  stream,
  op,
  current,
  effectiveEmittedAt,
  recordJson,
  insertedChangeJsonBytes,
  prunedBytesForDelta,
  prunedRowsForDelta,
  consentTimeField,
}: IngestDeltaArgs): void {
  const countDelta = recordCountDelta(op, current);
  const jsonBytesDelta =
    op === "delete"
      ? -byteLength(current?.record_json)
      : byteLength(recordJson) - (current && !current.deleted ? byteLength(current.record_json) : 0);
  applyDatasetSummaryRecordDelta({
    connectorId,
    consentTimeField,
    dirtyRecordTimeBounds: true,
    emittedAt: effectiveEmittedAt,
    recordChangesJsonBytesDelta: insertedChangeJsonBytes - prunedBytesForDelta,
    recordCountDelta: countDelta,
    recordJsonBytesDelta: jsonBytesDelta,
    stream,
  });
  applyRetainedSizeRecordDelta({
    connectorId,
    connectorInstanceId,
    currentRecordJsonBytesDelta: jsonBytesDelta,
    recordCountDelta: countDelta,
    recordHistoryCountDelta: 1 - prunedRowsForDelta,
    recordHistoryJsonBytesDelta: insertedChangeJsonBytes - prunedBytesForDelta,
    stream,
  });
}

function pruneRecordChangeHistory(
  connectorInstanceId: string,
  stream: string,
  nextVersion: number,
  changeHistoryLimit: number
): HistoryPruneDeltas {
  if (changeHistoryLimit <= 0) {
    return { prunedBytesForDelta: 0, prunedRowsForDelta: 0 };
  }
  const cutoff = nextVersion - changeHistoryLimit;
  const prunedBytesForDelta = getPrunedRecordChangeJsonBytes(connectorInstanceId, stream, cutoff);
  const prunedRowsForDelta = getPrunedRecordChangeCount(connectorInstanceId, stream, cutoff);
  exec(referenceQueries.recordsIngestPruneRecordChanges, [connectorInstanceId, stream, cutoff]);
  return { prunedBytesForDelta, prunedRowsForDelta };
}

async function ingestSqliteRecord(
  storageTarget: RecordStorageTarget,
  record: RecordEnvelope,
  options: RecordIngestOptions
): Promise<RecordIngestOutcome> {
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const { stream, key, data, emitted_at, op = "upsert" } = record;
  const recordKey = encodeKey(key);
  const recordJson = data ? JSON.stringify(data) : null;

  // Validate record identity against the manifest-declared primary_key. The
  // record `key` is the ordered tuple of primary-key field values; each
  // declared field present in `data` must equal its position in `key`. This
  // covers non-`id` single keys (e.g. ["account_number"]) and compound keys
  // (e.g. ["account_id", "txn_id"]), not just `data.id`. When the manifest is
  // unavailable we fall back to the legacy `data.id` check so identity is never
  // silently unvalidated for the common `["id"]` case.
  const attemptStreamFacts = options.attemptContext?.streams?.[stream] ?? null;
  if (options.attemptContext) {
    assertRecordIdentity(attemptStreamFacts?.primaryKey ?? [], key, data);
  } else {
    validateRecordIdentity({ connectorId, data, key, stream });
  }

  const effectiveEmittedAt = emitted_at || nowIso();
  // SEMANTIC time (when the thing happened) for the Explore merged-timeline sort.
  // Resolved from the manifest consent_time_field/cursor_field of `data`,
  // epoch-aware, falling back to emitted_at. Only meaningful for upserts (a
  // delete keeps the row's existing semantic_time); computed unconditionally for
  // a simpler, branch-free bind below — the delete path does not write it.
  const semanticTime =
    op === "delete"
      ? effectiveEmittedAt
      : computeIngestSemanticTime(connectorId, stream, data, effectiveEmittedAt, attemptStreamFacts);
  const changeHistoryLimit = getChangeHistoryLimit();

  // Durable mutation unit: returns the operation outcome so derived index
  // maintenance can run *after* the commit succeeds.
  const outcome = writeTransaction<DurableIngestOutcome>(() => {
    if (options.requireConnectionAdmission) {
      assertSqliteConnectorInstanceWritableWithinTransaction(connectorInstanceId);
    }
    assertSqliteRunStillAdmitted(options.runId, connectorInstanceId);
    const finishDurableOutcome = (value: DurableIngestOutcome): DurableIngestOutcome => {
      if (options.deviceReservation) {
        advanceSqliteDeviceIngestPrefix(options.deviceReservation, options.deviceReservation.inputIndex);
      }
      return value;
    };
    const current = getOne<CurrentRecordRow>(referenceQueries.recordsIngestGetCurrentRecordState, [
      connectorInstanceId,
      stream,
      recordKey,
    ]);

    if (op === "delete" && (!current || current.deleted)) {
      return finishDurableOutcome({ kind: "noop" });
    }

    // Self-heal of an unanchored current row. An unchanged reingest is
    // normally a no-op (suppressing it is what keeps re-sent identical
    // payloads from churning the version space). But history pruning by
    // stream-global version cutoff can remove the only retained
    // `record_changes` row for a still-current, unchanged record: a cold
    // key whose anchor falls below the retention horizon while a hot key
    // churns the stream forward. The current `records` row then has no
    // provenance anchor — the exact orphan/unresolved_pruned class the
    // operator repair tool refuses to reconstruct from the DB alone.
    //
    // The ingest path is in a stronger epistemic position than that
    // offline tool: the source just re-sent the authoritative payload and
    // it is byte-identical to the current row, so the current projection is
    // proven correct. We re-anchor it by appending a fresh change row at a
    // NEW stream version (not the stale existing version, which would land
    // below the prune horizon and be re-pruned on the very next changed
    // write). The downstream changed-write delta math is already correct
    // for an unchanged payload at a new version: the record-count and
    // current-bytes deltas are zero, and only one history row is appended.
    const wouldBeUnchangedUpsert = op !== "delete" && current && !current.deleted && current.record_json === recordJson;
    // Anchor present → genuine no-op. Anchor missing → fall through to
    // the changed-write path below to re-anchor the current row.
    if (wouldBeUnchangedUpsert) {
      const unchanged = resolveUnchangedUpsert(
        connectorInstanceId,
        stream,
        recordKey,
        current.version,
        semanticTime,
        Boolean(options.attemptContext)
      );
      if (unchanged.kind === "noop") {
        return finishDurableOutcome({ kind: "noop" });
      }
    }
    const selfHeal = Boolean(wouldBeUnchangedUpsert);

    const allocated = execReturningOne<VersionAllocationRow>(referenceQueries.recordsIngestAllocateNextVersion, [
      connectorId,
      connectorInstanceId,
      stream,
    ]);
    const nextVersion = allocated.max_version;

    maybeFault("after-version-allocation", { connectorId, connectorInstanceId, nextVersion, recordKey, stream });

    writeRecordChange({
      connectorId,
      connectorInstanceId,
      current,
      effectiveEmittedAt,
      nextVersion,
      op,
      recordJson,
      recordKey,
      semanticTime,
      stream,
    });
    maybeFault("after-records-mutation", { connectorId, connectorInstanceId, nextVersion, op, recordKey, stream });

    maybeFault("after-record-changes-append", { connectorId, connectorInstanceId, nextVersion, op, recordKey, stream });

    const insertedChangeJsonBytes = byteLength(op === "delete" ? current?.record_json : recordJson);
    const { prunedBytesForDelta, prunedRowsForDelta } = pruneRecordChangeHistory(
      connectorInstanceId,
      stream,
      nextVersion,
      changeHistoryLimit
    );
    applyIngestRecordDeltas({
      connectorId,
      connectorInstanceId,
      consentTimeField: options.attemptContext
        ? (attemptStreamFacts?.consentTimeField ?? null)
        : getManifestConsentTimeField(connectorId, stream),
      current,
      effectiveEmittedAt,
      insertedChangeJsonBytes,
      op,
      prunedBytesForDelta,
      prunedRowsForDelta,
      recordJson,
      stream,
    });

    return finishDurableOutcome({ kind: "changed", op, selfHeal, version: nextVersion });
  });

  if (outcome.kind === "noop") {
    return { accepted: true, changed: false };
  }

  // Derived index maintenance runs after the durable commit. Failures here
  // are not allowed to retroactively roll back the durable record mutation;
  // recovery is the search-index drift detector's job.
  if (!options.deferIndexes) {
    await maintainRecordIndexes(
      storageTarget,
      record,
      options.attemptContext ? { attemptContext: options.attemptContext } : {}
    );
  }

  // Colocated with the retained-size delta applied in the committed
  // transaction above: a changed record write moved this connection's
  // count/stream evidence, so the maintained connector-summary read model for
  // this exact connection is now stale. Scoped marker (instance id is known);
  // best-effort and a no-op until the read model is warmed, so a marker miss
  // cannot fail or retroactively roll back the durable record mutation.
  await markConnectorSummaryEvidenceDirty({
    connectorInstanceId,
    reason: "record ingest changed connection count/stream evidence",
  });

  // After-commit notification for client event subscriptions. Failures
  // here MUST NOT retroactively roll back the durable record mutation.
  __invokeClientEventEnqueueHook({
    connectionId: connectorInstanceId,
    connectorId,
    connectorInstanceId,
    emittedAt: effectiveEmittedAt,
    stream,
    version: outcome.version,
  });

  // `self_healed` flags the case where the incoming payload was unchanged
  // but the current row's provenance anchor was missing and had to be
  // re-appended at a new version. It is purely additive — existing callers
  // key off `changed` / `accepted` — and lets operators/tests distinguish a
  // re-anchor from an ordinary content change.
  const result: RecordIngestOutcome = {
    accepted: true,
    changed: true,
  };
  if (outcome.selfHeal) {
    result.self_healed = true;
  }
  return result;
}

/**
 * Repair lexical and semantic derived state for an already committed record.
 * This is deliberately version-free; callers holding an instance fence may
 * invoke it after a committed durable phase or to repair a no-op replay.
 */
export async function maintainRecordIndexes(
  storageTarget: RecordStorageTarget,
  record: RecordEnvelope,
  options: RecordIngestOptions = {}
): Promise<void> {
  return await withIndexWork(() => maintainRecordIndexesWithinPermit(storageTarget, record, options));
}

/**
 * Resolve the final collapsed keys from the authoritative current projection
 * before repairing derived state. A processing retry can reacquire the
 * instance fence after another writer changed the same key; using the batch's
 * old payload here would make a successful retry regress search state while
 * leaving the durable row newer.
 *
 * This seam also repairs manifest-derived durable facts without allocating a
 * version or emitting a record-change notification. The caller normally
 * already owns the instance fence; the reentrant ownership argument keeps the
 * helper safe for direct callers as well.
 */
export async function prepareDeviceFinalRecords(
  storageTarget: RecordStorageTarget,
  plan: DeviceRecordPlanEntry[],
  attemptContext: AttemptContext | undefined,
  durablePrefixCount = 0,
  coordinatorOwnership?: ConnectorInstanceWriteOwnership
) {
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  return await withConnectorInstanceWrite(
    connectorInstanceId,
    () => prepareDeviceFinalRecordsWithinCoordinator(storageTarget, plan, attemptContext, durablePrefixCount),
    coordinatorOwnership
  );
}

function authoritativeFinalRecord(
  entry: DeviceRecordPlanEntry,
  current: CurrentRecordRow | null
): DeviceRecordPlanEntry {
  const input = entry.record;
  if (!current || current.deleted) {
    return {
      ...entry,
      record: { ...input, data: {}, op: "delete" },
    };
  }
  let data = current.record_json;
  if (typeof data === "string") {
    data = JSON.parse(data);
  }
  return {
    ...entry,
    record: {
      ...input,
      data,
      emitted_at: current.emitted_at ?? input.emitted_at,
      op: "upsert",
    },
  };
}

function toPostgresDevicePlanEntry(entry: DeviceRecordPlanEntry) {
  return { ...entry, record: toPostgresRecordInput(entry.record) };
}

function toDeviceRecordPlanEntry(entry: { inputIndex?: unknown; record: RecordEnvelope } & Record<string, unknown>) {
  if (typeof entry.inputIndex !== "number") {
    throw new TypeError("Postgres device record plan entry is missing inputIndex");
  }
  return { ...entry, inputIndex: entry.inputIndex, record: entry.record } satisfies DeviceRecordPlanEntry;
}

async function prepareDeviceFinalRecordsWithinCoordinator(
  storageTarget: RecordStorageTarget,
  plan: DeviceRecordPlanEntry[],
  attemptContext: AttemptContext | undefined,
  durablePrefixCount: number
): Promise<DeviceRecordPlanEntry[]> {
  // finalDeviceRecordPlan owns duplicate-key collapse. Fresh keys whose last
  // input index is in the just-replayed durable suffix are authoritative by
  // construction; only skipped final keys need a reread after another writer
  // could have changed the row between attempts.
  const skipped = plan.filter((entry) => entry.inputIndex < durablePrefixCount);
  if (skipped.length === 0) {
    return [...plan];
  }
  if (isPostgresStorageBackend()) {
    const repaired = await postgresPrepareDeviceFinalRecords(
      storageTarget,
      skipped.map(toPostgresDevicePlanEntry),
      toPostgresAttemptContext(attemptContext)
    );
    const repairedByIndex = new Map(repaired.map(toDeviceRecordPlanEntry).map((entry) => [entry.inputIndex, entry]));
    return plan.map((entry) => repairedByIndex.get(entry.inputIndex) ?? entry);
  }

  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  return writeTransaction(() => {
    const repairedByIndex = new Map<number, DeviceRecordPlanEntry>();
    for (const entry of skipped) {
      const input = entry.record;
      const recordKey = encodeKey(input.key);
      const current = getOne<CurrentRecordRow>(referenceQueries.recordsIngestGetCurrentRecordState, [
        connectorInstanceId,
        input.stream,
        recordKey,
      ]);
      const resolved = authoritativeFinalRecord(entry, current);
      if (current && !current.deleted) {
        const facts = attemptContext?.streams?.[input.stream] ?? null;
        const semanticTime = computeIngestSemanticTime(
          connectorId,
          input.stream,
          resolved.record.data,
          current.emitted_at ?? input.emitted_at ?? nowIso(),
          facts
        );
        exec(referenceQueries.recordsIngestRepairCurrentDerivedFacts, [
          semanticTime,
          connectorInstanceId,
          input.stream,
          recordKey,
        ]);
      }
      repairedByIndex.set(entry.inputIndex, resolved);
    }
    return plan.map((entry) => repairedByIndex.get(entry.inputIndex) ?? entry);
  });
}

async function maintainRecordIndexesWithinPermit(
  storageTarget: RecordStorageTarget,
  record: RecordEnvelope,
  options: RecordIngestOptions
): Promise<void> {
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const { stream, key, data, op = "upsert" } = record;
  const recordKey = encodeKey(key);
  if (op === "delete") {
    await lexicalIndexDelete({ connectorId, connectorInstanceId, recordKey, stream });
    maybeRecordIndexFault("after-lexical-index", {
      connectorId,
      connectorInstanceId,
      finalInputIndex: options.deviceFinalInputIndex ?? null,
      recordKey,
      stream,
    });
    await semanticIndexDelete({ connectorId, connectorInstanceId, recordKey, stream });
    maybeRecordIndexFault("after-semantic-index", {
      connectorId,
      connectorInstanceId,
      finalInputIndex: options.deviceFinalInputIndex ?? null,
      recordKey,
      stream,
    });
    return;
  }
  const attemptFacts = options.attemptContext?.streams?.[stream] ?? null;
  await lexicalIndexUpsert({
    connectorId,
    connectorInstanceId,
    data,
    declaredFields: options.attemptContext ? (attemptFacts?.lexicalFields ?? []) : undefined,
    recordKey,
    stream,
  });
  maybeRecordIndexFault("after-lexical-index", {
    connectorId,
    connectorInstanceId,
    finalInputIndex: options.deviceFinalInputIndex ?? null,
    recordKey,
    stream,
  });
  await semanticIndexUpsert({
    connectorId,
    connectorInstanceId,
    data,
    declaredFields: options.attemptContext ? (attemptFacts?.semanticFields ?? []) : undefined,
    recordKey,
    stream,
  });
  maybeRecordIndexFault("after-semantic-index", {
    connectorId,
    connectorInstanceId,
    finalInputIndex: options.deviceFinalInputIndex ?? null,
    recordKey,
    stream,
  });
}

/**
 * Apply field projection to a record's data object
 */
function projectFields(data: RecordData, fields: string[] | undefined): RecordData {
  if (!fields) {
    return data;
  }
  const result: RecordData = {};
  for (const f of fields) {
    if (f in data) {
      result[f] = data[f];
    }
  }
  return result;
}

// Canonical public read query-param allowlist. `connection_id` is the
// canonical public connection identifier; `connector_instance_id` is the
// deprecated wire alias accepted during the migration window defined by
// `openspec/changes/expose-connection-identity-on-public-read`. Both are
// optional filters today; when storage enumerates multiple connections per
// owner they will narrow the result set. `subject_id` is forwarded by some
// MCP / dashboard clients for diagnostic context and is allowlisted alongside
// `connector_id` for parity with `/v1/streams` and `/v1/schema`.
const SUPPORTED_RECORD_QUERY_PARAMS = new Set([
  "changes_since",
  "connection_id",
  "connector_id",
  "connector_instance_id",
  "count",
  "cursor",
  "expand",
  "expand_limit",
  "fields",
  "filter",
  "limit",
  "order",
  "sort",
  "subject_id",
  "view",
  "window",
]);

// Canonical graded-count vocabulary. Spec:
//   openspec/changes/canonicalize-public-read-contract design.md ("Counts")
//   reference-contract `CountKindSchema`
const SUPPORTED_COUNT_KINDS = new Set(["none", "estimated", "exact"]);

// Canonical bounded-window opt-in vocabulary. `meta.window` is opt-in via the
// `window` query parameter, mirroring the `count` opt-in discipline: absence,
// empty, or `none` omits `meta.window`; `exact` requests the bounded aggregate
// over the filtered, grant-scoped corpus. Any other value is a typed
// invalid-query error. Spec:
//   openspec/changes/complete-explorer-slvp-ideal/specs/
//   reference-implementation-architecture/spec.md
//   (#"The record-list read MAY expose bounded window aggregate metadata")
const SUPPORTED_WINDOW_KINDS = new Set(["none", "exact"]);
const SUPPORTED_AGGREGATE_QUERY_PARAMS = new Set([
  "connection_id",
  "connector_id",
  "connector_instance_id",
  "field",
  "filter",
  "granularity",
  "group_by",
  "group_by_time",
  "limit",
  "metric",
  "subject_id",
  "time_zone",
]);

/**
 * Re-export the canonical alias contract helpers so existing imports from
 * `./records.js` continue to work. The single source of truth is
 * `./connection-id-request.js`, which records.js, postgres-records.js, and
 * future read-path runtime share without duplication.
 */
export { CONNECTION_ALIAS_DEPRECATED_WARNING_CODE, resolveRequestConnectionId } from "./connection-id-request.ts";
export const validateConnectionAlias = validateConnectionAliasShared;
const SUPPORTED_AGGREGATE_METRICS = new Set(["count", "sum", "min", "max", "count_distinct"]);
const MAX_AGGREGATE_GROUP_LIMIT = 100;
const DEFAULT_AGGREGATE_GROUP_LIMIT = 10;
// Calendar `date_trunc` granularity set for `group_by_time` (weeks start
// Monday). See openspec/changes/add-aggregate-time-buckets-and-distinct.
const SUPPORTED_AGGREGATE_GRANULARITIES = new Set(["minute", "hour", "day", "week", "month", "quarter", "year"]);

function getFieldSchema(manifestStream: ManifestStream | null | undefined, field: string): JsonSchema | null {
  return manifestStream?.schema?.properties?.[field] || null;
}

/**
 * JSON Schema allows `type` to be either a string (`"string"`) or an array
 * (`["string", "null"]`). For cursor-field parity checks and filter
 * validation/coercion we care about the underlying non-null type(s).
 * Returns a Set of type names with `"null"` stripped out. An empty set means
 * "type not declared". A size-1 set represents a cleanly-typed scalar
 * (possibly nullable); callers that need a single type should bail otherwise.
 */
function nonNullSchemaTypes(schema: JsonSchema | null | undefined): Set<string> {
  const raw = schema?.type;
  if (raw === null) {
    return new Set();
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return new Set(list.filter((t): t is string => typeof t === "string" && t !== "null"));
}

const AGGREGATE_SCALAR_SCHEMA_TYPES = new Set(["boolean", "integer", "number", "string"]);

function isScalarAggregateSchema(fieldSchema: JsonSchema | null | undefined): boolean {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) {
    return false;
  }
  const [only] = types;
  return only !== undefined && AGGREGATE_SCALAR_SCHEMA_TYPES.has(only);
}

function isNumericAggregateSchema(fieldSchema: JsonSchema | null | undefined): boolean {
  const types = nonNullSchemaTypes(fieldSchema);
  return types.size === 1 && (types.has("integer") || types.has("number"));
}

function isMinMaxAggregateSchema(fieldSchema: JsonSchema | null | undefined): boolean {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) {
    return false;
  }
  if (types.has("integer") || types.has("number")) {
    return true;
  }
  return types.has("string") && (fieldSchema?.format === "date" || fieldSchema?.format === "date-time");
}

function parseNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateValue(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceComparableValue(
  value: unknown,
  fieldSchema: JsonSchema | null | undefined,
  { strict = false }: { strict?: boolean } = {}
): number | string | null {
  if (value === null) {
    return null;
  }

  // Branch on the non-null component of the declared type so that nullable
  // scalar schemas (`["integer", "null"]` etc.) coerce the same way as their
  // bare counterparts. An ambiguous `type` (e.g. `["string","integer"]`)
  // falls through to string coercion — that matches pre-nullable behavior
  // for any schema we wouldn't have accepted as range-queryable anyway.
  const types = nonNullSchemaTypes(fieldSchema);
  const only = types.size === 1 ? [...types][0] : null;

  if (only === "integer") {
    return coerceStrictOrNull(parseIntegerValue(value), strict, `Invalid integer value for '${String(value)}'`);
  }

  if (only === "number") {
    return coerceStrictOrNull(parseNumberValue(value), strict, `Invalid number value for '${String(value)}'`);
  }

  if (only === "string" && (fieldSchema?.format === "date" || fieldSchema?.format === "date-time")) {
    return coerceStrictOrNull(parseDateValue(value), strict, `Invalid date value for '${String(value)}'`);
  }

  return String(value);
}

// Return a parsed scalar, or in strict mode raise `invalid_query` when parsing
// failed (parsed == null). Non-strict callers get null and route the value to
// their own fallback.
function coerceStrictOrNull<T>(parsed: T | null, strict: boolean, message: string): T | null {
  if (parsed === null && strict) {
    throw invalidQueryError(message);
  }
  return parsed;
}

// --- group_by_time calendar bucketing --------------------------------------
//
// The in-process aggregate floor computes time buckets with calendar
// `date_trunc` semantics (weeks start Monday) in the effective IANA zone,
// using `Intl.DateTimeFormat` so day/week/month/quarter/year boundaries
// respect the zone and DST without a SQL round trip. Bucket keys are ISO
// strings: a date (`YYYY-MM-DD`) for day/week/month/quarter/year, and a
// minute/hour timestamp (`YYYY-MM-DDTHH:MM:00Z`-style, zone-qualified) for the
// sub-day units. See openspec/changes/add-aggregate-time-buckets-and-distinct.

function resolveAggregateTimeZone(rawZone: unknown): string {
  if (!rawZone) {
    return "UTC";
  }
  if (typeof rawZone !== "string") {
    throw invalidQueryError(`Unknown time_zone: '${String(rawZone)}'`);
  }
  // Intl.DateTimeFormat throws RangeError for unknown IANA zones; resolvedOptions()
  // consumes the instance so it is not flagged as unused.
  let resolvedZone: string | undefined;
  try {
    resolvedZone = new Intl.DateTimeFormat("en-US", { timeZone: rawZone }).resolvedOptions().timeZone;
  } catch {
    // RangeError from Intl — fall through to domain error below.
  }
  if (!resolvedZone) {
    throw invalidQueryError(`Unknown time_zone: '${rawZone}'`);
  }
  return rawZone;
}

// Decompose an absolute instant into wall-clock parts for the given IANA zone.
function zonedParts(
  epochMs: number,
  timeZone: string
): {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of fmt.formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") {
      parts[p.type] = p.value;
    }
  }
  // `Intl` emits hour "24" at midnight in some engines; normalize to 0.
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return {
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    month: Number(parts.month),
    second: Number(parts.second),
    year: Number(parts.year),
  };
}

// ISO day-of-week (1 = Monday .. 7 = Sunday) for a Y/M/D in proleptic
// Gregorian terms. Used to snap weeks to a Monday start.
function isoDayOfWeek(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Calendar-truncate the instant `value` to the start of its `granularity`
 * bucket in `timeZone`, returning a stable ISO key string. Returns `null`
 * when the value is null or unparseable so the caller can route it to the
 * single null bucket.
 */
function bucketStartForGranularity(value: unknown, granularity: string, timeZone: string): string | null {
  const epochMs = parseDateValue(value);
  if (epochMs === null) {
    return null;
  }
  const { year, month, day, hour, minute } = zonedParts(epochMs, timeZone);

  switch (granularity) {
    case "minute":
      return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
    case "hour":
      return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:00`;
    case "day":
      return `${year}-${pad2(month)}-${pad2(day)}`;
    case "week": {
      // Snap back to Monday in the zone's wall-clock calendar.
      const offset = isoDayOfWeek(year, month, day) - 1;
      const monday = new Date(Date.UTC(year, month - 1, day - offset));
      return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
    }
    case "month":
      return `${year}-${pad2(month)}-01`;
    case "quarter": {
      const quarterStartMonth = month - ((month - 1) % 3);
      return `${year}-${pad2(quarterStartMonth)}-01`;
    }
    case "year":
      return `${year}-01-01`;
    default:
      return null;
  }
}

/**
 * Compare two values under the semantics of a declared field schema, used by
 * the in-memory fallback sort/seek path. Mirrors the old JS comparator: numeric
 * compare for integer/number (and date-coerced), `localeCompare` for strings,
 * with null values sorted after present values (the seek builder handles the
 * missing-bucket toggle separately).
 */
function compareComparableValues(left: unknown, right: unknown, fieldSchema: JsonSchema | null): number {
  const l = coerceComparableValue(left, fieldSchema);
  const r = coerceComparableValue(right, fieldSchema);
  if (typeof l === "number" && typeof r === "number") {
    return l - r;
  }
  return String(l ?? "").localeCompare(String(r ?? ""));
}

/**
 * (cursor_value, primary_key) → (cursor_value, primary_key) comparison with
 * the manifest-declared schema types. `order === 'ASC'` produces ascending
 * order, `'DESC'` descending. Missing cursor values (null/'') bucket last in
 * ASC and first in DESC — matches the SQL path's `__cursor_missing` keyway.
 */
function compareLogicalPositions(
  left: LogicalPosition | null | undefined,
  right: LogicalPosition | null | undefined,
  manifestStream: ManifestStream | null | undefined,
  order: PageOrder
): number {
  const direction = order === "ASC" ? 1 : -1;

  const cursorCmp = compareCursorField(left, right, manifestStream, direction);
  if (cursorCmp !== 0) {
    return cursorCmp;
  }

  const primaryKeyFields = normalizePrimaryKey(manifestStream?.primary_key);
  for (let i = 0; i < primaryKeyFields.length; i += 1) {
    const field = primaryKeyFields[i];
    if (!field) {
      continue;
    }
    const fieldSchema = getFieldSchema(manifestStream, field);
    const cmp = compareComparableValues(left?.primary_key?.[i], right?.primary_key?.[i], fieldSchema);
    if (cmp !== 0) {
      return cmp * direction;
    }
  }
  return 0;
}

// Order two logical positions by the stream's cursor_field alone. Returns a
// direction-applied comparison, or 0 to defer to the primary-key tiebreak
// (no cursor_field declared, or both values equal/present-and-equal). A missing
// cursor value sorts after a present one in ASC, before it in DESC.
// A cursor value counts as "missing" when null/undefined or the empty string,
// matching the SQL `__cursor_missing` bucket.
function isMissingCursorValue(value: unknown): boolean {
  return value === null || value === "";
}

function compareCursorField(
  left: LogicalPosition | null | undefined,
  right: LogicalPosition | null | undefined,
  manifestStream: ManifestStream | null | undefined,
  direction: number
): number {
  const cursorField = manifestStream?.cursor_field || null;
  if (!cursorField) {
    return 0;
  }

  const leftMissing = isMissingCursorValue(left?.cursor_value);
  const rightMissing = isMissingCursorValue(right?.cursor_value);
  if (leftMissing !== rightMissing) {
    return (leftMissing ? 1 : -1) * direction;
  }
  if (!(leftMissing || rightMissing)) {
    const fieldSchema = getFieldSchema(manifestStream, cursorField);
    const cmp = compareComparableValues(left?.cursor_value, right?.cursor_value, fieldSchema);
    if (cmp !== 0) {
      return cmp * direction;
    }
  }
  return 0;
}

function buildRecordSortPosition(
  rawData: RecordData | null | undefined,
  recordKey: string,
  manifestStream: ManifestStream | null | undefined
): Required<LogicalPosition> {
  const primaryKeyFields = normalizePrimaryKey(manifestStream?.primary_key);
  const decodedKey = decodeKey(recordKey);
  const decodedKeyParts = Array.isArray(decodedKey) ? decodedKey : [decodedKey];
  const primaryKey = primaryKeyFields.map((field, index) => {
    if (rawData?.[field] !== undefined) {
      return rawData[field];
    }
    return decodedKeyParts[index] ?? null;
  });

  return {
    cursor_value: manifestStream?.cursor_field ? (rawData?.[manifestStream.cursor_field] ?? null) : null,
    primary_key: primaryKey,
  };
}

function parsePageOrder(rawOrder: unknown): PageOrder {
  if (isNullish(rawOrder) || rawOrder === "") {
    return "DESC";
  }
  if (rawOrder === "asc") {
    return "ASC";
  }
  if (rawOrder === "desc") {
    return "DESC";
  }
  throw invalidQueryError("order must be asc or desc");
}

/**
 * Resolve the effective list order from the canonical `sort` parameter
 * and the legacy `order` parameter.
 *
 * Canonical `sort` wins: `sort=-emitted_at` is DESC, `sort=emitted_at` is
 * ASC. Legacy `order` is honored only when `sort` is absent. If both are
 * sent and disagree, we reject with `invalid_sort` rather than silently
 * picking one — this is the strict-validation discipline the contract
 * requires for sort behavior.
 */
function resolveListOrder(rawOrder: unknown, resolvedSort: { direction: PageOrder } | null | undefined): PageOrder {
  if (resolvedSort) {
    if (!isNullish(rawOrder) && rawOrder !== "") {
      const legacyOrder = parsePageOrder(rawOrder);
      if (legacyOrder !== resolvedSort.direction) {
        const err = invalidQueryError(
          `sort and order disagree: sort resolves to ${resolvedSort.direction}, order=${rawOrder}. Send only canonical \`sort\`.`,
          "invalid_sort"
        );
        err.param = "sort";
        throw err;
      }
    }
    return resolvedSort.direction;
  }
  return parsePageOrder(rawOrder);
}

function normalizePaginationCursor(
  cursor: PaginationCursor | null | undefined,
  order: PageOrder
): LogicalPosition | null {
  if (!cursor) {
    return null;
  }
  if (cursor.session !== "records") {
    throw invalidQueryError("Malformed cursor", "invalid_cursor");
  }
  if (!Array.isArray(cursor.primary_key)) {
    throw invalidQueryError("Malformed cursor", "invalid_cursor");
  }
  if (cursor.order !== order) {
    throw invalidQueryError("Cursor order does not match request order", "invalid_cursor");
  }
  return {
    cursor_value: cursor.cursor_value ?? null,
    primary_key: cursor.primary_key,
  };
}

function validateTopLevelQueryParams(
  requestParams: RequestParams,
  manifestStream: ManifestStream | null = null
): { direction: PageOrder; field: string } | null {
  const unsupported = Object.keys(requestParams).filter((key) => !SUPPORTED_RECORD_QUERY_PARAMS.has(key));
  if (unsupported.length) {
    throw invalidQueryError(`Unsupported query parameter: ${unsupported.join(", ")}`);
  }
  validateConnectionAlias(requestParams);
  validateCountKind(requestParams.count);
  validateWindowKind(requestParams.window);
  return validateCanonicalSort(requestParams.sort, manifestStream);
}

/**
 * Validate the requested count grade against the canonical
 * `none|estimated|exact` vocabulary. Absent / empty values pass through;
 * the server applies `none` as the default. Spec:
 *   openspec/changes/canonicalize-public-read-contract/specs/
 *   reference-implementation-architecture/spec.md (#"Counts are opt-in
 *   and cost-graded").
 */
function validateCountKind(value: unknown): void {
  if (isNullish(value) || value === "") {
    return;
  }
  if (typeof value !== "string" || !SUPPORTED_COUNT_KINDS.has(value)) {
    throw invalidQueryError(`count must be one of: ${[...SUPPORTED_COUNT_KINDS].join(", ")}`);
  }
}

/**
 * Validate the requested `window` grade against the canonical
 * `none|exact` vocabulary. Absent / empty / `none` values pass through; the
 * server omits `meta.window` for those. `exact` requests the bounded
 * aggregate. Any other value is a typed invalid-query error, mirroring the
 * strict-validation discipline used for `count`. Spec:
 *   openspec/changes/complete-explorer-slvp-ideal/specs/
 *   reference-implementation-architecture/spec.md
 *   (#"The record-list read MAY expose bounded window aggregate metadata").
 */
function validateWindowKind(value: unknown): void {
  if (isNullish(value) || value === "") {
    return;
  }
  if (typeof value !== "string" || !SUPPORTED_WINDOW_KINDS.has(value)) {
    throw invalidQueryError(`window must be one of: ${[...SUPPORTED_WINDOW_KINDS].join(", ")}`);
  }
}

function rejectListOnlyParamsForChangesFeed(requestParams: RequestParams): void {
  const unsupported: string[] = [];
  for (const key of ["sort", "count", "order", "window"]) {
    if (!isNullish(requestParams[key]) && requestParams[key] !== "") {
      unsupported.push(key);
    }
  }
  if (!unsupported.length) {
    return;
  }
  throw invalidQueryError(
    `${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} not supported with changes_since`,
    "invalid_request"
  );
}

/**
 * Validate the canonical `sort` parameter against the manifest stream's
 * declared cursor field, and return the resolved direction the runtime
 * will apply.
 *
 * The wire vocabulary is sign-prefix CSV (`sort=-emitted_at`). Today the
 * reference runtime supports ordering by the stream's declared cursor
 * field only, so any other field is rejected with a typed `invalid_sort`
 * error. The sign prefix MUST control direction: `sort=field` is asc,
 * `sort=-field` is desc — silently ignoring the sign would amount to
 * accepting `sort` as a no-op, which the canonical contract forbids.
 *
 * Returns `null` when no `sort` is supplied, or
 *   `{ field: <cursor_field>, direction: 'ASC' | 'DESC' }`
 * when a single-field sort matches the advertised cursor field. Multi-key
 * sort (`sort=-emitted_at,name`) is not yet implemented; if a caller
 * supplies more than one entry that all happen to be the same advertised
 * field, we still resolve to its direction. Anything else is rejected.
 *
 * Conformance: every advertised sort field MUST be enforced by the
 * runtime. The reference runtime advertises only the cursor field as
 * sortable via `/v1/schema` (see operations/rs-schema-get); this helper
 * rejects all other fields rather than silently no-oping.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract design.md
 *       (#"Sort").
 */
function validateCanonicalSort(
  value: unknown,
  manifestStream: ManifestStream | null | undefined
): { direction: PageOrder; field: string } | null {
  if (isNullish(value) || value === "") {
    return null;
  }
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  const entries = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return null;
  }
  const cursorField = manifestStream?.cursor_field || null;
  const sortableFields = cursorField ? new Set([cursorField]) : new Set<string>();
  let resolved: { direction: PageOrder; field: string } | null = null;
  for (const entry of entries) {
    const parsed = resolveSortEntry(entry, sortableFields);
    if (resolved && resolved.direction !== parsed.direction) {
      throw sortValidationError(`Conflicting sort directions for field '${parsed.field}'`);
    }
    resolved = parsed;
  }
  return resolved;
}

// Build an `invalid_sort` query error tagged with `param = 'sort'`.
function sortValidationError(message: string): Error & { code: string; param: string } {
  return Object.assign(invalidQueryError(message, "invalid_sort"), { param: "sort" });
}

// Parse one canonical-sort entry (`field` or `-field`) into {field, direction},
// enforcing that the field is advertised as sortable. Throws a tagged
// `invalid_sort` error otherwise.
function resolveSortEntry(entry: string, sortableFields: Set<string>): { direction: PageOrder; field: string } {
  const direction = entry.startsWith("-") ? "DESC" : "ASC";
  const field = direction === "DESC" ? entry.slice(1) : entry;
  if (!field) {
    throw sortValidationError("Empty sort field");
  }
  if (sortableFields.size === 0 || !sortableFields.has(field)) {
    throw sortValidationError(
      `Sort field '${field}' is not advertised as sortable; check /v1/schema for the canonical sort vocabulary.`
    );
  }
  return { direction, field };
}

function validateTopLevelAggregateParams(requestParams: RequestParams): void {
  const unsupported = Object.keys(requestParams).filter((key) => !SUPPORTED_AGGREGATE_QUERY_PARAMS.has(key));
  if (unsupported.length) {
    throw invalidQueryError(`Unsupported query parameter: ${unsupported.join(", ")}`);
  }
  validateConnectionAlias(requestParams);
}

function normalizeAggregateMetric(value: unknown): string {
  const metric = String(value || "").trim();
  if (!SUPPORTED_AGGREGATE_METRICS.has(metric)) {
    throw invalidQueryError("metric must be one of count, sum, min, max, count_distinct");
  }
  return metric;
}

function normalizeAggregateLimit(value: unknown, grouped: boolean): number | null {
  if (!grouped) {
    if (!isNullish(value)) {
      throw invalidQueryError("limit is only supported with group_by or group_by_time");
    }
    return null;
  }
  if (isNullish(value) || value === "") {
    return DEFAULT_AGGREGATE_GROUP_LIMIT;
  }
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    throw invalidQueryError("limit must be an integer");
  }
  const limit = Number.parseInt(String(value), 10);
  if (
    !Number.isInteger(limit) ||
    String(limit) !== String(value).trim() ||
    limit < 1 ||
    limit > MAX_AGGREGATE_GROUP_LIMIT
  ) {
    throw invalidQueryError(`limit must be an integer between 1 and ${MAX_AGGREGATE_GROUP_LIMIT}`);
  }
  return limit;
}

function getDeclaredAggregateFields(manifestStream: ManifestStream | null | undefined, kind: string): string[] {
  const fields = manifestStream?.query?.aggregations?.[kind];
  return Array.isArray(fields) ? fields : [];
}

function requireDeclaredAggregate(
  manifestStream: ManifestStream | null | undefined,
  kind: string,
  field: string
): void {
  if (!getDeclaredAggregateFields(manifestStream, kind).includes(field)) {
    throw invalidQueryError(`Aggregation ${kind} is not declared for '${field}'`);
  }
}

function requireAggregateFieldGranted(streamGrant: StreamGrant, field: string): void {
  if (streamGrant.fields && !streamGrant.fields.includes(field)) {
    throw invalidQueryError(`Aggregation field '${field}' not in grant`, "field_not_granted");
  }
}

function validateAggregateMetricField({
  field,
  grouped,
  manifestStream,
  metric,
  streamGrant,
}: {
  field: string | null;
  grouped: boolean;
  manifestStream: ManifestStream | null | undefined;
  metric: string;
  streamGrant: StreamGrant;
}): void {
  if (metric === "count") {
    validateCountAggregateField(field, manifestStream);
    return;
  }
  if (metric === "count_distinct") {
    validateDistinctAggregateField(field, grouped, manifestStream, streamGrant);
    return;
  }
  if (grouped) {
    throw invalidQueryError(
      `${metric} does not support grouping; group_by and group_by_time are only valid with metric=count`
    );
  }
  if (!field) {
    throw invalidQueryError(`field is required for ${metric}`);
  }
  const fieldSchema = getFieldSchema(manifestStream, field);
  if (!fieldSchema) {
    throw invalidQueryError(`Unknown field: ${field}`, "unknown_field");
  }
  requireAggregateFieldGranted(streamGrant, field);
  requireDeclaredAggregate(manifestStream, metric, field);
  if (metric === "sum" && !isNumericAggregateSchema(fieldSchema)) {
    throw invalidQueryError(`Aggregation sum requires a numeric field; '${field}' is not numeric`);
  }
  if ((metric === "min" || metric === "max") && !isMinMaxAggregateSchema(fieldSchema)) {
    throw invalidQueryError(
      `Aggregation ${metric} requires a numeric, date, or date-time field; '${field}' is not supported`
    );
  }
}

function validateCountAggregateField(field: string | null, manifestStream: ManifestStream | null | undefined): void {
  if (field) {
    throw invalidQueryError("field is not supported for count");
  }
  if (manifestStream?.query?.aggregations?.count !== true) {
    throw invalidQueryError(`Count aggregation is not declared for stream '${manifestStream?.name || ""}'`);
  }
}

function validateDistinctAggregateField(
  field: string | null,
  grouped: boolean,
  manifestStream: ManifestStream | null | undefined,
  streamGrant: StreamGrant
): void {
  if (grouped) {
    throw invalidQueryError("count_distinct does not support grouping; omit group_by and group_by_time");
  }
  if (!field) {
    throw invalidQueryError("field is required for count_distinct");
  }
  const fieldSchema = getFieldSchema(manifestStream, field);
  if (!fieldSchema) {
    throw invalidQueryError(`Unknown field: ${field}`, "unknown_field");
  }
  requireAggregateFieldGranted(streamGrant, field);
  requireDeclaredAggregate(manifestStream, "count_distinct", field);
  if (!isScalarAggregateSchema(fieldSchema)) {
    throw invalidQueryError(`count_distinct requires a scalar field; '${field}' is not scalar`);
  }
}

function validateAggregateGrouping(
  metric: string,
  groupBy: string | null,
  groupByTime: string | null,
  manifestStream: ManifestStream | null | undefined,
  streamGrant: StreamGrant
): void {
  if (groupBy) {
    const schema = getFieldSchema(manifestStream, groupBy);
    if (!schema) {
      throw invalidQueryError(`Unknown field: ${groupBy}`, "unknown_field");
    }
    requireAggregateFieldGranted(streamGrant, groupBy);
    requireDeclaredAggregate(manifestStream, "group_by", groupBy);
    if (!isScalarAggregateSchema(schema)) {
      throw invalidQueryError(`Grouped counts require a scalar field; '${groupBy}' is not scalar`);
    }
  }
  if (!groupByTime) {
    return;
  }
  if (metric !== "count") {
    throw invalidQueryError("group_by_time is only valid with metric=count");
  }
  const schema = getFieldSchema(manifestStream, groupByTime);
  if (!schema) {
    throw invalidQueryError(`Unknown field: ${groupByTime}`, "unknown_field");
  }
  requireAggregateFieldGranted(streamGrant, groupByTime);
  requireDeclaredAggregate(manifestStream, "group_by_time", groupByTime);
  if (!isMinMaxAggregateSchema(schema) || nonNullSchemaTypes(schema).has("string") === false) {
    throw invalidQueryError(`group_by_time requires a date or date-time field; '${groupByTime}' is not supported`);
  }
}

function resolveAggregateTimeGrouping(
  groupByTime: string | null,
  granularityRaw: string | null,
  timeZoneRaw: string | null
): { granularity: string | null; timeZone: string | null } {
  if (!groupByTime) {
    if (granularityRaw) {
      throw invalidQueryError("granularity is only supported with group_by_time");
    }
    if (timeZoneRaw) {
      throw invalidQueryError("time_zone is only supported with group_by_time");
    }
    return { granularity: null, timeZone: null };
  }
  if (!granularityRaw) {
    throw invalidQueryError("granularity is required when group_by_time is present");
  }
  if (!SUPPORTED_AGGREGATE_GRANULARITIES.has(granularityRaw)) {
    throw invalidQueryError(`granularity must be one of ${[...SUPPORTED_AGGREGATE_GRANULARITIES].join(", ")}`);
  }
  return { granularity: granularityRaw, timeZone: resolveAggregateTimeZone(timeZoneRaw) };
}

function normalizeAggregateRequest(
  requestParams: RequestParams,
  streamGrant: StreamGrant,
  manifestStream: ManifestStream | null | undefined
) {
  validateTopLevelAggregateParams(requestParams);

  const aggregations = manifestStream?.query?.aggregations;
  if (!aggregations || typeof aggregations !== "object" || Array.isArray(aggregations)) {
    throw invalidQueryError(`Aggregations are not declared for stream '${manifestStream?.name || ""}'`);
  }

  const metric = normalizeAggregateMetric(requestParams.metric);
  const field =
    isNullish(requestParams.field) || requestParams.field === "" ? null : String(requestParams.field).trim();
  const groupBy =
    isNullish(requestParams.group_by) || requestParams.group_by === "" ? null : String(requestParams.group_by).trim();
  const groupByTime =
    isNullish(requestParams.group_by_time) || requestParams.group_by_time === ""
      ? null
      : String(requestParams.group_by_time).trim();
  const granularityRaw =
    isNullish(requestParams.granularity) || requestParams.granularity === ""
      ? null
      : String(requestParams.granularity).trim();
  const timeZoneRaw =
    isNullish(requestParams.time_zone) || requestParams.time_zone === ""
      ? null
      : String(requestParams.time_zone).trim();

  // Exactly one grouping dimension in v1: group_by XOR group_by_time.
  if (groupBy && groupByTime) {
    throw invalidQueryError("group_by and group_by_time cannot be combined; choose one grouping dimension");
  }
  const grouped = Boolean(groupBy || groupByTime);
  const limit = normalizeAggregateLimit(requestParams.limit, grouped);

  const { granularity, timeZone } = resolveAggregateTimeGrouping(groupByTime, granularityRaw, timeZoneRaw);

  validateAggregateMetricField({ field, grouped, manifestStream, metric, streamGrant });

  validateAggregateGrouping(metric, groupBy, groupByTime, manifestStream, streamGrant);

  return { field, granularity, groupBy, groupByTime, limit, metric, timeZone };
}

function jsonExtractExpr(field: string): string {
  assertSafeJsonField(field, "json_extract");
  // record_json is our JSON TEXT column; $.<field> is the JSONPath.
  return `json_extract(record_json, '$.${field}')`;
}

/**
 * Exact-parity note (vs `compareLogicalPositions`):
 *
 * - The JS comparator sorts by `cursor_field` (if declared), with missing
 *   values (null or '') sorted **after** present values in ASC, **before**
 *   in DESC. We reproduce that with a `__cursor_missing` boolean in the
 *   SELECT list and an explicit two-key ORDER BY: `__cursor_missing ASC/DESC`
 *   first, then the field value.
 * - Within "present cursor" rows the JS comparator uses either numeric compare
 *   (integer/number schemas) or `localeCompare` (strings). SQLite's ORDER BY
 *   on `json_extract(...)` uses numeric ordering for SQLite's INTEGER/REAL
 *   affinity values and BINARY collation for TEXT. For our corpus every
 *   declared `cursor_field` is typed as integer/number or as a string with
 *   `format: date` / `format: date-time` (ISO-8601), where lexical BINARY
 *   order equals temporal order — semantic parity holds.
 * - Nullable variants like `["string", "null"]` or `["integer", "null"]` are
 *   semantically the same sort basis with additional null rows; those null
 *   rows fall into the `__cursor_missing` bucket which ORDER BY already
 *   places after present values in ASC (before in DESC). No parity break.
 * - For any cursor_field whose non-null type is not numeric and not ISO
 *   date/date-time (e.g. a plain `"string"` or `["string", "null"]` with no
 *   date/date-time format), we bail out rather than silently accept
 *   BINARY-vs-localeCompare drift. That leaves slice-2 handlers free to
 *   narrow the scope later without anyone relying on accidental parity today.
 * - `primary_key` parts fall through to the same rules. Every stream in
 *   our corpus uses `["id"]` primary keys — always strings of ASCII hex /
 *   UUID / etc. BINARY == localeCompare on ASCII.
 */
/**
 * Returns `{supported, reason}` for a stream's `cursor_field`. A supported
 * cursor field means the SQL-pushdown records path will produce results
 * consistent with the JS comparator. Unsupported shapes route the stream
 * through `fetchVisibleRecordRowsInMemory` instead — see the fallback in
 * `fetchVisibleRecordRowsPaginated`.
 */
function classifyCursorFieldSqlSupport(manifestStream: ManifestStream | null | undefined): {
  reason: string | null;
  supported: boolean;
} {
  const field = manifestStream?.cursor_field;
  if (!field) {
    return { reason: null, supported: true };
  }
  const schema = getFieldSchema(manifestStream, field);
  if (!schema) {
    return {
      reason: `cursor_field '${field}' not in schema.properties`,
      supported: false,
    };
  }
  const types = nonNullSchemaTypes(schema);
  const numeric = types.size === 1 && (types.has("integer") || types.has("number"));
  const isoDate =
    types.size === 1 && types.has("string") && (schema.format === "date" || schema.format === "date-time");
  if (numeric || isoDate) {
    return { reason: null, supported: true };
  }
  const typeLabel = JSON.stringify(schema.type);
  return {
    reason:
      `cursor_field '${field}' has schema type ${typeLabel}${schema.format ? ` format '${schema.format}'` : ""}; ` +
      "SQL-layer sort is only supported for numeric or ISO date/date-time cursor_fields " +
      "(nullable variants allowed). Repair the manifest, or let the reference " +
      "fallback handle it in-memory (logged at first use).",
    supported: false,
  };
}

// Streams we've already logged a fallback for, so we don't flood stderr.
const _sqlFallbackLoggedStreams = new Set();
function logSqlFallbackOnce(connectorId: string, stream: string, reason: string): void {
  const key = `${connectorId}::${stream}`;
  if (_sqlFallbackLoggedStreams.has(key)) {
    return;
  }
  _sqlFallbackLoggedStreams.add(key);
  console.warn(`[records] stream ${connectorId}/${stream} using in-memory pagination fallback: ${reason}`);
}

/**
 * Build the seek predicate WHERE clause that selects rows strictly after
 * `cursorPosition` in the requested `order`, honoring the same missing/present
 * bucketing as `compareLogicalPositions`.
 *
 * Returns `{sql, binds}` where `sql` is a ready-to-inject predicate fragment
 * (no leading AND) and `binds` is the positional params in order.
 *
 * Assumes primary_key has exactly one scalar column (verified against the
 * current corpus; widening this requires a per-pk-column seek builder).
 */
function buildCursorSeekClause(
  manifestStream: ManifestStream | null | undefined,
  cursorPosition: Required<LogicalPosition>,
  order: PageOrder
): { binds: BindValue[]; sql: string } {
  const cursorField = manifestStream?.cursor_field || null;
  const primaryKeyFields = normalizePrimaryKey(manifestStream?.primary_key);
  if (primaryKeyFields.length === 0) {
    throw new Error("[records] cursor seek requires a manifest-declared primary_key");
  }
  if (primaryKeyFields.length > 1) {
    // Parity with `compareLogicalPositions` for multi-part primary keys would
    // require nested `OR (pk0 = pv0 AND (pk1 > pv1 OR …))` — worth building
    // when a corpus stream actually uses one. Today every stream has ["id"].
    throw new Error("[records] SQL cursor seek is not implemented for multi-part primary keys");
  }
  const [pkField] = primaryKeyFields;
  if (!pkField) {
    throw new Error("[records] cursor seek requires a manifest-declared primary_key");
  }
  const pkExpr = jsonExtractExpr(pkField);

  const cursorMissing = cursorPosition.cursor_value === null || cursorPosition.cursor_value === "";
  const pkValue = asSqliteBindValue(cursorPosition.primary_key[0] ?? null);
  const cursorValue = asSqliteBindValue(cursorPosition.cursor_value);
  const cmp = order === "ASC" ? ">" : "<";

  if (!cursorField) {
    // No cursor_field declared → sort key is just primary_key.
    return { binds: [pkValue], sql: `AND ${pkExpr} ${cmp} ?` };
  }

  const cursorExpr = jsonExtractExpr(cursorField);
  // __cursor_missing in the SELECT is (cursor IS NULL OR cursor = '').
  // Missing-bucket sort position: ASC → last (1), DESC → first (1 still, since
  // we flip the direction of the `__cursor_missing` ORDER clause itself).
  if (cursorMissing) {
    if (order === "ASC") {
      // Cursor is in the missing bucket; all non-missing rows came before this
      // page, so we only need to seek inside the missing bucket by pk.
      return {
        binds: [pkValue],
        sql: `AND (${cursorExpr} IS NULL OR ${cursorExpr} = '') AND ${pkExpr} ${cmp} ?`,
      };
    }
    // DESC: missing-bucket came first; the missing bucket's remainder is
    // pk-ordered DESC; the non-missing bucket hasn't started yet and still
    // needs to be served. Combine: "still in missing bucket and past pk" OR
    // "now in non-missing bucket".
    return {
      binds: [pkValue],
      sql:
        `AND ((${cursorExpr} IS NULL OR ${cursorExpr} = '') AND ${pkExpr} ${cmp} ? ` +
        `  OR (${cursorExpr} IS NOT NULL AND ${cursorExpr} <> ''))`,
    };
  }

  // Non-missing cursor.
  if (order === "ASC") {
    // Strictly-after = same cursor+later pk, OR later cursor, OR missing bucket (after all non-missing).
    return {
      binds: [cursorValue, pkValue, cursorValue],
      sql:
        `AND ((${cursorExpr} = ? AND ${pkExpr} ${cmp} ?) ` +
        `  OR (${cursorExpr} IS NOT NULL AND ${cursorExpr} <> '' AND ${cursorExpr} ${cmp} ?) ` +
        `  OR (${cursorExpr} IS NULL OR ${cursorExpr} = ''))`,
    };
  }
  // DESC: missing bucket came first and is already consumed; now we're in
  // non-missing descending. Strictly-before = same cursor+earlier pk OR earlier cursor.
  return {
    binds: [cursorValue, pkValue, cursorValue],
    sql:
      `AND ${cursorExpr} IS NOT NULL AND ${cursorExpr} <> '' ` +
      `AND ((${cursorExpr} = ? AND ${pkExpr} ${cmp} ?) ` +
      `  OR (${cursorExpr} ${cmp} ?))`,
  };
}

/**
 * Streaming, SQL-pushdown variant of `fetchVisibleRecordRows` used by the
 * primary `/v1/streams/:stream/records` handler (not expansion — see
 * `hydrateExpandedRelations`, slated for slice 2 of the memory-pressure
 * change).
 *
 * Contract:
 *   - Access-control filters (time_range, resources) are applied in SQL.
 *   - ORDER BY is applied in SQL, reproducing `compareLogicalPositions`.
 *   - Cursor-based seek is applied in SQL; no result is materialized for
 *     rows before the cursor.
 *   - Request-side filters (compiledFilters) are kept in JS per the spec;
 *     the streaming loop yields up to `limit + 1` post-filter visible rows,
 *     reading in batches of `sqlBatchSize` from the driver iterator.
 *
 * Returns `{rows, hasMore}` where `rows` is at most `limit` post-filter
 * visible rows in SQL-sort-order, already carrying `rawData` + `sortPosition`
 * to match the shape `queryRecords` expects.
 */

/**
 * In-memory fallback used when a stream's `cursor_field` is not SQL-safe.
 * Loads the visible connector/stream records with access-control pushdown in
 * SQL (WHERE only; no ORDER BY / LIMIT), then sorts and seeks in JS using
 * `compareLogicalPositions`.
 *
 * Trade-offs vs the SQL path:
 *   - Memory: one pass over all visible records for the stream; acceptable for
 *     the reference but not for very large streams. The registration-time
 *     guardrail + manifest repairs are expected to keep this path rare.
 *   - Correctness: exact parity with the old JS comparator, including
 *     `localeCompare` on plain strings, which is what the SQL path bails on.
 */
function fetchVisibleRecordRowsInMemory({
  connectorInstanceId,
  stream,
  effective,
  manifestStream,
  compiledFilters = [],
  cursorPosition,
  limit,
  order,
}: FetchVisibleRecordsArgs): { hasMore: boolean; rows: VisibleRecordRow[]; scanned: number; underread: false } {
  const consentTimeField = manifestStream?.consent_time_field;

  // Access-control pushdown: keep the same WHERE shape the SQL path uses, just
  // without ORDER BY / LIMIT / cursor-seek.
  const whereParts = ["connector_instance_id = ?", "stream = ?", "deleted = 0"];
  const whereBinds = [connectorInstanceId, stream];
  if (effective.timeRange && consentTimeField) {
    assertSafeJsonField(consentTimeField, "consent_time_field");
    const ctExpr = jsonExtractExpr(consentTimeField);
    whereParts.push(`${ctExpr} IS NOT NULL`);
    if (!isNullish(effective.timeRange.since)) {
      whereParts.push(`${ctExpr} >= ?`);
      whereBinds.push(new Date(effective.timeRange.since).toISOString());
    }
    if (!isNullish(effective.timeRange.until)) {
      whereParts.push(`${ctExpr} < ?`);
      whereBinds.push(new Date(effective.timeRange.until).toISOString());
    }
  }
  if (effective.resources && effective.resources.length > 0) {
    const placeholders = effective.resources.map(() => "?").join(", ");
    whereParts.push(`record_key IN (${placeholders})`);
    whereBinds.push(...effective.resources);
  }

  const sql = `
    SELECT record_key, record_json, emitted_at
    FROM records
    WHERE ${whereParts.join(" AND ")}
  `;

  // REVIEWED-DYNAMIC: in-memory fallback for streams whose cursor_field is
  // not SQL-safe; WHERE clause varies with grant time_range / resources;
  // intentionally no LIMIT — JS sort/seek needs the full visible set.
  const visible: VisibleRecordRow[] = [];
  for (const row of iterateDynamicSqlAcknowledged<StoredRecordRow>(sql, whereBinds)) {
    const rawData = parseStoredRecordData(row.record_json);
    if (compiledFilters.length && !passesRequestFilters(rawData, compiledFilters)) {
      continue;
    }
    visible.push({
      emitted_at: row.emitted_at,
      rawData,
      record_key: row.record_key,
      sortPosition: buildRecordSortPosition(rawData, row.record_key, manifestStream),
    });
  }

  visible.sort((left, right) => compareLogicalPositions(left.sortPosition, right.sortPosition, manifestStream, order));

  const afterCursor = cursorPosition
    ? visible.filter((row) => compareLogicalPositions(row.sortPosition, cursorPosition, manifestStream, order) > 0)
    : visible;

  const hasMore = afterCursor.length > limit;
  const rows = hasMore ? afterCursor.slice(0, limit) : afterCursor;
  return { hasMore, rows, scanned: visible.length, underread: false };
}

interface PaginatedSqlParts {
  orderByParts: string[];
  primaryKeyField: string;
  seekBinds: BindValue[];
  seekSql: string;
  selectParts: string[];
  whereBinds: BindValue[];
  whereParts: string[];
}

function buildPaginatedSqlParts(
  connectorInstanceId: string,
  stream: string,
  manifestStream: ManifestStream | null | undefined,
  effective: EffectiveReadScope,
  cursorPosition: Required<LogicalPosition> | null,
  order: PageOrder
): PaginatedSqlParts {
  const consentTimeField = manifestStream?.consent_time_field;
  const cursorField = manifestStream?.cursor_field || null;
  const primaryKeyFields = normalizePrimaryKey(manifestStream?.primary_key);
  if (primaryKeyFields.length === 0) {
    throw new Error("[records] manifest primary_key is required");
  }
  const [primaryKeyField] = primaryKeyFields;
  if (!primaryKeyField) {
    throw new Error("[records] manifest primary_key is required");
  }

  const selectParts = ["record_key", "record_json", "emitted_at"];
  if (cursorField) {
    selectParts.push(`${jsonExtractExpr(cursorField)} AS __cursor_val`);
    selectParts.push(
      `CASE WHEN ${jsonExtractExpr(cursorField)} IS NULL OR ${jsonExtractExpr(cursorField)} = '' ` +
        "     THEN 1 ELSE 0 END AS __cursor_missing"
    );
  }

  const whereParts = ["connector_instance_id = ?", "stream = ?", "deleted = 0"];
  const whereBinds: BindValue[] = [connectorInstanceId, stream];
  if (effective.timeRange && consentTimeField) {
    assertSafeJsonField(consentTimeField, "consent_time_field");
    const ctExpr = jsonExtractExpr(consentTimeField);
    whereParts.push(`${ctExpr} IS NOT NULL`);
    if (!isNullish(effective.timeRange.since)) {
      whereParts.push(`${ctExpr} >= ?`);
      whereBinds.push(new Date(effective.timeRange.since).toISOString());
    }
    if (!isNullish(effective.timeRange.until)) {
      whereParts.push(`${ctExpr} < ?`);
      whereBinds.push(new Date(effective.timeRange.until).toISOString());
    }
  }
  if (effective.resources && effective.resources.length > 0) {
    const placeholders = effective.resources.map(() => "?").join(", ");
    whereParts.push(`record_key IN (${placeholders})`);
    whereBinds.push(...effective.resources);
  }

  let seekSql = "";
  const seekBinds: BindValue[] = [];
  if (cursorPosition) {
    const seek = buildCursorSeekClause(manifestStream, cursorPosition, order);
    seekSql = seek.sql;
    seekBinds.push(...seek.binds);
  }

  const orderByParts: string[] = [];
  if (cursorField) {
    orderByParts.push(`__cursor_missing ${order}`);
    orderByParts.push(`__cursor_val ${order}`);
  }
  orderByParts.push(`${jsonExtractExpr(primaryKeyField)} ${order}`);

  return { orderByParts, primaryKeyField, seekBinds, seekSql, selectParts, whereBinds, whereParts };
}

function fetchVisibleRecordRowsPaginated({
  connectorId,
  connectorInstanceId,
  stream,
  effective,
  manifestStream,
  compiledFilters = [],
  cursorPosition,
  limit,
  order,
}: FetchVisibleRecordsArgs): { hasMore: boolean; rows: VisibleRecordRow[]; scanned: number; underread: boolean } {
  // Graceful per-stream fallback for manifests whose cursor_field is not
  // compatible with the SQL sort path. Registration-time validation catches
  // this for freshly-registered connectors (see auth.js), but stale DB rows
  // predating the guardrail can still slip through — this keeps assistant-
  // critical browsing working rather than 500-ing.
  const sqlSupport = classifyCursorFieldSqlSupport(manifestStream);
  if (!sqlSupport.supported) {
    logSqlFallbackOnce(connectorId, stream, sqlSupport.reason ?? "unsupported cursor field");
    return fetchVisibleRecordRowsInMemory({
      compiledFilters,
      connectorId,
      connectorInstanceId,
      cursorPosition,
      effective,
      limit,
      manifestStream,
      order,
      stream,
    });
  }

  const { selectParts, whereBinds, whereParts, seekBinds, seekSql, orderByParts } = buildPaginatedSqlParts(
    connectorInstanceId,
    stream,
    manifestStream,
    effective,
    cursorPosition,
    order
  );

  const whereSqlPart = `WHERE ${whereParts.join(" AND ")} ${seekSql}`;
  const orderBySql = `ORDER BY ${orderByParts.join(", ")}`;

  // --- SQL LIMIT strategy ---
  // Post-SQL we run request-side filters in JS. When request-filters reject
  // rows, we need to keep reading from the driver until we've collected
  // `limit + 1` post-filter rows. Use iterate() with a generous batch bound —
  // if the driver's LIMIT cuts us off before filling the page, we re-issue
  // with the offset advanced. For the no-request-filter case (the overwhelming
  // majority of traffic) one batch of `limit + 1` is enough.
  const hasRequestFilters = compiledFilters && compiledFilters.length > 0;
  const sqlLimit = hasRequestFilters
    ? Math.max(limit * 4, 100) // headroom for rejections
    : limit + 1;

  const sql = `
    SELECT ${selectParts.join(", ")}
    FROM records
    ${whereSqlPart}
    ${orderBySql}
    LIMIT ?
  `;

  // REVIEWED-DYNAMIC: WHERE clause varies with grant time_range / resources
  // / cursor seek; SQL composed in JS as today; LIMIT N+1 included.
  const collected: VisibleRecordRow[] = [];
  let scanned = 0;

  for (const row of iterateDynamicSqlAcknowledged<StoredRecordRow>(sql, [...whereBinds, ...seekBinds, sqlLimit])) {
    scanned += 1;
    const rawData = parseStoredRecordData(row.record_json);
    if (compiledFilters.length && !passesRequestFilters(rawData, compiledFilters)) {
      continue;
    }
    collected.push({
      emitted_at: row.emitted_at,
      rawData,
      record_key: row.record_key,
      sortPosition: buildRecordSortPosition(rawData, row.record_key, manifestStream),
    });
    if (collected.length > limit) {
      break;
    }
  }

  const hasMore = collected.length > limit;
  const rows = hasMore ? collected.slice(0, limit) : collected;

  // If we had request filters AND we exhausted the SQL batch without filling
  // the page, we under-return (hasMore=false even though more rows may exist
  // past our sqlLimit window). Acceptable for this tranche: the dashboard
  // doesn't use request filters in its hot paths. A follow-up slice can
  // loop the SQL offset forward in that case.
  return { hasMore, rows, scanned, underread: hasRequestFilters && !hasMore && scanned >= sqlLimit };
}

function buildResponseRecord(
  stream: string,
  row: VisibleRecordRow,
  effective: EffectiveReadScope,
  identity: RecordIdentity | null = null
): ResponseRecord {
  const record: ResponseRecord = {
    data: projectFields(row.rawData, effective.fields ?? undefined),
    emitted_at: row.emitted_at,
    id: row.record_key,
    object: "record",
    stream,
  };
  decorateRecordWithConnectionIdentity(record, identity);
  return record;
}

/**
 * Attach `connection_id` (canonical) and the deprecated `connector_instance_id`
 * alias to a response record when the runtime knows the binding without
 * guessing. `identity` is `null` (e.g. legacy callers) or
 * `{ connectionId, displayName? }`. Empty/missing values are skipped so we
 * never fabricate identity for pre-binding rows.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Records, search, and blob items SHALL carry canonical connection identity")
 */
function decorateRecordWithConnectionIdentity(record: ResponseRecord, identity: RecordIdentity | null): void {
  if (!(record && identity)) {
    return;
  }
  const connectionId = typeof identity.connectionId === "string" ? identity.connectionId.trim() : "";
  if (connectionId) {
    record.connection_id = connectionId;
    record.connector_instance_id = connectionId;
  }
  const displayName = typeof identity.displayName === "string" ? identity.displayName.trim() : "";
  if (displayName) {
    record.display_name = displayName;
  }
}

function hydrateExpandedRelations({
  connectorId,
  connectorInstanceId,
  effectiveParentRows,
  expansions,
  manifest,
  childIdentity: childIdentityOverride = null,
}: {
  childIdentity?: RecordIdentity | null;
  connectorId: string;
  connectorInstanceId: string;
  effectiveParentRows: EffectiveParentRow[];
  expansions: ExpandResult[];
  manifest: { streams?: ManifestStream[] } | null | undefined;
}): void {
  if (!(expansions.length && effectiveParentRows.length)) {
    return;
  }

  for (const expansion of expansions) {
    const childManifestStream = manifest?.streams?.find((entry) => entry.name === expansion.relationship.stream);
    const childRequiredFields = childManifestStream?.schema?.required ?? [];
    const childEffective = buildEffectiveReadScope(expansion.childGrant, {}, childRequiredFields);

    const parentKeys = effectiveParentRows.map((row) => row.record_key);
    const foreignKeyField = expansion.relationship.foreign_key;
    if (typeof foreignKeyField !== "string") {
      throw invalidQueryError(`Expansion '${expansion.name}' has no foreign_key`, "invalid_expand");
    }
    const groupedChildren = fetchExpansionChildrenGroupedByForeignKey({
      cardinality: expansion.relationship.cardinality,
      childEffective,
      childManifestStream,
      childStream: expansion.relationship.stream,
      connectorId,
      connectorInstanceId,
      foreignKeyField,
      limit: expansion.limit,
      parentKeys,
    });

    // Expansion children belong to the same connector_instance_id as the
    // parent, so reuse the resolved record identity (including display_name)
    // rather than constructing a bare `{ connectionId }` shape.
    const childIdentity = childIdentityOverride || { connectionId: connectorInstanceId };
    for (const parentRow of effectiveParentRows) {
      assignExpansionToParentRow(parentRow, expansion, groupedChildren, childEffective, childIdentity);
    }
  }
}

/**
 * Hydrate one expansion onto a single parent row. Reads the parent's matched
 * children out of `groupedChildren`, then writes `expanded[expansion.name]` as
 * either a single record (`has_one`) or a bounded `list` object (`has_many`),
 * projecting each child through the child grant's `childEffective` filter.
 */
function assignExpansionToParentRow(
  parentRow: EffectiveParentRow,
  expansion: ExpandResult,
  groupedChildren: Map<string, VisibleRecordRow[]>,
  childEffective: EffectiveReadScope,
  childIdentity: RecordIdentity
): void {
  const matches = groupedChildren.get(parentRow.record_key) || [];
  if (!parentRow.responseRecord.expanded) {
    parentRow.responseRecord.expanded = {};
  }

  if (expansion.relationship.cardinality === "has_one") {
    const [first] = matches;
    parentRow.responseRecord.expanded[expansion.name] = first
      ? buildResponseRecord(expansion.relationship.stream, first, childEffective, childIdentity)
      : null;
    return;
  }

  parentRow.responseRecord.expanded[expansion.name] = {
    data: matches
      .slice(0, expansion.limit)
      .map((childRow) => buildResponseRecord(expansion.relationship.stream, childRow, childEffective, childIdentity)),
    has_more: matches.length > expansion.limit,
    object: "list",
  };
}

/**
 * Slice-2 replacement for the per-child full-scan. Builds one window-function
 * SQL query that:
 *   - narrows by `foreign_key IN (?, ?, ...)` to the current parent page,
 *   - applies the child grant's access-control filters (time_range, resources)
 *     in SQL,
 *   - assigns ROW_NUMBER() per foreign-key partition ordered by the child's
 *     manifest-declared (cursor_field, primary_key) basis,
 *   - clips the per-partition rank to (has_many: limit + 1) or (has_one: 1).
 *
 * Grant filtering stays in SQL: the child's time_range/resources come from
 * `childEffective` (derived from `expansion.childGrant`) and are pushed into
 * WHERE exactly as the primary path does.
 *
 * Returns a Map<encodedForeignKey, childRow[]> where each childRow carries the
 * `{record_key, rawData, emitted_at, sortPosition}` shape the caller expects
 * for `buildResponseRecord`.
 */
/**
 * In-memory fallback for `fetchExpansionChildrenGroupedByForeignKey`. Used
 * when the child stream's cursor_field is not SQL-safe. Same per-parent cap
 * semantics, but ordering + partitioning happen in JS.
 */
function fetchExpansionChildrenGroupedByForeignKeyInMemory({
  connectorInstanceId,
  childStream,
  childManifestStream,
  childEffective,
  foreignKeyField,
  parentKeys,
  cardinality,
  limit,
}: Omit<ExpansionChildArgs, "connectorId">): Map<string, VisibleRecordRow[]> {
  const result = new Map<string, VisibleRecordRow[]>();
  if (!parentKeys.length) {
    return result;
  }

  const consentTimeField = childManifestStream?.consent_time_field;
  const primaryKeyFields = normalizePrimaryKey(childManifestStream?.primary_key);
  if (primaryKeyFields.length === 0) {
    throw new Error("[records] child stream manifest primary_key is required for expansion");
  }

  const whereParts = ["connector_instance_id = ?", "stream = ?", "deleted = 0"];
  const whereBinds = [connectorInstanceId, childStream];
  if (childEffective.timeRange && consentTimeField) {
    assertSafeJsonField(consentTimeField, "consent_time_field");
    const ctExpr = jsonExtractExpr(consentTimeField);
    whereParts.push(`${ctExpr} IS NOT NULL`);
    if (!isNullish(childEffective.timeRange.since)) {
      whereParts.push(`${ctExpr} >= ?`);
      whereBinds.push(new Date(childEffective.timeRange.since).toISOString());
    }
    if (!isNullish(childEffective.timeRange.until)) {
      whereParts.push(`${ctExpr} < ?`);
      whereBinds.push(new Date(childEffective.timeRange.until).toISOString());
    }
  }
  if (childEffective.resources && childEffective.resources.length > 0) {
    const placeholders = childEffective.resources.map(() => "?").join(", ");
    whereParts.push(`record_key IN (${placeholders})`);
    whereBinds.push(...childEffective.resources);
  }
  assertSafeJsonField(foreignKeyField, "foreign_key");
  const fkExpr = jsonExtractExpr(foreignKeyField);
  const parentPlaceholders = parentKeys.map(() => "?").join(", ");
  whereParts.push(`${fkExpr} IN (${parentPlaceholders})`);

  const sql = `
    SELECT record_key, record_json, emitted_at, ${fkExpr} AS __fk
    FROM records
    WHERE ${whereParts.join(" AND ")}
  `;

  // REVIEWED-DYNAMIC: in-memory expansion fallback for child streams whose
  // cursor_field is not SQL-safe; WHERE clause varies with child grant
  // time_range / resources and parent foreign-key IN-list; intentionally no
  // LIMIT — JS sort/per-parent slice needs the full visible child set for
  // the parent page.
  const rankBound = cardinality === "has_one" ? 1 : limit + 1;
  const buckets = new Map<string, VisibleRecordRow[]>();
  for (const row of iterateDynamicSqlAcknowledged<StoredRecordRow>(sql, [...whereBinds, ...parentKeys])) {
    const rawData = parseStoredRecordData(row.record_json);
    const relationKey = encodeKey(row.__fk);
    const childRow = {
      emitted_at: row.emitted_at,
      rawData,
      record_key: row.record_key,
      sortPosition: buildRecordSortPosition(rawData, row.record_key, childManifestStream),
    };
    if (!buckets.has(relationKey)) {
      buckets.set(relationKey, []);
    }
    buckets.get(relationKey)?.push(childRow);
  }
  for (const [relationKey, bucket] of buckets) {
    bucket.sort((l, r) => compareLogicalPositions(l.sortPosition, r.sortPosition, childManifestStream, "ASC"));
    result.set(relationKey, bucket.slice(0, rankBound));
  }
  return result;
}

function fetchExpansionChildrenGroupedByForeignKey({
  connectorId,
  connectorInstanceId,
  childStream,
  childManifestStream,
  childEffective,
  foreignKeyField,
  parentKeys,
  cardinality,
  limit,
}: ExpansionChildArgs): Map<string, VisibleRecordRow[]> {
  const result = new Map<string, VisibleRecordRow[]>();
  if (!parentKeys.length) {
    return result;
  }

  assertSafeJsonField(foreignKeyField, "foreign_key");
  // If the child stream's cursor_field isn't SQL-safe, fall back to an
  // in-memory per-foreign-key group so the expansion still hydrates. Rare in
  // practice (expansion streams are typically the narrow, well-typed ones),
  // but keeps the whole read from failing over one badly-declared child.
  const childSqlSupport = classifyCursorFieldSqlSupport(childManifestStream);
  if (!childSqlSupport.supported) {
    logSqlFallbackOnce(connectorId, childStream, `expansion: ${childSqlSupport.reason}`);
    return fetchExpansionChildrenGroupedByForeignKeyInMemory({
      cardinality,
      childEffective,
      childManifestStream,
      childStream,
      connectorInstanceId,
      foreignKeyField,
      limit,
      parentKeys,
    });
  }

  const primaryKeyFields = normalizePrimaryKey(childManifestStream?.primary_key);
  if (primaryKeyFields.length === 0) {
    throw new Error("[records] child stream manifest primary_key is required for expansion");
  }
  if (primaryKeyFields.length > 1) {
    // Same reason as cursor seek: every stream in our corpus is ["id"].
    throw new Error("[records] expansion SQL pushdown is not implemented for multi-part child primary keys");
  }

  const fkExpr = jsonExtractExpr(foreignKeyField);
  const [primaryKeyField] = primaryKeyFields;
  if (!primaryKeyField) {
    throw new Error("[records] child stream manifest primary_key is required for expansion");
  }
  const pkExpr = jsonExtractExpr(primaryKeyField);
  const cursorField = childManifestStream?.cursor_field || null;
  const consentTimeField = childManifestStream?.consent_time_field;

  const orderByParts: string[] = [];
  if (cursorField) {
    const cursorExpr = jsonExtractExpr(cursorField);
    orderByParts.push(`CASE WHEN ${cursorExpr} IS NULL OR ${cursorExpr} = '' THEN 1 ELSE 0 END ASC`);
    orderByParts.push(`${cursorExpr} ASC`);
  }
  orderByParts.push(`${pkExpr} ASC`);
  const orderBySql = orderByParts.join(", ");

  const whereParts = ["connector_instance_id = ?", "stream = ?", "deleted = 0"];
  const whereBinds = [connectorInstanceId, childStream];

  // time_range pushdown — same shape as fetchVisibleRecordRowsPaginated.
  if (childEffective.timeRange && consentTimeField) {
    assertSafeJsonField(consentTimeField, "consent_time_field");
    const ctExpr = jsonExtractExpr(consentTimeField);
    whereParts.push(`${ctExpr} IS NOT NULL`);
    if (!isNullish(childEffective.timeRange.since)) {
      whereParts.push(`${ctExpr} >= ?`);
      whereBinds.push(new Date(childEffective.timeRange.since).toISOString());
    }
    if (!isNullish(childEffective.timeRange.until)) {
      whereParts.push(`${ctExpr} < ?`);
      whereBinds.push(new Date(childEffective.timeRange.until).toISOString());
    }
  }

  // resources pushdown.
  if (childEffective.resources && childEffective.resources.length > 0) {
    const placeholders = childEffective.resources.map(() => "?").join(", ");
    whereParts.push(`record_key IN (${placeholders})`);
    whereBinds.push(...childEffective.resources);
  }

  // Parent foreign-key narrowing.
  const parentPlaceholders = parentKeys.map(() => "?").join(", ");
  whereParts.push(`${fkExpr} IN (${parentPlaceholders})`);

  // Per-partition cap.
  //   has_one: rn = 1 (take one per parent).
  //   has_many: rn <= limit + 1 (the +1 gives the caller a has_more signal).
  const rankBound = cardinality === "has_one" ? 1 : limit + 1;

  const sql = `
    WITH ranked AS (
      SELECT
        record_key,
        record_json,
        emitted_at,
        ${fkExpr} AS __fk,
        ROW_NUMBER() OVER (
          PARTITION BY ${fkExpr}
          ORDER BY ${orderBySql}
        ) AS __rn
      FROM records
      WHERE ${whereParts.join(" AND ")}
    )
    SELECT record_key, record_json, emitted_at, __fk
    FROM ranked
    WHERE __rn <= ?
  `;

  // REVIEWED-DYNAMIC: SQL-pushdown expansion; WHERE clause varies with
  // child grant time_range / resources and parent foreign-key IN-list;
  // ORDER BY varies with the child manifest's cursor_field /
  // primary_key; per-partition rank bound (__rn <= ?) caps each parent's
  // child set instead of a top-level LIMIT.
  for (const row of iterateDynamicSqlAcknowledged<StoredRecordRow>(sql, [...whereBinds, ...parentKeys, rankBound])) {
    const rawData = parseStoredRecordData(row.record_json);
    const relationKey = encodeKey(row.__fk);
    const childRow = {
      emitted_at: row.emitted_at,
      rawData,
      record_key: row.record_key,
      sortPosition: buildRecordSortPosition(rawData, row.record_key, childManifestStream),
    };
    if (!result.has(relationKey)) {
      result.set(relationKey, []);
    }
    result.get(relationKey)?.push(childRow);
  }

  return result;
}

function isVisibleSnapshot(
  snapshot: RecordSnapshot | null,
  effective: EffectiveReadScope,
  consentTimeField: string | null | undefined
): boolean {
  if (!snapshot || snapshot.deleted || !snapshot.data) {
    return false;
  }
  if (effective.resources && !effective.resources.includes(snapshot.record_key)) {
    return false;
  }
  if (
    effective.timeRange &&
    consentTimeField &&
    !passesTimeRange(snapshot.data, effective.timeRange, consentTimeField)
  ) {
    return false;
  }
  return true;
}

function parseChangesSinceCursor(str: string): ChangesSinceCursor | null {
  if (str === "beginning") {
    return { version: 0 };
  }
  const decoded = decodeCursor(str);
  if (!decoded) {
    return null;
  }
  if (!decoded.kind) {
    return typeof decoded.version === "number" && Number.isInteger(decoded.version)
      ? { version: decoded.version }
      : null;
  }
  if (decoded.kind !== "changes_since" || typeof decoded.version !== "number" || !Number.isInteger(decoded.version)) {
    return null;
  }
  return { kind: "changes_since", version: decoded.version };
}

// Self-teaching error message: when a caller passes something other than the
// two legal forms (the `beginning` bootstrap sentinel or a `next_changes_since`
// value returned by a prior changes-feed response), name both forms so the
// caller can correct the request without reading the spec. Common cold-start
// mistake: passing an ISO timestamp like `2024-01-01T00:00:00Z`.
const CHANGES_SINCE_MALFORMED_MESSAGE =
  "Malformed changes_since cursor; pass `beginning` to bootstrap or the `next_changes_since` value returned by a prior /v1/streams/{stream}/records response";

function parsePageCursor(str: string): PaginationCursor | null {
  const decoded = decodeCursor(str);
  if (!decoded) {
    return null;
  }
  if (decoded.kind !== "page" || typeof decoded.session !== "string") {
    return null;
  }
  return decoded;
}

function encodeRecordsPageCursor(position: LogicalPosition | null | undefined, order: PageOrder): string {
  return encodeCursor({
    cursor_value: position?.cursor_value ?? null,
    kind: "page",
    order,
    primary_key: position?.primary_key || [],
    session: "records",
  });
}

function encodeChangesPageCursor({
  sinceVersion,
  afterVersion,
  sessionMaxVersion,
}: {
  afterVersion: number;
  sessionMaxVersion: number;
  sinceVersion: number;
}): string {
  return encodeCursor({
    after_version: afterVersion,
    kind: "page",
    session: "changes",
    session_max_version: sessionMaxVersion,
    since_version: sinceVersion,
  });
}

function encodeChangesSinceCursor(version: number): string {
  return encodeCursor({ kind: "changes_since", version });
}

function getSnapshotAtVersion(
  connectorInstanceId: string,
  stream: string,
  recordKey: string,
  version: number
): RecordSnapshot | null {
  if (!Number.isInteger(version) || version < 0) {
    return null;
  }
  const row = getOne<SnapshotRow>(referenceQueries.recordsSnapshotsGetSnapshotAtVersion, [
    connectorInstanceId,
    stream,
    recordKey,
    version,
  ]);

  if (!row) {
    return null;
  }

  return {
    data: row.record_json ? parseStoredRecordData(row.record_json) : null,
    deleted: !!row.deleted,
    deleted_at: row.deleted_at,
    emitted_at: row.emitted_at,
    record_key: recordKey,
    version: row.version,
  };
}

/**
 * Stream on which local collectors emit coverage diagnostics. Records on
 * this stream carry `{ id, store, stream, status, reason }`; the reader
 * below projects only the safe `store`/`stream`/`status` triple.
 */
const LOCAL_COVERAGE_DIAGNOSTICS_STREAM = "coverage_diagnostics";

const SAFE_COVERAGE_STATUSES = new Set([
  "collected",
  "inventory_only",
  "excluded",
  "deferred",
  "missing",
  "unsupported",
  "unaccounted",
]);

function projectCoverageRow(rawData: unknown): { status: string; store: string; stream: string | null } | null {
  if (!isRecordData(rawData)) {
    return null;
  }
  const store = typeof rawData.store === "string" && rawData.store ? rawData.store : null;
  if (!store) {
    return null;
  }
  const status =
    typeof rawData.status === "string" && SAFE_COVERAGE_STATUSES.has(rawData.status) ? rawData.status : "unaccounted";
  const stream = typeof rawData.stream === "string" && rawData.stream ? rawData.stream : null;
  // Deliberately omit `id`, `reason`, and anything else: the operator
  // diagnostic only needs the safe store/stream/status triple, never the
  // reason free-text or any payload.
  return { status, store, stream };
}

/**
 * Read the latest `coverage_diagnostics` records for one connector instance
 * and return only the safe `{ store, stream, status }` triple per store.
 *
 * This is the server-side source for Section 5.3 operator completeness
 * diagnostics. It reads live records (the inventory rebuilds them each run,
 * so the live row is the latest), and never returns paths, payloads, the
 * coverage `reason` text, or secrets. Returns an empty array when the
 * instance has no coverage records (a run that never requested the stream).
 */
export async function listLocalCoverageDiagnostics(storageTarget: RecordStorageTarget) {
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  if (!connectorInstanceId) {
    return [];
  }

  const byStore = new Map<string, { status: string; store: string; stream: string | null }>();
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT record_key, record_json FROM records
         WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE
         ORDER BY record_key ASC`,
      [connectorInstanceId, LOCAL_COVERAGE_DIAGNOSTICS_STREAM]
    );
    for (const row of result.rows) {
      const projected = projectCoverageRow(
        typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json
      );
      if (projected) {
        byStore.set(projected.store, projected);
      }
    }
  } else {
    const rows = getDb()
      .prepare(
        `SELECT record_key, record_json FROM records
           WHERE connector_instance_id = ? AND stream = ? AND deleted = 0
           ORDER BY record_key ASC`
      )
      .all<CoverageRecordRow>(connectorInstanceId, LOCAL_COVERAGE_DIAGNOSTICS_STREAM);
    for (const row of rows) {
      const projected = projectCoverageRow(JSON.parse(row.record_json));
      if (projected) {
        byStore.set(projected.store, projected);
      }
    }
  }

  return [...byStore.values()].sort((a, b) => a.store.localeCompare(b.store));
}

/**
 * Read the local coverage proof without laundering malformed or duplicate
 * diagnostic rows into a healthy projection. This is intentionally separate
 * from the operator list above: that surface presents a concise inventory,
 * while the health gate must retain every failure signal.
 */
export async function readCommittedLocalCoverageDiagnostics(storageTarget: RecordStorageTarget) {
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  if (!connectorInstanceId) {
    return {
      duplicateStores: [],
      hasAuthoritativeInventory: false,
      hasCommittedSnapshot: false,
      malformed: false,
      missingStores: [],
      rows: [],
      state: null,
      unexpectedStores: [],
      updatedAt: null,
    };
  }
  const stateProjection = await getSyncState(storageTarget, {
    allowedStreams: new Set([LOCAL_COVERAGE_DIAGNOSTICS_STREAM]),
    grantId: null,
  });
  const state = stateProjection.state[LOCAL_COVERAGE_DIAGNOSTICS_STREAM] ?? null;
  const generation = isPostgresStorageBackend()
    ? ((
        await postgresQuery(
          `SELECT ci.manifest_generation AS current_generation, cs.manifest_generation AS state_generation
           FROM connector_instances ci
           LEFT JOIN connector_state cs
             ON cs.connector_instance_id = ci.connector_instance_id AND cs.stream = $2
          WHERE ci.connector_instance_id = $1`,
          [connectorInstanceId, LOCAL_COVERAGE_DIAGNOSTICS_STREAM]
        )
      ).rows[0] ?? null)
    : (getDb()
        .prepare(
          `SELECT ci.manifest_generation AS current_generation, cs.manifest_generation AS state_generation
         FROM connector_instances ci
         LEFT JOIN connector_state cs
           ON cs.connector_instance_id = ci.connector_instance_id AND cs.stream = ?
        WHERE ci.connector_instance_id = ?`
        )
        .get<CoverageGenerationRow>(LOCAL_COVERAGE_DIAGNOSTICS_STREAM, connectorInstanceId) ?? null);
  const currentGeneration = generation?.current_generation ?? null;
  const stateGeneration = generation?.state_generation ?? null;
  return {
    ...parseCoverageDiagnosticsStateSnapshot(connectorId, state),
    manifestGeneration: currentGeneration === null ? null : Number(currentGeneration),
    state,
    stateManifestGeneration: stateGeneration === null ? null : Number(stateGeneration),
    updatedAt: stateProjection.updated_at ?? null,
  };
}

/**
 * Page-scoped form of committed local coverage evidence. It reads the same
 * connection-state and manifest-generation facts as the singleton API, but
 * never resolves through connector id (which is not a connection identity).
 */
export async function readCommittedLocalCoverageDiagnosticsByConnectionIds(connectorInstanceIds: readonly string[]) {
  const ids = [...new Set(connectorInstanceIds.filter((id) => typeof id === "string" && id.length > 0))];
  const result = new Map<
    string,
    ReturnType<typeof parseCoverageDiagnosticsStateSnapshot> & {
      manifestGeneration: number | null;
      state: unknown;
      stateManifestGeneration: number | null;
      updatedAt: string | null;
    }
  >();
  if (ids.length === 0) {
    return result;
  }
  interface Row {
    connector_id: string;
    connector_instance_id: string;
    current_generation: number | string | null;
    state_generation: number | string | null;
    state_json: unknown;
    updated_at: string | null;
  }
  const rows: Row[] = [];
  const projection = `SELECT ci.connector_id, ci.connector_instance_id,
                              ci.manifest_generation AS current_generation,
                              cs.manifest_generation AS state_generation,
                              cs.state_json, cs.updated_at
                         FROM connector_instances ci
                         LEFT JOIN connector_state cs
                           ON cs.connector_instance_id = ci.connector_instance_id
                          AND cs.stream = '${LOCAL_COVERAGE_DIAGNOSTICS_STREAM}'`;
  if (isPostgresStorageBackend()) {
    const query = await postgresQuery<Row>(`${projection} WHERE ci.connector_instance_id = ANY($1::text[])`, [ids]);
    rows.push(...query.rows);
  } else {
    for (let start = 0; start < ids.length; start += 900) {
      const chunk = ids.slice(start, start + 900);
      rows.push(
        ...(getDb()
          .prepare(`${projection} WHERE ci.connector_instance_id IN (${chunk.map(() => "?").join(", ")})`)
          .all(...chunk) as Row[])
      );
    }
  }
  for (const row of rows) {
    // `row.state_json` is already the `coverage_diagnostics` stream's own
    // payload — the JOIN's `ON` clause already narrows `cs.stream =
    // LOCAL_COVERAGE_DIAGNOSTICS_STREAM`, so a matched row's `state_json`
    // column is that one stream's state, not a wrapper object keyed by
    // stream name (unlike `getStateSync`'s multi-stream `state` map, which
    // this function does not build). Re-indexing it a second time here
    // always missed and returned `null`, which `parseCoverageDiagnosticsStateSnapshot`
    // then read as "no coverage evidence" — the exact live symptom this
    // function exists to fix, silently reintroduced because nothing called
    // this batch path until Perf-2026-07-29 wired it into `computeConnectorSummaries`.
    const state = row.state_json === null || row.state_json === undefined ? null : row.state_json;
    const parsedState = typeof state === "string" ? JSON.parse(state) : state;
    result.set(row.connector_instance_id, {
      ...parseCoverageDiagnosticsStateSnapshot(row.connector_id, parsedState),
      manifestGeneration: row.current_generation === null ? null : Number(row.current_generation),
      state: parsedState,
      stateManifestGeneration: row.state_generation === null ? null : Number(row.state_generation),
      updatedAt: row.updated_at ?? null,
    });
  }
  return result;
}

/**
 * Persist explicit provenance for a rejected internal write against the
 * current manifest generation. It never writes a record: retained history is
 * diagnostic/dormant unless this independent signal says otherwise.
 */
export async function recordCurrentGenerationUndeclaredWrite(
  storageTarget: RecordStorageTarget,
  evidence: { provenance?: unknown; stream?: unknown } | null | undefined
) {
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const stream = typeof evidence?.stream === "string" ? evidence.stream : "";
  const provenance = typeof evidence?.provenance === "string" ? evidence.provenance : "runtime_rejected_write";
  if (!(connectorInstanceId && stream)) {
    throw new Error("Current manifest violation evidence requires connection and stream");
  }
  const observedAt = nowIso();
  if (isPostgresStorageBackend()) {
    await withPostgresTransaction(async (client) => {
      const current = await client.query(
        "SELECT manifest_generation FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
        [connectorInstanceId]
      );
      if (current.rowCount === 0) {
        throw new Error("Current manifest violation evidence requires an existing connection");
      }
      const generation = Number(current.rows[0].manifest_generation ?? 0);
      await client.query(
        `INSERT INTO manifest_write_violations(connector_instance_id, stream, manifest_generation, provenance, observed_at)
       VALUES($1, $2, $3, $4, $5)
       ON CONFLICT(connector_instance_id, stream, manifest_generation) DO UPDATE
         SET provenance = EXCLUDED.provenance, observed_at = EXCLUDED.observed_at`,
        [connectorInstanceId, stream, generation, provenance, observedAt]
      );
      await client.query(
        "UPDATE connector_summary_evidence SET dirty = 1, state = 'stale' WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
    });
    return;
  }
  await withConnectorInstanceWrite(connectorInstanceId, () => {
    writeTransaction(() => {
      const current = getDb()
        .prepare("SELECT manifest_generation FROM connector_instances WHERE connector_instance_id = ?")
        .get(connectorInstanceId);
      if (!current) {
        throw new Error("Current manifest violation evidence requires an existing connection");
      }
      const generation = Number(current.manifest_generation ?? 0);
      getDb()
        .prepare(
          `INSERT INTO manifest_write_violations(connector_instance_id, stream, manifest_generation, provenance, observed_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(connector_instance_id, stream, manifest_generation) DO UPDATE
           SET provenance = excluded.provenance, observed_at = excluded.observed_at`
        )
        .run(connectorInstanceId, stream, generation, provenance, observedAt);
      getDb()
        .prepare("UPDATE connector_summary_evidence SET dirty = 1, state = 'stale' WHERE connector_instance_id = ?")
        .run(connectorInstanceId);
    });
    return Promise.resolve();
  });
}

interface ValidatedChangeVersions {
  effectiveSessionMaxVersion: number;
  verifiedAfterVersion: number;
  verifiedSinceVersion: number;
}

function validateChangesSinceVersions(
  changesSince: ChangesSinceCursor | null,
  paginationCursor: PaginationCursor | null,
  connectorInstanceId: string,
  stream: string
): ValidatedChangeVersions {
  const changesCursor = paginationCursor?.session === "changes" ? paginationCursor : null;
  const sinceVersion = changesSince === null ? (changesCursor?.since_version ?? null) : changesSince.version;
  const afterVersion = changesSince === null ? (changesCursor?.after_version ?? null) : changesSince.version;
  const sessionMaxVersion = changesSince === null ? (changesCursor?.session_max_version ?? null) : null;

  if (
    typeof sinceVersion !== "number" ||
    !Number.isInteger(sinceVersion) ||
    typeof afterVersion !== "number" ||
    !Number.isInteger(afterVersion)
  ) {
    throw codedError(CHANGES_SINCE_MALFORMED_MESSAGE, "invalid_cursor");
  }

  const vcRow = getOne<VersionCounterRow>(referenceQueries.recordsIngestGetVersionCounter, [
    connectorInstanceId,
    stream,
  ]);
  const currentMaxVersion = vcRow ? vcRow.max_version : 0;
  const effectiveSessionMaxVersion = changesSince ? currentMaxVersion : sessionMaxVersion;
  if (typeof effectiveSessionMaxVersion !== "number" || !Number.isInteger(effectiveSessionMaxVersion)) {
    throw codedError(CHANGES_SINCE_MALFORMED_MESSAGE, "invalid_cursor");
  }

  const minChangeRow = getOne<MinVersionRow>(referenceQueries.recordsSnapshotsGetMinRecordChangeVersion, [
    connectorInstanceId,
    stream,
  ]);
  const minVersion = minChangeRow?.min_version ?? null;
  if (minVersion !== null && sinceVersion < minVersion - 1) {
    throw codedError("changes_since cursor is too old; full re-sync required", "cursor_expired");
  }

  return { effectiveSessionMaxVersion, verifiedAfterVersion: afterVersion, verifiedSinceVersion: sinceVersion };
}

function fetchChangeGroupBatch(
  connectorInstanceId: string,
  stream: string,
  pageAfterVersion: number,
  effectiveSessionMaxVersion: number,
  batchSize: number
): ChangeGroupRow[] {
  const changeGroups: ChangeGroupRow[] = [];
  for (const row of iterate<ChangeGroupRow>(referenceQueries.recordsSnapshotsListChangeGroups, [
    connectorInstanceId,
    stream,
    pageAfterVersion,
    effectiveSessionMaxVersion,
  ])) {
    changeGroups.push(row);
    if (changeGroups.length >= batchSize) {
      break;
    }
  }
  return changeGroups;
}

function collectVisibleChanges(
  connectorInstanceId: string,
  stream: string,
  verifiedSinceVersion: number,
  verifiedAfterVersion: number,
  effectiveSessionMaxVersion: number,
  effective: EffectiveReadScope,
  consentTimeField: string | undefined,
  compiledFilters: CompiledFilter[],
  recordIdentity: RecordIdentity | null,
  limit: number
): Array<{ latestVersion: number; responseRecord: ResponseRecord }> {
  const visibleChanges: Array<{ latestVersion: number; responseRecord: ResponseRecord }> = [];
  let pageAfterVersion = verifiedAfterVersion;
  const batchSize = limit + 1;

  while (visibleChanges.length <= limit) {
    const changeGroups = fetchChangeGroupBatch(
      connectorInstanceId,
      stream,
      pageAfterVersion,
      effectiveSessionMaxVersion,
      batchSize
    );

    if (!changeGroups.length) {
      break;
    }

    for (const group of changeGroups) {
      const responseRecord = resolveChangeGroupRecord(
        group,
        connectorInstanceId,
        stream,
        verifiedSinceVersion,
        effective,
        consentTimeField,
        compiledFilters,
        recordIdentity
      );
      if (responseRecord) {
        visibleChanges.push({ latestVersion: group.latest_version, responseRecord });
        if (visibleChanges.length > limit) {
          break;
        }
      }
    }

    if (visibleChanges.length > limit || changeGroups.length < batchSize) {
      break;
    }
    const lastChangeGroup = changeGroups.at(-1);
    if (!lastChangeGroup) {
      break;
    }
    pageAfterVersion = lastChangeGroup.latest_version;
  }

  return visibleChanges;
}

function resolveChangeGroupRecord(
  group: ChangeGroupRow,
  connectorInstanceId: string,
  stream: string,
  verifiedSinceVersion: number,
  effective: EffectiveReadScope,
  consentTimeField: string | undefined,
  compiledFilters: CompiledFilter[],
  recordIdentity: RecordIdentity | null
): ResponseRecord | null {
  const previous = getSnapshotAtVersion(connectorInstanceId, stream, group.record_key, verifiedSinceVersion);
  const current = getSnapshotAtVersion(connectorInstanceId, stream, group.record_key, group.latest_version);

  const previousVisible = isVisibleSnapshot(previous, effective, consentTimeField);
  const currentVisible = isVisibleSnapshot(current, effective, consentTimeField);

  if (current?.deleted) {
    if (!(previousVisible && previous?.data && passesRequestFilters(previous.data, compiledFilters))) {
      return null;
    }
    const deletedRecord: ResponseRecord = {
      deleted: true,
      deleted_at: current.deleted_at,
      emitted_at: current.emitted_at,
      id: group.record_key,
      object: "record",
      stream,
    };
    decorateRecordWithConnectionIdentity(deletedRecord, recordIdentity);
    return deletedRecord;
  }

  if (!(currentVisible && current?.data && passesRequestFilters(current.data, compiledFilters))) {
    return null;
  }

  const previousProjection =
    previousVisible && previous?.data ? projectFields(previous.data, effective.fields ?? undefined) : null;
  const currentProjection = projectFields(current.data, effective.fields ?? undefined);

  if (previousProjection && JSON.stringify(previousProjection) === JSON.stringify(currentProjection)) {
    return null;
  }

  const changeRecord: ResponseRecord = {
    data: currentProjection,
    emitted_at: current.emitted_at,
    id: group.record_key,
    object: "record",
    stream,
  };
  decorateRecordWithConnectionIdentity(changeRecord, recordIdentity);
  return changeRecord;
}

interface QueryRecordsChangesSinceArgs {
  changesSince: ChangesSinceCursor | null;
  compiledFilters: CompiledFilter[];
  connectorInstanceId: string;
  consentTimeField: string | undefined;
  effective: EffectiveReadScope;
  limit: number;
  paginationCursor: PaginationCursor | null;
  recordIdentity: RecordIdentity | null;
  requestWarnings: ReadWarning[];
  stream: string;
}

function queryRecordsChangesSince({
  changesSince,
  compiledFilters,
  connectorInstanceId,
  consentTimeField,
  effective,
  limit,
  paginationCursor,
  recordIdentity,
  requestWarnings,
  stream,
}: QueryRecordsChangesSinceArgs): ListResponse {
  const { verifiedSinceVersion, verifiedAfterVersion, effectiveSessionMaxVersion } = validateChangesSinceVersions(
    changesSince,
    paginationCursor,
    connectorInstanceId,
    stream
  );

  const visibleChanges = collectVisibleChanges(
    connectorInstanceId,
    stream,
    verifiedSinceVersion,
    verifiedAfterVersion,
    effectiveSessionMaxVersion,
    effective,
    consentTimeField,
    compiledFilters,
    recordIdentity,
    limit
  );

  const hasMore = visibleChanges.length > limit;
  const data = visibleChanges.slice(0, limit).map((change) => change.responseRecord);

  const response: ListResponse = {
    data,
    has_more: hasMore,
    object: "list",
  };

  if (hasMore && data.length) {
    const lastGroup = visibleChanges[limit - 1];
    if (!lastGroup) {
      throw new Error("[records] changes page has no terminal group");
    }
    response.next_cursor = encodeChangesPageCursor({
      afterVersion: lastGroup.latestVersion,
      sessionMaxVersion: effectiveSessionMaxVersion,
      sinceVersion: verifiedSinceVersion,
    });
  }

  response.next_changes_since = encodeChangesSinceCursor(effectiveSessionMaxVersion);
  attachRequestWarningsToResponse(response, requestWarnings);
  return response;
}

interface PagedRecordsArgs {
  compiledFilters: CompiledFilter[];
  connectorId: string;
  connectorInstanceId: string;
  consentTimeField: string | undefined;
  effective: EffectiveReadScope;
  expansions: ReturnType<typeof normalizeExpandRequest>;
  limit: number;
  manifest: ReadManifest | null;
  manifestStream: ManifestStream;
  order: PageOrder;
  paginationCursor: PaginationCursor | null;
  recordIdentity: RecordIdentity | null;
  requestParams: RequestParams;
  requestWarnings: ReadWarning[];
  stream: string;
}

async function buildPagedRecordsResponse({
  compiledFilters,
  connectorId,
  connectorInstanceId,
  consentTimeField,
  effective,
  expansions,
  limit,
  manifest,
  manifestStream,
  order,
  paginationCursor,
  recordIdentity,
  requestParams,
  requestWarnings,
  stream,
}: PagedRecordsArgs): Promise<ListResponse> {
  const cursorPosition = normalizePaginationCursor(paginationCursor, order);
  const { rows: pagedRows, hasMore } = fetchVisibleRecordRowsPaginated({
    compiledFilters,
    connectorId,
    connectorInstanceId,
    cursorPosition: cursorPosition
      ? { cursor_value: cursorPosition.cursor_value, primary_key: cursorPosition.primary_key ?? [] }
      : null,
    effective,
    limit,
    manifestStream,
    order,
    stream,
  });
  const effectivePageRows = pagedRows.map((row) => ({
    ...row,
    responseRecord: buildResponseRecord(stream, row, effective, recordIdentity),
  }));

  await hydrateExpandedRelations({
    childIdentity: recordIdentity,
    connectorId,
    connectorInstanceId,
    effectiveParentRows: effectivePageRows,
    expansions,
    manifest: manifest?.streams ? { streams: manifest.streams } : null,
  });

  const data = effectivePageRows.map((row) => row.responseRecord);

  const response: ListResponse = {
    data,
    has_more: hasMore,
    object: "list",
  };

  if (hasMore && data.length) {
    const lastRow = effectivePageRows.at(-1);
    if (!lastRow) {
      throw new Error("[records] non-empty record page has no terminal row");
    }
    response.next_cursor = encodeRecordsPageCursor(lastRow.sortPosition, order);
  }

  const countOutcome = computeGradedRecordCount({
    compiledFilters,
    connectorInstanceId,
    consentTimeField,
    effective,
    requestParams,
    stream,
  });
  if (countOutcome) {
    response.meta = mergeMetaCount(response.meta, countOutcome.count);
  }

  const windowOutcome = computeRecordWindow({
    compiledFilters,
    connectorInstanceId,
    consentTimeField,
    effective,
    requestParams,
    stream,
  });
  if (windowOutcome) {
    response.meta = mergeMetaWindow(response.meta, windowOutcome);
  }

  attachRequestWarningsToResponse(response, requestWarnings);
  return response;
}

interface ValidatedQueryContext {
  changesSince: ChangesSinceCursor | null;
  compiledFilters: CompiledFilter[];
  connectorId: string;
  connectorInstanceId: string;
  consentTimeField: string | undefined;
  effective: EffectiveReadScope;
  expansions: ReturnType<typeof normalizeExpandRequest>;
  limit: number;
  mStream: ManifestStream;
  order: PageOrder;
  paginationCursor: PaginationCursor | null;
  requestWarnings: ReadWarning[];
}

function validateQueryCursors(
  requestParams: RequestParams,
  expansions: ReturnType<typeof normalizeExpandRequest>
): { changesSince: ChangesSinceCursor | null; paginationCursor: PaginationCursor | null } {
  const changesSince =
    typeof requestParams.changes_since === "string" ? parseChangesSinceCursor(requestParams.changes_since) : null;
  const paginationCursor = typeof requestParams.cursor === "string" ? parsePageCursor(requestParams.cursor) : null;

  if (requestParams.changes_since && !changesSince) {
    throw codedError(CHANGES_SINCE_MALFORMED_MESSAGE, "invalid_cursor");
  }
  if (requestParams.cursor && !paginationCursor) {
    throw codedError("Malformed cursor", "invalid_cursor");
  }
  if (changesSince !== null || paginationCursor?.session === "changes") {
    rejectListOnlyParamsForChangesFeed(requestParams);
  }
  if ((changesSince !== null || paginationCursor?.session === "changes") && expansions.length) {
    throw invalidQueryError("expand is not supported with changes_since", "invalid_expand");
  }
  return { changesSince, paginationCursor };
}

async function validateQueryRecordsRequest(
  storageTarget: RecordStorageTarget,
  stream: string,
  grant: ReadGrant,
  requestParams: RequestParams,
  manifest: ReadManifest | null
): Promise<ValidatedQueryContext & { recordIdentity: RecordIdentity | null }> {
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);

  const streamGrant = grant.streams.find((entry) => entry.name === stream);
  if (!streamGrant) {
    throw codedError(`Stream '${stream}' not in grant`, "grant_stream_not_allowed");
  }
  const mStream = manifest?.streams?.find((entry) => entry.name === stream) ?? null;
  if (!mStream) {
    throw codedError(`Stream '${stream}' is not declared by the manifest`, "invalid_stream");
  }
  const consentTimeField = mStream.consent_time_field;
  const requiredFields = mStream.schema?.required ?? [];
  const resolvedSort = validateTopLevelQueryParams(requestParams, mStream);
  const order = resolveListOrder(requestParams.order, resolvedSort);
  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  enforceConnectionNarrowing(requestParams, connectorInstanceId);

  const recordIdentity = await resolveRecordIdentityForBinding(connectorInstanceId, connectorId);

  if (Array.isArray(requestParams.fields) && streamGrant.fields) {
    const unauthorized = requestParams.fields.filter((field) => !streamGrant.fields?.includes(field));
    if (unauthorized.length) {
      throw codedError(`Fields not in grant: ${unauthorized.join(", ")}`, "field_not_granted");
    }
  }

  const compiledFilters = compileRequestFilters(requestParams.filter, streamGrant, mStream);
  const effective = buildEffectiveReadScope(streamGrant, requestParams, requiredFields);
  const expansions = normalizeExpandRequest(requestParams, stream, grant, mStream, order);
  const { limit, clamped: limitClamped, requested: requestedLimit } = clampRecordsPageLimit(requestParams.limit);
  if (limitClamped && requestedLimit !== null) {
    requestWarnings.push(buildLimitClampedWarning(requestedLimit));
  }

  const { changesSince, paginationCursor } = validateQueryCursors(requestParams, expansions);

  return {
    changesSince,
    compiledFilters,
    connectorId,
    connectorInstanceId,
    consentTimeField,
    effective,
    expansions,
    limit,
    mStream,
    order,
    paginationCursor,
    recordIdentity,
    requestWarnings,
  };
}

/**
 * Query records for a stream under grant enforcement
 */
export async function queryRecords(
  storageTarget: RecordStorageTarget,
  stream: string,
  grant: ReadGrant,
  requestParams: RequestParams = {},
  manifest: ReadManifest | null = null
): Promise<ListResponse> {
  assertManifestReadAuthority(manifest?.streams ? { streams: manifest.streams } : null, stream, { actor: "internal" });
  if (isPostgresStorageBackend()) {
    return requireListResponse(
      await Reflect.apply(postgresQueryRecords, undefined, [
        storageTarget,
        stream,
        grant,
        requestParams,
        manifest?.streams ? { streams: manifest.streams } : null,
      ])
    );
  }

  const ctx = await validateQueryRecordsRequest(storageTarget, stream, grant, requestParams, manifest);
  const { changesSince, paginationCursor } = ctx;

  if (changesSince !== null || paginationCursor?.session === "changes") {
    return queryRecordsChangesSince({
      changesSince: ctx.changesSince,
      compiledFilters: ctx.compiledFilters,
      connectorInstanceId: ctx.connectorInstanceId,
      consentTimeField: ctx.consentTimeField,
      effective: ctx.effective,
      limit: ctx.limit,
      paginationCursor: ctx.paginationCursor,
      recordIdentity: ctx.recordIdentity,
      requestWarnings: ctx.requestWarnings,
      stream,
    });
  }

  return buildPagedRecordsResponse({
    compiledFilters: ctx.compiledFilters,
    connectorId: ctx.connectorId,
    connectorInstanceId: ctx.connectorInstanceId,
    consentTimeField: ctx.consentTimeField,
    effective: ctx.effective,
    expansions: ctx.expansions,
    limit: ctx.limit,
    manifest,
    manifestStream: ctx.mStream,
    order: ctx.order,
    paginationCursor: ctx.paginationCursor,
    recordIdentity: ctx.recordIdentity,
    requestParams,
    requestWarnings: ctx.requestWarnings,
    stream,
  });
}

/**
 * Compute the requested graded count for a records list response.
 *
 * The canonical grades are `none`, `estimated`, and `exact`. This first
 * surface implements `exact` by scanning the same visible-row set the
 * records list would have scanned for the aggregate path (cheap on the
 * SQLite reference; future tranches can add planner-style estimates).
 *
 * Behavior:
 *   - `count` absent or `none`: return `null` (callers omit `meta.count`).
 *   - `count=exact`:     returns `{ count: { kind: 'exact', value } }`.
 *   - `count=estimated`: returns `{ count: { kind: 'exact', value } }`
 *     (silent upgrade). `count_downgraded` is reserved for the strict
 *     case where the server returned a *lower* grade than requested
 *     (e.g. `count=exact` -> delivered `estimated`/`none`). Returning a
 *     higher-fidelity value than asked for is not a downgrade, so the
 *     reference does not invent a warning for it.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract design.md
 *       (#"Counts") and specs/reference-implementation-architecture/
 *       spec.md (#"Requested count is downgraded").
 */
function computeGradedRecordCount({
  requestParams,
  connectorInstanceId,
  stream,
  effective,
  compiledFilters,
  consentTimeField,
}: {
  compiledFilters: readonly CompiledFilter[];
  connectorInstanceId: string;
  consentTimeField: string | null | undefined;
  effective: EffectiveReadScope;
  requestParams: RequestParams;
  stream: string;
}): { count: CountMeta } | null {
  const requested = typeof requestParams.count === "string" ? requestParams.count : null;
  if (!requested || requested === "none") {
    return null;
  }

  const exactValue = countVisibleRecordsForStream({
    compiledFilters,
    connectorInstanceId,
    consentTimeField,
    effective,
    stream,
  });

  if (requested === "exact" || requested === "estimated") {
    return { count: { kind: "exact", value: exactValue } };
  }

  return null;
}

/**
 * Scan visible records under the same grant + filter set the list path
 * uses and return the visible count. Mirrors `aggregateRecords` count
 * semantics so the two surfaces stay in lock-step.
 */
function countVisibleRecordsForStream({
  connectorInstanceId,
  stream,
  effective,
  compiledFilters,
  consentTimeField,
}: {
  compiledFilters: readonly CompiledFilter[];
  connectorInstanceId: string;
  consentTimeField: string | null | undefined;
  effective: EffectiveReadScope;
  stream: string;
}): number {
  if (isPostgresStorageBackend()) {
    // Postgres path falls back to scanning visible rows; postgres-records.js
    // owns the storage-specific count helper. For now records.ts's count
    // helper only handles the SQLite reference because the Postgres list
    // path runs entirely through postgres-records.js.
    return 0;
  }
  const rows = iterate<AggregateRecordRow>(referenceQueries.recordsAggregateIterateStreamRecordsForAggregation, [
    connectorInstanceId,
    stream,
  ]);
  let visibleCount = 0;
  for (const row of rows) {
    const rawData = parseStoredRecordData(row.record_json);
    if (effective.resources && !effective.resources.includes(row.record_key)) {
      continue;
    }
    if (effective.timeRange && consentTimeField && !passesTimeRange(rawData, effective.timeRange, consentTimeField)) {
      continue;
    }
    if (compiledFilters.length && !passesRequestFilters(rawData, compiledFilters)) {
      continue;
    }
    visibleCount += 1;
  }
  return visibleCount;
}

/**
 * Merge a `meta.count` payload into an existing response.meta, preserving
 * `warnings` and any other meta members. Returns the new meta object.
 */
function mergeMetaCount(existingMeta: RecordResponseMeta | undefined, count: CountMeta): RecordResponseMeta {
  const base =
    existingMeta && typeof existingMeta === "object" && !Array.isArray(existingMeta) ? { ...existingMeta } : {};
  base.count = count;
  return base;
}

/**
 * Merge a `meta.window` payload into an existing response.meta, preserving
 * `count`, `warnings`, and any other meta members. Returns the new meta
 * object.
 */
function mergeMetaWindow(existingMeta: RecordResponseMeta | undefined, window: WindowMeta): RecordResponseMeta {
  const base =
    existingMeta && typeof existingMeta === "object" && !Array.isArray(existingMeta) ? { ...existingMeta } : {};
  base.window = window;
  return base;
}

function isVisibleAggregateRow(
  row: AggregateRecordRow,
  rawData: RecordData,
  effective: EffectiveReadScope,
  consentTimeField: string | null | undefined,
  compiledFilters: readonly CompiledFilter[]
): boolean {
  if (effective.resources && !effective.resources.includes(row.record_key)) {
    return false;
  }
  if (effective.timeRange && consentTimeField && !passesTimeRange(rawData, effective.timeRange, consentTimeField)) {
    return false;
  }
  return compiledFilters.length === 0 || passesRequestFilters(rawData, compiledFilters);
}

function recordWindowTime(value: unknown): number | null {
  if (value === null || value === "") {
    return null;
  }
  const ms = new Date(typeof value === "string" || typeof value === "number" ? value : String(value)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Compute the bounded `meta.window` aggregate for a records list response,
 * when the request opted in via `window=exact`.
 *
 * The window describes the *whole filtered, grant-scoped corpus* — not the
 * paginated page — so `limit=1` still reports the full bounds. It reuses the
 * exact visible-row scan `countVisibleRecordsForStream` uses (same grant
 * resources, time-range, and compiled filters), so the two surfaces stay in
 * lock-step and we never duplicate grant/filter semantics on a divergent path.
 *
 * Timestamp source is the stream's logical `consent_time_field` — the same
 * field `passesTimeRange` filters on — never the storage ingest `emitted_at`.
 *
 * Honest-omission rules (never estimate; see spec scenario "Window metadata is
 * omitted rather than estimated"):
 *   - `window` absent / empty / `none`: return `null` (callers omit
 *     `meta.window`).
 *   - empty filtered corpus: `{ total: 0 }` with no timestamps.
 *   - stream declares no `consent_time_field`: `{ total: N }` with no
 *     timestamps (do NOT substitute `emitted_at`).
 *   - rows whose `consent_time_field` value is missing/unparseable are
 *     excluded from min/max; if every visible row lacks a parseable value,
 *     emit `{ total: N }` with no timestamps.
 *   - `earliest_at` and `latest_at` are emitted together or both omitted.
 *
 * Spec: openspec/changes/complete-explorer-slvp-ideal/specs/
 *       reference-implementation-architecture/spec.md.
 */
function computeRecordWindow({
  requestParams,
  connectorInstanceId,
  stream,
  effective,
  compiledFilters,
  consentTimeField,
}: {
  compiledFilters: readonly CompiledFilter[];
  connectorInstanceId: string;
  consentTimeField: string | null | undefined;
  effective: EffectiveReadScope;
  requestParams: RequestParams;
  stream: string;
}): WindowMeta | null {
  const requested = typeof requestParams.window === "string" ? requestParams.window : null;
  if (!requested || requested === "none") {
    return null;
  }

  if (isPostgresStorageBackend()) {
    // The Postgres list path runs entirely through postgres-records.js, which
    // owns its own (currently omitted) window computation. Guard here so a
    // SQLite-only helper never silently returns a zero window under Postgres.
    return null;
  }

  const rows = iterate<AggregateRecordRow>(referenceQueries.recordsAggregateIterateStreamRecordsForAggregation, [
    connectorInstanceId,
    stream,
  ]);

  let total = 0;
  let earliestMs: number | null = null;
  let latestMs: number | null = null;

  for (const row of rows) {
    const rawData = parseStoredRecordData(row.record_json);
    if (!isVisibleAggregateRow(row, rawData, effective, consentTimeField, compiledFilters)) {
      continue;
    }

    total += 1;

    if (!consentTimeField) {
      continue;
    }
    const ms = recordWindowTime(rawData[consentTimeField]);
    if (ms === null) {
      continue;
    }
    if (earliestMs === null || ms < earliestMs) {
      earliestMs = ms;
    }
    if (latestMs === null || ms > latestMs) {
      latestMs = ms;
    }
  }

  const window: WindowMeta = { total };
  if (earliestMs !== null && latestMs !== null) {
    // Normalize to ISO 8601 UTC via the same `new Date(...)` parse the
    // time-range filter uses; `earliest_at`/`latest_at` are emitted together.
    window.earliest_at = new Date(earliestMs).toISOString();
    window.latest_at = new Date(latestMs).toISOString();
  }
  return window;
}

/**
 * Attach a `meta.warnings[]` envelope to a public-read response only when
 * the runtime has non-empty structured warnings to surface. Keeps the wire
 * shape backwards-compatible for the common no-warning case while opening
 * the canonical `meta.warnings` slot for deprecated-alias usage and any
 * future graded outcomes (skipped sources, count downgrade, etc.).
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 */
function attachRequestWarningsToResponse(
  response: { meta?: RecordResponseMeta } | null | undefined,
  warnings: readonly unknown[] | null | undefined
): void {
  if (!response || typeof response !== "object") {
    return;
  }
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return;
  }
  const existingMeta =
    response.meta && typeof response.meta === "object" && !Array.isArray(response.meta) ? response.meta : null;
  const existingWarnings = existingMeta && Array.isArray(existingMeta.warnings) ? existingMeta.warnings : [];
  response.meta = {
    ...(existingMeta || {}),
    warnings: [...existingWarnings, ...warnings],
  };
}

export function listRowsForAggregation(connectorInstanceId: string, stream: string) {
  const backend = createStorageBackend();
  return backend.listRowsForAggregation({ connectorInstanceId, stream });
}

interface LocalAggregateAccumulator {
  bestComparable: number | string | null;
  bestValue: unknown;
  distinctValues: Set<string>;
  groups: Map<string, AggregateGroup>;
  sum: number;
  timeBuckets: Map<string, AggregateGroup>;
  visibleCount: number;
}

function accumulateGroupedAggregateRow(
  acc: LocalAggregateAccumulator,
  rawData: RecordData,
  request: ReturnType<typeof normalizeAggregateRequest>
): boolean {
  if (request.groupBy) {
    const value = rawData[request.groupBy] ?? null;
    const key = JSON.stringify(value);
    const group = acc.groups.get(key) || { count: 0, key: value };
    group.count += 1;
    acc.groups.set(key, group);
    return true;
  }
  if (!(request.groupByTime && request.granularity && request.timeZone)) {
    return false;
  }
  const key = bucketStartForGranularity(rawData[request.groupByTime] ?? null, request.granularity, request.timeZone);
  const mapKey = key === null ? "__null__" : key;
  const group = acc.timeBuckets.get(mapKey) || { count: 0, key };
  group.count += 1;
  acc.timeBuckets.set(mapKey, group);
  return true;
}

function accumulateAggregateRow(
  acc: LocalAggregateAccumulator,
  rawData: RecordData,
  request: ReturnType<typeof normalizeAggregateRequest>,
  fieldSchema: JsonSchema | null
): void {
  acc.visibleCount += 1;
  if (accumulateGroupedAggregateRow(acc, rawData, request)) {
    return;
  }
  if (!request.field) {
    return;
  }
  const value = rawData[request.field];
  if (request.metric === "count_distinct") {
    if (value !== null && value !== undefined) {
      acc.distinctValues.add(JSON.stringify(value));
    }
    return;
  }
  const comparable = coerceComparableValue(value, fieldSchema);
  if (request.metric === "sum") {
    if (typeof comparable === "number" && Number.isFinite(comparable)) {
      acc.sum += comparable;
    }
    return;
  }
  if ((request.metric === "min" || request.metric === "max") && comparable !== null) {
    const replace =
      acc.bestComparable === null ||
      (request.metric === "min" ? comparable < acc.bestComparable : comparable > acc.bestComparable);
    if (replace) {
      acc.bestComparable = comparable;
      acc.bestValue = value;
    }
  }
}

function applyAggregateGrouping(
  response: AggregateResponse,
  request: ReturnType<typeof normalizeAggregateRequest>,
  acc: LocalAggregateAccumulator
): boolean {
  const isScalarGroup = Boolean(request.groupBy);
  const groups = isScalarGroup ? acc.groups : acc.timeBuckets;
  if (!request.limit || (groups.size === 0 && !(request.groupBy || request.groupByTime))) {
    return false;
  }
  if (!(request.groupBy || request.groupByTime)) {
    return false;
  }
  const sorted = [...groups.values()].sort((left, right) => compareMergedBuckets(left, right, isScalarGroup));
  response.groups = sorted.slice(0, request.limit);
  response.limit = request.limit;
  response.other_count = sorted.slice(request.limit).reduce((total, group) => total + group.count, 0);
  return true;
}

function aggregateScalarValue(
  request: ReturnType<typeof normalizeAggregateRequest>,
  acc: LocalAggregateAccumulator
): unknown {
  if (request.metric === "count") {
    return acc.visibleCount;
  }
  if (request.metric === "count_distinct") {
    return acc.distinctValues.size;
  }
  if (request.metric === "sum") {
    return acc.sum;
  }
  return acc.bestValue;
}

/**
 * Aggregate records for one stream under the same grant and filter semantics
 * used by record listing. This first surface deliberately scans visible rows
 * in-process instead of adding aggregate indexes; it is a semantic floor.
 */
export async function aggregateRecords(
  storageTarget: RecordStorageTarget,
  stream: string,
  grant: ReadGrant,
  requestParams: RequestParams = {},
  manifest: ReadManifest | null = null
) {
  assertManifestReadAuthority(manifest?.streams ? { streams: manifest.streams } : null, stream, { actor: "internal" });
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);

  const streamGrant = grant.streams.find((entry) => entry.name === stream);
  if (!streamGrant) {
    throw codedError(`Stream '${stream}' not in grant`, "grant_stream_not_allowed");
  }

  const manifestStream = manifest?.streams?.find((entry) => entry.name === stream) ?? null;
  if (!manifestStream) {
    throw codedError(`Stream '${stream}' is not declared by the manifest`, "invalid_stream");
  }

  const aggregateRequest = normalizeAggregateRequest(requestParams, streamGrant, manifestStream);
  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  enforceConnectionNarrowing(requestParams, connectorInstanceId);
  const compiledFilters = compileRequestFilters(requestParams.filter, streamGrant, manifestStream);
  const effective = buildEffectiveReadScope(streamGrant, {});
  const consentTimeField = manifestStream?.consent_time_field || null;

  const rows = await listRowsForAggregation(connectorInstanceId, stream);

  const acc: LocalAggregateAccumulator = {
    bestComparable: null,
    bestValue: null,
    distinctValues: new Set<string>(),
    groups: new Map<string, AggregateGroup>(),
    sum: 0,
    timeBuckets: new Map<string, AggregateGroup>(),
    visibleCount: 0,
  };
  const aggregateFieldSchema = aggregateRequest.field ? getFieldSchema(manifestStream, aggregateRequest.field) : null;

  for (const row of rows) {
    const rawData = parseStoredRecordData(row.record_json);
    if (effective.resources && !effective.resources.includes(row.record_key)) {
      continue;
    }
    if (effective.timeRange && consentTimeField && !passesTimeRange(rawData, effective.timeRange, consentTimeField)) {
      continue;
    }
    if (compiledFilters.length && !passesRequestFilters(rawData, compiledFilters)) {
      continue;
    }

    accumulateAggregateRow(acc, rawData, aggregateRequest, aggregateFieldSchema);
  }

  const response: AggregateResponse = {
    // The in-process floor is exact; only a future accelerated estimator
    // would flip this to true.
    approximate: false,
    field: aggregateRequest.field,
    filtered_record_count: acc.visibleCount,
    granularity: aggregateRequest.granularity,
    group_by: aggregateRequest.groupBy,
    // Additive time-bucket fields: null for non-time aggregations so the
    // payload stays backward-compatible.
    group_by_time: aggregateRequest.groupByTime,
    metric: aggregateRequest.metric,
    object: "aggregation",
    stream,
    time_zone: aggregateRequest.timeZone,
  };

  if (!applyAggregateGrouping(response, aggregateRequest, acc)) {
    response.value = aggregateScalarValue(aggregateRequest, acc);
  }

  attachRequestWarningsToResponse(response, requestWarnings);

  return response;
}

/**
 * Get a single record by key, under grant enforcement
 */
export async function getRecord(
  storageTarget: RecordStorageTarget,
  stream: string,
  recordId: string,
  grant: ReadGrant,
  manifest: ReadManifest | null = null,
  requestParams: RequestParams = {}
): Promise<ResponseRecord> {
  assertManifestReadAuthority(manifest?.streams ? { streams: manifest.streams } : null, stream, { actor: "internal" });
  if (isPostgresStorageBackend()) {
    return requireResponseRecord(
      await Reflect.apply(postgresGetRecord, undefined, [
        storageTarget,
        stream,
        recordId,
        grant,
        manifest?.streams ? { streams: manifest.streams } : null,
        requestParams,
      ])
    );
  }

  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);

  const streamGrant = grant.streams.find((s) => s.name === stream);
  if (!streamGrant) {
    throw codedError(`Stream '${stream}' not in grant`, "grant_stream_not_allowed");
  }

  const mStream = manifest?.streams?.find((s) => s.name === stream);

  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  enforceConnectionNarrowing(requestParams, connectorInstanceId);

  const row = getOne<StoredRecordRow>(referenceQueries.recordsGetLiveRecordByKey, [
    connectorInstanceId,
    stream,
    recordId,
  ]);

  if (!row) {
    throw codedError("Record not found", "not_found");
  }

  const rawData = parseStoredRecordData(row.record_json);
  const consentTimeField = mStream?.consent_time_field;
  const requiredFields = mStream?.schema?.required || [];

  const effective = buildEffectiveReadScope(streamGrant, {}, requiredFields);
  if (effective.resources && !effective.resources.includes(row.record_key)) {
    throw codedError("Record not found", "not_found");
  }
  if (effective.timeRange && consentTimeField && !passesTimeRange(rawData, effective.timeRange, consentTimeField)) {
    throw codedError("Record not found", "not_found");
  }

  const recordIdentity = await resolveRecordIdentityForBinding(connectorInstanceId, connectorId);

  const responseRow: EffectiveParentRow = {
    emitted_at: row.emitted_at,
    rawData,
    record_key: row.record_key,
    responseRecord: buildResponseRecord(
      stream,
      {
        emitted_at: row.emitted_at,
        rawData,
        record_key: row.record_key,
        sortPosition: buildRecordSortPosition(rawData, row.record_key, mStream),
      },
      effective,
      recordIdentity
    ),
    sortPosition: buildRecordSortPosition(rawData, row.record_key, mStream),
  };

  const expansions = normalizeExpandRequest(
    {
      expand:
        typeof requestParams.expand === "string" ||
        Array.isArray(requestParams.expand) ||
        isRecordData(requestParams.expand)
          ? requestParams.expand
          : null,
      expand_limit:
        typeof requestParams.expand_limit === "string" ||
        typeof requestParams.expand_limit === "number" ||
        isRecordData(requestParams.expand_limit)
          ? requestParams.expand_limit
          : null,
    },
    stream,
    grant,
    mStream ?? {},
    "ASC"
  );

  hydrateExpandedRelations({
    childIdentity: recordIdentity,
    connectorId,
    connectorInstanceId,
    effectiveParentRows: [responseRow],
    expansions,
    manifest,
  });

  attachRequestWarningsToResponse(responseRow.responseRecord, requestWarnings);
  return responseRow.responseRecord;
}

function assertFieldWindowManifestAuthority(manifest: ReadManifest | null, stream: string): void {
  try {
    assertManifestReadAuthority(manifest?.streams ? { streams: manifest.streams } : null, stream, {
      actor: "internal",
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "stream_not_declared") {
      const statusCode = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 404;
      throw fieldWindowError("stream_not_declared", error.message, statusCode);
    }
    throw error;
  }
}

function assertFieldWindowRecordVisible(
  row: RecordFieldWindowRow,
  effective: ReturnType<typeof buildEffectiveReadScope>,
  consentTimeField: string | undefined
): void {
  if (effective.resources && !effective.resources.includes(row.record_key)) {
    throw fieldWindowError("not_found", "Record not found", 404);
  }
  if (effective.timeRange && consentTimeField) {
    const consentData = { [consentTimeField]: row.consent_time_value };
    if (!passesTimeRange(consentData, effective.timeRange, consentTimeField)) {
      throw fieldWindowError("not_found", "Record not found", 404);
    }
  }
}

function buildFieldWindowBinds(
  fieldPathExpr: string,
  consentPathExpr: string | null,
  connectorInstanceId: string,
  stream: string,
  recordId: string,
  selector: ReturnType<typeof normalizeFieldWindowSelector>
): BindValue[] {
  const isQuery = selector.mode === "query";
  return [
    fieldPathExpr,
    fieldPathExpr,
    consentPathExpr,
    connectorInstanceId,
    stream,
    recordId,
    isQuery ? selector.query : null,
    isQuery ? selector.query : null,
    isQuery ? selector.query : null,
    isQuery ? selector.query : null,
    isQuery ? selector.before : 0,
    isQuery ? null : selector.offset + 1,
    selector.limit,
  ];
}

function resolveFieldWindowOffset(
  selector: ReturnType<typeof normalizeFieldWindowSelector>,
  fieldPath: string,
  matchPosRaw: unknown
): { matchStart: number | null; windowOffset: number } {
  if (selector.mode !== "query") {
    return { matchStart: null, windowOffset: selector.offset };
  }
  const matchStart = Number(matchPosRaw) - 1;
  if (!Number.isFinite(matchStart) || matchStart < 0) {
    throw fieldWindowError("query_not_found", `q was not found in field '${fieldPath}'`, 404);
  }
  return { matchStart, windowOffset: Math.max(0, matchStart - selector.before) };
}

export async function getRecordFieldWindow(
  storageTarget: RecordStorageTarget,
  stream: string,
  recordId: string,
  fieldPath: string,
  grant: ReadGrant,
  manifest: ReadManifest | null = null,
  requestParams: RequestParams = {}
) {
  assertFieldWindowManifestAuthority(manifest, stream);
  if (isPostgresStorageBackend()) {
    return await Reflect.apply(postgresGetRecordFieldWindow, undefined, [
      storageTarget,
      stream,
      recordId,
      fieldPath,
      grant,
      manifest,
      requestParams,
    ]);
  }

  assertFieldPath(fieldPath);
  const selector = normalizeFieldWindowSelector(requestParams);

  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);

  const streamGrant = grant.streams.find((s) => s.name === stream);
  if (!streamGrant) {
    throw fieldWindowError("grant_stream_not_allowed", `Stream '${stream}' not in grant`, 403);
  }

  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  enforceConnectionNarrowing(requestParams, connectorInstanceId);

  const mStream = manifest?.streams?.find((s) => s.name === stream);
  const consentTimeField = mStream?.consent_time_field;
  const requiredFields = mStream?.schema?.required || [];
  const effective = buildEffectiveReadScope(streamGrant, {}, requiredFields);

  assertFieldVisibleToGrant(fieldPath, effective.fields);

  const fieldPathExpr = sqliteFieldJsonPath(fieldPath);
  const consentPathExpr = consentTimeField ? sqliteFieldJsonPath(consentTimeField) : null;

  const row = getOne<RecordFieldWindowRow>(
    referenceQueries.recordsGetFieldWindow,
    buildFieldWindowBinds(fieldPathExpr, consentPathExpr, connectorInstanceId, stream, recordId, selector)
  );

  if (!row) {
    throw fieldWindowError("not_found", "Record not found", 404);
  }

  assertFieldWindowRecordVisible(row, effective, consentTimeField);

  const fieldClass = classifyFieldType(row.field_type);
  assertReadableStringField(fieldPath, fieldClass);
  const { matchStart, windowOffset } = resolveFieldWindowOffset(selector, fieldPath, row.match_pos);

  const window = buildWindowEnvelope({
    limit: selector.limit,
    matchEndChars: selector.mode === "query" && matchStart !== null ? matchStart + selector.query.length : null,
    matchStartChars: matchStart,
    offset: windowOffset,
    text: row.window_text ?? "",
    totalChars: Number(row.total_chars ?? 0),
  });

  const warnings = [...requestWarnings];
  if (selector.limitClamped) {
    warnings.push({ code: "limit_clamped", message: `limit_chars clamped to ${selector.limit}`, param: "limit_chars" });
  }

  return {
    field_path: fieldPath,
    field_type: fieldClass,
    record_key: row.record_key,
    warnings,
    window,
  };
}

/**
 * Delete a record (owner-authenticated).
 *
 * Atomicity: durable record mutation — current-state read, absent /
 * already-deleted no-op decision, atomic version allocation
 * (`recordsIngestAllocateNextVersion` upserts `version_counter` and returns
 * the freshly-allocated `max_version` in one statement), live `records`
 * delete-marker mutation, `record_changes` deleted-row append, and history
 * pruning — runs inside one explicit SQLite `BEGIN IMMEDIATE` write
 * transaction (`writeTransaction`). The write lock is acquired at
 * transaction start so concurrent writers (direct delete and ingest both
 * target the same per-`(connector_id, stream)` version state) serialize on
 * the read, not on the first write.
 *
 * Lexical and semantic index deletes run after the durable commit and are
 * deliberately *not* part of the atomic unit; an index-maintenance failure
 * must not roll back the durable record write.
 *
 * Spec: openspec/changes/harden-record-version-allocation-atomicity/specs/
 *       reference-implementation-architecture/spec.md
 */
export function deleteRecord(
  storageTarget: RecordStorageTarget,
  stream: string,
  recordId: string,
  coordinatorOwnership?: ConnectorInstanceWriteOwnership
) {
  const coordinationConnectorId = connectorIdForStorageTarget(storageTarget);
  const coordinationInstanceId = resolveStorageConnectorInstanceId(storageTarget, coordinationConnectorId);
  return withConnectorInstanceWrite(
    coordinationInstanceId,
    () => deleteRecordWithinCoordinator(storageTarget, stream, recordId),
    coordinatorOwnership
  );
}

async function deleteRecordWithinCoordinator(storageTarget: RecordStorageTarget, stream: string, recordId: string) {
  if (isPostgresStorageBackend()) {
    const outcome = await postgresDeleteRecord(storageTarget, stream, recordId);
    if (outcome.changed) {
      const connectorId = connectorIdForStorageTarget(storageTarget);
      const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
      if ("retainedSizeDelta" in outcome && outcome.retainedSizeDelta) {
        await applyRetainedSizeRecordDelta(outcome.retainedSizeDelta);
      } else {
        await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
      }
      // Colocated with the retained-size delta: a record delete moved this
      // connection's count/stream evidence, so its maintained connector-summary
      // read model is now stale. Scoped marker (instance id known); best-effort
      // and a no-op until the read model is warmed, so it cannot fail the
      // durable delete.
      await markConnectorSummaryEvidenceDirty({
        connectorInstanceId,
        reason: "record delete changed connection count/stream evidence",
      });
      await lexicalIndexDelete({ connectorId, connectorInstanceId, recordKey: recordId, stream });
      await semanticIndexDelete({ connectorId, connectorInstanceId, recordKey: recordId, stream });
    }
    return outcome;
  }

  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const now = nowIso();
  const changeHistoryLimit = getChangeHistoryLimit();

  const outcome = writeTransaction<{ kind: "changed" | "noop" }>(() => {
    const current = getOne<CurrentRecordRow>(referenceQueries.recordsIngestGetCurrentRecordState, [
      connectorInstanceId,
      stream,
      recordId,
    ]);
    if (!current || current.deleted) {
      return { kind: "noop" };
    }

    const allocated = execReturningOne<VersionAllocationRow>(referenceQueries.recordsIngestAllocateNextVersion, [
      connectorId,
      connectorInstanceId,
      stream,
    ]);
    const nextVersion = allocated.max_version;

    maybeDeleteFault("after-version-allocation", { connectorId, connectorInstanceId, nextVersion, recordId, stream });

    exec(referenceQueries.recordsIngestMarkRecordDeleted, [now, nextVersion, connectorInstanceId, stream, recordId]);

    maybeDeleteFault("after-records-mutation", { connectorId, connectorInstanceId, nextVersion, recordId, stream });

    exec(referenceQueries.recordsIngestInsertRecordChangeDeleted, [
      connectorId,
      connectorInstanceId,
      stream,
      recordId,
      nextVersion,
      current.record_json,
      now,
      now,
    ]);

    maybeDeleteFault("after-record-changes-append", {
      connectorId,
      connectorInstanceId,
      nextVersion,
      recordId,
      stream,
    });

    const { prunedBytesForDelta, prunedRowsForDelta } = pruneRecordChangeHistory(
      connectorInstanceId,
      stream,
      nextVersion,
      changeHistoryLimit
    );
    applyDatasetSummaryRecordDelta({
      connectorId,
      consentTimeField: getManifestConsentTimeField(connectorId, stream),
      dirtyRecordTimeBounds: true,
      emittedAt: now,
      recordChangesJsonBytesDelta: byteLength(current.record_json) - prunedBytesForDelta,
      recordCountDelta: -1,
      recordJsonBytesDelta: -byteLength(current.record_json),
      stream,
    });
    applyRetainedSizeRecordDelta({
      connectorId,
      connectorInstanceId,
      currentRecordJsonBytesDelta: -byteLength(current.record_json),
      recordCountDelta: -1,
      recordHistoryCountDelta: 1 - prunedRowsForDelta,
      recordHistoryJsonBytesDelta: byteLength(current.record_json) - prunedBytesForDelta,
      stream,
    });

    return { kind: "changed" };
  });

  if (outcome.kind === "noop") {
    return 0;
  }

  // The durable delta (applied inside the committed transaction above) moved
  // this connection's count/stream evidence, so its maintained connector-summary
  // read model is now stale. Scoped marker (instance id known); best-effort and
  // a no-op until the read model is warmed, so it cannot fail the durable delete.
  await markConnectorSummaryEvidenceDirty({
    connectorInstanceId,
    reason: "record delete changed connection count/stream evidence",
  });

  // Derived index maintenance runs after the durable commit. Failures here
  // are not allowed to retroactively roll back the durable record mutation;
  // recovery is the search-index drift detector's job.
  await lexicalIndexDelete({ connectorId, connectorInstanceId, recordKey: recordId, stream });
  await semanticIndexDelete({ connectorId, connectorInstanceId, recordKey: recordId, stream });

  return 1;
}

export function listAllStreams(storageTarget: RecordStorageTarget) {
  if (isPostgresStorageBackend()) {
    return postgresListAllStreams(storageTarget);
  }

  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  // REVIEWED-BOUNDED: rows are one per (connector, stream) pair; a single
  // connector's manifest declares at most a few dozen streams, well under
  // the registry's @max_rows=256 cap on the records table read.
  const rows = allowUnboundedReadAcknowledged<StreamSummaryRow>(
    referenceQueries.recordsAggregateStreamsByConnectorInstance,
    [connectorId, connectorInstanceId]
  );

  return rows.map((row) => ({
    last_updated: row.last_updated || null,
    name: row.stream,
    object: "stream",
    record_count: row.record_count || 0,
  }));
}

/**
 * Delete all records for a connector+stream (owner-authenticated reference reset use)
 */
export function deleteAllRecords(
  storageTarget: RecordStorageTarget,
  stream: string,
  coordinatorOwnership?: ConnectorInstanceWriteOwnership
) {
  const coordinationConnectorId = connectorIdForStorageTarget(storageTarget);
  const coordinationInstanceId = resolveStorageConnectorInstanceId(storageTarget, coordinationConnectorId);
  return withConnectorInstanceWrite(
    coordinationInstanceId,
    () => deleteAllRecordsWithinCoordinator(storageTarget, stream),
    coordinatorOwnership
  );
}

/**
 * Advance `connector_instances.record_reset_generation` (SQLite) by the
 * count of distinct candidate streams that, BEFORE this reset's deletes run
 * in the SAME `writeTransaction`, have either a `version_counter` row or a
 * live (non-deleted) canonical record. Mirrors
 * `advancePostgresRecordResetGenerationForStreams` in `postgres-records.js`
 * — the union rule from design.md's "Exact reset-safe record checkpoint": a
 * stream whose counter was already lost still counts if it has live
 * records, so a subsequent reset+reinsertion can never reproduce the
 * earlier composite checkpoint. A no-op reset (neither input present for
 * any candidate) advances nothing. MUST be called before the tail deletes,
 * inside the caller's `writeTransaction`.
 * Spec: openspec/changes/reconcile-active-summary-evidence/design.md
 */
function advanceSqliteRecordResetGenerationForStreams(connectorInstanceId: string, streams: string[]): void {
  let touchedCount = 0;
  for (const stream of streams) {
    const hasCounter = Boolean(
      getOne(referenceQueries.recordsDeleteProbeVersionCounterRow, [connectorInstanceId, stream])
    );
    const hasLiveRecord =
      !hasCounter &&
      Boolean(getOne(referenceQueries.recordsDeleteProbeLiveCanonicalRecord, [connectorInstanceId, stream]));
    if (hasCounter || hasLiveRecord) {
      touchedCount += 1;
    }
  }
  if (touchedCount === 0) {
    return;
  }
  exec(referenceQueries.recordsDeleteAdvanceRecordResetGeneration, [touchedCount, connectorInstanceId]);
}

async function deleteAllRecordsWithinCoordinator(storageTarget: RecordStorageTarget, stream: string) {
  if (isPostgresStorageBackend()) {
    const deletedRecordCount = await postgresDeleteAllRecords(storageTarget, stream);
    const connectorId = connectorIdForStorageTarget(storageTarget);
    const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
    if (deletedRecordCount > 0) {
      await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
      // Colocated with the retained-size delta: a bulk stream delete moved this
      // connection's count/stream evidence, so its maintained connector-summary
      // read model is now stale. Scoped marker (instance id known); best-effort.
      await markConnectorSummaryEvidenceDirty({
        connectorInstanceId,
        reason: "bulk stream record delete changed connection count/stream evidence",
      });
    }
    await lexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    await semanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    return deletedRecordCount;
  }

  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const countRow = getOne<CountRow>(referenceQueries.recordsDeleteCountRecordsByStream, [connectorInstanceId, stream]);
  const deletedRecordCount = countRow?.count || 0;
  writeTransaction(() => {
    advanceSqliteRecordResetGenerationForStreams(connectorInstanceId, [stream]);
    exec(referenceQueries.recordsDeleteDeleteRecordsByStream, [connectorInstanceId, stream]);
    exec(referenceQueries.recordsDeleteDeleteRecordChangesByStream, [connectorInstanceId, stream]);
    exec(referenceQueries.recordsDeleteDeleteVersionCounterByStream, [connectorInstanceId, stream]);
  });
  if (deletedRecordCount > 0) {
    markDatasetSummaryProjectionStale("bulk stream record delete bypassed exact dataset summary projection deltas");
    await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
    // Colocated with the retained-size delta: a bulk stream delete moved this
    // connection's count/stream evidence, so its maintained connector-summary
    // read model is now stale. Scoped marker (instance id known); best-effort.
    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId,
      reason: "bulk stream record delete changed connection count/stream evidence",
    });
  }
  await lexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
  await semanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
  return deletedRecordCount;
}

/**
 * Delete every persisted record for a connector across all of its streams.
 *
 * Invoked by the polyfill manifest reconciliation loop when it flips a
 * connector's persisted manifest fingerprint. Records emitted under the
 * prior-shape manifest are not safe to advertise as fresh data under the
 * new manifest's declarations, so we drop them and let the next real
 * connector run repopulate. See
 * openspec/changes/reconcile-invalidates-stale-records/.
 *
 * Returns the number of records deleted plus the list of stream names
 * that had records, so the caller can produce an informative log line.
 */
export async function deleteAllRecordsForConnector(connectorId: string) {
  if (typeof connectorId !== "string" || !connectorId) {
    return { deletedCount: 0, streams: [] };
  }
  const storageConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
  if (isPostgresStorageBackend()) {
    return postgresDeleteAllRecordsForConnector(storageConnectorId);
  }
  // Take exactly one instance fence at a time in stable id order.  The former
  // connector-wide transaction bypassed sibling instance coordination; this
  // keeps each instance's durable + derived teardown indivisible with respect
  // to direct/device writers without holding a lock for a second instance.
  const namespaceRows = allowUnboundedReadAcknowledged<StreamNamespaceRow>(
    referenceQueries.recordsDeleteListInstanceStreamsByConnector,
    [storageConnectorId, storageConnectorId]
  );
  const countRow = getOne<CountRow>(referenceQueries.recordsDeleteCountRecordsByConnector, [storageConnectorId]);
  const deletedCount = countRow?.count || 0;
  const streams = Array.from(new Set(namespaceRows.map((row) => row.stream)));
  const streamsByInstance = new Map<string, string[]>();
  for (const row of namespaceRows) {
    const entries = streamsByInstance.get(row.connector_instance_id) ?? [];
    entries.push(row.stream);
    streamsByInstance.set(row.connector_instance_id, entries);
  }
  await mapWithConcurrency([...streamsByInstance.keys()].sort(), 1, (connectorInstanceId) =>
    withConnectorInstanceWrite(connectorInstanceId, async () => {
      const instanceStreams = streamsByInstance.get(connectorInstanceId);
      if (!instanceStreams) {
        return;
      }
      writeTransaction(() => {
        advanceSqliteRecordResetGenerationForStreams(connectorInstanceId, instanceStreams);
        for (const stream of instanceStreams) {
          exec(referenceQueries.recordsDeleteDeleteRecordsByStream, [connectorInstanceId, stream]);
          exec(referenceQueries.recordsDeleteDeleteRecordChangesByStream, [connectorInstanceId, stream]);
          exec(referenceQueries.recordsDeleteDeleteVersionCounterByStream, [connectorInstanceId, stream]);
          exec(referenceQueries.recordsDeleteDeleteBlobBindingsByStream, [connectorInstanceId, stream]);
        }
      });
      await mapWithConcurrency(instanceStreams, 1, async (stream) => {
        await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
        await markConnectorSummaryEvidenceDirty({
          connectorInstanceId,
          reason: "bulk connector record delete changed connection count/stream evidence",
        });
        await lexicalIndexDeleteByConnectorStream({ connectorId: storageConnectorId, connectorInstanceId, stream });
        await semanticIndexDeleteByConnectorStream({ connectorId: storageConnectorId, connectorInstanceId, stream });
      });
    })
  );
  if (deletedCount > 0) {
    markDatasetSummaryProjectionStale("bulk connector record delete bypassed exact dataset summary projection deltas");
    await markRetainedSizeConnectionDirty({ connectorInstanceId: null });
  }

  return { deletedCount, streams };
}

// Postgres equivalent of `deleteAllRecordsForConnector`. The reconcile loop
// runs at every startup in Postgres deployments
// (`shouldAutoReconcilePolyfillManifests` defaults on for the postgres
// backend), so the connector-wide invalidation contract must reach Postgres
// records — not the empty/legacy rows in the SQLite shadow table — when the
// reference-fixture → polyfill fingerprint transition fires.
//
// Strategy: discover (connector_instance_id, stream) pairs from the
// authoritative postgres `records ∪ record_changes ∪ blob_bindings` set for
// this connector_id, count the live (deleted = FALSE) records to mirror the
// SQLite path's return-shape contract, then compose the per-stream
// `postgresDeleteAllRecords` helper once per pair (records, record_changes,
// version_counter, lexical/semantic search tables) and drop `blob_bindings`
// separately, mirroring the SQLite per-connector path's extra fourth delete
// vs. the per-stream owner-reset path.
async function postgresDeleteAllRecordsForConnector(connectorId: string) {
  // Union of (instance, stream) pairs across `records`, `record_changes`,
  // `blob_bindings`, AND `version_counter` so a stream that has only
  // history rows, only surviving blob bindings (records already pruned), or
  // ONLY a live version_counter row with zero live/history records is still
  // discovered. Sol P2.2: the union rule that governs
  // `advancePostgresRecordResetGenerationForStreams`'s CHECKPOINT semantics
  // is only correct if this DISCOVERY query surfaces every such pair in the
  // first place — a counter-only pair invisible here means the connector-
  // wide reset silently never resets its checkpoint or clears its counter.
  const pairsResult = await postgresQuery<StreamNamespaceRow>(
    `SELECT DISTINCT connector_instance_id, stream FROM (
       SELECT connector_instance_id, stream FROM records WHERE connector_id = $1
       UNION
       SELECT connector_instance_id, stream FROM record_changes WHERE connector_id = $1
       UNION
       SELECT connector_instance_id, stream FROM blob_bindings WHERE connector_id = $1
       UNION
       SELECT connector_instance_id, stream FROM version_counter WHERE connector_id = $1
     ) AS t
     ORDER BY connector_instance_id, stream`,
    [connectorId]
  );
  const namespaceRows = pairsResult.rows;
  const streams = Array.from(new Set(namespaceRows.map((row) => row.stream)));

  const countResult = await postgresQuery<CountRow>(
    `SELECT COUNT(*)::int AS count FROM records
       WHERE connector_id = $1 AND deleted = FALSE`,
    [connectorId]
  );
  const deletedCount = Number(countResult.rows[0]?.count || 0);

  const streamsByInstance = new Map<string, string[]>();
  for (const row of namespaceRows) {
    const entries = streamsByInstance.get(row.connector_instance_id) ?? [];
    entries.push(row.stream);
    streamsByInstance.set(row.connector_instance_id, entries);
  }
  await mapWithConcurrency([...streamsByInstance.keys()].sort(), 1, (connectorInstanceId) =>
    withConnectorInstanceWrite(connectorInstanceId, async () => {
      const storageTarget = { connector_id: connectorId, connector_instance_id: connectorInstanceId };
      const instanceStreams = streamsByInstance.get(connectorInstanceId);
      if (!instanceStreams) {
        return;
      }
      await mapWithConcurrency(instanceStreams, 1, async (stream) => {
        await postgresDeleteAllRecords(storageTarget, stream);
        await postgresQuery("DELETE FROM blob_bindings WHERE connector_instance_id = $1 AND stream = $2", [
          connectorInstanceId,
          stream,
        ]);
        await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
        // Parity with the SQLite arm above: a connector-wide record delete
        // changes this connection's count/stream evidence and must mark the
        // connector-summary evidence row dirty too, not just retained-size.
        // Missing this left Postgres deployments relying solely on
        // `classifyCandidate`'s checkpoint/count backstops to notice the
        // change (bounded staleness until the next full reconcile pass, not
        // permanent — but a real, avoidable honesty gap).
        await markConnectorSummaryEvidenceDirty({
          connectorInstanceId,
          reason: "bulk connector record delete changed connection count/stream evidence",
        });
        await lexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
        await semanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
      });
    })
  );

  if (deletedCount > 0) {
    // Postgres dashboard summary reads from the retained-size projection
    // (see `getRetainedSizeDatasetSummaryProjection` in server/index.js).
    // The SQLite `dataset_summary_projection` is unused in Postgres mode,
    // so only the retained-size projection is marked dirty here.
    await markRetainedSizeConnectionDirty({ connectorInstanceId: null });
  }

  return { deletedCount, streams };
}

/**
 * Records-side building blocks for the owner-agent connection-delete cascade
 * (`add-owner-connection-delete-contract`), keyed STRICTLY on a single
 * connector_instance_id. Unlike `deleteAllRecords` (one stream) and
 * `deleteAllRecordsForConnector` (connector-WIDE, across sibling connections),
 * these erase every stream for exactly one connection and NEVER widen to
 * connector_id — deleting one connection leaves sibling connections of the same
 * connector type fully intact (invariant I1).
 *
 * The cascade is split into three explicit phases so the STORE can run the
 * source-of-truth row deletes in the SAME transaction as its own row/schedule/
 * device cleanup — making the whole durable cascade atomic (invariant I8),
 * not two independently-committed transactions:
 *
 *   1. enumerateConnectionStreams(target)            — pre-commit bounded read
 *   2. deleteConnectionRecordRows{Sqlite,Postgres}() — the record-family DELETEs,
 *      run INSIDE the store's transaction (no transaction of their own)
 *   3. teardownConnectionSearchProjection(...)       — post-commit projection
 *      teardown + dirty markers
 *
 * What phase 2 erases (all by connector_instance_id):
 *   - records, record_changes, version_counter   (the record + history spine)
 *   - blob_bindings, blobs                        (this connection's blobs)
 *   - connector_attention_records                 (open attention for it)
 *
 * What these helpers do NOT touch: connector_instances row, connector_schedules,
 * controller_active_runs, device_source_instances, spine_events, grants. The
 * store owns the row + schedule + device back-ref (now in the SAME transaction);
 * controller_active_runs is never erased (an in-flight run is REFUSED, not
 * deleted); the audit spine + grants are deliberately preserved.
 *
 * Transactionality (invariant I8): phase 2's record-family deletes carry NO
 * transaction of their own. The store calls them inside its single
 * `writeTransaction` / `withPostgresTransaction`, alongside the schedule +
 * device back-ref + connector_instances row deletes, so the ENTIRE
 * source-of-truth cascade commits or rolls back as one unit. A failure anywhere
 * in the cascade — record purge OR schedule/device/row cleanup — leaves the
 * connection fully intact: row present, data present, schedule present.
 *
 * Phase 3 (search indices) is a REBUILDABLE projection of `records` (the SQLite
 * semantic path maintains a vec0 rowid sidecar that a flat by-instance DELETE
 * cannot tear down correctly), so it is torn down per-stream AFTER the durable
 * commit through the proven stream-scoped helpers. A phase-3 failure after the
 * commit leaves orphaned index rows pointing at gone records — a derived-cache
 * inconsistency (the records are gone, so a lookup returns nothing), recoverable
 * by reindex, NOT a data-integrity loss and NOT a reason to report the committed
 * source-of-truth delete as failed. The durable delete is already committed.
 */

/**
 * Domain-local store for the connection-delete stream enumeration read.
 *
 * Selected once via `isPostgresStorageBackend()`. Each adapter performs the
 * dialect-specific DISTINCT-stream read verbatim and returns RAW rows (each
 * carrying a `stream` field); the caller owns the `.map((row) => row.stream)`
 * shaping so the two adapters stay thin and dialect-only.
 */
function createConnectionStreamStore(): ConnectionStreamStore {
  if (isPostgresStorageBackend()) {
    return {
      async listInstanceStreams(connectorInstanceId: string): Promise<readonly ConnectionStreamRow[]> {
        const streamRows = await postgresQuery<ConnectionStreamRow>(
          "SELECT DISTINCT stream FROM records WHERE connector_instance_id = $1 ORDER BY stream ASC",
          [connectorInstanceId]
        );
        return streamRows.rows;
      },
    };
  }
  return {
    listInstanceStreams(connectorInstanceId: string): Promise<readonly ConnectionStreamRow[]> {
      return Promise.resolve(
        allowUnboundedReadAcknowledged<ConnectionStreamRow>(referenceQueries.recordsDeleteListStreamsByInstance, [
          connectorInstanceId,
        ])
      );
    },
  };
}

/**
 * Phase 1: enumerate the (instance) streams so the post-commit search teardown
 * knows which (instance, stream) pairs to clear. Backend-aware bounded read.
 * Returns `{ connectorId, connectorInstanceId, streams }`.
 */
export async function enumerateConnectionStreams(storageTarget: RecordStorageTarget) {
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const store = createConnectionStreamStore();
  const streamRows = await store.listInstanceStreams(connectorInstanceId);
  return { connectorId, connectorInstanceId, streams: streamRows.map((row) => row.stream) };
}

/**
 * Phase 2 (SQLite): erase the record-family + blobs + attention rows for one
 * connection. Runs INSIDE the caller's `writeTransaction` — it opens NO
 * transaction of its own, so it composes atomically with the store's schedule /
 * device / row deletes. Synchronous (better-sqlite3 idiom). Returns the deleted
 * record count.
 */
export function deleteConnectionRecordRowsSqlite(connectorInstanceId: string) {
  const countRow = getOne<CountRow>(referenceQueries.recordsDeleteCountRecordsByInstance, [connectorInstanceId]);
  const count = countRow?.count || 0;
  exec(referenceQueries.recordsDeleteDeleteRecordChangesByInstance, [connectorInstanceId]);
  exec(referenceQueries.recordsDeleteDeleteVersionCounterByInstance, [connectorInstanceId]);
  exec(referenceQueries.recordsDeleteDeleteBlobBindingsByInstance, [connectorInstanceId]);
  exec(referenceQueries.recordsDeleteDeleteBlobsByInstance, [connectorInstanceId]);
  exec(referenceQueries.recordsDeleteDeleteAttentionRecordsByInstance, [connectorInstanceId]);
  exec(referenceQueries.recordsDeleteDeleteRecordsByInstance, [connectorInstanceId]);
  return count;
}

/**
 * Phase 2 (Postgres): same as the SQLite arm, but binds against the explicit
 * transaction `client` the store opened, so the record-family deletes run in
 * the SAME BEGIN/COMMIT as the store's schedule / device / row deletes. Returns
 * the deleted record count.
 */
export async function deleteConnectionRecordRowsPostgres(client: PostgresClient, connectorInstanceId: string) {
  const countResult = await client.query<CountRow>(
    "SELECT COUNT(*)::int AS count FROM records WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  const count = Number(countResult.rows[0]?.count || 0);
  await client.query("DELETE FROM record_changes WHERE connector_instance_id = $1", [connectorInstanceId]);
  await client.query("DELETE FROM version_counter WHERE connector_instance_id = $1", [connectorInstanceId]);
  await client.query("DELETE FROM blob_bindings WHERE connector_instance_id = $1", [connectorInstanceId]);
  await client.query("DELETE FROM blobs WHERE connector_instance_id = $1", [connectorInstanceId]);
  await client.query("DELETE FROM connector_attention_records WHERE connector_instance_id = $1", [connectorInstanceId]);
  await client.query("DELETE FROM records WHERE connector_instance_id = $1", [connectorInstanceId]);
  return count;
}

/**
 * Phase 3: tear down the per-stream search-index projection AFTER the durable
 * cascade has committed, and mark the derived dashboard projections dirty. This
 * is a rebuildable derived-cache cleanup — it runs post-commit and its failure
 * does NOT mean the committed source-of-truth delete failed (see the cascade
 * doc above). Idempotent if a stream had no index.
 */
export async function teardownConnectionSearchProjection({
  connectorId,
  connectorInstanceId,
  streams,
  deletedRecordCount,
}: ConnectionTeardown) {
  await mapWithConcurrency([...streams], 1, async (stream) => {
    await lexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    await semanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
  });
  if (deletedRecordCount > 0) {
    if (!isPostgresStorageBackend()) {
      markDatasetSummaryProjectionStale("connection delete erased a connection's records across all streams");
    }
    await markRetainedSizeConnectionDirty({ connectorInstanceId: null });
  }
}

/**
 * List streams available under a grant, with record counts
 */
export async function listStreams(
  storageTarget: RecordStorageTarget,
  grant: ReadGrant,
  manifest: ReadManifest | null = null
): Promise<StreamListEntry[]> {
  // Authority is checked before either backend enumerates physical history.
  // A stale grant is a closed rejection, never an empty filtered list.
  assertGrantedManifestReadAuthority(manifest?.streams ? { streams: manifest.streams } : null, grant, null);
  if (isPostgresStorageBackend()) {
    return requireStreamList(await Reflect.apply(postgresListStreams, undefined, [storageTarget, grant, manifest]));
  }

  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const result: StreamListEntry[] = [];

  for (const sg of grant.streams) {
    const rows = iterate<StreamVisibleRow>(referenceQueries.recordsListStreamVisibleCandidates, [
      connectorInstanceId,
      sg.name,
    ]);
    const effective = buildEffectiveReadScope(sg, {});
    const manifestStream = manifest?.streams?.find((stream) => stream.name === sg.name);
    const consentTimeField = manifestStream?.consent_time_field || null;
    let visibleCount = 0;
    let lastUpdated: string | null = null;

    for (const row of rows) {
      const rawData = parseStoredRecordData(row.record_json);
      if (effective.timeRange && consentTimeField && !passesTimeRange(rawData, effective.timeRange, consentTimeField)) {
        continue;
      }
      if (effective.resources && !effective.resources.includes(row.record_key)) {
        continue;
      }
      visibleCount += 1;
      if (!lastUpdated || row.emitted_at > lastUpdated) {
        lastUpdated = row.emitted_at;
      }
    }

    result.push({
      last_updated: lastUpdated,
      name: sg.name,
      object: "stream",
      record_count: visibleCount,
    });
  }

  return result;
}

// ─── Multi-binding fan-in helpers ──────────────────────────────────────────
//
// Closes the deferred runtime work tracked under
// `openspec/changes/expose-connection-identity-on-public-read/tasks.md`
// Section 3 / 4 / 6. These helpers wrap the existing per-binding storage
// primitives (`queryRecords`, `getRecord`, `listStreams`, `aggregateRecords`,
// `getBlob`-style flows) with the canonical (connection_id, stream)
// addressing rule from the public read contract:
//
//   - omitted `connection_id` SHALL fan in across the granted connections;
//   - exactly one matching connection SHALL be auto-selected;
//   - record/blob identifier ambiguity SHALL raise the typed
//     `ambiguous_connection` error with `available_connections`.
//
// The helpers stay deliberately thin: they iterate the existing per-binding
// SQL paths and union results so the storage layer does not need a new
// query shape. A future tranche can push fan-in into the SQL itself for
// pagination performance.

function buildBindingStorageTarget(connectorId: string, connectorInstanceId: string): RecordStorageTarget {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

function requireSingleBinding(bindings: readonly ReadBinding[]): ReadBinding {
  const [binding] = bindings;
  if (!binding) {
    throw codedError("No active connection is available under this grant.", "connection_not_found");
  }
  return binding;
}

// Identity key for a meta warning: two warnings collapse iff their code, param,
// message, and structured detail all match. Shared by the merge/append helpers
// so their dedup semantics stay in lockstep.
function warningDedupKey(w: ReadWarning): string {
  return `${w.code}|${w.param || ""}|${w.message || ""}|${JSON.stringify(w.detail || null)}`;
}

function mergeMetaWarnings(
  target: RecordResponseMeta | null,
  incoming: RecordResponseMeta | null | undefined
): RecordResponseMeta | null {
  if (!incoming) {
    return target;
  }
  const next: RecordResponseMeta = { ...(target || {}) };
  if (Array.isArray(incoming.warnings) && incoming.warnings.length) {
    const seen = new Set();
    const merged: ReadWarning[] = [];
    for (const w of [...(next.warnings || []), ...incoming.warnings]) {
      if (!isRecordData(w)) {
        continue;
      }
      const key = warningDedupKey(w);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(w);
    }
    next.warnings = merged;
  }
  return next;
}

function appendUniqueWarning(meta: RecordResponseMeta | null, warning: ReadWarning): RecordResponseMeta {
  const next: RecordResponseMeta = { ...(meta || {}) };
  const existing = Array.isArray(next.warnings) ? next.warnings.filter(isRecordData) : [];
  const key = warningDedupKey(warning);
  for (const w of existing) {
    if (warningDedupKey(w) === key) {
      next.warnings = existing;
      return next;
    }
  }
  next.warnings = [...existing, warning];
  return next;
}

function ensureBindingsOrThrow(
  bindings: readonly ReadBinding[] | null | undefined,
  { connectorId, missingMessage }: { connectorId: string | undefined; missingMessage?: string }
): asserts bindings is readonly ReadBinding[] {
  if (!bindings || bindings.length === 0) {
    throw codedError(
      missingMessage || `No active connection is available for connector '${connectorId}'.`,
      "connection_not_found"
    );
  }
}

// Throw the structured `invalid_argument` error when a multi-binding fan-in
// caller passes `changes_since`. Per-binding version counters cannot be
// safely merged across connections.
function assertChangesSinceNotMultiBinding(requestParams: RequestParams, bindings: readonly ReadBinding[]): void {
  const changesSinceRaw = requestParams.changes_since;
  if (!(typeof changesSinceRaw === "string" && changesSinceRaw.length > 0)) {
    return;
  }
  const err: CodedReadError = Object.assign(
    new Error(
      "`changes_since` is not supported across multiple connections. Retry with `connection_id` to bind the cursor to a single connection."
    ),
    { code: "invalid_argument" }
  );
  err.param = "changes_since";
  err.retry_with = "connection_id";
  err.available_connections = bindings.map(projectReadBindingForWire).filter((binding) => binding !== null);
  throw err;
}

function projectReadBindingForWire(binding: ReadBinding) {
  return projectBindingForWire({
    connectorId: binding.connectorId,
    connectorInstanceId: binding.connectorInstanceId,
    displayName: binding.displayName ?? "",
  });
}

// Apply extra-warnings to a single-binding response in place. Used by both
// queryRecordsAcrossBindings and aggregateRecordsAcrossBindings when the
// binding list has exactly one entry.
function applyExtraWarningsToSingleResponse(
  response: { meta?: RecordResponseMeta },
  extraWarnings: ReadWarning[]
): void {
  if (!extraWarnings.length) {
    return;
  }
  let meta: RecordResponseMeta | null =
    response.meta && typeof response.meta === "object" && !Array.isArray(response.meta) ? { ...response.meta } : null;
  for (const w of extraWarnings) {
    meta = appendUniqueWarning(meta, w);
  }
  if (meta) {
    response.meta = meta;
  }
}

// Mutable accumulator for the multi-binding list fan-in.
interface FanInListAccumulator {
  countAllExact: boolean;
  countSum: number;
  hasMoreAny: boolean;
  meta: RecordResponseMeta | null;
  unioned: ResponseRecord[];
  windowAllPresent: boolean;
  windowBoundsAllPresent: boolean;
  windowEarliestMs: number | null;
  windowLatestMs: number | null;
  windowTotalSum: number;
}

// Context for the list fan-in fold — the per-request flags that do not change
// between bindings.
interface FanInListContext {
  requestedCount: string | null;
  requestedWindow: string | null;
}

// Fold one binding's list result into the fan-in accumulator. Mutates acc in
// place. The window merging rules mirror the count rules: all-or-omit, sum
// totals, global min/max for bounds — never emit a merged window if any
// binding omits it.
function foldListResult(acc: FanInListAccumulator, result: ListResponse, ctx: FanInListContext): void {
  if (Array.isArray(result.data)) {
    acc.unioned.push(...result.data);
  }
  if (result.has_more) {
    acc.hasMoreAny = true;
  }
  acc.meta = mergeMetaWarnings(acc.meta, result.meta);
  if (acc.countAllExact && ctx.requestedCount) {
    const c = result.meta?.count;
    if (c && c.kind === "exact" && Number.isFinite(Number(c.value))) {
      acc.countSum += Number(c.value);
    } else {
      acc.countAllExact = false;
    }
  }
  if (acc.windowAllPresent && ctx.requestedWindow) {
    foldListWindowResult(acc, result);
  }
}

// Fold the window portion of one binding result into the accumulator. Kept
// separate to keep foldListResult's complexity budget below the limit.
function foldListWindowResult(acc: FanInListAccumulator, result: ListResponse): void {
  const w = result.meta?.window;
  if (!(w && Number.isFinite(Number(w.total)))) {
    acc.windowAllPresent = false;
    return;
  }
  acc.windowTotalSum += Number(w.total);
  const { earliest_at: earliestAt, latest_at: latestAt } = w;
  if (typeof earliestAt === "string" && typeof latestAt === "string") {
    const e = new Date(earliestAt).getTime();
    const l = new Date(latestAt).getTime();
    if (Number.isNaN(e) || Number.isNaN(l)) {
      acc.windowBoundsAllPresent = false;
    } else {
      if (acc.windowEarliestMs === null || e < acc.windowEarliestMs) {
        acc.windowEarliestMs = e;
      }
      if (acc.windowLatestMs === null || l > acc.windowLatestMs) {
        acc.windowLatestMs = l;
      }
    }
  } else {
    acc.windowBoundsAllPresent = false;
  }
}

// Apply the accumulated count result to meta, using downgrade warnings when
// any binding could not produce an exact count.
function finalizeFanInListCount(
  acc: FanInListAccumulator,
  requestedCount: string | null,
  meta: RecordResponseMeta | null
): RecordResponseMeta | null {
  if (!requestedCount || requestedCount === "none") {
    return meta;
  }
  if (acc.countAllExact) {
    return { ...(meta || {}), count: { kind: "exact", value: acc.countSum } };
  }
  return appendUniqueWarning(meta, {
    code: CANONICAL_WARNING_CODES.COUNT_DOWNGRADED,
    message:
      "Requested count grade could not be produced as a single value across multiple connections. Retry with `connection_id` to receive an exact per-connection count.",
    param: "count",
  });
}

// Apply the accumulated window result to meta.
function finalizeFanInListWindow(
  acc: FanInListAccumulator,
  requestedWindow: string | null,
  meta: RecordResponseMeta | null
): RecordResponseMeta | null {
  if (!requestedWindow || requestedWindow === "none" || !acc.windowAllPresent) {
    return meta;
  }
  const mergedWindow: WindowMeta = { total: acc.windowTotalSum };
  if (acc.windowBoundsAllPresent && acc.windowEarliestMs !== null && acc.windowLatestMs !== null) {
    mergedWindow.earliest_at = new Date(acc.windowEarliestMs).toISOString();
    mergedWindow.latest_at = new Date(acc.windowLatestMs).toISOString();
  }
  return { ...(meta || {}), window: mergedWindow };
}

/**
 * Fan-in records list across multiple bindings under one grant.
 *
 * Returns a canonical list envelope whose `data` is the union of records
 * across the addressed bindings. Each record carries `connection_id`,
 * deprecated `connector_instance_id`, and `display_name` when known —
 * already wired by per-binding `queryRecords`.
 *
 * Cursor / count honesty under fan-in:
 *
 * - `changes_since` is NOT supported under multi-binding fan-in. The
 *   per-binding `next_changes_since` cursors are per-(connector_instance_id,
 *   stream) version counters, and merging them across bindings would either
 *   silently skip changes on the binding(s) whose counter lags or wrap
 *   numeric semantics in a base64 lexical comparison. We reject `changes_since`
 *   with a typed `invalid_argument` carrying recovery guidance (narrow the
 *   call with `connection_id`). Spec: P1 fix in
 *   `tmp/workstreams/fan-in-branch-owner-review-report.md`.
 *
 * - Per-binding `next_cursor` cannot be safely unioned today. When any
 *   binding has more pages, the response emits a structured
 *   `meta.warnings[{code:"partial_results"}]` so callers know that fan-in
 *   pagination is partial and they should narrow with `connection_id` to
 *   page exhaustively. `next_cursor` is intentionally omitted on the
 *   multi-binding envelope.
 *
 * - `meta.count` is summed across bindings only when every binding produced
 *   an `exact` count over the same shape; if any binding omits or downgrades
 *   it, the fan-in response drops `meta.count` and emits a
 *   `count_downgraded` warning. The previous behavior (carrying whichever
 *   binding's count ran last) is removed.
 */
export async function queryRecordsAcrossBindings(
  bindings: readonly ReadBinding[],
  stream: string,
  grant: ReadGrant,
  requestParams: RequestParams,
  manifest: ReadManifest | null,
  opts: FanInOptions = {}
): Promise<ListResponse> {
  assertManifestReadAuthority(manifest?.streams ? { streams: manifest.streams } : null, stream, { actor: "internal" });
  ensureBindingsOrThrow(bindings, {
    connectorId: bindings?.[0]?.connectorId,
    missingMessage: "No active connection is available under this grant.",
  });

  const extraWarnings = Array.isArray(opts.extraWarnings) ? opts.extraWarnings : [];

  if (bindings.length === 1) {
    const binding = requireSingleBinding(bindings);
    const single = await queryRecords(
      buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId),
      stream,
      grant,
      requestParams,
      manifest
    );
    applyExtraWarningsToSingleResponse(single, extraWarnings);
    return single;
  }

  // P1: reject `changes_since` under multi-binding fan-in. Per-binding
  // version counters cannot be combined into a single forward-progress
  // cursor without silently skipping changes on a lagging binding. The
  // caller must narrow with `connection_id` to get a sound cursor.
  assertChangesSinceNotMultiBinding(requestParams, bindings);

  // Drop request-time connection_id when fanning in across multiple bindings;
  // queryRecords would reject an unrelated id with connection_not_found, but
  // here we have already filtered the binding list per the grant + request.
  const perBindingParams = { ...requestParams };
  perBindingParams.connection_id = undefined;
  perBindingParams.connector_instance_id = undefined;

  const requestedCount = typeof requestParams.count === "string" ? requestParams.count : null;
  const requestedWindow = typeof requestParams.window === "string" ? requestParams.window : null;
  const ctx: FanInListContext = { requestedCount, requestedWindow };
  const acc: FanInListAccumulator = {
    countAllExact: !!requestedCount && requestedCount !== "none",
    countSum: 0,
    hasMoreAny: false,
    meta: null,
    unioned: [],
    windowAllPresent: !!requestedWindow && requestedWindow !== "none",
    windowBoundsAllPresent: true,
    windowEarliestMs: null,
    windowLatestMs: null,
    windowTotalSum: 0,
  };

  const results = await mapWithConcurrency(
    bindings,
    fanInReadConcurrency(opts),
    (binding) => {
      const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
      return queryRecords(target, stream, grant, perBindingParams, manifest);
    },
    fanInMapOptions(opts)
  );

  for (const result of results) {
    foldListResult(acc, result, ctx);
  }

  const response: ListResponse = {
    data: acc.unioned,
    has_more: acc.hasMoreAny,
    object: "list",
  };

  // P2: explicit structured warning when fan-in collapses pagination. We do
  // not emit `next_cursor` here because per-binding cursors cannot be
  // unioned today.
  let { meta } = acc;
  if (acc.hasMoreAny) {
    meta = appendUniqueWarning(meta, {
      code: CANONICAL_WARNING_CODES.PARTIAL_RESULTS,
      message:
        "has_more=true and next_cursor is not emitted under multi-connection fan-in. Retry with `connection_id` to page a single connection.",
      param: "connection_id",
    });
  }

  // P3: honest meta.count and meta.window under fan-in.
  meta = finalizeFanInListCount(acc, requestedCount, meta);
  meta = finalizeFanInListWindow(acc, requestedWindow, meta);

  // P3: resolver-supplied warnings (e.g. deprecated_alias_used) are
  // stripped from per-binding params for multi-binding fan-in, so they
  // would never appear on the response unless the route threads them
  // back in here.
  for (const w of extraWarnings) {
    meta = appendUniqueWarning(meta, w);
  }

  if (meta && Object.keys(meta).length) {
    response.meta = meta;
  }
  return response;
}

/**
 * Fan-in records detail across multiple bindings under one grant.
 *
 * Emits the typed `ambiguous_connection` error when the identifier resolves
 * to more than one binding. Returns the single record otherwise. Falls back
 * to a normal `not_found` when no binding holds the identifier.
 */
export async function getRecordAcrossBindings(
  bindings: readonly ReadBinding[],
  stream: string,
  recordId: string,
  grant: ReadGrant,
  manifest: ReadManifest | null,
  requestParams: RequestParams = {},
  opts: FanInOptions = {}
): Promise<ResponseRecord> {
  assertManifestReadAuthority(manifest?.streams ? { streams: manifest.streams } : null, stream, { actor: "internal" });
  ensureBindingsOrThrow(bindings, { connectorId: bindings?.[0]?.connectorId });

  const extraWarnings = Array.isArray(opts.extraWarnings) ? opts.extraWarnings : [];

  function applyExtraWarnings(record: ResponseRecord): ResponseRecord {
    if (!(record && extraWarnings.length)) {
      return record;
    }
    let meta: RecordResponseMeta | null =
      record.meta && typeof record.meta === "object" && !Array.isArray(record.meta) ? { ...record.meta } : null;
    for (const w of extraWarnings) {
      meta = appendUniqueWarning(meta, w);
    }
    if (meta) {
      record.meta = meta;
    }
    return record;
  }

  if (bindings.length === 1) {
    const single = await getRecord(
      buildBindingStorageTarget(
        requireSingleBinding(bindings).connectorId,
        requireSingleBinding(bindings).connectorInstanceId
      ),
      stream,
      recordId,
      grant,
      manifest,
      requestParams
    );
    return applyExtraWarnings(single);
  }

  const perBindingParams = { ...requestParams };
  perBindingParams.connection_id = undefined;
  perBindingParams.connector_instance_id = undefined;

  const bindingResults = await mapWithConcurrency(
    [...bindings],
    fanInReadConcurrency(opts),
    async (binding) => {
      const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
      try {
        const record = await getRecord(target, stream, recordId, grant, manifest, perBindingParams);
        return { binding, record } as { binding: ReadBinding; record: ResponseRecord };
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "not_found") {
          return null;
        }
        throw err;
      }
    },
    fanInMapOptions(opts)
  );
  const matches = bindingResults.filter((m): m is { binding: ReadBinding; record: ResponseRecord } => m !== null);

  if (matches.length === 0) {
    throw codedError("Record not found", "not_found");
  }
  if (matches.length === 1) {
    const [match] = matches;
    if (!match) {
      throw codedError("Record not found", "not_found");
    }
    return applyExtraWarnings(match.record);
  }
  const candidates = matches
    .map(({ binding }) => projectReadBindingForWire(binding))
    .filter((binding): binding is NonNullable<typeof binding> => binding !== null);
  throw new AmbiguousConnectionError(
    `Record '${recordId}' is present under more than one connection. Retry with \`connection_id\`.`,
    candidates
  );
}

export async function getRecordFieldWindowAcrossBindings(
  bindings: readonly ReadBinding[],
  stream: string,
  recordId: string,
  fieldPath: string,
  grant: ReadGrant,
  manifest: ReadManifest | null,
  requestParams: RequestParams = {},
  opts: FanInOptions = {}
): Promise<FieldWindowResponse> {
  assertManifestReadAuthority(manifest?.streams ? { streams: manifest.streams } : null, stream, { actor: "internal" });
  ensureBindingsOrThrow(bindings, {
    connectorId: bindings?.[0]?.connectorId,
    missingMessage: "No active connection is available under this grant.",
  });

  const extraWarnings = Array.isArray(opts.extraWarnings) ? opts.extraWarnings : [];
  function applyExtraWarnings(result: FieldWindowResponse): FieldWindowResponse {
    if (!(result && extraWarnings.length)) {
      return result;
    }
    const existing = Array.isArray(result.warnings) ? result.warnings : [];
    result.warnings = [...existing, ...extraWarnings];
    return result;
  }

  if (bindings.length === 1) {
    const binding = requireSingleBinding(bindings);
    const single = await getRecordFieldWindow(
      buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId),
      stream,
      recordId,
      fieldPath,
      grant,
      manifest,
      requestParams
    );
    return applyExtraWarnings(single);
  }

  const perBindingParams = { ...requestParams };
  perBindingParams.connection_id = undefined;
  perBindingParams.connector_instance_id = undefined;

  const bindingResults = await mapWithConcurrency(
    [...bindings],
    fanInReadConcurrency(opts),
    async (binding) => {
      const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
      try {
        const result = await Promise.resolve(
          getRecordFieldWindow(target, stream, recordId, fieldPath, grant, manifest, perBindingParams)
        );
        return { binding, result } as { binding: ReadBinding; result: FieldWindowResponse };
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "not_found") {
          return null;
        }
        throw err;
      }
    },
    fanInMapOptions(opts)
  );
  const matches = bindingResults.filter((m): m is { binding: ReadBinding; result: FieldWindowResponse } => m !== null);

  if (matches.length === 0) {
    throw fieldWindowError("not_found", "Record not found", 404);
  }
  if (matches.length === 1) {
    const [match] = matches;
    if (!match) {
      throw fieldWindowError("not_found", "Record not found", 404);
    }
    return applyExtraWarnings(match.result);
  }

  const candidates = matches
    .map(({ binding }) => projectReadBindingForWire(binding))
    .filter((binding): binding is NonNullable<typeof binding> => binding !== null);
  throw new AmbiguousConnectionError(
    `Record '${recordId}' is present under more than one connection. Retry with \`connection_id\`.`,
    candidates
  );
}

/**
 * Fan-in records aggregate across multiple bindings.
 *
 * The reference computes each binding with the same aggregate semantic floor
 * and only merges operations that are mathematically composable across
 * disjoint connection partitions.
 */
export async function aggregateRecordsAcrossBindings(
  bindings: readonly ReadBinding[],
  stream: string,
  grant: ReadGrant,
  requestParams: RequestParams,
  manifest: ReadManifest | null,
  opts: FanInOptions = {}
): Promise<AggregateResponse> {
  assertManifestReadAuthority(manifest?.streams ? { streams: manifest.streams } : null, stream, { actor: "internal" });
  ensureBindingsOrThrow(bindings, { connectorId: bindings?.[0]?.connectorId });

  const extraWarnings = Array.isArray(opts.extraWarnings) ? opts.extraWarnings : [];

  if (bindings.length === 1) {
    const binding = requireSingleBinding(bindings);
    const single = await aggregateRecords(
      buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId),
      stream,
      grant,
      requestParams,
      manifest
    );
    applyExtraWarningsToSingleResponse(single, extraWarnings);
    return single;
  }

  const perBindingParams = { ...requestParams };
  perBindingParams.connection_id = undefined;
  perBindingParams.connector_instance_id = undefined;

  // Exact count_distinct cannot be soundly merged from per-binding distinct
  // counts (summing would overcount values shared across connections). Rather
  // than silently return a wrong number, reject the cross-connection case and
  // tell the caller to scope with `connection_id`. This preserves the
  // semantic-floor contract: never diverge from the exact distinct meaning.
  if ((requestParams.metric || "") === "count_distinct") {
    throw invalidQueryError("count_distinct across multiple connections is not supported; scope with connection_id");
  }

  const isTimeBucket = typeof requestParams.group_by_time === "string" && requestParams.group_by_time.trim() !== "";
  const isScalarGroup = typeof requestParams.group_by === "string" && requestParams.group_by.trim() !== "";
  const metric = typeof requestParams.metric === "string" ? requestParams.metric : "count";
  const manifestStream = manifest?.streams?.find((entry) => entry.name === stream);
  const aggregateFieldSchema =
    typeof requestParams.field === "string" && manifestStream
      ? getFieldSchema(manifestStream, requestParams.field)
      : null;

  // Merge grouped buckets across disjoint bindings: counts in the same bucket
  // key are additive because each binding sees a disjoint record set.
  const acc: AggregateAccumulator = {
    bestComparable: null,
    filteredRecordCount: 0,
    mergedBuckets: new Map<string, AggregateGroup>(),
    mergedLimit: null,
    meta: null,
    responseShape: null,
    value: metric === "sum" || metric === "count" ? 0 : null,
  };
  const foldContext: AggregateFoldContext = {
    aggregateFieldSchema,
    isScalarGroup,
    isTimeBucket,
    metric: String(metric),
  };
  const results = await mapWithConcurrency(
    bindings,
    fanInReadConcurrency(opts),
    (binding) => {
      const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
      return aggregateRecords(target, stream, grant, perBindingParams, manifest);
    },
    fanInMapOptions(opts)
  );

  for (const result of results) {
    foldBindingAggregate(acc, result, foldContext);
  }
  for (const w of extraWarnings) {
    acc.meta = appendUniqueWarning(acc.meta, w);
  }
  return buildAggregateResponse(acc, requestParams, stream, metric, isScalarGroup, isTimeBucket);
}

// Assemble the final AggregateResponse from the completed accumulator. Separated
// from aggregateRecordsAcrossBindings to keep that function's complexity in budget.
function buildAggregateResponse(
  acc: AggregateAccumulator,
  requestParams: RequestParams,
  stream: string,
  metric: string,
  isScalarGroup: boolean,
  isTimeBucket: boolean
): AggregateResponse {
  const { value, filteredRecordCount, meta, mergedBuckets, mergedLimit } = acc;
  let { responseShape } = acc;
  responseShape ||= {
    approximate: false,
    field: typeof requestParams.field === "string" ? requestParams.field : null,
    granularity: typeof requestParams.granularity === "string" ? requestParams.granularity : null,
    group_by: typeof requestParams.group_by === "string" ? requestParams.group_by : null,
    group_by_time: typeof requestParams.group_by_time === "string" ? requestParams.group_by_time : null,
    metric: String(metric),
    time_zone: null,
  };
  const response: AggregateResponse = {
    approximate: responseShape.approximate,
    field: responseShape.field,
    filtered_record_count: filteredRecordCount,
    granularity: responseShape.granularity,
    group_by: responseShape.group_by,
    group_by_time: responseShape.group_by_time,
    metric: responseShape.metric,
    object: "aggregation",
    stream,
    time_zone: responseShape.time_zone,
  };
  if (isScalarGroup || isTimeBucket) {
    const groupedResponse: AggregateResponse = {
      ...response,
      groups: [...mergedBuckets.values()]
        .sort((left, right) => compareMergedBuckets(left, right, isScalarGroup))
        .slice(0, mergedLimit ?? undefined),
    };
    if (mergedLimit !== null) {
      groupedResponse.limit = mergedLimit;
    }
    if (meta && Object.keys(meta).length) {
      groupedResponse.meta = meta;
    }
    return groupedResponse;
  }
  response.value = value;
  if (meta && Object.keys(meta).length) {
    response.meta = meta;
  }
  return response;
}

/**
 * Fold one binding's aggregate `result` into the cross-binding accumulator `acc`.
 * Mutates `acc` in place: captures the response shape from the first result, sums
 * `filtered_record_count`, merges meta warnings, and combines the metric value —
 * additive for grouped buckets and sum/count, min/max-comparable otherwise.
 * `ctx` carries the per-request invariants (metric, group flags, field schema).
 */
function foldBindingAggregate(acc: AggregateAccumulator, result: AggregateResponse, ctx: AggregateFoldContext): void {
  const { metric, isScalarGroup, isTimeBucket, aggregateFieldSchema } = ctx;
  if (!acc.responseShape) {
    acc.responseShape = captureAggregateResponseShape(result);
  }
  acc.filteredRecordCount += Number(result.filtered_record_count || 0);
  acc.meta = mergeMetaWarnings(acc.meta, result.meta);
  if ((isScalarGroup || isTimeBucket) && Array.isArray(result.groups)) {
    mergeGroupedBuckets(acc, result);
    return;
  }
  if (metric === "sum" || metric === "count") {
    acc.value = Number(acc.value ?? 0) + Number(result.value ?? 0);
    return;
  }
  if (metric === "min" || metric === "max") {
    mergeComparableMetric(acc, result, metric, aggregateFieldSchema);
  }
}

// Snapshot the response envelope (metric/field/grouping/granularity/zone) from
// the first binding's result; subsequent bindings share the same shape.
function captureAggregateResponseShape(result: AggregateResponse): AggregateResponseShape {
  return {
    approximate: result.approximate === true,
    field: result.field ?? null,
    granularity: result.granularity ?? null,
    group_by: result.group_by ?? null,
    group_by_time: result.group_by_time ?? null,
    metric: result.metric,
    time_zone: result.time_zone ?? null,
  };
}

// Add a binding's grouped buckets into the accumulator; counts for the same key
// are additive across disjoint bindings.
function mergeGroupedBuckets(acc: AggregateAccumulator, result: AggregateResponse): void {
  acc.mergedLimit = result.limit ?? acc.mergedLimit;
  for (const bucket of result.groups ?? []) {
    const mapKey = JSON.stringify(bucket.key ?? null);
    const entry = acc.mergedBuckets.get(mapKey) || { count: 0, key: bucket.key ?? null };
    entry.count += Number(bucket.count || 0);
    acc.mergedBuckets.set(mapKey, entry);
  }
}

// Fold a min/max binding value into the running best-comparable, keeping the
// original (uncoerced) value that won.
function mergeComparableMetric(
  acc: AggregateAccumulator,
  result: AggregateResponse,
  metric: "min" | "max",
  aggregateFieldSchema: JsonSchema | null
): void {
  const comparable = coerceComparableValue(result.value, aggregateFieldSchema);
  if (comparable === null) {
    return;
  }
  const shouldReplace =
    acc.bestComparable === null ||
    (metric === "min" ? comparable < acc.bestComparable : comparable > acc.bestComparable);
  if (shouldReplace) {
    acc.bestComparable = comparable;
    acc.value = result.value ?? null;
  }
}

/**
 * Order merged fan-in buckets. Scalar `group_by` sorts by descending count with
 * a stable JSON-key tiebreak; time buckets sort ascending by key with nulls
 * last. Extracted from `aggregateRecordsAcrossBindings` to keep the merge/assembly
 * body flat.
 */
function compareMergedBuckets(left: AggregateGroup, right: AggregateGroup, isScalarGroup: boolean): number {
  if (isScalarGroup) {
    const countCmp = right.count - left.count;
    if (countCmp !== 0) {
      return countCmp;
    }
    return JSON.stringify(left.key).localeCompare(JSON.stringify(right.key));
  }
  if (left.key === null) {
    return right.key === null ? 0 : 1;
  }
  if (right.key === null) {
    return -1;
  }
  return JSON.stringify(left.key).localeCompare(JSON.stringify(right.key));
}

/**
 * Fan-in stream-list summaries across multiple bindings.
 *
 * Emits one entry per (stream, connection_id) so multi-connection
 * deployments can disambiguate. Single-binding deployments preserve the
 * pre-existing shape with `connection_id`/`display_name` populated from
 * the sole active binding.
 *
 * When the grant pins per-stream `connection_id`, those streams resolve
 * against the named binding(s) only; streams without the constraint fan
 * in across `defaultBindings`. The `resolveBindingsForStream` callback
 * lets the route adapter apply the same `(request connection_id, grant
 * per-stream connection_id)` rules per stream. When callers do not pass
 * a resolver, the helper falls back to using `defaultBindings` for every
 * stream (preserving the prior single-resolution behavior for callers
 * that do not need per-stream constraint accuracy).
 */
export async function listStreamsAcrossBindings(
  defaultBindings: readonly ReadBinding[],
  grant: ReadGrant,
  manifest: ReadManifest | null,
  opts: FanInOptions = {}
): Promise<StreamListEntry[]> {
  assertGrantedManifestReadAuthority(manifest, grant, null);
  ensureBindingsOrThrow(defaultBindings, { connectorId: defaultBindings?.[0]?.connectorId });

  const resolveBindingsForStream =
    typeof opts.resolveBindingsForStream === "function" ? opts.resolveBindingsForStream : null;

  const summaries: StreamListEntry[] = [];
  const grantStreams = Array.isArray(grant.streams) ? grant.streams : [];

  // When no per-stream resolver is wired, fall back to the prior shape:
  // iterate every (binding, stream-in-grant) pair once.
  if (!resolveBindingsForStream) {
    const perBindingResults = await mapWithConcurrency(
      defaultBindings,
      fanInReadConcurrency(opts),
      async (binding) => {
        const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
        const perBinding = await listStreams(target, grant, manifest);
        const wireBinding = projectReadBindingForWire(binding);
        return perBinding.map((summary) => {
          const decorated: StreamListEntry = { ...summary };
          if (wireBinding?.connection_id) {
            decorated.connection_id = wireBinding.connection_id;
            decorated.connector_instance_id = wireBinding.connection_id;
            const wireDisplayName = Reflect.get(wireBinding, "display_name");
            const displayName = typeof wireDisplayName === "string" ? wireDisplayName : null;
            if (displayName) {
              decorated.display_name = displayName;
            }
          }
          return decorated;
        });
      },
      fanInMapOptions(opts)
    );
    for (const perBinding of perBindingResults) {
      summaries.push(...perBinding);
    }
    return summaries;
  }

  // Per-stream resolver path: each stream's bindings honor its own
  // grant-scope `connection_id` constraint. Streams whose grant entry
  // pins different connections do not bleed each other's counts.
  const namedGrants = grantStreams.filter((sg) => sg?.name);
  const perStreamResults = await mapWithConcurrency(
    namedGrants,
    fanInReadConcurrency(opts),
    async (streamGrant) => {
      const bindingsForStream = await resolveBindingsForStream(streamGrant);
      if (!bindingsForStream || bindingsForStream.length === 0) {
        return [];
      }
      const singleStreamGrant = { ...grant, streams: [streamGrant] };
      const perBindingResults = await mapWithConcurrency(
        bindingsForStream,
        fanInReadConcurrency(opts),
        async (binding) => {
          const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
          const perBinding = await listStreams(target, singleStreamGrant, manifest);
          const wireBinding = projectReadBindingForWire(binding);
          return perBinding.map((summary) => {
            const decorated: StreamListEntry = { ...summary };
            if (wireBinding?.connection_id) {
              decorated.connection_id = wireBinding.connection_id;
              decorated.connector_instance_id = wireBinding.connection_id;
              const wireDisplayName = Reflect.get(wireBinding, "display_name");
              const displayName = typeof wireDisplayName === "string" ? wireDisplayName : null;
              if (displayName) {
                decorated.display_name = displayName;
              }
            }
            return decorated;
          });
        },
        fanInMapOptions(opts)
      );
      return perBindingResults.flat();
    },
    fanInMapOptions(opts)
  );
  for (const perStream of perStreamResults) {
    summaries.push(...perStream);
  }
  return summaries;
}

/**
 * Fan-in stream-detail summaries across multiple bindings.
 *
 * Returns a single stream view aggregating record counts and last_updated
 * across bindings, plus `available_connections` so callers can disambiguate
 * if they want to follow up with a `connection_id` filter.
 */
export async function getStreamDetailAcrossBindings(
  bindings: readonly ReadBinding[],
  streamName: string,
  grant: ReadGrant,
  manifest: ReadManifest | null,
  opts: FanInOptions = {}
) {
  assertManifestReadAuthority(manifest, streamName, { actor: "internal" });
  ensureBindingsOrThrow(bindings, { connectorId: bindings?.[0]?.connectorId });

  let recordCount = 0;
  let lastUpdated: string | null = null;
  const available: Array<{ connection_id: string; display_name?: string }> = [];
  const perBindingResults = await mapWithConcurrency(
    bindings,
    fanInReadConcurrency(opts),
    async (binding) => {
      const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
      const summaries = await listStreams(
        target,
        { streams: grant.streams.filter((s) => s.name === streamName) },
        manifest
      );
      const wire = projectReadBindingForWire(binding);
      return { summaries, wire };
    },
    fanInMapOptions(opts)
  );

  for (const { summaries, wire } of perBindingResults) {
    const summary = summaries.find((s) => s.name === streamName);
    if (summary) {
      recordCount += Number(summary.record_count || 0);
      if (!lastUpdated || (summary.last_updated && summary.last_updated > lastUpdated)) {
        lastUpdated = summary.last_updated || lastUpdated;
      }
    }
    if (wire) {
      available.push(wire);
    }
  }
  return {
    available_connections: available,
    last_updated: lastUpdated,
    name: streamName,
    object: "stream",
    record_count: recordCount,
  };
}

/**
 * Resolve the request's bindings for a public-read route.
 *
 * Returns `{ bindings, requestConnectionId, warnings }`. `bindings` carries
 * `{ connectorInstanceId, connectorId, displayName? }` entries the caller
 * should iterate. `warnings` contains the deprecated-alias warning when
 * the caller used `connector_instance_id` on the wire.
 *
 * Honors per-stream `grant.streams[].connection_id` when present; absent
 * constraint preserves cross-connection (fan-in) semantics.
 */
export async function resolveReadRequestBindings({
  ownerSubjectId,
  storageBinding,
  grant,
  requestParams,
  streamName,
  nativeProviderStorage = false,
}: ReadRequestBindingsArgs) {
  // Canonicalize the storage binding's connector_id at the shared admission
  // boundary. A grant or owner storage binding may still carry the legacy
  // URL-shaped connector id (e.g. https://registry.pdpp.dev/connectors/gmail);
  // connector_instances and records are keyed by the canonical key (`gmail`),
  // so listActiveByConnector must look up under that same canonical key or it
  // returns zero rows and the read fails connection_not_found. This mirrors
  // getConnectorManifestRow, which already accepts the URL alias at the
  // boundary and resolves canonically. See canonicalize-connector-keys
  // Decision 1: storage bindings and grants key by connector_key.
  const rawConnectorId = storageBinding?.connector_id || null;
  const connectorId = rawConnectorId ? (canonicalConnectorKey(rawConnectorId) ?? rawConnectorId) : null;
  if (nativeProviderStorage && connectorId) {
    const { connectionId } = resolveRequestConnectionId(requestParams);
    if (connectionId) {
      const err: CodedReadError = Object.assign(
        new Error("connection_id is not applicable to provider_native sources."),
        {
          code: "invalid_argument",
        }
      );
      err.param =
        typeof requestParams.connection_id === "string" && requestParams.connection_id
          ? "connection_id"
          : "connector_instance_id";
      throw err;
    }
    return {
      bindings: [
        {
          connectorId,
          connectorInstanceId:
            storageBinding?.connector_instance_id ||
            makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId),
          displayName: null,
        },
      ],
      requestConnectionId: null,
      warnings: [],
    };
  }

  const connectorInstanceIdHint = storageBinding?.connector_instance_id || undefined;
  const streamGrant = grant.streams.find((s) => s.name === streamName);
  const grantStreamConnectionId = streamGrant?.connection_id || undefined;
  return await Reflect.apply(resolveRequestBindings, undefined, [
    {
      connectorId,
      connectorInstanceIdHint,
      grantStreamConnectionId,
      ownerSubjectId,
      requestParams,
    },
  ]);
}

/**
 * Get/put sync state (Collection Profile, owner-authenticated).
 *
 * Persistence is delegated to the production `ConnectorStateStore`; this
 * function preserves the legacy signature (string | { connector_id }
 * storage target, `allowedStreams` accepts Set/array/null) so existing
 * route handlers and the runtime caller don't change shape.
 */
export function getSyncState(storageTarget: RecordStorageTarget, opts: SyncStateOptions = {}) {
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const { grantId = null, allowedStreams = null } = opts;
  return getDefaultConnectorStateStore().getState({ connectorId, connectorInstanceId, grantId }, { allowedStreams });
}

export async function putSyncState(
  storageTarget: RecordStorageTarget,
  stateMap: Record<string, unknown>,
  opts: SyncStateOptions = {}
) {
  const connectorId = connectorIdForStorageTarget(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const { grantId = null, allowedStreams = null } = opts;
  const store = getDefaultConnectorStateStore();
  await store.putState({ connectorId, connectorInstanceId, grantId }, stateMap);
  return store.getState({ connectorId, connectorInstanceId, grantId }, { allowedStreams });
}

/**
 * Native capability inputs for the canonical `ref.dataset.summary` operation
 * (`reference-implementation/operations/ref-dataset-summary`). The operation
 * owns envelope assembly, `total_retained_bytes` derivation, top-connector
 * sort/limit, and the empty-corpus collapse rule; the helpers below are the
 * native dependency wiring the route hands in.
 *
 * Semantics preserved from the previous combined `getDatasetSummary`:
 * - `record_count`, `connector_count`, `stream_count`, and `record_json_bytes`
 *   count only live (non-soft-deleted) records — what normal reads would
 *   surface.
 * - `connector_count` is the legacy wire name for live configured
 *   connections (`connector_instance_id`); `stream_count` counts distinct
 *   `(connector_instance_id, stream)` observations in the live records table,
 *   not manifest-declared counts.
 * - `record_changes_json_bytes` sums the `record_changes` table — historical
 *   versions retained by design for change tracking. Included in
 *   `total_retained_bytes` because the substrate is honestly holding them.
 * - `blob_bytes` sums the whole `blobs` table (blobs are not soft-deleted).
 * - Byte fields use `LENGTH(CAST(... AS BLOB))` so multibyte JSON counts real
 *   bytes, not codepoints.
 * - `record_json_bytes` is an adapter-native operator diagnostic per
 *   `define-reference-operation-environments` contract correction (4); the
 *   operation preserves this and does not present it as a PDPP-stable metric.
 * - `earliest_record_time` / `latest_record_time` are real-world timestamps
 *   pulled from record payloads via each stream's manifest-declared
 *   `consent_time_field`. Streams without a `consent_time_field` don't
 *   contribute — only streams the manifest itself has named as temporally
 *   meaningful. All PDPP `consent_time_field`s observed in practice are
 *   ISO-lexicographically comparable strings (date or date-time), so the
 *   global min/max is honestly computed across connectors.
 * - `earliest_ingested_at` / `latest_ingested_at` are the substrate's own
 *   `emitted_at` bounds (when the runtime wrote the row). These are always
 *   available and useful for operator observability; they are *not* the real
 *   age of the data.
 */

/**
 * One-row aggregate over the live records substrate: counts and the
 * substrate's own ingest-time bounds. Coerces nullable / `BigInt`-shaped
 * SQLite outputs into the plain numbers the operation expects.
 */
export function getDatasetRecordsAggregate() {
  if (isPostgresStorageBackend()) {
    return postgresGetDatasetRecordsAggregate();
  }

  const recordAgg = getOne<DatasetAggregateRow>(referenceQueries.recordsDatasetGetRecordsAggregate);
  return {
    connector_count: Number(recordAgg?.connector_count || 0),
    earliest_ingested_at: typeof recordAgg?.earliest_ingested_at === "string" ? recordAgg.earliest_ingested_at : null,
    latest_ingested_at: typeof recordAgg?.latest_ingested_at === "string" ? recordAgg.latest_ingested_at : null,
    record_count: Number(recordAgg?.record_count || 0),
    record_json_bytes: Number(recordAgg?.record_json_bytes || 0),
    stream_count: Number(recordAgg?.stream_count || 0),
  };
}

/** Sum of `record_changes` JSON bytes (historical versions). */
export function getDatasetRecordChangesBytes() {
  if (isPostgresStorageBackend()) {
    return postgresGetDatasetRecordChangesBytes();
  }

  const changeAgg = getOne<DatasetBytesRow>(referenceQueries.recordsDatasetGetRecordChangesBytes);
  return Number(changeAgg?.record_changes_json_bytes || 0);
}

/** Sum of `blobs` table bytes. */
export function getDatasetBlobBytes() {
  if (isPostgresStorageBackend()) {
    return postgresGetDatasetBlobBytes();
  }

  const blobAgg = getOne<DatasetBytesRow>(referenceQueries.recordsDatasetGetBlobBytes);
  return Number(blobAgg?.blob_bytes || 0);
}

/**
 * Real-world record-time bounds across streams the manifest declares as
 * temporally meaningful (`consent_time_field`). Exposed so the
 * `ref.dataset.summary` operation's `getRecordTimeBounds` dependency can
 * call it on the native side.
 */
export function getDatasetRecordTimeBounds() {
  if (isPostgresStorageBackend()) {
    return postgresGetDatasetRecordTimeBounds();
  }

  return getRealWorldTimeBounds();
}

/**
 * Candidate connectors for the top-N slot. The underlying SQL already orders
 * by `record_count DESC, connector_id ASC`, but the operation reapplies the
 * sort and limit so both adapters cannot drift. We collect every row here
 * (the connector corpus is small — tens of entries at most, well under the
 * registry's bounded-row cap) and let the operation own the limit.
 */
export function listDatasetTopConnectorCandidates() {
  if (isPostgresStorageBackend()) {
    return postgresListDatasetTopConnectorCandidates();
  }

  const candidates: Array<{ connector_id: string; record_count: number }> = [];
  for (const row of iterate<DatasetConnectorRow>(referenceQueries.recordsDatasetGetTopConnectorsByRecordCount)) {
    candidates.push({
      connector_id: row.connector_id,
      record_count: Number(row.record_count || 0),
    });
  }
  return candidates;
}

export function listDatasetSummaryStreamProjectionSeeds() {
  if (isPostgresStorageBackend()) {
    return [];
  }

  const streamRows = getDb()
    .prepare(
      `SELECT connector_id,
              stream,
              COUNT(*) AS record_count,
              COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS record_json_bytes,
              MIN(emitted_at) AS earliest_ingested_at,
              MAX(emitted_at) AS latest_ingested_at,
              0 AS dirty_record_time_bounds
         FROM records
        WHERE deleted = 0
        GROUP BY connector_id, stream`
    )
    .all<SqliteDatasetProjectionRow>()
    .map(seedDatasetSummaryStreamProjection);
  return streamRows;
}

export function getDatasetSummaryStreamRecordTimeBounds(connectorId: string, stream: string, consentTimeField: string) {
  if (isPostgresStorageBackend()) {
    return { earliest: null, latest: null };
  }
  if (!SAFE_JSON_FIELD_NAME.test(consentTimeField || "")) {
    throw new Error("unsafe consent_time_field for dataset summary stream reconciliation");
  }

  const jsonPath = `$.${consentTimeField}`;
  const result = getOne<DatasetTimeBoundsRow>(referenceQueries.recordsDatasetGetStreamTimeBounds, [
    jsonPath,
    jsonPath,
    connectorId,
    stream,
  ]);
  return {
    earliest: typeof result?.min_time === "string" ? result.min_time : null,
    latest: typeof result?.max_time === "string" ? result.max_time : null,
  };
}

/**
 * Compute the real-world earliest/latest record timestamps across all streams
 * whose manifest declares a `consent_time_field`. Streams without that field
 * (workspace metadata, label dictionaries, etc.) don't contribute because the
 * manifest itself did not name them as temporally meaningful.
 *
 * This is O(streams_with_consent_time_field) queries — ~50 for the full
 * 10-connector corpus. Each query uses the existing
 * (connector_id, stream, record_key) index for the WHERE clause; the
 * `json_extract` MIN/MAX still scans rows, but only within one stream at a
 * time. Measured at ~210ms for the largest populated stream on a 772k-row DB.
 */
function recordTimeBoundsForManifest(
  connectorId: string,
  manifest: StoredManifest
): { earliest: string | null; latest: string | null } {
  let earliest: string | null = null;
  let latest: string | null = null;
  if (!Array.isArray(manifest.streams)) {
    return { earliest, latest };
  }
  for (const stream of manifest.streams) {
    const field = stream?.consent_time_field;
    const streamName = stream?.name;
    if (typeof field !== "string" || !field || typeof streamName !== "string" || !SAFE_JSON_FIELD_NAME.test(field)) {
      continue;
    }
    const result = getOne<DatasetTimeBoundsRow>(referenceQueries.recordsDatasetGetStreamTimeBounds, [
      `$.${field}`,
      `$.${field}`,
      connectorId,
      streamName,
    ]);
    if (!result) {
      continue;
    }
    const minTime = typeof result.min_time === "string" ? result.min_time : null;
    const maxTime = typeof result.max_time === "string" ? result.max_time : null;
    if (minTime && (earliest === null || minTime < earliest)) {
      earliest = minTime;
    }
    if (maxTime && (latest === null || maxTime > latest)) {
      latest = maxTime;
    }
  }
  return { earliest, latest };
}

function getRealWorldTimeBounds() {
  // REVIEWED-BOUNDED: rows are one per registered connector; the corpus is
  // tens of connectors at most, well under the registry's @max_rows=256
  // cap on the connectors table.
  const connectors = allowUnboundedReadAcknowledged<RegisteredConnectorRow>(referenceQueries.listRegisteredConnectors);

  let earliest: string | null = null;
  let latest: string | null = null;

  for (const row of connectors) {
    let manifest: StoredManifest;
    try {
      manifest = JSON.parse(row.manifest);
    } catch {
      continue;
    }
    const bounds = recordTimeBoundsForManifest(row.connector_id, manifest);
    const { earliest: boundsEarliest, latest: boundsLatest } = bounds;
    if (boundsEarliest && (earliest === null || boundsEarliest < earliest)) {
      earliest = boundsEarliest;
    }
    if (boundsLatest && (latest === null || boundsLatest > latest)) {
      latest = boundsLatest;
    }
  }

  return { earliest, latest };
}

function seedDatasetSummaryStreamProjection(row: SqliteDatasetProjectionRow) {
  const consentTimeField = getManifestConsentTimeField(row.connector_id, row.stream);
  const recordTimeBounds = consentTimeField
    ? getDatasetSummaryStreamRecordTimeBounds(row.connector_id, row.stream, consentTimeField)
    : { earliest: null, latest: null };
  return {
    connector_id: row.connector_id,
    consent_time_field: consentTimeField,
    dirty_record_time_bounds: 0,
    earliest_ingested_at: row.earliest_ingested_at || null,
    earliest_record_time: recordTimeBounds.earliest,
    latest_ingested_at: row.latest_ingested_at || null,
    latest_record_time: recordTimeBounds.latest,
    record_count: Number(row.record_count || 0),
    record_json_bytes: Number(row.record_json_bytes || 0),
    stream: row.stream,
  };
}

function getManifestConsentTimeField(connectorId: string, streamName: string): string | null {
  const row = getOne<ConnectorManifestRow>(referenceQueries.authConnectorsGetManifestById, [connectorId]);
  if (!row?.manifest) {
    return null;
  }

  let manifest: StoredManifest;
  try {
    manifest = JSON.parse(row.manifest);
  } catch {
    return null;
  }
  const stream = Array.isArray(manifest?.streams)
    ? manifest.streams.find((candidate) => candidate?.name === streamName)
    : null;
  const field = stream?.consent_time_field;
  if (typeof field !== "string" || !field) {
    return null;
  }
  return SAFE_JSON_FIELD_NAME.test(field) ? field : null;
}

// Below this, a numeric timestamp is treated as Unix SECONDS; at or above it, as
// Unix MILLISECONDS. 1e12 seconds is the year 33658 and 1e12 ms is 2001 — any
// real record date is unambiguous against this boundary. Mirrors the constant in
// packages/operator-ui/src/lib/search-record-timestamps.ts so ingest and search
// coerce timestamps identically.
const SEMANTIC_TIME_EPOCH_MS_THRESHOLD = 1e12;

// Coerce a manifest-declared timestamp field value to a clean ISO-8601 string,
// matching coerceTimestampValue in search-record-timestamps.ts: an ISO string
// passes through (trimmed); a positive finite NUMBER is a Unix epoch (seconds
// below the threshold, ms at/above) -> ISO. Anything else -> null so the caller
// falls back to emitted_at.
function coerceSemanticTimeValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value >= SEMANTIC_TIME_EPOCH_MS_THRESHOLD ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function firstSemanticTime(data: RecordData, fields: readonly unknown[]): string | null {
  for (const field of fields) {
    if (typeof field !== "string") {
      continue;
    }
    const coerced = coerceSemanticTimeValue(data[field]);
    if (coerced) {
      return coerced;
    }
  }
  return null;
}

// Compute the SEMANTIC time (when the thing happened) to stamp on a record at
// ingest. Resolves the stream's manifest consent_time_field (preferred) then
// cursor_field, reads that field from the record `data`, and coerces it
// epoch-aware. Falls back to `effectiveEmittedAt` when no semantic field is
// declared or the value is missing/unparseable — so semantic_time is never
// empty and the merged-timeline sort degrades gracefully to ingest order. Loads
// the manifest via the same query getManifestConsentTimeField uses.
function computeIngestSemanticTime(
  connectorId: string,
  streamName: string,
  data: unknown,
  effectiveEmittedAt: string,
  attemptStreamFacts: AttemptStreamFacts | null = null
): string {
  if (!isRecordData(data)) {
    return effectiveEmittedAt;
  }
  if (attemptStreamFacts) {
    return (
      firstSemanticTime(data, [attemptStreamFacts.consentTimeField, attemptStreamFacts.cursorField]) ??
      effectiveEmittedAt
    );
  }
  const row = getOne<ConnectorManifestRow>(referenceQueries.authConnectorsGetManifestById, [connectorId]);
  if (!row?.manifest) {
    return effectiveEmittedAt;
  }
  let manifest: StoredManifest;
  try {
    manifest = JSON.parse(row.manifest);
  } catch {
    return effectiveEmittedAt;
  }
  const stream = Array.isArray(manifest?.streams)
    ? manifest.streams.find((candidate) => candidate?.name === streamName)
    : null;
  if (!stream) {
    return effectiveEmittedAt;
  }
  // consent_time_field is the declared semantic/authored time; cursor_field is
  // the incremental sort field (often the same authored time). Prefer the former.
  const fields = [stream.consent_time_field, stream.cursor_field].filter(
    (field, index, candidates): field is string =>
      typeof field === "string" && field !== "" && candidates.indexOf(field) === index
  );
  return firstSemanticTime(data, fields) ?? effectiveEmittedAt;
}

// Registration changes can alter the manifest-derived sort facts of already
// accepted SQLite rows. SQLite deliberately stores only semantic_time (cursor
// and primary-key positions are derived from canonical record JSON at read
// time), so repair that persisted fact under the same instance fence used by
// every writer. This is version-free: a manifest evolution must not append a
// record change or emit a client notification.
export async function backfillSqliteRecordSemanticTimesForManifest(manifest: StoredManifest) {
  const connectorId =
    canonicalConnectorKey(manifest.connector_key || manifest.connector_id) ??
    manifest.connector_key ??
    manifest.connector_id;
  if (typeof connectorId !== "string" || !Array.isArray(manifest.streams)) {
    return { updated: 0 };
  }
  const streamFacts = manifest.streams.flatMap((stream) => {
    if (typeof stream?.name !== "string" || !stream.name) {
      return [];
    }
    return [
      {
        consentTimeField: typeof stream.consent_time_field === "string" ? stream.consent_time_field : null,
        cursorField: typeof stream.cursor_field === "string" ? stream.cursor_field : null,
        stream: stream.name,
      },
    ];
  });
  if (streamFacts.length === 0) {
    return { updated: 0 };
  }

  const instanceRows = getDb()
    .prepare(
      `SELECT DISTINCT connector_instance_id
       FROM records
      WHERE connector_id = ? AND stream IN (${streamFacts.map(() => "?").join(", ")})
      ORDER BY connector_instance_id`
    )
    .all(connectorId, ...streamFacts.map((entry) => entry.stream));
  let updated = 0;
  const connectorInstanceIds: string[] = instanceRows.map(
    (row: unknown) => (row as { connector_instance_id: string }).connector_instance_id
  );
  await mapWithConcurrency(connectorInstanceIds, 1, async (connectorInstanceId) => {
    await maybeSqliteRecordSortBackfillPhaseForTest("before-instance-fence", {
      connectorId,
      connectorInstanceId,
    });
    await withConnectorInstanceWrite(connectorInstanceId, async () => {
      await maybeSqliteRecordSortBackfillPhaseForTest("inside-instance-fence", {
        connectorId,
        connectorInstanceId,
      });
      for (const facts of streamFacts) {
        const rows = getDb()
          .prepare(
            `SELECT record_key, record_json, emitted_at, semantic_time
               FROM records
              WHERE connector_id = ? AND connector_instance_id = ? AND stream = ? AND deleted = 0`
          )
          .all(connectorId, connectorInstanceId, facts.stream);
        writeTransaction(() => {
          const update = getDb().prepare(
            `UPDATE records SET semantic_time = ?
                WHERE connector_instance_id = ? AND stream = ? AND record_key = ? AND deleted = 0`
          );
          for (const row of rows) {
            const data = JSON.parse((row as { record_json: string }).record_json);
            const emittedAt = (row as { emitted_at: string }).emitted_at;
            const semanticTime = computeIngestSemanticTime(connectorId, facts.stream, data, emittedAt, facts);
            const currentSemanticTime = (row as { semantic_time: string | null }).semantic_time;
            if (semanticTime === currentSemanticTime) {
              continue;
            }
            const recordKey = (row as { record_key: string }).record_key;
            update.run(semanticTime, connectorInstanceId, facts.stream, recordKey);
            updated += 1;
          }
        });
      }
    });
  });
  return { updated };
}

// Returns the manifest-declared primary_key field names for a stream, or null
// when the manifest/stream is unavailable. Mirrors getManifestConsentTimeField's
// load path so identity validation uses the same manifest source of truth.
function getManifestPrimaryKeyFields(connectorId: string, streamName: string): string[] | null {
  const row = getOne<ConnectorManifestRow>(referenceQueries.authConnectorsGetManifestById, [connectorId]);
  if (!row?.manifest) {
    return null;
  }

  let manifest: StoredManifest;
  try {
    manifest = JSON.parse(row.manifest);
  } catch {
    return null;
  }
  const stream = Array.isArray(manifest?.streams)
    ? manifest.streams.find((candidate) => candidate?.name === streamName)
    : null;
  const fields = normalizePrimaryKey(stream?.primary_key);
  return fields.length > 0 ? fields : null;
}

// Validate the record `key` tuple against manifest-declared primary-key fields,
// delegating to the shared assertRecordIdentity guard so SQLite and Postgres
// stores enforce identical identity rules.
function validateRecordIdentity({
  connectorId,
  stream,
  key,
  data,
}: {
  connectorId: string;
  data: unknown;
  key: unknown;
  stream: string;
}): void {
  const fields = getManifestPrimaryKeyFields(connectorId, stream) ?? [];
  assertRecordIdentity(fields, key, data);
}

// --- Cursor encoding ---

function encodeCursor(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function decodeCursor(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(str, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
