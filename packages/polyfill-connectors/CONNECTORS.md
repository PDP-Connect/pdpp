# Polyfill connector registry

When adding or changing a connector manifest, follow the repo-level
[connector authoring guide](../../docs/reference/connector-authoring-guide.md). The guide
is enforced by manifest-honesty tests for search affordances and presentation
roles; do not land readable owner-visible fields without the matching semantics.

31 connectors, organized by auth/operational class.

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
| ynab | `YNAB_PERSONAL_ACCESS_TOKEN` or `YNAB_PAT` | Manual: ynab.com/settings → "New Token" | ✅ | ✅ | ~10,311 |
| github | `GITHUB_PERSONAL_ACCESS_TOKEN` | Manual: github.com/settings/tokens | ✅ | ✅ | 553 |
| gmail | `GMAIL_ADDRESS` or `GMAIL_USER`; `GOOGLE_APP_PASSWORD_PDPP` or `GMAIL_APP_PASSWORD` | Google app password | ✅ | ✅ | ~27,359 |
| notion | `NOTION_API_TOKEN` | Manual: notion.so/my-integrations → "New integration" | 🟡 code ready | ✅ (expected) | — |
| oura | `OURA_PERSONAL_ACCESS_TOKEN` | Manual: cloud.ouraring.com/personal-access-tokens | 🟡 code ready | ✅ (expected) | — |
| strava | `STRAVA_ACCESS_TOKEN` | Requires OAuth app registration | 🟡 code ready | ✅ (expected) | — |
| reddit | `REDDIT_USERNAME`, `REDDIT_PASSWORD` | Logged-in browser session against old.reddit.com JSON | 🟡 code ready | ⚠ browser session | — |
| slack | `SLACK_WORKSPACE` + slackdump binary | Subprocess; wraps slackdump CLI | 🟡 code ready | ✅ (expected) | — |
| spotify | `SPOTIFY_ACCESS_TOKEN` | OAuth app creation frozen by Spotify as of Feb 2026 | 🚫 blocked upstream | — | — |
| pocket | — | **Deprecated** (Mozilla shut Pocket down 2025-07-08) | 🚫 excluded | — | — |

## Browser-scraper

These connectors drive a Playwright session against a persistent browser profile. Session expiry is handled by `src/auto-login/<platform>.js` helpers that drive re-login + 2FA via `INTERACTION`. **None of these are first-run portable without some friction** — the upstream platforms have anti-bot surfaces that treat fresh IPs and cold profiles as higher-risk by design.

All browser-scrape connectors use `acquireIsolatedBrowser({ profileName: '<name>' })` (per-connector on-disk profile at `~/.pdpp/profiles/<name>/`, full patchright stealth). See `docs/reference/connector-authoring-guide.md`. The legacy shared daemon and shared `~/.pdpp/browser-profile/` were retired 2026-04-25.

First-run-portability notes are platform-specific and worth reading before handing the connector to a new user:

| Connector | Bootstrap needs | Maintainer-verified | First-run portable | Records (mine) | Notes on first-run |
|---|---|---|---|---|---|
| amazon | Amazon login + 2FA | ✅ | ⚠ needs 2FA device | 2,863 (orders+items) | 2FA on the account's registered device. First run may burn trusted-device state; subsequent runs smoother. Full best-practices refactor (Zod, shape-check, tracing, p-retry, structural extraction, isolated browser). |
| chase | Chase login + SMS 2FA | ✅ | ⚠ needs SMS access, fresh OTP per run | 21 (4 streams verified) | Chase does not persist trusted-device cookie across runs; every run currently requires a fresh OTP. Root cause: `_tmprememberme` cookie is session-only; the opt-in "remember me" checkbox may not be getting ticked. See `src/auto-login/chase.js` — speculative fix landed but un-verified. |
| chatgpt | ChatGPT login (email+password); optional 2FA | ✅ | ⚠ conditional | 2,302 conv / 9,252 msg | Cloudflare may challenge on new IPs. Run with `PDPP_CHATGPT_HEADLESS=0` so the user can see and clear the challenge. p-retry on 429/5xx from OpenAI API. |
| usaa | USAA member login + SMS 2FA | ✅ | ⚠ needs SMS access | 887 (5 streams, pre-refactor) | SMS OTP delivered to the account's registered phone. Tier A refactor (Zod, shape-check, tracing, isolated-browser code) complete; end-to-end validation blocked on Akamai rejecting the maintainer's IP — need reverse proxy or fresh IP. |
| anthropic | Claude.ai login | 🟡 scaffolded | — | — | Uses `browser-scraper-runtime.js` (now on isolated path); selectors TBD. |
| shopify | Shopify admin login | 🟡 scaffolded | — | — | Uses `browser-scraper-runtime.js`. |
| heb | HEB.com login | 🟡 scaffolded | — | — | Uses `browser-scraper-runtime.js`. |
| wholefoods | Piggybacks on Amazon session | 🟡 scaffolded | — | — | Uses `browser-scraper-runtime.js`. Inherits Amazon's portability profile. |
| linkedin | LinkedIn login | 🟡 scaffolded | — | — | Uses `browser-scraper-runtime.js`. |
| meta | Instagram login | 🟡 scaffolded | — | — | Uses `browser-scraper-runtime.js`. |
| loom | Loom login | 🟡 scaffolded | — | — | Uses `browser-scraper-runtime.js`. |
| uber | Uber login | 🟡 scaffolded | — | — | Uses `browser-scraper-runtime.js`. |
| doordash | DoorDash login | 🟡 scaffolded | — | — | Uses `browser-scraper-runtime.js`. |

