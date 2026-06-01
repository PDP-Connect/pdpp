## Why

A trusted owner agent (Daisy/Simon-style) can initiate a local-collector
connection through `POST /v1/owner/connections/intents`, but an API/network
connector such as Gmail or GitHub returns `unsupported`. The reason is honest:
Gmail and GitHub are **static-secret** connectors — Gmail authenticates over IMAP
with a Google app password, GitHub with a personal access token. Neither runs an
OAuth authorization-code flow, so `open_url` is the wrong primitive for them. The
reference has no owner-mediated way to bring a static-secret connection into
existence: the secret lives only in process-global env or a transient local stdin
prompt, there is no per-`connection_id` credential home, and a connection
materializes only implicitly on first ingest.

The `add-owner-agent-control-surface` design (commit `f319f326`) named this exact
gap, its three missing sub-primitives, and the invariant that *agents never
receive provider static secrets*. This change promotes that named, deferred packet
into a standalone construction-quality OpenSpec design so the static-secret
connection primitive becomes correct by construction for Gmail, GitHub, and future
static-secret connectors — without leaking provider secrets to agents, without
faking a flow before proof exists, and without minting any route that handles real
provider secrets in this lane.

The only code in this lane is a safe contract reservation: a
`complete_credential_capture` next-step kind reserved in the intent enum, exactly
analogous to the `enroll_browser_collector` reservation, emitted by no route and
pinned to stay `unsupported` until a future lane lands the primitive with proof.

## What Changes

- Define the **per-connection encrypted credential store**: an app-password / PAT
  keyed to a single `connection_id`, encrypted at rest, never returned by any
  REST / MCP / console read, with rotation, revocation, and delete semantics that
  do not conflate credential validity with connection lifecycle.
- Define the **owner-mediated capture step the agent never sees**: the owner (not
  the agent) supplies the static secret through an owner-trusted local surface, in
  the same trust shape as the existing Gmail/GitHub stdin `credentials`
  `INTERACTION`. The agent observes only a typed next step and the resulting
  `connection_id`, never the secret.
- Define **connection-scoped subprocess credential injection**: the orchestrator
  loads the per-connection secret and injects it into one connector run scoped to
  that `connection_id` (via the existing stdin credential channel), not the
  process-global env — so two Gmail mailboxes run as two distinct addressable
  `connection_id`s.
- Define the **typed next step shape** and **reserve** `complete_credential_capture`
  in the `OwnerConnectionIntentNextStepSchema` enum (a code change), emitted by no
  route, with a test pinning that the `api_network` branch stays `unsupported`.
- Define the **proof-before-flip gate**: no route advertises a real static-secret
  next step until a committed test drives intent → owner-mediated capture → first
  ingest → addressable labeled `connection_id`, with audit asserting no secret
  leaks and two mailboxes producing two `connection_id`s.

## Capabilities

### Modified Capabilities

- `reference-connector-instances`: add the per-connection encrypted credential
  store as instance-scoped durable state (a peer of the existing instance-scoped
  storage and schedule requirements), with no-leakage, rotation/revoke/delete,
  connection-scoped injection, and two-account-distinct requirements.

## Impact

- OpenSpec design + a single safe contract reservation in this lane. No credential
  store, capture surface, or injection path is implemented here.
- Code touched in this lane: `packages/reference-contract/src/reference/index.ts`
  (reserve the enum value), the regenerated contract artifacts
  (`reference-implementation/openapi/*.json`,
  `reference-implementation/docs/generated/*.md`), and
  `reference-implementation/test/owner-connection-intent.test.js` (pin
  reserved-but-not-emitted).
- Future implementation areas (out of scope here, each handling a real provider
  secret): a per-connection credential store, an owner-session/local capture
  surface, connection-scoped injection in `packages/polyfill-connectors/src/collector-runner.ts`,
  and the `api_network` intent-branch flip in
  `reference-implementation/server/routes/owner-connection-intent.ts`.
- Downstream: `add-owner-agent-control-surface`'s deferred "API/network connection
  initiation" packet is the upstream that named this gap; this change is its
  promotion. The catalog flip from `unsupported` stays gated on the proof here.
