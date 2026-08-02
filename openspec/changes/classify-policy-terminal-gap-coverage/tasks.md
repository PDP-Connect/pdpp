## 1. Projection and storage

- [x] 1.1 Define one validated immutable terminal policy disposition.
- [x] 1.2 Persist it only through Gmail terminal lease settlement on both stores.
- [x] 1.3 Exclude only the whitelisted disposition from coverage and derive
  diagnostics from it.
- [x] 1.4 Fail closed for malformed, duplicate, failed, or inconsistent
  terminal aggregates.

## 2. Verification

- [x] 2.1 Add deterministic SQLite and throwaway-PostgreSQL policy-versus-
  defect, normalization, scope, and generic-mutation regressions.
- [x] 2.2 Run focused tests, typecheck delta, Ultracite, strict OpenSpec
  validation, and diff checks.
