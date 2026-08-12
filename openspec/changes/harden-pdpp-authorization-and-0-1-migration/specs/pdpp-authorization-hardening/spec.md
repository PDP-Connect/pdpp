## MODIFIED Requirements

### Requirement: A separated resource server SHALL resolve complete context from authenticated introspection

The RS SHALL call the AS over authenticated RFC 7662 HTTP using the binding's
configured RS credentials and exact audience. The response SHALL carry the
Source-defined approved authorization through RFC 9396 `authorization_details`.
Supplementary context SHALL carry only binding and lifecycle facts. The RS
SHALL reject missing, unknown, stale, or mismatched mandatory facts before the
route handler and SHALL not perform a second AS lookup.

**Change class:** repairs an existing interoperability and security hole

#### Scenario: A valid response resolves

- **WHEN** the RS receives an authenticated active response with the exact
  audience, unexpired token, matching identity and source facts, and complete
  approved rights
- **THEN** it SHALL resolve one authorization context and enforce from that
  response

#### Scenario: A response with an expired token fails closed

- **WHEN** introspection reports a token past its expiration at the fixed test
  clock
- **THEN** the RS SHALL reject before the route handler with `context.expired`

#### Scenario: A response with an instance mismatch fails closed

- **WHEN** the request instance is not in the approved stream's unique
  `instance_ids`
- **THEN** the RS SHALL reject with `context.instance_mismatch`

#### Scenario: Invalid caller or audience fails closed

- **WHEN** RS introspection credentials are missing or wrong, or `aud` does not
  match the RS
- **THEN** the request SHALL be rejected with `context.authentication_failed`
  or `context.audience_mismatch`

### Requirement: ApprovedAuthorization SHALL consume the Source contract

The resolved authorization SHALL contain exactly `source_id`, `access_mode`,
and `streams`. Each stream SHALL have a unique nonempty `name`, unique
nonempty `instance_ids`, and unique nonempty `fields`. It MAY have
`time_constraint` with a nonempty frozen `field` and at least one bound, and
MAY have unique canonical `resources`. `source.kind` SHALL remain outside
authorization equality, but the binding SHALL reject a kind that does not
match the retained declaration before deriving the resolved authorization.
The granted RFC 9396 detail SHALL also preserve the approved `purpose_code`,
optional `purpose_description`, optional `retention`, and selection
provenance. These policy terms are outside the RS enforcement projection but
remain part of the consent record. JSON Schema dialect ownership remains with
Source. This requirement does not define timestamp or duration value
canonicalization.

**Change class:** repairs an existing interoperability and security hole

#### Scenario: Equivalent validated Source rights are equal

- **WHEN** a persisted grant and approved RAR details contain the same Source
  rights and each has passed metadata matching against the retained declaration
- **THEN** they SHALL produce deeply equal `ApprovedAuthorization` values

#### Scenario: Provenance mismatch is rejected before projection

- **WHEN** a persisted grant or approved RAR detail names a `source.kind` that
  does not match the retained declaration
- **THEN** the binding SHALL reject it before deriving `ApprovedAuthorization`

#### Scenario: The carrier preserves approved policy terms

- **WHEN** the AS narrows and approves an authorization detail
- **THEN** the granted detail SHALL preserve the approved purpose, retention,
  and selection provenance without adding them to RS enforcement equality

#### Scenario: The OAuth binding maps Source validation failure

- **WHEN** Source validation returns `source.authorization_details_invalid`
- **THEN** the OAuth authorization response SHALL return RFC 9396
  `invalid_authorization_details`

#### Scenario: Invalid right-bearing values are rejected

- **WHEN** a stream has empty or duplicate instance IDs or fields, a duplicate
  stream name, malformed bounds, or a changed temporal field
- **THEN** parsing SHALL fail with the corresponding stable `auth.*` code

#### Scenario: Supplementary context does not duplicate rights

- **WHEN** the introspection response is decoded
- **THEN** approved streams, instances, fields, temporal bounds, and resources
  SHALL occur in the Source-defined authorization member only

### Requirement: Authorization-code redemption SHALL be one-use

An authorization code SHALL be consumed atomically with the first successful
redemption. Any later redemption, including one with the same valid PKCE
verifier or same DPoP key, SHALL return `invalid_grant` and SHALL not issue a
second token. Revocation after detected reuse is a separate RFC 6749
SHOULD-strength result unless exact token linkage is implemented and tested.

