/**
 * Canonical `rs.search.hybrid` operation.
 *
 * Owns the public-contract slice of `GET /v1/search/hybrid` independent of
 * HTTP framework, sandbox UI, concrete database driver, the native
 * `server/search.js` lexical helper module, the native `server/search-semantic.js`
 * helper module, the native `server/search-hybrid.js` helper module, and
 * `process.env`. The native Fastify route mounts this operation through the
 * `runHybridSearch` shell in `server/search-hybrid.js`, which composes the
 * existing `runLexicalSearch` / `runSemanticSearch` runners under the same
 * grant and hands their per-source result lists to `executeSearchHybrid` as
 * capability dependencies. Grant enforcement, plan compilation, snapshot
 * orchestration, ranking, and snippet hydration stay inside the underlying
 * lexical and semantic runners — hybrid does NOT duplicate them.
 *
 * Boundary rules (see openspec/changes/mount-rs-search-hybrid-operation):
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, the native
 *   `server/search.js` helper module, the native `server/search-semantic.js`
 *   helper module, the native `server/search-hybrid.js` helper module, or
 *   `process` / `process.env`. The lexical and semantic helper import bans
 *   are load-bearing: this operation SHALL NOT itself reach into either
 *   underlying retrieval surface; it consumes already-grant-filtered
 *   per-source result envelopes through capability dependencies.
 * - Grant enforcement, plan compilation, snapshot build, snapshot
 *   persistence, ranking, snippet hydration, manifest/grant resolution, and
 *   record-url formatting stay behind the underlying lexical and semantic
 *   runners. The operation does not look at adapter internals.
 *
 * What the operation owns (the host-independent public-contract slice):
 *   - strict v1 query-param allowlist (`q`, `limit`, `streams`, `streams[]`,
 *     `filter`); rejects unknown keys with `invalid_request`;
 *   - explicit `cursor` rejection (v1 hybrid does NOT support cursor
 *     pagination — see module header in `server/search-hybrid.js`); raised
 *     as `invalid_request` with `param: 'cursor'`. This is intentionally
 *     stricter than the lexical/semantic surfaces, which DO support cursor;
 *   - explicit forbidden-parameter list (`vector`, `embedding`, `embed`,
 *     `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`,
 *     `blend`, `connector_id`, `fields`, `expand`, `expand[]`,
 *     `expand_limit`, `expand_limit[]`, `order`, `sort`, `mode`); each
 *     rejected with `invalid_request` and `param: <key>`;
 *   - `q` non-empty required;
 *   - `limit` clamp (default 25, min 1, max 100);
 *   - `streams[]` normalization (string or array, trim, drop empty);
 *   - `filter[...]` requires exactly one `streams[]` value;
 *   - per-source result fan-out via the lexical and semantic runner
 *     dependencies, both invoked under the same grant the host has already
 *     authenticated (the runners enforce advertisement, grant projection,
 *     stream-grant intersection, field-grant intersection, and any
 *     record-level grant constraints — hybrid does NOT re-implement them);
 *   - round-robin merge of the two per-source result lists, preserving
 *     per-source rank order so neither surface dominates the first page;
 *   - dedup by `(connector_id, stream, record_key)`; on overlap, the
 *     operation unions `matched_fields` (lexical-first discovery order),
 *     unions per-source scores into a `scores` map keyed by source name,
 *     and keeps the first non-empty snippet encountered (lexical snippets
 *     are highlighted; semantic snippets are verbatim excerpts; either is
 *     informative; the operation does not invent a combined one);
 *   - `search_result` shaping with `retrieval_mode: "hybrid"` and an
 *     explicit `retrieval_sources` provenance list (subset of
 *     `["lexical", "semantic"]`, in lexical-first order); per-source
 *     `score` objects are forwarded verbatim under `scores` so each surface
 *     keeps its own kind/order/value semantics;
 *   - list-envelope shape (`object: 'list'`, `has_more`, `data[]`); v1
 *     hybrid intentionally omits `next_cursor` — see cursor rejection
 *     above. Hosts add the host-shaped `url` field;
 *   - `disclosure.served` data block (`query_shape: 'search_hybrid'`,
 *     `record_count`, `has_more`, `mode`, `lexical_count`,
 *     `semantic_count`).
 */

// ─── Errors ────────────────────────────────────────────────────────────────

export type SearchHybridErrorCode = "invalid_request";

/**
 * Error thrown when the request itself is invalid in a host-independent way.
 * Hosts map `code` (and `param` where present) into their existing error
 * envelopes.
 */
export class SearchHybridRequestError extends Error {
  readonly code: SearchHybridErrorCode;
  readonly param?: string;

