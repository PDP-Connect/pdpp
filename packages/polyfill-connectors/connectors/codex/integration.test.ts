/**
 * Integration tests for the Codex connector's `collect()` emit path —
 * specifically the per-rollout-line dispatchers (`processRolloutLine`,
 * `processResponseItem`, `flushPendingCalls`) and the sessions merge
 * (`emitSessionsFromMaps`).
 *
 * These tests DON'T touch the filesystem or open state_5.sqlite. They
 * construct a fake `LineEmitDeps` that captures every (stream, data)
 * pair pushed through `emitRecord` plus every progress message, then
 * assert on the observable invariants: session_meta-before-children
 * (session id must install before any response_item lands), cross-stream
 * gating (messages off still permits function_calls; and vice versa),
 * all-streams-disabled emits nothing, function_call + output pair into
 * a single record at flush, orphan output emits its own record,
 * source-order is preserved across streams, timestamps thread into
 * messages, and the sessions pass dedups on session id (thread-preferred
 * when both maps list it).
 *
 * Imports directly from ./index.ts — `main().catch(...)` is guarded by
 * `isMainModule(import.meta.url)` so it only fires when index.ts is the
 * process entry point, not when a test imports it.
 *
 * Why bother: parsers.test.ts proves each record *shape* is correct
 * from an individual payload. These integration tests prove the
 * cross-stream + sessions-merge invariants consumers observe: the
 * parent-before-child contract, that dropping one stream doesn't break
 * siblings, that `function_calls` assembles paired records at EOF, and
 * that a session present in both state_5 and rolloutAggregates lands
 * exactly once. Regressing any of these is a silent data-shape bug
 * parsers.test.ts can't catch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordData, StreamScope } from "../../src/connector-runtime.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import {
  emitSessionsFromMaps,
  flushPendingCalls,
  type LineEmitDeps,
  makeRolloutParseState,
  processRolloutLine,
  readPriorThreadFingerprints,
  shouldDeferActiveRolloutFile,
  shouldReemitThreadSession,
} from "./index.ts";
import type {
  RolloutAggregate,
  RolloutObject,
  RolloutPayload,
  StartMessage,
  ThreadFingerprint,
  ThreadRow,
} from "./types.ts";

interface RecordingHarness {
  deps: LineEmitDeps;
  emitted: EmittedRecord[];
  progressMessages: string[];
}

/** Build a LineEmitDeps that records every emitRecord() + progress() call.
 *  Uses makeRecordingEmit() in pass-through mode — the codex connector
 *  does not currently ship a validateRecord helper, so the production
 *  runtime performs no shape-check on its records; matching that here
 *  keeps the test truthful. LineEmitDeps expects a sync emitRecord
 *  returning void; the shared harness returns Promise<void>, so we wrap
 *  to drop the promise — the underlying push into .emitted is synchronous. */
function makeHarness({
  requested = ["messages", "function_calls", "sessions"],
}: {
  requested?: readonly string[];
} = {}): RecordingHarness {
  const harness = makeRecordingEmit();
  const progressMessages: string[] = [];
  const requestedMap = new Map<string, StreamScope>(requested.map((name) => [name, { name }]));
  const deps: LineEmitDeps = {
    emitRecord: (stream: string, data: RecordData): void => {
      // Fire-and-forget: harness.emitRecord resolves synchronously in
      // pass-through mode (no await points). We ignore the resolved
      // promise to honour the sync void return LineEmitDeps declares.
      harness.emitRecord(stream, data).catch((): undefined => undefined);
    },
    progress: (message: string): void => {
      progressMessages.push(message);
    },
    requested: requestedMap,
  };
  return { deps, emitted: harness.emitted, progressMessages };
}

/** Synthetic session_meta line. `id` is the session UUID downstream records
 *  reference via `session_id`. */
function sessionMetaLine(id: string, overrides: RolloutPayload = {}): RolloutObject {
  return {
    type: "session_meta",
    timestamp: "2026-04-22T00:00:00.000Z",
    payload: { id, timestamp: "2026-04-22T00:00:00.000Z", ...overrides },
  };
}

function messageLine(text: string, role = "user", ts = "2026-04-22T00:00:01.000Z"): RolloutObject {
  return {
    type: "response_item",
    timestamp: ts,
    payload: {
      type: "message",
      role,
      content: [{ text }],
    },
  };
}