**Change class:** repairs an existing interoperability and security hole

#### Scenario: Concurrent redemptions have one winner

- **WHEN** two valid requests redeem one code concurrently in PostgreSQL
- **THEN** exactly one succeeds, exactly one returns `invalid_grant`, and one
  token row exists

#### Scenario: A sequential reused code is denied

- **WHEN** a valid code is presented after its first successful redemption
- **THEN** the token endpoint SHALL return `invalid_grant`

### Requirement: Refresh tokens SHALL rotate and detect superseded-generation reuse

The store SHALL retain `family_id`, `generation`, `token_hash`, `status`,
`parent_generation`, `created_at`, and `superseded_at`. A successful use of an
active generation SHALL atomically mark it superseded and insert exactly one
active successor. Family revocation SHALL mark every family row `revoked`.
Reuse of any superseded generation, including a retry after a lost success
response, SHALL revoke the whole family, return
`invalid_grant`, and require fresh authorization. The response SHALL be the
same for all superseded-generation reuse. Every access token issued with or
from the family SHALL persist the family linkage and a token-specific expiry no
more than ten minutes after issuance and no later than the family expiry.
Detected reuse SHALL atomically revoke every family-linked access-token row,
and RFC 7662 introspection SHALL report each one inactive. Refresh tokens SHALL
be issued only for `continuous` grants. A package is eligible only when every
child grant is `continuous`. This follows RFC 9700.

**Change class:** repairs an existing interoperability and security hole

#### Scenario: Concurrent refresh uses have one successor

- **WHEN** two requests use the same active refresh generation concurrently
- **THEN** one rotates successfully and the other revokes the family and
  returns `invalid_grant`
- **AND** no active successor SHALL remain after the detected reuse
- **AND** every access token linked to the family SHALL introspect as inactive

#### Scenario: A lost-response retry is not distinguishable

- **WHEN** the client retries a refresh token after the successful response was
  lost
- **THEN** the superseded generation SHALL trigger family revocation and
  `invalid_grant`, not an idempotent replay response

#### Scenario: Token lifetime fields report persisted truth

- **WHEN** a family-linked access token is issued
- **THEN** `expires_in` SHALL report its actual persisted short lifetime
- **AND** RFC 7662 `exp` SHALL report the same persisted expiration
- **WHEN** an access token has no expiration
- **THEN** the token response SHALL omit `expires_in` and introspection SHALL
  omit `exp`

#### Scenario: Single-use and mixed-mode packages receive no refresh token

- **WHEN** an authorization-code exchange binds a `single_use` grant
- **THEN** the response SHALL omit `refresh_token`
- **WHEN** a package contains any child grant that is not `continuous`
- **THEN** the response SHALL omit `refresh_token`

#### Scenario: Containment failure rolls back atomically

- **WHEN** revoking a family-linked bearer fails during replay containment
- **THEN** neither the refresh-family revocation nor a partial bearer
  revocation SHALL commit
- **WHEN** superseding the active refresh generation fails after bearer
  insertion
- **THEN** the inserted bearer SHALL roll back and the active generation SHALL
  remain usable

#### Scenario: Unlinked legacy refresh state fails closed

- **WHEN** storage migration finds an active or superseded refresh family with
  no persisted family-linked bearer
- **THEN** the migration SHALL NOT guess or reconstruct bearer linkage
- **AND** it SHALL revoke that family and its grant- or package-bound bearer
  rows and require fresh authorization

### Requirement: Successful token responses SHALL prevent intermediary caching

Every successful `/oauth/token` response containing an access token or refresh
token SHALL set `Cache-Control: no-store` and `Pragma: no-cache` before the
response body is serialized. The requirement applies to authorization-code,
refresh-token, and device-code exchanges, including grant and package variants.
Token errors and unsupported grant responses are outside this successful
token-response requirement.

**Change class:** repairs an existing standards and credential-handling hole

#### Scenario: Authorization-code and refresh responses prevent caching

- **WHEN** an authorization-code or refresh-token exchange succeeds for a
  grant or package
- **THEN** the response SHALL include `Cache-Control: no-store` and
  `Pragma: no-cache`

#### Scenario: Device-code responses prevent caching

- **WHEN** a device-code exchange succeeds for an owner or package token
- **THEN** the response SHALL include `Cache-Control: no-store` and
  `Pragma: no-cache`

#### Scenario: Token errors do not masquerade as token successes

