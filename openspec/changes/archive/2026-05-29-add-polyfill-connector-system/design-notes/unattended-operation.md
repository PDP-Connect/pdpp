# Unattended-operation principle

**Status:** codified 2026-04-19.
**Binding on every connector past, present, and future.**

## The rule

**Every polyfill connector must ultimately run on a schedule, unattended, with the owner asleep or away from his laptop.** No connector's happy path may depend on a human sitting at the keyboard.

## Corollaries

1. **No `INTERACTION manual_action` on the happy path.**
   Only fires on genuine session death, CAPTCHA, "unusual activity" challenges, or bank-mandated step-up. These are exception paths, not the default.

2. **Automated re-auth from stored credentials.**
   When a browser session expires (cookies invalidated, 401, redirect-to-login detected), the connector itself drives the re-auth flow — username/password from the encrypted creds store. Not a human clicking "bootstrap browser."

3. **2FA must reach the owner anywhere.**
   - Emit `INTERACTION kind=otp` with a short message.
   - ntfy pushes to the owner's phone immediately.
   - the owner responds by writing the code to a well-known file (or via the inbox web form on his phone over Tailscale/similar).
   - Connector picks it up and resumes. No laptop needed.
   - Pattern proven tonight: `/tmp/usaa-otp.txt` + poll loop. Same shape for every browser connector.

4. **Selectors must be pinned to stable DOM attributes.**
   - Prefer: `name`, role-based locators, semantic classes.
   - Avoid: auto-generated React IDs, position-in-DOM fragility, `[data-testid*=...]` with wildcards that could hit unrelated elements.
   - When a heuristic selector is necessary, the connector logs the ambiguity and emits a `SKIP_RESULT` with reason `selectors_pending` rather than silently skipping data.

5. **Humanlike cadence to preserve sessions.**
   - Bank connectors: ≥2s between navigation events.
   - Keep-alive probes every ~90 min per browser-backed connector so idle-TTL doesn't hit mid-scheduled-run.
   - Jittered schedules (±25%) so we don't cluster on round hours.

6. **Graceful degradation.**
   - If stream A succeeds and stream B fails, emit `SKIP_RESULT` for B and keep going. Never fail the whole run on one stream's hiccup.
   - If export is slow, retry with progressively narrower ranges rather than giving up.

7. **State preservation on error.**
   - Even on failed runs, persist state for streams that did emit successfully before the failure point.
   - Enforced by the runtime's checkpoint-streaming architecture; connectors just have to emit STATE per stream as they go.

8. **Notification clarity.**
   - When something genuinely needs the owner (session re-auth mid-night, 2FA), ntfy subject line is specific: "USAA 2FA needed" not "PDPP alert".
   - When a run completes silently (green), no notification unless it's the daily summary.

## Anti-patterns (seen tonight, to avoid)

- **"Run `pdpp browser bootstrap X` to re-auth"** — requires laptop access. Wrong for unattended. The connector should drive login itself.
- **"Deferred to co-pilot session"** — acceptable during design, unacceptable once credentials are available. Tonight's USAA CSV-export flow went from "deferred" to "wired live" once I used the existing session.
- **Fixed-length timeouts that don't retry** — a 60-second download timeout might be right for 3 months of data and wrong for 2 years. Use candidate-range fallbacks.
- **Silent selector drift** — if a selector misses, emit a structured `SKIP_RESULT` with `reason: "selectors_pending"`, don't return empty records.

## Compliance checklist per connector

Before a connector is considered complete:

- [ ] Handles session expiry with automated re-auth from stored creds
- [ ] Fires 2FA INTERACTION via ntfy + phone-response file pattern
- [ ] All selectors pinned to stable attributes
- [ ] At least one full run with `pnpm ... run <connector>` under cron/scheduler with no interactive input
- [ ] Keep-alive integrated with scheduler
- [ ] State preserved across expected + unexpected failures
- [ ] Handles empty windows (no data) without erroring

## Retroactive audit

Applying to existing connectors:

| Connector | Compliant | Gaps |
|---|---|---|
| ynab | ✅ | API-only, no session concerns |
| gmail | ✅ | IMAP app password, stable |
| chatgpt | 🟡 | No auto re-auth; relies on bootstrap — needs automated login |
| usaa | 🟡 | Has 2FA-via-file pattern; needs automated password re-entry on expiry |
| amazon | ❌ | Requires wife's-phone 2FA; can only run when phone is accessible — fundamental constraint |
| github, oura, spotify, strava, notion, reddit, pocket | ✅ | API tokens |
| whatsapp, google_takeout, twitter_archive, apple_health, ical | ✅ | File-based, no auth |
| slack | ✅ | slackdump EZ-login handles session automatically |
| anthropic, shopify, heb, wholefoods, linkedin, meta, loom, uber, doordash | 🟡 | Scaffolded; each needs the automated re-auth + 2FA flow when wired |

Amazon's 2FA-through-wife's-phone is a hard dependency we can't paper over at the connector level. Best we can do: prompt the owner clearly when the scheduler hits Amazon's expiry and flag whether it's a "fast re-auth with stored creds" path (doesn't need wife) or "needs 2FA on her phone" path.
