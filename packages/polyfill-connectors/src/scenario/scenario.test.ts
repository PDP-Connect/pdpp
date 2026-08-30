// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the v1 scenario format's replay matcher strictness and
 * `verifyScenario`'s pass/fail behavior, against a small toy connector (not
 * a real one — that proof is connectors/oura/scenario.spike.test.ts). Every
 * test here builds its own hand-crafted `ConnectorScenario` so the matcher's
 * behavior is exercised directly, without depending on record.ts's capture
 * path.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol/connector-runtime-protocol";
import { validateRuntimeContinuationFact } from "@pdpp/connector-protocol/connector-runtime-protocol";
import type { ConnectorScenario, ScenarioInteraction } from "./format.ts";
import { SCENARIO_FORMAT } from "./format.ts";
import { createInMemoryRecordSink, createRecordingFetch } from "./record.ts";
import {
  createReplayFetch,
  ScenarioBindingMismatchError,
  ScenarioMismatchError,
  UnconsumedInteractionsError,
} from "./replay.ts";
import { ScenarioValidationError, validateScenario } from "./validate.ts";
import type { RawTraceMessage, RunCollector } from "./verify.ts";
import { buildProtocolTrace, TRACE_POLICY, TraceNormalizationError, verifyScenario } from "./verify.ts";
import { assertKnownMessageType, isKnownMessageType, UnknownMessageTypeError } from "./wire-registry.ts";

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A toy "widgets" interaction: GET https://toy.example/widgets → one item. */
function widgetsInteraction(seq: number, id: string): ScenarioInteraction {
  return {
    seq,
    request: {
      method: "GET",
      origin: "https://toy.example",
      path: "/widgets",
      query: [],
    },
    response: {
      status: 200,
      content_type: "application/json",
      body: { id, name: `Widget ${id}` },
    },
  };
}

function toyScenario(interactions: ScenarioInteraction[]): ConnectorScenario {
  return {
    format: SCENARIO_FORMAT,
    connector: { id: "toy" },
    capture: {
      captured_at: "2026-08-01T00:00:00.000Z",
      evidence_class: "synthetic-spike",
      privacy_class: "local-only",
      recorder_version: "test",
      complete: true,
    },
    runs: [
      {
        start: { scope: { streams: [{ name: "widgets" }] }, state: null },
        interactions,
        expected: {
          records: {
            widgets: {
              count: 1,
              ids: ["w1"],
              ops: ["upsert"],
              record_sha256s: [canonicalHash({ id: "w1", name: "Widget w1" })],
            },
          },
          final_state: { widgets: { last_id: "w1" } },
        },
      },
    ],
  };
}

/** Drives the toy connector: GET /widgets once, emit one RECORD + one STATE. */
const toyCollector: RunCollector = async (_runIndex, { fetch: toyFetch, emit }) => {
  const res = await toyFetch("https://toy.example/widgets");
  const body = (await res.json()) as { id: string; name: string };
  emit({ type: "RECORD", stream: "widgets", id: body.id, data: body });
  emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
};

test("happy path: a scenario matching the real request/response passes verification", async () => {
  const scenario = toyScenario([widgetsInteraction(1, "w1")]);
  const result = await verifyScenario(scenario, toyCollector);

  assert.equal(result.pass, true, JSON.stringify(result.failures));
  assert.deepEqual(result.failures, []);
  assert.equal(result.metrics.interactionCount, 1);
  assert.equal(result.metrics.normalizerCount, 0);
});

test("vacuous run: zero interactions AND zero expected records fails verification with a vacuous_run failure, without invoking the collector", async () => {
  // A run this empty proves nothing — the collector could do literally
  // nothing and every other check (count/ids/hashes/final_state) would
  // still read as trivially satisfied. verifyScenario must catch this
  // explicitly rather than let it report pass:true for a run that verified
  // nothing. The collector below throws if ever called, proving verify.ts
  // catches this BEFORE invoking runCollector at all (a scenario this
  // vacuous doesn't even need to drive a subprocess to know it's useless).
  const scenario = toyScenario([]);
  scenario.runs[0] = {
    start: { scope: { streams: [] }, state: null },
    interactions: [],
    expected: { records: {}, final_state: {} },
  };
  const neverCalledCollector: RunCollector = () => {
    throw new Error("test failure: collector must not be invoked for a vacuous run");
  };

  const result = await verifyScenario(scenario, neverCalledCollector);

  assert.equal(result.pass, false);
  assert.equal(result.failures.length, 1);
  const vacuous = result.failures.find((f) => f.kind === "vacuous_run");
  assert.ok(vacuous, "expected a vacuous_run failure");
  assert.equal(vacuous?.runIndex, 0);
  assert.match(vacuous?.detail ?? "", /zero recorded interactions and zero expected records/);
});

test("vacuous run: a run with zero interactions but at least one expected record is NOT flagged vacuous_run", async () => {
  // toyScenario([]) has zero interactions but a non-empty expected.records
  // (widgets: count 1) — this is a legitimate "the collector should have
  // requested something and didn't" case (replay_mismatch), not a vacuous
  // scenario. The two failure kinds must stay distinct.
  const scenario = toyScenario([]);
  const result = await verifyScenario(scenario, toyCollector);

  assert.equal(result.pass, false);
  assert.equal(
    result.failures.some((f) => f.kind === "vacuous_run"),
    false
  );
});

test("unmatched request: a collector request with no recorded interaction fails verification with ScenarioMismatchError detail", async () => {
  // The scenario has zero interactions, so the collector's GET has nothing
  // to match — replay throws ScenarioMismatchError, caught and reported as
  // a replay_mismatch failure.
  const scenario = toyScenario([]);
  const result = await verifyScenario(scenario, toyCollector);

  assert.equal(result.pass, false);
  const mismatch = result.failures.find((f) => f.kind === "replay_mismatch");
  assert.ok(mismatch, "expected a replay_mismatch failure");
  assert.match(mismatch?.detail ?? "", /no recorded interaction matches/);
});

test("unconsumed interaction: a recorded interaction the collector never requests fails verification", async () => {
  // Two recorded interactions but the toy collector only issues one request
  // (same key, so it consumes seq 1 and leaves seq 2 unconsumed).
  const scenario = toyScenario([widgetsInteraction(1, "w1"), widgetsInteraction(2, "w1")]);
  const result = await verifyScenario(scenario, toyCollector);

  const unconsumed = result.failures.find((f) => f.kind === "unconsumed_interactions");
  assert.ok(unconsumed, "expected an unconsumed_interactions failure");
  assert.match(unconsumed?.detail ?? "", /seq \[2\]/);
});

test("tampered response body: a mutated recorded response makes the record hash mismatch fail verification", async () => {
  // The scenario's expected.records hash was computed for {id:"w1", name:"Widget w1"};
  // tamper the recorded response's `name` field so the collector's real replay
  // sees a different body — the emitted record's hash no longer matches.
  const tampered = widgetsInteraction(1, "w1");
  tampered.response.body = { id: "w1", name: "TAMPERED" };
  const scenario = toyScenario([tampered]);

  const result = await verifyScenario(scenario, toyCollector);

  assert.equal(result.pass, false);
  const hashFailure = result.failures.find((f) => f.kind === "record_hash");
  assert.ok(hashFailure, "expected a record_hash failure");
  assert.match(hashFailure?.detail ?? "", /expected sha256/);
});

test("record data containing `undefined` makes verify throw instead of silently hashing a collision", async () => {
  // hashCanonicalJson (local-device-envelope.ts's toCanonicalValue) silently
  // DROPS an `undefined` object property before hashing — so a record whose
  // real data is {id:"w1", name:"Widget w1", note: undefined} would hash
  // IDENTICALLY to {id:"w1", name:"Widget w1"} (no `note` key at all). That
  // is a genuine hash collision this test's own record_sha256s expectation
  // (computed by toyScenario's canonicalHash, itself just JSON.stringify —
  // which turns `undefined` into `null` differently again) would not catch
  // — the whole point of the record_hash check is to catch exactly this
  // class of "the record looks the same but isn't" bug, so a silent
  // collision defeats it. verify.ts's guard must throw BEFORE reaching
  // hashCanonicalJson at all, rather than let a wrong hash accidentally
  // match (or accidentally mismatch for the wrong reason).
  const scenario = toyScenario([widgetsInteraction(1, "w1")]);

  await assert.rejects(
    () =>
      verifyScenario(scenario, async (_runIndex, { fetch: toyFetch, emit }) => {
        const res = await toyFetch("https://toy.example/widgets");
        const body = (await res.json()) as { id: string; name: string };
        // A record whose data contains a literal `undefined` value — only
        // reachable from an in-process collector (JSON.parse can never
        // produce `undefined`), which is exactly the "in-process emitters"
        // case fix 5 is scoped to.
        emit({ type: "RECORD", stream: "widgets", id: body.id, data: { ...body, note: undefined } });
        emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /record data contains `undefined`/);
      assert.match(err.message, /note/);
      return true;
    }
  );
});

// ─── RECORD op (upsert/delete) oracle (originated seventh review as P1-1;
// ops made MANDATORY, eighth review P1) ─────────────────────────────────────
//
// `ScenarioStreamExpectation.ops` (format.ts) captures each emitted RECORD's
// normalized op (`"upsert"` or `"delete"`), index-aligned with
// `ids`/`record_sha256s`; `verifyStream`'s `verifyStreamOps` (verify.ts)
// always compares it — `ops` is now REQUIRED on every stream expectation, and
// `validateScenario` (validate.ts) rejects any scenario missing it (or
// misaligned, or carrying an invalid literal) before replay is ever
// attempted, so `verifyStreamOps` never needs an absent-ops bypass. These
// tests build a toy scenario with `ops` set directly (not via
// bin/scenario-record.ts — that CLI-level round trip is
// bin/scenario-cli.test.ts's job) and drive `verifyScenario` with hand-rolled
// collectors that emit a specific op, proving the comparison actually gates
// on the value rather than passing vacuously.

/** `toyScenario` already carries `ops: ["upsert"]` on the widgets expectation
 *  (mandatory field); this just overwrites it to the given op — the baseline
 *  every op-mutation test below tweaks. */
function toyScenarioWithOp(interactions: ScenarioInteraction[], op: "upsert" | "delete"): ConnectorScenario {
  const scenario = toyScenario(interactions);
  const widgets = scenario.runs[0]?.expected.records.widgets;
  if (!widgets) {
    throw new Error("test setup: expected toyScenario to declare a widgets expectation");
  }
  widgets.ops = [op];
  return scenario;
}

/** Drives the toy connector exactly like `toyCollector`, but emits the
 *  given `op` on the RECORD message. */
function toyCollectorWithOp(op: "upsert" | "delete"): RunCollector {
  return async (_runIndex, { fetch: toyFetch, emit }) => {
    const res = await toyFetch("https://toy.example/widgets");
    const body = (await res.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body.id, data: body, op });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
  };
}

test("record op: a scenario expecting ops:['upsert'] passes when the collector actually emits an upsert (no explicit op)", async () => {
  const scenario = toyScenarioWithOp([widgetsInteraction(1, "w1")], "upsert");
  // No explicit `op` on the emitted RECORD — absence normalizes to upsert,
  // exactly matching the wire's own "op absent means upsert" contract.
  const result = await verifyScenario(scenario, toyCollector);
  assert.equal(result.pass, true, JSON.stringify(result.failures));
});

test("record op: a scenario expecting ops:['delete'] passes when the collector actually emits op:'delete'", async () => {
  const scenario = toyScenarioWithOp([widgetsInteraction(1, "w1")], "delete");
  const result = await verifyScenario(scenario, toyCollectorWithOp("delete"));
  assert.equal(result.pass, true, JSON.stringify(result.failures));
});

test("record op mutation: recorded delete replayed as upsert fails with record_op_mismatch", async () => {
  const scenario = toyScenarioWithOp([widgetsInteraction(1, "w1")], "delete");
  const result = await verifyScenario(scenario, toyCollectorWithOp("upsert"));
  assert.equal(result.pass, false);
  const opFailure = result.failures.find((f) => f.kind === "record_op_mismatch");
  assert.ok(opFailure, `expected a record_op_mismatch failure; got ${JSON.stringify(result.failures)}`);
  assert.match(opFailure?.detail ?? "", /expected op "delete", got "upsert"/);
});

