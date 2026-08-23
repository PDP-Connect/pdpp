// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Reddit connector's `collect()` layer — the
 * per-stream emit + pagination + cursor orchestration.
 *
 * These tests don't spin up a browser. They construct a fake
 * `RedditListingFetch` that serves hand-crafted listing payloads, then
 * drive `collectStream` through `makeRecordingEmit(validateRecord)`.
 * Every emitted record is run through the real zod schema the runtime
 * applies in production — a fixture that would SKIP_RESULT in prod
 * fails the test here rather than silently passing.
 *
 * Imports directly from ./index.ts — `runConnector({...})` is guarded
 * by `isMainModule(import.meta.url)` so it only fires when index.ts
 * is the process entry point, not when a test imports it.
 *
 * Why bother: unit tests on pure parsers prove record shapes. These
 * prove the invariants downstream actually depends on: "records emit
 * before STATE", "incremental cursor stops early when data is old",
 * "unrequested streams emit nothing", "STATE advances to max
 * created_utc", "multi-page pagination threads 'after' correctly".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { REDDIT_JSON_ORIGIN } from "../../src/auto-login/reddit.ts";
import type { BrowserCollectContext } from "../../src/connector-runtime.ts";
import { createRepairBudget } from "../../src/repair-budget.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  buildStreamTable,
  collectAllStreams,
  collectStream,
  makePageFetch,
  makeReauth,
  normalizeRedditTerminalError,
  paginate,
  type RedditListingFetch,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { RedditChild, RedditFetchResult, RedditListing } from "./types.ts";

const EMITTED_AT = "2026-04-24T12:00:00.000Z";
const USER_PATH = "/user/anon";

test("normalizeRedditTerminalError maps auth failures to credential recovery and redacts account paths", () => {
  const normalized = normalizeRedditTerminalError({
    message:
      "reddit_auth_failed: 401 on /user/private-account/submitted.json?after=private-cursor&query=private-query " +
      "id=private-id",
    retryable: false,
  });

  assert.equal(normalized.recovery_hint, "refresh_credentials");
  assert.equal(normalized.retryable, false);
  assert.match(normalized.message, /reddit_preprogress_failure: refresh_credentials/u);
  assert.match(normalized.message, /\/user\/\[redacted\]\/submitted\.json/u);
  assert.doesNotMatch(normalized.message, /private-account/u);
  assert.doesNotMatch(normalized.message, /private-cursor|private-query|private-id/u);
  assert.doesNotMatch(normalized.message, /\$1/u, "redaction replacements must not leak capture placeholders");
});

const REDDIT_MANUAL_ACTION_ERROR_CODES = [
  "reddit_login_manual_incomplete",
  "reddit_login_unexpected_ui",
  "reddit_login_submit_missing",
  "reddit_2fa_cancelled",
  "reddit_login_post_submit_failed",
] as const;

for (const code of REDDIT_MANUAL_ACTION_ERROR_CODES) {
  test(`normalizeRedditTerminalError classifies exact production code ${code} as manual action`, () => {
    assert.deepEqual(normalizeRedditTerminalError({ message: code, retryable: false }), {
      message: `reddit_preprogress_failure: manual_action_required: ${code}`,
      recovery_hint: "manual_action_required",
      retryable: false,
    });
  });
}

test("normalizeRedditTerminalError maps a generic Cloudflare challenge to manual action", () => {
  const normalized = normalizeRedditTerminalError({
    message: "Cloudflare challenge remains",
    retryable: false,
  });
  assert.equal(normalized.recovery_hint, "manual_action_required");
  assert.equal(normalized.retryable, false);
});

test("normalizeRedditTerminalError does not turn retryable rate limits into reconnects", () => {
  const normalized = normalizeRedditTerminalError({
    message: "reddit_rate_limited: 429 on /user/private-account/submitted.json",
    retryable: true,
  });

  assert.equal(normalized.retryable, true);
  assert.equal("recovery_hint" in normalized, false);
  assert.doesNotMatch(normalized.message, /private-account/u);
});

// ─── Synthetic fixture helpers ─────────────────────────────────────────

/** Build a valid t3_* post child with the fields our enriched parser
 *  reads. created_utc is Unix seconds (Reddit's native format). */
function makePost(id: string, createdUtc: number, overrides: Partial<RedditChild["data"]> = {}): RedditChild {
  return {
    kind: "t3",
    data: {
      name: id,
      subreddit: "LocalLLaMA",
      title: `Post ${id}`,
      permalink: `/r/LocalLLaMA/comments/${id.replace("t3_", "")}/post/`,
      url: "https://example.com/article",
      selftext: "",
      is_self: false,
      over_18: false,
      score: 10,
      num_comments: 5,
      upvote_ratio: 0.9,
      created_utc: createdUtc,
      ...overrides,
    },
  };
}

function makeComment(id: string, createdUtc: number, overrides: Partial<RedditChild["data"]> = {}): RedditChild {
  return {
    kind: "t1",
    data: {
      name: id,
      subreddit: "Economics",
      body: "A comment",
      link_id: "t3_post01",
      parent_id: "t3_post01",
      permalink: `/r/Economics/comments/post01/x/${id.replace("t1_", "")}/`,
      score: 3,
      created_utc: createdUtc,
      ...overrides,
    },
  };
}

function makeStreamChild(streamName: string, suffix: "old" | "new", createdUtc: number): RedditChild {
  if (streamName === "comments") {
    return makeComment(`t1_${streamName}${suffix}`, createdUtc);
  }
  return makePost(`t3_${streamName}${suffix}`, createdUtc);
}

function listing(children: RedditChild[], after: string | null = null): RedditListing {
  return { data: { children, after } };
}

function okResult(redditListing: RedditListing): RedditFetchResult {
  return { status: 200, json: redditListing };
}

function asWrongShapeRedditListing(value: unknown): RedditListing {
  return value as RedditListing;
}

const REDDIT_MALFORMED_SUCCESS_BODIES: ReadonlyArray<readonly [string, RedditListing | null]> = [
  ["null body", null],
  ["missing data envelope", asWrongShapeRedditListing({})],
  ["missing children array", asWrongShapeRedditListing({ data: {} })],
  ["null children", asWrongShapeRedditListing({ data: { children: null } })],
  ["malformed child entry", asWrongShapeRedditListing({ data: { children: [null] } })],
];

/** Build a RedditListingFetch that serves pre-scripted responses keyed
 *  by `endpoint` (path before `?`). Subsequent calls to the same
 *  endpoint advance through the provided response list. */
function makeScriptedFetch(script: Record<string, RedditFetchResult[]>): {
  calls: string[];
  fetch: RedditListingFetch;
} {
  const calls: string[] = [];
  const cursors: Record<string, number> = {};
  return {
    calls,
    fetch: (path: string) => {
      calls.push(path);
      const endpoint = path.split("?")[0] ?? path;
      const responses = script[endpoint];
      if (!responses) {
        throw new Error(`no scripted response for ${endpoint}`);
      }
      const i = cursors[endpoint] ?? 0;
      const r = responses[Math.min(i, responses.length - 1)];
      cursors[endpoint] = i + 1;
      if (!r) {
        throw new Error(`scripted response undefined at ${endpoint}#${i}`);
      }
      return Promise.resolve(r);
    },
  };
}

const NO_DELAY = (): Promise<void> => Promise.resolve();

// ─── Invariant 1: records emit before STATE ─────────────────────────────

