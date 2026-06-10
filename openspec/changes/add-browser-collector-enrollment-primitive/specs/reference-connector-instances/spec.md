## ADDED Requirements

### Requirement: Connector-instance source bindings SHALL distinguish browser collection from filesystem collection

The reference connector-instance source binding SHALL support `browser_collector`
as a source kind distinct from `local_device`. A `browser_collector` binding
SHALL identify a connector instance collected by a local collector that drives a
browser session for a browser-bound connector. A `local_device` binding SHALL
continue to identify a filesystem-read local collection. This source kind is the
connector-instance source-binding axis only; it is not the spine event source
kind, and it is not promoted into PDPP Core protocol vocabulary.

#### Scenario: Browser-collected and filesystem-collected bindings stay distinct

- **WHEN** the reference enrolls one connector instance as `browser_collector` and another, for a different connector, as `local_device`
- **THEN** each instance SHALL record its own source kind on its source binding
- **AND** the source kind SHALL be available to owner-facing diagnostics so a browser-session expiry is distinguishable from a device-unreachable condition

#### Scenario: A second browser-bound account is a distinct instance

- **WHEN** an owner enrolls two browser-collector bindings for the same browser-bound connector type, such as two Amazon accounts
- **THEN** both bindings MAY share the same `connector_id`
- **AND** each SHALL resolve to a distinct `connector_instance_id` with its own state, schedules, active-run lease, diagnostics, and idempotency namespace
- **AND** one account's records SHALL NOT overwrite, deduplicate, or advance freshness for the other unless an explicit approved cross-instance identity rule applies

#### Scenario: Browser-collector source kind is not the spine source kind

- **WHEN** the reference records a `browser_collector` connector-instance source binding
- **THEN** it SHALL NOT change the spine event source-kind vocabulary
- **AND** the `browser_collector` value SHALL apply to the connector-instance source binding only
