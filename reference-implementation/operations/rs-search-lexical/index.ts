/**
 * Canonical `rs.search.lexical` operation.
 *
 * Owns the public-contract slice of `GET /v1/search` and `/sandbox/v1/search`
 * independent of HTTP framework, sandbox UI, concrete database driver, the
 * native `server/search.js` helper module, and `process.env`. Both the native
 * Fastify route (via the `runLexicalSearch` shell in `server/search.js`) and
 * the sandbox Next route mount this operation; the host adapter still owns
 * auth, request id / trace id, instrumentation events, response writing, and
 * the host-shaped `url` envelope field.
 *
 * Boundary rules (see openspec/changes/mount-rs-search-lexical-operation):
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, the native
 *   `server/search.js` helper module, or `process` / `process.env`.
 * - Plan compilation, snapshot build, snapshot persistence, FTS5/ranking,
 *   manifest/grant resolution, advertisement source, and record-url
 *   formatting are delegated to capability dependencies. The operation does
 *   not look at adapter internals.
 * - Manifest, grant, advertisement, and snapshot bytes are operation inputs /
 *   dependency results. Hosts compute them and hand them in.
 *
 * What the operation owns (the host-independent public-contract slice):
 *   - strict v1 query-param allowlist (`q`, `limit`, `cursor`, `streams`,
 *     `streams[]`, `filter`); rejects unknown keys with `invalid_request`;
 *   - `q` non-empty required;
 *   - `limit` clamp (default 25, min 1, max 100);
 *   - `streams[]` normalization (string or array, trim, drop empty);
 *   - `filter[...]` requires exactly one `streams[]` value;
 *   - cross-stream advertisement gate (`cross_stream: false` ⇒ `streams[]`
 *     is required);
 *   - mode classification (owner vs client);
 *   - client-mode `streams[] ⊆ grant.streams` enforcement
 *     (`grant_stream_not_allowed`);
 *   - owner-mode soft `streams[]` filter (no error on unknown stream);
 *   - cursor encode/decode (base64url JSON `{snap, off}`);
 *   - snapshot orchestration (build & persist on a fresh request, load on a
 *     cursor request);
 *   - slice math (`offset`, `limit`, `has_more`, `next_cursor`);
 *   - score-advertisement gate (emit per-result `score` only when capability
 *     advertises bm25 lower-is-better);
 *   - `search_result` shaping; `record_url` is delegated to the host through
 *     a `formatRecordUrl` capability;
 *   - list-envelope shape (`object: 'list'`, `has_more`, `next_cursor?`,
 *     `data[]`); hosts add the host-shaped `url` field;
 *   - `disclosure.served` data block.
 */

// ─── Errors ────────────────────────────────────────────────────────────────

export type SearchLexicalErrorCode =
  | "invalid_request"
  | "invalid_argument"
  | "invalid_cursor"
  | "grant_stream_not_allowed"
  | "connection_not_found";

/**
 * Error thrown when the request itself is invalid in a host-independent way.
 * Hosts map `code` (and `param` where present) into their existing error
 * envelopes.
 */
export class SearchLexicalRequestError extends Error {
  readonly code: SearchLexicalErrorCode;
  readonly param?: string;

  constructor(code: SearchLexicalErrorCode, message: string, param?: string) {
    super(message);
    this.name = "SearchLexicalRequestError";
    this.code = code;
    if (param !== undefined) {
      this.param = param;
    }
  }
}

// ─── Public types ──────────────────────────────────────────────────────────

export type SearchLexicalActor =
  | { kind: "owner"; subject_id: string | null }
  | {
      kind: "client";
      subject_id: string | null;
      client_id: string | null;
      grant_id: string | null;
      /**
       * Already-resolved client grant. The operation reads `streams[].name`
       * for the `streams[] ⊆ grant.streams` enforcement.
       */
      grant: SearchLexicalGrant;
    };

export interface SearchLexicalManifestStream {
  name: string;
  [extra: string]: unknown;
}

export interface SearchLexicalManifest {
  streams?: SearchLexicalManifestStream[];
  [extra: string]: unknown;
}

export interface SearchLexicalGrantStream {
  name: string;
  fields?: string[];
  [extra: string]: unknown;
}

export interface SearchLexicalGrant {
  streams?: SearchLexicalGrantStream[];
  [extra: string]: unknown;
}

/**
 * Capability advertisement consumed by the operation. Mirrors the public
 * `capabilities.lexical_retrieval` shape published in RS metadata.
 */
export interface SearchLexicalAdvertisement {
  supported?: boolean;
  cross_stream?: boolean;
  snippets?: boolean;
  default_limit?: number;
  max_limit?: number;
  score?: {
    supported?: boolean;
    kind?: string;
    order?: string;
    value_semantics?: string;
  };
  [extra: string]: unknown;
}