function functionCallLine(callId: string, name: string, args: string, ts = "2026-04-22T00:00:02.000Z"): RolloutObject {
  return {
    type: "response_item",
    timestamp: ts,
    payload: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: args,
    },
  };
}

function functionCallOutputLine(
  callId: string | undefined,
  output: string,
  ts = "2026-04-22T00:00:03.000Z"
): RolloutObject {
  const payload: RolloutPayload = {
    type: "function_call_output",
    output,
  };
  if (callId !== undefined) {
    payload.call_id = callId;
  }
  return {
    type: "response_item",
    timestamp: ts,
    payload,
  };
}

function drive(deps: LineEmitDeps, objs: readonly RolloutObject[], file = "rollout-test.jsonl"): void {
  const state = makeRolloutParseState();
  for (const obj of objs) {
    processRolloutLine({ obj, state, deps, file });
  }
  flushPendingCalls(state, deps);
}

test("shouldDeferActiveRolloutFile defers only files inside the quiet window", () => {
  const nowMs = Date.parse("2026-05-20T20:45:00.000Z");
  assert.equal(
    shouldDeferActiveRolloutFile({ mtimeMs: nowMs - 10_000, nowMs, quietMs: 120_000 }),
    true,
    "recently modified rollout should wait for a later collector pass"
  );
  assert.equal(
    shouldDeferActiveRolloutFile({ mtimeMs: nowMs - 180_000, nowMs, quietMs: 120_000 }),
    false,
    "quiet rollout can be collected"
  );
  assert.equal(
    shouldDeferActiveRolloutFile({ mtimeMs: nowMs - 10_000, nowMs, quietMs: 0 }),
    false,
    "operators can disable the quiet window explicitly"
  );
});

// ─── Invariant 1: parent-before-child (session_meta gates response_items) ────

test("processRolloutLine: response_items before session_meta emit nothing (no session id = no records)", () => {
  // Defense-in-depth: if a malformed rollout somehow puts a response_item
  // before session_meta, the dispatcher must not emit a record with a
  // null session_id. The session id is pinned at session_meta time.
  const { deps, emitted } = makeHarness();
  drive(deps, [messageLine("ghost message"), functionCallLine("c1", "shell", "ls")]);
  assert.equal(emitted.length, 0, "no session id seen → no records land");
});

test("processRolloutLine: session_meta installs the session id; subsequent messages carry session_id", () => {
  const { deps, emitted } = makeHarness();
  drive(deps, [sessionMetaLine("sess-A"), messageLine("hello")]);
  const msgRec = emitted.find((r) => r.stream === "messages");
  assert.ok(msgRec, "messages record must emit after session_meta");
  assert.equal(msgRec.data.session_id, "sess-A", "session_id threads through from session_meta");
});

// ─── Invariant 2: stream-scope gating is independent per stream ──────────────

test("processRolloutLine: messages disabled — function_calls still flow in the same pass", () => {
  const { deps, emitted } = makeHarness({ requested: ["function_calls"] });
  drive(deps, [
    sessionMetaLine("sess-B"),
    messageLine("hi"),
    functionCallLine("c1", "shell", "ls"),
    functionCallOutputLine("c1", "total 0"),
  ]);
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 0, "messages gated off");
  assert.equal(emitted.filter((r) => r.stream === "function_calls").length, 1, "paired call emits once on flush");
});

test("processRolloutLine: function_calls disabled — messages still flow in the same pass", () => {
  const { deps, emitted } = makeHarness({ requested: ["messages"] });
  drive(deps, [
    sessionMetaLine("sess-C"),
    messageLine("hi"),
    functionCallLine("c1", "shell", "ls"),
    functionCallOutputLine("c1", "done"),
  ]);
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 1, "messages still emit");
  assert.equal(emitted.filter((r) => r.stream === "function_calls").length, 0, "function_calls gated off");
});

// ─── Invariant 3: all streams disabled → nothing emits ──────────────────────

