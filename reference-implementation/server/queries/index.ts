/**
 * Query registry.
 *
 * Every SQL string executed against the reference database lives in a
 * `.sql` artifact under this directory and is loaded into a frozen
 * registry at server startup. The registry is the only legitimate way
 * to obtain a `ReadQuery | MutationQuery | SmallEnumerationQuery`
 * branded handle; the bounded-statement wrapper at `lib/db.ts` accepts
 * only those handles and refuses raw SQL strings.
 *
 * Each `.sql` file declares its terminator and bound via a header of
 * `-- @key: value` lines preceding the statement:
 *
 *   -- @terminator: many               # one | many | iterate | exec | exec_one
 *   -- @cursor_field: rowid            # required for terminator=many|iterate
 *   -- @bounded_by: small_enumeration_table   # optional
 *   -- @table: connectors              # required if @bounded_by is set
 *   -- @max_rows: 256                  # required if @bounded_by is set
 *   SELECT … LIMIT ?                   # SQL follows
 *
 * Loader invariants (enforced at startup):
 *
 *   - Every artifact has a `@terminator` header.
 *   - terminator='many' artifacts: SQL contains `LIMIT ?` placeholder
 *     OR the artifact is annotated `@bounded_by: small_enumeration_table`
 *     with `@table` and `@max_rows`.
 *   - terminator='iterate' artifacts: have a `@cursor_field` header.
 *   - terminator='exec' artifacts: SQL begins with INSERT/UPDATE/DELETE/
 *     CREATE/ALTER/DROP/REPLACE.
 *   - terminator='exec_one' artifacts: SQL begins with a mutation keyword
 *     AND contains a `RETURNING` clause; executed via `execReturningOne`,
 *     which returns the single returned row.
 *   - Every artifact prepares cleanly against the live database.
 *   - Filenames map deterministically to keys (kebab-case → camelCase).
 *
 * Spec: openspec/changes/bound-spine-and-record-read-paths/specs/
 *       reference-implementation-architecture/spec.md
 *       Requirement: "Reference SQL wrapper SHALL make bounded reads explicit"
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getDb } from "../db.js";

const QUERIES_DIR = dirname(fileURLToPath(import.meta.url));
const SQL_FILE_SUFFIX = ".sql";
const CAMEL_CASE_PART_RE = /[^A-Za-z0-9]+/;
const TRAILING_SEMICOLON_RE = /;\s*$/;
const FRONTMATTER_LINE_RE = /^--\s*@([a-z_]+):\s*(.+?)\s*$/;
const LIMIT_PLACEHOLDER_RE = /\bLIMIT\s+\?/i;
const MUTATION_LEADING_KEYWORD_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i;
const RETURNING_CLAUSE_RE = /\bRETURNING\b/i;
const LINE_SEPARATOR_RE = /\r?\n/;

// Brand symbol — at runtime it's just a property; in TS it makes the
// query types incompatible with raw strings. Callers cannot construct
// these handles; only the loader produces them.
declare const QueryBrand: unique symbol;

interface Branded<TKind extends string> {
  readonly [QueryBrand]: TKind;
}

export interface QueryArtifactMetadata {
  /** Path relative to the queries directory, with `/` separators. */
  readonly file: string;
  /** Camel-cased registry key derived from the filename. */
  readonly key: string;
  /** Validated SQL with surrounding whitespace and trailing `;` stripped. */
  readonly sql: string;
}

/** Single-row read. SQL ends in `LIMIT 1` or selects on a unique key. */
export interface ReadOneQuery extends QueryArtifactMetadata, Branded<"read_one"> {
  readonly terminator: "one";
}

/** Bounded multi-row read. SQL contains `LIMIT ?` enforced by the wrapper. */
export interface ReadManyQuery extends QueryArtifactMetadata, Branded<"read_many"> {
  readonly cursorField: string;
  readonly terminator: "many";
}

/** Streaming read. Caller iterates and breaks; wrapper does not impose a cap. */
export interface IterateQuery extends QueryArtifactMetadata, Branded<"iterate"> {
  readonly cursorField: string;
  readonly terminator: "iterate";
}

/** Mutation. INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/DROP. */
export interface MutationQuery extends QueryArtifactMetadata, Branded<"mutation"> {
  readonly terminator: "exec";
}

/**
 * Mutation that returns a single row via SQL `RETURNING`. Used by atomic
 * operations whose post-mutation result must be observed in the same
 * statement that wrote it — e.g. `INSERT … ON CONFLICT … DO UPDATE …
 * RETURNING <col>` for atomic counter allocation. The wrapper at
 * `lib/db.ts` reads exactly one row via `execReturningOne`. The handle is
 * branded distinctly from `MutationQuery` and `ReadOneQuery` so static
 * SQL semantics are pinned at the call site.
 */
export interface MutationReturningOneQuery extends QueryArtifactMetadata, Branded<"mutation_returning_one"> {
  readonly terminator: "exec_one";
}

/** Whole-table scan of a table whose row count is bounded by domain. */
export interface SmallEnumerationQuery extends QueryArtifactMetadata, Branded<"small_enum"> {
  readonly boundedBy: "small_enumeration_table";
  readonly maxRows: number;
  readonly table: string;
  readonly terminator: "many";
}

export type RegisteredQuery =
  | ReadOneQuery
  | ReadManyQuery
  | IterateQuery
  | MutationQuery
  | MutationReturningOneQuery
  | SmallEnumerationQuery;

