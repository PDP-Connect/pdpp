# reference-implementation-architecture Spec Delta

## ADDED Requirements

### Requirement: The reference implementation ships an operator self-host onboarding lane

The reference implementation SHALL ship an operator-facing self-host onboarding runbook that names at least one substrate beyond a generic Docker host and that scopes substrate-specific constraints honestly. The runbook SHALL NOT adopt hosted-service framing.

#### Scenario: A self-hoster reads the quick-start

- **WHEN** an operator opens `docs/operator/selfhost-quickstart.md`
- **THEN** they SHALL find at least two named lanes — one generic Docker host lane and one substrate-specific lane (RunPod CPU Pod for the SLVP) — each stating the minimum environment variables that must change from defaults, the dashboard verification step, and the wiring to `docs/operator/hosted-mcp-setup.md` for MCP grant package issuance
- **AND** the runbook SHALL state, for the substrate-specific lane, what that substrate does and does not provide (single-container vs. multi-container compose, HTTP proxy vs. native TLS, UDP support, port exposure model) without implying capabilities the substrate lacks

#### Scenario: The runbook scopes out hosted-service language

- **WHEN** the runbook describes the reference deployment
- **THEN** it SHALL address the reader as the operator of their own instance and SHALL NOT use "sign up", "our service", "we sync", or otherwise imply that PDPP-the-protocol or its stewards operate a hosted backend for end users

### Requirement: The deployment dashboard surfaces first-boot readiness

The reference implementation operator dashboard SHALL surface a structured deployment readiness view that presents existing diagnostic state as first-boot self-check rows. The view SHALL be presentation-only: it MAY consume `/_ref/deployment`, the in-browser origin, and the deployment's published OAuth metadata, but SHALL NOT introduce new owner control-plane mutations.

#### Scenario: An operator visits the dashboard on first boot

- **WHEN** an operator visits `/dashboard/deployment` after starting a fresh reference deployment
- **THEN** they SHALL see a readiness view that includes at minimum the following checks, each rendered with a status of `ok`, `warn`, `error`, `info`, or `unknown` and a one-line remediation hint:
  - owner-password gate (whether `PDPP_OWNER_PASSWORD` is configured)
  - reference-origin alignment (whether `PDPP_REFERENCE_ORIGIN` matches the URL the operator is currently viewing)
  - storage backend health
  - embedding cache state
  - hosted MCP refresh-token advertisement at the deployment's authorization-server metadata endpoint

#### Scenario: The owner password is unset on a reachable dashboard

- **WHEN** the operator opens `/dashboard/deployment` against a deployment whose `PDPP_OWNER_PASSWORD` is empty
- **THEN** the owner-password row SHALL render with `status = error` and a hint that explicitly states that `/owner`, `/device`, `/consent`, and `/dashboard` are reachable without authentication until the variable is set and the deployment is restarted

#### Scenario: The dashboard is reached via a proxy URL different from the configured origin

- **WHEN** the operator opens `/dashboard/deployment` at an origin (for example `https://<podid>-3002.proxy.runpod.net`) that does not match the server-reported `PDPP_REFERENCE_ORIGIN`
- **THEN** the reference-origin row SHALL render with `status = warn` and a hint that names the observed origin and recommends setting `PDPP_REFERENCE_ORIGIN` to that origin to avoid OAuth callback and MCP routing failures

#### Scenario: The reference image is too old to advertise `refresh_token`

- **WHEN** the deployment's `/.well-known/oauth-authorization-server` does not advertise `refresh_token` in `grant_types_supported`
- **THEN** the readiness view SHALL render the MCP refresh-token row with `status = error` and a hint that the image must be updated to a revision that advertises `refresh_token`

#### Scenario: The readiness view introduces no new control plane

- **WHEN** the readiness view is rendered
- **THEN** the implementation SHALL NOT expose a new `/_ref/*` mutation endpoint, a new owner action, or a credential-entry affordance through this view; surfacing existing state is the sole responsibility of the view
