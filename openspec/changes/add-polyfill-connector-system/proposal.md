# Add polyfill connector system

**Status:** In progress — MVP-5 landed, fleet expanded to 30 connectors (2026-04-19 EOD)
**Owner:** the owner (with Claude working autonomously overnight 2026-04-19 → 2026-04-20; continued same-day)
**Scope (original):** MVP polyfill connectors for the owner's real data (YNAB, Gmail, ChatGPT, Amazon, USAA) + scheduler + inbox + ntfy notifications.
**Scope (expanded 2026-04-19):** +21 additional connectors including local coding-agent history (Claude Code, Codex), file-based imports (WhatsApp, Google Takeout, Twitter archive, iMessage, Apple Health, iCal), pending-credential API connectors (GitHub, Oura, Spotify, Strava, Notion, Reddit, Pocket, Slack), and scaffolded browser scrapers (Anthropic, Shopify, HEB, Wholefoods, LinkedIn, Meta, Loom, Uber, DoorDash).

**Delivery signal:** ~50k records from YNAB + Gmail + ChatGPT + USAA are already queryable via the RS. Claude Code + Codex ingests are in flight. See `tasks.md` for the full table.

## Why

The reference implementation today has sample polyfill connectors (Spotify, GitHub, Reddit) backed by seed fixtures. It does not yet have **living polyfill connectors against real platforms** for a real user, running on a real schedule, with a real human-in-the-loop interaction channel.

the owner encountered a concrete motivating scenario: a coding agent with access only to YNAB could not efficiently reconcile transactions because it lacked context — Amazon order details, USAA/Chase bank memos, Uber trip info, Expensify reimbursement status. If PDPP polyfill connectors existed for all of those sources, the agent could issue one selection request, the user could approve one grant, and the agent would have everything it needs.

This change implements the MVP of that vision: a self-hosted polyfill-connector package sitting beside the reference implementation, running real connectors against real user data, with a lean UX that makes autonomous operation feel good even for non-technical users.

This is separate from the reference-implementation samples by design. It is **not** part of the forkable reference substrate. It is the owner's personal polyfill collection, built on top of the reference, demonstrating what "the most successful version of PDPP" looks like when it meets reality.

## What Changes

### New package
- `packages/polyfill-connectors/` — sibling to `apps/web/` and `reference-implementation/`. Lives in the monorepo but does not alter the reference substrate.

### MVP connectors (in priority order)
1. **YNAB** (API, Personal Access Token) — **DONE** end-to-end as of 2026-04-19 03:42 UTC. Real data flows. Incremental sync via `server_knowledge`. Needs schema completion pass (scheduled_transactions + months streams).
2. **Gmail** (IMAP + Google app-specific password) — no browser. Pluggable auth strategy so OAuth can slot in later for non-Gmail providers.
3. **ChatGPT** (browser session, bootstrapped profile) — uses private `/backend-api/` endpoints. Tree-walk message extraction.
4. **USAA** (browser session, bootstrapped profile) — scrape transactions, accounts, statements. Investigate USAA's built-in export feature — if drivable, prefer it over DOM scraping.
5. **Amazon** (browser session) — **blocked on the owner's 2FA** until he returns. Scaffolded tonight against `~/code/data-connectors/amazon/` prior art so it's ready to run the moment 2FA clears.

### Operational infrastructure
- **Browser profile**: single persistent Playwright context at `~/.pdpp/browser-profile/`, `channel: 'chrome'`, fixed viewport/UA, shared by all browser-backed connectors. One bootstrap session logs in to everything; scrapers reuse cookies.
- **Session keep-alive**: lightweight "am I still logged in?" probe every ~2 hours per browser-backed connector. Not often enough to look botlike; often enough to beat idle-TTL expiry.
- **Scheduler**: extend `reference-implementation/runtime/scheduler.js` with SQLite-backed run history and per-connector intervals. Jittered schedules. Exponential backoff on failure.
- **Inbox**: single parked-interactions list on the personal server. CLI command `pdpp inbox` + minimal web page at `/inbox`. Forms for `credentials`/`otp`; "come to the browser" affordance for `manual_action`.
- **ntfy notifications**: push to `pdpp-the owner` topic on `ntfy.vivid.fish` (self-hosted, auth-enforced) whenever the inbox gains an item or a critical failure occurs.
- **Pause/resume INTERACTION**: run parks on INTERACTION, resumes on INTERACTION_RESPONSE without re-scraping from zero. This is the single biggest UX win over vana-connect.
- **Distinct auth states**: "never authed" vs "expired token" vs "session died" are each their own copy in the inbox, not collapsed.

### Schema design discipline (per the owner's direction)
- **Flat schemas, platform-native field names.** No forced universal abstraction. The reconciliation agent joins via date/amount/memo, not a universal layer.
- **Each connector has a `design-notes/<connector>.md`** documenting: streams, field-by-field rationale, resilience strategy, what's in/out.
- **Completeness bar**: every valuable field the platform exposes is captured unless there's a reason to skip. "Reasonably resilient to platform evolution" is the stated bar.
- **Required fields kept minimal** so platform-side changes don't break grant enforcement.

### Out of scope (deferred to future changes)
- Chase, Uber, Expensify connectors.
- OAuth for Gmail (follow-up `add-gmail-oauth-connector`).
- page-agent auto-CAPTCHA solving.
- Hosted operator model (everything is self-hosted for now).
- UI for the inbox beyond a functional form page.
- Conformance claims beyond "it runs."

## Capabilities

### New Capabilities
- `polyfill-connector-mvp`: a running set of polyfill connectors against real user data on a real schedule with a real interaction inbox and real notifications.
- `browser-profile-binding`: concrete implementation of the spec's `browser_profile` binding. Managed persistent Chrome profile, shared across connectors, with bootstrap + probe commands.
- `polyfill-connector-package`: the new `packages/polyfill-connectors/` workspace, with its own package boundary, distinct from the reference substrate.

### Modified Capabilities
- `reference-implementation-runtime`: the in-process scheduler graduates from "experimental" to first-class with persistent history.
- `reference-implementation-server`: gains an inbox + ntfy bridge, alongside existing AS/RS surfaces.

## Impact

- `packages/polyfill-connectors/` — new
- `reference-implementation/runtime/scheduler.js` — extended (persistence, keep-alive, jitter)
- `reference-implementation/server/` — inbox endpoints, ntfy adapter
- `reference-implementation/manifests/` — polyfill manifests registered from the new package at startup
- No changes to `spec-core.md` or `spec-collection-profile.md`

## Open questions (decided autonomously overnight; review on the owner's return)

Any decision marked "(autonomous 2026-04-19)" in a design note is a decision Claude made without the owner's input and is explicitly open to reversal.

## Checkpoint at start of work

Already live before autonomous work begins:
- Browser profile bootstrapped (ChatGPT ✓, USAA ✓, Amazon ✗ pending 2FA)
- Headless probes verified (ChatGPT ✓, USAA ✓)
- YNAB connector running end-to-end against the owner's 4 real budgets, 111 recent transactions, including the actual Uber SF trip transaction the motivating agent was trying to reconcile
- ntfy topic `pdpp-the owner` live with the owner's phone subscribed
