# Tasks — race-chatgpt-push-approval-auto-resume

## 1. Preserve the checkpoint hook foundation

- [x] 1.1 Confirm current `main` already passes the session-establishment
      `checkpoint` hook into the ChatGPT auto-login path.
- [x] 1.2 Preserve that hook through the helper extraction.
- [x] 1.3 Pass `checkpoint` into `handlePushApproval`
      (via `submitPasswordAndHandleSecondFactor`) for the extended poll.

## 2. Checkpoint + extend the non-blocking poll

- [x] 2.1 Add `resolveChatGptPushApprovalTimeoutMs()` reading
      `PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS` (positive int) with a raised
      default (900_000 ms); derive the poll attempt count from it and the
      existing 5s interval.
- [x] 2.2 In the push-approval poll loop, call `checkpoint("push-approval-poll")`
      on each iteration.
- [x] 2.3 Derive `chatGptPushApprovalAssistance()` `timeout_seconds` from the
      same budget so the assistance metadata stays honest.

## 3. Auto-resume vs fallback ordering

- [x] 3.1 Keep the existing happy path: readiness observed in the poll →
      complete assistance `resolved`, return `true`, emit NO interaction.
- [x] 3.2 Keep the existing exhaustion path: budget elapsed → complete
      assistance `escalated` THEN emit blocking `manual_action`, re-check
      readiness once. (No new envelope, no Promise.race against manualAction.)

## 4. Tests

- [x] 4.1 Watchdog-not-tripped: a deterministic
      `makeSessionEstablishWatchdog` (small injected deadline) wrapping a
      push-approval poll that out-lasts the deadline does NOT trip, because the
      poll checkpoints each tick (+ a control proving it DOES trip without the
      checkpoint hook).
- [x] 4.2 Auto-resume happy path: readiness observed during the extended
      non-blocking poll → `handlePushApproval` returns `true`, assistance
      completed `resolved`, and NO `sendInteraction`/`INTERACTION` was issued.
- [x] 4.3 Exhaustion ordering: no readiness within budget → assistance
      completed `escalated` BEFORE the blocking `manual_action` interaction is
      emitted.
- [x] 4.4 Budget env override: `PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS` changes
      the assistance `timeout_seconds` (and attempt count via the resolver).
- [x] 4.5 No-regression: existing `chatgpt.test.ts` and
      `chatgpt-login-flow.test.ts` (captcha/unexpected-UI) stay green.

## 5. Validation (Acceptance checks)

- [x] 5.1 `node --test` targeted ChatGPT auto-login suites pass
      (131/131 chatgpt; full package 2240/2240 with 6 skipped, after building
      the better-sqlite3 native binding the sandbox install had skipped).
- [x] 5.2 `openspec validate race-chatgpt-push-approval-auto-resume --strict`
      passes.
- [x] 5.3 `git diff --check` clean.
- [x] 5.4 `tsc --noEmit` clean; `ultracite check` on changed files clean.

## Residual (owner-only)

- [ ] R.1 Live ChatGPT run where approval lands after the old 180s window
      confirms auto-resume without an owner click and no watchdog trip.
      (Requires real credentials + push device; recorded as a residual risk,
      not blocking.)
