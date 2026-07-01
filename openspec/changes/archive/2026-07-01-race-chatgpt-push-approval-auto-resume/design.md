# Design — race-chatgpt-push-approval-auto-resume

## Problem, precisely

`handlePushApproval` (`packages/polyfill-connectors/src/auto-login/chatgpt.ts`)
runs two phases:

1. **Observable window.** Emit `act_elsewhere` assistance (`response_contract:
   none`), poll `isChatGptSessionActive(page)` for 36 × 5s = 180s. If readiness
   is observed, complete the assistance `resolved` and continue. This honors
   "do not require a submitted response solely to keep polling."
2. **Blocking fallback.** If the window expires, complete the assistance
   `escalated` and `await manualAction({ reason: "2fa", … })`. After the owner
   responds, re-check `isChatGptSessionActive(page)` once.

`run_1782503653985`: approval landed after 180s; the session was live at
`https://chatgpt.com/`; but the connector was blocked on the fallback
`manual_action` and only resumed on the owner's click.

Current `main` already includes the session-establishment checkpoint foundation
for this flow. The remaining defect is structural: short budget plus
blocking-only post-budget path.

180s does not cover realistic human push-approval latency. Once the budget
expires the connector blocks on `manual_action` and stops observing readiness, so
a late approval requires an owner click.

## Decision: narrow fix in the non-blocking ASSISTANCE path

We keep auto-resume entirely in the existing non-blocking `act_elsewhere`
assistance path:

1. **Extend the poll budget**, owner-configurable via
   `PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS` (default raised to cover realistic
   approval latency). The `act_elsewhere` assistance `timeout_seconds` is
   derived from the same budget so timeline metadata stays honest.
2. **Checkpoint each poll tick** so the watchdog observes forward progress. This
   is honest: the connector IS making progress (actively probing readiness), and
   the watchdog still catches a genuinely wedged renderer because a hung
   `page.evaluate`/`waitForTimeout` would stop advancing the checkpoint. The
   existing sparse checkpointing is preserved for continuity; per-tick
   checkpointing makes the longer budget explicit rather than relying on an
   incidental cadence.
3. **Auto-resume with NO interaction** when readiness is observed during the
   window: complete the assistance `resolved`, continue.
4. **Blocking fallback only after the budget is exhausted**: complete the
   assistance `escalated`, emit `manual_action` exactly as today, re-check
   readiness once.

This satisfies the objective — when the session becomes active while the
connector is waiting on the owner's external approval, the connector continues
without an owner click — for the entire (now much longer) observation budget,
which is where the live failure actually occurred. The blocking fallback is
preserved as the terminal owner-driven recovery path, unchanged.

## Why NOT a connector-initiated interaction-withdrawal primitive

An earlier draft proposed an `INTERACTION_WITHDRAW` connector→runtime envelope so
the connector could race the blocking `manual_action` against a readiness poll
and retire the interaction when readiness won. It is rejected:

- **Wrong altitude / layering.** It adds a new protocol primitive
  (connector-initiated cancellation of a pending interaction) to solve a problem
  that does not require leaving the non-blocking ASSISTANCE path. The
  `act_elsewhere` assistance already models "owner acts elsewhere; connector
  observes completion; no response required." Extending its budget and keeping it
  alive (not tripping the watchdog) is the same capability the run-assistance
  spec already grants — no new envelope needed.
- **More invasive than it looked.** The parent runtime processes connector
  messages strictly one at a time (`index.js::processNext` returns early while
  `processing`), and the `INTERACTION` case `await`s the response inside
  `handleMsg`, so `processing` stays true for the whole pending interaction. An
  in-band `INTERACTION_WITHDRAW` would sit in `msgQueue` and never be dequeued
  while the interaction blocks the queue. Making it work would require an
  out-of-band fast-path in the `rl.on('line')` handler (the same place
  `failPendingInteraction` lives) plus parent-runtime + controller + attention
  changes — a large surface for no capability the non-blocking path lacks.
- **Avoids a `Promise.race` against `manualAction`.** Racing the blocking
  interaction promise risks a dangling stdin listener, a stuck `pendingInteraction`
  gate, an `open` attention row, and a later spurious timeout — all avoided by
  simply not entering the blocking interaction until the observation budget is
  exhausted.

If a future requirement genuinely needs auto-resume *while a blocking
interaction is already pending* (rather than during an observation window), that
is the point to revisit a runtime-level completion primitive — modeled on the
existing mid-wait surface-loss detector
(`controller.ts::wrapInteractionHandlerWithSurfaceLossDetection`), which already
resolves a pending interaction internally and rejects late owner responses with
`no_pending_interaction`. It is out of scope here.

## Alternatives considered

- **Just lengthen the 180s window without explicit progress.** Rejected: a
  longer observation window should make its own progress signal explicit instead
  of depending on sparse checkpoint cadence or unrelated watchdog behavior.
- **Pause the watchdog for the whole poll.** Rejected: pausing entirely would
  blind the run to a wedged renderer during a long wait. Per-tick checkpoint
  keeps the watchdog semantics honest.
- **Poll indefinitely, drop the blocking fallback.** Considered; rejected by
  owner decision — the blocking `manual_action` is retained as the terminal
  owner-driven recovery path after the budget is exhausted.

## Out of scope

- No change to the `act_elsewhere` assistance shape, the blocking fallback copy,
  or captcha/login/OTP/unexpected-UI flows.
- No parent-runtime, controller, attention-writer, or protocol changes.
- Other connectors are unchanged.

## Acceptance checks

1. **Watchdog not tripped during the poll.** With a real (small, test-injected)
   watchdog deadline and a poll that out-lasts it, the run does NOT trip because
   the poll checkpoints each tick.
2. **Auto-resume happy path emits NO interaction.** Readiness observed during
   the (extended) non-blocking poll → `handlePushApproval` returns `true`, the
   assistance is completed `resolved`, and no `INTERACTION`/`sendInteraction` is
   issued.
3. **Assistance ordering on exhaustion.** Budget exhausted with no readiness →
   the assistance is completed `escalated` BEFORE the blocking `manual_action`
   interaction is emitted.
4. **No behavior change to other fallbacks.** captcha/login/OTP and the
   unexpected-UI manual fallback paths are unchanged (existing tests stay green).
5. `openspec validate race-chatgpt-push-approval-auto-resume --strict` passes;
   `git diff --check` clean.

## Residual risks

- Live verification (owner-only): a real ChatGPT run where approval lands after
  the old 180s window confirms the connector auto-resumes without an owner click
  and the watchdog does not fire. Requires real credentials + a push device;
  recorded as a residual risk, not blocking for the code/test tranche.
- If approval latency exceeds even the extended budget, the owner-click fallback
  still applies — by design.
