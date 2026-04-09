---
title: "Connector Ecosystem: Runtime Landscape and Third-Party Sources"
---


Date: 2026-03-30

## Browser abstraction decision

### Model A vs Model B

Two models for how connectors interact with browsers:

- **Model A (current/recommended):** Runtime owns the browser and provides Playwright Page + ConnectorContext to connectors. Connectors use Playwright's full API. Simple, powerful, debuggable.
- **Model B (deferred):** Runtime exposes browser via JSONL messages (BROWSER/BROWSER_RESULT). Connectors never touch Playwright. Enables process isolation and language independence but adds a fragile proxy layer.

### Decision: Model A, with JSONL for everything else

**Codex gpt-5.4 recommendation (2026-03-30):** Do not build a custom BROWSER JSONL protocol. Connectors need real browser power (Cloudflare challenges, SPA navigation, network interception, cookie extraction). A message protocol either reimplements Playwright or falls back to `evaluate` for everything hard.

The protocol is JSONL for RECORD/STATE/INTERACTION/DONE. Browser automation is a runtime capability, not a protocol concern. When process isolation or language independence is needed, expose a CDP WebSocket URL rather than inventing a custom browser protocol.

**Phased approach (from model-b-runtime-provided-browser.md):**
1. Phase 1 (now): Formalize BrowserCapability interface — refactor, not behavior change
2. Phase 2 (when needed): Message protocol OR CDP endpoint for out-of-process connectors
3. Phase 3 (defer): Full process isolation with container support

## Connector strategies

How connectors get data from sources:

| Strategy | Examples | Runtime needs | Language |
|---|---|---|---|
| API client | Plaid, Terra API, Spotify API, GitHub API | HTTP only | Any |
| Browser automation | Instagram, ChatGPT, LinkedIn, H-E-B | Playwright/CDP + browser | JS/TS (current), any via CDP |
| Session cookie extraction | slackdump, DiscordChatExporter | Cookies from browser profile, no live browser | Any |
| Archive/export parser | Timelinize, WhatsApp export, Facebook DYI, Google Takeout | File system access | Any |
| Browser extension | LinkedIn scrapers, Amazon purchase history | Runs in user's browser, sends to local connector | JS (extension) + any (receiver) |
| Aggregator wrapper | Plaid (12K+ banks), Terra (Fitbit/Oura/Garmin/Apple Health) | Just API calls | Any |

## Third-party tools that could become PDPP connectors

### Go-based

| Tool | Data | Auth method | License | Wrap difficulty |
|---|---|---|---|---|
| **slackdump** (rusq/slackdump) | Slack messages, threads, files, users, emojis | Browser session cookie (`d` cookie) or export token | GPL-3.0 | Easy — already outputs JSON/SQLite |
| **Timelinize** (timelinize/timelinize) | 10+ sources: photos, Facebook, Instagram, Twitter, Google, iCloud, Strava, SMS, email, contacts | Per-source (OAuth, file import, API keys) | Apache-2.0 | Medium — need Go wrapper per data source |

### C# / .NET

| Tool | Data | Auth method | License | Wrap difficulty |
|---|---|---|---|---|
| **DiscordChatExporter** (Tyrrrz/DiscordChatExporter) | Discord messages, DMs, servers, attachments | User token | GPL-3.0 | Easy — supports JSON export, CLI invokable |

### Python

| Tool | Data | Auth method | License | Wrap difficulty |
|---|---|---|---|---|
| **tg-archive** (knadh/tg-archive) | Telegram groups, private messages, media | Telegram API credentials (api_id, api_hash, phone) | MIT | Easy — syncs to SQLite, read and emit |
| **rexport** (karlicoss/rexport) | Reddit comments, submissions, upvotes, saved | Reddit API (client_id, client_secret, username/password) | MIT | Easy — outputs JSON arrays |

### Aggregator services (one connector = many sources)

