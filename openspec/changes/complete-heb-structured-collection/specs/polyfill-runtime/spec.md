## ADDED Requirements

### Requirement: The H-E-B connector SHALL parse observed structured order-list source data before rendered-text fallbacks

The H-E-B connector SHALL parse a valid, source-owned `__NEXT_DATA__.props.pageProps.orders` structured payload at its boundary and prefer its valid per-order values over rendered-DOM text extraction. It SHALL retain the existing bounded rendered-DOM fallback only for a page or row where the structured payload is absent, malformed, or does not contain a trustworthy order row. The fallback SHALL NOT silently replace a known-valid structured row.

#### Scenario: H-E-B order list contains valid embedded Next.js data

- **WHEN** an H-E-B order-list page contains a parseable
  `__NEXT_DATA__.props.pageProps.orders` array with a valid order row
- **THEN** the H-E-B connector SHALL emit that order from the structured row
- **AND** it SHALL preserve existing order identity, cursor, and field
  compatibility while emitting only nullable additive direct-source fields

#### Scenario: H-E-B structured order data is missing or malformed

- **WHEN** an H-E-B order-list page has no usable `__NEXT_DATA__` payload or
  an individual row cannot be parsed into a trustworthy order
- **THEN** the H-E-B connector SHALL use its existing DOM extraction for that
  page or row
- **AND** it SHALL retain existing schema validation and diagnostic evidence
  rather than fabricate structured values

### Requirement: The H-E-B connector's list pagination SHALL treat successful parsing through the source-advertised maxPage as normal completion and fail closed on an unexpected empty page

The H-E-B connector SHALL treat successful parsing of every list page from page 1 through the source-advertised `maxPage` as normal completion of the forward walk. It SHALL NOT use `pageNum > 1` alone as terminal proof. An empty page encountered at or before the source-advertised `maxPage` SHALL fail closed with diagnostic evidence and SHALL NOT advance the orders cursor or report history complete. Pagination metadata that is missing or internally contradictory SHALL NOT silently default to a single-page result; the connector SHALL fail closed with diagnostic evidence instead.

#### Scenario: H-E-B forward walk completes through the advertised maxPage

- **WHEN** the H-E-B connector successfully parses every list page from page 1
  through the source-advertised `maxPage` with at least one order on each page
  that contains orders
- **THEN** the connector SHALL treat the walk as normally complete
- **AND** it SHALL NOT require a speculative request beyond `maxPage` to prove
  completeness

#### Scenario: An empty page occurs at or before the advertised maxPage

- **WHEN** an H-E-B list page at or before the source-advertised `maxPage`
  parses zero orders
- **THEN** the connector SHALL emit diagnostic failure/skip evidence and fail
  closed
- **AND** it SHALL NOT advance its cursor or report history complete

#### Scenario: Pagination metadata is missing or contradictory

- **WHEN** an H-E-B list page's pagination metadata is absent or internally
  contradictory (for example conflicting max-page signals)
- **THEN** the connector SHALL NOT default to treating the result as a
  single-page or completed walk
- **AND** it SHALL emit diagnostic failure evidence and fail closed

### Requirement: The H-E-B connector's mid-run source repair SHALL be manual-run-only for owner-started assistance and latch-only for unattended runs

The H-E-B connector SHALL use the run trigger-kind and automation-mode metadata the runtime provides to its child process to distinguish an owner-started manual run from an unattended run before attempting any mid-run interactive repair. On an unattended run, the connector SHALL NOT open manual browser assistance on an authenticated-session loss or source challenge; it SHALL latch `sessionRepairRequired` immediately and emit `owner_repair_required` deferred-coverage evidence for the affected and remaining detail work without interaction. On an owner-started manual run, the connector MAY spend at most one shared run-scoped `manualAction` attempt using the existing generic browser-assistance and `probeHebSession` primitives; on success it SHALL re-probe the session and retry only the affected detail once. The one-attempt budget SHALL be shared across pending-gap recovery and forward scanning so the two paths cannot each spend an independent attempt. After a consumed or failed attempt, or a second session/challenge failure in the same run, the connector SHALL latch and defer remaining detail work through existing `DETAIL_GAP`/`owner_repair_required` evidence without a further assistance or browser-retry attempt.

#### Scenario: Unattended run encounters a mid-run session loss or challenge

- **WHEN** an H-E-B run started under unattended/session-reuse automation
  mode detects an authenticated-session loss, Incapsula block, or challenge
  during detail collection
- **THEN** the connector SHALL NOT open the generic browser-assistance manual
  handoff
- **AND** it SHALL latch `sessionRepairRequired` and defer the affected and
  remaining detail work through `owner_repair_required` evidence without
  further interaction

#### Scenario: Owner-started manual run repairs successfully

- **WHEN** an H-E-B run started under owner-started manual automation mode
  detects the first authenticated-session loss, Incapsula block, or challenge
  during detail collection
- **AND** the owner completes the existing generic browser assistance and the
  H-E-B session re-probe (`probeHebSession`) succeeds
- **THEN** the connector SHALL wait its bounded polite delay and retry only
  the affected detail once
- **AND** it SHALL continue only if that retry succeeds

#### Scenario: Owner-started manual run's shared repair attempt is consumed or fails

- **WHEN** the one shared run-scoped `manualAction` attempt fails, its
  re-probe fails, the affected retry fails, or a second session/challenge
  failure occurs in the same run
- **THEN** the connector SHALL latch its repair state across pending-gap
  recovery and forward scanning
- **AND** it SHALL defer affected and remaining detail work through existing
  `DETAIL_GAP`/`owner_repair_required` evidence without another assistance or
  browser-retry attempt
