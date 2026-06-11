import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCollectionRateProgress,
  buildPacingStateFields,
  ConnectorRateLimitedError,
  createConnectorHttpGovernor,
  DEFAULT_PACING_INITIAL_INTERVAL_MS,
  DEFAULT_PACING_MIN_INTERVAL_MS,
  readPersistedPacingInterval,
} from "./connector-http-governor.ts";
import { RetryExhaustedError } from "./http-retry.ts";
import { RetryBudget } from "./provider-budget.ts";
import { PreflightWaitProbe } from "./send-governor.ts";

interface RawResponse {
  body?: unknown;
  headers?: Record<string, string | undefined>;
  status: number;
}

function classify(raw: RawResponse): { status: number; headers?: Record<string, string | undefined>; value: unknown } {
  return raw.headers
    ? { status: raw.status, headers: raw.headers, value: raw.body }
    : { status: raw.status, value: raw.body };
}

test("connector governor: recovers a 429-then-200 and returns the parsed value", async () => {
  const slept: number[] = [];
  const statuses = [429, 200];
  const g = createConnectorHttpGovernor({
    name: "oura",
    maxAttempts: 4,
    baseDelayMs: 1000,
    maxDelayMs: 10_000,
    // Isolate the Retry-After double-pay guard: pacing off so the only waits on
    // `slept` are the retry/backoff waits this test asserts about. (Default-on
    // adaptive pacing is covered by the dedicated pacing tests below.)
    pacingInitialIntervalMs: 0,
    sleep: (ms) => {
      slept.push(ms);
    },
    now: () => 0,
    random: () => 0.5,
  });
  const result = await g.request(
    () => ({ status: statuses.shift() ?? 200, headers: { "retry-after": "7" }, body: { ok: true } }),
    classify
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, { ok: true });
  // Retry-After honored exactly (7000), no extra backoff stacked on top.
  assert.deepEqual(slept, [7000]);
});

test("connector governor: Retry-After double-pay guard — the server interval is slept once, not stacked on backoff", async () => {
  const slept: number[] = [];
  const statuses = [429, 200];
  const g = createConnectorHttpGovernor({
    name: "strava",
    maxAttempts: 4,
    baseDelayMs: 2000,
    maxDelayMs: 60_000,
    // Pacing off to isolate the retry-after guard (see note above).
    pacingInitialIntervalMs: 0,
    sleep: (ms) => {
      slept.push(ms);
    },
    now: () => 0,
    random: () => 1, // would make jittered backoff large if it were (wrongly) added
  });
  await g.request(() => ({ status: statuses.shift() ?? 200, headers: { "retry-after": "3" }, body: null }), classify);
  // Exactly one wait of 3000 (the Retry-After), NOT 3000 + jittered backoff.
  assert.deepEqual(slept, [3000], "no double-pay: backoff is not added on top of Retry-After");
});

test("connector governor: terminal 429 exhaustion throws <name>_rate_limited (cross-run contract preserved)", async () => {
  const g = createConnectorHttpGovernor({
    name: "github",
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 2,
    sleep: () => {
      /* no-op */
    },
    now: () => 0,
    random: () => 0.5,
  });
  await assert.rejects(
    g.request(() => ({ status: 429, body: null }), classify),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorRateLimitedError);
      assert.equal((err as Error).message, "github_rate_limited", "matches the existing retryablePattern token");
      return true;
    }
  );
});

test("connector governor: ratio-based retry budget caps retry volume across requests", async () => {
  // capacity 1, refill 0 → only ONE retry is ever permitted across the run.
  const retryBudget = new RetryBudget({ capacity: 1, refillPerSuccess: 0 });
  const g = createConnectorHttpGovernor({
    name: "ynab",
    maxAttempts: 10,
    baseDelayMs: 1,
    maxDelayMs: 2,
    retryBudget,
    sleep: () => {
      /* no-op */
    },
    now: () => 0,
    random: () => 0.5,
  });

  let calls = 0;
  // First request: always 429 → consumes the single retry token on its 1 retry,
  // then exhausts the budget and stops (throws rate_limited) BEFORE maxAttempts.
  await assert.rejects(
    g.request(() => {
      calls += 1;
      return { status: 429, body: null };
    }, classify),
    ConnectorRateLimitedError
  );
  assert.equal(calls, 2, "1 initial + 1 budgeted retry, then the retry budget stops the run (not 10 attempts)");
});

