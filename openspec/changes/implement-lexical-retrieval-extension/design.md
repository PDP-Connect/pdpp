# Design — Implementing the Lexical Retrieval Extension in the Reference

**Status:** implementation design (non-normative working notes for this change)
**Date:** 2026-04-23
**Owner inputs:**
- Approved canonical spec: `openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md`
- Approved canonical design: `openspec/changes/add-lexical-retrieval-extension/design.md`
- Worker brief: `openspec/changes/reference-implementation-program/design-notes/lexical-retrieval-launch-worker-brief-2026-04-23.md`

This change does not redesign anything. It only describes the implementation choices the reference makes inside the approved contract.

## 1. What this change does NOT touch

- The approved spec delta in `add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md`. Owned by the prior change. Not re-stated here. If implementation collides with it, stop and report.
- The contract surface. `GET /v1/search`, parameter allowlist (now including the explicit rejection of public `connector_id`), `search_result` shape (now requiring `connector_id` on every result), owner-token search semantics (cross-connector with no public connector-scope param), advertisement keys, `lexical_fields` declaration shape, opaque cursor, no portable score — all locked by the patched approved spec at `openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md`.
- The status rung. Optional extension, not core. Not revisited.
- The carrier. RS metadata document, not a new top-level metadata document. Not revisited.

If a future implementer thinks any of those need to move, they MUST reopen the approved change, not freelance here.

## 2. Surface map (where each piece lands)

| Piece | File | Scope |
|---|---|---|
| Stream metadata declaration | `reference-implementation/manifests/reddit.json` (+ validator in `auth.js`) | Adds `query.search.lexical_fields` to the seed manifest; tightens validator |
| RS metadata advertisement | `reference-implementation/server/metadata.js` + the route in `index.js` | Adds `capabilities.lexical_retrieval` |
| Public route | `reference-implementation/server/index.js` (`GET /v1/search`) | Thin handler — strict allowlist, single helper handoff, spine emit |
| Internal helper | `reference-implementation/server/search.js` (new) | All search logic: param parse, owner/client mode, planner, FTS5, snippet, envelope |
| Backing index | `reference-implementation/server/db.js` (additive FTS5 table) + `search.js` | SQLite FTS5; declared-fields-only |
| Dashboard switchover | `apps/web/src/app/dashboard/search/page.tsx` + new `searchRecordsLexical` in `apps/web/src/app/dashboard/lib/rs-client.ts` | Replaces brute-force fan-out via the existing rs-client pattern |
| Docs | `apps/web/content/docs/spec-data-query-api.md` (edit) + `spec-lexical-retrieval-extension.md` (new) | Truthfulness cleanup |
| Tests | `reference-implementation/test/lexical-retrieval.test.js` (new) | Every spec scenario |

## 3. Stream metadata declaration plumbing

The existing stream-metadata route at `index.js:1948` already passes `mStream.query` straight through to the response. So `query.search.lexical_fields` is plumbed end-to-end the moment a manifest declares it. No route change is needed for the read side.

The validator change is all that's needed to make the contract honest:

```js
// inside validateConnectorManifest, per-stream loop, after view validation:
const lexical = stream?.query?.search?.lexical_fields;
if (lexical !== undefined) {
  if (!Array.isArray(lexical) || lexical.length === 0
      || lexical.some(f => !isNonEmptyString(f))) {
    throw invalidConnectorManifest(
      `Stream '${stream.name}' query.search.lexical_fields must be a non-empty array of strings`, code);
  }
  for (const fname of lexical) {
    if (!schemaFieldNames.has(fname)) {
      throw invalidConnectorManifest(
        `Stream '${stream.name}' lexical_fields references unknown field '${fname}'`, code);
    }
    const fSchema = schemaProperties[fname];
    if (fSchema?.type !== 'string') {
      throw invalidConnectorManifest(
        `Stream '${stream.name}' lexical_fields entry '${fname}' must be a top-level string field`, code);
    }
  }
}
```

