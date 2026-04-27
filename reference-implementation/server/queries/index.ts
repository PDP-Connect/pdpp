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
 *   -- @terminator: many               # one | many | iterate | exec
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
 *   - Every artifact prepares cleanly against the live database.
 *   - Filenames map deterministically to keys (kebab-case → camelCase).
 *
 * Spec: openspec/changes/bound-spine-and-record-read-paths/specs/
 *       reference-implementation-architecture/spec.md
 *       Requirement: "Reference RS read paths SHALL be bounded by construction"
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

/** Whole-table scan of a table whose row count is bounded by domain. */
export interface SmallEnumerationQuery extends QueryArtifactMetadata, Branded<"small_enum"> {
  readonly boundedBy: "small_enumeration_table";
  readonly maxRows: number;
  readonly table: string;
  readonly terminator: "many";
}

export type RegisteredQuery = ReadOneQuery | ReadManyQuery | IterateQuery | MutationQuery | SmallEnumerationQuery;

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
  readonly authGrantsMarkConsumed: MutationQuery;
  readonly authGrantsMarkRevoked: MutationQuery;
  readonly authOauthClientsGetByClientId: ReadOneQuery;
  // Auth — oauth_clients (registered OAuth clients)
  readonly authOauthClientsUpsert: MutationQuery;
  // Auth — owner_device_auth (owner CLI device-flow authentication)
  readonly authOwnerDeviceAuthGetByDeviceCode: ReadOneQuery;
  readonly authOwnerDeviceAuthGetByUserCode: ReadOneQuery;
  readonly authOwnerDeviceAuthInsert: MutationQuery;
  readonly authOwnerDeviceAuthMarkApproved: MutationQuery;
  readonly authOwnerDeviceAuthMarkDenied: MutationQuery;
  readonly authOwnerDeviceAuthMarkExpired: MutationQuery;
  readonly authOwnerDeviceAuthUpdateLastPolled: MutationQuery;
  // Auth — pending_consents (device-flow staged consent records)
  readonly authPendingConsentsGetByDeviceCode: ReadOneQuery;
  readonly authPendingConsentsInsert: MutationQuery;
  readonly authPendingConsentsMarkApproved: MutationQuery;
  readonly authPendingConsentsMarkDenied: MutationQuery;
  readonly authPendingConsentsMarkExpired: MutationQuery;
  readonly authTokensGetIntrospection: ReadOneQuery;
  // Auth — tokens
  readonly authTokensInsertClient: MutationQuery;
  readonly authTokensInsertOwner: MutationQuery;
  readonly authTokensRevokeByGrant: MutationQuery;
  readonly blobsGetStoredById: ReadOneQuery;
  readonly blobsInsertBinding: MutationQuery;
  // Blobs — content-addressed blob persistence + binding maintenance.
  readonly blobsInsertBlob: MutationQuery;
  readonly controllerDeleteActiveRun: MutationQuery;
  readonly controllerDeleteSchedule: MutationQuery;
  readonly controllerGetScheduleByConnector: ReadOneQuery;
  readonly controllerInsertSchedule: MutationQuery;
  // Controller — schedule + active-run persistence for runtime/controller.
  readonly controllerListActiveRuns: SmallEnumerationQuery;
  readonly controllerListSchedules: SmallEnumerationQuery;
  readonly controllerUpdateSchedule: MutationQuery;
  readonly controllerUpdateScheduleEnabled: MutationQuery;
  readonly controllerUpsertActiveRun: MutationQuery;
  // Grants — runtime hydration of persisted grant rows for grant-scoped
  // state lookups and similar runtime paths.
  readonly grantsGetScopedStateById: ReadOneQuery;
  readonly listRegisteredConnectors: SmallEnumerationQuery;
  // Records — streaming aggregate scan over a single (connector, stream).
  readonly recordsAggregateIterateStreamRecordsForAggregation: IterateQuery;
  // Records — per-connector stream aggregate for `/_ref/connectors`.
  readonly recordsAggregateStreamsByConnector: SmallEnumerationQuery;
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
  // Records — ingest path: read/write of records, record_changes, version_counter.
  readonly recordsIngestGetCurrentRecordState: ReadOneQuery;
  readonly recordsIngestGetVersionCounter: ReadOneQuery;
  readonly recordsIngestInsertRecordChangeDeleted: MutationQuery;
  readonly recordsIngestInsertRecordChangeUpsert: MutationQuery;
  readonly recordsIngestMarkRecordDeleted: MutationQuery;
  readonly recordsIngestPruneRecordChanges: MutationQuery;
  readonly recordsIngestUpsertRecord: MutationQuery;
  readonly recordsIngestUpsertVersionCounter: MutationQuery;
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
  // Spine — controller-side terminal-event existence probe.
  readonly spineCheckRunTerminal: ReadOneQuery;
  readonly spineGetRunTerminalEvent: ReadOneQuery;
  readonly spineListEventsByGrantId: ReadManyQuery;
  readonly spineListEventsByRunId: ReadManyQuery;
  readonly spineListEventsByTraceId: ReadManyQuery;
}

interface ParsedFrontmatter {
  readonly boundedBy: "small_enumeration_table" | null;
  readonly cursorField: string | null;
  readonly maxRows: number | null;
  readonly table: string | null;
  readonly terminator: "one" | "many" | "iterate" | "exec";
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

function validateTerminator(value: string | undefined, file: string): ParsedFrontmatter["terminator"] {
  if (value === "one" || value === "many" || value === "iterate" || value === "exec") {
    return value;
  }
  throw new Error(
    `[queries] ${file}: missing or invalid @terminator (got "${value ?? ""}"). Allowed: one | many | iterate | exec.`
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
    "authPendingConsentsInsert",
    "authPendingConsentsMarkApproved",
    "authPendingConsentsMarkDenied",
    "authPendingConsentsMarkExpired",
    // Auth — owner_device_auth
    "authOwnerDeviceAuthGetByDeviceCode",
    "authOwnerDeviceAuthGetByUserCode",
    "authOwnerDeviceAuthInsert",
    "authOwnerDeviceAuthMarkApproved",
    "authOwnerDeviceAuthMarkDenied",
    "authOwnerDeviceAuthMarkExpired",
    "authOwnerDeviceAuthUpdateLastPolled",
    // Auth — oauth_clients
    "authOauthClientsUpsert",
    "authOauthClientsGetByClientId",
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
    // Auth — tokens
    "authTokensInsertClient",
    "authTokensInsertOwner",
    "authTokensGetIntrospection",
    "authTokensRevokeByGrant",
    // Grants — runtime hydration of persisted grant rows.
    "grantsGetScopedStateById",
    // Blobs — content-addressed blob persistence + binding maintenance.
    "blobsInsertBlob",
    "blobsGetStoredById",
    "blobsInsertBinding",
    // Approvals — `/_ref/approvals` projection.
    "approvalsListPendingConsents",
    "approvalsListPendingOwnerDevices",
    // Records — per-connector stream aggregate for `/_ref/connectors`.
    "recordsAggregateStreamsByConnector",
    // Records — ingest path.
    "recordsIngestGetCurrentRecordState",
    "recordsIngestGetVersionCounter",
    "recordsIngestMarkRecordDeleted",
    "recordsIngestInsertRecordChangeDeleted",
    "recordsIngestUpsertRecord",
    "recordsIngestInsertRecordChangeUpsert",
    "recordsIngestUpsertVersionCounter",
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
    // Spine — controller-side terminal-event existence probe.
    "spineCheckRunTerminal",
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
