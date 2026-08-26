// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the session-establishment watchdog.
 *
 * The watchdog guards the window between the browser page being created and the
 * connector returning from session establishment. A wedged renderer can hang a
 * connector's ensureSession indefinitely with no INTERACTION ever emitted, so
 * the controller-side mid-wait detector cannot help. The watchdog keys on
 * checkpoint progress, is paused while an interaction is open, and fails the
 * run closed if establishment stalls.
 *
 * We drive a controllable logical clock via the injectable `now` seam so the
 * trip decision is deterministic while a tiny `pollIntervalMs` lets the real
 * interval timer tick quickly. No real Playwright, no real sleeps proportional
 * to the production deadline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";

import {
  type AssistanceCompletionStatus,
  type AssistanceRequest,
  captureBrowserPage,
  type InteractionRequest,
  type InteractionResponse,
  makeSessionEstablishWatchdog,
  resolveSessionEstablishWatchdogMs,
} from "./connector-runtime.ts";
import type { CaptureSession } from "./fixture-capture.ts";
import { buildSessionEstablishTerminalError, establishSession } from "./session-establish.ts";

// A controllable logical clock: tests advance `value` to simulate elapsed time
// without waiting in real time. The watchdog's interval still ticks on real
// time (tiny pollIntervalMs), but its trip math reads this clock.
function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

// Minimal Page stand-in. capture is null in these tests, so captureBrowserPage
// returns early and never touches the page. isClosed is the only method the
// capture guard could reach; provide it defensively.
function makeStubPage(): Page {
  const fake: Pick<Page, "isClosed"> = { isClosed: () => false };
  return fake as Page;
}

// Poll on a short real interval so ticks happen promptly; advance the logical
// clock and let the event loop turn so a tick can observe it.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const nonblockingAssistance = (): AssistanceRequest => ({
  message: "Approve this request in the source app.",
  owner_action: "act_elsewhere",
  progress_posture: "running",
  response_contract: "none",
  sensitivity: "non_secret",
  timeout_seconds: 1800,
});

test("watchdog trips when establishment never checkpoints and never returns", async () => {
  const clock = makeClock();
  const trips: Array<{ lastLabel: string | null; sinceMs: number }> = [];
  const watchdog = makeSessionEstablishWatchdog({
    capture: null,
    name: "amazon",
    page: makeStubPage(),
    deadlineMs: 100,
    pollIntervalMs: 2,
    now: clock.now,
    onTrip: (info) => trips.push(info),
  });

  // Work that never resolves and never checkpoints — the wedged-renderer case.
  const work = (): Promise<void> =>
    new Promise<void>(() => {
      /* never resolves */
    });

  // Attach the rejection handler synchronously (before advancing the clock) so
  // there is no window where the run's rejection is unhandled — node:test
  // treats a transiently-unhandled rejection as a failure.
  const rejection = assert.rejects(watchdog.run(work), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /amazon_session_establish_timeout/);
    assert.match(err.message, /no session-establishment progress/);
    return true;
  });
  // Advance logical time past the deadline; let the real interval observe it.
  clock.advance(150);
  await rejection;
  assert.equal(trips.length, 1);
  assert.equal(trips[0]?.lastLabel, null);
});

test("watchdog records the last checkpoint label in the trip and terminal message", async () => {
  const clock = makeClock();
  const watchdog = makeSessionEstablishWatchdog({
    capture: null,
    name: "amazon",
    page: makeStubPage(),
    deadlineMs: 100,
    pollIntervalMs: 2,
    now: clock.now,
  });

  const work = async (): Promise<void> => {
    await watchdog.checkpoint("amazon-email-submit");
    // then stall forever
    await new Promise<void>(() => {
      /* never resolves */
    });
  };

  const rejection = assert.rejects(watchdog.run(work), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /last checkpoint: amazon-email-submit/);
    return true;
  });
  clock.advance(150);
  await rejection;
});