  constructor(code: SearchHybridErrorCode, message: string, param?: string) {
    super(message);
    this.name = "SearchHybridRequestError";
    this.code = code;
    if (param !== undefined) {
      this.param = param;
    }
  }
}

// ─── Public types ──────────────────────────────────────────────────────────

export type SearchHybridActor =
  | { kind: "owner"; subject_id: string | null }
  | {
      kind: "client";
      subject_id: string | null;
      client_id: string | null;
      grant_id: string | null;
    };

/**
 * One per-source search result item, as produced by the underlying lexical
 * or semantic runner. The operation reads `connector_id`, `stream`,
 * `record_key`, `record_url`, `emitted_at`, `matched_fields`, `snippet`, and
 * `score`. Adapter-specific fields are preserved on `[extra]` but never read
 * — they do not propagate onto the merged hybrid envelope.
 */
export interface SearchHybridSourceResult {
  object: "search_result";
  stream: string;
  record_key: string;
  connector_id: string;
  record_url: string;
  emitted_at: string | null;
  matched_fields: string[];
  snippet?: { field: string; text: string };
  /**
   * Per-source score object (e.g. `{kind: "bm25", value, order: ...}` for
   * lexical hits, `{kind: "semantic_distance", value, order: ...}` for
   * semantic hits). The operation forwards this verbatim under
   * `scores[source]` so each surface keeps its own value semantics.
   */
  score?: { kind: string; value: number; order: string };
  [extra: string]: unknown;
}

/**
 * Per-source result envelope, as returned by `runLexicalSearch` /
 * `runSemanticSearch`. The operation reads `data[]` only; `has_more` and
 * other fields are ignored — v1 hybrid does NOT honor underlying
 * `next_cursor`s and does NOT publish a hybrid `next_cursor`.
 */
export interface SearchHybridSourceEnvelope {
  data: SearchHybridSourceResult[];
  [extra: string]: unknown;
}

export interface SearchHybridSourceOutput {
  envelope: SearchHybridSourceEnvelope;
  [extra: string]: unknown;
}

export interface SearchHybridSubRequestParams {
  q: string;
  limit: number;
  streams: string[] | null;
  filter: unknown;
}

export interface SearchHybridDependencies {
  /**
   * Run the underlying lexical search under the caller's grant, returning
   * the per-source result envelope. Implementations MUST honor the same
   * grant, advertisement, and filter rules they would on a direct
   * `/v1/search` call. The hybrid operation passes the parsed sub-request
   * params verbatim — it does NOT re-implement grant enforcement.
   *
   * Errors thrown by the runner (e.g. `grant_stream_not_allowed`) propagate
   * unchanged — hybrid behaves identically to calling the underlying
   * endpoint for the same grant.
   */
  runLexical(
    params: SearchHybridSubRequestParams,
  ): Promise<SearchHybridSourceOutput> | SearchHybridSourceOutput;
  /**
   * Run the underlying semantic search under the caller's grant. Same
   * contract as `runLexical` — the operation forwards the parsed
   * sub-request params verbatim and the runner enforces advertisement,
   * grant projection, and field gating.
   */
  runSemantic(
    params: SearchHybridSubRequestParams,
  ): Promise<SearchHybridSourceOutput> | SearchHybridSourceOutput;
}

export interface SearchHybridInput {
  actor: SearchHybridActor;
  /**
   * Raw request query object. The operation runs the v1 allowlist,
   * cursor rejection, forbidden-parameter list, and normalization against
   * this object. Hosts should pass the parsed query-string object their
   * framework produces (Fastify `req.query`, URLSearchParams via
   * Object.fromEntries, etc.) without normalizing `streams[]`/`filter[...]`
   * shapes — those are operation concerns.
   */
  query: Record<string, unknown>;
}

export interface SearchHybridResultItem {
  object: "search_result";
  stream: string;
  record_key: string;
  connector_id: string;
  record_url: string;
  emitted_at: string | null;
  matched_fields: string[];
  /**
   * v1: every hybrid hit emits `retrieval_mode: "hybrid"`.
   */
  retrieval_mode: "hybrid";
  /**
   * Provenance: which underlying retrieval surfaces produced this record.
   * Subset of `["lexical", "semantic"]`, in lexical-first order so the
   * shape is stable across runs.
   */
  retrieval_sources: ("lexical" | "semantic")[];
  snippet?: { field: string; text: string };
  /**
   * Per-source scores keyed by source name. Each value is the per-source
   * score object the underlying runner produced (e.g.
   * `{kind: "bm25", value, order: ...}`); the operation forwards them
   * verbatim, it does NOT normalize across surfaces.
   */
  scores?: Record<string, { kind: string; value: number; order: string }>;
}

