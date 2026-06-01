## Context

PDPP now has two distinct agent paths:

- routine agents use scoped client grants and MCP/read APIs;
- trusted local owner agents use an explicitly approved owner-agent credential for owner-visible REST data access.

The second path is still incomplete. Daisy and Simon can onboard and read data, but Simon could not initiate a new Amazon connection or discover a typed connection-management path from the owner-agent REST surface. The current public/read surfaces also make connector type identity (`amazon`) more visible than connection instance identity; records carry `connection_id`, but connector/schema listings can still look template-only and display names can degrade to registry URLs.

The SLVP target is not "owner token can do anything silently." It is "a trusted local agent can help operate the owner's reference instance through typed, audited, owner-mediated REST actions."

## Goals / Non-Goals

**Goals:**

- Define the complete owner-agent control surface before implementation.
- Let owner-agent credentials perform explicit owner REST administration where an owner session can already operate, subject to route-level allowlists and audit semantics.
- Expose connector templates separately from configured connection instances.
- Let a trusted owner agent initiate a new connection as a typed intent that returns the correct next step: OAuth redirect, browser-assistance session, upload/import session, local-collector enrollment, or unsupported-with-reason.
- Make multi-connection operation first-class: every owner-agent-visible connection row carries `connection_id`, `connector_id`/`connector_key`, owner-meaningful `display_name`, lifecycle status, supported actions, and links or actions for run/schedule/revoke/delete.
- Preserve grant-scoped MCP as the default data-access surface for external assistants; `/mcp` continues to reject owner bearers.
- Use Amazon as an acceptance fixture for connector type vs connection instance clarity.

**Non-Goals:**

- Do not turn MCP into an owner-admin API.
- Do not allow a bearer token to bypass provider login, 2FA, consent, upload, or local-device enrollment steps.
- Do not standardize connector instance identity as Core PDPP protocol vocabulary in this change; it remains reference/Collection Profile implementation vocabulary.
- Do not require every connector to support every lifecycle action. Unsupported actions must be discoverable and typed.

## Decisions

1. **Owner-agent admin is REST-only.**

   Owner-agent credentials MAY authorize selected `/_ref/*` or successor owner REST routes, but `/mcp` remains grant-scoped. This keeps tool-using external clients on least-privilege grants while letting trusted local agents operate the owner's instance through a more explicit control plane.

2. **Connector templates and connection instances are separate resources.**

   A template describes a connector implementation such as `amazon`. A connection instance describes one owner-approved binding such as `cin_cd523fe54af1881cc18d7368`. Listing templates without listing instances is insufficient for owner-agent operation because a trusted agent cannot tell "the owner personal Amazon" from a future "shared Amazon" account.

3. **New connection creation is an intent, not a direct mutation.**

   `POST`ing a connection intent should not claim that the connection exists. It creates an auditable workflow object with a typed `next_step`, such as `open_url`, `complete_browser_assistance`, `upload_file`, `enroll_local_collector`, or `unsupported`. The owner or local environment still performs sensitive provider interaction.

4. **Owner-meaningful labels are required before multi-connection claims are complete.**

   A `display_name` equal to a registry URL is acceptable as a fallback implementation detail but not the SLVP ideal. Owner-agent-visible connection listings must make it possible to label and later address "personal Amazon" vs "shared Amazon" without relying on raw `cin_*` values.

5. **Control-plane actions are capability-advertised.**

   Each template and connection instance should advertise supported actions so agents do not probe random 404s. Actions include `initiate_connection`, `run_now`, `schedule`, `pause_schedule`, `resume_schedule`, `rename`, `delete`, `revoke_credentials`, `inspect_diagnostics`, and `open_assisted_flow`, as applicable.

6. **Authorization is explicit and auditable.**

   Owner-agent bearer acceptance should be route-family and operation scoped, not an accidental side effect of owner-session middleware. Mutating actions record actor kind (`owner_agent` vs browser owner session), client id/name, target connection id, and action outcome without logging secrets.

