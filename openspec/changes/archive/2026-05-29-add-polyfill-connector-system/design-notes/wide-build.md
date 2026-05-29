# Wide-build batch — overnight expansion

**Status:** added 2026-04-19 overnight after the owner asked "why not go big and go wide while you wait for me to wake up?"

Built scaffolds for 13 additional connectors beyond the original 5-MVP (YNAB, Gmail, ChatGPT, USAA, Amazon). All have full manifests; implementations vary from complete (API-based with available creds) to scaffolded-pending-wiring (browser-based needing live session).

## Manifest table — all 19 connectors

| Connector | Auth | Tonight's state | Next step |
|---|---|---|---|
| **ynab** | PAT | ✅ Full backfill (10,311 records) | Schedule ongoing incremental |
| **gmail** | IMAP app password | 🏃 Full backfill running (~17k msgs) | — |
| **chatgpt** | Browser profile | 🔒 Blocked on Gmail finishing | Run post-Gmail |
| **usaa** | Browser profile | 🔒 Blocked on Gmail finishing | CSV driver wiring on the owner's return |
| **amazon** | Browser profile | 🚫 Blocked on 2FA | the owner bootstraps w/ wife's phone |
| **github** | PAT | 🟡 Ready; needs `GITHUB_PERSONAL_ACCESS_TOKEN` in env | the owner adds PAT |
| **oura** | PAT | 🟡 Ready; needs `OURA_PERSONAL_ACCESS_TOKEN` | the owner adds PAT |
| **spotify** | OAuth token | 🟡 Ready; needs `SPOTIFY_ACCESS_TOKEN` | the owner generates token |
| **anthropic** | Browser profile | 📝 Scaffolded | Wire org-UUID + endpoint discovery |
| **shopify** | Browser profile | 📝 Scaffolded | Wire Apollo-cache extraction |
| **heb** | Browser profile | 📝 Scaffolded | Wire DOM selectors |
| **wholefoods** | Amazon session | 📝 Scaffolded | Filter Amazon orders + USDA lookup |
| **linkedin** | Browser profile | 📝 Scaffolded | Voyager API wiring (hostile anti-bot) |
| **meta** (Instagram) | Browser profile | 📝 Scaffolded | Polaris GraphQL operation discovery |
| **loom** | Browser profile | 📝 Scaffolded | Apollo-cache extraction |
| **uber** | Browser profile | 📝 Scaffolded | GraphQL operation-hash capture |
| **doordash** | Browser profile | 📝 Scaffolded | GraphQL OrderHistoryQuery capture |
| **whatsapp** | File-based (chat exports) | ✅ Implemented parser | Drop `.txt` files into `~/.pdpp/imports/whatsapp/` |
| **slack** | slackdump subprocess | ✅ Implemented | `go install .../slackdump@latest` + set `SLACK_WORKSPACE` |

Legend: ✅ fully working · 🏃 running · 🟡 ready-pending-creds · 📝 scaffolded-awaiting-wiring · 🔒 queued · 🚫 blocked-on-user

## Shared scaffolding introduced

- **`src/browser-scraper-runtime.js`** — single harness for all browser-session connectors. Each connector just provides `probeSession` and `scrape`. Prevents boilerplate drift across the ~10 browser-scrape connectors and keeps INTERACTION handling consistent (one source of truth).

## Design choices (autonomous, 2026-04-19)

1. **Scaffold vs ship.** Every scaffolded connector ships a valid manifest + a connector that probes the session and emits `SKIP_RESULT` with a clear `reason`. This means:
   - Orchestrator smoke-tests pass for every connector (DONE succeeded, 0 records).
   - the owner can register all manifests right away and see the consent surface even if no scraping works yet.
   - Actual selectors are explicitly marked "deferred to live session" — not optimistically hardcoded from prior art that may be stale.

2. **Prefer APIs over scraping where the platform has one.** GitHub, Oura, Spotify, Anthropic (future) are API-first. Less fragile than scraping, smaller LOC, faster to implement.

3. **Reuse external projects rather than re-implementing.** Slack delegated to `slackdump` subprocess. WhatsApp is a pure-JS parser (no external process needed — WhatsApp's export format is plaintext and well-documented).

4. **ChatGPT and Anthropic/Claude are sibling connectors.** Separate manifests because they're separate products with separate consent surfaces.

5. **Meta vs Instagram naming.** Connector is named `meta` because Instagram/Threads/Facebook share infrastructure; v1 targets Instagram but the connector ID is namespaced to `meta` for future expansion.

## What the owner should know

- **Add PATs for GitHub, Oura, Spotify in `.env.local`** to unlock three more fully-working connectors immediately.
- **For Slack:** install slackdump, set `SLACK_WORKSPACE=yourteam`, run the connector.
- **For WhatsApp:** export chats from mobile, drop `.txt` files in `~/.pdpp/imports/whatsapp/`, run the connector.
- **For browser-scrape scaffolds (anthropic, shopify, heb, linkedin, meta, loom, uber, doordash, wholefoods):** open a live session in bootstrap, then we wire the selectors together — each one takes 30 min once the session is live.

## Why shipping scaffolds tonight matters

Every scaffolded connector is a legitimate PDPP polyfill right now: it has a manifest with full schemas, declares its consent surface, probes the session, and communicates cleanly with the runtime. What it doesn't do yet is scrape — but that's orthogonal to the protocol. The protocol is exercised end-to-end. The fan-out demonstrates that PDPP's polyfill model scales horizontally.