/**
 * One per-connector plan entry. The shape is opaque to the operation; only
 * `streamName` and `searchableFields` are read for emptiness checks. Adapter
 * helpers (FTS5, fixture matcher) carry whatever extra fields they need
 * through the plan back into the snapshot builder.
 */
export interface SearchLexicalPlanEntry {
  streamName: string;
  searchableFields: string[];
  [extra: string]: unknown;
}

export interface SearchLexicalConnectorPlan {
  connectorId: string | null;
  manifest: SearchLexicalManifest;
  grant: SearchLexicalGrant;
  planEntries: SearchLexicalPlanEntry[];
}

/**
 * One snapshot result carrying the data needed to shape a `search_result`
 * envelope. `score` is the raw adapter score; the operation emits it only
 * when the advertisement gates score emission.
 */
export interface SearchLexicalSnapshotResult {
  connectorId: string;
  /**
   * Connection identifier (canonical) for the binding this hit came from.
   * Optional only because pre-identity snapshots may omit it; new snapshots
   * SHOULD always set it so the operation can emit `connection_id` and the
   * deprecated `connector_instance_id` alias on each result item.
   */
  connectorInstanceId?: string | null;
  /**
   * Owner-facing label for the connection. The operation emits this as
   * `display_name` on the result item only when the dependency resolved a
   * non-placeholder label without guessing. Snapshots that cannot pin a
   * label SHOULD omit this field rather than fabricate one.
   */
  displayName?: string | null;
  stream: string;
  recordKey: string;
  emittedAt: string;
  authoredAt?: string | null;
  matchedFields: string[];
  snippet?: { field: string; text: string } | null;
  score?: number;
  [extra: string]: unknown;
}

export interface SearchLexicalSnapshot {
  snapshot_id: string;
  query: string;
  results: SearchLexicalSnapshotResult[];
  [extra: string]: unknown;
}

/**
 * One owner-visible binding for cross-binding fan-in. `connectorInstanceId`
 * is the canonical connection identifier; `displayName` is the owner-facing
 * label (omitted when the runtime only has a placeholder).
 */
export interface SearchLexicalOwnerBinding {
  connectorId: string;
  connectorInstanceId: string;
  displayName?: string | null;
}

/**
 * One client-mode binding the grant resolves to under cross-binding fan-in.
 * Each entry pins one storage binding under the grant's connector_id. When
 * the grant authorizes more than one active connection the resolver returns
 * one entry per binding; the operation emits one connector plan per binding
 * so the snapshot's round-robin merge prevents any single binding from
 * dominating early pages.
 *
 * `manifest` carries the per-binding storage pin (the binding's
 * `connector_instance_id` baked into `storage_binding`). `displayName` is
 * surfaced through the snapshot builder for the per-hit `display_name`.
 */
export interface SearchLexicalClientBinding {
  manifest: SearchLexicalManifest;
  connectorInstanceId: string;
  displayName?: string | null;
}

