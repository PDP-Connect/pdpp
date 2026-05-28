## Decision

Adopt identity-based owner gating for all reference `_ref/*` reads when placeholder owner auth is enabled.

Current behavior makes mutation routes owner-only but leaves read routes open. The distinction is no longer defensible: the read surface now includes operational control-plane state, not only low-risk trace inspection. The dashboard already forwards the owner-session cookie to the reference server, so the primary UI path is compatible with gating. Local development stays unchanged because `requireOwnerSession` is a no-op when `PDPP_OWNER_PASSWORD` is unset.

## Options Considered

### Option A: Keep reads open and document the boundary

Rejected. We already saw deployment posture drift; documentation alone is not a sufficient control for a surface that enumerates grants, runs, schedules, approvals, connectors, and deployment diagnostics.

### Option B: Loopback-only reads

Rejected as the primary control. Loopback checks are brittle behind reverse proxies and split deployments, and they answer "where did the request appear to come from" rather than "is this the owner".

### Option C: Owner-gate reads when owner auth is enabled

Accepted for this change. It reuses the existing owner-session model, aligns reads with mutations, preserves local-dev behavior, and is easy to verify with black-box route tests.

### Option D: Split public-safe and owner-only `_ref` reads

Rejected for now. No current `_ref` read is useful to unauthenticated callers. Even aggregate summaries and id-jump helpers leak instance state.

## Scope

In scope:

- Gate all current `GET /_ref/*` read routes when owner auth is enabled.
- Keep all current `GET /_ref/*` read routes open when owner auth is disabled.
- Ensure the Next dashboard still works by forwarding the owner session.
- Ensure CLI/operator reads either preserve local-dev behavior or send owner credentials when needed.
- Add tests for unauthenticated rejection and authenticated success.
- Update reference architecture docs/spec deltas to list the current `_ref` read surface.

Out of scope:

- Replacing placeholder owner auth with production-grade auth.
- Hashing stored bearer tokens at rest; that remains tracked under `harden-reference-auth-surfaces`.
- Changing public `/v1/*` resource-server auth.
- Adding loopback bypasses.
- Changing `_ref` route payload shapes except for auth failures.

## Acceptance Checks

- With `PDPP_OWNER_PASSWORD` configured, `GET /_ref/grants` without owner credentials returns `401 owner_session_required`.
- With `PDPP_OWNER_PASSWORD` configured, the same read with a valid owner session succeeds.
- With `PDPP_OWNER_PASSWORD` unset, existing local-dev `_ref` reads continue to work unauthenticated.
- Dashboard pages that consume `_ref` reads still render when the owner is logged in.
- CLI timeline/summary reads continue to work in local-dev mode and have an owner-credential path for password-enabled mode.
