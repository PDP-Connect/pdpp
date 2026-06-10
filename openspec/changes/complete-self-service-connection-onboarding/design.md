## Context

The reference now has several connection setup primitives, but they do not yet
compose into one SLVP setup contract:

- local collectors (`claude-code`, `codex`) can enroll through a proven device
  exporter path;
- browser-bound connectors have an enrollment primitive, but real browser
  end-to-end support remains proof-gated;
- static-secret connectors (`gmail`, `github`) have encrypted credential storage,
  owner-session draft/capture routes, and first-ingest activation, but their
  normal setup is still runbook/proof-gated;
- owner-agent intent and the console catalog classify the same manifests, but
  keep separate code paths and copy;
- self-hosted deployment docs still mention source credential env vars as
  compatibility/fallbacks, which risks turning Railway/Fly/VPS setup into a
  per-connector env-var exercise.

The correct target is not "make every connector one click." The target is a
single owner-mediated setup engine that can answer, for any connector, what the
operator can do now, what prerequisite is missing, which owner step is required,
and when a connection becomes active.

## Goals / Non-Goals

**Goals:**

- Make the setup engine the single source of truth for connector setup modality,
  next-step shape, support state, deployment readiness, and proof gates.
- Make Console, owner-agent REST, and CLI/SDK-style helpers consume that engine
  so they provide the same setup answer.
- Remove connector-specific per-connection env vars from the normal setup path.
- Preserve the secret boundary: provider credentials are captured only through
  owner-mediated setup flows and are never returned to agents, MCP, REST reads,
  or console reads.
- Preserve proof honesty for browser-bound and static-secret paths.
- Keep all setup/control surfaces separate from grant-scoped MCP/read surfaces.

**Non-Goals:**

- Do not claim PDPP Core defines connector setup. This is reference
  implementation and Collection Profile machinery.
- Do not make every connector supported. Unsupported and proof-gated states are
  first-class setup outcomes.
- Do not remove env-var fallback paths in this change. They may remain as local
  development/operator escape hatches while normal setup moves elsewhere.
- Do not add MCP management tools or accept owner bearers on `/mcp`.
- Do not flip browser-bound or static-secret connectors to supported without the
  live proof required by their existing changes/runbooks.

## Decisions

### 1. Use one setup engine, not duplicated catalog logic

The setup engine should be a server/reference module that takes connector
manifest identity plus owner/deployment context and returns a typed setup plan.
The plan includes:

- canonical connector key and display metadata;
- modality derived from manifest runtime bindings;
- support state (`supported`, `proof_gated`, `needs_deployment_config`,
  `unsupported`);
- owner-visible next step (`enroll_local_collector`,
  `enroll_browser_collector`, `capture_static_secret`, `open_provider_auth`,
  `manual_runbook`, or `unsupported`);
- whether an active connection is created, a draft is created, or no row is
  written yet;
- non-secret setup prerequisites and documentation links.

The console add-connection picker, owner-agent intent route, and CLI/SDK helpers
should render or serialize that plan. They should not each reimplement the
classification matrix.

Alternative rejected: keep console and owner-agent classifications in sync with
tests. That has already reduced drift, but it is still a duplication trap and
does not give CLI/SDK consumers a stable source of truth.

### 2. Deployment readiness is separate from connection setup

Deployment variables are acceptable for instance-level runtime facts:
database URL, public origin, owner auth/session configuration, AS/RS ports, and
the credential encryption key. They are not the normal path for adding one Gmail
mailbox, one GitHub account, or one future OAuth source.

If a connector needs platform-level provider app material, such as an OAuth
client id/secret owned by the operator's deployment, the setup engine should
return `needs_deployment_config` until that platform config exists. Once it
exists, per-account authorization happens through an owner setup step, not by
adding another env var.

Alternative rejected: let Railway/Fly users add source credentials as service
variables. That is acceptable for emergency compatibility, but it fails the
multi-account construction and makes every new connector a deployment-editing
exercise.

### 3. Setup has typed modalities, not ad hoc connector exceptions

The initial modalities remain:

- `local_collector`: owner enrolls a device/local collector binding; the
  connection activates when the enrolled collector ingests.
- `browser_bound`: owner enrolls/attaches a browser-capable collector; support is
  proof-gated until a real browser login/run proves the path.
- `static_secret`: owner creates a draft, captures a provider secret through an
  owner session, and activates on first ingest.
- `provider_authorization`: owner completes a provider OAuth/Link-style
  authorization flow after deployment-level provider app readiness exists.
- `manual_or_upload`: owner supplies an uploaded artifact or manual file when a
  connector is implemented that way.
- `unsupported`: connector has no reference setup path.

These are setup modalities, not user-facing product categories. The console
should render them as concise next steps, not a taxonomy page.

### 4. Active connections require proof of usable binding

The setup engine may create a draft or enrollment code, but it SHALL NOT mark a
connection active until the modality's proof boundary is crossed:

- local collector: enrolled collector exchanges the code and ingests accepted
  data or otherwise proves a usable source binding;
