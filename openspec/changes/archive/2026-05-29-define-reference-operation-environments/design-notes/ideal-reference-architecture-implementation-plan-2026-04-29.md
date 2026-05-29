# Ideal Reference Architecture Implementation Plan

Status: decided-promote
Owner: owner-agent
Created: 2026-04-29
Updated: 2026-04-29
Related: openspec/changes/define-reference-operation-environments

## Question

What is the fully ideal reference implementation organization, assuming no migration constraints, and how should PDPP migrate toward it without losing protocol rigor?

## Context

The desired end state is not "make the code prettier" and not "add Postgres." The desired end state is a reference implementation whose AS/RS behavior is defined exactly once, whose hosts and environments provide dependencies without forking semantics, and whose tests make PDPP behavior falsifiable across local, Docker, sandbox, and future storage profiles.

This note records the full architecture target and implementation packets so the reasoning is not lost between worker lanes.

## Ideal Organization

### Top-Level Shape

The reference should converge toward this dependency direction:

```text
reference operations
  depend on: domain capabilities + environment dependencies
  do not depend on: Fastify, Next, SQLite, process env

operation hosts
  Fastify local server
  Next sandbox route host
  test host
  future worker/edge host if proven

environment profiles
  local-personal
  docker-personal
  sandbox-fixture
  test-memory
  future postgres-spike

adapters
  sqlite stores/indexes
  memory/fixture stores/indexes
  future postgres stores/indexes
```

The strongest directory target, if designed from scratch:

```text
reference-implementation/
  src/
    operations/
      as/
      rs/
      ref/
      shared/
    domains/
      auth/
      grants/
      records/
      spine/
      search/
      blobs/
      connectors/
      schedules/
    environments/
      profiles/
        local-personal.ts
        docker-personal.ts
        sandbox-fixture.ts
        test-memory.ts
      dependencies.ts
    adapters/
      sqlite/
      memory/
      fixture/
      postgres-spike/
    hosts/
      fastify/
      next-sandbox/
      test/
    contracts/
      generated/
      operation-registry.ts
    conformance/
      records/
      spine/
      lexical/
      semantic/
      auth/
      sandbox/
  server/
    index.js
    transport.js
```

`server/index.js` should eventually become composition/startup glue. It should not be the place where AS/RS semantics live.

### Why This Is Better Than Simpler Alternatives

Rejected alternatives:

- `ports/` / `adapters/` as the main language: too architecture-pattern-coded. PDPP's review surface is operation/capability semantics, not hexagonal architecture branding.
- `interfaces/` as the center: too likely to produce generic contracts before semantic obligations are known.
- `services/` as the center: too likely to become a god layer.
- `repositories/`: wrong abstraction. PDPP needs record/search/grant/spine semantics, not table-shaped CRUD.
- `packages/reference-operations` immediately: potentially right later, but too much package-boundary churn before the operation shape is proven.

Preferred language:

- `operations`: public AS/RS/ref behavior.
- `domains`: pure domain helpers and semantic rules.
- `environments`: dependency composition.
- `adapters`: concrete storage/search/host implementation details.
- `hosts`: HTTP/framework/test mounting.
- `conformance`: executable semantic contract tests.

## Operation Capsule Contract

An operation is the unit of reference truth. Each operation should have:

```ts
type Operation<Request, Response> = {
  id: OperationId;
  stability: "reference" | "experimental";
  normalize(input: HostInput): Request | OperationError;
  authorize(request: Request, deps: OperationDeps): Promise<AuthzResult>;
  execute(request: Request, deps: OperationDeps): Promise<Response>;
  toHttp(response: Response): HostResponse;
  errors: OperationErrorCatalog;
  examples: OperationExample[];
};
```

This is illustrative, not final TypeScript. The important obligations are:

- Request normalization is explicit and shared across hosts.
- Authorization is operation-owned, not route-owned.
- Errors are operation-owned and mapped by hosts.
- Trace/disclosure obligations are operation-owned.
- Hosts adapt input/output; hosts do not define semantics.

Candidate first operation:

```text
rs.streams.list
```

Why first:

- Visible enough to prove AS/RS route parity.
- Low risk compared with records/search.
- Lets sandbox delete a real hand-built builder.
- Exercises auth/schema/manifest dependencies without record pagination complexity.

Minimum `rs.streams.list` obligations:

- request: bearer token or owner/demo auth context, optional connector/source filters if already supported
- auth: owner sees all owner-visible streams; client token sees grant-visible streams only
- response: identical stream descriptors across Fastify and Next sandbox for the same environment profile
- errors: unauthenticated, invalid token, stream/source not visible
- trace: include request id / source descriptor if the existing route does
- dependencies: manifest registry, grant visibility resolver, source descriptor resolver
- tests: Fastify local host and Next sandbox host execute same operation implementation against fixture profile

