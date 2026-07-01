## Context

The reference already has adjacent pieces of the desired model:

- `reference-connection-health` treats credential validity, runtime bindings, local-device availability, and owner attention as typed evidence before projection.
- `reference-run-assistance` separates progress posture, owner action, response obligation, attachments, and sensitivity.
- `polyfill-runtime` already says scheduled browser runs that depend on reusable owner-authenticated state are session-reuse-only unless a later accepted policy permits background auth repair.
- The refresh corpus states that connectors are Collection Profile runtimes, not PDPP Core, and that browser automation is a polyfill for missing portability APIs.

The missing boundary is which semantics belong in a connector manifest versus which belong in runtime/connection evidence.

## Decision

Manifests describe stable capabilities and policy. They do not describe current auth/session state.

Runtime evidence describes what happened on this connection now: stored credential rejected, provider session unavailable, browser page already logged in, owner challenge required, local collector outbox stalled, provider archive pending, coverage gap recoverable, and similar observed facts.

Connection health owns the durable projection: whether the existing connection is ready, repair-required, repair-in-progress, self-healing, degraded, or healthy. Run history is evidence for the connection; it is not the owner-facing object to repair.

The platform owns a bounded owner-action protocol so dashboards, CLI, owner-agent, schedules, and audits can agree on what the owner can do. Connectors choose one of those bounded actions only after observing runtime evidence. Provider-specific instructions stay inside the action's safe metadata or run timeline, not in manifest vocabulary.

## Bounded Owner-Action Surfaces

The implementation should converge on a small set of action surfaces:

- rotate or provide a stored secret;
- complete provider authorization or reauthorization;
- operate a browser session;
- provide a file or export artifact;
- repair or run a local collector;
- review a coverage gap or retry a recoverable gap;
- wait for the system/provider/backoff when no owner action is useful.

These are product-surface classes, not provider-state taxonomies. They are sufficient to choose safe UI, audit, scheduling, and owner-agent behavior without embedding provider-specific page knowledge in the manifest schema.

## Manifest Semantics To Keep

Keep manifest semantics that are stable across runs:

- source identity and streams;
- setup modality or supported setup mechanisms;
- required runtime bindings such as browser, filesystem, provider authorization, local device, or import artifact;
- whether unattended background runs are allowed and any safe scheduling cadence;
- coarse repair mechanisms the connector can support.

## Manifest Semantics To Avoid

Avoid manifest semantics that claim live state or provider-specific page state:

- "the owner is currently logged in";
- "the current browser profile is reusable";
- "this run currently needs a password";
- "this provider page currently wants push approval";
- "this source is healthy enough to run";
- "this failure is transient versus credential-broken" before runtime evidence exists.

Those facts change per connection and per run. Encoding them statically makes the manifest expensive, wrong, and hard to generalize to marginal connectors.

## Compatibility Position

Existing `capabilities.refresh_policy` hints remain reference/runtime metadata. The `assisted-after-owner-auth` posture is a compatibility hint, not a durable endpoint-specific auth lifecycle model. New implementation work should route through stable mechanism declarations plus evidence-derived connection repair state rather than adding provider-specific variants to that hint.

## Why This Is The SLVP-Aligned Boundary

The prior-art pattern is consistent:

- Plaid repairs an existing Item through update mode and clears the owner prompt when repair is proven.
- Nylas treats `invalid_grant` as a grant/connection repair problem, not a retry-the-run problem.
- Zapier and Airbyte separate connector authentication configuration from each user's current credential/session state.

For PDPP, the corresponding design is connection-scoped repair over observed evidence. It is not a universal connector UI free-for-all, and it is not a manifest schema that tries to model every provider's live auth flow.

The confidence is high for this boundary because it matches the local corpus, the reference's existing condition model, and mature connector platforms. The exact field names and migration path still require implementation proof before being called final.

## Acceptance Checks

- A password reset, invalid stored token, expired browser session, or revoked provider grant changes connection evidence without changing the connector manifest.
- An unattended scheduled run that cannot proceed without owner action records repair-required evidence and does not open a browser handoff or prompt loop.
- An owner-started repair uses the existing connection and closes only after evidence proves repair, not because an old owner-action row aged out.
- Dashboards, Runs, Sources, CLI, and owner-agent surfaces use the same required-action classification for whether owner action is needed.
- A connector-specific provider instruction can be rendered inside a bounded action, but no provider-specific instruction becomes a manifest enum or durable cross-connector contract.
- Browser-session repair captures reusable session state when supported and never silently stores passwords typed into the provider page.

## Risks

- A too-small action protocol would force connectors to hide important distinctions in copy strings. Mitigation: keep the bounded surfaces coarse but allow typed safe metadata inside each action.
- A too-large action protocol would recreate provider-specific UI taxonomy in the platform. Mitigation: require new actions to be product-surface classes that multiple connector families can use.
- Treating a stale owner-action record as closed by age alone can hide unresolved repair. Mitigation: close repair through satisfied/canceled/superseded evidence; age can suppress stale prompts but not prove health.
- Moving too much into connector code would make dashboards, owner agents, and audit logs inconsistent. Mitigation: connectors select from bounded actions; the platform renders and schedules from the shared contract.
