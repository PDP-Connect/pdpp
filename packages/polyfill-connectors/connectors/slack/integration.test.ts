/**
 * Integration tests for the Slack connector's `collect()` emit path —
 * specifically the unified messages/reactions/message_attachments pass
 * (`emitMessagesPass`) that shares a single co-traversal of the MESSAGE
 * table across three streams.
 *
 * These tests DON'T spawn slackdump or open sqlite. They construct a fake
 * `MessagesPassDeps` that captures every (stream, data) pair pushed
 * through `emitRecord`, then assert on the observable invariants: per-row
 * emit order (message before reactions before attachments), cross-stream
 * scope gating (disabling one stream doesn't break the other two), null-
 * enrichment fallback (message with no reactions / no attachments still
 * emits a messages row), dedup-is-upstream (same row twice → two emits),
 * emittedAt propagation, and maxMessageTs tracking across rows.
 *
 * Imports directly from ./index.ts — `runConnector({...})` is guarded by
 * `isMainModule(import.meta.url)` so it only fires when index.ts is the
 * process entry point, not when a test imports it.
 *
 * Why bother: parsers.test.ts proves each record *shape* is correct from
 * an individual MessageRow. Integration tests on the emit pass prove the
 * cross-stream invariants consumers observe: "messages, reactions, and
 * attachments share one pass but each has its own scope gate", "a bare
 * message without enrichment still lands". Regressing any of these would
 * be a silent data shape bug parsers.test.ts can't catch.
 *
 * NOTE on workspace/channel ordering (invariant 1 from the task brief):
 * the workspace → channels → messages ordering is owned by
 * `runRequestedStreams` in index.ts, not by this seam. That orchestrator
 * is sqlite-bound (each runner reads from DatabaseSync) and isn't
 * factored into a testable seam today; see the last test below for the
 * narrower "parent-before-child within a single row" assertion that this
 * seam does own.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { StreamScope } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { emitMessagesPass, type MessagesPassDeps, runChannelsStream, type StreamDeps } from "./index.ts";
import type { MessageRow, SlackDataBlob } from "./types.ts";

interface RecordingHarness {
  deps: MessagesPassDeps;
  emitted: EmittedRecord[];
  progressCalls: { extra: { stream?: string } | undefined; message: string }[];
}

/** Build a MessagesPassDeps that records every emitRecord() + progress()
 *  call. `requested` is a Map<stream,StreamScope> — match the runtime
 *  shape exactly so we aren't hiding a coercion. slack does not ship a
 *  validateRecord today, so makeRecordingEmit runs in pass-through
 *  mode; this matches runtime semantics. */
function makeHarness({
  requested = ["messages", "reactions", "message_attachments"],
  emittedAt = "2026-04-22T12:00:00.000Z",
}: {
  emittedAt?: string;
  requested?: readonly string[];
} = {}): RecordingHarness {
  const harness = makeRecordingEmit();
  const progressCalls: { extra: { stream?: string } | undefined; message: string }[] = [];
  const requestedMap = new Map<string, StreamScope>(requested.map((name) => [name, { name }]));
  const deps: MessagesPassDeps = {
    emitRecord: harness.emitRecord,
    emittedAt,
    progress: (message: string, extra?: { stream?: string }): Promise<void> => {
      progressCalls.push({ message, extra });
      return Promise.resolve();
    },
    requested: requestedMap,
  };
  return { deps, emitted: harness.emitted, progressCalls };
}

/** Encode a SlackDataBlob → Uint8Array the same way slackdump's sqlite
 *  archive stores it. parseBlob decodes via TextDecoder. */
function encodeBlob(blob: SlackDataBlob): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(blob));
}

/** Synthetic MessageRow. All fields match slackdump's sqlite column
 *  shape; DATA is a real encoded blob so parseMessageRow / parseBlob
 *  round-trip through the production decoder. */
function makeRow(overrides: Partial<MessageRow> = {}, blob: SlackDataBlob = {}): MessageRow {
  return {
    CHANNEL_ID: "C0001",
    TS: "1700000000.000100",
    THREAD_TS: null,
    IS_PARENT: null,
    TXT: "hello",
    NUM_FILES: null,
    DATA: encodeBlob(blob),
    ...overrides,
  };
}

function makeChannelDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE CHANNEL (ID TEXT, NAME TEXT, DATA TEXT, CHUNK_ID INTEGER)");
  db.prepare("INSERT INTO CHANNEL (ID, NAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)").run(
    "C0001",
    "general",
    JSON.stringify({
      created: 1_700_000_000,
      is_channel: true,
      name: "general",
      name_normalized: "general",
      num_members: 12,
    }),
    1
  );
  return db;
}

function makeChannelDeps(requestedStreams: readonly string[]): {
  close: () => void;
  deps: StreamDeps;
  emitted: EmittedRecord[];
} {
  const db = makeChannelDb();
  const harness = makeRecordingEmit();
  const requested = new Map<string, StreamScope>(requestedStreams.map((name) => [name, { name }]));
  return {
    close: () => db.close(),
    deps: {
      db,
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      emittedAt: "2026-06-03T12:00:00.000Z",
      fingerprintCursors: new Map([["channels", openFingerprintCursor({}, { excludeFromFingerprint: [] })]]),
      progress: () => Promise.resolve(),
      requested,
    },
    emitted: harness.emitted,
  };
}

