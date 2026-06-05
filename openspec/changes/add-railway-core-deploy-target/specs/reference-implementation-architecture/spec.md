## ADDED Requirements

### Requirement: Managed-platform Core deploy target SHALL expose exactly one public origin

The reference implementation SHALL define a managed-platform Core deploy target
that exposes exactly one internet-reachable origin and keeps the Authorization
Server and Resource Server listeners private. The single public origin SHALL be
the operator console service, which fronts the full protocol surface — OAuth
metadata, OAuth endpoints, the hosted MCP endpoint, the `/v1` query API, owner
and device surfaces — by proxying to the internal AS and RS using the existing
`PDPP_AS_URL` and `PDPP_RS_URL` internal targets, while the public origin is
advertised through composed mode via `PDPP_REFERENCE_ORIGIN` (or
`AS_PUBLIC_URL` / `RS_PUBLIC_URL`).

The AS `7662` and RS `7663` listeners SHALL NOT be published as separate public
origins for this deploy target. The reference service SHALL be reachable only
over the platform's private network, and the public origin SHALL terminate TLS
with the forwarded protocol trusted so that browser-facing metadata, owner
sessions, and CSRF protection bind to the public HTTPS origin.

Browser-facing metadata served through the public origin SHALL advertise the
public origin and SHALL NOT leak an internal service name as a browser-facing
URL.

#### Scenario: Public origin fronts the full protocol surface

- **WHEN** the managed-platform Core deploy target is configured with one public console service and a private reference service
- **THEN** the public origin SHALL serve OAuth authorization-server metadata, OAuth protected-resource metadata, the OAuth endpoints, the hosted MCP endpoint, and the `/v1` query API by proxying to the internal AS and RS
- **AND** the AS `7662` and RS `7663` listeners SHALL NOT be published as separate public origins
- **AND** the reference service SHALL be reachable only over the platform private network

#### Scenario: Composed-origin metadata is consistent on the public origin

- **WHEN** an external client reads OAuth metadata from the public origin
- **THEN** the AS `issuer`, the RS `resource`, and the first entry of the RS `authorization_servers` SHALL each equal the public origin
- **AND** no internal service name SHALL appear as a browser-facing URL in that metadata

#### Scenario: Public origin is served over HTTPS with trusted forwarded protocol

- **WHEN** the public origin terminates TLS at the platform and forwards the protocol to the console
- **THEN** owner-session and CSRF cookies SHALL be marked `Secure`
- **AND** browser-facing metadata and authorization URLs SHALL use the public HTTPS origin

### Requirement: Managed-platform Core deploy target SHALL configure durable storage explicitly

The managed-platform Core deploy target SHALL be configured with durable storage
so that records, grants, runs, and tokens survive a restart or redeploy. The
operator SHALL choose either a managed Postgres backend, set through
`PDPP_STORAGE_BACKEND=postgres` and `PDPP_DATABASE_URL`, whose schema is
bootstrapped idempotently at boot with no separate migrate step, or a SQLite
database file on a mounted persistent volume with `PDPP_DB_PATH` pointed onto
that mounted path.

The non-durable default storage SHALL NOT be the configured backend for a deploy
that must survive restart. The in-memory SQLite default SHALL NOT be used, and a
SQLite deploy SHALL NOT leave `PDPP_DB_PATH` at a default path that is not on the
mounted persistent volume.

#### Scenario: Managed Postgres backend bootstraps at boot

- **WHEN** the deploy target is configured with `PDPP_STORAGE_BACKEND=postgres` and `PDPP_DATABASE_URL`
- **THEN** the schema SHALL be created or migrated idempotently during application start
- **AND** no separate migrate step SHALL be required before first boot
- **AND** a restart SHALL re-run the idempotent bootstrap without error and without data loss

#### Scenario: SQLite backend is pinned to a mounted volume

- **WHEN** the deploy target uses the SQLite backend
- **THEN** `PDPP_DB_PATH` SHALL point onto a mounted persistent volume
- **AND** the in-memory default and any unmounted default path SHALL NOT be the configured database location

#### Scenario: Stored data survives a restart

- **WHEN** the deployed service is restarted after storing records and an owner session
- **THEN** the previously stored records SHALL still be queryable
- **AND** the owner SHALL still authenticate without data loss

### Requirement: Managed-platform Core deploy target SHALL gate owner data by default

The managed-platform Core deploy target SHALL require a non-empty
`PDPP_OWNER_PASSWORD` and SHALL NOT serve the owner console, device-approval, or
pending-consent surfaces anonymously. An unauthenticated request to the owner
console SHALL redirect to the owner login surface, and live owner data SHALL NOT
be rendered without a valid owner session.

Secrets required by the deploy target SHALL be runtime-provided and SHALL NOT be
baked into image layers or committed configuration defaults. The owner-session
signing key is derived from `PDPP_OWNER_PASSWORD`, so a stable password SHALL
keep owner sessions valid across restarts without a separate session secret.

#### Scenario: Owner console is gated on the public origin

- **WHEN** an anonymous request hits the owner console on the public origin with `PDPP_OWNER_PASSWORD` configured
- **THEN** the request SHALL redirect to the owner login surface
- **AND** live owner data SHALL NOT be served without a valid owner session

#### Scenario: Owner password is required for the deploy target

- **WHEN** the managed-platform Core deploy target is configured
- **THEN** a non-empty `PDPP_OWNER_PASSWORD` SHALL be required
- **AND** the empty-password open-dashboard behavior SHALL NOT be the configured state for the public origin

#### Scenario: Deploy secrets are runtime-provided

