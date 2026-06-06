## ADDED Requirements

### Requirement: Fly.io Core deploy target SHALL expose exactly one public origin and keep the reference app private

The reference implementation SHALL define a Fly.io Core deploy target that
exposes exactly one internet-reachable origin (the console Fly app) and keeps
the Authorization Server and Resource Server listeners reachable only over Fly's
private WireGuard network. The public console app SHALL proxy the full protocol
surface — OAuth metadata, OAuth endpoints, the hosted MCP endpoint, the `/v1`
query API, owner and device surfaces — to the private reference app using
`PDPP_AS_URL` and `PDPP_RS_URL` set to `*.internal` hostnames on the private
network. The composed public origin SHALL be advertised via `PDPP_REFERENCE_ORIGIN`
so the AS issuer and RS resource equal the public console app URL.

The reference Fly app SHALL have no public `[http_service]` or `[[services]]`
block. The AS `7662` and RS `7663` listeners SHALL NOT be published as separate
public Fly app origins for this deploy target. Browser-facing metadata served
through the public origin SHALL advertise the public origin and SHALL NOT leak an
internal `.internal` hostname as a browser-facing URL.

#### Scenario: Public console app fronts the full protocol surface

- **WHEN** the Fly.io Core deploy target is configured with one public console
  app and a private reference app
- **THEN** the public origin SHALL serve OAuth authorization-server metadata,
  OAuth protected-resource metadata, the OAuth endpoints, the hosted MCP
  endpoint, and the `/v1` query API by proxying to the private reference app
- **AND** the reference app SHALL have no public service block and SHALL be
  reachable only over the Fly private WireGuard network

#### Scenario: Composed-origin metadata is consistent on the public origin

- **WHEN** an external client reads OAuth metadata from the public Fly origin
- **THEN** the AS `issuer`, the RS `resource`, and the first entry of the RS
  `authorization_servers` SHALL each equal the public console app origin
- **AND** no `.internal` hostname SHALL appear as a browser-facing URL in that
  metadata

#### Scenario: Private network addresses use Fly internal DNS

- **WHEN** the console app routes requests to the reference app
- **THEN** `PDPP_AS_URL` SHALL use a `*.internal` hostname resolvable over the
  Fly private WireGuard network
- **AND** `PDPP_RS_URL` SHALL use a `*.internal` hostname resolvable over the
  Fly private WireGuard network
- **AND** neither value SHALL be a public URL or `localhost`

### Requirement: Fly.io Core deploy target SHALL configure durable Postgres explicitly

The Fly.io Core deploy target SHALL use a Fly Postgres cluster (created via
`fly postgres create` and attached via `fly postgres attach`) or another
operator-supplied Postgres URL as the storage backend. The `PDPP_DATABASE_URL`
environment variable SHALL be set to the Postgres connection string; the runtime
selects Postgres when this variable is present, bootstraps the schema
idempotently at boot with no separate migrate step, and requires no volume. The
non-durable in-memory SQLite default SHALL NOT be the configured backend.

#### Scenario: Fly Postgres is the default storage path

- **WHEN** the Fly.io Core deploy target is configured with `fly postgres attach`
- **THEN** `PDPP_DATABASE_URL` SHALL be set to the Postgres connection string
- **AND** the schema SHALL bootstrap idempotently at boot without a separate
  migrate step
- **AND** a restart SHALL re-run the idempotent bootstrap without data loss

#### Scenario: Non-durable storage is forbidden

- **WHEN** the Fly.io Core deploy target is configured
- **THEN** the in-memory SQLite default SHALL NOT be the configured storage
  backend
- **AND** the deploy preflight SHALL reject a configuration without
  `PDPP_DATABASE_URL`

### Requirement: Fly.io Core deploy target SHALL gate owner data and enforce HTTPS

The Fly.io Core deploy target SHALL require a non-empty `PDPP_OWNER_PASSWORD`
and SHALL configure `force_https = true` on the console app's `[http_service]`
so the platform redirects HTTP to HTTPS and owner-session cookies are marked
`Secure`. An unauthenticated request to the owner console SHALL redirect to
the owner login surface.

#### Scenario: Owner console is gated on the public origin

- **WHEN** an anonymous request hits the owner console on the public Fly origin
  with `PDPP_OWNER_PASSWORD` configured
- **THEN** the request SHALL redirect to the owner login surface
- **AND** live owner data SHALL NOT be served without a valid owner session

#### Scenario: HTTPS is enforced by the platform

- **WHEN** the console app is deployed with `force_https = true` in its
  `[http_service]` block
- **THEN** HTTP requests SHALL be redirected to HTTPS
- **AND** owner-session and CSRF cookies SHALL be marked `Secure`

### Requirement: Fly.io Core deploy target SHALL define an executable first-live-test gate

The Fly.io Core deploy target SHALL define a reproducible first-live-test gate
equivalent to the Railway gate: service health via the platform healthcheck path,
composed-origin smoke assertions, owner-gating redirect, storage persistence
across restart, and an MCP reachability check (anonymous refusal, scoped
success). The gate SHALL be runnable against a local composed-origin stack before
any live Fly run is requested. The existing `pnpm docker:smoke` and
`pnpm railway:mcp-query-smoke` harnesses are platform-neutral and serve as the
local proxy; no Fly-specific runtime change is required.

#### Scenario: Health and diagnostics are reachable on the public origin

- **WHEN** the Fly.io deployed service is healthy
- **THEN** `GET /.well-known/oauth-authorization-server` SHALL return HTTP 200
  from the public console app
- **AND** `GET /_ref/deployment` SHALL report deploy facts to the owner

#### Scenario: MCP refuses anonymous access and serves a scoped grant

- **WHEN** a client calls the hosted MCP endpoint on the public Fly origin
- **THEN** an anonymous call SHALL be refused
- **AND** a call carrying a valid scoped grant SHALL complete `tools/list` and
  return a scoped record query result

### Requirement: Fly.io Core deploy target SHALL provide a scripted operator path and an honest pushbutton assessment

The reference implementation SHALL provide Fly.io deploy artifacts sufficient
for an operator to reproduce the Core node from a clean Fly account using the
Fly CLI (`fly launch`, `fly postgres create`, `fly postgres attach`,
`fly deploy`). The operator path SHALL NOT require a live Fly token from the
maintainer, SHALL NOT require private registry credentials, and SHALL work from
either public GHCR images or a source clone.

The deploy artifacts SHALL document honestly that a one-click "Launch on Fly"
button equivalent to Railway's Template is not available as a first-class Fly
feature as of the change date, and SHALL NOT present a placeholder URL as a live
deploy button. A placeholder button with a clear "not yet live" annotation MAY be
included to mark the intended future state.

#### Scenario: Operator path is reproducible from the Fly CLI

- **WHEN** an operator follows the documented Fly.io deploy runbook from a clean
  Fly account
- **THEN** the documented commands SHALL be sufficient to deploy the Core node
  without the maintainer's credentials
- **AND** the deploy SHALL use public GHCR images or a source clone as the
  service source
- **AND** no undocumented manual step SHALL be required between the documented
  commands

#### Scenario: Pushbutton assessment is honest

- **WHEN** the Fly.io deploy documentation describes the operator path
- **THEN** it SHALL NOT present a placeholder button URL as a live deploy button
- **AND** if no live one-click path exists, the documentation SHALL say so
  explicitly and SHALL document what a future slice would need to enable it
