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

When a first-party browser connector's per-record detail fetch fails after an
attempt, the connector SHALL emit a retryable `DETAIL_GAP` with a redacted reason
that distinguishes retry exhaustion, redirected or non-detail pages, parse-missing
pages, source pressure, and explicit connector budget deferral when the connector
can tell those cases apart. When connector fixture capture is enabled, the
connector SHALL capture a bounded failed-detail checkpoint for at least the first
attempted failed detail page in the run. A connector MAY defer later detail
fetches in the same run after repeated retryable temporary failures, provided it
still emits list-derived records, emits matching retryable `DETAIL_GAP` records,
and reports the deferred keys in `DETAIL_COVERAGE.gap_keys`.

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
**THEN** `DETAIL_COVERAGE.gap_keys` SHALL contain the corresponding record keys
**AND** the runtime SHALL be able to match each gap key to a durable pending
`DETAIL_GAP` before committing the list stream checkpoint

#### Scenario: repeated temporary detail failures are bounded

**WHEN** a first-party browser connector sees repeated retryable temporary
detail failures in a single run
**THEN** it MAY defer later detail fetches instead of spending the same full
wait/retry budget on every remaining key
**AND** each deferred key SHALL be emitted as a retryable `DETAIL_GAP`
**AND** each deferred key SHALL appear in `DETAIL_COVERAGE.gap_keys`
**AND** the connector SHALL NOT report the detail stream as fully hydrated

#### Scenario: failed detail capture is enabled

**WHEN** connector fixture capture is enabled
**AND** a first-party browser connector attempts a detail page that fails to
hydrate
**THEN** the connector SHALL capture a bounded failed-detail checkpoint for at
least one failed detail page in the run
**AND** the connector SHALL NOT require capture to succeed for the run to
continue
