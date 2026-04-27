# `_ref` Read Authentication Posture

Status: sprint-needed
Owner: reference-implementation
Created: 2026-04-27
Updated: 2026-04-27
Related: `openspec/specs/reference-implementation-architecture/spec.md` (Reference-only surfaces are explicit; Reference control-plane mutations require owner session when enabled), `openspec/changes/harden-reference-auth-surfaces/` (sibling change deliberately scoped *out* of this question), `tmp/workstreams/worktree-bughunt-security-privacy-report.md`

## Question

Reference-instance `_ref/*` **read** routes are currently unauthenticated. The current architecture spec explicitly preserves that — reads are stable inspection substrate, mutations are owner-gated. Bug-hunt v2 surfaced the read-side exposure as high-stakes for any deployment beyond loopback. Should the durable read posture stay open, become loopback-only, become owner-gated, or split into a public-safe subset and an owner-only subset?

## Context

### Current route inventory (commit `5b887b5`)

Reads (all unauthenticated today; source: `reference-implementation/server/index.js`):

| Route | Line | Spec coverage today | Sensitivity |
| --- | --- | --- | --- |
| `GET /_ref/traces` | 2018 | listed in spec | medium — exposes request_id, grant_id, run_id, client_id |
| `GET /_ref/grants` | 2033 | listed in spec | medium — enumerates all grants on instance |
| `GET /_ref/runs` | 2048 | listed in spec | medium — enumerates all runs |
| `GET /_ref/search` | 2068 | listed in spec | medium — id-jump helper |
| `GET /_ref/traces/:traceId` | 2083 | listed in spec | medium — full timeline |
| `GET /_ref/grants/:grantId/timeline` | 2094 | listed in spec; `harden-reference-auth-surfaces` redacts `token_id` here | high pre-redact / medium post-redact |
| `GET /_ref/runs/:runId/timeline` | 2105 | listed in spec; same redaction | high pre-redact / medium post-redact |
| `GET /_ref/dataset/summary` | 2161 | listed in spec | low–medium — aggregate counts/freshness |
| `GET /_ref/connectors` | 2170 | NOT in spec read list | medium — connector_ids, freshness, schedules |
| `GET /_ref/connectors/:connectorId` | 2179 | NOT in spec read list | medium — manifest excerpt + stream summaries |
| `GET /_ref/approvals` | 2189 | NOT in spec read list | medium — pending approvals (presence reveals owner intent) |
| `GET /_ref/records/timeline` | 2198 | NOT in spec read list | medium — record-level activity |
| `GET /_ref/schedules` | 2222 | NOT in spec read list | medium — schedule + recommended-policy state |
| `GET /_ref/connectors/:connectorId/schedule` | 2231 | NOT in spec read list | medium |
| `GET /_ref/deployment` | 2247 | NOT in spec read list | medium — diagnostics (secret redaction is enforced inside `collectDeploymentDiagnostics`) |

Mutations (already gated by `ownerAuth.requireOwnerSession`; preserved by spec):

| Route | Line |
| --- | --- |
| `POST /_ref/runs/:runId/interaction` | 2122 |
| `POST /_ref/connectors/:connectorId/run` | 2268 |
| `POST /_ref/connectors/:connectorId/schedule` | 2284 |
| `POST /_ref/connectors/:connectorId/schedule/pause` | 2304 |
| `POST /_ref/connectors/:connectorId/schedule/resume` | 2319 |
| `PUT /_ref/connectors/:connectorId/schedule` | 2335 |

Two facts about the inventory the current spec does not yet capture:

1. The set of durable read routes the spec lists is now smaller than what the reference actually serves. Six reads (`connectors*`, `approvals`, `records/timeline`, `schedules*`, `deployment`) shipped after the spec list was last updated.
2. `/_ref/deployment` is operator-only by design (the comment in `server/index.js:2244` says so) and lives in the same flat namespace as routes that the dashboard already treats as inspection substrate. The current posture treats them all the same.

### Consumer inventory

Three callers depend on `_ref` reads:

1. **Next dashboard server components** (`apps/web/src/app/dashboard/lib/ref-client.ts`). Already gates itself with `requireDashboardOwnerSession` (`apps/web/src/app/dashboard/lib/owner-token.ts:186`) and forwards the owner-session cookie on every `_ref` fetch via `withOwnerSessionCookie` (`owner-token.ts:166`). When `PDPP_OWNER_PASSWORD` is unset, the cookie helper is a no-op and reads remain open; the dashboard itself remains open in that mode too.
2. **CLI commands** (`cli/commands/{grant,run,trace,seed}.js`). Read `_ref/grants/:id/timeline`, `_ref/runs/:id/timeline`, `_ref/traces/:id`, and `_ref/dataset/summary` with no Authorization header and no cookie. The CLI runs alongside the AS process — assumed loopback.
3. **Test suites** (`reference-implementation/test/control-actions.test.js`, `security-auth-surfaces.test.js`, etc). All in-process or loopback.

