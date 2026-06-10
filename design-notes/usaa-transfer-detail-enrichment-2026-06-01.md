# Should The USAA Connector Enrich Transfer Counterparty Details?

Status: captured
Owner: reference implementation owner
Created: 2026-06-01
Updated: 2026-06-01
Related: Collection Profile, USAA connector, owner/live connector coverage

## Question

Should the USAA connector capture richer transfer counterparty details, such as
Zelle recipient/account-ending hints that are visible in the USAA web
transaction-detail or transfers UI but absent from the current CSV-derived
records?

## Context

The current USAA records surfaced through PDPP carry generic descriptions for
several Zelle-like transfers, for example `USAA FUNDS TRANSFER DB` and
`USAA FUNDS TRANSFER CR`. A trusted local agent checked the owner-visible PDPP
records and found they do not clarify the recipient beyond the same generic
description present in YNAB.

The likely missing detail lives only on USAA's authenticated web transfer or
transaction-detail surface, not in the current CSV/API feed used by the reference
connector. Closing this would therefore be a connector coverage improvement,
not a PDPP Core change.

## Stakes

This is low priority compared with the active RI-owner lanes for trusted
owner-agent control, batch consent, browser-collector enrollment, and remaining
live acceptance gates. It is still worth preserving because finance-transfer
counterparty details are a concrete owner value case: without them, agents cannot
answer "who was this transfer to?" without asking the owner to inspect USAA
manually.

The risk is also source-specific. Adding this as a one-off scrape should not
weaken the Collection Profile framing. If pursued, it should be treated as a
USAA connector coverage tranche with explicit provenance and coverage labels:
the CSV feed provides generic transfer rows; the authenticated web detail
surface may provide optional enrichment.

## Current Leaning

Defer for now. The SLVP shape is probably a USAA connector enrichment lane that:

- confirms, with a live owner session, which USAA web surface exposes stable
  transfer-detail fields;
- captures a scrubbed fixture proving the richer fields exist and can be parsed
  without over-collecting;
- records source provenance so downstream clients can distinguish CSV-provided
  fields from browser-enriched fields;
- treats missing detail as an honest coverage gap rather than a connector
  failure;
- avoids promoting a source-specific browser scrape into any Core or Collection
  Profile requirement.

## Promotion Trigger

Promote this into OpenSpec before implementation if the owner prioritizes USAA
transfer-detail enrichment, or if another finance connector exposes the same
CSV-vs-web-detail split and a shared enrichment/coverage primitive becomes
useful.

## Decision Log

- 2026-06-01: Captured after a trusted local agent verified that current PDPP
  USAA records do not improve on YNAB for generic Zelle-like transfer
  descriptions. Current decision: preserve as low-priority connector coverage
  intake, not active work.
