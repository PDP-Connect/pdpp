// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

/**
 * Truthful evidence contract for derived streams (messages, attachments,
 * memory_notes), on the canonical local-source-inventory coverage-status
 * vocabulary (mirrors connectors/codex/coverage-truthful.test.ts).
 *
 * Before this fix, a run that emitted real messages/attachments/memory_notes
 * RECORDs still produced a `collection_facts.streams` list (built from
 * `coverage_diagnostics`) that omitted those three streams entirely — they
 * are parsed out of the same on-disk files as `sessions`, not scanned as
 * their own top-level `KNOWN_LOCAL_STORES` entry, so they never got a
 * coverage_diagnostics row. `fullyAccounted` was blind to the same gap.
 */

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function transcriptLine(uuid: string, timestamp: string): string {
  return JSON.stringify({
    message: { content: "hello from a real transcript line" },
    isSidechain: false,
    sessionId: SESSION_ID,
    timestamp,
    type: "user",
    uuid,
  });
}

async function makePopulatedHome(): Promise<string> {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-coverage-truthful-"));
  const project = join(claudeHome, "projects", "-tmp-demo");
  const sessionDir = join(project, SESSION_ID);
  const toolResults = join(sessionDir, "tool-results");
  const memory = join(project, "memory");
  await mkdir(toolResults, { recursive: true });
  await mkdir(memory, { recursive: true });
  await writeFile(
    join(project, `${SESSION_ID}.jsonl`),
    `${transcriptLine("00000000-0000-4000-8000-000000000001", "2026-08-10T00:00:00.000Z")}\n`
  );
  await writeFile(join(toolResults, "result-1.txt"), "tool result body\n");
  await writeFile(join(memory, "note.md"), "# note\nsome memory content\n");
  return claudeHome;
}

function records(messages: EmittedMessage[]): Extract<EmittedMessage, { type: "RECORD" }>[] {
  return messages.filter((msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD");
}

function states(messages: EmittedMessage[], stream?: string): Extract<EmittedMessage, { type: "STATE" }>[] {
  return messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "STATE" }> =>
      msg.type === "STATE" && (!stream || msg.stream === stream)
  );
}

test("claude_code coverage truth: a run emitting real messages/attachments/memory_notes records also emits coverage_diagnostics rows for those streams", async () => {
  const claudeHome = await makePopulatedHome();

  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/claude_code/index.ts",
    env: { CLAUDE_CODE_HOME: claudeHome, CLAUDE_CODE_PROJECTS_DIR: join(claudeHome, "projects") },
    start: {
      scope: {
        streams: [
          { name: "sessions" },
          { name: "messages" },
          { name: "attachments" },
          { name: "memory_notes" },
          { name: "coverage_diagnostics" },
        ],
      },
      type: "START",
    },
  });

  assert.equal(result.code, 0);
  const recs = records(result.messages);

  // Sanity: the run really did emit real records for all three derived streams
  // (this is exactly what live event seq 155438's run.completed omitted).
  assert(
    recs.some((r) => r.stream === "messages"),
    "fixture must produce a messages record"
  );
  assert(
    recs.some((r) => r.stream === "attachments"),
    "fixture must produce an attachments record"
  );
  assert(
    recs.some((r) => r.stream === "memory_notes"),
    "fixture must produce a memory_notes record"
  );

  const coverageRecs = recs.filter((r) => r.stream === "coverage_diagnostics");
  const coveredStreams = new Set(coverageRecs.map((r) => r.data.stream));

  for (const stream of ["messages", "attachments", "memory_notes"]) {
    assert(
      coveredStreams.has(stream),
      `coverage_diagnostics must include a row for '${stream}' — a record-bearing stream must not be ` +
        "silently absent from terminal coverage evidence"
    );
  }

  const messagesCoverage = coverageRecs.find((r) => r.data.stream === "messages");
  const attachmentsCoverage = coverageRecs.find((r) => r.data.stream === "attachments");
  const memoryNotesCoverage = coverageRecs.find((r) => r.data.stream === "memory_notes");
  assert.equal(messagesCoverage?.data.status, "collected");
  assert.equal(attachmentsCoverage?.data.status, "collected");
  assert.equal(memoryNotesCoverage?.data.status, "collected");
});

test("claude_code coverage truth: derived coverage records are included in the final coverage_diagnostics STATE snapshot", async () => {
  const claudeHome = await makePopulatedHome();

  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/claude_code/index.ts",
    env: { CLAUDE_CODE_HOME: claudeHome, CLAUDE_CODE_PROJECTS_DIR: join(claudeHome, "projects") },
    start: {
      scope: {
        streams: [
          { name: "sessions" },
          { name: "messages" },
          { name: "attachments" },
          { name: "memory_notes" },
          { name: "coverage_diagnostics" },
        ],
      },
      type: "START",
    },
  });

  const coverageStates = states(result.messages, "coverage_diagnostics");
  assert(coverageStates.length > 0, "must emit coverage_diagnostics STATE");
  const stateSnapshot = (coverageStates.at(-1)?.cursor as { stores?: Record<string, unknown> })?.stores;
  assert(stateSnapshot, "STATE must include stores snapshot");
  const streamNames = Object.values(stateSnapshot)
    .filter((v) => typeof v === "object" && v !== null && "stream" in (v as Record<string, unknown>))
    .map((v) => (v as { stream?: unknown }).stream);

  for (const stream of ["messages", "attachments", "memory_notes"]) {
    assert(streamNames.includes(stream), `STATE snapshot must include a '${stream}' coverage row`);
  }
});

