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
