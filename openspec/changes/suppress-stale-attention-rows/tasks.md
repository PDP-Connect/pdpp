## 1. Reference Attention Read Model

- [x] Filter expired open attention rows in SQLite and Postgres store reads.
- [x] Keep the existing bounded limit and connector-instance scoping.

## 2. Tests

- [x] Add a focused test for expired open attention suppression.
- [x] Add a projection test for stale manual action after later success.

## 3. Acceptance Checks

- [x] `openspec validate suppress-stale-attention-rows --strict`
- [x] Targeted attention tests pass.
