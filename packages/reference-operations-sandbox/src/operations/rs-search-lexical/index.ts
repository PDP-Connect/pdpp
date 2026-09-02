// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 *     `data[]`, `meta`); hosts add the host-shaped `url` field. `meta` always
 *     carries `count` / `count_accuracy` / `recall` recall disclosure (see
 *     openspec/changes/disclose-lexical-recall-windows) plus optional
 *     structured `warnings[]`;
 *   - `disclosure.served` data block.
 */

// ─── Errors ────────────────────────────────────────────────────────────────

import { searchAuthorityKey } from "../search-authority-key.ts";

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
  fields?: string[];
  instance_ids?: string[];
  name: string;
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
  cross_stream?: boolean;
  default_limit?: number;
  max_limit?: number;
  score?: {
    supported?: boolean;
    kind?: string;
    order?: string;
    value_semantics?: string;
  };
  snippets?: boolean;
  supported?: boolean;
  [extra: string]: unknown;
}

/**
 * One per-connector plan entry. The shape is opaque to the operation; only
 * `streamName` and `searchableFields` are read for emptiness checks. Adapter
 * helpers (FTS5, fixture matcher) carry whatever extra fields they need
 * through the plan back into the snapshot builder.
 */
export interface SearchLexicalPlanEntry {
  searchableFields: string[];
  streamName: string;
  [extra: string]: unknown;
}

export interface SearchLexicalConnectorPlan {
  connectorId: string | null;
  grant: SearchLexicalGrant;
  manifest: SearchLexicalManifest;
  planEntries: SearchLexicalPlanEntry[];
}

/**
 * One snapshot result carrying the data needed to shape a `search_result`
 * envelope. `score` is the raw adapter score; the operation emits it only
 * when the advertisement gates score emission.
 */
export interface SearchLexicalSnapshotResult {
  authoredAt?: string | null;
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
  emittedAt: string;
  matchedFields: string[];
  recordKey: string;
  score?: number;
  snippet?: { field: string; text: string } | null;
  stream: string;
  [extra: string]: unknown;
}

/**
 * Count-accuracy grade for the caller-visible match count.
 *
 * - `exact`: `count` is the exact number of caller-visible matching candidates.
 * - `lower_bound`: `count` is a minimum; additional matches may exist (e.g. a
 *   bounded candidate window truncated at least one source).
 * - `estimated`: `count` is approximate.
 * - `not_counted`: the server did not compute a count; `count` is `null`.
 */
export type SearchLexicalCountAccuracy = "exact" | "lower_bound" | "estimated" | "not_counted";

export type SearchLexicalRankingScope = "all_matches" | "candidate_window" | "unknown";

/**
 * Response-level recall disclosure. Describes the ranking *input* — whether the
 * implementation ranked all known caller-visible matches or a bounded subset —
 * which is distinct from `has_more` (a property of the current paginated set).
 *
 * Compact window facts (`ranked_candidate_count`, `candidate_window_limit`,
 * `sources_searched_count`, `truncated_source_count`) are response-level
 * aggregates, never a per-source dump. An implementation MUST omit any fact it
 * cannot prove cheaply and MUST NOT fabricate a fact to look more complete.
 */
export interface SearchLexicalRecallMeta {
  /** Per-source candidate cap that produced the window, when one applies. */
  candidate_window_limit?: number;
  /**
   * `true` ⇒ the implementation ranked all known caller-visible matches for
   * the query before pagination. `false` ⇒ additional caller-visible matches
   * may exist outside the ranked set.
   */
  complete: boolean;
  /** Number of caller-visible candidates the implementation actually ranked. */
  ranked_candidate_count?: number;
  ranking_scope: SearchLexicalRankingScope;
  /** Count of caller-visible sources that were searched under this query. */
  sources_searched_count?: number;
  /**
   * `true` ⇒ an implementation-applied candidate or source window prevented
   * the ranked set from representing every caller-visible match.
   */
  truncated: boolean;
  /** Count of searched sources whose candidate set was truncated by the cap. */
  truncated_source_count?: number;
}

