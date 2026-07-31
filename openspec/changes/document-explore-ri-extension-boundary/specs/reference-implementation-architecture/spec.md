# reference-implementation-architecture — document-explore-ri-extension-boundary delta

## ADDED Requirements

### Requirement: Explore's merged-timeline operations are a documented RI-only extension family

`rs.explore.timeline` and `rs.explore.record_buckets` (`operations/rs-explore-timeline/`,
`operations/rs-explore-record-buckets/`) SHALL be treated as an explicitly
documented reference-implementation-only extension of the `operations/rs-*`
family, not as normative PDPP Core surface. They SHALL remain mounted only at
`GET /_ref/explore/records` and `GET /_ref/explore/records/buckets` behind
`requireOwnerSession`. They SHALL NOT be exposed at `/v1`, SHALL NOT be exposed
as an MCP tool, and SHALL NOT be advertised through the `/v1` schema/capability
discovery mechanism while they remain RI-only. This matches
`reference-surface-topology`'s existing distinction between protocol-normative
surfaces and reference-implementation-only artifacts (`reference-surface-topology/spec.md`,
"Public website surfaces SHALL distinguish artifact categories" and "The
reference implementation SHALL have a public explainer surface distinct from
protocol docs"): this requirement documents that distinction for Explore's
merged-timeline family specifically rather than inventing a new category.

Promotion of either operation to `/v1` or to MCP is a distinct future decision
requiring, at minimum: a second non-Explore consumer proving interoperability
need, and a settled grant-semantics story for cross-source reads under a
client (non-owner) token. Neither condition is met by this requirement, and
this requirement does not itself trigger or schedule promotion.

#### Scenario: A caller checks `/v1` capability discovery for the merged timeline

- **WHEN** a client inspects `/v1` schema/capability discovery (e.g.
  `rs-discovery-index`/`as-discovery-index`) for a merged cross-source timeline
  or bucket-aggregate capability
- **THEN** no such capability SHALL be advertised
- **AND** the only route surfacing this functionality SHALL be
  `GET /_ref/explore/records[/buckets]`

#### Scenario: A caller checks MCP's tool set for a timeline or buckets tool

- **WHEN** a client inspects the MCP server's tool set
  (`schema`, `query_records`, `aggregate`, `search`, `fetch`,
  `read_record_field`)
- **THEN** no tool SHALL wrap `rs.explore.timeline` or
  `rs.explore.record_buckets`

#### Scenario: A contributor considers promoting the merged timeline to `/v1`

- **WHEN** a contributor proposes exposing `rs.explore.timeline` or
  `rs.explore.record_buckets` at `/v1`
- **THEN** the proposal SHALL identify a second non-Explore consumer proving
  interoperability need and SHALL settle the grant-semantics question for a
  client (non-owner) token before promotion, rather than promoting on the
  strength of the operation already being `rs.*`-shaped

### Requirement: The Explore timeline's opaque cursor is a distinct token space

The Explore timeline's composite keyset cursor (a server-side, `ecr1_`-prefixed
opaque handle stored by a server-side cursor store) SHALL be documented as a
third token space, distinct from and never interchangeable with spec-core's
`cursor`/`next_cursor` (single-query pagination) and `changes_since`/`next_changes_since`
(cross-session incremental sync). A caller MUST NOT present an Explore
timeline cursor handle to any `/v1` route, and MUST NOT present a `/v1`
`cursor` or `changes_since` value to `GET /_ref/explore/records`.

#### Scenario: An Explore timeline cursor is presented to a `/v1` route

- **WHEN** a caller presents an `ecr1_`-prefixed Explore timeline cursor handle
  as the `cursor` or `changes_since` parameter of a `/v1` route
- **THEN** the `/v1` route SHALL treat it as an unrecognized/invalid token for
  that route's own token space rather than resolving it as a valid position

#### Scenario: A stale or unknown Explore timeline cursor handle is presented

- **WHEN** a caller presents a cursor handle that is stale, expired, or unknown
  to the Explore timeline's server-side cursor store
