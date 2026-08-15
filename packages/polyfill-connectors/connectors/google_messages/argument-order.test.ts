// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminating tests proving this connector's gmcli invocations use the
 * documented, source-verified CLI contract, not a guessed one: `chats
 * list` (never `messages search`), then `messages list --conv <id>` per
 * chat with the correct global-flag placement and bounding flags. Uses an
 * injected fake runner (not the fake-gmcli.mjs subprocess) so argument
 * arrays can be asserted directly, precisely, and independent of stdout
 * parsing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatsJsonFixture,
  buildEmptyChatsJsonFixture,
  buildMessagesJsonFixture,
  type GmcliResult,
} from "./fixtures.ts";
import { fetchAndParseGmcliMessages, type GmcliInvoker } from "./index.ts";

function ok(stdout: string): GmcliResult {
  return { exitCode: 0, stderr: "", stdout };
}

test("never invokes `messages search` — only `chats list` and `messages list`", async () => {
  const seenInvocations: string[][] = [];
  const invoker: GmcliInvoker = (args) => {
    seenInvocations.push([...args]);
    if (args[0] === "--json") {
      return Promise.resolve(ok(buildChatsJsonFixture()));
    }
    return Promise.resolve(ok(buildMessagesJsonFixture()));
  };
  await fetchAndParseGmcliMessages(invoker);
  for (const invocation of seenInvocations) {
    assert.ok(!invocation.includes("search"), `must never invoke 'messages search': saw ${JSON.stringify(invocation)}`);
  }
});

test("chats list is invoked with global flags before the subcommand, plus an explicit --limit sized to GMCLI_MAX_CHATS + 1", async () => {
  const priorMaxChats = process.env.GMCLI_MAX_CHATS;
  process.env.GMCLI_MAX_CHATS = "50";
  try {
    const seenInvocations: string[][] = [];
    const invoker: GmcliInvoker = (args) => {
      seenInvocations.push([...args]);
      if (args[0] === "--json") {
        return Promise.resolve(ok(buildEmptyChatsJsonFixture()));
      }
      return Promise.resolve(ok(buildMessagesJsonFixture()));
    };
    await fetchAndParseGmcliMessages(invoker);
    // Explicit --limit, sized to GMCLI_MAX_CHATS + 1 — NEVER left unset.
    // gmcli's own `chats list` defaults --limit to 50 server-side when the
    // flag is absent (verified from gmkit's Go source), which would
    // silently cap chat enumeration upstream of this connector's own
    // GMCLI_MAX_CHATS bookkeeping. The +1 (not exactly GMCLI_MAX_CHATS) is
    // what makes "exactly at the cap" distinguishable from "truncated" —
    // see fetchAndParseGmcliMessages's doc comment.
    assert.deepEqual(seenInvocations[0], ["--json", "--full", "chats", "list", "--limit", "51"]);
  } finally {
    if (priorMaxChats === undefined) {
      delete process.env.GMCLI_MAX_CHATS;
    } else {
      process.env.GMCLI_MAX_CHATS = priorMaxChats;
    }
  }
});

test("messages list is invoked with --conv <chat-id> and per-chat bounding/order flags", async () => {
  const seenInvocations: string[][] = [];
  const invoker: GmcliInvoker = (args) => {
    seenInvocations.push([...args]);
    if (args[0] === "--json") {
      return Promise.resolve(ok(buildChatsJsonFixture()));
    }
    return Promise.resolve(ok(buildMessagesJsonFixture()));
  };
  await fetchAndParseGmcliMessages(invoker);
  const messagesInvocation = seenInvocations.find((a) => a[0] === "messages");
  assert.ok(messagesInvocation, "expected a messages list invocation");
  assert.equal(messagesInvocation?.[0], "messages");
  assert.equal(messagesInvocation?.[1], "list");
  const convIdx = messagesInvocation?.indexOf("--conv") ?? -1;
  assert.ok(convIdx >= 0, "expected --conv flag");
  assert.equal(messagesInvocation?.[convIdx + 1], "chat_alice");
  assert.ok(messagesInvocation?.includes("--json"));
  assert.ok(messagesInvocation?.includes("--full"));
  assert.ok(messagesInvocation?.includes("--limit"));
  const orderIdx = messagesInvocation?.indexOf("--order") ?? -1;
  assert.ok(orderIdx >= 0, "expected --order flag");
  assert.equal(
    messagesInvocation?.[orderIdx + 1],
    "desc",
    "must fetch newest-first so a growing conversation's new activity stays observable across runs (see fetchChatMessages's doc comment)"
  );
});

test("one messages list invocation per chat, in the order chats were listed", async () => {
  const twoChats = JSON.stringify([
    { conversation_id: "chat_a", source_platform: "rcs", name: "A" },
    { conversation_id: "chat_b", source_platform: "rcs", name: "B" },
  ]);
  const seenConvIds: string[] = [];
  const invoker: GmcliInvoker = (args) => {
    if (args[0] === "--json") {
      return Promise.resolve(ok(twoChats));
    }
    const convIdx = args.indexOf("--conv");
    seenConvIds.push(args[convIdx + 1] ?? "");
    return Promise.resolve(ok(buildEmptyChatsJsonFixtureAsMessages()));
  };
  await fetchAndParseGmcliMessages(invoker);
  assert.deepEqual(seenConvIds, ["chat_a", "chat_b"]);
});

function buildEmptyChatsJsonFixtureAsMessages(): string {
  return "[]";
}