test("record op mutation: recorded upsert replayed as delete fails with record_op_mismatch", async () => {
  const scenario = toyScenarioWithOp([widgetsInteraction(1, "w1")], "upsert");
  const result = await verifyScenario(scenario, toyCollectorWithOp("delete"));
  assert.equal(result.pass, false);
  const opFailure = result.failures.find((f) => f.kind === "record_op_mismatch");
  assert.ok(opFailure, `expected a record_op_mismatch failure; got ${JSON.stringify(result.failures)}`);
  assert.match(opFailure?.detail ?? "", /expected op "upsert", got "delete"/);
});

test("record op: a scenario missing ops entirely is rejected by validateScenario — never reaches replay", () => {
  // P1 (eighth review) supersedes the old "legacy scenario, no ops, verifies
  // unchanged" backward-compat behavior: `ops` is now MANDATORY on every
  // stream expectation (format.ts's ScenarioStreamExpectation.ops doc
  // comment — the format is unmerged and scenarios are local-only, so there
  // is no real legacy corpus a migration tier would protect). A scenario
  // missing `ops` must be caught by validateScenario's trust gate BEFORE any
  // replay is attempted — it must never reach verifyScenario/toyCollector at
  // all, proven here by deleting `ops` from an otherwise-valid toyScenario
  // and asserting the SPECIFIC named rejection reason.
  const scenario = toyScenario([widgetsInteraction(1, "w1")]);
  const widgets = scenario.runs[0]?.expected.records.widgets;
  assert.ok(widgets, "test setup: expected toyScenario to declare a widgets expectation");
  // biome-ignore lint/performance/noDelete: deliberately simulating a scenario file that never carries the (now mandatory) field, not a hot path.
  delete (widgets as { ops?: unknown }).ops;
  assert.throws(
    () => validateScenario(scenario),
    (err: unknown) => {
      assert.ok(err instanceof ScenarioValidationError, `expected ScenarioValidationError, got ${String(err)}`);
      assert.equal(err.reason, "missing_ops");
      return true;
    }
  );
});

test("record op mutation: an invalid op on the wire (neither absent nor 'delete') fails RECORD wire-boundary validation", async () => {
  const { assertValidRecordMessage } = await import("./wire-registry.ts");
  assert.throws(
    () =>
      assertValidRecordMessage({
        type: "RECORD",
        stream: "widgets",
        key: "w1",
        data: {},
        emitted_at: "2026-08-13T00:00:00.000Z",
        op: "delete_all",
      }),
    /op, when present, must be the literal "delete"/
  );
});

test("record op mutation: a RECORD missing emitted_at fails RECORD wire-boundary validation", async () => {
  const { assertValidRecordMessage } = await import("./wire-registry.ts");
  assert.throws(
    () =>
      assertValidRecordMessage({
        type: "RECORD",
        stream: "widgets",
        key: "w1",
        data: {},
      }),
    /emitted_at must be a nonempty string/
  );
});

test("record op mutation: a RECORD with non-object data fails RECORD wire-boundary validation", async () => {
  const { assertValidRecordMessage } = await import("./wire-registry.ts");
  assert.throws(
    () =>
      assertValidRecordMessage({
        type: "RECORD",
        stream: "widgets",
        key: "w1",
        data: "not-an-object",
        emitted_at: "2026-08-13T00:00:00.000Z",
      }),
    /data must be an object/
  );
});

// ─── P2 (eighth review): STATE wire-boundary validation, symmetric with
// RECORD/INTERACTION ─────────────────────────────────────────────────────

test("STATE wire-boundary: a valid message with an opaque cursor passes", async () => {
  const { assertValidStateMessage } = await import("./wire-registry.ts");
  assert.doesNotThrow(() =>
    assertValidStateMessage({ type: "STATE", stream: "widgets", cursor: { opaque: "token", nested: [1, 2] } })
  );
});

test("STATE wire-boundary: a valid message with cursor:null passes — null is an explicit, present value, not absence", async () => {
  const { assertValidStateMessage } = await import("./wire-registry.ts");
  assert.doesNotThrow(() => assertValidStateMessage({ type: "STATE", stream: "widgets", cursor: null }));
});

test("STATE wire-boundary: a message with no cursor property at all is rejected", async () => {
  const { assertValidStateMessage } = await import("./wire-registry.ts");
  assert.throws(() => assertValidStateMessage({ type: "STATE", stream: "widgets" }), /cursor property is required/);
});

test("STATE wire-boundary: a non-string stream is rejected", async () => {
  const { assertValidStateMessage } = await import("./wire-registry.ts");
  assert.throws(
    () => assertValidStateMessage({ type: "STATE", stream: 42, cursor: {} }),
    /stream must be a nonempty string/
  );
});

test("STATE wire-boundary: an empty-string stream is rejected — every real emission site in this repo always names a nonempty stream", async () => {
  const { assertValidStateMessage } = await import("./wire-registry.ts");
  assert.throws(
    () => assertValidStateMessage({ type: "STATE", stream: "", cursor: {} }),
    /stream must be a nonempty string/
  );
});

test("STATE wire-boundary is wired into messagesToRecordsAndState: a malformed STATE fails the whole projection instead of silently disappearing", async () => {
  const { messagesToRecordsAndState } = await import("./subprocess-fetch-preloads.ts");
  assert.throws(() => messagesToRecordsAndState([{ type: "STATE", stream: "widgets" }]), /cursor property is required/);
  assert.throws(
    () => messagesToRecordsAndState([{ type: "STATE", stream: "", cursor: {} }]),
    /stream must be a nonempty string/
  );
});

test("record op: emitted_at is excluded-volatile — two RECORD messages differing ONLY in emitted_at project to identical records via messagesToRecordsAndState", async () => {
  // format.ts's ScenarioStreamExpectation doc comment documents emitted_at
  // as excluded-volatile: it is a wall-clock stamp, not part of the
  // count/ids/ops/record_sha256s comparison. Proven directly at the
  // projection layer this pass owns: messagesToRecordsAndState reads
  // stream/key/data/op off a RECORD (validating emitted_at is PRESENT and
  // well-shaped at the wire boundary — required per connector-runtime-
  // protocol.ts — but never threads its VALUE into the projected record),
  // so two otherwise-identical RECORDs with different emitted_at values
  // must project to byte-identical output.
  const { messagesToRecordsAndState } = await import("./subprocess-fetch-preloads.ts");
  const earlier = messagesToRecordsAndState([
    { type: "RECORD", stream: "widgets", key: "w1", data: { id: "w1" }, emitted_at: "2026-01-01T00:00:00.000Z" },
  ]);
  const later = messagesToRecordsAndState([
    { type: "RECORD", stream: "widgets", key: "w1", data: { id: "w1" }, emitted_at: "2026-12-31T23:59:59.999Z" },
  ]);
  assert.deepEqual(earlier.records, later.records);
});

test("verifyScenario never throws even when the collector's fetch call raises ScenarioMismatchError — it reports a replay_mismatch failure instead", async () => {
  // Record a POST interaction; the collector issues a GET. Method differs,
  // so replay.fetch() throws ScenarioMismatchError — verifyScenario must
  // catch it and turn it into a reported failure, not let it propagate.
  const postInteraction: ScenarioInteraction = {
    seq: 1,
    request: { method: "POST", origin: "https://toy.example", path: "/widgets", query: [] },
    response: { status: 200, body: { id: "w1", name: "Widget w1" } },
  };
  const scenario = toyScenario([postInteraction]);

  const result = await verifyScenario(scenario, async (_runIndex, { fetch: toyFetch }) => {
    await toyFetch("https://toy.example/widgets"); // GET, not POST
  });

  assert.equal(result.pass, false);
  const mismatch = result.failures.find((f) => f.kind === "replay_mismatch");
  assert.ok(mismatch, "expected a replay_mismatch failure");
  assert.match(mismatch?.detail ?? "", /method expected="POST" actual="GET"/);
});

test("ScenarioMismatchError.nearestMiss names the differing component directly (unit-level, bypassing verifyScenario)", async () => {
  const [run] = toyScenario([
    {
      seq: 1,
      request: { method: "POST", origin: "https://toy.example", path: "/widgets", query: [] },
      response: { status: 200, body: {} },
    },
  ]).runs;
  if (!run) {
    throw new Error("test setup: expected a run");
  }
  const replay = createReplayFetch(run);

  await assert.rejects(
    () => replay.fetch("https://toy.example/widgets"),
    (err: unknown) => {
      assert.ok(err instanceof ScenarioMismatchError);
      assert.equal(err.nearestMiss?.component, "method");
      assert.equal(err.nearestMiss?.expected, "POST");
      assert.equal(err.nearestMiss?.actual, "GET");
      return true;
    }
  );
});

test("assertAllConsumed throws UnconsumedInteractionsError listing every unconsumed seq", async () => {
  const [run] = toyScenario([
    widgetsInteraction(1, "w1"),
    widgetsInteraction(2, "w1"),
    widgetsInteraction(3, "w1"),
  ]).runs;
  if (!run) {
    throw new Error("test setup: expected a run");
  }
  const replay = createReplayFetch(run);

  // Consume only seq 1.
  await replay.fetch("https://toy.example/widgets");

  assert.throws(
    () => replay.assertAllConsumed(),
    (err: unknown) => {
      assert.ok(err instanceof UnconsumedInteractionsError);
      assert.deepEqual(err.unconsumedSeqs, [2, 3]);
      return true;
    }
  );
});

/** Like `toyScenario`, but for a run expected to emit TWO widget records
 *  (the normalizer-misuse-guard tests below need a two-request run, so the
 *  single-record expectations `toyScenario` bakes in don't fit). */
function twoRecordToyScenario(interactions: ScenarioInteraction[]): ConnectorScenario {
  return {
    format: SCENARIO_FORMAT,
    connector: { id: "toy" },
    capture: {
      captured_at: "2026-08-01T00:00:00.000Z",
      evidence_class: "synthetic-spike",
      privacy_class: "local-only",
      recorder_version: "test",
      complete: true,
    },
    runs: [
      {
        start: { scope: { streams: [{ name: "widgets" }] }, state: null },
        interactions,
        expected: {
          records: {
            widgets: {
              count: 2,
              ids: ["w1", "w2"],
              ops: ["upsert", "upsert"],
              record_sha256s: [
                canonicalHash({ id: "w1", name: "Widget w1", next_cursor: "replay-issued-cursor-999" }),
                canonicalHash({ id: "w2", name: "Widget w2" }),
              ],
            },
          },
          final_state: { widgets: { last_id: "w2" } },
        },
      },
    ],
  };
}

test("query normalizers: a normalized param may differ between record and replay without failing the match, when the differing value was provider-issued by an earlier response in this run", async () => {
  // Two recorded interactions on the SAME match key (cursor is normalized,
  // so both collapse onto one FIFO bucket): page 1 has no cursor param at
  // all, page 2's recorded cursor is "abc123" (whatever the recorder
  // happened to capture). The replay collector's actual page-2 request
  // instead carries "replay-issued-cursor-999" — a DIFFERENT value from what
  // was recorded — but that value is exactly what page 1's OWN response
  // handed back as next_cursor, so it is legitimately provider-issued in
  // THIS replay run and the normalizer still excuses the mismatch.
  const page1: ScenarioInteraction = {
    seq: 1,
    request: { method: "GET", origin: "https://toy.example", path: "/widgets", query: [] },
    response: { status: 200, body: { id: "w1", name: "Widget w1", next_cursor: "replay-issued-cursor-999" } },
  };
  const page2: ScenarioInteraction = {
    seq: 2,
    request: {
      method: "GET",
      origin: "https://toy.example",
      path: "/widgets",
      query: [["cursor", "abc123"]],
    },
    response: { status: 200, body: { id: "w2", name: "Widget w2" } },
  };
  const scenario = twoRecordToyScenario([page1, page2]);
  scenario.normalizers = [{ param: "cursor", reason: "volatile pagination cursor" }];

  const result = await verifyScenario(scenario, async (_runIndex, { fetch: toyFetch, emit }) => {
    const res1 = await toyFetch("https://toy.example/widgets");
    const body1 = (await res1.json()) as { id: string; name: string; next_cursor: string };
    emit({ type: "RECORD", stream: "widgets", id: body1.id, data: body1 });

    // The cursor value used here comes from body1.next_cursor — a value THIS
    // run's own page-1 response just handed back — not a hardcoded literal.
    const res2 = await toyFetch(`https://toy.example/widgets?cursor=${body1.next_cursor}`);
    const body2 = (await res2.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body2.id, data: body2 });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body2.id } });
  });

  assert.equal(result.pass, true, JSON.stringify(result.failures));
});

