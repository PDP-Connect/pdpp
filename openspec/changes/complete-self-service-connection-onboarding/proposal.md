## Why

Connector setup is still fragmented across local collector enrollment, browser
collector proof gates, static-secret draft/capture routes, console catalog copy,
and owner-agent intent responses. A self-hosted operator, including a Railway
operator, should not need connector-specific per-connection environment variables
or runbook archaeology to add supported connections.

## What Changes

- Define a single owner-mediated connection setup engine as the reference source
  of truth for connector setup modality, next steps, support state, proof gates,
  and secret boundaries.
- Require Console, owner-agent REST, and CLI/SDK-style setup helpers to consume
  that same engine instead of keeping separate hard-coded modality/catalog logic.
- Make connector-specific per-connection deployment environment variables a
  non-SLVP fallback only. Normal setup SHALL capture source credentials and
  account authorization through owner-mediated setup flows and encrypted
  instance-scoped storage where needed.
- Preserve proof gates: static-secret and browser-bound setup SHALL NOT be
  advertised as supported until the corresponding end-to-end live proof exists.
- Keep client/MCP read surfaces separate from owner setup/control surfaces; owner
  bearers and provider secrets SHALL NOT become normal MCP setup.
- Reframe the acceptance target around the shipped owner journey: owners must be
  able to find add-source setup, avoid developer-only commands, preserve
  credential setup continuity, see pending/running/failed setup state, and
  distinguish existing working data from add-new-account support.
- Productize browser-bound source setup as an owner-usable dashboard flow in a
  later tranche; until then, normal setup UI SHALL NOT show monorepo proof
  commands as an owner path.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: define the shared setup engine and
  deployment configuration boundary.
- `reference-connector-instances`: define the connection setup lifecycle across
  local collector, browser-bound, static-secret, and provider-authorization
  modalities.
- `reference-owner-agent-control-surface`: require owner-agent setup intents to
  expose the same setup engine, next-step contract, and secret-safe boundaries as
  the console and CLI helpers.

## Impact

- Affects reference server setup routes, owner-agent connection intent, console
  add-source UX, CLI/SDK setup helpers, deployment docs, connector catalog copy,
  setup lifecycle/status projection, browser-bound setup productization, and
  setup validation tests.
- Does not change PDPP Core grant semantics or MCP read tools.
- Does not remove existing env-var compatibility paths immediately, but demotes
  them to fallback/dev/operator escape hatches rather than normal connection
  setup.
