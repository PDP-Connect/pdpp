// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The page-ceiling correction: exhausting the guard and receiving no
 * `next_token` used to produce a byte-identical result, so a capped walk read
 * as a finished one. Oura's cursor is `last_day`, which becomes the next run's
 * `start_date` — advancing it after a cap would skip days this run never read.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import type {
  CollectContext,
  EmittedMessage,
  RecordData,
  StartMessage,
  StreamScope,
} from "../../src/connector-runtime.ts";
import { ouraPacingProfile } from "../../src/provider-profile.ts";
import { collectOura } from "./index.ts";

/** The real governor with pacing switched off — production retry and
 *  classification path intact, only the rate ceiling skipped. */
function unpacedGovernor(): ReturnType<typeof createConnectorHttpGovernor> {
  return createConnectorHttpGovernor({
    name: "oura",
    maxAttempts: 1,
    pacingInitialIntervalMs: 0,
    profile: ouraPacingProfile(),
  });
}

interface OuraPageFixture {
  data: Array<{ day: string; id: string; score?: number }>;
  next_token?: string | null;
}

/**
 * Serve queued pages through the REAL production fetch path (`globalThis.fetch`
 * -> `oura()` -> the HTTP governor), so these tests exercise the shipped walk.
 */
function withOuraPages<T>(pages: OuraPageFixture[], run: (requested: URL[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const requested: URL[] = [];
  let index = 0;
  globalThis.fetch = ((input: URL | string) => {
    requested.push(new URL(String(input)));
    const page = pages[index] ?? { data: [] };
    index += 1;
    return Promise.resolve(new Response(JSON.stringify(page), { status: 200 }));
  }) as typeof globalThis.fetch;
  return run(requested).finally(() => {
    globalThis.fetch = original;
  });
}

function makeContext({
  state = {},
  streams = [{ name: "activity" }],
}: {
  readonly state?: Record<string, unknown>;
  readonly streams?: readonly StreamScope[];
} = {}): {
  readonly ctx: CollectContext;
  readonly messages: EmittedMessage[];
  readonly records: Array<{ data: RecordData; stream: string }>;
} {
  const messages: EmittedMessage[] = [];
  const records: Array<{ data: RecordData; stream: string }> = [];
  const start: StartMessage = { type: "START", scope: { streams }, state };
  return {
    messages,
    records,
    ctx: {
      assist: () => Promise.resolve("asst_test"),
      capture: null,
      completeAssistance: () => Promise.resolve(),
      credentials: { OURA_PERSONAL_ACCESS_TOKEN: "token-test" },
      detailGaps: [],
      emit: (msg) => {
        messages.push(msg);
        return Promise.resolve();
      },
      emitRecord: (stream, data) => {
        records.push({ data, stream });
        return Promise.resolve();
      },
      emittedAt: "2026-08-07T00:00:00.000Z",
      progress: () => Promise.resolve(),
      requested: new Map(streams.map((stream) => [stream.name, stream])),
      requestDetailGapPage: () => Promise.resolve([]),
      scope: start.scope,
      sendInteraction: () =>
        Promise.resolve({
          request_id: "int_test",
          status: "cancelled" as const,
          type: "INTERACTION_RESPONSE" as const,
        }),
      state,
    },
  };
}

function lastStateCursor(messages: readonly EmittedMessage[], stream: string): unknown {
  const found = [...messages].reverse().find((msg) => msg.type === "STATE" && msg.stream === stream);
  return found && found.type === "STATE" ? found.cursor : undefined;
}

function truncationSkip(
  messages: readonly EmittedMessage[],
  stream: string
): Extract<EmittedMessage, { type: "SKIP_RESULT" }> | undefined {
  return messages.find(
    (message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
      message.type === "SKIP_RESULT" && message.stream === stream
  );
}

test("a walk that exhausts naturally advances the cursor and discloses no truncation", async () => {
  // No `next_token` on the final page is the provider saying it has nothing
  // more. This is the behavior-preservation case: unchanged from before.
  const { ctx, messages, records } = makeContext();
  await withOuraPages(
    [
      { data: [{ id: "a1", day: "2026-08-01", score: 80 }], next_token: "tok-2" },
      { data: [{ id: "a2", day: "2026-08-02", score: 85 }], next_token: null },
    ],
    () => collectOura(ctx, { httpGovernor: unpacedGovernor() })
  );

  assert.equal(records.length, 2, "every row on every fetched page is emitted");
  assert.equal(truncationSkip(messages, "activity"), undefined, "an exhausted walk must not claim truncation");
  assert.deepEqual(
    lastStateCursor(messages, "activity"),
    { last_day: "2026-08-02" },
    "an exhausted walk advances to the latest day it saw"
  );
});

test("a capped walk is distinguishable from an exhausted one and holds the cursor at unread history", async () => {
  // Two pages, both advertising a next_token, with a 1-page ceiling: the
  // provider still has more when the budget runs out. Advancing `last_day` to
  // 2026-08-02 would make every unread day after it unreachable.
  const { ctx, messages, records } = makeContext({
    state: { activity: { last_day: "2026-07-31" } },
  });
  await withOuraPages(
    [
      { data: [{ id: "a1", day: "2026-08-02", score: 80 }], next_token: "tok-2" },
      { data: [{ id: "a2", day: "2026-08-03", score: 85 }], next_token: "tok-3" },
    ],
    () => collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 })
  );

  assert.equal(records.length, 1, "the enumerated prefix may still be emitted");

  const skip = truncationSkip(messages, "activity");
  assert.ok(skip, "a truncated walk must disclose itself to the owner");
  assert.equal(skip.reason, "older_pages_deferred_page_budget");
  assert.match(skip.message, /1-page limit/, "the disclosed ceiling must be the one actually enforced");

  assert.deepEqual(
    lastStateCursor(messages, "activity"),
    { last_day: "2026-07-31" },
    "a capped walk must hold the day it started from, never advance past unread history"
  );
});

test("a capped walk with no prior cursor holds at null rather than claiming a latest day", async () => {
  const { ctx, messages } = makeContext();
  await withOuraPages(
    [
      { data: [{ id: "a1", day: "2026-08-02", score: 80 }], next_token: "tok-2" },
      { data: [{ id: "a2", day: "2026-08-03", score: 85 }], next_token: "tok-3" },
    ],
    () => collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 })
  );

  assert.ok(truncationSkip(messages, "activity"), "a truncated first-ever walk still discloses truncation");
  assert.deepEqual(
    lastStateCursor(messages, "activity"),
    { last_day: null },
    "a first run that is capped must not claim it reached a latest day"
  );
});