test("query normalizers: a normalized param that differs WITHOUT the value being provider-issued by an earlier response fails the match (normalizer misuse guard)", async () => {
  // Same shape as the legitimate case above, but the replay collector's
  // page-2 request carries a value nobody in this run ever issued (not
  // page 1's response, not anything) — e.g. a hardcoded/guessed value, or
  // recorded interactions served out of order. The normalizer must NOT
  // excuse this: it only accounts for values the provider itself handed
  // back, not arbitrary differing values.
  const page1: ScenarioInteraction = {
    seq: 1,
    request: { method: "GET", origin: "https://toy.example", path: "/widgets", query: [] },
    response: { status: 200, body: { id: "w1", name: "Widget w1", next_cursor: "real-next-cursor-abc" } },
  };
  const page2: ScenarioInteraction = {
    seq: 2,
    request: {
      method: "GET",
      origin: "https://toy.example",
      path: "/widgets",
      query: [["cursor", "abc123"]],
    },
    response: { status: 200, body: { id: "w2", name: "Widget w2" } },
  };
  const scenario = twoRecordToyScenario([page1, page2]);
  scenario.normalizers = [{ param: "cursor", reason: "volatile pagination cursor" }];

  const result = await verifyScenario(scenario, async (_runIndex, { fetch: toyFetch, emit }) => {
    const res1 = await toyFetch("https://toy.example/widgets");
    const body1 = (await res1.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body1.id, data: body1 });

    // "hardcoded-guessed-cursor" never appeared in ANY response served so
    // far in this run — not provider-issued, so the guard must reject it
    // even though `cursor` is a declared normalizer.
    const res2 = await toyFetch("https://toy.example/widgets?cursor=hardcoded-guessed-cursor");
    const body2 = (await res2.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body2.id, data: body2 });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body2.id } });
  });

  assert.equal(result.pass, false);
  const mismatch = result.failures.find((f) => f.kind === "replay_mismatch");
  assert.ok(mismatch, "expected a replay_mismatch failure");
  assert.match(mismatch?.detail ?? "", /normalized query param "cursor" differs/);
  assert.match(mismatch?.detail ?? "", /not provider-issued/);
});

test("normalizer misuse guard: a page-swap scenario (page=1 vs page=2 with `page` normalized) fails instead of silently serving the wrong page", async () => {
  // The exact red-team scenario from the task: page 1 and page 2 responses
  // differ only in a `page` query param that is declared a normalizer.
  // Without the guard, the FIFO-per-key queue would silently hand page 2's
  // response to a request that actually asked for page 1 (or vice versa)
  // whenever the collector's real request order doesn't match recorded
  // order. `page` is a static, caller-chosen integer — never provider-issued
  // — so the guard must reject this regardless of FIFO order.
  const page1: ScenarioInteraction = {
    seq: 1,
    request: { method: "GET", origin: "https://toy.example", path: "/widgets", query: [["page", "1"]] },
    response: { status: 200, body: { id: "w-page1", name: "Widget page 1" } },
  };
  const page2: ScenarioInteraction = {
    seq: 2,
    request: { method: "GET", origin: "https://toy.example", path: "/widgets", query: [["page", "2"]] },
    response: { status: 200, body: { id: "w-page2", name: "Widget page 2" } },
  };
  const scenario = twoRecordToyScenario([page1, page2]);
  scenario.normalizers = [{ param: "page", reason: "misdeclared as normalizer (red-team repro)" }];

  // The collector asks for page=2 FIRST — out of recorded order. Under the
  // old FIFO-only matcher this would silently return page 1's recorded
  // response (cursor position 0) for a page=2 request. The guard must catch
  // this: "2" never appeared in any response served earlier in this run.
  const result = await verifyScenario(scenario, async (_runIndex, { fetch: toyFetch, emit }) => {
    const res = await toyFetch("https://toy.example/widgets?page=2");
    const body = (await res.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body.id, data: body });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
  });

  assert.equal(result.pass, false);
  const mismatch = result.failures.find((f) => f.kind === "replay_mismatch");
  assert.ok(mismatch, "expected a replay_mismatch failure");
  assert.match(mismatch?.detail ?? "", /normalized query param "page" differs/);
});

test("query normalizers: without the normalizer entry, a differing cursor value fails the match", async () => {
  const recorded: ScenarioInteraction = {
    seq: 1,
    request: {
      method: "GET",
      origin: "https://toy.example",
      path: "/widgets",
      query: [["cursor", "abc123"]],
    },
    response: { status: 200, body: { id: "w1", name: "Widget w1" } },
  };
  const scenario = toyScenario([recorded]);
  // No normalizers declared this time.

  const result = await verifyScenario(scenario, async (_runIndex, { fetch: toyFetch, emit }) => {
    const res = await toyFetch("https://toy.example/widgets?cursor=different-value-999");
    const body = (await res.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body.id, data: body });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
  });

  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.kind === "replay_mismatch"));
});

/**
 * Tests for `createRecordingFetch`'s conditional credential-param redaction
 * (record.ts): a query param matching the credential-name pattern is
 * redacted only when its value has NOT already appeared in an earlier
 * recorded response body in the same run. See record.ts's module doc for the
 * full rationale — these tests exercise it directly (not via a real
 * connector; that proof is connectors/oura/scenario.spike.test.ts).
 */

/** A synthetic `fetch` that always returns `body` as JSON, ignoring the request. */
function jsonFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

test("recording fetch: a next_token param whose value came from a prior response becomes a ScenarioBinding, never persisted raw (FIX 4 recorder unification)", async () => {
  // A single recordingFetch spans the whole run (as it does in real
  // connector traffic), so page 2's request can see the provider-issued
  // value page 1's response introduced. The synthetic provider below
  // returns page 1's body (with a next_token) when no next_token is on the
  // request, and page 2's body (next_token: null) once next_token is
  // echoed back — exactly a real cursor-paginated API's shape.
  //
  // Re-review finding: this module previously kept a provider-issued
  // credential-named value RAW in the stored query (the old "kept, not
  // redacted" heuristic) — diverging from subprocess-fetch-preloads.ts's
  // RECORD preload, which already produced bindings. Provenance is not
  // non-secrecy: a value being provider-issued only proves the recorder
  // doesn't need to protect it from ITSELF, not that it's safe to leave
  // sitting in a committed/shared scenario file's request query. This test
  // now asserts the binding model — record.ts's `createRecordingFetch` must
  // match the preload exactly.
  const combinedFetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.has("next_token")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: ["b"], next_token: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ data: ["a"], next_token: "cursor-page-2-abcdef" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;

  const runSink = createInMemoryRecordSink();
  const recording = createRecordingFetch(combinedFetch, runSink);
  await recording.fetch("https://api.example/items");
  await recording.fetch("https://api.example/items?next_token=cursor-page-2-abcdef");

  assert.equal(runSink.interactions.length, 2);
  const [interaction1, interaction2] = runSink.interactions;
  assert.ok(interaction1 && interaction2);

  // page 1 has no next_token param at all (nothing to redact or keep).
  assert.deepEqual(interaction1.request.query, []);

  // page 2's next_token is a provider-issued value (it appeared in page 1's
  // response body) — EXCLUDED from the stored query entirely, never
  // persisted raw. Its provenance is recorded as a binding instead: which
  // earlier interaction (source_seq) served it, and where in that response
  // body (json_path).
  assert.deepEqual(interaction2.request.query, []);
  assert.deepEqual(interaction2.bindings, [{ param: "next_token", source_seq: 1, json_path: ".next_token" }]);

  // The raw cursor value never appears anywhere in either persisted
  // interaction (request query, response bodies are fine — that's where the
  // provider itself put it — but the REQUEST side must never carry it).
  assert.deepEqual(interaction1.request.query, []);
  assert.deepEqual(interaction2.request.query, []);

  // Not listed as a normalizer, since it was never redacted as a client
  // secret — it's a resolved binding instead.
  assert.deepEqual(recording.discoveredNormalizers(), []);
});

test("recording fetch round-trips through createReplayFetch: a recorded binding replays correctly, and a tampered cursor is rejected as a binding mismatch (FIX 4 end-to-end proof)", async () => {
  // Proves record.ts's binding output isn't just structurally correct in
  // isolation — it is exactly what replay.ts's `assertBindingsSatisfied`
  // expects, end to end: record two pages with createRecordingFetch, feed
  // the RECORDED interactions straight into createReplayFetch (no manual
  // reshaping), and confirm replay accepts the real cursor and rejects a
  // wrong one via ScenarioBindingMismatchError (not a silent pass or a
  // generic ScenarioMismatchError).
  const combinedFetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.has("next_token")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: ["b"], next_token: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ data: ["a"], next_token: "cursor-page-2-abcdef" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;

  const runSink = createInMemoryRecordSink();
  const recording = createRecordingFetch(combinedFetch, runSink);
  await recording.fetch("https://api.example/items");
  await recording.fetch("https://api.example/items?next_token=cursor-page-2-abcdef");

  const replay = createReplayFetch({
    start: { scope: { streams: [{ name: "items" }] }, state: null },
    interactions: runSink.interactions,
    expected: { records: {}, final_state: {} },
  });

  const page1 = await replay.fetch("https://api.example/items");
  assert.deepEqual(await page1.json(), { data: ["a"], next_token: "cursor-page-2-abcdef" });

  // The real cursor value — resolved from page 1's actual served response,
  // not read off the recorded file — is accepted.
  const page2 = await replay.fetch("https://api.example/items?next_token=cursor-page-2-abcdef");
  assert.deepEqual(await page2.json(), { data: ["b"], next_token: null });
  assert.doesNotThrow(() => replay.assertAllConsumed());

  // A second, independent replay of the SAME recorded interactions rejects a
  // wrong/guessed cursor as a binding mismatch.
  const replayRejected = createReplayFetch({
    start: { scope: { streams: [{ name: "items" }] }, state: null },
    interactions: runSink.interactions,
    expected: { records: {}, final_state: {} },
  });
  await replayRejected.fetch("https://api.example/items");
  await assert.rejects(
    () => replayRejected.fetch("https://api.example/items?next_token=guessed-wrong-cursor"),
    ScenarioBindingMismatchError
  );
});

test("recording fetch: an api_key param whose value never appeared in any response is still redacted", async () => {
  const sink = createInMemoryRecordSink();
  const providerFetch = jsonFetch({ data: ["a"] }); // no echo of the api_key value anywhere
  const recording = createRecordingFetch(providerFetch, sink);

  await recording.fetch("https://api.example/items?api_key=client-supplied-secret-value");

  assert.equal(sink.interactions.length, 1);
  const [interaction] = sink.interactions;
  assert.ok(interaction);
  assert.deepEqual(interaction.request.query, []);
  assert.deepEqual(recording.discoveredNormalizers(), [{ param: "api_key", reason: "credential" }]);
});

test("recording fetch: a token param in the first request (no prior responses) is redacted", async () => {
  const sink = createInMemoryRecordSink();
  const providerFetch = jsonFetch({ data: ["a"] });
  const recording = createRecordingFetch(providerFetch, sink);

  // First-ever request in the run: providerIssuedValues is empty, so a
  // genuine credential value here has nothing to be coincidentally matched
  // against and is redacted as before.
  await recording.fetch("https://api.example/items?token=first-request-credential");

  assert.equal(sink.interactions.length, 1);
  const [interaction] = sink.interactions;
  assert.ok(interaction);
  assert.deepEqual(interaction.request.query, []);
  assert.deepEqual(recording.discoveredNormalizers(), [{ param: "token", reason: "credential" }]);
});

