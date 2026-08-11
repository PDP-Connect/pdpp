// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end cursor/emission tests for the browser-session collect() layer
 * (`collectTransactions`, `collectAllStreams`), driven through a scripted
 * `VenmoPageFetch` (no real browser, no real network — see
 * src/auto-login/venmo.test.ts for the session-establishment tests and
 * parsers.test.ts / schemas.test.ts for pure-function coverage).
 *
 * `VenmoPageFetch` is the seam this redesign introduced: every JSON read
 * goes through `page.evaluate(fetch)` under the live session cookie, never
 * a raw `fetch()` with an Authorization header or device-id. These tests
 * assert the seam is honored (fetchPath is the only I/O boundary
 * collectTransactions/collectAllStreams touch) and that honest coverage
 * (considered/covered) survives a schema-invalid record.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserCollectContext } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { collectAllStreams, collectTransactions, fetchAllFriends, type VenmoPageFetch } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const OWNER_ID = "1111111111111111111";
const EMITTED_AT = "2026-08-10T00:00:00.000Z";
/** Skips the real 500ms PAGE_DELAY_MS pacing in tests that need a multi-page result but aren't testing pacing itself. */
const NO_DELAY = (): Promise<void> => Promise.resolve();

/** `id` must be a numeric string — real Venmo story/payment ids are decimal digit runs (see schemas.ts NUMERIC_ID_RE). */
function story(id: string, dateCreated: string, amount = 10) {
  return {
    id,
    date_created: dateCreated,
    payment: {
      id: `9${id}`,
      action: "pay",
      actor: { id: OWNER_ID, username: "owner", display_name: "Owner" },
      target: { user: { id: "2222222222222222222", username: "friend", display_name: "Friend" } },
      amount,
      status: "settled",
    },
  };
}

function accountUser() {
  return { id: OWNER_ID, username: "owner", display_name: "Owner", date_joined: "2020-01-01T00:00:00Z" };
}

/** Script one JSON response (or an HTTP status) per matched endpoint. Each call to the same endpoint advances through its list. */
function makeScriptedFetch(script: Record<string, Array<{ body: unknown; status?: number }>>): {
  calls: string[];
  fetchPath: VenmoPageFetch;
} {
  const calls: string[] = [];
  const cursors: Record<string, number> = {};
  const fetchPath: VenmoPageFetch = (path, query) => {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    calls.push(path + qs);
    const responses = script[path];
    if (!responses) {
      throw new Error(`no scripted response for ${path}`);
    }
    const i = cursors[path] ?? 0;
    const r = responses[Math.min(i, responses.length - 1)];
    cursors[path] = i + 1;
    if (!r) {
      throw new Error(`scripted response undefined at ${path}#${i}`);
    }
    return Promise.resolve({ status: r.status ?? 200, body: JSON.stringify(r.body) });
  };
  return { calls, fetchPath };
}

/**
 * A fake `/stories/target-or-actor/{id}` backend implementing REAL Venmo
 * `before_id` semantics: `history` is newest-first (as Venmo returns it),
 * and a `before_id` query param returns the slice strictly after (i.e.
 * older than) that id in `history` — never re-serving it or anything newer.
 * Unlike `makeScriptedFetch`'s hand-scripted per-call arrays, this lets a
 * cursor from one call correctly resume mid-history in a later call, which
 * is what a two-run oracle needs to be honest about what `before_id`
 * actually does.
 */
function makeStatefulVenmoFetch(history: ReturnType<typeof story>[]): { calls: string[]; fetchPath: VenmoPageFetch } {
  const calls: string[] = [];
  const fetchPath: VenmoPageFetch = (path, query) => {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    calls.push(path + qs);
    const beforeId = query?.before_id;
    const limit = Number(query?.limit ?? String(history.length));
    const startIndex = beforeId ? history.findIndex((s) => s.id === beforeId) + 1 : 0;
    const page = beforeId && startIndex === 0 ? [] : history.slice(startIndex, startIndex + limit);
    return Promise.resolve({ status: 200, body: JSON.stringify({ data: page }) });
  };
  return { calls, fetchPath };
}

