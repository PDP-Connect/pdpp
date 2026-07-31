## MODIFIED Requirements

### Requirement: Connection-summary route supports single-connection scoping

The `GET /_ref/connectors` connection-summary route SHALL accept an optional connection-selector query parameter. When the selector is present, the route SHALL project and return only the connection the selector resolves; when it is absent, the route SHALL return summaries for all configured connections exactly as before. The scoped projection SHALL be the same per-connection projection used to build the unscoped list, so a single-connection summary cannot diverge from the connection's entry in the full list.

The selector SHALL resolve an exact match on a connection's stable connection identity (`connection_id` / `connector_instance_id`) first. If no exact identity matches, connector-id fallback MAY resolve only when exactly one configured connection uses that `connector_id`. When multiple configured connections share the connector id, the route SHALL return no scoped summary rather than silently selecting one. The route SHALL NOT introduce a new addressing scheme for connections.

The route SHALL remain owner-session-gated for both the scoped and unscoped forms, and the scoped read SHALL NOT persist a connection.

The route SHALL additionally accept an optional named `profile` query parameter selecting which dependency families the single, shared connector-summary projection loads and which fields it synthesizes for this request; the parameter SHALL compose with the connection selector, cursor, and `limit`/`connector_id` exactly as documented for each. Omitting `profile` SHALL preserve the exact full (`detail`-shaped) response documented above and elsewhere in this capability. A named profile is option-gating within the one existing projection implementation, never a second projection or a second route.

The paged (non-`connection`-selector) form's `connector_id` query parameter SHALL additionally accept a bounded set of repeated values (`?connector_id=A&connector_id=B&...`), 1 to 100 canonical distinct connector ids per request. A single occurrence SHALL behave exactly as the pre-existing single-connector-id filter. The server SHALL canonicalize each supplied id using the same boundary rule as the single-id filter before deduplicating; a set containing more than 100 distinct canonical ids, an empty set, or two or more raw ids that canonicalize to the same id SHALL be rejected as a typed invalid request. The `connector_id` set parameter SHALL remain mutually exclusive with the connection selector, exactly as the existing single-id filter is.

The set-scoped page's opaque continuation cursor SHALL bind to the set's canonical (deduplicated, order-independent) fingerprint, not to the raw order the caller supplied. A continuation whose bound fingerprint does not exactly match the current request's `connector_id` scope (omitted, added, removed, or naming a different set) SHALL be rejected as a typed invalid cursor, exactly as a single-id filter mismatch already is. A caller MAY supply the same logical set in a different order across requests without invalidating an in-flight cursor.

For a fixed canonical `connector_id` set, exhausted traversal (following `next_cursor` until `has_more` is `false`) SHALL return every owner-visible connection whose canonical `connector_id` is in that set, exactly once, subject to the same keyset/no-cross-request-snapshot semantics documented for the unfiltered and single-id-filtered forms. A single page SHALL NOT be represented as complete; only exhausted traversal is complete. A caller MAY partition a `connector_id` scope larger than 100 distinct ids into disjoint subsets and traverse each independently to completion, since result sets are disjoint by canonical `connector_id`.

#### Scenario: Unscoped request returns all connections

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with no connection selector
- **THEN** the route SHALL return a `{object: "list", data}` envelope containing a summary for every configured connection
- **AND** the response SHALL be equivalent to the prior unscoped behavior

#### Scenario: Scoped request returns only the exact connection

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with a connection selector matching a configured `connection_id` or `connector_instance_id`
- **THEN** the route SHALL return a list containing only that connection's summary
- **AND** the summary SHALL be projected through the same per-connection projector used by the unscoped list

#### Scenario: Connector-id fallback is unambiguous

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with a connection selector matching a `connector_id`
- **AND** exactly one configured connection uses that connector id
- **THEN** the route MAY return a list containing that one connection's summary

#### Scenario: Connector-id fallback is ambiguous

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with a connection selector matching a `connector_id`
- **AND** two or more configured connections use that connector id
- **THEN** the route SHALL return an empty list
- **AND** it SHALL NOT silently select the first matching configured connection

