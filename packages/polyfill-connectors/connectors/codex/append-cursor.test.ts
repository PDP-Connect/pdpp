/**
 * End-to-end tests for the Codex append-safe rollout cursor.
 *
 * Unlike integration.test.ts (which drives the I/O-free per-line dispatchers
 * against synthetic in-memory data), these tests spawn the real connector as a
 * subprocess against real rollout files on disk, then round-trip the emitted
 * `messages` STATE cursor back into a second run — exactly what the local
 * collector does. They prove the physical-source contract the whole-file mtime
 * gate could not satisfy:
 *
 *   1. A first run full-parses a file and writes a rich per-file cursor
 *      (committed offset, line count, prefix integrity guard, counts).
 *   2. An unchanged file emits zero rollout records on the next run.
 *   3. Appending to a long-lived rollout file under an OLD date directory emits
 *      ONLY the appended records, with non-colliding keys — never the 1+ GB
 *      prefix that the live root-cause re-emitted on every append.
 *   4. A truncated/replaced file full-reparses rather than tailing a stale
 *      offset or silently skipping.
 *   5. Session message_count / function_call_count stay correct (prior + delta)
 *      after an append-only delta parse.
 *   6. A legacy `file_mtimes`-only cursor reparses once, then writes a rich
 *      cursor that lets the next append tail.
 *
 * The quiet-period defer is disabled via PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS=0
 * because fixture files are written milliseconds before the scan.
 */

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const QUIET_OFF = { PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS: "0" } as const;
const SESSION_ID = "019d922d-c38b-7e11-ae99-9187af386148";
// An old date directory: the exact long-lived-session shape from the live
// root cause (a session started in April, still appended to in June).
const OLD_DATE_DIR = join("2026", "04", "15");

interface StateCursor {
  file_cursors?: Record<string, RolloutFileCursorShape>;
  file_mtimes?: Record<string, number>;
}

interface RolloutFileCursorShape {
  function_call_count: number;
  guard_bytes: number;
  head_sha256: string;
  line_count: number;
  message_count: number;
  mtime_ms: number;
  offset_bytes: number;
  session_id: string | null;
  size_bytes: number;
}

function sessionMetaLine(id = SESSION_ID): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp: "2026-04-15T17:33:32.000Z",
    payload: { id, timestamp: "2026-04-15T17:33:32.000Z", cwd: "/repo", originator: "codex-tui" },
  });
}

function messageLine(text: string, role = "user", ts = "2026-04-15T17:34:00.000Z"): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: ts,
    payload: { type: "message", role, content: [{ text }] },
  });
}

// call_ids must match the function_calls schema (`call_` + 24 alphanumerics)
// or the record is shape-rejected before emit — use real-shaped ids so the
// test asserts on emit, not on schema validation.
const CALL_A = "call_AAAAAAAAAAAAAAAAAAAAAAAA";
const CALL_B = "call_BBBBBBBBBBBBBBBBBBBBBBBB";

function functionCallLine(callId: string, name: string, args: string, ts = "2026-04-15T17:34:01.000Z"): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: ts,
    payload: { type: "function_call", call_id: callId, name, arguments: args },
  });
}

/** Join JSONL lines with a trailing newline so the file ends on a terminator
 *  (the committed-offset boundary). */
function jsonl(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

async function writeRollout(codexHome: string, dateDir: string, fileName: string, body: string): Promise<string> {
  const dir = join(codexHome, "sessions", dateDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, body);
  return path;
}

async function runCodex(input: {
  codexHome: string;
  streams: readonly string[];
  state?: Record<string, unknown>;
  quietMs?: string;
}): Promise<{ exitCode: number | null; messages: EmittedMessage[]; stderr: string }> {
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/codex/index.ts",
    env: {
      CODEX_HOME: input.codexHome,
      PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS: input.quietMs ?? QUIET_OFF.PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS,
    },
    start: {
      scope: { streams: input.streams.map((name) => ({ name })) },
      ...(input.state ? { state: input.state } : {}),
      type: "START",
    },
  });
  return { exitCode: result.code, messages: result.messages, stderr: result.stderr };
}

function recordsFor(messages: EmittedMessage[], stream: string): Extract<EmittedMessage, { type: "RECORD" }>[] {
  return messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD" && msg.stream === stream
  );
}

/** The rollout STATE cursor is emitted under `messages` (or `function_calls`
 *  when only that is requested). Return its cursor object as the next run's
 *  `state.messages`. */
function rolloutStateCursor(messages: EmittedMessage[], stream = "messages"): StateCursor {
  const state = messages.findLast(
    (msg): msg is Extract<EmittedMessage, { type: "STATE" }> => msg.type === "STATE" && msg.stream === stream
  );
  assert.ok(state, `expected a ${stream} STATE cursor`);
  return state.cursor as StateCursor;
}

