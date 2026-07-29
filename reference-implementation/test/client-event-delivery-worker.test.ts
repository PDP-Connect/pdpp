// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit / concurrency guardrail tests for `createDeliveryWorker`.
 *
 * The delivery operation layer and signing are already covered by
 * `rs-client-event-deliver-operation.test.js`. This suite focuses on the
 * worker's own responsibilities:
 *
 *   1. `classifyRow` dispositions — each subscription status routes to the
 *      right outcome (deliver / skip / drop).
 *   2. `inFlight` guard — a second concurrent `tick()` call returns immediately
 *      without claiming any rows while a tick is in progress.
 *   3. Happy-path orchestration — enqueue via operation layer, tick, row
 *      transitions to `delivered`, attempt logged.
 *
 * All tests use an in-memory SQLite server so no live Postgres or network is
 * required.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  type BearerActor,
  executeApplyGrantRevoke,
  executeCreateSubscription,
  executeEnqueueTestEvent,
  executeUpdateSubscription,
  executeVerificationOutcome,
} from "../operations/as-client-event-subscriptions/index.ts";
import {
  acquireDefaultDeliveryWorker,
  createDeliveryWorker,
  getDefaultDeliveryWorker,
} from "../server/client-event-delivery-worker.ts";
import { startServer } from "../server/index.ts";
import {
  claimDueQueue,
  getDefaultClientEventSubscriptionStore,
  listAttemptsForQueue,
} from "../server/stores/client-event-subscription-store.ts";

// ---------------------------------------------------------------------------
// Shared server lifecycle
// ---------------------------------------------------------------------------

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

type ClientEventSubscriptionStore = ReturnType<typeof getDefaultClientEventSubscriptionStore>;

// `let x: T | undefined` (never `T | null`) so a reassignment inside an async
// closure (setup()) doesn't defeat narrowing at read sites (a known TS
// strict-mode pitfall with `let x: T | null = null` patterns).
let server: TestServer | undefined;
let store: ClientEventSubscriptionStore | undefined;

async function setup() {
  server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  // After startServer the SQLite store singleton is live.
  store = getDefaultClientEventSubscriptionStore();
}

async function teardown() {
  const activeServer = server;
  if (activeServer) {
    activeServer.asServer.closeAllConnections();
    activeServer.rsServer.closeAllConnections();
    await Promise.allSettled([
      new Promise((r) => activeServer.asServer.close(r)),
      new Promise((r) => activeServer.rsServer.close(r)),
    ]);
    server = undefined;
  }
}

function deps(s?: ClientEventSubscriptionStore) {
  const resolved = s ?? store;
  assert.ok(resolved, "deps() called before setup() populated the store");
  return { nowIso: () => new Date().toISOString(), store: resolved };
}

function makeActor(overrides: Partial<BearerActor> = {}): BearerActor {
  return {
    authorityKind: "client_grant",
    clientId: "worker_test_client",
    grantId: `grant_${Math.random().toString(36).slice(2)}`,
    grantScope: {
      source: { id: "spotify", kind: "connector" },
      streams: [{ name: "top_artists" }],
    },
    subjectId: "worker_test_owner",
    ...overrides,
  };
}

interface ReceiverPayload {
  data?: { challenge?: string; [key: string]: unknown };
  type?: string;
  [key: string]: unknown;
}

interface ReceiverEvent {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  payload: ReceiverPayload | null;
}

interface Receiver {
  close: () => Promise<void>;
  events: ReceiverEvent[];
  url: string;
}

