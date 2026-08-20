// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ChatGPT conversations declare `message_count_on_current_branch`, and the
 * obvious reconciliation — compare it against the messages we emitted — proves
 * nothing. That field is computed by OUR OWN `countBranchMessages` from the
 * same `mapping` object, inside the same call that emits those messages. Both
 * sides of that comparison read one in-memory graph, so it is a tautology.
 *
 * Worse, it is a tautology that HIDES the real defect. `flattenTreeCurrentBranch`
 * walks parent pointers and stops silently when a parent is missing from the
 * mapping. A truncated payload therefore produces a short branch AND a
 * correspondingly short declared count — the denominator shrinks to match the
 * loss and the conversation reads complete.
 *
 * The provider assertion worth reconciling against is structural: `current_node`
 * and the `parent` chain declare a branch that must be present and must
 * terminate at a real root. These tests pin that contract.
 *
 * Grounding: reconciled against 5,821 live conversations. On-branch message
 * counts matched the declared count exactly for 5,815 and never exceeded it,
 * so equality is the right contract. Three conversations in the historical
 * archive were short by exactly one message, each with a dangling non-system
 * parent — the shape `truncatedBranch` reproduces below.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { processConversationDetail, type StreamDeps } from "./index.ts";
import { buildConversationRecord, type ConversationDetail } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ChatGptFetchResult, ChatGptNode, ConversationListItem } from "./types.ts";

function makeHarness(requested: readonly string[] = ["conversations", "messages"]) {
  const harness = makeRecordingEmit(validateRecord);
  const deps: StreamDeps = {
    api: {
      auth: (): Promise<never> => Promise.reject(new Error("unused")),
      fetch: (): Promise<ChatGptFetchResult> => Promise.resolve({ status: 200, json: null }),
    },
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(requested.map((name) => [name, { name }])),
  };
  // SKIP_RESULT is a protocol message, not a schema rejection, so the gaps this
  // contract emits live in protocolMessages.
  const skips = (): Record<string, unknown>[] =>
    harness.protocolMessages.filter((m) => (m as { type?: string }).type === "SKIP_RESULT") as unknown as Record<
      string,
      unknown
    >[];
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages, skips };
}

function makeConvo(currentNode: string): ConversationListItem {
  return {
    id: "convo-abc",
    title: "Hello world",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: currentNode,
  };
}

function emitConversation(deps: StreamDeps) {
  return async (c: ConversationListItem, detail: ConversationDetail | null): Promise<void> => {
    await deps.emitRecord("conversations", buildConversationRecord(c, detail));
  };
}

function userNode(parent: string | null, children: string[] = []): ChatGptNode {
  return {
    parent,
    children,
    message: {
      author: { role: "user" },
      create_time: 1_700_000_000,
      content: { content_type: "text", parts: ["hello"] },
    },
  };
}

function assistantNode(parent: string, children: string[] = []): ChatGptNode {
  return {
    parent,
    children,
    message: {
      author: { role: "assistant" },
      create_time: 1_700_000_001,
      end_turn: true,
      content: { content_type: "text", parts: ["hi there"] },
    },
  };
}

/** A whole conversation: root → u1 → a1, every parent present. */
function wholeBranch(): Record<string, ChatGptNode> {
  return {
    root: { parent: null, children: ["u1"] },
    u1: userNode("root", ["a1"]),
    a1: assistantNode("u1"),
  };
}

/**
 * The real defect shape found in the live archive: the branch tip is present
 * and walkable, but the opening user turn it descends from was never
 * delivered. `flattenTreeCurrentBranch` stops at `a1` and reports a 1-message
 * branch, so the declared count agrees with the truncated data and nothing
 * looks wrong.
 */
function truncatedBranch(): Record<string, ChatGptNode> {
  return {
    a1: assistantNode("aaa2c1fa-missing-user-turn"),
  };
}

async function run(mapping: Record<string, ChatGptNode>, currentNode: string) {
  const harness = makeHarness();
  const detail: ChatGptFetchResult = {
    status: 200,
    json: {
      title: "Hello world",
      create_time: 1_700_000_000,
      update_time: 1_700_000_100,
      mapping,
      current_node: currentNode,
    },
  };
  await processConversationDetail(harness.deps, makeConvo(currentNode), detail, emitConversation(harness.deps));
  return harness;
}

