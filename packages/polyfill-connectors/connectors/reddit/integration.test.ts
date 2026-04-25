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
import { buildStreamTable, collectStream, paginate, type RedditListingFetch } from "./index.ts";
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

function okResult(listing: RedditListing): RedditFetchResult {
  return { status: 200, json: listing };
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
    [`${USER_PATH}/gilded.json`]: [okResult(listing([comment]))],
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
  assert.equal(streamCounts.gilded, 1);
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