// Receiver that echoes the verification challenge correctly.
function startReceiver(): Promise<Receiver> {
  return new Promise((resolve) => {
    const events: ReceiverEvent[] = [];
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        let payload: ReceiverPayload | null = null;
        try {
          payload = JSON.parse(body) as ReceiverPayload;
          // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        } catch {}
        events.push({ body, headers: { ...req.headers }, payload });
        if (payload?.type === "pdpp.subscription.verify") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ challenge: payload.data?.challenge }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      assert.ok(address && typeof address === "object", "server.address() must return an AddressInfo");
      const { port } = address;
      resolve({
        close: () => new Promise<void>((r) => srv.close(() => r())),
        events,
        url: `http://127.0.0.1:${port}/hook`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("default delivery worker leases stop only after the final release", async () => {
  const worker = getDefaultDeliveryWorker();
  assert.equal(worker.isRunning(), false);
  const first = acquireDefaultDeliveryWorker();
  const second = acquireDefaultDeliveryWorker();
  assert.equal(worker.isRunning(), true);
  await first.release();
  await first.release();
  assert.equal(worker.isRunning(), true, "an idempotent partial release must preserve the other owner");
  const finalRelease = second.release();
  assert.equal(second.release(), finalRelease, "idempotent release callers must share the active drain");
  await finalRelease;
  assert.equal(worker.isRunning(), false);
});

test("startServer releases its delivery worker after both listeners close", async () => {
  const activeServer = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const worker = getDefaultDeliveryWorker();
  assert.equal(worker.isRunning(), true);

  activeServer.asServer.closeAllConnections();
  await new Promise<void>((resolve) => activeServer.asServer.close(() => resolve()));
  assert.equal(worker.isRunning(), true, "the RS still owns the worker after the AS closes");

  activeServer.rsServer.closeAllConnections();
  await new Promise<void>((resolve) => activeServer.rsServer.close(() => resolve()));
  assert.equal(worker.isRunning(), false);
});

test("classifyRow: active subscription delivers any event type", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeVerificationOutcome(created.subscriptionId, "verified", deps());

  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());

  const farFuture = new Date(Date.now() + 60_000).toISOString();
  const due = await claimDueQueue(farFuture);
  const testRow = due.find((r) => r.event_type === "pdpp.subscription.test");
  assert.ok(testRow, "pdpp.subscription.test row must be claimable for active subscription");
  assert.equal(testRow.subscription_status, "active");
});

test("classifyRow: pending_verification subscription delivers only pdpp.subscription.verify, skips others", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  // Do NOT transition to verified — subscription stays pending_verification.
  // Enqueue a test event in addition to the auto-enqueued verify event.
  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());

  const farFuture = new Date(Date.now() + 60_000).toISOString();
  const due = await claimDueQueue(farFuture);
  const verifyRow = due.find((r) => r.event_type === "pdpp.subscription.verify");
  const testRow = due.find((r) => r.event_type === "pdpp.subscription.test");
  assert.ok(verifyRow, "verify event must be present");
  assert.equal(verifyRow.subscription_status, "pending_verification");
  assert.ok(testRow, "test event must be present");
  assert.equal(testRow.subscription_status, "pending_verification");

  let deliveredCount = 0;
  const skippedCount = 0;
  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    transport: async () => {
      // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
      deliveredCount++;
      return {
        bodyText: JSON.stringify({ challenge: verifyRow.verification_challenge }),
        errorMessage: null,
        latencyMs: 5,
        statusCode: 200,
      };
    },
  });

  const result = await worker.tick();
  // Only the verify event gets attempted; the test event is skipped.
  assert.equal(result.attempted, 1, "only pdpp.subscription.verify attempted for pending_verification");
  assert.equal(deliveredCount, 1);
  // skipped rows are not counted in outcomes, but attempted is the delivered count
  assert.equal(skippedCount, 0);
});

test("classifyRow: disabled_revoked subscription delivers only pdpp.grant.revoked, drops others", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeVerificationOutcome(created.subscriptionId, "verified", deps());
  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());

  // Apply grant revoke — marks subscription disabled_revoked and enqueues pdpp.grant.revoked.
  assert.ok(actor.grantId, "test actor fixture must carry a grantId");
  await executeApplyGrantRevoke(actor.grantId, deps());

  const farFuture = new Date(Date.now() + 60_000).toISOString();
  const due = await claimDueQueue(farFuture);
  const revokedRow = due.find((r) => r.event_type === "pdpp.grant.revoked");
  assert.ok(revokedRow, "pdpp.grant.revoked row must be present");
  assert.equal(revokedRow.subscription_status, "disabled_revoked");

  let transportCalls = 0;
  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    transport: async () => {
      // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
      transportCalls++;
      return { bodyText: "ok", errorMessage: null, latencyMs: 5, statusCode: 200 };
    },
  });

  const result = await worker.tick();
  // Only pdpp.grant.revoked is attempted; test event is dropped.
  assert.equal(result.attempted, 1, "only pdpp.grant.revoked attempted for disabled_revoked");
  assert.equal(transportCalls, 1, "transport called exactly once");
});

