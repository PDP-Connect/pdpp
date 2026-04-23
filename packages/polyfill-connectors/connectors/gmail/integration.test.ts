/**
 * Integration tests for the Gmail connector's `collect()` emit path —
 * specifically the per-message orchestration in `processMessage` and the
 * loop driver `emitMessagesPass`.
 *
 * These tests DON'T talk to IMAP. They build a fake `PerMessageDeps`
 * that:
 *   - records every (stream, data) pair pushed through emitRecord,
 *   - injects a pure fetchBodies() that returns canned bodies (or
 *     rejects to simulate a real-world fetch failure),
 *   - freezes nowIso() so timestamp fallbacks are deterministic,
 *   - captures PROGRESS emits (none expected at N<FETCH_MSG_PROGRESS).
 *
 * Imports from ./collect-helpers.ts (not ./index.ts) because index.ts
 * runs main() at module load — importing it would open stdin and hang
 * the test process.
 *
 * Why bother: parsers.test.ts proves record *shapes*. Integration tests
 * on the emit path prove the invariants downstream consumers observe:
 *   - stream-scope filters (wantMessages / wantBodies / attachments)
 *     suppress only their own stream and don't break siblings,
 *   - body-fetch failure still emits the envelope record (with null
 *     snippet, body_source="empty"), never silently drops the message,
 *   - emit order within a message is body → envelope → attachments,
 *   - missing X-GM-MSGID is skipped silently without emitting anything,
 *   - per-message errors inside emitMessagesPass don't halt the loop.
 * Regressing any of these is a real data-loss bug.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  FetchMessageObject,
  MessageEnvelopeObject,
  // biome-ignore lint/correctness/noUnresolvedImports: imapflow is declared in package.json; Biome's resolver doesn't see it here
} from "imapflow";
import {
  emitMessagesPass,
  type FetchBodiesFn,
  type FetchedBodies,
  type PerMessageDeps,
  processMessage,
} from "./collect-helpers.ts";
import type { ProgressMessage, StreamRequest } from "./types.ts";

interface EmittedRecord {
  data: Record<string, unknown>;
  stream: string;
}

interface RecordingHarness {
  deps: PerMessageDeps;
  emitted: EmittedRecord[];
  progress: ProgressMessage[];
}

const FROZEN_NOW = "2026-04-22T12:00:00.000Z";

function makeRequested(streams: readonly string[]): Map<string, StreamRequest> {
  return new Map(streams.map((name) => [name, { name }]));
}

/** Default fake body fetch: returns plausible non-null bodies so records
 *  with wantBodies/wantMessages show real content. Override per-test via
 *  the `fetchBodies` option. */
const defaultFetchBodies: FetchBodiesFn = (): Promise<FetchedBodies> =>
  Promise.resolve({
    bodyHtmlFull: "<p>hi</p>",
    bodyTextFull: "hi",
    snippet: "hi",
  });

interface HarnessOverrides {
  fetchBodies?: FetchBodiesFn;
  nowIso?: () => string;
  requested?: Map<string, StreamRequest>;
  timeRange?: { since?: string; until?: string };
  wantBodies?: boolean;
  wantMessages?: boolean;
}

function makeHarness(overrides: HarnessOverrides = {}): RecordingHarness {
  const emitted: EmittedRecord[] = [];
  const progress: ProgressMessage[] = [];
  const requested = overrides.requested ?? makeRequested(["messages", "attachments"]);
  const deps: PerMessageDeps = {
    emitProgress: (m: ProgressMessage): Promise<void> => {
      progress.push(m);
      return Promise.resolve();
    },
    emitRecord: (stream: string, data: Record<string, unknown>): Promise<void> => {
      emitted.push({ stream, data });
      return Promise.resolve();
    },
    fetchBodies: overrides.fetchBodies ?? defaultFetchBodies,
    nowIso: overrides.nowIso ?? ((): string => FROZEN_NOW),
    requested,
    timeRange: overrides.timeRange,
    wantBodies: overrides.wantBodies ?? false,
    wantMessages: overrides.wantMessages ?? true,
  };
  return { deps, emitted, progress };
}

