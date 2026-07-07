## 1. Implementation

- [x] 1.1 Update the shared attention health-relevance predicate to classify
  time-bound external approval rows as health-relevant.
- [x] 1.2 Preserve the existing quiet behavior for unbounded external progress
  notices.
- [x] 1.3 Enforce no-response `ASSISTANCE.timeout_seconds` in the runtime so an
  unresolved assistance window releases the active run as a terminal timeout.
- [x] 1.4 Reconcile open attention rows whose runs have already reached a
  terminal spine event.

## 2. Verification

- [x] 2.1 Add pure model tests for time-bound, unbounded, and expired external
  attention rows.
- [x] 2.2 Add a connection-summary projection test proving a time-bound external
  approval produces structured owner action.
- [x] 2.3 Add a runtime regression test proving unresolved time-bound
  no-response assistance terminals as `assistance_timed_out`.
- [x] 2.4 Add store/startup regression tests proving terminal runs close stale
  owner-action attention rows.
- [x] 2.5 Run targeted reference-implementation tests and `openspec validate`.

## 3. Live Closeout

- [ ] 3.1 Deploy from clean main after merge.
- [ ] 3.2 Trigger or inspect a browser-backed run that emits
  `act_elsewhere + expires_at`.
- [ ] 3.3 Confirm owner diagnostics and the console classify the row as current
  owner action until it resolves or expires.