| Service | Data domain | Sources covered | Auth | Wrap difficulty |
|---|---|---|---|---|
| **Plaid** | Financial (transactions, accounts, balances, investments) | 12,000+ US/EU financial institutions | Plaid Link OAuth flow → access_token | Easy — structured JSON API |
| **Terra API** | Health/fitness (workouts, sleep, heart rate, steps) | Fitbit, Oura, Garmin, Apple Health, Whoop, Peloton, etc. | Terra OAuth → API calls | Easy — structured JSON API |
| **CommonHealth** | Health records (Android) | 400+ data sources | On-device consent | Medium — Android-specific |

### Archive parsers (user provides exported data)

| Source | Export format | Parser exists? | Notes |
|---|---|---|---|
| WhatsApp | .txt/.zip from phone export | Python parsers exist | E2E encrypted, no API access possible |
| Facebook DYI | .zip archive (HTML or JSON) | Timelinize parses it | Large archives, complex structure |
| Google Takeout | .zip per-product | Timelinize parses some | 51-54 data types |
| Apple Data & Privacy | .zip archive | No standard parser | 15 categories, 1-7 day fulfillment |
| Instagram data export | .zip archive | Timelinize parses it | Different format eras |

## Timelinize data sources (potential connectors)

Each Timelinize data source implements either `FileImporter` (parses archives) or `APIImporter` (calls APIs) or both:

1. Photos/Videos (Apple HEIC/MOV, Google Photos, Samsung, generic EXIF)
2. Facebook (DYI archive parser)
3. Instagram (archive parser)
4. Twitter/X (archive parser)
5. Google Location History
6. Apple iCloud
7. Strava (API + GPS data)
8. SMS/Text Messages (SMS Backup & Restore format)
9. Email (Mbox/IMAP)
10. Contacts (vCard, CSV)
11. WhatsApp (archive parser)
12. Telegram (archive parser)
13. iMessage (local database)

## Runtime requirements summary

The PDPP connector protocol (JSONL stdin/stdout) is universal. What varies is the runtime's optional capabilities:

| Capability | Declared in manifest | Who needs it |
|---|---|---|
| `browser: "required"` | Manifest `runtime_requirements` | Instagram, ChatGPT, LinkedIn, H-E-B scrapers |
| `browser: "optional"` | Same | Connectors that prefer browser but can fall back to API |
| `browser: "none"` | Same | Plaid, Terra, GitHub API, slackdump, Timelinize, archive parsers |
| File system access | Not yet in manifest (future) | Archive parsers, Timelinize file importers |
| Network access | Implicit (connectors handle their own HTTP) | All API-based connectors |

A runtime host either can or can't provide what the connector needs. If it can't and the connector requires it, the run fails with a clear error. The protocol is the same everywhere.

## Implications for the spec

1. **The JSONL protocol is correct.** Every connector type (Go binary, Python script, Node.js + Playwright, aggregator wrapper) can write JSONL to stdout.
2. **Browser is a runtime capability, not a protocol concern.** Connectors that need a browser get one from the runtime. The protocol doesn't define how.
3. **Aggregator connectors (Plaid, Terra) are high leverage.** One Plaid connector = 12,000+ financial institutions. One Terra connector = dozens of health/fitness platforms.
4. **Archive parsers need file system access.** The manifest may need a `runtime_requirements.filesystem` capability in the future.
5. **Go/Python/C# connectors work today** via the JSONL protocol. No Node.js required. The runtime just spawns a process.

## Sources

- Gemini 3.1 Pro Preview research with Google Search (2026-03-30)
- Codex gpt-5.4 analysis (2026-03-30): browser abstraction recommendation
- model-b-runtime-provided-browser.md: phased approach to browser abstraction
- slackdump: https://github.com/rusq/slackdump
- DiscordChatExporter: https://github.com/Tyrrrz/DiscordChatExporter
- tg-archive: https://github.com/knadh/tg-archive
- rexport: https://github.com/karlicoss/rexport
- Timelinize: https://github.com/timelinize/timelinize
- Plaid: https://plaid.com/docs/
- Terra API: https://docs.tryterra.co/