This rejects: nested paths (no dotted names allowed by `schemaFieldNames` lookup), arrays (`type !== 'string'`), blob refs (same), unknown fields, empty arrays, non-string entries.

The seed manifest gets a minimal honest declaration:

```jsonc
// reference-implementation/manifests/reddit.json — posts stream
"query": {
  "search": {
    "lexical_fields": ["title", "selftext"]
  }
}
// comments stream
"query": {
  "search": {
    "lexical_fields": ["body", "post_title"]
  }
}
```

`saved` stream stays non-participating — its only string fields are `title` and `url`, and `url` is not text the dashboard search should match against. That is the point: a stream MAY participate. Most streams in the seed corpus stay outside the extension; that itself is the test for the non-participation branch.

## 4. RS metadata advertisement plumbing

`buildProtectedResourceMetadata()` gets one new optional argument:

```js
export function buildProtectedResourceMetadata({
  // ... existing ...
  lexicalRetrievalCapability,
}) {
  const md = { /* existing */ };
  if (lexicalRetrievalCapability) {
    md.capabilities = { ...(md.capabilities || {}), lexical_retrieval: lexicalRetrievalCapability };
  }
  return md;
}
```

The route call site in `index.js` constructs the capability object:

```js
const lexicalRetrievalCapability = opts.lexicalRetrievalSupported === false ? null : {
  supported: true,
  endpoint: '/v1/search',
  cross_stream: true,
  snippets: true,
  default_limit: 25,
  max_limit: 100,
};
```

The reference always exposes the extension by default; an opts flag (off by default = on; explicit `false` turns it off) lets test fixtures or downstream forks publish `supported: false` or omit the block. When `supported: true`, all six required keys are emitted, satisfying the strict scenario.

## 5. `GET /v1/search` route shape

The route stays intentionally thin per owner constraint. All search logic — parameter parsing, owner-vs-client mode resolution, plan construction, FTS5 query, snippet hydration, response shaping — lives in `reference-implementation/server/search.js`. The route's job is: accept the request, resolve the token kind once, hand off to the helper, emit the right spine events, return the envelope.

```js
app.get('/v1/search', { contract: 'searchRecordsLexical' }, requireToken, async (req, res) => {
  let queryContext = null;
  try {
    const { tokenInfo } = req;
    const queryId = ensureRequestId(res);
    const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
    setReferenceTraceId(res, traceId);

    queryContext = {
      tokenInfo, queryId, actorType, actorId, traceId, scenarioId,
      sourceDescriptor: tokenInfo.pdpp_token_kind === 'owner'
        ? null
        : buildSourceDescriptor(tokenInfo.grant?.source),
      streamId: null,
      queryData: { query_shape: 'search' },
    };

    const { envelope, disclosureData } = await runLexicalSearch({
      req, opts, tokenInfo, queryContext,
    });
    await emitQueryReceived(queryContext, req);
    await emitSpineEvent({
      event_type: 'disclosure.served',
      trace_id: traceId, scenario_id: scenarioId,
      actor_type: actorType, actor_id: actorId,
      subject_type: 'subject', subject_id: tokenInfo.subject_id || null,
      object_type: 'query', object_id: queryId,
      status: 'succeeded',
      grant_id: tokenInfo.grant_id || null,
      client_id: tokenInfo.client_id || null,
      stream_id: null,
      token_id: req.headers.authorization?.slice(7) || null,
      data: disclosureData,
    });

    res.json(envelope);
  } catch (err) {
    if (queryContext) {
      await emitQueryReceived(queryContext, req);
      return await rejectQuery(res, req, queryContext, err);
    }
    handleError(res, err);
  }
});
```

The route handler is ~30 lines. Everything else is in `search.js`.

Notes:

- `runLexicalSearch` is the single helper entry point. It does parameter parsing (so the route doesn't have to know the allowlist), owner-vs-client mode resolution (so the route doesn't fork on token kind), per-mode plan construction, FTS5 query, snippet hydration under grant projection, and response envelope shaping.
- The route doesn't touch the FTS5 backing directly. Ever.
- `query_shape: 'search'` is the spine event marker.
- `disclosureData` carries `record_count`, `has_more`, and per-mode summary so spine consumers can audit search disclosures the same way they audit record reads.

