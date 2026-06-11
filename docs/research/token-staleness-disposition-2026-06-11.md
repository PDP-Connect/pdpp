# Token-staleness disposition (2026-06-11)

Outcome of the connector token-staleness audit
(`connector-token-staleness-audit-2026-06-11.md`, probed + verified) plus the
two fixes shipped in commit `09d3ce54`.

## The bug class
A connector caches/uses a short-lived auth token for the whole run without
refreshing it; a run longer than the token lifetime gets a spurious 401 late in
the run and **fails silently** (no reconnect prompt). Found live on ChatGPT
while draining the 964-gap recovery backlog (run died at 13 min on a rotated JWT).

## Audit result (probed: spotify L113/L338, usaa L1320, slack verified)
**4 VULNERABLE:** spotify, strava, google_maps_data_portability, slack.
SAFE: static-PAT connectors (github/notion/oura/ynab/gmail — tokens don't rotate),
browser-session connectors that re-auth (usaa = gold standard), file-based
imports. CONDITIONALLY SAFE: chase (session-based, no mid-run lapse detection
like usaa, but longer-lived sessions). N/A: pocket (deprecated).

## What shipped (commit 09d3ce54)
**Fix #1 — ChatGPT self-heal (the full fix where a fresh token IS obtainable):**
ChatGPT extracts its bearer from the live browser page, so on a 401 it now
re-extracts the page's CURRENT token and retries once (`reauth()`,
chatgpt/index.ts). A rotated-token 401 self-heals; a dead session still surfaces.

**Fix #2 — §10-C generic credential prompt (covers ALL 4 vulnerable connectors):**
A terminal auth failure flattened to a generic run reason
(`connector_reported_failed`) now surfaces `credentials_required` via
`credentialReasonFromGenericFailure` (server/ref-control.ts) when a degrading
known-gap signals auth (a 401/403 message OR a `refresh_credentials` recovery
hint). The runtime already runs every thrown connector error through
`inferRecoveryAction` (runtime/index.js:827), which maps any `*_auth_failed` /
401 message to `refresh_credentials`. So spotify/strava/google_maps/slack — all
of which throw `*_auth_failed` or a 401 — now project `needs_attention` + a
Reconnect CTA + the §10-F escalation push instead of a silent failure.
Pinned by connection-health-acceptance §10-C tests (fires on auth, NOT on a
non-auth generic failure).

## Remaining work (per-connector, NOT yet done)
The 4 vulnerable connectors read their token from an ENV var
(`SPOTIFY_ACCESS_TOKEN` etc.) with the OAuth refresh-token loop **deferred in
v1** — they have NO fresh-token source mid-run (unlike ChatGPT's live page). So
the full self-heal (#1 pattern) does NOT directly apply. Their correct full fix
is **OAuth refresh-token support**:
- spotify (AT ~1h) — deferred connector, NOT a priority (owner). Fails honestly via #2.
- strava (AT ~6h) — deferred connector, NOT a priority. Fails honestly via #2.
- google_maps_data_portability (AT ~1h, cached in client instance) — deferred, NOT a priority.
- chase — LOW: add usaa-style mid-run session-lapse detection.

## Slack RE-VERDICT: NOT vulnerable in practice (audit over-indexed)
The audit ranked slack "HIGHEST priority" by analogy to ChatGPT's JWT. That
analogy is WRONG: ChatGPT's bearer is a ~minutes-rotating JWT, but slack's
`xoxc-` token is tied to the browser session cookie (`d`) and is LONG-LIVED
(weeks-to-months, as long as the Slack session is valid). Owner confirms slack
has run fine for weeks. So slack is LOW risk — it only fails if the whole Slack
session dies (logout / password change / Slack-side invalidation), which is rare
and which #2 now handles gracefully (reconnect prompt, not silent fail). Also
`xoxc` has no refresh-token; the only "refresh" would be re-extracting from the
browser (like ChatGPT) — not worth it given the multi-week lifetime. **Do not
prioritize slack.**

Until OAuth refresh lands for the (deferred, non-priority) spotify/strava/gmaps,
#2 ensures they FAIL HONESTLY (reconnect prompt + push), which is the priority —
no more silent runs dying with no owner signal.
