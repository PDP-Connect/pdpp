// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { runOptionalStream } from "../../packages/polyfill-connectors/connectors/slack/index.ts";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { RetryExhaustedError } from "../../packages/polyfill-connectors/src/http-retry.ts";
import type { CollectionReportEntry, RuntimeCollectionFact, RuntimeCollectionFactSkip } from "../server/ref-control.ts";
import { buildCollectionReport } from "../server/ref-control.ts";

type ManifestStreamFixture = Parameters<typeof buildCollectionReport>[0]["manifestStreams"][number];

/**
 * Runs the REAL `runOptionalStream` (the connector's own exported failure-
 * isolation wrapper) against a rejecting `run` and returns the
 * `RuntimeCollectionFactSkip` the runtime would actually build from its
 * emitted `SKIP_RESULT` — mirroring `runtime/index.ts`'s own
 * `recovery_hint.action` -> `recovery_action` unwrap (see e.g.
 * `runtime/index.ts:4058`, `server/runtime-collection-facts.ts:109-110`).
 * This closes the exact gap a prior review found: a test asserting only
 * `runOptionalStream`'s emitted `message`/`recovery_hint` fields, never
 * fed through the actual downstream coverage classifier, would not have
 * caught two structurally different failure causes collapsing to the
 * identical classification.
 */
async function skipFromRealRunOptionalStream(rejection: Error): Promise<RuntimeCollectionFactSkip> {
  const messages: EmittedMessage[] = [];
  await runOptionalStream(
    (emitted) => {
      messages.push(emitted);
      return Promise.resolve();
    },
    "stars",
    () => Promise.reject(rejection)
  );
  const [msg] = messages;
  assert.equal(msg?.type, "SKIP_RESULT", "runOptionalStream must emit exactly one SKIP_RESULT on a rejecting run");
  const skip = msg as Extract<EmittedMessage, { type: "SKIP_RESULT" }>;
  const hint = skip.recovery_hint;
  const action = typeof hint === "object" && hint !== null ? hint.action : undefined;
  return {
    reason: skip.reason,
    ...(typeof action === "string" ? { recovery_action: action } : {}),
  };
}

// Slack-specific projection proofs for OpenSpec task 4.2
// (`define-connector-progress-evidence-contract`): the Slack connector declares
// an objective `considered` denominator for `canvases` (its one full-sync,
// non-fingerprinted, no-filter list stream).
//
// These tests feed a realistic Slack `collection_facts` block to the REAL
// exported `buildCollectionReport` projection and assert the derived report:
//   - canvases with collected === considered  -> complete  (the new signal)
//   - canvases with collected  <  considered  -> partial   (honest shortfall)
//   - streams that declare NO considered (messages, workspace, users, …) stay
//     `unknown` / `unmeasured` — never inferred `complete` from collected count
//   - a stream that emits SKIP_RESULT(reason: "not_available") reads
//     `unavailable` coverage -> a `terminal` forward disposition with no extra
//     connector code (the second half of task 4.2, true by construction). As
//     of `complete-slack-bundled-connector-coverage`, Slack no longer has any
//     streams in this state (stars/user_groups/reminders/dm_read_states now
//     collect via direct Slack Web API calls); the mechanism below is
//     projection-generic and exercised with synthetic fixture stream names,
//     not a live Slack manifest assertion.
//
// The runtime half (DETAIL_COVERAGE.considered carried onto the terminal facts
// block without blocking commit) is proven connector-agnostically in
// collection-profile.test.js; the Slack connector emitting the right
// DETAIL_COVERAGE shape is proven in
// connectors/slack/canvases-considered.test.ts.

/** A runtime fact-block entry with honest defaults (no considered, no gaps, no skip). */
function fact(overrides: Partial<RuntimeCollectionFact> = {}): RuntimeCollectionFact {
  return {
    checkpoint: "committed",
    collected: 0,
    considered: null,
    covered: null,
    pending_detail_gaps: 0,
    skipped: null,
    stream: "messages",
    ...overrides,
  };
}