test("watchdog does NOT trip while establishment keeps checkpointing past the deadline", async () => {
  const clock = makeClock();
  let tripped = false;
  const watchdog = makeSessionEstablishWatchdog({
    capture: null,
    name: "amazon",
    page: makeStubPage(),
    deadlineMs: 100,
    pollIntervalMs: 2,
    now: clock.now,
    onTrip: () => {
      tripped = true;
    },
  });

  // Five phases, each 80ms apart (< deadline). Total 400ms >> deadline, but no
  // single gap exceeds it, so the watchdog must not trip.
  const work = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await watchdog.checkpoint(`phase-${i}`);
      clock.advance(80);
      await tick();
    }
  };

  await watchdog.run(work);
  assert.equal(tripped, false, "steadily-checkpointing flow must not be killed");
});

test("watchdog is paused while an interaction is open (long owner wait is not killed)", async () => {
  const clock = makeClock();
  let tripped = false;
  const watchdog = makeSessionEstablishWatchdog({
    capture: null,
    name: "amazon",
    page: makeStubPage(),
    deadlineMs: 100,
    pollIntervalMs: 2,
    now: clock.now,
    onTrip: () => {
      tripped = true;
    },
  });

  // sendInteraction that takes "a long time" (advance well past the deadline
  // while it is in flight). Because the watchdog pauses for open interactions,
  // no trip must occur.
  const send = (req: InteractionRequest): Promise<InteractionResponse> =>
    new Promise<InteractionResponse>((resolve) => {
      clock.advance(500); // far past deadline, but interaction is open
      // resolve on a real tick so the interval has chances to (wrongly) trip
      setTimeout(
        () =>
          resolve({
            type: "INTERACTION_RESPONSE",
            request_id: req.request_id ?? "x",
            status: "success",
          }),
        20
      );
    });
  const wrapped = watchdog.wrapSendInteraction(send);

  const work = async (): Promise<void> => {
    await watchdog.checkpoint("before-interaction");
    const resp = await wrapped({ kind: "manual_action", message: "solve" });
    assert.equal(resp.status, "success");
  };

  await watchdog.run(work);
  assert.equal(tripped, false, "open interaction must pause the watchdog");
});

test("watchdog is paused while nonblocking running assistance is open", async () => {
  const clock = makeClock();
  let tripped = false;
  const watchdog = makeSessionEstablishWatchdog({
    capture: null,
    name: "chatgpt",
    page: makeStubPage(),
    deadlineMs: 100,
    pollIntervalMs: 2,
    now: clock.now,
    onTrip: () => {
      tripped = true;
    },
  });

  const assist = (_req: AssistanceRequest): Promise<string> => {
    clock.advance(500);
    return Promise.resolve("assist_1");
  };
  const completeAssistance = async (_assistanceRequestId: string, _status: AssistanceCompletionStatus): Promise<void> =>
    undefined;
  const wrappedAssist = watchdog.wrapAssist(assist);
  const wrappedCompleteAssistance = watchdog.wrapCompleteAssistance(completeAssistance);

  const work = async (): Promise<void> => {
    await watchdog.checkpoint("before-assistance");
    const assistanceRequestId = await wrappedAssist(nonblockingAssistance());
    clock.advance(500);
    await tick();
    await wrappedCompleteAssistance(assistanceRequestId, "escalated");
  };

  await watchdog.run(work);
  assert.equal(tripped, false, "open nonblocking assistance must pause the watchdog");
});

test("watchdog re-arms after nonblocking assistance completes", async () => {
  const clock = makeClock();
  const watchdog = makeSessionEstablishWatchdog({
    capture: null,
    name: "chatgpt",
    page: makeStubPage(),
    deadlineMs: 100,
    pollIntervalMs: 2,
    now: clock.now,
  });

  let assistanceClosed = false;
  const wrappedAssist = watchdog.wrapAssist(async (): Promise<string> => "assist_1");
  const wrappedCompleteAssistance = watchdog.wrapCompleteAssistance(async (): Promise<void> => undefined);

  const work = async (): Promise<void> => {
    const assistanceRequestId = await wrappedAssist(nonblockingAssistance());
    await wrappedCompleteAssistance(assistanceRequestId, "escalated");
    assistanceClosed = true;
    await new Promise<void>(() => {
      /* never resolves */
    });
  };

  const rejection = assert.rejects(watchdog.run(work), /chatgpt_session_establish_timeout/);
  await tick();
  assert.equal(assistanceClosed, true, "assistance should have completed");
  clock.advance(150);
  await rejection;
});