/**
 * The frozen registry. Keys are camel-cased filenames; values are
 * branded query handles. The wrapper at `lib/db.ts` accepts these
 * handles and refuses anything else.
 *
 * Specific keys are listed here for type-aware autocompletion at call
 * sites. The registry is also indexable as `referenceQueries[key]`
 * with the union type fallback for dynamic dispatch.
 */
export interface ReferenceQueryRegistry extends Readonly<Record<string, RegisteredQuery>> {
  // Approvals — `/_ref/approvals` projection.
  readonly approvalsListPendingConsents: SmallEnumerationQuery;
  readonly approvalsListPendingOwnerDevices: SmallEnumerationQuery;
  readonly authConnectorsGetManifestById: ReadOneQuery;
  readonly authConnectorsListIds: SmallEnumerationQuery;
  // Auth — connectors (manifest registry)
  readonly authConnectorsUpsert: MutationQuery;
  readonly authGrantsGetForIssuance: ReadOneQuery;
  readonly authGrantsGetForRevocation: ReadOneQuery;
  // Auth — grants
  readonly authGrantsInsert: MutationQuery;
  readonly authGrantsListActiveIdsByClientId: SmallEnumerationQuery;
  readonly authGrantsMarkConsumed: MutationQuery;
  readonly authGrantsMarkRevoked: MutationQuery;
  readonly authOauthClientsDeleteByClientId: MutationQuery;
  readonly authOauthClientsGetByClientId: ReadOneQuery;
  readonly authOauthClientsListByIssuerSubject: SmallEnumerationQuery;
  readonly authOauthClientsUpsert: MutationQuery;
  // Auth — oauth_authorization_codes (OAuth code + PKCE bridge)
  readonly authOauthAuthorizationCodesConsumeCode: MutationQuery;
  readonly authOauthAuthorizationCodesGetByCode: ReadOneQuery;
  readonly authOauthAuthorizationCodesGetByDeviceCode: ReadOneQuery;
  readonly authOauthAuthorizationCodesIssueForDeviceCode: MutationQuery;
  readonly authOauthAuthorizationCodesMarkExpiredByDeviceCode: MutationQuery;
  readonly authOauthAuthorizationCodesUpsertPending: MutationQuery;
  // Auth — oauth_refresh_tokens (hosted MCP durable OAuth sessions)
  readonly authOauthRefreshTokensGetByToken: ReadOneQuery;
  readonly authOauthRefreshTokensInsert: MutationQuery;
  readonly authOauthRefreshTokensMarkUsed: MutationQuery;
  readonly authOauthRefreshTokensRevokeByGrant: MutationQuery;
  // Auth — owner_device_auth (owner CLI device-flow authentication)
  readonly authOwnerDeviceAuthGetByApprovalId: ReadOneQuery;
  readonly authOwnerDeviceAuthGetByDeviceCode: ReadOneQuery;
  readonly authOwnerDeviceAuthGetByUserCode: ReadOneQuery;
  readonly authOwnerDeviceAuthInsert: MutationQuery;
  readonly authOwnerDeviceAuthMarkApproved: MutationQuery;
  readonly authOwnerDeviceAuthMarkDenied: MutationQuery;
  readonly authOwnerDeviceAuthMarkExpired: MutationQuery;
  readonly authOwnerDeviceAuthUpdateLastPolled: MutationQuery;
  readonly authPendingConsentsGetByApprovalId: ReadOneQuery;
  // Auth — pending_consents (device-flow staged consent records)
  readonly authPendingConsentsGetByDeviceCode: ReadOneQuery;
  readonly authPendingConsentsInsert: MutationQuery;
  readonly authPendingConsentsMarkApproved: MutationQuery;
  readonly authPendingConsentsMarkDenied: MutationQuery;
  readonly authPendingConsentsMarkExpired: MutationQuery;
  // Auth — tokens
  readonly authTokensCountActiveByClientId: ReadOneQuery;
  readonly authTokensGetIntrospection: ReadOneQuery;
  readonly authTokensInsertClient: MutationQuery;
  readonly authTokensInsertOwner: MutationQuery;
  readonly authTokensRevokeByClientId: MutationQuery;
  readonly authTokensRevokeByGrant: MutationQuery;
  readonly blobsGetRowById: ReadOneQuery;
  readonly blobsGetStoredById: ReadOneQuery;
  readonly blobsInsertBinding: MutationQuery;
  // Blobs — content-addressed blob persistence + binding maintenance.
  readonly blobsInsertBlob: MutationQuery;
  readonly blobsListBindingsById: ReadManyQuery;
  readonly connectorInstancesGetByBinding: ReadOneQuery;
  readonly connectorInstancesGetById: ReadOneQuery;
  readonly connectorInstancesInsert: MutationQuery;
  readonly connectorInstancesListActiveByOwnerConnector: ReadManyQuery;
  readonly connectorInstancesListByOwner: ReadManyQuery;
  readonly connectorInstancesUpdateDisplayName: MutationQuery;
  readonly connectorInstancesUpdateStatus: MutationQuery;
  readonly controllerDeleteActiveRun: MutationQuery;
  readonly controllerDeleteSchedule: MutationQuery;
  readonly controllerGetScheduleByConnector: ReadOneQuery;
  readonly controllerInsertSchedule: MutationQuery;
  // Controller — schedule + active-run persistence for runtime/controller.
  readonly controllerInsertSchedulerRunHistory: MutationQuery;
  readonly controllerListActiveRuns: SmallEnumerationQuery;
  readonly controllerListSchedulerLastRunTimes: SmallEnumerationQuery;
  readonly controllerListSchedulerRunHistory: ReadManyQuery;
  readonly controllerListSchedules: SmallEnumerationQuery;
  readonly controllerUpdateSchedule: MutationQuery;
  readonly controllerUpdateScheduleEnabled: MutationQuery;
  readonly controllerUpsertActiveRun: MutationQuery;
  readonly controllerUpsertSchedulerLastRunTime: MutationQuery;
  readonly deviceExportersConsumeEnrollmentCode: MutationQuery;
  readonly deviceExportersGetBatchOutcomeByBatch: ReadOneQuery;
  readonly deviceExportersGetCredentialByTokenHash: ReadOneQuery;
  readonly deviceExportersGetDevice: ReadOneQuery;
  readonly deviceExportersGetEnrollmentByCodeHash: ReadOneQuery;
  readonly deviceExportersGetSourceInstance: ReadOneQuery;
  readonly deviceExportersGetSourceInstanceByBinding: ReadOneQuery;
  readonly deviceExportersInsertBatchOutcome: MutationQuery;
  readonly deviceExportersInsertCredential: MutationQuery;
  readonly deviceExportersInsertDevice: MutationQuery;
  readonly deviceExportersInsertEnrollmentCode: MutationQuery;
  readonly deviceExportersListBatchOutcomes: ReadManyQuery;
  readonly deviceExportersListDevices: SmallEnumerationQuery;
  readonly deviceExportersListSourceInstanceHeartbeatsByConnector: SmallEnumerationQuery;
  readonly deviceExportersListSourceInstances: SmallEnumerationQuery;
  readonly deviceExportersMarkCredentialUsed: MutationQuery;
  readonly deviceExportersRevokeConnectorInstancesForDevice: MutationQuery;
  readonly deviceExportersRevokeCredentialsForDevice: MutationQuery;
  readonly deviceExportersRevokeDevice: MutationQuery;
  readonly deviceExportersRevokeEnrollmentCode: MutationQuery;
  readonly deviceExportersRevokeSourceInstancesForDevice: MutationQuery;
  readonly deviceExportersUpdateDeviceHeartbeat: MutationQuery;
  readonly deviceExportersUpdateSourceInstanceHeartbeat: MutationQuery;
  readonly deviceExportersUpsertSourceInstance: MutationQuery;
  // Grants — runtime hydration of persisted grant rows for grant-scoped
  // state lookups and similar runtime paths.
  readonly grantsGetScopedStateById: ReadOneQuery;
  readonly listRegisteredConnectors: SmallEnumerationQuery;
  // Records — streaming aggregate scan over a single (connector, stream).
  readonly recordsAggregateIterateStreamRecordsForAggregation: IterateQuery;
  // Records — per-connector stream aggregate for `/_ref/connectors`.
  readonly recordsAggregateStreamsByConnector: SmallEnumerationQuery;
  readonly recordsAggregateStreamsByConnectorInstance: SmallEnumerationQuery;
  readonly recordsDatasetGetBlobBytes: ReadOneQuery;
  readonly recordsDatasetGetRecordChangesBytes: ReadOneQuery;
  // Records — dataset summary for the operator console hero band.
  readonly recordsDatasetGetRecordsAggregate: ReadOneQuery;
  readonly recordsDatasetGetStreamTimeBounds: ReadOneQuery;
  readonly recordsDatasetGetTopConnectorsByRecordCount: IterateQuery;
  readonly recordsDeleteCountRecordsByConnector: ReadOneQuery;
  // Records — owner-driven deletion paths.
  readonly recordsDeleteCountRecordsByStream: ReadOneQuery;
  readonly recordsDeleteDeleteBlobBindingsByConnector: MutationQuery;
  readonly recordsDeleteDeleteRecordChangesByConnector: MutationQuery;
  readonly recordsDeleteDeleteRecordChangesByStream: MutationQuery;
  readonly recordsDeleteDeleteRecordsByConnector: MutationQuery;
  readonly recordsDeleteDeleteRecordsByStream: MutationQuery;
  readonly recordsDeleteDeleteVersionCounterByConnector: MutationQuery;
  readonly recordsDeleteDeleteVersionCounterByStream: MutationQuery;
  readonly recordsDeleteListDistinctStreamsByConnector: SmallEnumerationQuery;
  // Records — point-read for /v1/records/{id}.
  readonly recordsGetLiveRecordByKey: ReadOneQuery;
  readonly recordsGetRetainedByConnectorInstance: ReadOneQuery;
  // Records — ingest path: read/write of records, record_changes, version_counter.
  readonly recordsIngestAllocateNextVersion: MutationReturningOneQuery;
  readonly recordsIngestGetCurrentRecordState: ReadOneQuery;
  readonly recordsIngestGetVersionCounter: ReadOneQuery;
  readonly recordsIngestInsertRecordChangeDeleted: MutationQuery;
  readonly recordsIngestInsertRecordChangeUpsert: MutationQuery;
  readonly recordsIngestMarkRecordDeleted: MutationQuery;
  readonly recordsIngestPruneRecordChanges: MutationQuery;
  readonly recordsIngestUpsertRecord: MutationQuery;
  readonly recordsListStreamVisibleCandidates: IterateQuery;
  readonly recordsSnapshotsGetMinRecordChangeVersion: ReadOneQuery;
  // Records — change-log snapshot/page reads for /changes feed.
  readonly recordsSnapshotsGetSnapshotAtVersion: ReadOneQuery;
  readonly recordsSnapshotsListChangeGroups: IterateQuery;
  readonly recordsSyncStateListConnectorState: SmallEnumerationQuery;
  // Records — Collection Profile sync-state (owner-authenticated).
  readonly recordsSyncStateListGrantConnectorState: SmallEnumerationQuery;
  readonly recordsSyncStateUpsertConnectorState: MutationQuery;
  readonly recordsSyncStateUpsertGrantConnectorState: MutationQuery;
  readonly searchIndexCountByStream: ReadOneQuery;
  // Lexical retrieval — FTS5 index maintenance.
  readonly searchIndexDeleteByRecordKey: MutationQuery;
  readonly searchIndexDeleteByStream: MutationQuery;
  readonly searchIndexInsertRow: MutationQuery;
  readonly searchMetaDeleteByStream: MutationQuery;
  // Lexical retrieval — backfill drift detection metadata.
  readonly searchMetaExistsByStream: ReadOneQuery;
  readonly searchMetaGetFingerprintByStream: ReadOneQuery;
  readonly searchMetaListStreamsForConnector: SmallEnumerationQuery;
  readonly searchMetaUpsertFingerprint: MutationQuery;
  readonly searchRecordsCountIndexableTextValues: ReadOneQuery;
  readonly searchRecordsCountNonDeleted: ReadOneQuery;
  // Lexical retrieval — record paging for backfill scans + counts.
  readonly searchRecordsPageNonDeleted: ReadManyQuery;
  readonly searchSemanticBlobCountAll: ReadOneQuery;
  readonly searchSemanticBlobCountByScope: ReadOneQuery;
  readonly searchSemanticBlobDeleteByConnector: MutationQuery;
  readonly searchSemanticBlobDeleteByRecordAndStreamPrefix: MutationQuery;
  readonly searchSemanticBlobDeleteByScope: MutationQuery;
  readonly searchSemanticBlobDeleteByStreamPrefix: MutationQuery;
  readonly searchSemanticBlobListExistingKeysByStreamPrefix: ReadManyQuery;
  // Semantic retrieval — BLOB-flat vector store.
  readonly searchSemanticBlobUpsert: MutationQuery;
  readonly searchSemanticMetaDeleteAll: MutationQuery;
  readonly searchSemanticMetaDeleteByStream: MutationQuery;
  // Semantic retrieval — drift detection metadata.
  readonly searchSemanticMetaExistsByStream: ReadOneQuery;
  readonly searchSemanticMetaGetByStream: ReadOneQuery;
  readonly searchSemanticMetaListAllIdentities: SmallEnumerationQuery;
  readonly searchSemanticMetaListStreamsForConnector: SmallEnumerationQuery;
  readonly searchSemanticMetaUpsert: MutationQuery;
  readonly searchSemanticProgressDeleteAll: MutationQuery;
  readonly searchSemanticProgressDeleteByStream: MutationQuery;
  readonly searchSemanticProgressExistsAny: ReadOneQuery;
  readonly searchSemanticProgressGetByStream: ReadOneQuery;
  readonly searchSemanticProgressListStreamsForConnector: SmallEnumerationQuery;
  // Semantic retrieval — interrupted-rebuild progress tracking.
  readonly searchSemanticProgressUpsert: MutationQuery;
  readonly searchSemanticRecordsCountIndexableTextValues: ReadOneQuery;
  readonly searchSemanticRecordsCountNonDeleted: ReadOneQuery;
  readonly searchSemanticRecordsGetRecordByKey: ReadOneQuery;
  // Semantic retrieval — record paging for backfill scans + counts + lookups.
  readonly searchSemanticRecordsPageNonDeleted: ReadManyQuery;
  readonly searchSemanticRowidCountAll: ReadOneQuery;
  readonly searchSemanticRowidCountByScope: ReadOneQuery;
  readonly searchSemanticRowidDeleteAll: MutationQuery;
  readonly searchSemanticRowidDeleteByConnector: MutationQuery;
  readonly searchSemanticRowidDeleteByIdentity: MutationQuery;
  readonly searchSemanticRowidDeleteByScope: MutationQuery;
  readonly searchSemanticRowidDeleteByStreamPrefix: MutationQuery;
  readonly searchSemanticRowidGetRowidByIdentity: ReadOneQuery;
  readonly searchSemanticRowidInsert: MutationQuery;
  readonly searchSemanticRowidListExistingKeysByStreamPrefix: ReadManyQuery;
  readonly searchSemanticRowidPageByConnector: ReadManyQuery;
  // Semantic retrieval — sqlite-vec sidecar rowid mapping.
  readonly searchSemanticRowidPageByRecordAndStreamPrefix: ReadManyQuery;
  readonly searchSemanticRowidPageByScope: ReadManyQuery;
  readonly searchSemanticRowidPageByStreamPrefix: ReadManyQuery;
  readonly searchSemanticSnapshotsDeleteAll: MutationQuery;
  readonly searchSemanticSnapshotsGetById: ReadOneQuery;
  // Semantic retrieval — opaque-cursor snapshots.
  readonly searchSemanticSnapshotsInsert: MutationQuery;
  // Semantic retrieval — sqlite-vec virtual-table introspection.
  readonly searchSemanticVecGetTableSql: ReadOneQuery;
  readonly searchSnapshotsGetById: ReadOneQuery;
  // Lexical retrieval — opaque-cursor snapshots.
  readonly searchSnapshotsInsert: MutationQuery;
  // Source webhooks — replay/idempotency guard.
  readonly sourceWebhooksClaimEvent: MutationQuery;
  // Client event subscriptions (outbound, reference-only).
  readonly clientEventSubscriptionsInsertSubscription: MutationQuery;
  readonly clientEventSubscriptionsGetSubscriptionById: ReadOneQuery;
  readonly clientEventSubscriptionsListSubscriptionsByClient: SmallEnumerationQuery;
  readonly clientEventSubscriptionsListActiveSubscriptions: SmallEnumerationQuery;
  readonly clientEventSubscriptionsListSubscriptionsByGrant: SmallEnumerationQuery;
  readonly clientEventSubscriptionsUpdateStatus: MutationQuery;
  readonly clientEventSubscriptionsUpdateSecret: MutationQuery;
  readonly clientEventSubscriptionsDeleteSubscription: MutationQuery;
  readonly clientEventSubscriptionsInsertQueue: MutationQuery;
  readonly clientEventSubscriptionsClaimDueQueue: SmallEnumerationQuery;
  readonly clientEventSubscriptionsUpdateQueueAttempt: MutationQuery;
  readonly clientEventSubscriptionsDropQueuedForSubscription: MutationQuery;
  readonly clientEventSubscriptionsInsertAttempt: MutationQuery;
  readonly clientEventSubscriptionsListAttemptsForQueue: SmallEnumerationQuery;
  // Client event subscriptions — operator oversight reads (reference-only).
  readonly clientEventSubscriptionsListAllSubscriptions: SmallEnumerationQuery;
  readonly clientEventSubscriptionsGetSubscriptionSummary: ReadOneQuery;
  readonly clientEventSubscriptionsListAttemptsForSubscription: SmallEnumerationQuery;
  // Spine — controller-side terminal-event existence probe.
  readonly spineCheckRunTerminal: ReadOneQuery;
  readonly spineGetRunTerminalEvent: ReadOneQuery;
  // Spine — append and correlation search.
  readonly spineInsertEvent: MutationQuery;
  readonly spineListEventsByGrantId: ReadManyQuery;
  readonly spineListEventsByRunId: ReadManyQuery;
  readonly spineListEventsByTraceId: ReadManyQuery;
  readonly spineSearchFindGrantId: ReadOneQuery;
  readonly spineSearchFindRunId: ReadOneQuery;
  readonly spineSearchFindTraceId: ReadOneQuery;
  readonly spineSearchFindTraceIdByRequestId: ReadOneQuery;
  readonly spineSearchListGrantSummariesByLike: ReadManyQuery;
  readonly spineSearchListRunSummariesByLike: ReadManyQuery;
  readonly spineSearchListTraceSummariesByLike: ReadManyQuery;
  readonly webPushDeleteAllForTests: MutationQuery;
  readonly webPushGetByEndpoint: ReadOneQuery;
  readonly webPushListActiveSubscriptions: SmallEnumerationQuery;
  readonly webPushListSubscriptions: SmallEnumerationQuery;
  readonly webPushMarkFailure: MutationQuery;
  readonly webPushMarkSuccess: MutationQuery;
  readonly webPushRevokeSubscription: MutationQuery;
  readonly webPushUpsertSubscription: MutationQuery;
}