7. **Connection-intent modality is classified from the manifest, and the route only returns a real next step for proven primitives.**

   The reference has exactly three connection-creation primitives today: device-exporter (local-collector) enrollment; implicit default-account materialization on first ingest; and **no standalone browser-assistance/OAuth provider-connect route at all**. `POST /v1/owner/connections/intents` therefore classifies a connector by its manifest `runtime_requirements.bindings`:

   - a `filesystem` binding → `local_collector` (`claude-code`, `codex`). The route mints a real single-use device-exporter enrollment code via the same `deviceExporterStore.createEnrollmentCode` operation the cookie-authed `/_ref/device-exporters/enrollment-codes` route uses (separate owner-bearer auth adapter — no handler cloning) and returns `next_step.kind: enroll_local_collector`. The connection materializes only when the owner's collector exchanges the code and ingests; the intent writes no `connector_instances` row.
   - a `browser` binding → `browser_bound` (`amazon`, `chase`, `chatgpt`) → `next_step.kind: unsupported`. The reason names the exact missing primitive (Open Question 3, resolved below). Claiming `enroll_local_collector` for Amazon would assert a flow the reference does not prove; that would be a faked success, which the acceptance criteria forbid.
   - `network` only → `api_network` (`github`, `gmail`) → `unsupported`, naming the implicit-on-ingest gap (no standalone owner-agent API-connect route exists).
   - no manifest / no bindings → `unknown` → `unsupported`.

   Every response carries `connection_active: false`. The contract enum reserves `open_url`, `complete_browser_assistance`, and `upload_file` next-step kinds that this build does not emit, so a future lane that gains those primitives can use them without a contract break. Initiation attempts emit `owner_agent.connection.initiate` spine evidence (actor kind/client, connector key, modality, next-step kind, outcome, request id; never the bearer token or the minted enrollment code).

   The four connection-creation modalities therefore map to exactly one proven primitive and three named gaps. The proven one (`local_collector`) ships. The three gaps each have a precise missing-primitive description so a future lane has a concrete start; they are enumerated as deferred packets below. Of the reserved next-step kinds, `enroll_local_collector` is live; `upload_file` has **no triggering connector in the reference at all** (only `filesystem`, `browser`, and `network` binding markers appear across every manifest — verified in tree), so it stays purely contract-reserved with no packet until an upload/import connector is added; `open_url` and `complete_browser_assistance` are the browser/OAuth-assistance next steps the deferred packets below would emit.

## Resolved: Amazon second-account (browser-collector) implementation packet

The Amazon second-account flow is `unsupported` until the **browser-collector enrollment primitive** ships. This is the precise next implementation packet (resolves Open Question 3 for browser-bound connectors):

1. A `browser_collector` source kind distinct from `local_device`, so an owner can have a local collector that drives a real browser session for a browser-bound connector and the instance binding records that it is browser-collected, not filesystem-read.
2. Binding-aware enrollment gating at `POST /_ref/device-exporters/enrollment-codes` (and the owner-agent intent route) keyed on the manifest `runtime_requirements.bindings`: a `browser` binding must enroll as `browser_collector`, a `filesystem` binding as `local_device`. Today the enroll path hardcodes `source_kind: local_device` and does no binding-aware validation.
3. Committed proof (test + fixture) that a local collector runs a browser connector (Amazon) end-to-end and ingests via the device-exporter path. Only with that proof may the intent route flip Amazon from `unsupported` to `enroll_local_collector` (or a new `enroll_browser_collector`) and add the Amazon second-account acceptance coverage (tasks 5.3, 8.5).

Until then the route's honest output for Amazon is `unsupported` with this gap named in `next_step.reason`.

## Deferred: API/network connection initiation (github / gmail) needs a typed owner-agent API-connect primitive

