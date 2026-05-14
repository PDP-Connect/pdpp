import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AdaptiveLaneCancelledError,
  type AdaptiveLaneEvent,
  AdaptiveLaneQueueFullError,
  createAdaptiveLane,
} from "./adaptive-lane.ts";

function deferred<T = void>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("adaptive lane never exceeds effective max concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
  const lane = createAdaptiveLane<string>({
    name: "test.bulk",
    initialConcurrency: 2,
    maxConcurrency: 2,
    maxDelayMs: 0,
    maxQueueSize: 10,
    minConcurrency: 1,
    minDelayMs: 0,
    classifyOutcome: () => ({ kind: "ok" }),
  });

  const runs = gates.map((gate) =>
    lane.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const result = await gate.promise;
      active -= 1;
      return result;
    })
  );
  await flush();

  assert.equal(active, 2);
  assert.equal(maxActive, 2);
  gates[0]?.resolve("a");
  await flush();
  await flush();
  assert.equal(active, 2, "third task may start only after one active task completes");
  gates[1]?.resolve("b");
  gates[2]?.resolve("c");
  assert.deepEqual(await Promise.all(runs), ["a", "b", "c"]);
});

test("adaptive lane rejects explicitly when queue bound is full", async () => {
  const gate = deferred<string>();
  const events: AdaptiveLaneEvent[] = [];
  const lane = createAdaptiveLane<string>({
    name: "test.bound",
    initialConcurrency: 1,
    maxConcurrency: 1,
    maxDelayMs: 10,
    maxQueueSize: 2,
    minConcurrency: 1,
    minDelayMs: 0,
    classifyOutcome: () => ({ kind: "ok" }),
    emitTelemetry: (event) => {
      events.push(event);
    },
  });

  const first = lane.run(() => gate.promise);
  const second = lane.run(() => Promise.resolve("queued"));
  await assert.rejects(
    lane.run(() => Promise.resolve("rejected")),
    AdaptiveLaneQueueFullError
  );

  gate.resolve("active");
  assert.deepEqual(await Promise.all([first, second]), ["active", "queued"]);
  assert.equal(
    events.some((event) => event.type === "queue_rejected"),
    true
  );
});

test("adaptive lane respects bounded Retry-After cooldown with fake sleep", async () => {
  const sleeps: number[] = [];
  const events: AdaptiveLaneEvent[] = [];
  let calls = 0;
  const lane = createAdaptiveLane<{ status: number }>({
    name: "test.retry-after",
    initialConcurrency: 1,
    maxAttempts: 2,
    maxConcurrency: 1,
    maxDelayMs: 5000,
    maxQueueSize: 10,
    minConcurrency: 1,
    minDelayMs: 100,
    classifyOutcome: ({ result }) =>
      result?.status === 429 ? { kind: "rate_limited", retryAfterMs: 20_000 } : { kind: "ok" },
    emitTelemetry: (event) => {
      events.push(event);
    },
    sleep: (ms) => {
      sleeps.push(ms);
    },
  });

  const result = await lane.run(() => {
    calls += 1;
    return { status: calls === 1 ? 429 : 200 };
  });

  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [5000], "Retry-After is capped by maxDelayMs");
  assert.equal(
    events.some((event) => event.type === "cooldown" && event.retryAfterMs === 20_000),
    true
  );
});

test("adaptive lane reportPressure delays next queued task even when current task succeeds", async () => {
  const sleeps: number[] = [];
  const events: AdaptiveLaneEvent[] = [];
  const started: string[] = [];
  const firstGate = deferred<string>();
  const lane = createAdaptiveLane<string>({
    name: "test.intermediate-pressure",
    initialConcurrency: 1,
    maxAttempts: 1,
    maxConcurrency: 1,
    maxDelayMs: 5000,
    maxQueueSize: 10,
    minConcurrency: 1,
    minDelayMs: 100,
    classifyOutcome: () => ({ kind: "ok" }),
    emitTelemetry: (event) => {
      events.push(event);
    },
    random: () => 0,
    sleep: (ms) => {
      sleeps.push(ms);
    },
  });

  const first = lane.run(async (context) => {
    started.push("first");
    await context.reportPressure({ kind: "rate_limited", retryAfterMs: 20_000 });
    await firstGate.promise;
    return "first-ok";
  });
  const second = lane.run(() => {
    started.push("second");
    return "second-ok";
  });
  await flush();
  assert.deepEqual(started, ["first"]);

  firstGate.resolve("release");
  assert.deepEqual(await Promise.all([first, second]), ["first-ok", "second-ok"]);
  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual(sleeps, [5000], "reported pressure sets a capped cooldown before the next launch");
  assert.equal(lane.snapshot().concurrency, 1, "reported pressure must not raise max-limited concurrency");
  assert.equal(
    events.some(
      (event) => event.type === "cooldown" && event.outcome === "rate_limited" && event.retryAfterMs === 20_000
    ),
    true
  );
});