export interface SearchHybridEnvelope {
  object: "list";
  has_more: boolean;
  data: SearchHybridResultItem[];
}

export interface SearchHybridDisclosureData {
  query_shape: "search_hybrid";
  record_count: number;
  has_more: boolean;
  mode: "owner" | "client";
  lexical_count: number;
  semantic_count: number;
}

export interface SearchHybridOutput {
  /**
   * List envelope minus the host-shaped `url` field. Hosts add
   * `url: '/v1/search/hybrid'`. v1 hybrid intentionally omits `next_cursor`.
   */
  envelope: SearchHybridEnvelope;
  /**
   * Pre-shaped `disclosure.served` data block. Hosts merge in `source` and
   * any host-only fields.
   */
  disclosureData: SearchHybridDisclosureData;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

const ALLOWED_PARAMS: ReadonlySet<string> = new Set([
  "q",
  "limit",
  "streams",
  "streams[]",
  "filter",
]);

/**
 * Parameters that MUST be rejected explicitly (not silently ignored). Some
 * of these overlap with "anything not in ALLOWED_PARAMS" — the explicit list
 * makes the rejection intentional and visible in source. This list mirrors
 * the previous behavior in `server/search-hybrid.js` plus the explicit
 * forbidden list pinned by the conformance test.
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
  streams: string[] | null;
  filter: unknown;
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
 * Public-contract param parsing. Mirrors the previous `parseHybridSearchParams`
 * helper inside `server/search-hybrid.js`; the operation owns it now so the
 * native dependency wiring runs the same allowlist, cursor rejection,
 * forbidden list, and coupling rules.
 *
 * v1 hybrid pagination choice: NO cursor support. Snapshot-honest hybrid
 * cursors require encoding the combined-source snapshot identity; rather
 * than ship offset-only pagination over two independently changing
 * candidate sets, v1 rejects the `cursor` parameter and advertises
 * `cursor_supported: false`.
 */
export function parseSearchHybridParams(
  query: Record<string, unknown>,
): NormalizedRequestParams {
  for (const key of Object.keys(query)) {
    if (key === "cursor") {
      throw new SearchHybridRequestError(
        "invalid_request",
        "cursor pagination is not supported on /v1/search/hybrid",
        "cursor",
      );
    }
    if (FORBIDDEN_PARAMS.has(key)) {
      throw new SearchHybridRequestError(
        "invalid_request",
        `Unsupported query parameter: ${key}`,
        key,
      );
    }
    if (!ALLOWED_PARAMS.has(key)) {
      throw new SearchHybridRequestError(
        "invalid_request",
        `Unsupported query parameter: ${key}`,
        key,
      );
    }
  }
  const q = typeof query.q === "string" ? query.q : "";
  if (!q) {
    throw new SearchHybridRequestError(
      "invalid_request",
      "q is required",
      "q",
    );
  }
  const limit = clampLimit(query.limit);
  const streams = normalizeStreamsParam(query.streams ?? query["streams[]"]);
  const hasFilter = Object.prototype.hasOwnProperty.call(query, "filter");
  if (hasFilter && (!streams || streams.length !== 1)) {
    throw new SearchHybridRequestError(
      "invalid_request",
      "filter[...] requires exactly one streams[] value (e.g. ?streams[]=messages&filter[received_at][gte]=...). filter[stream] and filter[connector_id] are not supported.",
      "streams",
    );
  }
  return {
    q,
    limit,
    streams,
    filter: hasFilter ? query.filter : null,
  };
}

function dedupKey(hit: SearchHybridSourceResult): string {
  return JSON.stringify([hit.connector_id, hit.stream, hit.record_key]);
}

interface MergeEntry {
  base: {
    object: "search_result";
    stream: string;
    record_key: string;
    connector_id: string;
    record_url: string;
    emitted_at: string | null;
  };
  matchedFields: string[];
  sources: Set<"lexical" | "semantic">;
  scores: Record<string, { kind: string; value: number; order: string }>;
  snippet: { field: string; text: string } | null;
}

function addHit(
  merged: Map<string, MergeEntry>,
  hit: SearchHybridSourceResult,
  source: "lexical" | "semantic",
): void {
  const key = dedupKey(hit);
  const existing = merged.get(key);
  if (existing) {
    existing.sources.add(source);
    // Union matched_fields across sources without duplicating. Field order
    // reflects discovery order (lexical before semantic when both match).
    for (const f of hit.matched_fields || []) {
      if (!existing.matchedFields.includes(f)) existing.matchedFields.push(f);
    }
    if (hit.score) existing.scores[source] = hit.score;
    // Keep the first non-empty snippet encountered — lexical snippets are
    // highlighted; semantic snippets are verbatim excerpts. Either is
    // informative; we do not invent a combined one.
    if (!existing.snippet && hit.snippet) existing.snippet = hit.snippet;
    return;
  }
  merged.set(key, {
    base: {
      object: hit.object,
      stream: hit.stream,
      record_key: hit.record_key,
      connector_id: hit.connector_id,
      record_url: hit.record_url,
      emitted_at: hit.emitted_at,
    },
    matchedFields: Array.isArray(hit.matched_fields)
      ? hit.matched_fields.slice()
      : [],
    sources: new Set<"lexical" | "semantic">([source]),
    scores: hit.score ? { [source]: hit.score } : {},
    snippet: hit.snippet || null,
  });
}

function shapeResult(entry: MergeEntry): SearchHybridResultItem {
  // Stable lexical-first source order so the shape is reproducible across
  // runs and matches the previous native behavior.
  const sources: ("lexical" | "semantic")[] = [];
  if (entry.sources.has("lexical")) sources.push("lexical");
  if (entry.sources.has("semantic")) sources.push("semantic");
  const result: SearchHybridResultItem = {
    ...entry.base,
    matched_fields: entry.matchedFields,
    retrieval_mode: "hybrid",
    retrieval_sources: sources,
  };
  if (Object.keys(entry.scores).length > 0) result.scores = entry.scores;
  if (entry.snippet) result.snippet = entry.snippet;
  return result;
}

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * Execute the canonical `rs.search.hybrid` operation.
 *
 * The operation does not mutate `input.query`; it parses and normalizes a
 * fresh request-params object internally. It does NOT compile a plan, build
 * a snapshot, persist a snapshot, or read records — instead it delegates to
 * the underlying lexical and semantic runners (which already enforce the
 * caller's grant) and merges their per-source result lists.
 */
export async function executeSearchHybrid(
  input: SearchHybridInput,
  dependencies: SearchHybridDependencies,
): Promise<SearchHybridOutput> {
  // 1. Strict v1 allowlist + cursor rejection + forbidden list + required `q`
  //    + `filter[...]` coupling.
  const params = parseSearchHybridParams(input.query);

  const isOwner = input.actor.kind === "owner";
  const mode: "owner" | "client" = isOwner ? "owner" : "client";

  // 2. Per-source fan-out under the caller's grant. The runners enforce
  //    advertisement, grant projection, stream-grant intersection, and
  //    field gating; hybrid does NOT re-implement them. Errors from either
  //    runner propagate unchanged so hybrid behaves identically to the
  //    underlying endpoints for the same grant (e.g. `grant_stream_not_allowed`
  //    from semantic surfaces through hybrid as well).
  const subRequest: SearchHybridSubRequestParams = {
    q: params.q,
    limit: params.limit,
    streams: params.streams,
    filter: params.filter,
  };
  const [lexicalOutcome, semanticOutcome] = await Promise.all([
    Promise.resolve(dependencies.runLexical(subRequest)),
    Promise.resolve(dependencies.runSemantic(subRequest)),
  ]);

  const lexicalHits = Array.isArray(lexicalOutcome.envelope?.data)
    ? lexicalOutcome.envelope.data
    : [];
  const semanticHits = Array.isArray(semanticOutcome.envelope?.data)
    ? semanticOutcome.envelope.data
    : [];

  // 3. Round-robin merge so neither source dominates the first page. The
  //    dedup map preserves the insertion order of whichever source surfaced
  //    a given record first, which naturally gives overlapping hits the best
  //    available rank. Per-source scores and matched_fields are unioned.
  const merged = new Map<string, MergeEntry>();
  const maxLen = Math.max(lexicalHits.length, semanticHits.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (i < lexicalHits.length) {
      addHit(merged, lexicalHits[i]!, "lexical");
    }
    if (i < semanticHits.length) {
      addHit(merged, semanticHits[i]!, "semantic");
    }
  }

  // 4. Trim to the caller-requested limit AFTER dedup+merge so hybrid never
  //    returns fewer hits than requested purely because of cross-source
  //    overlap. `has_more` honestly reports whether we truncated the merged
  //    list. v1 hybrid has no cursor so `has_more` is informational only —
  //    we never emit `next_cursor`.
  const all = Array.from(merged.values()).map(shapeResult);
  const slice = all.slice(0, params.limit);
  const hasMore = all.length > params.limit;

  const envelope: SearchHybridEnvelope = {
    object: "list",
    has_more: hasMore,
    data: slice,
  };

  const disclosureData: SearchHybridDisclosureData = {
    query_shape: "search_hybrid",
    record_count: slice.length,
    has_more: hasMore,
    mode,
    lexical_count: lexicalHits.length,
    semantic_count: semanticHits.length,
  };

  return { envelope, disclosureData };
}
