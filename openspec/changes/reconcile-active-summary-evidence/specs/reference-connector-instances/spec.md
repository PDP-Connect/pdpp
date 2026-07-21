## ADDED Requirements

### Requirement: Connector summary evidence SHALL converge through an exact scope-safe observation barrier

The reference implementation SHALL treat connector-summary evidence as a
repairable derived projection. Before any list, scoped, diagnostic, scheduler,
or singleton-detail connection summary is used for owner health or count
synthesis, one internal observation barrier SHALL compare the exact requested
canonical connection set and source checkpoints with observed evidence. It
SHALL create missing rows, repair dirty, identity-, manifest-, terminal-, and
record-checkpoint-mismatched rows, and return row-shaped stale or failed
evidence when repair cannot complete.

Record-source convergence SHALL NOT depend solely on best-effort dirty or cache
invalidation hooks. Derived extraction/upsert SHALL remain outside record and
device-batch acceptance, so projection failure cannot reject or ambiguate an
otherwise accepted record.

#### Scenario: Missing active evidence self-heals before summary use

- **GIVEN** an active canonical connection has no connector-summary evidence row
- **WHEN** any cookie, owner-bearer, scheduler, direct list, or scoped consumer requests its connection summary
- **THEN** the central observation barrier SHALL create and reconcile a row from canonical state before synthesis
- **AND** the consumer SHALL NOT substitute an empty latest-fact map or cached pre-repair verdict for missing evidence.

#### Scenario: Repair failure remains explicit

- **GIVEN** a requested connection is missing, dirty, or checkpoint-lagging
- **WHEN** fence admission, canonical read, normalization, terminal fold, or evidence write fails
- **THEN** the barrier SHALL return row-shaped stale or failed evidence with a closed sanitized reason code
- **AND** it SHALL NOT return a clean row, raw error, or empty evidence list.

#### Scenario: Full and scoped orphan cleanup preserve siblings and lifecycle rows

- **WHEN** a complete census proves an evidence row is absent from the complete canonical `connector_instances` set
- **THEN** the complete pass MAY delete that orphan
- **BUT WHEN** a scoped pass requests one connection
- **THEN** it SHALL delete only that requested row after an exact point lookup proves the connection no longer exists
- **AND** SHALL preserve every non-requested sibling and existing paused, draft/setup, and revoked lifecycle row.

### Requirement: Record summary checkpoints SHALL be reset-safe and numerically exact

For each connection, the canonical record checkpoint SHALL be the composite:

```text
{
  reset_generation: <unsigned base-10 integer string without leading zeros>,
  streams: [{ stream, max_version: <unsigned base-10 integer string without leading zeros> }, ...]
}
```

The stream array SHALL be ordered by the UTF-8 bytes of the exact stream name.
SQLite integers and Postgres bigints SHALL be read and compared as decimal text,
never coerced through JavaScript `Number`.

The canonical connection SHALL carry a non-null `record_reset_generation`
initialized to zero. A supported live-connection stream or connector reset SHALL
increment it by the number of distinct stream namespaces whose pre-reset state
contains either a `version_counter` row or at least one live canonical record,
in the same canonical transaction as those deletes. This union SHALL make a
counterless live-record reset advance once for that stream, while a reset that
finds neither a counter nor a live count/recency input remains a checkpoint
no-op. The generation SHALL survive stream/connector invalidation and disappear
only with connection deletion. Ordinary changed ingest/direct delete advances
the stream vector; semantic no-op, absent/repeated delete, and accepted replay
advance neither component.

#### Scenario: Lost dirty marker cannot hide changed ingest

- **GIVEN** evidence is current at record checkpoint A
- **AND** changed ingest commits checkpoint B inside the canonical record transaction
- **AND** the post-commit summary dirty/cache hint is lost or delayed
- **WHEN** the next connection summary observation occurs
- **THEN** the barrier SHALL detect A differs from B and repair before synthesis
- **AND** ingest acceptance SHALL remain independent of derived repair.

#### Scenario: Reset and reinsertion cannot recreate a prior checkpoint

- **GIVEN** a stream is current at `{reset_generation: R, stream_version: 1}`
- **WHEN** a supported reset removes its version counter and a different record is later inserted at stream version 1
- **THEN** the reset generation SHALL be greater than R
- **AND** the composite checkpoint SHALL differ even when the stream/version pair is identical.

#### Scenario: Counterless live records cannot hide a reset

- **GIVEN** a live canonical stream has records but its version-counter row is deliberately absent
- **WHEN** a supported stream reset or connector-wide invalidation removes that namespace
- **THEN** the reset generation SHALL advance once for that stream
- **AND** equivalent SQLite and Postgres owner-journey fixtures SHALL converge to the same checkpoint and count.

#### Scenario: Large counters normalize identically across backends

