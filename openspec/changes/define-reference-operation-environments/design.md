## Context

PDPP is a protocol plus reference implementation. The codebase therefore has a higher authority bar than a normal product app: docs, dashboard, sandbox, tests, and connector demos must not become competing definitions of AS/RS behavior.

The current implementation has several useful building blocks:

- `packages/reference-contract` already captures machine-readable operation shapes and generated artifacts.
- `reference-implementation/server/transport.js` already isolates some Fastify mechanics.
- `reference-implementation/server/queries/**` and `reference-implementation/lib/db.ts` already started centralizing bounded SQL execution.
- `/sandbox/**` now shares dashboard views more than the first attempt did.

But the hard boundary is still missing. AS/RS behavior is largely embedded in `server/index.js`; storage is module-global SQLite; search is tied to SQLite FTS5 and sqlite-vec; several control-plane reads still build SQLite SQL directly; and the sandbox still has Next-side builders that can drift from the reference runtime.

## Goals / Non-Goals

**Goals:**

- Establish the ideal architecture from scratch: one reference operation set, multiple environment profiles, multiple hosts, shared product surfaces, executable evidence.
- Define what storage/search abstractions must look like to enable Postgres later without weakening PDPP semantics.
- Make the Vercel sandbox target precise: same reference operations, sandbox fixture environment, Next route host.
- Produce a handoff-ready workstream that Claude workers can audit and refine without asking the human owner to act as message bus.

**Non-Goals:**

- Do not implement the refactor in this change.
- Do not approve Postgres as a product requirement.
- Do not replace Fastify or SQLite merely for cleanliness.
- Do not adopt generic repository abstractions, generic service layers, or an architecture framework.
- Do not bless the current sandbox builders as a final AS/RS mock implementation.

## Decisions

### 1. Operation is the unit of AS/RS truth

The reference should converge on operation capsules such as:

- `as.metadata.get`
- `as.par.create`
- `as.token.exchange`
- `rs.schema.get`
- `rs.records.list`
- `rs.records.get`
- `rs.search.lexical`
- `rs.search.semantic`
- `rs.search.hybrid`
- `rs.blobs.get`
- `ref.runs.timeline`

Each operation owns behavior, request normalization, authorization policy, error mapping, emitted trace/disclosure obligations, examples, and conformance scenarios. Transports mount operations; they do not define semantics.

Alternative considered: capability folders only (`records/`, `search/`, `grants/`). Capability folders are still useful for domain helpers, but operations are the reviewable public contract boundary. A capability-only layout can hide route-specific semantics and make `/sandbox` drift harder to detect.

### 2. Environments are dependency profiles, not implementations

The expected profiles are:

- `local-personal`: SQLite, local connector runner, local indexes, real clock/ids.
- `docker-personal`: same semantics as local with container-compatible adapters and explicit browser/filesystem limitations.
- `sandbox-fixture`: fixture storage, disabled/scripted connector runner, fixture indexes, frozen clock, deterministic ids, public origin resolution.
- `test-memory`: minimal deterministic adapters for focused conformance tests.

The profile composes dependencies. It must not fork operation behavior.

### 3. Storage abstractions must be PDPP capability contracts

Acceptable contracts are semantic and capability-specific:

- `RecordStore`
- `GrantStore`
- `TokenStore`
- `ConsentStore`
- `DisclosureSpineStore`
- `BlobStore`
- `ConnectorStateStore`
- `LexicalIndex`
- `SemanticIndex`

Unacceptable contracts are generic persistence abstractions such as `Repository<T>`, `store.find(table, where)`, or ORM objects leaking into operation code. Those would weaken auditability by hiding PDPP invariants behind database-shaped APIs.

### 4. Search abstractions stay separate and truthful

Lexical, semantic, and hybrid retrieval must not collapse into one generic `SearchProvider`. Their score semantics, index identity, language/model metadata, fallback behavior, filtering, and freshness state are different. Each index contract must preserve those distinctions.

Postgres compatibility would likely map lexical retrieval to Postgres full-text or trigram infrastructure and semantic retrieval to `pgvector`, but those are adapter concerns. Operation semantics and score disclosures remain PDPP concerns.

### 5. Kysely is an adapter tool, not the architecture

Kysely is a strong candidate for future SQLite/Postgres adapters because it can reduce SQL drift and improve type-safety. The runtime must not depend on Kysely. Kysely belongs below capability contracts, inside adapters.

### 6. OpenAPI-generated clients are likely a separate no-brainer

`openapi-fetch` or a similar OpenAPI-generated client should be considered separately for dashboard/client surfaces because `packages/reference-contract` already exists and handwritten dashboard clients are drift-prone. This does not replace operation extraction; it reduces client-side path and shape drift.

### 7. Fastify remains acceptable unless the operation host boundary proves otherwise

The current Fastify transport already isolates framework mechanics more than a raw Express route file would. Hono may become attractive if Web-standard `Request`/`Response` mounting materially simplifies Next/Vercel hosting, but replacing Fastify is not a prerequisite for the target architecture.

## Worker Audit Synthesis

Three focused read-only audits were run against this design:

- SQLite obligation inventory: `tmp/workstreams/ref-env-sqlite-obligations-report.md`
- Postgres/Kysely feasibility: `tmp/workstreams/ref-env-postgres-feasibility-report.md`
- Sandbox/operation drift: `tmp/workstreams/ref-env-sandbox-drift-report.md`

