## Context

The 2026-05-26 churn investigation split version-churn remediation into two
phases: stop forward churn at the connector (per-record fingerprint cursors),
then offer an owner-run, backed-up historical compaction for the rows the bug
window already wrote. The historical tool landed in archived change
`2026-05-29-compact-retained-record-history`. The YNAB `budgets` forward fix
landed later, in `8eb2a31a` — after that tool archived — so `budgets` was never
added to the compaction policy registry.

This change closes that gap. It is deliberately the minimum: one Family-1
registry entry plus its required test coverage, and the spec-enumeration update
that keeps the canonical capability spec honest.

## Decision

### Mirror the connector fingerprint exactly

The connector gate (`packages/polyfill-connectors/connectors/ynab/index.ts`)
defines `BUDGET_FINGERPRINT_EXCLUDE = ["last_month", "last_modified_on"]` and
emits each budget through `openBudgetCursor` → `openFingerprintCursor` →
`recordFingerprint`. The runtime stores the emitted `budgetRecord(b)` verbatim
as `record_changes.record_json`; the record body carries no `fetched_at` (the
run clock lives in the STATE cursor, not the record).

The compaction policy therefore declares `excludeKeys: ["last_month",
"last_modified_on"]`. The script's `recordFingerprint` is byte-for-byte
identical to the connector's canonical helper — asserted by
`compact-record-history-fingerprint-parity.test.js`, which this change extends
with a `ynab/budgets` fixture and the equality check that a `last_month` /
`last_modified_on` delta does not move the fingerprint. So a "removable
historical version" under this policy equals the connector's own "no-op emit"
for the same payload.

### Why excluding the two calendar/clock fields is lossless

- `last_month` is the most recent budget month YNAB has materialized. YNAB
  rolls active budgets forward automatically, so it advances on the 1st of
  every calendar month with no owner action — a clock, not a budget-summary
  edit.
- `last_modified_on` ticks on any in-budget edit (a transaction, a category
  assignment, a memo), none of which change the fields the `budgets` stream
  projects. Those edits surface in their own streams.

Every other field the stream emits — `name`, currency locale, date format,
`first_month`, `deleted` — is a real budget-summary source fact and remains in
the fingerprint. A genuine edit to any of them is a fingerprint boundary the
retention rule never collapses (the second pure-helper selector test proves
this with a rename across a calendar rollover).

### No change to the engine

The retention selector, backup/apply transaction, dry-run default, credential
gate, and retained-size invalidation are untouched. This change only registers
a policy and proves it. The dashboard version-churn drilldown
(`apps/console/src/app/dashboard/lib/version-churn-summary.ts`) is data-driven
from `/_ref/records/version-stats` ground truth; after an owner `--apply` marks
the retained-size projection dirty and the rebuild runs, the `budgets`
`versions_per_record` ratio drops on its own. No drilldown code changes.

## Alternatives Considered

- **Edit `openspec/specs/.../spec.md` directly** to add `ynab/budgets` to the
  Family-1 enumeration. Rejected: that file's deltas come through OpenSpec
  changes; a drive-by edit to the canonical capability spec is disallowed by
  `AGENTS.md`.
- **Skip the spec delta and treat the registry addition as pure code review.**
  Rejected: the capability spec normatively *enumerates* the Family-1 streams,
  so adding one is a durable-contract change that the spec must reflect, even
  though the per-policy authorization is a code-review gate.
- **Add a Family-2 (exact stable-JSON) policy for budgets instead.** Rejected:
  the record body contains `last_month`/`last_modified_on`, which are volatile
  but live *inside* `record_json`. Exact-JSON identity would never collapse the
  historical churn (every version differs in those fields). The Family-1 mirror
  with the connector's own exclusion is the correct, lossless definition.
- **Run a live `--apply` in this lane.** Out of scope and owner-gated. This
  change is fixture/dry-run only; live compaction against the owner's data
  remains a manual, backed-up, owner-approved step.

## Acceptance Checks

- `openspec validate register-ynab-budgets-compaction-policy --strict` passes.
- `node --test reference-implementation/test/compact-record-history.test.js`
  passes, including the two new `ynab/budgets` selector tests and the updated
  registry-shape assertion. (DB-gated tests stay skipped without
  `PDPP_TEST_POSTGRES_URL`.)
- `node --test --import tsx
  reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  passes, including the new `ynab/budgets` parity fixture and the static guard
  that every registered policy has a parity fixture.

## Residual Risks

- **Historical live compaction is still owner-gated.** This change makes the
  `budgets` policy *available*; it does not run it. The dashboard churn notice
  for `ynab / budgets` persists until an owner runs the tool with `--apply`
  against the live database (which creates a per-run backup table as the
  rollback handle). That is the named human/live gate.
- **Selector behavior on real budgets history is exercised only by seeded
  fixtures here.** The Postgres-backed integration tests in the test file would
  cover an end-to-end seed, but require `PDPP_TEST_POSTGRES_URL`; they are not
  run in this lane. A dry-run against live data (read-only, no `--apply`) is the
  recommended first owner validation before any apply.
