## ADDED Requirements

### Requirement: Fly.io Core deploy target SHALL expose one public Core app with loopback AS/RS listeners

The reference implementation SHALL define a Fly.io Core deploy target that
exposes exactly one internet-reachable Fly app. The app SHALL run the operator
console on Fly's public service port and SHALL keep the Authorization Server and
Resource Server listeners on loopback inside the same app. The composed public
origin SHALL be advertised via `PDPP_REFERENCE_ORIGIN` so the AS issuer and RS
resource equal the public Fly app URL.

The selected Fly deploy target SHALL NOT require a second private reference app
or `*.internal` private-DNS wiring.

#### Scenario: Public Core app fronts the full protocol surface

- **WHEN** the Fly.io Core deploy target is configured
- **THEN** the public origin SHALL serve OAuth authorization-server metadata,
  OAuth protected-resource metadata, OAuth endpoints, the hosted MCP endpoint,
  the `/v1` query API, owner surfaces, and device surfaces
- **AND** AS/RS listeners SHALL remain reachable only on loopback inside the app

#### Scenario: Composed-origin metadata is consistent on the public origin

- **WHEN** an external client reads OAuth metadata from the public Fly origin
- **THEN** the AS `issuer`, the RS `resource`, and the first entry of the RS
  `authorization_servers` SHALL each equal the public Fly app origin
- **AND** browser-facing metadata SHALL NOT expose a loopback or internal
  hostname as a public URL

### Requirement: Fly.io Core deploy target SHALL configure durable Postgres through a database URL

The Fly.io Core deploy target SHALL use Fly Postgres or another
operator-supplied Postgres URL as the storage backend. The runtime SHALL select
Postgres when `PDPP_DATABASE_URL` is present. If `PDPP_DATABASE_URL` is absent,
the runtime SHALL select Postgres when the platform-standard `DATABASE_URL` is
present. `PDPP_DATABASE_URL` SHALL take precedence when both variables are set.

The non-durable in-memory SQLite default SHALL NOT be the configured backend for
the Fly Core deploy target.

#### Scenario: Fly launch database URL selects Postgres

- **WHEN** Fly provisions Postgres and injects `DATABASE_URL`
- **AND** `PDPP_DATABASE_URL` is absent
- **THEN** the runtime SHALL select Postgres using `DATABASE_URL`
- **AND** the schema SHALL bootstrap idempotently at boot without a separate
  migrate step

#### Scenario: Explicit PDPP database URL wins

- **WHEN** both `PDPP_DATABASE_URL` and `DATABASE_URL` are set
- **THEN** the runtime SHALL use `PDPP_DATABASE_URL`

#### Scenario: Non-durable storage is forbidden

- **WHEN** the Fly.io Core deploy target is configured
- **THEN** the deploy preflight SHALL reject a configuration without either
  `PDPP_DATABASE_URL` or `DATABASE_URL`

### Requirement: Fly.io Core deploy target SHALL gate owner data and enforce HTTPS

The Fly.io Core deploy target SHALL require a non-empty `PDPP_OWNER_PASSWORD`
and SHALL configure `force_https = true` on the app's `[http_service]` so the
platform redirects HTTP to HTTPS and owner-session cookies are marked `Secure`.
An unauthenticated request to the owner console SHALL redirect to the owner login
surface.

#### Scenario: Owner console is gated on the public origin

- **WHEN** an anonymous request hits the owner console on the public Fly origin
  with `PDPP_OWNER_PASSWORD` configured
- **THEN** the request SHALL redirect to the owner login surface
- **AND** live owner data SHALL NOT be served without a valid owner session

#### Scenario: HTTPS is enforced by the platform

- **WHEN** the app is deployed with `force_https = true` in its `[http_service]`
  block
- **THEN** HTTP requests SHALL be redirected to HTTPS
- **AND** owner-session and CSRF cookies SHALL be marked `Secure`

### Requirement: Fly.io Core deploy target SHALL define an executable first-live-test gate

The Fly.io Core deploy target SHALL define a reproducible first-live-test gate:
service health via the platform healthcheck path, composed-origin smoke
assertions, owner-gating redirect, storage persistence across restart, and an
MCP reachability check with anonymous refusal and scoped success. The gate SHALL
be runnable against a local composed-origin stack before any live Fly run is
requested.

#### Scenario: Health and diagnostics are reachable on the public origin

- **WHEN** the Fly.io deployed app is healthy
- **THEN** `GET /.well-known/oauth-authorization-server` SHALL return HTTP 200
  from the public origin
- **AND** owner-gated diagnostics SHALL report deploy facts to the owner

#### Scenario: MCP refuses anonymous access and serves a scoped grant

- **WHEN** a client calls the hosted MCP endpoint on the public Fly origin
- **THEN** an anonymous call SHALL be refused
- **AND** a call carrying a valid scoped grant SHALL complete `tools/list` and
  return a scoped record query result

### Requirement: Fly.io Core deploy target SHALL provide an honest shareable CLI path

The reference implementation SHALL provide Fly.io deploy artifacts sufficient
for an operator to reproduce the Core node from a clean Fly account using a
documented Fly CLI command. The command SHALL NOT require the maintainer's Fly
token and SHALL NOT require private registry credentials.

The deploy artifacts SHALL document honestly that a Railway-style published
Template button is not available for this Fly deploy target. The documentation
SHALL NOT present a placeholder button URL as a live deploy button.

#### Scenario: Operator path is reproducible from the Fly CLI

- **WHEN** an operator follows the documented Fly.io deploy runbook from a clean
  Fly account
- **THEN** the documented command SHALL be sufficient to deploy the Core node
  without the maintainer's credentials
- **AND** no undocumented manual step SHALL be required between documented
  commands

#### Scenario: Pushbutton assessment is honest

- **WHEN** the Fly.io deploy documentation describes the operator path
- **THEN** it SHALL NOT present a placeholder button URL as a live deploy button
- **AND** if no live one-click link exists, the documentation SHALL say so
  explicitly