## Environment Profiles

Profiles provide dependencies. They do not define AS/RS behavior.

### `local-personal`

- SQLite stores/indexes.
- Real connector runner.
- Real clock/ids.
- Local filesystem/browser dependencies.
- Owner placeholder auth.

### `docker-personal`

- Same AS/RS semantics as `local-personal`.
- Explicitly declared browser/filesystem limitations.
- Container-compatible paths and startup.
- May use host-browser bridge later, but that is an adapter/profile choice.

### `sandbox-fixture`

- Fixture stores/indexes.
- Frozen or deterministic clock/ids.
- Disabled/scripted connector execution.
- Public origin resolution.
- No live credentials or owner data.
- Same operations as real host.

### `test-memory`

- Minimal deterministic dependencies.
- Designed for conformance tests.
- Not a product/runtime profile.

### `postgres-spike`

- Non-product proof profile.
- Exists only after conformance harness and SQLite atomicity fix.
- Must not be advertised as supported operator storage until workload/perf/recovery evidence exists.

## Capability Contracts

Contracts are semantic, not generic.

### Good Contracts

- `ConsentStore`
- `OwnerDeviceAuthStore`
- `ConnectorStateStore`
- `SchedulerStore`
- `RecordStore`
- `DisclosureSpineStore`
- `BlobStore`
- `LexicalIndex`
- `SemanticIndex`
- `SearchSnapshotStore` if shared by lexical/semantic/hybrid pagination

### Forbidden Shapes

- `Repository<T>`
- `store.find(table, where)`
- raw SQL handles above adapters
- Kysely/ORM builders above adapters
- generic cross-store transaction manager
- generic `SearchProvider`
- operation code importing Fastify/Next/SQLite/process env

## Contract Details To Preserve

### `RecordStore`

`RecordStore` should eventually own:

- durable record mutation
- current-state lookup
- no-op detection
- version allocation
- `record_changes`
- `version_counter`
- live record listing
- typed cursor comparison
- missing/null/empty bucket behavior
- `changes_since`
- projection equality
- field projection
- range filter semantics
- limited parent-child expansion shape

It should not own:

- grant authorization policy beyond receiving an already-resolved visibility/projection plan
- lexical/semantic index mutation
- disclosure-spine append
- connector runtime semantics
- dashboard formatting

First mandatory change:

- Make durable record mutation atomic in SQLite before extraction.

### `DisclosureSpineStore`

Must own:

- append-only event persistence
- explicit `event_seq` or equivalent tiebreaker
- terminal event lookup
- list-by-correlation ordering and cursors
- correlation summary aggregation as a semantic operation

Must not expose:

- SQLite `rowid`
- generic dynamic aggregate escape hatches

### `LexicalIndex`

Must own:

- field-scoped indexing
- field-scoped search result rows
- snippet source field
- backend identity
- tokenizer/dictionary identity
- score kind/order/value semantics
- stale/building/built state if drift is visible

Must not own:

- JSON record filtering
- grant widening/narrowing decisions
- hybrid score normalization
- generic query DSL

### `SemanticIndex`

Must own:

- embedding profile identity
- model/dtype/dimensions/metric
- index kind
- recall determinism (`exact` vs `approximate`)
- backfill state
- stale detection
- stable tie ordering

Must not hide:

- approximate pgvector/HNSW recall behind an exact-looking capability
- dtype/model changes
- backend-specific distance semantics

### Hybrid Retrieval

Hybrid remains an operation-level fusion:

- lexical and semantic sources stay separate
- scores stay separate
- provenance is explicit
- dedup is by `(connector_id, stream, record_key)`
- cursor remains unsupported until snapshot fusion is proven

## Migration Packets

Each packet should be small enough for a worker lane and owner review.

### Packet A — Harden Record Ingest Atomicity

OpenSpec change: likely new change, not buried in the architecture proposal.

Scope:

- Add failing tests for concurrent same-stream ingest.
- Add fault/crash-style test around version allocation and `record_changes`.
- Make durable record mutation atomic in SQLite.
- Keep index/spine outside the transaction.

Validation:

- targeted record tests
- full reference test subset if affordable
- `openspec validate --all --strict`

Owner acceptance:

- No generic `RecordStore` yet.
- No Postgres.
- No behavior weakening.

### Packet B — Conformance Harness Drafts

Scope:

- Add conformance test harnesses without broad refactor.
- Start with tests that run against current SQLite implementation.
- Add one intentionally wrong fixture/memory implementation where cheap.

Sub-lanes:

- records read
- records write
- spine
- lexical
- semantic/hybrid

Owner acceptance:

- Tests encode PDPP semantics, not incidental SQL.
- Tests fail on wrong behavior.
- Tests are clear enough to guide contract extraction.

### Packet C — Low-Risk Store Proof

Scope:

- `ConsentStore`
- `OwnerDeviceAuthStore`
- SQLite + memory adapters
- no records/search

Why:

- proves dependency injection shape
- security meaningful
- low semantic complexity

Owner acceptance:

- same operation behavior under both adapters
- operation code does not import concrete adapter

### Packet D — Connector State / Scheduler Proof

Scope:

- `ConnectorStateStore`
- `SchedulerStore`
- SQLite + non-default adapter spike if possible

Why:

- exercises upsert/active-run semantics
- lower risk than records/search

Owner acceptance:

- no hidden global SQLite handle in operation code
- startup/control-plane behavior unchanged

### Packet E — `rs.streams.list` Operation Mount

Scope:

- Define operation capsule for `rs.streams.list`.
- Mount through Fastify.
- Mount through Next sandbox route host.
- Delete corresponding sandbox response builder in same change.

Owner acceptance:

- same operation implementation serves both hosts
- fixture profile supplies data
- sandbox route no longer reimplements AS/RS semantics

### Packet F — `rs.schema.get` Operation Mount

Scope:

- Same pattern as streams.
- Needs manifest/visibility semantics settled.

Owner acceptance:

- generated/contract metadata remains in sync
- sandbox and local route parity proven

### Packet G — Records/Search Adapter-Readiness

Scope:

- Extract smallest `RecordStore` subset behind conformance harness.
- SQLite + memory/fixture adapter.
- Candidate operations: `records.get`, one-stream `records.list`, `changes_since=beginning`.

Owner acceptance:

- byte-identical outputs where contract requires it
- old cursor invalidation behavior is explicit
- no adapter internals leak

### Packet H — Lexical/Semantic Contract Hardening

Scope:

- Add lexical backend identity.
- Add semantic recall kind and vector identity if not already present.
- Add tests proving metadata changes make stale state visible.

Owner acceptance:

- no portable score claim
- no hidden tokenizer/model assumption

### Packet I — Postgres Spike

Scope:

- Non-product adapter proof.
- Narrow `RecordStore` read/write subset.
- Optional lexical/semantic experiments only if metadata honesty is already in place.

Owner acceptance:

- conformance suite passes
- no operator-facing support claim
- spike may be deleted if it reveals weakening

### Packet J — Sandbox Parity Completion

Scope:

- Move remaining `/sandbox/v1/**`, `/sandbox/_ref/**`, and sandbox well-known behavior onto operations.
- Keep fixture data.
- Keep educational UI if useful.
- Delete or demote parallel builders.

Owner acceptance:

- sandbox is a real hosted profile, not a fork
- tests prevent regression to hand-built AS/RS semantics

## Import Boundary Rules

Eventually enforce with static checks:

- `src/operations/**` must not import Fastify, Next, SQLite, Kysely, `process.env`, or concrete adapters.
- `src/domains/**` must not import hosts or adapters.
- `src/adapters/**` may import SQLite/Kysely/Postgres libraries.
- `src/hosts/**` may import framework packages and operation registry.
- `apps/web/src/app/sandbox/**` API routes may import only the Next host adapter/operation registry, not sandbox AS/RS builders.

## Worker-Agent Strategy

Workers should not be asked to "do the refactor." They should receive bounded packets:

- one packet
- one worktree
- one validation target
- explicit out-of-scope list
- no broad naming/architecture invention
- report exact files touched and tests run

Good worker tasks:

- write failing atomic-ingest tests
- audit and draft conformance cases
- extract one low-risk store
- mount one operation through one host
- delete one sandbox builder after parity tests pass

Bad worker tasks:

- design the whole storage layer
- make Postgres work
- clean up `server/index.js`
- introduce a repository abstraction
- migrate records/search in one pass

## Confidence And Stop Gates

Highest-confidence first:

1. Atomic ingest in SQLite: `90`
2. Auth/device low-risk store proof: `94`
3. `rs.streams.list` operation mount: `86`
4. Conformance harnesses: `86`
5. Records adapter-readiness: `72` now, `84` after prior phases
6. Postgres spike: `62` now, `78` after records harness

Global stop gates:

- Any abstraction hides PDPP semantics instead of naming them.
- A second adapter cannot pass tests without copying SQLite quirks as universal truth.
- Sandbox needs forked behavior to look good publicly.
- Search backends require false score/recall claims.
- Workers produce code that passes tests but is not explainable against the OpenSpec requirements.

## Decision Log

- 2026-04-29: Captured the ideal implementation organization and migration packets after owner asked whether the fully ideal refactor was fully documented.
