# Design — add-polyfill-connector-system

## Operational model

### Three classes of authentication
| Class | Connectors | Auth storage | Refresh |
|---|---|---|---|
| API token | YNAB | `.env.local` (plain, bootstrap) | Never; user-rotated |
| IMAP app password | Gmail | `.env.local` (plain, bootstrap) | Never; user-rotated if Google deprecates |
| Browser session | ChatGPT, Amazon, USAA | Persistent Chromium profile at `~/.pdpp/browser-profile/` | Keep-alive probes + bootstrap on session death |

### Autonomous failure modes and responses
| Failure | Connector response | Scheduler response | User notification |
|---|---|---|---|
| API 401 | `DONE status=failed` with `error.message="auth_failed"` | Mark connector `needs_reauth`, don't retry | ntfy: "YNAB token rejected, rotate PAT" |
| API 429 | `DONE status=failed retryable=true` | Exp. backoff up to 1 hour | none |
| Browser session expired (cookie probe fails) | `SKIP_RESULT` then `DONE status=failed` | Mark connector `needs_reauth` | ntfy: "Amazon session expired, open browser to re-login" |
| Captcha/manual_action | `INTERACTION kind=manual_action` | Park run; don't resume until inbox response | ntfy: "Amazon needs you — captcha" |
| OTP required | `INTERACTION kind=otp` | Park run | ntfy: "Amazon OTP — sent to your phone" |
| Network error | `DONE status=failed retryable=true` | Exp. backoff | none (unless repeats) |

### Pause/resume semantics (MVP)
The Collection Profile spec already defines `INTERACTION` as a blocking message — the connector waits on stdin for `INTERACTION_RESPONSE` before continuing. The runtime keeps the child process alive. **This is the pause/resume primitive.** We do not yet implement full restart-from-checkpoint (that would require serializing connector state to disk and restoring it after process death). For MVP: the parked run holds its process open, sometimes for hours, until the user responds via the inbox. If the process dies while parked (restart, crash), the run is lost and rescheduled from the last `STATE` checkpoint.

This is pragmatically fine for the owner-scale: bank scrapes are ~5 min, ChatGPT scrapes are ~10 min, so a parked process hanging around for an hour awaiting OTP is acceptable. Amazon's multi-hour scrape is the exception — for that we'd need proper checkpoint-resume, deferred to a follow-up change.

### Scheduler policy
| Connector | Default interval | Jitter | Notes |
|---|---|---|---|
| YNAB | 4 hours | ±30 min | API rate limit 200/hr leaves plenty of room |
| Gmail | 30 min | ±5 min | IMAP IDLE would be better; deferred |
| ChatGPT | 6 hours | ±1 hr | Session hostility unknown |
| USAA | 4 hours | ±1 hr | Aggressive enough to keep session warm, not so often as to raise flags |
| Amazon | 12 hours | ±2 hr | Low-frequency after initial backfill |

Keep-alive probes (distinct from full runs) run every ~90 min per browser-backed connector. One HTTP request, no scraping.

### Inbox lifecycle
An inbox item enters when `INTERACTION` is emitted. It exits via:
- `POST /_ref/inbox/:id/respond` — runtime sends `INTERACTION_RESPONSE status=success data=…` to the connector
- `POST /_ref/inbox/:id/dismiss` — runtime sends `INTERACTION_RESPONSE status=cancelled`
- Timeout — runtime sends `INTERACTION_RESPONSE status=timeout` after manifest-declared or connector-emitted timeout_seconds (default 30 min)

All three cases leave the item in the DB with final state for audit. Dismiss is a hard cancel; the connector can choose to fail or try an alternate path.

## Schema discipline (autonomous 2026-04-19)

### Flat, platform-native, complete
Per the owner's direction: no universal normalization layer. Every field uses the platform's own naming where stable. Cross-platform joins happen at the agent layer via amount/date/counterparty — the way a human would do it.