test("processRolloutLine: neither messages nor function_calls requested — nothing emits (sessions-only run)", () => {
  // Sessions-only collections run rollout scan for aggregates, not record
  // emit — ensure the per-line dispatcher respects that.
  const { deps, emitted } = makeHarness({ requested: ["sessions"] });
  drive(deps, [
    sessionMetaLine("sess-D"),
    messageLine("hi"),
    functionCallLine("c1", "shell", "ls"),
    functionCallOutputLine("c1", "done"),
  ]);
  assert.equal(emitted.length, 0, "no per-line records when both streams are off");
});

// ─── Invariant 4: function_call + output pair into one record at EOF ────────

test("flushPendingCalls: function_call + matching output merge into a single record at end-of-file", () => {
  const { deps, emitted } = makeHarness();
  drive(deps, [
    sessionMetaLine("sess-E"),
    functionCallLine("call-1", "shell", "echo hi"),
    functionCallOutputLine("call-1", "hi\n"),
  ]);
  const calls = emitted.filter((r) => r.stream === "function_calls");
  assert.equal(calls.length, 1, "one merged record per call_id");
  assert.equal(calls[0]?.data.call_id, "call-1");
  assert.equal(calls[0]?.data.name, "shell", "name from the call side");
  assert.equal(calls[0]?.data.arguments, "echo hi", "arguments from the call side");
  assert.equal(calls[0]?.data.output_preview, "hi\n", "output from the matching output line");
});

test("processRolloutLine: orphan function_call_output (no matching call) emits its own record immediately", () => {
  // Observed in rollouts where a tool output lands without the paired
  // call (e.g. replay of partial state). The connector still lands the
  // output so downstream sees the bytes — with name/arguments nulled.
  const { deps, emitted } = makeHarness();
  drive(deps, [sessionMetaLine("sess-F"), functionCallOutputLine("orphan-x", "stdout bytes")]);
  const calls = emitted.filter((r) => r.stream === "function_calls");
  assert.equal(calls.length, 1, "orphan output lands as its own record");
  assert.equal(calls[0]?.data.call_id, "orphan-x");
  assert.equal(calls[0]?.data.name, null, "name null — no paired call_line");
  assert.equal(calls[0]?.data.arguments, null);
  assert.equal(calls[0]?.data.output_preview, "stdout bytes");
});

// ─── Invariant 5: source order is preserved across streams ──────────────────

test("processRolloutLine: messages and pre-flush function_calls emit in file-line order within a session", () => {
  // function_calls emit on EOF flush (or on orphan output), but messages
  // emit eagerly as their line is processed. Pin the observable sequence:
  // messages come out in source order; paired calls all land together at
  // flush after the last message.
  const { deps, emitted } = makeHarness();
  drive(deps, [
    sessionMetaLine("sess-G"),
    messageLine("first message"),
    functionCallLine("c1", "shell", "ls"),
    messageLine("second message", "assistant"),
    functionCallOutputLine("c1", "out"),
    messageLine("third message", "user"),
  ]);
  const streams = emitted.map((r) => r.stream);
  // Three messages emit in source order before the flush-time call record.
  const msgIdxs = streams.flatMap((s, i) => (s === "messages" ? [i] : []));
  const callIdxs = streams.flatMap((s, i) => (s === "function_calls" ? [i] : []));
  assert.equal(msgIdxs.length, 3, "three messages landed");
  assert.equal(callIdxs.length, 1, "one merged function_call record");
  const [m0, m1, m2] = msgIdxs;
  const [c0] = callIdxs;
  assert.ok(m0 !== undefined && m1 !== undefined && m0 < m1, "first < second message");
  assert.ok(m1 !== undefined && m2 !== undefined && m1 < m2, "second < third message");
  assert.ok(m2 !== undefined && c0 !== undefined && m2 < c0, "function_calls flush lands after all messages");
});

// ─── Invariant 6: timestamp propagation ─────────────────────────────────────

test("processRolloutLine: obj.timestamp threads into each messages record's `timestamp` field", () => {
  const { deps, emitted } = makeHarness();
  drive(deps, [sessionMetaLine("sess-H"), messageLine("hi", "user", "2026-04-22T01:23:45.000Z")]);
  const msg = emitted.find((r) => r.stream === "messages");
  assert.ok(msg);
  assert.equal(msg.data.timestamp, "2026-04-22T01:23:45.000Z", "line timestamp pinned into the record");
});

