// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The page-ceiling correction: a capped walk must be distinguishable from an
 * exhausted one, and must NOT advance `last_start_epoch` past history it never
 * read. Strava's cursor is a newest-first watermark and the next run asks for
 * activities AFTER it, so advancing it after a cap makes the unread remainder
 * unreachable forever — the defect these tests exist to prevent regressing.
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
import { stravaPacingProfile } from "../../src/provider-profile.ts";
import { collectStrava } from "./index.ts";

/** The real governor with pacing switched off. Keeps the production retry and
 *  classification path — only the 10s-per-request rate ceiling is skipped, so
 *  a two-page fixture does not take a minute of wall clock. */
function unpacedGovernor(): ReturnType<typeof createConnectorHttpGovernor> {
  return createConnectorHttpGovernor({
    name: "strava",
    maxAttempts: 1,
    pacingInitialIntervalMs: 0,
    profile: stravaPacingProfile(),
  });
}

const PAGE_SIZE = 100;

interface StravaActivityFixture {
  id: number;
  start_date: string;
}

/** A full page (PAGE_SIZE items) tells the walk another page is listed. */
function fullPage(startId: number, startDate: string): StravaActivityFixture[] {
  return Array.from({ length: PAGE_SIZE }, (_, index) => ({
    id: startId + index,
    start_date: startDate,
  }));
}

/**
 * Serve queued pages through the REAL production fetch path (`globalThis.fetch`
 * -> the connector's HTTP governor), so these tests exercise the shipped walk
 * rather than a re-implementation of it. Matches the ynab/github precedent.
 */
function withStravaPages<T>(pages: StravaActivityFixture[][], run: (requested: URL[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const requested: URL[] = [];
  let index = 0;
  globalThis.fetch = ((input: URL | string) => {
    requested.push(new URL(String(input)));
    const page = pages[index] ?? [];
    index += 1;
    return Promise.resolve(new Response(JSON.stringify(page), { status: 200 }));
  }) as typeof globalThis.fetch;
  return run(requested).finally(() => {
    globalThis.fetch = original;
  });
}

function makeContext({
  state = {},
  streams = [{ name: "activities" }],
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
      credentials: { STRAVA_ACCESS_TOKEN: "token-test" },
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
  messages: readonly EmittedMessage[]
): Extract<EmittedMessage, { type: "SKIP_RESULT" }> | undefined {
  return messages.find(
    (message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
      message.type === "SKIP_RESULT" && message.stream === "activities"
  );
}

const EPOCH_2026_08_01 = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
const EPOCH_2026_08_02 = Math.floor(new Date("2026-08-02T00:00:00Z").getTime() / 1000);

test("a walk that exhausts naturally advances the cursor and discloses no truncation", async () => {
  // A short final page is the provider saying it has nothing more. This is the
  // behavior-preservation case: it must stay exactly as it always was.
  const { ctx, messages, records } = makeContext();
  await withStravaPages([fullPage(1, "2026-08-01T00:00:00Z"), [{ id: 9001, start_date: "2026-08-02T00:00:00Z" }]], () =>
    collectStrava(ctx, { httpGovernor: unpacedGovernor() })
  );

  assert.equal(records.length, PAGE_SIZE + 1, "every activity on every fetched page is emitted");
  assert.equal(truncationSkip(messages), undefined, "an exhausted walk must not claim truncation");
  assert.deepEqual(
    lastStateCursor(messages, "activities"),
    { last_start_epoch: EPOCH_2026_08_02 },
    "an exhausted walk advances to the newest activity it saw"
  );
});

test("an empty first page exhausts the walk without advancing past a prior cursor", async () => {
  const { ctx, messages, records } = makeContext({
    state: { activities: { last_start_epoch: EPOCH_2026_08_01 } },
  });
  await withStravaPages([[]], () => collectStrava(ctx, { httpGovernor: unpacedGovernor() }));

  assert.equal(records.length, 0);
  assert.equal(truncationSkip(messages), undefined, "an empty page is exhaustion, not truncation");
  assert.deepEqual(
    lastStateCursor(messages, "activities"),
    { last_start_epoch: EPOCH_2026_08_01 },
    "nothing new seen means the prior watermark stands"
  );
});

test("a capped walk is distinguishable from an exhausted one and holds the cursor at unread history", async () => {
  // Two full pages with a 1-page ceiling: the provider still has more listed
  // when the budget runs out. Advancing `last_start_epoch` to the newest
  // activity on page 1 would make page 2 unreachable forever.
  const { ctx, messages, records } = makeContext({
    state: { activities: { last_start_epoch: EPOCH_2026_08_01 } },
  });
  await withStravaPages([fullPage(1, "2026-08-02T00:00:00Z"), fullPage(101, "2026-08-03T00:00:00Z")], () =>
    collectStrava(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 })
  );

  assert.equal(records.length, PAGE_SIZE, "the enumerated prefix may still be emitted");

  const skip = truncationSkip(messages);
  assert.ok(skip, "a truncated walk must disclose itself to the owner");
  assert.equal(skip.reason, "older_pages_deferred_page_budget");
  assert.match(skip.message, /1-page limit/, "the disclosed ceiling must be the one actually enforced");

  assert.deepEqual(
    lastStateCursor(messages, "activities"),
    { last_start_epoch: EPOCH_2026_08_01 },
    "a capped walk must hold the cursor it started from, never advance past unread history"
  );
});

test("a capped walk with no prior cursor holds at zero rather than skipping unread history", async () => {
  const { ctx, messages } = makeContext();
  await withStravaPages([fullPage(1, "2026-08-02T00:00:00Z"), fullPage(101, "2026-08-03T00:00:00Z")], () =>
    collectStrava(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 })
  );

  assert.ok(truncationSkip(messages), "a truncated first-ever walk still discloses truncation");
  assert.deepEqual(
    lastStateCursor(messages, "activities"),
    { last_start_epoch: 0 },
    "a first run that is capped must not claim it reached the newest activity"
  );
});

test("the page ceiling is what stops the walk — it does not fetch past its budget", async () => {
  const { ctx } = makeContext();
  const requested = await withStravaPages(
    [fullPage(1, "2026-08-02T00:00:00Z"), fullPage(101, "2026-08-03T00:00:00Z"), fullPage(201, "2026-08-04T00:00:00Z")],
    async (urls) => {
      await collectStrava(ctx, { httpGovernor: unpacedGovernor(), maxPages: 2 });
      return urls;
    }
  );

  assert.equal(requested.length, 2, "a 2-page budget fetches exactly 2 pages");
  assert.deepEqual(
    requested.map((url) => url.searchParams.get("page")),
    ["1", "2"],
    "pages are requested in order, starting at 1"
  );
});
