import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, truncate, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCollectorConnector } from "../../src/collector-runner.ts";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { scanLocalJsonl } from "../../src/local-jsonl-cursor.ts";
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
  return { messages: result.messages, records, states };
}

async function scanLines(path: string, prior?: Awaited<ReturnType<typeof scanLocalJsonl>>["cursor"]) {
  const lines: string[] = [];
  const result = await scanLocalJsonl({
    path,
    prior,
    onLine: (line) => {
      lines.push(line.toString("utf8"));
      return Promise.resolve();
    },
  });
  return { lines, result };
}

test("M1: unchanged rich cursor fast-skips without a transcript replay", async () => {
  const source = await makeSource();
  const first = await run(source);
  const second = await run({ ...source, state: { messages: first.states.messages, sessions: first.states.sessions } });
  assert.equal(second.records.length, 0);
});

test("M2: an mtime-only touch verifies the prefix and emits no transcript record", async () => {
  const source = await makeSource();
  const first = await run(source);
  await utimes(source.top, new Date(Date.now() + 20_000), new Date(Date.now() + 20_000));
  const touched = await run({ ...source, state: { messages: first.states.messages, sessions: first.states.sessions } });
  assert.equal(touched.records.length, 0);
});

test("M3: a complete append emits only the suffix", async () => {
  const source = await makeSource();
  const first = await run(source);
  await writeFile(
    source.top,
    `${await readFile(source.top, "utf8")}${transcriptLine("top-2", "2026-07-21T00:02:00Z")}\n`
  );
  const appended = await run({
    ...source,
    state: { messages: first.states.messages, sessions: first.states.sessions },
  });
  assert.deepEqual(
    appended.records.filter((record) => record.stream === "messages").map((record) => record.data.id),
    [IDS["top-2"]]
  );
});

test("M4: a committed-prefix mutation beyond 64 KiB rebuilds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-m4-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, `${JSON.stringify({ id: "one", padding: "x".repeat(70_000) })}\n`);
  const first = await scanLines(path);
  const bytes = await readFile(path, "utf8");
  await writeFile(path, `${bytes.slice(0, 66_000)}y${bytes.slice(66_001)}`);
  assert.equal((await scanLines(path, first.result.cursor)).result.decision.kind, "rebuild");
});

test("M5: a same-size committed-prefix rewrite rebuilds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-m5-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"id":"one"}\n');
  const first = await scanLines(path);
  await writeFile(path, '{"id":"two"}\n');
  assert.equal((await scanLines(path, first.result.cursor)).result.decision.kind, "rebuild");
});

test("M6: replacement with a matching prefix tails only the replacement suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-m6-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"id":"one"}\n');
  const first = await scanLines(path);
  const replacement = `${path}.replacement`;
  await writeFile(replacement, '{"id":"one"}\n{"id":"two"}\n');
  await rename(replacement, path);
  assert.deepEqual((await scanLines(path, first.result.cursor)).lines, ['{"id":"two"}']);
});

test("M7: truncation rebuilds from the current source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-m7-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"id":"one"}\n');
  const first = await scanLines(path);
  await truncate(path, 0);
  await writeFile(path, '{"id":"new"}\n');
  assert.deepEqual((await scanLines(path, first.result.cursor)).lines, ['{"id":"new"}']);
});

test("M8: an unterminated line is not committed until its LF arrives", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-m8-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"id":"partial');
  const first = await scanLines(path);
  assert.equal(first.result.cursor.committed_offset_bytes, 0);
  await writeFile(path, '{"id":"partial"}\n');
  assert.deepEqual((await scanLines(path, first.result.cursor)).lines, ['{"id":"partial"}']);
});

test("M9: malformed LF-terminated JSON is skipped while its physical boundary advances", async () => {
  const source = await makeSource();
  const first = await run(source);
  await writeFile(source.top, `${await readFile(source.top, "utf8")}not-json\n`);
  const malformed = await run({
    ...source,
    state: { messages: first.states.messages, sessions: first.states.sessions },
  });
  assert.equal(malformed.records.length, 0);
  const child = malformed.states.messages as { file_cursors: Record<string, { committed_offset_bytes: number }> };
  assert.equal(
    child.file_cursors[source.top]?.committed_offset_bytes,
    (await (await import("node:fs/promises")).stat(source.top)).size
  );
});

