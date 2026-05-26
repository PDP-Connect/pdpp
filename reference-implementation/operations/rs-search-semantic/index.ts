/**
 * Canonical `rs.search.semantic` operation.
 *
 * Owns the public-contract slice of `GET /v1/search/semantic` independent of
 * HTTP framework, sandbox UI, concrete database driver, embedding-backend
 * implementation, vector-index implementation, the native
 * `server/search-semantic.js` helper module, the native `server/search.js`
 * helper module, and `process.env`. The native Fastify route mounts this
 * operation through the `runSemanticSearch` shell in `server/search-semantic.js`
 * which wires the embedding pipeline, vector indexes, snapshot tables, and
 * records-table snippet hydration as capability dependencies. The host
 * adapter still owns auth, request id / trace id, instrumentation events,
 * response writing, and the host-shaped `url` envelope field.
 *
 * Boundary rules (see openspec/changes/mount-rs-search-semantic-operation):
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, the native
 *   `server/search.js` helper module, the native `server/search-semantic.js`
 *   helper module, or `process` / `process.env`. The lexical-import ban is
 *   load-bearing: it is the operation-boundary realization of the
 *   no-silent-fallback invariant pinned at the file level on
 *   `server/search-semantic.js`.
 * - Plan compilation, snapshot build, snapshot persistence, embedding pipeline,
 *   ranking, snippet hydration, manifest/grant resolution, advertisement
 *   source, current backend identity, and record-url formatting are delegated
 *   to capability dependencies. The operation does not look at adapter
 *   internals.
 * - Manifest, grant, advertisement, snapshot bytes, and snippet text are
 *   operation inputs / dependency results. Hosts compute them and hand them
 *   in.
 *
 * What the operation owns (the host-independent public-contract slice):
 *   - strict v1 query-param allowlist (`q`, `limit`, `cursor`, `streams`,
 *     `streams[]`, `filter`); rejects unknown keys with `invalid_request`;
 *   - explicit forbidden-parameter list (`vector`, `embedding`, `embed`,
 *     `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`,
 *     `blend`, `connector_id`, `fields`, `expand`, `expand[]`,
 *     `expand_limit`, `expand_limit[]`, `order`, `sort`, `mode`); each
 *     rejected with `invalid_request` and `param: <key>`;
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
 *   - cursor encode/decode with the literal `sem1.` prefix
 *     (body is base64url JSON `{snap, off}`);
 *   - snapshot orchestration (build & persist on a fresh request, load on a
 *     cursor request);
 *   - backend-identity stale-cursor detection: a loaded snapshot whose
 *     `backend_hash` differs from `getCurrentBackendIdentity()` raises
 *     `invalid_cursor`;
 *   - slice math (`offset`, `limit`, `has_more`, `next_cursor`);
 *   - score-advertisement gate (emit per-result `score` only when capability
 *     advertises `kind: "semantic_distance"` lower-is-better);
 *   - `search_result` shaping including `retrieval_mode: "semantic"`;
 *     `record_url` is delegated to the host through a `formatRecordUrl`
 *     capability; `emitted_at` and `snippet` are delegated to a
 *     `hydrateResult` capability so snippets remain grant-safe verbatim
 *     substrings of the matched field;
 *   - list-envelope shape (`object: 'list'`, `has_more`, `next_cursor?`,
 *     `data[]`); hosts add the host-shaped `url` field;
 *   - `disclosure.served` data block (`query_shape: 'search_semantic'`).
 */

// ─── Errors ────────────────────────────────────────────────────────────────

export type SearchSemanticErrorCode =
  | "invalid_request"
  | "invalid_argument"
  | "invalid_cursor"
  | "grant_stream_not_allowed";

/**
 * Error thrown when the request itself is invalid in a host-independent way.
 * Hosts map `code` (and `param` where present) into their existing error
 * envelopes.
 */
export class SearchSemanticRequestError extends Error {
  readonly code: SearchSemanticErrorCode;
  readonly param?: string;

  constructor(code: SearchSemanticErrorCode, message: string, param?: string) {
    super(message);
    this.name = "SearchSemanticRequestError";
    this.code = code;
    if (param !== undefined) {
      this.param = param;
    }
  }
}

// ─── Public types ──────────────────────────────────────────────────────────

export type SearchSemanticActor =
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
      grant: SearchSemanticGrant;
    };

export interface SearchSemanticManifestStream {
  name: string;
  [extra: string]: unknown;
}