export interface SearchLexicalDependencies {
  /**
   * Capability advertisement; controls cross-stream and score-emission gates.
   */
  getAdvertisement(): SearchLexicalAdvertisement | null;
  /**
   * Owner fan-out: list every connector id whose manifest the owner can read.
   *
   * Legacy single-binding-per-connector path. Hosts that support cross-
   * binding fan-in SHOULD additionally implement `listOwnerVisibleBindings`
   * below; when present, the operation uses it and ignores this method.
   */
  listOwnerVisibleConnectorIds(): Promise<string[]> | string[];
  /**
   * Owner cross-binding fan-out (optional): list every active owner-visible
   * binding (one entry per `(connector_id, connector_instance_id)`). When
   * provided, the operation emits one connector plan per binding so the
   * round-robin merge fans across bindings rather than picking a single
   * binding per connector.
   *
   * Spec: openspec/changes/expose-connection-identity-on-public-read/
   *       specs/reference-implementation-architecture/spec.md
   *       (#"Multi-connection list and search reads SHALL fan in by default")
   */
  listOwnerVisibleBindings?: () =>
    | Promise<SearchLexicalOwnerBinding[]>
    | SearchLexicalOwnerBinding[];
  /**
   * Owner fan-out helper: return the manifest for one connector, or null to
   * skip it (e.g. broken polyfill manifests).
   */
  resolveOwnerManifestForConnector(
    connectorId: string,
  ):
    | Promise<SearchLexicalManifest | null>
    | SearchLexicalManifest
    | null;
  /**
   * Owner cross-binding fan-out helper (optional): resolve the manifest for
   * one specific binding. Used in conjunction with
   * `listOwnerVisibleBindings`. When omitted, the operation falls back to
   * `resolveOwnerManifestForConnector(binding.connectorId)`.
   */
  resolveOwnerManifestForBinding?: (
    binding: SearchLexicalOwnerBinding,
  ) =>
    | Promise<SearchLexicalManifest | null>
    | SearchLexicalManifest
    | null;
  /**
   * Owner fan-out helper: build a synthetic owner read-grant covering every
   * stream of `manifest`. Adapter decides field-set semantics (typically
   * `fields = undefined ⇒ all fields authorized`).
   */
  buildOwnerReadGrantForManifest(
    manifest: SearchLexicalManifest,
  ): SearchLexicalGrant;
  /**
   * Client-mode helper: resolve the manifest the supplied client grant
   * applies against. Hosts build this from the bearer token information.
   *
   * Legacy single-binding path. Hosts that support cross-binding fan-in
   * SHOULD additionally implement `resolveClientBindings` below; when
   * present, the operation uses it and ignores this method.
   */
  resolveClientManifest(
    actor: { kind: "client"; grant: SearchLexicalGrant },
  ): Promise<SearchLexicalManifest> | SearchLexicalManifest;
  /**
   * Client cross-binding fan-out (optional): resolve the set of bindings the
   * grant authorizes. Each entry carries a manifest pinned to one binding
   * plus the binding's canonical `connection_id`. The operation emits one
   * connector plan per binding.
   *
   * Implementations MUST honor:
   *   - grant-scope per-stream `connection_id` constraints
   *     (`grant.streams[].connection_id`);
   *   - request-time `connection_id` / deprecated `connector_instance_id`
   *     alias narrowing;
   *   - exactly-one auto-select when only one binding is addressable.
   *
   * Throws `connection_not_found` (with `param: 'connection_id'`) when the
   * caller addresses a binding that is not active under the grant; throws
   * `invalid_argument` when the request mixes canonical and alias with
   * conflicting values.
   */
  resolveClientBindings?: (
    actor: { kind: "client"; grant: SearchLexicalGrant },
    request: { connectionId: string | null },
  ) =>
    | Promise<SearchLexicalClientBinding[]>
    | SearchLexicalClientBinding[];
  /**
   * Compile one connector's grant + manifest + request filter shape into a
   * plan. Implementations must enforce field-grant intersection and
   * stream-grant intersection — the operation does not look inside the plan
   * entries beyond `streamName` and `searchableFields`.
   *
   * `streamsFilter` is the normalized `streams[]` request value (null if
   * absent). `filter` and `filteredStream` are the request `filter[...]` and
   * the single `streams[]` value bound to it (if `filter` is present).
   */
  buildSearchPlanForGrant(args: {
    manifest: SearchLexicalManifest;
    grant: SearchLexicalGrant;
    streamsFilter: string[] | null;
    filter: unknown;
    filteredStream: string | null;
    connectorId: string | null;
  }): SearchLexicalPlanEntry[];
  /**
   * Build a snapshot of the fully-ranked result set for `(q, plans)`. The
   * adapter owns FTS5/ranking/snippet semantics; the operation only slices
   * the snapshot.
   */
  buildSnapshot(args: {
    q: string;
    perConnectorPlans: SearchLexicalConnectorPlan[];
    isOwner: boolean;
  }): Promise<SearchLexicalSnapshot> | SearchLexicalSnapshot;
  /**
   * Persist a freshly-built snapshot for cursor reuse.
   */
  persistSnapshot(snapshot: SearchLexicalSnapshot): Promise<void> | void;
  /**
   * Load a previously-persisted snapshot by id. Returns `null` if the
   * snapshot has expired or never existed.
   */
  loadSnapshot(
    snapshotId: string,
  ):
    | Promise<SearchLexicalSnapshot | null>
    | SearchLexicalSnapshot
    | null;
  /**
   * Format the public `record_url` for one search result. Hosts wire the
   * concrete implementation: native -> `/v1/streams/<stream>/records/<id>`
   * (with `?connector_id=` for owner mode); sandbox ->
   * `/sandbox/v1/streams/<stream>/records/<id>`.
   */
  formatRecordUrl(args: {
    stream: string;
    recordKey: string;
    connectorId: string;
    isOwner: boolean;
  }): string;
}

export interface SearchLexicalInput {
  actor: SearchLexicalActor;
  /**
   * Raw request query object. The operation runs the v1 allowlist and
   * normalization against this object. Hosts should pass the parsed
   * query-string object their framework produces (Fastify `req.query`,
   * URLSearchParams via Object.fromEntries, etc.) without normalizing
   * `streams[]`/`filter[...]` shapes — those are operation concerns.
   */
  query: Record<string, unknown>;
}

