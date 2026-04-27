## Context

The PDPP reference implementation interacts with SQLite through `better-sqlite3`. As of 2026-04-27, every DB call site in `reference-implementation/{lib,server,runtime,cli}/` calls `db.prepare(sql)` directly, then chains a terminator (`.all()`, `.get()`, `.iterate()`, `.run()`). 177 such call sites exist (audit attached as `design-notes/audit-call-sites-2026-04-27.md`).

The first crash this pattern produced was diagnosed and fixed in `archive/2026-04-24-fix-rs-query-memory-pressure`. That change identified four read paths that materialized unbounded JSON-column scans into in-memory arrays under concurrent dashboard load, observed an OOM SIGSEGV signature inside V8's parallel scavenger during `better-sqlite3` result marshaling, and rewrote those four paths to stream + bound at the SQL layer. The change introduced a normative requirement at `reference-implementation-architecture/spec.md:242-300` constraining those four paths and explicitly invited follow-ups (line 260): *"Other read paths (if any) are out of scope for this change; bringing them under the same invariant is a follow-up."*

The follow-up arrived on 2026-04-27 when the `apps/web` Next.js dev server segfaulted with the same V8 backtrace while rendering `/dashboard/runs?peek=run_1777231731305`. The triggering call was `listSpineEvents({ runId })` at `lib/spine.ts:401`, which the archived change did not cover. A 9.5 GB core dump was preserved; gdb output is in `design-notes/run-timeline-memory-regression-memo-2026-04-27.md`.

The audit found 14 other unbounded-pathological call sites with the same shape, plus a hidden quadratic in `listSpineCorrelations` (the archived change bounded its outer aggregate but its inner per-row hydration still calls the unbounded `listSpineEventsSync` once per page item). 162 of the 177 sites are correct today, but they are correct *by reviewer discipline*, not by construction. Nothing in the type system, the linter, or the pre-commit gates prevents the next contributor from re-introducing the pathology in a new file.

The project already has a structural-discipline pre-commit precedent: `lefthook.yml`'s `polyfill-connectors:no-double-cast` job greps for `as unknown as` and rejects commits that introduce it, with the comment "Biome/Ultracite has no equivalent ... yet. Grep ... as a stop-gap until that rule lands upstream." The same shape applies here: Biome cannot today express "ban `.all()` on prepared statements outside this one file"; lefthook can.

The project also already has a structured-query precedent: `server/queries/index.ts` defines a `referenceQueries` registry that loads `.sql` files from disk at startup, validates them with `db.prepare(sql)` at boot (so a malformed query fails the boot, not a request), and freezes the resulting registry. As of today only `listRegisteredConnectors` lives in the registry, but the infrastructure is in place.

This change unifies the two precedents into one structural rule: every DB read in the reference implementation flows through a typed bounded-statement wrapper exposed by `lib/db.ts`, every SQL string lives in the registry, and the lefthook gate enforces "no direct `db.prepare(` outside the wrapper."

## Goals / Non-Goals

**Goals:**

- Close the 2026-04-27 regression with a fix that an engineer or standards reviewer can mechanically verify: the four `listSpineEvents` callers stop materializing unbounded arrays; the three public `_ref` timeline routes paginate honestly; the dashboard surfaces `truncated` state instead of silently consuming the whole timeline.
- Make the unbounded-`.all()` shape inexpressible without an explicit, named, grep-able opt-in (`allowUnboundedReadAcknowledged`). The escape hatch exists for genuinely-bounded-by-domain reads of small enumeration tables; every call site of the escape hatch is a review trigger by name.
- Move every SQL string in the production read paths into `server/queries/*.sql` artifacts so SQL is reviewable in one tree, validated at startup, and free of Node-side string interpolation surprises.
- Add a lefthook pre-commit gate that fails any commit introducing `db.prepare(` outside `lib/db.ts`. The gate is the discipline; reviewer attention is freed.
- Shrink the diff between "where SQL lives" and "where SQL is executed." Today both are inline at every call site; after this change SQL lives in `.sql` files, the wrapper executes them, and call sites only deal with parameters and result hydration.

**Non-Goals:**