test("first run full-parses a rollout file and writes a rich per-file cursor", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-append-first-"));
  const path = await writeRollout(
    codexHome,
    OLD_DATE_DIR,
    `rollout-2026-04-15T12-26-06-${SESSION_ID}.jsonl`,
    jsonl([sessionMetaLine(), messageLine("first"), messageLine("second", "assistant")])
  );

  const run = await runCodex({ codexHome, streams: ["messages"] });
  assert.equal(run.exitCode, 0);
  assert.equal(recordsFor(run.messages, "messages").length, 2, "both messages parsed on first run");

  const cursor = rolloutStateCursor(run.messages).file_cursors?.[path];
  assert.ok(cursor, "a rich per-file cursor is written for the parsed file");
  assert.equal(cursor.session_id, SESSION_ID);
  assert.equal(cursor.message_count, 2, "cursor records cumulative message count");
  assert.ok(cursor.offset_bytes > 0, "committed offset advanced to end of file");
  assert.ok(cursor.head_sha256.length === 64, "prefix integrity guard is a sha-256 hex");
  assert.ok(cursor.line_count >= 3, "line_count covers the meta + two message lines");
});

test("unchanged rollout file emits no rollout records on the next run", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-append-unchanged-"));
  await writeRollout(
    codexHome,
    OLD_DATE_DIR,
    `rollout-2026-04-15T12-26-06-${SESSION_ID}.jsonl`,
    jsonl([sessionMetaLine(), messageLine("only"), functionCallLine(CALL_A, "shell", "ls")])
  );

  const run1 = await runCodex({ codexHome, streams: ["messages", "function_calls"] });
  assert.equal(run1.exitCode, 0);
  assert.ok(recordsFor(run1.messages, "messages").length >= 1, "run 1 emits");

  const priorCursor = rolloutStateCursor(run1.messages);
  const run2 = await runCodex({
    codexHome,
    streams: ["messages", "function_calls"],
    state: { messages: priorCursor },
  });
  assert.equal(run2.exitCode, 0);
  assert.equal(recordsFor(run2.messages, "messages").length, 0, "unchanged file → no message records");
  assert.equal(recordsFor(run2.messages, "function_calls").length, 0, "unchanged file → no function_call records");
});

test("appending to a long-lived rollout file emits ONLY the appended records with non-colliding keys", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-append-tail-"));
  const fileName = `rollout-2026-04-15T12-26-06-${SESSION_ID}.jsonl`;
  const path = await writeRollout(
    codexHome,
    OLD_DATE_DIR,
    fileName,
    jsonl([sessionMetaLine(), messageLine("april message 1"), messageLine("april message 2", "assistant")])
  );

  const run1 = await runCodex({ codexHome, streams: ["messages"] });
  assert.equal(run1.exitCode, 0);
  const run1Msgs = recordsFor(run1.messages, "messages");
  assert.equal(run1Msgs.length, 2, "run 1 emits the two original messages");
  const run1Ids = new Set(run1Msgs.map((r) => String(r.data.id)));
  const priorCursor = rolloutStateCursor(run1.messages);

  // June: the SAME old-dated file is appended to.
  await appendFile(path, jsonl([messageLine("june message 3", "user", "2026-06-03T20:30:04.000Z")]));

  const run2 = await runCodex({ codexHome, streams: ["messages"], state: { messages: priorCursor } });
  assert.equal(run2.exitCode, 0);
  const run2Msgs = recordsFor(run2.messages, "messages");
  assert.equal(run2Msgs.length, 1, "run 2 emits ONLY the single appended message, not the whole file");
  assert.equal(run2Msgs[0]?.data.content, "june message 3", "the appended message is the one emitted");

  // The appended record's key must NOT collide with a previously-emitted key —
  // proof the parser line counter continued from the prior boundary.
  const appendedId = String(run2Msgs[0]?.data.id);
  assert.equal(run1Ids.has(appendedId), false, "appended record key continues the line sequence (no collision)");
  assert.match(appendedId, new RegExp(`^${SESSION_ID}:\\d+$`), "appended id keeps the session:line shape");

  // The advanced cursor reflects the new boundary + cumulative count.
  const nextCursor = rolloutStateCursor(run2.messages).file_cursors?.[path];
  assert.ok(nextCursor, "cursor advances after the tail");
  assert.equal(nextCursor.message_count, 3, "cumulative message count is prior + delta");
});