- **WHEN** the deploy target needs `PDPP_OWNER_PASSWORD`, a database URL, or other secrets
- **THEN** those values SHALL be supplied at runtime through platform environment variables
- **AND** they SHALL NOT be baked into image layers or committed configuration defaults

### Requirement: Managed-platform Core deploy target SHALL define an executable first-live-test gate

The managed-platform Core deploy target SHALL define a reproducible
first-live-test gate that proves a Core node boots, stays healthy, gates owner
data, persists across restart, and answers an authenticated query, and SHALL be
runnable against a local composed-origin stack before any live platform run is
requested. The gate SHALL use the platform healthcheck path, the composed-origin
smoke assertions, the owner-gated deployment diagnostics, an MCP reachability
check, a storage-persistence check, and a documented rollback or cleanup path.

The healthcheck path SHALL return HTTP 200 from the public origin when the
service is ready. The hosted MCP endpoint on the public origin SHALL refuse
anonymous access and SHALL succeed for a scoped grant. The first live test SHALL
NOT depend on browser-backed connector collection.

#### Scenario: Health and diagnostics are reachable on the public origin

- **WHEN** the deployed service is healthy
- **THEN** the platform healthcheck path on the public origin SHALL return HTTP 200
- **AND** the owner-gated `GET /_ref/deployment` diagnostics SHALL report the deploy facts with semantic retrieval shown as an honest "not enabled" rather than a defect

#### Scenario: MCP refuses anonymous access and serves a scoped grant

- **WHEN** a client calls the hosted MCP endpoint on the public origin
- **THEN** an anonymous call SHALL be refused
- **AND** a call carrying a valid scoped grant or token SHALL complete `tools/list` and return a scoped record query result

#### Scenario: First live test excludes browser collection

- **WHEN** the first live test exercises the Core query path
- **THEN** the queried records SHALL come from a small hand-imported record set
- **AND** the test SHALL NOT require a browser-backed connector run inside the deployed service

#### Scenario: Rollback and cleanup are defined

- **WHEN** a deploy must be rolled back or torn down
- **THEN** a documented rollback or cleanup path SHALL return the project to a known-good or clean state
- **AND** it SHALL NOT orphan the public origin or the persistent storage volume

### Requirement: Managed-platform Core deploy target SHALL provide platform-neutral deploy artifacts

The reference implementation SHALL provide deploy artifacts that reproduce the
managed-platform Core deploy target from the existing Docker assembly without a
runtime code change. The artifacts SHALL include a documented environment block
consistent with the committed Docker example environment, a deploy configuration
and runbook describing the public console service, the private reference service,
the storage choice, the healthcheck path, and the rollback steps, and an
operator-voice deployment guide section.

The deploy artifacts SHALL keep the public-versus-internal URL distinction
explicit, SHALL describe the storage choice and its persistence requirement, and
SHALL use operator voice. They SHALL NOT describe the reference deployment as a
hosted multi-tenant service, SHALL NOT imply that browser-backed connector
collection runs inside the deployed service, and SHALL keep Core, Collection
Profile, reference implementation, and operator console distinct.

#### Scenario: Deploy artifacts reproduce the target from the existing assembly

- **WHEN** an operator follows the deploy artifacts for the managed-platform Core deploy target
- **THEN** the documented environment block SHALL be consistent with the committed Docker example environment
- **AND** the runbook SHALL define the public console service, the private reference service, the storage choice, the healthcheck path, and the rollback steps
- **AND** no runtime code change SHALL be required to reproduce the target

#### Scenario: Deploy documentation uses operator voice

- **WHEN** the deployment guide describes the deploy target
- **THEN** it SHALL use operator voice and SHALL NOT describe the reference deployment as a hosted multi-tenant service
- **AND** it SHALL NOT imply that browser-backed connector collection runs inside the deployed service
- **AND** it SHALL keep Core, Collection Profile, reference implementation, and operator console distinct

### Requirement: Managed-platform Core deploy target SHALL provide a pushbutton Railway Template handoff

The reference implementation SHALL provide a Railway Template publication
handoff that can produce a user-facing "Deploy on Railway" button after the
template owner publishes a validated project. The handoff SHALL define the
multi-service template shape, service Dockerfile paths, private networking,
durable storage binding, required owner secret, public-origin binding, smoke
checks, and button markup.

The template handoff SHALL NOT rely on an unencoded manual Docker build-target
setting. Each application service SHALL be selectable by a Dockerfile path whose
final stage is the intended service image, or by an equivalent platform setting
that is captured in the published template. The user-facing deploy button SHALL
NOT be published with a placeholder template code.

#### Scenario: Template service selection is encoded by Dockerfile path

- **WHEN** the Railway Template defines the public console service and private reference service
- **THEN** the console service SHALL select a Dockerfile whose final image is the console
- **AND** the reference service SHALL select a Dockerfile whose final image is the reference runtime
- **AND** the template SHALL NOT require the deploying operator to set a manual Docker target stage after clicking the deploy button

#### Scenario: Template variables are sufficient for first boot

- **WHEN** an operator deploys from the published Railway Template
- **THEN** the template SHALL define the private console-to-reference URLs, composed-mode public origin, owner password, and Postgres database binding needed for first boot
- **AND** the reference service SHALL stay private
- **AND** the public console service SHALL be the only internet-reachable application origin

#### Scenario: User-facing button is only published after template validation

- **WHEN** the template owner publishes the Railway Template
- **THEN** the owner SHALL deploy a scratch project from the published template and run the live smoke plus restart smoke before presenting the button to users
- **AND** the user-facing button URL SHALL contain Railway's assigned template code, not a placeholder
