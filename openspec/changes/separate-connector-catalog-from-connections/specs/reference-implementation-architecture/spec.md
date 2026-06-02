## ADDED Requirements

### Requirement: Catalog completeness SHALL be independent of connection rows

Reference connector catalog completeness SHALL be satisfied by the `connectors` table and the `GET /_ref/connectors` projection alone. The reference SHALL NOT require, and SHALL NOT create, a `connector_instances` row in order to make a listed first-party connector visible in the catalog. Catalog visibility (a connector the owner can add) and connection existence (a configured `connector_instance_id`) are distinct: a connector SHALL be able to appear in the catalog with zero connections.

#### Scenario: Listed connector is catalog-visible with no connection row

- **WHEN** a first-party manifest declares `capabilities.public_listing.listed: true` and the owner has never configured a connection for it
- **THEN** the connector SHALL appear in the catalog via `GET /_ref/connectors`
- **AND** the reference SHALL NOT have created a `connector_instances` row to achieve that visibility.

#### Scenario: Catalog projection does not mutate durable connection state

- **WHEN** an owner-facing read enumerates the connector catalog
- **THEN** the read SHALL NOT create or upsert any `connector_instances` row
- **AND** the count of the owner's configured connections SHALL be unchanged by the read.
