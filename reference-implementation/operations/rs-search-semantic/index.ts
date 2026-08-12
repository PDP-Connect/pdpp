// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { searchAuthorityKey } from "../search-authority-key.ts";

export type SearchSemanticErrorCode =
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
  fields?: string[];
  name: string;
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
  cross_stream?: boolean;
  default_limit?: number;
  max_limit?: number;
  score?: {
    supported?: boolean;
    kind?: string;
    order?: string;
    value_semantics?: string;
    comparable_with?: unknown;
  };
  snippets?: boolean;
  supported?: boolean;
  [extra: string]: unknown;
}

/**
 * One per-connector plan entry. The shape is opaque to the operation; only
 * `streamName` and `searchableFields` are read for emptiness checks. Adapter
 * helpers (vector-index, candidate-record narrowing) carry whatever extra
 * fields they need through the plan back into the snapshot builder.
 */
export interface SearchSemanticPlanEntry {
  searchableFields: string[];
  streamName: string;
  [extra: string]: unknown;
}

export interface SearchSemanticConnectorPlan {
  connectorId: string | null;
  grant: SearchSemanticGrant;
  manifest: SearchSemanticManifest;
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
  distance: number;
  matchedFields: string[];
  recordKey: string;
  stream: string;
  [extra: string]: unknown;
}

export interface SearchSemanticSnapshot {
  authority_key?: string;
  /**
   * Opaque backend identity hash captured at snapshot build time. The
   * operation compares it against `getCurrentBackendIdentity()` on cursor
   * load and raises `invalid_cursor` on any divergence.
   */
  backend_hash: string;
  query: string;
  results: SearchSemanticSnapshotResult[];
  snapshot_id: string;
  [extra: string]: unknown;
}

export interface SearchSemanticHydratedResult {
  authoredAt?: string | null;
  emittedAt: string | null;
  /**
   * Verbatim contiguous substring of the matched field's stored value.
   * Adapters MUST NOT paraphrase, summarize, or model-generate snippet text.
   * `null` or `undefined` ⇒ omit `snippet` from the public result.
   */
  snippet?: { field: string; text: string } | null;
}

/**
 * One owner-visible binding for cross-binding semantic fan-in. Mirrors
 * `SearchLexicalOwnerBinding` so host wirings can share one resolver
 * implementation across surfaces.
 */
export interface SearchSemanticOwnerBinding {
  connectorId: string;
  connectorInstanceId: string;
  displayName?: string | null;
}

/**
 * One client-mode binding the grant resolves to under cross-binding fan-in.
 * `manifest` is pinned to the binding's `connector_instance_id` so the
 * downstream plan compiler scopes vector queries to that binding.
 */
export interface SearchSemanticClientBinding {
  connectorId?: string | null;
  connectorInstanceId: string;
  displayName?: string | null;
  manifest: SearchSemanticManifest;
}

