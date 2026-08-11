// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Closes red-team findings against the STATE-watermark change in
 * state-checkpoint.test.ts, across two review passes:
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
 * (2) `GMCLI_MAX_CHATS` sliced `chats list`'s raw response order. Sorting
 *     chats by `last_message_time_ms` descending (ties broken by
 *     `conversation_id`) BEFORE the `GMCLI_MAX_CHATS` slice, plus a new
 *     `messages` SKIP_RESULT (`gmcli_chat_scan_limit_reached`) whenever
 *     that slice actually drops chats, so a run that silently scanned only
 *     a subset of conversations cannot read as complete coverage. NOTE:
 *     an earlier version of this fix's rationale wrongly claimed gmcli's
 *     `chats list` has "no ordering guarantee" — verified against gmkit's
 *     real Go source, it DOES sort server-side (`ORDER BY last_message_ts
 *     DESC, updated_at DESC`). This connector's own sort is a determinism/
 *     tie-break improvement on top of an already-recency-sorted response,
 *     not a correction of an unordered one (see sortChatsByRecency's doc
 *     comment in index.ts).
 *
 * (3) An independent second-pass red-team review (see
 *     /tmp/google-messages-tail-redteam-0810.md) found that (2)'s fix was
 *     itself silently defeated: `fetchAndParseGmcliMessages` never passed
 *     `--limit` to `gmcli chats list` at all. Verified against gmkit's real
 *     Go source (`internal/cmd/chats.go`'s `chatsListCmd`,
 *     `IntVar(&limit, "limit", 50, ...)`, and `internal/store/
 *     conversations.go`'s `ListConversations`, `if limit <= 0 { limit = 50
 *     }`): an unset `--limit` silently caps the response at 50 chats
 *     UPSTREAM of this connector's own `GMCLI_MAX_CHATS` (default 200)
 *     bookkeeping. `orderedChats.length > maxChats` could never be true
 *     when the fetch itself never returned more than 50 rows, so
 *     `gmcli_chat_scan_limit_reached` — the entire deliverable of fix
 *     (2) — never fired for any real archive with more than 50
 *     conversations, and the SKIP_RESULT's own "increase GMCLI_MAX_CHATS"
 *     recovery instruction had zero effect. Fixed by passing an explicit
 *     `--limit` of `maxChats + 1` to `chats list` — the `+1`, not exactly
 *     `maxChats`, is what makes "the archive has exactly maxChats
 *     conversations" distinguishable from "the archive has more, but the
 *     probe fetch itself got capped at maxChats" (see
 *     fetchAndParseGmcliMessages's doc comment in index.ts for the full
 *     rationale, which mirrors the same "exact cap vs. truncation is
 *     unknowable without one extra row" logic this connector already
 *     applies to the per-chat message limit).
 *
 * (4) A reason-ownership coordination pass (packages/polyfill-connectors/
 *     src/reason-emission-scan.ts, on the reason-messages-current-0809
 *     lane) proved that `collect()`'s `await emit({ type: "SKIP_RESULT",
 *     stream: "messages", ...outcome.skip })` silently evaded the bounded,
 *     AST-based reason-completeness scanner: a SpreadElement in a
 *     SKIP_RESULT construction is opaque to that scanner's dataflow
 *     resolution, so every reason code this connector emits (gmcli_not_
 *     installed, gmcli_not_paired, gmcli_query_failed, gmcli_schema_drift)
 *     would have gone unchecked for manifest display-copy completeness. An
 *     initial fix destructured `outcome.skip.reason`/`outcome.skip.message`
 *     into explicit emit-site properties — still opaque to the scanner,
 *     since a nested `x.y.reason` member chain needs resolution depth
 *     beyond its deliberately bounded one-hop scope, same as a spread.
 *     Closed at the source instead: `GmcliFetchOutcome` carries `reason`/
 *     `message` as flat top-level fields (no `skip` nesting at all), so the
 *     emit-site `reason: outcome.reason` is a plain one-hop `x.reason`
 *     MemberExpression the scanner's existing same-file-call-result
 *     resolution already handles — no generalized spread or member-chain
 *     dataflow was added to the scanner itself.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { fetchAndParseGmcliMessages, GmcliError, type GmcliInvoker, sortChatsByRecency } from "./index.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "google_messages", "index.ts");
const FAKE_GMCLI = join(PACKAGE_ROOT, "connectors", "google_messages", "fixtures", "fake-gmcli.mjs");
const INDEX_SOURCE = readFileSync(ENTRYPOINT, "utf8");

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
  env: Record<string, string> = {},
  timeoutMs = 15_000
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
    timeoutMs,
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
  // The chats-list probe fetches GMCLI_MAX_CHATS + 1 (here 3), which
  // happens to equal the true archive size in this fixture, so the
  // "at least" lower bound is exact here — but the message is phrased as a
  // lower bound ("at least N"), never a precise total, because the probe
  // itself is bounded and a larger real archive would not be fully seen
  // (see GmcliFetchOutcome's chatsTruncated doc comment).
  assert.match(chatScanSkip?.message ?? "", /Only the 2 most recently active conversations were scanned/);
  assert.match(chatScanSkip?.message ?? "", /at least 3 conversation\(s\) exist/);

  // This must never be framed as historical convergence.
  assert.doesNotMatch(
    chatScanSkip?.message ?? "",
    /eventually|will (be )?(caught up|converge)|all history/i,
    "the chat-scan-limit message must not claim eventual convergence — it only reports what was scanned this run"
  );
});

// ─── Finding 3: chats-list --limit must be explicit, sized past gmcli's own hidden 50-default ─

test("finding 3 — chats list always carries an explicit --limit argv, never relies on gmcli's own default", async () => {
  const seenInvocations: string[][] = [];
  const invoker: GmcliInvoker = (args) => {
    seenInvocations.push([...args]);
    if (args[0] === "--json") {
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "[]" });
    }
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: "[]" });
  };
  const priorMaxChats = process.env.GMCLI_MAX_CHATS;
  process.env.GMCLI_MAX_CHATS = "200";
  try {
    await fetchAndParseGmcliMessages(invoker);
  } finally {
    if (priorMaxChats === undefined) {
      delete process.env.GMCLI_MAX_CHATS;
    } else {
      process.env.GMCLI_MAX_CHATS = priorMaxChats;
    }
  }
  const chatsListInvocation = seenInvocations.find((a) => a[2] === "chats" && a[3] === "list");
  assert.ok(chatsListInvocation, "expected a chats list invocation");
  const limitIdx = chatsListInvocation?.indexOf("--limit") ?? -1;
  assert.ok(
    limitIdx >= 0,
    "chats list MUST always pass an explicit --limit — gmcli's own default (50, verified from gmkit source) would silently cap the response upstream of GMCLI_MAX_CHATS if omitted"
  );
  assert.equal(
    chatsListInvocation?.[limitIdx + 1],
    "201",
    "the probe limit must be GMCLI_MAX_CHATS + 1 (here 200 + 1), not exactly GMCLI_MAX_CHATS, so exact-cap and over-cap are distinguishable"
  );
});

test("finding 3 — behavioral: an archive with more chats than gmcli's own hidden 50-default is fully scanned when GMCLI_MAX_CHATS is set above 50", async () => {
  // This is the exact scenario the independent red-team report identified:
  // a real archive with more than 50 conversations, and a GMCLI_MAX_CHATS
  // set well above 50 (60 here — deliberately > gmcli's own hidden
  // default so the old defect, if reintroduced, would silently truncate
  // at 50 and never reach this test's chats). Before the fix, the
  // connector's own `chats list` invocation carried no --limit, so gmcli
  // itself would return only its default 50 rows — 5 real conversations
  // would vanish with zero signal, and `orderedChats.length > maxChats`
  // (50 > 60) would be false, suppressing the truncation SKIP_RESULT that
  // should never have needed to fire here at all (55 <= 60, genuinely no
  // truncation).
  const chatCount = 55;
  const maxChats = 60;
  const chats = Array.from({ length: chatCount }, (_, i) =>
    chat({ conversation_id: `chat_${String(i).padStart(3, "0")}`, last_message_time_ms: 1_000_000 + i * 1000 })
  );
  const messages = chats.map((c) =>
    msg({ message_id: `msg_${c.conversation_id}`, conversation_id: c.conversation_id, timestamp_ms: 1000 })
  );
  const run = await runGoogleMessagesCustom(chats, messages, {}, { GMCLI_MAX_CHATS: String(maxChats) }, 60_000);
  const emitted = records(run.messages, "messages");
  const emittedChatIds = new Set(emitted.map((r) => r.chat_id));

  assert.equal(
    emittedChatIds.size,
    chatCount,
    `all ${String(chatCount)} conversations must be scanned — none may be silently dropped by gmcli's own hidden default limit`
  );
  for (const c of chats) {
    assert.ok(emittedChatIds.has(c.conversation_id), `${c.conversation_id} must have been scanned`);
  }

  assert.ok(
    !skips(run.messages).some((s) => s.reason === "gmcli_chat_scan_limit_reached"),
    "55 <= 60 is genuinely not truncated — no chat-scan SKIP_RESULT should fire"
  );
});

