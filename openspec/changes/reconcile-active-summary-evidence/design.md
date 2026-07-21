## Context

`connector_summary_evidence` persists durable identity/count evidence and
per-stream terminal-run facts. Rendered freshness, health, collection reports,
and actions remain read-time synthesis. The current dirty marker is deliberately
best-effort so a derived-projection failure cannot reject an accepted record,
but the normal reconciler selects only rows that already exist and are dirty.
Consequently:

- a missing row is invisible to reconciliation;
- a lost dirty marker can leave changed record evidence looking current;
- hard stream resets delete `version_counter`, so the same stream/version vector
  can reappear around different canonical records (an ABA collision);
- only cookie routes invoke reconciliation, while the central list/scoped
  functions, owner diagnostics, and scheduler can bypass that route hook;
- the list path may return a fresh or stale cached value before it computes or
  observes repaired evidence;
- terminal fact folds can overlap and regress a newer fact map/checkpoint;
- sparse stream rows encode several meanings through omission; and
- a retained stream outside the current manifest is not surfaced as a
  declaration mismatch.

The live residual audit observed the missing/dirty/unexpected shapes without
reading record payloads. A deterministic architecture probe additionally proved
the reset ABA against both the base implementation and the active throughput
diff. Existing project requirements make projection unreliability the highest-
precedence `unknown` health condition.

External prior art supports a reconciliation boundary rather than stronger
cache coupling: Kubernetes controllers compare desired and observed state until
they converge; PostgreSQL documents materialized results as potentially stale
and makes unavailable population explicit; Kafka Streams restores derived state
from durable source/checkpoint history. The durable research note is
`ai/research/distributed-systems/derived-projections-self-heal-by-reconciling-authoritative-state-and-expose-unavailable-as-distinct-from-empty.md`
in the shared research corpus.

## SLVP-Ideal Concept Boundary

### Authorities

- `connector_instances` is authoritative for the connection set and
  lifecycle/identity fields. All existing lifecycle rows remain represented;
  active connections are the forced missing-row acceptance case, not a reason
  to drop paused, draft/setup, or revoked rows.
- A reset-safe `record_source_checkpoint` is authoritative for whether stored
  record facts match the current record namespace. It is the composite of a
  per-connection `record_reset_generation` and the sorted per-stream
  `version_counter` vector described below.
- Canonical `records WHERE deleted = false` is authoritative for current
  per-stream counts and record recency during a repair. Tombstones, coverage,
  and retained-size estimates do not own those facts.
- Attributable terminal spine events ordered by `event_seq` are authoritative
  for per-stream latest-attempt facts.
- The successfully parsed current stored connector manifest is authoritative
  for declaration membership and requiredness.
- Clean retained-size rows are authoritative only for retained byte, history,
  and blob measures. They never own canonical record counts or provider
  coverage.

`connector_summary_evidence` is never an authority. It is a disposable,
idempotently repairable cache of facts from those sources.

### Exact reset-safe record checkpoint

The normalized checkpoint is:

```text
record_source_checkpoint = {
  reset_generation: <unsigned base-10 integer string, no leading zeros>,
  streams: [
    { stream: <exact stream name>, max_version: <unsigned base-10 integer string, no leading zeros> },
    ...
  ]
}
```

`streams` is sorted by the UTF-8 byte sequence of the exact stream name. Both
backends read the integer columns as decimal text; JavaScript `Number` is not an
allowed checkpoint representation. SQLite `INTEGER` and Postgres `BIGINT`
therefore normalize byte-identically even beyond `2^53 - 1`.

`record_reset_generation` is a non-null canonical column on
`connector_instances`, initialized to zero. A supported stream or
connector-wide reset increments it by the number of distinct stream namespaces
whose pre-reset state contains either a `version_counter` row or at least one
live canonical record, in the same canonical transaction as the deletes. This
union rule covers recoverable counter drift: a reset that deletes live records
whose counter is already missing still advances once for that stream. A reset
is a checkpoint no-op only when it removes neither a counter nor a live
count/recency input. The generation survives every stream/connector
invalidation and disappears only when the connection row is deleted. Ordinary
changed ingest/direct soft-delete advances the relevant stream counter;
semantic no-op, absent/repeated delete, and exact accepted replay advance
neither component. A reset followed by reinsertion can therefore never
reproduce the earlier composite checkpoint.

The checkpoint is a source-change detector, not the record payload. It contains
no record key, value, content, or credential.

### One scope-safe reconciliation primitive

