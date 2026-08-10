// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Closes two red-team findings against the STATE-watermark change in
 * state-checkpoint.test.ts:
 *
 * (1) The per-chat fetch used `--order asc` (oldest-first). With a flat
 *     `--limit` and no pagination cursor, a conversation that ever hit its
 *     limit would fetch and permanently re-fetch the SAME oldest-N-message
 *     prefix forever — any newer message never entered a fetch at all, so
 *     the fingerprint cursor had nothing to evaluate it against and could
 *     never surface it. Fixed by switching to `--order desc` (newest-first)
 *     so a growing conversation's new activity stays inside the fetched
 *     window on every run. This is bounded monotonic tracking of the
 *     newest N messages, NOT historical convergence: older history beyond
 *     the newest N in a limit-hitting conversation is still never fetched
 *     by this connector on its own.
 *
 * (2) `GMCLI_MAX_CHATS` sliced `chats list`'s raw response order, which
 *     gmkit's source documents no ordering guarantee for — an arbitrary,
 *     source-order-dependent subset could be kept while an actively
 *     growing conversation got silently dropped from the scan entirely.
 *     Fixed by sorting chats by `last_message_time_ms` descending (ties
 *     broken by `conversation_id`) BEFORE the GMCLI_MAX_CHATS slice, and by
 *     emitting a new `messages` SKIP_RESULT (`gmcli_chat_scan_limit_reached`)
 *     whenever that slice actually drops chats, so a run that silently
 *     scanned only a subset of conversations cannot read as complete
 *     coverage. The reason code is generic and connector-authored, with its
 *     display copy declared in this connector's own manifest
 *     (`reason_display_messages`) — never in RI.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { sortChatsByRecency } from "./index.ts";

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

