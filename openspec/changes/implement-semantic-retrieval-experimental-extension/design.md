# Design — Implementing the Semantic Retrieval Experimental Extension in the Reference

**Status:** implementation design (non-normative working notes for this change)
**Date:** 2026-04-23
**Owner inputs:**
- Approved canonical spec: `openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md`
- Approved canonical design: `openspec/changes/add-semantic-retrieval-experimental-extension/design.md`
- Precedent implementation: `openspec/changes/implement-lexical-retrieval-extension/`
- Status rubric: `openspec/changes/reference-implementation-program/design-notes/surface-status-ladder-2026-04-23.md`
- Metadata carrier: `openspec/changes/reference-implementation-program/design-notes/semantic-retrieval-metadata-carrier-2026-04-23.md`

This change does not redesign anything. It describes the implementation choices the reference makes **inside** the approved contract. If implementation collides with the canonical spec, stop and report — do not mutate the spec.

## 1. What this change does NOT touch

- The approved spec delta at `openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md`. Owned by the prior change. Not re-stated here.
- The contract surface: `GET /v1/search/semantic`, parameter allowlist, `search_result` shape (with required `retrieval_mode` ∈ {`"semantic"`, `"hybrid"`}), owner-token search semantics (cross-connector with no public connector-scope param), advertisement key set (`stability`, `query_input`, `model`, `dimensions`, `distance_metric`, `index_state`, …), `semantic_fields` declaration shape, opaque cursor, no portable score, no debug/trace fields. All locked by the approved spec.
- The status rung. Experimental optional extension, not stabilized, not core. Not revisited.
- The carrier. RS metadata document; no new top-level capability document. Not revisited.
- The lexical retrieval surface (`GET /v1/search`, `capabilities.lexical_retrieval`, `query.search.lexical_fields`). Not modified.
- `/_ref/*` surfaces. This change does not introduce reference-only semantic UIs.

If a future implementer thinks any of those need to move, they MUST reopen the approved change, not freelance here.

## 2. Surface map (where each piece lands)

| Piece | File | Scope |
|---|---|---|
| Stream metadata declaration | `reference-implementation/manifests/reddit.json` (+ validator in `auth.js`) | Adds `query.search.semantic_fields` to the seed manifest; tightens validator |
| RS metadata advertisement | `reference-implementation/server/metadata.js` + route in `index.js` | Adds `capabilities.semantic_retrieval` with required experimental marker and honestly-computed `index_state` |
| Public route | `reference-implementation/server/index.js` (`GET /v1/search/semantic`) | Thin handler — strict allowlist, single helper handoff, spine emit, stability-visible code comment |
| Internal helper | `reference-implementation/server/search-semantic.js` (new) | All semantic search logic: param parse, owner/client mode, plan builder, embedding call, index lookup, snippet, envelope |
| Embedding backend | `reference-implementation/server/search-semantic.js` (`EmbeddingBackend`) | Pluggable interface; default deterministic local stub; hosted providers are operator-configurable drop-ins |
| Vector index | `reference-implementation/server/search-semantic.js` (`VectorIndex`) | Pluggable interface; default in-memory flat; `sqlite-vec` and external DBs are drop-in replacements, not default dependencies |
| Drift metadata | `reference-implementation/server/db.js` (additive `semantic_search_meta` table) | Tracks declared fields fingerprint, `model`, `dimensions`, `distance_metric` per `(connector_id, stream)` |
| Dashboard helper | `apps/web/src/app/dashboard/lib/rs-client.ts` | Adds `searchRecordsSemantic()` proxy; no UI change in this tranche |
| Docs | `apps/web/content/docs/spec-semantic-retrieval-extension.md` (new) + optional `spec-data-query-api.md` pointer | Experimental marker surfaced prominently |
| Tests | `reference-implementation/test/semantic-retrieval.test.js` (new) | Every spec scenario |

## 3. Stream metadata declaration plumbing

The existing stream-metadata route (`GET /v1/streams/:stream`) already passes `mStream.query` straight through to the response. `query.search.semantic_fields` will surface end-to-end the moment a manifest declares it. No route change is needed on the read side. The validator change is what makes the contract honest.