export interface SearchLexicalResultItem {
  object: "search_result";
  stream: string;
  record_key: string;
  connector_id: string;
  /**
   * Canonical connection identifier — present whenever the snapshot result
   * captured one. `connector_instance_id` mirrors the same value during the
   * deprecation window so clients can migrate without coordinated cutovers.
   */
  connection_id?: string;
  connector_instance_id?: string;
  /**
   * Owner-facing label for the connection. Emitted only when the snapshot
   * captured a non-placeholder label. Wire shape mirrors records-list and
   * records-detail so REST/MCP/dashboard/CLI consumers see identity in one
   * uniform form across read surfaces.
   */
  display_name?: string;
  record_url: string;
  emitted_at: string;
  authored_at?: string;
  matched_fields: string[];
  snippet?: { field: string; text: string };
  score?: { kind: "bm25"; value: number; order: "lower_is_better" };
}

/**
 * Structured warning shape used in `meta.warnings[]`. The canonical
 * `deprecated_alias_used` code is emitted whenever the request reached the
 * operation via the deprecated `connector_instance_id` query alias.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Public read warnings SHALL be structured")
 */
export interface SearchLexicalWarning {
  code: string;
  param?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

export interface SearchLexicalEnvelopeMeta {
  warnings?: SearchLexicalWarning[];
  [extra: string]: unknown;
}

export interface SearchLexicalEnvelope {
  object: "list";
  has_more: boolean;
  next_cursor?: string;
  data: SearchLexicalResultItem[];
  /** Optional canonical `meta` slot; only emitted when warnings are non-empty. */
  meta?: SearchLexicalEnvelopeMeta;
}

export interface SearchLexicalDisclosureData {
  query_shape: "search";
  record_count: number;
  has_more: boolean;
  mode: "owner" | "client";
  connector_count: number;
}

export interface SearchLexicalOutput {
  /**
   * List envelope minus the host-shaped `url` field. Hosts add
   * `url: '/v1/search'` (native) or `url: '/sandbox/v1/search'` (sandbox).
   */
  envelope: SearchLexicalEnvelope;
  /**
   * Pre-shaped `disclosure.served` data block. Hosts merge in `source` and
   * any host-only fields.
   */
  disclosureData: SearchLexicalDisclosureData;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Returns `true` when `err` is the per-stream schema-miss case from
 * `record-filters.js#compileRequestFilters` — specifically the
 * `'filter_field_not_in_schema'` code emitted when the filtered field does
 * not appear in this stream's manifest schema. Used in the owner-mode fan-out
 * paths to skip inapplicable connectors rather than failing the whole request
 * (matches intent `B4` of the intent-fulfillment audit).
 *
 * Hard filter errors (range not supported on this field type, range operator
 * not declared in the manifest, etc.) carry a different code and MUST NOT be
 * swallowed — they are user errors that should return 400 regardless of which
 * connector triggered them.
 */
function isInvalidQueryError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as Error & { code?: unknown }).code === "filter_field_not_in_schema"
  );
}

// `connection_id` is the canonical public connection identifier;
// `connector_instance_id` is the deprecated wire alias accepted during the
// migration window defined by
// `openspec/changes/expose-connection-identity-on-public-read`. Both are
// optional filters. When both are present they MUST carry the same value
// (alias-conflict validation runs after the allowlist check).
const ALLOWED_PARAMS: ReadonlySet<string> = new Set([
  "q",
  "limit",
  "cursor",
  "streams",
  "streams[]",
  "filter",
  "connection_id",
  "connector_instance_id",
]);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface NormalizedRequestParams {
  q: string;
  limit: number;
  cursor: string | null;
  streams: string[] | null;
  filter: unknown;
  filteredStream: string | null;
  /**
   * Structured warnings derived from the raw request shape (currently only
   * `deprecated_alias_used`). The operation surfaces them via the envelope's
   * canonical `meta.warnings[]` slot when non-empty.
   */
  warnings: SearchLexicalWarning[];
}

/**
 * Canonical warning code for deprecated-alias usage. Shared across the
 * three search operations so REST and MCP clients can detect alias
 * deprecation without parsing free-form messages.
 */
export const SEARCH_CONNECTION_ALIAS_DEPRECATED_WARNING_CODE = "deprecated_alias_used";

/**
 * Canonical warning code for a connector that the owner fan-out chose to
 * skip (broken manifest, empty searchable plan) instead of failing the
 * whole request. The wire shape mirrors
 * `connection-id-request.js#CANONICAL_WARNING_CODES.SOURCE_SKIPPED_NOT_APPLICABLE`
 * so REST, MCP, dashboard, and CLI all see the same identifier.
 */
