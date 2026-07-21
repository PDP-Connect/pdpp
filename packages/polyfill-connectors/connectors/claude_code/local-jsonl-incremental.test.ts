import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const IDS: Record<string, string> = {
  partial: "00000000-0000-4000-8000-000000000005",
  "sub-1": "00000000-0000-4000-8000-000000000002",
  "sub-later": "00000000-0000-4000-8000-000000000007",
  "sub-new": "00000000-0000-4000-8000-000000000006",
  "top-1": "00000000-0000-4000-8000-000000000001",
  "top-2": "00000000-0000-4000-8000-000000000003",
  "top-3": "00000000-0000-4000-8000-000000000004",
};

function transcriptLine(id: string, timestamp: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    message: { content: "x" },
    isSidechain: false,
    sessionId: SESSION_ID,
    timestamp: timestamp.replace("Z", ".000Z"),
    type: "user",
    uuid: IDS[id] ?? id,
    ...extra,
  });
}

async function makeSource(): Promise<{ claudeHome: string; projects: string; top: string; subagent: string }> {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-incremental-"));
  const projects = join(claudeHome, "projects");
  const project = join(projects, "-tmp-incremental");
  const top = join(project, `${SESSION_ID}.jsonl`);
  const subagent = join(project, SESSION_ID, "subagents", "worker.jsonl");
  await mkdir(join(project, SESSION_ID, "subagents"), { recursive: true });
  await writeFile(top, `${transcriptLine("top-1", "2026-07-21T00:00:00Z", { padding: "x".repeat(70_000) })}\n`);
  await writeFile(subagent, `${transcriptLine("sub-1", "2026-07-21T00:01:00Z", { sessionId: "wrong-sidechain" })}\n`);
  return { claudeHome, projects, subagent, top };
}

async function run(input: {
  claudeHome: string;
  projects: string;
  state?: Record<string, unknown>;
  streams?: string[];
}) {
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/claude_code/index.ts",
    env: { CLAUDE_CODE_HOME: input.claudeHome, CLAUDE_CODE_PROJECTS_DIR: input.projects },
    start: {
      scope: { streams: (input.streams ?? ["sessions", "messages"]).map((name) => ({ name })) },
      ...(input.state ? { state: input.state } : {}),
      type: "START",
    },
  });
  assert.equal(result.code, 0, result.stderr);
  const states = Object.fromEntries(
    result.messages
      .filter((message): message is Extract<EmittedMessage, { type: "STATE" }> => message.type === "STATE")
      .map((message) => [message.stream, message.cursor])
  );
  const records = result.messages.filter(
    (message): message is Extract<EmittedMessage, { type: "RECORD" }> => message.type === "RECORD"
  );
  return { records, states };
}

test("M1-M3, M10-M13, M22: mtime touch is empty; safe append preserves same-session contributors and independent cursors", async () => {
  const source = await makeSource();
  const first = await run(source);
  assert.equal(first.records.filter((record) => record.stream === "messages").length, 2);
  const state = { messages: first.states.messages, sessions: first.states.sessions };

  const touchedAt = new Date(Date.now() + 20_000);
  await utimes(source.top, touchedAt, touchedAt);
  const touched = await run({ ...source, state });
  assert.equal(touched.records.length, 0, "M1/M2: a touch emits no transcript records");

  await writeFile(
    source.top,
    `${await readFile(source.top, "utf8")}${transcriptLine("top-2", "2026-07-21T00:02:00Z", { sessionId: undefined })}\n`
  );
  const appended = await run({
    ...source,
    state: { messages: touched.states.messages, sessions: touched.states.sessions },
  });
  const messages = appended.records.filter((record) => record.stream === "messages");
  assert.deepEqual(
    messages.map((record) => record.data.id),
    [IDS["top-2"]],
    "M3: only the appended child key emits"
  );
  assert.equal(messages[0]?.data.session_id, SESSION_ID, "M10: tail inherits the prior session id");
  const session = appended.records.find((record) => record.stream === "sessions");
  assert.equal(session?.data.message_count, 3, "M11/M13: aggregate keeps unchanged subagent plus top-level tail");
  assert.equal(session?.data.last_event_at, "2026-07-21T00:02:00.000Z");

  const sessionOnly = await run({ ...source, state: { messages: appended.states.messages }, streams: ["sessions"] });
  assert.equal(
    sessionOnly.records.filter((record) => record.stream === "sessions").length,
    1,
    "M22: sessions backfill independently"
  );
  assert.ok(sessionOnly.states.sessions);
});

