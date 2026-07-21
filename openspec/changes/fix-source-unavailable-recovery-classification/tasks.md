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

## 5. Scheduler retry-classifier fix (2026-07-10 addendum)

- [x] Trust an explicit `connector_error.retryable === true` over the `runRequiresOwnerAuthRepair` free-text heuristic in `runtime/scheduler-retry-classifier.ts`, so a proven-retryable `source_unavailable` session-establishment failure is not vetoed by the `session_failed` substring in its wrapped message.
- [x] Add regressions proving both directions: a declared-retryable `source_unavailable` message is admitted; a genuine `session_required`/`session_expired` auth failure (retryable `false` or absent) is still denied.
- [x] Run focused scheduler/connection-health/USAA/connector-runtime tests, typecheck, `openspec validate --strict`.

## 6. Correction: revert the connector-level manual_action bypass (2026-07-10, root-cause investigation)

- [x] Revert the §4 connector-level change: `classifyUsaaLoginStepFailure` matching USAA's `source_unavailable` page copy no longer bypasses `manual_action` at either failure point. It was over-claimed as proof of a provider outage; the underlying password-field stall was already the connector's dominant, weeks-long recurring failure mode before that page text was ever cited as evidence, which is inconsistent with an intermittent provider condition. The scheduler-level fix in §5 is unaffected and stays — a connector that genuinely declares `retryable: true` for a real transient condition should still bypass the owner-auth heuristic.
- [x] Keep `classifyUsaaLoginStepFailure` as a diagnostic-only label: folded into the owner-facing `manual_action` message (password-field-stall point) and into the thrown diagnostic (post-password fallthrough), never used to skip the owner or assert retryability.
- [x] Wire `capture: CaptureSession | null` through `EnsureUsaaSessionArgs` and both `ensureUsaaSession` call sites (`ensureSession` hook, mid-collection re-auth) so a `source_unavailable`-classified stall captures DOM/screenshot/aria evidence via the existing `captureDom` seam — the missing discriminating capture this investigation needed and didn't have.
- [x] Update/replace the §4 fixture regressions to assert the corrected behavior (manual_action reached in both classifications, differing only in message content; capture invoked on the password-field-stall path).
- [x] Run focused USAA/connector-runtime/scheduler-retry-classifier tests, typecheck.
