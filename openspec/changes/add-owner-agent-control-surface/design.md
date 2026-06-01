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

## Resolved: Amazon second-account (browser-collector) implementation packet

The Amazon second-account flow is `unsupported` until the **browser-collector enrollment primitive** ships. This is the precise next implementation packet (resolves Open Question 3 for browser-bound connectors):

1. A `browser_collector` source kind distinct from `local_device`, so an owner can have a local collector that drives a real browser session for a browser-bound connector and the instance binding records that it is browser-collected, not filesystem-read.
2. Binding-aware enrollment gating at `POST /_ref/device-exporters/enrollment-codes` (and the owner-agent intent route) keyed on the manifest `runtime_requirements.bindings`: a `browser` binding must enroll as `browser_collector`, a `filesystem` binding as `local_device`. Today the enroll path hardcodes `source_kind: local_device` and does no binding-aware validation.
3. Committed proof (test + fixture) that a local collector runs a browser connector (Amazon) end-to-end and ingests via the device-exporter path. Only with that proof may the intent route flip Amazon from `unsupported` to `enroll_local_collector` (or a new `enroll_browser_collector`) and add the Amazon second-account acceptance coverage (tasks 5.3, 8.5).

Until then the route's honest output for Amazon is `unsupported` with this gap named in `next_step.reason`.

## Resolved: destructive owner-agent control (delete / revoke / run-now) stays unsupported until a connection-scoped primitive ships

The destructive control tranche (connection delete, credential revoke, run-now) was audited against the rule that an owner-agent route may only share **existing, tested, owner-scoped** semantics, and may not introduce new destructive semantics without a spec delta. The audit (`tmp/workstreams/ri-owner-agent-destructive-control-v1-report.md`) found no safe-by-construction sharing path for any destructive family, so all three remain typed-`unsupported`/`owner_mediated` in the control catalog (`server/metadata.ts`). The precise reasons:

1. **`delete_connection` → `unsupported`.** The connector-instance store (`server/stores/connector-instance-store.js`) has **no delete method** at all — only `updateStatus`, `setDisplayName`, and read/resolve operations. No browser owner-session route deletes a connection either. There is no existing semantic to share; implementing one would require defining what a connection delete cascades to (records, dataset, spine correlations, device source-instance rows) — a durable data-loss contract that needs its own spec delta before any code.

2. **`revoke_connection` → `unsupported`.** The only credential-revoke primitive in the reference is **device-scoped**: `deviceExporterStore.revokeDevice(deviceId)` (`server/routes/ref-device-exporters.ts` `POST /_ref/device-exporters/:deviceId/revoke`), whose store method soft-revokes the device row **and cascades to every `device_source_instances` row under that `device_id`**. A `connection_id` (== `connector_instance_id`) maps to one source instance on one device, but a single device can back multiple connections. Reusing `revokeDevice` from a connection-scoped owner-agent route would let an agent addressing one `connection_id` silently revoke unrelated sibling connections sharing the device — broader, **new** destructive semantics, not the same semantics shared under a different auth adapter. The missing primitive is a **connection-scoped credential revoke** (`revokeSourceInstance(connectorInstanceId)` or equivalent) with its own committed test, distinct from `revokeDevice`. Until that exists, the owner-agent surface names device-exporter revoke as owner-session-only and does not expose a connection-scoped revoke.

3. **`run_connection` → `owner_mediated`.** Run-now exists on the browser owner-session surface but is non-destructive (it triggers a collection run, not data loss) and out of this destructive tranche's scope. It stays `owner_mediated` in the catalog; exposing it to owner-agent bearers is a separate, lower-risk lane that can proceed on its own without the data-loss analysis above.

Grant-package revoke (`POST /_ref/grant-packages/:id/revoke`, cascading soft-revoke across grant_packages/tokens/members/refresh_tokens) is intentionally **not** mapped to any owner-agent connection family: it revokes *client grant access*, not a connection binding, and an owner-agent revoking grants — including potentially its own issuing grant — is exactly the "owner-agent credentials become too powerful by default" risk this design mitigates. It remains owner-session only.

The catalog already advertises all three families honestly and typed per the "Owner-agent control SHALL advertise and enforce per-connection actions" requirement (actions are advertised "when available", unavailable ones "marked unsupported with a typed reason"). No spec requirement mandates these routes exist; the spec requires honest advertisement, which is in place. A future lane that lands a connection-scoped delete or revoke primitive (with cascade semantics and committed proof) flips the corresponding catalog descriptor from `unsupported` to `supported` without a contract break.

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

- Should the final public path remain `/_ref/*`, or should owner-agent admin get a cleaner `/v1/owner/*` route family while `/_ref/*` remains reference/debug-oriented?
- Should owner-agent onboarding mint separate scopes/profiles for `read`, `manage_connections`, `manage_schedules`, and `manage_subscriptions`, or is a single trusted-owner profile acceptable for the reference SLVP?
- ~~Which connection lifecycle operations should ship first for browser-bound connectors such as Amazon versus local collectors such as Claude Code/Codex?~~ **Resolved:** local-collector initiation (`enroll_local_collector`) ships first because it reuses a proven primitive; browser-bound initiation (Amazon) is `unsupported` until the browser-collector enrollment primitive ships (see "Resolved: Amazon second-account implementation packet" above).