/** Build a report from a Slack-shaped fact block. Defaults: fresh, no
 *  attention, schedulable (the projection inputs the connection-health snapshot
 *  supplies). */
function report(
  facts: readonly RuntimeCollectionFact[],
  overrides: Partial<Parameters<typeof buildCollectionReport>[0]> = {}
): CollectionReportEntry[] {
  return buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: facts },
    freshness: "fresh",
    manifestStreams: [],
    refresh: null,
    ...overrides,
  });
}

function entryFor(entries: readonly CollectionReportEntry[], stream: string): CollectionReportEntry {
  const entry = entries.find((e) => e.stream === stream);
  assert.ok(entry, `expected a Collection Report entry for stream "${stream}"`);
  return entry;
}

test("slack canvases: collected === considered -> complete (the populated signal task 4.2 adds)", () => {
  const entries = report([fact({ collected: 4, considered: 4, stream: "canvases" })]);
  const entry = entryFor(entries, "canvases");
  assert.equal(entry.considered, 4, "the declared denominator is carried, not unknown");
  assert.equal(entry.collected, 4);
  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.forward_disposition, "complete");
});

test("slack canvases: collected < considered -> partial / resumable (honest shortfall, e.g. a dropped canvas)", () => {
  const entries = report([fact({ collected: 3, considered: 4, stream: "canvases" })]);
  const entry = entryFor(entries, "canvases");
  assert.equal(entry.considered, 4);
  assert.equal(entry.coverage_condition, "partial");
  assert.equal(entry.forward_disposition, "resumable");
});

test("slack canvases: an enumerated empty inventory (considered: 0, collected: 0) reads complete", () => {
  const entries = report([fact({ collected: 0, considered: 0, stream: "canvases" })]);
  const entry = entryFor(entries, "canvases");
  assert.equal(entry.considered, 0, "an enumerated empty inventory is a real 0, not unknown");
  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.forward_disposition, "complete");
});

test("slack non-canvas streams declare NO considered -> stay unknown / unmeasured (never inferred complete)", () => {
  // messages / workspace / users / files / channels collect records but declare
  // no `considered` (fingerprint-suppressed or incrementally-windowed streams
  // have no honest denominator). They MUST stay `unknown`, never `complete`.
  const entries = report([
    fact({ collected: 1903, considered: null, stream: "messages" }),
    fact({ collected: 1, considered: null, stream: "workspace" }),
    fact({ collected: 0, considered: null, stream: "users" }),
  ]);
  for (const stream of ["messages", "workspace", "users"]) {
    const entry = entryFor(entries, stream);
    assert.equal(entry.considered, "unknown", `${stream} considered stays unknown when undeclared`);
    assert.equal(entry.coverage_condition, "unknown", `${stream} is never inferred complete`);
    assert.equal(entry.forward_disposition, "unmeasured", `${stream} is unmeasured coverage, not active checking`);
  }
});

test('slack unsupported streams: SKIP_RESULT(reason: "not_available") -> unavailable coverage -> terminal disposition', () => {
  // Projection-generic mechanism proof (synthetic stream names — not a live
  // Slack manifest assertion; see file header). A stream that emits
  // SKIP_RESULT { reason: "not_available" } projects "not_available" ->
  // `unavailable` coverage, and the pure disposition helper maps an
  // `unavailable` coverage with no recovery path -> `terminal`. No extra
  // connector code is needed for the second half of task 4.2 — it holds by
  // construction.
  const unsupported = ["stars", "user_groups", "reminders", "dm_read_states"];
  const entries = report(
    unsupported.map((stream) => fact({ collected: 0, skipped: { reason: "not_available" }, stream }))
  );
  for (const stream of unsupported) {
    const entry = entryFor(entries, stream);
    assert.equal(entry.coverage_condition, "unavailable", `${stream} skip reads unavailable, not complete`);
    assert.equal(entry.forward_disposition, "terminal", `${stream} has no ordinary recovery path -> terminal`);
  }
});

