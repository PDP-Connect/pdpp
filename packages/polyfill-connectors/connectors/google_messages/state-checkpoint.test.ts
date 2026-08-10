// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the Google Messages connector's STATE watermark: fail-before/
 * pass-after coverage for the resume/proof defect in
 * /tmp/local-connectors-proof-0809.md ("emits no STATE watermark... every
 * run rescans and can duplicate large histories").
 *
 * Drives the real connector subprocess (fake-gmcli, `custom` mode) across
 * two real runs, applying the runtime's actual per-stream last-wins STATE
 * projection between them (collector-runner.ts's
 * `bufferedState[message.stream] = message.cursor`) — the same proof shape
 * groupme/carry-forward-projection.test.ts uses, and for the same reason:
 * hand-threading state between runs would not catch a bug in how `collect()`
 * shapes or keys its own STATE emit.
 *
 * gmcli has no server-side "since" cursor (see index.ts's STATE doc
 * comment) — every run re-fetches the same bounded per-conversation window
 * from scratch. So "resume" here means: a message whose fetched content is
 * unchanged from a prior run's fingerprint must not be re-emitted as a
 * duplicate RECORD, while a genuinely new/changed/late-arriving message
 * (still within the fetched window) always is.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { messagesSchema } from "./schemas.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "google_messages", "index.ts");
const FAKE_GMCLI = join(PACKAGE_ROOT, "connectors", "google_messages", "fixtures", "fake-gmcli.mjs");

function records(messages: readonly EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD")
    .filter((m) => m.stream === stream)
    .map((m) => m.data);
}

function skips(messages: readonly EmittedMessage[]): Extract<EmittedMessage, { type: "SKIP_RESULT" }>[] {
  return messages.filter((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
}

function sortedIds(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((r) => String(r.id)).sort((a, b) => (a < b ? -1 : 1));
}

function stateFor(messages: readonly EmittedMessage[], stream: string): unknown {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE")
    .find((m) => m.stream === stream)?.cursor;
}

/**
 * The runtime's real per-stream STATE projection (collector-runner.ts:1447):
 * last-wins per stream. Used between two chained runs so the "resume" proof
 * exercises the actual persisted-cursor shape, not a hand-built one.
 */
function projectState(messages: readonly EmittedMessage[]): Record<string, unknown> {
  const bufferedState: Record<string, unknown> = {};
  for (const message of messages) {
    if (message.type === "STATE") {
      bufferedState[message.stream] = message.cursor;
    }
  }
  return bufferedState;
}

interface RawChat {
  conversation_id: string;
  is_group?: boolean;
  last_message_time_ms?: number;
  name: string;
  source_platform: string;
}

interface RawMessage {
  body: string;
  conversation_id: string;
  is_from_me: boolean;
  message_id: string;
  sender_id: string;
  source_platform: string;
  status: number;
  timestamp_ms: number;
}

const CHAT_ALICE: RawChat = {
  conversation_id: "chat_alice",
  source_platform: "rcs",
  name: "Alice",
  is_group: false,
  last_message_time_ms: 1_754_071_605_000,
};

function msg(overrides: Partial<RawMessage> & Pick<RawMessage, "message_id" | "timestamp_ms">): RawMessage {
  return {
    conversation_id: "chat_alice",
    source_platform: "rcs",
    sender_id: "+15551230001",
    body: `body for ${overrides.message_id}`,
    status: 1,
    is_from_me: false,
    ...overrides,
  };
}

function runGoogleMessagesCustom(
  chats: RawChat[],
  messages: RawMessage[],
  state: Record<string, unknown>,
  env: Record<string, string> = {}
): Promise<{ code: number | null; messages: EmittedMessage[] }> {
  return runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: {
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
      GMCLI_BIN: FAKE_GMCLI,
      FAKE_GMCLI_MODE: "custom",
      FAKE_GMCLI_CHATS_JSON: JSON.stringify(chats),
      FAKE_GMCLI_MESSAGES_JSON: JSON.stringify(messages),
      ...env,
    },
    start: {
      scope: { streams: [{ name: "messages" }, { name: "coverage_diagnostics" }] },
      state,
      type: "START",
    },
  });
}

// ─── First run: fresh state, everything is new ────────────────────────────

test("first run: no prior state, every message emitted and a STATE watermark is committed", async () => {
  const run1 = await runGoogleMessagesCustom(
    [CHAT_ALICE],
    [
      msg({ message_id: "msg_1", timestamp_ms: 1_754_071_452_000 }),
      msg({ message_id: "msg_2", timestamp_ms: 1_754_071_453_000 }),
    ],
    {}
  );

  const emitted = records(run1.messages, "messages");
  assert.equal(emitted.length, 2, "first run emits every fetched message");
  for (const record of emitted) {
    const parsed = messagesSchema.safeParse(record);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  }

  const cursor = stateFor(run1.messages, "messages") as { fingerprints?: Record<string, string> } | undefined;
  assert.ok(cursor, "first run must commit a STATE watermark for the messages stream");
  assert.equal(Object.keys(cursor?.fingerprints ?? {}).length, 2, "cursor remembers both fetched message ids");
});

// ─── No-op resume: same archive, second run emits nothing new ─────────────

test("no-op resume: identical archive on run 2 emits zero duplicate RECORDs", async () => {
  const chats = [CHAT_ALICE];
  const messages = [
    msg({ message_id: "msg_1", timestamp_ms: 1_754_071_452_000 }),
    msg({ message_id: "msg_2", timestamp_ms: 1_754_071_453_000 }),
  ];

  const run1 = await runGoogleMessagesCustom(chats, messages, {});
  assert.equal(records(run1.messages, "messages").length, 2, "run 1 emits both messages");
  const projected = projectState(run1.messages);
  assert.ok(projected.messages, "run 1 persisted a messages cursor to carry forward");

  const run2 = await runGoogleMessagesCustom(chats, messages, projected);
  assert.equal(
    records(run2.messages, "messages").length,
    0,
    "identical archive re-fetch must not duplicate already-durable records — this is the exact defect: it used to always re-emit everything"
  );

  // A no-op resume still proves its own coverage (2 considered/covered) and
  // still commits a STATE watermark (even though it is byte-identical to
  // run 1's), so a subsequent crash-recovery run has a fresh cursor to seed from.
  const coverage = run2.messages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      m.type === "DETAIL_COVERAGE" && m.stream === "messages"
  );
  assert.ok(coverage, "no-op resume still emits DETAIL_COVERAGE");
  assert.equal(coverage?.considered, 2);
  assert.equal(coverage?.covered, 2);
  assert.ok(stateFor(run2.messages, "messages"), "no-op resume still commits a STATE watermark");
});

