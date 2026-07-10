## 1. Runtime Fix

- [x] Preserve connector `retryablePattern` semantics when browser session establishment fails.
- [x] Add a connector-runtime regression for `source_unavailable` session failures.

## 2. Projection Read Repair

- [x] Prevent legacy `source_unavailable` known-gap messages from being promoted to credential repair.
- [x] Classify legacy `source_unavailable` known-gap messages as retryable source conditions rather than terminal connector-code defects.
- [x] Preserve existing auth 401/403 credential repair behavior.
- [x] Add a source-health regression for the USAA-shaped persisted failure.

## 3. Validation

- [x] Run focused connector-runtime and USAA tests.
- [x] Run `openspec validate fix-source-unavailable-recovery-classification --strict`.
- [x] Run focused connection-health tests.

## 4. Connector-level bypass (2026-07-10 addendum)

- [x] Classify body text before calling `requestManualLoginRecovery` at the password-field-stall failure point in `ensureUsaaSession`.
- [x] Classify body text at the final post-password fallthrough failure point too.
- [x] Add/update fixture-based regressions proving no `manual_action` interaction is emitted for a proven `source_unavailable` page.
- [x] Run focused USAA/connector-runtime/watchdog/connection-health tests, typecheck, `openspec validate --strict`, lint diff.
