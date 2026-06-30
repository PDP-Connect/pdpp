# Tasks

## 1. Spec

- [x] 1.1 Add a reference-connection-health delta for source action routing and successful terminal coverage rendering.
- [x] 1.2 Validate the OpenSpec change strictly.

## 2. Implementation

- [x] 2.1 Preserve full `run_...` ids from already-running server responses.
- [x] 2.2 Link run-start and already-running toasts to run detail pages.
- [x] 2.3 Reset source-detail local state when the selected source changes.
- [x] 2.4 Render owner-runnable verdict actions as either run controls or detail hints based on action kind.
- [x] 2.5 Render successful terminal coverage as degraded coverage review rather than a total collection failure.

## 3. Tests

- [x] 3.1 Cover missing-credential verdicts routing to `reauth`.
- [x] 3.2 Cover successful terminal coverage rendering as degraded coverage review.
- [x] 3.3 Cover owner-runnable attention cues in the Sources view model.
- [x] 3.4 Cover run toast links, selection reset, and run-action label wiring structurally.
- [x] 3.5 Cover full active-run-id preservation in the server action.

## 4. Validation

- [x] 4.1 Run focused console tests.
- [x] 4.2 Run focused rendered-verdict tests.
- [x] 4.3 Run console typecheck if focused tests pass.