function makeCtx(
  priorState: Record<string, unknown>,
  requestedStreams: string[]
): {
  ctx: BrowserCollectContext;
  emitted: ReturnType<typeof makeRecordingEmit>["emitted"];
  messages: ReturnType<typeof makeRecordingEmit>["protocolMessages"];
} {
  const harness = makeRecordingEmit(validateRecord);
  const requested = new Map(requestedStreams.map((s) => [s, { name: s }]));
  const ctx = {
    assist: () => Promise.reject(new Error("not used")),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    context: {} as BrowserCollectContext["context"],
    credentials: {},
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: EMITTED_AT,
    page: {} as BrowserCollectContext["page"],
    progress: () => Promise.resolve(),
    requestDetailGapPage: () => Promise.resolve([]),
    requested,
    scope: { streams: [] },
    sendInteraction: () => Promise.reject(new Error("not used")),
    state: priorState,
  } as BrowserCollectContext;
  return { ctx, emitted: harness.emitted, messages: harness.protocolMessages };
}

// ─── collectTransactions: pagination, cursor, coverage ─────────────────────

test("collectTransactions: a partial page emits every modeled record and clears the cursor", async () => {
  const { fetchPath } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [
      { body: { data: [story("4001", "2026-07-01T00:00:00Z"), story("4002", "2026-07-02T00:00:00Z")] } },
    ],
  });
  const { ctx, emitted } = makeCtx({}, ["transactions"]);
  const result = await collectTransactions(ctx, fetchPath, OWNER_ID);
  assert.equal(emitted.length, 2);
  assert.equal(result.considered, 2);
  assert.equal(result.covered, 2);
  assert.equal(result.latestSeenAt, "2026-07-02T00:00:00Z", "latest date_created across the page wins");
});

test("collectTransactions: an empty first page stops immediately with zero records", async () => {
  const { fetchPath } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: { data: [] } }],
  });
  const { ctx, emitted } = makeCtx({}, ["transactions"]);
  const result = await collectTransactions(ctx, fetchPath, OWNER_ID);
  assert.equal(emitted.length, 0);
  assert.equal(result.considered, 0);
  assert.equal(result.covered, 0);
  assert.equal(result.latestSeenAt, null);
});

// F6 (regression, fixed): `before_id` pages backward with no documented
// forward/`after_id` counterpart. Persisting it across runs would resume
// the *next* run deeper into old history and permanently hide new
// transactions added at the head since the last run. So a prior run's
// `before_id` in STATE must never be read back, regardless of how the
// prior run ended (exhaustion, page cap, anything) — every run starts at
// the head.
test("collectTransactions: prior STATE.before_id is never read — every run starts at the head", async () => {
  const { fetchPath, calls } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: { data: [story("5001", "2026-04-01T00:00:00Z")] } }],
  });
  const { ctx, emitted } = makeCtx({ transactions: { before_id: "stale-cursor-from-a-prior-run" } }, ["transactions"]);
  await collectTransactions(ctx, fetchPath, OWNER_ID);
  assert.ok(
    !calls[0]?.includes("before_id"),
    "the first request of a run must never carry a cursor from a previous run"
  );
  assert.equal(emitted.length, 1);
});

test("collectAllStreams: transactions STATE never carries a before_id key — only last_seen_date_created", async () => {
  const TRANSACTIONS_PAGE_SIZE = 50;
  const fullPage = Array.from({ length: TRANSACTIONS_PAGE_SIZE }, (_, i) =>
    story(String(7000 + i), "2026-01-01T00:00:00Z")
  );
  const { fetchPath } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: { data: fullPage } }, { body: { data: [] } }],
  });
  const { ctx, messages } = makeCtx({}, ["transactions"]);
  await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
  const state = messages.find((m) => m.type === "STATE" && m.stream === "transactions");
  assert.ok(state && state.type === "STATE");
  assert.ok(
    !("before_id" in (state.cursor as Record<string, unknown>)),
    "STATE must not persist a before_id cursor across runs"
  );
  assert.equal(
    (state.cursor as { last_seen_date_created?: string | null }).last_seen_date_created,
    "2026-01-01T00:00:00Z"
  );
});

