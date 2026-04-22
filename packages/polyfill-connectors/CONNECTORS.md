# Polyfill connector registry

30 connectors, organized by auth/operational class.

## What the status columns mean

Connector portability is not a single bit. The honest picture is **two axes**:

- **Maintainer-verified**: has the maintainer successfully landed records on their own machine? This is what a "✅" with a record count means historically — it says "it produced data for me, once or more."
- **First-run portable**: can a new user, on a new machine, on an IP that has never automated this platform before, follow our docs and land records without manual hand-holding?

API-based connectors are structurally first-run portable: give anyone the credentials and they work from any machine. Browser-scrape connectors are structurally not: they depend on warm cookies, trusted-device state, Cloudflare/Akamai IP reputation, SMS 2FA access, device-fingerprint burn-in, and sometimes geographic factors. "Works for the maintainer" and "works for a new user on a new MBP" are genuinely different states.

A `⚠` in the **First-run portable** column is not a bug — it's a property of the upstream platform's anti-bot surface that no amount of connector code can fully work around. Documenting it honestly is healthier than pretending otherwise.

## API-based (token/PAT)

These connectors fetch via the platform's public HTTP API using a long-lived token. Bootstrap once; rotate periodically. Incremental via platform cursors. **All API-based connectors are structurally first-run portable** — no browser profile, no IP reputation dependency.

