# reference-implementation-architecture (delta)

## ADDED Requirements

### Requirement: Owner auth SHALL fail closed on an internet-facing deployment

The reference implementation SHALL distinguish a local-development posture
(loopback, password-optional convenience) from a hosted posture (internet-facing
intent) and SHALL NOT silently expose the owner control plane when no owner
password is configured.

The implementation SHALL classify a deployment as **hosted** when any of the
following honest signals is present: a non-loopback `PDPP_REFERENCE_ORIGIN`, a
non-loopback `AS_PUBLIC_URL` (or the equivalent `asPublicUrl` start option),
`NODE_ENV=production`, or an explicit non-loopback listener bind host. Operators
MAY force the classification with `PDPP_HOSTED=1` / `PDPP_HOSTED=0`. For
hosted-classification purposes a bind host of `0.0.0.0` / `::` is NOT loopback
(it binds all interfaces). Under the Node test runner the implementation SHALL
ignore ambient hosting env so the test suite stays hermetic; explicit start
options and `PDPP_HOSTED` SHALL still be honored.

When the posture is hosted and `PDPP_OWNER_PASSWORD` is unset or empty, the
server SHALL refuse to start: `startServer` SHALL throw before any AS or RS
listener binds, with an error that names `PDPP_OWNER_PASSWORD` and explains the
exposure. An operator MAY intentionally run an unauthenticated owner surface by
setting `PDPP_ALLOW_UNAUTHENTICATED_OWNER=1`; that override SHALL be the only way
to boot a hosted deployment without a password, and it SHALL keep the open
posture rather than silently flipping it on.

When the posture is local-dev (loopback) the password SHALL remain optional and
the existing open approval-UI / `_ref` behavior SHALL be preserved unchanged. If
a local-dev posture nonetheless binds a non-loopback interface without a
password, the server SHALL emit a loud warning at boot.

The `requireOwnerSession` gate's disabled-auth branch (no password configured)
SHALL fall through to open behavior ONLY in a local-dev posture or under the
explicit `PDPP_ALLOW_UNAUTHENTICATED_OWNER=1` override. In any other posture the
disabled-auth branch SHALL fail closed: a 401 JSON envelope with error code
`owner_session_required` for non-HTML callers, or a redirect to `/owner/login`
for HTML callers. This is a defense-in-depth guarantee behind the boot guard.

#### Scenario: Hosted deployment without a password refuses to boot

- **WHEN** `startServer` is invoked in a hosted posture (e.g. a non-loopback
  `asPublicUrl` / `PDPP_REFERENCE_ORIGIN`, or `NODE_ENV=production`) and
  `PDPP_OWNER_PASSWORD` is unset or empty and
  `PDPP_ALLOW_UNAUTHENTICATED_OWNER` is not set
- **THEN** `startServer` SHALL reject before any listener binds
- **AND** the error message SHALL name `PDPP_OWNER_PASSWORD` and describe the
  internet-facing exposure

#### Scenario: Hosted deployment with the explicit override boots

- **WHEN** `startServer` is invoked in a hosted posture without a password but
  with `PDPP_ALLOW_UNAUTHENTICATED_OWNER=1`
- **THEN** the server SHALL boot and serve
- **AND** the owner-session disabled-auth branch SHALL keep the open posture

#### Scenario: Hosted deployment with a password boots and gates normally

- **WHEN** `startServer` is invoked in a hosted posture with a non-empty
  `PDPP_OWNER_PASSWORD`
- **THEN** the server SHALL boot
- **AND** protected owner routes SHALL require a valid owner session

#### Scenario: Local-dev deployment preserves the open password-optional UI

- **WHEN** `startServer` is invoked in a local-dev posture (loopback origin, no
  hosting signals) with no `PDPP_OWNER_PASSWORD`
- **THEN** the server SHALL boot
- **AND** the approval UIs and `_ref` reads SHALL remain open exactly as before

#### Scenario: Disabled-auth owner route fails closed in a non-local posture

- **WHEN** owner auth is disabled and the posture does not allow the open
  fall-through (hosted, no explicit override)
- **AND** an unauthenticated caller requests a route protected by
  `requireOwnerSession`
- **THEN** a non-HTML caller SHALL receive HTTP 401 with error code
  `owner_session_required`
- **AND** an HTML caller SHALL be redirected to `/owner/login`

### Requirement: The connector registry upsert SHALL be owner-gated on a hosted deployment

The reference implementation SHALL NOT accept an unauthenticated
`POST /connectors` on an internet-facing deployment. `POST /connectors` upserts
a connector manifest, and because grants are validated against
`grant_contract.version`, a manifest upsert that bumps the `version` field
invalidates every existing grant for that connector — a one-request grant-wipe
denial of service — and can also rewrite stream schema and refresh policy.

`POST /connectors` SHALL require a valid owner session whenever the deployment
is in a hosted posture (per the owner-exposure posture above) or when the
operator sets `PDPP_LOCK_CONNECTOR_REGISTRY=1`. When the posture is local-dev
and the registry is not explicitly locked, `POST /connectors` MAY remain
unauthenticated so the development and test harness can self-register manifests.
`GET /connectors/:connectorId` (manifest read) carries no user data and SHALL
remain unauthenticated regardless of posture.

#### Scenario: Hosted POST /connectors requires an owner session

- **WHEN** the deployment is in a hosted posture (or
  `PDPP_LOCK_CONNECTOR_REGISTRY=1`)
- **AND** an unauthenticated caller sends `POST /connectors` with a manifest body
- **THEN** the response SHALL be HTTP 401 with error code
  `owner_session_required`
- **AND** the manifest store SHALL NOT be mutated

#### Scenario: Authenticated owner can still register a manifest on a hosted deployment

- **WHEN** the deployment is in a hosted posture
- **AND** a caller with a valid owner session sends `POST /connectors`
- **THEN** the manifest SHALL be registered and the response SHALL be HTTP 201

#### Scenario: Manifest read stays open on a hosted deployment

- **WHEN** the deployment is in a hosted posture
- **AND** an unauthenticated caller sends `GET /connectors/:connectorId`
- **THEN** the response SHALL return the manifest with HTTP 200

#### Scenario: Local-dev POST /connectors stays open for the harness

- **WHEN** the deployment is in a local-dev posture and the registry is not
  explicitly locked
- **AND** an unauthenticated caller sends `POST /connectors`
- **THEN** the manifest SHALL be registered with HTTP 201