// The decisive regression case: history that is an exact multiple of the
// page size (50, 100, ...) exhausts via the *empty-page* exit, not the
// partial-page exit. The pre-fix code only reset the cursor on the
// partial-page exit, so it persisted a dead `before_id` here and run 2
// resumed past every new head transaction, forever.
//
// This must be a discriminating oracle, not just a rerun of run1's script:
// run against `makeStatefulVenmoFetch`, which implements real `before_id`
// semantics over one canonical newest-first history, and thread run1's
// *actual emitted* STATE message into run2's ctx.state, exactly as the
// runtime replays STATE across runs. A version that hand-scripts run2's
// responses independently of run1 can't tell the fixed code from the bug —
// it passes either way.
test("collectTransactions: two runs over exact-multiple-of-50 history — run2 sees new head transactions after run1 exhausts", async () => {
  const PAGE_SIZE = 50;
  const run1History = Array.from({ length: PAGE_SIZE }, (_, i) =>
    story(String(1000 + i), "2026-01-01T00:00:00Z")
  ).reverse(); // newest-first, matching real Venmo ordering
  const newHeadItems = Array.from({ length: 5 }, (_, i) => story(String(9000 + i), "2026-02-01T00:00:00Z")).reverse();

  // Run 1: exactly one full page of the exact-multiple-of-50 history, then
  // exhausted via the empty-page exit (not the partial-page exit).
  const run1Fetch = makeStatefulVenmoFetch(run1History);
  const ctx1 = makeCtx({}, ["transactions"]);
  await collectAllStreams(ctx1.ctx, run1Fetch.fetchPath, OWNER_ID, accountUser());
  assert.equal(ctx1.emitted.length, PAGE_SIZE, "run1 collects the full 50-item history");

  const run1State = ctx1.messages.find((m) => m.type === "STATE" && m.stream === "transactions");
  assert.ok(run1State && run1State.type === "STATE", "run1 must emit a transactions STATE message");

  // Run 2: thread run1's *actual emitted* STATE into ctx.state, exactly as
  // the runtime replays it. 5 new transactions have landed at the head
  // since run1 (newest-first, so they now lead the canonical history).
  const run2History = [...newHeadItems, ...run1History];
  const run2Fetch = makeStatefulVenmoFetch(run2History);
  const ctx2 = makeCtx({ transactions: run1State.cursor as Record<string, unknown> }, ["transactions"]);
  await collectAllStreams(ctx2.ctx, run2Fetch.fetchPath, OWNER_ID, accountUser());

  assert.ok(
    !run2Fetch.calls[0]?.includes("before_id"),
    "run2 must start at the head, not resume from run1's stale before_id"
  );
  const seenIds = new Set(ctx2.emitted.map((r) => r.data.id));
  const sawAllNewHeadItems = newHeadItems.every((s) => seenIds.has(s.id));
  assert.ok(sawAllNewHeadItems, "run2 must retain every new head transaction created after run1");
  assert.equal(seenIds.size, run2History.length, "run2 re-walks and retains the full history, old and new");
});

// Page-cap exhaustion (MAX_TRANSACTION_PAGES) must be equally safe: even
// when a run stops because it hit the page cap rather than an empty/partial
// page, nothing is persisted that would make the next run skip the head.
test("collectTransactions: hitting the page cap still starts the next run at the head", async () => {
  const PAGE_SIZE = 50;
  const MAX_TRANSACTION_PAGES = 400;
  const fullPage = (offset: number) =>
    Array.from({ length: PAGE_SIZE }, (_, i) => story(String(offset + i), "2026-01-01T00:00:00Z"));
  const script: Record<string, Array<{ body: unknown }>> = {
    "/stories/target-or-actor/1111111111111111111": Array.from({ length: MAX_TRANSACTION_PAGES }, (_, page) => ({
      body: { data: fullPage(page * PAGE_SIZE) },
    })),
  };
  const { fetchPath: fetchPath1, calls } = makeScriptedFetch(script);
  const ctx1 = makeCtx({}, ["transactions"]);
  const result1 = await collectTransactions(ctx1.ctx, fetchPath1, OWNER_ID, NO_DELAY);
  assert.equal(result1.considered, PAGE_SIZE * MAX_TRANSACTION_PAGES, "the run consumes every page up to the cap");
  assert.equal(calls.length, MAX_TRANSACTION_PAGES, "the loop stops exactly at the page cap, not beyond");

  const { fetchPath: fetchPath2, calls: calls2 } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: { data: [story("head-1", "2026-03-01T00:00:00Z")] } }],
  });
  const ctx2 = makeCtx({ transactions: { before_id: "should-never-be-read" } }, ["transactions"]);
  await collectTransactions(ctx2.ctx, fetchPath2, OWNER_ID, NO_DELAY);
  assert.ok(!calls2[0]?.includes("before_id"), "a page-cap-exhausted run must not leave a cursor for the next run");
});

// ─── Page pacing (F10) ──────────────────────────────────────────────────────

