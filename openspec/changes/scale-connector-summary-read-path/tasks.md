## 1. Contract and identity page

- [ ] Add the reference-contract request/response pagination fields and typed
  cursor validation for unscoped `GET /_ref/connectors`; keep `connection`
  behavior unchanged.
- [ ] Add one owner-visible connection-instance keyset-page store method with
  the immutable current-order tuple and `limit + 1` lookahead, in SQLite and
  PostgreSQL.
- [ ] Add cursor encode/decode scope binding and migration telemetry/
  deprecation behavior without logging cursor contents or owner identity.

## 2. Page-scoped evidence gatherer

- [ ] Resolve identity page before the observation barrier; reconcile/read
  summary evidence with exactly the page ids.
- [ ] Add bounded semantic-store batch methods for schedules, run history and
  selected terminal facts, retained-size, gaps, attention, acquisition,
  credentials, and local coverage.
- [ ] Keep runtime-only snapshots separate and filter them by page identity;
  do not persist a rendered summary or fleet cache.
- [ ] Preserve exact `connector_instance_id` mapping, current null/failure/
  floor semantics, and guarded singleton connector-wide legacy run fallback.

## 3. Fleet and consumers

- [ ] Keep fleet health/count/attention rollups on independent bounded
  aggregation/composition reads; do not derive them from one list page.
- [ ] Migrate console pagination and retain small-fleet response compatibility
  for the declared transition window.
- [ ] Decide and document default-cap activation only after consumer migration
  and UAT evidence.

## 4. Acceptance checks

- [ ] SQLite and real PostgreSQL parity: page ids/order/cursors, summary
  fields, failures, and scoped detail identity.
- [ ] Query-slope oracle: N=1 vs N=1000 with page size 100 has constant
  page-bounded SQL count and result rows; no per-connection query returns.
- [ ] Parameter oracle: maximum accepted page is safe on SQLite, chunked
  batches preserve ordering, and PostgreSQL `ANY` empty input short-circuits.
- [ ] Concurrent-update oracle: mutable evidence updates do not duplicate or
  skip retained identities; insert/delete behavior matches the documented
  non-snapshot contract.
- [ ] Compatibility/UAT: fixtures and a synthetic large owner preserve every
  current small-fleet field, follow all pages once, and reconcile fleet
  rollups independently.
- [ ] Run `openspec validate scale-connector-summary-read-path --strict`,
  `openspec validate --all --strict`, targeted reference tests, Postgres-gated
  parity tests, typecheck, and `git diff --check`.