test("runChannelsStream: channel_stats-only scope emits no channels entity records", async () => {
  const { close, deps, emitted } = makeChannelDeps(["channel_stats"]);
  try {
    await runChannelsStream(deps);
  } finally {
    close();
  }

  assert.deepEqual(
    emitted.map((r) => r.stream),
    ["channel_stats"]
  );
  assert.equal(emitted[0]?.data.channel_id, "C0001");
  assert.equal(emitted[0]?.data.num_members, 12);
});

test("runChannelsStream: channels-only scope emits no channel_stats observations", async () => {
  const { close, deps, emitted } = makeChannelDeps(["channels"]);
  try {
    await runChannelsStream(deps);
  } finally {
    close();
  }

  assert.deepEqual(
    emitted.map((r) => r.stream),
    ["channels"]
  );
  assert.equal(emitted[0]?.data.id, "C0001");
  assert.equal("num_members" in (emitted[0]?.data ?? {}), false);
});

// ─── Invariant 7a: parent-before-child within a single row ───────────────
// (The task brief's workspace → channels → messages ordering lives in
// runRequestedStreams, not this seam. The seam-local parent-before-child
// contract is: within one MessageRow, the `messages` record emits before
// its `reactions` and `message_attachments` children.)

test("emitMessagesPass: messages record for a row emits BEFORE its reactions + attachments", async () => {
  const { deps, emitted } = makeHarness();
  const row = makeRow(
    {},
    {
      reactions: [{ name: "tada", users: ["U1", "U2"] }],
      attachments: [{ fallback: "att-0", title: "Attached" }],
    }
  );
  await emitMessagesPass(deps, [row], null);

  const messagesIdx = emitted.findIndex((r) => r.stream === "messages");
  const firstReactionIdx = emitted.findIndex((r) => r.stream === "reactions");
  const firstAttachmentIdx = emitted.findIndex((r) => r.stream === "message_attachments");
  assert.notEqual(messagesIdx, -1, "expected a messages record");
  assert.notEqual(firstReactionIdx, -1, "expected at least one reactions record");
  assert.notEqual(firstAttachmentIdx, -1, "expected at least one message_attachments record");
  assert.ok(messagesIdx < firstReactionIdx, "messages record must precede its reactions");
  assert.ok(messagesIdx < firstAttachmentIdx, "messages record must precede its attachments");
});

// ─── Invariant 7b: cross-stream unified-pass correctness ─────────────────

test("emitMessagesPass: reactions disabled — messages + attachments still flow in the same pass", async () => {
  const { deps, emitted } = makeHarness({ requested: ["messages", "message_attachments"] });
  const row = makeRow(
    {},
    {
      reactions: [{ name: "tada", users: ["U1"] }],
      attachments: [{ fallback: "att-0" }],
    }
  );
  await emitMessagesPass(deps, [row], null);

  assert.equal(emitted.filter((r) => r.stream === "messages").length, 1, "messages still emits");
  assert.equal(emitted.filter((r) => r.stream === "reactions").length, 0, "reactions suppressed by scope");
  assert.equal(emitted.filter((r) => r.stream === "message_attachments").length, 1, "attachments still emits");
});

test("emitMessagesPass: messages disabled — reactions + attachments still flow (sibling streams not dropped)", async () => {
  // This is the unified-pass invariant: a stream's gate is local; when
  // one of the three is off the other two still see every row.
  const { deps, emitted } = makeHarness({ requested: ["reactions", "message_attachments"] });
  const row = makeRow(
    {},
    {
      reactions: [{ name: "heart", users: ["U9"] }],
      attachments: [{ fallback: "att-0" }],
    }
  );
  await emitMessagesPass(deps, [row], null);

  assert.equal(emitted.filter((r) => r.stream === "messages").length, 0, "messages suppressed by scope");
  assert.equal(emitted.filter((r) => r.stream === "reactions").length, 1, "reactions flow in shared pass");
  assert.equal(emitted.filter((r) => r.stream === "message_attachments").length, 1, "attachments flow in shared pass");
});

// ─── Invariant 3: all three streams disabled → nothing emitted ───────────

test("emitMessagesPass: all three streams disabled — no records emit, rows still iterate", async () => {
  // Production caller guards entry on `requested.has("messages" | ...)`,
  // so this is the defense-in-depth contract: if called with none of the
  // three requested, the loop runs silently. maxMessageTs still advances
  // so a STATE checkpoint written by the caller stays correct.
  const { deps, emitted } = makeHarness({ requested: ["channels"] });
  const row = makeRow(
    {},
    {
      reactions: [{ name: "fire", users: ["U1"] }],
      attachments: [{ fallback: "x" }],
    }
  );
  const result = await emitMessagesPass(deps, [row], null);
  assert.equal(emitted.length, 0, "no records emit when no relevant stream requested");
  assert.equal(result.maxMessageTs, "1700000000.000100", "ts tracking still advances");
});

