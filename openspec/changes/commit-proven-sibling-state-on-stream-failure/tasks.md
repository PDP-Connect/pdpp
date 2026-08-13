## 1. Protocol Contract

- [x] 1.1 Define the certified stream-scoped failure envelope and fail-closed counterweights in the Collection Profile.
- [x] 1.2 Add OpenSpec deltas for the polyfill and reference runtime capabilities.

## 2. Reference Runtime

- [ ] 2.1 Track named stream failures and map them to their covering state streams without connector-specific logic.
- [ ] 2.2 Commit only eligible sibling state after a certified stream-scoped failure while preserving failed terminal evidence.

## 3. Verification

- [ ] 3.1 Add fail-before/pass-after tests for sibling commit, leaked failed-stream state, parent-state mapping, and uncertified/global failure.
- [ ] 3.2 Run focused runtime tests, typecheck, formatting, complexity, spec parity, strict OpenSpec validation, and the canonical accounting gate.
- [ ] 3.3 Deploy an exact-revision image to the retained UAT volume and verify a retry resumes completed sibling streams while the failed stream remains unproven until success.