```js
// inside validateConnectorManifest, per-stream loop, AFTER the lexical_fields check:
const semantic = stream?.query?.search?.semantic_fields;
if (semantic !== undefined) {
  if (!Array.isArray(semantic) || semantic.length === 0
      || semantic.some(f => !isNonEmptyString(f))) {
    throw invalidConnectorManifest(
      `Stream '${stream.name}' query.search.semantic_fields must be a non-empty array of strings`, code);
  }
  for (const fname of semantic) {
    if (!schemaFieldNames.has(fname)) {
      throw invalidConnectorManifest(
        `Stream '${stream.name}' semantic_fields references unknown field '${fname}'`, code);
    }
    const fSchema = schemaProperties[fname];
    if (fSchema?.type !== 'string') {
      throw invalidConnectorManifest(
        `Stream '${stream.name}' semantic_fields entry '${fname}' must be a top-level string field`, code);
    }
  }
}
```

This enforcement is independent of `lexical_fields`. A field listed in one declaration is NOT auto-listed in the other. Identical shape constraints as the lexical validator; the two lists run side-by-side.

The seed manifest gets a minimal honest declaration:

```jsonc
// reference-implementation/manifests/reddit.json — posts stream
"query": {
  "search": {
    "lexical_fields": ["title", "selftext"],
    "semantic_fields": ["title", "selftext"]
  }
}
// comments stream
"query": {
  "search": {
    "lexical_fields": ["body", "post_title"],
    "semantic_fields": ["body"]
  }
}
```

A deliberate choice: `comments.semantic_fields` omits `post_title`. That proves the spec's "one field MAY be lexical-only" branch end-to-end.

## 4. The experimental marker is load-bearing in code

The approved spec requires `stability: "experimental"` in the advertisement. The implementation treats this as non-optional in three distinct places:

1. `buildProtectedResourceMetadata()` hardcodes `stability: "experimental"` on the semantic capability object. There is no operator flag that can publish `"stable"` in this tranche. An operator who wants to disclaim support entirely can set `opts.semanticRetrievalSupported === false`, which publishes `supported: false` (or omits the object); there is no third setting.
2. The `GET /v1/search/semantic` route handler carries a `// Experimental — public semantic retrieval. Unstable.` comment band so the stability is obvious to any future reader.
3. Docs (`spec-semantic-retrieval-extension.md`) surface the marker prominently in the first paragraph and at the top of every subsection that describes stability-dependent behavior.

The marker is not a doc adjective — it is the contract that lets us revise or retract the surface without breaking an assumption we never made.

## 5. RS metadata advertisement

Pattern mirrors `capabilities.lexical_retrieval`. Shape:

```js
// metadata.js
function buildProtectedResourceMetadata(opts) {
  // ... existing fields ...
  if (opts.lexicalRetrievalCapability) {
    metadata.capabilities ??= {};
    metadata.capabilities.lexical_retrieval = opts.lexicalRetrievalCapability;
  }
  if (opts.semanticRetrievalCapability) {
    metadata.capabilities ??= {};
    metadata.capabilities.semantic_retrieval = opts.semanticRetrievalCapability;
  }
  return metadata;
}
```

In the route, the capability object is assembled from the configured backend:

```js
const backend = getSemanticBackend(); // null if not configured
const vectorIndex = getVectorIndex();
const semanticRetrievalCapability = backend && vectorIndex ? {
  supported: true,
  stability: 'experimental',
  endpoint: '/v1/search/semantic',
  cross_stream: true,
  query_input: 'text',
  snippets: true,
  lexical_blending: false,
  model: backend.model(),
  dimensions: backend.dimensions(),
  distance_metric: backend.distanceMetric(),
  default_limit: 25,
  max_limit: 100,
  index_state: vectorIndex.state(),
  // language_bias is optional; omitted unless backend declares one
} : null;
```

Key invariants enforced by construction:

- `supported: true` is only published when a real embedding backend AND a real vector index are configured. An orphan advertisement ("we say we support it but we can't produce embeddings") is unreachable by code path.
- `stability` is hardcoded to `"experimental"` in v1.
- `query_input` is hardcoded to `"text"` in v1 (the code does not accept any other value; future work would change this file deliberately).
- `model`, `dimensions`, `distance_metric` come from the backend, not from configuration drift. They cannot lie.
- `index_state` is read from the index backend itself. The reference NEVER caches `built` while the backing store is rebuilding.

