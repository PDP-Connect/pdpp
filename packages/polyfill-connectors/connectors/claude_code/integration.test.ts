/**
 * Integration tests for the Claude Code connector's `collect()` emit path —
 * specifically the per-JSONL-line dispatcher (`processJsonlLine`) and the
 * sessions-pass emitter (`emitSessionsFromAccumulators`).
 *
 * These tests DON'T touch the filesystem or scan ~/.claude/projects. They
 * construct a fake `LineEmitDeps` that captures every (stream, data) pair
 * pushed through `emitRecord`, then assert on the observable invariants:
 * session id must be pinned before any message/attachment lands, cross-stream
 * gating (messages off still permits attachments; and vice versa), all-streams
 * disabled emits nothing, message + attachment lines interleave in source
 * order within a session, and the sessions pass emits one record per
 * accumulator only when the sessions stream is requested.
 *
 * Imports directly from ./index.ts — `runConnector({...})` is guarded by
 * `isMainModule(import.meta.url)` so it only fires when index.ts is the
 * process entry point, not when a test imports it.
 *
 * Why bother: parsers.test.ts proves each record *shape* is correct from an
 * individual payload. These integration tests prove the cross-stream +
 * sessions-pass invariants consumers observe: the session-id-before-child
 * contract, that dropping one stream doesn't break siblings, that source
 * order is preserved, and that a session with no parseable messages still
 * gets a sessions record (so downstream sees the session existed even if
 * its content was malformed). Regressing any of these is a silent data-shape
 * bug parsers.test.ts can't catch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamScope } from "../../src/connector-runtime.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import {
  emitSessionsFromAccumulators,
  type JsonlObservations,
  type LineEmitDeps,
  makeJsonlObservations,
  observeJsonlFields,
  processJsonlLine,
} from "./index.ts";
import { makeEmptySessionAccumulator } from "./parsers.ts";
import type { JsonlObject, SessionAccumulator } from "./types.ts";

interface RecordingHarness {
  deps: LineEmitDeps;
  emitted: EmittedRecord[];
}

/** Build a LineEmitDeps that records every emitRecord() call. The
 *  claude_code connector does not (yet) ship a validateRecord helper, so
 *  makeRecordingEmit runs in pass-through mode — matching runtime
 *  semantics, where no shape-check happens for this connector. The
 *  shared harness still gives us a consistent emit/emitRecord surface
 *  across connectors, and switching this to validating mode is a
 *  one-line change once schemas land. */
function makeHarness({
  requested = ["messages", "attachments", "sessions"],
}: {
  requested?: readonly string[];
} = {}): RecordingHarness {
  const harness = makeRecordingEmit();
  const requestedMap = new Map<string, StreamScope>(requested.map((name) => [name, { name }]));
  const deps: LineEmitDeps = {
    emitRecord: harness.emitRecord,
    requested: requestedMap,
  };
  return { deps, emitted: harness.emitted };
}

/** Process one JSONL object through observe+dispatch — the same order the
 *  production parseJsonlFile loop does. */
async function drive(
  deps: LineEmitDeps,
  objs: readonly JsonlObject[],
  { forcedSessionId = null }: { forcedSessionId?: string | null } = {}
): Promise<JsonlObservations> {
  const obs = makeJsonlObservations(forcedSessionId);
  for (const obj of objs) {
    observeJsonlFields(obj, obs, forcedSessionId);
    await processJsonlLine({ deps, obj, obs });
  }
  return obs;
}

function messageLine(overrides: Partial<JsonlObject> = {}): JsonlObject {
  return {
    type: "user",
    uuid: "msg-uuid-1",
    sessionId: "sess-1",
    timestamp: "2026-04-22T00:00:01.000Z",
    message: { content: [{ type: "text", text: "hi" }] },
    ...overrides,
  };
}