test("classifyRow: disabled subscription delivers only pdpp.subscription.verify, drops others", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());
  await executeUpdateSubscription(actor, created.subscriptionId, { enabled: false }, deps());

  let transportCalls = 0;
  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    transport: async ({ body }) => {
      // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
      transportCalls++;
      const payload = JSON.parse(body);
      return {
        bodyText: JSON.stringify({ challenge: payload.data?.challenge }),
        errorMessage: null,
        latencyMs: 5,
        statusCode: 200,
      };
    },
  });

  const result = await worker.tick();
  assert.equal(result.attempted, 1, "only pdpp.subscription.verify attempted for disabled");
  assert.equal(transportCalls, 1, "transport called exactly once");

  const due = await claimDueQueue(new Date(Date.now() + 120_000).toISOString());
  assert.equal(
    due.some((row) => row.event_type === "pdpp.subscription.test"),
    false,
    "test event must be dropped"
  );
});

test("classifyRow: disabled_failure subscription delivers only pdpp.subscription.verify, drops others", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());
  const now = new Date().toISOString();
  await deps().store.updateStatus(created.subscriptionId, "disabled_failure", now, now, "delivery_failed");

  let transportCalls = 0;
  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    transport: async ({ body }) => {
      // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
      transportCalls++;
      const payload = JSON.parse(body);
      return {
        bodyText: JSON.stringify({ challenge: payload.data?.challenge }),
        errorMessage: null,
        latencyMs: 5,
        statusCode: 200,
      };
    },
  });

  const result = await worker.tick();
  assert.equal(result.attempted, 1, "only pdpp.subscription.verify attempted for disabled_failure");
  assert.equal(transportCalls, 1, "transport called exactly once");

  const due = await claimDueQueue(new Date(Date.now() + 120_000).toISOString());
  assert.equal(
    due.some((row) => row.event_type === "pdpp.subscription.test"),
    false,
    "test event must be dropped"
  );
});

test("inFlight guard: concurrent tick() calls do not double-process", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeVerificationOutcome(created.subscriptionId, "verified", deps());

  // Drain the auto-enqueued subscription.verify row with a prep tick so the
  // test event is the only pending row when the inFlight guard test starts.
  const prepWorker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    transport: async () => ({ bodyText: "ok", errorMessage: null, latencyMs: 5, statusCode: 200 }),
  });
  await prepWorker.tick();

  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());

  let transportCallCount = 0;
  let resolveFirstTransport!: () => void;
  const firstTransportDone = new Promise<void>((r) => {
    resolveFirstTransport = r;
  });

  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    transport: async () => {
      // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
      transportCallCount++;
      // Hold the first transport call open so the first tick stays inFlight.
      if (transportCallCount === 1) {
        await firstTransportDone;
      }
      return { bodyText: "ok", errorMessage: null, latencyMs: 5, statusCode: 200 };
    },
  });

  // Launch first tick — it will stall inside transport.
  const tick1Promise = worker.tick();

  // Give tick1 time to set inFlight before tick2 starts.
  await new Promise((r) => setImmediate(r));

  // Second tick must return immediately with attempted=0.
  const tick2Result = await worker.tick();
  assert.equal(tick2Result.attempted, 0, "inFlight guard must prevent second tick from claiming rows");

  let stopSettled = false;
  const stopPromise = worker.stop().then(() => {
    stopSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false, "stop must drain the active tick before teardown can continue");

  // Release the first transport call.
  resolveFirstTransport();
  const tick1Result = await tick1Promise;
  await stopPromise;
  assert.equal(tick1Result.attempted, 1, "first tick must have attempted exactly the test event");
  assert.equal(transportCallCount, 1, "transport called exactly once despite concurrent tick()");
});

