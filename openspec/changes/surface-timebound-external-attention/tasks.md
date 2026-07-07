## 1. Implementation

- [x] 1.1 Update the shared attention health-relevance predicate to classify
  time-bound external approval rows as health-relevant.
- [x] 1.2 Preserve the existing quiet behavior for unbounded external progress
  notices.

## 2. Verification

- [x] 2.1 Add pure model tests for time-bound, unbounded, and expired external
  attention rows.
- [x] 2.2 Add a connection-summary projection test proving a time-bound external
  approval produces structured owner action.
- [x] 2.3 Run targeted reference-implementation tests and `openspec validate`.

## 3. Live Closeout

- [ ] 3.1 Deploy from clean main after merge.
- [ ] 3.2 Trigger or inspect a browser-backed run that emits
  `act_elsewhere + expires_at`.
- [ ] 3.3 Confirm owner diagnostics and the console classify the row as current
  owner action until it resolves or expires.
