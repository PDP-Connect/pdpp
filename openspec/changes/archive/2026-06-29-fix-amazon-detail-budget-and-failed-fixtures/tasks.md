## 1. Spec

- [x] Create OpenSpec change `fix-amazon-detail-budget-and-failed-fixtures`.
- [x] Add a `polyfill-runtime` requirement delta for bounded Amazon detail failure handling.
- [x] Validate with `openspec validate fix-amazon-detail-budget-and-failed-fixtures --strict`.

## 2. Implementation

- [x] Return structured Amazon detail fetch results with precise redacted failure reasons.
- [x] Capture one failed detail page fixture per run when fixture capture is enabled.
- [x] Defer later detail fetches after repeated temporary failures without changing global watchdogs.
- [x] Preserve order record emission, `DETAIL_GAP`, `DETAIL_COVERAGE`, and state checkpoint ordering.

## 3. Tests

- [x] Add focused Amazon tests for reason classification.
- [x] Add focused Amazon tests for failed-detail fixture capture.
- [x] Add focused Amazon tests for deferring later details after repeated temporary failures.

## 4. Acceptance checks

- [x] `openspec validate fix-amazon-detail-budget-and-failed-fixtures --strict`
- [x] Focused Amazon connector tests
- [x] Typecheck if feasible