test("finding 3 — behavioral: an archive genuinely exceeding GMCLI_MAX_CHATS past the 50-row hidden default is still correctly detected as truncated", async () => {
  // Complements the test above: here the archive (70 chats) exceeds
  // GMCLI_MAX_CHATS (60) AND exceeds gmcli's own hidden 50-default. The
  // fixed probe (--limit 61) must still see enough of the archive (61 of
  // 70 rows) to correctly detect truncation and keep the 60 most recently
  // active — not silently cap at 50 and miss the truncation signal
  // entirely (the pre-fix defect), and not silently cap at 50 and
  // incorrectly retain only 50 recently-active chats instead of 60.
  const chatCount = 70;
  const maxChats = 60;
  const chats = Array.from({ length: chatCount }, (_, i) =>
    chat({ conversation_id: `chat_${String(i).padStart(3, "0")}`, last_message_time_ms: 1_000_000 + i * 1000 })
  );
  const messages = chats.map((c) =>
    msg({ message_id: `msg_${c.conversation_id}`, conversation_id: c.conversation_id, timestamp_ms: 1000 })
  );
  const run = await runGoogleMessagesCustom(chats, messages, {}, { GMCLI_MAX_CHATS: String(maxChats) }, 60_000);
  const emitted = records(run.messages, "messages");
  const emittedChatIds = new Set(emitted.map((r) => r.chat_id));

  assert.equal(
    emittedChatIds.size,
    maxChats,
    `exactly the ${String(maxChats)}-chat cap should be scanned, not gmcli's hidden 50`
  );
  // The 60 kept must be the 60 MOST RECENT (indices 10..69 — last_message_time_ms
  // ascends with index), not an arbitrary or gmcli-default-order subset.
  for (let i = 0; i < 10; i += 1) {
    assert.ok(
      !emittedChatIds.has(`chat_${String(i).padStart(3, "0")}`),
      `chat_${String(i).padStart(3, "0")} is among the 10 oldest and must be dropped, not kept in place of a more recent chat`
    );
  }
  for (let i = 10; i < chatCount; i += 1) {
    assert.ok(
      emittedChatIds.has(`chat_${String(i).padStart(3, "0")}`),
      `chat_${String(i).padStart(3, "0")} is among the 60 most recently active and must be kept`
    );
  }

  const chatScanSkip = skips(run.messages).find((s) => s.reason === "gmcli_chat_scan_limit_reached");
  assert.ok(
    chatScanSkip,
    "70 > 60 must be detected as truncated, even though gmcli's own hidden default (50) is also exceeded"
  );
  assert.match(chatScanSkip?.message ?? "", /Only the 60 most recently active conversations were scanned/);
  // The probe fetches maxChats + 1 = 61 rows; the archive has 70. The
  // connector can only honestly claim "at least 61 exist", NOT the true 70
  // — it has no visibility past its own bounded probe.
  assert.match(chatScanSkip?.message ?? "", /at least 61 conversation\(s\) exist/);
});