## 6. Internal helper — single enforcement path

`reference-implementation/server/search.js` exposes one entry point used by the route, and a couple of pure helpers:

```js
// Pure planner. Per (manifest, grant) pair, computes the (stream, field) tuples
// the search may legally consider. Field gating happens here, BEFORE any
// FTS5 query is issued. There is no code path that asks the index about an
// unauthorized field. This satisfies the "filter-later prohibited" scenario
// by construction.
export function buildSearchPlanForGrant({ manifest, grant, streamsFilter }) {
  const plan = [];
  for (const mStream of manifest.streams || []) {
    const declared = mStream.query?.search?.lexical_fields;
    if (!Array.isArray(declared) || declared.length === 0) continue;
    if (streamsFilter && !streamsFilter.includes(mStream.name)) continue;

    const streamGrant = (grant.streams || []).find(s => s.name === mStream.name);
    if (!streamGrant) continue;

    // streamGrant.fields = null/undefined means "all fields authorized".
    const grantedFields = streamGrant.fields ? new Set(streamGrant.fields) : null;
    const searchable = grantedFields
      ? declared.filter(f => grantedFields.has(f))
      : declared.slice();
    if (searchable.length === 0) continue;

    plan.push({ streamName: mStream.name, searchableFields: searchable });
  }
  return plan;
}

// Top-level entry called by the route. Owns parameter parsing,
// owner-vs-client mode resolution, per-mode plan construction
// (cross-connector for owner; single-grant for client), FTS5 query,
// snippet hydration, and response envelope shaping.
export async function runLexicalSearch({ req, opts, tokenInfo, queryContext }) {
  // 1. Strict parameter allowlist
  const params = parseSearchParams(req.query); // throws invalid_request on disallowed keys
  // params = { q, limit, cursor, streams[] | null }

  // 2. Resolve mode
  const isOwner = tokenInfo.pdpp_token_kind === 'owner';

  // 3. Per-mode planning
  let perConnectorPlans;
  if (isOwner) {
    // Cross-connector fan-out. Enumerate every connector the owner can read.
    // For each, resolve its manifest and synthetic owner grant; build a plan.
    const connectorIds = await listOwnerVisibleConnectorIds(opts);
    perConnectorPlans = [];
    for (const connectorId of connectorIds) {
      const ownerScope = buildOwnerScopeForConnector(connectorId, opts);
      const { manifest, storageBinding } = await resolveOwnerManifestFromScope(ownerScope, opts);
      const grant = buildOwnerReadGrantForManifest(manifest); // synthetic grant: all streams, all fields
      const planEntries = buildSearchPlanForGrant({
        manifest, grant, streamsFilter: params.streams,
      });
      if (planEntries.length === 0) continue;
      perConnectorPlans.push({ connectorId, manifest, storageBinding, grant, planEntries });
    }

    // For owner mode, streams[] is NOT a hard error if a stream isn't present
    // anywhere — it just means zero hits. The hard-error scenario in the spec
    // applies to client tokens (named stream not in grant). Owner-mode only
    // hard-errors if the OWNER itself has zero connectors (unreachable) — we
    // return an empty list, not an error, so the dashboard renders cleanly.
  } else {
    // Client token. Single grant, single connector, single plan.
    const { manifest, storageBinding } = await resolveGrantManifest(tokenInfo, opts);
    const grant = tokenInfo.grant;
    const connectorId = grant?.source?.connector_id ?? null;

    if (params.streams) {
      for (const s of params.streams) {
        const inGrant = (grant?.streams || []).some(g => g.name === s);
        if (!inGrant) {
          const err = new Error(`Stream '${s}' not in grant`);
          err.code = 'grant_stream_not_allowed';
          throw err;
        }
      }
    }

    const planEntries = buildSearchPlanForGrant({
      manifest, grant, streamsFilter: params.streams,
    });
    perConnectorPlans = planEntries.length === 0
      ? []
      : [{ connectorId, manifest, storageBinding, grant, planEntries }];
  }

  // 4. FTS5 query, gather candidates with connector_id attached at the source
  const { hits, nextCursor, hasMore } = await queryLexicalIndex({
    perConnectorPlans, q: params.q, limit: params.limit, cursor: params.cursor,
  });
  // Each hit shape: { connectorId, stream, recordKey, emittedAt, matchedFields, snippet?: { field, text } }

  // 5. Shape candidates into search_result, including required connector_id
  // and the canonical record_url (with owner-mode connector_id query param
  // when isOwner, plain when client).
  const data = hits.map(h => buildSearchResult({ hit: h, isOwner }));

  return {
    envelope: {
      object: 'list',
      url: '/v1/search',
      has_more: hasMore,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      data,
    },
    disclosureData: {
      query_shape: 'search',
      record_count: data.length,
      has_more: hasMore,
      mode: isOwner ? 'owner' : 'client',
      connector_count: perConnectorPlans.length,
    },
  };
}

function buildSearchResult({ hit, isOwner }) {
  const recordPath = `/v1/streams/${encodeURIComponent(hit.stream)}/records/${encodeURIComponent(hit.recordKey)}`;
  const recordUrl = isOwner
    ? `${recordPath}?connector_id=${encodeURIComponent(hit.connectorId)}`
    : recordPath;
  return {
    object: 'search_result',
    stream: hit.stream,
    record_key: hit.recordKey,
    connector_id: hit.connectorId,
    record_url: recordUrl,
    emitted_at: hit.emittedAt,
    matched_fields: hit.matchedFields,
    ...(hit.snippet ? { snippet: hit.snippet } : {}),
  };
}
```

