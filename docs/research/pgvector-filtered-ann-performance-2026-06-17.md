# pgvector Filtered ANN Performance — Research (2026-06-17)

Read-only research. **No code or live-stack changes made.** Quality bar: SLVP
(Stripe / Linear / Vercel / Plaid) — recommendations are grounded in primary
docs, applied concretely to PDPP's `semantic_search_blob`, and end in a verdict.

## Sources

All fetched and indexed on 2026-06-17. Primary docs only.

| Source | URL |
|---|---|
| pgvector README (master, 0.8.x) | https://github.com/pgvector/pgvector/blob/master/README.md |
| PostgreSQL 18 — Partial Indexes (§11.8) | https://www.postgresql.org/docs/current/indexes-partial.html |
| PostgreSQL 18 — Table Partitioning (§5.12) | https://www.postgresql.org/docs/current/ddl-partitioning.html |
| PostgreSQL 18 — Index Types (§11.2) | https://www.postgresql.org/docs/current/indexes-types.html |
| PostgreSQL 18 — Multicolumn Indexes (§11.3) | https://www.postgresql.org/docs/current/indexes-multicolumn.html |

PDPP context read (not external): the active OpenSpec change
`openspec/changes/migrate-postgres-semantic-index-to-pgvector/design.md`, which
already implements much of the recommended shape. This report validates that
design against the docs and flags the residual gaps.

---

## 1. What the docs actually say

### 1.1 Two ANN index types

- **HNSW** — multilayer proximity graph. Best speed/recall tradeoff; slower
  builds, more memory; **can be built on an empty table** (no training step).
- **IVFFlat** — partitions vectors into `lists`, probes the closest `n`. Faster
  builds, less memory, **worse speed/recall**. Recall depends on: (1) build the
  index *after* the table has data, (2) `lists ≈ rows/1000` (≤1M rows) or
  `sqrt(rows)` (>1M), (3) query with `probes ≈ sqrt(lists)`.

For a single-precision `vector` you build one index *per distance function*.
PDPP uses cosine → `vector_cosine_ops` only.

### 1.2 The filtering problem (the crux for PDPP)

A filtered ANN query looks like:

```sql
SELECT * FROM items WHERE category_id = 123 ORDER BY embedding <-> '[…]' LIMIT 5;
```

With an **approximate index, the filter is applied *after* the index scan.**
The graph walk returns up to `hnsw.ef_search` (default **40**) candidates; the
`WHERE` then discards any that don't match. README's worked example: if the
filter matches 10% of rows, an `ef_search` of 40 yields **~4 rows on average** —
silent under-return, not an error. This is the dominant failure mode for
metadata-filtered vector search.

The docs give a four-rung ladder, in order of preference by filter selectivity:

1. **B-tree index on the filter column(s).** "A good place to start." For
   conditions matching a *low* percentage of rows, this gives **fast, exact**
   nearest-neighbor search — the planner filters first, then sorts the small
   surviving set exactly. Multicolumn `(a, b)` index for AND filters.
2. **Approximate index + raise `ef_search` / overscan** when filters match more
   rows.
3. **Iterative index scans** (pgvector ≥ 0.8.0) — auto-rescan more of the index
   until `LIMIT` is satisfied or a cap is hit (`hnsw.max_scan_tuples`, default
   20000; `ivfflat.max_probes`). `strict_order` keeps exact distance order;
   `relaxed_order` trades order for recall. With relaxed, wrap in a
   `MATERIALIZED` CTE and re-sort outside (`ORDER BY distance + 0` on PG 17+) to
   recover strict order.
4. **Partial index** — `… USING hnsw (embedding …) WHERE (category_id = 123)` —
   when filtering by **only a few distinct values**. One graph per value; the
   filtered query hits a graph that *only* contains matching rows, so `ef_search`
   is spent entirely on candidates that pass the filter.
5. **Partitioning** — `PARTITION BY LIST(category_id)` (or HASH/RANGE) — when
   filtering by **many different values**. Each partition carries its own
   HNSW/IVFFlat index; the planner prunes to the relevant partition(s) before
   the ANN scan, so again the graph contains only filter-matching rows.

### 1.3 Why a query may not use the index at all

