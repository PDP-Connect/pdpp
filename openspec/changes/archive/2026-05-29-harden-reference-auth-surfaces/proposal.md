## Why

The overnight bug-hunt audit on 2026-04-27 (`tmp/workstreams/worktree-bughunt-security-privacy-report.md`) found three concrete, reproducible reference-AS auth defects that violate owner-stated security requirements:

1. `_ref/grants/:grantId/timeline` and `_ref/runs/:runId/timeline` return `token_id` from `spine_events` verbatim. `token_id` is the live opaque bearer string used for introspection — it is, today, the token. The two timeline routes are unauthenticated, so any caller that can reach the AS port can lift a still-valid bearer.
2. `POST /grants/:grantId/revoke` is unauthenticated. Combined with the `_ref/grants` enumeration above, anyone reachable on the AS port can revoke any grant on the instance. The reference's own `pdpp-data-access` skill documents this as a feature.
3. `apps/web/src/app/dashboard/lib/owner-token.ts:19` falls back to the literal owner-name `"the owner"` for the dashboard's owner subject id when no env override is set. That is committed personal data and a direct violation of "no personal info in committed code."

These are all "reference-only surface" gaps, not changes to public PDPP wire shape. The fix is narrow: redact `token_id` at the read boundary, gate revoke with either an owner credential or the grant's own client bearer, replace the personal subject-id default with the canonical `owner_local`, and add clickjacking response headers to the AS hosted UI.

## What Changes

- `_ref/grants/:grantId/timeline` and `_ref/runs/:runId/timeline` SHALL project two specific fields out of every event before it leaves the reference: the top-level `token_id`, and the `object_id` when `object_type === 'token'` (because `token.issued` events use the bearer string as both fields). The projection does NOT traverse `data` payloads, does NOT match by field-name pattern, and does NOT inspect value shape — that wider redaction is deliberately deferred to the storage-migration tranche. Storage keeps the columns for now; we redact at response time. This avoids a schema migration in the same patch and keeps the existing internal correlation paths intact.
- `POST /grants/:grantId/revoke` SHALL require either:
  - a valid owner bearer token (`pdpp_token_kind === 'owner'`), or
  - a valid client bearer token (`pdpp_token_kind === 'client'`) whose introspection-resolved `grant_id` exactly equals the URL `:grantId`.
  Anything else (no `Authorization` header, owner-session cookie alone, mismatched grant, expired/revoked token) SHALL fail before any state mutation. Failure SHALL emit `grant.revoke_rejected` for owner-debugging parity, but SHALL NOT leak whether the grant exists.
- `apps/web/src/app/dashboard/lib/owner-token.ts` SHALL default the dashboard's owner subject id to the canonical `OWNER_SESSION_DEFAULT_SUBJECT_ID` (`"owner_local"`) rather than to a personal name. Repository-wide grep proof goes in the fix report.
- Every response from the AS app's hosted-UI HTML pages (`/consent`, `/consent/approve`, `/consent/deny`, `/device`, `/device/approve`, `/device/deny`, `/owner/login`, `/owner/logout`, the AS root index, and any future `renderHostedDocument`-backed page) SHALL set `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`. Setting both on every AS response is harmless on JSON paths.
- The `pdpp-data-access` skill's "When a token is compromised" guidance SHALL be updated to send the grant's bearer in the revoke curl call.
- Existing revoke-using tests SHALL be updated to send a valid bearer; new regression tests SHALL pin the new auth shape, the token-redaction shape, and the clickjacking headers.

Out of scope (explicit, captured as design notes for follow-up):

- Removing `token_id` from `spine_events` storage entirely. The audit recommends this; it is a schema migration, a spine-replay change, and a contract change. Done in a later tranche.
- Migrating to consent exchange-codes so `/consent/approve`'s HTML stops embedding the live token. Captured as `design-notes/consent-result-token-rendering-2026-04-27.md` with a clear follow-up.
- Changing the unauth `_ref/*` read posture for routes other than the two timeline routes. The current spec explicitly says reads stay open; we keep that scope and only redact one specific field. Wider gating belongs in a separate change.
- Connector-scoped blob-upload tokens (audit P2 #11). Separate runtime-spec change.
- docker-compose host-binding posture (audit P1 #5). Separate ops change.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: extend the "Reference-only surfaces are explicit" requirement so the two timeline read routes strip the top-level `token_id` and redact `object_id` when `object_type === 'token'`, and add new requirements for grant-revoke authentication and AS hosted-UI clickjacking defense.

## Impact

- `reference-implementation/server/index.js` — add `requireRevokeAuth` middleware on `POST /grants/:grantId/revoke`; add a `redactTimelineEvent` projection and apply it at `summaryToGrant`'s timeline route and at the run-timeline route; add `X-Frame-Options` / `Content-Security-Policy` headers on the AS app's existing global middleware.
- `reference-implementation/test/security-auth-surfaces.test.js` — new test file pinning the four invariants (timeline `token_id` absent; revoke requires auth; revoke accepts owner bearer; revoke accepts grant-scoped client bearer; revoke rejects mismatched-grant client bearer; HTML pages carry the two clickjacking headers).
- `reference-implementation/test/event-spine.test.js`, `reference-implementation/test/cli.test.js`, `reference-implementation/test/agent-cli.test.js`, `reference-implementation/test/pdpp.test.js` — update revoke calls to pass the grant's bearer.
- `apps/web/src/app/dashboard/lib/owner-token.ts` — replace literal `"the owner"` with the canonical `OWNER_SESSION_DEFAULT_SUBJECT_ID` import.
- `skills/pdpp-data-access/references/security.md` and `docs/agent-skills/pdpp-data-access/references/security.md` — update the revoke recipe to require the grant token; update the "PDPP responses generally do not include credentials" note to add the timeline-projection guarantee.
- `openspec/changes/harden-reference-auth-surfaces/design-notes/consent-result-token-rendering-2026-04-27.md` — captured follow-up for the `/consent/approve` HTML token-copy issue (out of scope here).
- `openspec/changes/harden-reference-auth-surfaces/design-notes/spine-token-id-storage-2026-04-27.md` — captured follow-up for hashing/removing `token_id` from `spine_events` storage (out of scope here).