test("slack unsupported-in-mode streams: manifest accepted-absence prevents resting unknown coverage", () => {
  // Projection-generic mechanism proof (synthetic stream names and a
  // synthetic manifest fragment — Slack's real manifest no longer declares
  // any stream this way as of `complete-slack-bundled-connector-coverage`;
  // see file header). A manifest stream declaring coverage_policy=deferred +
  // required=false projects an explicit accepted-absence even when old run
  // facts have no skip, instead of resting `unknown` forever.
  const unsupported = ["stars", "user_groups", "reminders", "dm_read_states"];
  const manifestStreams: ManifestStreamFixture[] = unsupported.map((stream) => ({
    coverage_policy: "deferred",
    coverage_strategy: stream === "stars" || stream === "user_groups" ? "full_inventory" : "checkpoint_window",
    freshness_strategy: "not_trackable",
    name: stream,
    required: false,
  }));
  const entries = report(
    unsupported.map((stream) => fact({ checkpoint: "unknown", collected: 0, considered: null, stream })),
    { manifestStreams }
  );
  for (const stream of unsupported) {
    const entry = entryFor(entries, stream);
    assert.equal(entry.coverage_condition, "deferred", `${stream} is accepted-absent, not unknown`);
    assert.equal(entry.forward_disposition, "complete", `${stream} owes no ordinary collection in slackdump mode`);
  }
});

test("slack co-emitted detail streams: checkpoint_window + committed parent checkpoint -> complete", () => {
  // reactions / message_attachments ride the `messages` cursor and are committed
  // by the parent `messages` STATE. They carry no `considered` denominator, so
  // the ONLY coverage proof is the committed checkpoint under the
  // `checkpoint_window` strategy. A succeeded run whose parent committed must
  // read `complete`, not `unknown`.
  const manifestStreams: ManifestStreamFixture[] = [
    { coverage_strategy: "checkpoint_window", name: "reactions", state_stream: "messages" },
    { coverage_strategy: "checkpoint_window", name: "message_attachments", state_stream: "messages" },
  ];
  const entries = report(
    [
      fact({ checkpoint: "committed", collected: 42, considered: null, stream: "reactions" }),
      fact({ checkpoint: "committed", collected: 7, considered: null, stream: "message_attachments" }),
    ],
    { manifestStreams }
  );
  for (const stream of ["reactions", "message_attachments"]) {
    const entry = entryFor(entries, stream);
    assert.equal(entry.coverage_condition, "complete", `${stream} committed checkpoint proves coverage`);
    assert.equal(entry.forward_disposition, "complete", `${stream} is complete, not unmeasured`);
  }
});

test("slack co-emitted detail streams: historical child not_staged inherits committed parent checkpoint", () => {
  // Live repair: historical terminal fact blocks may have stamped a co-emitted
  // child stream as `not_staged` even though the parent `messages` cursor
  // committed. The manifest state_stream declaration is the durable read-side
  // evidence that lets old reports project the same way current runtime facts do.
  const manifestStreams: ManifestStreamFixture[] = [
    { coverage_strategy: "checkpoint_window", name: "reactions", state_stream: "messages" },
  ];
  const entries = report(
    [
      fact({ checkpoint: "committed", collected: 1903, considered: null, stream: "messages" }),
      fact({ checkpoint: "not_staged", collected: 42, considered: null, stream: "reactions" }),
    ],
    { manifestStreams }
  );
  const entry = entryFor(entries, "reactions");
  assert.equal(entry.checkpoint, "committed", "child stream inherits the parent committed checkpoint");
  assert.equal(entry.coverage_condition, "complete", "parent checkpoint proves child checkpoint_window coverage");
  assert.equal(entry.forward_disposition, "complete");
});