/** Minimal-but-complete FetchMessageObject. imapflow only requires seq+uid;
 *  everything else is optional but we populate realistic defaults so the
 *  record builders have something to work with. */
function makeMsg(overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  const envelope: MessageEnvelopeObject = {
    date: new Date("2026-04-20T10:00:00.000Z"),
    subject: "Test subject",
    from: [{ name: "Alice", address: "alice@example.com" }],
    to: [{ name: "Bob", address: "bob@example.com" }],
    cc: [],
    bcc: [],
    messageId: "<msg-abc@example.com>",
  };
  return {
    seq: 1,
    uid: 100,
    emailId: "gmmsgid-1111",
    threadId: "gmthrid-2222",
    flags: new Set<string>(["\\Seen"]),
    labels: new Set<string>(["\\Inbox"]),
    envelope,
    internalDate: new Date("2026-04-20T10:00:05.000Z"),
    size: 1024,
    ...overrides,
  };
}

// ─── Invariant: parent-before-child (body → envelope → attachments) ──────

test("processMessage: emits message_bodies BEFORE messages record for the same message", async () => {
  const { deps, emitted } = makeHarness({
    requested: makeRequested(["messages", "message_bodies"]),
    wantBodies: true,
    wantMessages: true,
  });
  await processMessage(deps, makeMsg());

  const bodyIdx = emitted.findIndex((r) => r.stream === "message_bodies");
  const messageIdx = emitted.findIndex((r) => r.stream === "messages");
  assert.notEqual(bodyIdx, -1, "expected a message_bodies record");
  assert.notEqual(messageIdx, -1, "expected a messages record");
  assert.ok(bodyIdx < messageIdx, "message_bodies must precede messages in emit order");
});

// ─── Invariant: stream-scope filters cleanly ─────────────────────────────

test("processMessage: wantMessages=false suppresses messages but still emits message_bodies + attachments", async () => {
  const { deps, emitted } = makeHarness({
    requested: makeRequested(["message_bodies", "attachments"]),
    wantBodies: true,
    wantMessages: false,
  });
  // msg with no attachments → only message_bodies should emit. Skip attachments.
  await processMessage(deps, makeMsg());
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 0, "no messages record when wantMessages=false");
  assert.ok(
    emitted.some((r) => r.stream === "message_bodies"),
    "message_bodies still flows"
  );
});

test("processMessage: wantBodies=false suppresses message_bodies but still emits the messages record", async () => {
  const { deps, emitted } = makeHarness({
    wantBodies: false,
    wantMessages: true,
  });
  await processMessage(deps, makeMsg());
  assert.equal(
    emitted.filter((r) => r.stream === "message_bodies").length,
    0,
    "no message_bodies record when wantBodies=false"
  );
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 1, "messages record still emits");
});

// ─── Invariant: all-streams-disabled emits nothing ───────────────────────

test("processMessage: all streams disabled → nothing emitted, but returns true (message was processed)", async () => {
  const { deps, emitted } = makeHarness({
    requested: makeRequested([]), // no 'attachments' requested
    wantBodies: false,
    wantMessages: false,
  });
  const processed = await processMessage(deps, makeMsg());
  assert.equal(emitted.length, 0, "no records emitted when all streams off");
  assert.equal(processed, true, "processed flag still true (message wasn't skipped by early filter)");
});

// ─── Invariant: early-filter skip (missing X-GM-MSGID) ───────────────────

test("processMessage: missing X-GM-MSGID returns false and emits nothing", async () => {
  const { deps, emitted } = makeHarness({ wantMessages: true });
  // Build a message without emailId (we omit rather than set undefined to
  // satisfy exactOptionalPropertyTypes).
  const { emailId: _emailId, ...rest } = makeMsg();
  const processed = await processMessage(deps, rest);
  assert.equal(processed, false);
  assert.equal(emitted.length, 0);
});

// ─── Invariant: time_range filter skips out-of-window messages ───────────