// ─── New rows: only the new message is emitted, the old one is suppressed ─

test("new rows: run 2 adds one message to the same chat — only the new message is emitted", async () => {
  const chats = [CHAT_ALICE];
  const run1Messages = [msg({ message_id: "msg_1", timestamp_ms: 1_754_071_452_000 })];
  const run1 = await runGoogleMessagesCustom(chats, run1Messages, {});
  assert.equal(records(run1.messages, "messages").length, 1);
  const projected = projectState(run1.messages);

  // gmcli returns the whole (bounded) archive every run — the archive now
  // legitimately contains msg_1 (unchanged) plus a new msg_2.
  const run2Messages = [
    msg({ message_id: "msg_1", timestamp_ms: 1_754_071_452_000 }),
    msg({ message_id: "msg_2", timestamp_ms: 1_754_071_500_000 }),
  ];
  const run2 = await runGoogleMessagesCustom(chats, run2Messages, projected);
  const emitted = records(run2.messages, "messages");
  assert.equal(emitted.length, 1, "only the new message is emitted, not the unchanged one");
  assert.equal(emitted[0]?.id, "msg_2");

  const coverage = run2.messages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      m.type === "DETAIL_COVERAGE" && m.stream === "messages"
  );
  assert.equal(coverage?.considered, 2, "both fetched messages were considered, even though only one was emitted");
  assert.equal(
    coverage?.covered,
    2,
    "the unchanged message is still covered — its prior emission already durably queued it"
  );
});

// ─── Same-timestamp rows: two distinct ids sharing a timestamp both survive ─

test("same-timestamp rows: two distinct messages sharing sent_at are both emitted and both idempotent on resume", async () => {
  const chats = [CHAT_ALICE];
  const sameTs = 1_754_071_452_000;
  const messages = [
    msg({ message_id: "msg_a", timestamp_ms: sameTs, sender_id: "+15551230001" }),
    msg({ message_id: "msg_b", timestamp_ms: sameTs, sender_id: "+15551230002" }),
  ];

  const run1 = await runGoogleMessagesCustom(chats, messages, {});
  const emitted1 = records(run1.messages, "messages");
  assert.equal(emitted1.length, 2, "distinct ids at the same timestamp are both emitted, not collapsed");
  assert.deepEqual(sortedIds(emitted1), ["msg_a", "msg_b"]);

  const projected = projectState(run1.messages);
  const run2 = await runGoogleMessagesCustom(chats, messages, projected);
  assert.equal(
    records(run2.messages, "messages").length,
    0,
    "same-timestamp rows are keyed by id, not sent_at — both remain idempotent on an unchanged resume"
  );
});