### Resilience principles
1. **Required fields kept minimal.** Usually just `id` (primary key) + any field used in `consent_time_field`. Everything else is optional in the schema. Platform adds a field → we pass it through transparently. Platform removes a field → records still validate.
2. **Typed optionals with null-unions** (`"type": ["string", "null"]`) for fields that platforms sometimes populate, sometimes don't.
3. **No inferred defaults.** If the platform says null/absent, the record has null/absent. We don't guess.
4. **No coercion of timestamp formats.** Platform gives ISO 8601 → we emit ISO 8601. Platform gives Unix seconds → we emit the native format in a distinct field name. This protects against accidental silent lossy conversions.
5. **Platform-specific enums passed through as strings.** YNAB's `cleared` enum values (`cleared`, `uncleared`, `reconciled`) stay as strings, not booleanized.
6. **Nested objects for bounded sub-entities; separate streams for unbounded ones.** Per spec §4 Split Rule.

### Required field minimality
For every stream, declare only the subset that's genuinely required for record identity + consent-time filtering. Leave everything else optional. This means a platform renaming a non-required field breaks nothing on the PDPP side; only required-field changes require schema evolution (which YNAB does via the manifest version bump).

## Connector live-ingest contract quality

### Parent-first emit ordering

For connectors with obvious parent/child stream relationships, the
reference-quality default is `parent-first`: emit the parent record
before any of its children. This is not a core PDPP protocol rule; it
is a reference implementation quality decision for live ingest
semantics.

The owner rationale and exception policy are captured in
[`design-notes/parent-first-emit-order-decision-2026-04-23.md`](./design-notes/parent-first-emit-order-decision-2026-04-23.md).

## Package layering

```
packages/polyfill-connectors/     ← this change
├─ bin/
│  └─ pdpp-connectors.js          ← CLI: browser bootstrap/probe, connector run
├─ src/
│  ├─ browser-profile.js          ← persistent context launcher
│  ├─ platform-probes.js          ← is-logged-in detectors, per platform
│  └─ bootstrap.js                ← headed bootstrap flow
├─ connectors/
│  ├─ ynab/
│  │  └─ index.js                 ← stdin/stdout connector per Collection Profile
│  ├─ gmail/
│  │  └─ index.js
│  ├─ chatgpt/
│  │  └─ index.js                 ← uses shared browser profile
│  ├─ usaa/
│  │  └─ index.js                 ← uses shared browser profile
│  └─ amazon/
│     └─ index.js                 ← uses shared browser profile
├─ manifests/
│  ├─ ynab.json
│  ├─ gmail.json
│  ├─ chatgpt.json
│  ├─ usaa.json
│  └─ amazon.json
└─ package.json

reference-implementation/         ← untouched substrate
├─ runtime/
│  └─ scheduler.js                ← extended in-place (add SQLite persistence + keep-alive)
└─ server/
   ├─ inbox.js                    ← new — parked interactions
   ├─ ntfy.js                     ← new — push notification bridge
   └─ index.js                    ← amended to mount inbox + ntfy
```

Browser-backed connectors import `packages/polyfill-connectors/src/browser-profile.js` to open the shared persistent context. They're single-process and exit at the end of each run; the profile directory persists cookies across runs via Chromium's own storage.

## Autonomous decisions (2026-04-19)

These are decisions Claude made without the owner's input while he was away. Each is open to reversal.

1. **Jitter + keep-alive cadence** — chose ranges that feel humanlike (irregular, ~hour-scale). Could be tightened or loosened based on real platform behavior.
2. **USAA export feature** — if the investigation finds a drivable export flow, prefer it; otherwise fall back to DOM scrape with a cookie-based session probe.
3. **Required field minimality** — went as minimal as reasonable (usually just `id`). May need to loosen further if specific fields turn out to be null-prone in ways that cause ingest rejections.
4. **One browser profile, shared** — all browser-backed connectors share one profile. If fingerprint cross-contamination becomes an issue (e.g., Amazon notices we've been on usaa.com), we'd split per-platform. Easy to revisit.
5. **No OAuth for Gmail tonight** — app password only. Simpler, already works for the owner. OAuth is a followup change.
6. **Scheduler stays in-process** — not spun out to a daemon. Runs inside the personal server process. Simplest possible architecture.
