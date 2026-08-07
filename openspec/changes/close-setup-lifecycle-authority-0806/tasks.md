## 1. Contract and authority

- [x] 1.1 Add the shared terminal setup-disposition contract and count-presence
  evidence to the existing run-history facts payload.
- [x] 1.2 Add connection-scoped exact/latest run-history readers and wire setup
  status to them.
- [x] 1.3 Carry the shared disposition through the owner summary contract.

## 2. Owner surfaces

- [x] 2.1 Distinguish terminal setup states and status-page copy/actions.
- [x] 2.2 Make Dashboard, Sources, and Syncs consume the same disposition copy
  while retaining draft discoverability and inactive scheduling behavior.

## 3. Verification

- [x] 3.1 Add deterministic valid-empty, silent-zero, and missing-count tests.
- [x] 3.2 Add duplicate-run-id, no-run-id revisit, and cross-surface zero-yield
  tests.
- [x] 3.3 Run focused tests, lint/type checks, and strict OpenSpec validation.