test("session message_count / function_call_count stay correct (prior + delta) after an append-only parse", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-append-counts-"));
  const fileName = `rollout-2026-04-15T12-26-06-${SESSION_ID}.jsonl`;
  const path = await writeRollout(
    codexHome,
    OLD_DATE_DIR,
    fileName,
    jsonl([
      sessionMetaLine(),
      messageLine("m1"),
      messageLine("m2", "assistant"),
      functionCallLine(CALL_A, "shell", "ls"),
    ])
  );

  // Sessions stream derives counts from the rollout aggregate. No state_5.sqlite
  // here, so the session lands as a rollout-only record carrying the counts.
  const run1 = await runCodex({ codexHome, streams: ["messages", "function_calls", "sessions"] });
  assert.equal(run1.exitCode, 0);
  const session1 = recordsFor(run1.messages, "sessions").find((r) => r.data.id === SESSION_ID);
  assert.ok(session1, "run 1 emits the session");
  assert.equal(session1.data.message_count, 2, "run 1 message_count");
  assert.equal(session1.data.function_call_count, 1, "run 1 function_call_count");

  const priorCursor = rolloutStateCursor(run1.messages);
  // Append one new message and one new function call.
  await appendFile(
    path,
    jsonl([
      messageLine("m3 appended", "user", "2026-06-03T20:30:04.000Z"),
      functionCallLine(CALL_B, "shell", "pwd", "2026-06-03T20:30:05.000Z"),
    ])
  );

  const run2 = await runCodex({
    codexHome,
    streams: ["messages", "function_calls", "sessions"],
    state: { messages: priorCursor },
  });
  assert.equal(run2.exitCode, 0);
  // Only the appended message + call are emitted as records…
  assert.equal(recordsFor(run2.messages, "messages").length, 1, "only the appended message record");
  assert.equal(recordsFor(run2.messages, "function_calls").length, 1, "only the appended function_call record");
  // …but the session count is the FULL prior+delta total, not the suffix-only count.
  const session2 = recordsFor(run2.messages, "sessions").find((r) => r.data.id === SESSION_ID);
  assert.ok(session2, "run 2 re-emits the session (its rollout was parsed)");
  assert.equal(session2.data.message_count, 3, "message_count = prior 2 + delta 1");
  assert.equal(session2.data.function_call_count, 2, "function_call_count = prior 1 + delta 1");
});

test("truncated rollout file falls back to a full reparse rather than tailing a stale offset", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-append-truncate-"));
  const fileName = `rollout-2026-04-15T12-26-06-${SESSION_ID}.jsonl`;
  const path = await writeRollout(
    codexHome,
    OLD_DATE_DIR,
    fileName,
    jsonl([sessionMetaLine(), messageLine("m1"), messageLine("m2", "assistant"), messageLine("m3", "user")])
  );

  const run1 = await runCodex({ codexHome, streams: ["messages"] });
  assert.equal(run1.exitCode, 0);
  assert.equal(recordsFor(run1.messages, "messages").length, 3, "run 1 emits all three");
  const priorCursor = rolloutStateCursor(run1.messages);

  // Replace the file with a SHORTER one (rotation/replacement). The new file is
  // smaller than the cursor size, so the connector must full-reparse from 0.
  await truncate(path, 0);
  await writeFile(path, jsonl([sessionMetaLine(), messageLine("replaced single message")]));

  const run2 = await runCodex({ codexHome, streams: ["messages"], state: { messages: priorCursor } });
  assert.equal(run2.exitCode, 0);
  const run2Msgs = recordsFor(run2.messages, "messages");
  assert.equal(run2Msgs.length, 1, "replaced file is fully reparsed, not skipped or tailed");
  assert.equal(run2Msgs[0]?.data.content, "replaced single message", "the new content is emitted");
});

test("replaced-prefix rollout file (same size, changed head) full-reparses via the integrity guard", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-append-prefix-"));
  const fileName = `rollout-2026-04-15T12-26-06-${SESSION_ID}.jsonl`;
  // Use a DIFFERENT session id in the replacement so a tail-from-offset would
  // mis-attribute. Build a same-byte-length replacement to defeat the size
  // check and force the integrity guard to be the thing that catches it.
  const original = jsonl([sessionMetaLine(), messageLine("AAAAAAAAAA"), messageLine("BBBBBBBBBB", "assistant")]);
  const path = await writeRollout(codexHome, OLD_DATE_DIR, fileName, original);

  const run1 = await runCodex({ codexHome, streams: ["messages"] });
  assert.equal(run1.exitCode, 0);
  const priorCursor = rolloutStateCursor(run1.messages);
  const priorSize = priorCursor.file_cursors?.[path]?.size_bytes;
  assert.ok(priorSize, "first run wrote a cursor");

  // Rewrite with the SAME byte length but a changed prefix (different first
  // message text of equal length). Append one extra line so size GROWS — this
  // routes through the grow path where the integrity guard is consulted.
  const replaced = jsonl([
    sessionMetaLine(),
    messageLine("ZZZZZZZZZZ"),
    messageLine("BBBBBBBBBB", "assistant"),
    messageLine("CCCCCCCCCC", "user"),
  ]);
  await writeFile(path, replaced);

  const run2 = await runCodex({ codexHome, streams: ["messages"], state: { messages: priorCursor } });
  assert.equal(run2.exitCode, 0);
  const contents = recordsFor(run2.messages, "messages").map((r) => r.data.content);
  // A correct full-reparse emits ALL current messages (including the changed
  // prefix line "ZZZZZZZZZZ"); a buggy tail would have emitted only "CCCCCCCCCC".
  assert.ok(contents.includes("ZZZZZZZZZZ"), "changed prefix line is re-emitted (full reparse, not a tail)");
  assert.equal(contents.length, 3, "all three current messages re-parsed");
});