export interface SearchSemanticDependencies {
  /**
   * Owner fan-out helper: build a synthetic owner read-grant covering every
   * stream of `manifest`. Adapter decides field-set semantics (typically
   * `fields = undefined ⇒ all fields authorized`).
   */
  buildOwnerReadGrantForManifest: (manifest: SearchSemanticManifest) => SearchSemanticGrant;
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
  buildSearchPlanForGrant: (args: {
    manifest: SearchSemanticManifest;
    grant: SearchSemanticGrant;
    streamsFilter: string[] | null;
    filter: unknown;
    filteredStream: string | null;
    connectorId: string | null;
  }) => SearchSemanticPlanEntry[];
  /**
   * Build a snapshot of the fully-ranked result set for `(q, plans)`. The
   * adapter owns embedding, KNN, ranking, per-record collapsing, and
   * recall-determinism semantics; the operation only slices the snapshot.
   * The returned snapshot MUST carry the backend identity captured at build
   * time as `backend_hash` so cursor staleness is decidable on later loads.
   */
  buildSnapshot: (args: {
    q: string;
    perConnectorPlans: SearchSemanticConnectorPlan[];
    isOwner: boolean;
    pageLimit: number;
  }) => Promise<SearchSemanticSnapshot> | SearchSemanticSnapshot;
  /**
   * Format the public `record_url` for one search result. Hosts wire the
   * concrete implementation: native -> `/v1/streams/<stream>/records/<id>`
   * (with `?connector_id=` for owner mode).
   */
  formatRecordUrl: (args: { stream: string; recordKey: string; connectorId: string; isOwner: boolean }) => string;
  /**
   * Capability advertisement; controls cross-stream and score-emission gates.
   */
  getAdvertisement: () => SearchSemanticAdvertisement | null;
  /**
   * Current backend identity hash. Compared against `snapshot.backend_hash`
   * on cursor load; any divergence ⇒ `invalid_cursor`.
   */
  getCurrentBackendIdentity: () => string;
  /**
   * Hydrate `emitted_at` and (optionally) `snippet` for one search hit.
   * Snippet MUST be a verbatim contiguous substring of the matched field's
   * stored value. The operation calls this once per emitted hit so the
   * records-table read stays in the dependency.
   */
  hydrateResult: (args: {
    hit: SearchSemanticSnapshotResult;
    isOwner: boolean;
  }) => Promise<SearchSemanticHydratedResult> | SearchSemanticHydratedResult;
  /**
   * Owner cross-binding fan-out (optional): list every active owner-visible
   * binding. When provided, the operation emits one connector plan per
   * binding so the snapshot's total-order merge fans across bindings.
   */
  listOwnerVisibleBindings?: () => Promise<SearchSemanticOwnerBinding[]> | SearchSemanticOwnerBinding[];
  /**
   * Owner fan-out: list every connector id whose manifest the owner can read.
   *
   * Legacy single-binding-per-connector path. Hosts that support cross-
   * binding fan-in SHOULD additionally implement `listOwnerVisibleBindings`
   * below; when present, the operation uses it and ignores this method.
   */
  listOwnerVisibleConnectorIds: () => Promise<string[]> | string[];
  /**
   * Load a previously-persisted snapshot by id. Returns `null` if the
   * snapshot has expired or never existed.
   */
  loadSnapshot: (snapshotId: string) => Promise<SearchSemanticSnapshot | null> | SearchSemanticSnapshot | null;
  /**
   * Persist a freshly-built snapshot for cursor reuse.
   */
  persistSnapshot: (snapshot: SearchSemanticSnapshot) => Promise<void> | void;
  /**
   * Client cross-binding fan-out (optional). Same semantics as the lexical
   * counterpart: honors grant-scope per-stream constraints, request-time
   * `connection_id` narrowing, and exactly-one auto-select; raises
   * `connection_not_found` / `invalid_argument` on resolution failure.
   */
  resolveClientBindings?: (
    actor: { kind: "client"; grant: SearchSemanticGrant },
    request: { connectionId: string | null }
  ) => Promise<SearchSemanticClientBinding[]> | SearchSemanticClientBinding[];
  /**
   * Client-mode helper: resolve the manifest the supplied client grant
   * applies against. Hosts build this from the bearer token information.
   *
   * Legacy single-binding path. Hosts that support cross-binding fan-in
   * SHOULD additionally implement `resolveClientBindings` below; when
   * present, the operation uses it and ignores this method.
   */
  resolveClientManifest: (actor: {
    kind: "client";
    grant: SearchSemanticGrant;
  }) => Promise<SearchSemanticManifest> | SearchSemanticManifest;
  /**
   * Owner cross-binding fan-out helper (optional): resolve the manifest for
   * one specific binding. When omitted, the operation falls back to
   * `resolveOwnerManifestForConnector(binding.connectorId)`.
   */
  resolveOwnerManifestForBinding?: (
    binding: SearchSemanticOwnerBinding
  ) => Promise<SearchSemanticManifest | null> | SearchSemanticManifest | null;
  /**
   * Owner fan-out helper: return the manifest for one connector, or null to
   * skip it (e.g. broken polyfill manifests).
   */
  resolveOwnerManifestForConnector: (
    connectorId: string
  ) => Promise<SearchSemanticManifest | null> | SearchSemanticManifest | null;
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
  authored_at?: string;
  /**
   * Canonical connection identifier — present whenever the snapshot result
   * captured one. `connector_instance_id` mirrors the same value during the
   * deprecation window so clients can migrate without coordinated cutovers.
   */
  connection_id?: string;
  connector_id: string;
  connector_instance_id?: string;
  /**
   * Owner-facing label for the connection. Emitted only when the snapshot
   * captured a non-placeholder label. Mirrors records-list/detail wire shape.
   */
  display_name?: string;
  emitted_at: string | null;
  matched_fields: string[];
  object: "search_result";
  record_key: string;
  record_url: string;
  /**
   * v1: every hit emits `retrieval_mode: "semantic"`. `lexical_blending` is
   * advertised as `false` in v1 and the operation does not blend.
   */
  retrieval_mode: "semantic";
  score?: { kind: "semantic_distance"; value: number; order: "lower_is_better" };
  snippet?: { field: string; text: string };
  stream: string;
}

