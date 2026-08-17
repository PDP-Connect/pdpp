## 1. Profile text

- [x] 1.1 Define `streams[].state_stream` and `streams[].parent_streams` manifest fields: placement, type, cardinality, mutual exclusivity, defaults.
- [x] 1.2 Define manifest-time validation: self-reference, unknown-stream, duplicate-parent, both-fields-present, empty-array, cycle.
- [x] 1.3 Define `DETAIL_COVERAGE` wire message: fields, key-set validation, multi-parent emission, `optional_skip_keys` evidence bar.
- [x] 1.4 Define `DETAIL_GAP` wire message: fields, parent-scoping and key-collision rules, `gap_keys`-requires-matching-`DETAIL_GAP` rule.
- [x] 1.5 Define the eligible-checkpoint algorithm for a certified stream-scoped failure, including partial checkpoint-store failure handling.
- [x] 1.6 Define precedence between manifest declarations and live `DETAIL_COVERAGE` evidence.
- [x] 1.7 Define the cancellation-precedes-certification rule.
- [x] 1.8 Resolve the `recovery_hint` empty/retryability-only-object ambiguity.
- [x] 1.9 Update §4 Connector Conformance checklists and §5 TypeScript types to match.
- [x] 1.10 Run `pnpm spec:check` to confirm root/web-spec parity.

## 2. Conformance fixtures

- [x] 2.1 Add a portable conformance harness (real subprocess connector stub + real HTTP server, wire-observable assertions only) for checkpoint-dependency eligibility.
- [x] 2.2 Cover: ordinary same-stream sibling failure; one failed detail stream with one parent; one detail stream with two parents; same detail key under two parents; absent coverage; cycle and unknown-parent manifest rejection; malformed/mismatched failure certification.
- [x] 2.3 Cover cancellation racing a certified stream-scoped failure (zero prior coverage).
- [x] 2.4 Cover partial checkpoint-store failure mid-commit (zero prior coverage).
- [x] 2.5 Add SQLite/Postgres parity for the checkpoint-dependency commit path (zero prior coverage; Postgres gated on `PDPP_TEST_POSTGRES_URL` per existing project convention).

## 3. Verification

- [x] 3.1 Run the new conformance fixtures and confirm fail-before/pass-after evidence.
- [x] 3.2 Run `openspec validate close-checkpoint-dependency-profile-contract --strict`.
- [x] 3.3 Independent checker review of the final diff (`CHECKPOINT-CONTRACT-REVIEW.md`). Verdict: REJECT against the pre-correction commit (`3fc69b98c`). P0 (recovery_hint) was already fixed by a prior corrective commit before the review ran. Findings P1-1 (coverage_strategy), P1-4 (partial-failure identity granularity), P2-1 (DETAIL_COVERAGE ordering enforcement), and P2-3 (parity framing) were confirmed real and addressed in a second corrective commit. P1-3 (parent_streams fallback) was independently disproven by two instrumented, subprocess-driven empirical tests. P1-2 (cycle detection) was confirmed real; addressed by demoting to a documented, non-normative-for-the-reference-implementation floor per the reviewer's own offered alternative, since implementing runtime cycle detection is out of this change's documentation-only scope. P2-2 (Chase/Amazon `optional_skip_keys` non-conformance) was confirmed real and disclosed rather than silently fixed, since correcting shipped connector logic is out of scope for a checkpoint-dependency profile-contract change.
- [x] 3.4 Second independent re-review after the corrective commit. Confirmed two further real gaps: (a) both-fields-present rejection was incidental (via mutually exclusive `coverage_strategy` gating) rather than a direct explicit check — added a direct check and a discriminator test proving it; (b) §4 checklist items 13/15 still echoed stronger guarantees ("exactly which streams committed", cycle rejection as an implemented check) than the already-corrected body text — brought into consistency. See `design.md` Addendum 2. Fixed in a third corrective commit; `recovery_hint` unchanged, verified by diff.
