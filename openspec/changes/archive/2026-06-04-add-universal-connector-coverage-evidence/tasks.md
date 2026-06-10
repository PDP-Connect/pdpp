# Tasks — add-universal-connector-coverage-evidence

## Tranche A: Promote coverage_policy to reference-contract manifest schema

- [x] A.1 Add `coverage_policy` as an explicit optional typed field to
  `ManifestStreamLike` in `reference-implementation/server/ref-record-utils.ts`
  (the shared base type for all manifest-stream consumers), with the same enum
  values as `ManifestStream` in `ref-control.ts`.
- [x] A.2 Verify `npx tsc --noEmit` in both `reference-implementation/` and
  `packages/polyfill-connectors/` passes with the new field. (Clean.)
- [x] A.3 Add `packages/polyfill-connectors/src/coverage-policy-manifest-honesty.test.ts`:
  two build-time guardrails — (1) any declared `coverage_policy` value must be
  in the recognized enum; (2) an accepted-coverage policy must not combine with
  `required: true` (contradictory-manifest guard). Both tests green (2/2 pass).

## Tranche B: Shared emitDetailCoverage helper (owner-gated)

- [x] B.1 Add `emitDetailCoverage(ctx, params)` to
  `packages/polyfill-connectors/src/connector-runtime.ts` with params:
  `stream`, `stateStream`, `requiredKeys`, `hydratedKeys`, and optional
  `gapKeys` and `optionalSkipKeys`.
- [x] B.2 Add a unit test in `packages/polyfill-connectors/src/connector-runtime.test.ts`
  (or equivalent) verifying the helper emits a valid `DETAIL_COVERAGE` message
  with `reference_only: true` and all required fields present.
- [x] B.3 Refactor `makeConversationDetailCoverage` in
  `packages/polyfill-connectors/connectors/chatgpt/index.ts` to use
  the shared `buildDetailCoverageMessage`; confirm the ChatGPT DETAIL_COVERAGE
  tests still pass.
- [x] B.4 Confirm the contract requirement in `specs/polyfill-runtime/spec.md`
  already says a connector running a list+detail lane SHALL emit
  `DETAIL_COVERAGE` once per run.

## Acceptance checks

### Tranche A

- `openspec validate add-universal-connector-coverage-evidence --strict` — pass.
- `npx tsc --noEmit` in `packages/reference-contract` — no errors.
- `node --test` in `packages/reference-contract` (if test suite exists) — no regressions.
- Confirm 0 connector manifests changed (policy adoption is owner-gated, separate).

### Tranche B (owner-gated)

- `openspec validate add-universal-connector-coverage-evidence --strict` — pass.
- `pnpm --dir packages/polyfill-connectors run typecheck` — no errors.
- New `emitDetailCoverage` unit test passes.
- ChatGPT DETAIL_COVERAGE tests (in `connectors/chatgpt/integration.test.ts`) —
  still pass after refactor.
- No other connector modified.

## Residual risks

- Connector authors may declare `coverage_policy: unsupported` on required
  streams, which produces a `requiredButAccepted` contradiction signal and
  degrades health. The server handles this correctly but authors need to
  understand the `required: false` + `coverage_policy` interplay. Document in
  reference-contract JSDoc.
- `emitDetailCoverage` (Tranche B) is a fire-and-forget helper; callers must
  emit it AFTER the detail lane completes, not before. The contract requirement
  should be clear about timing (once per run, after detail lane).