The advertisement is discoverable without a bearer token (the existing RS metadata route is unauthenticated; we do not regress that).

## 6. `GET /v1/search/semantic` route — thin handler, all logic in `search-semantic.js`

```js
// index.js, near /v1/search registration
// Experimental — public semantic retrieval. Unstable.
// See capabilities.semantic_retrieval.stability and spec-semantic-retrieval-extension.md.
app.get('/v1/search/semantic',
  { contract: 'searchRecordsSemantic' },
  requireToken,
  async (req, res) => {
    const queryContext = buildQueryContext(req);
    const result = await runSemanticSearch({ req, opts, tokenInfo: req.tokenInfo, queryContext });
    emitSpine('query.received', queryContext);
    emitSpine('disclosure.served', result.disclosureData);
    res.json(result.envelope);
  });
```

All parameter parsing, mode branching, plan construction, embedding, index lookup, snippet hydration, and envelope assembly live in `runSemanticSearch()` inside `search-semantic.js`. The handler does not know what a semantic field is; the helper does not know what a Fastify request object is.

### 6.1 Parameter allowlist

```js
const ALLOWED = new Set(['q', 'limit', 'cursor', 'streams']); // plus streams[]

// every unknown key → invalid_request_error with `param` = <key>
// explicit rejection list in tests:
//   vector, embedding, embed, model, model_id, model_family,
//   rank, boost, weights, blend,
//   connector_id,
//   filter[*], fields, expand, expand[*], expand_limit, expand_limit[*],
//   order, sort, mode,
//   any connector-specific param
```

The allowlist is checked before any manifest lookup or embedding call, so rejected requests never touch the backend.

### 6.2 Mode resolution

```js
// runSemanticSearch
if (tokenInfo.kind === 'client') {
  // resolveGrantManifest() — same path /v1/search uses
  // streams[] membership check: unauthorized → permission_error / grant_stream_not_allowed
} else { // owner token
  // enumerate owner-visible connectors
  // for each, resolve manifest + synthetic owner grant
  // streams[] is a SOFT filter: unknown name → zero hits, NOT a hard error
}
```

Cross-connector fan-out for owner tokens matches the lexical tranche's pattern exactly. The `connector_id` is recorded on the plan and threaded through to every `search_result`.

### 6.3 Plan construction — grant gating BEFORE embedding

```js
// search-semantic.js
function buildSemanticSearchPlan({ manifest, grant, streamsFilter }) {
  const plan = [];
  for (const stream of manifest.streams) {
    if (!streamPasses(stream, grant, streamsFilter)) continue;
    const declared = stream?.query?.search?.semantic_fields ?? [];
    const authorized = declared.filter(f => fieldReadable(stream, f, grant));
    if (authorized.length === 0) continue; // zero hits, silent
    plan.push({ streamName: stream.name, semanticFields: authorized });
  }
  return plan;
}
```

Field gating happens here, before the embedding backend is called and before the vector index is queried. There is no code path that embeds or indexes an unauthorized or undeclared field for a caller. This satisfies "embed everything, filter later" prohibition by construction.

### 6.4 Embedding + index lookup

```js
async function runSemanticSearch(params) {
  const plan = buildSemanticSearchPlan(params);
  if (plan.length === 0) return emptyEnvelope(params);

  // Honest index-state check. If the index is not able to produce semantic
  // results right now, we return an empty or partial result set. We do NOT
  // substitute lexical-only matching while emitting retrieval_mode: "semantic".
  // That is the canonical spec scenario: "The semantic surface SHALL NOT silently
  // substitute a non-semantic fallback."
  const indexState = vectorIndex.state();
  if (indexState === 'stale' || indexState === 'building') {
    return limitedEnvelope({ plan, reason: indexState });
  }

  const queryVector = await backend.embedQuery(params.q);
  const { hits, nextCursor, hasMore } = await vectorIndex.query({
    vector: queryVector,
    plan,
    limit: params.limit,
    cursor: params.cursor,
  });

  const enriched = await hydrateHits({ hits, plan, tokenInfo: params.tokenInfo });
  return {
    envelope: {
      object: 'list',
      url: '/v1/search/semantic',
      has_more: hasMore,
      next_cursor: nextCursor,
      data: enriched.map(toSearchResult), // retrieval_mode: "semantic" set here
    },
    disclosureData: { query_shape: 'search_semantic', record_count: hits.length, /* ... */ },
  };
}
```

