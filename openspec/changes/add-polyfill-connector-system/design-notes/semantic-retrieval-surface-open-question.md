# Open question: semantic retrieval surface — what search primitives does the RS expose, and who owns the ranker?

**Status:** open
**Raised:** 2026-04-20
**Trigger:** An outside coding agent given a PDPP owner token hit the practical ceiling almost immediately: `/v1/streams/messages/records` has 186k Slack messages, 17.8k Gmail messages, 9k ChatGPT messages, plus everything else. Paginating linearly to find "anything the owner said about X last month" is ~2,000 round-trips per connector. Today's filter primitives (exact-match only, see `rs-api-discoverability-open-question.md`) don't help because the question is "similar to" not "equal to."

Meanwhile, anyone who builds on PDPP will re-embed the same 800k records. That's a staggering amount of duplicated work across implementations and the forcing function the blob-hydration note already named for binaries ("don't make every consumer re-derive expensive things that are identical across consumers"). Embeddings and BM25 indexes fall in the same class.

An intuition worth considering — ship recall primitives (BM25 + vector) upstream, keep the ranker client-side — matches the Postgres "ship tsvector and pgvector, don't ship the ranker for your app" line, and matches how Pinecone / Weaviate / Turbopuffer draw the line today. Whether that intuition survives the actual decision depends on trade-offs this note tries to enumerate, not resolve.

**Framing:** Search surface answers differ depending on which client party is primary — the owner's own agent (model choice is local) vs. a third-party client (model choice is an interop question). See `pdpp-trust-model-framing.md`. Any option below that looks appealing in one frame may look wrong in the other.

## Why this is a spec-level question

Three distinct decisions that today's spec is silent on:

1. **Is search a first-class operation on the RS at all, or is it a client concern?** If the RS only exposes records, every downstream client rebuilds the same indexes. If the RS exposes search, the spec has to define what search *means* consistently across implementations.

2. **If search exists, what recall layers are required?** BM25 (lexical), vector similarity (semantic), hybrid, or all three? Each has independent costs and implementation constraints.

3. **Who owns embedding generation and its versioning?** Embeddings are model-specific. When OpenAI ships `text-embedding-4` two years from now, does every PDPP RS re-embed 800k records? This is a known hard problem — vector DBs punt on it. PDPP shouldn't also punt unless the punt is explicit.

None of these is answered in `spec-core.md` or `spec-data-query-api.md`. All three should be, because they're interlocking: deciding (1) without (3) produces implementations that diverge on model choice; deciding (2) without (1) produces feature without interface.

## What the spec could require

### Option A — No search primitives. Records-only RS.

The RS stays narrow. Clients who want search run their own indexer against `/v1/streams/<stream>/records`, grant-scoped to whatever they need.

- **Pro:** smallest spec surface; no versioning question; implementers can't diverge on "which embedding model."
- **Con:** every client re-derives the same expensive artifacts. Unusable for agents at any real scale. Makes the reference unable to demonstrate the protocol on real-owner-scale data.

### Option B — BM25 / lexical search only

The RS exposes `GET /v1/search?q=<query>&stream=<stream>&...` that returns candidate record IDs with BM25 scores. No vectors, no model choices, no versioning issue. Lexical match on record text.

- **Pro:** no embedding-model commitment; pure-text retrieval is well-understood; SQLite FTS5, Postgres tsvector, Lucene all implement it interchangeably; answers 60-70% of "find the X about Y" queries.
- **Con:** misses paraphrase ("my bank fees" vs "overdraft charges"), misses cross-language, misses conceptual similarity. Lexical-only is honest but limited.

### Option C — Hybrid BM25 + vector, server-chosen embedding model

The RS exposes `GET /v1/search?q=...` that returns candidates scored by both BM25 and vector similarity, using a server-chosen embedding model declared in server metadata (`RFC 9728` protected-resource-metadata could carry the embedding model identifier).

- **Pro:** powerful; agents get semantic recall out of the box.
- **Con:** server picks the model and owns upgrade cost. Re-embedding 800k records on model bump is painful. Multiple implementations will pick different models; results aren't portable across PDPP instances.

### Option D — Client-brings-embedding, server-provides-index

The RS exposes `GET /v1/search?vector=<base64-float32>` where the client computes the embedding itself (via its own chosen model) and the server does approximate-nearest-neighbor lookup against an index built with the same model. Server declares which model it indexes in its metadata.

- **Pro:** clients stay in control of model choice *for queries*; server still indexes with a specific model but discloses it.
- **Con:** doesn't actually solve the "model choice is opinionated" problem — it moves it from "which model do I use to query" to "which model did the server use to index, and does my query model agree?" Query-model and index-model must match for ANN to return anything useful.

### Option E — Tiered surface: records-only core, search as capability extension

The core spec says the RS MUST expose records-only. It MAY additionally expose search primitives; if it does, it MUST declare the capability in its metadata (which layers, which model, which engine). Agents probe the metadata and adapt.

