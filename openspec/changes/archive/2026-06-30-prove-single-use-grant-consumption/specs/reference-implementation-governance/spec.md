# reference-implementation-governance (delta)

## ADDED Requirements

### Requirement: single_use grant consumption MUST be proven at the HTTP boundary

The reference implementation's `single_use` access mode SHALL have an
integration-test proof that operates at the HTTP boundary — not only a test of
token reuse with the already-issued token, but a proof that a **second token
issuance** against a consumed grant is rejected with a typed error code.

The enforcement rule is:

- When a grant whose `access_mode` is `single_use` is used for the first time
  to issue an access token, the grant SHALL be marked `consumed` atomically in
  the same transaction as the token row insertion.
- Any subsequent call to issue an access token for the same grant SHALL be
  rejected with error code `grant_consumed` and MUST NOT produce a second
  access token.
- The atomic consumption check MUST be race-safe: the check (`consumed = 0`)
  and the mark (`consumed = TRUE`) MUST occur in a single serializable
  transaction, so two concurrent issuance calls produce exactly one token and
  one `grant_consumed` rejection.
- A `continuous` grant SHALL NOT be consumed after any number of token
  issuances. Repeated calls to issue tokens against a continuous grant MUST
  succeed as long as the grant is `active` and not revoked.
- An already-issued access token for a `single_use` grant SHALL remain valid
  for RS queries (pagination, retries, resumable reads) until the token expires
  or is explicitly revoked. The consumption flag prevents a second token from
  being issued, not the already-issued token from being used.

The `grant_consumed` error code MUST be surfaced by the HTTP boundary as
`error: "invalid_grant"` with an `error_description` of `"Grant has already
been consumed"` in the token endpoint response.

The doc artifact `grant-design.md` SHALL contain a replayable curl sequence
(PAR request → consent approval → RS query → second token issuance rejection)
so an engineer or standards reviewer can verify the enforcement without reading
source code.

#### Scenario: second token issuance on a consumed single_use grant is rejected

- **GIVEN** a `single_use` grant has been issued and its first access token has
  been issued (the grant is now marked consumed)
- **WHEN** a caller attempts to issue a second access token for the same grant
- **THEN** the operation SHALL fail with error code `grant_consumed`
- **AND** no second token row SHALL be written
- **AND** the original issued token SHALL still be usable for RS queries

#### Scenario: continuous grant allows repeated token issuances

- **GIVEN** a `continuous` grant has been issued and one or more access tokens
  have been issued against it
- **WHEN** a caller issues an additional access token for the same grant
- **THEN** the operation SHALL succeed and return a valid access token
- **AND** the grant's `consumed` flag SHALL remain unset
- **AND** RS queries using the newly issued token SHALL return HTTP 200