test("collectStream: emits all RECORDs before the STATE cursor", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [okResult(listing([makePost("t3_a", 200), makePost("t3_b", 100)]))],
  });
  const stream = buildStreamTable(USER_PATH, EMITTED_AT).find((s) => s.name === "submitted");
  assert.ok(stream, "submitted stream must exist");

  await collectStream({
    stream,
    fetchPath: fetch,
    state: {},
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: async () => undefined,
    capture: null,
    delay: NO_DELAY,
  });

  const lastRecordIdx = harness.events.reduce((acc, e, i) => (e.kind === "record" ? i : acc), -1);
  const stateIdx = harness.events.findIndex((e) => e.kind === "message" && e.message.type === "STATE");
  assert.ok(lastRecordIdx !== -1, "expected at least one RECORD event");
  assert.ok(stateIdx !== -1, "expected a STATE event");
  assert.ok(stateIdx > lastRecordIdx, "STATE must land after the last RECORD");
});

// ─── Invariant 2: STATE cursor advances to max created_utc ──────────────

test("collectStream: STATE cursor = max(created_utc) across batch", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [
      okResult(listing([makePost("t3_a", 300), makePost("t3_b", 500), makePost("t3_c", 100)])),
    ],
  });
  const stream = buildStreamTable(USER_PATH, EMITTED_AT).find((s) => s.name === "submitted");
  assert.ok(stream);

  await collectStream({
    stream,
    fetchPath: fetch,
    state: {},
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: async () => undefined,
    capture: null,
    delay: NO_DELAY,
  });

  const stateMsg = harness.protocolMessages.find((m) => m.type === "STATE");
  assert.ok(stateMsg && stateMsg.type === "STATE");
  assert.deepEqual(stateMsg.cursor, { last_created_utc: 500 });
});

// ─── Invariant 3: incremental sync halts on old data ────────────────────

test("collectStream: since-epoch stops pagination once an item crosses the cursor", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const { fetch, calls } = makeScriptedFetch({
    // Page 1: two new items, then one item at-or-below cursor → stop.
    // Page 2 should never be requested.
    [`${USER_PATH}/submitted.json`]: [
      okResult(listing([makePost("t3_a", 300), makePost("t3_b", 200), makePost("t3_c", 150)], "t3_c")),
      okResult(listing([makePost("t3_d", 100)], null)),
    ],
  });
  const stream = buildStreamTable(USER_PATH, EMITTED_AT).find((s) => s.name === "submitted");
  assert.ok(stream);

  await collectStream({
    stream,
    fetchPath: fetch,
    state: { submitted: { last_created_utc: 150 } },
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: async () => undefined,
    capture: null,
    delay: NO_DELAY,
  });

  assert.equal(calls.length, 1, "must not request page 2 once cursor is crossed");
  const ids = harness.emitted.map((e) => e.data.id);
  assert.deepEqual(ids, ["t3_a", "t3_b"], "only strictly-newer items emit");
  const stateMsg = harness.protocolMessages.find((m) => m.type === "STATE");
  assert.ok(stateMsg && stateMsg.type === "STATE");
  assert.equal((stateMsg.cursor as { last_created_utc: number }).last_created_utc, 300);
});

for (const stream of buildStreamTable(USER_PATH, EMITTED_AT)) {
  test(`collectStream: ${stream.name} restart resumes strictly after its cursor`, async () => {
    const firstHarness = makeRecordingEmit(validateRecord);
    const firstFetch = makeScriptedFetch({
      [stream.endpoint]: [okResult(listing([makeStreamChild(stream.name, "old", 200)]))],
    }).fetch;
    await collectStream({
      stream,
      fetchPath: firstFetch,
      state: {},
      emit: firstHarness.emit,
      emitRecord: firstHarness.emitRecord,
      progress: async () => undefined,
      capture: null,
      delay: NO_DELAY,
    });
    const firstState = firstHarness.protocolMessages.find((message) => message.type === "STATE");
    assert.ok(firstState && firstState.type === "STATE");

    const secondHarness = makeRecordingEmit(validateRecord);
    const secondFetch = makeScriptedFetch({
      [stream.endpoint]: [
        okResult(listing([makeStreamChild(stream.name, "new", 300), makeStreamChild(stream.name, "old", 200)])),
      ],
    }).fetch;
    await collectStream({
      stream,
      fetchPath: secondFetch,
      state: { [stream.name]: firstState.cursor },
      emit: secondHarness.emit,
      emitRecord: secondHarness.emitRecord,
      progress: async () => undefined,
      capture: null,
      delay: NO_DELAY,
    });

    const prefix = stream.name === "comments" ? "t1_" : "t3_";
    const emittedIds = secondHarness.emitted.map((record) => record.data.id);
    if (stream.order === "action") {
      // Action-ordered listings (saved/upvoted/downvoted/hidden) are sorted by
      // when the OWNER acted, not by created_utc, so an item below the cursor
      // says nothing about what follows it. These streams must walk the whole
      // listing and re-see the boundary item; suppressing it is exactly the
      // defect that froze `upvoted` at a 2026-04-28 cursor while real history
      // ran back to 2011. Re-emitting is safe — records are keyed by fullname.
      assert.deepEqual(
        emittedIds,
        [`${prefix}${stream.name}new`, `${prefix}${stream.name}old`],
        `${stream.name}: an action-ordered restart must walk past the cursor boundary`
      );
    } else {
      assert.deepEqual(
        emittedIds,
        [`${prefix}${stream.name}new`],
        `${stream.name}: a created-ordered restart must not re-emit the cursor boundary`
      );
    }
    const secondState = secondHarness.protocolMessages.find((message) => message.type === "STATE");
    assert.ok(secondState && secondState.type === "STATE");
    assert.deepEqual(secondState.cursor, { last_created_utc: 300 });
  });
}

// A restart on an action-ordered stream must recover history BELOW the stored
// cursor — the real-world shape of the defect, where `upvoted`'s cursor sat at
// a 2026 timestamp and every older upvote had become unreachable.
test("collectStream: action-ordered restart recovers items far below the cursor", async () => {
  const stream = buildStreamTable(USER_PATH, EMITTED_AT).find((s) => s.name === "upvoted");
  assert.ok(stream);
  const harness = makeRecordingEmit(validateRecord);
  const { fetch, calls } = makeScriptedFetch({
    [stream.endpoint]: [
      // Rank 1 is a 2011-era post upvoted moments ago, far below the cursor.
      okResult(listing([makePost("t3_upvotedancient", 100)], "t3_upvotedancient")),
      okResult(listing([makePost("t3_upvotedolder", 90)], null)),
    ],
  });

  await collectStream({
    stream,
    fetchPath: fetch,
    state: { upvoted: { last_created_utc: 1_777_366_297 } },
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: async () => undefined,
    capture: null,
    delay: NO_DELAY,
  });

  assert.equal(calls.length, 2, "must page past an old item instead of halting on it");
  assert.deepEqual(
    harness.emitted.map((r) => r.data.id),
    ["t3_upvotedancient", "t3_upvotedolder"],
    "history below the cursor must be recovered, not skipped"
  );
});

// ─── Invariant 4: multi-page pagination threads the 'after' cursor ──────

test("paginate: follows 'after' through multiple pages until exhausted", async () => {
  const { fetch, calls } = makeScriptedFetch({
    [`${USER_PATH}/comments.json`]: [
      okResult(listing([makeComment("t1_a", 300), makeComment("t1_b", 200)], "t1_b")),
      okResult(listing([makeComment("t1_c", 100)], null)),
    ],
  });

  const out = await paginate(fetch, `${USER_PATH}/comments.json`, null, null, NO_DELAY);
  assert.equal(out.children.length, 3);
  assert.equal(out.truncated, false);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.includes("limit=100"));
  assert.ok(calls[1]?.includes("after=t1_b"), "page 2 must carry the 'after' cursor");
});