test("M10: a tail without sessionId inherits saved parser continuation", async () => {
  const source = await makeSource();
  const first = await run(source);
  await writeFile(
    source.top,
    `${await readFile(source.top, "utf8")}${transcriptLine("top-2", "2026-07-21T00:02:00Z", { sessionId: undefined })}\n`
  );
  const appended = await run({
    ...source,
    state: { messages: first.states.messages, sessions: first.states.sessions },
  });
  assert.equal(appended.records.find((record) => record.stream === "messages")?.data.session_id, SESSION_ID);
});

test("M11: one changed contributor retains its unchanged contributor in the aggregate", async () => {
  const source = await makeSource();
  const first = await run(source);
  await writeFile(
    source.top,
    `${await readFile(source.top, "utf8")}${transcriptLine("top-2", "2026-07-21T00:02:00Z")}\n`
  );
  const appended = await run({
    ...source,
    state: { messages: first.states.messages, sessions: first.states.sessions },
  });
  assert.equal(appended.records.find((record) => record.stream === "sessions")?.data.message_count, 3);
});

test("M12: rewriting one of two contributors rebuilds the aggregate to the clean full fold", async () => {
  const source = await makeSource();
  const first = await run(source);
  const rewritten = (await readFile(source.top, "utf8")).replace("x".repeat(70_000), "y".repeat(70_000));
  await writeFile(source.top, rewritten);
  const incremental = await run({
    ...source,
    state: { messages: first.states.messages, sessions: first.states.sessions },
  });
  const full = await run({ ...source, streams: ["sessions"] });
  assert.deepEqual(
    (incremental.states.sessions as { session_aggregates: Record<string, unknown> }).session_aggregates,
    (full.states.sessions as { session_aggregates: Record<string, unknown> }).session_aggregates
  );
});

test("M13: a new contributor for an existing session folds into the existing aggregate", async () => {
  const source = await makeSource();
  const first = await run(source);
  const later = join(source.projects, "-tmp-incremental", SESSION_ID, "subagents", "later.jsonl");
  await writeFile(later, `${transcriptLine("sub-later", "2026-07-21T00:05:00Z")}\n`);
  const changed = await run({ ...source, state: { messages: first.states.messages, sessions: first.states.sessions } });
  assert.equal(changed.records.find((record) => record.stream === "sessions")?.data.message_count, 3);
});

test("M15: concurrent rewrite plus growth rejects the scan and a retry rebuilds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-m15-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"id":"one"}\n');
  await assert.rejects(
    scanLocalJsonl({
      path,
      prior: undefined,
      onLine: async () => {
        await writeFile(path, '{"id":"rewritten"}\n{"id":"grown"}\n');
      },
    }),
    /committed prefix changed/
  );
  assert.deepEqual((await scanLines(path)).lines, ['{"id":"rewritten"}', '{"id":"grown"}']);
});

test("M17: matching legacy mtimes establish rich state without transcript replay", async () => {
  const source = await makeSource();
  const topMtime = (await (await import("node:fs/promises")).stat(source.top)).mtimeMs;
  const subMtime = (await (await import("node:fs/promises")).stat(source.subagent)).mtimeMs;
  const migrated = await run({
    ...source,
    state: {
      messages: { file_mtimes: { [source.top]: topMtime, [source.subagent]: subMtime } },
      sessions: { file_mtimes: { [source.top]: topMtime, [source.subagent]: subMtime } },
    },
  });
  assert.equal(migrated.records.length, 0);
  assert.equal((migrated.states.messages as { local_jsonl_cursor_version: number }).local_jsonl_cursor_version, 1);
});

test("M18: changed legacy mtime conservatively replays the current source once", async () => {
  const source = await makeSource();
  const replayed = await run({
    ...source,
    state: { messages: { file_mtimes: { [source.top]: 0 } }, sessions: { file_mtimes: { [source.top]: 0 } } },
  });
  assert.equal(replayed.records.filter((record) => record.stream === "messages").length, 2);
});

test("M16: restarting from the pre-STATE cursor replays a stable logical key", async () => {
  const source = await makeSource();
  const first = await run(source);
  await writeFile(
    source.top,
    `${await readFile(source.top, "utf8")}${transcriptLine("top-2", "2026-07-21T00:02:00Z")}\n`
  );
  const prior = { messages: first.states.messages, sessions: first.states.sessions };
  const interruptedAttempt = await run({ ...source, state: prior });
  const restart = await run({ ...source, state: prior });
  assert.deepEqual(
    restart.records.filter((record) => record.stream === "messages").map((record) => record.key),
    interruptedAttempt.records.filter((record) => record.stream === "messages").map((record) => record.key)
  );
});

