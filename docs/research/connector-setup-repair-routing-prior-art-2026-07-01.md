# Connector setup and repair routing prior art

Date: 2026-07-01
Status: research corpus
Scope: connector manifest semantics, owner repair flows, and the platform-vs-connector routing boundary for the reference implementation

## Question

Should a connector manifest tell the reference implementation enough to route setup and repair to a fixed product surface, or should connector/runtime code return the concrete next action after observing the source?

## Sources

- Plaid, "Link - Update mode", retrieved 2026-07-01: https://plaid.com/docs/link/update-mode/
- Zapier, "Authentication", retrieved 2026-07-01: https://docs.zapier.com/integrations/build/auth
- Airbyte, "Authentication", retrieved 2026-07-01: https://docs.airbyte.com/platform/connector-development/connector-builder-ui/authentication
- Nylas, "Fix OAuth invalid_grant token errors", retrieved 2026-07-01: https://developer.nylas.com/docs/cookbook/use-cases/build/fix-invalid-grant-errors/

Related local corpus:

- `docs/research/connector-credential-session-repair-prior-art-2026-07-01.md`
- `docs/connector-health-state-research-2026-05-15.md`
- `design-notes/schedule-manual-attention-prior-art-2026-05-21.md`
- `design-notes/2026-05-16-run-automation-assistance-and-capability-gaps.md`
- `design-notes/connection-first-collection-identity-2026-05-18.md`
- `design-notes/connection-lifecycle-and-local-collector-recovery-2026-06-01.md`

## Findings

### 1. Mature products make repair connection-scoped, not run-scoped

Plaid's update mode repairs an existing Item after errors such as `ITEM_LOGIN_REQUIRED`, pending expiration, or pending disconnect. The app asks the user to return to a scoped repair flow, and Plaid can present a reduced re-authentication path requiring only the necessary user input. Plaid also has a `LOGIN_REPAIRED` signal so host apps can stop prompting after an Item is fixed elsewhere.

Nylas frames OAuth `invalid_grant` similarly: a previously working grant later becomes invalid because of password changes, security resets, revocation, expiry, or app-credential changes. The recovery path is re-authentication of the same grant, not retrying the same dead credential.

Implication for PDPP RI: repair state should attach to the `connection` / `connector_instance_id`. A failed run can be evidence, but the owner-facing object is the connection.

### 2. Connector definitions should describe stable auth mechanisms, not current auth state

Airbyte's connector builder separates connector authentication configuration from the user's secret values. The connector definition chooses an auth method, while end users provide credentials during source setup and Airbyte stores those credentials separately.

Zapier's platform also treats authentication scheme and authentication test as integration metadata, while each user authenticates a connection. Zapier emphasizes verifying the account authentication via a test call and supports multiple account connections for one app.

Implication for PDPP RI: manifest setup semantics should declare stable mechanisms such as provider authorization, static secret, browser-bound session, local collector, or manual upload. They should not claim that a session or credential is currently valid.

### 3. The platform still needs a constrained owner-action protocol

A pure connector-owned UI would let every connector invent its own setup and repair product surface. That may generalize to arbitrary sources, but it weakens secret-handling boundaries, owner-agent parity, auditability, and consistent status/action semantics.

The stronger pattern is: the platform owns a small constrained action protocol; connector/runtime code can choose the specific action after observing evidence.

Candidate action surfaces:

- provide or rotate a stored secret
- provider authorization / reauthorization
- operate a browser session
- provide a file or artifact
- run or repair a local collector
- review a coverage gap
- wait or retry

Provider-specific instructions such as approving a push notification, entering an OTP, selecting a file type, or clicking a provider button belong to runtime evidence inside the bounded action, not to the manifest schema.

### 4. Current corpus covers adjacent pieces, not the exact routing decision

The existing corpus is strong on connection-first identity, schedule/manual-attention policy, health status, and credential/session repair lifecycle. It does not yet contain a focused design artifact that adjudicates platform-routed setup/repair versus connector-routed setup/repair and names the final manifest schema boundary.

## Conclusion

The evidence supports this direction, but not yet a final >95% SLVP-ideal claim:

- Manifest semantics should remain stable capability/policy declarations.
- Runtime evidence should own current auth/session truth.
- Connection lifecycle should own `ready`, `repair_required`, `repair_in_progress`, and `verified_ready`.
- The platform should expose a small constrained owner-action protocol.
- Connectors should emit specific next actions and provider instructions only after observing source state.

Confidence today: high for the broad boundary, below >95% for the exact schema vocabulary and migration path. A focused design note or OpenSpec change should settle the routing boundary before changing durable manifest semantics.
