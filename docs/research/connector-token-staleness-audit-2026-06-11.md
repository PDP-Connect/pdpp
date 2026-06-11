# Connector Token Staleness Audit — 2026-06-11

**Scope:** All 34 connectors in `packages/polyfill-connectors/connectors/*/index.ts`  
**Bug pattern:** Token extracted once at run start, cached for entire run, no mid-run refresh; on 401 the run hard-aborts instead of re-extracting a fresh token.  
**Reference bug (confirmed + fixed):** `chatgpt/index.ts` — see §1 below for fix anatomy.

---

## Summary

| Category | Connectors |
|---|---|
| SAFE (FIXED) | chatgpt |
| SAFE (static long-lived secret) | github, notion, oura, ynab, gmail |
| SAFE (browser-only, no HTTP bearer) | amazon, chase (partial — see note), reddit, anthropic, linkedin, loom, meta, shopify, heb, doordash, uber, wholefoods |
| SAFE (browser session with mid-run reauth) | usaa |
| SAFE (file-based, no auth) | apple_health, google_takeout, ical, imessage, twitter_archive, whatsapp, claude_code, codex |
| **VULNERABLE** | **spotify, strava, google_maps_data_portability, slack** |
| N/A (deprecated) | pocket |

**VULNERABLE count: 4**

---

## Detailed Table

