# USAA extra-streams wiring plan

**Status:** designed 2026-04-19, awaiting USAA's current orchestrator run to complete so the shared browser profile is free.

Evidence gathered from live session recon during the overnight run.

## 1. `statements` stream

URL: `https://www.usaa.com/my/documents`
Table shape observed (sample output):
```
Document title     Date delivered   Account            Actions
CHECKING STATEMENT 04/17/2026       Checking *3602     Options
CHECKING STATEMENT 04/04/2026       Family Checking *9932  Options
SIGNATURE VISA     4270 ...
```

**Fields:**
- `id` — synthetic `sha256(title|date|account)`
- `title`
- `date_delivered` (ISO)
- `account_reference` (e.g. "Checking *3602")
- `document_url` — from the "Options" menu; opens a PDF download endpoint
- `fetched_at`

**Extraction strategy:** scrape the `<table>` with a row-by-row selector once the page fully hydrates. Expect selector: a DataTables-like table with `tr` rows inside `tbody`. Will need live probe to confirm.

**PDF bodies:** deferred — blob_ref only. Download driven on-demand via a follow-up hydration connector.

## 2. `inbox_messages` stream

URL: `https://www.usaa.com/my/inbox`
Table shape observed:
```
Status   Date    Message                    Action
UNREAD   Apr 17  You Have a New Document... Delete
UNREAD   Apr 11  You Have a New Document... Delete
```

**Fields:**
- `id` — synthetic `sha256(date|preview_text)`; refine if a real message ID is available when clicking in
- `date_received` (ISO, year-inferred from context)
- `status` (UNREAD/READ)
- `subject` / `preview` (first ~120 chars)
- `fetched_at`

**Extraction strategy:** same table-row scrape. Message bodies require click-through — deferred.

## 3. `transfers` stream

URL: `https://www.usaa.com/my/transfer-funds` (then "Transfer Activity" tab).

**Value:** A reconciliation agent distinguishes "transfer between my accounts" from "purchase at merchant" from "bill payment." USAA's transaction CSV lumps all of these into one log with category=`Transfer`, but the transfers-activity view gives structured fields.

**Fields:**
- `id` — synthetic
- `transfer_date`
- `from_account_id`, `from_account_name`
- `to_account_id`, `to_account_name`
- `amount_cents`
- `status` (Pending/Completed/Scheduled)
- `type` (One-time/Recurring)
- `recurrence_pattern` (if recurring)
- `memo`
- `fetched_at`

**Extraction strategy:** navigate to activity tab; scrape the activity table.

## 4. `bill_payments` stream

URL: `https://www.usaa.com/my/pay-bills`

Note: live recon showed a Terms & Conditions wall ("We've updated our Terms and Conditions") requiring acceptance before pay-bills data is visible. First run may need INTERACTION for user to accept.

**Fields:**
- `id`
- `payee_id`, `payee_name`
- `amount_cents`
- `due_date`, `scheduled_date`, `sent_date`
- `status` (Scheduled/Sent/Delivered/Failed)
- `account_id` (payor)
- `frequency` (One-time/Monthly/etc.)
- `confirmation_number`
- `fetched_at`

## 5. `credit_card_billing` stream (one row per credit card, refreshed each run)

URL pattern: `https://www.usaa.com/my/credit-card/?accountId=<id>`

From earlier recon, the Signature Visa page shows:
```
Current Balance: $0.00
Available Credit: $24,992.00
Statement Balance (as of Mar 20, 2026): $8.65
Statement Due Date: Apr 14, 2026
Last Payment: $8.65
Last Payment Received: ...
Minimum Payment Met (flag)
```

**Fields:**
- `id` — credit card `accountId`
- `current_balance_cents`
- `available_credit_cents`
- `statement_balance_cents`
- `statement_as_of_date`
- `statement_due_date`
- `last_payment_cents`
- `last_payment_received_date`
- `minimum_payment_met` (boolean)
- `fetched_at`

**Extraction strategy:** parse the key-value list on the card detail page. Regexes over innerText for the labeled amounts.

## 6. `scheduled_transactions` stream

URL pattern: same as account detail, with "Scheduled Transactions" tab. Distinct from "Transactions" (posted).

**Fields:** same shape as `transactions` but with `status: "scheduled"` and `scheduled_date` instead of posted `date`. Primary key same synthetic hash.

## 7. `external_accounts` stream

URL: `https://www.usaa.com/my/external-accounts` (or via dashboard `/my/external-account/...` links).

**Fields:**
- `id` (external `acctId`)
- `display_name`
- `institution_name`
- `account_type`
- `last_four`
- `balance_cents` (when visible)
- `balance_as_of`
- `link_status`

The Chase Sapphire Preferred 9241 entry is already visible in dashboard scrape; this stream formalizes it and adds any other linked accounts.

## Implementation order once profile is free

1. Navigate each page in turn (while session still fresh), dump table HTML, pin real selectors.
2. Write the extractors as helper functions inside `connectors/usaa/index.js` so the existing run invocation gets all streams.
3. Smoke-test each stream individually before combining.
4. Ensure each stream emits STATE per sync boundary so partial runs don't lose progress.

## Effort estimate

~15-20 minutes per stream once profile is free, assuming selectors are as stable as the main dashboard turned out to be. All 7 streams ≈ 2 hours of wiring + smoke tests.