test("watchdog re-arms after an interaction resolves and trips if progress then stalls", async () => {
  // The interaction resets the deadline on resolve, so we must advance the
  // clock AGAIN (past the deadline) after it resolves to observe the re-armed
  // trip. This also proves the deadline is measured from the interaction
  // resolution, not from before it.
  const clock = makeClock();
  const watchdog = makeSessionEstablishWatchdog({
    capture: null,
    name: "amazon",
    page: makeStubPage(),
    deadlineMs: 100,
    pollIntervalMs: 2,
    now: clock.now,
  });

  let interactionResolved = false;
  const send = (req: InteractionRequest): Promise<InteractionResponse> => {
    // Burn 500ms of logical time while the interaction is open (watchdog paused).
    clock.advance(500);
    return Promise.resolve({
      type: "INTERACTION_RESPONSE",
      request_id: req.request_id ?? "x",
      status: "success",
    });
  };
  const wrapped = watchdog.wrapSendInteraction(send);

  const work = async (): Promise<void> => {
    await wrapped({ kind: "manual_action", message: "solve" });
    interactionResolved = true;
    // interaction resolved (deadline reset to "now"); now stall forever
    await new Promise<void>(() => {
      /* never resolves */
    });
  };

  // Attach the rejection handler synchronously; it stays pending until the
  // post-interaction stall trips the re-armed watchdog.
  const rejection = assert.rejects(watchdog.run(work), /amazon_session_establish_timeout/);
  // Let the interaction resolve first (deadline reset happens in its finally).
  await tick();
  assert.equal(interactionResolved, true, "interaction should have resolved");
  // Now advance past the deadline from the post-interaction baseline.
  clock.advance(150);
  await rejection;
});

test("watchdog success path: work resolves before the deadline, no trip", async () => {
  const clock = makeClock();
  let tripped = false;
  const watchdog = makeSessionEstablishWatchdog({
    capture: null,
    name: "gmail",
    page: makeStubPage(),
    deadlineMs: 100,
    pollIntervalMs: 2,
    now: clock.now,
    onTrip: () => {
      tripped = true;
    },
  });

  await watchdog.run(async () => {
    await watchdog.checkpoint("session-establish:begin");
    // resolves promptly
  });
  // Even if time later advances, the timer was cleared on completion.
  clock.advance(1000);
  await tick();
  assert.equal(tripped, false);
});

test("watchdog propagates a real establishment failure unchanged (not a timeout)", async () => {
  const clock = makeClock();
  const watchdog = makeSessionEstablishWatchdog({
    capture: null,
    name: "amazon",
    page: makeStubPage(),
    deadlineMs: 100,
    pollIntervalMs: 2,
    now: clock.now,
  });

  await assert.rejects(
    watchdog.run(async () => {
      await watchdog.checkpoint("amazon-auth-probe");
      throw new Error("amazon_login_unexpected_ui");
    }),
    /amazon_login_unexpected_ui/
  );
});

test("session-establishment terminal errors preserve connector retryable patterns", () => {
  const terminal = buildSessionEstablishTerminalError(
    "usaa",
    "source_unavailable: USAA reported its login system is currently unavailable after Next click.",
    /ECONN|ETIMEDOUT|timeout|source_unavailable/i
  );

  assert.equal(
    terminal.message,
    "usaa_session_failed: source_unavailable: USAA reported its login system is currently unavailable after Next click."
  );
  assert.equal(terminal.retryable, true);
});

