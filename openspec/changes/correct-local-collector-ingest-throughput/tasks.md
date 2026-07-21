## 1. Specification

- [x] Define canonical identity, reservation lifecycle, replay precedence, and
      accepted-only diagnostics in the device collection and architecture deltas.
- [x] Define shared instance writer coordination, bounded Postgres lifecycle,
      and child-process termination/fail-stop semantics in runtime deltas.
- [x] Run strict focused OpenSpec validation before implementation acceptance.

## 2. Durable/store and record seams

- [x] Migrate SQLite/Postgres outcomes to processing/accepted reservations,
      complete immutable identity, record counts, prefix cursor, and terminal response.
- [x] Implement atomic per-record cursor advancement in existing record
      transaction cores and expose durable plus derived seams.
- [x] Preserve Postgres projection/dirty repair behavior and immediate
      best-effort changed-record notification parity.

## 3. Coordination and execution

- [x] Add shared re-entrant connector-instance coordination to all direct,
      provider/webhook, delete/purge, startup, manifest, drift, repair, and
      operator lexical/semantic writer paths.
- [x] Add bounded global admission/index permits, Postgres separate advisory
      pool lifecycle, and safe fixed diagnostics.
- [x] Add child compute execution with attempt/generation/job/backend fences,
      deadline, TERM/KILL confirmation, and fail-stop capability checks.

## 4. Device route

- [x] Validate canonical hashes before reservation, replay exact stored accepted
      results, preserve sticky processing, complete immutable preflight, and
      repair final collapsed logical keys before generation-fenced acceptance.
- [x] Share the full-envelope hash/wire projection request builder across every
      shipped sender and exercise that builder against the server route.

## 5. Evidence

- [x] Add deterministic SQLite and real-Postgres state, failure, collision,
      duplicate-key, manifest/backfill, notification, privacy, and lock tests.
- [x] Add operational 1/2/4/8 transformer benchmark receipt with a synthetic
      100-record fixture, result equality/cardinality, high-water, and RSS.
- [x] Add a real local-transformer-child plus disposable-PostgreSQL HTTP oracle
      for two 100-record batches, exact vectors, replay, latency, bounded work,
      confirmed child shutdown, and response/log privacy.
- [x] Run focused suites, typecheck/changed-file lint, strict OpenSpec validation, diff/remnant
      checks, and record unavailable oracle(s) honestly in the delivery report.