// ─── Invariant 7: same line processed twice emits twice (no hidden dedup) ────

test("processRolloutLine: driving the same message line twice emits twice (no per-line dedup)", () => {
  // Codex's dedup happens upstream (mtime-gated file skip in
  // processRolloutEntry). Inside the per-line dispatcher we're faithful to
  // input — pin this so a future optimization that caches by (sessionId,
  // lineCount) id doesn't land quietly.
  const { deps, emitted } = makeHarness();
  const state = makeRolloutParseState();
  processRolloutLine({ obj: sessionMetaLine("sess-I"), state, deps, file: "r.jsonl" });
  const m = messageLine("repeat me");
  processRolloutLine({ obj: m, state, deps, file: "r.jsonl" });
  processRolloutLine({ obj: m, state, deps, file: "r.jsonl" });
  flushPendingCalls(state, deps);

  const msgs = emitted.filter((r) => r.stream === "messages");
  assert.equal(msgs.length, 2, "two emits for two passes — no dedup at this layer");
  // IDs differ because lineCount advances each pass.
  assert.notEqual(msgs[0]?.data.id, msgs[1]?.data.id, "ids disambiguate duplicate lines via lineCount");
});

// ─── Invariant 8: emitSessionsFromMaps dedup + fallback ─────────────────────

function makeThreadRow(id: string, overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id,
    rollout_path: `/rollouts/${id}.jsonl`,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_010,
    source: "cli",
    model_provider: "openai",
    cwd: "/repo",
    title: "from state_5",
    sandbox_policy: "workspace_write",
    approval_mode: "always",
    tokens_used: 42,
    has_user_event: 1,
    archived: 0,
    archived_at: null,
    git_sha: "abc",
    git_branch: "main",
    git_origin_url: "https://example.com/r.git",
    cli_version: "1.0.0",
    first_user_message: "hello",
    agent_nickname: null,
    agent_role: null,
    memory_mode: null,
    model: "gpt-5",
    reasoning_effort: "high",
    ...overrides,
  };
}

function makeAggregate(overrides: Partial<RolloutAggregate> = {}): RolloutAggregate {
  return {
    meta: { timestamp: "2026-04-22T00:00:00Z" },
    firstTs: "2026-04-22T00:00:00Z",
    lastTs: "2026-04-22T00:00:10Z",
    messageCount: 5,
    functionCallCount: 2,
    rolloutPath: "/rollouts/x.jsonl",
    ...overrides,
  };
}

test("emitSessionsFromMaps: session present in BOTH threads + aggregates emits exactly ONCE (thread-preferred)", () => {
  const { deps, emitted } = makeHarness();
  const threadsMap = new Map<string, ThreadRow>([["sess-dup", makeThreadRow("sess-dup")]]);
  const aggs = new Map<string, RolloutAggregate>([["sess-dup", makeAggregate()]]);
  emitSessionsFromMaps({ threadsMap, rolloutAggregates: aggs, emitRecord: deps.emitRecord });

  const sessions = emitted.filter((r) => r.stream === "sessions");
  assert.equal(sessions.length, 1, "one session id = one emit");
  // Thread-preferred: title comes from state_5, counts come from aggregate.
  assert.equal(sessions[0]?.data.title, "from state_5", "thread row wins on title");
  assert.equal(sessions[0]?.data.message_count, 5, "aggregate merged in for counts");
  assert.equal(sessions[0]?.data.function_call_count, 2);
});

test("emitSessionsFromMaps: rollout-only sessions (not in threadsMap) emit as fallback with nulls for state_5 fields", () => {
  const { deps, emitted } = makeHarness();
  const aggs = new Map<string, RolloutAggregate>([["sess-rollout-only", makeAggregate()]]);
  emitSessionsFromMaps({ threadsMap: new Map(), rolloutAggregates: aggs, emitRecord: deps.emitRecord });

  const sessions = emitted.filter((r) => r.stream === "sessions");
  assert.equal(sessions.length, 1, "rollout-only session still lands");
  assert.equal(sessions[0]?.data.id, "sess-rollout-only");
  assert.equal(sessions[0]?.data.title, null, "title null (state_5 absent)");
  assert.equal(sessions[0]?.data.archived, null, "state_5-only fields null in fallback");
  assert.equal(sessions[0]?.data.message_count, 5, "aggregate counts still land");
});

