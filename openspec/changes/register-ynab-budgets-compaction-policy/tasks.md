# Tasks

## 1. Register the policy

- [x] 1.1 Add a `ynab/budgets` entry to `COMPACTION_POLICIES` in
  `reference-implementation/scripts/compact-record-history.mjs` with
  `connectorIds: ['ynab', 'https://registry.pdpp.org/connectors/ynab']`,
  `stream: 'budgets'`, `excludeKeys: ['last_month', 'last_modified_on']`, and a
  `connectorSource` pointing at `BUDGET_FINGERPRINT_EXCLUDE` /
  `openBudgetCursor`.

## 2. Test coverage

- [x] 2.1 Add `['ynab', 'budgets']` to the canonical ordered list in the
  `COMPACTION_POLICIES exposes the registered policies` assertion in
  `reference-implementation/test/compact-record-history.test.js`.
- [x] 2.2 Add a selector test proving `last_month`/`last_modified_on`-only
  adjacent churn collapses under the budgets exclusion.
- [x] 2.3 Add a selector test proving a genuine budget-summary edit (rename
  across a calendar rollover) stays a fingerprint boundary.
- [x] 2.4 Add a `ynab/budgets` parity fixture to
  `reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  and add `ynab/budgets` to the static-guard `fixturedPairs` set.

## 3. Spec

- [x] 3.1 Add `ynab/budgets` to the Family-1 enumeration in the
  reference-implementation-architecture capability spec via this change's delta.
- [x] 3.2 Add a scenario describing the budgets policy's collapse/boundary
  behavior.

## Acceptance checks

- [x] `node --test reference-implementation/test/compact-record-history.test.js`
  — pass (DB-gated tests skipped without `PDPP_TEST_POSTGRES_URL`).
- [x] `node --test --import tsx reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  — pass.
- [x] `pnpm exec openspec validate register-ynab-budgets-compaction-policy --strict`
  — pass.
- [ ] (owner/live, deferred) Dry-run the tool against the live `ynab/budgets`
  scope to confirm a non-zero `removableVersions`, then `--apply` with the
  per-run backup table as the rollback handle. Owner-gated; not run in this lane.