test("rich state contains neither transcript content nor child-key ledgers", async () => {
  const source = await makeSource();
  const result = await run(source);
  const state = JSON.stringify({ messages: result.states.messages, sessions: result.states.sessions });
  assert.equal(state.includes("top-1"), false);
  assert.equal(state.includes("sub-1"), false);
  assert.equal(state.includes("x".repeat(70_000)), false);
  assert.equal(state.includes("hmac"), false);
});

test("M21: device-token changes do not alter rich cursor behavior", async () => {
  const source = await makeSource();
  const first = await run(source);
  const saved = process.env.PDPP_LOCAL_DEVICE_TOKEN;
  process.env.PDPP_LOCAL_DEVICE_TOKEN = "rotated-test-token";
  try {
    const second = await run({
      ...source,
      state: { messages: first.states.messages, sessions: first.states.sessions },
    });
    assert.equal(second.records.length, 0);
  } finally {
    if (saved === undefined) {
      delete process.env.PDPP_LOCAL_DEVICE_TOKEN;
    } else {
      process.env.PDPP_LOCAL_DEVICE_TOKEN = saved;
    }
  }
});

test("M22: sessions backfill independently without advancing the child cursor", async () => {
  const source = await makeSource();
  const first = await run(source);
  const sessionOnly = await run({ ...source, state: { messages: first.states.messages }, streams: ["sessions"] });
  assert.ok(sessionOnly.states.sessions);
  assert.equal(sessionOnly.states.messages, undefined);
});

test("M23: fixed-seed append, rewrite, truncate, and rotation fold equals a clean full scan", async () => {
  const source = await makeSource();
  const first = await run(source);
  await writeFile(
    source.top,
    `${await readFile(source.top, "utf8")}${transcriptLine("top-2", "2026-07-21T00:02:00Z")}\n`
  );
  const append = await run({ ...source, state: { messages: first.states.messages, sessions: first.states.sessions } });
  await truncate(source.subagent, 0);
  await writeFile(source.subagent, `${transcriptLine("sub-new", "2026-07-21T00:03:00Z")}\n`);
  const truncated = await run({
    ...source,
    state: { messages: append.states.messages, sessions: append.states.sessions },
  });
  const replacement = `${source.subagent}.replacement`;
  await writeFile(
    replacement,
    `${await readFile(source.subagent, "utf8")}${transcriptLine("sub-later", "2026-07-21T00:04:00Z")}\n`
  );
  await rename(replacement, source.subagent);
  const incremental = await run({
    ...source,
    state: { messages: truncated.states.messages, sessions: truncated.states.sessions },
  });
  const full = await run({ ...source, streams: ["sessions"] });
  assert.deepEqual(
    (incremental.states.sessions as { session_aggregates: Record<string, unknown> }).session_aggregates,
    (full.states.sessions as { session_aggregates: Record<string, unknown> }).session_aggregates
  );
});