export const SEARCH_SOURCE_SKIPPED_WARNING_CODE = "source_skipped_not_applicable";

/**
 * Canonical warning code for a `limit` that exceeded the advertised maximum
 * page size and was clamped. Mirrors the records-list `limit_clamped` code
 * (`connection-id-request.js#CANONICAL_WARNING_CODES.LIMIT_CLAMPED`) so REST,
 * MCP, dashboard, and CLI all see the same identifier across read surfaces.
 */
export const SEARCH_LIMIT_CLAMPED_WARNING_CODE = "limit_clamped";

function deriveSearchConnectionAliasWarnings(
  query: Record<string, unknown>,
): SearchLexicalWarning[] {
  const alias = query.connector_instance_id;
  if (typeof alias !== "string" || alias.length === 0) return [];
  return [
    {
      code: SEARCH_CONNECTION_ALIAS_DEPRECATED_WARNING_CODE,
      param: "connector_instance_id",
      message: "`connector_instance_id` is deprecated; send `connection_id` instead.",
    },
  ];
}

function clampLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Derive the structured `limit_clamped` warning for an over-max `limit`.
 *
 * Returns a single warning only when the raw `limit` parses to a finite
 * integer strictly greater than `MAX_LIMIT`. A non-positive, unparseable, or
 * absent `limit` falls back to the default page size (handled by `clampLimit`)
 * and is NOT a clamp — there is nothing to honestly report — so it emits no
 * warning. Exactly `MAX_LIMIT` is in-range and emits no warning. The wire shape
 * mirrors the records-list `limit_clamped` warning so a client reads one
 * identical structure across read surfaces.
 */
function deriveLimitClampedWarning(raw: unknown): SearchLexicalWarning[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const n = Number(raw);
  if (!Number.isFinite(n)) return [];
  const requested = Math.floor(n);
  if (requested <= MAX_LIMIT) return [];
  return [
    {
      code: SEARCH_LIMIT_CLAMPED_WARNING_CODE,
      param: "limit",
      detail: { requested_limit: requested, max_limit: MAX_LIMIT },
      message: `Requested limit=${requested} exceeds the maximum page size of ${MAX_LIMIT}; returned at most ${MAX_LIMIT} hits per page. Page forward with the returned cursor.`,
    },
  ];
}

function normalizeStreamsParam(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const arr = Array.isArray(raw) ? raw : [raw];
  const cleaned = arr
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Public-contract param parsing. Mirrors the previous `parseSearchParams`
 * helper inside `server/search.js`; the operation owns it now so both the
 * native dependency wiring and the sandbox host run the same allowlist and
 * coupling rules.
 */
export function parseSearchLexicalParams(
  query: Record<string, unknown>,
): NormalizedRequestParams {
  for (const key of Object.keys(query)) {
    if (!ALLOWED_PARAMS.has(key)) {
      throw new SearchLexicalRequestError(
        "invalid_request",
        `Unsupported query parameter: ${key}`,
        key,
      );
    }
  }
  const q = typeof query.q === "string" ? query.q : "";
  if (!q) {
    throw new SearchLexicalRequestError(
      "invalid_request",
      "q is required",
      "q",
    );
  }
  const limit = clampLimit(query.limit);
  const cursor =
    typeof query.cursor === "string" && query.cursor ? query.cursor : null;
  const streams = normalizeStreamsParam(query.streams ?? query["streams[]"]);
  const hasFilter = Object.prototype.hasOwnProperty.call(query, "filter");
  if (hasFilter && (!streams || streams.length !== 1)) {
    throw new SearchLexicalRequestError(
      "invalid_request",
      "filter[...] requires exactly one streams[] value (e.g. ?streams[]=messages&filter[received_at][gte]=...). filter[stream] and filter[connector_id] are not supported.",
      "streams",
    );
  }
  validateSearchConnectionAlias(query, SearchLexicalRequestError);
  return {
    q,
    limit,
    cursor,
    streams,
    filter: hasFilter ? query.filter : null,
    filteredStream: hasFilter && streams && streams.length > 0 ? streams[0]! : null,
    warnings: [
      ...deriveSearchConnectionAliasWarnings(query),
      ...deriveLimitClampedWarning(query.limit),
    ],
  };
}

/**
 * Shared alias-conflict check for search operations. `connection_id` is the
 * canonical public identifier; `connector_instance_id` is the deprecated wire
 * alias. Both MAY be sent but MUST carry the same opaque value. Mismatched
 * values are rejected with a typed `invalid_argument` error so clients learn
 * before shipping divergent identity assumptions.
 */
function validateSearchConnectionAlias(
  query: Record<string, unknown>,
  ErrorCtor: typeof SearchLexicalRequestError,
): void {
  const canonical = query.connection_id;
  const alias = query.connector_instance_id;
  const canonicalSet = typeof canonical === "string" && canonical.length > 0;
  const aliasSet = typeof alias === "string" && alias.length > 0;
  if (canonicalSet && aliasSet && canonical !== alias) {
    throw new ErrorCtor(
      "invalid_argument",
      "connection_id and connector_instance_id refer to the same connection. Send only `connection_id` (canonical) or supply matching values.",
      "connector_instance_id",
    );
  }
}

interface CursorPayload {
  snap: string;
  off: number;
}

/** Encode an opaque cursor pointing at offset `off` of snapshot `snap`. */
export function encodeSearchLexicalCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor. Returns `null` for malformed input. Hosts MUST
 * map `null` to `invalid_cursor`; we surface that mapping inside
 * `executeSearchLexical` so the cursor format stays internal to the
 * operation.
 */
export function decodeSearchLexicalCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<CursorPayload>;
    if (typeof parsed.snap !== "string" || typeof parsed.off !== "number") {
      return null;
    }
    return { snap: parsed.snap, off: parsed.off };
  } catch {
    return null;
  }
}