for (const stream of buildStreamTable(USER_PATH, EMITTED_AT)) {
  test(`paginate: ${stream.name} follows the opaque after cursor`, async () => {
    const after = `after-${stream.name}`;
    const { fetch, calls } = makeScriptedFetch({
      [stream.endpoint]: [
        okResult(listing([makePost(`t3_${stream.name}_1`, 300)], after)),
        okResult(listing([makePost(`t3_${stream.name}_2`, 200)], null)),
      ],
    });

    const out = await paginate(fetch, stream.endpoint, null, null, NO_DELAY);

    assert.equal(out.children.length, 2, `${stream.name}: both pages contribute children`);
    assert.equal(out.truncated, false);
    assert.deepEqual(calls, [`${stream.endpoint}?limit=100`, `${stream.endpoint}?limit=100&after=${after}`]);
  });
}

test("paginate: progress reports cursor presence without raw cursor values", async () => {
  const progressEvents: Array<{ message: string; extra?: { cursor_present?: boolean; page_index?: number } }> = [];
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/comments.json`]: [
      okResult(listing([makeComment("t1_a", 300), makeComment("t1_b", 200)], "t1_b")),
      okResult(listing([makeComment("t1_c", 100)], null)),
    ],
  });

  await paginate(
    fetch,
    `${USER_PATH}/comments.json`,
    null,
    null,
    NO_DELAY,
    (message, extra) => {
      progressEvents.push(extra === undefined ? { message } : { message, extra });
      return Promise.resolve();
    },
    "comments"
  );

  const serialized = JSON.stringify(progressEvents);
  assert.equal(serialized.includes("t1_b"), false, "raw after cursor must not appear in progress");
  assert.equal(serialized.includes(`${USER_PATH}/comments.json`), false, "endpoint path must not appear in progress");
  assert.equal(
    progressEvents.some((event) => event.extra?.cursor_present === true),
    true
  );
  assert.equal(
    progressEvents.some((event) => event.extra?.page_index === 1),
    true
  );
});

// ─── Invariant 5: empty page terminates pagination gracefully ───────────

test("paginate: empty listing children → returns empty, no further fetches", async () => {
  const { fetch, calls } = makeScriptedFetch({
    [`${USER_PATH}/hidden.json`]: [okResult(listing([], null))],
  });
  const out = await paginate(fetch, `${USER_PATH}/hidden.json`, null, null, NO_DELAY);
  assert.equal(out.children.length, 0);
  assert.equal(out.truncated, false);
  assert.equal(calls.length, 1);
});

// ─── Invariant 6: auth / rate-limit / error status classification ───────

test("paginate: 401 → auth_failed error", async () => {
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [{ status: 401, json: null }],
  });
  await assert.rejects(paginate(fetch, `${USER_PATH}/submitted.json`, null, null, NO_DELAY), /reddit_auth_failed/);
});

test("paginate: 429 → rate_limited error", async () => {
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [{ status: 429, json: null }],
  });
  await assert.rejects(paginate(fetch, `${USER_PATH}/submitted.json`, null, null, NO_DELAY), /reddit_rate_limited/);
});

test("paginate: 500 → generic http_error", async () => {
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [{ status: 500, json: null }],
  });
  await assert.rejects(paginate(fetch, `${USER_PATH}/submitted.json`, null, null, NO_DELAY), /reddit_http_500/);
});

// ─── Invariant 6b: mid-run stale-session self-heal (401/403) ────────────

test("paginate: page 1 succeeds, page 2 401s, repair succeeds, retry of the SAME page succeeds", async () => {
  const { fetch, calls } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [
      okResult(listing([makePost("t3_a", 300)], "t3_a")),
      { status: 401, json: null },
      okResult(listing([makePost("t3_b", 200)], null)),
    ],
  });
  let reauthCalls = 0;
  // biome-ignore lint/suspicious/useAwait: mock matches RedditReauthFn's Promise-returning signature
  const onAuthFailed = async (): Promise<boolean> => {
    reauthCalls += 1;
    return true;
  };

  const out = await paginate(
    fetch,
    `${USER_PATH}/submitted.json`,
    null,
    null,
    NO_DELAY,
    undefined,
    "submitted",
    onAuthFailed
  );

  assert.equal(reauthCalls, 1, "repair must be attempted exactly once");
  assert.equal(calls.length, 3, "page 1, failed page 2, retried page 2 — no extra calls");
  assert.deepEqual(calls[1], calls[2], "the retry after repair must hit the EXACT SAME path as the failed request");
  assert.deepEqual(
    out.children.map((c) => c.data.name),
    ["t3_a", "t3_b"],
    "both pre- and post-repair pages contribute records"
  );
});

test("paginate: 401 persists after repair succeeds → still terminal auth_failed, exactly one retry attempted", async () => {
  const { fetch, calls } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [
      { status: 401, json: null },
      { status: 401, json: null },
    ],
  });
  let reauthCalls = 0;
  // biome-ignore lint/suspicious/useAwait: mock matches RedditReauthFn's Promise-returning signature
  const onAuthFailed = async (): Promise<boolean> => {
    reauthCalls += 1;
    return true;
  };

  await assert.rejects(
    paginate(fetch, `${USER_PATH}/submitted.json`, null, null, NO_DELAY, undefined, "submitted", onAuthFailed),
    /reddit_auth_failed/
  );
  assert.equal(reauthCalls, 1, "repair must not be retried in a loop");
  assert.equal(calls.length, 2, "exactly one retry of the failed request, then give up");
});

test("paginate: repair itself fails (returns false) → terminal auth_failed, no retry request sent", async () => {
  const { fetch, calls } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [{ status: 403, json: null }],
  });
  let reauthCalls = 0;
  // biome-ignore lint/suspicious/useAwait: mock matches RedditReauthFn's Promise-returning signature
  const onAuthFailed = async (): Promise<boolean> => {
    reauthCalls += 1;
    return false;
  };

  await assert.rejects(
    paginate(fetch, `${USER_PATH}/submitted.json`, null, null, NO_DELAY, undefined, "submitted", onAuthFailed),
    /reddit_auth_failed/
  );
  assert.equal(reauthCalls, 1, "repair is attempted once even though it fails");
  assert.equal(calls.length, 1, "a failed repair must not spend a retry request");
});

test("paginate: repair is attempted at most once across the whole pagination loop, not once per page", async () => {
  const { fetch, calls } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [
      { status: 401, json: null },
      okResult(listing([makePost("t3_a", 300)], "t3_a")),
      { status: 401, json: null },
    ],
  });
  let reauthCalls = 0;
  // biome-ignore lint/suspicious/useAwait: mock matches RedditReauthFn's Promise-returning signature
  const onAuthFailed = async (): Promise<boolean> => {
    reauthCalls += 1;
    return true;
  };

  await assert.rejects(
    paginate(fetch, `${USER_PATH}/submitted.json`, null, null, NO_DELAY, undefined, "submitted", onAuthFailed),
    /reddit_auth_failed/
  );
  assert.equal(reauthCalls, 1, "the one-shot repair budget is per paginate() call, not per page");
  assert.equal(calls.length, 3, "page1-failed, page1-retry-ok, page2-failed (no second repair)");
});

test("paginate: no onAuthFailed hook supplied → 401 fails immediately (pre-fix behavior unchanged)", async () => {
  const { fetch, calls } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [{ status: 401, json: null }],
  });

  await assert.rejects(paginate(fetch, `${USER_PATH}/submitted.json`, null, null, NO_DELAY), /reddit_auth_failed/);
  assert.equal(calls.length, 1, "no hook means no retry attempt");
});

// ─── Invariant 6c: makeReauth is credential-gated against process.env ───
//
// Unit-tests makeReauth DIRECTLY rather than only through collectAllStreams:
// a collectAllStreams-level test with an under-specified mock
// context/page can't discriminate "the env gate refused" from "some
// unrelated call on the stub context/page threw" — both look identical
// (makeReauth's outer catch swallows either) from the outside. Testing
// makeReauth in isolation, with a NEVER_CALLED sendInteraction and a page
// that would prove a real ensureRedditSession call was reached (by
// throwing distinctively), makes the gate itself the thing under test.

const REDDIT_ENV_KEYS = ["REDDIT_USERNAME", "REDDIT_PASSWORD"] as const;

function withoutRedditEnvCredentials<T>(fn: () => Promise<T>): Promise<T> {
  const prior = REDDIT_ENV_KEYS.map((k) => process.env[k]);
  for (const k of REDDIT_ENV_KEYS) {
    delete process.env[k];
  }
  return fn().finally(() => {
    REDDIT_ENV_KEYS.forEach((k, i) => {
      const v = prior[i];
      if (v !== undefined) {
        process.env[k] = v;
      }
    });
  });
}

function withRedditEnvCredentials<T>(
  username: string | undefined,
  password: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const prior = REDDIT_ENV_KEYS.map((k) => process.env[k]);
  if (username === undefined) {
    delete process.env.REDDIT_USERNAME;
  } else {
    process.env.REDDIT_USERNAME = username;
  }
  if (password === undefined) {
    delete process.env.REDDIT_PASSWORD;
  } else {
    process.env.REDDIT_PASSWORD = password;
  }
  return fn().finally(() => {
    REDDIT_ENV_KEYS.forEach((k, i) => {
      const v = prior[i];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    });
  });
}

/** A ctx whose context/page/sendInteraction record every property touch in
 *  `touches` before throwing (so `ensureRedditSession` can't proceed past
 *  the first access, but the fact that it was REACHED is directly
 *  observable) — the discriminating signal a bare `assert.equal(result,
 *  false)` can't provide, since makeReauth's own try/catch makes "gate
 *  refused" and "gate bypassed then failed downstream" both return `false`.
 *  Fills every `BrowserCollectContext` field (matching
 *  `createMockBrowserContext` below), with `as any` on the two
 *  Playwright-shaped fields rather than a double-cast on the whole object —
 *  those two are the only fields whose real type this stub doesn't
 *  structurally satisfy. */
function makeInstrumentedRedditCtx(): { ctx: BrowserCollectContext; touches: string[] } {
  const touches: string[] = [];
  const proxyOf = (label: string) =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          touches.push(`${label}.${String(prop)}`);
          throw new Error(`stub ${label} cannot complete ${String(prop)}`);
        },
      }
    );
  const ctx: BrowserCollectContext = {
    // biome-ignore lint/suspicious/useAwait: mock returns Promise<never> via throw for type conformance
    assist: async (): Promise<never> => {
      throw new Error("mock assist not implemented");
    },
    capture: null,
    completeAssistance: async () => undefined,
    context: proxyOf("context") as any,
    credentials: {},
    detailGaps: [],
    emit: async () => undefined,
    emitRecord: async () => undefined,
    emittedAt: EMITTED_AT,
    page: proxyOf("page") as any,
    progress: async () => undefined,
    requestDetailGapPage: async (): Promise<readonly never[]> => [],
    requested: new Map(),
    scope: { streams: [] },
    // biome-ignore lint/suspicious/useAwait: mock throws synchronously to prove the gate short-circuits before any await
    sendInteraction: async () => {
      touches.push("sendInteraction");
      throw new Error("stub sendInteraction cannot complete");
    },
    state: {},
  };
  return { ctx, touches };
}

test("makeReauth: no REDDIT_USERNAME/REDDIT_PASSWORD in process.env → refuses immediately, never touches context/page/sendInteraction", async () => {
  await withoutRedditEnvCredentials(async () => {
    const { ctx, touches } = makeInstrumentedRedditCtx();
    const result = await makeReauth(ctx)();
    assert.equal(result, false);
    assert.deepEqual(
      touches,
      [],
      "GATE MUTANT GUARD: with the env-credential check removed, ensureRedditSession would immediately touch context/page/sendInteraction — this list would be non-empty"
    );
  });
});

test("makeReauth: REDDIT_USERNAME set but REDDIT_PASSWORD absent → gate still refuses, still no touch (both vars required, not just username)", async () => {
  await withRedditEnvCredentials("anon", undefined, async () => {
    const { ctx, touches } = makeInstrumentedRedditCtx();
    const result = await makeReauth(ctx)();
    assert.equal(result, false);
    assert.deepEqual(touches, [], "password-less env must be treated the same as fully absent");
  });
});

test("makeReauth: both env vars present → gate passes through, ensureRedditSession is actually reached (context IS touched)", async () => {
  await withRedditEnvCredentials("anon", "hunter2", async () => {
    const { ctx, touches } = makeInstrumentedRedditCtx();
    const result = await makeReauth(ctx)();
    assert.equal(result, false, "the stub context/page still can't complete a real session establishment");
    assert.ok(
      touches.length > 0,
      "with credentials present, the gate must pass through and ensureRedditSession must actually touch context/page"
    );
  });
});

// ─── Invariant 6d: makeReauth trusts the post-repair isSessionLive probe, ───
// not a bare "ensureRedditSession didn't throw"
//
// `ensureRedditSession`'s own fast path (a live cookie already present) can
// return without throwing while the session dies again immediately after —
// e.g. Reddit revokes the cookie server-side between the fast-path check and
// the caller resuming. A mutant that replaces makeReauth's post-repair
// `isSessionLive(ctx.page)` call with a bare `return true` would pass every
// other Reddit test (none of them assert on the probe), because
// `ensureRedditSession` not throwing is otherwise indistinguishable from a
// truly live session. This builds a page/context pair where
// `ensureRedditSession`'s internal fast-path probe reports live (so it
// returns cleanly, no throw) but the FOLLOWING probe call — the one
// `makeReauth` issues itself — reports dead. Only a real, order-sensitive
// call to `isSessionLive` after `ensureRedditSession` returns can produce
// `false` here; a mutant returning bare `true` cannot.

/** A fake Playwright Page satisfying only what `isSessionLive` touches
 *  (`goto`, `locator(...).count()`). Each call to `.count()` consumes the
 *  next scripted answer, in order — this is what makes "live on call N,
 *  dead on call N+1" observable without a real browser. */
function makeSequencedLiveProbePage(sequence: boolean[]): Page {
  let call = 0;
  return {
    goto: async () => null,
    locator: () => ({
      // biome-ignore lint/suspicious/useAwait: mock matches Locator.count's Promise-returning signature
      count: async () => {
        const isLive = sequence[call] ?? false;
        call += 1;
        return isLive ? 1 : 0;
      },
    }),
  } as any;
}

test("makeReauth: ensureRedditSession's fast-path returns cleanly (session reads live internally) but the post-repair isSessionLive probe then reports dead → makeReauth returns false, not a bare pass-through true", async () => {
  await withRedditEnvCredentials("anon", "hunter2", async () => {
    const page = makeSequencedLiveProbePage([true, false]);
    const context = {
      // hasSessionCookie's context.cookies() gate — must report the cookie
      // present so ensureRedditSession's fast path is the branch taken
      // (skipping the full login flow this stub can't perform).
      cookies: async () => [{ name: "reddit_session", value: "stale-but-present" }],
    } as any;
    const ctx: BrowserCollectContext = {
      // biome-ignore lint/suspicious/useAwait: mock returns Promise<never> via throw for type conformance
      assist: async (): Promise<never> => {
        throw new Error("mock assist not implemented");
      },
      capture: null,
      completeAssistance: async () => undefined,
      context,
      credentials: {},
      detailGaps: [],
      emit: async () => undefined,
      emitRecord: async () => undefined,
      emittedAt: EMITTED_AT,
      page,
      progress: async () => undefined,
      requestDetailGapPage: async (): Promise<readonly never[]> => [],
      requested: new Map(),
      scope: { streams: [] },
      // biome-ignore lint/suspicious/useAwait: mock throws synchronously to prove the fast path is real, not swallowed
      sendInteraction: async (): Promise<never> => {
        throw new Error("stub sendInteraction cannot complete");
      },
      state: {},
    };

    const result = await makeReauth(ctx)();
    assert.equal(
      result,
      false,
      "PROBE GUARD: ensureRedditSession returned without throwing (fast-path saw a live session), " +
        "but the session was scripted dead on the NEXT probe call — makeReauth must trust that " +
        "post-repair probe, not treat 'didn't throw' as truth. A mutant replacing the probe call " +
        "with `return true` would make this assertion fail."
    );
  });
});

test("collectAllStreams: mid-run 401 with credentials only on baseCtx (prompted, not env) never reaches the manual 1800s hand-off — terminal auth_failed instead, and the gate is proven by NO extra page fetch", async () => {
  await withoutRedditEnvCredentials(async () => {
    const harness = makeRecordingEmit(validateRecord);
    const { fetch, calls } = makeScriptedFetch({
      [`${USER_PATH}/submitted.json`]: [{ status: 401, json: null }],
    });
    const ctx = createMockBrowserContext(fetch, harness, ["submitted"]);
    // Credentials arrived via the interaction prompt (baseCtx.credentials is
    // populated) but never landed in process.env — the exact gap this fix
    // closes.
    await assert.rejects(collectAllStreams(ctx as Parameters<typeof collectAllStreams>[0]), /reddit_auth_failed/);
    assert.equal(
      calls.length,
      1,
      "no retry: the credential-less reauth hook reports failure without a second page fetch — proves no repair-then-retry cycle ran"
    );
  });
});

test("collectAllStreams: credential-less env gate stops the FIRST requested stream's terminal failure before a second stream ever runs — not a per-stream-budget assertion (collectAllStreams doesn't catch-and-continue)", async () => {
  await withoutRedditEnvCredentials(async () => {
    const harness = makeRecordingEmit(validateRecord);
    const { fetch, calls } = makeScriptedFetch({
      [`${USER_PATH}/submitted.json`]: [{ status: 401, json: null }],
      [`${USER_PATH}/comments.json`]: [{ status: 401, json: null }],
    });
    const ctx = createMockBrowserContext(fetch, harness, ["submitted", "comments"]);

    await assert.rejects(collectAllStreams(ctx as Parameters<typeof collectAllStreams>[0]), /reddit_auth_failed/);
    // The "comments" stream is never reached: collectAllStreams throws on
    // the first stream's terminal reddit_auth_failed instead of catching
    // and continuing. This is NOT evidence of a per-stream budget — see the
    // six-stream credentialed oracle below for the actual run-scoped-budget
    // proof (old per-paginate()-call budget: 6 logins; shared budget: 1).
    assert.equal(calls.length, 1, "the credential-less gate returns false without any additional fetch");
  });
});

// ─── B2 fix: run-scoped repair budget, not per-stream ───────────────────
//
// buildStreamTable returns 6 streams (submitted, comments, saved, upvoted,
// downvoted, hidden). Each one 401s on its first page. Old behavior:
// `attemptedReauth = { done: false }` was declared INSIDE paginate(), which
// runs once per stream, so the "one-shot" budget reset 6 times per run — 6
// automated logins. Fixed behavior: a single repairBudget is created once in
// collectAllStreams and shared across every collectStream() call, so the
// login count is exactly 1 regardless of how many streams 401.

/** A fake Playwright Page that (a) always reports a live session to
 *  `isSessionLive`'s `/saved.json` JSON probe — so every reauth attempt
 *  genuinely succeeds, never masked by a scripted-sequence exhaustion —
 *  while counting each such probe call as one login-repair attempt, and
 *  (b) answers `page.evaluate(fetch, ...)` for listing pages — the real
 *  production shape `makePageFetch` builds — by routing to a scripted
 *  `RedditListingFetch`. One object plays both roles because production
 *  `collectAllStreams` drives both `fetchPath` (via `makePageFetch(page)`)
 *  and `makeReauth(ctx)` (via `isSessionLive(ctx.page)`) off the SAME
 *  `ctx.page`, and both go through `page.evaluate`. Counting real
 *  liveness-probe calls (rather than a bounded scripted-answer sequence) is
 *  what makes this discriminate a per-stream-budget regression: with a real
 *  budget shared across the run, the probe fires at most twice total (the
 *  two `isSessionLive` calls inside ONE repair — `ensureRedditSession`'s own
 *  fast-path check, then `makeReauth`'s follow-up); a regressed per-call
 *  budget would let every one of the 6 streams attempt its own repair, each
 *  firing two more probes, so the count would climb unboundedly instead of
 *  capping at 2 — a scripted-sequence approach would instead just run out
 *  and silently report "not live" for the extra attempts, hiding the defect. */
function makeReauthCapablePage(fetch: RedditListingFetch): { probeCalls: number; page: Page } {
  const state = { probeCalls: 0 };
  const page = {
    evaluate: (_fn: unknown, args: unknown): Promise<unknown> => {
      const { path } = args as { path: string };
      if (path === `${USER_PATH}/saved.json`) {
        state.probeCalls += 1;
        return Promise.resolve({ status: 200 }); // isSessionLive's liveness probe: always live
      }
      return fetch(path);
    },
    goto: () => Promise.resolve(null),
    locator: () => ({
      count: async () => 1, // credential-less fallback path only; unused once REDDIT_USERNAME is set
    }),
    // Already on the JSON origin, as a real run is by collect time — the
    // origin guard in `redditFetch`/`isSessionLive` then no-ops.
    url: () => `${REDDIT_JSON_ORIGIN}/`,
  } as any;
  return {
    get probeCalls() {
      return state.probeCalls;
    },
    page,
  };
}

/** A real `BrowserCollectContext` wired for `collectAllStreams`, with
 *  `context`/`page` shaped so `makeReauth`'s actual `ensureRedditSession`
 *  fast path (`hasSessionCookie` + `isSessionLive`) succeeds without a real
 *  browser: `context.cookies()` reports the session cookie present, so
 *  `ensureRedditSession` takes its no-login fast path and returns cleanly,
 *  and `isSessionLive` always reads live off `page`. */
function createCredentialedMockBrowserContext(
  page: Page,
  harness: ReturnType<typeof makeRecordingEmit>,
  requestedStreams: string[]
): BrowserCollectContext {
  const requested = new Map(requestedStreams.map((s) => [s, { name: s }]));
  return {
    capture: null,
    context: { cookies: async () => [{ name: "reddit_session", value: "live-cookie" }] } as any,
    credentials: { REDDIT_USERNAME: "anon" },
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: EMITTED_AT,
    page,
    progress: async () => undefined,
    requested,
    state: {},
    // biome-ignore lint/suspicious/useAwait: mock returns Promise<never> via throw for type conformance
    assist: async (): Promise<never> => {
      throw new Error("mock assist not implemented");
    },
    completeAssistance: async () => undefined,
    detailGaps: [],
    requestDetailGapPage: async (): Promise<readonly never[]> => [],
    scope: { streams: [] },
    // biome-ignore lint/suspicious/useAwait: mock returns Promise<never> via throw for type conformance
    sendInteraction: async (): Promise<never> => {
      throw new Error("mock sendInteraction not implemented");
    },
  };
}

test("collectAllStreams: 6 credentialed streams each 401 on their first page — production wiring caps automated logins at exactly 1 for the whole run, not 1 per stream", async () => {
  // Drives the REAL production entry point (collectAllStreams), the real
  // makeReauth (real ensureRedditSession fast path + real isSessionLive
  // probe, no injected onAuthFailed stub), and the real page.evaluate(fetch)
  // shape makePageFetch builds — the exact wiring a live run uses. This is
  // deliberately NOT collectStream driven in a hand-rolled loop: that shape
  // can pass even if collectAllStreams itself stopped threading one shared
  // repairBudget through (e.g. reverted to `repairBudget: createRepairBudget()`
  // as a per-call default at the collectStream() call site inside
  // collectAllStreams) because the test would still be supplying its own
  // shared instance rather than proving collectAllStreams constructs one.
  await withRedditEnvCredentials("anon", "hunter2", async () => {
    const harness = makeRecordingEmit(validateRecord);
    const streamTable = buildStreamTable(USER_PATH, EMITTED_AT);
    const script: Record<string, RedditFetchResult[]> = {};
    for (const stream of streamTable) {
      script[stream.endpoint] = [{ status: 401, json: null }, okResult(listing([makePost(`t3_${stream.name}`, 100)]))];
    }
    const { fetch } = makeScriptedFetch(script);

    // The fake page ALWAYS reports the session live (never a bounded
    // scripted-answer sequence that could run out and silently mask a
    // regression by reading "not live" for extra attempts) — every reauth
    // attempted, whether 1 or 6, would genuinely succeed if attempted. The
    // discriminating signal is therefore how many times a repair is
    // attempted at all, measured by counting `isSessionLive`'s `/saved.json`
    // probe calls: one successful repair costs exactly two probes
    // (ensureRedditSession's own fast-path check, then makeReauth's
    // follow-up check). A run-scoped budget spends this ONCE for the whole
    // run: 2 probes total, no matter how many of the 6 streams 401. A
    // regressed per-call/per-stream budget would let every 401'ing stream
    // attempt its own repair, each costing 2 more probes — the count would
    // grow with stream count instead of staying flat at 2.
    const pageHandle = makeReauthCapablePage(fetch);
    const { page } = pageHandle;
    const ctx = createCredentialedMockBrowserContext(
      page,
      harness,
      streamTable.map((s) => s.name)
    );

    // FIXED behavior: the first stream's 401 spends the run's one repair,
    // succeeds, and collects its record. Every later stream's 401 finds the
    // shared budget already spent, so makeReauth is never even invoked for
    // them — they fail immediately with the real terminal reddit_auth_failed,
    // without ever calling ensureRedditSession/isSessionLive again.
    await assert.rejects(
      () => collectAllStreams(ctx),
      /reddit_auth_failed/,
      "the run-scoped budget must let exactly one stream repair, then fail terminally on the next 401"
    );

    assert.equal(
      pageHandle.probeCalls,
      2,
      "exactly one repair's worth of session-live probing (2 /saved.json calls) for the WHOLE run, regardless of " +
        "how many of the 6 streams 401 — a per-stream/per-call budget would let every 401'ing stream repair " +
        "independently and this count would climb with stream count instead of staying at 2"
    );

    // Only the FIRST stream (submitted) could have retried past its 401 and
    // collected a record; every later stream's 401 must be terminal before
    // any record is produced for it.
    const emittedStreams = harness.emitted.map((e) => e.stream);
    assert.deepEqual(
      emittedStreams,
      ["submitted"],
      "exactly one stream (the first, whose repair spent the shared budget) reaches record emission"
    );
  });
});

test("collectStream: a single successful repair resumes collection for the CURRENT stream past its 401 (counterweight — the budget caps automated logins, it does not just fail everything closed)", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [{ status: 401, json: null }, okResult(listing([makePost("t3_a", 300)]))],
  });
  const stream = buildStreamTable(USER_PATH, EMITTED_AT).find((s) => s.name === "submitted");
  assert.ok(stream);

  const result = await collectStream({
    stream,
    fetchPath: fetch,
    state: {},
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: async () => undefined,
    capture: null,
    delay: NO_DELAY,
    onAuthFailed: () => Promise.resolve(true),
    repairBudget: createRepairBudget(),
  });

  assert.equal(
    result.considered,
    1,
    "the post-repair retry's record is collected, not just the login itself succeeding"
  );
  assert.equal(
    harness.skipped.length,
    0,
    "no SKIP_RESULT: the repaired session's retry is treated as a normal successful page"
  );
});

test("collectStream: threads onAuthFailed through to paginate and self-heals a mid-stream 401", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [{ status: 401, json: null }, okResult(listing([makePost("t3_a", 300)]))],
  });
  const stream = buildStreamTable(USER_PATH, EMITTED_AT).find((s) => s.name === "submitted");
  assert.ok(stream);
  let reauthCalls = 0;

  const result = await collectStream({
    stream,
    fetchPath: fetch,
    state: {},
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: async () => undefined,
    capture: null,
    delay: NO_DELAY,
    // biome-ignore lint/suspicious/useAwait: mock matches RedditReauthFn's Promise-returning signature
    onAuthFailed: async () => {
      reauthCalls += 1;
      return true;
    },
  });

  assert.equal(reauthCalls, 1);
  assert.equal(result.considered, 1, "the record from the post-repair retry is collected");
  assert.equal(harness.emitted.length, 1);
});

// ─── Invariant 7: every stream in the stream table passes its schema ────

test("buildStreamTable: records from every stream pass their zod schema", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const post = makePost("t3_a", 100);
  const comment = makeComment("t1_a", 200);
  const savedPost: RedditChild = {
    kind: "t3",
    data: {
      name: "t3_saved01",
      subreddit: "test",
      title: "Saved post",
      selftext: "body",
      permalink: "/r/test/comments/saved01/saved_post/",
      url: "https://example.com/x",
      created_utc: 300,
    },
  };
  const savedComment: RedditChild = {
    kind: "t1",
    data: {
      name: "t1_saved01",
      subreddit: "test",
      body: "saved comment body",
      link_title: "Parent thread",
      permalink: "/r/test/comments/p01/parent_thread/saved01/",
      created_utc: 400,
    },
  };

  const script: Record<string, RedditFetchResult[]> = {
    [`${USER_PATH}/submitted.json`]: [okResult(listing([post]))],
    [`${USER_PATH}/comments.json`]: [okResult(listing([comment]))],
    [`${USER_PATH}/saved.json`]: [okResult(listing([savedPost, savedComment]))],
    [`${USER_PATH}/upvoted.json`]: [okResult(listing([post, comment]))],
    [`${USER_PATH}/downvoted.json`]: [okResult(listing([post]))],
    [`${USER_PATH}/hidden.json`]: [okResult(listing([post]))],
  };
  const { fetch } = makeScriptedFetch(script);

  for (const stream of buildStreamTable(USER_PATH, EMITTED_AT)) {
    await collectStream({
      stream,
      fetchPath: fetch,
      state: {},
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      progress: async () => undefined,
      capture: null,
      delay: NO_DELAY,
    });
  }

  assert.equal(harness.skipped.length, 0, `expected no SKIP_RESULTs, got ${JSON.stringify(harness.skipped)}`);
  const streamCounts = harness.emitted.reduce<Record<string, number>>((acc, r) => {
    acc[r.stream] = (acc[r.stream] ?? 0) + 1;
    return acc;
  }, {});
  assert.equal(streamCounts.submitted, 1);
  assert.equal(streamCounts.comments, 1);
  assert.equal(streamCounts.saved, 2);
  assert.equal(streamCounts.upvoted, 2);
  assert.equal(streamCounts.downvoted, 1);
  assert.equal(streamCounts.hidden, 1);
  for (const stream of buildStreamTable(USER_PATH, EMITTED_AT)) {
    const ids = harness.emitted.filter((record) => record.stream === stream.name).map((record) => record.data.id);
    assert.equal(new Set(ids).size, ids.length, `${stream.name}: emitted primary IDs must be unique within a run`);
  }
});

// ─── Invariant 8: no emit when stream isn't requested ───────────────────

test("collect loop shape: only requested streams drive a fetch", async () => {
  // We exercise the buildStreamTable + request gating logic end-to-end
  // against a single scripted endpoint. Unrequested streams must not
  // call the fetcher — this is what makes scope honoring cheap.
  const harness = makeRecordingEmit(validateRecord);
  const { fetch, calls } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [okResult(listing([makePost("t3_a", 100)]))],
    [`${USER_PATH}/comments.json`]: [okResult(listing([makeComment("t1_a", 200)]))],
  });

  const requested = new Set(["submitted"]);
  for (const stream of buildStreamTable(USER_PATH, EMITTED_AT)) {
    if (!requested.has(stream.name)) {
      continue;
    }
    await collectStream({
      stream,
      fetchPath: fetch,
      state: {},
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      progress: async () => undefined,
      capture: null,
      delay: NO_DELAY,
    });
  }

  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0]?.stream, "submitted");
  assert.ok(calls.every((c) => c.startsWith(`${USER_PATH}/submitted.json`)));
});

// ─── Invariant 9: shape-check catches a drifted record ──────────────────

test("collectStream: a record missing required created_utc lands in SKIP_RESULT, not RECORD", async () => {
  const harness = makeRecordingEmit(validateRecord);
  // created_utc=0 makes isoFromUnix → null → empty string in the record,
  // which the schema's ISO regex rejects.
  const broken: RedditChild = {
    kind: "t3",
    data: {
      name: "t3_broken01",
      subreddit: "test",
      title: "broken",
      permalink: "/r/test/comments/broken01/broken/",
      url: null,
      created_utc: 0,
    },
  };
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [okResult(listing([broken]))],
  });
  const stream = buildStreamTable(USER_PATH, EMITTED_AT).find((s) => s.name === "submitted");
  assert.ok(stream);

  await collectStream({
    stream,
    fetchPath: fetch,
    state: {},
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: async () => undefined,
    capture: null,
    delay: NO_DELAY,
  });

  assert.equal(harness.emitted.length, 0, "broken record must not land in emitted[]");
  assert.equal(harness.skipped.length, 1, "broken record must land in skipped[]");
  assert.equal(harness.skipped[0]?.stream, "submitted");
});

// ─── Invariant 10: collectStream tracks coverage ──────────────────────────

test("collectStream: zero results return considered=0 and covered=0", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [okResult(listing([], null))],
  });
  const stream = buildStreamTable(USER_PATH, EMITTED_AT).find((s) => s.name === "submitted");
  assert.ok(stream);

  const result = await collectStream({
    stream,
    fetchPath: fetch,
    state: {},
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: async () => undefined,
    capture: null,
    delay: NO_DELAY,
  });

  assert.equal(result.considered, 0);
  assert.equal(result.covered, 0);
});

test("collectStream: nonzero results return correct considered and covered counts", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [
      okResult(listing([makePost("t3_a", 300), makePost("t3_b", 200), makePost("t3_c", 100)])),
    ],
  });
  const stream = buildStreamTable(USER_PATH, EMITTED_AT).find((s) => s.name === "submitted");
  assert.ok(stream);

  const result = await collectStream({
    stream,
    fetchPath: fetch,
    state: {},
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: async () => undefined,
    capture: null,
    delay: NO_DELAY,
  });

  assert.equal(result.considered, 3);
  assert.equal(result.covered, 3);
});

test("collectAllStreams: a Reddit listing beyond MAX_PAGES is partial and does not advance its watermark", async () => {
  let pagesFetched = 0;
  const fetch: RedditListingFetch = () => {
    pagesFetched += 1;
    return Promise.resolve(
      okResult(listing([makePost(`t3_cap${pagesFetched}`, 100_000 - pagesFetched)], `after-${pagesFetched}`))
    );
  };
  const { children: items, truncated } = await paginate(fetch, `${USER_PATH}/submitted.json`, null, null, NO_DELAY);

  assert.equal(items.length, 100);
  assert.equal(truncated, true, "the partial result must carry an explicit truncation marker");
  assert.equal(pagesFetched, 100, "the safety ceiling still bounds the walk");
});

test("collectStream: a capped Reddit walk holds its watermark instead of skipping the unread tail", async () => {
  // The ceiling is hit while `after` is still set, so pages 101+ (the OLDEST
  // items, in a reverse-chronological listing) were never fetched. Advancing
  // last_created_utc to the newest page would move the next run's resume
  // boundary PAST that unread tail — permanent, silent loss.
  const PRIOR_WATERMARK = 500;
  const harness = makeRecordingEmit(validateRecord);
  const fetch: RedditListingFetch = (() => {
    let pagesFetched = 0;
    return () => {
      pagesFetched += 1;
      // created_utc descends but stays above PRIOR_WATERMARK, so the walk is
      // stopped by the page ceiling rather than by the created-order boundary.
      return Promise.resolve(
        okResult(listing([makePost(`t3_cap${pagesFetched}`, 100_000 - pagesFetched)], `after-${pagesFetched}`))
      );
    };
  })();

  const stream = buildStreamTable(USER_PATH, EMITTED_AT).find((s) => s.name === "submitted");
  assert.ok(stream);

  const result = await collectStream({
    stream,
    fetchPath: fetch,
    state: { submitted: { last_created_utc: PRIOR_WATERMARK } },
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: async () => undefined,
    capture: null,
    delay: NO_DELAY,
  });

  const state = harness.protocolMessages.find((m) => m.type === "STATE" && m.stream === "submitted");
  assert.ok(state && state.type === "STATE");
  assert.deepEqual(
    state.cursor,
    { last_created_utc: PRIOR_WATERMARK },
    "a truncated walk must hold the prior watermark, never advance past unfetched pages"
  );

  assert.ok(
    result.considered > result.covered,
    "the unread tail must produce a boundary_shortfall, not a complete stream"
  );
  assert.ok(
    harness.protocolMessages.some((m) => m.type === "SKIP_RESULT" && m.stream === "submitted"),
    "a capped walk must announce the deferred pages"
  );
});

test("collectAllStreams: a Reddit listing that ends before MAX_PAGES remains complete", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [okResult(listing([makePost("t3_complete", 100)], null))],
  });
  await collectAllStreams(createMockBrowserContext(fetch, harness, ["submitted"]));

  const coverage = harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "submitted");
  assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
  assert.equal(coverage.considered, 1);
  assert.equal(coverage.covered, 1, "an honest terminal page must remain complete");
  assert.equal(
    harness.protocolMessages.some((m) => m.type === "SKIP_RESULT"),
    false
  );
});

test("collectStream: schema-invalid item not counted in covered, still emitted for runtime SKIP_RESULT", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const broken: RedditChild = {
    kind: "t3",
    data: {
      name: "t3_broken01",
      subreddit: "test",
      title: "broken",
      permalink: "/r/test/comments/broken01/broken/",
      url: null,
      created_utc: 0, // Invalid: isoFromUnix(0) → null, schema rejects empty created_utc
    },
  };
  const valid = makePost("t3_valid", 200);
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [okResult(listing([broken, valid]))],
  });
  const stream = buildStreamTable(USER_PATH, EMITTED_AT).find((s) => s.name === "submitted");
  assert.ok(stream);

  const result = await collectStream({
    stream,
    fetchPath: fetch,
    state: {},
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: async () => undefined,
    capture: null,
    delay: NO_DELAY,
  });

  assert.equal(result.considered, 2, "considered: both enumerated items (weighed)");
  assert.equal(result.covered, 1, "covered: only schema-valid item (contract: weighed-but-dropped ≠ covered)");
  assert.equal(harness.emitted.length, 1, "runtime receives only valid record");
  assert.equal(harness.skipped.length, 1, "runtime SKIP_RESULT logs broken record");
});

// ─── Invariant 11: real collectAllStreams emits DETAIL_COVERAGE ───────────

/**
 * Create a mock page that redirects evaluate calls to a scripted fetch.
 *
 * `url()` reports the JSON origin because that is where a real run's page
 * already sits by the time collect runs: `redditFetch`'s origin guard is a
 * URL check that no-ops in that state. Modeling it keeps these listing/parsing
 * oracles about listings and parsing. The guard's own behavior — including a
 * page on the WRONG origin — is proven separately below and in
 * `src/auto-login/reddit.test.ts`, not accidentally by every test here.
 */
function createMockPageForFetch(fetch: RedditListingFetch) {
  return {
    evaluate: (_fn: (args: unknown) => Promise<unknown>, args: unknown): Promise<unknown> => {
      const { path } = args as { path: string };
      return fetch(path);
    },
    goto: (): Promise<null> => Promise.resolve(null),
    url: (): string => `${REDDIT_JSON_ORIGIN}/`,
  };
}

/** Create minimal BrowserCollectContext for oracle tests */
function createMockBrowserContext(
  fetch: RedditListingFetch,
  harness: ReturnType<typeof makeRecordingEmit>,
  requestedStreams: string[]
) {
  const requested = new Map(requestedStreams.map((s) => [s, { name: s }]));
  return {
    capture: null,
    credentials: { REDDIT_USERNAME: "anon" },
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: EMITTED_AT,
    page: createMockPageForFetch(fetch) as any,
    progress: async () => undefined,
    requested,
    state: {},
    context: {} as any,
    // biome-ignore lint/suspicious/useAwait: mock returns Promise<never> via throw for type conformance
    assist: async (): Promise<never> => {
      throw new Error("mock assist not implemented");
    },
    completeAssistance: async () => undefined,
    detailGaps: [],
    requestDetailGapPage: async (): Promise<readonly never[]> => [],
    scope: { streams: [] },
    // biome-ignore lint/suspicious/useAwait: mock returns Promise<never> via throw for type conformance
    sendInteraction: async (): Promise<never> => {
      throw new Error("mock sendInteraction not implemented");
    },
  };
}

for (const stream of buildStreamTable(USER_PATH, EMITTED_AT)) {
  test(`collectAllStreams: ${stream.name} verified-empty listing emits STATE and zero coverage`, async () => {
    const harness = makeRecordingEmit(validateRecord);
    const { fetch } = makeScriptedFetch({ [stream.endpoint]: [okResult(listing([], null))] });

    await collectAllStreams(createMockBrowserContext(fetch, harness, [stream.name]));

    assert.equal(harness.emitted.length, 0, `${stream.name}: verified empty emits no records`);
    assert.equal(
      harness.protocolMessages.filter((message) => message.type === "STATE" && message.stream === stream.name).length,
      1,
      `${stream.name}: verified empty commits its stream cursor`
    );
    const coverage = harness.protocolMessages.find(
      (message) => message.type === "DETAIL_COVERAGE" && message.stream === stream.name
    );
    assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
    assert.equal(coverage.considered, 0);
    assert.equal(coverage.covered, 0);
  });
}

for (const stream of buildStreamTable(USER_PATH, EMITTED_AT)) {
  for (const [label, body] of REDDIT_MALFORMED_SUCCESS_BODIES) {
    test(`collectAllStreams: ${stream.name} rejects ${label} before STATE or coverage`, async () => {
      const harness = makeRecordingEmit(validateRecord);
      const { fetch } = makeScriptedFetch({ [stream.endpoint]: [{ status: 200, json: body }] });

      await assert.rejects(
        () => collectAllStreams(createMockBrowserContext(fetch, harness, [stream.name])),
        /reddit_parse_error/u
      );
      assert.equal(
        harness.protocolMessages.some((message) => message.type === "STATE"),
        false,
        `${stream.name}/${label}: malformed success must not commit STATE`
      );
      assert.equal(
        harness.protocolMessages.some((message) => message.type === "DETAIL_COVERAGE"),
        false,
        `${stream.name}/${label}: malformed success must not prove coverage`
      );
      assert.equal(harness.emitted.length, 0, `${stream.name}/${label}: malformed success emits no records`);
    });
  }
}

test("collectAllStreams: zero-count stream emits DETAIL_COVERAGE with considered=0, covered=0", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/submitted.json`]: [okResult(listing([], null))],
  });

  await collectAllStreams(createMockBrowserContext(fetch, harness, ["submitted"]));

  const coverageMsg = harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "submitted");
  assert.ok(coverageMsg, "DETAIL_COVERAGE must be emitted for empty stream");
  assert.ok(coverageMsg && coverageMsg.type === "DETAIL_COVERAGE");
  assert.equal(coverageMsg.considered, 0, "zero enumeration proves boundary was checked");
  assert.equal(coverageMsg.covered, 0, "covered matches considered");
});

