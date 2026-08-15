// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the chat-identity reconciliation-alias design (index.ts's
 * openChatIdentityCursor) does NOT silently merge two distinct chats that
 * happen to share a participant list, while still giving a genuine
 * re-export of the SAME chat (overlapping message content, different
 * filename/date-range) a stable chatId across runs.
 *
 * A first-draft design (identityKey -> ONE chatId, first-seen wins) would
 * have merged these two distinct-chats-same-participants exports under one
 * chatId — caught and rejected before shipping (see index.ts's
 * openChatIdentityCursor doc comment). These tests are the fail-before/
 * pass-after proof for that correction.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const WHATSAPP_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "whatsapp", "index.ts");

function chatRecords(messages: readonly EmittedMessage[]): Record<string, unknown>[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD" && m.stream === "chats")
    .map((m) => m.data);
}

function messageRecords(messages: readonly EmittedMessage[]): Record<string, unknown>[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD" && m.stream === "messages")
    .map((m) => m.data);
}

function stateFor(messages: readonly EmittedMessage[], stream: string): unknown {
  const state = messages.find(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === stream
  );
  return state?.cursor;
}

function progressTexts(messages: readonly EmittedMessage[]): string[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS")
    .map((m) => m.message);
}

async function runImport(importRoot: string, state?: Record<string, unknown>): Promise<{ messages: EmittedMessage[] }> {
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: WHATSAPP_ENTRYPOINT,
    env: {
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
      TZ: "America/Chicago",
      WHATSAPP_EXPORT_DIR: importRoot,
    },
    start: {
      scope: { streams: [{ name: "chats" }, { name: "messages" }] },
      type: "START",
      ...(state ? { state } : {}),
    },
  });
  return { messages: result.messages };
}