function advertisesScore(advertisement: SearchLexicalAdvertisement | null): boolean {
  return !!(
    advertisement
    && advertisement.supported !== false
    && advertisement.score?.supported === true
    && advertisement.score.kind === "bm25"
    && advertisement.score.order === "lower_is_better"
  );
}

function buildResultItem(
  hit: SearchLexicalSnapshotResult,
  isOwner: boolean,
  emitScore: boolean,
  formatRecordUrl: SearchLexicalDependencies["formatRecordUrl"],
): SearchLexicalResultItem {
  const item: SearchLexicalResultItem = {
    object: "search_result",
    stream: hit.stream,
    record_key: hit.recordKey,
    connector_id: hit.connectorId,
    record_url: formatRecordUrl({
      stream: hit.stream,
      recordKey: hit.recordKey,
      connectorId: hit.connectorId,
      isOwner,
    }),
    emitted_at: hit.emittedAt,
    matched_fields: hit.matchedFields,
  };
  if (typeof hit.authoredAt === "string" && hit.authoredAt.length > 0) {
    item.authored_at = hit.authoredAt;
  }
  if (typeof hit.connectorInstanceId === "string" && hit.connectorInstanceId.length > 0) {
    item.connection_id = hit.connectorInstanceId;
    item.connector_instance_id = hit.connectorInstanceId;
  }
  if (typeof hit.displayName === "string" && hit.displayName.length > 0) {
    item.display_name = hit.displayName;
  }
  if (hit.snippet) {
    item.snippet = hit.snippet;
  }
  if (emitScore && typeof hit.score === "number" && Number.isFinite(hit.score)) {
    item.score = {
      kind: "bm25",
      value: hit.score,
      order: "lower_is_better",
    };
  }
  return item;
}

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * Execute the canonical `rs.search.lexical` operation.
 *
 * The operation does not mutate `input.query`; it parses and normalizes a
 * fresh request-params object internally.
 */