One backend-parity primitive owns convergence. Batched discovery compares the
requested canonical set, normalized record checkpoints, durable manifest
generations (with fingerprints retained only as declaration diagnostics),
retained-byte envelopes, terminal high-water, and observed evidence. It
classifies each requested row as:

- `missing`: a canonical connection has no evidence row;
- `dirty`: the row says it has not absorbed a change;
- `record_checkpoint_mismatch`: the composite record checkpoint differs;
- `identity_mismatch`: cached lifecycle/identity fields differ;
- `manifest_generation_mismatch`: its durable declaration generation differs;
- `terminal_checkpoint_lag`: terminal facts are behind the pass high-water;
- `retained_bytes_changed_or_unavailable`: the byte source changed or is not
  trustworthy; or
- `current`: no repair condition applies.

A complete unscoped census may delete evidence rows absent from the complete
authoritative `connector_instances` set. A scoped pass may delete only the exact
requested row after a point lookup proves that exact connection no longer
exists. Absence from a subset is never evidence that a sibling is orphaned.

Discovery is batched and does not acquire per-connection locks. Only a repair
candidate acquires the shared re-entrant connector-instance writer fence from
the landed local-ingest-throughput tranche. Never hold two instance fences at
once. Under that fence:

- SQLite re-reads the canonical connection, checkpoint, counts, recency,
  manifest declaration, and retained-byte envelope and upserts their exact
  checkpoint in one immediate write transaction.
- Postgres holds the same advisory-lock domain for one transaction that re-reads
  those facts and upserts their exact checkpoint.

The row used by synthesis is the row returned from that fenced transaction, not
the pre-lock discovery snapshot. Ingest concurrent with discovery either
linearizes before the fenced repair or waits for it; no final checkpoint-read to
upsert gap exists. Admission, lock, canonical read, normalization, or evidence
write failure returns row-shaped `stale` or `failed` evidence with a closed,
sanitized reason code. It never fabricates a clean row or substitutes `[]`.

Derived repair stays outside record/device-batch acceptance. Dirty markers and
cache invalidations remain latency hints only. The composite checkpoint is the
correctness backstop when either hint is lost.

### Monotonic terminal-fact fold

Terminal folding remains independently snapshot-bounded. A pass captures
terminal high-water `S`, reads attributable events only through `S`, and writes
the new fact map/checkpoint only if the row still carries the baseline terminal
checkpoint it read. Record-evidence upserts preserve terminal columns.

If the compare-and-set loses to a newer fold, the pass accepts the newer row or
retries; an older fact map/checkpoint may never overwrite a newer one. An event
committed after `S` is explicitly next-pass work. Fold failure changes only the
`terminal_facts` component to stale/failed and cannot be erased by a successful
record-snapshot repair.

### Orthogonal projection evidence

Each summary exposes typed components:

- `record_snapshot`: `current | unobserved | stale | failed`, with normalized
  checkpoint, `as_of`, and a closed optional `reason_code`;
- `terminal_facts`: `current | unobserved | stale | failed`, with terminal
  `event_seq`, `as_of`, and reason code;
- `manifest_declaration`: `current | unavailable | failed`, with normalized
  declaration fingerprint and reason code; and
- `retained_bytes`: `current | unobserved | stale | failed`, with source `as_of`
  and reason code.

Reason codes are a closed connector-neutral vocabulary such as
`summary_missing`, `record_checkpoint_lag`, `repair_lock_unavailable`,
`record_snapshot_failed`, `terminal_fold_failed`, `manifest_unavailable`,
`manifest_invalid`, and `retained_bytes_unavailable`. Raw database or source
errors never cross this boundary.

The components are independent. Clean canonical counts do not launder failed
terminal facts; dirty retained bytes do not make a stable record count unknown;
and a clean retained row does not prove provider observation or manifest
declaration.

### Explicit stream evidence

Each stream record entry carries two independent fields:

- `declaration_state`: `declared`, `dormant`, `unexpected`, or `unavailable`;
- `count_state`: `known`, `known_zero`, `unobserved`, `stale`, or `unknown`.

The invariants are disjoint:

- `known` requires integer `record_count >= 1` at the current checkpoint;
- `known_zero` requires `record_count = 0` at the current checkpoint;
- `unobserved` requires `record_count = null` before any completed snapshot;
- `stale` means the checkpoint moved or repair failed after a prior snapshot and
  may carry its last-known count; and
- `unknown` requires `record_count = null` when failure left no trustworthy
  prior value.