test("slack co-emitted detail streams: child not_staged without parent proof stays unknown", () => {
  const manifestStreams: ManifestStreamFixture[] = [
    { coverage_strategy: "checkpoint_window", name: "reactions", state_stream: "messages" },
  ];
  const entries = report([fact({ checkpoint: "not_staged", collected: 42, considered: null, stream: "reactions" })], {
    manifestStreams,
  });
  const entry = entryFor(entries, "reactions");
  assert.equal(entry.coverage_condition, "unknown", "not_staged alone does not prove checkpoint_window coverage");
  assert.equal(entry.forward_disposition, "unmeasured");
});

test("slack optional-stream auth failure: SKIP_RESULT with no recovery action -> terminal_gap, not a misleading retryable_gap", () => {
  // Regression for a real evidence gap in `runOptionalStream`
  // (connectors/slack/index.ts): before the fix, every optional-stream
  // failure — including a durable `slack_auth_failed` 401 on `stars.list`
  // that will not clear by retrying — reported `recovery_hint.action:
  // "retry_by_runtime"` unconditionally. `mapSkipCoverageCondition`
  // (connector-coverage-policy.ts) checks that action BEFORE any reason
  // text, so the durable failure was misclassified as a transient
  // `retryable_gap`. The fix omits the action for an auth failure, so the
  // real, non-self-healing severity (`terminal_gap`) surfaces instead.
  const entries = report([fact({ collected: 0, skipped: { reason: "optional_stream_failed" }, stream: "stars" })]);
  const entry = entryFor(entries, "stars");
  assert.equal(entry.coverage_condition, "terminal_gap", "a durable auth failure must not read as self-healing");
  assert.notEqual(entry.coverage_condition, "retryable_gap");
});

test("slack optional-stream transient failure: SKIP_RESULT with retry_by_runtime -> retryable_gap (unchanged)", () => {
  const entries = report([
    fact({
      collected: 0,
      skipped: { reason: "optional_stream_failed", recovery_action: "retry_by_runtime" },
      stream: "reminders",
    }),
  ]);
  const entry = entryFor(entries, "reminders");
  assert.equal(entry.coverage_condition, "retryable_gap", "a transient failure still reads as self-healing");
});

test("slack nested exhausted network failure: real connector output projects to retryable_gap", async () => {
  const skip = await skipFromRealRunOptionalStream(
    new RetryExhaustedError("HTTP request failed after retry budget was exhausted", 4, {
      code: "EAI_AGAIN",
      message: "temporary DNS failure",
    })
  );
  assert.equal(skip.recovery_action, "retry_by_runtime");

  const entries = report([fact({ collected: 0, skipped: skip, stream: "reminders" })]);
  assert.equal(
    entryFor(entries, "reminders").coverage_condition,
    "retryable_gap",
    "a nested transient cause must survive the connector and downstream coverage projection"
  );
});

test("slack optional-stream exhausted request without a retry signal -> terminal_gap", async () => {
  const skip = await skipFromRealRunOptionalStream(new Error("HTTP request failed after retry budget was exhausted"));
  assert.equal(skip.recovery_action, undefined, "an exhausted request without a retry signal must not retry forever");

  const entries = report([fact({ collected: 0, skipped: skip, stream: "stars" })]);
  assert.equal(entryFor(entries, "stars").coverage_condition, "terminal_gap");
});

test("slack browser capability wrapped by HTTP retry remains unsupported", async () => {
  const skip = await skipFromRealRunOptionalStream(
    new Error("HTTP request failed after retry budget was exhausted", {
      cause: new Error("slack_api_browser_unavailable: chromium_not_installed"),
    })
  );
  assert.equal(skip.reason, "optional_stream_capability_missing");
  assert.notEqual(skip.recovery_action, "retry_by_runtime");

  const entries = report([fact({ collected: 0, skipped: skip, stream: "stars" })]);
  assert.equal(entryFor(entries, "stars").coverage_condition, "unsupported");
});