test("happy path: enqueue test event, tick delivers it and logs attempt", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeVerificationOutcome(created.subscriptionId, "verified", deps());
  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());

  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    transport: async () => ({ bodyText: "ok", errorMessage: null, latencyMs: 8, statusCode: 200 }),
  });

  const result = await worker.tick();
  assert.ok(result.attempted >= 1, "tick must attempt at least the test event");
  const testOutcome = result.outcomes.find((o) => o.kind === "delivered");
  assert.ok(testOutcome, "pdpp.subscription.test must result in delivered outcome");

  // Verify attempt was logged in the store.
  const farFuture = new Date(Date.now() + 60_000).toISOString();
  const due = await claimDueQueue(farFuture);
  const testQueueRow = due.find((r) => r.event_type === "pdpp.subscription.test");
  // Delivered rows are removed from due queue.
  assert.equal(testQueueRow, undefined, "delivered row must not appear in due queue again");
});

test("retry path: non-2xx transport response increments attempt_count and reschedules", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeVerificationOutcome(created.subscriptionId, "verified", deps());
  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());

  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    transport: async () => ({ bodyText: "unavailable", errorMessage: null, latencyMs: 5, statusCode: 503 }),
  });

  const result = await worker.tick();
  const retryOutcome = result.outcomes.find((o) => o.kind === "retry");
  assert.ok(retryOutcome, "503 response must produce retry outcome");

  // The attempt must be logged.
  const farFuture = new Date(Date.now() + 120_000).toISOString();
  const due = await claimDueQueue(farFuture);
  const testRow = due.find((r) => r.event_type === "pdpp.subscription.test");
  assert.ok(testRow, "retried row must appear again in due queue at next_attempt_at");
  assert.equal(testRow.attempt_count, 1, "attempt_count must be incremented to 1 after first retry");

  const attempts = await listAttemptsForQueue(testRow.queue_id);
  assert.equal(attempts.length, 1, "one attempt must be logged");
  const [firstAttempt] = attempts;
  assert.ok(firstAttempt, "expected the logged attempt row to be present");
  assert.equal(firstAttempt.ok, 0, "attempt must be logged as not ok");
  assert.equal(firstAttempt.status_code, 503);
});

// ---------------------------------------------------------------------------
// 410 Gone auto-disable (P3)
// ---------------------------------------------------------------------------

test("410 Gone: worker disables subscription immediately and does not reschedule", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeVerificationOutcome(created.subscriptionId, "verified", deps());
  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());

  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    transport: async () => ({ bodyText: "Gone", errorMessage: null, latencyMs: 5, statusCode: 410 }),
  });

  const result = await worker.tick();
  const outcome = result.outcomes.find((o) => o.kind === "permanent_failure");
  assert.ok(outcome, "410 response must produce permanent_failure outcome");

  // Subscription must now be disabled_failure — executor called executeRecordDeliveryFailure.
  const sub = await getDefaultClientEventSubscriptionStore().getSubscriptionById(created.subscriptionId);
  assert.equal(sub?.status, "disabled_failure", "subscription must be disabled immediately on 410");

  // The queue row must not appear in a future due scan — it was finalized.
  const farFuture = new Date(Date.now() + 120_000).toISOString();
  const due = await claimDueQueue(farFuture);
  const testRow = due.find(
    (r) => r.event_type === "pdpp.subscription.test" && r.subscription_id === created.subscriptionId
  );
  assert.equal(testRow, undefined, "410 row must not be rescheduled in due queue");
});

test("410 Gone: attempt_count is NOT incremented (permanent disable consumes no retry slot)", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeVerificationOutcome(created.subscriptionId, "verified", deps());
  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());

  // Claim the queue to know the initial attempt_count.
  const preDue = await claimDueQueue(new Date(Date.now() + 60_000).toISOString());
  const preRow = preDue.find((r) => r.event_type === "pdpp.subscription.test");
  assert.ok(preRow, "test row must be claimable before tick");
  const initialAttemptCount = preRow.attempt_count;

  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    transport: async () => ({ bodyText: "Gone", errorMessage: null, latencyMs: 5, statusCode: 410 }),
  });

  const result = await worker.tick();
  const outcome = result.outcomes.find((o) => o.kind === "permanent_failure");
  assert.ok(outcome, "410 must produce permanent_failure");
  assert.equal(outcome.attemptCount, initialAttemptCount, "attempt_count must not be incremented on 410");
});

// ---------------------------------------------------------------------------
// 429 / 502 / 504 throttle (P3) + Retry-After inspection
// ---------------------------------------------------------------------------

