# Tasks

## 1. Forward connector fixes (new connector-side no-op gates)

- [x] 1.1 usaa `accounts`: gate `emitAccountsStream` through an optional
  `FingerprintCursor` with `excludeFromFingerprint:["fetched_at"]`, prune stale,
  persist `fingerprints` into the `accounts` STATE cursor; add
  `readPriorAccountFingerprints`; open the cursor in `collect` when `accounts`
  is requested.
- [x] 1.2 usaa `credit_card_billing`: gate `runCreditCardBillingStream` through
  an optional `FingerprintCursor` with `excludeFromFingerprint:["fetched_at"]`,
  prune stale, persist `fingerprints` into the `credit_card_billing` STATE
  cursor; add `readPriorCreditCardBillingFingerprints`; open the cursor in
  `collect` when `credit_card_billing` is requested.

## 2. Register the compaction policies

- [x] 2.1 Add `usaa/accounts` (`excludeKeys: ["fetched_at"]`) and
  `usaa/credit_card_billing` (`excludeKeys: ["fetched_at"]`) to
  `COMPACTION_POLICIES` in `compact-record-history.mjs`, each with short +
  registry-URL `connectorIds` and a `connectorSource` pointing at the new
  connector gate. Update the header docstring's Family-1 enumeration.

## 3. Test coverage

- [x] 3.1 Forward-gate tests:
  `connectors/usaa/accounts-fingerprint.test.ts` and
  `connectors/usaa/credit-card-billing-fingerprint.test.ts` — each proves
  no-op-suppressed / real-field-move-emits / STATE round-trip / legacy
  tolerance / connector-vs-compaction fingerprint parity, with explicit
  assertions that a balance (and rewards/APR) move is a DISTINCT fingerprint.
- [x] 3.2 Add the two pairs (in array order) to the
  `COMPACTION_POLICIES exposes the registered policies` assertion in
  `compact-record-history.test.js`.
- [x] 3.3 Add `usaa/accounts` and `usaa/credit_card_billing` parity fixtures to
  `compact-record-history-fingerprint-parity.test.js` and to the static-guard
  `fixturedPairs` set; assert real-field moves change the fingerprint.

## 4. Spec

- [x] 4.1 Extend the Family-1 enumeration in the
  reference-implementation-architecture capability spec to include
  `usaa/accounts` and `usaa/credit_card_billing` via this change's delta.
- [x] 4.2 Add a scenario describing the run-clock collapse and the preserved
  real-financial-state boundary (a balance/rewards/APR move stays a fingerprint
  boundary).

## Acceptance checks

- [x] `node --test --import tsx connectors/usaa/accounts-fingerprint.test.ts
  connectors/usaa/credit-card-billing-fingerprint.test.ts` — pass.
- [x] full USAA connector suite — pass.
- [x] `node --test reference-implementation/test/compact-record-history.test.js`
  — pass (DB-gated tests skipped without `PDPP_TEST_POSTGRES_URL`).
- [x] `node --test --import tsx reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  — pass.
- [x] `pnpm --dir packages/polyfill-connectors typecheck` — pass.
- [x] `pnpm exec openspec validate extend-usaa-real-field-churn-incidental-gates --strict`
  — pass.
- [ ] (Owner-only, deferred) Dry-run each scope against live data, confirm
  `removableVersions`, then `--apply` with the per-run backup table as the
  rollback handle. Not run in this lane (no live credentials; no production
  mutation permitted).
