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
