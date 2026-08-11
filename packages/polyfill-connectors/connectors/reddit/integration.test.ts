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
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { buildStreamTable, collectAllStreams, collectStream, paginate, type RedditListingFetch } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { RedditChild, RedditFetchResult, RedditListing } from "./types.ts";

const EMITTED_AT = "2026-04-24T12:00:00.000Z";
const USER_PATH = "/user/anon";

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

function listing(children: RedditChild[], after: string | null = null): RedditListing {
  return { data: { children, after } };
}

function okResult(redditListing: RedditListing): RedditFetchResult {
  return { status: 200, json: redditListing };
}

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

// ─── Invariant 4: multi-page pagination threads the 'after' cursor ──────

test("paginate: follows 'after' through multiple pages until exhausted", async () => {
  const { fetch, calls } = makeScriptedFetch({
    [`${USER_PATH}/comments.json`]: [
      okResult(listing([makeComment("t1_a", 300), makeComment("t1_b", 200)], "t1_b")),
      okResult(listing([makeComment("t1_c", 100)], null)),
    ],
  });

  const out = await paginate(fetch, `${USER_PATH}/comments.json`, null, null, NO_DELAY);
  assert.equal(out.length, 3);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.includes("limit=100"));
  assert.ok(calls[1]?.includes("after=t1_b"), "page 2 must carry the 'after' cursor");
});

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
  assert.equal(out.length, 0);
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
    out.map((c) => c.data.name),
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

/** Create a mock page that redirects evaluate calls to a scripted fetch */
function createMockPageForFetch(fetch: RedditListingFetch) {
  return {
    evaluate: (_fn: (args: unknown) => Promise<unknown>, args: unknown): Promise<unknown> => {
      const { path } = args as { path: string };
      return fetch(path);
    },
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
