## Why

Live source health showed a stored-credential USAA connection projected as needing credential repair after the source login system reported `source_unavailable`.

The connector had not proved credential rejection. The connector already declared `source_unavailable` retryable, but the shared browser session-establishment wrapper converted the failure into a non-retryable terminal error before the outer runtime could apply the connector retryability pattern. That bad terminal event then persisted as a `refresh_credentials` known gap and the source-health projection over-promoted it into an owner reconnect action.

## What Changes

- Preserve connector retryability patterns when browser session establishment fails.
- Keep definitive auth failures mapped to credential repair.
- Prevent legacy `source_unavailable` run evidence from manufacturing a credential-required condition.
- Add regressions for the shared runtime seam and the live source-health shape.

## Capabilities

Modified:

- `reference-connection-health`
- `polyfill-runtime`

## Impact

- USAA-like source outages no longer ask the owner to reconnect credentials without credential-rejection evidence.
- Browser-backed connectors keep their declared retryability semantics during session establishment.
- Existing credential-rejection and missing-credential paths are unchanged.

## Addendum (2026-07-10): connector-level manual_action bypass

A live run showed the runtime/projection fix above was necessary but not sufficient. `ensureUsaaSession` (packages/polyfill-connectors/src/auto-login/usaa.ts) already had `classifyUsaaLoginStepFailure` to detect USAA's `source_unavailable` page, but never consulted it before calling `requestManualLoginRecovery` — so the connector sent the owner into a browser to "fix" a page that said the provider's own login system was unavailable, and the owner saw the identical error. Trace evidence localized the fault precisely: `waitForSelector('input[name="password"]')` timed out at exactly its configured 25,000ms deadline after the memberId "Next" click, and the body-text read immediately after (the connector's own diagnostic-capture step) matched the source-unavailable classifier. The defect is definitively a control-flow bug — the classifier already existed and matched, but its result was discarded before the manual_action decision — independent of any question of provider uptime.

Fixed by having both `ensureUsaaSession` failure points (password-field stall after memberId submit; final fallthrough after password submit) classify body text first. When `classifyUsaaLoginStepFailure` returns `source_unavailable`, the connector now throws a `source_unavailable`-prefixed error directly — matching `USAA_RETRYABLE_PATTERN` and flowing through the already-fixed `buildSessionEstablishTerminalError` retryable seam — instead of calling `manualAction`. No new taxonomy, no new spec capability: this closes the connector-level gap that the runtime/projection fix assumed was already closed.

## Addendum (2026-07-10): scheduler retry classifier discarded the connector's own retryable signal

Both addenda above make the connector throw a retryable `source_unavailable` error and make the source-health projection read the resulting persisted event correctly. Neither of those governs whether the **scheduler actually retries the run with bounded backoff** — that decision belongs to `runtime/scheduler-retry-classifier.ts`'s `shouldRetryRunFailure`, called from `runWithRetries`/`runSingleAttempt` in `runtime/scheduler/run-executor.ts`.

That classifier had its own independent bug. `buildSessionEstablishTerminalError` prefixes every session-establishment failure's message with `${name}_session_failed:` — for USAA, `usaa_session_failed: source_unavailable: ...` — regardless of whether the failure is retryable. `shouldRetryRunFailure`'s `runRequiresOwnerAuthRepair` heuristic pattern-matches free text for owner-auth signals and includes `session_failed` in its regex (intended to catch genuine expired/rejected browser sessions). That heuristic ran unconditionally, before the classifier ever consulted `connector_error.retryable`, so it vetoed the connector's own explicit `retryable: true` and the scheduler gave up within the same tick instead of retrying with its bounded backoff. Reproduced directly: `shouldRetryRunFailure({ connector_error: { message: 'usaa_session_failed: source_unavailable: ...', retryable: true } })` returned `false` before this fix.

Fixed by having `runRequiresOwnerAuthRepair` trust an explicit `connector_error.retryable === true` over the free-text heuristic — a connector-neutral signal a connector only sets after its own retryability pattern already matched (e.g. `USAA_RETRYABLE_PATTERN`). The message-text heuristic still applies whenever `retryable` is `false` or absent, so a genuine `session_required`/`session_expired` auth failure (where the connector has not declared retryability, or has declared `false`) is unaffected and still routes to credential repair. No taxonomy change; the fix is scoped to the one seam that discarded an already-computed connector signal.

## Correction (2026-07-10): the connector-level bypass addendum above was itself wrong

The owner reported that USAA works normally in their own daily-driver browser at the time this connection was failing — directly contradicting the prior addendum's framing of the recurring password-field stall as a proven provider outage. A closer read of this change's own history shows the "trace evidence" cited for that addendum was narrative inference (a timeout at the configured deadline, plus page copy matching a classifier), never an actual captured screenshot, DOM snapshot, or other artifact — no fixture or trace file for that specific run exists in the repository. More importantly, an earlier commit in this same file's history (`70efc3e65`, 2026-07-09, one day before the bypass addendum) states directly: *"The memberId->password step timeout... has been the dominant USAA failure mode for weeks."* A failure mode that has been constant for weeks, with the exact same page text on every occurrence, is not what an intermittent provider outage looks like — it is far more consistent with a persistent automation-side condition (e.g. a stale/blocked isolated browser profile, or bot-detection response specific to the automated login flow) that happens to render USAA's generic "system unavailable" boilerplate. USAA is a bank; banks are a canonical target for behavioral bot-detection (e.g. Akamai Bot Manager), and the connector's login fills form fields via Playwright `fill()` (a single synthetic DOM/value assignment, not per-keystroke events) with no other human-like timing — a plausible, though unproven, contributing signal.

**Reverted:** `classifyUsaaLoginStepFailure` matching `source_unavailable` no longer bypasses `manual_action` at either failure point. Page-copy matching alone is not sufficient evidence of provider uptime to withhold the one signal (a human completing login in the visible browser, or failing to) that can actually discriminate a real outage from a persistent automation-side block. Both failure points now route back through `requestManualLoginRecovery`, with the classification folded into the owner-facing message (password-field-stall point) or the thrown diagnostic (post-password fallthrough) as a label, not a bypass condition.

**Added:** `capture: CaptureSession | null` is now threaded through `EnsureUsaaSessionArgs` and both `ensureUsaaSession` call sites, so a `source_unavailable`-classified stall captures DOM/screenshot/aria evidence via the existing `captureDom` seam (`fixture-capture.ts`, already used by the Reddit connector's `captureLoginState`). This was the actual missing piece: the next occurrence produces real evidence instead of requiring another round of narrative inference from timeout values and page copy.

**Unaffected:** the scheduler-retry-classifier fix in the addendum immediately above this one is NOT reverted — a connector that genuinely declares `retryable: true` for a real transient condition should still bypass the free-text owner-auth heuristic. That fix is generic and correct independent of whether USAA's specific classification was over-claimed.

**Also verified, not changed:** the connection-health `consecutiveFailures` → `blocked` escalation (`scheduler-backoff.ts`, `BLOCKED_PROMOTION_THRESHOLD = 7`) is structurally intact and keys off run-history `status: "failed"` records regardless of per-attempt retryability, so a persistent USAA failure should already promote to owner-actionable `blocked` state after 7 consecutive same-class scheduled failures, independent of this connector-level classification. Whether that promotion is actually visible to the owner for the live USAA connection could not be verified without querying the live stack, which was out of scope for this change.