test("adaptive lane rate limits reduce cap and clean successes increase only within max", async () => {
  const events: AdaptiveLaneEvent[] = [];
  const lane = createAdaptiveLane<{ status: number }>({
    name: "test.adapt",
    initialConcurrency: 2,
    maxAttempts: 1,
    maxConcurrency: 3,
    maxDelayMs: 10,
    maxQueueSize: 10,
    minConcurrency: 1,
    minDelayMs: 0,
    successWindow: 2,
    classifyOutcome: ({ result }) => (result?.status === 429 ? { kind: "rate_limited" } : { kind: "ok" }),
    emitTelemetry: (event) => {
      events.push(event);
    },
    random: () => 0,
    sleep: () => undefined,
  });

  await lane.run(() => ({ status: 429 }));
  assert.equal(lane.snapshot().concurrency, 1);
  await lane.run(() => ({ status: 200 }));
  assert.equal(lane.snapshot().concurrency, 1, "one clean success is not enough to increase");
  await lane.run(() => ({ status: 200 }));
  assert.equal(lane.snapshot().concurrency, 2);
  await lane.run(() => ({ status: 200 }));
  await lane.run(() => ({ status: 200 }));
  await lane.run(() => ({ status: 200 }));
  assert.equal(lane.snapshot().concurrency, 3, "concurrency stays within max");
  assert.equal(
    events.some((event) => event.type === "concurrency_decreased"),
    true
  );
  assert.equal(events.filter((event) => event.type === "concurrency_increased").length, 2);
});

test("adaptive lane simulator handles hidden and changing quota pressure deterministically", async () => {
  const events: AdaptiveLaneEvent[] = [];
  const sleeps: number[] = [];
  const attemptsByItem = new Map<number, number>();
  let active = 0;
  let maxActive = 0;
  const lane = createAdaptiveLane<{ item: number; status: number }>({
    name: "test.simulated-hidden-quota",
    initialConcurrency: 3,
    maxAttempts: 2,
    maxConcurrency: 3,
    maxDelayMs: 1000,
    maxQueueSize: 10,
    minConcurrency: 1,
    minDelayMs: 1000,
    successWindow: 2,
    classifyOutcome: ({ result }) =>
      result?.status === 429 ? { kind: "rate_limited", retryAfterMs: 1000 } : { kind: "ok" },
    emitTelemetry: (event) => {
      events.push(event);
    },
    sleep: (ms) => {
      sleeps.push(ms);
    },
  });

  const results = await lane.runAll([1, 2, 3, 4], async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const attempt = (attemptsByItem.get(item) ?? 0) + 1;
    attemptsByItem.set(item, attempt);
    await Promise.resolve();
    active -= 1;
    return { item, status: item === 3 && attempt === 1 ? 429 : 200 };
  });

  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200, 200, 200]
  );
  assert.ok(maxActive <= 3, "simulated hidden quota never exceeds lane max concurrency");
  assert.equal(attemptsByItem.get(3), 2, "pathological first attempt is retried once");
  assert.ok(sleeps.includes(1000), "Retry-After controls a deterministic cooldown");
  assert.equal(
    events.some((event) => event.type === "concurrency_decreased" && event.reason === "rate_limited"),
    true
  );
  assert.equal(
    events.some((event) => event.type === "concurrency_increased"),
    true,
    "lane recovers after the simulated quota changes back to clean successes"
  );
});

test("adaptive lane cancellation rejects queued and sleeping retry work", async () => {
  const sleepGate = deferred();
  let attempts = 0;
  const lane = createAdaptiveLane<{ status: number }>({
    name: "test.cancel",
    initialConcurrency: 1,
    maxAttempts: 3,
    maxConcurrency: 1,
    maxDelayMs: 1000,
    maxQueueSize: 10,
    minConcurrency: 1,
    minDelayMs: 1000,
    classifyOutcome: ({ result }) => (result?.status === 503 ? { kind: "retryable" } : { kind: "ok" }),
    random: () => 0,
    sleep: () => sleepGate.promise,
  });

  const first = lane.run(() => {
    attempts += 1;
    return { status: 503 };
  });
  const second = lane.run(() => Promise.resolve({ status: 200 }));
  await flush();
  lane.cancel("owner stop");

  await assert.rejects(first, AdaptiveLaneCancelledError);
  await assert.rejects(second, AdaptiveLaneCancelledError);
  assert.equal(attempts, 1, "scheduled retry does not launch after cancellation");
});