export interface SearchSemanticEnvelopeMeta {
  warnings?: Array<{ code: string; param?: string; message?: string }>;
  [extra: string]: unknown;
}

export interface SearchSemanticEnvelope {
  data: SearchSemanticResultItem[];
  has_more: boolean;
  /** Optional canonical `meta` slot; only emitted when warnings are non-empty. */
  meta?: SearchSemanticEnvelopeMeta;
  next_cursor?: string;
  object: "list";
}

export interface SearchSemanticDisclosureData {
  connector_count: number;
  has_more: boolean;
  mode: "owner" | "client";
  query_shape: "search_semantic";
  record_count: number;
}

export interface SearchSemanticOutput {
  /**
   * Pre-shaped `disclosure.served` data block. Hosts merge in `source` and
   * any host-only fields.
   */
  disclosureData: SearchSemanticDisclosureData;
  /**
   * List envelope minus the host-shaped `url` field. Hosts add
   * `url: '/v1/search/semantic'`.
   */
  envelope: SearchSemanticEnvelope;
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
  return err instanceof Error && (err as Error & { code?: unknown }).code === "filter_field_not_in_schema";
}

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
  cursor: string | null;
  filter: unknown;
  filteredStream: string | null;
  limit: number;
  q: string;
  streams: string[] | null;
  warnings: SearchSemanticWarning[];
}

/**
 * Structured warning shape used in `meta.warnings[]`. The canonical
 * `deprecated_alias_used` code is emitted whenever the request reached the
 * operation via the deprecated `connector_instance_id` query alias.
 */