test("collectTransactions: paces between pages via the injected delay, not a bare back-to-back loop", async () => {
  const TRANSACTIONS_PAGE_SIZE = 50;
  const page1 = Array.from({ length: TRANSACTIONS_PAGE_SIZE }, (_, i) =>
    story(String(1000 + i), "2026-01-01T00:00:00Z")
  );
  const page2 = [story("2000", "2026-01-02T00:00:00Z")];
  const { fetchPath } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: { data: page1 } }, { body: { data: page2 } }],
  });
  const { ctx } = makeCtx({}, ["transactions"]);
  const delays: number[] = [];
  const recordingDelay = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  await collectTransactions(ctx, fetchPath, OWNER_ID, recordingDelay);
  assert.deepEqual(delays, [500], "one page-to-page transition must pace exactly once, via the injected delay");
});

test("collectTransactions: a single (non-continuing) page never paces — nothing to wait between", async () => {
  const { fetchPath } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: { data: [story("3000", "2026-01-01T00:00:00Z")] } }],
  });
  const { ctx } = makeCtx({}, ["transactions"]);
  let delayCalls = 0;
  await collectTransactions(ctx, fetchPath, OWNER_ID, () => {
    delayCalls += 1;
    return Promise.resolve();
  });
  assert.equal(delayCalls, 0, "a run with only one page has nothing to pace between");
});

test("fetchAllFriends: paces between pages via the injected delay", async () => {
  const FRIENDS_PAGE_SIZE = 200;
  const page1 = Array.from({ length: FRIENDS_PAGE_SIZE }, (_, i) => ({
    id: String(4000 + i),
    username: `friend${i}`,
    display_name: `Friend ${i}`,
  }));
  const page2 = [{ id: "5000", username: "last", display_name: "Last Friend" }];
  const { fetchPath } = makeScriptedFetch({
    [`/users/${OWNER_ID}/friends`]: [{ body: { data: page1 } }, { body: { data: page2 } }],
  });
  const delays: number[] = [];
  const all = await fetchAllFriends(
    fetchPath,
    OWNER_ID,
    () => Promise.resolve(),
    (ms) => {
      delays.push(ms);
      return Promise.resolve();
    }
  );
  assert.equal(all.length, FRIENDS_PAGE_SIZE + 1);
  assert.deepEqual(delays, [500], "one page-to-page transition must pace exactly once");
});

// ─── Endpoint failure classification ────────────────────────────────────────

test("collectTransactions: a 401 mid-run terminals as venmo_session_expired, never as a raw password-grant retry", async () => {
  const { fetchPath } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: { error: { message: "session gone" } }, status: 401 }],
  });
  const { ctx } = makeCtx({}, ["transactions"]);
  await assert.rejects(collectTransactions(ctx, fetchPath, OWNER_ID), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /venmo_session_expired/);
    assert.match(
      err.message,
      /\/stories\/target-or-actor\/\{id\}/,
      "endpoint label is templated, not the live user id"
    );
    assert.doesNotMatch(err.message, /1111111111111111111/, "the live owner id must not leak into the message");
    return true;
  });
});

test("collectTransactions: a 5xx terminals as venmo_http_5xx naming the endpoint", async () => {
  const { fetchPath } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: "upstream boom", status: 500 }],
  });
  const { ctx } = makeCtx({}, ["transactions"]);
  await assert.rejects(collectTransactions(ctx, fetchPath, OWNER_ID), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /venmo_http_500/);
    assert.match(err.message, /\/stories\/target-or-actor/);
    return true;
  });
});

test("collectTransactions: a 429 terminals as venmo_rate_limited (retryable pattern match)", async () => {
  const { fetchPath } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: {}, status: 429 }],
  });
  const { ctx } = makeCtx({}, ["transactions"]);
  await assert.rejects(collectTransactions(ctx, fetchPath, OWNER_ID), /venmo_rate_limited/);
});

// ─── collectAllStreams: full collect() body, honest coverage, scope ────────

test("collectAllStreams: only requested streams drive a fetch", async () => {
  const { fetchPath, calls } = makeScriptedFetch({
    "/account": [{ body: { data: { user: accountUser() } } }],
  });
  const { ctx, emitted } = makeCtx({}, ["profile"]);
  await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.stream, "profile");
  assert.deepEqual(calls, [], "the pre-fetched account object must be reused, not re-fetched for profile");
});