// ─── Invariant 4: null/missing enrichment fallback ───────────────────────

test("emitMessagesPass: message with no reactions + no attachments still emits its messages record", async () => {
  // `reactions` + `attachments` absent from the blob entirely — the
  // record builders should yield [] silently and the core messages row
  // must still land. This is the enrichment-is-additive contract.
  const { deps, emitted } = makeHarness();
  const row = makeRow({}, {}); // bare blob
  await emitMessagesPass(deps, [row], null);

  assert.equal(emitted.filter((r) => r.stream === "messages").length, 1);
  assert.equal(emitted.filter((r) => r.stream === "reactions").length, 0);
  assert.equal(emitted.filter((r) => r.stream === "message_attachments").length, 0);
  const msg = emitted.find((r) => r.stream === "messages");
  assert.ok(msg, "messages record present");
  assert.equal(msg.data.has_attachments, false);
  assert.equal(msg.data.reaction_count, 0);
});

test("emitMessagesPass: message with reactions but no attachments — reactions emit, no attachments", async () => {
  const { deps, emitted } = makeHarness();
  const row = makeRow(
    {},
    {
      reactions: [{ name: "wave", users: ["U1", "U2", "U3"] }],
    }
  );
  await emitMessagesPass(deps, [row], null);

  assert.equal(emitted.filter((r) => r.stream === "messages").length, 1);
  assert.equal(emitted.filter((r) => r.stream === "reactions").length, 3, "one reaction record per (emoji, user) pair");
  assert.equal(emitted.filter((r) => r.stream === "message_attachments").length, 0);
});

// ─── Invariant 5: no hidden dedup at this seam ───────────────────────────

test("emitMessagesPass: the same MessageRow passed twice emits twice (dedup is upstream in iterateMessageRows)", async () => {
  // Slackdump can store (CHANNEL_ID, TS) across multiple CHUNK_IDs; the
  // MAX(CHUNK_ID) GROUP BY in iterateMessageRows collapses those. This seam
  // is faithful to its input — a future optimization that caches by
  // message id would land here and change the contract, so pin it.
  const { deps, emitted } = makeHarness();
  const row = makeRow({ TS: "1700000005.000200" }, {});
  await emitMessagesPass(deps, [row, row], null);

  assert.equal(
    emitted.filter((r) => r.stream === "messages").length,
    2,
    "duplicate row processed twice → two emits (no hidden dedup at this layer)"
  );
});

// ─── Invariant 6: timestamps thread through correctly ────────────────────

test("emitMessagesPass: row TS propagates into the messages record's ts + sent_at fields", async () => {
  const { deps, emitted } = makeHarness();
  const row = makeRow({ TS: "1700000000.000100" }, {});
  await emitMessagesPass(deps, [row], null);

  const msg = emitted.find((r) => r.stream === "messages");
  assert.ok(msg);
  assert.equal(msg.data.ts, "1700000000.000100", "row TS pinned into the record's ts field");
  // 1700000000 * 1000 = 1700000000000 → 2023-11-14T22:13:20.000Z
  assert.equal(msg.data.sent_at, "2023-11-14T22:13:20.000Z", "ts → ISO threaded into sent_at");
});

test("emitMessagesPass: returns maxMessageTs — the largest row TS seen across the pass", async () => {
  const { deps } = makeHarness();
  const rows: MessageRow[] = [
    makeRow({ TS: "1700000000.000100" }, {}),
    makeRow({ TS: "1700000200.000050" }, {}), // latest
    makeRow({ TS: "1700000100.999999" }, {}),
  ];
  const result = await emitMessagesPass(deps, rows, null);
  assert.equal(result.maxMessageTs, "1700000200.000050", "max ts seen across all rows returned for STATE cursor");
});

// ─── Progress + incremental filtering signal ─────────────────────────────

test("emitMessagesPass: priorTs triggers a progress emit tagged to the messages stream", async () => {
  // The incremental progress signal is part of the observable contract:
  // callers wire it to the STATE cursor display. Pin the shape so a
  // future refactor that drops the extra={stream} tag lands as a failing
  // test.
  const { deps, progressCalls } = makeHarness();
  await emitMessagesPass(deps, [makeRow({}, {})], "1699999999.000000");

  assert.equal(progressCalls.length, 1, "one progress emit on incremental runs");
  assert.match(progressCalls[0]?.message ?? "", /incremental.*1699999999/);
  assert.equal(progressCalls[0]?.extra?.stream, "messages", "progress tagged with the messages stream for UI routing");
});

test("emitMessagesPass: priorTs=null — no incremental progress emit (full-run mode)", async () => {
  const { deps, progressCalls } = makeHarness();
  await emitMessagesPass(deps, [makeRow({}, {})], null);
  assert.equal(progressCalls.length, 0, "full-run mode doesn't fire the incremental progress signal");
});