- This change does not introduce additional runtime defenses (per-route concurrency cap, response-size budget hook, supervisor mandate). The archived change deferred those because its read-path rewrite alone resolved the measured pathology; the same logic applies here. They remain open follow-ups.
- This change does not address the apps/web Next.js dev server's source-map and module-graph allocation pressure directly. The 2026-04-27 crash was on the consumer side, but the root cause was the source emitting unbounded envelopes; bounding the source is sufficient for this change.
- This change does not introduce a generic ORM, a query builder, or a schema-typed result mapper. The wrapper exposes prepared-statement primitives; the SQL is hand-written; the rows are JSON-parsed at the call site.
- This change does not migrate test fixtures or scripts. They remain free to call `db.prepare(...)` directly. The lefthook gate is scoped to `reference-implementation/{lib,server,runtime,cli}/`.

## Decisions

### Decision 1: The wrapper API surface is four primitives plus one named escape hatch

```ts
// reference-implementation/lib/db.ts

export interface Db {
  // Single-row read. SQL must be from the registry. Returns null if not found.
  getOne<R>(query: ReadQuery, params?: ParamArray): R | null;

  // Bounded multi-row read. limit is required, must be > 0. Returns
  // { rows: R[], truncated: boolean, nextCursor: string | null }.
  // Cursor is opaque; the wrapper handles encode/decode based on the
  // query's declared cursor field.
  getMany<R>(
    query: ReadQuery,
    params: ParamArray,
    opts: { limit: number; cursor?: string | null }
  ): { rows: R[]; truncated: boolean; nextCursor: string | null };

  // Streaming for handlers that consume row-by-row and break early.
  // Yields rows. The handler is responsible for breaking; the wrapper
  // does not impose a cap, but the lefthook gate flags any iterate()
  // caller that doesn't have a `break` or early-return in the body.
  iterate<R>(query: ReadQuery, params?: ParamArray): Generator<R, void, unknown>;

  // Mutation. INSERT/UPDATE/DELETE/CREATE/ALTER/DROP. Returns
  // better-sqlite3 RunResult (changes, lastInsertRowid).
  exec(query: MutationQuery, params?: ParamArray): { changes: number; lastInsertRowid: number };

  // Escape hatch. The function name is part of the contract: it is
  // long, full English, and grep-friendly. Every call site SHALL carry
  // an adjacent `// REVIEWED-BOUNDED: <reason>` comment. The lefthook
  // gate flags calls without that comment. SHALL only be used for
  // reads of small enumeration tables (connectors, oauth_clients,
  // version_counter, connector_state, grant_connector_state,
  // lexical_search_meta, semantic_search_meta).
  allowUnboundedReadAcknowledged<R>(query: SmallEnumerationQuery, params?: ParamArray): R[];

  // Transactional helper, unchanged from better-sqlite3's idiom.
  transaction<T>(fn: () => T): T;
}
```

`ReadQuery`, `MutationQuery`, and `SmallEnumerationQuery` are **branded types**. They are produced only by the registry loader (`server/queries/index.ts`) and the small-enumeration manifest. There is no public constructor that accepts a raw SQL string. A call site that tries to pass a string literal to any of these primitives fails at the type system. The lefthook gate covers the runtime: any commit introducing a `db.prepare(` outside `lib/db.ts` itself is rejected.

Alternatives considered:

- **One unified `query()` method that returns a thenable shape.** Rejected: the four shapes (one row, many rows, streaming, mutation) want distinctly different return types, and folding them into one method either gives up the type benefits or invents a tagged union the caller has to discriminate.
- **Separate read/write classes.** Rejected: better-sqlite3 transactions cross both, and the project already uses that idiom (e.g. the `transaction()` block at `server/auth.js:2553`). Splitting would force shimming.
- **Generic `.all()` with a runtime row-count assertion.** Rejected: a runtime assertion only fires after the bytes are already in memory. The crash we are addressing happens during result marshaling, before the assertion would run.

### Decision 2: SQL lives in `.sql` artifacts; the registry validates them at startup

The existing `server/queries/index.ts` registry already does this for one query. We extend it to be the home for every DB query in the reference implementation:

- Every `.sql` file in `server/queries/` (recursively) becomes a registered query.
- The filename, in kebab-case, becomes the registry key (e.g. `list-spine-events-by-run.sql` → `referenceQueries.listSpineEventsByRun`).
- The loader validates each artifact with `db.prepare(sql)` at startup. Malformed SQL fails the boot.
- A sibling `registry.json` declares per-query metadata: `terminator: 'one' | 'many' | 'iterate' | 'exec'`, optional `bounded_by: { kind: 'small_enumeration_table', table: 'connectors' }`, optional `cursor_field: 'rowid' | 'occurred_at' | …`, optional `cursor_tiebreaker: 'rowid'`.
- The loader textually verifies that every `terminator: 'many'` query contains `LIMIT ?` (the loader will inject the limit binding from `getMany`'s `opts.limit`). A query lacking `LIMIT ?` whose terminator is `many` fails the boot.
- The loader textually verifies that every `bounded_by: 'small_enumeration_table'` query references the declared table in its `FROM` clause. A mismatch fails the boot.

Alternatives considered:

- **Inline SQL in TS files via tagged template strings.** Rejected: SQL is reviewable as SQL when it lives in `.sql` files. Every editor surfaces SQL syntax highlighting, schema-aware completion, and reviewability. Inline strings lose that.
- **JSDoc-annotated SQL in TS files with a build step that extracts artifacts.** Rejected: adds a build step the project does not currently have. Worse than inline.
- **A migration tool that infers `LIMIT ?` from query shape.** Rejected: too clever. The explicit-`bounded_by`-or-`LIMIT` rule is two-line code, fails fast, and is debuggable.

### Decision 3: Escape hatch is named `allowUnboundedReadAcknowledged`

The name is verb-led (matching the project's existing style: `requireStructuredSourceBinding`, `validateDoneExitCode`, `redactSpineEventForPublic`). It says, in full English, what calling it means: I am explicitly allowing an unbounded read; I have acknowledged the cost.

Alternatives considered:

- `unsafe_allUnbounded` — Rust-style snake-case prefix. Rejected: the project does not use snake-case prefixes elsewhere; introducing one creates a precedent that could grow into a competing naming style.
- `_allUnboundedAcknowledged` — leading underscore, terse. Rejected: leading-underscore is the project's convention for "private" not "dangerous"; conflating the two is a future bug source.
- `db.dangerous.all(...)` — namespace-the-danger. Rejected: shorter to type at the call site, which is the wrong direction. Friction at the call site is a feature for this primitive.

The lefthook gate enforces an adjacent `// REVIEWED-BOUNDED: <reason>` comment on every call site. Examples:

```ts
// REVIEWED-BOUNDED: connectors table is O(registered connectors) ≤ 30; whole-table scan acceptable.
const all = db.allowUnboundedReadAcknowledged<ConnectorRow>(referenceQueries.listAllConnectors);
```

A grep for `allowUnboundedReadAcknowledged` enumerates every escape-hatch use in the codebase. A grep for the `REVIEWED-BOUNDED` token does the same in case the function ever gets renamed.

### Decision 4: The `_ref` timeline routes paginate additively, not breakingly

The three timeline endpoints (`GET /_ref/traces/:traceId`, `GET /_ref/grants/:grantId/timeline`, `GET /_ref/runs/:runId/timeline`) currently return an envelope of shape:

```json
{
  "object": "run_timeline" | "grant_timeline" | "trace_timeline",
  "id": "<traceId|grantId|runId>",
  "events": [ ... full event list ... ]
}
```

The new shape adds three optional fields, additively:

```json
{
  "object": "run_timeline" | "grant_timeline" | "trace_timeline",
  "id": "<traceId|grantId|runId>",
  "events": [ ... up to limit events ... ],
  "truncated": true | false,
  "next_cursor": "<opaque>" | null,
  "limit": <int>
}
```

The default `limit` is **2,000 events** (chosen so the largest current run, ~2,500 events at ~1.2 MB, fits in two pages; deeper runs paginate honestly). The maximum `limit` accepted from the caller is 5,000. Pagination is by `cursor` parameter; the cursor encodes `(occurred_at, rowid)` so it is stable under concurrent inserts.

The `events` array is hydrated as before — same `data` JSON parsing, same field shape per event. Existing apps/web consumers that read `events` keep working until they hit `truncated: true`, at which point they need to follow `next_cursor` to get the rest.

Alternatives considered:

- **Hard-cap with no pagination.** Rejected: cuts off long-running runs silently. The 2026-04-27 audit found a few real runs above 2,500 events; they need to be inspectable, not truncated.
- **Server-Sent Events / streaming HTTP.** Rejected: the existing `_ref` surface is JSON-over-HTTP; SSE adds infrastructure (replay handling, reconnection, content-type negotiation) for a reference-only debug surface. Pagination is honest enough.
- **Default `limit = 50`** to be aggressive about bounding. Rejected: makes the dashboard call `next_cursor` repeatedly for every normal run; UX regression.

### Decision 5: `listSpineCorrelations` per-row hydration uses the terminal event, not the full event list

The hidden quadratic at `lib/spine.ts:778` hydrates the full event list for every page row only to compute `summarizeEvents` (first/last timestamps, count, terminal status, terminal `failure.reason`). The first three are already in the SQL aggregate (`MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*) AS event_count`); only the terminal status and failure reason require row inspection, and they live in **at most two events per correlation** (`run.completed` or `run.failed`, and possibly `run.cancelled`).

The fix is to (a) extend the aggregate query to also pull the most-recent terminal event's `status` and `data_json` via a window-function or correlated subquery, OR (b) issue one bounded query per correlation that reads only events where `event_type LIKE '%.completed' OR event_type LIKE '%.failed' OR event_type LIKE '%.cancelled'`. The wrapper supports both shapes; the SQL artifact decides.

(b) is simpler and chosen here. The artifact is `server/queries/get-correlation-terminal-event.sql`, returns 0–1 rows, called once per page row via `db.getOne(...)`. For a 50-row page, that's 50 indexed `.get()` calls instead of 50 unbounded scans.

Alternatives considered:

- **Materialized terminal-event index** as a database trigger or view. Rejected: adds schema migration complexity and a performance characteristic that has to be re-validated on every database. Out of scope for this change.
- **Cache terminal events at write time** in a separate table. Rejected: same.
- **Just paginate the outer aggregate harder so each page is smaller.** Rejected: doesn't fix the per-row work, only spreads it out.

### Decision 6: The wrapper layers above the existing engine in `server/db.js`

`server/db.js` today owns the engine bootstrap: schema text (~400 lines of `CREATE TABLE` / `CREATE INDEX` / `CREATE VIRTUAL TABLE`), the SQLite busy-retry helpers, the `sqlite-vec` extension probe, and the cached-prepare Proxy that gives every `db.prepare(text)` call the same `Statement` instance for the same text. That code is dense, battle-tested, and orthogonal to the wrapper's purpose.

The wrapper at `lib/db.ts` is therefore a layer **above** the existing engine, not a replacement for it. `lib/db.ts` exports the bounded primitives (`getOne`, `getMany`, `iterate`, `exec`, `allowUnboundedReadAcknowledged`); each primitive internally calls `getDb()` from `server/db.js` and uses the existing cached prepare. Engine bootstrap stays in `server/db.js`. No migration of the schema text, no movement of the busy-retry helpers, no risk of breaking the vec-extension probe.

The lefthook gate is the discipline that prevents code outside `lib/db.ts` from calling `.prepare(...)` directly. `server/db.js` itself is part of the engine layer and continues to call `raw.prepare(...)` to back the cached-prepare Proxy; the gate excludes it (just as it excludes `lib/db.ts` itself).

Alternatives considered:

- **Move the engine bootstrap into `lib/db.ts`.** Rejected after walking the actual contents of `server/db.js`: the schema text and busy-retry helpers are ~600 lines of code that work today; the wrapper's purpose is bounded-statement *primitives*, not engine ownership. Conflating the two adds risk for no benefit. Greenfield, the engine bootstrap and the bounded-primitive surface live in different modules — they do here too.
- **Keep `server/db.js` and `lib/db.ts` entirely independent.** Rejected: the wrapper needs `getDb()`. Importing it as a dependency is the cleanest option and matches the rest of the codebase.

The lefthook gate's allow-list therefore covers two files: `reference-implementation/lib/db.ts` (the wrapper) and `reference-implementation/server/db.js` (the engine). The audit at `design-notes/audit-call-sites-2026-04-27.md` enumerates every direct `.prepare(...)` outside those two files; all 177 sites are migrated through the wrapper.

### Decision 7: The lefthook gate is a grep, modeled on `polyfill-connectors:no-double-cast`

```yaml
- name: reference-implementation:no-direct-prepare
  glob: "reference-implementation/{lib,server,runtime,cli}/**/*.{ts,js}"
  run: |
    files=$(echo {staged_files} | tr ' ' '\n' | grep -v '^reference-implementation/lib/db\.\(ts\|js\)$' || true)
    if [ -z "$files" ]; then exit 0; fi
    if echo "$files" | xargs grep -nE '(\bdb|\bgetDb\(\))\.prepare\(' 2>/dev/null; then
      echo "✗ Direct .prepare(...) is forbidden outside reference-implementation/lib/db.ts."
      echo "  Use db.getOne / db.getMany / db.iterate / db.exec, or"
      echo "  db.allowUnboundedReadAcknowledged with a // REVIEWED-BOUNDED: comment."
      echo "  See openspec/specs/reference-implementation-architecture/spec.md"
      echo "  Requirement: 'Reference RS read paths SHALL be bounded by construction'"
      exit 1
    fi
```

A second gate enforces the `REVIEWED-BOUNDED:` comment on `allowUnboundedReadAcknowledged` callers:

```yaml
- name: reference-implementation:reviewed-bounded-comment
  glob: "reference-implementation/**/*.{ts,js}"
  run: |
    if echo {staged_files} | xargs grep -nB1 'allowUnboundedReadAcknowledged' 2>/dev/null \
      | awk 'BEGIN{ok=1} /allowUnboundedReadAcknowledged/{if(prev!~/REVIEWED-BOUNDED:/) ok=0; print} {prev=$0} END{exit !ok}'; then
      exit 0
    else
      echo "✗ allowUnboundedReadAcknowledged() requires an adjacent // REVIEWED-BOUNDED: <reason> comment."
      exit 1
    fi
```

Alternatives considered:

- **A custom Biome plugin.** Rejected: Biome plugin support is on the roadmap but not shipping in the version pinned by Ultracite v2.x. Wait-and-see when it ships; this change doesn't block on it.
- **A custom Node script invoked from lefthook.** Reasonable; the grep is simpler. We can replace the grep with a Node script later if false positives drive us there. The existing `no-double-cast` precedent is a grep, so we match.

## Risks / Trade-offs

- **[Risk] The migration touches 177 call sites; merge conflicts with in-flight work are likely.** → Mitigation: scope our `runtime/` changes to `controller.ts` only (3 sites). The in-flight `persist-connector-failure-diagnostics` change touches `runtime/index.js` and does not touch any of our 177 call sites in that file (the runtime indexes prepared statements via cached helpers, not direct `db.prepare(...)`). We commit our changes to `runtime/controller.ts` last, after their change merges, with a documented rebase note.
- **[Risk] The `_ref` timeline pagination breaks downstream consumers that expected the full event list.** → Mitigation: the new shape is additive; existing consumers that read `events` get up to 2,000 events without doing anything. Only consumers that need the *complete* timeline for a long-running run hit `truncated: true` and need to follow `next_cursor`. The dashboard, CLI, and tests are migrated in the same change.
- **[Risk] The `.sql` artifact migration creates ~150 small files, complicating navigation.** → Mitigation: the registry is alphabetical and one-per-query. A 150-line directory listing is not large by repo standards (the existing `connectors/` directory has 30 connector files plus support modules; the test suite has 70+ files). The reviewability gain (SQL in `.sql` files, validated at startup) outweighs the file-count cost. The directory structure mirrors caller intent (e.g. `queries/spine/list-events-by-run.sql`).
- **[Risk] The `LIMIT ?` text-check at startup gives false confidence — a query that says `LIMIT ?` but binds a huge value still emits a huge result.** → Mitigation: the wrapper's `getMany` enforces `limit > 0 && limit <= MAX_LIMIT` (default 5,000) on every call; the SQL `LIMIT` is bound from the wrapper-validated value, not from caller-controlled text. The startup check exists to catch developer mistakes (forgetting `LIMIT`) not malicious input.
- **[Risk] The `bounded_by: small_enumeration_table` annotation drifts as the schema grows — the `connectors` table is bounded today (≤30 entries) but future deployments could load thousands.** → Mitigation: the annotation includes the maximum expected size; the wrapper asserts that the result count does not exceed that maximum at request time and logs a `tmp/.warning` file if exceeded. The annotation becomes stale only if both the schema grows AND no one updates the registry; the lefthook gate flags any change to the annotation in review.
- **[Trade-off] Friction at every call site.** Every DB read now requires writing a `.sql` file, registering it, and calling through the wrapper. This is more friction than `db.prepare(sql).get(params)`. The trade-off is intentional: friction at write time prevents the next OOM at production time.

## Migration Plan

**One change, four ordered commits**:

1. **Wrapper + registry foundation.** New `lib/db.ts` with the four primitives + escape hatch. Extended `server/queries/index.ts` registry that loads all `.sql` files, enforces `LIMIT ?` or `bounded_by`, exposes `referenceQueries`. `server/db.js` becomes a thin shim. No call sites migrate yet. Tests for the wrapper itself pass.
2. **Pathological sites + timeline pagination.** Migrate the 15 unbounded-pathological sites (the four `listSpineEvents` callers, the inner hydration in `listSpineCorrelations`, the timeline routes, the connector-wide record scans, the dynamic record-key builders). Add `truncated` + `next_cursor` to the timeline envelopes. Update `apps/web` consumers. Add the `repro-crash.sh` URL set extension. Run the harness; confirm 5/5 PASS.
3. **Bulk migration of the remaining 162 sites.** Mutations, single-row PK lookups, small-enumeration reads, and already-streaming sites move through the wrapper. SQL moves into `.sql` artifacts. Behavior unchanged. This commit is the largest by line count but the smallest by semantic risk; sub-agents drive batches.
4. **Lefthook gate + cleanup.** Both gates land. `server/db.js` shim is deleted; remaining imports rewritten. Final pass over `apps/web` for any straggler timeline-shape assumptions.

Each commit is independently reviewable and runs the full test suite green.

**Rollback**: each commit is reverted independently. The wrapper module can sit unused if commit 2 reverts. The lefthook gate is configuration; reverting it removes enforcement without breaking running code.

## Open Questions

- **Cursor encoding format.** The cursor encodes `(occurred_at, rowid)` as an opaque base64-encoded string. Should it be JSON-readable (so an operator can inspect it) or treated as fully opaque (so the format can change without contract impact)? The `polyfill-connectors` cursor uses opaque base64; the `_ref/changes` cursor surface in the existing spec is also opaque. We'll match.
- **Whether the registry's `bounded_by` annotation should be a sibling JSON manifest or in-file SQL frontmatter.** SQL frontmatter (`-- @bounded_by: small_enumeration_table; @max_rows: 30; @table: connectors`) keeps each query self-describing but requires a custom parser. A sibling `registry.json` is parsed by the loader's existing JSON path. **Leaning toward in-file frontmatter** — co-locating the metadata with the SQL is the same authoring principle as the project's manifest-authored stream display, and the parser is ~20 lines.
- **Whether `apps/web` should expose the new `truncated` state visually or only structurally.** The minimum is structural (the field exists, the dashboard fetches `next_cursor` if a user clicks "load more"). The dashboard could also show a "truncated" badge in the timeline header when applicable. Not a blocking question for this change; the structural plumbing lands here, the visual refinement can follow.
- **Whether to re-run `repro-crash.sh` against the current 96,972-row substrate before this change lands** to baseline the current PASS/FAIL rate. Worth doing as part of Phase 8 verification; if it's PASSing today on the smaller substrate, the harness extension in commit 2 is what would have caught the 2026-04-27 regression.
