# Extend the run-clock churn gates to the remaining no-op streams

## Why

The 2026-06-03 post-compaction churn ground-truth still shows four streams
appending a new version of every record on every run for the same run-clock
reason the already-shipped `chase/accounts`, `chase/statements`,
`chase/transactions`, `usaa/statements`, `usaa/accounts`, and
`usaa/credit_card_billing` gates fixed. Each carries a run-clock
`fetched_at` over an otherwise-immutable (or transition-only) body:

- **usaa / transactions** — both emit paths re-surface the same transaction
  every run: the CSV-export path re-downloads an overlapping incremental date
  window (`INCREMENTAL_OVERLAP_MS`), and the PDF-statement parse re-parses the
  same statement PDFs. A posted transaction's identity
  (`id = hashId(accountId|date|amount|original|#ord)`) and fields are immutable;
  only `fetched_at` moved. This is byte-for-byte the shape of the shipped
  `chase/transactions` gate.
- **usaa / inbox_messages** — the inbox page is re-scraped in full every run, so
  every still-listed message was re-emitted with a fresh `fetched_at`. A
  message's identity (`id = hashId(date_short|preview[:120])`) and body are
  immutable until its read/unread status flips.
- **chase / current_activity** — the dashboard overview re-renders the same
  recent rows every run; a row keyed by a stable `ui_transaction_id` is
  immutable until it transitions pending → posted, so only `fetched_at` moved.
- **amazon / orders** — year-freezing already bounds re-scraping to recent
  years, but every order in the current (unfrozen) year was re-emitted each run
  with a fresh `fetched_at`. An order's identity (`id = order id`) and total are
  fixed once placed; only `fetched_at` moved. (`order_items` carries no
  `fetched_at` and needs no gate.)

Excluding **only** the run-clock `fetched_at` from the fingerprint is provably
lossless, exactly as established for the prior streams: a run where any real
field moved (a corrected amount, a balance_after move, a read/unread flip, a
pending → posted transition, a delivery_status move) produces a different
fingerprint and re-emits; only a body byte-identical modulo `fetched_at` is
suppressed.

Scan classification:

- `usaa/transactions`, `chase/current_activity`, and `amazon/orders` are
  **partial** scans (an overlapping incremental window, the dashboard's recent
  rows, and year-freezing respectively), so their fingerprint cursors are never
  `pruneStale()`d — pruning ids the run did not observe would drop their
  fingerprints and re-churn them when they are next re-surfaced.
- `usaa/inbox_messages` is a **full** scan of the inbox page, so it prunes like
  `usaa/statements` / `chase/accounts`.

## What Changes

- Forward fix: add per-record fingerprint cursors (each
  `excludeFromFingerprint: ["fetched_at"]`) to:
  - the USAA connector for `transactions` (one stream-wide cursor shared by the
    CSV-export and PDF-statement paths; ids are globally unique and both paths
    hash the same logical transaction to the same id; NOT pruned — partial scan;
    persisted into the `transactions` STATE cursor alongside the per-account
    `last_date` watermarks) and `inbox_messages` (full-scan, pruned; persisted
    into the `inbox_messages` STATE cursor);
  - the Chase connector for `current_activity` (one stream-wide cursor; NOT
    pruned — partial scan; persisted into the `current_activity` STATE cursor);
  - the Amazon connector for `orders` (one stream-wide cursor; NOT pruned —
    partial scan / year-freezing; persisted into the `orders` STATE cursor
    alongside the `years` cursor; `order_items` left ungated).
  Add `readPriorTransactionFingerprints`, `readPriorInboxMessageFingerprints`,
  `readPriorCurrentActivityFingerprints`, and `readPriorOrderFingerprints`.
- Register four Family-1 ("connector fingerprint mirror") compaction policies,
  each `excludeKeys: ["fetched_at"]`: `usaa/transactions`,
  `usaa/inbox_messages`, `chase/current_activity`, `amazon/orders`.
- Extend the canonical Family-1 stream enumeration in the
  reference-implementation-architecture capability spec to include the four new
  streams, and add a scenario pinning that a real field move stays a fingerprint
  boundary and that the partial-scan cursors are never pruned.
- Add forward-gate tests and compaction registry + fingerprint-parity coverage,
  including explicit "real field move is a distinct fingerprint" and
  "no-prune partial-scan" / "full-scan prune" assertions.

No new HTTP route, schedule, or automatic job. No real source field is excluded
from any fingerprint. No change to the retention rule, backup/apply safety,
dry-run default, or any public read path. Live owner `--apply` is deferred and
owner-gated.

## Capabilities

- Modified: reference-implementation-architecture

## Impact

- `packages/polyfill-connectors/connectors/usaa/index.ts` — `transactions` +
  `inbox_messages` fingerprint gates + `readPriorTransactionFingerprints` +
  `readPriorInboxMessageFingerprints` + `withTransactionFingerprints`; threads
  the shared transactions cursor through both emit paths.
- `packages/polyfill-connectors/connectors/usaa/types.ts` — `transactions`
  cursor types separating the per-account watermark from the `fingerprints`
  sibling key.
- `packages/polyfill-connectors/connectors/chase/index.ts` —
  `current_activity` fingerprint gate + `readPriorCurrentActivityFingerprints` +
  `currentActivityFingerprintCursor` on `EmitDeps`.
- `packages/polyfill-connectors/connectors/amazon/index.ts` — `orders`
  fingerprint gate + `readPriorOrderFingerprints` + `ordersFingerprintCursor`
  on `EmitDeps` + `fingerprints` on the orders STATE cursor.
- `packages/polyfill-connectors/connectors/{usaa,chase,amazon}/*-fingerprint.test.ts`
  — new forward-gate tests.
- `reference-implementation/scripts/compact-record-history.mjs` — four registry
  entries + header docstring.
- `reference-implementation/test/compact-record-history.test.js` — registry
  shape assertion.
- `reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  — four parity fixtures (with real-field-boundary assertions) + static-guard
  set.
- `openspec/specs/reference-implementation-architecture/spec.md` — Family-1
  enumeration (via this change's delta).
