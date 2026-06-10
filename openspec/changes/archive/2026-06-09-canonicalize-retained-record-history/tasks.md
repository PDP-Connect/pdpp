## 1. Policy And Selector

- [x] 1.1 Add `--mode=audit|canonical` parsing to `compact-record-history.mjs`, defaulting to `audit`.
- [x] 1.2 Add `changeModel` and `representativePolicy` fields to compaction policies, with canonical mode refusing policies that are not explicitly eligible.
- [x] 1.3 Implement canonical selector behavior that keeps current-row survivors, real fingerprint boundaries, tombstones, and resurrection boundaries while dropping duplicate same-fingerprint history.
- [x] 1.4 Keep audit-mode selector behavior byte-for-byte compatible with existing tests.

## 2. Chase Transaction Opt-In

- [x] 2.1 Mark only `chase/transactions` as `changeModel: "immutable_semantic"` and `representativePolicy: "current"` for the first implementation slice.
- [x] 2.2 Keep `chase/transactions` fingerprint exclusions aligned with connector runtime exclusions for `fetched_at` and `source`.
- [x] 2.3 Confirm no other Chase, USAA, Amazon, ChatGPT, agent, or point-in-time stream is eligible in this tranche.

## 3. Tests

- [x] 3.1 Add selector unit tests for canonical duplicate collapse to one current survivor.
- [x] 3.2 Add selector unit tests for distinct-fingerprint boundaries, tombstones, and resurrection boundaries.
- [x] 3.3 Add denial tests for canonical mode on missing or mutable policies.
- [x] 3.4 Strengthen fingerprint parity tests so they fail closed instead of silently skipping when the connector helper cannot load.
- [x] 3.5 Add a Chase transaction convergence regression test proving old metadata-churn history compacts to one retained current survivor per key.

## 4. Copied-Database Validation

- [x] 4.1 Recreate or refresh the narrow copied database for `cin_029a67a16d8a252f6e3eb896/chase/transactions`.
- [x] 4.2 Run audit-mode dry-run and confirm it still reports the conservative `4605 -> 2289` shape on the copied data.
- [x] 4.3 Run canonical-mode dry-run and confirm it reports the canonical `4605 -> 1145` shape on the copied data.
- [x] 4.4 Apply canonical mode on the copied database and confirm every current `records.version` still has a matching retained history row.
- [x] 4.5 Re-run canonical-mode dry-run after copied-database apply and confirm idempotence.

## 5. Acceptance Checks

- [x] 5.1 Run focused compact-record-history tests.
- [x] 5.2 Run Chase transaction fingerprint/integration tests.
- [x] 5.3 Run `openspec validate canonicalize-retained-record-history --strict`.
- [x] 5.4 Run `openspec validate --all --strict`.
- [x] 5.5 Run `git diff --check`.

## 6. Live Owner Gate

- [ ] 6.1 Run live canonical-mode dry-run only after copied-database validation passes.
- [ ] 6.2 Do not run live canonical apply until the owner explicitly approves the destructive retained-history mutation.
- [ ] 6.3 After any approved live apply, run retained-size projection refresh and verify records/connections UI ratios.