// ─── Late rows: an older-timestamped message that only appears on run 2 ───

test("late rows: a message with an older sent_at than already-seen messages is still emitted when it first appears", async () => {
  const chats = [CHAT_ALICE];
  const run1Messages = [msg({ message_id: "msg_recent", timestamp_ms: 1_754_071_500_000 })];
  const run1 = await runGoogleMessagesCustom(chats, run1Messages, {});
  assert.equal(records(run1.messages, "messages").length, 1);
  const projected = projectState(run1.messages);

  // A late-arriving message with an OLDER sent_at than one already seen —
  // e.g. a delayed RCS delivery, or a message gmcli's archive only backfilled
  // after this run. Must still be discoverable: nothing about this
  // connector's cursor is time-ordered (it is a per-id fingerprint set, not
  // a `sent_at` high-watermark), so an older timestamp is never excluded.
  const run2Messages = [
    msg({ message_id: "msg_recent", timestamp_ms: 1_754_071_500_000 }),
    msg({ message_id: "msg_late", timestamp_ms: 1_754_071_400_000 }),
  ];
  const run2 = await runGoogleMessagesCustom(chats, run2Messages, projected);
  const emitted = records(run2.messages, "messages");
  assert.equal(emitted.length, 1, "only the newly-appearing late message is emitted");
  assert.equal(emitted[0]?.id, "msg_late", "an older-timestamped message is still discoverable on first appearance");
});

// ─── Truncation: per-chat limit hit still commits STATE for what was fetched ─

test("truncation: per-chat limit hit still commits a STATE watermark for the fetched window, plus an honest SKIP_RESULT", async () => {
  const chats = [CHAT_ALICE];
  const limit = 5;
  const messages = Array.from({ length: limit }, (_, i) =>
    msg({ message_id: `msg_${String(i)}`, timestamp_ms: 1_754_071_000_000 + i * 1000 })
  );

  const run1 = await runGoogleMessagesCustom(chats, messages, {}, { GMCLI_MESSAGES_PER_CHAT_LIMIT: String(limit) });
  assert.equal(records(run1.messages, "messages").length, limit, "every fetched (bounded) message is emitted");

  const truncationSkip = skips(run1.messages).find((s) => s.reason === "gmcli_per_chat_limit_reached");
  assert.ok(
    truncationSkip,
    "a per-chat-limit truncation must surface an honest SKIP_RESULT — never silently claim completeness"
  );

  const cursor = stateFor(run1.messages, "messages") as { fingerprints?: Record<string, string> } | undefined;
  assert.ok(
    cursor,
    "a bounded-but-honest fetch still commits STATE for the window it did fetch — this fixture's message set is unchanged between run1/run2, so the fetched window is stable across runs regardless of --order direction, and withholding STATE here would only force useless re-emission of the same bounded window forever"
  );
  assert.equal(Object.keys(cursor?.fingerprints ?? {}).length, limit);

  // Resuming against the identical (still-truncated) archive must not
  // re-duplicate the bounded prefix it already committed.
  const projected = projectState(run1.messages);
  const run2 = await runGoogleMessagesCustom(chats, messages, projected, {
    GMCLI_MESSAGES_PER_CHAT_LIMIT: String(limit),
  });
  assert.equal(
    records(run2.messages, "messages").length,
    0,
    "the already-committed bounded prefix is not re-emitted on resume"
  );
});

// ─── Crash before commit: a run that never reaches DONE leaves no partial checkpoint ─

