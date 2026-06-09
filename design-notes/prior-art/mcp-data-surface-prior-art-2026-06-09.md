# PDPP MCP Data Surface — SLVP Prior-Art References

Status: complete (3 research strands, all citation-backed from primary sources)
Owner: reference implementation owner (delegated worker)
Created: 2026-06-09
Related: `design-notes/mcp-server-design-research-2026-05-21.md` (transport/auth/capability shape — this note does NOT re-cover that), `design-notes/full-context-refresh.md` (SLVP bar = Stripe/Linear/Vercel/Plaid), `~/sandbox/pdpp-battery-report.md` + `~/sandbox/pdpp-battery-retest.md` (the defects this benchmarks against), `spec-core.md` §8

## Question

The MCP `schema` → `query_records` → `search`/`fetch` → `aggregate` data surface works correctly, but a live battery (2026-06-09) found defects concentrated in **payload shape**: duplicated search arrays, comma-wrapped snippets, `title`=snippet, a 1 MB `detail:"full"` schema, and (now fixed) per-connection search limits. What do the SLVP exemplars (Stripe, Linear, Vercel, Plaid) and the leading search/retrieval engines do here, so PDPP's data surface resembles their work "by construction"?

This note is **interface-contract prior art** for the *data surface*. The companion `mcp-server-design-research-2026-05-21.md` already settled the *transport/auth/capability* shape (stdio adapter, read-only over the RS, no new grants). No overlap.

## TL;DR (what to adopt)

Mapped against the live battery findings:

| Battery finding | SLVP / industry convention | Source |
| --- | --- | --- |
| `search` returns hits twice (`data.data[]` + `results[]`) — **was FAIL, now FIXED** | **Exactly one canonical array.** Stripe list = `{object:"list", data:[…], has_more, url}` — one `data[]`, period. MCP: the *only* sanctioned duplication is a JSON-serialized mirror of `structuredContent` in a `content[]` text block for backwards-compat — never an independent second hit array. | Stripe pagination; MCP 2025-06-18 tools |
| Snippet wraps matches in bare commas (`,budget,`) — **UNCHANGED** | **Paired, balanced, body-safe delimiter tags.** Every major engine: `<em>…</em>` (Elasticsearch, OpenSearch, Algolia, Meilisearch defaults) or `<mark>…</mark>` (Typesense default), configurable via `pre_tags`/`post_tags`. A bare comma is unbalanced (can't tell open from close) and collides with prose, numbers (`$1,200`), and CSV. **Zero** engines use a bare punctuation mark. | ES/OpenSearch/Algolia/Typesense/Meilisearch |
| `title` = snippet — **UNCHANGED** | **`title` and `snippet` are distinct fields with distinct jobs.** OpenAI's MCP contract: `title` = "human-readable title" (the citable document name); the matched excerpt belongs in `text`/snippet. Setting `title`=snippet destroys citable identity and dedup, and feeds the agent low-signal context where a name belongs. | OpenAI MCP / deep-research; Anthropic tools |
| `detail:"full"` schema = 1 MB, ignores `stream` scope — **REGRESSED** | **Progressive disclosure + `$ref` dedup.** Linear: introspect one type at a time on demand; the type system *is* the capability doc. Stripe/Vercel OpenAPI: each entity defined once under `components/schemas`, referenced by `$ref` — 600+ endpoints don't re-inline `Charge`. MCP: tools discovered via `tools/list`, not a giant embedded schema. PDPP's own `schema` → `schema(stream)` path is the right model; `detail:"full"` must honor `stream` and return one stream. | Linear GraphQL; Stripe/Vercel OpenAPI; MCP tools |
| `query_records` projection (was leaking envelope) — **FIXED**; `fetch` double-prints `text` — **IMPROVED** | **Lean-by-default + two opt-in levers.** GraphQL (Linear): response shape = query shape, server only serializes requested fields. Stripe: lean responses, related objects as IDs, opt into joins via `expand[]`. Adopt both: a `fields=` sparse-fieldset whitelist *and* a Stripe-style `expand[]`. | Linear GraphQL; Stripe `expand[]` |
| fan-in `limit` applied per-connection — **was FAIL, now FIXED** | **One opaque `next_cursor` + one `has_more` at envelope top level; encode per-source state inside the cursor.** Never expose offsets (Plaid's `count`/`offset` is the model to avoid for fan-out). For re-sync, steal Plaid `/transactions/sync`'s `added`/`modified`/`removed` + `next_cursor` delta shape. | Stripe/Linear cursors; Plaid sync |

## Findings

### 1. List envelope — single source of truth (Stripe)
`https://docs.stripe.com/api/pagination`, `https://docs.stripe.com/api/charges/list`

Stripe's list envelope has exactly four top-level fields and one canonical array:
```
{ "object": "list", "url": "/v1/charges", "has_more": false,
  "data": [ { "id": "ch_3M…", "object": "charge", "amount": 1099, … } ] }
```
Every element self-describes via its own `id` + `object` discriminator, so any item is identifiable out of context. The PDPP anti-pattern (same hits in `data.data[]` *and* a flattened `results[]`) violates single-source-of-truth, doubles a token-metered payload, and drifts after any transform. **Rule: one canonical `data[]`/`results[]`; pagination metadata lives beside it, never duplicating it.** (PDPP's update already collapsed this to a single `results[]` + `results_ref` — matches the convention. Keep it.)

### 2. Pagination — opaque cursor, not offset (Stripe / Linear / Plaid)
- **Stripe** (`/api/pagination`): `limit` default 10 / max 100, opaque `starting_after`/`ending_before` (an object ID you already received), `has_more` boolean. Cursors mutually exclusive.
- **Linear** (`linear.app/developers/pagination`): Relay-style `first`/`after` + `pageInfo { hasNextPage endCursor }`; default page 50.
- **Plaid** (`plaid.com/docs/api/products/transactions`): classic `count`(max 500)/`offset`(default 0) on `/get`, **and** a modern delta-sync on `/transactions/sync` returning `added`/`modified`/`removed` + `next_cursor` + `has_more`.

**For fan-out across sources, opaque-cursor beats offset:** an opaque token can encode per-source state (`base64({sourceA:curX, sourceB:curY})`) and expose one `has_more`+`next_cursor` to the caller while resuming each source independently. Offset forces all sources onto one numeric coordinate and breaks when data shifts. PDPP already uses opaque cursors (`{snap, off}` for search, `{order, cursor_value, primary_key_text}` for records) — consistent with the convention. The unrealized upgrade: a Plaid-`sync`-style delta mode (`changes_since` already exists in PDPP — surface it as `added`/`modified`/`removed`).

### 3. Field selection — lean by default, two opt-in levers (Linear / Stripe)
- **Linear GraphQL** (`linear.app/developers/graphql`): response shape = query shape; the server only ever serializes requested fields. Ideal for a token-metered API because the *caller* controls payload.
- **Stripe `expand[]`** (`/api/expanding_objects`): lean by default (related objects are IDs), opt into expansion; recursive via dotted paths; on lists, expansions start at `data.` (`expand[]=data.customer`).

REST "return a fixed wide record, then project" still materializes + serializes the wide record server-side before trimming — you pay then discard. **Adopt both levers:** a `fields=` whitelist (sparse fieldset) to trim down + a Stripe-style `expand[]` to opt into joins; default related objects to references, never inline a graph unless asked. (PDPP's `fields` projection is now fixed and `expand` already exists — this validates the direction.)

### 4. Error envelope — two-level taxonomy + two messages + request_id (Stripe / Plaid)
- **Stripe** (`/api/errors`): `error.{type, code, message, param, …}` + `request_id` on responses.
- **Plaid** (`plaid.com/docs/errors`): `{error_type, error_code, error_message, display_message (user-safe, nullable), documentation_url, suggested_action, status, request_id}` — and explicitly: prefer `error_code`/`error_type` over HTTP status for app-level errors.

Good and copyable: (1) coarse `type` to branch on + stable specific `code` to handle; (2) separate developer `message` vs user-safe `display_message`; (3) a machine-attachable pointer (`param` / `documentation_url`) for routing or self-heal; (4) `request_id` on **every** response; (5) status mirrored into the body so MCP tools needn't see the HTTP layer. **PDPP's typed errors are already strong** (distinct `code`s: `grant_stream_not_allowed`, `unknown_field`, `invalid_expand`, `invalid_sort`, `ambiguous_connection`). Gaps vs SLVP: PDPP returns `request_id: null` on success envelopes (Stripe/Plaid populate it always), and has no `display_message`/`documentation_url`. Adopt both.

### 5. The MCP `search`+`fetch` contract (OpenAI) + tool-result rules (MCP spec)
`https://platform.openai.com/docs/mcp`, `https://platform.openai.com/docs/guides/deep-research`, `https://modelcontextprotocol.io/specification/2025-06-18/server/tools`

- **`search` result object:** `id`, `title` ("human-readable title"), `url` ("canonical URL for citation"); optional snippet/`text`.
- **`fetch` result object:** `id`, `title`, `text` ("full text"), `url`, `metadata` (optional key/value).
- **Wrapping:** return the object as `structuredContent` **and** a JSON-encoded string mirror in `content[]` — the MCP spec's words: *"a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block"* — strictly a backwards-compat serialized mirror, **not** a second independent payload. Declare an `outputSchema` so clients validate.
- **Errors:** protocol errors = JSON-RPC (`-32602` etc.); tool-execution errors = a successful result with `isError: true` so the model can react. (Known wrinkle: some SDKs validate `structuredContent` against `outputSchema` before honoring `isError` — typescript-sdk#654.)
- **Token efficiency (Anthropic, "Writing effective tools for agents"):** "return only high-signal information… eschew low-level technical identifiers (`uuid`, `mime_type`)"; implement pagination/range/filter/truncation with sane defaults (Claude Code caps tool responses at 25k tokens); offer a `response_format` enum (`concise`/`detailed`) so the agent controls verbosity.

PDPP's `fetch` now returns the OpenAI-shaped document only: `id/title/text/url/metadata` in `structuredContent`, with that exact object mirrored as JSON text in `content[]`. It does **not** also carry the canonical PDPP record envelope under `structuredContent.data`; structured record reads are handled by `query_records`. This turns the former `text` + `data.data.text` overlap into the one duplication MCP explicitly permits: a serialized mirror for compatibility.

### 6. Highlight / snippet conventions (Elasticsearch, Algolia, Typesense, Meilisearch) + hybrid scores
| Engine | Default markers | Cite |
| --- | --- | --- |
| Elasticsearch / OpenSearch | `<em>…</em>`, via `pre_tags`/`post_tags` | elastic.co/guide …/highlighting.html; opensearch.org …/highlight |
| Algolia | `<em>…</em>`, `_highlightResult`/`_snippetResult` with `matchLevel` (full/partial/none) | algolia.com/doc …/understanding-the-api-response |
| Typesense | `<mark>…</mark>` (`highlight_start_tag`/`highlight_end_tag`) | typesense.org/docs/29.0/api/search |
| Meilisearch | `<em>…</em>` (`highlightPreTag`/`highlightPostTag`), in `_formatted` | meilisearch.com/docs/reference/api/search |

**Standard = a paired, balanced, body-safe open/close tag** so a renderer can unambiguously bound each span. `<mark>` is the most semantically correct for non-HTML-escaping renderers (it's the HTML element literally meaning "highlighted"). **A bare comma fails on all counts:** unbalanced (can't distinguish open from close — `,a, ,b,` is unrecoverable), and collides with prose, numbers, and CSV. Recommendation: replace `,term,` with `<mark>term</mark>` (or `<em>`), make the tags configurable, and keep `title` (real record title — for Slack: channel + author + time) separate from the highlighted `snippet`.

**Hybrid-fusion scores:** Elasticsearch/Qdrant RRF (`Σ 1/(k+rank)`, k≈60/2), Weaviate Relative-Score-Fusion (default since 1.24). All expose **higher fused score = more relevant** and surface a per-result breakdown (`explainScore`). PDPP exposes raw `bm25` (negative, `lower_is_better`) and `semantic_distance` separately and labels direction — honest, but for `hybrid` consider emitting a single fused, higher-is-better score with an `explain`-style breakdown so an agent can rank without knowing each engine's sign convention.

## Protocol lineage — the stream/cursor/catalog model PDPP resembles

**Framing claim CONFIRMED (citation-backed):** "PDPP is an Airbyte-shaped catalog wearing an OData-shaped query dress." The `schema → stream → primary_key/cursor_field` discovery model is the Airbyte/Singer ELT lineage; the `query_records` surface (typed filters, `fields` projection, `expand`, `cursor`/`limit`, `aggregate`, `count`) is the OData `$filter`/`$select`/`$expand`/`$skip`/`$count` vocabulary in JSON clothes. Refinement: PDPP is also Singer-shaped at the message layer (SCHEMA/RECORD/STATE separation), and its per-stream `schema(stream)` fetch *is* the introspection-on-demand discipline that GraphQL and OData use to avoid dumping a giant catalog — that anti-giant-dump behavior is the through-line across all six, and the one place the `detail:"full"` payload still diverges (now on verbosity, not scope — the scope bug is fixed per retest pass 2).

### Airbyte Protocol — the direct ancestor (`docs.airbyte.com/understanding-airbyte/airbyte-protocol`)
`AirbyteCatalog` (from the `discover` action) = list of `AirbyteStream`, each with `name` + `json_schema` (relational columns become `properties` keys), `supported_sync_modes` (`full_refresh`/`incremental`), `source_defined_primary_key`. **Cursor precedence ladder (exact):** `source_defined_cursor:true` → source picks, *cannot be overridden*; else caller's `cursor_field`; else `default_cursor_field`; all-falsey = illegal. `ConfiguredAirbyteCatalog` = the consumer-selected subset (capability catalog vs chosen projection). State is an **opaque black box** the source emits and nothing else may parse (`null` = no state).
**STEAL:** (1) the 3-tier cursor precedence + a per-stream **`source_defined_cursor` boolean** so the agent knows when it may *not* override the cursor — cheap capability advertisement that prevents invalid configs; (2) the **opaque-state black-box rule** — hand the agent a cursor token it must only echo, never parse (PDPP already does this); (3) the discover/configure split — advertise capability uniformly per stream rather than hardcoding.

### Singer — the message-level skeleton (`github.com/singer-io/getting-started/blob/master/docs/SPEC.md`)
Three message types: `SCHEMA` (`schema` JSON Schema + `stream` + `key_properties` + optional `bookmark_properties`), `RECORD`, `STATE`. A RECORD not preceded by a SCHEMA "is assumed to be schema-less" — **schema is emitted per-stream, interleaved, never as one monolithic dump.** `key_properties` "may be an empty list to indicate that there is no primary key."
**STEAL:** (1) the **empty-`key_properties` = explicit no-PK** convention (vs absent/ambiguous); (2) the per-stream interleaved SCHEMA discipline — direct confirmation of PDPP's `schema(stream)` over a catalog dump. `bookmark_properties` is the direct ancestor of `cursor_field`.

### Steampipe — the road-not-taken: SQL-tables-over-APIs (`steampipe.io/docs`, `/docs/sql/steampipe-sql`)
"Zero-ETL"; Postgres FDWs "translate APIs to foreign tables"; "if you know SQL, you already know how to query Steampipe" (`WHERE`/`LIKE`/`AND`/`OR`/`ORDER BY`/`count`/`sum`/`min`/`max`/`avg`/`JOIN`). **Critical efficiency note (exact):** querying all columns "is inefficient… you should only query the columns that you need. This will save Steampipe from making API calls to gather data that you don't want" — **projection prunes upstream API calls, not just bytes.**
**SQL-tables vs typed-tool for an LLM:** the **typed-tool (PDPP) wins on discovery + token efficiency** — a typed tool with an enumerated filter vocabulary + `schema(stream)` introspection is self-describing and constrains the model to valid ops; raw SQL needs table/column names a priori (or an `information_schema` dump — the very giant-dump to avoid) and can be arbitrarily wrong. SQL wins only on expressive power (cross-connector `JOIN`/`UNION` in one statement, which PDPP approximates with `expand` + client-side joins).
**STEAL:** make `fields`/`aggregate` explicitly **skip connector API calls for unrequested fields** and advertise that in the schema, so the agent is incentivized to project narrowly; model cross-connector `aggregate` on SQL `JOIN`/`UNION`.

### OData v4 — the query-dress vocabulary (`odata.org/getting-started/basic-tutorial`)
`$metadata` = the CSDL service-definition doc at one well-known endpoint; every response carries `@odata.context: serviceRoot/$metadata#<EntitySet>` pointing back at it — **schema fetched once, not inlined per response.** Closed typed operator vocabulary: `$filter` with `eq`/`gt`/`ge`/`lt`/`le`/`and`/`or` + functions (`endswith`) + lambda `any`/`all` over collections. `$select` (projection), `$expand` (inline relations), `$top`/`$skip`, `$count`, `$orderby`, `$search`. **`@odata.id`/`$ref`** expresses a relationship as an **entity reference** (`{"@odata.id":"serviceRoot/People('x')"}`) instead of re-embedding the entity — the dedup mechanism.
**STEAL:** (1) pin PDPP's typed filter objects to OData's exact operator names (`eq/gt/ge/lt/le/and/or` + `any`/`all` for arrays) so the grammar is recognizable and the schema advertises which operators each field supports (PDPP's `{gte,gt,lte,lt}` is close — aligning the names makes it instantly legible to anyone who's used OData/Microsoft Graph); (2) the **`@odata.id`/`$ref` reference-instead-of-embed** pattern — when `expand` would duplicate the same related entity across many records, return a stable id reference and let the agent fetch once (the `$ref`-style dedup that also answers the `detail:"full"` verbosity residual).

### GraphQL / Apollo Federation — one stitched schema, introspection-on-demand (`apollographql.com/docs/federation`)
"Declaratively combine multiple APIs into a single federated GraphQL API" — the **supergraph**; constituent APIs are **subgraphs** (any language; REST via Apollo Connectors); a **router** orchestrates one client request across them into a unified response. GraphQL's defining property: the client asks for exactly the fields it wants, and schema is discovered via **introspection on demand** (`__type(name:)` for one type, not the whole schema per response).
**STEAL:** the supergraph/router + selective-introspection model maps cleanly: `schema()` lists streams (supergraph type names), `schema(stream)` introspects one type's fields/filters/relations (introspection-on-demand), `query_records` is the field-precise selection set. The strongest articulation of "never dump the whole schema."

### RFC 9396 Rich Authorization Requests — fine-grained consent (`datatracker.ietf.org/doc/html/rfc9396`)
`scope` is "sufficient… for coarse-grained" but "not sufficient to specify fine-grained authorization requirements." `authorization_details` = a JSON array of typed objects; each has required `type` plus common fields `locations` (resource URIs), `actions`, `datatypes`, `identifier`, `privileges`; combined fields multiply (permissions = product of values).
**STEAL:** model PDPP grants as `authorization_details[]` — `type` = connector/stream, `datatypes` = fields/streams, `actions` = `["read","search","aggregate"]`, `locations`/`identifier` = `connection_id`. Standard, auditable vocabulary for the grant-scoping PDPP already does, aligning consent with the schema's per-stream granularity. (Plaid item/account scoping is the commercial analogue — asserted, not freshly cited this pass.)

### One-line steal per protocol
- **Airbyte:** 3-tier cursor precedence + `source_defined_cursor` capability flag + opaque-state black box.
- **Singer:** empty-`key_properties` = explicit no-PK; per-stream interleaved SCHEMA (never one dump).
- **Steampipe:** projection (`fields`) should prune *upstream* API calls, not just bytes; advertise it.
- **OData:** standardize on `eq/gt/ge/lt/le/and/or` + `any/all` operator names; use `@odata.id`/`$ref` to dedup expanded entities.
- **GraphQL/Federation:** `schema()`→list, `schema(stream)`→introspect-one, `query_records`→field-precise selection = the canonical "don't dump the schema" loop.
- **RFC 9396:** express grants as typed `authorization_details[]` (`type`/`datatypes`/`actions`/`locations`) instead of coarse scopes.

**Net lineage takeaway:** PDPP is an Airbyte-shaped catalog (streams/cursor/primary_key/per-field capabilities) wearing an OData-shaped query dress, exposed through the MCP/OpenAI search-fetch contract, under an RFC 9396-style consent layer. All six share one discipline — *never dump the whole schema; fetch per-stream/per-type on demand, reference-deduped*. PDPP's `schema → schema(stream)` path already embodies it; the remaining `detail:"full"` verbosity (and the compact `schema()` double-listing) are the last places to apply `$ref`/`@odata.id`-style dedup.

Sources: docs.airbyte.com/understanding-airbyte/airbyte-protocol · github.com/singer-io/getting-started/blob/master/docs/SPEC.md · steampipe.io/docs (+ /docs/sql/steampipe-sql) · odata.org/getting-started/basic-tutorial · apollographql.com/docs/federation · datatracker.ietf.org/doc/html/rfc9396

## Decision Log
- 2026-06-09: Captured interface-contract prior art for the MCP *data surface*, benchmarked against SLVP (Stripe/Linear/Vercel/Plaid) + leading search engines + the OpenAI/MCP search-fetch contract. Highest-leverage adoptable fixes, in order: (1) honor `stream` scope in `detail:"full"` + `$ref`-dedup the schema (kills the 1 MB regression); (2) replace comma snippet delimiters with `<mark>`/`<em>` paired tags; (3) make `title` a real record title, not the snippet; (4) make `fetch` document-only and use only the MCP JSON text mirror for compatibility; (5) populate `request_id` always + add `display_message`/`documentation_url` to errors. Protocol lineage is captured above.