- The query **must** have `ORDER BY <distance-operator> … ASC` *and* `LIMIT`,
  and the `ORDER BY` must be the bare distance operator, **not an expression**.
  (Casts like `embedding::vector(384) <=> $q` are themselves an expression — the
  index only matches when it was built on that *same* expression. See §3.)
- `NULL` vectors are never indexed; **zero vectors are not indexed for cosine**
  (and cosine distance to a zero vector is `NaN`).

### 1.4 Query knobs

- `hnsw.ef_search` (default 40) — dynamic candidate-list size. Higher = better
  recall, slower. Set per-query with `SET LOCAL` inside a transaction.
- `ivfflat.probes` (default 1) and `ivfflat.max_probes`.
- Iterative caps: `hnsw.max_scan_tuples` (20000), `hnsw.scan_mem_multiplier`
  (×`work_mem`, default 1 — raise if more tuples didn't lift recall).

### 1.5 Build / maintenance

- HNSW builds far faster when the graph fits in `maintenance_work_mem`; a
  `NOTICE` fires when it spills. Build the index **after** bulk load.
- Parallel HNSW builds need `--shm-size ≥ maintenance_work_mem` in Docker.
- Vacuuming HNSW is slow; `REINDEX INDEX CONCURRENTLY` first, then `VACUUM`.
- Index need not fit in RAM but performs better when it does; `halfvec` or
  binary quantization shrink it.

---

## 2. How this applies to PDPP `semantic_search_blob(connector_instance_id, scope_key, embedding vector(384))`

PDPP's query is a **highly selective, AND-filtered** ANN search:

```sql
WHERE connector_instance_id = $1
  AND scope_key = ANY($2::text[])
  [AND record_key = ANY($n::text[])]
ORDER BY embedding <=> $q LIMIT k
```

The filter columns are **high-cardinality identity keys**, not a handful of
categories. A single `connector_instance_id` (one source for one owner) is a
*small* slice of the whole table; `scope_key` narrows further. This is squarely
the docs' **"condition matches a low percentage of rows"** case — the regime
where the docs explicitly say a **B-tree filter index gives fast, exact NN**,
and where a global HNSW graph is *most* likely to under-return (post-scan
filtering throws away nearly all of its 40 candidates because they belong to
other instances/scopes).

The existing OpenSpec design (`migrate-postgres-semantic-index-to-pgvector`)
already lands a sophisticated shape and is broadly **docs-correct**:

- **Dimension-untyped `vector` column + partial expression HNSW index** keyed on
  `WHERE (vector_dims(embedding) = 384)` — so 384-dim production rows are indexed
  and non-384 test stubs fall to exact scan. Verified against
  `pgvector/pgvector:pg16` (0.8.2).
- Per-query `SET LOCAL hnsw.ef_search = clamp(limit, 40, 1000)` so a large
  overscan isn't silently capped at 40.
- `SET LOCAL hnsw.iterative_scan = strict_order` (probed at bootstrap) so the
  scope/record-key filters keep exact order and don't under-return.
- `<=>` cosine matches the prior JS `cosineDistance`; `NaN → Infinity`
  normalization for zero-magnitude parity; tie-break keys kept out of SQL
  `ORDER BY` (they'd disqualify the index) and re-sorted in JS.

That design correctly uses rungs 2+3 of the ladder. The open question this
research answers: **is rung 1 (a B-tree filter index) or rungs 4/5 (partial /
partition) a better fit given PDPP's high-cardinality identity filters?**

### The gap the docs expose

The partial index in the current design is keyed on **dimension**, not on the
**filter columns**. It produces *one* 384-dim HNSW graph spanning **all
instances and scopes**. Every query still walks that global graph and discards
the (large) majority of candidates that belong to other `connector_instance_id`s
— exactly the post-filter-shrinkage the docs warn about. `ef_search` + iterative
scan mitigate under-return but pay for it in latency: the graph walk visits up
to `max_scan_tuples` (20000) tuples to refill `k` results that survive a very
selective filter. **There is no B-tree index on `(connector_instance_id,
scope_key)` to give the planner the exact, filter-first path the docs recommend
for low-selectivity conditions.**

---

## 3. Recommended architecture options

Listed cheapest-first. Options A and B are additive and complementary; C/D are
heavier and conditional on scale.

### Option A — Add a B-tree filter index (do this regardless) ✅ recommended

```sql
CREATE INDEX idx_pg_semantic_search_filter
  ON semantic_search_blob (connector_instance_id, scope_key);
```

- Matches the docs' **rung 1** for selective AND-filters. Lets the planner
  filter to one instance+scope **first**, then run an **exact** ordered scan over
  that small set — no `ef_search`/recall risk, exact distance order, no iterative
  overscan. For PDPP's typical per-source result sizes this is often *faster and
  100% recall*, and it's the planner's fallback whenever `d ≠ 384` (stub dims)
  or the HNSW path is unprofitable.
- Column order `(connector_instance_id, scope_key)` matches the leading-column
  rule for multicolumn indexes (§11.3): the index serves both
  `connector_instance_id = $1` alone and the combined predicate.
- Cost: one B-tree, cheap to build and maintain. **Zero downside.** The planner
  chooses between this exact path and the HNSW path by cost.

### Option B — Keep partial HNSW, but make `ef_search`/iterative honest ✅ recommended (already largely present)

Retain the dimension-partial HNSW index + the existing per-query
`hnsw.ef_search` clamp and `iterative_scan = strict_order`. This is the right
safety net for large unfiltered-ish queries and for the case where one
instance+scope is itself large. Two refinements vs. the current design:

- **Overscan ratio, not just `clamp(limit,40,1000)`.** When the filter is
  selective, set `ef_search` to a multiple of `LIMIT` (e.g. `max(40, k * 4)`),
  since post-filter survival rate is low. Iterative scan already backstops
  under-return up to `max_scan_tuples`; consider raising `hnsw.max_scan_tuples`
  if recall telemetry shows truncation, and `hnsw.scan_mem_multiplier` if more
  tuples don't help.
- With Option A present, the planner will frequently prefer the exact B-tree
  path for selective filters and only fall to HNSW when a single instance+scope
  slice is large enough that exact sort is the bottleneck. That's the desired
  adaptive behavior — let cost-based planning arbitrate.

### Option C — Partial HNSW per high-traffic instance (rung 4) — conditional

```sql
CREATE INDEX … ON semantic_search_blob
  USING hnsw ((embedding::vector(384)) vector_cosine_ops)
  WHERE (connector_instance_id = '<id>' AND vector_dims(embedding) = 384);
```

- The docs' answer for "filtering by **only a few distinct values**." Gives each
  hot instance its own graph so `ef_search` is spent only on matching rows.
- **Rejected as the general mechanism for PDPP:** `connector_instance_id` is
  *many* values (grows per owner per source), and partial indexes don't
  parameterize — you'd need DDL per instance. That's operationally the same
  anti-pattern the design already rejected (dynamic retype-on-write) and breaks
  the "no per-instance DDL churn" property. Only worth it for a *small fixed set*
  of dominant instances if profiling later shows them hot.

### Option D — `PARTITION BY LIST/HASH (connector_instance_id)` (rung 5) — conditional, heavier

- The docs' answer for "filtering by **many different values**." `HASH`
  partitioning on `connector_instance_id` would let the planner prune to one
  partition before the ANN scan, so each partition's HNSW graph contains only
  that instance's rows — structurally solving post-filter shrinkage at scale.
- **Costs / risks:** partitioning is a table-rewrite migration; each partition
  needs its own HNSW index (build + memory multiplied by partition count);
  `scope_key` is a *second* filter dimension partitioning doesn't address;
  cross-instance maintenance (backfill/drift rebuild in `semantic_search_meta`)
  gets more complex. Partition pruning only helps when the partition key is in
  the predicate — fine here, since `connector_instance_id` always is.
- **Defer** unless/until the table reaches a scale where Options A+B latency is
  unacceptable (see §4 scale trigger). For PDPP's current single-owner /
  modest-corpus profile this is over-engineering.

---

## 4. Risks

- **Silent under-return is the headline risk** and is data-dependent: a global
  HNSW graph + selective filter returns *fewer than `k`* rows without erroring.
  Mitigated by Option A (exact path) + Option B (`ef_search`/iterative). **Add a
  recall/truncation telemetry check** (did we return `k` when ≥`k` matching rows
  exist?) — the docs give no automatic alarm for this.
- **Expression-index matching is brittle.** The HNSW index is on
  `(embedding::vector(384))` and the query must `ORDER BY embedding::vector(384)
  <=> $q::vector(384)` with the *identical* cast, `ASC`, and a `LIMIT`, or the
  planner silently falls to seq-scan. Any drift in how `d` is interpolated, or a
  `record_key`/tie-break leaking into `ORDER BY`, disqualifies the index. Pin
  this with an `EXPLAIN` assertion in tests.
- **Zero / NULL vectors:** not indexed for cosine; cosine distance to zero is
  `NaN`. The design's `NaN → Infinity` normalization handles parity, but such
  rows are invisible to the ANN path and only reachable via the exact (B-tree)
  path — another reason Option A matters.
- **Scale trigger for D:** the docs' tuning advice (`maintenance_work_mem`,
  IVFFlat `lists`, partitioning) only bites past ~hundreds-of-thousands to
  millions of rows. **The live `semantic_search_blob` row count and per-instance
  cardinality were not measured in this read-only pass** — they should be checked
  (during a declared live-stack window per the co-owner mutex) before investing
  in C/D. If the largest single `(connector_instance_id, scope_key)` slice is
  small, Option A alone may make the HNSW graph nearly irrelevant.
- **Build/vacuum cost:** HNSW vacuum is slow; schedule `REINDEX CONCURRENTLY`
  then `VACUUM`. Ensure Docker `--shm-size` ≥ `maintenance_work_mem` for parallel
  builds (PDPP runs pgvector in Docker per `deploy/docker/docker-compose.yml`).
- **IVFFlat is the wrong default here:** it needs data before build and degrades
  recall under selective filters worse than HNSW. The design's HNSW choice is
  correct; don't switch to IVFFlat for this workload.

---

## 5. Verdict

The active `migrate-postgres-semantic-index-to-pgvector` design is **already on
the documented path** (partial HNSW + `ef_search` clamp + strict iterative scan)
and is more correct than the prior Postgres path. **One change is missing and
should be added:**

> **Add a B-tree index on `(connector_instance_id, scope_key)`** (Option A).

PDPP's filters are high-cardinality *identity* keys, which is precisely the
"low percentage of rows" regime where pgvector's docs recommend an **exact,
filter-first B-tree path** over a global ANN graph. Combined with the existing
HNSW + iterative-scan safety net (Option B), this gives the planner both an
exact fast path for selective queries and a recall-safe approximate path for
large slices — letting cost-based planning pick correctly per query. This is the
SLVP move: exact when it can be, approximate only when it must be, never silently
truncating.

**Do now:** Option A + keep/tune Option B; add recall-truncation telemetry and an
`EXPLAIN`-pinning test for the expression-index match.
**Defer (scale-gated):** Option C for a small fixed set of proven-hot instances;
Option D (`PARTITION BY HASH(connector_instance_id)`) only if measured
per-instance scale makes A+B latency unacceptable. Measure live row counts in a
declared window before committing to either.

## 6. RI Owner Correction After Live Verification

Follow-up live inspection showed Option A was already present in PDPP as
`idx_pg_semantic_search_scope ON semantic_search_blob(connector_instance_id, scope_key)`.
That invalidates the report's statement that the btree filter index was missing.
The live finding is sharper:

- The exact btree path exists and is chosen for the combined
  `connector_instance_id + scope_key` predicate.
- For medium-large sources such as Gmail and ChatGPT, that exact path still
  scans/sorts roughly 80k-90k vectors and takes about 3-4 seconds.
- A bounded connector-level ANN candidate window improves Gmail materially but
  remains cold-slow for ChatGPT on low-similarity query vectors.
- Diagnostic partial HNSW indexes for Gmail and ChatGPT made the original
  fully-scoped query use filtered HNSW directly and return in about 180-205ms.
- A later diagnostic attempt to build a partial HNSW index for the largest
  832k-row Claude Code source exceeded maintenance memory and was canceled
  after ~25 minutes. That corrected the design: do not build partial HNSW for
  dominant huge sources by default; use a smaller candidate window for those.

Corrected verdict: keep the existing btree exact path for small scopes, use
bounded ANN candidate windows as a fallback, and manage a capped set of derived
partial HNSW indexes for medium-selectivity hot connector instances. Raise the
exact threshold enough that 15k-20k-row rare local-device sources stay exact,
and keep the default ANN candidate window modest so dominant large sources do
not pay for unnecessary 1000-row overscan. This is the
lowest-incidental-complexity fix that matches the pgvector filtering ladder and
the live PDPP workload.