function attachmentLine(overrides: Partial<JsonlObject> = {}): JsonlObject {
  return {
    type: "attachment",
    uuid: "att-uuid-1",
    sessionId: "sess-1",
    timestamp: "2026-04-22T00:00:02.000Z",
    attachment: { hookName: "post-tool-use", content: "hook stdout" },
    ...overrides,
  };
}

// ─── Invariant 1: session id must be pinned before children ─────────────────

test("processJsonlLine: line with no session id seen yet — nothing emits (defense-in-depth)", async () => {
  // Malformed transcript: a line arrives without ever having mentioned a
  // sessionId. observeJsonlFields leaves obs.sessionId=null; dispatcher
  // must refuse to emit a record with a null session_id.
  const { deps, emitted } = makeHarness();
  // Lines omit `sessionId` — observeJsonlFields won't pin anything.
  await drive(deps, [
    { type: "user", uuid: "u1", timestamp: "2026-04-22T00:00:01.000Z", message: "hi" },
    { type: "attachment", uuid: "a1", timestamp: "2026-04-22T00:00:02.000Z", attachment: {} },
  ]);
  assert.equal(emitted.length, 0, "no session id seen → no records land");
});

test("processJsonlLine: first line with sessionId pins it; subsequent messages carry session_id", async () => {
  const { deps, emitted } = makeHarness();
  await drive(deps, [
    // First line carries the sessionId; dispatcher sees obs.sessionId set.
    messageLine({ sessionId: "sess-A", uuid: "u1" }),
    messageLine({ sessionId: "sess-A", uuid: "u2", type: "assistant", timestamp: "2026-04-22T00:00:05.000Z" }),
  ]);
  const messages = emitted.filter((r) => r.stream === "messages");
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.data.session_id, "sess-A", "first message threads the pinned session id");
  assert.equal(messages[1]?.data.session_id, "sess-A", "second message carries the same session id");
});

test("processJsonlLine: forcedSessionId wins over per-line sessionId (subagent file case)", async () => {
  // Subagent files under <sessionId>/subagents/*.jsonl reuse the parent
  // session id from the directory name. The forcedSessionId argument to
  // observeJsonlFields pins that — any sessionId on the line is ignored.
  const { deps, emitted } = makeHarness();
  await drive(deps, [messageLine({ sessionId: "wrong-one", uuid: "u1" })], {
    forcedSessionId: "parent-sess",
  });
  const msg = emitted.find((r) => r.stream === "messages");
  assert.ok(msg);
  assert.equal(msg.data.session_id, "parent-sess", "forced id wins — subagent transcripts fold into parent session");
});

// ─── Invariant 2: stream-scope gating is independent per stream ─────────────

test("processJsonlLine: messages disabled — attachments still flow in the same pass", async () => {
  const { deps, emitted } = makeHarness({ requested: ["attachments"] });
  await drive(deps, [messageLine({ uuid: "u1" }), attachmentLine({ uuid: "a1" })]);
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 0, "messages gated off");
  assert.equal(emitted.filter((r) => r.stream === "attachments").length, 1, "attachment still lands");
});

test("processJsonlLine: attachments disabled — messages still flow in the same pass", async () => {
  const { deps, emitted } = makeHarness({ requested: ["messages"] });
  await drive(deps, [messageLine({ uuid: "u1" }), attachmentLine({ uuid: "a1" })]);
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 1, "message still emits");
  assert.equal(emitted.filter((r) => r.stream === "attachments").length, 0, "attachments gated off");
});

test("processJsonlLine: messages stream gated off still advances messageCount (session aggregate stays accurate)", async () => {
  // The messageCount counter feeds sessionAccumulator.message_count, which
  // is reported on the sessions record. If messages is off but sessions is
  // on, the count must still reflect the on-disk transcript.
  const { deps, emitted } = makeHarness({ requested: ["sessions"] });
  const obs = await drive(deps, [
    messageLine({ uuid: "u1" }),
    messageLine({ uuid: "u2", type: "assistant" }),
    attachmentLine({ uuid: "a1" }),
  ]);
  assert.equal(emitted.length, 0, "no per-line records when messages+attachments are off");
  assert.equal(obs.messageCount, 2, "messageCount advances even with messages stream gated off");
});