/**
 * Recall/count facts an adapter `buildSnapshot` MAY attach to the snapshot so
 * cursor pages reuse them verbatim instead of inferring completeness from
 * `has_more`. When absent, the operation emits an honest `not_counted` /
 * `unknown` envelope rather than guessing.
 */
export interface SearchLexicalSnapshotRecall {
  count: number | null;
  count_accuracy: SearchLexicalCountAccuracy;
  recall: SearchLexicalRecallMeta;
}

export interface SearchLexicalSnapshot {
  authority_key?: string;
  query: string;
  /**
   * Operation-level recall/count disclosure for the *whole* ranked set. The
   * preferred durable seam: the snapshot owns it so every page (fresh or
   * cursor-loaded) reports the same recall facts. Adapters that cannot prove
   * recall MAY omit it; the operation then emits `not_counted` / `unknown`.
   */
  recall_meta?: SearchLexicalSnapshotRecall;
  results: SearchLexicalSnapshotResult[];
  snapshot_id: string;
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
  connectorInstanceId: string;
  displayName?: string | null;
  manifest: SearchLexicalManifest;
}

export interface SearchLexicalDependencies {
  /**
   * Owner fan-out helper: build a synthetic owner read-grant covering every
   * stream of `manifest`. Adapter decides field-set semantics (typically
   * `fields = undefined ⇒ all fields authorized`).
   */
  buildOwnerReadGrantForManifest: (manifest: SearchLexicalManifest) => SearchLexicalGrant;
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
  buildSearchPlanForGrant: (args: {
    manifest: SearchLexicalManifest;
    grant: SearchLexicalGrant;
    streamsFilter: string[] | null;
    filter: unknown;
    filteredStream: string | null;
    connectorId: string | null;
  }) => SearchLexicalPlanEntry[];
  /**
   * Build a snapshot of the fully-ranked result set for `(q, plans)`. The
   * adapter owns FTS5/ranking/snippet semantics; the operation only slices
   * the snapshot.
   */
  buildSnapshot: (args: {
    q: string;
    perConnectorPlans: SearchLexicalConnectorPlan[];
    isOwner: boolean;
  }) => Promise<SearchLexicalSnapshot> | SearchLexicalSnapshot;
  /**
   * Format the public `record_url` for one search result. Hosts wire the
   * concrete implementation: native -> `/v1/streams/<stream>/records/<id>`
   * (with `?connector_id=` for owner mode); sandbox ->
   * `/sandbox/v1/streams/<stream>/records/<id>`.
   */
  formatRecordUrl: (args: { stream: string; recordKey: string; connectorId: string; isOwner: boolean }) => string;
  /**
   * Capability advertisement; controls cross-stream and score-emission gates.
   */
  getAdvertisement: () => SearchLexicalAdvertisement | null;
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
  listOwnerVisibleBindings?: () => Promise<SearchLexicalOwnerBinding[]> | SearchLexicalOwnerBinding[];
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
  loadSnapshot: (snapshotId: string) => Promise<SearchLexicalSnapshot | null> | SearchLexicalSnapshot | null;
  /**
   * Persist a freshly-built snapshot for cursor reuse.
   */
  persistSnapshot: (snapshot: SearchLexicalSnapshot) => Promise<void> | void;
  /**
   * Client cross-binding fan-out (optional): resolve the set of bindings the
   * grant authorizes. Each entry carries a manifest pinned to one binding
   * plus the binding's canonical `connection_id`. The operation emits one
   * connector plan per binding.
   *
   * Implementations MUST honor:
   *   - grant-scope per-stream `instance_ids` authority;
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
    request: { connectionId: string | null }
  ) => Promise<SearchLexicalClientBinding[]> | SearchLexicalClientBinding[];
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
    grant: SearchLexicalGrant;
  }) => Promise<SearchLexicalManifest> | SearchLexicalManifest;
  /**
   * Owner cross-binding fan-out helper (optional): resolve the manifest for
   * one specific binding. Used in conjunction with
   * `listOwnerVisibleBindings`. When omitted, the operation falls back to
   * `resolveOwnerManifestForConnector(binding.connectorId)`.
   */
  resolveOwnerManifestForBinding?: (
    binding: SearchLexicalOwnerBinding
  ) => Promise<SearchLexicalManifest | null> | SearchLexicalManifest | null;
  /**
   * Owner fan-out helper: return the manifest for one connector, or null to
   * skip it (e.g. broken polyfill manifests).
   */
  resolveOwnerManifestForConnector: (
    connectorId: string
  ) => Promise<SearchLexicalManifest | null> | SearchLexicalManifest | null;
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
   * captured a non-placeholder label. Wire shape mirrors records-list and
   * records-detail so REST/MCP/dashboard/CLI consumers see identity in one
   * uniform form across read surfaces.
   */
  display_name?: string;
  emitted_at: string;
  evidence_excerpts?: SearchLexicalEvidenceExcerpt[];
  matched_fields: string[];
  object: "search_result";
  record_key: string;
  record_url: string;
  score?: { kind: "bm25"; value: number; order: "lower_is_better" };
  snippet?: { field: string; text: string };
  stream: string;
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
  detail?: Record<string, unknown>;
  message?: string;
  param?: string;
}

