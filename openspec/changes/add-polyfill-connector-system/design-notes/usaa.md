# USAA connector — design notes

**Status:** design captured 2026-04-19 overnight (not yet implemented).
**Source:** USAA audit subagent 2026-04-19, verified against live cookie probe.

## Auth model
- Shared Playwright persistent profile at `~/.pdpp/browser-profile/`.
- Session probed via cookies: `UsaaMbWebMemberLoggedIn`, `LtpaToken2`, `AST`, `MemberGlobalSession`. Already live in the owner's profile.
- Session TTL estimated 15–30 min idle, unknown absolute. Keep-alive probes every ~90 min.
- On session death: INTERACTION `manual_action` fires, user re-bootstraps, schedule resumes.

## Primary path: CSV export (recommended)
USAA deprecated OFX/QFX in mid-2023 but **retains CSV export** via UI. Flow per account:
1. Navigate to `/my/accounts`
2. Click account name
3. Click "I want to" menu (upper-left of account detail page)
4. Select "Export"
5. Choose CSV, date range, download

**Automate this flow** via Playwright. Parse the CSV. Emit one RECORD per row.

CSV fields observed: **Date**, **Description** (cleaned payee), **Original Description** (raw statement text, sometimes includes `CHECK #NNNN`), **Category**, **Amount** (signed, single column), account-level balance.

## Fallback path: DOM scrape
If CSV export is unavailable for a given account type (some credit card product variants), scrape the transaction table directly. Paginate backward by month.

## Primary key strategy (resilience)
USAA CSV does **not** expose a transaction ID. Primary key must be synthetic and stable:
```
sha256(account_id || '|' || date || '|' || amount || '|' || description)
```
Stability requirements:
- `account_id` is stable (scraped from account detail URL once at initial sync).
- `date` format is stable (MM/DD/YYYY per CSV).
- `amount` is stable as string (signed dollars and cents).
- `description` is USAA's cleaned merchant name — can shift if USAA recategorizes. Use `Original Description` (raw statement text) instead for stability; accept that rare duplicates of (date, amount, raw-memo) collapse into one PDPP record.

**Decision (autonomous 2026-04-19):** use `Original Description` for hash stability. Cleaned description goes in the record as `payee_cleaned` for convenience but is not part of the identity.

## Proposed streams

### `accounts` (`mutable_state`, primary_key `["id"]`)
- `id` (synthetic: hash of account masked number + type)
- `usaa_account_key` (stable internal key scraped from URL; stored but not primary)
- `name`
- `type` (checking / savings / credit_card / mortgage / auto_loan / investment)
- `balance`
- `available_balance` (nullable; not applicable to loans)
- `last_four`
- `routing_number` (checking/savings only; nullable)
- `status` (open / closed / frozen)
- `opened_date` (best-effort, nullable)
- `fetched_at`

### `transactions` (`mutable_state`, primary_key `["id"]`, consent_time_field `"date"`)
- `id` (synthetic hash above)
- `account_id`
- `date` (posted, ISO 8601 date)
- `effective_date` (nullable; only if scraped detail page surfaces it)
- `amount` (signed integer milliunits — convert from dollars × 1000 to match YNAB convention)
- `currency` ("USD" default)
- `description` (USAA-cleaned payee)
- `original_description` (raw statement text)
- `category` (USAA-assigned category string; nullable)
- `check_number` (parsed from `original_description`; nullable)
- `transaction_type` (debit / credit / transfer / fee / interest / dividend — derived heuristically)
- `balance_after` (nullable; available only via DOM scrape, not CSV)
- `source` ("csv_export" or "dom_scrape")
- `raw_import_row` (the original CSV row as object, for debugging + future resilience)
- `fetched_at`

### `statements` (`mutable_state`, primary_key `["id"]`, consent_time_field `"period_end"`)
- `id` (synthetic: `account_id || '|' || period_end`)
- `account_id`
- `period_start`
- `period_end`
- `document_url` (URL to PDF; may require authenticated fetch)
- `pdf_sha256` (populated if/when we download)
- `document_blob_ref` (PDPP blob_ref once hydrated; deferred for v1 — metadata only)
- `fetched_at`

