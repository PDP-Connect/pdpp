## 1. Spec

- [x] 1.1 Add the "RI production code SHALL contain zero connector/provider-specific executable knowledge" requirement and the "executable conformance guard" requirement to `reference-implementation-architecture` via this change's spec delta.
- [x] 1.2 Document the design decisions (structural scan, manifest-derived identity set, scope boundary, no pre-seeded suppression list) in `design.md`.

## 2. Guard implementation

- [x] 2.1 Implement `reference-implementation/test/ri-zero-connector-knowledge-conformance.test.ts`: build the manifest-derived connector-identity set from both manifest roots, scan production `.ts` files for hardcoded-identity literals, connector-specific dispatch/branches, provider endpoint/scope URLs, and provider-shaped env-var names, and fail with a full file:line inventory.
- [x] 2.2 Confirm the guard passes on a synthetic clean fixture (no false positive on generic manifest-driven code) as an inline self-check.
- [x] 2.3 Run the guard against the current `HEAD` and capture the failing inventory verbatim.

## 3. Wire into signoff

- [x] 3.1 Add a new RI-production-path trigger to `scripts/ci-mode.ts` alongside the existing `CONNECTOR_SURFACE_PATH_PREFIXES` check, and run the new guard test file during `ci:signoff` when triggered.
- [x] 3.2 Extend `scripts/ci-mode.test.ts` coverage for the new trigger predicate.

## 4. Verification

- [x] 4.1 Confirm the guard fails against the current violating base and record the exact failure count/list as the inventory (this change intentionally does NOT fix the underlying files).
- [ ] 4.2 Confirm the guard passes once the ~9 currently-known violating files are remediated by their owning follow-up lanes (residual — tracked here, not blocking this change).
- [x] 4.3 Run `openspec validate enforce-ri-zero-connector-knowledge --strict` before archiving.
