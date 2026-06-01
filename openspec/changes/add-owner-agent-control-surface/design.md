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
- Which connection lifecycle operations should ship first for browser-bound connectors such as Amazon versus local collectors such as Claude Code/Codex?
