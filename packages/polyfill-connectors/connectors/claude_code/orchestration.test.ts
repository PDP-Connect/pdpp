/**
 * Orchestration-level proof of claude_code's parent-first two-pass emit
 * structure. Runs the real `scanProjectDirs` against a synthetic
 * `~/.claude/projects` tree in `tmpdir()`, then calls the real
 * `emitSessionsFromAccumulators`, then runs `scanProjectDirs` a second
 * time with `buildOnly: false`. Proves end-to-end that:
 *
 *   1. Pass 1 (buildOnly=true) populates accumulators and emits nothing.
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
 *
 * `baseDir` is passed to scanProjectDirs as-is (in production this is
 * `~/.claude/projects`). The JSONL has one `user` line and one
 * `assistant` line for the session, then one `attachment` line.
 * processJsonlLine's observe pass pins sessionId from line 1's
 * `sessionId` field.
 */
async function makeSyntheticProjectTree(): Promise<{ baseDir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pdpp-cc-orch-"));
  const projectDir = join(root, "-Users-test-my-project");
  await mkdir(projectDir, { recursive: true });
  const sessionFile = join(projectDir, "sess-ORCH-001.jsonl");
  const lines = [
    {
      sessionId: "sess-ORCH-001",
      type: "user",
      uuid: "m1",
      timestamp: "2026-04-23T10:00:00Z",
      message: { content: "hello" },
      cwd: "/Users/user/my-project",
    },
    {
      sessionId: "sess-ORCH-001",
      type: "assistant",
      uuid: "m2",
      timestamp: "2026-04-23T10:00:01Z",
      message: { content: "hi back" },
    },
    {
      sessionId: "sess-ORCH-001",
      type: "attachment",
      uuid: "a1",
      timestamp: "2026-04-23T10:00:02Z",
      description: "file-history-snapshot",
    },
  ];
  await writeFile(sessionFile, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

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

test("scanProjectDirs: pass 1 (buildOnly=true) populates accumulators but emits nothing", async () => {
  const { baseDir, cleanup } = await makeSyntheticProjectTree();
  try {
    const harness = makeRecordingEmit();
    const sessionAccumulators = new Map<string, SessionAccumulator>();
    const fileMtimes: Record<string, number> = {};
    const newMtimes: Record<string, number> = {};
    const requested = makeRequested(["sessions", "messages", "attachments"]);

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

    assert.equal(harness.emitted.length, 0, "buildOnly=true must emit zero records");
    assert.equal(sessionAccumulators.size, 1, "exactly one session observed");
    const acc = sessionAccumulators.get("sess-ORCH-001");
    assert.ok(acc, "session accumulator present");
    assert.equal(acc.message_count, 2, "accumulated 2 message lines");
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
    const requested = makeRequested(["sessions", "messages", "attachments"]);

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
    assert.equal(messageCount, 2);
    assert.equal(attachmentCount, 1);

    // Message_count on the session record is the correct count, not doubled.
    const sessionRec = harness.emitted[firstSession];
    assert.equal(sessionRec?.data.message_count, 2, "no accumulator double-count from pass 2");
  } finally {
    await cleanup();
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