interface ParsedFrontmatter {
  readonly boundedBy: "small_enumeration_table" | null;
  readonly cursorField: string | null;
  readonly maxRows: number | null;
  readonly table: string | null;
  readonly terminator: "one" | "many" | "iterate" | "exec" | "exec_one";
}

function toCamelCase(value: string): string {
  return value
    .split(CAMEL_CASE_PART_RE)
    .filter(Boolean)
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join("");
}

function discoverSqlFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...discoverSqlFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(SQL_FILE_SUFFIX)) {
      files.push(path);
    }
  }
  return files;
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(TRAILING_SEMICOLON_RE, "").trim();
}

function assertSingleStatement(sql: string, file: string): void {
  if (stripTrailingSemicolon(sql).includes(";")) {
    throw new Error(`[queries] Query artifact must contain one statement: ${file}`);
  }
}

function splitFrontmatterAndBody(raw: string): {
  fm: Record<string, string>;
  body: string;
} {
  const lines = raw.split(LINE_SEPARATOR_RE);
  const fm: Record<string, string> = {};
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = line.match(FRONTMATTER_LINE_RE);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      fm[match[1]] = match[2];
      bodyStart = i + 1;
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("--")) {
      bodyStart = i + 1;
      continue;
    }
    break;
  }
  return { fm, body: lines.slice(bodyStart).join("\n") };
}

