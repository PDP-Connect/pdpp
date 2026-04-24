## Context

The reference server has a placeholder owner-auth session gate controlled by `PDPP_OWNER_PASSWORD`. It already protects hosted owner approval pages when enabled, while preserving open local-dev behavior when disabled.

The dashboard now uses reference-only `_ref` mutation routes for connector runs, schedules, and run interactions. Dashboard server actions call `requireDashboardAccess()`, but the HTTP routes themselves still accept direct unauthenticated requests when owner auth is enabled. That leaves the reference control plane weaker than the dashboard UI that fronts it.

## Goals / Non-Goals

**Goals:**

- Require a valid owner session on `_ref` mutation routes when owner auth is enabled.
- Preserve unauthenticated `_ref` local-dev behavior when owner auth is disabled.
- Keep `_ref` read routes available for inspection, dashboards, scripts, and tests.
- Reuse the existing owner-auth placeholder rather than adding a second auth model.

**Non-Goals:**

- No public PDPP API change.
- No OAuth scope or bearer-token requirement for `_ref` routes.
- No full user-account system, API key system, or CSRF redesign.
- No change to submitted run-interaction persistence rules.

## Decisions

1. Gate `_ref` mutations with the existing owner session middleware.

   Rationale: `ownerAuth.requireOwnerSession` already implements the intended placeholder policy and returns JSON `401 owner_session_required` for non-HTML callers. Reusing it keeps `/owner/login`, hosted approval pages, dashboard server fetches, and `_ref` mutations on one trust boundary.

2. Protect mutation routes, not read routes.

   Rationale: `_ref` read surfaces are currently treated as reference-designated inspection substrate. The immediate security hole is direct remote triggering of runs, schedule changes, and interaction responses. Read-route hardening is a larger policy question and should not be mixed into this narrow fix.

3. Preserve open behavior when `PDPP_OWNER_PASSWORD` is unset.

   Rationale: the reference implementation intentionally runs open in local development unless the owner explicitly enables the placeholder gate. This change should make enabled auth coherent without turning every local smoke test into a login setup problem.

4. Keep dashboard forwarding via the owner-session cookie.

   Rationale: the dashboard already forwards the owner-session cookie to the reference server via `withOwnerSessionCookie()`. Tightening the server route should not require dashboard-specific credentials or a new private header.

## Risks / Trade-offs

- Tests or scripts that call `_ref` mutation routes with owner auth enabled will now receive `401` unless they sign in first. Mitigation: update coverage to prove both unauthorized rejection and authenticated success.
- `_ref` read routes remain unauthenticated when owner auth is enabled. Mitigation: document this as intentionally out of scope; revisit with a separate OpenSpec change if the reference control-plane trust boundary expands.
- This does not add CSRF tokens to `_ref` mutations. Mitigation: owner-session cookies are `SameSite=Lax`, dashboard actions are server-side, and this change is a local reference hardening step rather than a production auth design.