When a manifest is readable, the stream set is exhaustive over the union of
manifest declarations, stable canonical live-record streams, and readable
retained-size stream grains. A canonical or retained grain outside the current
manifest is `dormant`: its physical count and retained facts remain visible on
the diagnostic/retention surface, but it is excluded from active totals,
coverage, discovery, and serving. `unexpected` is reserved for an explicit
current-generation declaration violation, not historical persistence. When a
manifest is missing or malformed, canonical and readable retained stream names
remain visible with `declaration_state = unavailable`; `unexpected` is never
asserted without a successfully parsed manifest. Re-adding a dormant stream
makes it declared with its old retained facts, but coverage/freshness remain
unknown or stale until new current evidence commits. The production
manifest-registration transaction advances a connection-scoped durable
generation for every changed manifest and dirties its summary evidence before
any reader can observe it. Every attributable terminal spine event is stamped
with that connection's current generation in the terminal append transaction;
the event append and manifest mutation serialize on the same connection row.
A rebuilt summary accepts only facts stamped with its current generation, so a
deleted projection cannot replay a pre-removal success into a re-added stream.
Legacy or unattributed terminal events are historical, never current proof.
This boundary is durable and generation based, never a clock, fingerprint-reuse
test, or connector-specific branch.

Source-generation filtering is fold contract version 3. A version-2 terminal
map can have accepted source rows that predate durable generation provenance,
so version 3 treats that map and checkpoint as an invalid replay baseline. The
first v3 observation replays from source; its source-derived historical verdict
must equal deleting and rebuilding the disposable projection. A binary that
sees a fold version ahead of its own continues to fail closed in memory and
never overwrites that newer-owned row.

A replay CAS loss is an authority event, not a successful fold. The reader
replays from the new durable baseline a bounded number of times. If competing
writes keep winning, that observation returns typed non-current terminal
evidence in memory rather than trusting the retained map; it does not durably
mutate a potentially future-version row.

A declared stream absent from a completed stable canonical record snapshot is
`declared + known_zero`. A missing retained-size row does not change that count;
it affects retained byte evidence only. Known zero never proves provider
observation or complete coverage, which continues to derive from collection
facts and policy.

### Central consumer and cache boundary

One internal connection-summary observation barrier runs before every output
that carries connection counts or connection health:

- direct `listConnectorSummaries` calls;
- direct `getConnectorSummaryForRoute` calls;
- cookie list/scoped routes;
- owner-bearer diagnostics;
- scheduler probes; and
- connector detail only when it resolves exactly one connection.

Routes do not own correctness calls. The existing TTL/stale value cache is
removed; only equivalent in-flight promise coalescing may remain. Thus no cached
pre-repair verdict can bypass the barrier, and time-relative health is
re-synthesized for each observation. A connector-keyed catalog detail with zero
or multiple visible connections omits connection health/counts and exposes a
typed unresolved/ambiguous connection projection; it never merges sibling
evidence.

The barrier returns both the reconciled row and its component envelope. Missing
or failed reads are not caught into an empty fact map. Any repaired or changed
token naturally changes the subsequent synthesis input; no route-local cache
invalidation is required for correctness.

### Health boundary

`record_snapshot` non-current, `terminal_facts` non-current,
`manifest_declaration` non-current, or an explicit current-generation
`unexpected` stream is added to the existing `ProjectionReliable` input.
Dormant historical grains are not an unreliable input. That condition has highest
precedence and forces `unknown`; it cannot be overwritten by a successful run,
fresh source heartbeat, or complete coverage. A successfully checkpointed empty
terminal history is `current`, not failed absence; a never-observed terminal
component is non-current and fails closed.

`retained_bytes` failure makes byte fields unavailable but does not by itself
degrade connection health because health does not depend on retained bytes.
Source freshness, collection coverage, projection evidence, and retained bytes
remain separate axes. An unexpected stream is a maintainer
projection/declaration mismatch, not proof of corrupt records and never an
owner reauthentication action.

### Startup is acceleration, not authority

After storage, manifests, and the shared coordinator are ready, startup invokes
the same primitive over the complete connection set with bounded work and
closed sanitized failure diagnostics. It is best-effort: startup failure cannot
reject canonical data or make health trustworthy. Every observation still runs
the central barrier, so a later request repairs missing/failed startup work.

## Alternatives Rejected

### Make summary repair part of record acceptance

Rejected. A derived-cache outage would reject or ambiguate a canonical record or
accepted device batch. The reset generation and ordinary version allocation are
canonical mutation metadata; summary extraction/upsert remains derived and
post-acceptance.

### Trust dirty hooks and cache invalidation

Rejected. Hooks are useful latency optimizations, but missed calls, missing
rows, future writers, and warm value-cache entries remain correctness holes.

### Use the version vector without reset generation