test("adaptive lane runAll cancels queued work after first rejection", async () => {
  let attempts = 0;
  const lane = createAdaptiveLane<string>({
    name: "test.run-all-fail-fast",
    initialConcurrency: 1,
    maxConcurrency: 1,
    maxDelayMs: 0,
    maxQueueSize: 10,
    minConcurrency: 1,
    minDelayMs: 0,
    classifyOutcome: ({ error }) => (error ? { kind: "terminal" } : { kind: "ok" }),
  });

  await assert.rejects(
    lane.runAll(["fail", "must-not-run"], (item) => {
      attempts += 1;
      if (item === "fail") {
        throw new Error("first item failed");
      }
      return item;
    }),
    /first item failed/
  );

  assert.equal(attempts, 1, "queued work must not start after required work fails");
});

test("adaptive lane telemetry summarizes errors without carrying raw error objects", async () => {
  const events: AdaptiveLaneEvent[] = [];
  const lane = createAdaptiveLane<string>({
    name: "test.redaction",
    initialConcurrency: 1,
    maxAttempts: 1,
    maxConcurrency: 1,
    maxDelayMs: 0,
    maxQueueSize: 10,
    minConcurrency: 1,
    minDelayMs: 0,
    classifyOutcome: ({ error }) => (error ? { kind: "terminal" } : { kind: "ok" }),
    emitTelemetry: (event) => {
      events.push(event);
    },
  });

  await assert.rejects(lane.run(() => Promise.reject(new Error("secret-url=https://example.test/token"))));

  const terminalEvent = events.find((event) => event.type === "completed" && event.errorName === "Error");
  assert.ok(terminalEvent, "expected a safe error-name-only terminal event");
  assert.equal(Object.hasOwn(terminalEvent, "error"), false, "raw errors must not be exposed in lane telemetry");
  assert.equal(JSON.stringify(terminalEvent).includes("secret-url"), false);
});

test("adaptive lane supports QoS separation between saturated bulk and login lanes", async () => {
  const bulkGate = deferred<string>();
  const bulk = createAdaptiveLane<string>({
    name: "test.bulk",
    initialConcurrency: 1,
    maxConcurrency: 1,
    maxDelayMs: 10,
    maxQueueSize: 10,
    minConcurrency: 1,
    minDelayMs: 0,
    classifyOutcome: () => ({ kind: "ok" }),
  });
  const login = createAdaptiveLane<string>({
    name: "test.login",
    initialConcurrency: 1,
    maxConcurrency: 1,
    maxDelayMs: 10,
    maxQueueSize: 10,
    minConcurrency: 1,
    minDelayMs: 0,
    classifyOutcome: () => ({ kind: "ok" }),
  });

  const bulkRun = bulk.run(() => bulkGate.promise);
  const loginRun = login.run(() => Promise.resolve("login-ok"));
  assert.equal(await loginRun, "login-ok");
  bulkGate.resolve("bulk-ok");
  assert.equal(await bulkRun, "bulk-ok");
});

test("adaptive lane fake timing does not require wall-clock sleeps", async () => {
  const sleeps: number[] = [];
  const startedAt = Date.now();
  const lane = createAdaptiveLane<{ status: number }>({
    name: "test.fake-time",
    initialConcurrency: 1,
    maxAttempts: 2,
    maxConcurrency: 1,
    maxDelayMs: 60_000,
    maxQueueSize: 10,
    minConcurrency: 1,
    minDelayMs: 60_000,
    classifyOutcome: ({ result }) => (result?.status === 503 ? { kind: "retryable" } : { kind: "ok" }),
    sleep: (ms) => {
      sleeps.push(ms);
    },
  });
  let calls = 0;

  await lane.run(() => {
    calls += 1;
    return { status: calls === 1 ? 503 : 200 };
  });

  assert.deepEqual(sleeps, [60_000]);
  assert.ok(Date.now() - startedAt < 1000, "test should not wait for the configured fake delay");
});
