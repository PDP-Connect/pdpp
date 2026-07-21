## ADDED Requirements

### Requirement: Client-token introspection SHALL fail closed on unexpected faults

When `POST /introspect` resolves a client bearer (`pdpp_token_kind === 'client'`),
the reference SHALL validate the persisted grant against its bound manifest. A
genuine semantic grant-invalidity SHALL project the token as
`{ active: false, inactive_reason: 'grant_invalid' }`. Any OTHER error encountered
while resolving or validating the manifest — for example a manifest-store outage
or a database fault — SHALL propagate rather than be swallowed. Introspection
SHALL NOT project a token as `active: true` when the grant could not be validated
because of such an unexpected fault; it fails closed by surfacing the error to the
caller.

A grant bound to a connector that is not registered (the bound manifest resolves
to nothing) SHALL NOT by itself make the token inactive at introspection; that
condition is surfaced connector-first on the read path as `not_found`, and this
requirement does not move that failure earlier.

#### Scenario: An unexpected manifest-store fault occurs during introspection

- **WHEN** `POST /introspect` is called for an otherwise-active client bearer, but
  resolving or validating the grant's manifest raises an unexpected error (for
  example the manifest store is unavailable)
- **THEN** introspection SHALL NOT return `active: true`
- **AND** the error SHALL propagate to the caller rather than be masked as a clean
  inactive projection

#### Scenario: A persisted grant is semantically invalid

- **WHEN** `POST /introspect` is called for a client bearer whose persisted grant
  fails semantic validation against its manifest (a `grant_invalid` condition)
- **THEN** introspection SHALL return `{ active: false, inactive_reason: 'grant_invalid' }`

#### Scenario: A grant is bound to an unregistered connector

- **WHEN** `POST /introspect` is called for a client bearer whose grant is bound to
  a connector that is not registered (its manifest resolves to nothing)
- **THEN** introspection SHALL NOT fail closed solely on that basis
- **AND** the unregistered-connector condition SHALL instead be surfaced
  connector-first on the read path as `not_found`