- **WHEN** equivalent SQLite and Postgres fixtures contain reset generations or stream versions above `2^53 - 1` and non-ASCII stream names
- **THEN** both backends SHALL return byte-identical normalized decimal-string checkpoint JSON
- **AND** no distinct integer value SHALL collapse through floating-point coercion.

#### Scenario: No-op and replay create no false source change

- **WHEN** record ingest is a semantic no-op, delete is absent/repeated, or an accepted device batch is replayed exactly
- **THEN** neither reset generation nor stream vector SHALL advance
- **AND** summary reconciliation SHALL NOT invent a repair obligation.

### Requirement: Summary repair SHALL share the canonical connector-instance writer fence

After the local-ingest-throughput tranche lands, candidate repair SHALL acquire
its same re-entrant connector-instance writer fence. Discovery MAY be batched
outside the fence, but each candidate SHALL be re-read and upserted inside one
SQLite immediate transaction or one Postgres transaction while the shared
fence remains held. Synthesis SHALL use the row returned by that fenced repair.
No pass SHALL hold more than one connector-instance fence.

#### Scenario: Ingest around repair cannot be stamped into stale clean evidence

- **GIVEN** discovery observes checkpoint A and selects a repair candidate
- **WHEN** ingest B commits before the candidate obtains the shared fence
- **THEN** fenced repair SHALL re-read checkpoint B and its matching counts/recency
- **AND** SHALL stamp B, not discovery snapshot A, into the row used for synthesis.

#### Scenario: Repair linearizes before a concurrent writer

- **WHEN** repair obtains the shared connection fence before a canonical writer
- **THEN** the writer SHALL wait until the exact checkpoint and evidence row commit
- **AND** the next observation after writer commit SHALL detect its newer checkpoint.

#### Scenario: Backend parity covers repair outcomes

- **WHEN** equivalent canonical/evidence fixtures are applied to SQLite and a real disposable Postgres database
- **THEN** both backends SHALL produce the same classification, normalized checkpoint, component states, evidence values, and repair outcome
- **AND** lock/read/write failure SHALL be explicit rather than silently skipped.

### Requirement: Manifest declaration transitions SHALL start a new terminal-evidence generation

When a production manifest registration changes the valid connector manifest,
the same transaction SHALL advance every affected connection's durable manifest
generation and dirty its summary evidence. Reconciliation SHALL retain
non-declared canonical and retained stream grains as dormant diagnostic data,
but it SHALL clear terminal latest-attempt facts and advance their checkpoint to
the terminal event high-water captured by that repair. A later terminal fold
SHALL use that checkpoint as its replay boundary. A manifest fingerprint is
diagnostic only and SHALL NOT be the generation identity.

#### Scenario: Re-added stream does not inherit historical terminal success

- **GIVEN** a stream was declared and has a terminal coverage/freshness fact
- **WHEN** it is absent from a valid manifest and later declared again
- **THEN** the re-added stream SHALL remain stale or unknown until a terminal
  event committed after the re-add generation boundary supplies new evidence
- **AND** SQLite and real disposable Postgres SHALL produce the same result.

### Requirement: Terminal summary folds SHALL be snapshot-bounded and non-regressing

A terminal fold SHALL capture a terminal sequence high-water `S`, fold only
attributable events through `S`, and update its fact map/checkpoint only when the
row still carries the baseline terminal checkpoint read by that pass. Record
snapshot repairs SHALL preserve terminal columns. A losing compare-and-set SHALL
accept the newer row or retry; an older pass SHALL NOT overwrite a newer fact
map or checkpoint.

#### Scenario: Concurrent older fold cannot regress newer facts

- **GIVEN** two folds read different baselines for the same connection
- **WHEN** the newer fold commits first
- **THEN** the older fold's conditional write SHALL fail or observe the newer row
- **AND** the final terminal checkpoint and fact map SHALL remain monotonic.

#### Scenario: Event after snapshot is next-pass work

- **WHEN** a terminal event commits after a pass captures high-water S
- **THEN** that pass MAY complete at S without claiming the later event
- **AND** the next observation SHALL detect and fold the later sequence before health synthesis.

### Requirement: Stream record evidence SHALL distinguish declaration, count, coverage, and retained bytes

Every connection summary SHALL expose independent typed projection components
for `record_snapshot`, `terminal_facts`, `manifest_declaration`, and
`retained_bytes`, each with a closed state, checkpoint/as-of where applicable,
and a closed sanitized optional reason code.

Each stream entry SHALL carry `declaration_state` (`declared`, `dormant`,
`unexpected`, or `unavailable`) and `count_state` (`known`, `known_zero`, `unobserved`, `stale`,
or `unknown`). The count invariants SHALL be:

- `known`: integer count at least one at the current record checkpoint;
- `known_zero`: count exactly zero at the current checkpoint;
- `unobserved`: null count before any completed record snapshot;
- `stale`: prior count may be retained after its checkpoint moved or repair failed; and
- `unknown`: null count when no trustworthy prior value exists after failure.