test("collectAllStreams: friends stream emits DETAIL_COVERAGE with honest considered/covered", async () => {
  const { fetchPath } = makeScriptedFetch({
    "/users/1111111111111111111/friends": [
      { body: { data: [{ id: "3333333333333333333", username: "a", display_name: "A" }] } },
    ],
  });
  const { ctx, emitted, messages } = makeCtx({}, ["friends"]);
  await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
  assert.equal(emitted.length, 1);
  const coverage = messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "friends");
  assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
  assert.equal(coverage.considered, 1);
  assert.equal(coverage.covered, 1);
});

test("collectAllStreams: zero-friend run still emits DETAIL_COVERAGE considered=0 covered=0 (measured zero, not silence)", async () => {
  const { fetchPath } = makeScriptedFetch({
    "/users/1111111111111111111/friends": [{ body: { data: [] } }],
  });
  const { ctx, messages } = makeCtx({}, ["friends"]);
  await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
  const coverage = messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "friends");
  assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
  assert.equal(coverage.considered, 0);
  assert.equal(coverage.covered, 0);
});

test("collectAllStreams: transactions DETAIL_COVERAGE distinguishes considered from covered on an unmodeled story", async () => {
  const modeled = story("6001", "2026-05-01T00:00:00Z");
  const unmodeled = { id: "6002", date_created: "2026-05-01T00:00:00Z", payment: { id: "6003", action: "top_up" } };
  const { fetchPath } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: { data: [modeled, unmodeled] } }],
  });
  const { ctx, emitted, messages } = makeCtx({}, ["transactions"]);
  await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
  assert.equal(emitted.length, 1, "only the modeled story emits a record");
  const coverage = messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "transactions");
  assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
  assert.equal(coverage.considered, 2);
  assert.equal(coverage.covered, 1);
});

test("collectAllStreams: records emit before STATE for each requested stream", async () => {
  const { fetchPath } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: { data: [story("7001", "2026-06-01T00:00:00Z")] } }],
  });
  const harness = makeRecordingEmit(validateRecord);
  const ctx = {
    assist: () => Promise.reject(new Error("not used")),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    context: {} as BrowserCollectContext["context"],
    credentials: {},
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: EMITTED_AT,
    page: {} as BrowserCollectContext["page"],
    progress: () => Promise.resolve(),
    requestDetailGapPage: () => Promise.resolve([]),
    requested: new Map([["transactions", { name: "transactions" }]]),
    scope: { streams: [] },
    sendInteraction: () => Promise.reject(new Error("not used")),
    state: {},
  } as BrowserCollectContext;
  await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
  const lastRecordIdx = harness.events.reduce((acc, e, i) => (e.kind === "record" ? i : acc), -1);
  const stateIdx = harness.events.findIndex((e) => e.kind === "message" && e.message.type === "STATE");
  assert.ok(lastRecordIdx !== -1, "expected at least one RECORD event");
  assert.ok(stateIdx !== -1, "expected a STATE event");
  assert.ok(stateIdx > lastRecordIdx, "STATE must land after the last RECORD");
});

// ─── No raw fetch anywhere in the collect path ──────────────────────────────
//
// A source grep only catches a literal spelling — renaming
// `"access" + "_token"` or building the device-id header from a differently
// named constant defeats it while a real password-grant call still runs
// (proven live: /tmp/review-venmo-browser-redesign-0810.md F7). This asserts
// the actual behavior instead: `collectAllStreams` must not touch
// `globalThis.fetch` at all — every read goes through the injected
// `VenmoPageFetch` seam (`page.evaluate(fetch)` under the session cookie),
// never a raw Node-side `fetch()` call that could carry a bearer token,
// device-id, or spoofed User-Agent.

test("collectAllStreams: never calls globalThis.fetch — every read goes through the injected page-fetch seam", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    called = true;
    return original(...args);
  }) as typeof globalThis.fetch;
  try {
    const { fetchPath } = makeScriptedFetch({
      "/account": [{ body: { data: { user: accountUser() } } }],
      "/users/1111111111111111111/friends": [{ body: { data: [] } }],
      "/stories/target-or-actor/1111111111111111111": [{ body: { data: [] } }],
    });
    const { ctx } = makeCtx({}, ["profile", "friends", "transactions"]);
    await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
    assert.equal(called, false, "collectAllStreams must never call globalThis.fetch directly");
  } finally {
    globalThis.fetch = original;
  }
});