- **THEN** the operation SHALL resolve the handle to null and return a typed
  `invalid_cursor` 400 rather than silently starting over or serving a
  corrupt page

### Requirement: The Explore timeline's auth boundary is owner-session-only by design

`rs.explore.timeline` and `rs.explore.record_buckets` SHALL be gated by
`requireOwnerSession` (a cookie-based owner-session check) rather than by
grant/token authorization. Their dependency contracts (e.g.
`ExploreTimelineDependencies`) SHALL NOT carry a `grant`/`getGrant` field. This
is the correct, simpler model for an owner-only console surface with no
client/agent actor in the request path — it is not a missing grant check, and
implementers SHALL NOT add a grant-shaped parameter to these operations to
"match" `rs.records.list` without a corresponding decision to admit a
non-owner (client-token) actor into this path.

#### Scenario: A non-owner caller attempts to reach the Explore timeline

- **WHEN** a request to `GET /_ref/explore/records` or
  `GET /_ref/explore/records/buckets` does not carry a valid owner session
- **THEN** the request SHALL be rejected by `requireOwnerSession`
- **AND** no grant object or client-token authorization path SHALL be consulted
  as an alternate route to success

#### Scenario: A contributor proposes grant-scoping the Explore timeline

- **WHEN** a contributor proposes adding a grant/client-token authorization
  path to `rs.explore.timeline` or `rs.explore.record_buckets`
- **THEN** the proposal SHALL treat this as admitting a new non-owner actor
  into the Explore surface (a promotion-adjacent decision), not as a
  parity/consistency fix relative to `rs.records.list`

### Requirement: The Explore timeline orders by semantic time, independently of `rs.records.list`'s cursor-field order

`rs.explore.timeline` SHALL order its merged cross-source feed by
`COALESCE(NULLIF(semantic_time, ''), emitted_at)` DESC by default (or ASC when
`direction=asc` is requested and pinned in the cursor), per
`reference-implementation-architecture`'s existing semantic-time merged-timeline
requirement. This chronology contract SHALL NOT be required to match
`rs.records.list`'s single-stream default order
(`(cursor_field, primary_key)`, per spec-core §8's stable-sort rule): the two
operations answer different questions by construction — one merges chronology
across partitions by authored/semantic time, the other orders one stream by
its declared cursor field — and no parity claim between their orderings SHALL
be made or tested.

#### Scenario: A parity test is proposed between the two orderings

- **WHEN** a test or review proposes asserting that `rs.explore.timeline`'s
  merged order matches `rs.records.list`'s single-stream order for the same
  underlying records
- **THEN** the proposal SHALL be rejected as testing a non-goal: the two
  operations are not required to agree on ordering

### Requirement: The Explore timeline's tombstone/incremental-sync gap is documented as a deferred non-goal

`rs.explore.timeline` SHALL remain a forward point-in-time feed and SHALL NOT
be required to emit tombstone entries for deleted records, because it is not a
`changes_since`-shaped incremental-sync surface: spec-core §8's tombstone
requirement is scoped to `mutable_state` stream `changes_since` responses, not
general list pagination. `ExploreTimelineRecord` SHALL NOT be required to carry
a tombstone field under this requirement. If `rs.explore.timeline` is ever
promoted to or paired with an incremental-sync (`changes_since`-shaped) mode,
that promotion SHALL settle tombstone semantics for that mode as part of the
same promotion decision; this requirement does not schedule or gate that
promotion, it only records that the gap exists and is deliberately deferred.

#### Scenario: A reviewer checks the Explore timeline for tombstone entries

- **WHEN** a reviewer inspects `rs.explore.timeline`'s response shape or its
  conformance test suite for tombstone entries
- **THEN** none SHALL be present or required
- **AND** the absence SHALL be understood as a documented deferred non-goal for
  the current point-in-time feed shape, not an undiscovered defect

#### Scenario: A contributor proposes promoting the Explore timeline to incremental sync

- **WHEN** a contributor proposes giving `rs.explore.timeline` a
  `changes_since`-shaped incremental-sync mode
- **THEN** the proposal SHALL settle tombstone semantics for that mode as part
  of the same change rather than deferring them again