const VALID_TERMINATORS = new Set(["one", "many", "iterate", "exec", "exec_one"] as const);

function validateTerminator(value: string | undefined, file: string): ParsedFrontmatter["terminator"] {
  if (value !== undefined && (VALID_TERMINATORS as Set<string>).has(value)) {
    return value as ParsedFrontmatter["terminator"];
  }
  throw new Error(
    `[queries] ${file}: missing or invalid @terminator (got "${value ?? ""}"). Allowed: one | many | iterate | exec | exec_one.`
  );
}

function validateBoundedBy(value: string | null, file: string): "small_enumeration_table" | null {
  if (value === null || value === "small_enumeration_table") {
    return value;
  }
  throw new Error(`[queries] ${file}: invalid @bounded_by "${value}". Only "small_enumeration_table" is supported.`);
}

function validateMaxRows(value: string | undefined, file: string): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  throw new Error(`[queries] ${file}: @max_rows must be a positive integer (got "${value}").`);
}

/**
 * Splits a `.sql` file into a frontmatter object and the SQL body.
 * Frontmatter lines start with `-- @key:` and stop at the first
 * non-frontmatter line (blank line, comment without `@`, or SQL).
 */
function parseFrontmatter(raw: string, file: string): { frontmatter: ParsedFrontmatter; body: string } {
  const { fm, body } = splitFrontmatterAndBody(raw);
  const terminator = validateTerminator(fm.terminator, file);
  const cursorField = typeof fm.cursor_field === "string" && fm.cursor_field.length > 0 ? fm.cursor_field : null;
  const boundedBy = validateBoundedBy(fm.bounded_by ?? null, file);
  const table = typeof fm.table === "string" && fm.table.length > 0 ? fm.table : null;
  const maxRows = validateMaxRows(fm.max_rows, file);
  return {
    frontmatter: { terminator, cursorField, boundedBy, table, maxRows },
    body,
  };
}

