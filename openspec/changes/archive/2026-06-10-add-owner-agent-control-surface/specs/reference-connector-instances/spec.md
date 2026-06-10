## ADDED Requirements

### Requirement: Owner control surfaces SHALL expose connection identity before instance operations

Owner-facing and owner-agent-facing control surfaces SHALL expose configured connector instances before they allow instance-scoped operations. A connector type such as `amazon` SHALL NOT be the only owner-visible target when multiple configured bindings can exist for that connector type.

#### Scenario: Owner agent lists connector templates

- **WHEN** an owner agent lists connector templates
- **THEN** each template SHALL be identified as connector-type metadata
- **AND** the response SHALL either include related connection summaries or link to the connection-instance listing

#### Scenario: Owner agent lists connection instances

- **WHEN** an owner agent lists configured connection instances
- **THEN** each instance SHALL include `connection_id`
- **AND** each instance SHALL include its connector type identity
- **AND** each instance SHALL include an owner-meaningful `display_name` or an explicit label-needed state

### Requirement: Connection display names SHALL support owner-meaningful disambiguation

The reference implementation SHALL let the owner or trusted owner agent set a connection `display_name` suitable for disambiguating multiple bindings of the same connector type. Registry URLs or raw connector manifests SHALL NOT be the final SLVP display label for multi-connection owner workflows.

#### Scenario: Display name is only a fallback

- **WHEN** a connection has only a registry URL or connector-type fallback label
- **THEN** owner-agent control surfaces SHALL expose that state as a fallback or label-needed condition
- **AND** they SHALL provide a supported rename action when the connection can be renamed

#### Scenario: Owner labels a second Amazon account

- **WHEN** a trusted owner agent labels one Amazon connection `the owner personal` and another `Shared Amazon`
- **THEN** subsequent connection listings and public read result wrappers SHALL expose the updated labels for their respective `connection_id` values
- **AND** agent guidance SHALL still tell clients to persist `connection_id` rather than `display_name` as the stable selector

### Requirement: Connector lifecycle operations SHALL be instance-scoped when stateful

Stateful connector lifecycle operations such as run now, schedule, pause, resume, revoke, delete, diagnostics, and rename SHALL target `connection_id` when they affect a configured binding. Connector-type operations SHALL be limited to template-level metadata or shall raise typed ambiguity when multiple instances exist.

#### Scenario: Owner agent runs one Amazon connection

- **WHEN** two Amazon connection instances exist
- **AND** a trusted owner agent requests a run for one `connection_id`
- **THEN** the reference implementation SHALL run only the targeted connection instance
- **AND** it SHALL NOT run the other Amazon connection unless explicitly requested

#### Scenario: Connector-only action is ambiguous

- **WHEN** a trusted owner agent requests a stateful action with `connector_id` only
- **AND** multiple connection instances exist for that connector type
- **THEN** the reference implementation SHALL reject the request with a typed ambiguity error
- **AND** it SHALL include available `connection_id` values and owner-meaningful labels