Rejected by deterministic probe. A supported reset deletes the vector and a
reinsertion can recreate the same values around different records.

### Use only a repeatable snapshot or before/after reads

Rejected. Either admits a final-read-to-upsert race unless the canonical writers
and repair share one fence. The landed connector-instance writer coordinator is
the selected construction.

### Rebuild every row on every read

Rejected. Batched discovery identifies candidates; only K mismatches acquire a
fence and rescan one connection. Current steady-state reads remain fixed-query
and lock-free.

### Treat absent stream as zero or hide retained history

Rejected. Exact zero requires a completed canonical snapshot, while manifest or
retained evidence may be unavailable. The accepted design preserves retained
history as `dormant` diagnostic evidence while preventing stale grants and
active discovery from serving it; it does not call historical retention a
current declaration mismatch.

### Retain stale-while-revalidate value caching

Rejected. An evidence-token-aware cache plus time-relative health refresh is a
larger state machine. In-flight coalescing preserves duplicate-work protection
without making a cached verdict authoritative.

## Coordination With Local Ingest Throughput

The active throughput tranche changes `db.js`, `postgres-storage.js`,
`records.js`, `postgres-records.js`, `index.js`, connector-instance store and
coordinator files, and device-ingest tests. This change SHALL NOT edit those
files concurrently. The throughput owner must first produce a reviewed, gated
commit with a complete writer inventory. This branch then integrates that
commit and re-reads the landed coordinator API before implementation.

Summary reconciliation uses that one coordinator; it does not create another
lock domain, enter the device reservation transaction, change accepted replay
identity, dirty on a semantic no-op/replay, or hold a writer fence across an
unrelated sibling connection.

## Pre-Implementation Gate

Implementation is blocked until:

1. the older active `define-stream-coverage-freshness-evidence` count delta is
   amended to use canonical record-snapshot authority, a deterministic composed
   overlay check proves it is applied/archived before this `MODIFIED` delta, and
   the resulting requirement has exactly one count authority;
2. this change and the complete OpenSpec corpus pass strict validation;
3. the throughput owner has a reviewed/gated commit and this branch integrates
   it before touching overlapping files;
4. the same independent GPT-5.6 Sol architecture checker reads the amended
   artifacts and landed throughput construction;
5. the checker reports at least 95% confidence that the checkpoint, fence,
   terminal CAS, evidence taxonomy, consumer/cache boundary, backend parity,
   and sequencing are SLVP-ideal; and
6. every checker P0/P1 is resolved before production-code or test implementation
   begins.

## Acceptance Strategy

One parameterized production-entry-point journey matrix runs against SQLite and
a real disposable Postgres database. It forces:

- active missing evidence, dirty/failed evidence, initial zero, and declared
  zero-record streams;
- canonical and retained-only unexpected streams;
- missing/malformed manifest and declaration unavailability;
- changed ingest with the dirty marker neutralized;
- semantic no-op, absent/repeated delete, accepted replay, and device
  partial-prefix resume without false checkpoint work;
- direct changed write/delete and connector-wide invalidation;
- reset/delete followed by reinsertion at the same per-stream version;
- live canonical records with a deliberately absent counter followed by stream
  reset and connector-wide invalidation;
- counters beyond `2^53 - 1` and byte-identical normalized checkpoints;
- ingest immediately around discovery and fenced repair;
- two concurrent reconcilers/folds proving an older pass cannot regress a newer
  terminal checkpoint;
- an event after terminal snapshot `S`;
- warm prior value-cache and stale-while-refresh shapes proving the central
  barrier wins (the implementation retains only in-flight coalescing);
- full-list versus scoped orphan cleanup, including draft/paused/revoked
  preservation;
- startup/read overlap, startup failure, and later request repair;
- dirty retained bytes with clean canonical counts, failed terminal facts with
  clean counts, and terminal facts that are never observed versus a successfully
  checkpointed empty terminal history;
- repair lock/read/write failure forcing `ProjectionReliable=false` and never
  Healthy; and
- list, scoped, cookie, owner diagnostics, scheduler, singleton detail, and
  ambiguous detail entry points traversing the same barrier.

The final assertion is the owner-safe summary/health plus canonical,
checkpoint, and evidence rows—not a direct reconciler return. Backend parity
compares the same normalized state/checkpoint/result envelope. An instrumented
N-slope oracle proves discovery/evidence query count is fixed for N=1 and N=25
current connections; repair adds work only for K actual candidates, scoped
reads stay scoped, and no pass holds multiple instance fences.

No live mutation, credentials, record payload inspection, hosted CI, deploy, or
reset-credit use is part of acceptance.