test("incremental touch and append preserve parent-first session aggregation", async () => {
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

test("source mutations, partial tails, and malformed terminated lines retain physical cursor safety", async () => {
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

test("legacy baseline migration writes bounded private rich state", async () => {
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

test("M19: corrupt rich session cursor rebuilds every contributor instead of doubling its aggregate", async () => {
  const source = await makeSource();
  const first = await run(source);
  const sessions = structuredClone(first.states.sessions) as {
    file_cursors: Record<string, { committed_prefix_sha256: string }>;
  };
  const topCursor = sessions.file_cursors[source.top];
  assert.ok(topCursor);
  topCursor.committed_prefix_sha256 = "not-a-sha256";
  const repaired = await run({ ...source, state: { messages: first.states.messages, sessions } });
  assert.equal(
    repaired.records.filter((record) => record.stream === "sessions").length,
    0,
    "same fold is not re-emitted"
  );
  assert.equal(
    (repaired.states.sessions as { session_aggregates: Record<string, { message_count: number }> }).session_aggregates[
      SESSION_ID
    ]?.message_count,
    2
  );
});

test("partial rich session cursor state rebuilds all current contributors", async () => {
  const source = await makeSource();
  const first = await run(source);
  const sessions = structuredClone(first.states.sessions) as { file_cursors: Record<string, unknown> };
  delete sessions.file_cursors[source.subagent];
  const repaired = await run({ ...source, state: { messages: first.states.messages, sessions } });
  assert.equal(
    (repaired.states.sessions as { session_aggregates: Record<string, { message_count: number }> }).session_aggregates[
      SESSION_ID
    ]?.message_count,
    2
  );
});

test("aggregate-only local JSONL telemetry contains counts but no source identifiers", async () => {
  const source = await makeSource();
  const result = await run(source);
  const telemetry = result.messages.find(
    (message) => message.type === "PROGRESS" && message.message.startsWith("Claude Code local_jsonl ")
  );
  assert.ok(telemetry && telemetry.type === "PROGRESS");
  assert.match(
    telemetry.message,
    /fast_skip_files=\d+ verified_noop_files=\d+ append_files=\d+ rebuild_files=\d+ session_rebuild_all=\d+ prefix_bytes_hashed=\d+ tail_bytes_parsed=\d+ transcript_records_emitted=\d+ cursor_state_bytes=\d+/
  );
  assert.equal(telemetry.message.includes(source.top), false);
  assert.equal(telemetry.message.includes(source.subagent), false);
});

test("M14: removed sources are pruned from rich and dual-written mtime state", async () => {
  const source = await makeSource();
  const first = await run(source);
  await (await import("node:fs/promises")).rm(source.subagent);
  const second = await run({ ...source, state: { messages: first.states.messages, sessions: first.states.sessions } });
  for (const stream of ["messages", "sessions"] as const) {
    const cursor = second.states[stream] as {
      file_cursors: Record<string, unknown>;
      file_mtimes: Record<string, number>;
    };
    assert.equal(cursor.file_cursors[source.subagent], undefined);
    assert.equal(cursor.file_mtimes[source.subagent], undefined);
    assert.equal(Object.keys(cursor.file_cursors).length, 1);
    assert.equal(Object.keys(cursor.file_mtimes).length, 1);
  }
  assert.equal(second.records.find((record) => record.stream === "sessions")?.data.message_count, 1);
});

test("M24: Claude mtime touch queues no transcript records while advancing its durable checkpoint", async () => {
  const source = await makeSource();
  let persistedState: Record<string, unknown> = {};
  let statePuts = 0;
  const ingested: Array<{ records?: Array<{ stream?: string }> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body =
      chunks.length === 0 ? null : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    if (request.url?.endsWith("/state")) {
      if (request.method === "GET") {
        response.end(JSON.stringify({ state: persistedState }));
      } else {
        persistedState = { ...persistedState, ...(body?.state as Record<string, unknown>) };
        statePuts++;
        response.end(JSON.stringify({ state: persistedState }));
      }
      return;
    }
    if (request.url?.includes("/ingest-batches")) {
      ingested.push(body as { records?: Array<{ stream?: string }> });
      response.end(
        JSON.stringify({
          status: "accepted",
          accepted_record_count: body?.records ? (body.records as unknown[]).length : 0,
        })
      );
      return;
    }
    response.end(JSON.stringify({ status: "accepted" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const queuePath = join(source.claudeHome, "runner-outbox.sqlite");
  const config = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    batchSize: 10,
    connector: {
      args: ["connectors/claude_code/index.ts"],
      command: "tsx",
      connector_id: "claude_code",
      env: { CLAUDE_CODE_HOME: source.claudeHome, CLAUDE_CODE_PROJECTS_DIR: source.projects },
      runtime_requirements: { bindings: {} },
      streams: ["sessions", "messages"],
    },
    deviceId: "device-test",
    deviceToken: "test-token",
    queuePath,
    sourceInstanceId: "claude-mtime-touch",
  } as const;
  try {
    const first = await runCollectorConnector(config);
    assert.ok(first.recordsQueued > 0);
    const beforeTouch = structuredClone(persistedState);
    await utimes(source.top, new Date(Date.now() + 30_000), new Date(Date.now() + 30_000));
    ingested.length = 0;
    const touched = await runCollectorConnector(config);
    assert.equal(touched.recordsQueued, 0);
    assert.equal(
      ingested.flatMap((batch) => batch.records ?? []).filter((record) => record.stream === "messages").length,
      0,
      "touch-only Claude pass creates no transcript record_batch entries"
    );
    assert.ok(statePuts >= 2, "touch-only pass commits its refreshed cursor checkpoint");
    assert.notDeepEqual(persistedState, beforeTouch);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