test("connector governor: non-429 retryable exhaustion rethrows RetryExhaustedError (not rate_limited)", async () => {
  const g = createConnectorHttpGovernor({
    name: "notion",
    maxAttempts: 2,
    baseDelayMs: 1,
    maxDelayMs: 2,
    sleep: () => {
      /* no-op */
    },
    now: () => 0,
    random: () => 0.5,
  });
  await assert.rejects(
    g.request(() => ({ status: 503, body: null }), classify),
    (err: unknown) => {
      assert.ok(err instanceof RetryExhaustedError, "a 5xx exhaustion is not a rate-limit terminal");
      assert.ok(!(err instanceof ConnectorRateLimitedError));
      return true;
    }
  );
});

test("connector governor: per-provider isolation — two governors throttle independently", async () => {
  const now = () => 0;
  const a = createConnectorHttpGovernor({
    name: "spotify",
    pacingInitialIntervalMs: 1000,
    maxAttempts: 1,
    sleep: () => {
      /* no-op */
    },
    now,
  });
  const b = createConnectorHttpGovernor({
    name: "oura",
    pacingInitialIntervalMs: 1000,
    maxAttempts: 1,
    sleep: () => {
      /* no-op */
    },
    now,
  });
  // Throttle A hard, leave B untouched. They are separate instances with
  // separate pacing buckets; A's throttle does not move B's interval.
  await a.request(() => ({ status: 200, body: 1 }), classify);
  // B's pacing state is unaffected by A: a fresh request on B succeeds with no
  // borrowed backoff. (Behavioral proof of isolation: no shared mutable state.)
  const rb = await b.request(() => ({ status: 200, body: 2 }), classify);
  assert.equal(rb.value, 2);
  assert.notEqual(a.governor, b.governor, "distinct governor instances per provider");
});

test("connector governor: pacing is the single pre-flight gate (one wait source per attempt)", async () => {
  const probe = new PreflightWaitProbe();
  const g = createConnectorHttpGovernor({
    name: "oura",
    pacingInitialIntervalMs: 800,
    maxAttempts: 1,
    now: () => 0,
    sleep: probe.wrap(() => {
      /* no-op */
    }),
  });
  await g.request(() => ({ status: 200, body: null }), classify);
  assert.equal(probe.count, 1, "exactly one pre-flight wait — the single pacing governor");
});

test("connector governor: terminal abort status surfaces without rate_limited mislabel", async () => {
  const g = createConnectorHttpGovernor({
    name: "github",
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 2,
    sleep: () => {
      /* no-op */
    },
    now: () => 0,
  });
  // A 200 with no retry is the simple success path; a non-retryable 404 returns
  // as-is so the caller can branch (it is not a rate-limit terminal).
  const r = await g.request(() => ({ status: 404, body: "missing" }), classify);
  assert.equal(r.status, 404);
  assert.equal(r.value, "missing");
});

// ─── Adaptive collection is the DEFAULT (Phase A shared-primitive parity) ─────
//
// The six API connectors (github/notion/oura/spotify/strava/ynab) each construct
// their governor with the bare `createConnectorHttpGovernor({ name, ... })` call.
// These tests prove that bare call now yields the full adaptive behavior the
// ChatGPT detail path proved live (slow-start discovery → AIMD accelerate-under-
// success → ceiling-bounded back-off) WITH NO per-connector pacing config — the
// generalization deliverable.

test("adaptive default: a bare governor cold-starts at the shared discovery seed and exposes a snapshot", () => {
  // The exact call the six connectors ship — no pacing args.
  const g = createConnectorHttpGovernor({ name: "oura", maxAttempts: 1 });
  const snap = g.snapshot();
  assert.ok(snap, "a bare governor has live rate state by default (pacing is on)");
  assert.equal(
    snap.intervalMs,
    DEFAULT_PACING_INITIAL_INTERVAL_MS,
    "cold start enters the AIMD ramp from the conservative shared discovery seed"
  );
  assert.equal(
    snap.minIntervalMs,
    DEFAULT_PACING_MIN_INTERVAL_MS,
    "the one owner number — the rate ceiling — is the shared default"
  );
  assert.equal(snap.lastBackoff, null, "no back-off has fired on a fresh governor");
});

