# Chase connector — scope and strategy

**Status:** scope decided 2026-04-20; connector not yet implemented (awaiting live DOM probe)
**Owner:** the owner (login available) + Claude (autonomous implementation within scope)
**Related open questions:** `partial-run-semantics`, `cursor-finality`, `gap-recovery-execution`, `blob-hydration`, `layer-2-completeness`

## Why a Chase connector

Financial transactions are a high-value polyfill stream for the same reason USAA and YNAB are: reconciliation, life-history analysis, owner self-export, audit. Chase is the largest US retail bank by active checking accounts and is a natural parallel to USAA for demonstrating that PDPP polyfill connectors generalize across institutions.

## Strategy: QFX download via browser, not Direct Connect

### What was considered

Three candidate paths existed. **Research done 2026-04-20 — see summary in `design-notes/chatgpt.md` neighbor pattern if a separate research note is later extracted.**

1. **Chase OFX Direct Connect (SGML/XML over HTTPS).** Protocol-level, stable, canonical. Used by Quicken/GnuCash historically.
2. **QFX download via chase.com browser UI.** An OFX dialect delivered as a downloadable file. Same canonical record shape as Direct Connect.
3. **Pure HTML scrape of transaction tables.** Brittle; selectors drift monthly.

### Why QFX download wins

**Direct Connect is effectively dead for new personal-account enrollments.** Chase announced deprecation for third-party aggregator apps in October 2022. Community reports across 2024–2026 (GnuCash, Moneydance, Beancount forums; csingley/ofxtools GitHub issues) converge on: the AccountSafe → Desktop Software enrollment path either isn't surfaced anymore for most users, or enrollment completes but OFX requests return `signon error 2000: USER NOT AUTHORIZED` / `15510`. Probability of success on a new enrollment today is under 30%. The only party still reliably pulling Chase via OFX-adjacent means is Quicken itself, routed through Intuit's Express Web Connect+ (EWC+/FDX) — which requires a commercial Intuit relationship.

**Pure HTML scraping has a much larger brittle surface than needed.** Chase's transaction table renders thousands of cells per account-year with A/B-tested row shapes, sort columns, filter widgets. Parsing HTML to canonical record shape would mean hundreds of selectors, each subject to quiet Chase UI updates.

**QFX download splits the brittleness cleanly:**
- The **download click-path** is brittle — but it's small (5–6 selectors per account type: navigate → pick date range → pick format → click download → confirm dialog).
- The **resulting QFX file** is canonical and specified. Parsing it uses a standard OFX library (`node-ofx` / equivalent), not bespoke HTML regex. QFX record shape has been stable since the early 2000s.

This matches the USAA strategy exactly: USAA CSV export is USAA's canonical transaction-record format; the connector navigates the UI to click "Export" and parses the CSV. For Chase, QFX plays the same role as CSV did for USAA.

## What QFX gives us (in-scope for v0.1)

| Stream | Provided by QFX | Notes |
|---|---|---|
| `accounts` | `<ACCTINFO>` / `<ACCTLIST>` — routing number, account number (masked), account type | Enriched with dashboard-page friendly names |
| `transactions` | `<STMTTRN>` — type (DEBIT/CREDIT/CHECK/XFER/PAYMENT/FEE), posted date, amount, memo, check number, FITID (unique), payee, reference number | For credit cards: merchant name, merchant city |
| `balances` | `<LEDGERBAL>`, `<AVAILBAL>` — as-of date | Point-in-time balance per account |

## What QFX does NOT give us

These are UI-rendered or stored server-side outside the OFX surface. Each is a potential additional stream **out of scope for v0.1** unless explicitly added:

- **Statement PDFs** — monthly statements as rendered documents. Analogue to USAA's `statements` stream. Mechanism: browser-navigate to Documents section, download PDFs one-by-one like USAA.
- **Credit card billing surface** — statement balance, minimum payment due, payment due date, APR, rewards points balance, credit limit, available credit. Analogue to USAA's `credit_card_billing` stream.
- **Rewards / Ultimate Rewards** — points balance, redemption history. Lives at a separate URL.
- **Scheduled / recurring transactions** — upcoming bill pays, scheduled transfers, autopay arrangements. Bill Pay section.
- **Payees / Zelle recipient address book** — saved-payee nicknames, Zelle aliases.
- **Secure messages (chase.com inbox)** — Chase's internal message center.
- **Disputes / fraud claims** — claim status, submitted documents.
- **Alerts / notification settings** — threshold settings, SMS subscriptions.
- **Card metadata** — virtual card numbers, lock status, card art.
- **Investments** — Chase self-directed positions, dividends, capital gains (separate `J.P. Morgan Self-Directed` product surface with its own mechanics).
- **Loan / mortgage details** — amortization schedules, escrow analysis (separate `chase.com/mortgage` surface).

## v0.1 scope commitment

**Ship these three streams:**