test("emitSessionsFromMaps: thread-only and rollout-only sessions both emit; disjoint ids yield two records", () => {
  const { deps, emitted } = makeHarness();
  const threadsMap = new Map<string, ThreadRow>([["sess-thread", makeThreadRow("sess-thread")]]);
  const aggs = new Map<string, RolloutAggregate>([["sess-rollout", makeAggregate()]]);
  emitSessionsFromMaps({ threadsMap, rolloutAggregates: aggs, emitRecord: deps.emitRecord });

  const ids = emitted.filter((r) => r.stream === "sessions").map((r) => r.data.id);
  assert.deepEqual(ids.sort(), ["sess-rollout", "sess-thread"], "both sources contribute one record each");
});

// ─── Invariant 9: lossy-overwrite repair + churn reduction via fingerprints ──
//
// Background: the Codex local-device connector was emitting ~7.7 GB of
// `function_calls` / `messages` / `sessions` history JSON in Postgres,
// dominated by `sessions` versioning. Two bugs combined:
//
//   (a) `emitSessions` looped every thread row from state_5.sqlite on every
//       run where state_5.sqlite's mtime had changed (very frequent — Codex
//       updates threads constantly). With ~1,298 threads, every run wrote a
//       new history version per thread even when nothing about that thread
//       had changed.
//   (b) When state_5 mtime moved but the session's rollout file did not, the
//       run had no `RolloutAggregate` for that session — so the emitted
//       `sessions` record got `message_count: null` and `function_call_count:
//       null`, clobbering the previously-correct counts (observed on
//       `019d922d-c38b-7e11-ae99-9187af386148`).
//
// Fix: a per-thread fingerprint (carried on the `sessions` STATE cursor)
// gates both behaviors. These tests pin the contract.

test("shouldReemitThreadSession: new session (no prior fingerprint) — emit", () => {
  assert.equal(shouldReemitThreadSession(makeThreadRow("sess-new"), undefined, undefined), true);
});

test("shouldReemitThreadSession: this run parsed the rollout — emit (aggregate may have moved counts)", () => {
  const prior: ThreadFingerprint = { updated_at: 1_700_000_010, message_count: 3, function_call_count: 1 };
  assert.equal(shouldReemitThreadSession(makeThreadRow("sess-x"), makeAggregate(), prior), true);
});

test("shouldReemitThreadSession: thread.updated_at moved forward — emit", () => {
  const prior: ThreadFingerprint = { updated_at: 1_700_000_005, message_count: 3, function_call_count: 1 };
  // makeThreadRow default updated_at is 1_700_000_010 — strictly greater than prior.
  assert.equal(shouldReemitThreadSession(makeThreadRow("sess-x"), undefined, prior), true);
});

test("shouldReemitThreadSession: thread.updated_at unchanged AND no aggregate — SKIP (the churn fix)", () => {
  const prior: ThreadFingerprint = { updated_at: 1_700_000_010, message_count: 3, function_call_count: 1 };
  assert.equal(
    shouldReemitThreadSession(makeThreadRow("sess-x"), undefined, prior),
    false,
    "no rollout parsed + same updated_at = nothing changed, don't re-emit"
  );
});

test("shouldReemitThreadSession: updated_at moved backward (shouldn't happen, but tolerate) — SKIP", () => {
  const prior: ThreadFingerprint = { updated_at: 1_700_000_999, message_count: 3, function_call_count: 1 };
  assert.equal(shouldReemitThreadSession(makeThreadRow("sess-x"), undefined, prior), false);
});