// ─── post-submit retry-safety marker (systemic credential-submit fix) ──────
//
// The oracle established from Venmo B4 and generalized across USAA/Chase/
// HEB/Amazon/Venmo/ChatGPT/Jellyfin: a fault occurring AFTER a saved
// credential has been submitted to the provider's real sign-in form must be
// forced non-retryable, regardless of whether its message text happens to
// match the connector's `retryablePattern` (declared or default). This is
// the single point that closes the naming-collision defect class.

test("postSubmit forces retryable:false even though the message matches retryablePattern (the naming-collision case)", () => {
  const terminal = buildSessionEstablishTerminalError(
    "usaa",
    "ECONNRESET", // matches DEFAULT_RETRYABLE_PATTERN AND every connector's declared pattern by construction
    /ECONN|ETIMEDOUT|timeout|source_unavailable/i,
    true // postSubmit
  );
  assert.equal(terminal.retryable, false);
});

test("mutation-kill: the SAME fault pre-submit (postSubmit=false) remains retryable — proves the two tests discriminate on the flag, not on the message", () => {
  const terminal = buildSessionEstablishTerminalError(
    "usaa",
    "ECONNRESET",
    /ECONN|ETIMEDOUT|timeout|source_unavailable/i,
    false // postSubmit
  );
  assert.equal(terminal.retryable, true);
});

test("postSubmit forces retryable:false even with the DEFAULT pattern and no connector-declared pattern at all", () => {
  // Covers Chase/HEB/Amazon/Jellyfin: none declares retryablePattern, so
  // DEFAULT_RETRYABLE_PATTERN (/ECONN|ETIMEDOUT|timeout/i) applies. A bare
  // Playwright "Timeout 30000ms exceeded" after password submit must still
  // be forced non-retryable.
  const terminal = buildSessionEstablishTerminalError(
    "chase",
    "chase_login_failed_before_otp_submit: surface=open: Timeout 5000ms exceeded",
    undefined,
    true
  );
  assert.equal(terminal.retryable, false);
});

test("mutation-kill: omitting postSubmit (default false) leaves the DEFAULT-pattern timeout retryable", () => {
  const terminal = buildSessionEstablishTerminalError(
    "chase",
    "chase_login_failed_before_otp_submit: surface=open: Timeout 5000ms exceeded"
  );
  assert.equal(terminal.retryable, true);
});

test("postSubmit does not manufacture retryable:true — a non-matching post-submit message stays non-retryable for the ordinary reason too", () => {
  const terminal = buildSessionEstablishTerminalError(
    "reddit",
    "reddit_login_post_submit_failed",
    /ECONN|ETIMEDOUT|fetch failed|reddit_rate_limited/i,
    true
  );
  assert.equal(terminal.retryable, false);
});

// ─── establishSession wiring: onCredentialSubmit → forced non-retryable ─────
//
// The classifier tests above prove buildSessionEstablishTerminalError's
// postSubmit contract in isolation. These two prove the runtime actually
// wires it: the callback establishSession hands to ensureSession must flip
// the flag that reaches the classifier. A mutation that drops the callback
// assignment, or drops the 4th argument at the call site, survives every
// classifier test — only this pair kills it.

function makeEstablishArgs(name: string): Parameters<typeof establishSession>[1] {
  const noopAsync = async (): Promise<void> => {
    // establishSession's ensureSession path only ever awaits checkpoint;
    // assist/completeAssistance/progress/sendInteraction are pass-throughs
    // the throwing stubs below never invoke.
  };
  return {
    assist: (() => Promise.reject(new Error("assist must not be called"))) as never,
    capture: null,
    checkpoint: noopAsync,
    completeAssistance: noopAsync as never,
    context: {} as never,
    name,
    page: makeStubPage(),
    progress: noopAsync as never,
    retryablePattern: /ECONN|ETIMEDOUT|timeout|source_unavailable/i,
    sendInteraction: (() => Promise.reject(new Error("sendInteraction must not be called"))) as never,
  };
}

