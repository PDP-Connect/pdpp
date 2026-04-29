## 1. Record-read second adapters

- [ ] 1.1 Add a conforming memory record-read driver and test against the existing harness.
- [ ] 1.2 Add an env-gated Postgres record-read driver and test against the existing harness.
- [ ] 1.3 Provide self-falsification evidence for memory and Postgres record-read behavior.
- [ ] 1.4 Validate default record-read tests without requiring Postgres.
- [ ] 1.5 Validate Postgres record-read with `PDPP_TEST_POSTGRES_URL` when the Compose proof service is available.

## 2. Record-mutation second adapter

- [ ] 2.1 Add a conforming memory record-mutation driver and test against the existing harness.
- [ ] 2.2 Provide self-falsification evidence for at least one mutation invariant.
- [ ] 2.3 Validate record-mutation conformance and nearby atomicity tests.

## 3. Disclosure-spine second adapter

- [ ] 3.1 Add a conforming memory disclosure-spine driver and test against the existing harness.
- [ ] 3.2 Provide self-falsification evidence for at least one spine invariant.
- [ ] 3.3 Validate disclosure-spine conformance and nearby spine/timeline tests.

## 4. Consolidated owner review

- [ ] 4.1 Rebase all lanes onto current `main` and resolve conflicts.
- [ ] 4.2 Review all diffs together against the owner checklist in `design.md`.
- [ ] 4.3 Run default focused validation for record-read, record-mutation, disclosure-spine, reference typecheck/check, and OpenSpec strict/all.
- [ ] 4.4 Run env-gated Postgres record-read validation if the proof service is available.
- [ ] 4.5 Update this task list only after owner review confirms the batch.

