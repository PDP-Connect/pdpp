## ADDED Requirements

### Requirement: Manifest reconciliation MUST invalidate records on the reference-fixture → polyfill transition and MUST preserve records on every other manifest diff

When the reference performs polyfill manifest reconciliation at startup and observes that a connector's persisted manifest's `(version, sorted-stream-names)` fingerprint matches the on-disk reference-fixture manifest fingerprint for that same `connector_id`, AND the shipped polyfill manifest fingerprint is different, the reference SHALL invalidate every record previously persisted for that connector before re-registering the new manifest. Invalidation SHALL remove records, change history, version counters, blob bindings, and lexical and semantic index entries for the affected connector, and SHALL be logged per connector with the deleted record count.

When reconciliation observes a structural manifest diff that is NOT this reference-fixture → polyfill transition (for example: a polyfill manifest evolves with new `query.search.semantic_fields`, a description revision, a schema addition, a polyfill-only connector version bump, or a connector with no reference-fixture collision), the reference SHALL re-register the new manifest and SHALL NOT invalidate any records.

#### Scenario: A seeded reference fixture is replaced by the shipped polyfill manifest at boot
- **WHEN** the reference starts with a database whose persisted manifest fingerprint matches the on-disk reference-fixture fingerprint for a given `connector_id`, and the shipped polyfill manifest fingerprint for that same `connector_id` is different
- **THEN** reconciliation SHALL delete every record persisted under that `connector_id` before the new manifest is registered
- **AND** the dashboard, search endpoints, and dataset summary SHALL NOT advertise any prior-shape record as fresh data after reconciliation completes

#### Scenario: An ordinary polyfill manifest evolution is reconciled
- **WHEN** the persisted manifest is the prior polyfill version for a given `connector_id` and the shipped polyfill manifest differs only in details such as added `semantic_fields`, a copy revision, an added stream view, or a polyfill version bump with the same stream set
- **THEN** reconciliation SHALL re-register the new manifest
- **AND** SHALL NOT delete any records for that `connector_id`

#### Scenario: A polyfill-only connector with no reference-fixture collision is reconciled
- **WHEN** a connector's `connector_id` has no corresponding manifest under `reference-implementation/manifests/`, and the shipped polyfill manifest differs from the persisted manifest
- **THEN** reconciliation SHALL re-register the new manifest
- **AND** SHALL NOT delete any records for that `connector_id`

#### Scenario: The persisted manifest already matches the shipped polyfill manifest
- **WHEN** the persisted manifest for a `connector_id` is structurally equal to the shipped polyfill manifest at boot
- **THEN** reconciliation SHALL NOT invalidate any records for that `connector_id`

#### Scenario: A connector is registered for the first time at boot
- **WHEN** the persisted database contains no manifest row for a `connector_id` that the shipped polyfill manifests cover
- **THEN** reconciliation SHALL NOT invalidate records (there are none) and SHALL NOT auto-register the connector either

#### Scenario: A direct registerConnector call updates an existing manifest
- **WHEN** an operator or test calls `registerConnector` with a manifest that differs from the persisted manifest, outside the reconciliation loop
- **THEN** records SHALL NOT be deleted as a side effect of the registration call

#### Scenario: Reconciliation invalidation is observable
- **WHEN** reconciliation invalidates records for a connector via the reference-fixture → polyfill transition
- **THEN** it SHALL emit a log line that names the connector id and the number of records deleted, so the operator can audit which prior-shape data was discarded
