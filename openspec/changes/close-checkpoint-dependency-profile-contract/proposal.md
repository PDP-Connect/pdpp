## Why

`commit-proven-sibling-state-on-stream-failure` and `close-multi-parent-detail-coverage` landed a coherent, provider-neutral checkpoint-dependency algorithm in the reference runtime: manifest `state_stream`/`parent_streams` declarations, `DETAIL_COVERAGE`/`DETAIL_GAP` wire evidence, and an eligible-checkpoint computation for certified stream-scoped failures. An independent review of the pushed head found that this behavior was never promoted to the public, normative `spec-collection-profile.md` in the detail a second implementer would need: the manifest fields, the two wire messages, their validation rules, and the exact eligibility algorithm existed only in reference-implementation-scoped OpenSpec deltas and source, while the root profile's prose referenced `state_stream` without defining it and never mentioned `DETAIL_COVERAGE`/`DETAIL_GAP` at all. Two independently conformant runtimes could therefore derive different checkpoint-dependency graphs from the same connector output, risking a durable cursor advance over a failed stream's data.

This change closes that gap by fully specifying the already-shipped model in the normative profile — not by inventing new runtime behavior — and by adding portable, profile-level conformance fixtures for the parts of the review's required test matrix that had no coverage anywhere in the repo (cancellation racing a certified failure, partial checkpoint-store failure, and SQLite/Postgres parity for the commit path).

## What Changes

- Define `streams[].state_stream` and `streams[].parent_streams` as normative manifest fields in `spec-collection-profile.md`, with cardinality, mutual exclusivity, and defaults.
- Define manifest-time validation: self-reference, unknown-stream, duplicate-parent, both-fields-present, empty-array, and cycle rejection.
- Define `DETAIL_COVERAGE` and `DETAIL_GAP` as normative connector-to-runtime messages, with exact wire shape, key-set validation, the `optional_skip_keys` evidence bar, and multi-parent gap-scoping rules.
- Define the exact eligible-checkpoint algorithm for a certified stream-scoped failure, including the precedence order between manifest declarations and live `DETAIL_COVERAGE` evidence, and the cancellation-takes-precedence rule.
- Define partial checkpoint-store failure handling (a mid-commit persistence error fails the run and reports exact committed/staged counts) as a normative runtime obligation.
- Resolve the `recovery_hint` empty/retryability-only-object ambiguity: such objects are treated identically to an absent hint for action selection, with `retryable` honored as authoritative input to the runtime's fallback policy.
- Update the profile's TypeScript types and conformance checklists (§4) to match.
- Add profile-level, portable conformance fixtures (real subprocess connector stubs against the real HTTP server, asserting on wire-observable outcomes only) covering the review's required matrix, including the three items with zero prior coverage: cancellation racing a certified failure, partial checkpoint-store failure, and SQLite/Postgres parity.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-runtime`: add profile-level conformance fixtures for checkpoint-dependency eligibility (no runtime behavior change — the algorithm being specified is already shipped).

## Impact

- Updates the normative Collection Profile (manifest fields, wire messages, algorithm, conformance checklist, TypeScript types).
- Adds test-only conformance fixtures; no production code changes.
- Does not alter any shipped runtime behavior, connector, or provider-specific logic.
