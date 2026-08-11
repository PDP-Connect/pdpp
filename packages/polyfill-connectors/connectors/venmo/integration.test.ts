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
import { collectAllStreams, collectTransactions, type VenmoPageFetch } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const OWNER_ID = "1111111111111111111";
const EMITTED_AT = "2026-08-10T00:00:00.000Z";

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

test("collectTransactions: resumes from a persisted before_id cursor and an unmodeled story is considered but not covered", async () => {
  const modeled = story("5001", "2026-04-01T00:00:00Z");
  const unmodeled = { id: "5002", date_created: "2026-04-01T00:00:00Z", payment: { id: "5003", action: "refund" } };
  const { fetchPath, calls } = makeScriptedFetch({
    "/stories/target-or-actor/1111111111111111111": [{ body: { data: [modeled, unmodeled] } }],
  });
  const { ctx, emitted } = makeCtx({ transactions: { before_id: "prior-cursor-id" } }, ["transactions"]);
  const result = await collectTransactions(ctx, fetchPath, OWNER_ID);
  assert.ok(
    calls[0]?.includes(`before_id=${encodeURIComponent("prior-cursor-id")}`),
    "the persisted before_id must be sent on the first request of the run"
  );
  assert.equal(emitted.length, 1, "only the modeled story emits a record");
  assert.equal(result.considered, 2, "the raw page still counts unmodeled stories as considered");
  assert.equal(result.covered, 1, "only the modeled story counts as covered");
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

// ─── No raw password-grant call anywhere in this module ────────────────────

test("index.ts source contains no password-grant/device-id HTTP auth call", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /oauth\/access_token/, "no direct password-grant endpoint call");
  assert.doesNotMatch(source, /["'`]device-id["'`]\s*:/i, "no synthetic device-id header sent on a request");
  assert.doesNotMatch(source, /randomDeviceId/, "no synthetic device-id generator");
  assert.doesNotMatch(source, /phone_email_or_username/, "no password-grant request body shape");
  assert.doesNotMatch(source, /User-Agent.*Venmo\//, "no spoofed Venmo app User-Agent string");
});