test("adaptive default: sustained success ACCELERATES the bare governor toward the ceiling (the proven adaptive behavior)", async () => {
  const slept: number[] = [];
  // Bare call — the shape the six connectors ship. No pacing config.
  const g = createConnectorHttpGovernor({
    name: "github",
    maxAttempts: 1,
    now: () => 0,
    sleep: (ms) => {
      slept.push(ms);
    },
  });
  const before = g.snapshot()?.intervalMs ?? 0;
  // Several consecutive successes: each recordSuccess() additive-decreases the
  // interval (raises throughput) — accelerate-under-success.
  for (let i = 0; i < 5; i++) {
    await g.request(() => ({ status: 200, body: null }), classify);
  }
  const after = g.snapshot()?.intervalMs ?? 0;
  assert.ok(after < before, `interval shrank under success: ${after}ms < ${before}ms (the rate accelerated)`);
  assert.ok(after >= DEFAULT_PACING_MIN_INTERVAL_MS, "acceleration never crosses the rate ceiling");
});

test("adaptive default: a throttle BACKS OFF the bare governor and the back-off is legible in the snapshot", async () => {
  const g = createConnectorHttpGovernor({
    name: "spotify",
    // maxAttempts 2 so a 429-then-200 drives one onRetry (throttle) then success.
    maxAttempts: 2,
    baseDelayMs: 1,
    maxDelayMs: 2,
    now: () => 0,
    random: () => 0.5,
    sleep: () => {
      /* no-op */
    },
  });
  // Accelerate first so back-off has somewhere to climb back FROM.
  for (let i = 0; i < 3; i++) {
    await g.request(() => ({ status: 200, body: null }), classify);
  }
  const accelerated = g.snapshot()?.intervalMs ?? 0;
  const statuses = [429, 200];
  await g.request(() => ({ status: statuses.shift() ?? 200, body: null }), classify);
  const snap = g.snapshot();
  assert.ok(snap?.lastBackoff, "the throttle is recorded as a legible back-off event");
  assert.equal(snap.lastBackoff.reason, "throttle", "back-off reason surfaces for the operator");
  assert.ok(
    snap.intervalMs >= accelerated,
    "back-off raised the interval (slowed the rate) from the accelerated point"
  );
});

test("adaptive default: pacingInitialIntervalMs:0 opts OUT (no snapshot, byte-identical pre-convergence path)", async () => {
  const probe = new PreflightWaitProbe();
  const g = createConnectorHttpGovernor({
    name: "notion",
    maxAttempts: 1,
    pacingInitialIntervalMs: 0,
    now: () => 0,
    sleep: probe.wrap(() => {
      /* no-op */
    }),
  });
  assert.equal(g.snapshot(), null, "opting out disables the rate controller entirely");
  await g.request(() => ({ status: 200, body: null }), classify);
  assert.equal(probe.count, 0, "no pre-flight wait when pacing is off — the old conservative path");
});

// ─── Warm-start runtime seam (persist learned rate across runs) ──────────────

