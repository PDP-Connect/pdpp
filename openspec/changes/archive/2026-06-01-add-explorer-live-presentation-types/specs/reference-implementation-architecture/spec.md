## ADDED Requirements

### Requirement: Flagship first-party manifests SHALL declare presentation types for the typed-card pilot

The reference implementation SHALL declare an optional presentation `type` (via the `schema.properties[field].x_pdpp_type` extension already read by the resource server) on the small set of fields the Explorer dispatches record cards from, for the flagship first-party connectors selected for the typed-card pilot. The initial pilot connectors are `chase` (the `transactions` stream, dispatching a money card) and `gmail` (the `messages` stream, dispatching a message card). The declaration is additive and presentation-only: it SHALL NOT alter exact-filter, range-filter, lexical/semantic participation, aggregation, grant usability, or retrieval semantics for the declared field, and a manifest field without a declared `type` SHALL continue to surface no `type` key and fall back to the Explorer heuristic. This requirement makes the already-accepted typed-card dispatch path live on real connector data; it does not introduce a new contract field.

#### Scenario: A flagship money stream declares a currency-typed amount field

- **WHEN** the `chase` `transactions` stream manifest is read through `GET /v1/streams/transactions`
- **THEN** the `amount` field's `field_capabilities` entry SHALL carry a declared `type` of `currency`
- **AND** the stream's other declared presentation types SHALL name a `timestamp` field (the transaction date) and a `text` field (the merchant/payee display name)
- **AND** the surfaced declared types SHALL dispatch a `money` record card through the Explorer's declared-type-preferred classification

#### Scenario: A flagship message stream declares a person-and-text-typed field set

- **WHEN** the `gmail` `messages` stream manifest is read through `GET /v1/streams/messages`
- **THEN** the `from_name` field's `field_capabilities` entry SHALL carry a declared `type` of `person`
- **AND** the stream SHALL declare at least one `text`-typed field (the subject or snippet) and a `timestamp`-typed field (the message date)
- **AND** the surfaced declared types SHALL dispatch a `message` record card through the Explorer's declared-type-preferred classification

#### Scenario: A declared presentation type changes no other capability

- **WHEN** a pilot field declares a presentation `type`
- **THEN** its exact-filter, range-filter, lexical-search, semantic-search, aggregation, and grant-usability flags SHALL be identical to those it carried before the declaration
- **AND** a field in the same stream that does not declare a presentation `type` SHALL surface no `type` key and SHALL fall back to the Explorer's presentation-only heuristic

#### Scenario: A field that does not match its stream's card is not coerced

- **WHEN** a pilot stream carries a field whose value is not the presentation type of the card the stream dispatches (for example the ISO currency-code field on a money stream)
- **THEN** the manifest SHALL NOT declare a presentation `type` that misrepresents the field
- **AND** the declared types on the stream SHALL assert only the field shapes the card actually renders