function buildHandle(meta: QueryArtifactMetadata, fm: ParsedFrontmatter): RegisteredQuery {
  // Plain object keyed by terminator; the brand symbol field is at the
  // type level only and is erased at runtime, so the cast is safe.
  if (fm.terminator === "one") {
    return Object.freeze({ ...meta, terminator: "one" }) as ReadOneQuery;
  }

  if (fm.terminator === "iterate") {
    if (!fm.cursorField) {
      throw new Error(`[queries] ${meta.file}: terminator='iterate' requires @cursor_field.`);
    }
    return Object.freeze({
      ...meta,
      terminator: "iterate",
      cursorField: fm.cursorField,
    }) as IterateQuery;
  }

  if (fm.terminator === "exec") {
    if (!MUTATION_LEADING_KEYWORD_RE.test(meta.sql)) {
      throw new Error(
        `[queries] ${meta.file}: terminator='exec' but SQL does not begin with INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/DROP.`
      );
    }
    return Object.freeze({ ...meta, terminator: "exec" }) as MutationQuery;
  }

  if (fm.terminator === "exec_one") {
    if (!MUTATION_LEADING_KEYWORD_RE.test(meta.sql)) {
      throw new Error(
        `[queries] ${meta.file}: terminator='exec_one' but SQL does not begin with INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/DROP.`
      );
    }
    if (!RETURNING_CLAUSE_RE.test(meta.sql)) {
      throw new Error(
        `[queries] ${meta.file}: terminator='exec_one' requires a RETURNING clause; otherwise use terminator='exec'.`
      );
    }
    return Object.freeze({ ...meta, terminator: "exec_one" }) as MutationReturningOneQuery;
  }

  // terminator === 'many'
  if (fm.boundedBy === "small_enumeration_table") {
    if (!fm.table) {
      throw new Error(`[queries] ${meta.file}: @bounded_by=small_enumeration_table requires @table.`);
    }
    if (fm.maxRows === null) {
      throw new Error(`[queries] ${meta.file}: @bounded_by=small_enumeration_table requires @max_rows.`);
    }
    return Object.freeze({
      ...meta,
      terminator: "many",
      boundedBy: "small_enumeration_table",
      table: fm.table,
      maxRows: fm.maxRows,
    }) as SmallEnumerationQuery;
  }

  if (!LIMIT_PLACEHOLDER_RE.test(meta.sql)) {
    throw new Error(
      `[queries] ${meta.file}: terminator='many' SQL must contain a LIMIT ? placeholder OR be annotated @bounded_by: small_enumeration_table.`
    );
  }

  if (!fm.cursorField) {
    throw new Error(`[queries] ${meta.file}: terminator='many' requires @cursor_field.`);
  }

  return Object.freeze({
    ...meta,
    terminator: "many",
    cursorField: fm.cursorField,
  }) as ReadManyQuery;
}

