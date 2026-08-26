// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end integration tests for the Signal connector, driven through
 * the real subprocess entrypoint (index.ts) via
 * `runConnectorProtocolSubprocess` — same pattern imessage/integration.test.ts
 * uses. `SIGTOP_BIN` is pointed at a mock sigtop script (fixtures.ts's
 * `setupMockSigtop`) rather than a real `sigtop` install: no real sigtop
 * binary and no real Signal account are available in this environment, so
 * this is the honest limit of what can be proven here — see index.ts's
 * module doc for what remains unverified (a real sigtop run, a real
 * account, non-Linux platforms).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { buildSignalExportFixture, setupMockSigtop } from "./fixtures.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "signal", "index.ts");

function records(messages: readonly EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD")
    .filter((m) => m.stream === stream)
    .map((m) => m.data);
}

function skips(messages: readonly EmittedMessage[]): Extract<EmittedMessage, { type: "SKIP_RESULT" }>[] {
  return messages.filter((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
}

function states(messages: readonly EmittedMessage[]): Extract<EmittedMessage, { type: "STATE" }>[] {
  return messages.filter((m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE");
}

function runSignal(
  scriptPath: string,
  streams: string[],
  env: Record<string, string> = {},
  state: Record<string, unknown> = {}
) {
  return runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: {
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
      SIGTOP_BIN: scriptPath,
      ...env,
    },
    start: {
      scope: { streams: streams.map((name) => ({ name })) },
      state,
      type: "START",
    },
  });
}

const CONV_A = "11111111-1111-1111-1111-111111111111";
const CONV_B = "44444444-4444-4444-4444-444444444444";
const SENDER = "33333333-3333-3333-3333-333333333333";
// The sender's own resolved conversations.id, distinct from CONV_A (the
// chat thread) and SENDER (the raw ACI/PNI service-id column value) — see
// index.ts's messagesSelect doc: `sender` resolves through
// `LEFT JOIN conversations AS c ON m.sourceServiceId = c.serviceId`,
// selecting c.id, matching sigtop's own sender resolution.
const SENDER_CONV_ID = "66666666-6666-6666-6666-666666666666";

test("signal reports a failed DONE when sigtop is not on PATH / SIGTOP_BIN is wrong", async () => {
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: { SIGTOP_BIN: "/nonexistent/definitely-not-sigtop" },
    start: { scope: { streams: [{ name: "messages" }] }, state: {}, type: "START" },
  });
  const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
  assert.equal(done?.status, "failed");
  assert.match(done?.error?.message ?? "", /sigtop_not_found/);
  assert.match(done?.error?.message ?? "", /Install sigtop/);
});

