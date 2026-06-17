## 1. Spec

- [x] 1.1 Add a `reference-connection-health` requirement for visible self-handled local-device drain progress.
- [x] 1.2 Validate the change with `openspec validate surface-local-collector-background-drain --strict`.

## 2. Console

- [x] 2.1 Add a diagnostics background-upload panel for local-device sources with pending outbox work and no local-device remediation action.
- [x] 2.2 Keep the stalled/dead-letter remediation panel exclusive from the background-upload panel.
- [x] 2.3 Add focused console tests for the rendered panel, host label, count, and remediation exclusion.

## 3. Verification

- [x] 3.1 Run focused diagnostics tests.
- [x] 3.2 Run console typecheck.
- [x] 3.3 Run OpenSpec strict/all validation and `git diff --check`.
- [ ] 3.4 Verify the live peregrine source renders the new panel after deployment, or record why the live queue drained before deployment.