test("M4-M9, M12, M14, M19: rewrite, replacement, truncation, partial and malformed JSONL rebuild safely", async () => {
  const source = await makeSource();
  const first = await run(source);
  const state = { messages: first.states.messages, sessions: first.states.sessions };
  const original = await readFile(source.top, "utf8");
  await writeFile(source.top, `${original.replace("x", "y")}${transcriptLine("top-2", "2026-07-21T00:02:00Z")}\n`);
  const rewritten = await run({ ...source, state });
  assert.equal(
    rewritten.records.filter((record) => record.stream === "messages").length,
    2,
    "M4/M5: changed prefix rebuilds current file"
  );
  assert.equal(
    rewritten.records.find((record) => record.stream === "sessions")?.data.message_count,
    3,
    "M12: rebuilt aggregate is complete"
  );

  await writeFile(
    source.top,
    `${await readFile(source.top, "utf8")}{"sessionId":"${SESSION_ID}","type":"user","uuid":"${IDS.partial}`
  );
  const partial = await run({
    ...source,
    state: { messages: rewritten.states.messages, sessions: rewritten.states.sessions },
  });
  assert.equal(partial.records.length, 0, "M8: unterminated JSONL does not emit");
  await writeFile(
    source.top,
    `${await readFile(source.top, "utf8")}","isSidechain":false}\nnot-json\n${transcriptLine("top-3", "2026-07-21T00:03:00Z")}\n`
  );
  const completed = await run({
    ...source,
    state: { messages: partial.states.messages, sessions: partial.states.sessions },
  });
  assert.deepEqual(
    completed.records.filter((record) => record.stream === "messages").map((record) => record.data.id),
    [IDS.partial, IDS["top-3"]],
    "M8/M9: completed and post-malformed lines advance once"
  );

  await truncate(source.subagent, 0);
  await writeFile(source.subagent, `${transcriptLine("sub-new", "2026-07-21T00:04:00Z")}\n`);
  const truncated = await run({
    ...source,
    state: { messages: completed.states.messages, sessions: completed.states.sessions },
  });
  assert.ok(
    truncated.records.some((record) => record.stream === "messages" && record.data.id === IDS["sub-new"]),
    "M7: truncation rebuilds"
  );
  const replacement = `${source.subagent}.replacement`;
  await writeFile(
    replacement,
    `${await readFile(source.subagent, "utf8")}${transcriptLine("sub-later", "2026-07-21T00:05:00Z")}\n`
  );
  await rename(replacement, source.subagent);
  const rotated = await run({
    ...source,
    state: { messages: truncated.states.messages, sessions: truncated.states.sessions },
  });
  assert.deepEqual(
    rotated.records.filter((record) => record.stream === "messages").map((record) => record.data.id),
    [IDS["sub-later"]],
    "M6: identical prefix replacement tails safely"
  );
});

test("M17-M21: bounded migration writes private O(files + sessions) state without a token dependency", async () => {
  const source = await makeSource();
  const topMtime = (await (await import("node:fs/promises")).stat(source.top)).mtimeMs;
  const subMtime = (await (await import("node:fs/promises")).stat(source.subagent)).mtimeMs;
  const legacyState = {
    messages: { file_mtimes: { [source.top]: topMtime, [source.subagent]: subMtime } },
    sessions: { file_mtimes: { [source.top]: topMtime, [source.subagent]: subMtime } },
  };
  const migrated = await run({ ...source, state: legacyState });
  assert.equal(migrated.records.length, 0, "M17: matching legacy mtimes baseline without replay");
  const childCursor = migrated.states.messages as {
    file_cursors?: Record<string, unknown>;
    local_jsonl_cursor_version?: number;
  };
  const sessionCursor = migrated.states.sessions as {
    file_cursors?: Record<string, unknown>;
    session_aggregates?: Record<string, unknown>;
  };
  assert.equal(childCursor.local_jsonl_cursor_version, 1);
  assert.equal(Object.keys(childCursor.file_cursors ?? {}).length, 2);
  assert.equal(Object.keys(sessionCursor.session_aggregates ?? {}).length, 1);
  const serialized = JSON.stringify(migrated.states.messages);
  assert.ok(
    !(serialized.includes("top-1") || serialized.includes("sub-1")),
    "M20: child state has no record keys or fingerprints"
  );
});

test("M20: ten thousand child rows retain constant per-file cursor state", async () => {
  const source = await makeSource();
  const rows = Array.from({ length: 10_000 }, (_, index) =>
    transcriptLine(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, "2026-07-21T00:00:00Z")
  );
  await writeFile(source.top, `${rows.join("\n")}\n`);
  const topMtime = (await (await import("node:fs/promises")).stat(source.top)).mtimeMs;
  const subMtime = (await (await import("node:fs/promises")).stat(source.subagent)).mtimeMs;
  const state = {
    messages: { file_mtimes: { [source.top]: topMtime, [source.subagent]: subMtime } },
    sessions: { file_mtimes: { [source.top]: topMtime, [source.subagent]: subMtime } },
  };
  const migrated = await run({ ...source, state });
  const child = migrated.states.messages as { file_cursors?: Record<string, unknown> };
  assert.equal(Object.keys(child.file_cursors ?? {}).length, 2);
  assert.ok(JSON.stringify(child).length < 2000, "child STATE is O(files), not O(child records)");
});