API/network connectors (`api_network` modality: `github`, `gmail`) are `unsupported` from the intent route, and the reason names the gap verbatim ("no standalone owner-agent API-connect route; an API connection materializes implicitly on first ingest"). This is the symmetric counterpart to the browser-collector packet for the OAuth/API connector class the scope calls out. The reference has exactly two ways an API/network connection comes into existence today, and neither is an owner-agent-initiable typed intent:

1. **Implicit default-account materialization on first ingest.** A connection row is written the first time records arrive for the connector; there is no owner-mediated pre-creation step, no `connection_id` an agent can address before ingest, and no place to attach an owner-meaningful label at creation time.
2. **No standalone provider-connect route.** There is no `/v1/owner/*` (or `/_ref/*`) route that begins an OAuth authorization-code / PAR flow and returns an `open_url` next step, nor one that performs an owner-mediated API-token capture. The intent enum reserves `open_url` precisely for this, but no route emits it.

The missing primitive is a **typed owner-agent API-connect intent** that (a) creates an auditable intent object with `connection_active: false`, (b) returns `next_step.kind: open_url` for OAuth connectors (authorization endpoint + state, with the owner completing consent in a browser, never the agent), or an owner-mediated token-capture step for static-token connectors, and (c) materializes the `connector_instances` row only after the provider authorization completes and the first ingest lands — exactly mirroring the local-collector "intent does not write a row" rule. Until that primitive ships with committed proof (a test that drives intent → owner authorization → first ingest → addressable labeled `connection_id`), the honest output stays `unsupported` with the named gap. No spec requirement mandates the route exist; the spec requires honest advertisement, which is in place. A future lane flips `api_network` from `unsupported` to `open_url` in the same reviewable unit as its proof. This packet does **not** authorize headless OAuth: the agent never receives provider credentials or drives consent/2FA — only the owner does, in a real browser.

## Deferred: connection-scoped diagnostics needs a per-connection health primitive

`inspect_diagnostics` is typed `unsupported` per connection because the only diagnostics surface in the reference (`GET /_ref/device-exporters/diagnostics`) is **owner-wide and device-exporter-subsystem-scoped**, not addressed by `connection_id`. Sharing it under an owner-bearer adapter would let an agent ask "diagnose connection X" and receive subsystem-wide device state for unrelated connections — broader than the addressed connection, the same shape of over-broad sharing the destructive-control audit rejected for `revokeDevice`.

The missing primitive is a **connection-scoped diagnostics read** keyed on `connection_id` (== `connector_instance_id`) that returns the last run status, last successful ingest time, current schedule state, and a typed health classification (`healthy` / `auth_expired` / `stalled` / `never_run` / `unreachable`) for that one binding, distinct from device-exporter subsystem health. It is non-destructive, so it does not need a destructive-cascade spec delta — only a committed per-connection health read on the browser owner-session surface first, then shared under the owner-bearer adapter (the same "build on the session surface, share under a separate auth adapter" rule run-now followed). Until that exists, the catalog advertises `inspect_diagnostics` as `unsupported` with this gap named, and a future lane flips it to `supported` with its proof in one unit. The connector-health-surface research already captured the state taxonomy this classification should reuse.

## Resolved: destructive owner-agent control (delete / revoke) stays unsupported until connection-scoped primitives ship

The destructive control tranche was audited against the rule that an owner-agent route may only share **existing, tested, owner-scoped** semantics, and may not introduce new destructive semantics without a spec delta. The audit (`tmp/workstreams/ri-owner-agent-destructive-control-v1-report.md`) found no safe-by-construction sharing path for connection delete or credential revoke, so both remain typed `unsupported` in the control catalog (`server/metadata.ts`). The precise reasons:

1. **`delete_connection` → `unsupported`.** The connector-instance store (`server/stores/connector-instance-store.js`) has **no delete method** at all — only `updateStatus`, `setDisplayName`, and read/resolve operations. No browser owner-session route deletes a connection either. There is no existing semantic to share; implementing one would require defining what a connection delete cascades to (records, dataset, spine correlations, device source-instance rows) — a durable data-loss contract that needs its own spec delta before any code.

