## 1. Viewer session mechanism re-point

- [x] 1.1 Route mounted keyboard focus and browser-selection copy through the viewer session without changing console policy.
- [x] 1.2 Preserve typed clipboard-sheet paste where the viewer session has no text-bearing equivalent.
- [x] 1.3 Require both viewer and injected-adapter readiness before every session mechanism call.

## 2. Visible viewport failure

- [x] 2.1 Route viewport-error diagnostics into the existing retryable inline-error state.

## 3. Verification

- [x] 3.1 Add deterministic session-repoint and visible-failure coverage without editing the existing keyboard tests.
- [x] 3.2 Run stream tests, types, RI smoke, keyboard gate, and strict OpenSpec validation.
- [x] 3.3 Prove delayed adapter mount suppresses keyboard focus and selection copy until readiness.