export interface SearchSemanticManifest {
  streams?: SearchSemanticManifestStream[];
  [extra: string]: unknown;
}

export interface SearchSemanticGrantStream {
  name: string;
  fields?: string[];
  [extra: string]: unknown;
}

export interface SearchSemanticGrant {
  streams?: SearchSemanticGrantStream[];
  [extra: string]: unknown;
}

/**
 * Capability advertisement consumed by the operation. Mirrors the public
 * `capabilities.semantic_retrieval` shape published in RS metadata.
 */
export interface SearchSemanticAdvertisement {
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
    comparable_with?: unknown;
  };
  [extra: string]: unknown;
}

/**
 * One per-connector plan entry. The shape is opaque to the operation; only
 * `streamName` and `searchableFields` are read for emptiness checks. Adapter
 * helpers (vector-index, candidate-record narrowing) carry whatever extra
 * fields they need through the plan back into the snapshot builder.
 */
export interface SearchSemanticPlanEntry {
  streamName: string;
  searchableFields: string[];
  [extra: string]: unknown;
}

export interface SearchSemanticConnectorPlan {
  connectorId: string | null;
  manifest: SearchSemanticManifest;
  grant: SearchSemanticGrant;
  planEntries: SearchSemanticPlanEntry[];
}

/**
 * One snapshot result carrying the data needed to shape a `search_result`
 * envelope. Adapter-specific fields (e.g. `topField`, `scopeKey`) may be
 * carried through `[extra]`. The operation reads `connectorId`, `stream`,
 * `recordKey`, `matchedFields`, and `distance`; it forwards the entire hit
 * to `hydrateResult` so the dependency can derive `emitted_at` and
 * `snippet` from adapter-owned fields without leaking those fields into the
 * public envelope.
 */
export interface SearchSemanticSnapshotResult {
  connectorId: string;
  /**
   * Connection identifier (canonical) for the binding this hit came from.
   * Optional only because pre-identity snapshots may omit it; new snapshots
   * SHOULD always set it so the operation can emit `connection_id` and the
   * deprecated `connector_instance_id` alias on each result item.
   */
  connectorInstanceId?: string | null;
  /**
   * Owner-facing label for the connection. Emitted as `display_name` on the
   * result item only when the snapshot captured a non-placeholder label.
   */
  displayName?: string | null;
  stream: string;
  recordKey: string;
  matchedFields: string[];
  distance: number;
  [extra: string]: unknown;
}

export interface SearchSemanticSnapshot {
  snapshot_id: string;
  query: string;
  /**
   * Opaque backend identity hash captured at snapshot build time. The
   * operation compares it against `getCurrentBackendIdentity()` on cursor
   * load and raises `invalid_cursor` on any divergence.
   */
  backend_hash: string;
  results: SearchSemanticSnapshotResult[];
  [extra: string]: unknown;
}

export interface SearchSemanticHydratedResult {
  emittedAt: string | null;
  /**
   * Verbatim contiguous substring of the matched field's stored value.
   * Adapters MUST NOT paraphrase, summarize, or model-generate snippet text.
   * `null` or `undefined` ⇒ omit `snippet` from the public result.
   */
  snippet?: { field: string; text: string } | null;
}

