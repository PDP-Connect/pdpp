/**
 * Orchestration-level proof of claude_code's parent-first two-pass emit
 * structure. Runs the real `scanProjectDirs` against a synthetic
 * `~/.claude/projects` tree in `tmpdir()`, then calls the real
 * `emitSessionsFromAccumulators`, then runs `scanProjectDirs` a second
 * time with `buildOnly: false`. Proves end-to-end that:
 *
 *   1. Pass 1 (buildOnly=true) populates accumulators and emits no child records.
 *   2. Sessions emit before messages/attachments in the full run.
 *   3. Pass 2 emits the expected child records.
 *   4. No double-count: the session record's message_count matches the
 *      number of message lines in the synthetic fixture exactly once.
 *
 * Regression scenarios this test catches (and unit tests don't):
 *   - buildOnly leak on pass 1 (messages emitted silently)
 *   - pass 2 short-circuit (no child records emitted at all)
 *   - sessions emitted after messages (parent-first regression)
 *   - accumulator double-count (message_count=2N because pass 2 also
 *     called updateSessionAccumulator)
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { emitSessionsFromAccumulators, type ScanProjectDirsArgs, scanProjectDirs } from "./index.ts";
import type { SessionAccumulator } from "./types.ts";

/** Write a minimal synthetic project tree:
 *    <baseDir>/<projectDir>/<sessionId>.jsonl
 *    <baseDir>/<projectDir>/<sessionId>/subagents/nested/side.jsonl
 *    <baseDir>/<projectDir>/memory/nested/note.md
 *
 * `baseDir` is passed to scanProjectDirs as-is (in production this is
 * `~/.claude/projects`). The JSONL has one `user` line and one
 * `assistant` line for the session, then one `attachment` line.
 * processJsonlLine's observe pass pins sessionId from line 1's
 * `sessionId` field.
 */
const SYNTHETIC_SESSION_ID = "12345678-1234-orch";
const MIXED_AGENT_USER_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MIXED_AGENT_PARENT_SESSION_ID = "22222222-2222-4222-8222-222222222222";

