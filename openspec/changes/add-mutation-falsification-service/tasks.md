## 1. Packet and Receipt Contracts

- [ ] 1.1 Define versioned mutation-packet and mutation-receipt schemas with revision, risk, mutation, provenance, test selection, backstop, budget, outcome, command, diagnostic, and tree-identity fields.
- [ ] 1.2 Implement strict packet and receipt parsers that reject unknown schema versions, missing bounds, revision mismatches, forbidden profiles, and inconsistent outcome evidence.
- [ ] 1.3 Add canonical serialization and content binding for packets, receipts, effective commands, mutant content, and pre/post tree identities.
- [ ] 1.4 Add adversarial tests that alter each bound receipt class and prove validation fails.

## 2. Safe Mutation Executor

- [ ] 2.1 Implement a baseline-first executor in a disposable clean workspace with one mutation per trial.
- [ ] 2.2 Integrate finite wall-time, trial-count, process-concurrency, and cleanup bounds with the repository's local test-resource controls.
- [ ] 2.3 Implement killed, survived, not-exercised, timeout, execution-error, equivalent-suspect, and uninteresting result handling without collapsing uncertainty.
- [ ] 2.4 Emit receipts atomically with exact effective argv, captured diagnostics, durations, exit status, and cleanup evidence.
- [ ] 2.5 Add interruption and failure-path tests that prove bounded termination, child cleanup, exact restoration, and refusal to continue after cleanup failure.

## 3. Test Authority and Selection

- [ ] 3.1 Resolve declared focused tests and backstops against `test-accounting.manifest.json` or an explicit approved mutation-oracle entry.
- [ ] 3.2 Reject unaccounted executable side lanes and static-import-only completeness claims.
- [ ] 3.3 Record focused and backstop results separately so selection misses can be measured.
- [ ] 3.4 Add tests for dynamic/literal inputs, profile mismatch, missing backstop, and focused-pass/backstop-kill cases.

## 4. Existing-Oracle Adapter

- [ ] 4.1 Express each named case in `scripts/test-migration/mutation-oracle.ts` as a mutation packet without weakening its current checks.
- [ ] 4.2 Run the existing oracle through the common executor and preserve its byte-identical rollback proof in receipts.
- [ ] 4.3 Add differential tests proving dropped tests, silent skips, assertion loss, import breakage, and stale literal paths remain detectable.
- [ ] 4.4 Keep the legacy entry point available until receipt comparison proves the adapter has equal or stronger evidence.

## 5. Domain Pilot

- [ ] 5.1 Select one small, high-risk, hermetic domain surface using measured runtime, independent-oracle strength, and expected operator value.
- [ ] 5.2 Implement two or three domain-specific mutation operators with explicit risk provenance and compile-valid output checks.
- [ ] 5.3 Run the focused selection and relevant accounted backstop in advisory mode; capture outcome distribution, misses, runtime, and reviewer effort.
- [ ] 5.4 Add regression tests for every actionable survivor repaired during the pilot and prove each test fails before the repair or kills its nominated mutant.

## 6. Feasibility and Rollout

- [ ] 6.1 Run a time-boxed StrykerJS command-runner experiment on one precompiled pure-TypeScript island, including setup cost, test routing quality, mutant quality, and compute cost.
- [ ] 6.2 Record an explicit continue, adapt, or stop decision for the StrykerJS adapter based on comparison with domain operators.
- [ ] 6.3 Document packet authoring, local advisory execution, receipt triage, equivalent-suspect review, and forbidden live-data profiles.
- [ ] 6.4 Add a non-blocking control lane only after local reliability is proven, with explicit concurrency and time budgets.
- [ ] 6.5 Publish a pilot report covering productive-mutant rate, actionable survivors, focused-to-backstop misses, flaky baselines, cleanup failures, reviewer time, and compute time; propose no blocking gate without calibrated evidence.