- **WHEN** `/oauth/token` returns an OAuth error or unsupported-grant response
- **THEN** the successful token-response requirement SHALL not apply and the
  route SHALL not serialize a token envelope

### Requirement: Pre-v0.1 persisted authorization state SHALL fail closed

The current persisted-grant reader SHALL treat pre-v0.1 authorization-state
bytes as unsupported. It SHALL reject them with
`authorization_state.unsupported_legacy_shape` before introspection or route
handling and SHALL require fresh consent. It SHALL NOT reconstruct
`instance_ids`, issuer, audience, source identity, or any other missing fact
from current configuration. This requirement defines no acceptance flag,
compatibility adapter, alternate context kind, persisted-state inventory,
discovery metadata, or sunset policy.

**Change class:** repairs an existing interoperability and security hole

#### Scenario: Unsupported persisted bytes fail before authorization use

- **WHEN** pre-v0.1 authorization-state bytes reach the current persisted-grant
  reader
- **THEN** the reader SHALL return
  `authorization_state.unsupported_legacy_shape` before introspection or route
  handling
- **AND** the user SHALL be required to complete fresh consent

#### Scenario: Missing facts are not reconstructed

- **WHEN** the unsupported bytes omit facts required by the current contract
- **THEN** the reader SHALL return
  `authorization_state.unsupported_legacy_shape`
- **AND** it SHALL NOT obtain missing facts from current configuration

### Requirement: Post-approval HTML handoff SHALL survive failure and response loss

The HTML consent path SHALL store exchange-code state in the configured
database, not in process memory. The store SHALL retain only a non-reversible
code hash and a reference to `tokens.token_id`, the reference implementation's
existing plaintext bearer authority. It SHALL NOT persist a second plaintext bearer. The first
successful redemption SHALL record its transition atomically. A retry of the
same unexpired code SHALL return the same grant and token result and SHALL NOT
issue another token. An already-committed approval SHALL be resumable so a
failure before handoff delivery can create a fresh bounded exchange code.
Expired and unknown codes SHALL fail closed. JSON approval and OAuth
authorization-code transport SHALL remain unchanged.

**Change class:** repairs an existing durability and credential-delivery hole

#### Scenario: Process failure does not lose an exchange result

- **WHEN** the process restarts after the HTML exchange code is stored and
  before the code is redeemed
- **THEN** the client SHALL redeem the code from the reopened database and
  receive the approved grant and existing token

#### Scenario: A lost redemption response is safely retried

- **WHEN** the first redemption commits but its response is lost
- **THEN** a retry of the same unexpired code SHALL return the same grant and
  token
- **AND** it SHALL NOT issue or persist a second token

#### Scenario: Approval-to-handoff failure is recoverable

- **WHEN** approval is committed but the process fails before a handoff code is
  delivered
- **THEN** retrying that approval SHALL recover the committed grant and token
  and create a new bounded exchange code

#### Scenario: Concurrent redemption converges

- **WHEN** two requests redeem the same valid exchange code concurrently
- **THEN** both SHALL observe the same grant and token result
- **AND** exactly one first-redemption transition SHALL be stored

### Requirement: The seam result SHALL remain bounded and receipt-verifiable

The authoritative execution document is
`design-notes/seam-spike/corpus.md`. It SHALL define exactly seven seam cases
and one durable-handoff case,
fixture paths, stable failure codes, commands, receipt schema, and deterministic
oracles. PostgreSQL SHALL be mandatory for code and `single_use` races. CI
SHALL run the receipt checker. The receipt's relevant-file tree digest SHALL
exclude the receipt itself. Remaining proposed common schemas SHALL remain
undecided.

**Change class:** repairs an existing interoperability and security hole

#### Scenario: The eight cases produce a complete receipt

- **WHEN** the strict target and receipt checker run
- **THEN** all eight case results, the PostgreSQL assertion, the three decision
  keys, and the undecided common-schema result SHALL be present

#### Scenario: Deferred controls are not seam passes

- **WHEN** the receipt reports keyless recovery, security-profile floor, DPoP,
  or other deferred controls
- **THEN** it SHALL mark them deferred or not demonstrated rather than passed

#### Scenario: GNAP remains non-gating

- **WHEN** the pure GNAP map is evaluated
- **THEN** it SHALL round-trip rights and reject unknown mandatory members, but
  SHALL not decide the OAuth/RAR seam or claim GNAP conformance