test("emitSessionsFromMaps: unchanged thread with no aggregate — SKIPS emit but carries fingerprint forward", () => {
  // Stable-thread scenario: state_5.sqlite mtime changed (some OTHER thread
  // moved), but this thread's updated_at didn't budge and its rollout file
  // wasn't parsed this run. Pre-fix behavior: re-emit anyway with null
  // counts (lossy + churn). Post-fix: skip emit, preserve fingerprint.
  const { deps, emitted } = makeHarness();
  const threadsMap = new Map<string, ThreadRow>([["sess-stable", makeThreadRow("sess-stable")]]);
  const aggs = new Map<string, RolloutAggregate>();
  const priorFingerprints = new Map<string, ThreadFingerprint>([
    ["sess-stable", { updated_at: 1_700_000_010, message_count: 42, function_call_count: 7 }],
  ]);
  const fingerprintSink = new Map<string, ThreadFingerprint>(priorFingerprints);

  emitSessionsFromMaps({
    threadsMap,
    rolloutAggregates: aggs,
    emitRecord: deps.emitRecord,
    priorFingerprints,
    fingerprintSink,
  });

  const sessions = emitted.filter((r) => r.stream === "sessions");
  assert.equal(sessions.length, 0, "no churn — unchanged thread skipped");
  assert.deepEqual(
    fingerprintSink.get("sess-stable"),
    { updated_at: 1_700_000_010, message_count: 42, function_call_count: 7 },
    "fingerprint preserved verbatim for next-run gating"
  );
});

test("emitSessionsFromMaps: thread WITH prior counts but no fresh aggregate — preserves counts (no lossy null overwrite)", () => {
  // The original bug: state_5 mtime moved, this thread's updated_at also
  // moved (so we DO emit), but no rollout was parsed → agg = undefined →
  // pre-fix wrote `message_count: null`, clobbering a real prior value.
  // Post-fix: fall back to prior fingerprint counts.
  const { deps, emitted } = makeHarness();
  const threadsMap = new Map<string, ThreadRow>([
    ["sess-touched", makeThreadRow("sess-touched", { updated_at: 1_700_000_999 /* moved forward */ })],
  ]);
  const aggs = new Map<string, RolloutAggregate>();
  const priorFingerprints = new Map<string, ThreadFingerprint>([
    ["sess-touched", { updated_at: 1_700_000_010, message_count: 42, function_call_count: 7 }],
  ]);
  const fingerprintSink = new Map<string, ThreadFingerprint>(priorFingerprints);

  emitSessionsFromMaps({
    threadsMap,
    rolloutAggregates: aggs,
    emitRecord: deps.emitRecord,
    priorFingerprints,
    fingerprintSink,
  });

  const sessions = emitted.filter((r) => r.stream === "sessions");
  assert.equal(sessions.length, 1, "thread changed → emit");
  assert.equal(sessions[0]?.data.message_count, 42, "prior count preserved, not null");
  assert.equal(sessions[0]?.data.function_call_count, 7, "prior count preserved, not null");
  // Fingerprint advances updated_at but keeps the counts (still no fresh aggregate).
  assert.deepEqual(fingerprintSink.get("sess-touched"), {
    updated_at: 1_700_000_999,
    message_count: 42,
    function_call_count: 7,
  });
});

test("emitSessionsFromMaps: fresh aggregate beats prior fingerprint counts (real updates win)", () => {
  // The aggregate IS the source of truth when present — prior fingerprint
  // is fallback only.
  const { deps, emitted } = makeHarness();
  const threadsMap = new Map<string, ThreadRow>([["sess-active", makeThreadRow("sess-active")]]);
  const aggs = new Map<string, RolloutAggregate>([
    ["sess-active", makeAggregate({ messageCount: 99, functionCallCount: 11 })],
  ]);
  const priorFingerprints = new Map<string, ThreadFingerprint>([
    ["sess-active", { updated_at: 1_700_000_010, message_count: 42, function_call_count: 7 }],
  ]);
  const fingerprintSink = new Map<string, ThreadFingerprint>(priorFingerprints);

  emitSessionsFromMaps({
    threadsMap,
    rolloutAggregates: aggs,
    emitRecord: deps.emitRecord,
    priorFingerprints,
    fingerprintSink,
  });

  const sessions = emitted.filter((r) => r.stream === "sessions");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.data.message_count, 99, "aggregate wins over fingerprint");
  assert.equal(sessions[0]?.data.function_call_count, 11);
  assert.deepEqual(fingerprintSink.get("sess-active"), {
    updated_at: 1_700_000_010,
    message_count: 99,
    function_call_count: 11,
  });
});