- **Pro:** minimal mandatory surface; implementations that can't afford search (resource-constrained, embedded) stay conformant; implementations that want to ship search can do so without diverging from the base spec.
- **Con:** two-tier conformance is harder to reason about; agents need capability negotiation; the ecosystem fragments between "RS" and "RS with search" in practice.

## Query-shape options (compose with A–E)

These are about what a search request and response look like, independent of which layers are mandatory:

### Option Q1 — Separate `/v1/search` endpoint

A dedicated search endpoint returns `{ object: "list", data: [{ stream, record_key, score, snippet? }] }`. Clients fetch full records via the existing `/v1/streams/<stream>/records/<key>` path.

- **Pro:** search is recognizably a different operation; response shape can be minimal (IDs + scores).
- **Con:** two round-trips to get fully-hydrated results; clients have to join manually.

### Option Q2 — Extend `/v1/streams/<stream>/records` with `q=<query>` + `rank=bm25|vector|hybrid`

Treat search as a filter-with-a-score on the existing records endpoint. Response carries `score` alongside the full record when `q=` is present.

- **Pro:** fewer endpoints; composes naturally with existing filters; one round-trip.
- **Con:** couples search to per-stream queries, making cross-stream search awkward (do you call it once per stream?).

### Option Q3 — Cross-stream search endpoint with stream scoping

`GET /v1/search?q=...&streams=messages,conversations,issues` — one call, results across multiple streams, grant-filtered.

- **Pro:** matches how agents actually think ("find anything about X across everything the owner has"); reduces round-trips.
- **Con:** response shape has to carry stream identity per result; grant enforcement is more complex when a query spans streams with different time_ranges or field projections.

## Embedding-versioning options

If Option C or D is in play, the model-versioning sub-question cannot be dodged:

### Option V1 — Embeddings are frozen per-RS

Server declares the model once and re-embeds only when explicitly rebuilt. Results drift from current SOTA over time but are stable.

### Option V2 — Per-record embedding version stamps

Each record's embedding carries a model identifier. Server can run multiple models concurrently; queries specify which model's index to search. Storage cost multiplies.

### Option V3 — Content-addressable embeddings

Embeddings are stored by (content_hash, model_id) so identical content across connectors gets a single embedding per model. Useful when the same document shows up in Gmail + Slack + a file upload.

### Option V4 — Embeddings are ephemeral (compute-on-demand)

Server doesn't store embeddings; it computes them at query time and caches. Avoids storage but puts latency on the query path and makes ANN indexing impractical.

## Implementation stack (reference impl question, not spec question)

These are candidates for the reference to pick, independent of what the spec mandates. All compose with Options A–E above:

### S1 — SQLite FTS5 + sqlite-vec

Both extensions run in-process against the existing SQLite store. FTS5 is mature; sqlite-vec now supports HNSW. Single file, no engine change, no new service.

- **Pro:** zero operational delta from today; stays embedded; nothing to deploy.
- **Con:** sqlite-vec is newer than pgvector (less battle-testing); index rebuilds on large datasets block writes; scale ceiling lower than server-DB options.

### S2 — Postgres + tsvector + pgvector

Industry-standard pair. Well-understood, well-indexed.

- **Pro:** production-grade; ecosystem is enormous; GIN / HNSW indexes are mature.
- **Con:** reference impl becomes two-process (Postgres + Node); operational surface grows; the "one-file reference" story ends.

### S3 — External vector DB (Pinecone, Weaviate, Qdrant) via connector pattern

RS stores records; a sibling service stores vectors keyed by record ID. RS proxies to it for search.

- **Pro:** each does what it's best at; independently scalable.
- **Con:** external dependency for a reference impl is a step away from "easy to run locally"; the spec may accidentally mandate an external service.

### S4 — DuckDB + FTS + FLOAT_ARRAY cosine

Columnar store with FTS extension and array math. Single-file alternative to SQLite with better analytical query performance.

- **Pro:** faster analytical queries on large record sets; good embedding math via vectorized ops.
- **Con:** less familiar to implementers than SQLite or Postgres.

## Adjacent questions this note deliberately does NOT try to answer

Each of these deserves its own note if the group decides to pursue it:

### Cross-connector entity resolution

"The person I emailed as the owner@madskater.com is @the owner in Slack is user_id 734891 in GitHub" is a real owner need (agent wants to build a unified timeline, see everything about a single person). This is a large research problem — entity resolution under uncertainty, conflicting identifiers, temporal identity drift. Whether the spec ships primitives (normalized email-hash, normalized phone-hash, canonical-form-per-identifier-type), full resolution, or nothing is its own decision. Mentioned here because it's often bundled with "semantic search" in discussion, but they're different problems.

### Ranking and reranking policy

"Server returns candidates, client reranks" assumes the client can and will rerank. Dashboards rendering "top 10 recent Slack mentions of X" may or may not be expected to rerank. Whether the spec requires, allows, or forbids server-side default ranking is a separate design question that composes with any of the options above, not just one.