2. **`revoke_connection` → `unsupported`.** The only credential-revoke primitive in the reference is **device-scoped**: `deviceExporterStore.revokeDevice(deviceId)` (`server/routes/ref-device-exporters.ts` `POST /_ref/device-exporters/:deviceId/revoke`), whose store method soft-revokes the device row **and cascades to every `device_source_instances` row under that `device_id`**. A `connection_id` (== `connector_instance_id`) maps to one source instance on one device, but a single device can back multiple connections. Reusing `revokeDevice` from a connection-scoped owner-agent route would let an agent addressing one `connection_id` silently revoke unrelated sibling connections sharing the device — broader, **new** destructive semantics, not the same semantics shared under a different auth adapter. The missing primitive is a **connection-scoped credential revoke** (`revokeSourceInstance(connectorInstanceId)` or equivalent) with its own committed test, distinct from `revokeDevice`. Until that exists, the owner-agent surface names device-exporter revoke as owner-session-only and does not expose a connection-scoped revoke.

Run-now is intentionally not part of the destructive decision above. It is non-destructive (it triggers a collection run, not data loss) and now ships as the supported `run_connection` family via `POST /v1/owner/connections/{connection_id}/run`, sharing the controller `runNow` semantics with the browser owner-session route under a separate owner-bearer auth adapter.

Grant-package revoke (`POST /_ref/grant-packages/:id/revoke`, cascading soft-revoke across grant_packages/tokens/members/refresh_tokens) is intentionally **not** mapped to any owner-agent connection family: it revokes *client grant access*, not a connection binding, and an owner-agent revoking grants — including potentially its own issuing grant — is exactly the "owner-agent credentials become too powerful by default" risk this design mitigates. It remains owner-session only.

The catalog advertises the destructive families honestly and typed per the "Owner-agent control SHALL advertise and enforce per-connection actions" requirement (actions are advertised "when available", unavailable ones "marked unsupported with a typed reason"). No spec requirement mandates delete/revoke routes exist; the spec requires honest advertisement, which is in place. A future lane that lands a connection-scoped delete or revoke primitive (with cascade semantics and committed proof) flips the corresponding catalog descriptor from `unsupported` to `supported` without a contract break.

## The construction-first SLVP ideal for owner agents (REST / CLI / MCP)

This section states the durable ideal the surface is built toward, so future lanes
extend it by construction instead of patching one route at a time. It is the
synthesis the `design-notes/full-context-refresh.md` "Good Construction Before
Feature Lists" standard asks for: name the primitives and boundaries, then let the
endpoint list fall out of them.

### Three planes, one credential boundary

A trusted owner agent (Daisy/Simon class) operates the owner's reference instance
across three planes, each with a fixed role. The planes are the durable primitive;
the route list is derived.

1. **Discovery plane (no token).** `/.well-known/oauth-protected-resource`, `/llms.txt`,
   `/.well-known/llms.txt`, and the skill catalog. An agent learns the owner-agent
   onboarding profile, the control entrypoint, and the read/schema/cursor/subscription
   surfaces *before* it has a credential. This plane is already normative and shipped
   (`reference-agent-access-workflow`, archived `add-trusted-owner-agent-onboarding`);
   this change does not redefine it, it consumes it via the
   `pdpp_owner_agent_onboarding.control_surface` hint.

2. **Owner control plane (owner-agent bearer over REST).** `GET /v1/owner/control`
   (capability document) plus the `/v1/owner/connections*` and
   `/v1/owner/connectors*` families. This is where administration lives: list
   templates/instances, initiate typed connection intents, label, run-now, manage
   schedules. Authorized by `requireToken` + `requireOwner`; **never** by owner-session
   middleware side effect. The capability document is self-describing, so the route
   list is discoverable, not memorized.