#### Scenario: A repeated `connector_id` set scope returns every connection across every requested connector type

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with `connector_id` supplied 2 or more times, each a distinct canonical connector id, with `limit`
- **THEN** exhausted traversal (following `next_cursor` to `has_more: false`) SHALL return every owner-visible connection whose canonical `connector_id` is one of the supplied ids, exactly once
- **AND** a requested connector id with zero configured connections SHALL contribute no rows and SHALL NOT be treated as an error

#### Scenario: A `connector_id` set exceeding 100 distinct canonical ids is rejected

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with `connector_id` supplied more than 100 times, each canonicalizing to a distinct id
- **THEN** the route SHALL reject the request as a typed invalid request
- **AND** SHALL NOT silently truncate the set or fall back to an unbounded read

#### Scenario: Duplicate `connector_id` values after canonicalization are rejected

- **WHEN** an owner-authenticated request supplies two or more raw `connector_id` values that canonicalize to the same connector id
- **THEN** the route SHALL reject the request as a typed invalid request
- **AND** SHALL NOT silently deduplicate and proceed

#### Scenario: A `connector_id` set cursor rejects a scope mismatch

- **WHEN** a continuation cursor was issued under one `connector_id` set
- **AND** a subsequent request supplies that cursor with an omitted, added, removed, or otherwise different `connector_id` set
- **THEN** the route SHALL reject the request as a typed invalid cursor
- **AND** SHALL NOT resolve the continuation against the mismatched scope

#### Scenario: A `connector_id` set cursor tolerates reordering of the same logical set

- **WHEN** a continuation cursor was issued under one `connector_id` set
- **AND** a subsequent request supplies that cursor with the same distinct canonical ids in a different order
- **THEN** the route SHALL resolve the continuation exactly as if the order had not changed

#### Scenario: The `retained_count_summary` profile returns the pinned Add Source field set

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with `profile=retained_count_summary` (with or without a connection selector or `connector_id` scope)
- **THEN** each returned row SHALL contain exactly `connection_id`, `connector_id`, `connector_instance_id`, `display_name`, `connector_display_name`, `status`, `revoked_at`, `total_records`, `total_records_state`, and `acquisition_coverage`
- **AND** the route SHALL NOT execute a spine-event, browser-surface/runtime, schedule, or run-history read to serve this profile
- **AND** the route SHALL NOT perform a write

#### Scenario: `retained_count_summary` total_records reflects stored evidence, not a re-derived live count

- **WHEN** a connection has a `connector_summary_evidence` row with a current record snapshot
- **THEN** the `retained_count_summary` profile's `total_records` SHALL equal that row's stored canonical count
- **AND** `total_records_state` SHALL be `"known"` when the count is greater than zero, or `"known_zero"` when it is zero

#### Scenario: `retained_count_summary` before the first evidence sweep

- **WHEN** a connection has no `connector_summary_evidence` row yet
- **THEN** the `retained_count_summary` profile SHALL report `total_records: 0` with `total_records_state: "unobserved"`
- **AND** SHALL NOT fall back to a per-connection live record projection to fabricate a count

#### Scenario: `retained_count_summary` acquisition_coverage carries only the latest batch

- **WHEN** a connection has one or more acquisition batches
- **THEN** the `retained_count_summary` profile's `acquisition_coverage.latest_batch` SHALL be the most recently created batch
- **AND** the profile SHALL NOT include the `recent_batches` list the full profile carries

#### Scenario: `retained_count_summary` view model matches the full profile

- **WHEN** the same connection is projected once under `profile=retained_count_summary` and once under the default full profile
- **THEN** every field present in the `retained_count_summary` response SHALL be bit-identical to the corresponding field of the full response for the same observed instant

#### Scenario: `retained_count_summary` pagination does not erase revoked identities

- **WHEN** a `connector_id`-set-scoped page under `profile=retained_count_summary` includes a revoked connection
- **THEN** that connection's row SHALL still be returned, with its actual `status` and `revoked_at` values
- **AND** the route SHALL NOT omit it from the exhausted-traversal result set