export function loadReferenceQueries(queryDir = QUERIES_DIR): ReferenceQueryRegistry {
  const entries: Record<string, RegisteredQuery> = {};
  for (const file of discoverSqlFiles(queryDir)) {
    const relativeFile = relative(queryDir, file).split(sep).join("/");
    const key = toCamelCase(relativeFile.slice(0, -SQL_FILE_SUFFIX.length));
    if (!key) {
      throw new Error(`[queries] Query artifact has no stable key: ${relativeFile}`);
    }

    const raw = readFileSync(file, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw, relativeFile);
    const sql = stripTrailingSemicolon(body);
    if (!sql) {
      throw new Error(`[queries] Query artifact is empty: ${relativeFile}`);
    }
    assertSingleStatement(sql, relativeFile);

    if (entries[key]) {
      throw new Error(`[queries] Duplicate query key "${key}" from ${entries[key].file} and ${relativeFile}`);
    }

    const handle = buildHandle({ file: relativeFile, key, sql }, frontmatter);
    entries[key] = handle;
  }

  for (const requiredKey of [
    "listRegisteredConnectors",
    "spineListEventsByTraceId",
    "spineListEventsByGrantId",
    "spineListEventsByRunId",
    "spineGetRunTerminalEvent",
    // Auth — pending_consents
    "authPendingConsentsGetByDeviceCode",
    "authPendingConsentsGetByApprovalId",
    "authPendingConsentsInsert",
    "authPendingConsentsMarkApproved",
    "authPendingConsentsMarkDenied",
    "authPendingConsentsMarkExpired",
    // Auth — owner_device_auth
    "authOwnerDeviceAuthGetByDeviceCode",
    "authOwnerDeviceAuthGetByApprovalId",
    "authOwnerDeviceAuthGetByUserCode",
    "authOwnerDeviceAuthInsert",
    "authOwnerDeviceAuthMarkApproved",
    "authOwnerDeviceAuthMarkDenied",
    "authOwnerDeviceAuthMarkExpired",
    "authOwnerDeviceAuthUpdateLastPolled",
    // Auth — oauth_clients
    "authOauthClientsUpsert",
    "authOauthClientsGetByClientId",
    "authOauthClientsListByIssuerSubject",
    "authOauthClientsDeleteByClientId",
    // Auth — connectors
    "authConnectorsUpsert",
    "authConnectorsListIds",
    "authConnectorsGetManifestById",
    // Auth — grants
    "authGrantsInsert",
    "authGrantsGetForIssuance",
    "authGrantsMarkConsumed",
    "authGrantsGetForRevocation",
    "authGrantsMarkRevoked",
    "authGrantsListActiveIdsByClientId",
    // Auth — tokens
    "authTokensInsertClient",
    "authTokensInsertOwner",
    "authTokensCountActiveByClientId",
    "authTokensGetIntrospection",
    "authTokensRevokeByGrant",
    "authTokensRevokeByClientId",
    // Grants — runtime hydration of persisted grant rows.
    "grantsGetScopedStateById",
    // Blobs — content-addressed blob persistence + binding maintenance.
    "blobsInsertBlob",
    "blobsGetStoredById",
    "blobsInsertBinding",
    "blobsGetRowById",
    "blobsListBindingsById",
    // Approvals — `/_ref/approvals` projection.
    "approvalsListPendingConsents",
    "approvalsListPendingOwnerDevices",
    // Records — per-connector stream aggregate for `/_ref/connectors`.
    "recordsAggregateStreamsByConnector",
    "recordsAggregateStreamsByConnectorInstance",
    // Records — ingest path.
    "recordsIngestGetCurrentRecordState",
    "recordsIngestGetVersionCounter",
    "recordsIngestAllocateNextVersion",
    "recordsIngestMarkRecordDeleted",
    "recordsIngestInsertRecordChangeDeleted",
    "recordsIngestUpsertRecord",
    "recordsIngestInsertRecordChangeUpsert",
    "recordsIngestPruneRecordChanges",
    // Records — point reads.
    "recordsGetLiveRecordByKey",
    // Records — change-log snapshot/page.
    "recordsSnapshotsGetSnapshotAtVersion",
    "recordsSnapshotsGetMinRecordChangeVersion",
    "recordsSnapshotsListChangeGroups",
    // Records — deletion.
    "recordsDeleteCountRecordsByStream",
    "recordsDeleteDeleteRecordsByStream",
    "recordsDeleteDeleteRecordChangesByStream",
    "recordsDeleteDeleteVersionCounterByStream",
    "recordsDeleteListDistinctStreamsByConnector",
    "recordsDeleteCountRecordsByConnector",
    "recordsDeleteDeleteRecordsByConnector",
    "recordsDeleteDeleteRecordChangesByConnector",
    "recordsDeleteDeleteVersionCounterByConnector",
    "recordsDeleteDeleteBlobBindingsByConnector",
    // Records — Collection Profile sync-state.
    "recordsSyncStateListGrantConnectorState",
    "recordsSyncStateListConnectorState",
    "recordsSyncStateUpsertGrantConnectorState",
    "recordsSyncStateUpsertConnectorState",
    // Records — dataset summary.
    "recordsDatasetGetRecordsAggregate",
    "recordsDatasetGetRecordChangesBytes",
    "recordsDatasetGetBlobBytes",
    "recordsDatasetGetStreamTimeBounds",
    "recordsDatasetGetTopConnectorsByRecordCount",
    "recordsGetRetainedByConnectorInstance",
    "recordsListStreamVisibleCandidates",
    // Records — streaming aggregate.
    "recordsAggregateIterateStreamRecordsForAggregation",
    // Controller — schedule + active-run persistence.
    "controllerListActiveRuns",
    "controllerUpsertActiveRun",
    "controllerDeleteActiveRun",
    "controllerGetScheduleByConnector",
    "controllerListSchedules",
    "controllerInsertSchedule",
    "controllerUpdateSchedule",
    "controllerUpdateScheduleEnabled",
    "controllerDeleteSchedule",
    "controllerInsertSchedulerRunHistory",
    "controllerListSchedulerRunHistory",
    "controllerListSchedulerLastRunTimes",
    "controllerUpsertSchedulerLastRunTime",
    // Source webhooks — replay/idempotency guard.
    "sourceWebhooksClaimEvent",
    // Client event subscriptions (outbound, reference-only).
    "clientEventSubscriptionsInsertSubscription",
    "clientEventSubscriptionsGetSubscriptionById",
    "clientEventSubscriptionsListSubscriptionsByClient",
    "clientEventSubscriptionsListActiveSubscriptions",
    "clientEventSubscriptionsListSubscriptionsByGrant",
    "clientEventSubscriptionsUpdateStatus",
    "clientEventSubscriptionsUpdateSecret",
    "clientEventSubscriptionsDeleteSubscription",
    "clientEventSubscriptionsInsertQueue",
    "clientEventSubscriptionsClaimDueQueue",
    "clientEventSubscriptionsUpdateQueueAttempt",
    "clientEventSubscriptionsDropQueuedForSubscription",
    "clientEventSubscriptionsInsertAttempt",
    "clientEventSubscriptionsListAttemptsForQueue",
    // Client event subscriptions — operator oversight reads.
    "clientEventSubscriptionsListAllSubscriptions",
    "clientEventSubscriptionsGetSubscriptionSummary",
    "clientEventSubscriptionsListAttemptsForSubscription",
    // Spine — controller-side terminal-event existence probe.
    "spineCheckRunTerminal",
    "spineInsertEvent",
    "spineSearchFindTraceId",
    "spineSearchFindGrantId",
    "spineSearchFindRunId",
    "spineSearchFindTraceIdByRequestId",
    "spineSearchListTraceSummariesByLike",
    "spineSearchListGrantSummariesByLike",
    "spineSearchListRunSummariesByLike",
    // Lexical retrieval — FTS5 index maintenance.
    "searchIndexDeleteByRecordKey",
    "searchIndexInsertRow",
    "searchIndexDeleteByStream",
    "searchIndexCountByStream",
    // Lexical retrieval — backfill drift detection metadata.
    "searchMetaExistsByStream",
    "searchMetaDeleteByStream",
    "searchMetaGetFingerprintByStream",
    "searchMetaUpsertFingerprint",
    "searchMetaListStreamsForConnector",
    // Lexical retrieval — record paging for backfill scans + counts.
    "searchRecordsPageNonDeleted",
    "searchRecordsCountNonDeleted",
    "searchRecordsCountIndexableTextValues",
    // Lexical retrieval — opaque-cursor snapshots.
    "searchSnapshotsInsert",
    "searchSnapshotsGetById",
    // Semantic retrieval — BLOB-flat vector store.
    "searchSemanticBlobUpsert",
    "searchSemanticBlobDeleteByRecordAndStreamPrefix",
    "searchSemanticBlobDeleteByStreamPrefix",
    "searchSemanticBlobDeleteByScope",
    "searchSemanticBlobDeleteByConnector",
    "searchSemanticBlobCountAll",
    "searchSemanticBlobCountByScope",
    "searchSemanticBlobListExistingKeysByStreamPrefix",
    // Semantic retrieval — sqlite-vec virtual-table introspection.
    "searchSemanticVecGetTableSql",
    // Semantic retrieval — sqlite-vec sidecar rowid mapping.
    "searchSemanticRowidPageByRecordAndStreamPrefix",
    "searchSemanticRowidPageByStreamPrefix",
    "searchSemanticRowidPageByScope",
    "searchSemanticRowidPageByConnector",
    "searchSemanticRowidGetRowidByIdentity",
    "searchSemanticRowidInsert",
    "searchSemanticRowidDeleteByIdentity",
    "searchSemanticRowidDeleteByStreamPrefix",
    "searchSemanticRowidDeleteByScope",
    "searchSemanticRowidDeleteByConnector",
    "searchSemanticRowidDeleteAll",
    "searchSemanticRowidCountAll",
    "searchSemanticRowidCountByScope",
    "searchSemanticRowidListExistingKeysByStreamPrefix",
    // Semantic retrieval — drift detection metadata.
    "searchSemanticMetaExistsByStream",
    "searchSemanticMetaDeleteByStream",
    "searchSemanticMetaGetByStream",
    "searchSemanticMetaUpsert",
    "searchSemanticMetaListAllIdentities",
    "searchSemanticMetaListStreamsForConnector",
    "searchSemanticMetaDeleteAll",
    // Semantic retrieval — interrupted-rebuild progress tracking.
    "searchSemanticProgressUpsert",
    "searchSemanticProgressDeleteByStream",
    "searchSemanticProgressGetByStream",
    "searchSemanticProgressExistsAny",
    "searchSemanticProgressDeleteAll",
    "searchSemanticProgressListStreamsForConnector",
    // Semantic retrieval — record paging for backfill scans + counts + lookups.
    "searchSemanticRecordsPageNonDeleted",
    "searchSemanticRecordsCountNonDeleted",
    "searchSemanticRecordsCountIndexableTextValues",
    "searchSemanticRecordsGetRecordByKey",
    // Semantic retrieval — opaque-cursor snapshots.
    "searchSemanticSnapshotsInsert",
    "searchSemanticSnapshotsGetById",
    "searchSemanticSnapshotsDeleteAll",
  ]) {
    if (!entries[requiredKey]) {
      throw new Error(`[queries] Missing required query artifact: ${requiredKey}`);
    }
  }

  return Object.freeze(entries) as ReferenceQueryRegistry;
}

/**
 * Validate that every artifact in `registry` prepares cleanly against
 * the live database. Called from `initDb` after schema setup so the
 * server fails to bind on a malformed query rather than failing on the
 * first request.
 */
export function validateReferenceQueries(registry: ReferenceQueryRegistry = referenceQueries): void {
  const db = getDb();
  if (!db) {
    throw new Error("[queries] validateReferenceQueries called before initDb.");
  }
  for (const query of Object.values(registry)) {
    try {
      db.prepare(query.sql);
    } catch (cause) {
      throw new Error(`[queries] Failed to prepare ${query.key} (${query.file})`, {
        cause,
      });
    }
  }
}

export const referenceQueries = loadReferenceQueries();