export interface SearchSemanticDependencies {
  /**
   * Capability advertisement; controls cross-stream and score-emission gates.
   */
  getAdvertisement(): SearchSemanticAdvertisement | null;
  /**
   * Current backend identity hash. Compared against `snapshot.backend_hash`
   * on cursor load; any divergence ⇒ `invalid_cursor`.
   */
  getCurrentBackendIdentity(): string;
  /**
   * Owner fan-out: list every connector id whose manifest the owner can read.
   */
  listOwnerVisibleConnectorIds(): Promise<string[]> | string[];
  /**
   * Owner fan-out helper: return the manifest for one connector, or null to
   * skip it (e.g. broken polyfill manifests).
   */
  resolveOwnerManifestForConnector(
    connectorId: string,
  ):
    | Promise<SearchSemanticManifest | null>
    | SearchSemanticManifest
    | null;
  /**
   * Owner fan-out helper: build a synthetic owner read-grant covering every
   * stream of `manifest`. Adapter decides field-set semantics (typically
   * `fields = undefined ⇒ all fields authorized`).
   */
  buildOwnerReadGrantForManifest(
    manifest: SearchSemanticManifest,
  ): SearchSemanticGrant;
  /**
   * Client-mode helper: resolve the manifest the supplied client grant
   * applies against. Hosts build this from the bearer token information.
   */
  resolveClientManifest(
    actor: { kind: "client"; grant: SearchSemanticGrant },
  ): Promise<SearchSemanticManifest> | SearchSemanticManifest;
  /**
   * Compile one connector's grant + manifest + request filter shape into a
   * plan. Implementations MUST enforce field-grant intersection,
   * stream-grant intersection, and (declared semantic_fields ∩ grant
   * projection) intersection — the operation does not look inside the plan
   * entries beyond `streamName` and `searchableFields`.
   *
   * `streamsFilter` is the normalized `streams[]` request value (null if
   * absent). `filter` and `filteredStream` are the request `filter[...]` and
   * the single `streams[]` value bound to it (if `filter` is present).
   */
  buildSearchPlanForGrant(args: {
    manifest: SearchSemanticManifest;
    grant: SearchSemanticGrant;
    streamsFilter: string[] | null;
    filter: unknown;
    filteredStream: string | null;
    connectorId: string | null;
  }): SearchSemanticPlanEntry[];
  /**
   * Build a snapshot of the fully-ranked result set for `(q, plans)`. The
   * adapter owns embedding, KNN, ranking, per-record collapsing, and
   * recall-determinism semantics; the operation only slices the snapshot.
   * The returned snapshot MUST carry the backend identity captured at build
   * time as `backend_hash` so cursor staleness is decidable on later loads.
   */
  buildSnapshot(args: {
    q: string;
    perConnectorPlans: SearchSemanticConnectorPlan[];
    isOwner: boolean;
  }): Promise<SearchSemanticSnapshot> | SearchSemanticSnapshot;
  /**
   * Persist a freshly-built snapshot for cursor reuse.
   */
  persistSnapshot(snapshot: SearchSemanticSnapshot): Promise<void> | void;
  /**
   * Load a previously-persisted snapshot by id. Returns `null` if the
   * snapshot has expired or never existed.
   */
  loadSnapshot(
    snapshotId: string,
  ):
    | Promise<SearchSemanticSnapshot | null>
    | SearchSemanticSnapshot
    | null;
  /**
   * Hydrate `emitted_at` and (optionally) `snippet` for one search hit.
   * Snippet MUST be a verbatim contiguous substring of the matched field's
   * stored value. The operation calls this once per emitted hit so the
   * records-table read stays in the dependency.
   */
  hydrateResult(args: {
    hit: SearchSemanticSnapshotResult;
    isOwner: boolean;
  }): Promise<SearchSemanticHydratedResult> | SearchSemanticHydratedResult;
  /**
   * Format the public `record_url` for one search result. Hosts wire the
   * concrete implementation: native -> `/v1/streams/<stream>/records/<id>`
   * (with `?connector_id=` for owner mode).
   */
  formatRecordUrl(args: {
    stream: string;
    recordKey: string;
    connectorId: string;
    isOwner: boolean;
  }): string;
}

export interface SearchSemanticInput {
  actor: SearchSemanticActor;
  /**
   * Raw request query object. The operation runs the v1 allowlist,
   * forbidden-parameter list, and normalization against this object. Hosts
   * should pass the parsed query-string object their framework produces
   * (Fastify `req.query`, URLSearchParams via Object.fromEntries, etc.)
   * without normalizing `streams[]`/`filter[...]` shapes — those are
   * operation concerns.
   */
  query: Record<string, unknown>;
}

export interface SearchSemanticResultItem {
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
   * captured a non-placeholder label. Mirrors records-list/detail wire shape.
   */
  display_name?: string;
  record_url: string;
  emitted_at: string | null;
  matched_fields: string[];
  /**
   * v1: every hit emits `retrieval_mode: "semantic"`. `lexical_blending` is
   * advertised as `false` in v1 and the operation does not blend.
   */
  retrieval_mode: "semantic";
  snippet?: { field: string; text: string };
  score?: { kind: "semantic_distance"; value: number; order: "lower_is_better" };
}

export interface SearchSemanticEnvelopeMeta {
  warnings?: Array<{ code: string; param?: string; message?: string }>;
  [extra: string]: unknown;
}

export interface SearchSemanticEnvelope {
  object: "list";
  has_more: boolean;
  next_cursor?: string;
  data: SearchSemanticResultItem[];
  /** Optional canonical `meta` slot; only emitted when warnings are non-empty. */
  meta?: SearchSemanticEnvelopeMeta;
}

