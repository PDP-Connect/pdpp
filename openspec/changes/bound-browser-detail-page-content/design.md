## Context

Amazon order collection uses a list-plus-detail pattern. List pages enumerate orders; optional detail pages enrich `order_items`. Detail failures are already modeled as retryable `DETAIL_GAP` entries so list-page records can still be handled honestly.

Live debugging showed a different failure mode: the page was still navigated to an order-detail URL, but renderer-backed CDP calls did not return. Navigation and selector timeouts did not cover the later `page.content()` call.

## Decision

Bound page-content reads independently of navigation and selector waits. If the renderer stops answering while reading HTML, the connector treats that as a parse/detail failure and uses the existing retryable gap path.

This is intentionally local to content reads. It does not change Amazon parsing, item merge rules, gap redaction, or cursor advancement policy.

## Alternatives

### Wait for the controller watchdog

Rejected. The watchdog reclaims the process eventually, but the run remains active for too long and blocks other operational work.

### Skip detail pages entirely

Rejected. Detail enrichment is useful and already has bounded gap semantics. The defect is an unbounded read, not the existence of detail hydration.

### Add a new Amazon-specific recovery taxonomy

Rejected. Existing `parse_missing`/retryable detail-gap semantics are sufficient once the operation is bounded.

## Acceptance checks

- A stalled `page.content()` rejects within a bounded timeout.
- Amazon detail/list content reads use the bounded helper.
- Existing Amazon emit, coverage, and parser tests continue to pass.
