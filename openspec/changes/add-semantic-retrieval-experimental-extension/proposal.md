## Why

Lexical retrieval (see `add-lexical-retrieval-extension`) is the stable public retrieval floor PDPP is committing to. It is enough for most "find the X about Y" agent navigation, and it keeps the protocol out of opinionated territory.

It is **not** enough on its own. The accumulated evidence:

- Real agents already hit the ceiling of exact filters + pagination on real owner-scale corpora (see `openspec/changes/add-polyfill-connector-system/design-notes/semantic-retrieval-surface-open-question.md`).
- Lexical retrieval helps materially, but it does not close paraphrase ("my bank fees" vs "overdraft charges"), cross-language recall, or conceptual similarity over idiosyncratic generated/private connector schemas.
- Generated and private connectors (see `openspec/changes/add-polyfill-connector-system/design-notes/pdpp-trust-model-framing.md`) will make schema names and field labels much more idiosyncratic, amplifying the gap that semantic retrieval is meant to cover.

At the same time, semantic retrieval carries strong opinion — embedding model choice, model-upgrade/re-embedding cost, language and locale bias, vector index backend, reranker policy, self-export treatment of derived artifacts. The status-options note for semantic retrieval (`openspec/changes/reference-implementation-program/design-notes/semantic-retrieval-status-options-2026-04-23.md`) concludes that this capability is:

- **too valuable to keep reference-only indefinitely**, and
- **too opinionated to make core now**.

The owner execution brief (`openspec/changes/reference-implementation-program/design-notes/semantic-retrieval-experimental-extension-2026-04-23.md`) formalizes the middle position: ship the smallest honest public semantic retrieval capability **now**, but explicitly as an **experimental, unstable, optional extension**, while prelaunch project state still lets us revise or cut the contract without breaking outside users.

This change drafts that contract. The public surface must be:

- dedicated and non-overlapping with lexical retrieval
- text-query only
- grant-safe on every path including snippets
- truthfully advertised with explicit `stability: "experimental"`
- honest about what is implementation-defined (model, backend, ANN, reranker, tokenizer, blending formula, rebuild mechanics)

Lexical retrieval remains the stable retrieval floor. Semantic retrieval is **additive** and **revisable**.

## What Changes

- **Introduce a new optional extension capability** named `semantic-retrieval`, marked **experimental / unstable**. Core PDPP is not modified. Lexical retrieval is not modified. Clients MUST NOT assume this extension exists unless the server explicitly advertises it, and clients that rely on it MUST accept that breaking revisions are acceptable during the experimental phase.
- **Define one dedicated public endpoint**: `GET /v1/search/semantic`. The approved lexical retrieval route `GET /v1/search` is not mutated, not overloaded, and not aliased. The two routes are distinct public surfaces with distinct capabilities.
- **Restrict v1 query input to text**: allowed parameters are `q` (required), `limit`, `cursor`, and repeated `streams[]`. The endpoint SHALL NOT accept raw vectors, client-supplied embeddings, model selectors, ranking knobs, connector-specific parameters, or any semantic DSL. Disallowed parameters are rejected with `invalid_request_error`.
- **Return candidate references, not hydrated records**. The result shape stays intentionally close to the lexical `search_result` (`stream`, `record_key`, `connector_id`, optional `record_url`, `emitted_at`, `matched_fields`, optional grant-safe `snippet`) and adds one explicitly experimental field `retrieval_mode` (`"semantic"` or `"hybrid"`). A portable numeric relevance score SHALL NOT be exposed in v1.
- **Define a stream-level `query.search.semantic_fields` declaration** for semantic-searchable fields, parallel to `lexical_fields`. v1 accepts top-level textual fields only (no nested paths, no arrays, no blobs, no connector-specific semantics). "Semantic-searchable" is opt-in per field. There is no silent "embed every string we can find."
- **Enforce grant safety on every path**: the extension searches only over `(stream, field)` pairs where the stream is in the caller's grant, the field is readable under the grant's effective field projection, AND the stream declared the field in `query.search.semantic_fields`. Unauthorized fields never contribute to matching, ranking, or snippets. Snippets never include substrings drawn from fields outside that intersection. "Embed everything, filter later" is explicitly prohibited.
- **Publish a `capabilities.semantic_retrieval` object** inside the existing resource-server metadata document (reusing the same carrier approved for `lexical_retrieval`, per `capability-discovery-options-2026-04-22.md`). It declares: `supported`, `stability: "experimental"`, `endpoint`, `cross_stream`, `query_input: "text"`, `snippets`, `lexical_blending`, `model`, `dimensions`, `distance_metric`, `default_limit`, `max_limit`, `index_state` (one of `built`, `building`, `stale`), and, when the configured model has materially known language/locale bias, a `language_bias` descriptor. No broader new capability document is introduced.
- **Define opaque cursor pagination** distinct from record-list pagination, from `changes_since`, and from lexical-search pagination. Semantic-search cursors are never reusable on other surfaces. No promise of monotonic timestamps or durability across rebuilds.
- **Explicitly mark what is implementation-defined**: embedding backend, vector/index backend, ANN strategy, tokenizer, reranker, lexical blending formula, batch/rebuild mechanics, per-owner/per-deployment localized model choice. The hackable reference remains hackable.
- **Explicit non-goals** for this tranche: not core, not cross-server comparable, not portable numeric score semantics, not canonical embedding export, not cross-connector entity resolution, not a generalized vector API, not a replacement for lexical retrieval, no raw vector query surface, no client-supplied embedding query, no connector-specific semantic semantics, no mutation of `GET /v1/search`, no overloading of `/_ref/search`, no new broad discovery document.