test("crash before commit: a mid-run failure leaves the prior checkpoint intact, not a partial/fabricated one", async () => {
  const chats = [CHAT_ALICE];
  const run1Messages = [msg({ message_id: "msg_1", timestamp_ms: 1_754_071_452_000 })];
  const run1 = await runGoogleMessagesCustom(chats, run1Messages, {});
  const projected = projectState(run1.messages);
  assert.ok(projected.messages, "run 1 committed a real cursor to be at risk of loss");

  // Simulate a crash mid-fetch: the chats list call succeeds, but the
  // per-conversation messages list call returns malformed output, so
  // fetchAndParseGmcliMessages returns an outcome with `reason` set.
  // collect() returns before ever reaching the emit-loop / STATE-emit path
  // (see index.ts: `if (outcome.reason) { ...; return; }`), so this run
  // must emit no STATE
  // message and the previously-committed cursor must be exactly what a
  // subsequent run reads back — a real subprocess crash (not exit 0) would
  // additionally invalidate the run at the collector-runner.ts layer (a
  // pre-DONE STATE is never promoted to a server checkpoint unless the
  // connector terminally succeeded — see collector-runner.ts:1576-1588),
  // so this connector-level proof and that runtime-level guarantee compose:
  // neither layer can turn an interrupted run into a fabricated watermark.
  const run2 = await runGoogleMessagesCustom([CHAT_ALICE], [], projected, {
    FAKE_GMCLI_MODE: "malformed_messages",
  });
  assert.equal(
    stateFor(run2.messages, "messages"),
    undefined,
    "a failed fetch must emit no STATE this run — the prior checkpoint is left untouched, not overwritten with an empty/partial one"
  );
  const skip = skips(run2.messages).find((s) => s.stream === "messages");
  assert.ok(skip, "a failed fetch surfaces an honest SKIP_RESULT instead of a silent empty success");

  // A subsequent healthy run seeded from the ORIGINAL (pre-crash) projected
  // state must still suppress msg_1 — proving the crash run truly left the
  // prior checkpoint untouched rather than corrupting/losing it.
  const run3 = await runGoogleMessagesCustom(chats, run1Messages, projected);
  assert.equal(
    records(run3.messages, "messages").length,
    0,
    "the pre-crash checkpoint survived the failed run untouched"
  );
});

// ─── External archive replacement: a wholesale-different archive is treated as new data, not corruption ─

test("external archive replacement: a different (e.g. re-paired) archive's messages are all treated as new, not silently dropped", async () => {
  const run1Messages = [msg({ message_id: "msg_1", timestamp_ms: 1_754_071_452_000 })];
  const run1 = await runGoogleMessagesCustom([CHAT_ALICE], run1Messages, {});
  assert.equal(records(run1.messages, "messages").length, 1);
  const projected = projectState(run1.messages);

  // The archive was wholesale replaced (e.g. gmcli re-paired against a
  // different/reset device, or the local SQLite archive was rebuilt): a
  // brand-new chat with brand-new message ids, none of which collide with
  // the prior cursor's fingerprints.
  const NEW_CHAT: RawChat = {
    conversation_id: "chat_bob",
    source_platform: "rcs",
    name: "Bob",
    is_group: false,
    last_message_time_ms: 1_754_080_000_000,
  };
  const replacementMessages = [
    msg({ message_id: "replaced_msg_1", conversation_id: "chat_bob", timestamp_ms: 1_754_079_000_000 }),
    msg({ message_id: "replaced_msg_2", conversation_id: "chat_bob", timestamp_ms: 1_754_079_100_000 }),
  ];
  const run2 = await runGoogleMessagesCustom([NEW_CHAT], replacementMessages, projected);
  const emitted = records(run2.messages, "messages");
  assert.equal(
    emitted.length,
    2,
    "every message from the replacement archive is new relative to the old cursor, and must all be emitted"
  );
  assert.deepEqual(sortedIds(emitted), ["replaced_msg_1", "replaced_msg_2"]);

  // The cursor is carry-forward only (no pruneStale — see index.ts's STATE
  // doc comment: gmcli gives no deletion signal), so the old chat_alice/
  // msg_1 fingerprint is neither required nor asserted gone here; the point
  // under test is that the replacement's own messages are not silently
  // treated as already-seen (which would happen only on an id collision,
  // and a real re-pairing/archive-rebuild is exceedingly unlikely to
  // collide with prior message_ids).
  const cursor = stateFor(run2.messages, "messages") as { fingerprints?: Record<string, string> } | undefined;
  assert.ok(cursor?.fingerprints?.replaced_msg_1, "new archive's messages are recorded into the cursor");
  assert.ok(cursor?.fingerprints?.replaced_msg_2, "new archive's messages are recorded into the cursor");
});

// ─── STATE ordering: committed only after every RECORD this run has been queued ─

test("STATE is emitted after every messages RECORD this run, never before", async () => {
  const chats = [CHAT_ALICE];
  const messages = [
    msg({ message_id: "msg_1", timestamp_ms: 1_754_071_452_000 }),
    msg({ message_id: "msg_2", timestamp_ms: 1_754_071_453_000 }),
  ];
  const run1 = await runGoogleMessagesCustom(chats, messages, {});

  const stateIndex = run1.messages.findIndex((m) => m.type === "STATE" && m.stream === "messages");
  assert.ok(stateIndex >= 0, "expected a messages STATE message");
  const recordIndices = run1.messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.type === "RECORD" && m.stream === "messages")
    .map(({ i }) => i);
  assert.equal(recordIndices.length, 2);
  for (const recordIndex of recordIndices) {
    assert.ok(
      recordIndex < stateIndex,
      "every messages RECORD must precede the STATE emit that commits this run's cursor"
    );
  }
});