test("collectAllStreams: one valid + one invalid child emits DETAIL_COVERAGE with considered=2, covered=1", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const broken: RedditChild = {
    kind: "t1",
    data: {
      name: "t1_broken",
      subreddit: "test",
      body: "broken",
      link_id: "t3_post01",
      parent_id: "t3_post01",
      permalink: "/r/test/comments/post01/x/broken/",
      score: 0,
      created_utc: 0, // Invalid
    },
  };
  const valid = makeComment("t1_valid", 500);
  const { fetch } = makeScriptedFetch({
    [`${USER_PATH}/comments.json`]: [okResult(listing([broken, valid]))],
  });

  await collectAllStreams(createMockBrowserContext(fetch, harness, ["comments"]));

  const coverageMsg = harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "comments");
  assert.ok(coverageMsg && coverageMsg.type === "DETAIL_COVERAGE");
  assert.equal(coverageMsg.considered, 2, "both enumerated items");
  assert.equal(coverageMsg.covered, 1, "only schema-valid item counts as covered");
  assert.equal(harness.emitted.length, 1, "runtime emits only valid record");
  assert.equal(harness.skipped.length, 1, "runtime SKIP_RESULT logs invalid record");
});

// ─── Invariant 12: the collect path's in-page fetch is same-origin ────────
//
// `redditFetch` has the SAME cross-origin defect the liveness probe had
// (production `run_1787164349370`): Reddit sends no
// `Access-Control-Allow-Origin`, so a credentialed fetch issued from a page on
// the wrong origin is blocked by the browser before it reaches the network and
// surfaces as `TypeError: Failed to fetch` -> `status: 0` -> `reddit_http_0`.
// A live session would fail every listing with an opaque HTTP error.