export interface SearchSemanticDisclosureData {
  query_shape: "search_semantic";
  record_count: number;
  has_more: boolean;
  mode: "owner" | "client";
  connector_count: number;
}

export interface SearchSemanticOutput {
  /**
   * List envelope minus the host-shaped `url` field. Hosts add
   * `url: '/v1/search/semantic'`.
   */
  envelope: SearchSemanticEnvelope;
  /**
   * Pre-shaped `disclosure.served` data block. Hosts merge in `source` and
   * any host-only fields.
   */
  disclosureData: SearchSemanticDisclosureData;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

// `connection_id` is the canonical public connection identifier;
// `connector_instance_id` is the deprecated wire alias accepted during the
// migration window defined by
// `openspec/changes/expose-connection-identity-on-public-read`.
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

/**
 * Parameters that MUST be rejected explicitly (not silently ignored). Some
 * of these overlap with "anything not in ALLOWED_PARAMS" — the explicit list
 * makes the rejection intentional and visible in source. This list mirrors
 * the previous `FORBIDDEN_PARAMS` set in `server/search-semantic.js`.
 */
const FORBIDDEN_PARAMS: ReadonlySet<string> = new Set([
  "vector",
  "embedding",
  "embed",
  "model",
  "model_id",
  "model_family",
  "rank",
  "boost",
  "weights",
  "blend",
  "connector_id",
  "fields",
  "expand",
  "expand[]",
  "expand_limit",
  "expand_limit[]",
  "order",
  "sort",
  "mode",
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
  warnings: SearchSemanticWarning[];
}

/**
 * Structured warning shape used in `meta.warnings[]`. The canonical
 * `deprecated_alias_used` code is emitted whenever the request reached the
 * operation via the deprecated `connector_instance_id` query alias.
 */
export interface SearchSemanticWarning {
  code: string;
  param?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

/**
 * Canonical warning code for deprecated-alias usage. Mirrors the
 * lexical-operation export so REST and MCP clients can detect alias
 * deprecation uniformly across search modes.
 */
export const SEARCH_CONNECTION_ALIAS_DEPRECATED_WARNING_CODE = "deprecated_alias_used";

/**
 * Canonical warning code emitted when the owner fan-out had to skip a
 * connector (broken manifest, empty searchable plan) without failing the
 * whole request.
 */
export const SEARCH_SEMANTIC_SOURCE_SKIPPED_WARNING_CODE = "source_skipped_not_applicable";

function deriveSearchConnectionAliasWarnings(
  query: Record<string, unknown>,
): SearchSemanticWarning[] {
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

function normalizeStreamsParam(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const arr = Array.isArray(raw) ? raw : [raw];
  const cleaned = arr
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Public-contract param parsing. Mirrors the previous
 * `parseSemanticSearchParams` helper inside `server/search-semantic.js`; the
 * operation owns it now so the native dependency wiring runs the same
 * allowlist, forbidden list, and coupling rules.
 */
export function parseSearchSemanticParams(
  query: Record<string, unknown>,
): NormalizedRequestParams {
  for (const key of Object.keys(query)) {
    if (FORBIDDEN_PARAMS.has(key)) {
      throw new SearchSemanticRequestError(
        "invalid_request",
        `Unsupported query parameter: ${key}`,
        key,
      );
    }
    if (!ALLOWED_PARAMS.has(key)) {
      throw new SearchSemanticRequestError(
        "invalid_request",
        `Unsupported query parameter: ${key}`,
        key,
      );
    }
  }
  const q = typeof query.q === "string" ? query.q : "";
  if (!q) {
    throw new SearchSemanticRequestError(
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
    throw new SearchSemanticRequestError(
      "invalid_request",
      "filter[...] requires exactly one streams[] value (e.g. ?streams[]=messages&filter[received_at][gte]=...). filter[stream] and filter[connector_id] are not supported.",
      "streams",
    );
  }
  const canonicalConn = query.connection_id;
  const aliasConn = query.connector_instance_id;
  if (
    typeof canonicalConn === "string"
    && canonicalConn.length > 0
    && typeof aliasConn === "string"
    && aliasConn.length > 0
    && canonicalConn !== aliasConn
  ) {
    throw new SearchSemanticRequestError(
      "invalid_argument",
      "connection_id and connector_instance_id refer to the same connection. Send only `connection_id` (canonical) or supply matching values.",
      "connector_instance_id",
    );
  }
  return {
    q,
    limit,
    cursor,
    streams,
    filter: hasFilter ? query.filter : null,
    filteredStream: hasFilter && streams && streams.length > 0 ? streams[0]! : null,
    warnings: deriveSearchConnectionAliasWarnings(query),
  };
}

interface CursorPayload {
  snap: string;
  off: number;
}

/**
 * Semantic cursors carry a literal `sem1.` prefix to distinguish them from
 * lexical cursors on the wire. Decoding a cursor without the prefix is
 * rejected as `invalid_cursor`. This realizes the spec scenario "cursor
 * from /v1/search passed to /v1/search/semantic → invalid_cursor".
 */
const SEMANTIC_CURSOR_PREFIX = "sem1.";

/**
 * Encode an opaque cursor pointing at offset `off` of snapshot `snap`. The
 * literal `sem1.` prefix is part of the public cursor format and MUST NOT
 * change without an explicit OpenSpec change.
 */
export function encodeSearchSemanticCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return SEMANTIC_CURSOR_PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor. Returns `null` for malformed input (no prefix,
 * undecodable body, missing fields). Hosts MUST map `null` to
 * `invalid_cursor`; we surface that mapping inside `executeSearchSemantic`
 * so the cursor format stays internal to the operation.
 */
export function decodeSearchSemanticCursor(cursor: string): CursorPayload | null {
  if (typeof cursor !== "string" || !cursor.startsWith(SEMANTIC_CURSOR_PREFIX)) {
    return null;
  }
  try {
    const body = cursor.slice(SEMANTIC_CURSOR_PREFIX.length);
    const json = Buffer.from(body, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<CursorPayload>;
    if (typeof parsed.snap !== "string" || typeof parsed.off !== "number") {
      return null;
    }
    return { snap: parsed.snap, off: parsed.off };
  } catch {
    return null;
  }
}

function advertisesSemanticScore(
  advertisement: SearchSemanticAdvertisement | null,
): boolean {
  return !!(
    advertisement
    && advertisement.supported !== false
    && advertisement.score?.supported === true
    && advertisement.score.kind === "semantic_distance"
    && advertisement.score.order === "lower_is_better"
  );
}

async function buildResultItem(
  hit: SearchSemanticSnapshotResult,
  isOwner: boolean,
  emitScore: boolean,
  hydrate: SearchSemanticDependencies["hydrateResult"],
  formatRecordUrl: SearchSemanticDependencies["formatRecordUrl"],
): Promise<SearchSemanticResultItem> {
  const hydrated = await hydrate({ hit, isOwner });
  const item: SearchSemanticResultItem = {
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
    emitted_at: hydrated.emittedAt ?? null,
    matched_fields: hit.matchedFields,
    retrieval_mode: "semantic",
  };
  if (typeof hit.connectorInstanceId === "string" && hit.connectorInstanceId.length > 0) {
    item.connection_id = hit.connectorInstanceId;
    item.connector_instance_id = hit.connectorInstanceId;
  }
  if (typeof hit.displayName === "string" && hit.displayName.length > 0) {
    item.display_name = hit.displayName;
  }
  if (hydrated.snippet) {
    item.snippet = hydrated.snippet;
  }
  if (emitScore && Number.isFinite(hit.distance)) {
    item.score = {
      kind: "semantic_distance",
      value: hit.distance,
      order: "lower_is_better",
    };
  }
  return item;
}

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * Execute the canonical `rs.search.semantic` operation.
 *
 * The operation does not mutate `input.query`; it parses and normalizes a
 * fresh request-params object internally.
 */
export async function executeSearchSemantic(
  input: SearchSemanticInput,
  dependencies: SearchSemanticDependencies,
): Promise<SearchSemanticOutput> {
  // 1. Strict v1 allowlist + forbidden list + required `q` + `filter[...]`
  //    coupling.
  const params = parseSearchSemanticParams(input.query);

  // 2. Cross-stream advertisement gate: when capability says cross-stream
  //    search is disabled, `streams[]` becomes mandatory.
  const advertisement = dependencies.getAdvertisement();
  if (
    advertisement
    && advertisement.cross_stream === false
    && (!params.streams || params.streams.length === 0)
  ) {
    throw new SearchSemanticRequestError(
      "invalid_request",
      "streams[] is required when cross_stream search is disabled",
      "streams",
    );
  }

  const isOwner = input.actor.kind === "owner";
  const mode: "owner" | "client" = isOwner ? "owner" : "client";

  // 3. Per-mode planning fan-out.
  const perConnectorPlans: SearchSemanticConnectorPlan[] = [];
  // Track owner-fan-out connectors skipped without failing the request
  // (broken manifest, empty searchable plan). These become
  // `source_skipped_not_applicable` warnings so the envelope is honest.
  const skippedConnectorIds: string[] = [];
  if (input.actor.kind === "owner") {
    const connectorIds = await dependencies.listOwnerVisibleConnectorIds();
    for (const connectorId of connectorIds) {
      const manifest = await dependencies.resolveOwnerManifestForConnector(
        connectorId,
      );
      if (!manifest) {
        skippedConnectorIds.push(connectorId);
        continue;
      }
      const grant = dependencies.buildOwnerReadGrantForManifest(manifest);
      const planEntries = dependencies.buildSearchPlanForGrant({
        manifest,
        grant,
        streamsFilter: params.streams,
        filter: params.filter,
        filteredStream: params.filteredStream,
        connectorId,
      });
      if (planEntries.length === 0) {
        skippedConnectorIds.push(connectorId);
        continue;
      }
      perConnectorPlans.push({ connectorId, manifest, grant, planEntries });
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
          throw new SearchSemanticRequestError(
            "grant_stream_not_allowed",
            `Stream '${s}' not in grant`,
          );
        }
      }
    }
    const manifest = await dependencies.resolveClientManifest({
      kind: "client",
      grant,
    });
    const connectorId =
      (grant as { source?: { kind?: unknown; id?: unknown } } | null)?.source?.kind === "connector" &&
      typeof (grant as { source?: { id?: unknown } } | null)?.source?.id === "string"
        ? ((grant as { source?: { id?: string } }).source!.id as string)
        : null;
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

  // 4. Resolve cursor → snapshot. Fresh request: build & persist; cursor
  //    request: load by id and verify backend identity.
  let snapshot: SearchSemanticSnapshot;
  let snapshotId: string;
  let offset: number;
  if (params.cursor) {
    const decoded = decodeSearchSemanticCursor(params.cursor);
    if (!decoded) {
      throw new SearchSemanticRequestError(
        "invalid_cursor",
        "Cursor is malformed",
      );
    }
    const loaded = await dependencies.loadSnapshot(decoded.snap);
    if (!loaded) {
      throw new SearchSemanticRequestError(
        "invalid_cursor",
        "Cursor refers to an expired or unknown snapshot",
      );
    }
    // Stale-cursor backend-identity check: any divergence ⇒ invalid_cursor.
    // Recomputing under a different model would be dishonest — the spec
    // permits this and the previous native behavior raises the same code.
    const currentBackendIdentity = dependencies.getCurrentBackendIdentity();
    if (loaded.backend_hash !== currentBackendIdentity) {
      throw new SearchSemanticRequestError(
        "invalid_cursor",
        "Cursor predates a backend identity change",
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
    ? encodeSearchSemanticCursor({
        snap: snapshotId,
        off: offset + params.limit,
      })
    : null;

  // 6. Shape into `search_result` items. Hydration (emitted_at + snippet)
  //    is delegated to the dependency so the records-table read stays in the
  //    native shell. Score emission is gated by the advertisement.
  const emitScore = advertisesSemanticScore(advertisement);
  const data: SearchSemanticResultItem[] = [];
  for (const hit of slice) {
    data.push(
      await buildResultItem(
        hit,
        isOwner,
        emitScore,
        dependencies.hydrateResult,
        dependencies.formatRecordUrl,
      ),
    );
  }

  const skippedWarnings: SearchSemanticWarning[] = skippedConnectorIds.map(
    (connectorId) => ({
      code: SEARCH_SEMANTIC_SOURCE_SKIPPED_WARNING_CODE,
      message: `Connector '${connectorId}' is not applicable to this query and was skipped.`,
      detail: { source: connectorId },
    }),
  );
  const allWarnings: SearchSemanticWarning[] = [
    ...params.warnings,
    ...skippedWarnings,
  ];
  const envelope: SearchSemanticEnvelope = {
    object: "list",
    has_more: hasMore,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    data,
    ...(allWarnings.length > 0
      ? { meta: { warnings: allWarnings } }
      : {}),
  };

  const disclosureData: SearchSemanticDisclosureData = {
    query_shape: "search_semantic",
    record_count: data.length,
    has_more: hasMore,
    mode,
    connector_count: perConnectorPlans.length,
  };

  return { envelope, disclosureData };
}
