# race-chatgpt-push-approval-auto-resume

## Why

The ChatGPT auto-login push-approval flow emits a non-blocking `act_elsewhere`
assistance request and polls `isChatGptSessionActive(page)` for ~180s while the
owner approves the sign-in in the ChatGPT app. When that polling window expires
the connector escalates to a blocking `manual_action` INTERACTION ("Approve it…
then click Continue here") and `await`s the owner's response, re-checking
readiness only after the owner responds.

A live run (`run_1782503653985`) proved the gap: the push approval was approved
late — after the 180s window — and the browser reached `https://chatgpt.com/`
with an active session, but the connector only resumed after an explicit owner
interaction response. The owner had to click Continue even though the session
was already live. This contradicts the run-assistance principle that the
reference SHALL NOT require a submitted interaction response solely to continue
when the connector can observe completion by polling — honored during the
initial window, abandoned once it expires.

The remaining structural defect is the short observation budget plus the
blocking-only post-budget path. Current `main` already contains the
session-establishment checkpoint foundation for this flow; this change preserves
that foundation and makes the full observation budget explicitly watchdog-safe.

Realistic human push-approval latency can exceed 180s. Once the old budget
expires, the connector blocks on `manual_action` and stops observing readiness,
so a late approval no longer auto-resumes.

The narrow, correctly-layered fix keeps auto-resume entirely in the existing
non-blocking ASSISTANCE path: extend the poll budget (owner-configurable) so
realistic late approvals auto-resume with no owner interaction, checkpoint
during the whole budget, and only escalate to the blocking `manual_action` after
the budget is genuinely exhausted. No new connector→runtime protocol primitive
is introduced.

## What Changes

- The push-approval non-blocking poll SHALL checkpoint on each tick so the
  session-establishment watchdog observes forward progress and does not trip
  while the run is legitimately waiting on an external approval it can observe.
- Extend the non-blocking poll budget and make it owner-configurable via an env
  var (default raised from 180s to a value that covers realistic approval
  latency). The `act_elsewhere` assistance `timeout_seconds` is derived from the
  same budget so the timeline metadata stays honest.
- Auto-resume on observed readiness during the extended non-blocking poll
  resolves the assistance `resolved` and continues with NO `INTERACTION`
  emitted.
- Only after the poll budget is exhausted does the connector escalate the
  assistance `escalated` and emit the blocking `manual_action` fallback exactly
  as today (owner-click last resort), then re-check readiness once.
- Extract the password/post-submit tail of `ensureChatGptSession` into a
  file-local helper only to make the checkpoint threading legible; behavior and
  fallback order are unchanged.
- No change to captcha/login/OTP or the unexpected-UI manual fallbacks.

## Capabilities

### Modified

- `reference-run-assistance` — externally-approvable interactions auto-resume on
  observed completion across the full observation budget, and that observation
  window must not be killed by the session-establishment watchdog.
- `polyfill-runtime` — connectors driving a long non-blocking observation window
  during session establishment SHALL checkpoint so the watchdog is not tripped.

## Impact

- Connector runtime (`packages/polyfill-connectors/src/connector-runtime.ts`):
  no signature change.
- ChatGPT auto-login (`packages/polyfill-connectors/src/auto-login/chatgpt.ts`):
  extend + checkpoint the poll; env-configurable budget.
- No new protocol envelope, no parent-runtime or controller change.
- No change to live stack, credentials, DB, or deploy configuration.