test("establishSession wiring: an ensureSession that calls onCredentialSubmit then throws a pattern-matching fault yields a NON-retryable terminal error", async () => {
  await assert.rejects(
    establishSession(
      {
        ensureSession: ({ onCredentialSubmit }) => {
          onCredentialSubmit();
          throw new Error("ECONNRESET");
        },
        probeSession: undefined,
      },
      makeEstablishArgs("usaa")
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /usaa_session_failed: ECONNRESET/);
      assert.equal(
        (err as { retryable?: boolean }).retryable,
        false,
        "credential already submitted — a redispatch would resubmit the saved password"
      );
      return true;
    }
  );
});

test("mutation-kill twin: the SAME ensureSession fault WITHOUT calling onCredentialSubmit stays retryable through the full wiring", async () => {
  await assert.rejects(
    establishSession(
      {
        ensureSession: () => {
          throw new Error("ECONNRESET");
        },
        probeSession: undefined,
      },
      makeEstablishArgs("usaa")
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(
        (err as { retryable?: boolean }).retryable,
        true,
        "no credential went out — pre-submit transport faults must keep their ordinary retry classification"
      );
      return true;
    }
  );
});

// ─── code-shaped ensureSession throws survive redaction (HEB [REDACTED] fix) ─
//
// Root cause reproduced from live evidence: connection cin_c875ca3ec8b6ce2c-
// 283a4288 ("HEB - <owner account>"), run_1787075769657. H-E-B requested an
// OTP, the owner didn't answer within the 600s timeout, and
// packages/polyfill-connectors/src/auto-login/heb.ts's
// handleVerificationCodeSubmission threw `Error("heb_verification_code_not_provided")`
// (35 chars). establishSession's catch block previously built the terminal
// message ONLY from that string — `heb_session_failed: heb_verification_code_not_provided`
// — with no `code`. reference-implementation/runtime/connector-gap-bounding.ts's
// boundConnectorErrorMessage then redacted the persisted message via
// stderr-redact.ts's LONG_OPAQUE_RE (`/\b[A-Za-z0-9_-]{24,}\b/g`), which
// wholesale-matches any >=24-char alnum/underscore run — including a
// perfectly innocuous snake_case reason code with no PII in it — collapsing
// the owner-visible message to the literally-unreadable
// `connector_error_json.message: "heb_session_failed: [REDACTED]"` that
// reached run_history with zero other surviving diagnostic content
// (failure_reason and error were both empty on that row).
//
// The fix: session-establish.ts's catch block now also tests the raw thrown
// message against the SAME unredacted-channel charset connector code already
// uses (terminal-error.ts's CONNECTOR_ERROR_CODE_RE, exposed here via
// isConnectorErrorCodeShaped) and, when it qualifies, carries it through as
// TerminalError.code — which reaches `connector_error_code` UNREDACTED
// (runtime/index.ts's buildTerminalConnectorFields already exempts `code`
// from boundConnectorErrorMessage; this only makes ensureSession's throw path
// populate that pre-existing channel instead of leaving it empty).

test("HEB regression: a code-shaped ensureSession throw (heb_verification_code_not_provided) survives as TerminalError.code, not just the free-form message", async () => {
  await assert.rejects(
    establishSession(
      {
        ensureSession: () => {
          throw new Error("heb_verification_code_not_provided");
        },
        probeSession: undefined,
      },
      makeEstablishArgs("heb")
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // The free-form message channel still carries the full, unredacted-at-
      // this-layer text (redaction happens downstream at persistence) —
      // unchanged behavior.
      assert.match(err.message, /heb_session_failed: heb_verification_code_not_provided/);
      // NEW: the bare snake_case reason is ALSO available on `code`, which
      // downstream persistence (connector-gap-bounding.ts's
      // boundConnectorErrorMessage/boundConnectorErrorCode split) never
      // redacts — so an operator reading connector_error_code sees
      // "heb_verification_code_not_provided" even after connector_error_message
      // has been reduced to "[REDACTED]".
      assert.equal((err as { code?: string }).code, "heb_verification_code_not_provided");
      return true;
    }
  );
});