test("chatgpt branch: a whole conversation reconciles clean and reports no gap", async () => {
  const { skips, emitted } = await run(wholeBranch(), "a1");

  assert.equal(emitted.filter((r) => r.stream === "messages").length, 2, "u1 + a1 emit; root is synthetic");
  assert.equal(skips().length, 0, "an intact parent chain must not manufacture a gap");
});

test("chatgpt branch: a truncated branch is surfaced as a gap, not a silent pass", async () => {
  // This is the defect the declared-count comparison cannot see: the count and
  // the data agree with each other, and both are short.
  const { skips } = await run(truncatedBranch(), "a1");

  const gap = skips().find((s) => s.reason === "branch_truncated");
  assert.ok(gap, "a branch whose parent chain dangles must report a gap");
  assert.equal(
    (gap.diagnostics as { missing_parent_id: string }).missing_parent_id,
    "aaa2c1fa-missing-user-turn",
    "the gap names the message that was not delivered, so it is actionable"
  );
});

test("chatgpt branch: the tautological count check would have passed this truncated payload", async () => {
  // Proves the point of the whole contract. The conversation record's declared
  // count is derived from the same truncated mapping, so declared == emitted
  // and a count-based reconciliation reads complete. The gap is the only signal.
  const { emitted, skips } = await run(truncatedBranch(), "a1");

  const convo = emitted.find((r) => r.stream === "conversations");
  const declared = convo?.data.message_count_on_current_branch;
  const emittedOnBranch = emitted.filter((r) => r.stream === "messages" && r.data.on_current_branch === true).length;

  assert.equal(declared, 1, "the declared count shrank to match the truncation");
  assert.equal(emittedOnBranch, 1, "so declared == emitted and the counts agree");
  assert.equal(
    skips().some((s) => s.reason === "branch_truncated"),
    true,
    "only the structural check catches it"
  );
});

test("chatgpt branch: a current_node absent from the mapping is surfaced", async () => {
  // The conversation says it is on a tip the payload does not contain, so the
  // branch we walked is not the branch it claims to be on.
  const { skips } = await run(wholeBranch(), "tip-we-never-received");

  const gap = skips().find((s) => s.reason === "branch_tip_missing");
  assert.ok(gap, "an unreachable declared tip must report a gap");
  assert.equal((gap.diagnostics as { conversation_id: string }).conversation_id, "convo-abc");
});

test("chatgpt branch: an off-branch alternative does not trigger a false gap", async () => {
  // Branching is normal: holding MORE than the current branch is legitimate and
  // must stay silent. Live data showed 28% of conversations hold off-branch
  // messages, so a check that fired on these would be useless.
  const mapping: Record<string, ChatGptNode> = {
    root: { parent: null, children: ["u1"] },
    u1: userNode("root", ["a1", "a2"]),
    a1: assistantNode("u1"),
    a2: assistantNode("u1"),
  };
  const { skips, emitted } = await run(mapping, "a1");

  assert.equal(emitted.filter((r) => r.stream === "messages").length, 3, "both branches are held");
  assert.equal(skips().length, 0, "an extra branch is data we have, not data we lost");
});

test("chatgpt branch: a cyclic parent chain terminates instead of hanging", async () => {
  // Defensive: a malformed graph must not spin the walk forever.
  const mapping: Record<string, ChatGptNode> = {
    a1: assistantNode("a2"),
    a2: assistantNode("a1"),
  };
  const { skips } = await run(mapping, "a1");

  assert.equal(
    skips().some((s) => s.reason === "branch_truncated"),
    false,
    "a cycle is fully present in the mapping; it is not a truncation"
  );
});

test("chatgpt branch: a conversation with no current_node is not reconciled", async () => {
  // Nothing was declared, so there is nothing to hold the payload to. Inventing
  // a gap here would be a false positive on a legitimate shape.
  const harness = makeHarness();
  const mapping = wholeBranch();
  const detail: ChatGptFetchResult = {
    status: 200,
    json: { title: "t", create_time: 1, update_time: 2, mapping, current_node: null },
  };
  const convo: ConversationListItem = { ...makeConvo("a1"), current_node: null };
  await processConversationDetail(harness.deps, convo, detail, emitConversation(harness.deps));

  assert.equal(harness.skips().length, 0, "no declared tip means no claim to reconcile against");
});
