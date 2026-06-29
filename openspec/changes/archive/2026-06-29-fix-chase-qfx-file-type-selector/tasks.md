## 1. Implementation

- [x] 1.1 Share the Chase QFX file-type selector family between form-load wait and file-type selection.
- [x] 1.2 Add a semantic fallback for the Chase file-type combobox.
- [x] 1.3 Add a regression test for the shared selector family.

## 2. Validation

- [x] 2.1 Run `openspec validate fix-chase-qfx-file-type-selector --strict`.
- [x] 2.2 Run focused Chase connector tests.
- [x] 2.3 Run polyfill connector typecheck.
- [x] 2.4 Record owner-mediated live Chase retry as a residual risk before
  archiving. The code fix is complete; the live gap is not declared recovered.