// ─── Invariant 3: all streams disabled → nothing emits ──────────────────────

test("processJsonlLine: neither messages nor attachments requested — nothing emits (sessions-only run)", async () => {
  // Sessions-only collections still scan the jsonl files to aggregate
  // metadata, but no per-line records should land.
  const { deps, emitted } = makeHarness({ requested: ["sessions"] });
  await drive(deps, [messageLine({ uuid: "u1" }), attachmentLine({ uuid: "a1" })]);
  assert.equal(emitted.length, 0, "no per-line records when both child streams are off");
});

// ─── Invariant 4: source order is preserved across streams within a session ─

test("processJsonlLine: messages and attachments emit in file-line order within a session", async () => {
  // Each type emits eagerly as its line is processed — unlike codex which
  // defers function_calls to flush. Pin that messages and attachments
  // interleave in source order so downstream sees them in timestamp order.
  const { deps, emitted } = makeHarness();
  await drive(deps, [
    messageLine({ uuid: "m1", timestamp: "2026-04-22T00:00:01.000Z" }),
    attachmentLine({ uuid: "a1", timestamp: "2026-04-22T00:00:02.000Z" }),
    messageLine({
      uuid: "m2",
      type: "assistant",
      timestamp: "2026-04-22T00:00:03.000Z",
    }),
    attachmentLine({
      uuid: "a2",
      type: "file-history-snapshot",
      timestamp: "2026-04-22T00:00:04.000Z",
    }),
  ]);
  const streams = emitted.map((r) => ({ stream: r.stream, id: r.data.id }));
  assert.deepEqual(
    streams,
    [
      { stream: "messages", id: "m1" },
      { stream: "attachments", id: "a1" },
      { stream: "messages", id: "m2" },
      { stream: "attachments", id: "a2" },
    ],
    "interleaved emit order matches source-line order"
  );
});

// ─── Invariant 5: timestamp propagation ─────────────────────────────────────

test("processJsonlLine: obj.timestamp threads into each emitted record's `timestamp` field", async () => {
  const { deps, emitted } = makeHarness();
  await drive(deps, [
    messageLine({ uuid: "m1", timestamp: "2026-04-22T01:23:45.000Z" }),
    attachmentLine({ uuid: "a1", timestamp: "2026-04-22T02:34:56.000Z" }),
  ]);
  const msg = emitted.find((r) => r.stream === "messages");
  const att = emitted.find((r) => r.stream === "attachments");
  assert.equal(msg?.data.timestamp, "2026-04-22T01:23:45.000Z", "message timestamp pinned from obj.timestamp");
  assert.equal(att?.data.timestamp, "2026-04-22T02:34:56.000Z", "attachment timestamp pinned from obj.timestamp");
});

// ─── Invariant 6: no per-line dedup (pin current behavior) ──────────────────

test("processJsonlLine: driving the same line twice emits twice (no per-line dedup at this layer)", async () => {
  // Claude Code's dedup happens upstream (mtime-gated file skip in
  // processJsonlFile). Inside the per-line dispatcher we're faithful to
  // input. Pin this so a future optimization that caches by uuid doesn't
  // land quietly — that invariant belongs one layer up.
  const { deps, emitted } = makeHarness();
  const obs = makeJsonlObservations(null);
  const line = messageLine({ uuid: "dup", sessionId: "sess-dup" });
  observeJsonlFields(line, obs, null);
  await processJsonlLine({ deps, obj: line, obs });
  await processJsonlLine({ deps, obj: line, obs });

  const msgs = emitted.filter((r) => r.stream === "messages");
  assert.equal(msgs.length, 2, "two emits for two passes — no dedup at this layer");
  // Both emits share the same uuid — the per-line layer doesn't disambiguate.
  assert.equal(msgs[0]?.data.id, "dup");
  assert.equal(msgs[1]?.data.id, "dup");
});