export interface SearchSemanticWarning {
  code: string;
  detail?: Record<string, unknown>;
  message?: string;
  param?: string;
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

/**
 * Canonical warning code for a `limit` that exceeded the advertised maximum
 * page size and was clamped. Mirrors the records-list and lexical/hybrid
 * `limit_clamped` code so REST and MCP clients read one identical identifier
 * across read surfaces.
 */
export const SEARCH_LIMIT_CLAMPED_WARNING_CODE = "limit_clamped";

function deriveSearchConnectionAliasWarnings(query: Record<string, unknown>): SearchSemanticWarning[] {
  const alias = query.connector_instance_id;
  if (typeof alias !== "string" || alias.length === 0) {
    return [];
  }
  return [
    {
      code: SEARCH_CONNECTION_ALIAS_DEPRECATED_WARNING_CODE,
      message: "`connector_instance_id` is deprecated; send `connection_id` instead.",
      param: "connector_instance_id",
    },
  ];
}

function clampLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Derive the structured `limit_clamped` warning for an over-max `limit`.
 * Returns one warning only when the raw `limit` is a finite integer strictly
 * greater than `MAX_LIMIT`; absent / non-positive / unparseable limits fall
 * back to the default and emit nothing (there is no clamp to report). Mirrors
 * the records-list and lexical wire shape.
 */
function deriveLimitClampedWarning(raw: unknown): SearchSemanticWarning[] {
  if (raw === undefined || raw === null || raw === "") {
    return [];
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return [];
  }
  const requested = Math.floor(n);
  if (requested <= MAX_LIMIT) {
    return [];
  }
  return [
    {
      code: SEARCH_LIMIT_CLAMPED_WARNING_CODE,
      detail: { max_limit: MAX_LIMIT, requested_limit: requested },
      message: `Requested limit=${requested} exceeds the maximum page size of ${MAX_LIMIT}; returned at most ${MAX_LIMIT} hits per page. Page forward with the returned cursor.`,
      param: "limit",
    },
  ];
}

function normalizeStreamsParam(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const arr = Array.isArray(raw) ? raw : [raw];
  const cleaned = arr.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length > 0);
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Public-contract param parsing. Mirrors the previous
 * `parseSemanticSearchParams` helper inside `server/search-semantic.js`; the
 * operation owns it now so the native dependency wiring runs the same
 * allowlist, forbidden list, and coupling rules.
 */
export function parseSearchSemanticParams(query: Record<string, unknown>): NormalizedRequestParams {
  for (const key of Object.keys(query)) {
    if (FORBIDDEN_PARAMS.has(key)) {
      throw new SearchSemanticRequestError("invalid_request", `Unsupported query parameter: ${key}`, key);
    }
    if (!ALLOWED_PARAMS.has(key)) {
      throw new SearchSemanticRequestError("invalid_request", `Unsupported query parameter: ${key}`, key);
    }
  }
  const q = typeof query.q === "string" ? query.q : "";
  if (!q) {
    throw new SearchSemanticRequestError("invalid_request", "q is required", "q");
  }
  const limit = clampLimit(query.limit);
  const cursor = typeof query.cursor === "string" && query.cursor ? query.cursor : null;
  const streams = normalizeStreamsParam(query.streams ?? query["streams[]"]);
  const hasFilter = Object.hasOwn(query, "filter");
  if (hasFilter && streams?.length !== 1) {
    throw new SearchSemanticRequestError(
      "invalid_request",
      "filter[...] requires exactly one streams[] value (e.g. ?streams[]=messages&filter[received_at][gte]=...). filter[stream] and filter[connector_id] are not supported.",
      "streams"
    );
  }
  const canonicalConn = query.connection_id;
  const aliasConn = query.connector_instance_id;
  if (
    typeof canonicalConn === "string" &&
    canonicalConn.length > 0 &&
    typeof aliasConn === "string" &&
    aliasConn.length > 0 &&
    canonicalConn !== aliasConn
  ) {
    throw new SearchSemanticRequestError(
      "invalid_argument",
      "connection_id and connector_instance_id refer to the same connection. Send only `connection_id` (canonical) or supply matching values.",
      "connector_instance_id"
    );
  }
  return {
    cursor,
    filter: hasFilter ? query.filter : null,
    // biome-ignore lint/style/noNonNullAssertion: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    filteredStream: hasFilter && streams && streams.length > 0 ? streams[0]! : null,
    limit,
    q,
    streams,
    warnings: [...deriveSearchConnectionAliasWarnings(query), ...deriveLimitClampedWarning(query.limit)],
  };
}

interface CursorPayload {
  off: number;
  snap: string;
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
    return { off: parsed.off, snap: parsed.snap };
  } catch {
    return null;
  }
}

function advertisesSemanticScore(advertisement: SearchSemanticAdvertisement | null): boolean {
  return !!(
    advertisement &&
    advertisement.supported !== false &&
    advertisement.score?.supported === true &&
    advertisement.score.kind === "semantic_distance" &&
    advertisement.score.order === "lower_is_better"
  );
}

