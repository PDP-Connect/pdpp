## ADDED Requirements

### Requirement: Owner connector-summary lists SHALL page immutable connection identities before evidence

The reference-only unscoped `GET /_ref/connectors` read SHALL select an
owner-visible page of durable connection identities before it reconciles or
reads summary evidence. Its cursor order SHALL be the immutable tuple
`(connector_id, created_at, connector_instance_id)` ascending, where
`connector_instance_id` is the unique tie-breaker. The response SHALL expose a
bounded `limit`, `has_more`, and an opaque nullable `next_cursor`; the cursor
SHALL bind its owner scope and ordering version. The list SHALL NOT order by
display name, status, freshness, verdict, or other mutable derived evidence.

The optional `connection` selector SHALL retain its existing exact/
unambiguous single-connection semantics and SHALL NOT be widened by pagination.

#### Scenario: Page preserves exact connection identity

- **GIVEN** an owner has two active connections with the same `connector_id`
- **WHEN** either identity appears in an unscoped connector-summary page
- **THEN** its `connection_id` and `connector_instance_id` SHALL equal that
  exact durable connection id
- **AND** no sibling's schedule, run, health, or evidence SHALL be merged into
  that item.

#### Scenario: Cursor is stable across mutable summary updates

- **GIVEN** a client has received a page cursor after identity tuple `K`
- **WHEN** display name, status-derived health, schedule, run, or other
  mutable summary evidence changes before the next request
- **THEN** the next page SHALL continue after `K` in the immutable identity
  order
- **AND** the implementation SHALL NOT claim a cross-page snapshot.

#### Scenario: Cursor cannot cross owner scope

- **WHEN** a cursor issued for one owner, malformed cursor, or unsupported
  cursor version is supplied to another owner list request
- **THEN** the reference SHALL reject it as a typed invalid request
- **AND** SHALL NOT reveal or read another owner's connection identities.

### Requirement: Connector-summary page evidence SHALL use exact bounded connection scopes

For an unscoped summary page, every batch that has connection-grain evidence
SHALL accept the page's exact `connector_instance_id` set and return results
keyed by that id. SQLite batches SHALL bind values and chunk before their host
parameter limit; PostgreSQL batches SHALL preserve equivalent semantics with a
bound text array. An empty page scope SHALL return before either backend issues
a bulk membership query.

The reference SHALL preserve current null, stale, unreliable, and bounded-floor
semantics for absent or failed evidence. It SHALL NOT create a rendered-summary
cache, treat `connector_summary_evidence` as authority, or infer owner-wide
counts from one page.

#### Scenario: A large fleet has page-bounded query work

- **GIVEN** equivalent owners with 1 and 1,000 visible connections
- **WHEN** each requests a page with the same limit
- **THEN** each durable evidence axis SHALL issue a page-bounded batch rather
  than one query per connection or an owner-wide evidence scan
- **AND** the returned page SHALL contain no more than the requested limit.

#### Scenario: SQLite and PostgreSQL retain equivalent page semantics

- **WHEN** equivalent page ids and evidence fixtures are read from SQLite and
  a real PostgreSQL database
- **THEN** both backends SHALL return the same ordered identity page, cursor
  reachability, exact connection mapping, and typed unavailable evidence.

### Requirement: Owner connector-summary pages SHALL support an optional bounded connector_id filter

The paginated `GET /_ref/connectors` route SHALL accept an optional
`connector_id` query parameter that narrows the SAME owner-visible keyset page
(identity, ordering, cursor tuple) to exactly one connector's connections,
so a caller enumerating all connections of one connector (Add Source, manual
upload, grant discovery) does so without scanning the fleet. `connector_id`
SHALL compose with `limit`/`cursor` as a single fixed-shape query family — it
SHALL NOT introduce a second dynamic query variant, and it SHALL require
`limit` exactly like `cursor` already does (a bare `connector_id` with neither
`limit` nor `cursor` SHALL be rejected as an invalid request, since the filter
composes with pagination and is not a standalone unbounded list).

`connector_id` SHALL preserve owner isolation identically to the unfiltered
page: it SHALL NOT read or return another owner's connections, and it SHALL
NOT be combinable with the exact `connection` selector (that selector already
resolves at most one connection and takes exclusive precedence over
`limit`/`cursor`; `connector_id` together with `connection` SHALL be rejected
as an ambiguous combination the same way `connection` with `limit`/`cursor`
already is).

An opaque continuation cursor issued under one `connector_id` filter SHALL be
bound to that exact filter value: it SHALL NOT resolve under a request that
omits the filter, or names a different `connector_id`.

#### Scenario: connector_id filter narrows to exactly one connector, page-bounded

- **GIVEN** an owner has 150 connections for connector A and 5 for connector B
- **WHEN** a `GET /_ref/connectors?connector_id=A&limit=100` page is requested
- **THEN** every returned item SHALL belong to connector A
- **AND** the page SHALL contain no more than the requested limit
- **AND** traversing every page via `next_cursor` SHALL visit each of
  connector A's 150 connections exactly once
- **AND** none of connector B's connections SHALL appear on any page of that
  traversal.

#### Scenario: connector_id requires limit

- **WHEN** `GET /_ref/connectors?connector_id=A` is requested with neither
  `limit` nor `cursor`
- **THEN** the reference SHALL reject it as a typed invalid request rather
  than returning an unbounded connector-filtered list.

#### Scenario: connector_id cannot combine with the exact connection selector

- **WHEN** both `connection` and `connector_id` are supplied on the same
  request
- **THEN** the reference SHALL reject it as an ambiguous combination, the same
  way it already rejects `connection` together with `limit`/`cursor`.

#### Scenario: connector_id-scoped cursor cannot cross filter scope

- **GIVEN** a client has received a page cursor issued under
  `connector_id=A`
- **WHEN** that cursor is supplied on a request omitting `connector_id`, or
  naming `connector_id=B`
- **THEN** the reference SHALL reject it as a typed invalid cursor
- **AND** SHALL NOT silently resolve it against the wrong (or unfiltered)
  connector scope.

#### Scenario: SQLite and PostgreSQL retain equivalent connector_id-filtered page semantics

- **WHEN** equivalent page ids, a `connector_id` filter, and evidence fixtures
  spanning more than 100 connections for the filtered connector are read from
  SQLite and a real PostgreSQL database
- **THEN** both backends SHALL return the same ordered, connector-filtered
  identity page, cursor reachability, and exact connection mapping
- **AND** a concurrent status mutation on one connection during traversal
  SHALL NOT duplicate or drop any other identity in the filtered page set.