### Query-time grant enforcement for search results

Today's grant enforcement operates on field-level projection + `time_range`. A search result carrying a snippet may leak text from a field the grant didn't include. The spec needs to say whether search results are constrained to `grant.fields` or whether snippets are a separate permission. This is adjacent to `rs-api-discoverability-open-question.md` Quirk 3 (query vocabulary) but specific to search.

## Trade-offs to weigh

- **"Ship primitives, stay out of the ranker" has compounding implications.** Vector primitives commit implementations to a model or a versioning story; BM25 primitives don't. A spec that mandates both treats the commitment as acceptable; a spec that mandates only BM25 treats it as unacceptable. The choice is about what the protocol is willing to standardize around.

- **Embedding model choice as a protocol decision is a new level of opinion.** The spec has carefully avoided committing to specific technologies (OAuth RFC references, HTTP, JSON Schema — all neutral). Naming an embedding model would be the first spec decision tying the protocol to a specific ML vendor's product. Whether that's acceptable depends on whether the commitment pays back in interop.

- **The "don't re-derive expensive things" principle cuts both ways.** It argues for shipping embeddings upstream. It also argues against making clients re-index into their own format (which means the spec has to pick a format). Neither direction is neutral.

- **Forward compatibility is specifically hard here.** Every other spec decision can be extended additively. Embedding-model choices bake into stored data; changing them requires re-computation at scale. The versioning options (V1–V4) each have compounding operational implications over years.

- **Owner self-export interaction.** A self-export archive that includes embeddings commits the owner's future consumers to the model those embeddings were generated with. A self-export without embeddings forces re-computation. Both are valid; the spec's choice determines which is canonical.

- **Interop review.** Any review (LF, standards body, community) will ask "does the protocol fragment into incompatible implementations?" Options that declare capabilities surface the answer explicitly; options that mandate everywhere avoid the question by fiat; options that ship nothing avoid the question by omission. Each answer has its own cost.

- **GTM story.** "Your data is yours, and agents can semantically search it out of the box" lands differently from "your data is yours, and agents can keyword-search it," which lands differently from "your data is yours, and agents bring their own search." Whether marketing clarity should drive the decision — or follow it — is itself a question for the deciders.

## Cross-cutting

- `rs-api-discoverability-open-question.md` — search is a query surface; this note's Q1/Q2/Q3 options must compose with that note's A–E options for query vocabulary. A client probing the RS needs to discover what search is available via the same metadata channel.
- `blob-hydration-open-question.md` — same "don't make clients re-derive expensive things" forcing function. If blobs are content-addressed, embeddings might be too (Option V3).
- `cursor-finality-and-gap-awareness-open-question.md` — search results paginate via cursors that are NOT monotonic timestamps. The cursor-finality discussion needs to accommodate score-ordered pagination as a different cursor type.
- `owner-self-export-open-question.md` — self-export including (or excluding) embeddings is a canonical-ness decision.
- `authored-artifacts-vs-activity-open-question.md` — embeddings are a derived artifact; ownership/retention of derived artifacts is its own question.
- `rs-storage-topology-open-question.md` — if search is first-class, the storage topology has to accommodate search indexes alongside records. sub-question 4 (blob bytes live elsewhere than SQLite) has a sibling sub-question: do search indexes live with records or separately?
- `connector-configuration-open-question.md` — manifest additions to declare "this stream is searchable" or "this field participates in BM25" would belong there.

## Action items

- [ ] Multi-model review (Claude + Gemini + ChatGPT consensus per `consent-card`'s precedent) on Options A–E for the recall surface. This is a spec-shaping decision, not a tactical choice.
- [ ] Decide the trust-model framing question up front: is search optimized for owner-run agents, third-party clients, or symmetric across both? The answer constrains which options are live.
- [ ] Decide A/B/C/D/E for recall surface, Q1/Q2/Q3 for query shape, V1/V4 for versioning (if applicable), and S1/S4 for the reference implementation. These compose; no single decision answers everything.
- [ ] Separate note on cross-connector entity resolution if it's a priority. Don't bundle.
- [ ] Conformance tests: regardless of option, spec must say what "correct search" means functionally (returns candidates matching query, ordered by relevance) without mandating scoring internals.

## Why this note rather than shipping the feature

Every line of this note could be resolved with "just ship FTS5 + sqlite-vec behind `/v1/search`" and it'd work tomorrow. The code is a day of work. What's *not* a day of work is the spec surface it commits PDPP to — because once a reference implementation ships semantic retrieval, every future implementation has to, every existing spec example has to accommodate it, and every claim about "owner data portable across implementations" has to address embedding-model compatibility. These are spec commitments, not product features. Naming the forcing function and enumerating the options, and letting the multi-model review + community input decide, is the process that produced the consent card's SLVP quality bar.