test("signal reports a failed DONE when check-database fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-"));
  try {
    const scriptPath = setupMockSigtop(
      dir,
      { messages: [] },
      { checkDatabaseExitCode: 1, checkDatabaseStdout: "integrity check failed: foo" }
    );
    const result = await runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: PACKAGE_ROOT,
      entrypoint: ENTRYPOINT,
      env: { SIGTOP_BIN: scriptPath },
      start: { scope: { streams: [{ name: "messages" }] }, state: {}, type: "START" },
    });
    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.equal(done?.status, "failed");
    assert.match(done?.error?.message ?? "", /signal_db_check_failed/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signal emits messages with a monotonic sent_at cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-"));
  try {
    const t0 = Date.parse("2024-06-05T13:00:00.000Z");
    const scriptPath = setupMockSigtop(dir, {
      conversations: [
        { id: CONV_A, name: "Alice", type: "private" },
        { id: SENDER_CONV_ID, name: "Bob", serviceId: SENDER, type: "private" },
      ],
      messages: [
        {
          body: "hey",
          conversationId: CONV_A,
          id: "22222222-2222-2222-2222-222222222222",
          sentAt: t0,
          sourceServiceId: SENDER,
          type: "incoming",
        },
        {
          body: "hi back",
          conversationId: CONV_A,
          id: "55555555-5555-5555-5555-555555555555",
          sentAt: t0 + 60_000,
          sourceServiceId: null,
          type: "outgoing",
        },
      ],
    });

    const result = await runSignal(scriptPath, ["messages"]);
    const msgs = records(result.messages, "messages");
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]?.conversation_id, CONV_A);
    // sender resolves through the sourceServiceId -> conversations.serviceId
    // join to the sender's own conversations.id (SENDER_CONV_ID), not the
    // raw sourceServiceId (SENDER) — matching sigtop's own resolution.
    assert.equal(msgs[0]?.sender, SENDER_CONV_ID);
    assert.equal(msgs[1]?.sender, null);

    const state = states(result.messages).find((s) => s.stream === "messages");
    assert.ok(state, "expected a messages STATE checkpoint");
    const cursor = state.cursor as { last_sent_at_ms: number };
    assert.equal(cursor.last_sent_at_ms, t0 + 60_000);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signal cursor carries forward: a second run with prior STATE only emits newer messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-"));
  try {
    const t0 = Date.parse("2024-06-05T13:00:00.000Z");
    const scriptPath = setupMockSigtop(dir, {
      conversations: [{ id: CONV_A, name: "Alice", type: "private" }],
      messages: [
        {
          body: "first",
          conversationId: CONV_A,
          id: "22222222-2222-2222-2222-222222222222",
          sentAt: t0,
          sourceServiceId: SENDER,
          type: "incoming",
        },
        {
          body: "second",
          conversationId: CONV_A,
          id: "55555555-5555-5555-5555-555555555555",
          sentAt: t0 + 120_000,
          sourceServiceId: SENDER,
          type: "incoming",
        },
      ],
    });

    const first = await runSignal(scriptPath, ["messages"], {}, { messages: { last_sent_at_ms: t0 - 1 } });
    assert.equal(records(first.messages, "messages").length, 2);

    const second = await runSignal(scriptPath, ["messages"], {}, { messages: { last_sent_at_ms: t0 } });
    const secondMsgs = records(second.messages, "messages");
    assert.equal(secondMsgs.length, 1);
    assert.equal(secondMsgs[0]?.id, "55555555-5555-5555-5555-555555555555");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signal skips a message with no usable sent_at/received_at_ms deterministically instead of stamping the run clock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-"));
  try {
    const t0 = Date.parse("2024-06-05T13:00:00.000Z");
    const scriptPath = setupMockSigtop(dir, {
      messages: [
        {
          body: "no date",
          conversationId: CONV_A,
          id: "22222222-2222-2222-2222-222222222222",
          receivedAtMs: null,
          sentAt: null,
        },
        { body: "has date", conversationId: CONV_A, id: "55555555-5555-5555-5555-555555555555", sentAt: t0 },
      ],
    });

    const result = await runSignal(scriptPath, ["messages"]);
    const msgs = records(result.messages, "messages");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]?.id, "55555555-5555-5555-5555-555555555555");

    const skip = skips(result.messages).find((s) => s.stream === "messages");
    assert.ok(skip, "expected a messages SKIP_RESULT for the null-date row");
    assert.equal(skip?.reason, "message_date_unusable");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signal derives has_attachments/is_edited from the message json blob", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-"));
  try {
    const t0 = Date.parse("2024-06-05T13:00:00.000Z");
    const scriptPath = setupMockSigtop(dir, {
      messages: [
        {
          body: "photo",
          conversationId: CONV_A,
          id: "22222222-2222-2222-2222-222222222222",
          json: JSON.stringify({ attachments: [{ path: "a" }], editHistory: [{ body: "old" }] }),
          sentAt: t0,
        },
        {
          body: "plain",
          conversationId: CONV_A,
          id: "55555555-5555-5555-5555-555555555555",
          json: JSON.stringify({}),
          sentAt: t0 + 1000,
        },
      ],
    });

    const result = await runSignal(scriptPath, ["messages"]);
    const msgs = records(result.messages, "messages");
    const withAttachments = msgs.find((m) => m.id === "22222222-2222-2222-2222-222222222222");
    const plain = msgs.find((m) => m.id === "55555555-5555-5555-5555-555555555555");
    assert.equal(withAttachments?.has_attachments, true);
    assert.equal(withAttachments?.is_edited, true);
    assert.equal(plain?.has_attachments, false);
    assert.equal(plain?.is_edited, false);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signal emits conversations as a full resnapshot with null member_count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-"));
  try {
    const scriptPath = setupMockSigtop(dir, {
      conversations: [
        { id: CONV_A, name: "Alice", type: "private" },
        { groupId: "group-xyz", id: CONV_B, name: "Team Chat", type: "group" },
      ],
      messages: [],
    });

    const result = await runSignal(scriptPath, ["conversations"]);
    const convs = records(result.messages, "conversations");
    assert.equal(convs.length, 2);
    const byId = new Map(convs.map((c) => [c.id, c]));
    assert.equal(byId.get(CONV_A)?.type, "private");
    assert.equal(byId.get(CONV_A)?.title, "Alice");
    assert.equal(byId.get(CONV_B)?.type, "group");
    // member_count is never fabricated — see parsers.ts's buildConversationRecord doc.
    assert.equal(byId.get(CONV_A)?.member_count, null);
    assert.equal(byId.get(CONV_B)?.member_count, null);

    const state = states(result.messages).find((s) => s.stream === "conversations");
    assert.ok(state, "expected a conversations STATE checkpoint");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signal derives reactions from message json without a standalone reactions table", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-"));
  try {
    const t0 = Date.parse("2024-06-05T13:00:00.000Z");
    const scriptPath = setupMockSigtop(dir, {
      messages: [
        {
          body: "look at this",
          conversationId: CONV_A,
          id: "22222222-2222-2222-2222-222222222222",
          json: JSON.stringify({
            reactions: [
              { emoji: "👍", fromId: SENDER, targetTimestamp: t0 },
              { emoji: "❤️", fromId: "other-sender", targetTimestamp: t0 },
            ],
          }),
          sentAt: t0,
        },
      ],
    });

    const result = await runSignal(scriptPath, ["messages", "reactions"]);
    const reactions = records(result.messages, "reactions");
    assert.equal(reactions.length, 2);
    const byEmoji = new Map(reactions.map((r) => [r.emoji, r]));
    assert.equal(byEmoji.get("👍")?.sender, SENDER);
    assert.equal(byEmoji.get("👍")?.message_id, "22222222-2222-2222-2222-222222222222");
    assert.equal(byEmoji.get("❤️")?.sender, "other-sender");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signal derives reactions when only the reactions stream is requested (messages not in scope)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-"));
  try {
    const t0 = Date.parse("2024-06-05T13:00:00.000Z");
    const scriptPath = setupMockSigtop(dir, {
      messages: [
        {
          body: "x",
          conversationId: CONV_A,
          id: "22222222-2222-2222-2222-222222222222",
          json: JSON.stringify({ reactions: [{ emoji: "👍", fromId: SENDER, targetTimestamp: t0 }] }),
          sentAt: t0,
        },
      ],
    });

    const result = await runSignal(scriptPath, ["reactions"]);
    // messages was never requested: no messages RECORD/SKIP_RESULT traffic.
    assert.equal(records(result.messages, "messages").length, 0);
    assert.equal(skips(result.messages).filter((s) => s.stream === "messages").length, 0);
    // reactions is still derived from the underlying message rows.
    const reactions = records(result.messages, "reactions");
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0]?.emoji, "👍");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signal hydrates an exported attachment and joins metadata from message_attachments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-"));
  try {
    const t0 = Date.parse("2024-06-05T13:00:00.000Z");
    const messageId = "22222222-2222-2222-2222-222222222222";
    const bytes = Buffer.from([1, 2, 3, 4]);
    const scriptPath = setupMockSigtop(
      dir,
      {
        messageAttachments: [
          { contentType: "image/jpeg", fileName: "IMG_0001.jpg", messageId, size: bytes.byteLength },
        ],
        messages: [{ body: null, conversationId: CONV_A, id: messageId, sentAt: t0 }],
      },
      { attachments: [{ bytes, conversationDir: "Alice", filename: "IMG_0001.jpg" }] }
    );

    const result = await runSignal(scriptPath, ["attachments"]);
    const attachments = records(result.messages, "attachments");
    assert.equal(attachments.length, 1);
    const [a] = attachments;
    assert.equal(a?.hydration_status, "deferred");
    assert.equal(a?.filename, "IMG_0001.jpg");
    assert.equal(a?.content_type, "image/jpeg");
    assert.equal(a?.message_id, messageId);
    assert.equal(a?.size_bytes, bytes.byteLength);
    assert.match(String(a?.content_sha256), /^[0-9a-f]{64}$/);
    // id is a sha256 of the local export path, never the raw path itself.
    assert.match(String(a?.id), /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signal attachment metadata degrades to null on a schema without message_attachments, bytes still hydrate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-"));
  try {
    const bytes = Buffer.from([9, 9, 9]);
    const scriptPath = setupMockSigtop(
      dir,
      { includeMessageAttachmentsTable: false, messages: [] },
      { attachments: [{ bytes, conversationDir: "Bob", filename: "note.txt" }] }
    );

    const result = await runSignal(scriptPath, ["attachments"]);
    const [a] = records(result.messages, "attachments");
    assert.equal(a?.hydration_status, "deferred");
    assert.equal(a?.message_id, null);
    assert.equal(a?.content_type, "application/octet-stream");
    assert.match(String(a?.content_sha256), /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signal SKIP_RESULTs the attachments stream when sigtop exports nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-"));
  try {
    const scriptPath = setupMockSigtop(dir, { messages: [] }, { attachments: [] });
    const result = await runSignal(scriptPath, ["attachments"]);
    assert.equal(records(result.messages, "attachments").length, 0);
    const skip = skips(result.messages).find((s) => s.stream === "attachments");
    assert.ok(skip, "expected an attachments SKIP_RESULT");
    assert.equal(skip?.reason, "no_attachments_exported");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signal.json declares tier=development and no consent_time_field claim beyond messages.sent_at", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifestPath = join(PACKAGE_ROOT, "manifests", "signal.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    capabilities?: { public_listing?: { tier?: string } };
    streams: Array<{ name: string; consent_time_field?: string }>;
  };
  assert.equal(manifest.capabilities?.public_listing?.tier, "development");
  const messages = manifest.streams.find((s) => s.name === "messages");
  assert.equal(messages?.consent_time_field, "sent_at");
});

// Sanity check on the fixture builder itself, independent of the mock
// sigtop wiring: proves buildSignalExportFixture produces a database this
// connector's own SQL (messagesSelect/conversationsSelect column names)
// can actually query without a runtime SQL error, catching a fixture/schema
// drift before it manifests as a confusing subprocess-level failure.
test("buildSignalExportFixture produces a database queryable by the connector's own column names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-signal-fixture-"));
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = join(dir, "test.sqlite");
    buildSignalExportFixture(dbPath, {
      conversations: [{ id: CONV_A, name: "Alice", type: "private" }],
      messages: [{ body: "hi", conversationId: CONV_A, id: "22222222-2222-2222-2222-222222222222", sentAt: 1000 }],
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT id, conversationId, sourceServiceId, sent_at, received_at_ms, body, type, json FROM messages")
        .all();
      assert.equal(rows.length, 1);
      const convRows = db.prepare("SELECT id, type, name, e164, serviceId, groupId FROM conversations").all();
      assert.equal(convRows.length, 1);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
