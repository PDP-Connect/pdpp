## 1. OpenSpec authoring

- [x] 1.1 Author proposal, design, and spec delta against `reference-implementation-architecture`.
- [x] 1.2 Validate `propagate-skip-result-diagnostics --strict`.

## 2. Runtime diagnostics propagation

- [x] 2.1 Extend `validateSkipResultMessage` to accept `msg.diagnostics`: object only, not array; non-object values are ignored (the field is dropped from propagation but the message is not rejected).
- [x] 2.2 Add `boundGapDiagnostics` helper that walks the connector-authored object, applies `boundGapString` to every string leaf, preserves bounded numbers/booleans/nulls, caps nested array length and object depth, and substitutes sentinels on overflow.
- [x] 2.3 Add `diagnostics` to `buildKnownGap` so the bounded payload lands on the gap object that flows into terminal `known_gaps` blocks.
- [x] 2.4 Thread the bounded diagnostics into the `run.stream_skipped` spine event `data` block alongside `known_gap`.

## 3. Tests

- [x] 3.1 Add a runtime test where a stub connector emits `SKIP_RESULT` with a structured `diagnostics` object; assert `data.diagnostics` lands on the spine event and on the `known_gap`.
- [x] 3.2 Add a redaction test with secret-shaped string fields; assert the persisted text is redacted.
- [x] 3.3 Add a size-overflow test that emits a large diagnostics blob; assert the sentinel object is persisted instead of the original.
- [x] 3.4 Add a shape-rejection test where `diagnostics` is an array or scalar; assert the field is dropped and the message still propagates.

## 4. Validation

- [x] 4.1 `openspec validate propagate-skip-result-diagnostics --strict`.
- [x] 4.2 Targeted reference runtime tests (collection-profile SKIP_RESULT block).

## Deferred follow-up

- [x] Render bounded `SKIP_RESULT.diagnostics` on the dashboard run timeline detail surface as collapsed connector-authored evidence.
- [ ] Live USAA run with this propagation enabled to capture the actual export-flow root cause from the persisted timeline alone. Owner-only post-deploy step: requires real USAA credentials and operator Docker deployment. Automated tests (3.1–3.4) cover all code paths. Documented as residual risk in `design.md`.
