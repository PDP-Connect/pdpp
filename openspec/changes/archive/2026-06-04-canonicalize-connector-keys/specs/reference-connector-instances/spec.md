## MODIFIED Requirements

### Requirement: Connector instances SHALL be the durable configured-binding identity

The reference implementation SHALL distinguish connector type identity from configured connector instance identity. `connector_key` SHALL identify the connector implementation type by canonical short key. `manifest_uri` SHALL identify the registry or document URI for the connector manifest when such a URI exists. `connector_instance_id` SHALL remain the technical storage/runtime identity for one owner-approved configured binding for that connector type, such as one account authorization or one enrolled-device local binding.

#### Scenario: Two Gmail accounts use the same connector type

- **WHEN** an owner configures two Gmail accounts
- **THEN** both configured bindings SHALL share the canonical `connector_key` for Gmail
- **AND** each binding SHALL have a distinct `connector_instance_id`
- **AND** runtime state, records, schedules, active-run leases, diagnostics, and owner actions SHALL target the intended connector instance.

#### Scenario: Two devices collect the same local connector

- **WHEN** two enrolled devices collect Claude Code or Codex data for the same owner
- **THEN** both collectors SHALL use the canonical `connector_key` for that connector type
- **AND** each authorized device/local-binding pair SHALL resolve to a distinct connector instance before collection writes are accepted.

#### Scenario: Connector manifest has registry provenance

- **WHEN** a first-party connector manifest is registered
- **THEN** the reference SHALL persist its canonical `connector_key` as the active connector type key
- **AND** it SHALL preserve the manifest registry URI as `manifest_uri` metadata rather than using the URI as the active connector key.

## ADDED Requirements

### Requirement: Connector keys SHALL be canonical operational identifiers

The reference implementation SHALL use one canonical operational key for each connector type. Active storage, runtime, grant, consent, local-collector, owner dashboard, and MCP surfaces SHALL NOT require URL-shaped connector ids or stale local alias ids to address a connector type.

#### Scenario: Active surface receives a URL-shaped connector id

- **WHEN** a post-migration owner, client, MCP, local-collector, or runtime request uses a URL-shaped connector id where a connector key is required
- **THEN** the reference SHALL reject the request with a typed error naming `connector_key`
- **AND** it SHALL NOT silently normalize the URL through a long-lived alias.

#### Scenario: Custom connector is registered

- **WHEN** an operator registers a custom connector manifest
- **THEN** the manifest SHALL declare a locally unique `connector_key`
- **AND** any registry/document URL SHALL be stored as `manifest_uri` metadata.

### Requirement: Connector key migration SHALL preserve configured connections

The reference implementation SHALL provide a one-time migration from URL-shaped connector ids and stale local aliases to canonical connector keys without changing the configured connection identity.

#### Scenario: Existing records use a URL-shaped connector id

- **WHEN** migration runs on a deployment with retained records, record history, blobs, search rows, grants, schedules, state, runs, diagnostics, or event subscriptions keyed by a URL-shaped first-party connector id
- **THEN** the migration SHALL rewrite those references to the canonical connector key
- **AND** the corresponding `connector_instance_id`, `connection_id`, record keys, stream names, grant ids, package ids, and audit events SHALL remain stable.

#### Scenario: Stale alias has no retained data

- **WHEN** migration finds a stale alias connector instance with no retained records, no active grant, no schedule, no state, and no active subscription
- **THEN** the migration SHALL remove or quarantine that alias so it is not visible as an owner-selectable connection.

#### Scenario: Alias mapping is ambiguous

- **WHEN** migration cannot map a connector id or alias to one canonical connector key without risking data loss
- **THEN** the migration SHALL stop with an explicit diagnostic
- **AND** it SHALL NOT merge, delete, or rewrite the ambiguous rows automatically.
