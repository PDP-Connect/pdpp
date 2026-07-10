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