// ─── Browser-capability-missing vs. auth-failure: true end-to-end proof ────
//
// Regression for a real gap a prior review found: `acquireSlackApiBrowserTransport`
// failing (this RUNTIME has no browser to acquire — a structural/placement
// fact) and a live Slack API auth rejection (this SESSION was rejected — a
// credential fact) both threw an `Error`, both were caught by the SAME
// `runOptionalStream` catch block, and both produced the identical
// `reason: "optional_stream_failed"` + `recovery_hint: { retryable: false }`
// shape — indistinguishable to `mapSkipCoverageCondition`, and therefore to
// any operator or downstream system reading only `reason`/`recovery_hint`.
// These tests call the REAL exported `runOptionalStream` (not a synthetic
// `skipped:` fixture built by hand) and feed its REAL emitted SKIP_RESULT
// through the REAL `buildCollectionReport` projection, proving the fix holds
// at every hop of the actual pipeline, not just at the connector's own
// SKIP_RESULT shape (which `gap-streams.test.ts` already covers) or the
// classifier in isolation (which `connector-coverage-policy.test.ts` covers).

test("slack browser-capability-missing: real runOptionalStream + real coverage projection reads unsupported, distinct from an auth failure's terminal_gap", async () => {
  const capabilitySkip = await skipFromRealRunOptionalStream(
    new Error("slack_api_browser_unavailable: chromium_not_installed")
  );
  const authSkip = await skipFromRealRunOptionalStream(new Error("slack_auth_failed"));

  // The two real, distinct root causes must not collapse to the same reason
  // string once they reach the runtime fact the coverage layer actually
  // reads — this is the field `mapSkipCoverageCondition` classifies on.
  assert.notEqual(
    capabilitySkip.reason,
    authSkip.reason,
    "a missing browser capability and a rejected session must carry different reasons, not the same optional_stream_failed"
  );

  const entries = report([
    fact({ collected: 0, skipped: capabilitySkip, stream: "stars" }),
    fact({ collected: 0, skipped: authSkip, stream: "user_groups" }),
  ]);
  const capabilityEntry = entryFor(entries, "stars");
  const authEntry = entryFor(entries, "user_groups");

  assert.equal(
    capabilityEntry.coverage_condition,
    "unsupported",
    "a runtime with no browser binding reads as a capability limit, not an unclassified terminal_gap"
  );
  assert.equal(authEntry.coverage_condition, "terminal_gap", "an auth failure keeps its existing classification");
  assert.notEqual(
    capabilityEntry.coverage_condition,
    authEntry.coverage_condition,
    "the two root causes must project to genuinely different coverage conditions"
  );
});

test("slack browser-capability-missing: real runOptionalStream never claims retry_by_runtime for a structural runtime gap", async () => {
  const skip = await skipFromRealRunOptionalStream(new Error("slack_api_browser_setup_failed: context_closed"));
  assert.notEqual(
    skip.recovery_action,
    "retry_by_runtime",
    "retrying on the SAME runtime cannot conjure a browser binding into existence"
  );

  const entries = report([fact({ collected: 0, skipped: skip, stream: "dm_read_states" })]);
  const entry = entryFor(entries, "dm_read_states");
  assert.notEqual(entry.coverage_condition, "retryable_gap", "a missing capability is not a self-healing condition");
});

test("slack mixed report: canvases complete alongside unknown messages and a terminal unsupported stream", () => {
  // The whole-connection shape an owner sees after a clean Slack run: canvases
  // carries a real complete, messages stays honestly unknown, and an
  // unsupported stream is terminal — three distinct, non-contradictory verdicts
  // in one report.
  const entries = report([
    fact({ collected: 2, considered: 2, stream: "canvases" }),
    fact({ collected: 1903, considered: null, stream: "messages" }),
    fact({ collected: 0, skipped: { reason: "not_available" }, stream: "reminders" }),
  ]);
  assert.equal(entryFor(entries, "canvases").coverage_condition, "complete");
  assert.equal(entryFor(entries, "messages").coverage_condition, "unknown");
  assert.equal(entryFor(entries, "reminders").forward_disposition, "terminal");
});