// ─── Finding 3: exact-boundary determinism ─────────────────────────────────

test("finding 3 — exact boundary: archive size exactly GMCLI_MAX_CHATS + 1 is correctly detected as truncated by exactly one chat", async () => {
  const maxChats = 5;
  const chatCount = maxChats + 1;
  const chats = Array.from({ length: chatCount }, (_, i) =>
    chat({ conversation_id: `chat_${String(i).padStart(2, "0")}`, last_message_time_ms: 1_000_000 + i * 1000 })
  );
  const messages = chats.map((c) =>
    msg({ message_id: `msg_${c.conversation_id}`, conversation_id: c.conversation_id, timestamp_ms: 1000 })
  );
  const run = await runGoogleMessagesCustom(chats, messages, {}, { GMCLI_MAX_CHATS: String(maxChats) });
  const emitted = records(run.messages, "messages");
  const emittedChatIds = new Set(emitted.map((r) => r.chat_id));

  assert.equal(
    emittedChatIds.size,
    maxChats,
    "exactly maxChats chats are scanned when the archive has one more than the cap"
  );
  assert.ok(
    !emittedChatIds.has("chat_00"),
    "the single oldest chat (index 0, the one beyond the cap) must be the one dropped"
  );

  const chatScanSkip = skips(run.messages).find((s) => s.reason === "gmcli_chat_scan_limit_reached");
  assert.ok(
    chatScanSkip,
    "one chat over the cap must still be detected — the +1 probe margin exists precisely for this boundary"
  );
  assert.match(chatScanSkip?.message ?? "", new RegExp(`at least ${String(chatCount)} conversation\\(s\\) exist`));
});

