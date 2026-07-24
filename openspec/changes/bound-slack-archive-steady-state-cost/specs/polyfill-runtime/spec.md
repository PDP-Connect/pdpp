## ADDED Requirements

### Requirement: An archive-backed connector's steady-state run cost SHALL scale with new data, not total archive size

A connector that maintains a persistent local archive across runs (e.g. the
Slack connector's `slackdump.sqlite`) and reads that archive to emit RECORDs
incrementally SHALL bound its per-run work to the volume of new or changed
source data, not to the cumulative size of the archive. Specifically, when the
connector holds a committed cursor from a prior run, its archive read path
SHALL apply that cursor as early as possible in query evaluation — a full-table
aggregation or scan performed *before* the incremental filter, whose cost grows
with total archive size on every run regardless of how little is new, is a
performance defect.

The connector SHALL emit per-phase timing observability through its `progress`
channel — at minimum: external-tool subprocess duration, archive-open
duration, per-stream read+emit duration, and total run duration — plus an
archive size snapshot (the archive database's byte size and the presence and
byte size of any downloaded-attachment residue directory). This makes the
"scales with new data, not archive size" bound a measured value on every run
rather than an assumption, so a regression is visible in run evidence.

Pushing the cursor earlier in evaluation SHALL preserve the emitted RECORD set
exactly: the set of records emitted with the cursor applied early SHALL equal
the set emitted with the cursor applied late over the same archive state. This
is a query-shape optimization, not a coverage or semantics change.

#### Scenario: incremental read over a large archive with few new rows

**WHEN** the connector runs against a persistent archive holding many prior
messages
**AND** only a small number of messages are newer than the connector's
committed cursor
**THEN** the archive read SHALL restrict its dedup/aggregation to rows newer
than the cursor
**AND** the emitted RECORD set SHALL be identical to the set that a
full-archive aggregation followed by the same cursor filter would emit
**AND** the connector SHALL report per-phase timing (subprocess, archive open,
per-stream, total) and an archive size snapshot via `progress`.

#### Scenario: first run or missing cursor falls back to full read

**WHEN** the connector runs with no committed cursor for a stream (first run,
or a scope with no prior state)
**THEN** the archive read MAY perform a full aggregation over the archive for
that stream
**AND** this is correct because there is no cursor to push, and the resulting
emitted set is the connector's declared full coverage for that stream.

### Requirement: Reclaiming persistent archive residue SHALL be opt-in, commit-gated, and SHALL NOT remove resume-critical data

A connector MAY offer to reclaim operator-visible residue in its persistent
archive (e.g. downloaded attachment bytes the connector does not ingest into
PDPP). Such reclamation SHALL be off by default and SHALL execute only when the
operator explicitly enables it via a connector option.

When enabled, reclamation SHALL run only after the run's emitted records are
durably accepted by the runtime — gated on the runtime's end-of-stream
acknowledgement the connector already waits for before process exit — so that a
crash or failed ingest before durable acceptance leaves the residue intact.

Reclamation SHALL NOT remove any file the external tool depends on to resume or
to preserve already-collected data (e.g. the archive database and its
write-ahead/shared-memory sidecars). It SHALL report the reclaimed byte count
as run evidence, and its documentation SHALL state plainly that the operation
is one-way, that PDPP holds no copy of the reclaimed bytes, and that it may
disable the external tool's ability to re-fetch those bytes on future runs.

A connector SHALL NOT reclaim such residue automatically, even when steady-state
configuration would prevent the residue from regrowing, because an operator may
have intentionally configured the tool to retain those bytes locally, and a
connector must not silently destroy operator-owned data.

#### Scenario: reclaim runs only when explicitly enabled and after durable commit

**WHEN** the reclaim option is disabled (its default)
**THEN** the connector SHALL NOT delete any archive residue.

**WHEN** the reclaim option is explicitly enabled
**AND** the run's records have been durably accepted (the runtime has consumed
the terminal `DONE` and closed the connector's input)
**THEN** the connector SHALL remove only the operator-visible residue directory,
SHALL leave the archive database and its sidecars untouched, and SHALL report
the reclaimed byte count as run evidence.

#### Scenario: reclaim never precedes durable acceptance

**WHEN** the reclaim option is enabled
**AND** the run fails or the process is interrupted before the runtime
acknowledges durable acceptance
**THEN** the residue SHALL remain on disk untouched, so no bytes are lost ahead
of a durable commit receipt.