3. **Routine data plane (scoped client grant over MCP / `/v1/*`).** Grant-scoped
   reads for ordinary chat-hosted/third-party agents. `/mcp` rejects owner bearers by
   construction. An owner agent that only needs to *read* the owner's data SHOULD use
   the same scoped data plane, not its admin credential, for least privilege.

The credential boundary is the load-bearing invariant: **the owner-agent bearer is a
REST control-plane credential, and the scoped client grant is a data-plane credential.**
Everything else (which routes exist, which actions are supported) is derived from that
split plus the control catalog.

### Is Linear-style owner-token-over-MCP part of the SLVP ideal? No — by construction.

Some products (e.g. Linear's MCP) let a single owner-scoped token act over MCP as both
a read and an admin credential. **That is explicitly not PDPP's SLVP ideal, not merely
its current behavior.** The reason is structural, not a temporary limitation:

- MCP in PDPP is the *least-privilege, grant-scoped* surface for arbitrary external
  assistants. Its entire value is that a client token carries a narrow, revocable,
  field/stream/time-scoped grant. Letting an owner bearer act over `/mcp` would collapse
  that guarantee — any owner-token-bearing tool would silently hold owner authority on
  the surface specifically designed to *withhold* it.
- Administration is owner-mediated and auditable by design (typed intents, owner-completed
  provider steps, per-mutation spine evidence). MCP's tool-call shape does not carry the
  actor-kind/audit contract the control plane requires, and bolting it on would duplicate
  the REST control plane rather than reuse it.
- The "would this still be the right foundation for an exotic case later?" test points the
  same way: if a future owner agent needs a new admin action, it should appear as a typed
  family in `GET /v1/owner/control` (one catalog row), not as a new owner-privileged MCP
  tool that re-opens the credential boundary.

So the SLVP ideal keeps `/mcp` owner-bearer rejection permanent and routes all owner
administration through the REST control plane. A future PDPP MCP *server* could expose
owner administration **only** if it did so under a distinct owner-admin transport that
re-asserted the same audit + owner-mediation contract — which would be the REST control
plane reachable over a different framing, not a privilege escalation of the existing
grant-scoped `/mcp`. This change does not pursue that; it records the rejection as
intentional and durable.

### The control catalog is the single source of truth

Every supported/owner-mediated/unsupported action is one row in the shared control-action
catalog (`server/metadata.ts`), projected into both `GET /v1/owner/control` and each
connection's `supported_actions`. This is the construction that prevents the "one-off
endpoint list" the acceptance criteria forbid: an agent never probes for routes, and a
new primitive flips exactly one catalog row from `unsupported` to `supported` in the same
reviewable unit as its proof. Connection creation is therefore **not** four separate
primitives — it is one typed-intent primitive whose `next_step.kind` is selected from the
connector's manifest bindings (`local_collector` proven; `browser_bound`, `api_network`,
`unknown` typed-unsupported with a named missing primitive).

### Connection-scoped vs owner-wide boundary (diagnostics, revoke, delete)

The durable rule the deferred packets all obey: **an owner-agent action addressed by
`connection_id` must affect exactly that one binding.** Owner-wide or device-subsystem
surfaces (`GET /_ref/device-exporters/diagnostics`, `revokeDevice` cascade) are not
sharable under a connection-scoped owner-bearer adapter, because doing so would let an
agent addressing one connection read or mutate sibling connections. That is why
diagnostics, revoke, and delete are `unsupported` today: not "not built yet" in a vague
sense, but "the only existing semantic is broader than one connection, and sharing it
would violate the connection-scoped invariant." Each needs a connection-scoped primitive
(`per-connection health read`, `revokeSourceInstance`, `deleteConnection` with a defined
cascade) before it can be a catalog `supported` row.

### Task disposition against this ideal