export async function executeSearchLexical(
  input: SearchLexicalInput,
  dependencies: SearchLexicalDependencies,
): Promise<SearchLexicalOutput> {
  // 1. Strict v1 allowlist + required `q` + `filter[...]` coupling.
  const params = parseSearchLexicalParams(input.query);

  // 2. Cross-stream advertisement gate: when capability says cross-stream
  //    search is disabled, `streams[]` becomes mandatory.
  const advertisement = dependencies.getAdvertisement();
  if (
    advertisement
    && advertisement.cross_stream === false
    && (!params.streams || params.streams.length === 0)
  ) {
    throw new SearchLexicalRequestError(
      "invalid_request",
      "streams[] is required when cross_stream search is disabled",
      "streams",
    );
  }

  const isOwner = input.actor.kind === "owner";
  const mode: "owner" | "client" = isOwner ? "owner" : "client";

  // 3. Per-mode planning fan-out.
  const perConnectorPlans: SearchLexicalConnectorPlan[] = [];
  // Track owner-fan-out *sources* that the runtime had to skip without
  // failing the whole request (broken manifest, empty searchable plan).
  // These become structured `source_skipped_not_applicable` warnings on the
  // canonical envelope so the wire never lies by silently dropping sources.
  // Each entry carries `{ source, connection_id? }` — `connection_id` is
  // emitted when the skipped unit is a specific binding under a connector
  // (cross-binding fan-in), and omitted when the entire connector was
  // skipped before binding fan-out.
  const skippedSources: Array<{ source: string; connection_id?: string }> = [];
  // Request-time connection_id narrowing (canonical or deprecated alias).
  // The parser already validated alias conflicts; here we read the resolved
  // value from the query so owner-mode fan-in can narrow without piping the
  // value through every adapter dependency.
  const requestConnectionId =
    typeof input.query.connection_id === "string" && input.query.connection_id.length > 0
      ? input.query.connection_id
      : typeof input.query.connector_instance_id === "string"
            && input.query.connector_instance_id.length > 0
        ? input.query.connector_instance_id
        : null;
  if (input.actor.kind === "owner") {
    // Cross-binding fan-in path: when the host wires the binding-aware
    // dependency, the operation enumerates every active owner-visible
    // binding and emits one connector plan per binding. The plan still
    // carries the binding's connector_id so the round-robin merge in the
    // adapter snapshot fans across bindings.
    if (typeof dependencies.listOwnerVisibleBindings === "function") {
      const bindings = await dependencies.listOwnerVisibleBindings();
      const narrowedBindings = requestConnectionId
        ? bindings.filter((b) => b.connectorInstanceId === requestConnectionId)
        : bindings;
      if (requestConnectionId && narrowedBindings.length === 0) {
        throw new SearchLexicalRequestError(
          "connection_not_found",
          `connection_id '${requestConnectionId}' is not addressable for this owner.`,
          "connection_id",
        );
      }
      // Skipped (out-of-scope under request-time narrowing) bindings do NOT
      // become warnings — narrowing is the caller's explicit ask.
      for (const binding of narrowedBindings) {
        const manifest = typeof dependencies.resolveOwnerManifestForBinding
          === "function"
          ? await dependencies.resolveOwnerManifestForBinding(binding)
          : await dependencies.resolveOwnerManifestForConnector(
              binding.connectorId,
            );
        if (!manifest) {
          skippedSources.push({
            source: binding.connectorId,
            connection_id: binding.connectorInstanceId,
          });
          continue;
        }
        const grant = dependencies.buildOwnerReadGrantForManifest(manifest);
        let planEntries: SearchLexicalPlanEntry[];
        try {
          planEntries = dependencies.buildSearchPlanForGrant({
            manifest,
            grant,
            streamsFilter: params.streams,
            filter: params.filter,
            filteredStream: params.filteredStream,
            connectorId: binding.connectorId,
          });
        } catch (err) {
          if (!isInvalidQueryError(err)) throw err;
          skippedSources.push({
            source: binding.connectorId,
            connection_id: binding.connectorInstanceId,
          });
          continue;
        }
        if (planEntries.length === 0) {
          skippedSources.push({
            source: binding.connectorId,
            connection_id: binding.connectorInstanceId,
          });
          continue;
        }
        perConnectorPlans.push({
          connectorId: binding.connectorId,
          manifest,
          grant,
          planEntries,
        });
      }
    } else {
      // Legacy single-binding-per-connector path (sandbox host, older test
      // shims). Preserves prior behavior so existing dependency wirings keep
      // working unchanged.
      const connectorIds = await dependencies.listOwnerVisibleConnectorIds();
      for (const connectorId of connectorIds) {
        const manifest = await dependencies.resolveOwnerManifestForConnector(
          connectorId,
        );
        if (!manifest) {
          skippedSources.push({ source: connectorId });
          continue;
        }
        const grant = dependencies.buildOwnerReadGrantForManifest(manifest);
        let planEntries: SearchLexicalPlanEntry[];
        try {
          planEntries = dependencies.buildSearchPlanForGrant({
            manifest,
            grant,
            streamsFilter: params.streams,
            filter: params.filter,
            filteredStream: params.filteredStream,
            connectorId,
          });
        } catch (err) {
          if (!isInvalidQueryError(err)) throw err;
          skippedSources.push({ source: connectorId });
          continue;
        }
        if (planEntries.length === 0) {
          skippedSources.push({ source: connectorId });
          continue;
        }
        perConnectorPlans.push({ connectorId, manifest, grant, planEntries });
      }
    }
    // Owner-mode `streams[]` is a soft filter: unknown stream names just
    // produce zero hits.
  } else {
    const grant = input.actor.grant;
    if (params.streams) {
      const grantedStreamNames = new Set(
        (grant.streams || []).map((s) => s.name),
      );
      for (const s of params.streams) {
        if (!grantedStreamNames.has(s)) {
          throw new SearchLexicalRequestError(
            "grant_stream_not_allowed",
            `Stream '${s}' not in grant`,
          );
        }
      }
    }
    const connectorId =
      (grant as { source?: { kind?: unknown; id?: unknown } } | null)?.source?.kind === "connector" &&
      typeof (grant as { source?: { id?: unknown } } | null)?.source?.id === "string"
        ? ((grant as { source?: { id?: string } }).source!.id as string)
        : null;
    // Cross-binding fan-in path for client mode. When the host wires the
    // binding-aware resolver, the operation iterates every binding the grant
    // authorizes (after narrowing) and emits one connector plan per binding.
    // The resolver MUST raise `connection_not_found` for narrowing failures
    // and `invalid_argument` for alias conflicts — the operation does not
    // re-implement those checks.
    if (typeof dependencies.resolveClientBindings === "function") {
      const clientBindings = await dependencies.resolveClientBindings(
        { kind: "client", grant },
        { connectionId: requestConnectionId },
      );
      for (const cb of clientBindings) {
        const planEntries = dependencies.buildSearchPlanForGrant({
          manifest: cb.manifest,
          grant,
          streamsFilter: params.streams,
          filter: params.filter,
          filteredStream: params.filteredStream,
          connectorId,
        });
        if (planEntries.length === 0) {
          skippedSources.push({
            source: connectorId ?? "",
            connection_id: cb.connectorInstanceId,
          });
          continue;
        }
        perConnectorPlans.push({
          connectorId,
          manifest: cb.manifest,
          grant,
          planEntries,
        });
      }
    } else {
      const manifest = await dependencies.resolveClientManifest({
        kind: "client",
        grant,
      });
      const planEntries = dependencies.buildSearchPlanForGrant({
        manifest,
        grant,
        streamsFilter: params.streams,
        filter: params.filter,
        filteredStream: params.filteredStream,
        connectorId,
      });
      if (planEntries.length > 0) {
        perConnectorPlans.push({ connectorId, manifest, grant, planEntries });
      }
    }
  }

  // 4. Resolve cursor → snapshot. Fresh request: build & persist; cursor
  //    request: load by id.
  let snapshot: SearchLexicalSnapshot;
  let snapshotId: string;
  let offset: number;
  if (params.cursor) {
    const decoded = decodeSearchLexicalCursor(params.cursor);
    if (!decoded) {
      throw new SearchLexicalRequestError(
        "invalid_cursor",
        "Cursor is malformed",
      );
    }
    const loaded = await dependencies.loadSnapshot(decoded.snap);
    if (!loaded) {
      throw new SearchLexicalRequestError(
        "invalid_cursor",
        "Cursor refers to an expired or unknown snapshot",
      );
    }
    snapshot = loaded;
    snapshotId = decoded.snap;
    offset = decoded.off;
  } else {
    snapshot = await dependencies.buildSnapshot({
      q: params.q,
      perConnectorPlans,
      isOwner,
    });
    snapshotId = snapshot.snapshot_id;
    await dependencies.persistSnapshot(snapshot);
    offset = 0;
  }

  // 5. Slice the snapshot.
  const allHits = snapshot.results;
  const slice = allHits.slice(offset, offset + params.limit);
  const hasMore = offset + params.limit < allHits.length;
  const nextCursor = hasMore
    ? encodeSearchLexicalCursor({ snap: snapshotId, off: offset + params.limit })
    : null;

  // 6. Shape into `search_result` items. Score emission is gated by the
  //    advertisement.
  const emitScore = advertisesScore(advertisement);
  const data = slice.map((hit) =>
    buildResultItem(hit, isOwner, emitScore, dependencies.formatRecordUrl),
  );

  const skippedWarnings: SearchLexicalWarning[] = skippedSources.map(
    (skipped) => {
      const detail: Record<string, unknown> = { source: skipped.source };
      if (skipped.connection_id) detail.connection_id = skipped.connection_id;
      const subject = skipped.connection_id
        ? `Connection '${skipped.connection_id}' under connector '${skipped.source}'`
        : `Connector '${skipped.source}'`;
      return {
        code: SEARCH_SOURCE_SKIPPED_WARNING_CODE,
        message: `${subject} is not applicable to this query and was skipped.`,
        detail,
      };
    },
  );
  const allWarnings: SearchLexicalWarning[] = [
    ...params.warnings,
    ...skippedWarnings,
  ];
  const envelope: SearchLexicalEnvelope = {
    object: "list",
    has_more: hasMore,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    data,
    ...(allWarnings.length > 0
      ? { meta: { warnings: allWarnings } }
      : {}),
  };

  const disclosureData: SearchLexicalDisclosureData = {
    query_shape: "search",
    record_count: data.length,
    has_more: hasMore,
    mode,
    connector_count: perConnectorPlans.length,
  };

  return { envelope, disclosureData };
}