Scaffolded = manifest + connector shell exist with correct streams, but DOM selectors need a live co-pilot session to wire. All scaffolded connectors inherit the isolated-browser + patchright stealth path via `browser-scraper-runtime.js`.

"Conditional" first-run portability means: works without manual intervention *if* specific conditions are met (user has their 2FA device, clears any visible Cloudflare challenge, etc.). If those conditions can't be met, the connector emits an `INTERACTION manual_action` asking the user to complete the step manually, then re-run.

## File-based

These connectors parse local files without network access. Run on-device only. **All file-based connectors are first-run portable** — the user supplies the file and it works.

| Connector | Source | Maintainer-verified | First-run portable |
|---|---|---|---|
| claude_code | `~/.claude/projects/**/*.jsonl` | ✅ | ✅ |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | ✅ | ✅ |
| whatsapp | `~/.pdpp/imports/whatsapp/*.txt` (chat exports) | 🟡 code ready | ✅ (expected) |
| google_takeout | `~/.pdpp/imports/google_takeout/` (extracted takeout) | 🟡 code ready | ✅ (expected) |
| google_maps | `~/.pdpp/imports/google_maps/` (Google Maps Timeline export file or legacy Takeout location file; not API-backed) | 🟡 code ready | ✅ (expected) |
| twitter_archive | `~/.pdpp/imports/twitter_archive/` (extracted archive) | 🟡 code ready | ✅ (expected) |
| imessage | `~/Library/Messages/chat.db` (auto-discovered on macOS) | 🟡 code ready | ✅ (expected) |
| apple_health | `~/.pdpp/imports/apple_health/` (extracted iOS export) | 🟡 code ready | ✅ (expected) |
| ical | `.ics` files or `ICAL_SUBSCRIPTION_URL` | 🟡 code ready | ✅ (expected) |

Docker runs do not see the host home directory unless it is mounted. The default
compose contract mounts empty local import directories at `/imports/claude` and
`/imports/codex`; set `PDPP_DOCKER_CLAUDE_CODE_HOME` and
`PDPP_DOCKER_CODEX_HOME` to host paths when collecting real local files. Inside
the container, leave `CLAUDE_CODE_HOME=/imports/claude`,
`CLAUDE_CODE_PROJECTS_DIR=/imports/claude/projects`, and
`CODEX_HOME=/imports/codex`.

## How to run a connector

```bash
# One-shot run
node packages/polyfill-connectors/bin/orchestrate.js run <name>

# Validate all manifests
node packages/polyfill-connectors/bin/register-all.js --embedded

# Query results
sqlite3 packages/polyfill-connectors/.pdpp-data/pdpp.sqlite \
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

The 5 runtime requirements are formalized: resources-filter enforcement, filesystem binding, tombstones, INTERACTION on missing credentials, flushAndExit.

## Open questions (3)

- Connector configuration surface — manifest-declared `credentials_schema` + `options_schema`
- RS storage topology — unified vs per-connector DBs
- Credential storage — vault interface