| Connector | Auth | Bootstrap | Maintainer-verified | First-run portable | Records (mine) |
|---|---|---|---|---|---|
| ynab | `YNAB_PAT` | Manual: ynab.com/settings → "New Token" | ✅ | ✅ | ~10,311 |
| github | `GITHUB_PERSONAL_ACCESS_TOKEN` | **Automated** via `bin/bootstrap-github-pat.js` | ✅ | ✅ | 553 |
| gmail | `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `GMAIL_IMAP_HOST` | Google app password | ✅ | ✅ | ~27,359 |
| notion | `NOTION_API_TOKEN` | Manual: notion.so/my-integrations → "New integration" | 🟡 code ready | ✅ (expected) | — |
| oura | `OURA_PERSONAL_ACCESS_TOKEN` | Manual: cloud.ouraring.com/personal-access-tokens | 🟡 code ready | ✅ (expected) | — |
| strava | `STRAVA_ACCESS_TOKEN` | Requires OAuth app registration | 🟡 code ready | ✅ (expected) | — |
| reddit | `REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD` | reddit.com/prefs/apps → Resource Owner Password grant | 🟡 code ready | ✅ (expected) | — |
| slack | `SLACK_WORKSPACE` + slackdump binary | Subprocess; wraps slackdump CLI | 🟡 code ready | ✅ (expected) | — |
| spotify | `SPOTIFY_ACCESS_TOKEN` | OAuth app creation frozen by Spotify as of Feb 2026 | 🚫 blocked upstream | — | — |
| pocket | — | **Deprecated** (Mozilla shut Pocket down 2025-07-08) | 🚫 excluded | — | — |

## Browser-scraper

These connectors drive a Playwright session against a persistent browser profile. Session expiry is handled by `src/auto-login/<platform>.js` helpers that drive re-login + 2FA via `INTERACTION`. **None of these are first-run portable without some friction** — the upstream platforms have anti-bot surfaces that treat fresh IPs and cold profiles as higher-risk by design.

New browser-scrape connectors should use `acquireIsolatedBrowser({ profileName: '<name>' })` (per-connector on-disk profile, full patchright stealth). Older connectors still use the shared daemon at `~/.pdpp/browser-profile/`; they will be migrated. See `docs/connector-authoring-guide.md`.

First-run-portability notes are platform-specific and worth reading before handing the connector to a new user:

| Connector | Bootstrap needs | Maintainer-verified | First-run portable | Records (mine) | Notes on first-run |
|---|---|---|---|---|---|
| chatgpt | ChatGPT login (email+password); optional 2FA | ✅ | ⚠ conditional | 2,302 conv / 9,252 msg | Cloudflare may challenge on new IPs. Run with `PDPP_CHATGPT_HEADLESS=0` so the user can see and clear the challenge in a visible browser. |
| usaa | USAA member login + SMS 2FA | ✅ | ⚠ needs SMS access | 887 (5 streams) | SMS OTP delivered to the account's registered phone. User must have that phone. |
| amazon | Amazon login + 2FA | ✅ | ⚠ needs 2FA device | 2,863 (orders+items) | 2FA on the account's registered device. First run may also burn trusted-device state; subsequent runs smoother. |
| anthropic | Claude.ai login | 🟡 scaffolded | — | — | selectors TBD |
| shopify | Shopify admin login | 🟡 scaffolded | — | — | |
| heb | HEB.com login | 🟡 scaffolded | — | — | |
| wholefoods | Piggybacks on Amazon session | 🟡 scaffolded | — | — | inherits Amazon's portability profile |
| linkedin | LinkedIn login | 🟡 scaffolded | — | — | |
| meta | Instagram login | 🟡 scaffolded | — | — | |
| loom | Loom login | 🟡 scaffolded | — | — | |
| uber | Uber login | 🟡 scaffolded | — | — | |
| doordash | DoorDash login | 🟡 scaffolded | — | — | |

Scaffolded = manifest + connector shell exist with correct streams, but DOM selectors need a live co-pilot session to wire.

"Conditional" first-run portability means: works without manual intervention *if* specific conditions are met (user has their 2FA device, clears any visible Cloudflare challenge, etc.). If those conditions can't be met, the connector emits an `INTERACTION manual_action` asking the user to complete the step manually, then re-run.

## File-based

These connectors parse local files without network access. Run on-device only. **All file-based connectors are first-run portable** — the user supplies the file and it works.

| Connector | Source | Maintainer-verified | First-run portable |
|---|---|---|---|
| claude_code | `~/.claude/projects/**/*.jsonl` | ✅ | ✅ |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | ✅ | ✅ |
| whatsapp | `~/.pdpp/imports/whatsapp/*.txt` (chat exports) | 🟡 code ready | ✅ (expected) |
| google_takeout | `~/.pdpp/imports/google_takeout/` (extracted takeout) | 🟡 code ready | ✅ (expected) |
| twitter_archive | `~/.pdpp/imports/twitter_archive/` (extracted archive) | 🟡 code ready | ✅ (expected) |
| imessage | `~/Library/Messages/chat.db` (auto-discovered on macOS) | 🟡 code ready | ✅ (expected) |
| apple_health | `~/.pdpp/imports/apple_health/` (extracted iOS export) | 🟡 code ready | ✅ (expected) |
| ical | `.ics` files or `ICAL_SUBSCRIPTION_URL` | 🟡 code ready | ✅ (expected) |

## How to run a connector

```bash
# One-shot run
node packages/polyfill-connectors/bin/orchestrate.js run <name>

# Bootstrap a token (where automated)
node packages/polyfill-connectors/bin/bootstrap-github-pat.js

# Validate all manifests
node packages/polyfill-connectors/bin/register-all.js --embedded

# Query results
sqlite3 packages/polyfill-connectors/.pdpp-data/polyfill.sqlite \
  "SELECT connector_id, stream, COUNT(*) FROM records GROUP BY 1,2"
```

## Adding a new connector

1. Create `manifests/<name>.json` following an existing shape (e.g. `github.json` for API-based, `claude_code.json` for file-based, `amazon.json` for browser-scraper).
2. Create `connectors/<name>/index.js` — see `connectors/github/index.js` for a clean API example.
3. Register in `src/orchestrator.js` `KNOWN_CONNECTORS`.
4. Add to `bin/register-all.js` for smoke testing.
5. Run: `node bin/orchestrate.js run <name>`.

Required conventions: `flushAndExit` helper, `resourceSet` filter, tombstones on mutable_state deletion (where platform supports), `requireCredentialsOrAsk` for env-var creds.

## Spec surface documented

See `openspec/changes/add-polyfill-connector-system/specs/polyfill-runtime/spec.md` for the 5 runtime requirements we formalized: resources-filter enforcement, filesystem binding, tombstones, INTERACTION on missing credentials, flushAndExit.

## Open questions (3)

- Connector configuration surface — manifest-declared `credentials_schema` + `options_schema`
- RS storage topology — unified vs per-connector DBs
- Credential storage — vault interface

See `openspec/changes/add-polyfill-connector-system/design-notes/*-open-question.md`.