## Why this is acceptable now

Lexical retrieval's status memo documents the conservative preference: extensions should graduate, not be minted casually. Semantic retrieval does not clear that bar. But the semantic status memo and the experimental-extension brief both recognize that the project's prelaunch state materially changes the calculus:

- No outside users depend on any public semantic contract yet.
- A discoverable public extension produces materially better product feedback than a hidden reference-only surface.
- Breaking revisions and full retraction are still acceptable if the experiment fails.

The experimental framing is the discipline that makes this acceptable: it is *publicly named* so implementations cannot pretend ambient semantic behavior is portable, and *publicly unstable* so clients cannot accidentally pin to it.

## Capabilities

### New Capabilities
- `semantic-retrieval`: defines an **experimental**, optional, discoverable, grant-safe, text-query-only semantic retrieval surface at `GET /v1/search/semantic`, with stream-level semantic-searchable field declarations and a capability advertisement published inside the existing resource-server metadata document. Stability is `experimental`; the contract is publicly unstable and may be revised or retracted.

### Modified Capabilities
- *(none)*. Lexical retrieval (`add-lexical-retrieval-extension`) is deliberately untouched: its route, its result shape, its discovery contract, and its grant semantics are not modified by this change. Core PDPP (`reference-implementation-architecture`, `reference-implementation-governance`) is not modified.

## Impact

- `openspec/specs/semantic-retrieval/spec.md` (new on archival)
- `openspec/changes/add-lexical-retrieval-extension/` — no change required; this tranche depends on that one landing but does not edit it.
- `apps/web/content/docs/spec-data-query-api.md` — if the lexical tranche's truthfulness cleanup lands first, this change adds a short, clearly-experimental pointer to the semantic extension. It MUST NOT imply semantic retrieval is on the same stability tier as lexical retrieval.
- `apps/web/content/docs/` — new or cross-referenced extension doc describing `GET /v1/search/semantic`, `query.search.semantic_fields`, and the `capabilities.semantic_retrieval` advertisement, with the **experimental** marker surfaced prominently.
- `reference-implementation/` (future implementation tranche): build the extension as a first-class public surface using a server-chosen embedding backend (the choice itself is implementation-defined — see `design.md` §9). Any reference-only `/_ref/*` semantic experiments remain distinct and MUST NOT be aliased to `/v1/search/semantic`.

## Deferred / Follow-ups

These are intentionally excluded from this change. They are listed so future tranches can pick them up without rediscovering the shape:

- Promotion from **experimental** to a stabilized optional extension (requires one proving cycle; see `semantic-retrieval-status-options-2026-04-23.md` promotion criteria).
- Promotion to core PDPP (requires universal client dependence plus stabilized shape; not a topic for this tranche).
- Raw vector query input (`vector=...`, ANN-direct) as a public surface.
- Client-supplied embeddings (`embedding=...`) as a public surface.
- Multiple concurrent embedding models declared in one public contract.
- Portable numeric relevance score contract (BM25-like, cosine-exposed, or otherwise).
- Canonical embedding export in owner self-export (see `owner-self-export-open-question.md`; derived-artifact ownership is a separate decision, deliberately not pre-empted here).
- Cross-connector entity resolution.
- Generic vector/ANN API.
- `POST /v1/search/semantic` body-DSL for richer queries.
- Nested paths, arrays, or blob indexing in `semantic_fields`.
- Connector-specific ranking/tokenization/model hints as portable contract.