When the manifest is valid, the stream set SHALL be exhaustive over its
declarations, stable canonical live-record streams, and readable retained-size
stream grains. When the manifest is missing or malformed, canonical/readable
stream names SHALL remain visible with declaration `unavailable`; `unexpected`
SHALL NOT be asserted without valid declaration evidence.

Canonical records SHALL own current counts and recency. Terminal collection
facts SHALL own provider observation/coverage. The manifest SHALL own
declaration/requiredness. Retained-size SHALL own byte/history/blob measures
only.

#### Scenario: Completed canonical snapshot proves exact zero

- **GIVEN** canonical record extraction completed at a stable checkpoint
- **AND** a manifest-declared stream has no live canonical record
- **WHEN** the connection summary is synthesized
- **THEN** the stream SHALL be `declared + known_zero` with `record_count: 0`
- **AND** coverage SHALL still derive independently from terminal collection evidence.

#### Scenario: Failed or never-completed count evidence is not zero

- **WHEN** canonical record extraction never completed or failed without a trustworthy prior value
- **THEN** the entry SHALL be `unobserved` or `unknown` with a null count
- **AND** SHALL NOT fabricate `record_count: 0`.

#### Scenario: Retained canonical or history grain becomes dormant

- **GIVEN** a valid current manifest omits a stream that exists in canonical live records or readable retained history/bytes
- **WHEN** the connection summary is synthesized
- **THEN** the stream SHALL remain visible as `dormant` on a diagnostic/retention surface
- **AND** current canonical count state and retained-byte state SHALL be reported separately but excluded from active totals, coverage, discovery, and serving
- **AND** records, history, blobs, and retained facts SHALL remain preserved without automatic deletion
- **AND** re-adding the stream SHALL require new collection evidence before it can be fresh or coverage-complete.

#### Scenario: Manifest unavailability does not invent unexpected declaration

- **WHEN** the stored manifest is missing or malformed
- **THEN** canonical/readable stream names SHALL remain visible with declaration `unavailable`
- **AND** no stream SHALL be called declared or unexpected until manifest evidence is current.

#### Scenario: Dirty retained bytes do not invalidate current record counts

- **GIVEN** a record snapshot is current and its count is known
- **AND** retained byte evidence is dirty, stale, or failed
- **THEN** the record count SHALL remain known
- **AND** byte/history/blob fields SHALL be unavailable independently.

### Requirement: Connection summary observation SHALL precede caches and every consumer

Direct list/scoped functions, cookie routes, owner diagnostics, scheduler
probes, and any detail carrying connection health/counts SHALL enter the same
internal observation barrier. Correctness SHALL NOT depend on a route hook. No
TTL or stale-while-revalidate summary value MAY be returned before the barrier;
only equivalent in-flight promise coalescing MAY remain.

A connector-keyed catalog detail MAY expose connection health/counts only when
it resolves exactly one visible connection and delegates to the scoped barrier.
With zero or multiple connections it SHALL omit connection health/counts and
return typed unresolved/ambiguous connection-projection evidence.

#### Scenario: Warm pre-repair cache cannot bypass convergence

- **GIVEN** a previously computed healthy/count summary exists in the old value-cache shape
- **AND** canonical ingest changes the record checkpoint while dirty/cache hints are neutralized
- **WHEN** list or scoped summary is observed
- **THEN** the barrier SHALL reconcile before any prior value can be returned
- **AND** the response SHALL reflect the new checkpoint or explicit failure.

#### Scenario: Direct scheduler and diagnostics calls use the same barrier

- **WHEN** scheduler or owner diagnostics calls the scoped summary function without traversing a cookie route
- **THEN** it SHALL receive the same reconciled evidence and fail-closed health as the route.

#### Scenario: Ambiguous connector detail does not merge siblings

- **GIVEN** a connector id has multiple visible connections
- **WHEN** connector-keyed catalog detail is requested without exact connection identity
- **THEN** it SHALL omit per-connection health/counts and expose typed ambiguity
- **AND** SHALL NOT merge or select sibling evidence.

### Requirement: Startup summary reconciliation SHALL be bounded best-effort acceleration

After storage, manifests, and the shared writer coordinator are ready, startup
SHALL invoke the same complete-set reconciliation primitive with bounded work.
Failure SHALL record only closed sanitized diagnostics and SHALL NOT reject
canonical records or make health trustworthy. Observation-time reconciliation
SHALL remain the correctness gate.

#### Scenario: Startup failure self-heals on later observation

- **GIVEN** startup cannot repair a missing or dirty row
- **WHEN** the dependency recovers and a later connection summary is observed
- **THEN** the central barrier SHALL retry and converge the row
- **AND** no restart or owner action SHALL be required.