// ─── Finding 4: SKIP_RESULT emission must never spread a connector-owned shape ─

test("finding 4 — collect() never spreads outcome.skip into the emitted SKIP_RESULT (opaque to the reason-emission scanner)", () => {
  // A SpreadElement inside `emit({ type: "SKIP_RESULT", ... })` is exactly
  // the shape the reason-emission scanner cannot resolve — it fails closed
  // on it rather than guessing. This pins the source-level fix: no
  // `...outcome.skip`-shaped spread anywhere in a SKIP_RESULT construction,
  // AND no nested member chain (`outcome.skip.reason`) either — the
  // reason-emission-scan.ts completeness scanner's one-hop resolution
  // bound cannot follow either shape without deepening past what it's
  // deliberately scoped to (see reason-messages-current-0809's
  // /tmp/reason-messages-redteam-0810.md finding 2 and its follow-up: the
  // fix moved from "destructure the nested object one level" to
  // "GmcliFetchOutcome carries flat reason/message fields directly, no
  // nesting at all" once the scanner's one-hop bound turned out not to
  // reach even the destructured nested form).
  assert.doesNotMatch(
    INDEX_SOURCE,
    /type:\s*["']SKIP_RESULT["'][^}]*\.\.\.\w+(\.\w+)*/su,
    "a SKIP_RESULT emission must never spread a connector-owned object — write reason/message as explicit properties instead"
  );
  assert.doesNotMatch(
    INDEX_SOURCE,
    /reason:\s*outcome\.skip\.reason/u,
    "GmcliFetchOutcome must carry reason/message as flat top-level fields, not nested under skip — a nested member chain is also opaque to the completeness scanner's one-hop bound"
  );
  assert.match(
    INDEX_SOURCE,
    /reason:\s*outcome\.reason,\s*message:\s*outcome\.message/u,
    "expected the flat reason/message emission this fix introduced"
  );
});

test("finding 4 — behavioral: distinct reason code paths still surface their correct, distinct reason/message after skip was flattened to top-level fields", async () => {
  // Two different code sites that both populate GmcliFetchOutcome's flat
  // reason/message fields — classifyGmcliFetchError's not_installed
  // branch, and fetchAndParseGmcliMessages's own schema-drift branch —
  // proving the flattened `reason: outcome.reason, message: outcome.message`
  // emission at the call site carries each one through unchanged, not just
  // whichever single path integration.test.ts happens to exercise via
  // subprocess.
  const notInstalledInvoker: GmcliInvoker = () =>
    Promise.reject(new GmcliError("gmcli binary not found: gmcli", "not_installed"));
  const notInstalledOutcome = await fetchAndParseGmcliMessages(notInstalledInvoker);
  assert.equal(notInstalledOutcome.reason, "gmcli_not_installed");
  assert.match(notInstalledOutcome.message ?? "", /gmcli binary not found/);

  const schemaDriftInvoker: GmcliInvoker = () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "not json" });
  const schemaDriftOutcome = await fetchAndParseGmcliMessages(schemaDriftInvoker);
  assert.equal(schemaDriftOutcome.reason, "gmcli_schema_drift");
  assert.ok(schemaDriftOutcome.message, "gmcli_schema_drift must carry a non-empty message");
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
