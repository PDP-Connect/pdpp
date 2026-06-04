## ADDED Requirements

### Requirement: Catalog completeness SHALL be independent of connection rows

Reference connector catalog completeness SHALL be satisfied by the registered `connectors` table (the catalog projection of listed first-party manifests) and the add-connection surface alone. The reference SHALL NOT require, and SHALL NOT create, a `connector_instances` row in order to make a listed first-party connector visible in the catalog. Catalog visibility (a connector the owner can add) and connection existence (a configured `connector_instance_id`) are distinct: a connector SHALL be able to appear in the catalog with zero connections. The owner connection projection (`GET /_ref/connectors`, `GET /_ref/connections`) lists configured connections; it SHALL NOT be the mechanism that guarantees catalog completeness, and it SHALL NOT synthesize a connection row to represent a catalog connector.

#### Scenario: Listed connector is catalog-visible with no connection row

- **WHEN** a first-party manifest declares `capabilities.public_listing.listed: true` and the owner has never configured a connection for it
- **THEN** the connector SHALL appear in the connector catalog (the registered `connectors` table projection and the add-connection surface)
- **AND** the reference SHALL NOT have created a `connector_instances` row to achieve that visibility
- **AND** the owner connection projection SHALL NOT list the connector as a connection.

#### Scenario: Catalog projection does not mutate durable connection state

- **WHEN** an owner-facing read enumerates the connector catalog
- **THEN** the read SHALL NOT create or upsert any `connector_instances` row
- **AND** the count of the owner's configured connections SHALL be unchanged by the read.

## MODIFIED Requirements

### Requirement: Reference connector catalog SHALL hide unproven manifests by default

The reference implementation's operator-only addable connector catalog SHALL exclude any connector whose manifest is not explicitly opted in as a public listing. This requirement governs reference/operator catalog behavior and is not part of the PDPP protocol contract. The legacy `GET /_ref/connectors` route is a configured-connection summary projection and SHALL NOT be used as the catalog-completeness mechanism.

#### Scenario: Manifest is explicitly hidden

- **WHEN** a connector manifest declares
  `capabilities.public_listing.listed: false`
- **THEN** the reference addable connector catalog SHALL NOT include that connector.

#### Scenario: Manifest declares unproven status

- **WHEN** a connector manifest declares
  `capabilities.public_listing.status: "unproven"` without
  `listed: true`
- **THEN** the reference addable connector catalog SHALL NOT include that connector.

#### Scenario: Manifest requires a local-device binding without an explicit opt-in

- **WHEN** a connector manifest declares
  `runtime_requirements.bindings.local_device.required: true` and does
  not declare `capabilities.public_listing.listed: true`
- **THEN** the reference addable connector catalog SHALL NOT include that connector, because the provider Docker deployment cannot satisfy the local-device binding.

#### Scenario: Connector ID matches a known reference stub

- **WHEN** a connector ID contains a known reference test stub
  identifier (such as `manual_action_stub`, `manual-action-stub`, or
  `stream-test-stub`)
- **THEN** the reference addable connector catalog SHALL NOT include that connector,
  regardless of manifest contents.

#### Scenario: Manifest is explicitly listed

- **WHEN** a connector manifest declares
  `capabilities.public_listing.listed: true`
- **THEN** the reference addable connector catalog SHALL include that connector, provided the connector ID does not match a known reference stub identifier.

### Requirement: Reference connector catalog SHALL be complete for listed first-party manifests

After the reference implementation's startup `reconcilePolyfillManifests` pass, every first-party manifest under `packages/polyfill-connectors/manifests/` that declares `capabilities.public_listing.listed: true` SHALL be present in the connectors table and SHALL be visible through the reference addable connector catalog, regardless of whether the operator has ever scheduled, run, or connected the connector. Registration through this path is the catalog visibility act; it is NOT schedule enablement and NOT connection creation. Hidden / unproven first-party manifests, manifests outside the shipped first-party set (custom user-authored connectors), and known stub connector IDs SHALL NOT be auto-registered by this path.

#### Scenario: Listed first-party manifest with no prior schedule, run, or connection

- **WHEN** a first-party manifest under
  `packages/polyfill-connectors/manifests/` declares
  `capabilities.public_listing.listed: true`
- **AND** the connectors table contains no row for that manifest's
  `connector_id` (no schedule, no prior run, no connection)
- **THEN** the reference implementation's startup
  `reconcilePolyfillManifests` pass SHALL register the manifest so the
  addable connector catalog includes it
- **AND** that registration SHALL NOT create a `connector_instances` row.

#### Scenario: Hidden first-party manifest with no prior schedule, run, or connection

- **WHEN** a first-party manifest under
  `packages/polyfill-connectors/manifests/` declares
  `capabilities.public_listing.listed: false` (or omits a
  `listed: true` declaration)
- **AND** the connectors table contains no row for that manifest's
  `connector_id`
- **THEN** the reference implementation's startup
  `reconcilePolyfillManifests` pass SHALL NOT register the manifest,
  preserving the hidden-from-catalog state for unproven and
  deprecated-upstream manifests.