/** A page that models the browser's CORS rule: the in-page fetch only succeeds
 *  when the page itself is already on the JSON origin. */
function makeCorsAwarePage(startUrl: string): { gotoCalls: () => number; page: Page } {
  let url = startUrl;
  let gotoCalls = 0;
  const page = {
    evaluate: (_fn: unknown, args: unknown): Promise<unknown> => {
      const { origin } = args as { origin: string };
      if (new URL(url).origin !== origin) {
        // Blocked before the network — exactly what the real callback catches.
        return Promise.resolve({ status: 0, json: { error: "TypeError: Failed to fetch" } });
      }
      return Promise.resolve({ status: 200, json: listing([], null) });
    },
    goto: (target: string): Promise<null> => {
      gotoCalls += 1;
      url = target;
      return Promise.resolve(null);
    },
    url: (): string => url,
  } as unknown as Page;
  return { gotoCalls: () => gotoCalls, page };
}

test("redditFetch establishes the JSON origin, so a listing fetched from a www.reddit.com page succeeds instead of failing CORS", async () => {
  const { gotoCalls, page } = makeCorsAwarePage("https://www.reddit.com/");
  const result = await makePageFetch(page)(`${USER_PATH}/saved.json`);

  assert.equal(result.status, 200, "the collect fetch must not be blocked by the page's origin");
  assert.equal(gotoCalls(), 1, "the wrong origin must be corrected exactly once");
});

test("redditFetch does not re-navigate when the page is already on the JSON origin (COUNTERWEIGHT)", async () => {
  const { gotoCalls, page } = makeCorsAwarePage(`${REDDIT_JSON_ORIGIN}/`);
  const result = await makePageFetch(page)(`${USER_PATH}/saved.json`);

  assert.equal(result.status, 200);
  assert.equal(gotoCalls(), 0, "an already-correct origin must not be re-navigated on every listing page");
});