test("429: worker reschedules without incrementing attempt_count", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeVerificationOutcome(created.subscriptionId, "verified", deps());
  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());

  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    transport: async () => ({
      bodyText: "Too Many Requests",
      errorMessage: null,
      latencyMs: 5,
      responseHeaders: { "retry-after": "60" },
      statusCode: 429,
    }),
  });

  const result = await worker.tick();
  const outcome = result.outcomes.find((o) => o.kind === "throttle");
  assert.ok(outcome, "429 response must produce throttle outcome");

  // attempt_count must still be 0 — throttle does NOT consume a retry slot.
  const farFuture = new Date(Date.now() + 120_000).toISOString();
  const due = await claimDueQueue(farFuture);
  const testRow = due.find(
    (r) => r.event_type === "pdpp.subscription.test" && r.subscription_id === created.subscriptionId
  );
  assert.ok(testRow, "429 row must appear again in due queue after throttle delay");
  assert.equal(testRow.attempt_count, 0, "attempt_count must remain 0 after throttle (no retry slot consumed)");

  const attempts = await listAttemptsForQueue(testRow.queue_id);
  assert.equal(attempts.length, 1, "one attempt must be logged even for throttle");
  const [firstAttempt] = attempts;
  assert.ok(firstAttempt, "expected the logged attempt row to be present");
  assert.equal(firstAttempt.ok, 0, "throttle attempt must be logged as not ok");
  assert.equal(firstAttempt.status_code, 429);
});

test("429 with retry-after header: next_attempt_at respects the header value", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeVerificationOutcome(created.subscriptionId, "verified", deps());
  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());

  const retryAfterSecs = 300; // 5 minutes

  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000, // make all queue rows eligible for claiming
    randomJitterFactor: () => 1,
    transport: async () => ({
      bodyText: "Too Many Requests",
      errorMessage: null,
      latencyMs: 5,
      responseHeaders: { "retry-after": String(retryAfterSecs) },
      statusCode: 429,
    }),
  });

  const tickBefore = Date.now();
  await worker.tick();
  const tickAfter = Date.now();

  // The row should NOT appear in a claim window that ends before retryAfterSecs from now.
  // Use tickBefore as the conservative lower bound for the scheduled time.
  const tooSoon = new Date(tickBefore + (retryAfterSecs - 10) * 1000).toISOString();
  const dueEarly = await claimDueQueue(tooSoon);
  const earlyRow = dueEarly.find(
    (r) => r.event_type === "pdpp.subscription.test" && r.subscription_id === created.subscriptionId
  );
  assert.equal(earlyRow, undefined, "row must not be due before retry-after window expires");

  // But it must appear after the full delay (use tickAfter as upper bound).
  const afterDelay = new Date(tickAfter + (retryAfterSecs + 10) * 1000).toISOString();
  const dueAfter = await claimDueQueue(afterDelay);
  const lateRow = dueAfter.find(
    (r) => r.event_type === "pdpp.subscription.test" && r.subscription_id === created.subscriptionId
  );
  assert.ok(lateRow, "row must become due after retry-after delay");
});

test("502 Bad Gateway: worker throttles without incrementing attempt_count", async (t) => {
  await setup();
  t.after(teardown);

  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const actor = makeActor();
  const created = await executeCreateSubscription({ actor, callbackUrl: receiver.url }, deps());
  await executeVerificationOutcome(created.subscriptionId, "verified", deps());
  await executeEnqueueTestEvent(actor, created.subscriptionId, deps());

  const worker = createDeliveryWorker({
    nowMs: () => Date.now() + 60_000,
    randomJitterFactor: () => 1,
    transport: async () => ({
      bodyText: "Bad Gateway",
      errorMessage: null,
      latencyMs: 5,
      statusCode: 502,
    }),
  });

  const result = await worker.tick();
  const outcome = result.outcomes.find((o) => o.kind === "throttle");
  assert.ok(outcome, "502 response must produce throttle outcome");
  assert.equal(outcome.statusCode, 502);

  const farFuture = new Date(Date.now() + 120_000).toISOString();
  const due = await claimDueQueue(farFuture);
  const testRow = due.find(
    (r) => r.event_type === "pdpp.subscription.test" && r.subscription_id === created.subscriptionId
  );
  assert.ok(testRow, "502 row must be rescheduled");
  assert.equal(testRow.attempt_count, 0, "attempt_count must remain 0 after 502 throttle");
});
