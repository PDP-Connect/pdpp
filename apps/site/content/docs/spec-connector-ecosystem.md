---
title: "Connector Ecosystem"
description: "Reference runtime notes for connectors: browser abstraction decisions and third-party source integration."
---

<Callout type="info" title="Spec status">
  Status: **Informative**

  Date: 2026-07-07 (revised from 2026-03-30)

  Scope: Survey of connector types and the browser-abstraction decision behind the Collection Profile.
</Callout>
## Browser abstraction decision

Two models were considered in March 2026 for how connectors interact with browsers:

- **Model A:** the runtime owns the browser and hands connectors a live automation handle. Simple, powerful, debuggable.
- **Model B:** the runtime exposes the browser through custom JSONL messages (BROWSER/BROWSER_RESULT). Connectors never touch the browser API. Enables process isolation and language independence, but adds a fragile proxy layer.

**Decision: no custom BROWSER message protocol.** Connectors need real browser power (bot challenges, SPA navigation, network interception, cookie extraction). A message protocol either reimplements the automation API or falls back to `evaluate` for everything hard. The JSONL protocol stays reserved for RECORD/STATE/INTERACTION/DONE; browser automation is a runtime capability declared in the manifest, not a protocol concern.

The isolation path chosen instead was a standard browser endpoint: the [Collection Profile](spec-collection-profile) now specifies the `browser_automation` binding as a CDP WebSocket (`{ interface: "cdp", ws_url }`) that the runtime provides to the connector process. This gives process isolation and language independence without a bespoke proxy protocol.

## Connector strategies

How connectors get data from sources:

| Strategy | Examples | Runtime needs | Language |
|---|---|---|---|
| API client | Plaid, Terra API, Spotify API, GitHub API | HTTP only | Any |
| Browser automation | ChatGPT, LinkedIn, H-E-B | `browser_automation` binding (CDP) | Any that speaks CDP |
| Session cookie extraction | slackdump, DiscordChatExporter | Cookies from browser profile, no live browser | Any |
| Archive/export parser | Timelinize, WhatsApp export, Facebook DYI, Google Takeout | `filesystem` binding | Any |
| Browser extension | LinkedIn scrapers, Amazon purchase history | Runs in user's browser, sends to local connector | JS (extension) + any (receiver) |
| Aggregator wrapper | Plaid (many banks), Terra (Fitbit/Oura/Garmin/Apple Health) | Just API calls | Any |

## Third-party tools that could become PDPP connectors

### Go-based

| Tool | Data | Auth method | License | Wrap difficulty |
|---|---|---|---|---|
| **slackdump** (rusq/slackdump) | Slack messages, threads, files, users, emojis | Browser session cookie (`d` cookie) or export token | GPL-3.0 | Easy: already outputs JSON/SQLite |
| **Timelinize** (timelinize/timelinize) | 10+ sources: photos, Facebook, Instagram, Twitter, Google, iCloud, Strava, SMS, email, contacts | Per-source (OAuth, file import, API keys) | Apache-2.0 | Medium: need Go wrapper per data source |

### C# / .NET

| Tool | Data | Auth method | License | Wrap difficulty |
|---|---|---|---|---|
| **DiscordChatExporter** (Tyrrrz/DiscordChatExporter) | Discord messages, DMs, servers, attachments | User token | GPL-3.0 | Easy: supports JSON export, CLI invokable |

### Python

| Tool | Data | Auth method | License | Wrap difficulty |
|---|---|---|---|---|
| **tg-archive** (knadh/tg-archive) | Telegram groups, private messages, media | Telegram API credentials (api_id, api_hash, phone) | MIT | Easy: syncs to SQLite, read and emit |
| **rexport** (karlicoss/rexport) | Reddit comments, submissions, upvotes, saved | Reddit API (client_id, client_secret, username/password) | MIT | Easy: outputs JSON arrays |

### Aggregator services (one connector = many sources)

| Service | Data domain | Sources covered | Auth | Wrap difficulty |
|---|---|---|---|---|
| **Plaid** | Financial (transactions, accounts, balances, investments) | US/EU financial institutions via Plaid's aggregation coverage | Plaid Link OAuth flow → access_token | Easy: structured JSON API |
| **Terra API** | Health/fitness (workouts, sleep, heart rate, steps) | Fitbit, Oura, Garmin, Apple Health, Whoop, Peloton, etc. | Terra OAuth → API calls | Easy: structured JSON API |
| **CommonHealth** | Health records (Android) | 400+ data sources | On-device consent | Medium: Android-specific |

### Archive parsers (user provides exported data)

| Source | Export format | Parser exists? | Notes |
|---|---|---|---|
| WhatsApp | .txt/.zip from phone export | Python parsers exist | E2E encrypted, no API access possible |
| Facebook DYI | .zip archive (HTML or JSON) | Timelinize parses it | Large archives, complex structure |
| Google Takeout | .zip per-product | Timelinize parses some | 51-54 data types |
| Apple Data & Privacy | .zip archive | No standard parser | 15 categories, 1-7 day fulfillment |
| Instagram data export | .zip archive | Timelinize parses it | Different format eras |

## Runtime requirements summary

The connector run protocol (JSONL over stdin/stdout) is universal. What varies is which bindings a connector declares in `runtime_requirements.bindings` and whether the runtime can satisfy them. The Collection Profile defines the standard bindings: `browser_automation` (CDP WebSocket), `browser_profile`, `filesystem`, `network`, `interactive`, and `loopback_listen`; extension bindings use namespaced identifiers. Binding matching happens before the connector process is spawned: if the runtime cannot satisfy a required binding, the run fails with a clear error. See [Collection Profile Section 1](spec-collection-profile) for descriptors and matching rules.

## Implications for the spec

1. **The JSONL protocol is correct.** Every connector type (Go binary, Python script, Node.js process, aggregator wrapper) can write JSONL to stdout.
2. **Browser access is a binding, not a protocol message.** Connectors that need a browser declare `browser_automation` and receive a CDP WebSocket descriptor at START. The run protocol itself stays browser-free.
3. **Aggregator connectors (Plaid, Terra) cover many sources at once.** One Plaid connector reaches the financial institutions Plaid aggregates; one Terra connector reaches the health/fitness platforms Terra supports.
4. **Archive parsers are served by the `filesystem` binding**, which the Collection Profile now defines as a standard binding.
5. **Go/Python/C# connectors work today** via the JSONL protocol. No Node.js required. The runtime just spawns a process.

## Sources

- slackdump: https://github.com/rusq/slackdump
- DiscordChatExporter: https://github.com/Tyrrrz/DiscordChatExporter
- tg-archive: https://github.com/knadh/tg-archive
- rexport: https://github.com/karlicoss/rexport
- Timelinize: https://github.com/timelinize/timelinize
- Plaid: https://plaid.com/docs/
- Terra API: https://docs.tryterra.co/