### `pending_transactions` (optional, defer to v2)
### `transfers` (optional, defer to v2 — often indistinguishable from main transactions)

## Incremental sync strategy
- CSV export is a full-range pull. Request the widest range that's fast; client-side filter new rows.
- **Cursor per account:** `{ [account_id]: { last_posted_date: "YYYY-MM-DD", last_txn_id: "hash" } }`
- On subsequent runs, request CSV for `since = last_posted_date - 5 days` (buffer for late-posted transactions). Client-side filter `id NOT IN seen_hashes`.
- Full backfill on first run: export oldest available date range per account (USAA typically retains 18 months online; older requires statement PDFs).

## Humanlike behavior
- 2–3 second pauses between clicks.
- Do not run more than one USAA connector instance concurrently.
- Respect `networkidle` before interacting with dropdown menus (React-heavy UI).
- After export download, wait 5–10 seconds before navigating to the next account (simulate user reviewing the file).
- Full run: ~1 minute per account, ~5 minutes for a typical user with 5 accounts.

## Failure modes
| Failure | Response |
|---|---|
| Cookie probe fails | INTERACTION `manual_action`; notify; park run |
| "I want to" menu not found | SKIP_RESULT, fall back to DOM scrape for that account |
| CSV download times out | Retry once, then SKIP_RESULT |
| Unusual-activity challenge page | INTERACTION `manual_action` with link to the page |
| Account detail page 404 | Skip that account, continue with others |

## Explicit non-goals for v1
- Investment account positions and holdings (available on USAA but complex shape; defer).
- Mortgage/loan amortization schedules.
- Insurance policies and claims (different subtree of USAA).
- Wire transfer specifics beyond the standard transaction row.
- Check image fetching (blob hydration v2).

## Risks and open questions (on the owner's return)
- [?] Do some account types still expose OFX export that we could prefer over CSV? Audit said no but some credit card subsidiaries may differ.
- [?] Is the CSV date range selector bounded by "18 months" or less? If a run is missed for months, backfill may need multiple CSV fetches.
- [?] How often does USAA email "verify your identity" challenges for automated logins? Will test empirically tonight.

## Known gaps awaiting the partial-run-semantics mechanism

As of 2026-04-20, `spine_events` holds the following USAA skip history (from runs before the 2026-04-20 CC export + PDF parser fixes):

| Stream | Reason | Count | Category (per `gap-recovery-execution-open-question.md`) |
|---|---|---|---|
| `transactions` | `credit_card_export_unverified` | 8 | Cat 2 (capability gap — fixed 2026-04-20) |
| `transactions` | `export_no_download` | 16 | Cat 1 (transient — needs retry) |
| `transactions` | `export_error` | 7 | Cat 1 (transient) |
| `transactions` | `pdf_template_unknown` | 6 | Cat 2 (parser upgrade — improved 2026-04-20) |
| `transactions` | `usaa_csv_export_flow_pending` | 1 | Cat 2 (scaffold, now shipped) |
| `statements` | `pdf_download_download_timeout` | 10 | Cat 1 (transient) |
| `statements` | `selectors_pending` | 4 | Cat 3 (structural — selectors never wired) |
| `statements` | `usaa_statements_pending` | 1 | Cat 2 (scaffold, now shipped) |

Most Category 2 items are already resolved by code shipped 2026-04-20; a fresh full run would surface them as no-longer-skipped. Category 1 items need a retry mechanism (see the three-part open question).

Unlike ChatGPT's 4,188 gaps (individual conversation IDs, pre-filter-friendly), USAA's transient skips are **date-range scoped** (export failed for Account X across Date Range Y). Recovery here can't pass individual record IDs — it has to pass an account + date-range scope. The recovery mechanism design must accommodate both precisions.