### 6.5 `retrieval_mode` assignment

`lexical_blending: false` in v1 means the handler emits `retrieval_mode: "semantic"` on every result. The code path for `"hybrid"` exists but is gated on a config flag the reference does not flip in this tranche; tests assert that the advertisement's `lexical_blending` key agrees with the actual emitted `retrieval_mode` values (a hybrid result emitted while `lexical_blending: false` is a bug, not a feature).

### 6.6 Snippet hydration — verbatim only

```js
function buildSnippet({ record, matchedField, semanticFieldsAuthorized }) {
  if (!semanticFieldsAuthorized.includes(matchedField)) return null; // double-check
  const text = getFieldText(record, matchedField);
  if (typeof text !== 'string') return null;
  const excerpt = pickVerbatimExcerpt(text, /* bounded length */);
  return { field: matchedField, text: excerpt };
}
```

Key constraint: `pickVerbatimExcerpt` returns a contiguous substring of `text`. It does not paraphrase, summarize, or synthesize. If the chosen field cannot yield a useful verbatim excerpt, the snippet is omitted rather than fabricated. Tests assert that snippet text appears verbatim in the matched field's stored value.

### 6.7 Cursor semantics

Opaque. The cursor encodes:

- the query text `q`
- the plan hash (stream set + authorized field set + `connector_id` set)
- the index generation / model hash at the time of the first page
- a paging offset

Stale cursors (plan changes, model changes, index rebuild) are rejected as `invalid_cursor`. Tests cover: cursor from `/v1/search/semantic` rejected by `/v1/search` and by `/v1/streams/.../records`; cursor from those surfaces rejected by `/v1/search/semantic`.

### 6.8 Spine disclosure

`disclosure.served` with `query_shape: 'search_semantic'` (distinct from `'search'` for lexical and `'read'` for records) so the spine can distinguish the experimental surface. This makes semantic disclosures auditable without conflating them with lexical disclosures.

## 7. Embedding backend (`EmbeddingBackend` interface)

```ts
interface EmbeddingBackend {
  model(): string;
  dimensions(): number;
  distanceMetric(): 'cosine' | 'dot' | 'l2';
  embedQuery(text: string): Promise<Float32Array>;
  embedDocument(text: string): Promise<Float32Array>;
  available(): boolean;
  languageBias?(): { primary: string; note: string } | null;
}
```

### 7.1 Default: deterministic local stub

For CI, local dev, and the "the reference runs offline with no API key" invariant, the default backend is a **deterministic hash-based embedding**:

```js
function makeStubBackend({ dimensions = 64 } = {}) {
  return {
    model: () => 'pdpp-reference-stub-embed-v0',
    dimensions: () => dimensions,
    distanceMetric: () => 'cosine',
    embedQuery: async (t) => hashEmbed(t, dimensions),
    embedDocument: async (t) => hashEmbed(t, dimensions),
    available: () => true,
    languageBias: () => null,
  };
}
```

`hashEmbed` produces a deterministic vector from tokenized text. It is NOT a production semantic embedding. This is an honest trade:

- the model identifier explicitly names itself as a stub
- the extension is advertised as `stability: "experimental"`, so callers who care about semantic quality can inspect `model` and decline
- the stub is good enough to exercise the full contract end-to-end in tests: same input → same vector; different inputs → different vectors; field-scoping, grant-scoping, cursor stability, and `index_state` transitions all work

This is deliberately weak semantics. It satisfies the contract (a server-declared model, advertised honestly) without committing the reference to shipping, maintaining, and billing against a hosted embedding provider.

### 7.2 Hosted provider as operator-configured drop-in

An operator who wants real semantic quality configures a hosted provider through the same interface:

```js
// e.g. reference-implementation/server/embed-openai.js (NOT in this tranche)
function makeOpenAIBackend({ apiKey, model = '<operator-chosen>' }) {
  return {
    model: () => model,
    dimensions: () => 1024, // from provider docs
    distanceMetric: () => 'cosine',
    embedQuery: (t) => callProviderEmbeddings(apiKey, model, t),
    embedDocument: (t) => callProviderEmbeddings(apiKey, model, t),
    available: () => /* health check */,
    languageBias: () => null,
  };
}
```

This file is NOT added in this tranche. Adding a hosted-provider adapter is a follow-up that does not require a spec change; it is purely operator configuration.

### 7.3 The "no configured backend" path

If no backend is configured at startup, the reference:

- does NOT advertise `capabilities.semantic_retrieval.supported: true`
- does NOT register the `GET /v1/search/semantic` route
- passes all existing lexical/record tests unchanged

This is deliberately strict. A server that advertises semantic retrieval MUST be able to serve it; an "empty" advertisement would be a lie.

## 8. Vector index (`VectorIndex` interface)

```ts
interface VectorIndex {
  upsert(row: { stream: string; record_key: string; field: string;
                connector_id: string; vector: Float32Array }): Promise<void>;
  delete(row: { stream: string; record_key: string }): Promise<void>;
  delete_by_stream(row: { stream: string; connector_id: string }): Promise<void>;
  query(params: { vector: Float32Array; plan: Plan; limit: number;
                  cursor?: string }): Promise<{ hits: Hit[]; nextCursor?: string; hasMore: boolean }>;
  state(): 'built' | 'building' | 'stale';
  clear(): Promise<void>;
}
```

### 8.1 Default: in-memory flat store

```js
function makeInMemoryFlatIndex({ distanceMetric = 'cosine' } = {}) {
  const rows = new Map(); // keyed by `${connector_id}|${stream}|${record_key}|${field}`
  let currentState = 'built';
  return {
    upsert: async ({ stream, record_key, field, connector_id, vector }) => {
      rows.set(keyOf({ connector_id, stream, record_key, field }),
               { stream, record_key, field, connector_id, vector });
    },
    delete: async ({ stream, record_key }) => {
      for (const k of rows.keys()) {
        if (k.includes(`|${stream}|${record_key}|`)) rows.delete(k);
      }
    },
    delete_by_stream: async ({ stream, connector_id }) => {
      for (const k of rows.keys()) {
        if (k.startsWith(`${connector_id}|${stream}|`)) rows.delete(k);
      }
    },
    query: async ({ vector, plan, limit, cursor }) => {
      // flat scan restricted to plan's (stream, connector_id, field) tuples
      const allowed = planToAllowedKeys(plan);
      const candidates = [];
      for (const [k, row] of rows) {
        if (!allowed.has(keyWithoutRecord(k))) continue;
        const d = distance(vector, row.vector, distanceMetric);
        candidates.push({ row, d });
      }
      candidates.sort((a, b) => a.d - b.d); // lower distance = more relevant
      // apply cursor offset + limit; return hits without exposing `d`
      return paginate(candidates, cursor, limit);
    },
    state: () => currentState,
    setState: (s) => { currentState = s; }, // internal
    clear: async () => { rows.clear(); },
  };
}
```

### 8.2 Why in-memory instead of `sqlite-vec`

- `sqlite-vec` is a newer, native-addon SQLite extension. It works, but loading a native addon alongside the just-stabilized `better-sqlite3` install doubles the native-binding surface area during this tranche's verification.
- The default corpus on a developer laptop fits comfortably in memory for experimental semantic retrieval.
- Persistence is NOT promised by the spec — `index_state` reports `stale` on restart if coverage is lost, and the JS rebuild pattern recomputes from records. An in-memory default is aligned with that honesty.
- An operator who wants persistence configures a persistent `VectorIndex` drop-in. The interface supports it.

### 8.3 Index-only-declared-fields invariant

The `upsert` path is only ever called with `(stream, record_key, field, connector_id, vector)` tuples where `field ∈ stream.manifest.query.search.semantic_fields`. The caller enforces this; the backend does not need to. Tests assert that after ingesting records for a stream whose manifest declares `semantic_fields: ["body"]`, the index contains exactly one row per record (not one per field-of-record).

### 8.4 Drift detection and `index_state`

`semantic_search_meta(connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric)` tracks three drift signals:

1. **`fields_fingerprint`** — sorted JSON of `semantic_fields`. Any change (add, remove, reorder-with-content-delta) triggers a rebuild for that `(connector_id, stream)`.
2. **`model_id` / `dimensions` / `distance_metric`** — if any of these disagree with the currently-configured backend, the index is stale *globally*. The advertisement reports `index_state: "stale"` until the rebuild completes.
3. **Row-count band** (secondary) — if the index row count diverges materially from the records table's `participating_count * declared_fields_count`, report `stale`.

Rebuild is JS-maintained at the record write/update/delete call sites. SQLite triggers cannot consult the connector manifest (to know which fields to embed), so triggers are not used. Drift detection runs on startup and on every connector registration/update.

## 9. The no-silent-fallback rule in code

The approved spec has a scenario titled *"The semantic surface SHALL NOT silently substitute a non-semantic fallback."* This is implemented by explicit branches:

```js
// search-semantic.js
if (indexState === 'stale' || indexState === 'building') {
  // Return zero or partial results. NEVER call into lexical search
  // and emit retrieval_mode: "semantic" on the results.
  return limitedEnvelope({ plan, reason: indexState });
}
```

There is no imported reference to `search.js` (lexical) inside `search-semantic.js`. The two helpers are independent modules. A hypothetical future author who tries to "improve" semantic retrieval by calling into lexical search while the index rebuilds would have to cross a module boundary that is intentionally missing. The unit test asserts: with the index artificially set to `stale`, a request that would have matched lexically returns zero results from `/v1/search/semantic`, and the advertisement's `index_state` reports `stale`.

## 10. Owner-token cross-connector fan-out

Identical pattern to the lexical tranche's `implement-lexical-retrieval-extension`:

- Enumerate owner-visible connectors.
- For each connector, build a per-connector plan.
- Embed the query once; query each connector's plan against the shared vector index, scoped by `connector_id`.
- Merge results by relevance order.
- Emit `connector_id` on every hit.
- Emit `record_url` with the owner-mode `connector_id` query parameter.

The public request shape is identical for owner and client tokens. `connector_id` is rejected as a query parameter in both modes.

## 11. Dashboard and docs

### 11.1 Dashboard helper (no UI change)

```ts
// apps/web/src/app/dashboard/lib/rs-client.ts
export async function searchRecordsSemantic(
  query: string,
  scope: Scope
): Promise<SemanticSearchResult[]> {
  // GET /v1/search/semantic with owner token
  // returns parsed envelope's data[]
}
```

Wiring the dashboard UI is deferred. We only want the helper available so a follow-up product change consumes the public surface directly rather than minting a bridge.

### 11.2 Docs page

`apps/web/content/docs/spec-semantic-retrieval-extension.md` surfaces the experimental marker in:

- the first paragraph (e.g., *"This extension is **experimental and unstable**. Breaking revisions may occur without warning."*)
- a dedicated `## Stability` subsection that reproduces `stability: "experimental"` from the advertisement
- the top of `## Advertisement`, `## `index_state``, and `## Non-goals` subsections

`apps/web/content/docs/spec-data-query-api.md` gets one sentence (if the lexical rewrite has landed): *"Semantic retrieval is also available as an experimental optional extension at `GET /v1/search/semantic`. It is unstable; see `spec-semantic-retrieval-extension.md`."*

## 12. Test plan

`reference-implementation/test/semantic-retrieval.test.js` covers every scenario from the approved spec. Concretely:

### Advertisement
- `capabilities.semantic_retrieval` present with ALL required keys (`supported`, `stability`, `endpoint`, `cross_stream`, `query_input`, `snippets`, `lexical_blending`, `model`, `dimensions`, `distance_metric`, `default_limit`, `max_limit`, `index_state`) when a backend is configured.
- `stability === "experimental"`, `query_input === "text"`.
- Advertisement omitted (or `supported: false`) when no backend is configured.
- Advertisement is reachable without a bearer token.
- Advertisement is independent of `capabilities.lexical_retrieval` (toggles each independently in two test runs).

