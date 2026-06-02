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
  captureBrowserPage,
  type InteractionRequest,
  type InteractionResponse,
  makeSessionEstablishWatchdog,
  resolveSessionEstablishWatchdogMs,
} from "./connector-runtime.ts";
import type { CaptureSession } from "./fixture-capture.ts";

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
    for (let i = 0; i < 5; i++) {
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
