## ADDED Requirements

### Requirement: The reference's hosted consent-approval HTML SHALL NOT embed a live client bearer

When `POST /consent/approve` produces an HTML response (the human-hosted owner-approval surface), the response body, response headers, and any embedded scripts or attributes SHALL NOT contain the bearer string the AS just issued for that approval.

The HTML response SHALL instead embed an opaque single-use **consent exchange code** scoped to the freshly issued grant. The code SHALL be redeemable for the bearer exactly once at the reference-only redemption endpoint defined below.

The JSON branch of `POST /consent/approve` is not affected by this requirement and SHALL continue to return `{ grant_id, token, grant }` directly. The exchange code SHALL only be minted on the HTML branch.

#### Scenario: A human approves consent in the browser

- **WHEN** a browser submits `POST /consent/approve` for a pending consent request and the AS would have rendered the HTML success page
- **THEN** the response body SHALL NOT contain the bearer string the AS just issued for the resulting grant
- **AND** the response body SHALL contain an opaque consent exchange code prefixed `cex_`
- **AND** the response SHALL display the resulting `grant_id`

#### Scenario: A test harness or programmatic client approves with JSON

- **WHEN** a caller submits `POST /consent/approve` with `Content-Type: application/json` (or otherwise negotiates JSON)
- **THEN** the response SHALL be JSON of shape `{ grant_id, token, grant }` with the bearer in the `token` field
- **AND** the JSON response SHALL NOT include a consent exchange code

### Requirement: The reference SHALL expose a single-use consent-code redemption endpoint

The reference SHALL expose `POST /consent/exchange` as a reference-only redemption endpoint.

The endpoint SHALL accept `{ code }` in the request body, look up the in-memory consent-exchange entry, and on the first successful redemption SHALL return `{ grant_id, token, grant }` with the same shape as the JSON branch of `POST /consent/approve`.

The endpoint SHALL NOT require additional authentication beyond possession of the code; possession of a freshly minted single-use code is the only authority required to redeem the bearer the AS just issued for that consent request.

The endpoint SHALL enforce single-use semantics: after a successful redemption the code SHALL be invalidated and any subsequent redemption attempt SHALL fail. The endpoint SHALL also enforce a short TTL (default 5 minutes); a redemption attempt against an expired code SHALL fail.

Failure responses SHALL be PDPP error envelopes and SHALL NOT include the bearer string.

#### Scenario: Redeeming a freshly issued code

- **WHEN** a caller submits `POST /consent/exchange` with a `code` that was just minted by an HTML `POST /consent/approve`
- **THEN** the response status SHALL be `200`
- **AND** the response body SHALL be `{ grant_id, token, grant }` describing the same grant the approval issued
- **AND** the returned `token` SHALL be a valid client bearer for that grant (i.e. introspection SHALL return `active: true` for it)

#### Scenario: Replaying a consumed code

- **WHEN** a caller submits `POST /consent/exchange` with a `code` that was already redeemed once
- **THEN** the response status SHALL be a 4xx PDPP error envelope
- **AND** the response body SHALL NOT contain the bearer string of the originally issued grant

#### Scenario: Redeeming an expired code

- **WHEN** a caller submits `POST /consent/exchange` with a `code` whose TTL has elapsed
- **THEN** the response status SHALL be a 4xx PDPP error envelope
- **AND** the response body SHALL NOT contain the bearer string of the originally issued grant

#### Scenario: Redeeming an unknown code

- **WHEN** a caller submits `POST /consent/exchange` with a `code` the AS never issued
- **THEN** the response status SHALL be a 4xx PDPP error envelope