test("emitSessionsFromMaps: first run (no prior fingerprints) — emits everything, populates sink", () => {
  // Back-compat: existing callers that didn't pass priorFingerprints
  // continue to behave as before — every thread emits. Sink populates so
  // the next run can gate properly.
  const { deps, emitted } = makeHarness();
  const threadsMap = new Map<string, ThreadRow>([
    ["sess-1", makeThreadRow("sess-1")],
    ["sess-2", makeThreadRow("sess-2")],
  ]);
  const aggs = new Map<string, RolloutAggregate>([["sess-1", makeAggregate()]]);
  const fingerprintSink = new Map<string, ThreadFingerprint>();

  emitSessionsFromMaps({
    threadsMap,
    rolloutAggregates: aggs,
    emitRecord: deps.emitRecord,
    fingerprintSink,
  });

  const sessions = emitted.filter((r) => r.stream === "sessions");
  assert.equal(sessions.length, 2, "no prior = emit everything");
  assert.equal(fingerprintSink.size, 2, "fingerprints captured for next-run gating");
  assert.equal(fingerprintSink.get("sess-1")?.message_count, 5, "aggregate count captured");
  assert.equal(fingerprintSink.get("sess-2")?.message_count, null, "no-aggregate thread fingerprint has null count");
});

// ─── Invariant 10: forked rollouts — only the FIRST session_meta wins ──────
//
// Background: when a Codex thread forks (e.g. subagent spawn), the resulting
// rollout file starts with TWO session_meta lines:
//   line 1 — the child (canonical) session id, carrying `forked_from_id`.
//   line 2 — the fork parent's session_meta replayed for context.
// Every response_item that follows belongs to the CHILD session. Before this
// fix the parser overwrote `state.sessionId` on every session_meta, so the
// child's id was clobbered and all subsequent messages/function_calls were
// emitted under the parent's id — leaving the child session with null counts
// in state_5/threads merging. Pin the contract: only the first session_meta
// installs id+meta; later session_meta lines are inert.
//
// Real example from ~/.codex/sessions/...rollout-...019d9268.../jsonl:
//   id=019d9268-ffa5-72b3-9cba-e2a59443cd41 (child, file-canonical)
//   forked_from_id / second meta id = 019d922d-c38b-7e11-ae99-9187af386148

function forkedSessionMetaParentLine(parentId: string): RolloutObject {
  // Codex emits the parent meta a few ms after the child meta. We pin the
  // type/shape so a future schema tweak doesn't silently change behavior.
  return {
    type: "session_meta",
    timestamp: "2026-04-22T00:00:00.001Z",
    payload: {
      id: parentId,
      timestamp: "2026-04-22T00:00:00.000Z",
      cwd: "/repo",
      originator: "codex-tui",
    },
  };
}

test("processRolloutLine: forked rollout — first session_meta pins child id; second session_meta (parent) is ignored", () => {
  const childId = "019d9268-ffa5-72b3-9cba-e2a59443cd41";
  const parentId = "019d922d-c38b-7e11-ae99-9187af386148";
  const { deps, emitted } = makeHarness();
  const state = makeRolloutParseState();
  const lines: RolloutObject[] = [
    sessionMetaLine(childId, { originator: "codex-tui" }),
    forkedSessionMetaParentLine(parentId),
    messageLine("first child message"),
    functionCallLine("c1", "shell", "ls"),
    functionCallOutputLine("c1", "out"),
    messageLine("second child message", "assistant"),
  ];
  for (const obj of lines) {
    processRolloutLine({ obj, state, deps, file: "rollout-fork.jsonl" });
  }
  flushPendingCalls(state, deps);

  // State stays pinned to the child id even after the parent's session_meta lands.
  assert.equal(state.sessionId, childId, "sessionId stays on child after parent session_meta");
  assert.equal(state.sessionMeta?.id, childId, "sessionMeta still describes the child");
  // Every emitted record carries the child session id, never the parent's.
  const msgRecs = emitted.filter((r) => r.stream === "messages");
  const callRecs = emitted.filter((r) => r.stream === "function_calls");
  assert.equal(msgRecs.length, 2, "both child messages emit");
  for (const m of msgRecs) {
    assert.equal(m.data.session_id, childId, "message session_id is the child");
    assert.ok(String(m.data.id).startsWith(`${childId}:`), "message record id is prefixed with child session id");
    assert.notEqual(m.data.session_id, parentId, "message must not attribute to fork parent");
  }
  assert.equal(callRecs.length, 1, "the paired function_call lands once");
  assert.equal(callRecs[0]?.data.session_id, childId, "function_call session_id is the child");
  // Counts on state are the child's lifetime within this rollout file.
  assert.equal(state.messageCount, 2, "messageCount counts child messages only");
  assert.equal(state.functionCallCount, 1, "functionCallCount counts child calls only");
});