Owner synthesis:

- The architecture direction is sound, but the initial draft understated the SQLite-specific obligations in records, spine aggregates, lexical retrieval, and semantic retrieval.
- Postgres is feasible, but not if operation code continues to depend on implicit SQLite `rowid`, SQLite JSON affinity, FTS5 score direction, vec0 partition semantics, or inline relational blob bytes.
- The current sandbox has high shape fidelity but no semantic ownership transfer. All public `/sandbox/v1/**`, `/sandbox/_ref/**`, and `/sandbox/.well-known/**` routes are parallel AS/RS behavior and must move behind reference operations.
- The proof sequence must be staged. Records/search are the wrong first extraction despite being the most important long-term targets.

## Contract Corrections From Audits

These corrections refine the Decisions above and are required before implementation:

1. Paginated contracts use adapter-owned opaque cursors and explicit tiebreakers. `rowid` is never a reference-runtime contract.
2. `RecordStore` owns cursor comparison semantics. It must distinguish numeric, ISO-string, text, null, and empty-string missing-bucket behavior rather than relying on SQLite `json_extract` affinity or collation.
3. `RecordStore` owns version allocation. For each `(connector_id, stream)`, `next_version = current + 1` must be computed in the same atomic unit that writes `records`, `record_changes`, and `version_counter`.
4. `record_json_bytes` is adapter-native. If kept in operator diagnostics, it must be labeled as native storage bytes, not a PDPP-stable metric.
5. `LexicalIndex` exposes score direction, backend/tokenizer identity, and plain-text snippet semantics. FTS5 `bm25` and Postgres `ts_rank` are not interchangeable hidden details.
6. `SemanticIndex` exposes backend identity, index kind, distance metric, model identity, and recall determinism. Approximate vector indexes must not masquerade as exact recall.
7. `BlobStore` separates metadata/bindings from byte storage. SQLite may inline bytes; a Postgres profile may put bytes in object storage while preserving content-addressed semantics.
8. `DisclosureSpineStore` exposes explicit sequence/tiebreaker semantics for event listing and correlation aggregates. Aggregate listing is a first-class semantic operation, not a generic SQL wrapper.
9. Kysely remains optional and adapter-internal. It is useful for dynamic SQL and cross-dialect `ON CONFLICT`, but not for FTS, vector, DDL, or operation semantics.

## Evidence Standard

Before recommending these abstractions with high confidence, the project needs evidence in this order:

1. **SQLite obligation inventory**: enumerate every SQLite-specific semantic obligation across records, grants/auth, spine, blobs, connector state, lexical search, semantic search, and control-plane reads.
2. **Semantic obligation tests**: write or identify tests that express PDPP obligations against the current SQLite implementation before any adapter extraction.
3. **Contract draft from obligations**: define capability contracts only for methods required by those obligations.
4. **Two-adapter proof**: make SQLite and fixture/memory adapters pass the same obligation tests for at least one meaningful operation family.
5. **Postgres feasibility memo**: map hardest behaviors (`changes_since`, JSON field filters, expand, FTS, vector search, cursors, transactions) to Postgres without changing operation semantics.
6. **Import-boundary checks**: ensure operation code cannot import concrete storage/search/transport/process dependencies.

High-confidence recommendation threshold:

- 90%+ concept confidence only after the obligation inventory, Postgres feasibility memo, sandbox drift audit, and one two-adapter proof agree.
- 75-80% migration confidence only after a low-risk operation family is mounted through both Fastify and Next over the same operation implementation.

Recommended proof sequence:

1. **Storage-only security proof:** `ConsentStore` + `OwnerDeviceAuthStore` with SQLite and memory adapters, because approval-id/device-code secrecy is security-meaningful and the current paths avoid JSON/FTS/vector complexity.
2. **Postgres-oriented storage proof:** `ConnectorStateStore` + `SchedulerStore`, because those tables exercise upsert/active-run semantics without record/search complexity.
3. **Sandbox operation proof:** `rs.streams.list` mounted through both Fastify and Next sandbox over the same operation implementation, deleting `buildLiveStreamsList` in the same change.
4. **Operation-only schema proof:** `rs.schema.get` after connector manifest store shape is settled.
5. **Records/search later:** only after cursor comparison, version allocation, spine aggregate, lexical backend identity, and semantic backend identity corrections are formalized and tested.

## Risks / Trade-offs

- **Risk: Abstraction hides semantics** -> Use capability-specific contracts derived from tests, not generic repositories.
- **Risk: Refactor creates a new god layer** -> Keep operation capsules public-contract-sized and keep domain helpers under capability modules.
- **Risk: Kysely or Postgres drives protocol shape** -> Treat query builders and databases as adapter implementation details only.
- **Risk: Sandbox remains a parallel implementation** -> Add import and conformance gates that make hand-built AS/RS behavior in `apps/web` fail review.
- **Risk: Over-planning delays useful fixes** -> Prove the architecture with one operation family before broad migration.

## Open Questions

- Whether operation capsules should live under `reference-implementation/src/operations/**` or a package-level `packages/reference-operations/**`.
- Whether `apps/web` should eventually split into public site and operator dashboard apps, or remain one app with stricter surface boundaries.
- Whether generated OpenAPI clients should be introduced before operation extraction or as part of the first extracted operation family.