test("the page ceiling is what stops the walk — it does not fetch past its budget", async () => {
  const { ctx } = makeContext();
  const requested = await withOuraPages(
    [
      { data: [{ id: "a1", day: "2026-08-01" }], next_token: "tok-2" },
      { data: [{ id: "a2", day: "2026-08-02" }], next_token: "tok-3" },
      { data: [{ id: "a3", day: "2026-08-03" }], next_token: "tok-4" },
    ],
    async (urls) => {
      await collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 2 });
      return urls;
    }
  );

  assert.equal(requested.length, 2, "a 2-page budget fetches exactly 2 pages");
  assert.equal(requested[0]?.searchParams.get("next_token"), null, "the first page carries no continuation token");
  assert.equal(requested[1]?.searchParams.get("next_token"), "tok-2", "the second page follows the provider's token");
});

test("truncation is disclosed and the cursor withheld per stream, not once per run", async () => {
  // Each Oura stream walks independently, so a cap reached on one stream must
  // report and withhold on that stream alone.
  const { ctx, messages } = makeContext({
    state: { sleep: { last_day: "2026-07-01" }, activity: { last_day: "2026-07-31" } },
    streams: [{ name: "sleep" }, { name: "activity" }],
  });
  await withOuraPages(
    [
      // sleep: one page, exhausted.
      { data: [{ id: "s1", day: "2026-08-05" }], next_token: null },
      // activity: still advertising more when the 1-page budget runs out.
      { data: [{ id: "a1", day: "2026-08-06" }], next_token: "tok-2" },
    ],
    () => collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 })
  );

  assert.equal(truncationSkip(messages, "sleep"), undefined, "the exhausted stream must not claim truncation");
  assert.deepEqual(
    lastStateCursor(messages, "sleep"),
    { last_day: "2026-08-05" },
    "the exhausted stream advances normally"
  );

  assert.ok(truncationSkip(messages, "activity"), "the capped stream discloses truncation");
  assert.deepEqual(
    lastStateCursor(messages, "activity"),
    { last_day: "2026-07-31" },
    "the capped stream holds its own cursor"
  );
});
