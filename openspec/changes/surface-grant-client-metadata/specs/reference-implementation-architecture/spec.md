# reference-implementation-architecture — surface-grant-client-metadata delta

## MODIFIED Requirements

### Requirement: Reference-only surfaces are explicit

Debugging, replay, trace, and operator-control surfaces that are useful for the reference implementation but are not part of core PDPP SHALL be explicitly marked as reference-only.

For grant correlation summaries returned by `GET /_ref/grants` and trace correlation summaries returned by `GET /_ref/traces`, the reference MAY include an optional `client` object when the summary's `client_id` resolves to a registered OAuth client row. The `client` object SHALL include the registered `client_id`, MAY include the registered `client_name`, and MAY include the registration mode. The presence of `client.client_name` SHALL NOT replace `client_id` as the identity anchor; operator-console consumers SHALL treat it as display metadata and preserve raw `client_id` identity where the row has an identity slot.

#### Scenario: Reference summary includes registered client metadata

- **WHEN** an owner requests `GET /_ref/grants` or `GET /_ref/traces`
- **AND** a returned grant or trace summary has a `client_id` that resolves to a registered OAuth client row with `client_name`
- **THEN** that summary MAY include `client.client_name`
- **AND** `client.client_id` SHALL equal the top-level `client_id`
- **AND** the top-level `client_id` SHALL remain present.

#### Scenario: Reference summary lacks registered client metadata

- **WHEN** an owner requests `GET /_ref/grants` or `GET /_ref/traces`
- **AND** a returned grant or trace summary has no matching registered OAuth client row
- **THEN** the reference SHALL still return the summary with its top-level `client_id`
- **AND** SHALL omit the optional `client` object rather than inventing a display name.

#### Scenario: Run summaries do not inherit client display metadata

- **WHEN** an owner requests `GET /_ref/runs`
- **AND** a returned run summary has a `client_id`
- **THEN** the run summary SHALL NOT include a `client` display-metadata object unless a separate run-summary contract explicitly defines it.