test("two DISTINCT chats sharing the same participant list stay distinct, not silently merged", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-whatsapp-same-participants-"));
  try {
    // Same participants (Alice, Bob), completely different conversation
    // content and timestamps -- these must be recognized as two DIFFERENT
    // chats, not merged into one under the shared participant-set identity
    // key.
    await writeFile(
      join(importRoot, "chat-one.txt"),
      [
        "[6/5/24, 9:15:22 AM] Alice: Hey Bob, are we still on for the trip?",
        "[6/5/24, 9:16:00 AM] Bob: Yes! See you at 10.",
      ].join("\n")
    );
    await writeFile(
      join(importRoot, "chat-two.txt"),
      [
        "[1/2/23, 3:05:00 PM] Alice: Bob, did you finish the quarterly report?",
        "[1/2/23, 3:10:00 PM] Bob: Almost done, sending it tonight.",
      ].join("\n")
    );

    const { messages } = await runImport(importRoot);
    const chats = chatRecords(messages);
    assert.equal(chats.length, 2, "expected two distinct chat records, not one merged chat");

    const chatIds = new Set(chats.map((c) => c.id));
    assert.equal(chatIds.size, 2, `expected two distinct chatIds, got: ${JSON.stringify([...chatIds])}`);

    // The messages from each chat must carry that chat's own chat_id, and
    // no message from chat-one's content should end up attributed to
    // chat-two's chatId or vice versa.
    const msgs = messageRecords(messages);
    assert.equal(msgs.length, 4);
    const chatIdsForTripMessages = new Set(
      msgs.filter((m) => String(m.content).includes("trip")).map((m) => m.chat_id)
    );
    const chatIdsForReportMessages = new Set(
      msgs.filter((m) => String(m.content).includes("report")).map((m) => m.chat_id)
    );
    assert.equal(chatIdsForTripMessages.size, 1);
    assert.equal(chatIdsForReportMessages.size, 1);
    assert.notEqual([...chatIdsForTripMessages][0], [...chatIdsForReportMessages][0]);

    // The ambiguity must be surfaced, not silent.
    const texts = progressTexts(messages).join("\n");
    assert.match(texts, /shares its participant list with a different, already-imported chat/i);
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("a genuine re-export of the SAME chat (overlapping content, different filename) reuses the same chatId across runs", async () => {
  const importRootRun1 = await mkdtemp(join(tmpdir(), "pdpp-whatsapp-reexport-1-"));
  const importRootRun2 = await mkdtemp(join(tmpdir(), "pdpp-whatsapp-reexport-2-"));
  try {
    // Run 1: original export.
    await writeFile(
      join(importRootRun1, "WhatsApp Chat with Alice.txt"),
      [
        "[6/5/24, 9:15:22 AM] Alice: Hey, are we still on for tomorrow?",
        "[6/5/24, 9:16:00 AM] Bob: Yes! See you at 10.",
      ].join("\n")
    );
    const run1 = await runImport(importRootRun1);
    const run1ChatId = chatRecords(run1.messages)[0]?.id;
    assert.ok(run1ChatId, "expected a chatId from run 1");

    const priorState = {
      chats: stateFor(run1.messages, "chats"),
      messages: stateFor(run1.messages, "messages"),
    };

    // Run 2: re-export with a DIFFERENT filename (the common real-world
    // case: WhatsApp/the OS appends "(1)" to avoid overwriting) AND
    // additional later history appended, but overlapping content (the
    // original two messages are still present).
    await writeFile(
      join(importRootRun2, "WhatsApp Chat with Alice (1).txt"),
      [
        "[6/5/24, 9:15:22 AM] Alice: Hey, are we still on for tomorrow?",
        "[6/5/24, 9:16:00 AM] Bob: Yes! See you at 10.",
        "[6/6/24, 8:00:00 AM] Alice: That was fun yesterday!",
      ].join("\n")
    );
    const run2 = await runImport(importRootRun2, priorState);
    const run2ChatId = chatRecords(run2.messages)[0]?.id;

    assert.equal(run2ChatId, run1ChatId, "a genuine re-export with overlapping content must reuse the same chatId");

    // No ambiguity diagnostic should fire for a real re-export.
    const texts = progressTexts(run2.messages).join("\n");
    assert.doesNotMatch(texts, /shares its participant list with a different, already-imported chat/i);
  } finally {
    await rm(importRootRun1, { force: true, recursive: true });
    await rm(importRootRun2, { force: true, recursive: true });
  }
});

test("alias-list growth per identityKey is capped, not unbounded (H4)", async () => {
  // 25 distinct, zero-overlap "chats" all sharing the same participant set
  // (Alice, Bob), imported one per run with the growing STATE carried
  // forward -- each one is genuinely a NEW distinct chat by content, so
  // each SHOULD mint a new alias under index.ts's design, up to
  // MAX_ALIASES_PER_IDENTITY_KEY (20). Past the cap, further distinct
  // chats must still import successfully (never dropped/crashed) but must
  // NOT keep growing the persisted alias list forever -- proving the cap
  // is real, not just documented.
  const importRoots: string[] = [];
  try {
    let state: Record<string, unknown> | undefined;
    let lastMessages: EmittedMessage[] = [];
    const totalDistinctChats = 25;
    for (let i = 0; i < totalDistinctChats; i += 1) {
      const importRoot = await mkdtemp(join(tmpdir(), `pdpp-whatsapp-alias-cap-${i}-`));
      importRoots.push(importRoot);
      await writeFile(
        join(importRoot, "chat.txt"),
        [
          `[1/${(i % 12) + 1}/20, 3:0${i % 10}:00 PM] Alice: unique conversation number ${i} about topic ${i}`,
          `[1/${(i % 12) + 1}/20, 3:1${i % 10}:00 PM] Bob: reply to conversation ${i}`,
        ].join("\n")
      );
      const run = await runImport(importRoot, state);
      lastMessages = run.messages;
      state = {
        chats: stateFor(run.messages, "chats"),
        messages: stateFor(run.messages, "messages"),
      };
    }

    // Every run must have actually imported its one distinct chat -- the
    // cap must never cause a chat to be silently dropped.
    const finalChatState = state?.messages as { chat_identity?: { aliases?: Record<string, unknown[]> } } | undefined;
    const aliasLists = Object.values(finalChatState?.chat_identity?.aliases ?? {});
    assert.equal(aliasLists.length, 1, "expected exactly one identityKey (one shared participant set)");
    const aliasCount = (aliasLists[0] as unknown[]).length;
    // Exact, not <=: once at MAX_ALIASES_PER_IDENTITY_KEY, index.ts stops
    // minting new aliases and never evicts existing ones (see its own
    // overflow-chatId comment), so 25 distinct chats against a cap of 20
    // deterministically plateaus at exactly 20 -- a `<=` here would not
    // catch a regression that silently lowered the cap.
    assert.equal(
      aliasCount,
      20,
      `expected alias-list growth capped at exactly 20, found ${aliasCount} aliases after ${totalDistinctChats} distinct chats`
    );

    // The LAST run (past the cap) must still have imported successfully.
    const [lastChat] = chatRecords(lastMessages);
    assert.ok(lastChat, "expected the chat past the alias cap to still be imported, not dropped");
    const lastDone = lastMessages.at(-1);
    assert.equal(lastDone?.type, "DONE");
    if (lastDone?.type === "DONE") {
      assert.equal(lastDone.status, "succeeded");
    }
  } finally {
    await Promise.all(importRoots.map((root) => rm(root, { force: true, recursive: true })));
  }
});

test("two distinct chats sharing participants, seen across SEPARATE runs (not one run), still stay distinct", async () => {
  const importRootRun1 = await mkdtemp(join(tmpdir(), "pdpp-whatsapp-ambiguous-1-"));
  const importRootRun2 = await mkdtemp(join(tmpdir(), "pdpp-whatsapp-ambiguous-2-"));
  try {
    await writeFile(
      join(importRootRun1, "chat-one.txt"),
      [
        "[6/5/24, 9:15:22 AM] Alice: Hey Bob, are we still on for the trip?",
        "[6/5/24, 9:16:00 AM] Bob: Yes! See you at 10.",
      ].join("\n")
    );
    const run1 = await runImport(importRootRun1);
    const run1ChatId = chatRecords(run1.messages)[0]?.id;
    assert.ok(run1ChatId);

    const priorState = {
      chats: stateFor(run1.messages, "chats"),
      messages: stateFor(run1.messages, "messages"),
    };

    // A SEPARATE run, same participants, zero overlapping content -- the
    // reconciliation map from run 1 is loaded from STATE, not just held in
    // one process's memory, so this proves the alias persistence survives
    // a real process boundary, not just an in-memory Map within one run.
    await writeFile(
      join(importRootRun2, "chat-two.txt"),
      [
        "[1/2/23, 3:05:00 PM] Alice: Bob, did you finish the quarterly report?",
        "[1/2/23, 3:10:00 PM] Bob: Almost done, sending it tonight.",
      ].join("\n")
    );
    const run2 = await runImport(importRootRun2, priorState);
    const run2ChatId = chatRecords(run2.messages)[0]?.id;

    assert.notEqual(run2ChatId, run1ChatId, "a distinct chat across separate runs must NOT be merged via STATE");

    const texts = progressTexts(run2.messages).join("\n");
    assert.match(texts, /shares its participant list with a different, already-imported chat/i);
  } finally {
    await rm(importRootRun1, { force: true, recursive: true });
    await rm(importRootRun2, { force: true, recursive: true });
  }
});
