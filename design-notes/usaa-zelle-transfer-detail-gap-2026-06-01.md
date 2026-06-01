# USAA Zelle Transfer Detail Gap

Status: decided-defer
Owner: RI owner
Created: 2026-06-01
Updated: 2026-06-01
Related: openspec/changes/archive/2026-05-29-add-polyfill-connector-system, openspec/changes/add-browser-collector-enrollment-primitive, openspec/changes/add-connector-adaptive-lanes, docs/reference-implementation-owner-handoff-2026-05-15, packages/polyfill-connectors/connectors/usaa/, packages/polyfill-connectors/connectors/github/index.ts

## Question

Should the USAA connector enrich CSV-sourced transfer transactions with recipient/account detail from the web transfer or transaction-detail pages?

## Context

The current USAA data available through PDPP for recent Zelle-like transfers is sourced from `csv_export`. For the observed transfer rows, `original_description` only carried generic bank text such as `USAA FUNDS TRANSFER DB` or `USAA FUNDS TRANSFER CR`. That matches the limitation also visible from YNAB-derived transaction data: the CSV/API feed does not expose the recipient-level clue needed for reconciliation.

Simon reported that the useful detail, such as recipient or account-ending text like `TO ****nnnn`, appears to live only on USAA's web transfer or transaction-detail pages. In the observed case, PDPP therefore did not let an agent disambiguate whether specific transfers were likely for Spencer, Manoucher, Navid, or another recipient without a separate owner lookup in the USAA UI.

### Current available fields (verified 2026-06-01)

The live `transactions` stream emits records validated by `connectors/usaa/schemas.ts` (`transactionSchema`). For a transfer row the populated fields are:

- `id` (synthetic SHA-256), `account_id`, `account_name`, `date`, `amount` (signed cents), `currency`;
- `description` (cleaned payee; null for generic transfers), `original_description` (raw bank text — for transfers this is the generic `USAA FUNDS TRANSFER DB` / `... CR`);
- `category`, `check_number`, `balance_after_cents`;
- `source` (`csv_export` or `pdf_statement_YYYY-MM`), `fetched_at`.

There is no `recipient`, `recipient_account_last_four`, `counterparty`, `transfer_direction`, or detail-page provenance field in the schema today.

### What is missing, and where it belongs

The missing detail is recipient identity and account-ending (e.g. `TO ****nnnn`, a Zelle alias, or a named payee). The connector already declares — but defers — a dedicated `transfers` stream for exactly this class of data. `DEFERRED_STREAMS` in `connectors/usaa/index.ts` lists `transfers`, `bill_payments`, `scheduled_transactions`, `external_accounts`, each of which emits `SKIP_RESULT` with reason `selectors_pending` and the message "scaffolded in design-notes; click-chain or SPA-component wiring deferred." The manifest runtime binding is already `browser: required` + `network: required` (no filesystem), so a browser-driven detail fetch is binding-consistent.

This reframes the gap: the recipient/account-ending detail is most naturally a `transfers`-stream concern reached by a browser-bound detail fetch, not a retrofit of free-text parsing onto the CSV-sourced `transactions` rows. The `transactions` stream should keep emitting the honest CSV-grade record; enrichment is additive and lives in a stream that already exists in scaffold form.

## Stakes

This is not a protocol or MCP acceptance blocker. It is a connector-quality gap: the reference can expose a valid transaction stream while still being less useful than the owner-visible website for financial reconciliation tasks.

The data is sensitive and bank-site automation has operational risk. Any enrichment should preserve provenance, avoid money-movement surfaces, and fail closed if the page detail is not safely reachable.

## Current Leaning

Defer until USAA connector quality becomes an explicit lane. When promoted, the correct fix is a **browser-bound detail fetch that populates the already-scaffolded `transfers` stream**, not CSV enrichment, manual annotation, or a new connector capability. Reasoning across the four candidate fixes:

| Option | Verdict | Why |
| --- | --- | --- |
| CSV enrichment (parse recipient out of `original_description`) | Rejected | The data is not in the export. For transfer rows the CSV only carries `USAA FUNDS TRANSFER DB/CR`. There is nothing to parse; inferring recipients from amount/date would be a guess and violates the "fail closed, no fabrication" rule. |
| Browser-bound detail fetch into `transfers` stream | **Chosen** | The detail exists only on read-only web transfer/transaction-detail pages. The manifest already binds `browser: required`, and the `transfers` stream is already declared and emitting `selectors_pending`. This is the binding-consistent home for the data. |
| Manual owner annotation | Rejected as primary; acceptable stopgap | Useful as an owner-facing fallback for un-fetchable rows, but it does not scale, is not what Simon asked for, and should not be the connector's answer to a fetchable read surface. |
| New connector capability | Not required | No new manifest capability or protocol surface is needed. The work reuses existing primitives (see below). |

The SLVP shape stays additive and honest:

- preserve the CSV-sourced `transactions` record as the base record, unchanged;
- emit recipient/account-ending detail as `transfers`-stream records (or, if a future decision prefers in-line enrichment, as new nullable fields with explicit detail-page provenance), never by mutating CSV semantics;
- surface recipient/account-ending clues only when observed directly on a read-only detail surface; never the money-movement (initiate-transfer) surfaces;
- mark missing enrichment as a known gap (keep the `SKIP_RESULT`/null path) rather than guessing from amount/date patterns.