test("processRolloutLine: forked rollout aggregate writes back under the child id, not the parent id", () => {
  // Mirrors what parseRolloutFile would persist into `rolloutAggregates` —
  // pin the invariant via processRolloutLine + the closing state read.
  // (parseRolloutFile is `async` and owns the JSONL iterator; the
  // aggregate write-back uses `state.sessionId` directly, so testing
  // the per-line dispatcher is sufficient to lock the behavior.)
  const childId = "019d9268-ffa5-72b3-9cba-e2a59443cd41";
  const parentId = "019d922d-c38b-7e11-ae99-9187af386148";
  const { deps } = makeHarness();
  const state = makeRolloutParseState();
  for (const obj of [
    sessionMetaLine(childId),
    forkedSessionMetaParentLine(parentId),
    messageLine("hi"),
    functionCallLine("c1", "shell", "ls"),
  ]) {
    processRolloutLine({ obj, state, deps, file: "rollout-fork.jsonl" });
  }
  const aggregate: RolloutAggregate = {
    meta: state.sessionMeta || {},
    firstTs: state.firstTimestamp,
    lastTs: state.lastTimestamp,
    messageCount: state.messageCount,
    functionCallCount: state.functionCallCount,
    rolloutPath: "/rollouts/fork.jsonl",
  };
  assert.equal(state.sessionId, childId, "aggregate keying uses the child id");
  assert.equal(aggregate.meta.id, childId, "aggregate.meta.id is the child");
  assert.notEqual(aggregate.meta.id, parentId, "aggregate.meta.id is never the fork parent");
  assert.equal(aggregate.messageCount, 1);
  assert.equal(aggregate.functionCallCount, 1);
});

test("processRolloutLine: more than two session_meta lines — only the first ever wins", () => {
  // Defense-in-depth: if a future Codex change deepens the fork chain
  // (parent-of-parent meta etc.), we still pin to the first id seen.
  const childId = "child-uuid";
  const { deps, emitted } = makeHarness();
  const state = makeRolloutParseState();
  for (const obj of [
    sessionMetaLine(childId),
    sessionMetaLine("parent-1"),
    sessionMetaLine("parent-2"),
    sessionMetaLine("parent-3"),
    messageLine("hi"),
  ]) {
    processRolloutLine({ obj, state, deps, file: "r.jsonl" });
  }
  assert.equal(state.sessionId, childId);
  const msg = emitted.find((r) => r.stream === "messages");
  assert.equal(msg?.data.session_id, childId);
});

test("readPriorThreadFingerprints: tolerates missing state, missing field, and malformed entries", () => {
  const empty = readPriorThreadFingerprints({ type: "START" });
  assert.equal(empty.size, 0, "no state at all → empty");

  const noField = readPriorThreadFingerprints({
    type: "START",
    state: { sessions: { source_mtime_ms: 123 } },
  } as StartMessage);
  assert.equal(noField.size, 0, "no thread_fingerprints field → empty");

  const messy = readPriorThreadFingerprints({
    type: "START",
    state: {
      sessions: {
        thread_fingerprints: {
          good: { updated_at: 1, message_count: 2, function_call_count: 3 },
          bad1: "not-an-object",
          bad2: null,
          bad3: { updated_at: "nope", message_count: "no", function_call_count: "way" },
          partial: { updated_at: 100 },
        },
      },
    },
  });
  assert.equal(messy.get("good")?.message_count, 2, "well-formed entry survives");
  assert.equal(messy.has("bad1"), false, "non-object value dropped");
  assert.equal(messy.has("bad2"), false, "null value dropped");
  assert.deepEqual(
    messy.get("bad3"),
    { updated_at: null, message_count: null, function_call_count: null },
    "wrong-typed numeric fields fall back to null (entry not dropped, just neutered)"
  );
  assert.deepEqual(
    messy.get("partial"),
    { updated_at: 100, message_count: null, function_call_count: null },
    "missing fields fall back to null"
  );
});
