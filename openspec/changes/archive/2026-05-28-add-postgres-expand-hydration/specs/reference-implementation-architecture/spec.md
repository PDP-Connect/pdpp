## ADDED Requirements

### Requirement: The Postgres records backend hydrates manifest-declared one-hop relationship expansions

The reference implementation's Postgres records backend SHALL implement the
same grant-scoped one-hop parent → child relationship expansion contract
already provided by the SQLite backend. When a caller requests `expand[]`
on a Postgres deployment, the backend SHALL fetch declared child records,
project them through the child grant, and attach them to the parent
response page rather than rejecting or silently ignoring the request.

#### Scenario: A Postgres deployment hydrates a manifest-declared `has_many` relation

- **WHEN** a client calls `queryRecords` with `expand=recently_played` and `expand_limit[recently_played]=1` against a Postgres-backed deployment
- **AND** the grant covers both `saved_tracks` and `recently_played`
- **AND** the parent record has more than one matching child
- **THEN** the response SHALL include each parent record with an `expanded.recently_played` object
- **AND** `expanded.recently_played.object` SHALL be `'list'`
- **AND** `expanded.recently_played.data` SHALL contain exactly one child record
- **AND** `expanded.recently_played.has_more` SHALL be `true`
- **AND** the response envelope SHALL match the shape the SQLite backend returns for the same request.

#### Scenario: A Postgres deployment hydrates a `has_one` relation

- **WHEN** a client calls `queryRecords` with `expand=message_bodies` against a Postgres-backed deployment
- **AND** the grant covers both `messages` and `message_bodies`
- **THEN** each parent record SHALL include `expanded.message_bodies` set to the matching single child record
- **OR** to `null` when no matching child exists
- **AND** the child SHALL be projected through the child grant's `fields` selection.

#### Scenario: Single-record fetch honors expand on Postgres

- **WHEN** a client calls `getRecord` with `expand=recently_played` and `expand_limit[recently_played]=1` against a Postgres-backed deployment
- **THEN** the response SHALL include `expanded.recently_played` with the same shape as the list endpoint.

### Requirement: Postgres expansion enforces child grant scope, projection, and isolation

The Postgres expansion path SHALL enforce the same authorization and
isolation invariants the SQLite path enforces. Children outside the
child grant's `time_range`, `resources`, or connector-instance scope
SHALL NOT appear in the expanded payload. Fields outside the child
grant's `fields` selection SHALL NOT appear on expanded child records.

#### Scenario: Expansion without the child stream grant is rejected

- **WHEN** a client calls `queryRecords` with `expand=recently_played` against a Postgres-backed deployment
- **AND** the grant covers `saved_tracks` but not `recently_played`
- **THEN** the call SHALL throw with `error.code === 'insufficient_scope'`.

#### Scenario: Child rows from other connector instances are not visible

- **WHEN** two distinct connector instances on the same Postgres database have records for the same stream pair
- **AND** a client expands a relation on one connector instance's parent record
- **THEN** the expanded payload SHALL contain only child records owned by the same connector instance as the parent
- **AND** SHALL NOT contain child records from the other connector instance.

#### Scenario: Child field projection respects the grant

- **WHEN** a client expands a relation and the child grant restricts `fields` to a subset
- **THEN** the expanded child records' `data` object SHALL contain only the granted fields, plus any required-by-schema fields the SQLite path includes
- **AND** SHALL NOT include any fields outside the grant.

### Requirement: Postgres expansion validates the request shape with the same parser as SQLite

The Postgres expansion path SHALL use the same `normalizeExpandRequest`
parser the SQLite expansion path uses, so the accepted request shape,
the allowlist of relations, the cardinality constraints on
`expand_limit`, the nested-expansion rejection, and the default/max
limit enforcement remain identical across backends. The parser is
extracted to a shared `record-expand-helpers.js` module so both backends
import from one source of truth.

#### Scenario: Unsupported relation name returns `invalid_expand`

- **WHEN** a client calls `queryRecords` with `expand=not_a_relation` against a Postgres-backed deployment
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'`.

#### Scenario: `expand_limit` on a `has_one` relation returns `invalid_expand`

- **WHEN** a client calls `expand=message_bodies&expand_limit[message_bodies]=2` against a Postgres-backed deployment
- **AND** `message_bodies` is declared as `has_one`
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'`.

#### Scenario: `expand_limit` value above the manifest `max_limit` returns `invalid_expand`

- **WHEN** a client calls `expand=recently_played&expand_limit[recently_played]=9999` against a Postgres-backed deployment
- **AND** the manifest declares `max_limit: 50` for `recently_played`
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'`.

### Requirement: Postgres expansion is incompatible with `changes_since`

The Postgres expansion path SHALL preserve the SQLite contract that
`expand[]` cannot be combined with `changes_since`. Requests carrying
both SHALL reject with `invalid_expand` before any SQL runs.

#### Scenario: `expand` with `changes_since` is rejected on Postgres

- **WHEN** a client calls `queryRecords` with `expand=recently_played` and `changes_since=beginning` against a Postgres-backed deployment
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'`.

### Requirement: Postgres expansion rejects unsafe manifest JSON fields before SQL interpolation

The Postgres expansion path SHALL re-validate every manifest-declared
JSON field used to build SQL (`foreign_key`, `primary_key`,
`cursor_field`, `consent_time_field`) against the shared
`SAFE_JSON_FIELD` regex before any value is interpolated into a query.
Fields that fail the regex SHALL cause the request to reject before any
SQL is sent.

#### Scenario: A child stream missing from the manifest rejects the expansion

- **WHEN** a client requests an `expand` whose declared child stream is not present in `manifest.streams`
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'`.

#### Scenario: A child stream with a multi-part primary key rejects the expansion

- **WHEN** a client requests an `expand` whose declared child stream uses a multi-column `primary_key`
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'` — mirroring the SQLite path's first-party-only `primary_key: ['id']` constraint.
