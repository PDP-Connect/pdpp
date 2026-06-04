# polyfill-runtime Specification Delta

## ADDED Requirements

### Requirement: Connector manifest stream schema SHALL declare and validate coverage_policy

The `packages/reference-contract` manifest stream schema SHALL include
`coverage_policy` as an optional field with a closed enum of accepted values:
`collect`, `deferred`, `inventory_only`, `unavailable`, and `unsupported`.

The field SHALL be optional; absence is treated as `collect` (the default, "this
stream is intended to be fully collected"). A connector author declaring a stream
as `unsupported` or `unavailable` SHALL also set `required: false` to avoid a
contradictory manifest signal (`required: true` + accepted-coverage policy
degrades health rather than projecting accepted-coverage-green).

#### Scenario: manifest schema accepts all valid coverage_policy values

**WHEN** a manifest stream declares `coverage_policy` with one of `collect`,
`deferred`, `inventory_only`, `unavailable`, or `unsupported`
**THEN** the reference-contract schema validation SHALL accept the manifest
without error.

#### Scenario: manifest schema rejects unknown coverage_policy values

**WHEN** a manifest stream declares a `coverage_policy` value outside the
recognized enum
**THEN** the reference-contract schema validation SHALL reject the manifest with
a type error.

#### Scenario: absence of coverage_policy is valid

**WHEN** a manifest stream does not declare `coverage_policy`
**THEN** the schema SHALL accept the manifest
**AND** the server SHALL treat the stream as `collect` (fully collected by
default).

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