- browser-bound: real browser-bound end-to-end proof exists before the route is
  advertised as supported, then activation follows the implemented ingest rule;
- static-secret: first accepted ingest flips `draft` to `active`;
- provider authorization: callback/token exchange completes and any required
  account inventory/connection test passes.

Zero-record phantom rows are not a valid normal setup result.

### 5. Agent help is allowed; agent-held secrets are not

Owner agents may initiate setup, explain next steps, and poll non-secret status.
They may receive owner-openable URLs, setup codes, route names, and typed
errors. They SHALL NOT receive provider credentials, owner cookies, app
passwords, provider access tokens, browser session cookies, or bearer tokens for
grant-scoped MCP.

For secret-bearing steps, the plan points the owner to an owner-session surface
or local trusted collector prompt. This follows Airbyte's secret-mode pattern:
the assistant can guide the flow, but secret capture is a separate protected
mode.

### 6. The page/UX is a setup surface, not a documentation dump

The console add-connection flow should be one simple page focused on choosing a
source and completing the next owner action. It should not expose every internal
modality label, every route, or long explanatory copy before the owner has made
a choice.

The engine response supplies enough structure for low-copy rendering:

- one status label;
- one short explanation;
- one primary action;
- one proof/prerequisite message when blocked;
- one advanced/details disclosure with the exact route or command.

### 7. CLI and SDK helpers are consumers, not separate products of truth

The CLI and any future SDK can be ergonomic, but they should call the same setup
engine route/contract. If an agent uses a skill plus CLI, or a human uses CLI,
they should see the same setup answer that the console and owner-agent REST
surface would produce.

### 8. Static-secret forms are manifest-authored and credential-key-provider gated

Static-secret setup UI is generated from connector manifest metadata, not from
Console-specific connector branches. A connector that needs a provider secret or
non-secret account identifier declares the setup fields, help URL, labels, and
credential kind in its manifest. Console, owner-agent REST, and CLI helpers
consume that descriptor; the RI UI does not carry connector-specific form
knowledge.

Static-secret credential storage depends on an instance-level credential key
provider. The provider abstraction has at least two RI implementations:
`PDPP_CREDENTIAL_ENCRYPTION_KEY` for platforms whose secret manager exposes env
vars (Railway), and `PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE` for Docker/Kubernetes
secret-file mounts. Railway templates generate the env-var key automatically;
Docker's `generate-secrets.sh --write` fills the env-var provider by default.
When no provider is configured, setup SHALL block before provider-secret entry
and draft creation SHALL fail closed before writing a row.

### 9. Connector-related Console UI is data-driven, not provider-curated

The RI Console may render concrete AI-client setup commands for known client
software, but data-source setup UI must not own connector-specific labels,
examples, field copy, help links, or credential names. Connector display names
come from manifests; setup support, proof gates, deployment blockers, and action
shape come from the shared setup engine; static-secret form fields and help
links come from connector-authored setup descriptors.

This means a future connector with equivalent manifest/setup metadata should
appear in the add-source picker and render the correct owner next step without a
Console code change. A connector that needs a new runtime primitive still
requires setup-engine support, but the UI should display that engine response
generically rather than adding a provider-specific branch.

### 10. Owner journey acceptance overrides internal implementation completeness

The corrected acceptance target is an owner journey, not a setup-planner task
list. A self-host owner must be able to add, understand, monitor, and manage
multiple source accounts without a PDPP repo checkout, unpublished CLI command,
internal id mapping, or developer vocabulary.

The source setup surface therefore projects three different facts separately:

- existing connection/data state;
- add-new-account support from shipped owner-usable surfaces;
- prerequisites or blocked state when add-new is not supported yet.

A connector with existing working data can still be "not self-service yet" for
adding another account, but the UI must not make that connector look inert or
unsupported as a data source. Conversely, a maintainer proof path does not make a
connector owner-supported.

### 11. Normal UI command surfaces are product contracts

Any command rendered in normal owner UI must work from a clean target-user
environment using the exact package/version or platform named in the UI. Commands
that require `pnpm --dir`, `packages/...`, a PDPP monorepo checkout, unpublished
CLI subcommands, or placeholder substitution over internal ids are
developer/maintainer procedures and SHALL NOT appear in normal setup flows.

CLI discovery and setup helpers may exist, but source cards should not advertise
those commands until the published CLI package exposes and tests the exact
subcommand. The owner-agent CLI can remain an advanced/trusted-agent surface; it
is not a substitute for dashboard setup continuity.

### 12. Static-secret setup needs continuity and visible lifecycle

Static-secret setup remains manifest-authored and key-provider gated. The owner
flow also needs these user-facing properties:

- provider credential help opens in a new tab so the in-progress form remains
  available;
- required non-secret identity fields, such as an account email address, are
  supplied by manifest setup descriptors instead of deployment env vars;
- after submit, the owner lands on a visible setup status or running-sync state;
- failed first sync surfaces a repair action rather than leaving an invisible
  draft or one-time redirect notice.