// ─── Invariant 7: metadata-only lines (summary, etc.) silently no-op ────────

test("processJsonlLine: unknown / metadata-only line types emit nothing (silent no-op)", async () => {
  // Transcripts include metadata-only lines (e.g. a `summary` header) that
  // match neither message nor attachment predicates. They must fold into
  // observations without emitting a record.
  const { deps, emitted } = makeHarness();
  const obs = await drive(deps, [
    // A line that pins sessionId + timestamp but is neither message nor attachment.
    {
      type: "summary",
      sessionId: "sess-X",
      timestamp: "2026-04-22T00:00:00.000Z",
      uuid: "summary-uuid",
    },
  ]);
  assert.equal(emitted.length, 0, "metadata-only line emits nothing");
  assert.equal(obs.sessionId, "sess-X", "observations still pin session id from the metadata line");
});

// ─── Invariant 8: missing uuid → no emit (uuid is the record id) ────────────

test("processJsonlLine: message line missing uuid → no record (uuid is the emit id)", async () => {
  // Defense-in-depth: a malformed line without a uuid can't become a
  // record because the dispatcher uses obj.uuid as the emitted id. Pin
  // the silent drop so it doesn't land as id=null/undefined downstream.
  const { deps, emitted } = makeHarness();
  // Construct a line without a uuid field at all (exactOptionalPropertyTypes
  // rejects `uuid: undefined`).
  const noUuidLine: JsonlObject = {
    type: "user",
    sessionId: "sess-nouuid",
    timestamp: "2026-04-22T00:00:01.000Z",
    message: { content: "hi" },
  };
  await drive(deps, [noUuidLine]);
  assert.equal(emitted.length, 0, "no uuid → no record");
});

// ─── Invariant 9: emitSessionsFromAccumulators — sessions-pass semantics ────

function makeAccumulator(id: string, overrides: Partial<SessionAccumulator> = {}): SessionAccumulator {
  return {
    ...makeEmptySessionAccumulator(id, `proj/${id}`),
    ...overrides,
  };
}

test("emitSessionsFromAccumulators: one record per accumulator in iteration order", async () => {
  const { deps, emitted } = makeHarness();
  const sessionAccumulators = new Map<string, SessionAccumulator>([
    ["sess-1", makeAccumulator("sess-1", { message_count: 3 })],
    ["sess-2", makeAccumulator("sess-2", { message_count: 0 })],
  ]);
  await emitSessionsFromAccumulators({
    emitRecord: deps.emitRecord,
    requested: deps.requested,
    sessionAccumulators,
  });
  const sessions = emitted.filter((r) => r.stream === "sessions");
  assert.equal(sessions.length, 2, "one record per accumulator");
  assert.deepEqual(
    sessions.map((r) => r.data.id),
    ["sess-1", "sess-2"],
    "Map iteration order preserved"
  );
});

test("emitSessionsFromAccumulators: session with zero messages still emits (null/empty enrichment fallback)", async () => {
  // A session dir with malformed or empty jsonl yields an accumulator with
  // message_count=0 and all-null metadata. It must still land a sessions
  // record so downstream sees the session existed on disk — the invariant
  // is "session record exists iff the session dir exists", not "iff the
  // session had parseable content".
  const { deps, emitted } = makeHarness();
  const sessionAccumulators = new Map<string, SessionAccumulator>([["sess-empty", makeAccumulator("sess-empty")]]);
  await emitSessionsFromAccumulators({
    emitRecord: deps.emitRecord,
    requested: deps.requested,
    sessionAccumulators,
  });
  const sessions = emitted.filter((r) => r.stream === "sessions");
  assert.equal(sessions.length, 1, "empty session still lands");
  assert.equal(sessions[0]?.data.message_count, 0);
  assert.equal(sessions[0]?.data.started_at, null, "null timestamps ok — session still emits");
});