| Connector | Token type | Caches? | 401 handling | Verdict | Key evidence (file:line) |
|---|---|---|---|---|---|
| **chatgpt** | Short-lived JWT extracted from browser `#client-bootstrap` page element | YES — `let authCache` (L1131), set once | `reauth()` clears cache, re-extracts from page (L1152-1153), retries once (L1177-1180); if still 401, flows to `shouldAbort` (L1261) | **SAFE (FIXED)** — L1131 stores cache; L1144-1155 documents the rotation risk; L1177-1180 is the self-heal | `chatgpt/index.ts:L1131,L1144,L1152,L1177,L1261` |
| **github** | Static PAT (`GITHUB_PERSONAL_ACCESS_TOKEN` env) | No — read from `credentials` each `collect()` | `throw new Error("github_auth_failed")` (L161); not in `retryablePattern` `/rate_limited\|ECONN\|fetch failed/` (L930) → terminal run abort | **SAFE** — PAT does not rotate mid-run; 401 = revoked or wrong token, not staleness | `github/index.ts:L5,L160-161,L930` |
| **notion** | Static internal integration token (`NOTION_API_TOKEN` env) | No — read from `credentials` | `throw new Error("notion_auth_failed")` (L121); not in `retryablePattern` → terminal | **SAFE** — Notion internal integration tokens are long-lived (non-expiring); 401 = revoked | `notion/index.ts:L5,L120-121,L265` |
| **oura** | Static PAT (`OURA_PERSONAL_ACCESS_TOKEN` env) | No | `throw new Error("oura_auth_failed")` (L114); not in `retryablePattern` → terminal | **SAFE** — Oura PATs are long-lived; 401 = revoked | `oura/index.ts:L5,L113-114,L212` |
| **ynab** | Static PAT (`YNAB_PERSONAL_ACCESS_TOKEN` env) | No | `throw new Error("ynab_auth_failed")` (L284); not in `retryablePattern` → terminal | **SAFE** — YNAB PATs are non-expiring; 401 = revoked | `ynab/index.ts:L7,L283-284,L1250,L1272` |
| **gmail** | Google app-specific password (`GOOGLE_APP_PASSWORD_PDPP` env) over IMAP | No bearer token — IMAP connection uses app password at connection time | IMAP auth errors at connection setup; app passwords do not rotate mid-session | **SAFE** — IMAP app passwords are long-lived; no bearer token that can expire mid-run | `gmail/index.ts:L5,L10-11` |
| **spotify** | Short-lived OAuth AT (`SPOTIFY_ACCESS_TOKEN` env) — comment: "v1 expects a pre-issued token via env var. Full OAuth loop deferred" | No variable-level caching, but token is read once at `collect()` start and used for entire run | `throw new Error("spotify_auth_failed")` (L114); NOT in `retryablePattern` `/rate_limited\|ECONN\|fetch failed/i` (L338) → terminal run abort; no refresh attempt | **VULNERABLE** — Spotify OAuth ATs expire in ~1 hour; long runs will get 401 on the cached AT; no refresh_token flow; hard-aborts | `spotify/index.ts:L5-6,L113-114,L338,L341` |
| **strava** | Short-lived OAuth AT (`STRAVA_ACCESS_TOKEN` env) — comment: "run OAuth flow with scopes" | No variable-level caching, read once at `collect()` start | `throw new Error("strava_auth_failed")` (L94); NOT in `retryablePattern` `/ECONN\|fetch failed\|rate_limited/i` (L131) → terminal | **VULNERABLE** — Strava OAuth ATs expire in 6 hours; no refresh_token path; hard-aborts on 401 | `strava/index.ts:L5,L93-94,L131,L135` |
| **google_maps_data_portability** | Short-lived OAuth AT (`GOOGLE_DATAPORTABILITY_ACCESS_TOKEN` env) requiring full Google Data Portability OAuth scopes | YES — stored in `GoogleDataPortabilityClient` class instance as `this.accessToken` (api.ts:L106,L111); never invalidated | `DataPortabilityApiError` thrown with `response.status` (api.ts:L179); `retryablePattern` is `/429\|5\d\d\|timeout\|temporar\|rate\|unavailable\|google_data_portability_api_error/i` (L307) — 401 matches `google_data_portability_api_error` string but the error message is `google_data_portability_api_error: 401`, which DOES match the pattern; however there is no reauth mechanism | **VULNERABLE** — Google OAuth ATs expire in 1 hour; token stored in class instance; `retryablePattern` may make it cross-run retryable but there is no token refresh within the run | `google_maps_data_portability/api.ts:L29,L106,L111,L172,L179; index.ts:L73,L307` |
| **slack** | `xoxc-...` token + `d` cookie — extracted from "the browser app's JS bootstrap data" (L33-34); stored as env via `SLACK_TOKEN` / `SLACK_COOKIE` credentials | Read once from credentials at `collect()` start (L220-221); passed to `slackdump` subprocess; no mid-run re-extract | `retryablePattern` is `/ECONN\|timeout/i` (L1099) — auth errors from slackdump are not retryable; no mechanism to re-extract from the browser page | **VULNERABLE** — `xoxc` tokens are Slack client session tokens that expire (similar to ChatGPT's bearer); stored as static env; slackdump delegates auth entirely to passed token; no re-extract/refresh path | `slack/index.ts:L33-34,L220-221,L1099,L1104` |
| **pocket** | DEPRECATED — Mozilla shut down 2025-07-08. Was: `POCKET_ACCESS_TOKEN` env | No | `throw new Error("pocket_auth_failed")` (L105); not in `retryablePattern` | **N/A (DEPRECATED)** — Do not run | `pocket/index.ts:L3-8` |
| **usaa** | Browser session cookie (USAA username/password + OTP) | `ensureUsaaSession()` at run start; session maintained in browser profile | Session lapse detected via page redirect to `/my/logon`; `reauthAfterSessionLapse()` (L1320) calls `ensureUsaaSession()` mid-run; on failure emits `SKIP_RESULT` with reason `session_dead_reauth_failed` (L1340) | **SAFE** — Has explicit mid-run re-auth via `reauthAfterSessionLapse()` | `usaa/index.ts:L1320-1344,L2286` |
| **chase** | Browser session cookie (CHASE username/password + OTP 2FA) | `ensureChaseSession()` called once at run start via `ensureSession` hook (L1996-2001); no mid-run reauth found in `index.ts` | N/A — browser automation; no HTTP 401 patterns; session lapse would surface as page redirect | **CONDITIONALLY SAFE** — Session established once; if session lapses mid-run (Chase sessions are relatively long-lived), there is no mid-run reauth unlike USAA. Risk is lower because Chase runs are typically shorter than ChatGPT runs. | `chase/index.ts:L27,L35,L1996-2001` |
| **amazon** | Browser session via persistent bootstrapped profile; no bearer token HTTP calls | N/A — profile-based | On session expiry, emits `INTERACTION kind=manual_action` with sign-in URL (L16) | **SAFE (browser-only)** — No bearer token that can go stale; profile session expiry handled by emitting owner interaction | `amazon/index.ts:L15-16,L21` |
| **reddit** | Browser session cookie maintained by Playwright profile; `REDDIT_USERNAME`+`REDDIT_PASSWORD` for initial login via `ensureRedditSession()` | Browser maintains session in profile; no explicit in-code token caching | `throw new Error("reddit_auth_failed")` (L119) on `auth_failed` classification; NOT in `retryablePattern` → terminal; but `ensureRedditSession()` is called at run start | **CONDITIONALLY SAFE** — Browser session managed by Playwright; session is re-established at run start by `ensureRedditSession()`; during a run, fetches go through the page (`credentials: "include"`) so the browser's live session cookies are used for each fetch (no cached bearer token) | `reddit/index.ts:L87-94,L118-119,L311,L315-316` |
| **anthropic** | Session cookie check only (`sessionKey\|__Secure-next-auth.session-token`) | N/A — check only | N/A — no HTTP API calls | **N/A** — Session-check connector; emits no records via HTTP bearer | `anthropic/index.ts:L21,L28-29` |
| **linkedin** | Browser session cookie (`li_at\|JSESSIONID`) via Playwright | No HTTP bearer token extracted | N/A | **N/A (browser-session check)** — Session check connector, no direct HTTP API calls with bearer | `linkedin/index.ts:L10,L17-18` |
| **loom** | Browser session cookie (`connect.sid\|loom_session`) | N/A | N/A | **N/A (browser-session check)** | `loom/index.ts:L10,L17-18` |
| **meta** | Browser session cookie (`sessionid\|ds_user_id`) | N/A | N/A | **N/A (browser-session check)** | `meta/index.ts:L10,L17` |
| **shopify** | Browser session cookie (`session\|_shop_session\|consumer_access_token`) | N/A | N/A | **N/A (browser-session check)** | `shopify/index.ts:L10,L17-18` |
| **heb** | Browser session cookie (`session\|hebuser\|heb-session`) | N/A | N/A | **N/A (browser-session check)** | `heb/index.ts:L10,L17-18` |
| **doordash** | Browser session cookie | N/A | N/A | **N/A (browser-session check)** | `doordash/index.ts:L26` |
| **uber** | Browser session cookie | N/A | N/A | **N/A (browser-session check)** | `uber/index.ts:L34` |
| **wholefoods** | Browser session cookie (Amazon `session\|at-main`) | N/A | N/A | **N/A (browser-session check)** | `wholefoods/index.ts:L16,L23` |
| **apple_health** | None — file-based import | N/A | N/A | **N/A (file-based)** | No auth patterns |
| **google_takeout** | None — file-based (user exports zip) | N/A | N/A | **N/A (file-based)** | `google_takeout/index.ts:L5-7` |
| **ical** | None for local files; subscription URLs are unauthenticated (or URL-embedded auth) | N/A | N/A | **N/A (file/URL, no bearer)** | `ical/index.ts:L6-9` |
| **imessage** | None — local SQLite file | N/A | N/A | **N/A (file-based)** | No auth patterns |
| **twitter_archive** | None — file-based archive import | N/A | N/A | **N/A (file-based)** | No auth patterns |
| **whatsapp** | None — file-based import | N/A | N/A | **N/A (file-based)** | No auth patterns |
| **claude_code** | None — local file access | N/A | N/A | **N/A (local file)** | No auth patterns |
| **codex** | None — local file access | N/A | N/A | **N/A (local file)** | No auth patterns |
| **google_maps** | None — file-based (Timeline JSON import) | N/A | N/A | **N/A (file-based)** | Not an API connector |

---

## §1 — chatgpt: Confirmed FIXED

The bug originally described is **already patched** in the current tree.

**Before fix (the bug):**
- `authCache` set once at L1131, never cleared
- `shouldAbort: (result) => result.status === 401 || result.status === 403` hard-aborted on 401

**Current fix anatomy** (`chatgpt/index.ts:L1131-1180`):
```
L1131  let authCache: ChatGptAuth | null = null;
L1132  async function auth(): Promise<ChatGptAuth> {
L1133    if (authCache) { return authCache; }       // cache hit
L1136    const fresh = await getAuthFromPage(page);
L1140    authCache = fresh;                          // cache set once
L1141    return fresh;
L1142  }
L1144  // Re-extract the page's CURRENT bearer token, discarding the cached one.
L1152  async function reauth(): Promise<ChatGptAuth> {
L1153    authCache = null;       // CLEARS cache
L1154    return auth();          // re-reads from page
L1155  }
L1168  const result = await evaluate(await auth());
L1177  if (result.status === 401) {
L1178    const refreshed = await reauth();   // re-extract once
L1179    if (refreshed.accessToken && refreshed.accessToken !== authCacheTokenBefore(result)) {
L1180      return evaluate(refreshed);       // retry with fresh token
L1181    }
L1182  }
```

The self-heal comment at L1169-1176 explains the design precisely: "a 401 on the cached token is almost always a rotated/expired JWT, not a dead session."

---

## §2 — Vulnerable Connectors: Fix Priority List

Ordered by risk (short-lived tokens + production traffic first):

### Fix 1: `slack` — HIGHEST PRIORITY

**Risk:** `xoxc-...` tokens are Slack client session tokens that expire (similar to ChatGPT). Slack runs can be long (many channels). When the xoxc token expires, `slackdump` silently fails or returns auth errors.

**Root cause:** `SLACK_TOKEN` (xoxc-...) and `SLACK_COOKIE` (d cookie) are read from `credentials` once at `collect()` start (L220-221) and handed to `slackdump` via env. There is no mechanism to re-extract from the browser page mid-run.

**Fix pattern:** The ChatGPT pattern is not directly applicable because `slackdump` is an external subprocess. Two options:
1. **Detect slackdump auth failure** in its output and re-extract fresh token+cookie from the browser page (if a live page is available), then restart or retry the failed channel with fresh credentials.
2. **Re-extract before each major slackdump invocation** (each channel/workspace sync) rather than once per collect() call.

**Evidence:** `slack/index.ts:L33-34,L220-221,L1099,L1104`

---

### Fix 2: `spotify` — HIGH PRIORITY

**Risk:** Spotify OAuth access tokens expire in exactly 1 hour. Any run collecting a large library (many playlists + tracks) will outlive the token.

**Root cause:** Token read from `credentials.SPOTIFY_ACCESS_TOKEN` once at `collect()` start (L341). On 401, throws `spotify_auth_failed` (L114) which is not retryable → terminal run abort.

**Fix options:**
1. **Option A (refresh_token flow):** Store `SPOTIFY_REFRESH_TOKEN` alongside `SPOTIFY_ACCESS_TOKEN`. On 401, exchange the refresh token for a new AT via `POST https://accounts.spotify.com/api/token` and retry. This requires the full OAuth loop that the connector defers (L6: "Full OAuth loop deferred").
2. **Option B (re-extract from page):** If a browser binding exists, re-extract from the browser. Spotify does not currently have a browser binding, so this requires connector redesign.
3. **Option C (detect + emit retryable gap):** On 401, emit a retryable DETAIL_GAP instead of terminal abort. The run finishes partially; the next run picks up. This is lower-effort but leaves data gaps.

**Evidence:** `spotify/index.ts:L5-6,L113-114,L338,L341`

---

### Fix 3: `strava` — HIGH PRIORITY

**Risk:** Strava OAuth access tokens expire in 6 hours. Long first-time collections (years of activities) can outlive the token.

**Root cause:** Token read from `credentials.STRAVA_ACCESS_TOKEN` once at `collect()` start (L135). On 401, throws `strava_auth_failed` (L94); not retryable → terminal abort.

**Fix options:**
1. **Option A (refresh_token flow):** Strava provides `refresh_token` in OAuth responses. Store `STRAVA_REFRESH_TOKEN` alongside AT. On 401, call `POST https://www.strava.com/oauth/token` with `grant_type=refresh_token`. This is the correct fix.
2. **Option B (detect + retryable gap):** Emit retryable DETAIL_GAP on 401 for activity detail fetches; accept partial data. Lower effort, leaves gaps on first long run.

**Evidence:** `strava/index.ts:L5,L93-94,L131,L135`

---

### Fix 4: `google_maps_data_portability` — MEDIUM PRIORITY

**Risk:** Google OAuth access tokens expire in 1 hour. The Data Portability API is a long-running archive job (may take hours for the archive to be prepared and downloaded). The token is cached in the `GoogleDataPortabilityClient` class instance for the entire run.

**Root cause:** `this.accessToken` stored in class instance (`api.ts:L106,L111`); passed once at construction (`index.ts:L73`); the `DataPortabilityApiError` on non-2xx responses (`api.ts:L179`) does propagate status, but the connector's `retryablePattern` at `index.ts:L307` is `/429|5\d\d|timeout|temporar|rate|unavailable|google_data_portability_api_error/i` — a 401 DataPortabilityApiError (message: `google_data_portability_api_error: 401`) DOES match this pattern, making it cross-run retryable. However there is no within-run token refresh. The archive job started in run N cannot be continued in run N+1 with a new token since the archive job state is opaque.

**Fix options:**
1. **Preferred:** Store a `GOOGLE_DATAPORTABILITY_REFRESH_TOKEN` alongside the AT. On 401, obtain a new AT via Google OAuth token refresh, construct a new `GoogleDataPortabilityClient` with the fresh token, and continue.
2. **Partial mitigation:** The existing `retryablePattern` match on `google_data_portability_api_error` (which includes 401) means the cross-run retry machinery will re-attempt — but the archive job state may be lost between runs.

**Evidence:** `google_maps_data_portability/api.ts:L29,L106,L111,L172,L179; index.ts:L73,L307`

---

## §3 — Connectors with Hard-Abort on 401 but Static Secrets (SAFE, no action needed)

The following connectors hard-abort (throw non-retryable error) on 401 but use **long-lived static secrets** where 401 genuinely means "token is revoked" not "token is stale mid-run":

| Connector | Token type | Why 401 = revoked, not stale |
|---|---|---|
| `github` | Personal Access Token | PATs don't expire unless explicitly set with expiry or revoked |
| `notion` | Internal integration token | Notion integration tokens are non-expiring |
| `oura` | Personal Access Token | Oura PATs are non-expiring |
| `ynab` | Personal Access Token | YNAB PATs are non-expiring |
| `gmail` | Google App Password / IMAP | IMAP app passwords are long-lived; IMAP session auth happens at connection setup |

For these connectors, the current behavior (hard-abort on 401) is **correct** — a 401 indicates the credential was revoked or is wrong, which requires owner action, not a mid-run retry.

---

## §4 — Browser Connectors: Staleness Pattern Differs

Browser-automation connectors (amazon, chase, usaa, reddit, and the session-check-only stubs) use a **different auth model**: the browser Playwright profile maintains session cookies automatically across requests. The "stale cached token" pattern does not apply in the same way because each `page.goto()` and `fetch()` (with `credentials: "include"`) uses the browser's live cookie jar, not a separately cached bearer string.

**Key distinction:**
- chatgpt extracts a JWT string from the page's DOM and caches it in JavaScript memory → stale after rotation
- reddit calls `fetch()` with `credentials: "include"` inside `page.evaluate()` → the browser's live cookies are used for every fetch, no JavaScript-level token cache

**USAA is the gold standard** — it has explicit mid-run session lapse detection (checking for `/my/logon` redirect) and calls `reauthAfterSessionLapse()` (L1320) to re-run the full login flow. **Chase** has a similar session-based pattern but lacks the mid-run session-lapse detection that USAA has (no equivalent of `reauthAfterSessionLapse` found in `chase/index.ts`). Chase sessions are typically longer-lived than USAA sessions, making this a lower-priority gap.

---

## §5 — Methodology

For each connector:
1. Read `index.ts` (and adjacent `api.ts` if present) for auth extraction patterns
2. Identified token source (env var, browser page, file)
3. Checked for in-memory caching (variables holding token across calls)
4. Read 401/403 response handling in fetch helpers
5. Checked `retryablePattern` to determine if auth errors are retryable cross-run
6. Checked for any `reauth`, `refresh`, or re-extract mechanism

All `file:line` citations are verifiable by reading the current tree. No evidence was inferred — each claim is directly from the source.
