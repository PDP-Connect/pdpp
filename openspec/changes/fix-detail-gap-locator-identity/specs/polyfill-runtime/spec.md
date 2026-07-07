## ADDED Requirements

### Requirement: Durable detail-gap identity SHALL be stable across detail-locator schema drift

A durable `connector_detail_gaps` row's identity SHALL be
`(connector_instance_id, grant_id, stream, parent_stream, record_key)` when
`record_key` is present. The `detail_locator_json` SHALL NOT be part of that
identity when a `record_key` is present. When a `record_key` is absent, the
locator SHALL remain the identity disambiguator, namespaced so a locator-only gap
can never collide with a record-key gap.

A re-discovery of the same record under a changed `detail_locator` shape SHALL
re-upsert the same durable row, not create a second row, and SHALL update the
stored `detail_locator_json` to the newer locator shape. Consequently, when that
record is later recovered, the pre-existing pending row SHALL be closed rather
than left as an orphan under a stale locator.

Every nullable identity component (`grant_id`, `parent_stream`, `record_key`)
SHALL be normalized so that a SQL NULL cannot admit a duplicate row under the
identity uniqueness constraint on any storage backend.

#### Scenario: A locator-shape change re-upserts the same identity

- **WHEN** a pending `DETAIL_GAP` exists for record key K with a locator that
  omits a field
- **AND** a later run re-discovers K with a locator that adds that field
- **THEN** the store SHALL resolve both to the same durable row with the same
  `gap_id`
- **AND** exactly one durable row SHALL exist for K
- **AND** that row SHALL store the newer locator shape

#### Scenario: Recovery under a new locator shape closes the old-shape pending row

- **WHEN** a pending `DETAIL_GAP` for record key K was discovered under an
  old-shape locator
- **AND** K is re-discovered and recovered under a new-shape locator
- **THEN** the pre-existing pending row for K SHALL be marked recovered
- **AND** no pending row for K SHALL remain

#### Scenario: A record_key colliding with the locator namespace stays distinct

- **WHEN** one gap has a `record_key` whose literal value begins with the
  locator-fallback prefix
- **AND** another gap has no `record_key` and a locator
- **THEN** the two SHALL have distinct identities

#### Scenario: Without a record_key the locator still disambiguates

- **WHEN** two gaps in the same scope have no `record_key` and different locators
- **THEN** they SHALL have distinct identities

### Requirement: Detail-gap identity migration SHALL reconcile pre-existing locator-drift duplicates

The storage migration SHALL reconcile pre-existing rows that share the new
identity but differ only in `detail_locator_json` BEFORE it builds the
locator-independent identity index. For each such identity group the migration
SHALL keep the most-resolved sibling (a `terminal` or `recovered` row in
preference to a `pending` one) and remove the redundant rows, then build the
unique identity index. The migration SHALL be safe to run over existing duplicate
data and SHALL NOT alter any collected record data.

#### Scenario: Pre-existing duplicate rows collapse to the resolved sibling

- **WHEN** a database holds two `connector_detail_gaps` rows for the same record
  that differ only in `detail_locator_json`: one `pending`, one `recovered`
- **AND** the identity migration runs
- **THEN** the `recovered` row SHALL be kept and the `pending` orphan removed
- **AND** the rebuilt unique identity index SHALL reject a further row for the
  same record under any third locator shape
