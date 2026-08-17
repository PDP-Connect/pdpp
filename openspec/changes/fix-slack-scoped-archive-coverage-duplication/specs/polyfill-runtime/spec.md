## MODIFIED Requirements

### Requirement: Connectors with a detail lane SHALL emit DETAIL_COVERAGE once per run

A connector that runs a list+detail lane SHALL emit exactly one `DETAIL_COVERAGE`
message per run, after the detail lane completes. A list+detail lane is one that
fetches a list of records and then fetches per-record detail for at least a
subset of those records. The message SHALL carry:

- `stream`: the detail stream name.
- `state_stream`: the list/parent stream whose cursor anchors the detail pass.
- `required_keys`: the full set of record keys the connector considered for
  detail fetch in this run.
- `hydrated_keys`: the subset of `required_keys` for which detail was
  successfully fetched and emitted.
- `gap_keys` (optional): keys for which a `DETAIL_GAP` was emitted.
- `optional_skip_keys` (optional): keys skipped by explicit policy (e.g.
  rate-limited voluntarily, filtered by selection scope).

Connectors that emit only flat streams with no per-record detail fetch are
exempt from this requirement.

When a connector internally folds multiple independent sources into one
run's coverage for a `(state_stream, stream)` pair — for example, healing
missing partitions from separate archives and merging their results — the
"once per run" requirement applies to the run's single externally observed
DETAIL_COVERAGE emission for that pair, not to each internal source the
connector folds. The connector SHALL compute the merged denominator (e.g. a
summed `considered`) across every source folded, then emit exactly once
using that merged value. An internal per-source pass SHALL NOT itself emit
DETAIL_COVERAGE for a pair that the run also emits once, merged.

#### Scenario: list+detail run emits DETAIL_COVERAGE after the detail lane

**WHEN** a connector completes a list+detail run
**THEN** the connector SHALL emit a `DETAIL_COVERAGE` message
**AND** the message SHALL appear after the last RECORD or DETAIL_GAP emitted by
the detail lane in the same run
**AND** `required_keys` SHALL equal the set of keys the connector scanned for
detail

#### Scenario: fully hydrated run emits DETAIL_COVERAGE with no gap_keys

**WHEN** a list+detail run completes with no DETAIL_GAP messages
**THEN** `DETAIL_COVERAGE.hydrated_keys` SHALL equal `DETAIL_COVERAGE.required_keys`
**AND** `gap_keys` SHALL be absent or empty

#### Scenario: partially hydrated run carries gap_keys matching emitted DETAIL_GAPs

**WHEN** a list+detail run emits N DETAIL_GAP messages
**THEN** `DETAIL_COVERAGE.gap_keys` SHALL contain those N keys
**AND** `hydrated_keys` SHALL NOT contain keys that also appear in `gap_keys`

#### Scenario: a run folds multiple internal sources into one coverage pair

**WHEN** a connector's run internally reads from 2 or more independent
sources (e.g. a base archive plus one or more supplementary archives healing
missing partitions) that each contribute to the same `(state_stream,
stream)` DETAIL_COVERAGE pair
**THEN** the connector SHALL merge each source's contribution into one
denominator (e.g. summed `considered`) before emitting
**AND** the connector SHALL emit that `(state_stream, stream)`
DETAIL_COVERAGE pair exactly once for the run, using the merged denominator
**AND** no internal per-source pass SHALL emit that pair on its own