### Reuse, don't reinvent: existing primitives this maps onto

This work should not introduce new machinery. Two in-flight OpenSpec changes already supply the relevant primitives:

- `add-browser-collector-enrollment-primitive` — establishes browser-bound collection as a first-class, binding-aware, proof-gated path (`browser_collector` source kind). A USAA detail-fetch lane sits inside this enrollment story rather than alongside it.
- `add-connector-adaptive-lanes` — supplies the bounded-concurrency / `Retry-After` / per-record detail-hydration lane already piloted for ChatGPT conversation-detail collection. A per-transfer detail fetch is the same shape and should use this lane, not a hand-rolled loop.

The in-repo precedent for the per-record-detail pattern is the GitHub connector's `fetchPullDetail` (`connectors/github/index.ts`): it fetches one detail request per summary record, treats detail failure as **non-fatal** (emit the summary record, leave detail null), and only bubbles rate-limit/auth errors to abort-and-retry the run. A USAA transfer-detail fetch should mirror this: a failed or unreachable detail page yields the base record with null enrichment, never a dropped or fabricated row.

### Test fixtures required before implementation

No live bank automation should run before these fixtures exist:

1. **Generic CSV-only transfer row fixture** — extend `connectors/usaa/__fixtures__/csv-export-minimal.csv` (or add a sibling) with at least one `USAA FUNDS TRANSFER DB` and one `... CR` row. Asserts the base `transactions` record is emitted with null `description` and the generic `original_description`, i.e. the honest no-detail path.
2. **Scrubbed transfer-detail-page fixture** — a saved, fully redacted HTML/DOM snapshot (or structured intermediate) of a USAA web transfer/transaction-detail page, captured via `PDPP_CAPTURE_FIXTURES=1` and run through the fixture-scrubber pipeline (`scrub-connector-fixtures`). Must redact real names, account numbers, and aliases to synthetic but shape-faithful values. Drives a unit test of the detail-extraction parser in isolation (no Playwright), mirroring how `parsers.ts` is tested today.
3. **Enriched-vs-unenriched parity fixture** — a paired case proving: (a) when the detail page is reachable, a `transfers` record carries `recipient` / `recipient_account_last_four` with detail-page provenance; (b) when it is unreachable, the run emits the base `transactions` record plus a `SKIP_RESULT`/null-enrichment marker and never fabricates a recipient.
4. **Detail-fetch failure fixture** — a simulated detail-page fetch error proving the non-fatal path (base record retained) and that rate-limit/auth errors bubble to a retryable run-level failure, matching the GitHub `fetchPullDetail` contract.

## Promotion Trigger

Promote this into an OpenSpec change before implementation if USAA is moved from low-priority connector quality into an active financial-reconciliation lane, or if agents repeatedly fail owner tasks because USAA transfer recipients are not available through PDPP.

The promoted change should define the `transfers`-stream detail-fetch behavior, enrichment fields, redaction rules, provenance shape, fixture strategy, live-smoke safety constraints, and acceptance tests for generic CSV-only rows versus enriched detail-page rows. It should be scoped as a USAA-connector consumer of `add-browser-collector-enrollment-primitive` and `add-connector-adaptive-lanes` rather than a standalone primitive, so it reuses the binding-aware enrollment and adaptive-lane machinery instead of re-deriving them.

### Priority relative to current RI acceptance work

Low. This sits below every active RI acceptance gate. The current owner ledger (`tmp/workstreams/ri-owner-current-state.md`) shows the live priorities are: canonical-key production-backup restore proof (task 3.4), owner-agent control-surface deferred operations, browser-collector enrollment **proof** (the `unsupported -> enroll_browser_collector` flip still gated on a real Amazon browser-session fixture), split-site archive/spec closeout, and consent product decisions. USAA transfer-detail enrichment is a connector-quality improvement, not a protocol or acceptance blocker, and it is strictly downstream of `add-browser-collector-enrollment-primitive` landing its live proof — the same gate Amazon is waiting on. It should not be scheduled until that browser-collector path is proven and one of the promotion triggers above fires.

## Decision Log

- 2026-06-01: Captured from Simon's owner-agent investigation. Deferred as low-priority connector enrichment; not part of the current RI acceptance gate.
- 2026-06-01 (intake-v1): Verified against connector source. Confirmed the gap with concrete fields: live `transactions` schema has no recipient/account-ending field, and the CSV export carries only `USAA FUNDS TRANSFER DB/CR` for transfers. Identified the already-scaffolded but deferred `transfers` stream (`DEFERRED_STREAMS`, `selectors_pending`, browser binding already required) as the correct home for the data. Ranked the four candidate fixes and chose browser-bound detail fetch into `transfers`; rejected CSV parsing (data absent), demoted manual annotation to a fallback, and confirmed no new connector capability is needed. Mapped the work onto existing primitives (`add-browser-collector-enrollment-primitive`, `add-connector-adaptive-lanes`) and the GitHub `fetchPullDetail` non-fatal per-record-detail precedent. Specified four required fixtures (generic CSV-only, scrubbed detail page, enriched-vs-unenriched parity, detail-fetch failure) as preconditions to any live automation. Ranked priority as low and strictly downstream of the browser-collector live-proof gate. Status remains decided-defer.
