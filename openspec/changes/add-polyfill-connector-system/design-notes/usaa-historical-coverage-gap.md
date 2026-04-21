# USAA historical-coverage gap (CSV cap vs PDF statement archive)

**Status:** open — implementation path designed, not wired
**Raised:** 2026-04-19
**Trigger:** USAA transaction history in PDPP goes back only to 2024-11-25 (~17 months from today). Empirically verified this is NOT because USAA "forgot" — USAA retains ≥7 years of statement PDFs per WalletHub + USAA's own help docs.

## What we know

**USAA's CSV export UI hard-caps at ~18 months.** Empirically on 2026-04-19: "10/19/2024 accepted, 04/19/2024 rejected." Requesting older ranges leaves the form in "Fix From Date" state and submit button never enables. This is documented in the connector at `packages/polyfill-connectors/connectors/usaa/index.js` around line 350.

**USAA retains statements for up to 7 years.** Each monthly statement PDF in Documents & Records contains the itemized transactions for that period. Per WalletHub + general BSA retention norms (5-year minimum, typically 7-10), the data is on their servers; we just can't reach it via CSV.

**Today's DB state (2026-04-19):**
- Checking (3602): 789 transactions, earliest 2024-11-25
- Family Checking (9932): 68 transactions, earliest 2024-11-25
- Signature Visa, American Express: 0 transactions (CSV driver fails on current session — separate bug)
- Statements metadata: 10 entries but account_id not emitted (separate Layer 1 bug)
- **Missing ~5.5 years of transaction history** that exists in PDF statements

## Why this matters

For reconciliation and life-history use cases, 17 months is a short window. "Show me every Amazon order I ever reconciled against USAA" or "analyze my spending trends over 5 years" or "audit my 2020 tax year" all require multi-year coverage that's available on USAA's servers.

This is a **Layer 2 completeness gap** (cross-ref `layer-2-completeness-open-question.md`), manifest-claim vs actual-coverage divergence.

## The implementation path

**Step 1: Fix the statement-metadata bug.** Today's 10 `statements` records don't include `account_id` in their emitted payload. Fix the emit block so each statement is properly associated with its account. Without this, step 2 can't know which PDFs belong where.

**Step 2: Drive the statement-PDF download.** In the USAA UI, Documents & Records → Account → Statements → specific month has a download link. Wire the browser-scraper to click through and save each PDF.

**Step 3: Parse the PDFs.** Statement PDFs have a known structure (header, account summary, transaction list, ending balance). `pdfplumber` or `pdf-parse` can extract text → regex-parse transactions. This is well-trodden in the fintech space; probably a single-file ~200-line parser per account type (checking vs credit-card format).

**Step 4: Dedupe.** A CSV-export transaction and a PDF-statement transaction for the same date/amount/description should dedupe to one record. Primary key generation needs to be consistent across both paths — the existing hash on `(accountId, date, amount, description, ord)` should work if both paths populate the same fields identically.

**Step 5: Provenance.** Emit a provenance field (`source: "csv_export" | "pdf_statement_<period>"`) so consumers can verify which path an individual transaction came from.

## Trade-offs

- **Storage:** PDF bytes per month × 5.5 years × 5 accounts = ~300 PDFs at ~150KB each = ~45MB. Manageable.
- **Fragility:** PDF extractor has to handle format variations (USAA has changed statement templates over the years). Mitigate via content-hash + fallback strategies.
- **Re-extractable:** if raw PDFs are captured (see `raw-provenance-capture-open-question.md`), future extractor iteration doesn't need re-scraping.

## Why it isn't blocking today

CSV export captures what's most useful for reconciliation — the last 17 months. Older history serves audit/research use cases that aren't on the owner's immediate critical path. Defer unless a specific need arises.

## Generalization beyond USAA

Several other platforms will have the same "UI cap vs archive retention" pattern:
- **Gmail** — IMAP gives full history (not affected)
- **YNAB** — API gives full history (not affected)
- **Amazon** — order history CAP is probably ~90 days visible per page but archive exists; would need similar logic
- **ChatGPT** — current branch vs full conversation tree (separate gap)
- **Banks via Plaid** — Plaid typically gives 18-24 months, with a separate path for statements

A reusable "statement-PDF archive" pattern would apply to each.

## Action items

- [ ] Fix `statements.account_id` emit bug (small)
- [ ] Wire statement-PDF download as a new sub-flow in the USAA connector (medium)
- [ ] Implement transaction-line PDF parser (medium — probably leverage `pdf-parse` npm package)
- [ ] Ensure PK hash is consistent between CSV path and PDF path (small)
- [ ] Add `source` provenance field to the `transactions` stream manifest
- [ ] Consider extracting to a shared PDF-parser module — other bank/utility connectors will want it

## Cross-cutting

- `raw-provenance-capture-open-question.md` — raw PDF bytes would let re-extraction happen without re-scraping
- `blob-hydration-open-question.md` — PDFs are a natural blob type
- `layer-2-completeness-open-question.md` — this is the canonical "manifest says X, implementation covers less" case