async function buildResultItem(
  hit: SearchSemanticSnapshotResult,
  isOwner: boolean,
  emitScore: boolean,
  hydrate: SearchSemanticDependencies["hydrateResult"],
  formatRecordUrl: SearchSemanticDependencies["formatRecordUrl"]
): Promise<SearchSemanticResultItem> {
  const hydrated = await hydrate({ hit, isOwner });
  const item: SearchSemanticResultItem = {
    connector_id: hit.connectorId,
    emitted_at: hydrated.emittedAt ?? null,
    matched_fields: hit.matchedFields,
    object: "search_result",
    record_key: hit.recordKey,
    record_url: formatRecordUrl({
      connectorId: hit.connectorId,
      isOwner,
      recordKey: hit.recordKey,
      stream: hit.stream,
    }),
    retrieval_mode: "semantic",
    stream: hit.stream,
  };
  if (typeof hydrated.authoredAt === "string" && hydrated.authoredAt.length > 0) {
    item.authored_at = hydrated.authoredAt;
  }
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
      order: "lower_is_better",
      value: hit.distance,
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
export async function executeSearchSemantic(
  input: SearchSemanticInput,
  dependencies: SearchSemanticDependencies
): Promise<SearchSemanticOutput> {
  // 1. Strict v1 allowlist + forbidden list + required `q` + `filter[...]`
  //    coupling.
  const params = parseSearchSemanticParams(input.query);

  // 2. Cross-stream advertisement gate: when capability says cross-stream
  //    search is disabled, `streams[]` becomes mandatory.
  const advertisement = dependencies.getAdvertisement();
  if (advertisement && advertisement.cross_stream === false && (!params.streams || params.streams.length === 0)) {
    throw new SearchSemanticRequestError(
      "invalid_request",
      "streams[] is required when cross_stream search is disabled",
      "streams"
    );
  }

  const isOwner = input.actor.kind === "owner";
  const mode: "owner" | "client" = isOwner ? "owner" : "client";

  // 3. Per-mode planning fan-out.
  const perConnectorPlans: SearchSemanticConnectorPlan[] = [];
  // Track owner-fan-out *sources* skipped without failing the request
  // (broken manifest, empty searchable plan). Each entry optionally carries
  // `connection_id` when the skipped unit is one binding under a connector
  // rather than the whole connector. These become
  // `source_skipped_not_applicable` warnings so the envelope is honest.
  const skippedSources: Array<{ source: string; connection_id?: string }> = [];
  const requestConnectionId =
    typeof input.query.connection_id === "string" && input.query.connection_id.length > 0
      ? input.query.connection_id
      : // biome-ignore lint/style/noNestedTernary: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
        typeof input.query.connector_instance_id === "string" && input.query.connector_instance_id.length > 0
        ? input.query.connector_instance_id
        : null;
  if (input.actor.kind === "owner") {
    if (typeof dependencies.listOwnerVisibleBindings === "function") {
      const bindings = await dependencies.listOwnerVisibleBindings();
      const narrowedBindings = requestConnectionId
        ? bindings.filter((b) => b.connectorInstanceId === requestConnectionId)
        : bindings;
      if (requestConnectionId && narrowedBindings.length === 0) {
        throw new SearchSemanticRequestError(
          "connection_not_found",
          `connection_id '${requestConnectionId}' is not addressable for this owner.`,
          "connection_id"
        );
      }
      for (const binding of narrowedBindings) {
        const manifest =
          typeof dependencies.resolveOwnerManifestForBinding === "function"
            ? // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
              await dependencies.resolveOwnerManifestForBinding(binding)
            : await dependencies.resolveOwnerManifestForConnector(binding.connectorId);
        if (!manifest) {
          skippedSources.push({
            connection_id: binding.connectorInstanceId,
            source: binding.connectorId,
          });
          continue;
        }
        const grant = dependencies.buildOwnerReadGrantForManifest(manifest);
        let planEntries: SearchSemanticPlanEntry[];
        try {
          planEntries = dependencies.buildSearchPlanForGrant({
            connectorId: binding.connectorId,
            filter: params.filter,
            filteredStream: params.filteredStream,
            grant,
            manifest,
            streamsFilter: params.streams,
          });
        } catch (err) {
          if (!isInvalidQueryError(err)) {
            throw err;
          }
          skippedSources.push({
            connection_id: binding.connectorInstanceId,
            source: binding.connectorId,
          });
          continue;
        }
        if (planEntries.length === 0) {
          skippedSources.push({
            connection_id: binding.connectorInstanceId,
            source: binding.connectorId,
          });
          continue;
        }
        perConnectorPlans.push({
          connectorId: binding.connectorId,
          grant,
          manifest,
          planEntries,
        });
      }
    } else {
      const connectorIds = await dependencies.listOwnerVisibleConnectorIds();
      for (const connectorId of connectorIds) {
        // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
        const manifest = await dependencies.resolveOwnerManifestForConnector(connectorId);
        if (!manifest) {
          skippedSources.push({ source: connectorId });
          continue;
        }
        const grant = dependencies.buildOwnerReadGrantForManifest(manifest);
        let planEntries: SearchSemanticPlanEntry[];
        try {
          planEntries = dependencies.buildSearchPlanForGrant({
            connectorId,
            filter: params.filter,
            filteredStream: params.filteredStream,
            grant,
            manifest,
            streamsFilter: params.streams,
          });
        } catch (err) {
          if (!isInvalidQueryError(err)) {
            throw err;
          }
          skippedSources.push({ source: connectorId });
          continue;
        }
        if (planEntries.length === 0) {
          skippedSources.push({ source: connectorId });
          continue;
        }
        perConnectorPlans.push({ connectorId, grant, manifest, planEntries });
      }
    }
    // Owner-mode `streams[]` is a soft filter: unknown stream names just
    // produce zero hits.
  } else {
    const { grant } = input.actor;
    if (params.streams) {
      const grantedStreamNames = new Set((grant.streams || []).map((s) => s.name));
      for (const s of params.streams) {
        if (!grantedStreamNames.has(s)) {
          throw new SearchSemanticRequestError("grant_stream_not_allowed", `Stream '${s}' not in grant`);
        }
      }
    }
    // source.id is authorization identity, not a local connector key. The
    // host resolves the persisted storage binding and supplies that identity
    // through each binding manifest.
    const connectorId: string | null = null;
    if (typeof dependencies.resolveClientBindings === "function") {
      const clientBindings = await dependencies.resolveClientBindings(
        { grant, kind: "client" },
        { connectionId: requestConnectionId }
      );
      for (const cb of clientBindings) {
        const bindingManifest = cb.manifest as SearchSemanticManifest & {
          connector_id?: string | null;
          storage_binding?: { connector_id?: string | null } | null;
        };
        const bindingConnectorId =
          cb.connectorId ??
          bindingManifest.storage_binding?.connector_id ??
          bindingManifest.connector_id ??
          connectorId;
        const planEntries = dependencies.buildSearchPlanForGrant({
          connectorId: bindingConnectorId,
          filter: params.filter,
          filteredStream: params.filteredStream,
          grant,
          manifest: cb.manifest,
          streamsFilter: params.streams,
        });
        if (planEntries.length === 0) {
          skippedSources.push({
            connection_id: cb.connectorInstanceId,
            source: bindingConnectorId ?? "",
          });
          continue;
        }
        perConnectorPlans.push({
          connectorId: bindingConnectorId,
          grant,
          manifest: cb.manifest,
          planEntries,
        });
      }
    } else {
      const manifest = await dependencies.resolveClientManifest({
        grant,
        kind: "client",
      });
      const planEntries = dependencies.buildSearchPlanForGrant({
        connectorId,
        filter: params.filter,
        filteredStream: params.filteredStream,
        grant,
        manifest,
        streamsFilter: params.streams,
      });
      if (planEntries.length > 0) {
        perConnectorPlans.push({ connectorId, grant, manifest, planEntries });
      }
    }
  }

  // 4. Resolve cursor → snapshot. Fresh request: build & persist; cursor
  //    request: load by id and verify backend identity.
  const authorityKey = searchAuthorityKey({
    actor: input.actor,
    connection_id: requestConnectionId,
    plans: perConnectorPlans.map((plan) => ({
      connector_id: plan.connectorId,
      grant: plan.grant,
      plan_entries: plan.planEntries,
    })),
    query: {
      filter: params.filter,
      filtered_stream: params.filteredStream,
      q: params.q,
      streams: params.streams,
    },
  });
  let snapshot: SearchSemanticSnapshot;
  let snapshotId: string;
  let offset: number;
  if (params.cursor) {
    const decoded = decodeSearchSemanticCursor(params.cursor);
    if (!decoded) {
      throw new SearchSemanticRequestError("invalid_cursor", "Cursor is malformed");
    }
    const loaded = await dependencies.loadSnapshot(decoded.snap);
    if (!loaded) {
      throw new SearchSemanticRequestError("invalid_cursor", "Cursor refers to an expired or unknown snapshot");
    }
    if (loaded.authority_key !== authorityKey || loaded.query !== params.q) {
      throw new SearchSemanticRequestError("invalid_cursor", "Cursor does not match this query and grant authority");
    }
    // Stale-cursor backend-identity check: any divergence ⇒ invalid_cursor.
    // Recomputing under a different model would be dishonest — the spec
    // permits this and the previous native behavior raises the same code.
    const currentBackendIdentity = dependencies.getCurrentBackendIdentity();
    if (loaded.backend_hash !== currentBackendIdentity) {
      throw new SearchSemanticRequestError("invalid_cursor", "Cursor predates a backend identity change");
    }
    snapshot = loaded;
    snapshotId = decoded.snap;
    offset = decoded.off;
  } else {
    // The manifest plan is the serving authority. When it contains no
    // eligible stream (including a stale grant for dormant history), return
    // an empty result without touching vector/index storage or snapshots.
    if (perConnectorPlans.length === 0) {
      snapshot = {
        authority_key: authorityKey,
        backend_hash: dependencies.getCurrentBackendIdentity(),
        query: params.q,
        results: [],
        snapshot_id: "",
      };
      snapshotId = "";
    } else {
      snapshot = await dependencies.buildSnapshot({
        isOwner,
        pageLimit: params.limit,
        perConnectorPlans,
        q: params.q,
      });
      snapshot.authority_key = authorityKey;
      snapshotId = snapshot.snapshot_id;
      await dependencies.persistSnapshot(snapshot);
    }
    offset = 0;
  }

  // 5. Slice the snapshot.
  const allHits = snapshot.results;
  const slice = allHits.slice(offset, offset + params.limit);
  const hasMore = offset + params.limit < allHits.length;
  const nextCursor = hasMore
    ? encodeSearchSemanticCursor({
        off: offset + params.limit,
        snap: snapshotId,
      })
    : null;

  // 6. Shape into `search_result` items. Hydration (emitted_at + snippet)
  //    is delegated to the dependency so the records-table read stays in the
  //    native shell. Score emission is gated by the advertisement.
  const emitScore = advertisesSemanticScore(advertisement);
  const data: SearchSemanticResultItem[] = [];
  for (const hit of slice) {
    // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    data.push(await buildResultItem(hit, isOwner, emitScore, dependencies.hydrateResult, dependencies.formatRecordUrl));
  }

  const skippedWarnings: SearchSemanticWarning[] = skippedSources.map((skipped) => {
    const detail: Record<string, unknown> = { source: skipped.source };
    if (skipped.connection_id) {
      detail.connection_id = skipped.connection_id;
    }
    const subject = skipped.connection_id
      ? `Connection '${skipped.connection_id}' under connector '${skipped.source}'`
      : `Connector '${skipped.source}'`;
    return {
      code: SEARCH_SEMANTIC_SOURCE_SKIPPED_WARNING_CODE,
      detail,
      message: `${subject} is not applicable to this query and was skipped.`,
    };
  });
  const allWarnings: SearchSemanticWarning[] = [...params.warnings, ...skippedWarnings];
  const envelope: SearchSemanticEnvelope = {
    has_more: hasMore,
    object: "list",
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    data,
    ...(allWarnings.length > 0 ? { meta: { warnings: allWarnings } } : {}),
  };

  const disclosureData: SearchSemanticDisclosureData = {
    connector_count: perConnectorPlans.length,
    has_more: hasMore,
    mode,
    query_shape: "search_semantic",
    record_count: data.length,
  };

  return { disclosureData, envelope };
}