Every open task in `tasks.md` ties to exactly one of four states. This is the
"close now / requires new primitive / owner-live gated / not part of SLVP" mapping the
brief requires:

| Task | State | Rationale |
| --- | --- | --- |
| 3.1 owner-agent bearer allowlisting | **close now (supported scope done)** | All shipped control routes are `requireToken`+`requireOwner` gated; the only "remaining" routes (delete/revoke) are typed-unsupported by design, so the supported allowlist is complete. The checkbox stays open only because it was phrased to also cover routes that the design deliberately does not build; reword to scope it to supported families and close. |
| 3.2 share handlers across session/bearer | **close now (supported scope done)** | rename/schedule/run all share session semantics under separate adapters; delete/revoke have no session semantic to share (that is the deferred-primitive finding, not an incomplete share). Same reword-and-close as 3.1. |
| 3.3 non-secret mutation audit | **close now (supported scope done)** | rename/schedule/run emit typed spine evidence with no secret leakage; delete/revoke audit is inapplicable until a destructive primitive exists. Reword to scope to supported mutations and close. |
| 6.1 instance-scoped operations | **close now (supported scope done)** | rename/schedule/run are instance-scoped; diagnostics/delete/revoke are `unsupported` for the connection-scoped-boundary reason above. The instance-scoping invariant is fully realized for every *supported* family. Reword and close. |
| 8.5 live Daisy/Simon smoke | **owner / live gated** | Requires a deployed instance and a real local agent; cannot be closed with unit evidence. Stays open as a residual-risk live gate. |
| delete_connection | **requires new primitive** | needs `deleteConnection` + a defined cascade contract (records/dataset/spine/device source-instance) before any route or catalog flip. |
| revoke_connection | **requires new primitive** | needs `revokeSourceInstance(connectorInstanceId)` distinct from device-scoped `revokeDevice`. |
| inspect_diagnostics | **requires new primitive** | needs a per-connection health read keyed on `connection_id` distinct from owner-wide device-exporter diagnostics. |
| Amazon `enroll_browser_collector` (5.3) | **requires new primitive** | gated on `add-browser-collector-enrollment-primitive`; honest `unsupported` until browser-collector enrollment proves end-to-end. |
| API-connect `open_url` (api_network) | **requires new primitive** | needs a typed owner-agent API-connect intent emitting `open_url`/token-capture with owner-completed authorization; honest `unsupported` until then. |
| `upload_file` modality | **not part of SLVP (no triggering connector)** | no reference connector declares an upload/import binding; stays contract-reserved with no packet until one exists. |
| Linear-style owner-token-over-MCP | **not part of SLVP (by construction)** | see the dedicated subsection above; `/mcp` owner-bearer rejection is permanent. |

The closeable tasks (3.1, 3.2, 3.3, 6.1) are bounded by a wording fix only — their
*supported* scope is fully implemented, validated, and tested on `main`; the open
checkboxes currently conflate "supported scope done" with "deferred-primitive scope not
built." The next implementation lane should reword those four task lines to scope them to
the supported families and check them, leaving delete/revoke/diagnostics tracked solely
through their named deferred packets and the catalog descriptors.

## Risks / Trade-offs

- **Risk: Owner-agent credentials become too powerful by default.** Mitigation: require explicit owner approval during onboarding, publish a clear owner-agent profile, keep `/mcp` rejected, route-allowlist owner-agent mutating operations, and support revoke/status flows.
- **Risk: Agents attempt unsafe provider automation.** Mitigation: model provider login/upload/2FA as owner-mediated next steps and return `unsupported` rather than headlessly attempting money-adjacent or brittle flows.
- **Risk: Existing dashboard/session routes duplicate owner-agent routes.** Mitigation: share operation handlers under separate auth adapters instead of cloning behavior; tests should prove browser owner session and owner-agent bearer reach the same safe operation semantics.
- **Risk: Multi-connection display names remain low quality.** Mitigation: make owner-meaningful display names an acceptance criterion and support rename/update before relying on labels in agent flows.
- **Risk: Connector lifecycle varies widely.** Mitigation: use capability-advertised action sets and typed unsupported responses instead of requiring a uniform implementation path for OAuth, browser, upload, and local collectors.