Field gating happens in `buildSearchPlanForGrant` *before* any FTS5 query is issued. There is no code path that asks the index about an unauthorized field. This satisfies the "filter-later prohibited" scenario by construction, in both client mode and owner mode.

The dashboard's `apps/web/src/app/dashboard/lib/rs-client.ts` helper calls the route over HTTP rather than calling `runLexicalSearch` directly, so dashboard search and public search share exactly the same enforcement code path. There is no second contract.

### 6.1 Cross-connector ranking and pagination in owner mode

When owner-mode fan-out spans more than one connector, the FTS5 query is issued per connector (since each connector's records sit under that connector's storage binding in the reference). The merged result list is sorted by relevance score within each connector, then merged across connectors using a stable round-robin so no single connector dominates the early pages. The opaque cursor (§9) carries enough state to resume across the merged stream. Cross-connector relevance is intentionally not a portable promise — the spec says "higher-ranked results SHOULD generally be more relevant"; the round-robin merge is one honest realization of that.

## 7. Snippet generation

For each hit, the helper reads the corresponding record under the caller's grant projection (using the existing record-fetch/`projectFields` path), then derives a 120-character snippet centered on the first match within one of `matchedFields`. The snippet text comes only from a field that is both authorized and declared searchable, satisfying the snippet-grant-safety scenario by construction. If snippet generation fails (e.g., the record was deleted between index match and hydration), the result simply omits `snippet`. The result is still valid; the spec already says snippets are per-result optional.

## 8. FTS5 backing (reference-only)