/**
 * FIX 6 — binding resolution (replay.ts's `assertBindingsSatisfied`).
 *
 * A binding declares that a request query param's value was NOT recorded
 * raw because it was provider-issued: the expected value is resolved from
 * the response body ACTUALLY SERVED for `source_seq` at `json_path`, and
 * the live request must carry that resolved value at `param`. These tests
 * build hand-crafted two-interaction scenarios directly against
 * `createReplayFetch` (not through a full connector) — a page-1 interaction
 * whose response carries `next_cursor`, and a page-2 interaction whose
 * request binds its `cursor` query param to page 1's `next_cursor`.
 */

function boundCursorInteractions(): ScenarioInteraction[] {
  return [
    {
      seq: 1,
      request: { method: "GET", origin: "https://toy.example", path: "/items", query: [] },
      response: { status: 200, content_type: "application/json", body: { items: ["a"], next_cursor: "cursor-xyz" } },
    },
    {
      seq: 2,
      request: { method: "GET", origin: "https://toy.example", path: "/items", query: [] },
      response: { status: 200, content_type: "application/json", body: { items: ["b"], next_cursor: null } },
      bindings: [{ param: "cursor", source_seq: 1, json_path: "next_cursor" }],
    },
  ];
}

test("binding resolution: a live request carrying the value actually served for source_seq matches", async () => {
  const interactions = boundCursorInteractions();
  const replay = createReplayFetch({
    start: { scope: { streams: [{ name: "items" }] }, state: null },
    interactions,
    expected: { records: {}, final_state: {} },
  });

  const page1 = await replay.fetch("https://toy.example/items");
  assert.deepEqual(await page1.json(), { items: ["a"], next_cursor: "cursor-xyz" });

  // The live request carries the EXACT value page 1's response actually
  // served for next_cursor — this must match despite "cursor" not being a
  // normalizer and not appearing in the recorded page-2 request's query at
  // all (the recorded request has query: [] too; the binding's param is
  // matched separately from the base match key, not folded into it).
  const page2 = await replay.fetch("https://toy.example/items?cursor=cursor-xyz");
  assert.deepEqual(await page2.json(), { items: ["b"], next_cursor: null });

  assert.doesNotThrow(() => replay.assertAllConsumed());
});

test("binding resolution: a live request whose bound param value differs from what was actually served fails with a named mismatch", async () => {
  const interactions = boundCursorInteractions();
  const replay = createReplayFetch({
    start: { scope: { streams: [{ name: "items" }] }, state: null },
    interactions,
    expected: { records: {}, final_state: {} },
  });

  await replay.fetch("https://toy.example/items");

  // A wrong/guessed cursor value — not what page 1 actually served.
  await assert.rejects(
    () => replay.fetch("https://toy.example/items?cursor=wrong-guessed-cursor"),
    (err: unknown) => {
      assert.ok(
        err instanceof ScenarioBindingMismatchError,
        `expected ScenarioBindingMismatchError, got ${String(err)}`
      );
      assert.equal(err.interactionSeq, 2);
      assert.equal(err.binding.param, "cursor");
      assert.match(err.message, /bound param "cursor" mismatch/);
      return true;
    }
  );
});

test("binding resolution: a live request missing the bound param entirely fails (request must carry it)", async () => {
  const interactions = boundCursorInteractions();
  const replay = createReplayFetch({
    start: { scope: { streams: [{ name: "items" }] }, state: null },
    interactions,
    expected: { records: {}, final_state: {} },
  });

  await replay.fetch("https://toy.example/items");

  // No `cursor` param at all on the second request. Because the second
  // interaction excludes "cursor" from its own match key (it's bound), this
  // request still matches interaction seq 2 by (method, origin, path) —
  // exactly the case that must then fail the binding check rather than
  // silently pass through with the param simply absent.
  await assert.rejects(
    () => replay.fetch("https://toy.example/items"),
    (err: unknown) => {
      assert.ok(
        err instanceof ScenarioBindingMismatchError,
        `expected ScenarioBindingMismatchError, got ${String(err)}`
      );
      assert.match(err.message, /does not carry that param at all/);
      return true;
    }
  );
});

test("binding resolution: the bound param's value is never part of the match key (two differing live values both reach the same interaction)", async () => {
  // Proves FIX 6(d): including the bound value in the match key would make
  // a request with any OTHER cursor value fail to match at all (a plain
  // ScenarioMismatchError, "no recorded interaction matches"), rather than
  // matching and THEN failing the more specific binding check. Both
  // requests below must reach the SAME interaction (seq 2) — one accepted,
  // one rejected specifically as a binding mismatch, never as a "no match".
  const interactions = boundCursorInteractions();
  const replayAccepted = createReplayFetch({
    start: { scope: { streams: [{ name: "items" }] }, state: null },
    interactions,
    expected: { records: {}, final_state: {} },
  });
  await replayAccepted.fetch("https://toy.example/items");
  const accepted = await replayAccepted.fetch("https://toy.example/items?cursor=cursor-xyz");
  assert.equal(accepted.status, 200);

  const replayRejected = createReplayFetch({
    start: { scope: { streams: [{ name: "items" }] }, state: null },
    interactions: boundCursorInteractions(),
    expected: { records: {}, final_state: {} },
  });
  await replayRejected.fetch("https://toy.example/items");
  await assert.rejects(
    () => replayRejected.fetch("https://toy.example/items?cursor=some-other-value"),
    ScenarioBindingMismatchError,
    "a differing cursor value must still MATCH interaction seq 2 (proving cursor is excluded from the match key) and fail as a binding mismatch, not a ScenarioMismatchError"
  );
});

/**
 * FIX 1 — protocol-trace oracle (verify.ts's `buildProtocolTrace`/
 * `normalizeTraceMessage`/verifyRun's trace comparison).
 *
 * PDPP connectors' primary truth is completeness semantics, not just
 * records: a connector that silently drops a SKIP_RESULT, under-reports a
 * DETAIL_GAP, or claims DONE(succeeded) after what was actually a failed run
 * has lied about completeness even when every RECORD it emitted was
 * byte-correct. These tests build a fixture-shaped `RunCollector` that emits
 * SKIP_RESULT + DETAIL_GAP + a terminal DONE (success or failure, per test)
 * via the `TRACE` emit variant, alongside one RECORD/STATE pair so the run
 * isn't vacuous, and prove replay FAILS when each truth-bearing message is
 * dropped or altered, and PASSES unchanged — the mutation-testing discipline
 * the task requires: don't just prove the happy path parses, prove tampering
 * is actually caught.
 */

/** One recorded run's full fixture message sequence: RECORD + STATE (so the
 *  run isn't vacuous) + SKIP_RESULT + DETAIL_GAP + a terminal DONE. Returns
 *  both the `ScenarioRunExpected` shape (records + trace) a scenario would
 *  capture, and the raw messages a `RunCollector` replaying it should emit
 *  when behaving HONESTLY (i.e. reproducing the same run unmutated). */
function traceFixtureMessages(doneStatus: "succeeded" | "failed"): RawTraceMessage[] {
  const base: RawTraceMessage[] = [
    {
      type: "SKIP_RESULT",
      stream: "widgets",
      reason: "shape_check_failed",
      message: "widget w2 failed shape validation",
    },
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      // status/retryable/reference_only (repair wave 3B): fixed protocol
      // literals connector-runtime-protocol.ts's `DetailGapMessage` always
      // carries on the real wire — normalizeDetailGap's strict shape check
      // now requires them (see verify.ts's "FAIL-CLOSED SHAPE CHECKING").
      status: "pending",
      retryable: true,
      reference_only: true,
      detail: { class: "HttpError", http_status: 429 },
      // Repair wave 6 (P2-2 duty 2): detail_locator is REQUIRED on the wire
      // (connector-runtime-protocol.ts's `DetailGapMessage.detail_locator`,
      // no `?`) — this fixture previously omitted it, which the review's
      // shape validation now rejects. Flipped here (not a new test) per this
      // wave's "flip prior-wave tests that asserted acceptance of now-
      // rejected shapes" instruction.
      detail_locator: { kind: "widget_detail", widget_id: "w3" },
    },
  ];
  if (doneStatus === "succeeded") {
    return [...base, { type: "DONE", status: "succeeded", records_emitted: 1 }];
  }
  return [
    ...base,
    {
      type: "DONE",
      status: "failed",
      records_emitted: 1,
      // Repair wave 6 (P2-2 duty 2): DONE.error.message is REQUIRED whenever
      // `error` is present (connector-runtime-protocol.ts's DONE variant) —
      // this fixture previously omitted it. Flipped here for the same
      // reason as detail_locator above.
      error: {
        code: "retry_exhausted",
        message: "widget w3 retry budget exhausted",
        retryable: true,
        recovery_hint: { action: "retry_later", retryable: true },
      },
    },
  ];
}

function traceFixtureScenario(doneStatus: "succeeded" | "failed"): ConnectorScenario {
  const expectedTrace = buildProtocolTrace(traceFixtureMessages(doneStatus));
  return {
    format: SCENARIO_FORMAT,
    connector: { id: "trace-fixture" },
    capture: {
      captured_at: "2026-08-01T00:00:00.000Z",
      evidence_class: "synthetic-spike",
      privacy_class: "local-only",
      recorder_version: "test",
      complete: true,
    },
    runs: [
      {
        start: { scope: { streams: [{ name: "widgets" }] }, state: null },
        interactions: [widgetsInteraction(1, "w1")],
        expected: {
          records: {
            widgets: {
              count: 1,
              ids: ["w1"],
              ops: ["upsert"],
              record_sha256s: [canonicalHash({ id: "w1", name: "Widget w1" })],
            },
          },
          final_state: { widgets: { last_id: "w1" } },
          protocol_trace: expectedTrace,
        },
      },
    ],
  };
}

/** Builds a `RunCollector` that replays the toy widgets fetch (matching
 *  `traceFixtureScenario`'s one interaction) AND emits `mutatedMessages` as
 *  TRACE entries — the mutation under test. */
function traceCollectorEmitting(mutatedMessages: readonly RawTraceMessage[]): RunCollector {
  return async (_runIndex, { fetch: toyFetch, emit }) => {
    const res = await toyFetch("https://toy.example/widgets");
    const body = (await res.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body.id, data: body });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
    for (const raw of mutatedMessages) {
      const { type: rawType, ...rest } = raw;
      emit({ type: "TRACE", rawType, ...rest });
    }
  };
}

test("protocol trace: an unmutated trace (SKIP_RESULT + DETAIL_GAP + succeeded DONE) passes verification", async () => {
  const scenario = traceFixtureScenario("succeeded");
  const result = await verifyScenario(scenario, traceCollectorEmitting(traceFixtureMessages("succeeded")));

  assert.equal(result.pass, true, JSON.stringify(result.failures));
  assert.equal(
    result.failures.some((f) => f.kind === "trace_mismatch"),
    false
  );
});

test("protocol trace: an unmutated trace with a FAILED terminal DONE (error code/retryable/recovery fields) passes verification", async () => {
  const scenario = traceFixtureScenario("failed");
  const result = await verifyScenario(scenario, traceCollectorEmitting(traceFixtureMessages("failed")));

  assert.equal(result.pass, true, JSON.stringify(result.failures));
});

test("protocol trace: dropping the SKIP_RESULT message fails replay with a trace_mismatch", async () => {
  const scenario = traceFixtureScenario("succeeded");
  const mutated = traceFixtureMessages("succeeded").filter((m) => m.type !== "SKIP_RESULT");
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  const mismatch = result.failures.find((f) => f.kind === "trace_mismatch");
  assert.ok(mismatch, "expected a trace_mismatch failure when SKIP_RESULT is silently dropped");
  assert.match(mismatch?.detail ?? "", /protocol_trace\[0\]/);
});

