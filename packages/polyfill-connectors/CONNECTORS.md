# Polyfill connector registry

30 connectors, organized by auth/operational class. Last verified: 2026-04-19.

## API-based (token/PAT)

These connectors fetch via the platform's public HTTP API using a long-lived token. Bootstrap once; rotate periodically. Incremental via platform cursors.

| Connector | Auth | Bootstrap | Status | Records (live) |
|---|---|---|---|---|
| ynab | `YNAB_PAT` | Manual: ynab.com/settings → "New Token" | ✅ working | ~10,311 |
| github | `GITHUB_PERSONAL_ACCESS_TOKEN` | **Automated** via `bin/bootstrap-github-pat.js` | ✅ working | 553 |
| notion | `NOTION_API_TOKEN` | Manual: notion.so/my-integrations → "New integration" (automation designed; see [platform-bootstrap-research](../../openspec/changes/add-polyfill-connector-system/design-notes/platform-bootstrap-research.md)) | 🟡 ready |
| oura | `OURA_PERSONAL_ACCESS_TOKEN` | Manual: cloud.ouraring.com/personal-access-tokens | 🟡 ready |
| strava | `STRAVA_ACCESS_TOKEN` | Requires OAuth app registration → auth-code flow; not PAT-style | 🟡 ready |
| reddit | `REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD` | Script-app registration at reddit.com/prefs/apps → Resource Owner Password grant | 🟡 ready |
| spotify | `SPOTIFY_ACCESS_TOKEN` | OAuth app creation frozen by Spotify as of Feb 2026 | 🚫 blocked upstream |
| pocket | — | **Deprecated** (Mozilla shut Pocket down 2025-07-08) | 🚫 excluded |
| slack | `SLACK_WORKSPACE` + slackdump binary | Subprocess; wraps slackdump CLI | 🟡 ready |
| gmail | `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `GMAIL_IMAP_HOST` | Google app password in gmail settings | ✅ working | ~27,359 |

## Browser-scraper

These connectors drive a headless Playwright session against the shared profile at `~/.pdpp/browser-profile/`. One `bootstrap-browser` pass logs you in; connectors reuse the cookies. Session expiry is handled by `src/auto-login/<platform>.js` helpers that drive re-login + 2FA via `INTERACTION`.

| Connector | Bootstrap needs | Status |
|---|---|---|
| chatgpt | ChatGPT login (browser profile) | ✅ working (~10,616 records) |
| usaa | USAA member login (browser profile) + 2FA via SMS | ✅ working (887 records across 5 streams) |
| amazon | Amazon login (browser profile) + 2FA via wife's phone | 🚫 blocked (2FA on other phone) |
| anthropic | Claude.ai login | 🟡 scaffolded (selectors TBD) |
| shopify | Shopify admin login | 🟡 scaffolded |
| heb | HEB.com login | 🟡 scaffolded |
| wholefoods | Piggybacks on Amazon session | 🟡 scaffolded |
| linkedin | LinkedIn login | 🟡 scaffolded |
| meta | Instagram login | 🟡 scaffolded |
| loom | Loom login | 🟡 scaffolded |
| uber | Uber login | 🟡 scaffolded |
| doordash | DoorDash login | 🟡 scaffolded |

Scaffolded = manifest + connector shell exist with correct streams, but DOM selectors need a live co-pilot session to wire.

## File-based

These connectors parse local files without network access. Run on-device only.

| Connector | Source | Status |
|---|---|---|
| claude_code | `~/.claude/projects/**/*.jsonl` | ✅ working (ingest in progress) |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | ✅ working (ingest in progress) |
| whatsapp | `~/.pdpp/imports/whatsapp/*.txt` (chat exports) | ✅ ready — drop files and run |
| google_takeout | `~/.pdpp/imports/google_takeout/` (extracted takeout) | ✅ ready |
| twitter_archive | `~/.pdpp/imports/twitter_archive/` (extracted archive) | ✅ ready |
| imessage | `~/Library/Messages/chat.db` (auto-discovered on macOS) | ✅ ready |
| apple_health | `~/.pdpp/imports/apple_health/` (extracted iOS export) | ✅ ready |
| ical | `.ics` files or `ICAL_SUBSCRIPTION_URL` | ✅ ready |

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