test("mutation-kill: a compound (non-code-shaped) ensureSession throw does NOT get a fabricated code", async () => {
  await assert.rejects(
    establishSession(
      {
        ensureSession: () => {
          // Realistic compound message (has a colon + spaces) — must fail the
          // code charset and leave `code` unset, exactly like before this fix.
          throw new Error("source_unavailable: USAA reported its login system is currently unavailable");
        },
        probeSession: undefined,
      },
      makeEstablishArgs("usaa")
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(
        (err as { code?: string }).code,
        undefined,
        "a free-form compound message must not be smuggled through the unredacted code channel"
      );
      return true;
    }
  );
});

test("the recovered code round-trips through the actual redaction the connector_error_message column applies (proves the fix, not just the plumbing)", async () => {
  const { boundConnectorErrorCode, boundConnectorErrorMessage } = await import(
    "../../../reference-implementation/runtime/connector-gap-bounding.ts"
  );
  await assert.rejects(
    establishSession(
      {
        ensureSession: () => {
          throw new Error("heb_verification_code_not_provided");
        },
        probeSession: undefined,
      },
      makeEstablishArgs("heb")
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typedErr = err as { code?: string; message: string };
      // This reproduces the exact defect: the redacted message alone is
      // useless.
      assert.equal(boundConnectorErrorMessage(typedErr.message), "heb_session_failed: [REDACTED]");
      // But the code channel — now populated by the fix — survives
      // boundConnectorErrorCode's validation untouched and unredacted, giving
      // the operator an actionable reason even though `message` was nuked.
      assert.equal(boundConnectorErrorCode(typedErr.code), "heb_verification_code_not_provided");
      return true;
    }
  );
});

// ─── bounded capture during teardown ────────────────────────────────────────

test("captureBrowserPage returns within its deadline when captureDom hangs (wedged renderer)", async () => {
  // The teardown path captures `runtime-error` on the wedged page. If captureDom
  // (page.content/title/ariaSnapshot) hangs, the bounded capture must still
  // return so teardown — and the terminal DONE / release — is not re-hung.
  let captureDomStarted = false;
  const fakeCapture: Pick<CaptureSession, "captureDom"> = {
    captureDom: () => {
      captureDomStarted = true;
      return new Promise<void>(() => {
        /* never resolves — wedged renderer */
      });
    },
  };
  const hangingCapture = fakeCapture as CaptureSession;

  const start = Date.now();
  await captureBrowserPage(hangingCapture, makeStubPage(), "runtime-error", 20);
  const elapsed = Date.now() - start;
  assert.equal(captureDomStarted, true);
  assert.ok(elapsed < 1000, `captureBrowserPage should return promptly on a hang (took ${String(elapsed)}ms)`);
});

test("captureBrowserPage skips a closed page without invoking captureDom", async () => {
  let called = false;
  const fakeCapture: Pick<CaptureSession, "captureDom"> = {
    captureDom: () => {
      called = true;
      return Promise.resolve();
    },
  };
  const fakeClosedPage: Pick<Page, "isClosed"> = { isClosed: () => true };
  await captureBrowserPage(fakeCapture as CaptureSession, fakeClosedPage as Page, "runtime-error", 20);
  assert.equal(called, false);
});

// ─── env resolution ────────────────────────────────────────────────────────

test("resolveSessionEstablishWatchdogMs honors a positive override", () => {
  assert.equal(resolveSessionEstablishWatchdogMs({ PDPP_SESSION_ESTABLISH_WATCHDOG_MS: "45000" }), 45_000);
});

test("resolveSessionEstablishWatchdogMs falls back to default on missing/invalid", () => {
  assert.equal(resolveSessionEstablishWatchdogMs({}), 120_000);
  assert.equal(resolveSessionEstablishWatchdogMs({ PDPP_SESSION_ESTABLISH_WATCHDOG_MS: "0" }), 120_000);
  assert.equal(resolveSessionEstablishWatchdogMs({ PDPP_SESSION_ESTABLISH_WATCHDOG_MS: "nope" }), 120_000);
});