async function makeSyntheticProjectTree(): Promise<{ baseDir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pdpp-cc-orch-"));
  const projectDir = join(root, "-Users-test-my-project");
  await mkdir(projectDir, { recursive: true });
  const sessionFile = join(projectDir, `${SYNTHETIC_SESSION_ID}.jsonl`);
  const subagentsDir = join(projectDir, SYNTHETIC_SESSION_ID, "subagents", "nested");
  const memoryDir = join(projectDir, "memory", "nested");
  await mkdir(subagentsDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  const lines = [
    {
      sessionId: SYNTHETIC_SESSION_ID,
      type: "user",
      uuid: "m1",
      timestamp: "2026-04-23T10:00:00Z",
      message: { content: "hello" },
      cwd: "/Users/user/my-project",
    },
    {
      sessionId: SYNTHETIC_SESSION_ID,
      type: "assistant",
      uuid: "m2",
      timestamp: "2026-04-23T10:00:01Z",
      message: { content: "hi back" },
    },
    {
      sessionId: SYNTHETIC_SESSION_ID,
      type: "attachment",
      uuid: "a1",
      timestamp: "2026-04-23T10:00:02Z",
      description: "file-history-snapshot",
    },
  ];
  await writeFile(sessionFile, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
  await writeFile(
    join(subagentsDir, "side.jsonl"),
    `${JSON.stringify({
      sessionId: "wrong-sidechain-session",
      type: "assistant",
      uuid: "side-m1",
      timestamp: "2026-04-23T10:00:03Z",
      isSidechain: true,
      agentId: "agent-1",
      message: { content: "sidechain reply" },
    })}\n`,
    "utf8"
  );
  await writeFile(join(memoryDir, "note.md"), "---\ntitle: Memory Note\n---\nremember this", "utf8");

  return {
    baseDir: root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function makeRequested(streams: readonly string[]): Map<string, StreamScope> {
  return new Map(streams.map((name) => [name, { name }]));
}

/** Silent emit side-channel — we only care about emitRecord for ordering
 *  assertions. PROGRESS messages from scanProjectDirs are fine to ignore. */
function silentEmit(): (msg: EmittedMessage) => Promise<void> {
  return (): Promise<void> => Promise.resolve();
}

test("scanProjectDirs: pass 1 (buildOnly=true) populates accumulators but emits no child records", async () => {
  const { baseDir, cleanup } = await makeSyntheticProjectTree();
  try {
    const harness = makeRecordingEmit();
    const sessionAccumulators = new Map<string, SessionAccumulator>();
    const fileMtimes: Record<string, number> = {};
    const newMtimes: Record<string, number> = {};
    const requested = makeRequested(["sessions", "messages", "attachments", "memory_notes"]);

    const args: ScanProjectDirsArgs = {
      baseDir,
      buildOnly: true,
      emit: silentEmit(),
      emitRecord: harness.emitRecord,
      fileMtimes,
      newMtimes,
      requested,
      sessionAccumulators,
    };

    await scanProjectDirs(args);

    assert.equal(harness.emitted.filter((r) => r.stream === "messages").length, 0, "buildOnly=true emits no messages");
    assert.equal(
      harness.emitted.filter((r) => r.stream === "attachments").length,
      0,
      "buildOnly=true emits no attachments"
    );
    assert.equal(
      harness.emitted.filter((r) => r.stream === "memory_notes").length,
      1,
      "memory note emits on build pass"
    );
    assert.equal(sessionAccumulators.size, 1, "exactly one session observed");
    const acc = sessionAccumulators.get(SYNTHETIC_SESSION_ID);
    assert.ok(acc, "session accumulator present");
    assert.equal(acc.message_count, 3, "accumulated top-level plus recursive subagent message lines");
  } finally {
    await cleanup();
  }
});

test("scanProjectDirs: full two-pass — sessions emit BEFORE messages (parent-first end-to-end)", async () => {
  const { baseDir, cleanup } = await makeSyntheticProjectTree();
  try {
    const harness = makeRecordingEmit();
    const sessionAccumulators = new Map<string, SessionAccumulator>();
    const fileMtimes: Record<string, number> = {};
    const newMtimes: Record<string, number> = {};
    const requested = makeRequested(["sessions", "messages", "attachments", "memory_notes"]);

    // Pass 1: build accumulators silently.
    await scanProjectDirs({
      baseDir,
      buildOnly: true,
      emit: silentEmit(),
      emitRecord: harness.emitRecord,
      fileMtimes,
      newMtimes,
      requested,
      sessionAccumulators,
    });

    // Emit sessions.
    await emitSessionsFromAccumulators({
      emitRecord: harness.emitRecord,
      requested,
      sessionAccumulators,
    });

    // Pass 2: emit children.
    await scanProjectDirs({
      baseDir,
      buildOnly: false,
      emit: silentEmit(),
      emitRecord: harness.emitRecord,
      fileMtimes,
      newMtimes,
      requested,
      sessionAccumulators,
    });

    // Parent-first: session record before any child record.
    const firstSession = harness.emitted.findIndex((r) => r.stream === "sessions");
    const firstMessage = harness.emitted.findIndex((r) => r.stream === "messages");
    const firstAttachment = harness.emitted.findIndex((r) => r.stream === "attachments");

    assert.notEqual(firstSession, -1, "sessions record emitted");
    assert.notEqual(firstMessage, -1, "message record emitted");
    assert.notEqual(firstAttachment, -1, "attachment record emitted");
    assert.ok(firstSession < firstMessage, "sessions must precede messages");
    assert.ok(firstSession < firstAttachment, "sessions must precede attachments");

    // Exactly one of each child type — no double-emit from pass 1.
    const sessionCount = harness.emitted.filter((r) => r.stream === "sessions").length;
    const messageCount = harness.emitted.filter((r) => r.stream === "messages").length;
    const attachmentCount = harness.emitted.filter((r) => r.stream === "attachments").length;
    assert.equal(sessionCount, 1);
    const memoryNoteCount = harness.emitted.filter((r) => r.stream === "memory_notes").length;
    assert.equal(messageCount, 3);
    assert.equal(attachmentCount, 1);
    assert.equal(memoryNoteCount, 1);

    // Message_count on the session record is the correct count, not doubled.
    const sessionRec = harness.emitted[firstSession];
    assert.equal(sessionRec?.data.message_count, 3, "no accumulator double-count from pass 2");
    const sidechain = harness.emitted.find((r) => r.stream === "messages" && r.data.id === "side-m1");
    assert.equal(sidechain?.data.session_id, SYNTHETIC_SESSION_ID, "recursive subagent folds into parent session");
  } finally {
    await cleanup();
  }
});

test("scanProjectDirs: unchanged file mtime skips child records on an incremental pass", async () => {
  const { baseDir, cleanup } = await makeSyntheticProjectTree();
  try {
    const requested = makeRequested(["messages", "attachments"]);
    const sessionAccumulators = new Map<string, SessionAccumulator>();
    const firstPass = makeRecordingEmit();
    const firstMtimes: Record<string, number> = {};
    const newMtimes: Record<string, number> = {};

    await scanProjectDirs({
      baseDir,
      buildOnly: false,
      emit: silentEmit(),
      emitRecord: firstPass.emitRecord,
      fileMtimes: firstMtimes,
      newMtimes,
      requested,
      sessionAccumulators,
    });

    assert.equal(firstPass.emitted.filter((r) => r.stream === "messages").length, 3, "first pass emits messages");
    assert.equal(Object.keys(newMtimes).length, 2, "top-level and recursive subagent mtimes captured");

    const secondPass = makeRecordingEmit();
    await scanProjectDirs({
      baseDir,
      buildOnly: false,
      emit: silentEmit(),
      emitRecord: secondPass.emitRecord,
      fileMtimes: { ...newMtimes },
      newMtimes: {},
      requested,
      sessionAccumulators: new Map(),
    });

    assert.equal(secondPass.emitted.length, 0, "unchanged mtimes skip re-emitting child records");
  } finally {
    await cleanup();
  }
});

test("scanProjectDirs: session aggregation can backfill independently from message mtimes", async () => {
  const { baseDir, cleanup } = await makeSyntheticProjectTree();
  try {
    const requestedChildren = makeRequested(["messages", "attachments"]);
    const firstPass = makeRecordingEmit();
    const messageMtimes: Record<string, number> = {};

    await scanProjectDirs({
      baseDir,
      buildOnly: false,
      emit: silentEmit(),
      emitRecord: firstPass.emitRecord,
      fileMtimes: {},
      newMtimes: messageMtimes,
      requested: requestedChildren,
      sessionAccumulators: new Map(),
    });

    assert.equal(firstPass.emitted.filter((r) => r.stream === "messages").length, 3, "message state is current");
    assert.equal(Object.keys(messageMtimes).length, 2, "message cursor captured JSONL mtimes");

    const requestedSessions = makeRequested(["sessions"]);
    const sessionAccumulators = new Map<string, SessionAccumulator>();
    const sessionMtimes: Record<string, number> = {};

    await scanProjectDirs({
      baseDir,
      buildOnly: true,
      emit: silentEmit(),
      emitRecord: makeRecordingEmit().emitRecord,
      fileMtimes: {},
      newMtimes: sessionMtimes,
      requested: requestedSessions,
      sessionAccumulators,
    });

    assert.equal(
      sessionAccumulators.size,
      1,
      "empty session cursor reparses JSONL even when message cursor is current"
    );
    assert.equal(
      Object.keys(sessionMtimes).length,
      Object.keys(messageMtimes).length,
      "session cursor is captured separately"
    );
  } finally {
    await cleanup();
  }
});

test("scanProjectDirs: one top-level agent JSONL can emit summaries for each per-line session id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-cc-mixed-agent-"));
  const projectDir = join(root, "-Users-test-mixed-agent");
  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "agent-example.jsonl"),
      `${[
        {
          sessionId: MIXED_AGENT_USER_SESSION_ID,
          type: "user",
          uuid: "33333333-3333-4333-8333-333333333333",
          timestamp: "2026-04-23T10:00:00.000Z",
          cwd: "/Users/user/mixed-agent",
          message: { content: "delegate task" },
        },
        {
          sessionId: MIXED_AGENT_PARENT_SESSION_ID,
          type: "assistant",
          uuid: "44444444-4444-4444-8444-444444444444",
          parentUuid: "33333333-3333-4333-8333-333333333333",
          timestamp: "2026-04-23T10:00:01.000Z",
          cwd: "/Users/user/mixed-agent",
          message: { content: "worker accepted" },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
      "utf8"
    );

    const requested = makeRequested(["sessions", "messages"]);
    const sessionAccumulators = new Map<string, SessionAccumulator>();
    const harness = makeRecordingEmit();

    await scanProjectDirs({
      baseDir: root,
      buildOnly: true,
      emit: silentEmit(),
      emitRecord: harness.emitRecord,
      fileMtimes: {},
      newMtimes: {},
      requested,
      sessionAccumulators,
    });
    await emitSessionsFromAccumulators({ emitRecord: harness.emitRecord, requested, sessionAccumulators });
    await scanProjectDirs({
      baseDir: root,
      buildOnly: false,
      emit: silentEmit(),
      emitRecord: harness.emitRecord,
      fileMtimes: {},
      newMtimes: {},
      requested,
      sessionAccumulators,
    });

    const sessions = harness.emitted.filter((r) => r.stream === "sessions");
    assert.deepEqual(
      sessions.map((r) => r.data.id).sort(),
      [MIXED_AGENT_PARENT_SESSION_ID, MIXED_AGENT_USER_SESSION_ID].sort(),
      "both per-line session ids get parent summaries"
    );
    assert.deepEqual(
      sessions.map((r) => [r.data.id, r.data.message_count]).sort(),
      [
        [MIXED_AGENT_PARENT_SESSION_ID, 1],
        [MIXED_AGENT_USER_SESSION_ID, 1],
      ].sort(),
      "message_count is attributed to the matching line session"
    );
    const messages = harness.emitted.filter((r) => r.stream === "messages");
    assert.deepEqual(
      messages.map((r) => r.data.session_id),
      [MIXED_AGENT_USER_SESSION_ID, MIXED_AGENT_PARENT_SESSION_ID],
      "child messages keep their per-line session ids"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanProjectDirs: pass 2 alone (after pass 1) emits only children, no session leak", async () => {
  // Regression canary: if a future refactor accidentally also emits
  // sessions from scanProjectDirs (instead of only from
  // emitSessionsFromAccumulators), pass 2 would double up. This test
  // ensures pass 2 emits ONLY messages + attachments.
  const { baseDir, cleanup } = await makeSyntheticProjectTree();
  try {
    const sessionAccumulators = new Map<string, SessionAccumulator>();
    const fileMtimes: Record<string, number> = {};
    const newMtimes: Record<string, number> = {};
    const requested = makeRequested(["sessions", "messages", "attachments"]);

    // Build-pass silently populates accumulators.
    const build = makeRecordingEmit();
    await scanProjectDirs({
      baseDir,
      buildOnly: true,
      emit: silentEmit(),
      emitRecord: build.emitRecord,
      fileMtimes,
      newMtimes,
      requested,
      sessionAccumulators,
    });

    // Emit-pass: fresh harness so we observe pass 2 only.
    const emitPass = makeRecordingEmit();
    await scanProjectDirs({
      baseDir,
      buildOnly: false,
      emit: silentEmit(),
      emitRecord: emitPass.emitRecord,
      fileMtimes,
      newMtimes,
      requested,
      sessionAccumulators,
    });

    const streams = new Set(emitPass.emitted.map((r) => r.stream));
    assert.ok(!streams.has("sessions"), "pass 2 must not emit sessions");
    assert.ok(streams.has("messages"), "pass 2 emits messages");
    assert.ok(streams.has("attachments"), "pass 2 emits attachments");
  } finally {
    await cleanup();
  }
});
