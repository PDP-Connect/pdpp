# Add polyfill connector system

**Status:** In progress — 8 connectors pristine (951k records), 3 open-question notes on partial-run honesty mechanism, Chase scaffolded (2026-04-21)
**Owner:** the owner (with Claude working autonomously across multi-day sessions 2026-04-19 → 2026-04-21)
**Scope (original):** MVP polyfill connectors for the owner's real data (YNAB, Gmail, ChatGPT, Amazon, USAA) + scheduler + inbox + ntfy notifications.
**Scope (expanded 2026-04-19):** +21 additional connectors including local coding-agent history (Claude Code, Codex), file-based imports (WhatsApp, Google Takeout, Twitter archive, iMessage, Apple Health, iCal), pending-credential API connectors (GitHub, Oura, Spotify, Strava, Notion, Reddit, Pocket, Slack), and scaffolded browser scrapers (Anthropic, Shopify, HEB, Wholefoods, LinkedIn, Meta, Loom, Uber, DoorDash).
**Scope (added 2026-04-21):** Chase (via QFX download through the chase.com browser UI — Direct Connect is effectively dead for new personal-account enrollments per the 2026-04-20 research; see `design-notes/chase.md`).

**Delivery signal (2026-04-21):** 951,313 records across 8 active connectors queryable via the RS: slack 349k, claude-code 236k, codex 74k, gmail 50k, ynab 22k, chatgpt 11k, github 9k, usaa 1k. All connectors' most recent run committed state successfully. See `tasks.md` for the full table.

**Supersession note (2026-04-25):** the original shared browser-profile / browser-daemon plan below is historical. `openspec/changes/retire-browser-daemon` makes per-connector isolated Patchright profiles (`~/.pdpp/profiles/<connector>/`) the only supported browser-launch path; `design-notes/host-browser-bridge-open-question.md` tracks the separate Docker/remote-browser UX question.

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
5. **Amazon** (browser session) — UNBLOCKED 2026-04-21 (new account). Auto-login verified end-to-end against `#ap_email_login` / `#ap_password`; OTP branch untested (Amazon's device-trust persistence skipped 2FA on the wiped-cookie test). Order-detail fetch intentionally stubbed pending live DOM probe (see `design-notes/amazon.md`). Manifest overclaims ~11 fields; schema-vs-implementation reconciliation pending.
6. **Chase** (browser session + QFX parse) — v0.1 scaffolded 2026-04-21: manifest registered with AS, scope committed to `accounts + transactions + balances` (QFX-backed), auto-login probe succeeds through full 2FA including the mds-* shadow DOM method-chooser and OTP-input. Direct Connect considered and rejected per research. Connector `index.js` + `src/auto-login/chase.js` not yet implemented. See `design-notes/chase.md` for scope and strategy.

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
- Uber, Expensify connectors. (Chase moved IN scope 2026-04-21.)
- OAuth for Gmail (follow-up `add-gmail-oauth-connector`).
- page-agent auto-CAPTCHA solving.
- Chase v0.2 streams: `statements` (PDF download), `credit_card_billing`, `rewards`. Scaffolded in the manifest as future work per `design-notes/chase.md`.
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