## Migration Plan

1. Inventory current `/_ref/connectors`, `/_ref/connections`, owner-session middleware, owner-agent bearer guards, CLI owner-agent commands, and dashboard connection actions.
2. Add tests that fail on today's gaps: owner-agent cannot list connection instances with labels, cannot initiate a connection intent, and cannot distinguish Amazon instances from template-only connector output.
3. Factor owner operation handlers so browser sessions and owner-agent bearers can share allowed behavior without sharing auth assumptions.
4. Implement read-only owner-agent control discovery first, then connection intent creation, then safe mutations such as rename/run/schedule.
5. Update CLI/docs/agent guidance and live-smoke against Daisy/Simon style local agents.
6. Deploy, re-run owner-agent live smoke, then confirm a trusted agent can initiate a second Amazon connection flow up to the owner-mediated step without completing provider authentication.

Rollback is route-level: disable the owner-agent control metadata/allowlist while preserving existing owner-agent read access and dashboard session control.

## Open Questions

- ~~Should the final public path remain `/_ref/*`, or should owner-agent admin get a cleaner `/v1/owner/*` route family while `/_ref/*` remains reference/debug-oriented?~~ **Resolved (realized in code):** owner-agent administration ships under the cleaner `/v1/owner/*` family (`GET /v1/owner/control`, `/v1/owner/connections*`, `/v1/owner/connectors*`); `/_ref/*` remains the reference/debug owner-session surface that the `/v1/owner/*` handlers share semantics with under a separate bearer auth adapter. Task 1.4 records this; the route inventory above confirms it. No further decision needed.
- ~~Should owner-agent onboarding mint separate scopes/profiles for `read`, `manage_connections`, `manage_schedules`, and `manage_subscriptions`, or is a single trusted-owner profile acceptable for the reference SLVP?~~ **Resolved:** the reference SLVP uses a **single trusted-owner profile** authorized by `requireToken` + `requireOwner`; there are no per-family owner scopes in the reference, and the archived `add-trusted-owner-agent-onboarding` capability already committed to a single owner-level profile. The construction that keeps this safe is not scope subdivision but the control catalog: each action family carries its own `supported`/`owner_mediated`/`unsupported` status, and destructive families stay `unsupported` until a connection-scoped primitive exists. Per-family scopes can be introduced later without a credential-model break if a deployment needs to delegate a *subset* of admin authority, but that is a future refinement, not an SLVP requirement. The `reference-agent-access-workflow` "control action is not granted" scenario already specifies the typed-authorization-error shape such a future subdivision would reuse.
- ~~Which connection lifecycle operations should ship first for browser-bound connectors such as Amazon versus local collectors such as Claude Code/Codex?~~ **Resolved:** local-collector initiation (`enroll_local_collector`) ships first because it reuses a proven primitive; browser-bound initiation (Amazon) is `unsupported` until the browser-collector enrollment primitive ships (see "Resolved: Amazon second-account implementation packet" above).
- ~~Do the remaining unsupported connection-creation modalities (API/network OAuth, upload/import) and per-connection diagnostics need their own named packets, or can they stay inline `unsupported`?~~ **Triaged:** each now has a named deferred packet with a precise missing-primitive description and a proof-before-flip gate — API/network OAuth ("Deferred: API/network connection initiation"), per-connection diagnostics ("Deferred: connection-scoped diagnostics"). Upload/import gets no packet because no reference connector declares an upload/import binding; `upload_file` stays purely contract-reserved until such a connector exists. This keeps every modality in the scope either proven, or `unsupported` with a reviewable construction packet — none silently absent.
