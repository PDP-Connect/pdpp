# Extend the run-clock churn gates to USAA accounts and credit_card_billing

## Why

`register-current-churn-compaction-policies` classified `usaa/accounts` and
`usaa/credit_card_billing` as **report-only**, reasoning that they "churn on
real balance fields … in addition to `fetched_at`" and that "excluding only
`fetched_at` would still leave balance churn … and excluding balances would
hide real changes."

That reasoning conflates two independent options and reaches the wrong
conclusion. Excluding **only** the run-clock `fetched_at` from the fingerprint
is provably lossless:

- A run where the balance (or any real field) moved produces a different
  fingerprint, so the record re-emits — the real change is preserved.
- A run where the entire body modulo `fetched_at` is byte-identical to the
  prior version (a true no-op refresh: same balance, same APR, same status) is
  the only thing suppressed.

"Still leaves balance churn" is the **correct** behavior, not a reason to skip
the fix. The two streams therefore have a safe incidental `fetched_at`
component exactly like `usaa/statements` and `chase/accounts` — the difference
is only that their *non-excluded* fields are real and volatile, which is what
makes a real change re-emit. No real financial value is ever excluded from the
fingerprint.

This was verified against the actual retention selector
(`selectRemovableVersions`): on a balance-changing series with no-op windows,
only the pure-`fetched_at` duplicates collapse; every distinct balance value
survives as a version boundary. On a series where the balance moves every run,
nothing collapses.

## What Changes

- Forward fix: add per-record fingerprint cursors to the USAA connector for
  `accounts` (gate `emitAccountsStream`) and `credit_card_billing` (gate
  `runCreditCardBillingStream`), each with `excludeFromFingerprint:
  ["fetched_at"]`, mirroring the existing `usaa/statements` / `chase/accounts`
  pattern. Both prune on the full dashboard scan and persist a `fingerprints`
  map into their stream STATE cursor. Add `readPriorAccountFingerprints` and
  `readPriorCreditCardBillingFingerprints`.
- Register two Family-1 ("connector fingerprint mirror") compaction policies,
  each `excludeKeys: ["fetched_at"]`:
  - `usaa/accounts`
  - `usaa/credit_card_billing`
- Extend the canonical Family-1 stream enumeration in the
  reference-implementation-architecture capability spec to include the two new
  streams, and add a scenario pinning that a real balance/rewards/APR move
  stays a fingerprint boundary.
- Add forward-gate tests and compaction registry + fingerprint-parity coverage,
  including explicit "real field move is a distinct fingerprint" assertions.

No new HTTP route, schedule, or automatic job. No real financial field is
excluded from any fingerprint. No change to the retention rule, backup/apply
safety, dry-run default, or any public read path. Live owner `--apply` is
deferred and owner-gated.

## Capabilities

- Modified: reference-implementation-architecture

## Impact

- `packages/polyfill-connectors/connectors/usaa/index.ts` — `accounts` +
  `credit_card_billing` fingerprint gates + `readPriorAccountFingerprints` +
  `readPriorCreditCardBillingFingerprints`.
- `packages/polyfill-connectors/connectors/usaa/accounts-fingerprint.test.ts`,
  `packages/polyfill-connectors/connectors/usaa/credit-card-billing-fingerprint.test.ts`
  — new forward-gate tests.
- `reference-implementation/scripts/compact-record-history.mjs` — two registry
  entries + header docstring.
- `reference-implementation/test/compact-record-history.test.js` — registry
  shape assertion.
- `reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  — two parity fixtures (with real-field-boundary assertions) + static-guard
  set.
- `openspec/specs/reference-implementation-architecture/spec.md` — Family-1
  enumeration (via this change's delta).
