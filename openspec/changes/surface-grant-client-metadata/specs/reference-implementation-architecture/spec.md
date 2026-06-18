# reference-implementation-architecture — surface-grant-client-metadata delta

## MODIFIED Requirements

### Requirement: Reference-only surfaces are explicit

Debugging, replay, trace, and operator-control surfaces that are useful for the reference implementation but are not part of core PDPP SHALL be explicitly marked as reference-only.

For grant correlation summaries returned by `GET /_ref/grants`, the reference MAY include an optional `client` object when the grant's `client_id` resolves to a registered OAuth client row. The `client` object SHALL include the registered `client_id`, MAY include the registered `client_name`, and MAY include the registration mode. The presence of `client.client_name` SHALL NOT replace `client_id` as the identity anchor; operator-console consumers SHALL treat it as display metadata and preserve the raw `client_id` in the owner-facing relationship view.

#### Scenario: Grant summary includes registered client metadata

- **WHEN** an owner requests `GET /_ref/grants`
- **AND** a returned grant summary has a `client_id` that resolves to a registered OAuth client row with `client_name`
- **THEN** that grant summary MAY include `client.client_name`
- **AND** `client.client_id` SHALL equal the top-level `client_id`
- **AND** the top-level `client_id` SHALL remain present.

#### Scenario: Grant summary lacks registered client metadata

- **WHEN** an owner requests `GET /_ref/grants`
- **AND** a returned grant summary has no matching registered OAuth client row
- **THEN** the reference SHALL still return the grant summary with its top-level `client_id`
- **AND** SHALL omit the optional `client` object rather than inventing a display name.