1. `accounts` — one record per Chase account (checking, savings, credit card, etc.). Hybrid source: QFX `ACCTINFO` for identity + chase.com dashboard scrape for friendly name, open date, tier.
2. `transactions` — all posted transactions per account, from QFX. Date range walked per account to handle Chase's per-request date-window cap (historically ~90 days per QFX request for personal accounts).
3. `balances` — point-in-time ledger + available balance per account, from QFX.

**Manifest declares only these three.** No overclaiming. Other potential streams (statements, credit_card_billing, rewards) defer to v0.2+ with their own scope notes.

## v0.2 candidates, ranked by owner value

When v0.1 is operational, the next streams to add, in priority order:

1. `statements` — PDFs from Documents section. Mirrors USAA's implementation pattern (pdf-parse + content-addressed storage). High owner value, medium implementation cost.
2. `credit_card_billing` — one record per credit-card account with current cycle details. Mirrors USAA. Low implementation cost, medium owner value.
3. `rewards` — Ultimate Rewards points and history. Chase-specific surface; no USAA analogue.

## Operational shape (planned v0.1)

- **Auth:** `CHASE_USERNAME` + `CHASE_PASSWORD` in env. `src/auto-login/chase.js` drives login + 2FA via `INTERACTION kind=otp`, same pattern as USAA. First-run 2FA will be SMS-based; chase.com may additionally require device registration, which session-scoped cookies in the daemon's persistent profile are expected to handle.
- **Browser daemon:** uses the shared long-lived Chromium from `src/browser-daemon.js` so session cookies (Chase uses short-TTL session cookies aggressively) survive between runs. Same rationale as the USAA daemon work in commit `7dad996`.
- **Anti-bot:** Chase runs Akamai Bot Manager + JPMC device fingerprinting. Per research, vanilla Playwright is detected within a session or two; the plan is (a) persistent profile via daemon, (b) human-like timing with randomized delays, (c) headed mode for bootstrap / re-auth (`PDPP_CHASE_HEADLESS=0`).
- **Date-range walker:** Chase QFX is capped at ~90 days per request. Connector walks backward from today in 90-day windows until QFX returns empty or throws. For a typical 7-year history this is ~28 sequential requests per account.
- **QFX parsing:** `node-ofx` or `@wymp/ofx-parser` npm library. QFX is a strict OFX subset with Quicken's header; any OFX-capable parser handles it.
- **Record keys:** QFX `FITID` is Chase's unique transaction identifier. Use `${accountId}|${fitid}` as PDPP primary key. Across date-window boundaries, the same transaction with the same `FITID` dedupes cleanly — no need for hash-based dedup like USAA required.
- **Cursor:** per-account last-walked-through date. Next run walks from `last_walked` forward to today, falling back to 90-day windows again for older data if state is missing.

## Explicit non-goals for v0.1

- **No Direct Connect attempt.** Per research, not worth the enrollment cost.
- **No Plaid / MX / EWC+.** Third-party brokers defeat PDPP's owner-to-client trust model.
- **No investment / mortgage / loan streams.** Different product surfaces.
- **No PDF statements yet.** Deferred to v0.2.

## Risks and open items (to resolve via live probe before code lands)

- **[probe] Does Chase QFX still download?** Verify on the actual account that a browser-driven QFX download produces a non-empty, parseable file. If QFX has been quietly discontinued on retail consumer accounts (as Direct Connect was), the strategy collapses.
- **[probe] What's the per-request date window?** Empirically test 90, 180, 365-day requests. Chase may have changed this.
- **[probe] Does Chase prompt for 2FA per-download?** If the download flow triggers a step-up-auth on every request, the connector's ~28-windows-per-account plan breaks.
- **[probe] What's the selector path from dashboard to QFX download?** Unknown without live DOM. This is the brittle-but-small surface.
- **[probe] Credit cards vs checking/savings** — is the QFX export affordance in the same location for both account types? (USAA had subtle CC variant selectors that required a separate code path.)
- **[probe] Can we use the `statements` download page in parallel?** Sets up v0.2 sanely if the answer is yes.

## Cross-cutting

- `usaa.md` — template for the CSV/PDF/scrape trifecta that this connector will mirror (QFX instead of CSV).
- `partial-run-semantics-open-question.md` — Chase's 90-day window walker will produce the same "range shortened silently" pattern USAA has if we're not careful. SKIP_RESULTs must name the specific date ranges that failed.
- `cursor-finality-and-gap-awareness-open-question.md` — Chase's per-account cursor should be a `high_water` in the taxonomy; coverage_intervals matter for multi-year backfills.
- `gap-recovery-execution-open-question.md` — rate-limited / 5xx failures during a date-window walk are Category 1 (transient, runtime-retriable); `qfx_format_unsupported` on an account tier would be Category 2 (connector upgrade needed).
- `pdpp-trust-model-framing.md` — financial data is the archetype of the "multiple-party frame" where consent semantics matter most; Chase transactions are the reference case for "owner grants X client access to last-90-days-of-checking" consent flows.