export interface SearchLexicalEvidenceExcerptRead {
  connection_id?: string;
  field: string;
  method: "GET";
  object: "field_window_read";
  record_id: string;
  route: string;
  stream: string;
}

export interface SearchLexicalEvidenceExcerpt {
  field_path: string;
  object: "evidence_excerpt";
  preview_text: string;
  provenance: "lexical_match";
  /**
   * Bounded read continuation for the matched field. A REST/CLI client can
   * follow this to read the full field window without exporting the record;
   * the MCP adapter maps it to a `read_record_field` tool call. This keeps a
   * visible search excerpt from being a dead end on any surface.
   */
  read?: SearchLexicalEvidenceExcerptRead;
  truncated: boolean;
}

export interface SearchLexicalEnvelopeMeta {
  /**
   * Caller-visible match count. `null` when `count_accuracy` is
   * `not_counted`. Interpreted by `count_accuracy`; never read in isolation.
   */
  count?: number | null;
  count_accuracy?: SearchLexicalCountAccuracy;
  /** Response-level recall disclosure (see {@link SearchLexicalRecallMeta}). */
  recall?: SearchLexicalRecallMeta;
  warnings?: SearchLexicalWarning[];
  [extra: string]: unknown;
}

export interface SearchLexicalEnvelope {
  data: SearchLexicalResultItem[];
  has_more: boolean;
  /** Optional canonical `meta` slot; only emitted when warnings are non-empty. */
  meta?: SearchLexicalEnvelopeMeta;
  next_cursor?: string;
  object: "list";
}

export interface SearchLexicalDisclosureData {
  connector_count: number;
  has_more: boolean;
  mode: "owner" | "client";
  query_shape: "search";
  record_count: number;
}