test("protocol trace: altering the SKIP_RESULT's reason fails replay with a trace_mismatch", async () => {
  const scenario = traceFixtureScenario("succeeded");
  const mutated = traceFixtureMessages("succeeded").map((m) =>
    m.type === "SKIP_RESULT" ? { ...m, reason: "unknown" } : m
  );
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.kind === "trace_mismatch"));
});

test("protocol trace: dropping the DETAIL_GAP message fails replay with a trace_mismatch", async () => {
  const scenario = traceFixtureScenario("succeeded");
  const mutated = traceFixtureMessages("succeeded").filter((m) => m.type !== "DETAIL_GAP");
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  const mismatch = result.failures.find((f) => f.kind === "trace_mismatch");
  assert.ok(mismatch, "expected a trace_mismatch failure when DETAIL_GAP is silently dropped");
});

test("protocol trace: altering the DETAIL_GAP's record_key fails replay with a trace_mismatch", async () => {
  const scenario = traceFixtureScenario("succeeded");
  const mutated = traceFixtureMessages("succeeded").map((m) =>
    m.type === "DETAIL_GAP" ? { ...m, record_key: "w999-not-the-real-gap" } : m
  );
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.kind === "trace_mismatch"));
});

test("protocol trace: a DONE that flips from failed to succeeded (hiding a real failure) fails replay with a trace_mismatch", async () => {
  // The exact dishonesty this oracle exists to catch: the run's REAL
  // completeness outcome was failed/retryable, but the terminal DONE this
  // mutated collector reports claims success instead.
  const scenario = traceFixtureScenario("failed");
  const mutated = traceFixtureMessages("failed").map((m) =>
    m.type === "DONE" ? { type: "DONE", status: "succeeded", records_emitted: m.records_emitted } : m
  );
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  const mismatch = result.failures.find((f) => f.kind === "trace_mismatch");
  assert.ok(mismatch, "expected a trace_mismatch failure when a failed DONE is reported as succeeded");
});

test("protocol trace: altering the DONE error's retryable flag fails replay with a trace_mismatch", async () => {
  const scenario = traceFixtureScenario("failed");
  const mutated = traceFixtureMessages("failed").map((m) =>
    m.type === "DONE" && m.error && typeof m.error === "object"
      ? { ...m, error: { ...(m.error as Record<string, unknown>), retryable: false } }
      : m
  );
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.kind === "trace_mismatch"));
});

test("protocol trace: altering the DONE error's code fails replay with a trace_mismatch", async () => {
  const scenario = traceFixtureScenario("failed");
  const mutated = traceFixtureMessages("failed").map((m) =>
    m.type === "DONE" && m.error && typeof m.error === "object"
      ? { ...m, error: { ...(m.error as Record<string, unknown>), code: "some_other_code" } }
      : m
  );
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.kind === "trace_mismatch"));
});

test("protocol trace: PROGRESS messages are excluded from the trace entirely (diagnostic, not completeness-bearing)", async () => {
  // A collector that emits an extra PROGRESS message (never part of the
  // tracked four kinds) alongside the honest trace must still PASS —
  // PROGRESS is diagnostic per format.ts's NormalizedTraceEntry doc comment,
  // not a completeness claim, so it must not affect the comparison either
  // way.
  const scenario = traceFixtureScenario("succeeded");
  const withProgress: RawTraceMessage[] = [
    { type: "PROGRESS", message: "collecting widgets" },
    ...traceFixtureMessages("succeeded"),
  ];
  const result = await verifyScenario(scenario, traceCollectorEmitting(withProgress));

  assert.equal(result.pass, true, JSON.stringify(result.failures));
});

test("protocol trace: a legacy scenario with no protocol_trace expectation verifies exactly as before (backward compat)", async () => {
  // A scenario captured before this field existed has expected.protocol_trace
  // === undefined — the trace comparison must be skipped entirely, not
  // treated as an empty-array expectation (which would fail any run that
  // emits ANY of the four tracked messages).
  const scenario = toyScenario([widgetsInteraction(1, "w1")]);
  assert.equal(scenario.runs[0]?.expected.protocol_trace, undefined);

  const result = await verifyScenario(scenario, async (_runIndex, { fetch: toyFetch, emit }) => {
    const res = await toyFetch("https://toy.example/widgets");
    const body = (await res.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body.id, data: body });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
    emit({ type: "TRACE", rawType: "SKIP_RESULT", stream: "widgets", reason: "shape_check_failed", message: "x" });
  });

  assert.equal(result.pass, true, JSON.stringify(result.failures));
  assert.equal(
    result.failures.some((f) => f.kind === "trace_mismatch"),
    false
  );
});

/**
 * FIX (repair wave 3B, P1-3) — the "full menagerie" fixture: every one of the
 * six tracked completeness-bearing kinds in one run, including the two new
 * ones (DETAIL_GAP_ATTEMPTED, DETAIL_GAP_RECOVERED) and a SKIP_RESULT that
 * carries a `continuation` fact (SLVP §4.3's "more historical work remains"
 * signal). Proves replay FAILS when any single truth-bearing field is
 * tampered with — continuation.remaining, continuation.covered, a dropped
 * DETAIL_GAP_ATTEMPTED, a dropped DETAIL_GAP_RECOVERED, detail_gap.retryable,
 * and a digested field's underlying value — and PASSES unmutated. Also
 * proves a malformed SKIP_RESULT (continuation present but missing a
 * required field) makes trace building THROW rather than silently drop.
 */

const MENAGERIE_CONTINUATION = {
  boundary: "uidvalidity:12345",
  considered: 40,
  covered: 25,
  owner: "runtime" as const,
  remaining: true as const,
  slice_start: 100,
  slice_end: 140,
};

/** One recorded run's full fixture message sequence exercising every
 *  tracked kind: SKIP_RESULT (with continuation), DETAIL_GAP (with
 *  locator/lease/cursor fields), DETAIL_GAP_ATTEMPTED, DETAIL_GAP_RECOVERED,
 *  and a terminal DONE. */
function menagerieFixtureMessages(doneStatus: "succeeded" | "failed"): RawTraceMessage[] {
  const base: RawTraceMessage[] = [
    {
      type: "SKIP_RESULT",
      stream: "widgets",
      reason: "historical_backfill_pending",
      message: "This bounded page completed; more historical work remains.",
      continuation: MENAGERIE_CONTINUATION,
    },
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      gap_id: "gap-w3-abc123",
      lease_id: "lease-xyz-789",
      list_cursor: { page_token: "opaque-cursor-value" },
      detail_locator: { kind: "widget_detail", widget_id: "w3" },
      detail: { class: "HttpError", http_status: 429 },
    },
    {
      type: "DETAIL_GAP_ATTEMPTED",
      stream: "widgets",
      reference_only: true,
      gap_id: "gap-w2-earlier",
      lease_id: "lease-attempt-001",
    },
    {
      type: "DETAIL_GAP_RECOVERED",
      stream: "widgets",
      reference_only: true,
      gap_id: "gap-w1-earlier",
      lease_id: "lease-recover-002",
      record_key: "w1",
    },
  ];
  if (doneStatus === "succeeded") {
    return [...base, { type: "DONE", status: "succeeded", records_emitted: 1 }];
  }
  return [
    ...base,
    {
      type: "DONE",
      status: "failed",
      records_emitted: 1,
      // Repair wave 6 (P2-2 duty 2): DONE.error.message is REQUIRED whenever
      // `error` is present — see traceFixtureMessages's matching comment
      // above.
      error: {
        code: "retry_exhausted",
        message: "widget w3 retry budget exhausted",
        retryable: true,
        recovery_hint: { action: "retry_later", retryable: true },
      },
    },
  ];
}

function menagerieFixtureScenario(doneStatus: "succeeded" | "failed"): ConnectorScenario {
  const expectedTrace = buildProtocolTrace(menagerieFixtureMessages(doneStatus));
  return {
    format: SCENARIO_FORMAT,
    connector: { id: "menagerie-fixture" },
    capture: {
      captured_at: "2026-08-01T00:00:00.000Z",
      evidence_class: "synthetic-spike",
      privacy_class: "local-only",
      recorder_version: "test",
      complete: true,
    },
    runs: [
      {
        start: { scope: { streams: [{ name: "widgets" }] }, state: null },
        interactions: [widgetsInteraction(1, "w1")],
        expected: {
          records: {
            widgets: {
              count: 1,
              ids: ["w1"],
              ops: ["upsert"],
              record_sha256s: [canonicalHash({ id: "w1", name: "Widget w1" })],
            },
          },
          final_state: { widgets: { last_id: "w1" } },
          protocol_trace: expectedTrace,
        },
      },
    ],
  };
}

test("protocol trace menagerie: an unmutated full trace (SKIP_RESULT+continuation, DETAIL_GAP, DETAIL_GAP_ATTEMPTED, DETAIL_GAP_RECOVERED, succeeded DONE) passes verification", async () => {
  const scenario = menagerieFixtureScenario("succeeded");
  const result = await verifyScenario(scenario, traceCollectorEmitting(menagerieFixtureMessages("succeeded")));

  assert.equal(result.pass, true, JSON.stringify(result.failures));
});

test("protocol trace menagerie (a): flipping continuation.remaining fails replay with a trace_mismatch", async () => {
  const scenario = menagerieFixtureScenario("succeeded");
  const mutated = menagerieFixtureMessages("succeeded").map((m) =>
    m.type === "SKIP_RESULT" && m.continuation && typeof m.continuation === "object"
      ? { ...m, continuation: { ...(m.continuation as Record<string, unknown>), remaining: false } }
      : m
  );
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  // A `remaining: false` continuation also fails normalizeContinuation's own
  // strict shape check (RuntimeContinuationFact.remaining is fixed `true`),
  // so this is reported as a trace_normalization_error (fail-closed) rather
  // than a trace_mismatch — either way, verification must FAIL, which is
  // what this test actually proves.
  assert.equal(result.pass, false);
  assert.ok(
    result.failures.some((f) => f.kind === "trace_mismatch" || f.kind === "trace_normalization_error"),
    JSON.stringify(result.failures)
  );
});

test("protocol trace menagerie (b): altering continuation.covered fails replay with a trace_mismatch", async () => {
  const scenario = menagerieFixtureScenario("succeeded");
  const mutated = menagerieFixtureMessages("succeeded").map((m) =>
    m.type === "SKIP_RESULT" && m.continuation && typeof m.continuation === "object"
      ? { ...m, continuation: { ...(m.continuation as Record<string, unknown>), covered: 1 } }
      : m
  );
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  const mismatch = result.failures.find((f) => f.kind === "trace_mismatch");
  assert.ok(mismatch, "expected a trace_mismatch failure when continuation.covered is altered");
});

test("protocol trace menagerie (c): dropping DETAIL_GAP_ATTEMPTED fails replay with a trace_mismatch", async () => {
  const scenario = menagerieFixtureScenario("succeeded");
  const mutated = menagerieFixtureMessages("succeeded").filter((m) => m.type !== "DETAIL_GAP_ATTEMPTED");
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  const mismatch = result.failures.find((f) => f.kind === "trace_mismatch");
  assert.ok(mismatch, "expected a trace_mismatch failure when DETAIL_GAP_ATTEMPTED is silently dropped");
});

test("protocol trace menagerie (d): dropping DETAIL_GAP_RECOVERED fails replay with a trace_mismatch", async () => {
  const scenario = menagerieFixtureScenario("succeeded");
  const mutated = menagerieFixtureMessages("succeeded").filter((m) => m.type !== "DETAIL_GAP_RECOVERED");
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  const mismatch = result.failures.find((f) => f.kind === "trace_mismatch");
  assert.ok(mismatch, "expected a trace_mismatch failure when DETAIL_GAP_RECOVERED is silently dropped");
});

