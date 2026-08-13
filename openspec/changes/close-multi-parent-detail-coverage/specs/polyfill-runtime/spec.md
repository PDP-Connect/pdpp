## MODIFIED Requirements

### Requirement: Connectors with a detail lane SHALL emit DETAIL_COVERAGE once per parent boundary per run

A connector that runs a list+detail lane SHALL emit one `DETAIL_COVERAGE`
message after each distinct parent boundary's detail work settles. A detail
stream fed by multiple independently checkpointed parent streams MAY emit one
message per parent `state_stream` in the same run. Each required key SHALL
belong to exactly one parent-boundary report. A list+detail lane is one that
fetches a list of records and then fetches per-record detail for at least a
subset of those records. Each message SHALL carry:

- `stream`: the detail stream name.
- `state_stream`: the list/parent stream whose cursor anchors that detail pass.
- `required_keys`: the full set of record keys considered for detail in that
  parent boundary.
- `hydrated_keys`: the subset of `required_keys` successfully fetched and
  emitted.
- `gap_keys` (optional): keys for which a `DETAIL_GAP` was emitted.
- `optional_skip_keys` (optional): keys accepted by an explicit optional-detail
  policy.

Connectors that emit only flat streams with no per-record detail fetch are
exempt from this requirement.

`optional_skip_keys` SHALL contain only required keys accepted by an explicit
detail policy. Provider detail MAY be accepted as unavailable only when the
stream contract makes that detail optional and a connector-specific parser
affirmatively identifies a terminal provider-object response. An HTTP status,
object age, transport failure, retry exhaustion, or generic access denial alone
SHALL NOT establish terminal unavailability.

#### Scenario: list+detail run emits DETAIL_COVERAGE after the detail lane

**WHEN** a connector completes a list+detail run
**THEN** the connector SHALL emit a `DETAIL_COVERAGE` message
**AND** the message SHALL appear after the last RECORD or DETAIL_GAP emitted by
the detail lane in the same run
**AND** `required_keys` SHALL equal the set of keys the connector scanned for
detail.

#### Scenario: fully hydrated run emits DETAIL_COVERAGE with no gap_keys

**WHEN** a list+detail run completes with no DETAIL_GAP messages
**THEN** every `required_keys` entry SHALL appear in exactly one of
`hydrated_keys` or `optional_skip_keys`
**AND** `gap_keys` SHALL be absent or empty.

#### Scenario: partially hydrated run carries gap_keys matching emitted DETAIL_GAPs

**WHEN** a list+detail run emits N DETAIL_GAP messages
**THEN** `DETAIL_COVERAGE.gap_keys` SHALL contain those N keys
**AND** `hydrated_keys` SHALL NOT contain keys that also appear in `gap_keys`.

#### Scenario: failed detail remains retryable

**WHEN** detail hydration fails for a record whose parent enumeration otherwise
completed
**THEN** the connector SHALL either emit a durable `DETAIL_GAP` with a locator
sufficient to retry that detail independently, or leave the key uncovered so
the runtime withholds the parent cursor
**AND** it SHALL NOT emit durable retry work whose locator cannot survive the
control plane's persistence and redaction boundary
**AND** a connector that uses durable retry SHALL settle the exact served gap
and lease only after successful or terminally unavailable recovery.

#### Scenario: one detail stream has two parent cursors

**WHEN** one detail stream receives records from two independently checkpointed
parent streams
**THEN** the connector SHALL emit one `DETAIL_COVERAGE` message per parent
boundary
**AND** the runtime SHALL evaluate and commit each parent independently
**AND** it SHALL NOT reject the messages solely because their `stream` values
match while their `state_stream` values differ.

#### Scenario: the same detail key is unavailable under two parents

**WHEN** a durable detail gap names one parent and a coverage report for a
different parent contains the same detail key
**THEN** the gap SHALL account only for the parent it names
**AND** the other parent's checkpoint SHALL remain uncommitted unless that
parent supplies its own coverage evidence.

#### Scenario: ambiguous provider failure remains uncovered

**WHEN** a detail fetch returns a status or response that does not satisfy the
connector's provider-specific terminal-unavailability parser
**THEN** its key SHALL NOT appear in `hydrated_keys` or `optional_skip_keys`
**AND** the affected parent checkpoint SHALL remain uncommitted.

#### Scenario: terminal unavailable optional detail is accounted

**WHEN** an optional detail fetch satisfies the connector's provider-specific
terminal-unavailability parser
**THEN** the connector MAY retain an unavailable metadata record
**AND** it MAY include the key in `optional_skip_keys`
**AND** it SHALL NOT fabricate hydrated bytes or a blob reference.

## RENAMED Requirements

- FROM: `### Requirement: Connectors with a detail lane SHALL emit DETAIL_COVERAGE once per run`
- TO: `### Requirement: Connectors with a detail lane SHALL emit DETAIL_COVERAGE once per parent boundary per run`