test("claude_code coverage truth: genuinely empty projects dir (no messages/attachments/memory_notes) still shows collected", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-coverage-truthful-empty-"));
  await mkdir(join(claudeHome, "projects"), { recursive: true });

  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/claude_code/index.ts",
    env: { CLAUDE_CODE_HOME: claudeHome, CLAUDE_CODE_PROJECTS_DIR: join(claudeHome, "projects") },
    start: {
      scope: {
        streams: [
          { name: "sessions" },
          { name: "messages" },
          { name: "attachments" },
          { name: "memory_notes" },
          { name: "coverage_diagnostics" },
        ],
      },
      type: "START",
    },
  });

  assert.equal(result.code, 0);
  const recs = records(result.messages);
  const coverageRecs = recs.filter((r) => r.stream === "coverage_diagnostics");
  const coveredStreams = new Set(coverageRecs.map((r) => r.data.stream));

  for (const stream of ["messages", "attachments", "memory_notes"]) {
    assert(coveredStreams.has(stream), `coverage_diagnostics must include a row for '${stream}' even when empty`);
  }
  const messagesCoverage = coverageRecs.find((r) => r.data.stream === "messages");
  assert.equal(messagesCoverage?.data.status, "collected", "an empty-but-complete scan is collected, not missing");
});

// ─── per-stream examined counts must not cross-contaminate ───────────────
//
// scanChildSource used to return one scan-wide `linesExamined` count that got
// added to BOTH derivedCounts.messages.examined and
// derivedCounts.attachments.examined for every source file -- so a
// message-only transcript falsely reported attachments as "N examined, 0
// emitted", and an attachment-only transcript would equally falsely report
// messages as examined. These two fixtures are each exclusively one type, so
// the OTHER stream's honest examined count must read exactly 0.

function coverageReasonFor(recs: Extract<EmittedMessage, { type: "RECORD" }>[], stream: string): string | undefined {
  const row = recs.find((r) => r.stream === "coverage_diagnostics" && r.data.stream === stream);
  return typeof row?.data.reason === "string" ? row.data.reason : undefined;
}

test("claude_code coverage truth: a message-only transcript reports attachments as 0 examined, not the message line count", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-coverage-truthful-message-only-"));
  const project = join(claudeHome, "projects", "-tmp-demo");
  const sessionDir = join(project, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const lines = Array.from({ length: 5 }, (_, i) =>
    transcriptLine(`00000000-0000-4000-8000-00000000000${i}`, `2026-08-10T00:0${i}:00.000Z`)
  ).join("\n");
  await writeFile(join(project, `${SESSION_ID}.jsonl`), `${lines}\n`);

  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/claude_code/index.ts",
    env: { CLAUDE_CODE_HOME: claudeHome, CLAUDE_CODE_PROJECTS_DIR: join(claudeHome, "projects") },
    start: {
      scope: {
        streams: [
          { name: "sessions" },
          { name: "messages" },
          { name: "attachments" },
          { name: "coverage_diagnostics" },
        ],
      },
      type: "START",
    },
  });

  assert.equal(result.code, 0);
  const recs = records(result.messages);
  assert.equal(recs.filter((r) => r.stream === "messages").length, 5, "fixture must emit exactly 5 message records");
  assert.equal(recs.filter((r) => r.stream === "attachments").length, 0, "fixture must emit zero attachment records");

  const messagesReason = coverageReasonFor(recs, "messages");
  const attachmentsReason = coverageReasonFor(recs, "attachments");
  assert.equal(messagesReason, "5 message records emitted");
  assert.equal(
    attachmentsReason,
    "enumeration complete, 0 examined",
    "a message-only transcript must report 0 attachment-candidate lines examined, not the shared scan-wide line count"
  );
});

test("claude_code coverage truth: an attachment-only transcript reports messages as 0 examined, not the attachment line count", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-coverage-truthful-attachment-only-"));
  const project = join(claudeHome, "projects", "-tmp-demo");
  const sessionDir = join(project, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const attachmentLine = (uuid: string, timestamp: string): string =>
    JSON.stringify({
      isSidechain: false,
      sessionId: SESSION_ID,
      timestamp,
      type: "attachment",
      uuid,
    });
  // A leading message-typed line pins obs.sessionId so the attachment lines
  // that follow are dispatched (processJsonlLine no-ops before a session id
  // is observed) -- the count under test is on the attachment-typed lines.
  const lines = [
    transcriptLine("00000000-0000-4000-8000-000000000000", "2026-08-10T00:00:00.000Z"),
    ...Array.from({ length: 4 }, (_, i) =>
      attachmentLine(`00000000-0000-4000-8000-00000000001${i}`, `2026-08-10T00:0${i + 1}:00.000Z`)
    ),
  ].join("\n");
  await writeFile(join(project, `${SESSION_ID}.jsonl`), `${lines}\n`);

  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/claude_code/index.ts",
    env: { CLAUDE_CODE_HOME: claudeHome, CLAUDE_CODE_PROJECTS_DIR: join(claudeHome, "projects") },
    start: {
      scope: {
        streams: [
          { name: "sessions" },
          { name: "messages" },
          { name: "attachments" },
          { name: "coverage_diagnostics" },
        ],
      },
      type: "START",
    },
  });

  assert.equal(result.code, 0);
  const recs = records(result.messages);
  assert.equal(
    recs.filter((r) => r.stream === "attachments").length,
    4,
    "fixture must emit exactly 4 attachment records"
  );
  assert.equal(recs.filter((r) => r.stream === "messages").length, 1, "fixture emits exactly the one pinning message");

  const messagesReason = coverageReasonFor(recs, "messages");
  const attachmentsReason = coverageReasonFor(recs, "attachments");
  assert.equal(messagesReason, "1 message records emitted");
  assert.equal(attachmentsReason, "4 attachment records emitted");
});