Schema (additive, in `db.js`):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS lexical_search_index USING fts5(
  stream UNINDEXED,
  record_key UNINDEXED,
  field UNINDEXED,
  text,
  tokenize = 'unicode61'
);
```

One row per (stream, record_key, field) where `field` is in that stream's declared `lexical_fields`. Maintained by:

- on record insert: for each stream in the connector manifest with `lexical_fields`, insert one row per declared field
- on record update: delete + insert
- on record delete: delete by (stream, record_key)
- on startup: detect drift (count records vs index rows); if mismatched, rebuild

The reference implements maintenance in JS rather than SQLite triggers, because the index population requires consulting the manifest at write time (we need to know which fields are searchable). Triggers can't see the manifest; the JS write path can.

A `lexical_search_snapshots` table caches `(snapshot_id, q, plan_hash, results)` so that opaque cursor pagination is stable within a session. Snapshots have a TTL; expired snapshots return `invalid_cursor`, which the spec already permits.

## 9. Pagination cursor

Opaque cursor encoding (server-side):

```
base64url(json({ snap: <snapshot_id>, off: <offset> }))
```

Within one snapshot, pagination is deterministic. Across snapshots (server restart, manifest change, grant change, snapshot TTL expiry) the cursor is invalid → `invalid_cursor`. This satisfies "stable enough within a session, no monotonic-timestamp/durability promise."

The cursor format is implementation-defined per the spec — clients MUST treat it opaque. No client should need to peek inside it.

## 10. Separation from `/_ref/search`

- The existing `/_ref/search` handler stays exactly as is, except for a `// Reference-only — not the public lexical retrieval surface (see GET /v1/search).` comment band above it.
- The new `/v1/search` route is registered separately and shares **no** index, snapshot, or response code with `/_ref/search`.
- They MAY share infrastructure later, but they MUST NOT share contract — so for now, the cleanest move is "no shared code."

## 11. Dashboard switchover

`apps/web/src/app/dashboard/search/page.tsx` today does:

1. `refSearch(query)` → spine jump for trace/grant/run
2. `searchRecords(query, scope)` → fan out across all streams, paginate each, JSON-stringify-substring-match in JS

After this change:

1. `refSearch(query)` stays exactly as is — it serves the `_ref/search` operator-jump UX and the deep-link redirect on exact id match. That surface is reference-only and continues to be reference-only.
2. `searchRecords(query, scope)` is replaced by a new `searchRecordsLexical(query, scope)` in the existing `apps/web/src/app/dashboard/lib/rs-client.ts` (the same module that already exposes `listStreams`, `getStreamMetadata`, `queryRecords`, `getRecord` — server-only, owner-token, public-RS). The new helper calls `GET /v1/search` once with the dashboard's owner token; the public endpoint internally fans out across every owner-visible connector. The response carries `connector_id` on every result, which the page maps to the existing `RecordHit.connectorId` shape. The brute-force `recordMatches`, `extractSnippet`, and per-stream fan-out are deleted — the snippet now comes from the public endpoint. Reference-only `_ref` calls keep living in `apps/web/src/app/dashboard/lib/ref-client.ts`. The page UI is unchanged.

This satisfies the spec scenario "dashboard MUST consume the extension once it ships" and removes the duplicate enforcement path the dashboard had been pretending was equivalent.

## 12. Docs cleanup

`apps/web/content/docs/spec-data-query-api.md` ends with:

> If richer cross-stream search is needed later, add `POST /v1/search` with a query DSL on top of the same grant enforcement engine.

That sentence is rewritten:

> Public lexical retrieval lives in the optional **lexical retrieval extension** at `GET /v1/search`. See [Lexical retrieval extension](./spec-lexical-retrieval-extension) for the contract. A future `POST /v1/search` body-DSL is reserved for richer queries but is not yet specified.

A new doc page `spec-lexical-retrieval-extension.md` is created at the same depth as `spec-data-query-api.md`, mirroring its sectioning (Overview / Authentication / Endpoint / Result shape / Errors / Discovery / Pagination / Non-goals).

## 13. Coordination with `swap-sqlite-driver`

The agent on `swap-sqlite-driver` is mid-flight on changing the SQLite driver in `db.js`. To keep collisions amicable:

- All implementation here happens in the `implement-lexical-retrieval-extension` worktree off commit `7aa10d4`.
- The FTS5 schema change is **additive**: a `CREATE VIRTUAL TABLE IF NOT EXISTS` plus three new write-path call sites. No existing tables, queries, or driver wrapper functions are modified.
- The FTS5 maintenance lives in `search.js` and calls `db.query(sql\`…\`)` through the existing wrapper that the migration agent is themselves swapping out, so we naturally follow whatever shape they land on at merge time.
- If a merge conflict appears, the resolution is:
  - prefer the migration agent's driver-API changes
  - re-target the FTS5 calls onto whatever wrapper they land on
  - keep the FTS5 schema and maintenance semantics exactly the same

