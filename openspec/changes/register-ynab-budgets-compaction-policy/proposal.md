# Register the ynab/budgets historical compaction policy

## Why

The `budgets` stream re-emitted every budget on every run because `/budgets`
is a full-collection refetch with no `server_knowledge` delta. YNAB advances
`last_month` (calendar rollover) and `last_modified_on` (any in-budget edit)
without changing the budget-summary fields this stream projects, so ~273
versions per budget accumulated in the 2026-05-26 churn report.

The forward fix shipped in `8eb2a31a`: the connector now gates emit through
`openBudgetCursor` with `BUDGET_FINGERPRINT_EXCLUDE = ["last_month",
"last_modified_on"]`. That stops new churn but does not repair the historical
`record_changes` rows still inflating retained-size accounting and the
dashboard version-churn notice.

The owner/operator historical compaction tool already exists (archived change
`2026-05-29-compact-retained-record-history`) with dry-run default, per-run
backup table, and a connector-fingerprint-mirror policy family. `ynab/budgets`
is simply not yet in the registered policy enumeration. Registering it is the
in-scope, code-review-gated next step: a Family-1 mirror of a connector
fingerprint already in production.

## What Changes

- Add a `ynab/budgets` policy to the compaction tool's registry with
  `excludeKeys: ["last_month", "last_modified_on"]`, mirroring the shipped
  connector gate one-for-one.
- Extend the canonical Family-1 stream enumeration in the
  reference-implementation-architecture capability spec to include
  `ynab/budgets`.
- Add pure-helper and fingerprint-parity test coverage for the new policy.

No new HTTP route, schedule, or automatic job. No change to the retention
rule, backup/apply safety, dry-run default, or any public read path. No live
data is mutated by this change; running `--apply` against live data remains an
owner-gated manual step.

## Capabilities

- Modified: reference-implementation-architecture

## Impact

- `reference-implementation/scripts/compact-record-history.mjs` — one registry
  entry.
- `reference-implementation/test/compact-record-history.test.js` — registry
  shape assertion + budgets selector tests.
- `reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  — budgets parity fixture + static-guard set.
- `openspec/specs/reference-implementation-architecture/spec.md` — Family-1
  enumeration (via this change's delta).