test("protocol trace menagerie (e): flipping detail_gap.retryable fails replay (either trace_mismatch or fail-closed shape rejection)", async () => {
  const scenario = menagerieFixtureScenario("succeeded");
  const mutated = menagerieFixtureMessages("succeeded").map((m) =>
    m.type === "DETAIL_GAP" ? { ...m, retryable: false } : m
  );
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  // DETAIL_GAP.retryable is a fixed protocol literal (`true`) per the
  // field-disposition table, so a flipped value fails normalizeDetailGap's
  // OWN strict shape check (fail-closed) rather than reaching the
  // trace_mismatch comparison — proving the fixed-literal check itself
  // catches tampering, not just the equality comparison downstream.
  assert.equal(result.pass, false);
  assert.ok(
    result.failures.some((f) => f.kind === "trace_mismatch" || f.kind === "trace_normalization_error"),
    JSON.stringify(result.failures)
  );
});

test("protocol trace menagerie (f): changing a digested field's underlying value (gap_id) fails replay with a trace_mismatch (digest mismatch)", async () => {
  const scenario = menagerieFixtureScenario("succeeded");
  const mutated = menagerieFixtureMessages("succeeded").map((m) =>
    m.type === "DETAIL_GAP" ? { ...m, gap_id: "gap-DIFFERENT-value" } : m
  );
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  const mismatch = result.failures.find((f) => f.kind === "trace_mismatch");
  assert.ok(
    mismatch,
    "expected a trace_mismatch failure when a digested field's underlying value changes (digest mismatch)"
  );
  assert.match(mismatch?.detail ?? "", /gap_id_digest/);
});

test("protocol trace menagerie: a malformed SKIP_RESULT (continuation present but boundary missing) makes trace building THROW, not silently drop", async () => {
  const scenario = menagerieFixtureScenario("succeeded");
  const mutated = menagerieFixtureMessages("succeeded").map((m) => {
    if (m.type !== "SKIP_RESULT" || !m.continuation || typeof m.continuation !== "object") {
      return m;
    }
    const { boundary: _boundary, ...rest } = m.continuation as Record<string, unknown>;
    return { ...m, continuation: rest };
  });
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  const shapeFailure = result.failures.find((f) => f.kind === "trace_normalization_error");
  assert.ok(
    shapeFailure,
    `expected a trace_normalization_error when continuation is malformed (missing boundary), got: ${JSON.stringify(result.failures)}`
  );
  assert.match(shapeFailure?.detail ?? "", /continuation/);
});