### Route shape
- `/v1/search/semantic?q=...` returns `{ object: 'list', url, has_more, data: [...] }`.
- Each hit has `object: 'search_result'`, required `stream`/`record_key`/`connector_id`/`emitted_at`/`matched_fields`/`retrieval_mode`.
- `retrieval_mode === 'semantic'` when `lexical_blending: false` (always in this tranche).
- No `score`, `cosine`, `bm25`, `blend`, `_debug`, `_explain`, `_vector_distance` on any result.

### Parameter rejection
- Missing `q` → `invalid_request_error`.
- Each of the following → `invalid_request_error` with `param` set: `vector`, `embedding`, `embed`, `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`, `blend`, `connector_id`, `filter[foo]`, `fields`, `expand`, `expand[messages]`, `expand_limit`, `expand_limit[messages]`, `order`, `sort`, `mode`.

### Grants
- Client token with `streams[]=<not-in-grant>` → `permission_error` + `grant_stream_not_allowed`.
- Owner token with `streams[]=<nonexistent>` → empty list, not an error.
- Client token: stream in grant but zero declared `semantic_fields` in intersection with grant → zero hits, no per-stream error.
- Client token: field declared `semantic_fields` but not authorized → `matched_fields` excludes it; snippet never draws from it.

### Manifest validator
- Rejects: empty `semantic_fields`, non-array, nested path (`"posts.title"`), array-type schema field, blob-type field, integer-type field, unknown field.
- Independence from `lexical_fields`: manifest with only `semantic_fields` is valid; manifest with only `lexical_fields` is valid; manifest with both where a field appears in only one is valid.

### Grant-safe snippets
- Snippet text is a verbatim substring of the matched field's stored value (string contains check).
- Snippet text is NEVER a paraphrase (regression test: with stored content `"hello world"`, query `"greeting"` returns a hit but the snippet is drawn verbatim from `"hello world"`, not rewritten).
- Snippet omitted when the matched field cannot yield a useful verbatim excerpt.

### `index_state` and no-fallback
- Forcing `vectorIndex.state() = 'stale'` → request returns zero or partial results; advertisement reports `stale`.
- While `stale`, the handler does NOT call lexical search. (Mock `search.js` and assert it is not invoked.)
- Forcing `model` change → advertisement flips to `stale` until rebuild.
- Forcing `semantic_fields` fingerprint change → advertisement flips to `stale` until rebuild.

### Owner cross-connector
- Two owner-visible connectors both exposing `messages` with `semantic_fields: ["text"]` and a record matching → hits from BOTH connectors appear, each with its own `connector_id`.
- Owner `record_url` round-trip: take the URL, GET it under the same owner token, confirm the record envelope comes back. Proves `?connector_id=...` encoding.
- Owner request with `connector_id=` → `invalid_request_error`.

### Pagination
- `next_cursor` round-trips within a session.
- Cursor from `/v1/search/semantic` passed to `/v1/search` → `invalid_cursor`.
- Cursor from `/v1/search/semantic` passed to `/v1/streams/.../records` → `invalid_cursor`.
- Cursor from `/v1/search` passed to `/v1/search/semantic` → `invalid_cursor`.
- Stale cursor (after simulated index rebuild) → `invalid_cursor`.

### Independence from lexical
- `capabilities.lexical_retrieval` unchanged by this tranche.
- `GET /v1/search` behavior unchanged by this tranche.
- `/_ref/search` unchanged.

## 13. Stop-and-report conditions for the implementer

If during implementation any of these become necessary, stop and report rather than mutating the approved spec or silently widening:

- A real embedding model cannot be supplied through the `EmbeddingBackend` interface.
- Grant gating cannot be done before embedding and must happen after.
- Verbatim snippets cannot be produced at acceptable quality and a paraphrase is the only option.
- The advertisement's required key set cannot be populated honestly (e.g., `dimensions` is unknown).
- `index_state` cannot be computed honestly from the backing store.
- `GET /v1/search/semantic` needs to call into lexical search to produce acceptable results.
- A public `connector_id` or `model` parameter seems required.
- `retrieval_mode` values other than `"semantic"` or `"hybrid"` seem needed.
- Raw vector queries or client-supplied embeddings seem required.
- A dashboard-only semantic contract is needed beside the public extension.

Any of these means the design assumption is wrong, not that the implementation should improvise. Reopen the approved change.