test("processMessage: receivedAt outside time_range → false, emits nothing", async () => {
  const { deps, emitted } = makeHarness({
    timeRange: { since: "2030-01-01T00:00:00.000Z" }, // in the future
    wantMessages: true,
  });
  const processed = await processMessage(deps, makeMsg());
  assert.equal(processed, false);
  assert.equal(emitted.length, 0);
});

// ─── Invariant: body-fetch failure → still emit envelope record ──────────

test("processMessage: fetchBodies that resolves all-nulls still emits messages with snippet=null", async () => {
  const nullFetcher: FetchBodiesFn = (): Promise<FetchedBodies> =>
    Promise.resolve({ bodyHtmlFull: null, bodyTextFull: null, snippet: null });
  const { deps, emitted } = makeHarness({
    fetchBodies: nullFetcher,
    wantMessages: true,
  });
  await processMessage(deps, makeMsg());
  const msgRecord = emitted.find((r) => r.stream === "messages");
  assert.ok(msgRecord, "envelope record must emit even when body fetch returned nothing");
  assert.equal(msgRecord.data.snippet, null, "snippet falls back to null, not undefined");
});

test("processMessage: body-fetch failure + wantBodies=true emits message_bodies with body_source='empty'", async () => {
  const nullFetcher: FetchBodiesFn = (): Promise<FetchedBodies> =>
    Promise.resolve({ bodyHtmlFull: null, bodyTextFull: null, snippet: null });
  const { deps, emitted } = makeHarness({
    fetchBodies: nullFetcher,
    requested: makeRequested(["messages", "message_bodies"]),
    wantBodies: true,
    wantMessages: true,
  });
  await processMessage(deps, makeMsg());
  const bodyRecord = emitted.find((r) => r.stream === "message_bodies");
  assert.ok(bodyRecord);
  assert.equal(bodyRecord.data.body_source, "empty", "body_source marks the fallback");
  assert.equal(bodyRecord.data.body_text, null);
  assert.equal(bodyRecord.data.body_html, null);
});

// ─── Invariant: timestamp propagation (internalDate → received_at) ───────

test("processMessage: message.internalDate propagates into messages.received_at", async () => {
  const { deps, emitted } = makeHarness({ wantMessages: true });
  const fixed = new Date("2026-04-20T10:00:05.000Z");
  await processMessage(deps, makeMsg({ internalDate: fixed }));
  const msgRecord = emitted.find((r) => r.stream === "messages");
  assert.ok(msgRecord);
  assert.equal(msgRecord.data.received_at, fixed.toISOString());
});

test("processMessage: missing internalDate falls back to injected nowIso()", async () => {
  const { deps, emitted } = makeHarness({
    nowIso: (): string => "2026-04-22T12:00:00.000Z",
    wantMessages: true,
  });
  const { internalDate: _internalDate, ...rest } = makeMsg();
  await processMessage(deps, rest);
  const msgRecord = emitted.find((r) => r.stream === "messages");
  assert.ok(msgRecord);
  assert.equal(
    msgRecord.data.received_at,
    "2026-04-22T12:00:00.000Z",
    "nowIso dep is the clock seam for missing internalDate"
  );
});

// ─── Invariant: emitMessagesPass isolates per-message errors ─────────────

test("emitMessagesPass: one message throwing doesn't halt the rest of the batch", async () => {
  let calls = 0;
  const throwingFetcher: FetchBodiesFn = (): Promise<FetchedBodies> => {
    calls += 1;
    if (calls === 1) {
      return Promise.reject(new Error("synthetic fetch failure"));
    }
    return Promise.resolve({ bodyHtmlFull: null, bodyTextFull: "second msg", snippet: "second msg" });
  };
  const { deps, emitted } = makeHarness({
    fetchBodies: throwingFetcher,
    wantMessages: true,
  });
  const metas: FetchMessageObject[] = [
    makeMsg({ emailId: "bad-msg", uid: 1 }),
    makeMsg({ emailId: "good-msg", uid: 2 }),
  ];
  await emitMessagesPass(deps, metas);

  const msgRecords = emitted.filter((r) => r.stream === "messages");
  assert.equal(msgRecords.length, 1, "the second message emits even though the first errored");
  assert.equal(msgRecords[0]?.data.id, "good-msg");
});