test("legacy file_mtimes-only cursor reparses once, then writes a rich cursor that enables tailing", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-append-legacy-"));
  const fileName = `rollout-2026-04-15T12-26-06-${SESSION_ID}.jsonl`;
  const path = await writeRollout(
    codexHome,
    OLD_DATE_DIR,
    fileName,
    jsonl([sessionMetaLine(), messageLine("legacy m1"), messageLine("legacy m2", "assistant")])
  );

  // Seed ONLY a legacy file_mtimes cursor with a stale mtime (so the file looks
  // changed under the legacy gate) and NO file_cursors — modeling a collector
  // upgraded from the old cursor shape.
  const legacyState = { messages: { file_mtimes: { [path]: 1 } } };
  const run1 = await runCodex({ codexHome, streams: ["messages"], state: legacyState });
  assert.equal(run1.exitCode, 0);
  assert.equal(recordsFor(run1.messages, "messages").length, 2, "legacy upgrade reparses the file once");

  // The upgrade run wrote a rich cursor; a subsequent append must now tail.
  const upgradedCursor = rolloutStateCursor(run1.messages);
  assert.ok(upgradedCursor.file_cursors?.[path], "rich cursor written on the upgrade run");

  await appendFile(path, jsonl([messageLine("legacy m3 appended", "user", "2026-06-03T20:30:04.000Z")]));
  const run2 = await runCodex({ codexHome, streams: ["messages"], state: { messages: upgradedCursor } });
  assert.equal(run2.exitCode, 0);
  const run2Msgs = recordsFor(run2.messages, "messages");
  assert.equal(run2Msgs.length, 1, "after upgrade, the append tails — only the new line");
  assert.equal(run2Msgs[0]?.data.content, "legacy m3 appended");
});

test("a deferred (active-write) new file is NOT skipped next run — it parses once it goes quiet", async () => {
  // Regression guard: the active-rollout quiet-period defer must leave a brand
  // new file (no prior cursor) reparseable next run. A naive defer that stamps
  // the file's mtime into the cursor state would let the legacy fast path
  // (`!cursor && file_mtimes[path] === mtime`) silently skip it forever —
  // dropping the entire file's records. The defer must be a pure no-op on the
  // file's collected state.
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-append-defer-"));
  const fileName = `rollout-2026-04-15T12-26-06-${SESSION_ID}.jsonl`;
  await writeRollout(
    codexHome,
    OLD_DATE_DIR,
    fileName,
    jsonl([sessionMetaLine(), messageLine("written but still active"), messageLine("second", "assistant")])
  );

  // Run 1 with a huge quiet window: the just-written file is INSIDE the quiet
  // window, so it is deferred and emits nothing.
  const run1 = await runCodex({ codexHome, streams: ["messages"], quietMs: "3600000" });
  assert.equal(run1.exitCode, 0);
  assert.equal(recordsFor(run1.messages, "messages").length, 0, "active file is deferred on run 1");
  const deferredState = rolloutStateCursor(run1.messages);
  // The deferred file must NOT have been promoted to a rich cursor…
  assert.ok(
    !deferredState.file_cursors?.[Object.keys(deferredState.file_cursors ?? {})[0] ?? ""],
    "no rich cursor for a deferred new file"
  );

  // Run 2 with the quiet window off (file is now treated as quiet), threading
  // run 1's STATE. The file must be parsed in FULL — not skipped by a stale
  // mtime stamp left behind by the defer.
  const run2 = await runCodex({ codexHome, streams: ["messages"], quietMs: "0", state: { messages: deferredState } });
  assert.equal(run2.exitCode, 0);
  const run2Msgs = recordsFor(run2.messages, "messages");
  assert.equal(run2Msgs.length, 2, "deferred file parses fully on the next quiet run — no silent skip");
});