function idsOf(rows: readonly Record<string, unknown>[]): Set<string> {
  return new Set(rows.map((r) => String(r.id)));
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

function chat(overrides: Partial<RawChat> & Pick<RawChat, "conversation_id">): RawChat {
  return {
    source_platform: "rcs",
    name: overrides.conversation_id,
    is_group: false,
    ...overrides,
  };
}

function msg(
  overrides: Partial<RawMessage> & Pick<RawMessage, "message_id" | "timestamp_ms" | "conversation_id">
): RawMessage {
  return {
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

// ─── Finding 1: growing conversation stays observable with --order desc ───

test("finding 1 — growing conversation: a conversation past its per-chat limit still surfaces brand-new messages on the next run", async () => {
  const chats = [chat({ conversation_id: "chat_alice", last_message_time_ms: 2_000_000 })];
  const limit = 5;

  // Run 1: the conversation already has exactly `limit` messages — a
  // realistic "already at the cap" starting point.
  const run1Messages = Array.from({ length: limit }, (_, i) =>
    msg({ message_id: `m${String(i)}`, conversation_id: "chat_alice", timestamp_ms: 1_000_000 + i * 1000 })
  );
  const run1 = await runGoogleMessagesCustom(chats, run1Messages, {}, { GMCLI_MESSAGES_PER_CHAT_LIMIT: String(limit) });
  const run1Emitted = records(run1.messages, "messages");
  assert.equal(run1Emitted.length, limit, "run 1 emits every message in the (already full) window");
  assert.ok(
    idsOf(run1Emitted).has("m4"),
    "run 1's fetched window is the newest `limit` messages, so the most recent one (m4) is present"
  );

  // Project STATE the way the real runtime does (per-stream last-wins).
  const stateMsg = run1.messages.find(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === "messages"
  );
  assert.ok(stateMsg, "run 1 commits a STATE watermark");
  const projected = { messages: stateMsg?.cursor };

  // The conversation keeps growing: three brand-new messages arrive, newer
  // than everything in run 1. The archive itself now has limit+3 messages
  // for this chat — gmcli's `--limit` still only returns `limit` of them,
  // but WHICH `limit` depends entirely on --order.
  const run2Messages = [
    ...run1Messages,
    msg({ message_id: "m5", conversation_id: "chat_alice", timestamp_ms: 1_005_000 }),
    msg({ message_id: "m6", conversation_id: "chat_alice", timestamp_ms: 1_006_000 }),
    msg({ message_id: "m7", conversation_id: "chat_alice", timestamp_ms: 1_007_000 }),
  ];
  const run2 = await runGoogleMessagesCustom(chats, run2Messages, projected, {
    GMCLI_MESSAGES_PER_CHAT_LIMIT: String(limit),
  });
  const run2Emitted = records(run2.messages, "messages");
  const run2Ids = idsOf(run2Emitted);

  // This is the behavioral proof, not a literal argv assertion: the
  // connector's real output must contain the conversation's actual newest
  // messages, and must NOT be stuck re-observing only the original oldest
  // window forever.
  assert.ok(run2Ids.has("m5") && run2Ids.has("m6") && run2Ids.has("m7"), "the three brand-new messages are emitted");
  assert.ok(
    !(run2Ids.has("m0") || run2Ids.has("m1")),
    "the oldest messages in this still-truncated conversation are correctly NOT re-observed — they fell outside the newest-N window"
  );

  const truncationSkip = skips(run2.messages).find((s) => s.reason === "gmcli_per_chat_limit_reached");
  assert.ok(
    truncationSkip,
    "the conversation is still over its per-chat limit, so the existing honest per-chat SKIP_RESULT must still fire"
  );

  // A third run with no further growth must be a clean no-op — idempotency
  // is preserved by the fingerprint cursor regardless of fetch direction.
  const stateMsg2 = run2.messages.find(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === "messages"
  );
  const projected2 = { messages: stateMsg2?.cursor };
  const run3 = await runGoogleMessagesCustom(chats, run2Messages, projected2, {
    GMCLI_MESSAGES_PER_CHAT_LIMIT: String(limit),
  });
  assert.equal(
    records(run3.messages, "messages").length,
    0,
    "re-fetching the same (still-truncated) newest window a third time emits no duplicates"
  );
});

// ─── Finding 2: sortChatsByRecency (unit) ──────────────────────────────────

test("finding 2 — sortChatsByRecency: orders chats by last_message_time_ms descending", () => {
  const chats = [
    { id: "old", name: null, lastMessageTimeMs: 100 },
    { id: "newest", name: null, lastMessageTimeMs: 300 },
    { id: "mid", name: null, lastMessageTimeMs: 200 },
  ];
  const sorted = sortChatsByRecency(chats);
  assert.deepEqual(
    sorted.map((c) => c.id),
    ["newest", "mid", "old"]
  );
});

test("finding 2 — sortChatsByRecency: equal timestamps break ties by conversation_id ascending, deterministically", () => {
  const chats = [
    { id: "chat_z", name: null, lastMessageTimeMs: 500 },
    { id: "chat_a", name: null, lastMessageTimeMs: 500 },
    { id: "chat_m", name: null, lastMessageTimeMs: 500 },
  ];
  const sorted = sortChatsByRecency(chats);
  assert.deepEqual(
    sorted.map((c) => c.id),
    ["chat_a", "chat_m", "chat_z"],
    "equal timestamps must not depend on input order — sorted purely by id"
  );

  // Determinism: reversing the input order must not change the output.
  const sortedReversed = sortChatsByRecency([...chats].reverse());
  assert.deepEqual(
    sortedReversed.map((c) => c.id),
    ["chat_a", "chat_m", "chat_z"]
  );
});

test("finding 2 — sortChatsByRecency: missing/null last_message_time_ms sorts last, never wins priority over a real timestamp", () => {
  const chats = [
    { id: "no_timestamp_b", name: null, lastMessageTimeMs: null },
    { id: "has_timestamp", name: null, lastMessageTimeMs: 1 },
    { id: "no_timestamp_a", name: null, lastMessageTimeMs: null },
  ];
  const sorted = sortChatsByRecency(chats);
  assert.equal(sorted[0]?.id, "has_timestamp", "any real timestamp, however small, outranks a missing one");
  assert.deepEqual(
    sorted.slice(1).map((c) => c.id),
    ["no_timestamp_a", "no_timestamp_b"],
    "chats with no timestamp signal still get a deterministic, id-ordered tie-break among themselves"
  );
});

// ─── Finding 2: chat-scan truncation behavior (subprocess, end-to-end) ────

test("finding 2 — exact cap, no gap: chat count equal to GMCLI_MAX_CHATS scans everything, no truncation SKIP_RESULT", async () => {
  const maxChats = 3;
  const chats = [
    chat({ conversation_id: "chat_a", last_message_time_ms: 300 }),
    chat({ conversation_id: "chat_b", last_message_time_ms: 200 }),
    chat({ conversation_id: "chat_c", last_message_time_ms: 100 }),
  ];
  const messages = chats.map((c, i) =>
    msg({ message_id: `msg_${c.conversation_id}`, conversation_id: c.conversation_id, timestamp_ms: 1000 + i })
  );
  const run = await runGoogleMessagesCustom(chats, messages, {}, { GMCLI_MAX_CHATS: String(maxChats) });
  const emitted = records(run.messages, "messages");
  assert.equal(emitted.length, 3, "all three chats' messages are fetched — the count exactly meets the cap");
  assert.ok(
    !skips(run.messages).some((s) => s.reason === "gmcli_chat_scan_limit_reached"),
    "no chat-scan truncation SKIP_RESULT when the chat count does not exceed the cap"
  );
});

test("finding 2 — over cap, gap: chat count exceeding GMCLI_MAX_CHATS keeps the most recently active chats and emits a truncation SKIP_RESULT", async () => {
  const maxChats = 2;
  const chats = [
    chat({ conversation_id: "chat_oldest", last_message_time_ms: 100 }),
    chat({ conversation_id: "chat_newest", last_message_time_ms: 300 }),
    chat({ conversation_id: "chat_mid", last_message_time_ms: 200 }),
  ];
  const messages = chats.map((c) =>
    msg({ message_id: `msg_${c.conversation_id}`, conversation_id: c.conversation_id, timestamp_ms: 1000 })
  );
  const run = await runGoogleMessagesCustom(chats, messages, {}, { GMCLI_MAX_CHATS: String(maxChats) });
  const emitted = records(run.messages, "messages");
  const emittedChatIds = new Set(emitted.map((r) => r.chat_id));

  assert.deepEqual(
    emittedChatIds,
    new Set(["chat_newest", "chat_mid"]),
    "the two most recently active chats are kept; the oldest is dropped from this run's scan entirely"
  );

  const chatScanSkip = skips(run.messages).find((s) => s.reason === "gmcli_chat_scan_limit_reached");
  assert.ok(
    chatScanSkip,
    "a chat-list truncation must surface its own SKIP_RESULT, distinct from the per-chat message limit"
  );
  assert.match(chatScanSkip?.message ?? "", /1 of 3/);

  // This must never be framed as historical convergence.
  assert.doesNotMatch(
    chatScanSkip?.message ?? "",
    /eventually|will (be )?(caught up|converge)|all history/i,
    "the chat-scan-limit message must not claim eventual convergence — it only reports what was scanned this run"
  );
});

test("finding 2 — the chat-scan-limit reason has vetted display copy declared in this connector's own manifest, not in RI", async () => {
  const manifestModule = await import("../../manifests/google_messages.json", { with: { type: "json" } });
  const manifest = manifestModule.default as {
    reason_display_messages?: Record<string, string>;
  };
  assert.ok(manifest.reason_display_messages, "manifest must declare a reason_display_messages map");
  assert.ok(
    manifest.reason_display_messages?.gmcli_chat_scan_limit_reached,
    "gmcli_chat_scan_limit_reached must have vetted display copy in the manifest"
  );
  assert.ok(
    manifest.reason_display_messages?.gmcli_per_chat_limit_reached,
    "gmcli_per_chat_limit_reached must also have vetted display copy in the manifest"
  );
});