### Deployment shape inventory

| Deployment | Today | Risk surface |
| --- | --- | --- |
| Local dev (`pnpm --dir reference-implementation start`) | `PDPP_OWNER_PASSWORD` unset; AS binds loopback | None as long as host is trusted |
| Docker / local-device | compose binds `127.0.0.1` (per audit P1 #5 follow-up); password may or may not be set | Anything reaching the AS port can enumerate grants/runs/timelines |
| Hosted demo / internal review | publicly reachable; password should be set | Same as above; current spec says reads stay open even with password set |
| Server-rendered dashboard call | originates from dashboard process; can carry owner-session cookie | None new |
| Machine/operator diagnostics (CLI / `_ref/deployment` / `curl` for a runbook) | typically loopback or owner shell | Loopback assumption is implicit, not enforced |

### What changed

Pre-bug-hunt, the spec assumed `_ref` reads were inspection-only and operator-trusted. Three things shifted that:

- The reference now serves operator-control-plane data (`/_ref/connectors`, `/_ref/schedules`, `/_ref/deployment`) on the same prefix as inspection reads. Some of those carry information that is meaningful to a competitor or attacker who reaches the port (which connectors are configured, when they last ran, whether interaction is pending, deployment diagnostics).
- `harden-reference-auth-surfaces` showed that even narrow reads can leak credentials (`token_id`). The redaction at the response boundary closes that case but does not change the underlying "anyone-on-port can enumerate" property.
- A future hosted/internal-review deployment is now an explicit goal, not a hypothetical. That moves the AS port from "trusted local" to "boundary-exposed" without a corresponding spec change.

## Stakes

- **Security**: enumeration of grants/runs/timelines is itself a leak even after `token_id` redaction. It enables grant-id discovery, which feeds the (post-`harden-reference-auth-surfaces`) revoke endpoint. Until that change lands, it also enables grant revocation by anyone reachable on the port.
- **Operator UX**: gating reads by owner session would not break the dashboard (it already forwards the cookie). It would break the loopback CLI and any `curl`-based runbook unless we also accept an owner bearer or add a loopback bypass.
- **Spec coherence**: the spec's read list is already out of date. Whatever posture we land on, the spec needs to enumerate the *current* read surface, not a smaller historical subset.
- **Deployment-mode confusion**: the same code runs in four deployment modes today with no posture per mode. "Open by default, deploy-time advice in docs" has empirically failed (the audit found docker-compose host-binding regressed silently).

## Options Considered

### A. Status quo: open `_ref` reads, document deployment boundaries harder

- **Behavior**: keep all `_ref/*` reads unauthenticated. Add a runbook section that says "do not expose the AS port off-loopback unless you accept enumeration."
- **Pros**: zero code/test churn. CLI, dashboard, and tests keep working unchanged. Matches the current spec.
- **Cons**: relies on operators reading and applying deployment advice consistently. Already silently failed once (docker-compose binding). Unsuitable for hosted/internal-review.
- **Verdict**: insufficient for the new deployment shape.

### B. Loopback-only reads (default deny non-loopback)

- **Behavior**: middleware before `_ref/*` checks `req.socket.remoteAddress`/`X-Forwarded-For` and rejects non-loopback requests unless an explicit override is set (`PDPP_REF_READS_PUBLIC=1`) or owner-session cookie is present.
- **Pros**: hard default that survives operator misconfiguration. Doesn't require dashboards or CLIs to authenticate for the common loopback case.
- **Cons**: forwarded-for handling is finicky behind reverse proxies. The Next dashboard makes server-side fetches *to* the AS — already loopback in the same container today, but a future split deployment would suddenly break. Also: this is a spatial posture, not an identity posture; it tells you nothing about *who* asked.
- **Verdict**: a useful additional belt for ops, but not a substitute for identity-based gating.

### C. Owner-gate all `_ref` reads (when password configured)

- **Behavior**: extend the existing "Reference control-plane mutations require owner session when enabled" pattern to reads. `_ref/*` reads pass through `requireOwnerSession`. When `PDPP_OWNER_PASSWORD` is unset, the gate is a no-op (preserving current local-dev behavior). When set, every `_ref` read requires the owner-session cookie or an owner bearer.
- **Pros**: identity-based, symmetric with the existing mutation rule, already-tested middleware. The Next dashboard already forwards the cookie — zero code change required there. Ops can opt in by setting the password (which the audit says they should be doing anyway).
- **Cons**: CLI calls at `cli/commands/{grant,run,trace,seed}.js` would need an owner credential when password is set. That's a real but bounded change: the CLI already understands owner bearers (used elsewhere) and can send them to `_ref` reads. Tests against a password-enabled instance would need to obtain a session.
- **Verdict**: best fit for the architecture today — same pattern as mutations, no dashboard regression, easy to test, easy to reason about.

### D. Split: public-safe reads vs owner-only reads

- **Behavior**: identify a small subset of `_ref` reads that are genuinely safe to expose (e.g. nothing) and gate the rest. Or: define a third category between "PDPP protocol" and "operator-only" for the dashboard substrate.
- **Pros**: theoretically minimal blast radius.
- **Cons**: there is no `_ref` read that is *useful* to an unauthenticated caller. `dataset/summary` aggregates per-instance state. Listings enumerate object ids. Even `/_ref/search` is an id-jump tool that presumes you should be able to discover ids. The split costs design effort with no observable benefit because the public-safe set turns out to be empty.
- **Verdict**: rejected — the subset is empty in practice, and a split adds confusion without security value.

## Recommendation

Adopt Option C with a documented loopback fallback for the CLI:

1. **Spec change**: extend the "Reference control-plane mutations require owner session when enabled" requirement to *both* mutations and reads of `_ref/*`. Preserve the open local-dev behavior when `PDPP_OWNER_PASSWORD` is unset.
2. **Spec list reconciliation**: update the durable `_ref` read list in `openspec/specs/reference-implementation-architecture/spec.md` to enumerate the current shipped reads (`connectors`, `connectors/:id`, `approvals`, `records/timeline`, `schedules`, `connectors/:id/schedule`, `deployment`) so the spec matches reality.
3. **CLI**: when password is set, the CLI SHALL send an owner bearer (already supported via the device flow) on `_ref` calls. When unset, no change.
4. **Documentation**: in the docker/ops runbook, restate that hosted deployments MUST set `PDPP_OWNER_PASSWORD`, and that this now also gates inspection reads.
5. **Optional belt-and-suspenders**: add a separate, narrow loopback bypass for `/_ref/deployment` only, since it is genuinely operator-shell-only and already redacts secrets internally. This is optional and can be deferred.

This recommendation keeps the existing shape (the same middleware, the same env var, the same disabled-mode contract) and only widens its scope from mutations to reads. It does not introduce a new auth concept.

## Dashboard compatibility

Verified by code inspection:

- `apps/web/src/app/dashboard/lib/ref-client.ts:206` calls `withOwnerSessionCookie({ cache: "no-store" })` on every `_ref` fetch.
- `apps/web/src/app/dashboard/lib/owner-token.ts:166` reads the dashboard request's `pdpp_owner_session` cookie and forwards it to the AS.
- `apps/web/src/app/dashboard/lib/owner-token.ts:186` (`requireDashboardOwnerSession`) gates the dashboard pages themselves; the dashboard refuses to render without a session when password is enabled.

Therefore: gating `_ref` reads with `requireOwnerSession` does **not** require dashboard changes. Dashboard pages already authenticate before any server-side `_ref` fetch is issued, and the cookie is forwarded as expected. Test compatibility is the same: in local-dev (no password) the gate is a no-op; in tests that exercise password-enabled mode, the existing test fixtures for `harden-reference-auth-surfaces` already sign in to obtain the session.

## What should be implemented next

This design note recommends, but does not implement, a posture change. Implementation should land as a separate OpenSpec change after owner review, structured as:

1. **OpenSpec change `gate-ref-reads-when-owner-auth-enabled`**:
   - Spec delta in `reference-implementation-architecture` modifying "Reference-only surfaces are explicit" to enumerate the full current read list, and modifying "Reference control-plane mutations require owner session when enabled" → "Reference control-plane reads and mutations require owner session when enabled" (or split into two requirements with shared scenarios).
   - Tasks: route-gate sweep on `_ref/*` reads, CLI owner-bearer plumbing, test fixture for password-enabled `_ref` read, dashboard regression coverage (verify cookie forwarding still works when password is set).
   - Acceptance check: `curl $AS/_ref/grants` with `PDPP_OWNER_PASSWORD` set returns 401; with the owner session cookie returns 200.
2. Land it after `harden-reference-auth-surfaces` is merged so the redaction and the gating are not entangled.
3. After merge: archive this design note as `decided-promote` with a link to the change.

## Promotion Trigger

This note becomes an OpenSpec change when an owner approves the recommendation. The decision changes a security boundary documented in `reference-implementation-architecture` — promotion is required before implementation per `AGENTS.md`.

## Decision Log

- 2026-04-27 — Captured. Status: `sprint-needed`. Pending owner review.