test("emitSessionsFromAccumulators: sessions stream gated off — no records emit", async () => {
  const { deps, emitted } = makeHarness({ requested: ["messages", "attachments"] });
  const sessionAccumulators = new Map<string, SessionAccumulator>([["sess-1", makeAccumulator("sess-1")]]);
  await emitSessionsFromAccumulators({
    emitRecord: deps.emitRecord,
    requested: deps.requested,
    sessionAccumulators,
  });
  assert.equal(emitted.length, 0, "sessions stream off → no emit");
});

test("emitSessionsFromAccumulators: emitted record is a shallow copy (mutating accumulator doesn't leak)", async () => {
  // Accumulators are mutated in-place during parsing. If the emitter
  // shared the same object reference with the caller, a post-emit mutation
  // on the map would silently rewrite downstream records. Pin the copy.
  const { deps, emitted } = makeHarness();
  const acc = makeAccumulator("sess-1", { message_count: 5 });
  const sessionAccumulators = new Map<string, SessionAccumulator>([["sess-1", acc]]);
  await emitSessionsFromAccumulators({
    emitRecord: deps.emitRecord,
    requested: deps.requested,
    sessionAccumulators,
  });
  // Mutate the accumulator post-emit.
  acc.message_count = 999;
  const sessionRec = emitted.find((r) => r.stream === "sessions");
  assert.equal(sessionRec?.data.message_count, 5, "emitted record snapshots message_count at emit time");
});

// ─── Two-pass buildOnly contract (Tranche C parent-first) ──────────────────
//
// These tests pin the buildOnly flag's contract on processJsonlLine directly
// (no filesystem), and then the ORCHESTRATION test below runs the real
// scanProjectDirs against a tmpdir to prove end-to-end parent-first emit.
// The orchestration test would fail if:
//   - pass 1 emitted messages (buildOnly leak)
//   - pass 2 emitted nothing (orchestration regression)
//   - sessions emitted after messages (parent-first regression)
//   - accumulators were updated twice (double-count on message_count)

test("processJsonlLine: buildOnly=true suppresses message emit but still bumps messageCount", async () => {
  const { deps, emitted } = makeHarness();
  const obs = makeJsonlObservations(null);
  const line = { type: "user", sessionId: "sess-A", uuid: "m1", timestamp: "2026-04-23T10:00:00Z" };
  observeJsonlFields(line as JsonlObject, obs, null);
  await processJsonlLine({ buildOnly: true, deps, obj: line as JsonlObject, obs });

  assert.equal(emitted.length, 0, "buildOnly=true emits nothing");
  assert.equal(obs.messageCount, 1, "messageCount still incremented (feeds session aggregate)");
});

test("processJsonlLine: buildOnly=true suppresses attachment emit but still observes session fields", async () => {
  const { deps, emitted } = makeHarness();
  const obs = makeJsonlObservations(null);
  const line = { type: "attachment", sessionId: "sess-B", uuid: "a1", timestamp: "2026-04-23T10:00:01Z" };
  observeJsonlFields(line as JsonlObject, obs, null);
  await processJsonlLine({ buildOnly: true, deps, obj: line as JsonlObject, obs });

  assert.equal(emitted.length, 0, "buildOnly=true emits nothing");
  assert.equal(obs.sessionId, "sess-B", "session id still observed");
});

test("processJsonlLine: buildOnly=false (default behavior) DOES emit when requested", async () => {
  const { deps, emitted } = makeHarness();
  const obs = makeJsonlObservations(null);
  const line = { type: "user", sessionId: "sess-C", uuid: "m1", timestamp: "2026-04-23T10:00:02Z" };
  observeJsonlFields(line as JsonlObject, obs, null);
  await processJsonlLine({ buildOnly: false, deps, obj: line as JsonlObject, obs });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.stream, "messages");
});