test("warm-start seam: round-trip — a run persists its learned interval; the next run restores it via the shared helpers", async () => {
  const now = 1_000_000;
  // Run 1: bare governor, accelerate under success, then persist.
  const g1 = createConnectorHttpGovernor({
    name: "strava",
    maxAttempts: 1,
    now: () => 0,
    sleep: () => {
      /* no-op */
    },
  });
  for (let i = 0; i < 4; i++) {
    await g1.request(() => ({ status: 200, body: null }), classify);
  }
  const learned = g1.snapshot()?.intervalMs ?? 0;
  assert.ok(learned < DEFAULT_PACING_INITIAL_INTERVAL_MS, "run 1 learned a faster interval than the cold seed");
  const stateFields = buildPacingStateFields(g1, { now: () => now });
  // The connector spreads these into its STATE cursor next to its own fields.
  const persistedSlice = { last_cursor: "abc", ...stateFields };

  // Run 2: restore from the persisted slice, fresh (within staleness).
  const restored = readPersistedPacingInterval(persistedSlice, { now: () => now + 1000 });
  assert.equal(restored, learned, "warm-start restores the learned interval, not the cold seed");
  const g2 = createConnectorHttpGovernor({
    name: "strava",
    maxAttempts: 1,
    restoredIntervalMs: restored,
    now: () => 0,
    sleep: () => {
      /* no-op */
    },
  });
  assert.equal(
    g2.snapshot()?.intervalMs,
    learned,
    "run 2 cold-starts FROM the warm-started interval — descent compounds across runs"
  );
});

test("warm-start seam: a stale persisted interval is discarded (cold start against a possibly-reset quota)", () => {
  const now = 1_000_000;
  const persistedSlice = buildPacingStateFields(createConnectorHttpGovernorWithInterval("oura", 500), {
    now: () => now,
  });
  // Way past the staleness window → null (cold start).
  const restored = readPersistedPacingInterval(persistedSlice, { now: () => now + 100 * 60 * 60 * 1000 });
  assert.equal(restored, null, "a long-idle resume discards the stale learned rate and cold-starts conservatively");
});

test("warm-start seam: an absent / malformed state slice yields null (cold start)", () => {
  assert.equal(readPersistedPacingInterval(undefined), null);
  assert.equal(readPersistedPacingInterval(null), null);
  assert.equal(readPersistedPacingInterval({}), null, "no persisted fields → cold start");
  assert.equal(
    readPersistedPacingInterval({ pacing_interval_ms: "nan", pacing_recorded_at_ms: Date.now() }),
    null,
    "non-numeric interval → cold start"
  );
});

// ─── collection_rate observability (legible rate for ALL governor connectors) ─

test("observability: buildCollectionRateProgress turns a bare governor's snapshot into legible rate state carrying no account content", () => {
  const g = createConnectorHttpGovernor({ name: "ynab", maxAttempts: 1 });
  const rate = buildCollectionRateProgress(g);
  assert.ok(rate, "any governor-using connector can surface collection_rate");
  assert.equal(rate.object, "collection_rate");
  assert.equal(rate.current_interval_ms, DEFAULT_PACING_INITIAL_INTERVAL_MS);
  assert.equal(rate.ceiling_interval_ms, DEFAULT_PACING_MIN_INTERVAL_MS);
  assert.equal(rate.effective_rate_per_min, Math.round(60_000 / DEFAULT_PACING_INITIAL_INTERVAL_MS));
  assert.equal(rate.ceiling_rate_per_min, Math.round(60_000 / DEFAULT_PACING_MIN_INTERVAL_MS));
  assert.equal(rate.last_backoff, null);
  // No account/content fields leak — only rate numbers and a back-off reason.
  assert.deepEqual(
    Object.keys(rate).sort(),
    [
      "ceiling_interval_ms",
      "ceiling_rate_per_min",
      "current_interval_ms",
      "effective_rate_per_min",
      "last_backoff",
      "object",
    ].sort()
  );
});

test("observability: buildCollectionRateProgress returns null when pacing is opted out (honest absence, not a false zero)", () => {
  const g = createConnectorHttpGovernor({ name: "github", maxAttempts: 1, pacingInitialIntervalMs: 0 });
  assert.equal(buildCollectionRateProgress(g), null);
  assert.deepEqual(buildPacingStateFields(g), {}, "nothing to persist when pacing is off");
});

/** Helper: a governor whose pacing snapshot reports a specific learned interval. */
function createConnectorHttpGovernorWithInterval(name: string, intervalMs: number) {
  // restoredIntervalMs seeds the controller to a known interval for the test.
  return createConnectorHttpGovernor({
    name,
    maxAttempts: 1,
    restoredIntervalMs: intervalMs,
    now: () => 0,
    sleep: () => {
      /* no-op */
    },
  });
}