The current draft/first-ingest activation storage model may remain internally,
but its state must be projected into the owner UI. Invisible post-submit state is
not an acceptable product contract.

Implemented (flow design B1/D): a static-secret connector MAY declare an
optional, reference-only `probeCredential(secret, context) -> { identity, detail
} | typed error` hook (connector-keyed registry in `@pdpp/polyfill-connectors`,
injected transport, never a Collection Profile message and never in the runner
slice). The setup planner advertises `validation: synchronous | first_sync` from
that registry. When a probe is available the owner-session capture route
validates the credential BEFORE storing it: a known-bad credential is rejected
with a provider-named typed error and nothing is stored. Rejected first-time
drafts are retired immediately so they do not become invisible setup rows;
rejected rotation attempts against active connections leave the active
connection active. A valid credential is stored and the route echoes the
non-secret account identity. Connectors without a probe keep the first-sync
activation path unchanged. The Console form preserves non-secret context on a
validation failure (the secret is never round-tripped) and surfaces the identity
echo on success, staying connector-generic.

### 13. Browser-bound setup is committed product work, not a monorepo proof path

The owner decision on 2026-06-10 is to productize browser-bound setup. The SLVP
shape is in-dashboard "finish in this browser" setup using the existing remote
surface/interaction machinery, not a terminal command that runs package internals
from the repo. Until that ships, browser-bound source cards use packaged-path
pending copy and no normal owner action. Maintainer runbooks may still exist in
advanced documentation, but they do not make the normal setup path supported.

### 14. Browser enrollment shell + TTL retirement (Slice 2)

Every browser-bound add-account attempt creates a **browser enrollment shell**: a
`draft` connector instance with a `browser_enrollment_shell` sourceBinding. The
shell is invisible to all list/read surfaces (same as static-secret drafts) and
carries an `enrollment_expires_at` ISO timestamp in its sourceBinding. Retirement
rule at creation time: 2-hour TTL or explicit owner dismissal — whichever comes
first.

**Routes (owner-session / AS, no bearer):**
- `POST /_ref/connectors/:connectorId/browser-enrollment-shell` — creates the
  shell; refuses non-browser-bound connectors (409) and unknown connectors (404).
  Returns `connection_id`, `enrollment_expires_at`, and `next_step.kind =
  "browser_enrollment_run"`.
- `POST /_ref/connections/:connectorInstanceId/abandon-enrollment` — explicit
  owner dismissal; retires the shell (draft → revoked). Idempotent when already
  revoked; 409 when enrollment completed and shell is already active; 404 when
  not found or wrong owner.

**TTL retirement:**
- `expiredEnrollmentShellIds(shells, now)` (pure) — identifies expired shells
  without I/O; directly testable.
- `retireExpiredBrowserEnrollmentShells(store, { now })` — sweeps all draft
  browser enrollment shells system-wide and retires expired ones.
- SQLite store: `listDraftBrowserEnrollmentShells()` uses a bounded
  `@bounded_by: small_enumeration_table` query (max 256 rows).
- Postgres store: parametrized bounded queries; no dynamic SQL or injection risk.

**Data-ops retirement contract:** every shell has a declared TTL at creation
time. The `sourceBinding.kind = "browser_enrollment_shell"` field distinguishes
shells from static-secret drafts so the retirement sweep never touches unrelated
drafts. Active connections (enrollment captured source identity and flipped
status) are never touched by retirement.

## Risks / Trade-offs

- **Risk: the setup engine becomes a large abstraction.** Mitigation: keep it as
  a typed planner over existing manifests/primitives; do not move connector run
  logic into it.
- **Risk: proof-gated connectors look "unfinished."** Mitigation: this is
  honest. A source is not supported until the route and proof exist.
- **Risk: env-var compatibility lingers and confuses operators.** Mitigation:
  documentation and console copy must label env-var source credentials as
  fallback/dev escape hatches, while normal setup points to the engine.
- **Risk: owner-agent setup is mistaken for grant-scoped MCP.** Mitigation:
  owner-agent setup remains REST/control-plane only, and `/mcp` continues to
  reject owner bearers.

## Migration Plan

1. Add the setup engine as a pure planner over current manifests, support sets,
   deployment readiness checks, and existing static-secret/browser/local
   primitives.
2. Switch owner-agent intent to call the planner without changing emitted support
   states prematurely.
3. Switch console add-connection catalog rendering to call the planner or a
   serialized planner endpoint.
4. Add CLI/SDK helper commands against the same endpoint.
5. Update self-host/Railway docs to distinguish deployment readiness variables
   from source connection setup.
6. Move static-secret setup form fields and help links into connector manifests,
   and expose a setup descriptor that reports credential-key-provider readiness.
7. Flip proof-gated connectors only in the same unit as their live proof and
   corresponding planner tests.

## Open Questions

- None blocking this proposal. The static-secret and browser-bound live proofs
  are implementation gates, not design questions.