export interface SearchLexicalOutput {
  /**
   * Pre-shaped `disclosure.served` data block. Hosts merge in `source` and
   * any host-only fields.
   */
  disclosureData: SearchLexicalDisclosureData;
  /**
   * List envelope minus the host-shaped `url` field. Hosts add
   * `url: '/v1/search'` (native) or `url: '/sandbox/v1/search'` (sandbox).
   */
  envelope: SearchLexicalEnvelope;
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
  cursor: string | null;
  filter: unknown;
  filteredStream: string | null;
  limit: number;
  q: string;
  streams: string[] | null;
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

function deriveSearchConnectionAliasWarnings(query: Record<string, unknown>): SearchLexicalWarning[] {
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
 * Public-contract param parsing. Mirrors the previous `parseSearchParams`
 * helper inside `server/search.js`; the operation owns it now so both the
 * native dependency wiring and the sandbox host run the same allowlist and
 * coupling rules.
 */
export function parseSearchLexicalParams(query: Record<string, unknown>): NormalizedRequestParams {
  for (const key of Object.keys(query)) {
    if (!ALLOWED_PARAMS.has(key)) {
      throw new SearchLexicalRequestError("invalid_request", `Unsupported query parameter: ${key}`, key);
    }
  }
  const q = typeof query.q === "string" ? query.q : "";
  if (!q) {
    throw new SearchLexicalRequestError("invalid_request", "q is required", "q");
  }
  const limit = clampLimit(query.limit);
  const cursor = typeof query.cursor === "string" && query.cursor ? query.cursor : null;
  const streams = normalizeStreamsParam(query.streams ?? query["streams[]"]);
  const hasFilter = Object.hasOwn(query, "filter");
  if (hasFilter && streams?.length !== 1) {
    throw new SearchLexicalRequestError(
      "invalid_request",
      "filter[...] requires exactly one streams[] value (e.g. ?streams[]=messages&filter[received_at][gte]=...). filter[stream] and filter[connector_id] are not supported.",
      "streams"
    );
  }
  validateSearchConnectionAlias(query, SearchLexicalRequestError);
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

/**
 * Shared alias-conflict check for search operations. `connection_id` is the
 * canonical public identifier; `connector_instance_id` is the deprecated wire
 * alias. Both MAY be sent but MUST carry the same opaque value. Mismatched
 * values are rejected with a typed `invalid_argument` error so clients learn
 * before shipping divergent identity assumptions.
 */
function validateSearchConnectionAlias(
  query: Record<string, unknown>,
  ErrorCtor: typeof SearchLexicalRequestError
): void {
  const canonical = query.connection_id;
  const alias = query.connector_instance_id;
  const canonicalSet = typeof canonical === "string" && canonical.length > 0;
  const aliasSet = typeof alias === "string" && alias.length > 0;
  if (canonicalSet && aliasSet && canonical !== alias) {
    throw new ErrorCtor(
      "invalid_argument",
      "connection_id and connector_instance_id refer to the same connection. Send only `connection_id` (canonical) or supply matching values.",
      "connector_instance_id"
    );
  }
}

interface CursorPayload {
  off: number;
  snap: string;
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
    return { off: parsed.off, snap: parsed.snap };
  } catch {
    return null;
  }
}

/**
 * Resolve the response-level recall/count disclosure for a snapshot.
 *
 * When the adapter attached `snapshot.recall_meta`, the operation trusts it
 * verbatim (the adapter owns ranking and is the only honest source of
 * truncation facts). When it is absent — older adapters, test shims, or
 * implementations that cannot prove recall cheaply — the operation emits an
 * honest "I don't know" envelope (`not_counted` / `unknown`) rather than
 * inferring completeness from `has_more` or the hit count, which would be a
 * lie about the ranking input.
 */
function resolveEnvelopeRecall(snapshot: SearchLexicalSnapshot): SearchLexicalSnapshotRecall {
  const provided = snapshot.recall_meta;
  if (provided) {
    return provided;
  }
  return {
    count: null,
    count_accuracy: "not_counted",
    recall: {
      complete: false,
      ranking_scope: "unknown",
      truncated: false,
    },
  };
}

function advertisesScore(advertisement: SearchLexicalAdvertisement | null): boolean {
  return !!(
    advertisement &&
    advertisement.supported !== false &&
    advertisement.score?.supported === true &&
    advertisement.score.kind === "bm25" &&
    advertisement.score.order === "lower_is_better"
  );
}

function buildResultItem(
  hit: SearchLexicalSnapshotResult,
  isOwner: boolean,
  emitScore: boolean,
  formatRecordUrl: SearchLexicalDependencies["formatRecordUrl"]
): SearchLexicalResultItem {
  const item: SearchLexicalResultItem = {
    connector_id: hit.connectorId,
    emitted_at: hit.emittedAt,
    matched_fields: hit.matchedFields,
    object: "search_result",
    record_key: hit.recordKey,
    record_url: formatRecordUrl({
      connectorId: hit.connectorId,
      isOwner,
      recordKey: hit.recordKey,
      stream: hit.stream,
    }),
    stream: hit.stream,
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
    item.evidence_excerpts = buildEvidenceExcerpts(hit);
  }
  if (emitScore && typeof hit.score === "number" && Number.isFinite(hit.score)) {
    item.score = {
      kind: "bm25",
      order: "lower_is_better",
      value: hit.score,
    };
  }
  return item;
}

function buildEvidenceExcerpts(hit: SearchLexicalSnapshotResult): SearchLexicalEvidenceExcerpt[] {
  if (!hit.snippet) {
    return [];
  }
  // biome-ignore lint/style/useDestructuring: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const field = hit.snippet.field;
  const read: SearchLexicalEvidenceExcerptRead = {
    field,
    method: "GET",
    object: "field_window_read",
    record_id: hit.recordKey,
    route: `/v1/streams/${encodeURIComponent(hit.stream)}/records/${encodeURIComponent(hit.recordKey)}/field-window`,
    stream: hit.stream,
    ...(hit.connectorInstanceId ? { connection_id: hit.connectorInstanceId } : {}),
  };
  return [
    {
      field_path: field,
      object: "evidence_excerpt",
      preview_text: hit.snippet.text,
      provenance: "lexical_match",
      read,
      truncated: true,
    },
  ];
}

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * Execute the canonical `rs.search.lexical` operation.
 *
 * The operation does not mutate `input.query`; it parses and normalizes a
 * fresh request-params object internally.
 */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
export async function executeSearchLexical(
  input: SearchLexicalInput,
  dependencies: SearchLexicalDependencies
): Promise<SearchLexicalOutput> {
  // 1. Strict v1 allowlist + required `q` + `filter[...]` coupling.
  const params = parseSearchLexicalParams(input.query);

  // 2. Cross-stream advertisement gate: when capability says cross-stream
  //    search is disabled, `streams[]` becomes mandatory.
  const advertisement = dependencies.getAdvertisement();
  if (advertisement && advertisement.cross_stream === false && (!params.streams || params.streams.length === 0)) {
    throw new SearchLexicalRequestError(
      "invalid_request",
      "streams[] is required when cross_stream search is disabled",
      "streams"
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
      : // biome-ignore lint/style/noNestedTernary: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
        typeof input.query.connector_instance_id === "string" && input.query.connector_instance_id.length > 0
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
          "connection_id"
        );
      }
      // Skipped (out-of-scope under request-time narrowing) bindings do NOT
      // become warnings — narrowing is the caller's explicit ask.
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
        let planEntries: SearchLexicalPlanEntry[];
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
      // Legacy single-binding-per-connector path (sandbox host, older test
      // shims). Preserves prior behavior so existing dependency wirings keep
      // working unchanged.
      const connectorIds = await dependencies.listOwnerVisibleConnectorIds();
      for (const connectorId of connectorIds) {
        // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
        const manifest = await dependencies.resolveOwnerManifestForConnector(connectorId);
        if (!manifest) {
          skippedSources.push({ source: connectorId });
          continue;
        }
        const grant = dependencies.buildOwnerReadGrantForManifest(manifest);
        let planEntries: SearchLexicalPlanEntry[];
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
          throw new SearchLexicalRequestError("grant_stream_not_allowed", `Stream '${s}' not in grant`);
        }
      }
    }
    // source.id is authorization identity, not a local connector key. The
    // host resolves the persisted storage binding and supplies that identity
    // through each binding manifest.
    const connectorId: string | null = null;
    // Cross-binding fan-in path for client mode. When the host wires the
    // binding-aware resolver, the operation iterates every binding the grant
    // authorizes (after narrowing) and emits one connector plan per binding.
    // The resolver MUST raise `connection_not_found` for narrowing failures
    // and `invalid_argument` for alias conflicts — the operation does not
    // re-implement those checks.
    if (typeof dependencies.resolveClientBindings === "function") {
      const clientBindings = await dependencies.resolveClientBindings(
        { grant, kind: "client" },
        { connectionId: requestConnectionId }
      );
      for (const cb of clientBindings) {
        const planEntries = dependencies.buildSearchPlanForGrant({
          connectorId,
          filter: params.filter,
          filteredStream: params.filteredStream,
          grant,
          manifest: cb.manifest,
          streamsFilter: params.streams,
        });
        if (planEntries.length === 0) {
          skippedSources.push({
            connection_id: cb.connectorInstanceId,
            source: connectorId ?? "",
          });
          continue;
        }
        perConnectorPlans.push({
          connectorId,
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
  //    request: load by id.
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
  let snapshot: SearchLexicalSnapshot;
  let snapshotId: string;
  let offset: number;
  if (params.cursor) {
    const decoded = decodeSearchLexicalCursor(params.cursor);
    if (!decoded) {
      throw new SearchLexicalRequestError("invalid_cursor", "Cursor is malformed");
    }
    const loaded = await dependencies.loadSnapshot(decoded.snap);
    if (!loaded) {
      throw new SearchLexicalRequestError("invalid_cursor", "Cursor refers to an expired or unknown snapshot");
    }
    if (loaded.authority_key !== authorityKey || loaded.query !== params.q) {
      throw new SearchLexicalRequestError("invalid_cursor", "Cursor does not match this query and grant authority");
    }
    snapshot = loaded;
    snapshotId = decoded.snap;
    offset = decoded.off;
  } else {
    // No eligible manifest stream means no storage or index operation is
    // authorized. In particular, a stale grant may still name a now-dormant
    // stream; planner omission must short-circuit before the host adapter can
    // scan records or FTS state.
    if (perConnectorPlans.length === 0) {
      snapshot = { authority_key: authorityKey, query: params.q, results: [], snapshot_id: "" };
      snapshotId = "";
    } else {
      snapshot = await dependencies.buildSnapshot({
        isOwner,
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
  const nextCursor = hasMore ? encodeSearchLexicalCursor({ off: offset + params.limit, snap: snapshotId }) : null;

  // 6. Shape into `search_result` items. Score emission is gated by the
  //    advertisement.
  const emitScore = advertisesScore(advertisement);
  const data = slice.map((hit) => buildResultItem(hit, isOwner, emitScore, dependencies.formatRecordUrl));

  const skippedWarnings: SearchLexicalWarning[] = skippedSources.map((skipped) => {
    const detail: Record<string, unknown> = { source: skipped.source };
    if (skipped.connection_id) {
      detail.connection_id = skipped.connection_id;
    }
    const subject = skipped.connection_id
      ? `Connection '${skipped.connection_id}' under connector '${skipped.source}'`
      : `Connector '${skipped.source}'`;
    return {
      code: SEARCH_SOURCE_SKIPPED_WARNING_CODE,
      detail,
      message: `${subject} is not applicable to this query and was skipped.`,
    };
  });
  const allWarnings: SearchLexicalWarning[] = [...params.warnings, ...skippedWarnings];
  // Recall/count disclosure is a property of the whole ranked snapshot, not of
  // the current page, so it is identical across fresh and cursor-loaded pages
  // and is never inferred from `has_more`. It is always present so a client can
  // distinguish a complete exact search from a bounded-window one on every page.
  const { count, count_accuracy, recall } = resolveEnvelopeRecall(snapshot);
  const envelope: SearchLexicalEnvelope = {
    has_more: hasMore,
    object: "list",
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    data,
    meta: {
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
      count,
      count_accuracy,
      recall,
    },
  };

  const disclosureData: SearchLexicalDisclosureData = {
    connector_count: perConnectorPlans.length,
    has_more: hasMore,
    mode,
    query_shape: "search",
    record_count: data.length,
  };

  return { disclosureData, envelope };
}
