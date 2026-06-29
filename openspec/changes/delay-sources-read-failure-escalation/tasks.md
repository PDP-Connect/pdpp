## 1. Sources read-failure escalation

- [x] 1.1 Render quiet pending-retry copy before the first automatic reset.
- [x] 1.2 Keep explicit read-failure copy only after the automatic retry has failed.
- [x] 1.3 Rephrase last-known timestamp copy so it does not claim cached cards are being shown.

## 2. Validation

- [x] 2.1 Update the read-resilience invariant test.
- [x] 2.2 Run the focused read-resilience tests.
- [x] 2.3 Run console typecheck.
- [x] 2.4 Run `openspec validate delay-sources-read-failure-escalation --strict`.
