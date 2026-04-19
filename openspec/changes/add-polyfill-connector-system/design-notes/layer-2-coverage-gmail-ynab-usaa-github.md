# Layer 2 coverage audit: Gmail, YNAB, USAA, GitHub

**Raised:** 2026-04-19
**Context:** Layer 1 audits compare declared vs delivered fields. This note is Layer 2: manifest vs the platform's *actual surface* — what each source exposes that a user might want, regardless of what we currently declare. Auth surfaces (tokens/sessions) excluded per brief.

---

## Gmail

### Current manifest scope
`messages` (envelope + flags + snippet), `threads` (derived), `labels`, `attachments` (metadata only). Iterates `[Gmail]/All Mail`; labels derived from `X-GM-LABELS`.

### Source surface
IMAP `imap.gmail.com:993` and Gmail API expose substantially more than envelopes:

- **Bodies** — `BODY[TEXT]`, `BODY[1]` text/plain, `BODY[2]` text/html. Without bodies, semantic search, thread summarization, receipt parsing all fail.
- **Attachment bytes** — `BODY[n]` per `BODYSTRUCTURE`. v1 non-goal.
- **Inline calendar invites** — `text/calendar` parts (RSVP history).
- **List / bulk-mail headers** — `List-Id`, `List-Unsubscribe`, `List-Post`, `Precedence`, `Auto-Submitted`, `Authentication-Results` (SPF/DKIM/DMARC).
- **Signed/encrypted MIME** — `multipart/signed` (S/MIME, PGP), `multipart/encrypted`.
- **Gmail categories** — `CATEGORY_PERSONAL`/`SOCIAL`/`PROMOTIONS`/`UPDATES`/`FORUMS` (in `X-GM-LABELS`).
- **Drafts + Scheduled folders** — `\Drafts`, `[Gmail]/Scheduled`. `is_draft` captured; scheduled-send state not.
- **Filters/rules, vacation responder, forwarding** — Gmail API only (`users.settings.filters` / `.vacation` / `.forwardingAddresses` / `.autoForwarding`), not IMAP.
- **Quota** — `GETQUOTAROOT` or `users.getProfile`.
- **Contacts** — People API, out of scope.

### Gaps
**P0**
- **Message bodies (text + html)** — the snippet is too lossy for reconciliation or search. Even a `body_sha256` + deferred blob-ref mirrors USAA's statement-PDF hydration pattern.
- **List / mailing headers** (`List-Id`, `List-Unsubscribe`, `Auto-Submitted`) — cheap, enables "which newsletters am I on."

**P1**
- **Authentication-Results** (SPF/DKIM/DMARC verdicts) — single string, strong provenance signal.
- **`direction` field** (`inbound`/`outbound`/`draft`/`scheduled`) — trivially derived.
- **`has_calendar_invite` / `event_hints` sub-stream** from `text/calendar` parts.
- **Settings stream** — filters + vacation + forwarding. Requires auth-surface swap to Gmail API.

**P2**
- Attachment bytes (v1 non-goal, deferred).
- Quota / storage totals — one-row `account_summary`.

### Deliberately omitted
Attachment bytes v1; IDLE push; multiple concurrent accounts; generic non-Gmail IMAP; Chat/Meet content.

---

## YNAB

### Current manifest scope
Nine streams: `budgets`, `accounts`, `category_groups`, `categories`, `payees`, `payee_locations`, `transactions`, `scheduled_transactions`, `months`. Milliunits throughout.

### Source surface
`https://api.ynab.com/v1` is small. Nearly fully covered. Residual items:

- **`/budgets/{id}/months/{month}/categories/{category_id}`** — per-month-per-category budgeted/activity/balance. Not captured; month-level only.
- **`server_knowledge` delta token** — YNAB's native incremental cursor via `last_knowledge_of_server`. Manifest declares `incremental: true`; worth verifying the connector actually uses it (correctness, not surface).
- **`/user`** — returns a single `id`. Not captured.
- **Per-payee / per-category transaction endpoints** — redundant with the main stream; query shapes, not streams.
- **`cleared` state transition history** — NOT exposed by API (current state only). Unfixable from source.
- **Goal payment history** — not exposed; only current goal state.

### Gaps
**P0**
- None critical — YNAB is the best-covered of the four.

**P1**
- **`month_categories` stream** — per-month-per-category matrix keyed on `(budget_id, month, category_id)`. Powers trend analytics. Already returned nested inside `/months/{m}` response.
- **`user` stream** — one row, trivial, cleaner multi-budget reconciliation.
- Verify `server_knowledge` is plumbed for incremental sync.

**P2**
- Derived view streams (`transactions_by_payee`) — skip; query shapes not streams.

### Deliberately omitted
Write ops (PDPP is read-only); OFX import history; `cleared` transition log (source limit); goal audit trail (source limit).

---

## USAA

### Current manifest scope
Five streams: `accounts`, `transactions`, `statements` (index-only until blob hydration), `inbox_messages`, `credit_card_billing`. Web-scrape only.

### Source surface
`usaa.com/my/*` is much broader than five streams. Most items below are already designed in `usaa-extra-streams.md` but not yet in the manifest:

- **Transfers / Transfer Activity** — `/my/transfer-funds` Activity tab. Distinguishes internal transfers from spend; the CSV export lumps both under category=`Transfer`.
- **Bill Pay** — `/my/pay-bills`. Scheduled + paid bills with confirmation numbers, due/scheduled/sent dates. T&C wall on first run.
- **External linked accounts** — `/my/external-accounts`. Institution, type, last-four, balance when shared. Chase 9241 already visible in dashboard scrape.
- **Scheduled transactions** — pending/future-dated, separate tab from posted.
- **Documents beyond statements** — `/my/documents` also contains 1099-INT, 1098, legal notices, travel notifications.
- **Profile / member** — name, addresses, phone, membership number, military eligibility.
- **Credit-card dispute history** — case IDs, status, filed date.
- **Rewards ledger** — redemption history (standalone of `cash_rewards_cents` snapshot).
- **Physical card management** — active/locked/lost/replacement state.
- **Alerts & notifications settings** — user-configured balance/transaction/fraud alerts.
- **Insurance products** — `/my/insurance/*`. Auto/property/life policies, coverage, premiums, claims.
- **Investment accounts** — Victory Capital subdomain; likely a separate connector.
- **Loans / mortgage** — if present, amortization, escrow.

### Gaps
**P0**
- **Transfers stream** — reconciliation-critical (internal transfers ≠ spend). Designed and ready.
- **Bill Pay stream** — the scheduled side of recurring obligations; transactions CSV alone is insufficient.
- **External accounts stream** — cross-institution view is a primary USAA use case.

**P1**
- **Scheduled transactions** — smaller lift than transfers; designed.
- **Tax/legal documents** (non-statement `/my/documents`).
- **Profile / member** — one-row stream; unlocks identity binding.
- **Credit-card dispute history** — consumer-rights use case.

**P2**
- Alerts settings (preferences, not events).
- Physical card state (operational).
- Insurance policies (high value, but sub-product nav; defer).
- Investment holdings (own connector / subdomain).

### Deliberately omitted
Statement PDF bytes v1 (blob hydration deferred); inbox message bodies (click-through deferred); investment and insurance as separate connectors (scope boundary).

---

## GitHub

### Current manifest scope
Three streams: `user`, `repositories`, `starred`. Thin relative to the API surface.

### Source surface
`api.github.com` exposes dozens of resource categories. Current manifest covers roughly 10% of what a developer would call "their GitHub data":

- **Issues** — `/issues` + `/search/issues?q=author:@me|assignee:@me|mentions:@me|commenter:@me`. Labels, milestones, comments, timeline.
- **Pull requests** — `/search/issues?q=is:pr+author:@me` / `reviewer:@me` / `review-requested:@me`. Reviews, review-comments, merge/draft state.
- **Gists** — `/gists` owned + starred. Small, content bytes cheap.
- **Followers / following** — `/user/followers`, `/user/following`.
- **Organization memberships** — `/user/orgs` + role.
- **Teams** — `/user/teams`.
- **Releases** — `/repos/{o}/{r}/releases`.
- **Notifications** — `/notifications` with reason codes (`subscribed`, `mention`, `review_requested`).
- **Sponsors** — `/user/sponsorship` (both directions).
- **Projects (v2)** — GraphQL only.
- **Discussions** — per-repo GraphQL.
- **Codespaces** — `/user/codespaces`.
- **Milestones** — per-repo.
- **Watched repositories** — `/user/subscriptions` (distinct from starred).
- **Repository collaboration invitations** — `/user/repository_invitations`.
- **Commit activity** — `/repos/{o}/{r}/commits?author=@me`.
- **Contribution calendar** — GraphQL `user { contributionsCollection }`.
- **Events feed** — `/users/{u}/events` (~90-day TTL).
- **Packages / Deployments** — `/user/packages`, `/repos/.../deployments`.
- **SSH/GPG keys** — `/user/keys`, `/user/gpg_keys` (auth-surface adjacent).

### Gaps
**P0**
- **Issues + PRs authored/assigned/reviewed** — single biggest miss. Day-to-day GitHub use *is* issues and PRs; without them, "your GitHub data" is not credible.
- **Gists** — small endpoint, full-content capture reasonable; no excuse for omission.

**P1**
- **Notifications** — dense signal, cleanly maps to "your activity."
- **Organizations + Teams** — identity/graph data; cheap.
- **Followers / following** — social graph; trivial.
- **Contribution calendar** — single GraphQL call; user-facing "your year in code."
- **Watched repositories** — near-free given `starred` exists.
- **Releases** authored — especially for maintainers.

**P2**
- Events feed (90-day TTL weakens archival value; prefer typed streams).
- Deployments / Packages / Codespaces (low-use for most).
- Projects v2 + Discussions (GraphQL build complexity; defer).
- Repository collaboration invitations (operational).

### Deliberately omitted
Webhooks (admin); Enterprise/SAML audit (admin); Marketplace billing; SSH/GPG keys (auth-surface per brief).

---

## Cross-cutting observations

1. **Completeness tiers vary wildly.** YNAB is ~95% complete; USAA has five more streams designed and ready to wire; Gmail's big miss is bodies (acknowledged v1 non-goal); GitHub is most under-scoped — three streams against an API comfortably supporting twenty.

2. **Blob-hydration pattern is becoming universal.** Gmail bodies + attachments, USAA statement PDFs, GitHub gist content all fit the same "metadata now, `blob_ref` hydration later" shape. Promote from per-connector note to a protocol primitive before adding more.

3. **Settings/preferences streams systematically missing.** Gmail filters + vacation, USAA alert preferences, GitHub notification subscriptions. These describe *how the user has configured the platform*, which is often the most portable data. One-row-per-setting pattern, easy to standardize.

4. **Activity feeds are underused.** GitHub `/notifications` + `/events`, USAA `inbox_messages`, Gmail threads all provide a time-ordered "what happened" view. Manifests model state but not always the event log — fine for reconciliation, weaker for archival.

5. **Social / identity graph consistently omitted.** GitHub followers/orgs, Gmail contacts, USAA joint holders. Not critical for reconciliation; important for portability. Flag as a future `identity_graph` profile rather than per-connector add-hoc.

6. **Don't add API-convenience endpoints as streams.** YNAB `transactions_by_payee` and friends are query shapes, not streams. Worth codifying as a design guideline.