test("protocol trace menagerie: building the EXPECTED trace at capture time also throws on a malformed SKIP_RESULT (recording a malformed run must fail)", () => {
  // Mirrors bin/scenario-record.ts's own call: buildProtocolTrace() with no
  // try/catch around it, applied to a malformed continuation (present but
  // missing `owner`). Proves the fail-closed behavior protects the RECORD
  // path too, not just the REPLAY/verify path.
  const malformed: RawTraceMessage[] = [
    {
      type: "SKIP_RESULT",
      stream: "widgets",
      reason: "historical_backfill_pending",
      message: "bad",
      continuation: { boundary: "b", considered: 1, covered: 1, remaining: true, slice_start: 0, slice_end: 1 },
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("protocol trace menagerie: a malformed DETAIL_GAP_ATTEMPTED (missing lease_id) makes trace building THROW", () => {
  const malformed: RawTraceMessage[] = [
    { type: "DETAIL_GAP_ATTEMPTED", stream: "widgets", reference_only: true, gap_id: "gap-1" },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("protocol trace menagerie: a malformed DETAIL_GAP_RECOVERED (missing gap_id) makes trace building THROW", () => {
  const malformed: RawTraceMessage[] = [{ type: "DETAIL_GAP_RECOVERED", stream: "widgets", reference_only: true }];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// ─── FIX 2 (P1-2, repair wave 4): TRACE_POLICY exhaustiveness ─────────────
//
// `TRACE_POLICY` (verify.ts) is declared `satisfies
// Record<EmittedMessage["type"], TraceDisposition>` — that clause alone is
// enough to make an ADD to `EmittedMessage`'s union a compile error (tsc
// would reject TRACE_POLICY as missing the new member's key), which is the
// real enforcement mechanism the task asks for. This test is a runtime
// belt-and-suspenders check of the SAME property, so a change to either
// TRACE_POLICY's key set or to this test's own hardcoded expectation is
// caught in `node --test` output too, not only in a `tsc --noEmit` pass a
// contributor might skip locally.
test("TRACE_POLICY: every EmittedMessage kind has an explicit disposition, exactly the fourteen kinds the protocol declares", () => {
  const expectedKinds = [
    "RECORD",
    "STATE",
    "PROGRESS",
    "ASSISTANCE",
    "ASSISTANCE_STATUS",
    "SKIP_RESULT",
    "DETAIL_GAP",
    "DETAIL_GAP_ATTEMPTED",
    "DETAIL_COVERAGE",
    "DETAIL_GAP_RECOVERED",
    "DETAIL_GAPS_PAGE_REQUEST",
    "DONE",
    "INTERACTION",
    // Added by @pdpp/connector-protocol 0.0.2, after this oracle was written.
    "STREAM_EVIDENCE",
  ] satisfies EmittedMessage["type"][];
  assert.deepEqual(Object.keys(TRACE_POLICY).sort(), [...expectedKinds].sort());
});

test("TRACE_POLICY: the tracked subset matches exactly the seven kinds this oracle's normalizers cover", () => {
  const tracked = Object.entries(TRACE_POLICY)
    .filter(([, disposition]) => disposition === "tracked")
    .map(([kind]) => kind)
    .sort();
  assert.deepEqual(tracked, [
    "DETAIL_COVERAGE",
    "DETAIL_GAP",
    "DETAIL_GAPS_PAGE_REQUEST",
    "DETAIL_GAP_ATTEMPTED",
    "DETAIL_GAP_RECOVERED",
    "DONE",
    "SKIP_RESULT",
  ]);
});

test("TRACE_POLICY: ASSISTANCE, ASSISTANCE_STATUS and STREAM_EVIDENCE are the only unsupported_claim_withheld kinds", () => {
  const withheld = Object.entries(TRACE_POLICY)
    .filter(([, disposition]) => disposition === "unsupported_claim_withheld")
    .map(([kind]) => kind)
    .sort();
  // STREAM_EVIDENCE carries a child-stream coverage claim this offline
  // HTTP-replay oracle has no normalizer for, so it is withheld rather than
  // asserted — same reasoning as the two ASSISTANCE kinds.
  assert.deepEqual(withheld, ["ASSISTANCE", "ASSISTANCE_STATUS", "STREAM_EVIDENCE"]);
});

// ─── FIX 3 (P2-1, repair wave 4): strict parsers reject, never sanitize ────
//
// Every normalizer in verify.ts must throw TraceNormalizationError on a
// malformed truth-bearing field rather than silently filtering/coercing it
// away. One test per malformed-field class named in the task.

test("FIX 3: DETAIL_COVERAGE with an invalid member inside a key array (an object, not string|number) throws instead of silently filtering it out", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_COVERAGE",
      stream: "widgets",
      state_stream: "widgets",
      reference_only: true,
      required_keys: ["w1", { not: "a valid key" }, "w3"],
      hydrated_keys: ["w1", "w3"],
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: DETAIL_COVERAGE with reference_only: false (wrong fixed literal) throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_COVERAGE",
      stream: "widgets",
      state_stream: "widgets",
      reference_only: false,
      required_keys: ["w1"],
      hydrated_keys: ["w1"],
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: a malformed recovery_hint (a number, neither string nor {action?,retryable?}) throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "SKIP_RESULT",
      stream: "widgets",
      reason: "shape_check_failed",
      message: "x",
      recovery_hint: 42,
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: a recovery_hint object whose retryable is a string (not boolean) throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "SKIP_RESULT",
      stream: "widgets",
      reason: "shape_check_failed",
      message: "x",
      recovery_hint: { action: "retry_later", retryable: "yes" },
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: a malformed network_pressure (endpoint_route missing) throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      detail: { class: "HttpError", http_status: 429, network_pressure: { error_class: "http_429", method: "GET" } },
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: a malformed network_pressure (status is a string, not a number) throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      last_error: {
        class: "HttpError",
        network_pressure: {
          error_class: "http_429",
          method: "GET",
          endpoint_route: "/widgets/w3",
          status: "429",
        },
      },
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: a malformed nested detail (present but not an object) throws instead of every field silently reading as absent", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      detail: "not an object",
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: a malformed nested last_error (class field is a number, not a string) throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      last_error: { class: 42 },
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: an unexpected fixed-literal variant (DETAIL_GAP.status: 'active' instead of the closed literal 'pending') throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "active",
      retryable: true,
      reference_only: true,
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: DONE missing records_emitted (now required on the wire) throws instead of normalizing without it", () => {
  const malformed: RawTraceMessage[] = [{ type: "DONE", status: "succeeded" }];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: DETAIL_GAPS_PAGE_REQUEST with a non-string element in streams[] throws", () => {
  const malformed: RawTraceMessage[] = [
    { type: "DETAIL_GAPS_PAGE_REQUEST", request_id: "req-1", reference_only: true, streams: ["widgets", 42] },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: DETAIL_COVERAGE.considered = -1 (negative count) throws instead of silently omitting it", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_COVERAGE",
      stream: "widgets",
      state_stream: "widgets",
      reference_only: true,
      required_keys: [],
      hydrated_keys: [],
      considered: -1,
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: DETAIL_COVERAGE.covered = 2.5 (fractional count) throws instead of silently omitting it", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_COVERAGE",
      stream: "widgets",
      state_stream: "widgets",
      reference_only: true,
      required_keys: ["w1", "w2"],
      hydrated_keys: ["w1"],
      covered: 2.5,
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: SKIP_RESULT.continuation with a blank (whitespace-only) boundary throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "SKIP_RESULT",
      stream: "widgets",
      reason: "historical_backfill_pending",
      message: "x",
      continuation: {
        boundary: "   ",
        considered: 10,
        covered: 5,
        owner: "runtime",
        remaining: true,
        slice_start: 0,
        slice_end: 10,
      },
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

test("FIX 3: SKIP_RESULT.continuation with a fractional slice_end throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "SKIP_RESULT",
      stream: "widgets",
      reason: "historical_backfill_pending",
      message: "x",
      continuation: {
        boundary: "uidvalidity:1",
        considered: 10,
        covered: 5,
        owner: "runtime",
        remaining: true,
        slice_start: 0,
        slice_end: 10.5,
      },
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// ─── Runtime parity: the trace oracle rejects exactly what the runtime's own
//     emission-side validator rejects ────────────────────────────────────
//
// Bounded-closure review demand: "the replay oracle must reject exactly what
// the runtime rejects — no message the runtime would refuse may be
// normalized/repaired by the trace oracle." For `SKIP_RESULT.continuation`
// the runtime exports its own emission-side validator,
// `validateRuntimeContinuationFact` (connector-runtime-protocol.ts:247-265),
// and `normalizeContinuation` (verify.ts) now CALLS that function directly
// rather than reproducing its rules — so there is only one implementation of
// "well-formed continuation", not two that could silently drift apart. This
// test drives a curated set of malformed continuation facts through BOTH the
// runtime's validator directly and this module's trace normalizer, and
// asserts they agree on every one: the runtime rejects it AND the oracle
// rejects it. Because the oracle calls the runtime function by reference
// (not by reimplementation), this test is a regression guard against a
// future edit accidentally reintroducing a bespoke, drift-prone copy — it
// is not exercising two independent implementations that happen to agree
// today.
//
// Coverage of this curated set, stated honestly: it exercises every
// individual field `validateRuntimeContinuationFact` checks (missing/blank
// boundary, negative and fractional considered/covered/slice_start,
// slice_end < slice_start, wrong owner/remaining literals, non-object root)
// — i.e. one malformed case per branch of that function's `.every(Boolean)`
// list — plus one well-formed control the runtime ACCEPTS, to prove the
// parity check isn't vacuously "both sides reject everything". It does not
// attempt combinatorial coverage of every multi-field-malformed combination,
// since the runtime validator itself has no per-field error granularity to
// diverge on — each check is an independent boolean in one flat `.every`.
const CONTINUATION_PARITY_CASES: ReadonlyArray<{ name: string; value: unknown }> = [
  {
    name: "missing boundary",
    value: { considered: 1, covered: 1, owner: "runtime", remaining: true, slice_start: 0, slice_end: 1 },
  },
  {
    name: "blank boundary",
    value: {
      boundary: "  ",
      considered: 1,
      covered: 1,
      owner: "runtime",
      remaining: true,
      slice_start: 0,
      slice_end: 1,
    },
  },
  {
    name: "negative considered",
    value: {
      boundary: "b",
      considered: -1,
      covered: 1,
      owner: "runtime",
      remaining: true,
      slice_start: 0,
      slice_end: 1,
    },
  },
  {
    name: "fractional considered",
    value: {
      boundary: "b",
      considered: 1.5,
      covered: 1,
      owner: "runtime",
      remaining: true,
      slice_start: 0,
      slice_end: 1,
    },
  },
  {
    name: "negative covered",
    value: {
      boundary: "b",
      considered: 1,
      covered: -1,
      owner: "runtime",
      remaining: true,
      slice_start: 0,
      slice_end: 1,
    },
  },
  {
    name: "fractional covered",
    value: {
      boundary: "b",
      considered: 1,
      covered: 1.5,
      owner: "runtime",
      remaining: true,
      slice_start: 0,
      slice_end: 1,
    },
  },
  {
    name: "negative slice_start",
    value: {
      boundary: "b",
      considered: 1,
      covered: 1,
      owner: "runtime",
      remaining: true,
      slice_start: -1,
      slice_end: 1,
    },
  },
  {
    name: "fractional slice_start",
    value: {
      boundary: "b",
      considered: 1,
      covered: 1,
      owner: "runtime",
      remaining: true,
      slice_start: 0.5,
      slice_end: 1,
    },
  },
  {
    name: "fractional slice_end",
    value: {
      boundary: "b",
      considered: 1,
      covered: 1,
      owner: "runtime",
      remaining: true,
      slice_start: 0,
      slice_end: 1.5,
    },
  },
  {
    name: "slice_end < slice_start",
    value: {
      boundary: "b",
      considered: 1,
      covered: 1,
      owner: "runtime",
      remaining: true,
      slice_start: 10,
      slice_end: 1,
    },
  },
  {
    name: "wrong owner literal",
    value: {
      boundary: "b",
      considered: 1,
      covered: 1,
      owner: "connector",
      remaining: true,
      slice_start: 0,
      slice_end: 1,
    },
  },
  {
    name: "remaining: false",
    value: {
      boundary: "b",
      considered: 1,
      covered: 1,
      owner: "runtime",
      remaining: false,
      slice_start: 0,
      slice_end: 1,
    },
  },
  {
    name: "NaN considered",
    value: {
      boundary: "b",
      considered: Number.NaN,
      covered: 1,
      owner: "runtime",
      remaining: true,
      slice_start: 0,
      slice_end: 1,
    },
  },
  {
    name: "Infinity slice_end",
    value: {
      boundary: "b",
      considered: 1,
      covered: 1,
      owner: "runtime",
      remaining: true,
      slice_start: 0,
      slice_end: Number.POSITIVE_INFINITY,
    },
  },
  { name: "continuation is an array, not an object", value: [1, 2, 3] },
  { name: "continuation is a string", value: "not-an-object" },
];

test("parity: every malformed continuation the RUNTIME's own validateRuntimeContinuationFact rejects, the trace oracle also rejects", () => {
  for (const { name, value } of CONTINUATION_PARITY_CASES) {
    let runtimeRejected = false;
    try {
      validateRuntimeContinuationFact(value);
    } catch {
      runtimeRejected = true;
    }
    assert.equal(runtimeRejected, true, `test bug: curated case "${name}" was not actually rejected by the runtime`);

    const malformed: RawTraceMessage[] = [
      {
        type: "SKIP_RESULT",
        stream: "widgets",
        reason: "historical_backfill_pending",
        message: "x",
        continuation: value,
      },
    ];
    assert.throws(
      () => buildProtocolTrace(malformed),
      TraceNormalizationError,
      `parity divergence on case "${name}": runtime rejects this continuation but the trace oracle did not`
    );
  }
});

test("parity: a WELL-FORMED continuation the runtime's validator ACCEPTS also normalizes cleanly through the trace oracle (not vacuously rejecting everything)", () => {
  const wellFormed = {
    boundary: "uidvalidity:12345",
    considered: 40,
    covered: 25,
    owner: "runtime" as const,
    remaining: true as const,
    slice_start: 100,
    slice_end: 140,
  };
  assert.doesNotThrow(() => validateRuntimeContinuationFact(wellFormed));

  const wellFormedTrace: RawTraceMessage[] = [
    {
      type: "SKIP_RESULT",
      stream: "widgets",
      reason: "historical_backfill_pending",
      message: "x",
      continuation: wellFormed,
    },
  ];
  assert.doesNotThrow(() => buildProtocolTrace(wellFormedTrace));
});

// ─── FIX 2b (repair wave 4): DETAIL_GAP.network_pressure round-trips ───────

test("FIX 2b: a well-formed detail.network_pressure normalizes cleanly and round-trips through verifyTrace unmutated", async () => {
  const withPressure: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      detail: {
        class: "HttpError",
        http_status: 429,
        network_pressure: {
          error_class: "http_429",
          method: "GET",
          endpoint_route: "/widgets/w3",
          status: 429,
          attempt: 2,
          retry_after_ms: 1500,
        },
      },
      // Repair wave 6 (P2-2 duty 2): detail_locator is REQUIRED — see
      // traceFixtureMessages's matching comment above.
      detail_locator: { kind: "widget_detail", widget_id: "w3" },
    },
    { type: "DONE", status: "succeeded", records_emitted: 1 },
  ];
  const expectedTrace = buildProtocolTrace(withPressure);
  const scenario: ConnectorScenario = {
    format: SCENARIO_FORMAT,
    connector: { id: "trace-fixture" },
    capture: {
      captured_at: "2026-08-01T00:00:00.000Z",
      evidence_class: "synthetic-spike",
      privacy_class: "local-only",
      recorder_version: "test",
      complete: true,
    },
    runs: [
      {
        start: { scope: { streams: [{ name: "widgets" }] }, state: null },
        interactions: [widgetsInteraction(1, "w1")],
        expected: {
          records: {
            widgets: {
              count: 1,
              ids: ["w1"],
              ops: ["upsert"],
              record_sha256s: [canonicalHash({ id: "w1", name: "Widget w1" })],
            },
          },
          final_state: { widgets: { last_id: "w1" } },
          protocol_trace: expectedTrace,
        },
      },
    ],
  };
  const collector: RunCollector = async (_runIndex, { fetch: toyFetch, emit }) => {
    const res = await toyFetch("https://toy.example/widgets");
    const body = (await res.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body.id, data: body });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
    for (const raw of withPressure) {
      const { type: rawType, ...rest } = raw;
      emit({ type: "TRACE", rawType, ...rest });
    }
  };
  const result = await verifyScenario(scenario, collector);
  assert.equal(result.pass, true, JSON.stringify(result.failures));
});

test("FIX 2b: endpoint_route is digested — a route SUBSTITUTION (same error_class/method/status) still fails replay with a trace_mismatch", async () => {
  const base: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      detail: {
        network_pressure: { error_class: "http_429", method: "GET", endpoint_route: "/widgets/w3", status: 429 },
      },
      // Repair wave 6 (P2-2 duty 2): detail_locator is REQUIRED — see
      // traceFixtureMessages's matching comment above.
      detail_locator: { kind: "widget_detail", widget_id: "w3" },
    },
    { type: "DONE", status: "succeeded", records_emitted: 1 },
  ];
  const expectedTrace = buildProtocolTrace(base);
  const scenario: ConnectorScenario = {
    format: SCENARIO_FORMAT,
    connector: { id: "trace-fixture" },
    capture: {
      captured_at: "2026-08-01T00:00:00.000Z",
      evidence_class: "synthetic-spike",
      privacy_class: "local-only",
      recorder_version: "test",
      complete: true,
    },
    runs: [
      {
        start: { scope: { streams: [{ name: "widgets" }] }, state: null },
        interactions: [widgetsInteraction(1, "w1")],
        expected: {
          records: {
            widgets: {
              count: 1,
              ids: ["w1"],
              ops: ["upsert"],
              record_sha256s: [canonicalHash({ id: "w1", name: "Widget w1" })],
            },
          },
          final_state: { widgets: { last_id: "w1" } },
          protocol_trace: expectedTrace,
        },
      },
    ],
  };
  const mutated = base.map((m) =>
    m.type === "DETAIL_GAP"
      ? {
          ...m,
          detail: {
            network_pressure: {
              error_class: "http_429",
              method: "GET",
              endpoint_route: "/widgets/DIFFERENT-w3",
              status: 429,
            },
          },
        }
      : m
  );
  const collector: RunCollector = async (_runIndex, { fetch: toyFetch, emit }) => {
    const res = await toyFetch("https://toy.example/widgets");
    const body = (await res.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body.id, data: body });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
    for (const raw of mutated) {
      const { type: rawType, ...rest } = raw;
      emit({ type: "TRACE", rawType, ...rest });
    }
  };
  const result = await verifyScenario(scenario, collector);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.kind === "trace_mismatch"));
});

// ─── FIX 2c (repair wave 4): DONE.records_emitted ──────────────────────────

test("FIX 2c: DONE.records_emitted mismatch (connector under/over-reports its own total) fails replay with a trace_mismatch", async () => {
  const scenario = traceFixtureScenario("succeeded");
  const mutated = traceFixtureMessages("succeeded").map((m) =>
    m.type === "DONE" ? { ...m, records_emitted: 999 } : m
  );
  const result = await verifyScenario(scenario, traceCollectorEmitting(mutated));

  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.kind === "trace_mismatch"));
});

// ─── FIX 2a (repair wave 4): DETAIL_GAPS_PAGE_REQUEST ──────────────────────

test("FIX 2a: DETAIL_GAPS_PAGE_REQUEST normalizes and round-trips through verifyTrace unmutated", async () => {
  const messages: RawTraceMessage[] = [
    {
      type: "DETAIL_GAPS_PAGE_REQUEST",
      request_id: "req-1",
      reference_only: true,
      max_bytes: 65_536,
      streams: ["widgets"],
    },
    { type: "DONE", status: "succeeded", records_emitted: 1 },
  ];
  const expectedTrace = buildProtocolTrace(messages);
  const scenario: ConnectorScenario = {
    format: SCENARIO_FORMAT,
    connector: { id: "trace-fixture" },
    capture: {
      captured_at: "2026-08-01T00:00:00.000Z",
      evidence_class: "synthetic-spike",
      privacy_class: "local-only",
      recorder_version: "test",
      complete: true,
    },
    runs: [
      {
        start: { scope: { streams: [{ name: "widgets" }] }, state: null },
        interactions: [widgetsInteraction(1, "w1")],
        expected: {
          records: {
            widgets: {
              count: 1,
              ids: ["w1"],
              ops: ["upsert"],
              record_sha256s: [canonicalHash({ id: "w1", name: "Widget w1" })],
            },
          },
          final_state: { widgets: { last_id: "w1" } },
          protocol_trace: expectedTrace,
        },
      },
    ],
  };
  const collector: RunCollector = async (_runIndex, { fetch: toyFetch, emit }) => {
    const res = await toyFetch("https://toy.example/widgets");
    const body = (await res.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body.id, data: body });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
    for (const raw of messages) {
      const { type: rawType, ...rest } = raw;
      emit({ type: "TRACE", rawType, ...rest });
    }
  };
  const result = await verifyScenario(scenario, collector);
  assert.equal(result.pass, true, JSON.stringify(result.failures));
});

// ─── FIX 2d (repair wave 4): observedUnsupportedEvidenceSurface ───────────

test("observedUnsupportedEvidenceSurface: false when no run message is ASSISTANCE/ASSISTANCE_STATUS", async () => {
  const { observedUnsupportedEvidenceSurface } = await import("./verify.ts");
  assert.equal(observedUnsupportedEvidenceSurface([{ type: "RECORD" }, { type: "DONE" }, { type: "PROGRESS" }]), false);
});

test("observedUnsupportedEvidenceSurface: true when a run message is ASSISTANCE", async () => {
  const { observedUnsupportedEvidenceSurface } = await import("./verify.ts");
  assert.equal(observedUnsupportedEvidenceSurface([{ type: "RECORD" }, { type: "ASSISTANCE" }]), true);
});

test("observedUnsupportedEvidenceSurface: true when a run message is ASSISTANCE_STATUS", async () => {
  const { observedUnsupportedEvidenceSurface } = await import("./verify.ts");
  assert.equal(observedUnsupportedEvidenceSurface([{ type: "ASSISTANCE_STATUS" }]), true);
});

// ─── Repair wave 6, P2-2: complete wire-message registry, validation BEFORE
// normalization ────────────────────────────────────────────────────────────
//
// Duty (1) — UNKNOWN TYPE REJECTION — is exercised in bin/scenario-cli.test.ts
// (record side AND verify side, each driving the real subprocess pipeline);
// this file's own coverage is the pure `wire-registry.ts` unit tests below,
// since this file's existing convention (see this module's own top-of-file
// doc comment) is pure/no-subprocess trace-normalization tests.
//
// Duty (2) — COMPLETE SHAPE VALIDATION for tracked kinds — one negative
// control per named hole, using the SAME `assert.throws(() =>
// buildProtocolTrace([...]), TraceNormalizationError)` pattern the existing
// FIX 3 section above uses, plus one VALID control per kind proving the
// tightened checks don't reject a well-formed message.

test("wire-registry: isKnownMessageType is true for every one of the thirteen EmittedMessage kinds", () => {
  for (const type of [
    "RECORD",
    "STATE",
    "PROGRESS",
    "ASSISTANCE",
    "ASSISTANCE_STATUS",
    "SKIP_RESULT",
    "DETAIL_GAP",
    "DETAIL_GAP_ATTEMPTED",
    "DETAIL_COVERAGE",
    "DETAIL_GAP_RECOVERED",
    "DETAIL_GAPS_PAGE_REQUEST",
    "DONE",
    "INTERACTION",
  ]) {
    assert.equal(isKnownMessageType(type), true, `expected ${type} to be known`);
  }
});

test("wire-registry: isKnownMessageType is false for an unrecognized type, and for a non-string type", () => {
  assert.equal(isKnownMessageType("BOGUS_MESSAGE"), false);
  assert.equal(isKnownMessageType(42), false);
  assert.equal(isKnownMessageType(undefined), false);
});

test("wire-registry: assertKnownMessageType throws UnknownMessageTypeError naming the offending type, for an unknown message type", () => {
  assert.throws(() => assertKnownMessageType({ type: "BOGUS_MESSAGE" }), UnknownMessageTypeError);
});

test("wire-registry: assertKnownMessageType does not throw for any real EmittedMessage-shaped object", () => {
  assert.doesNotThrow(() => assertKnownMessageType({ type: "DONE", status: "succeeded", records_emitted: 0 }));
});

// recovery_hint: {} (empty object) rejects — action is required on the
// object form.
test("P2-2 negative control: recovery_hint {} (empty object) throws — action is required on the object form", () => {
  const malformed: RawTraceMessage[] = [
    { type: "SKIP_RESULT", stream: "widgets", reason: "shape_check_failed", message: "x", recovery_hint: {} },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// recovery_hint: {retryable: true} (no action) rejects.
test("P2-2 negative control: recovery_hint {retryable: true} (action missing) throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "SKIP_RESULT",
      stream: "widgets",
      reason: "shape_check_failed",
      message: "x",
      recovery_hint: { retryable: true },
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// One valid control: a well-formed {action, retryable?} recovery_hint still
// normalizes cleanly (the tightened check doesn't reject the honest case).
test("P2-2 valid control: a well-formed recovery_hint {action, retryable} normalizes cleanly", () => {
  const wellFormed: RawTraceMessage[] = [
    {
      type: "SKIP_RESULT",
      stream: "widgets",
      reason: "shape_check_failed",
      message: "x",
      recovery_hint: { action: "retry_later", retryable: true },
    },
  ];
  assert.doesNotThrow(() => buildProtocolTrace(wellFormed));
});

// DETAIL_GAP missing detail_locator entirely — REQUIRED on the wire.
test("P2-2 negative control: DETAIL_GAP missing detail_locator throws (required on the wire)", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// DETAIL_GAP.detail_locator present but not an object.
test("P2-2 negative control: DETAIL_GAP.detail_locator is a non-object (a string) throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      detail_locator: "widget_detail" as unknown as RawTraceMessage["detail_locator"],
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// DETAIL_GAP.detail_locator.kind is a blank (whitespace-only) string.
test("P2-2 negative control: DETAIL_GAP.detail_locator.kind is blank (whitespace-only) throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      detail_locator: { kind: "   " },
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// One valid control: a well-formed detail_locator normalizes cleanly.
test("P2-2 valid control: a well-formed DETAIL_GAP with detail_locator normalizes cleanly", () => {
  const wellFormed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      detail_locator: { kind: "widget_detail", widget_id: "w3" },
    },
  ];
  assert.doesNotThrow(() => buildProtocolTrace(wellFormed));
});

// numeric gap_id on DETAIL_GAP rejects (validated-when-present — the field
// itself is optional on DETAIL_GAP, but when present must be a string).
test("P2-2 negative control: numeric gap_id on DETAIL_GAP throws (must be a string when present)", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      detail_locator: { kind: "widget_detail" },
      gap_id: 12_345 as unknown as string,
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// numeric lease_id on DETAIL_GAP_RECOVERED rejects — required gap_id present
// and valid, but lease_id (optional-but-string-when-present) is a number.
test("P2-2 negative control: numeric lease_id on DETAIL_GAP_RECOVERED throws (must be a string when present)", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP_RECOVERED",
      stream: "widgets",
      reference_only: true,
      gap_id: "gap-1",
      lease_id: 999 as unknown as string,
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// Invalid optional gap_id on DETAIL_GAP (present but wrong-typed — an
// object, not a string) — distinct control from the numeric case above,
// naming a different wrong type for the same optional-string field.
test("P2-2 negative control: an object-typed gap_id on DETAIL_GAP throws (invalid optional gap_id)", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      detail_locator: { kind: "widget_detail" },
      gap_id: { not: "a valid id" } as unknown as string,
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// One valid control: string gap_id/lease_id on DETAIL_GAP normalizes
// cleanly (the tightened type check doesn't reject the honest case).
test("P2-2 valid control: string gap_id and lease_id on DETAIL_GAP normalize cleanly", () => {
  const wellFormed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP",
      stream: "widgets",
      reason: "rate_limited",
      record_key: "w3",
      status: "pending",
      retryable: true,
      reference_only: true,
      detail_locator: { kind: "widget_detail" },
      gap_id: "gap-1",
      lease_id: "lease-1",
    },
  ];
  assert.doesNotThrow(() => buildProtocolTrace(wellFormed));
});

// DONE.error missing message.
test("P2-2 negative control: DONE.error missing message throws (required whenever error is present)", () => {
  const malformed: RawTraceMessage[] = [
    { type: "DONE", status: "failed", records_emitted: 0, error: { code: "x", retryable: true } },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// DONE.error missing retryable.
test("P2-2 negative control: DONE.error missing retryable throws (required whenever error is present)", () => {
  const malformed: RawTraceMessage[] = [
    { type: "DONE", status: "failed", records_emitted: 0, error: { code: "x", message: "boom" } },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// DONE.error: {} (empty object) rejects — both message and retryable
// required whenever error is present at all.
test("P2-2 negative control: DONE.error {} (empty object) throws", () => {
  const malformed: RawTraceMessage[] = [{ type: "DONE", status: "failed", records_emitted: 0, error: {} }];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});

// One valid control: a well-formed DONE.error normalizes cleanly, and
// error.message is DIGESTED (not compared-directly) into the trace entry —
// proving it round-trips through verifyTrace unmutated and is caught by a
// SUBSTITUTION, matching every other digested field's contract.
test("P2-2 valid control: a well-formed DONE.error normalizes cleanly, and error.message digest round-trips through verifyTrace", async () => {
  const base: RawTraceMessage[] = [
    {
      type: "DONE",
      status: "failed",
      records_emitted: 0,
      error: { code: "retry_exhausted", message: "widget w3 retry budget exhausted", retryable: true },
    },
  ];
  const expectedTrace = buildProtocolTrace(base);
  const doneEntry = expectedTrace.find((e) => e.kind === "done");
  assert.ok(doneEntry?.kind === "done");
  assert.equal(doneEntry.error_message_digest?.present, true);
  assert.ok(
    typeof doneEntry.error_message_digest?.sha256 === "string" && doneEntry.error_message_digest.sha256.length === 64
  );

  const scenario: ConnectorScenario = {
    format: SCENARIO_FORMAT,
    connector: { id: "trace-fixture" },
    capture: {
      captured_at: "2026-08-01T00:00:00.000Z",
      evidence_class: "synthetic-spike",
      privacy_class: "local-only",
      recorder_version: "test",
      complete: true,
    },
    runs: [
      {
        start: { scope: { streams: [{ name: "widgets" }] }, state: null },
        interactions: [widgetsInteraction(1, "w1")],
        expected: {
          records: {
            widgets: {
              count: 1,
              ids: ["w1"],
              ops: ["upsert"],
              record_sha256s: [canonicalHash({ id: "w1", name: "Widget w1" })],
            },
          },
          final_state: { widgets: { last_id: "w1" } },
          protocol_trace: expectedTrace,
        },
      },
    ],
  };
  const collector: RunCollector = async (_runIndex, { fetch: toyFetch, emit }) => {
    const res = await toyFetch("https://toy.example/widgets");
    const body = (await res.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body.id, data: body });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
    for (const raw of base) {
      const { type: rawType, ...rest } = raw;
      emit({ type: "TRACE", rawType, ...rest });
    }
  };
  const result = await verifyScenario(scenario, collector);
  assert.equal(result.pass, true, JSON.stringify(result.failures));

  // SUBSTITUTION: a different error.message (same code/retryable) must
  // still fail replay via the digest mismatch — proving `message` is truth-
  // bearing evidence this oracle actually checks, not merely accepted.
  const mutated = base.map((m) =>
    m.type === "DONE" && m.error
      ? { ...m, error: { ...(m.error as Record<string, unknown>), message: "a completely different message" } }
      : m
  );
  const mutatedCollector: RunCollector = async (_runIndex, { fetch: toyFetch, emit }) => {
    const res = await toyFetch("https://toy.example/widgets");
    const body = (await res.json()) as { id: string; name: string };
    emit({ type: "RECORD", stream: "widgets", id: body.id, data: body });
    emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
    for (const raw of mutated) {
      const { type: rawType, ...rest } = raw;
      emit({ type: "TRACE", rawType, ...rest });
    }
  };
  const mutatedResult = await verifyScenario(scenario, mutatedCollector);
  assert.equal(mutatedResult.pass, false);
  assert.ok(mutatedResult.failures.some((f) => f.kind === "trace_mismatch" || f.kind === "trace_normalization_error"));
});

// wrong nested types: DETAIL_GAP_ATTEMPTED's gap_id is a number (wire type
// declares it a required STRING, not string|number) — distinct from the
// DETAIL_GAP optional-field controls above; this is the REQUIRED-field case.
test("P2-2 negative control: DETAIL_GAP_ATTEMPTED with a numeric gap_id (wrong nested type on a required string field) throws", () => {
  const malformed: RawTraceMessage[] = [
    {
      type: "DETAIL_GAP_ATTEMPTED",
      stream: "widgets",
      reference_only: true,
      gap_id: 1 as unknown as string,
      lease_id: "lease-1",
    },
  ];
  assert.throws(() => buildProtocolTrace(malformed), TraceNormalizationError);
});
