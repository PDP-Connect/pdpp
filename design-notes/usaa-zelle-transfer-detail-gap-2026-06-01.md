# USAA Zelle Transfer Detail Gap

Status: decided-defer
Owner: RI owner
Created: 2026-06-01
Updated: 2026-06-01
Related: openspec/changes/archive/2026-05-29-add-polyfill-connector-system, docs/reference-implementation-owner-handoff-2026-05-15

## Question

Should the USAA connector enrich CSV-sourced transfer transactions with recipient/account detail from the web transfer or transaction-detail pages?

## Context

The current USAA data available through PDPP for recent Zelle-like transfers is sourced from `csv_export`. For the observed transfer rows, `original_description` only carried generic bank text such as `USAA FUNDS TRANSFER DB` or `USAA FUNDS TRANSFER CR`. That matches the limitation also visible from YNAB-derived transaction data: the CSV/API feed does not expose the recipient-level clue needed for reconciliation.

Simon reported that the useful detail, such as recipient or account-ending text like `TO ****nnnn`, appears to live only on USAA's web transfer or transaction-detail pages. In the observed case, PDPP therefore did not let an agent disambiguate whether specific transfers were likely for Spencer, Manoucher, Navid, or another recipient without a separate owner lookup in the USAA UI.

## Stakes

This is not a protocol or MCP acceptance blocker. It is a connector-quality gap: the reference can expose a valid transaction stream while still being less useful than the owner-visible website for financial reconciliation tasks.

The data is sensitive and bank-site automation has operational risk. Any enrichment should preserve provenance, avoid money-movement surfaces, and fail closed if the page detail is not safely reachable.

## Current Leaning

Defer until USAA connector quality becomes an explicit lane. The likely SLVP is not to alter the CSV transaction meaning, but to add safe optional enrichment:

- preserve the CSV-sourced transaction record as the base record;
- add detail-page provenance for any enriched fields;
- surface recipient/account-ending clues only when they are observed directly on a read-only detail surface;
- mark missing enrichment as a known gap rather than guessing from amount/date patterns.

## Promotion Trigger

Promote this into an OpenSpec change before implementation if USAA is moved from low-priority connector quality into an active financial-reconciliation lane, or if agents repeatedly fail owner tasks because USAA transfer recipients are not available through PDPP.

The promoted change should define the enrichment fields, redaction rules, provenance shape, fixture strategy, live-smoke safety constraints, and acceptance tests for generic CSV-only rows versus enriched detail-page rows.

## Decision Log

- 2026-06-01: Captured from Simon's owner-agent investigation. Deferred as low-priority connector enrichment; not part of the current RI acceptance gate.