## 14. Test plan

`reference-implementation/test/lexical-retrieval.test.js` covers the following scenarios verbatim from the approved spec:

- RS metadata exposes `capabilities.lexical_retrieval` with all six required keys, `supported: true`
- A non-supporting build (`opts.lexicalRetrievalSupported = false`) omits the block or sets `supported: false`
- `/_ref/search` is not advertised as the public lexical retrieval surface and is not aliased to `/v1/search`
- `GET /v1/search` rejects missing `q` with `invalid_request_error`
- `GET /v1/search` accepts `q + limit + streams[]`
- `GET /v1/search` rejects `filter[recipient]=alice`, `rank=...`, `embedding=...`, vendor-specific params with `invalid_request_error`
- `GET /v1/search?connector_id=...` is rejected with `invalid_request_error` for both owner and client tokens (the public surface has no `connector_id` param)
- `GET /v1/search?streams[]=<not-in-grant>` (client token) returns `permission_error` with code `grant_stream_not_allowed`
- `GET /v1/search` cross-stream returns `invalid_request` when advertisement reports `cross_stream: false` (test uses an opts flag to flip cross_stream)
- Each result has `object: 'search_result'`, required `stream`/`record_key`/`emitted_at`/`connector_id`, no portable numeric score
- For client tokens, `record_url` resolves to `/v1/streams/{stream}/records/{record_key}` with no `connector_id` query param
- For owner tokens, `record_url` resolves to `/v1/streams/{stream}/records/{record_key}?connector_id=<canonical>` with the originating connector encoded
- `record_url` may be omitted (helper test confirms a result without `record_url` is still valid as long as `stream`, `record_key`, `emitted_at`, `connector_id` are present)
- `matched_fields` is a non-empty subset of declared `lexical_fields` ∩ grant projection
- A grant that authorizes only a subset of declared `lexical_fields` returns `matched_fields` constrained to that subset; snippet text never quotes the unauthorized field
- A stream with declared `lexical_fields` but zero overlap with the grant contributes zero hits and no per-stream error
- Owner-token search: with two owner-visible connectors that both expose a stream named `messages`, hits from BOTH connectors appear, each with its own `connector_id`
- Owner-token search: `streams[]=nonexistent_stream_anywhere` returns an empty result list (NOT an error — owner-mode `streams[]` is a soft filter, not the client-mode hard error)
- Owner-token search: `record_url` for a hit is dereference-able by the dashboard's `getRecord(connector_id, stream, recordId)` helper
- Pagination: `next_cursor` round-trip works; reusing the cursor on `/v1/streams/.../records?cursor=...` returns `invalid_cursor`
- `/_ref/search` and `/v1/search` are independent routes with independent backings (test calls both, asserts neither aliases the other)
- Manifest validator rejects: nested paths, array-typed schema fields, blob refs, unknown fields, empty arrays, non-string entries

The dashboard switchover gets a smaller integration check in `apps/web` if a test harness exists at the right depth; otherwise a manual smoke note in the change.

## 15. Acceptance bar

This change is done when:

1. Every scenario in `add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md` has at least one passing test.
2. `openspec validate add-lexical-retrieval-extension --strict` passes (it should already; we did not touch it).
3. `openspec validate implement-lexical-retrieval-extension --strict` passes.
4. `pnpm --filter pdpp-reference-implementation test` is green for the new file plus no regressions elsewhere.
5. The dashboard search page renders the same hit list shape against `/v1/search` as it did against the brute-force fan-out.
6. The docs page reads consistently with the spec delta and the new extension doc page.
7. Stale wording (`POST /v1/search` deferral, "richer cross-stream search later") is removed; a final grep confirms no orphan references.

If any of those fail, the change is not done.
