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

## 5. Merge-sequencing dependency (added 2026-08-09, revise3 pass)

- [ ] 5.1 **This guard series (and any branch built on it, e.g. `local/ri-runtime-guard-revise3-0809`) is NOT independently mergeable to `main` today.** The terminal test `RI production code contains zero connector/provider-specific executable knowledge` in `reference-implementation/test/ri-zero-connector-knowledge-conformance.test.ts` fails with exactly 91 violations against the current integrated base (Cluster A: `provider-auth/*`; Cluster B: `connector-key.ts`, `connection-setup-plan.ts`, `server/stores/provider-auth-run-credentials.ts`, `server/deployment-diagnostics.ts`). Per spec (`reference-implementation-architecture`, "The guard runs as part of the reference implementation test suite"), the guard SHALL execute inside `pnpm --dir reference-implementation test` and SHALL fail on any violation — this is normative, not a wiring bug, so the terminal assertion is intentionally NOT gated, ratcheted, or otherwise weakened to pass early.
- [ ] 5.2 `pnpm --dir reference-implementation test` is also the unconditional test step behind the hosted `reference-implementation` required status check (`.github/workflows/reference-implementation.yml`, "Test reference implementation" step, gated only on `reference_impacting == 'true'`, which covers nearly all RI production paths) and behind local `ci:signoff`'s `zeroConnectorKnowledgeGateRequired` trigger (`scripts/ci-mode.ts`). Landing this series to `main` before Cluster A/B closes would turn that required check red for the whole team on unrelated RI PRs.
- [ ] 5.3 Merge order: this series lands ONLY after the active provider-auth lane (owns Cluster A: `server/provider-auth/*`, `server/stores/provider-auth-run-credentials.ts`, `server/deployment-diagnostics.ts`'s Google env-key rows) and the active allowlist/connector-key lane (owns Cluster B: `server/connector-key.ts`, `server/connection-setup-plan.ts`) both land and the terminal test is re-run and confirmed at zero violations. Until then this branch stays open/unmerged; do not force-merge past the required check, and do not add a legacy-baseline allowlist/ratchet to make it pass early — see `docs/reference/ci-mode.md`'s "Zero-connector-knowledge guard merge dependency" note for the operational detail.
