// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Verified-coverage conformance gate.
 *
 * Contract under test: every successful exercised stream whose manifest
 * declares any `coverage_strategy` from the shared
 * `@pdpp/reference-contract` `CoverageProofStrategy` union
 * (`checkpoint_window`, `full_inventory`, `parent_detail_accounting`,
 * `snapshot_import_receipt`, `singleton_presence`) and is `required`
 * (default true) MUST prove its coverage claim under
 * `@pdpp/reference-contract`'s shared, pure `evaluateStreamCoherence` oracle
 * (packages/reference-contract/src/evidence/coherence.ts) — the SAME
 * function the reference implementation calls at its projection boundary
 * (reference-implementation/server/connector-coverage-policy.ts). This gate
 * derives a run-local evidence envelope from the connector's actual emitted
 * STATE / DETAIL_COVERAGE / SKIP_RESULT / DETAIL_GAP messages and asks that
 * shared oracle whether `proven === true` — it does not re-implement the
 * coherence rule, and it does not accept a bare message presence check as
 * sufficient authority. A `STATE` checkpoint commit alone is not proof: that
 * is the exact invariant `evaluateStreamCoherence` exists to enforce (its
 * `checkpoint_only` verdict), independent of this gate's own logic.
 *
 * This gate does not grep connector source for `emitDetailCoverage` call
 * sites — a call site proves intent, not runtime behavior (it could be
 * unreachable, gated wrong, or emit an empty/malformed message). Instead it
 * runs each connector's REAL collection code (the same exported entrypoint
 * or orchestration function production `collect()` calls — see each
 * driver's comment in coverage-conformance-drivers.ts for the exact
 * production call site it mirrors) against a small, deterministic,
 * credential-free fixture and evaluates the actual emitted protocol
 * messages, the same evidence the runtime and downstream projections
 * consume.
 *
 * Strategy coverage — what proves what, honestly:
 *   - `checkpoint_window` / `full_inventory` (Reddit, Jellyfin, Apple
 *     Contacts, Amazon): the aggregate gate below exercises these end to
 *     end, including the shortfall-adjacent `unresolved_attempt` mutation
 *     (a schema-invalid record must not be laundered into proven coverage —
 *     see the Reddit mutation tests). These two strategies are
 *     window-bounding under the shared oracle (`considered` + a closed
 *     checkpoint proves the boundary; `covered` is not additionally
 *     required to satisfy `considered`) — see coherence.ts's
 *     `strategyBoundsWindowRatherThanCounting`.
 *   - `snapshot_import_receipt` (Google Messages `messages`): also
 *     window-bounding. Driven end to end below, including a genuinely
 *     empty archive (verified-empty) and a real schema-drift SKIP_RESULT
 *     (unresolved_attempt) and a real failed/not-paired run.
 *   - `singleton_presence` (YNAB `account_stats`): also window-bounding.
 *     Driven end to end below via `ynabCollect`'s DI seam, including the
 *     zero-budget absence case.
 *   - `parent_detail_accounting` (GroupMe `attachments`, `required: false`
 *     — see the dedicated capability-pin section): the ONE strategy the
 *     shared oracle excludes from window-bounding, so its numerator must
 *     actually satisfy its denominator. This is the only strategy where
 *     `boundary_shortfall` is reachable, and it is proven here through
 *     GroupMe's real per-attachment hydration accounting (an unconfigured
 *     blob backend leaves `covered < considered`), not a synthetic
 *     envelope. `attachments` is not required, so it cannot appear in the
 *     aggregate required-stream gate/ratchet below — its proof lives
 *     entirely in the capability-pin tests, the same pattern already used
 *     for Amazon's zero-result and Reddit's malformed pins.
 *
 * Honesty contract:
 *   - A stream this gate has no driver for is UNEXERCISED. It is asserted
 *     against the checked-in ratchet (KNOWN_UNEXERCISED_COVERAGE) below —
 *     never silently passed, and never allowed to grow without a reviewable
 *     diff (see the ratchet test).
 *   - A stream this gate exercised, on a successful run, whose derived
 *     evidence envelope does not evaluate to `proven: true` under the
 *     shared oracle is a genuine FAIL — the contract violation this gate
 *     exists to catch.
 *   - A driver itself failing (DONE.status === "failed", or a thrown
 *     exception) is ALSO a genuine FAIL, not an escape hatch — every
 *     registered driver is a deliberately-authored happy-path fixture, so a
 *     failed run means the fixture (or the connector) regressed, and the
 *     gate must say so rather than silently exempting every stream that
 *     driver was supposed to prove.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/collector-runtime";
import {
  type CoverageProofStrategy,
  evaluateStreamCoherence,
  type StreamEvidenceEnvelope,
  type StreamProofDeclaration,
} from "@pdpp/reference-contract/evidence";
import {
  KNOWN_SCAFFOLD_CONNECTORS,
  PRODUCTION_READY_CONNECTORS,
  REAL_UNLISTED_CONNECTORS,
} from "../../src/connector-conformance-roster.ts";
import {
  AMAZON_ZERO_RESULT_DRIVER,
  APPLE_CONTACTS_AUTH_FAILURE_DRIVER,
  CONNECTOR_DRIVERS,
  type ConnectorDriver,
  type DriverResult,
  GOOGLE_MESSAGES_EMPTY_DRIVER,
  GOOGLE_MESSAGES_MALFORMED_DRIVER,
  GOOGLE_MESSAGES_NOT_PAIRED_DRIVER,
  GROUPME_ATTACHMENTS_SHORTFALL_DRIVER,
  GROUPME_ATTACHMENTS_WITHHELD_DRIVER,
  GROUPME_HIGH_VOLUME_DRIVER,
  GROUPME_ZERO_DIRECT_INVENTORY_DRIVER,
  KNOWN_UNEXERCISED_COVERAGE,
  REDDIT_MALFORMED_DRIVER,
  YNAB_ACCOUNT_STATS_TWO_BUDGETS_ONE_MALFORMED_DRIVER,
  YNAB_ACCOUNT_STATS_ZERO_BUDGETS_DRIVER,
} from "./coverage-conformance-drivers.ts";

/**
 * The aggregate gate's mechanical proof that `parent_detail_accounting` was
 * actually exercised this run, with the discriminating verdict the strategy
 * exists to prove. `parent_detail_accounting` is the one strategy the shared
 * oracle excludes from window-bounding (coherence.ts's
 * `strategyBoundsWindowRatherThanCounting`), so its whole reason for being in
 * `ALL_COVERAGE_PROOF_STRATEGIES` is that `boundary_shortfall` must be
 * reachable — a bare `proven: true` would prove nothing distinctive about it.
 * `attachments` is `required: false` in groupme.json, so it cannot flow
 * through `allRequiredStreamPairs()`/`provenSummary` the way the other four
 * strategies do; this function is what stands in its place, called directly
 * from the aggregate gate below (not narratively referenced from a separate
 * `test(...)` block the gate has no mechanical link to — see the red-team
 * finding this replaces).
 */
async function runParentDetailAccountingProbe(): Promise<{ ok: boolean; report: string }> {
  const result = await GROUPME_ATTACHMENTS_SHORTFALL_DRIVER.run();
  if (!result.exercised) {
    return { ok: false, report: `parent_detail_accounting probe (groupme.attachments) unexercised: ${result.reason}` };
  }
  const envelope = deriveStreamEnvelope(result.messages, "attachments", result.skippedRecords);
  const verdict = evaluateStreamCoherence(envelope, { coverage_strategy: "parent_detail_accounting" });
  if (verdict.reason !== "boundary_shortfall" || verdict.proven !== false) {
    return {
      ok: false,
      report: `parent_detail_accounting probe (groupme.attachments) expected proven=false/reason=boundary_shortfall, got proven=${verdict.proven}/reason=${verdict.reason} (envelope: considered=${envelope.considered}, covered=${envelope.covered})`,
    };
  }
  return { ok: true, report: "groupme.attachments: real boundary_shortfall reached (parent_detail_accounting)" };
}

const MANIFESTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "manifests");

/**
 * Every member of the shared `@pdpp/reference-contract` `CoverageProofStrategy`
 * union. TypeScript unions produce no runtime values, so this Set is hand-kept
 * in sync with that type (the same pattern
 * `stream-evidence-strategy-manifest.test.ts`'s `VALID_COVERAGE_STRATEGIES`
 * already uses) — but it is typed AGAINST `CoverageProofStrategy[]`, so a
 * future member added to or removed from the shared union that this array
 * does not mirror is a compile error here, not silent drift. A required
 * stream declaring ANY of these owes strategy-specific positive evidence
 * under the shared oracle — not just full_inventory/checkpoint_window.
 */
const ALL_COVERAGE_PROOF_STRATEGIES: readonly CoverageProofStrategy[] = [
  "checkpoint_window",
  "full_inventory",
  "parent_detail_accounting",
  "snapshot_import_receipt",
  "singleton_presence",
];
const PROOF_REQUIRED_STRATEGIES: ReadonlySet<string> = new Set(ALL_COVERAGE_PROOF_STRATEGIES);

interface ManifestStream {
  coverage_policy?: unknown;
  coverage_strategy?: unknown;
  name?: unknown;
  required?: unknown;
}

interface ConnectorManifest {
  streams?: ManifestStream[];
}

function readManifest(connectorKey: string): ConnectorManifest | null {
  const manifestPath = join(MANIFESTS_DIR, `${connectorKey}.json`);
  if (!existsSync(manifestPath)) {
    return null;
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ConnectorManifest;
}

/** Required (default true) streams declaring a proof-demanding strategy. */
function proofRequiredStreams(manifest: ConnectorManifest): string[] {
  return (manifest.streams ?? [])
    .filter((s) => s.required !== false && PROOF_REQUIRED_STRATEGIES.has(String(s.coverage_strategy)))
    .map((s) => String(s.name));
}

const ACCEPTED_ABSENCE_POLICIES = new Set(["deferred", "inventory_only", "unavailable", "unsupported"]);

/** The shared oracle's proof declaration for one manifest stream. */
function proofDeclarationFor(manifest: ConnectorManifest, stream: string): StreamProofDeclaration {
  const entry = (manifest.streams ?? []).find((s) => s.name === stream);
  const policy = typeof entry?.coverage_policy === "string" ? entry.coverage_policy : null;
  const acceptedAbsence: StreamProofDeclaration["accepted_absence"] =
    policy !== null && ACCEPTED_ABSENCE_POLICIES.has(policy)
      ? (policy as NonNullable<StreamProofDeclaration["accepted_absence"]>)
      : null;
  return {
    accepted_absence: acceptedAbsence,
    coverage_strategy: (entry?.coverage_strategy as StreamProofDeclaration["coverage_strategy"]) ?? null,
  };
}

function allTargetConnectorKeys(): string[] {
  const rosterKeys = new Set([...Object.keys(PRODUCTION_READY_CONNECTORS), ...Object.keys(REAL_UNLISTED_CONNECTORS)]);
  for (const scaffold of KNOWN_SCAFFOLD_CONNECTORS) {
    rosterKeys.delete(scaffold);
  }
  return [...rosterKeys].sort((a, b) => a.localeCompare(b));
}

/** Full inventory: every (connector, proof-required stream) pair across the roster. */
function allRequiredStreamPairs(): Array<{ connectorKey: string; stream: string }> {
  const pairs: Array<{ connectorKey: string; stream: string }> = [];
  for (const connectorKey of allTargetConnectorKeys()) {
    const manifest = readManifest(connectorKey);
    if (!manifest) {
      continue;
    }
    for (const stream of proofRequiredStreams(manifest)) {
      pairs.push({ connectorKey, stream });
    }
  }
  return pairs;
}

function doneMessage(messages: readonly EmittedMessage[]): Extract<EmittedMessage, { type: "DONE" }> | undefined {
  return messages.find(
    (m): m is Extract<EmittedMessage, { type: "DONE" }> => (m as { type?: unknown }).type === "DONE"
  );
}

/**
 * Derive the run-local `StreamEvidenceEnvelope` for one stream from the raw
 * protocol messages a driver captured — STATE (checkpoint + collected count,
 * via RECORD tally), DETAIL_COVERAGE (considered/covered), SKIP_RESULT
 * (skipped), and DETAIL_GAP with status "pending" (pending_detail_gaps) —
 * PLUS `skippedRecords`, the direct-import-harness counterpart of
 * SKIP_RESULT (see `SkippedRecordFact` in coverage-conformance-drivers.ts):
 * a driver that calls a connector's exported function directly via
 * `runDirectImportDriver`/`makeRecordingEmit` never gets a real SKIP_RESULT
 * protocol message for a validation failure — that failure lands in the
 * harness's own `.skipped` bookkeeping instead. Without folding
 * `skippedRecords` in here, a stream whose every considered record failed
 * schema validation would still read `checkpoint: "committed"` with no
 * `skipped` evidence, and the shared oracle would have nothing telling it
 * the attempt was unresolved — exactly the gap a genuinely broken Reddit
 * fixture exposed (considered=1, covered=0, yet the aggregate gate passed,
 * because the validation failure only ever reached `harness.skipped`, never
 * `messages`). This is the one piece of run-local aggregation this gate
 * owns; everything downstream of the envelope is the shared oracle's
 * judgement, not this gate's.
 *
 * `checkpoint` is stamped `"committed"` when a STATE message was emitted for
 * this stream this run (the connector advanced/held its cursor), else
 * `null` — mirroring the RI's own checkpoint semantics
 * (reference-implementation/server/runtime-collection-facts.ts): a raw
 * cursor value, not further classified, since none of this gate's fixtures
 * ever produce a "pending"/"disabled" checkpoint shape.
 */
function deriveStreamEnvelope(
  messages: readonly EmittedMessage[],
  stream: string,
  skippedRecords: readonly { stream: string }[] = []
): StreamEvidenceEnvelope {
  const stateForStream = messages.some(
    (m) => (m as { type?: unknown; stream?: unknown }).type === "STATE" && (m as { stream?: unknown }).stream === stream
  );
  const collected = messages.filter(
    (m) =>
      (m as { type?: unknown; stream?: unknown }).type === "RECORD" && (m as { stream?: unknown }).stream === stream
  ).length;
  const coverageMsgs = messages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      (m as { type?: unknown }).type === "DETAIL_COVERAGE" && (m as { stream?: unknown }).stream === stream
  );
  const protocolSkip = messages.find(
    (m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
      (m as { type?: unknown }).type === "SKIP_RESULT" && (m as { stream?: unknown }).stream === stream
  );
  const harnessSkip = skippedRecords.find((s) => s.stream === stream);
  const pendingGaps = messages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
      (m as { type?: unknown }).type === "DETAIL_GAP" &&
      (m as { stream?: unknown }).stream === stream &&
      (m as { status?: unknown }).status === "pending"
  ).length;

  // A stream may emit more than one DETAIL_COVERAGE across a run (e.g. a
  // per-budget loop); sum considered/covered when every emission carries a
  // measured value, otherwise fall through to "no measurement" (null) rather
  // than silently dropping a partial sum.
  let considered: number | null = null;
  let covered: number | null = null;
  if (coverageMsgs.length > 0) {
    const consideredValues = coverageMsgs.map((m) => (m as { considered?: unknown }).considered);
    const coveredValues = coverageMsgs.map((m) => (m as { covered?: unknown }).covered);
    if (consideredValues.every((v) => typeof v === "number")) {
      considered = consideredValues.reduce((a, b) => a + b, 0);
    }
    if (coveredValues.every((v) => typeof v === "number")) {
      covered = coveredValues.reduce((a, b) => a + b, 0);
    }
  }

  let skipped: StreamEvidenceEnvelope["skipped"] = null;
  if (protocolSkip) {
    skipped = { reason: protocolSkip.reason };
  } else if (harnessSkip) {
    skipped = { reason: "schema_validation_failed" };
  }

  return {
    checkpoint: stateForStream ? "committed" : null,
    collected,
    considered,
    covered,
    pending_detail_gaps: pendingGaps,
    skipped,
  };
}

/** Run a driver and evaluate one of its streams under the shared oracle in
 *  one call — the common shape every capability-pin test below needs.
 *  Throws (failing the test with a clear message) if the driver reports
 *  itself unexercised, since every capability-pin driver is a deliberately-
 *  authored happy/mutation-path fixture that must always run. */
async function runAndEvaluate(
  driver: ConnectorDriver | undefined,
  stream: string,
  manifestKey: string
): Promise<{
  envelope: StreamEvidenceEnvelope;
  result: DriverResult;
  verdict: ReturnType<typeof evaluateStreamCoherence>;
}> {
  assert.ok(driver, `no driver registered for ${manifestKey}.${stream}`);
  const result = await driver.run();
  if (!result.exercised) {
    throw new Error(`driver for ${manifestKey}.${stream} reported unexercised: ${result.reason}`);
  }
  const manifest = readManifest(manifestKey);
  assert.ok(manifest, `manifest missing for ${manifestKey}`);
  const envelope = deriveStreamEnvelope(result.messages, stream, result.skippedRecords);
  const verdict = evaluateStreamCoherence(envelope, proofDeclarationFor(manifest, stream));
  return { envelope, result, verdict };
}

// ─── The gate: run every registered driver once, evaluate every connector ──

test("verified-coverage conformance: every exercised required stream proves coverage under the shared @pdpp/reference-contract oracle", async () => {
  const driverEntries = Object.entries(CONNECTOR_DRIVERS);
  const results = await Promise.all(
    driverEntries.map(async ([connectorKey, driver]) => {
      try {
        return { connectorKey, result: await driver.run() };
      } catch (error) {
        return {
          connectorKey,
          result: { exercised: true, messages: [] } as DriverResult,
          thrown: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );
  const driverResults = new Map(results.map((r) => [r.connectorKey, r]));

  const failures: string[] = [];
  const unexercisedSummary: string[] = [];
  const provenSummary: string[] = [];

  for (const { connectorKey, stream } of allRequiredStreamPairs()) {
    const label = `${connectorKey}.${stream}`;
    const driverEntry = CONNECTOR_DRIVERS[connectorKey];
    const covers = driverEntry?.coveredStreams.includes(stream) ?? false;

    if (!covers) {
      unexercisedSummary.push(label);
      continue;
    }

    const entry = driverResults.get(connectorKey);
    if (entry && "thrown" in entry) {
      failures.push(`${label}: driver threw (${entry.thrown}) — a registered happy-path fixture must not throw`);
      continue;
    }
    const driverResult = entry?.result;
    if (!driverResult?.exercised) {
      failures.push(`${label}: driver reported unexercised (${driverResult?.reason ?? "no reason given"})`);
      continue;
    }

    const done = doneMessage(driverResult.messages);
    if (done?.status === "failed") {
      failures.push(
        `${label}: driver's DONE reported status=failed — a registered happy-path fixture must succeed, not silently exempt this stream`
      );
      continue;
    }

    const manifest = readManifest(connectorKey);
    if (!manifest) {
      failures.push(`${label}: manifest missing — cannot derive a proof declaration`);
      continue;
    }
    const envelope = deriveStreamEnvelope(driverResult.messages, stream, driverResult.skippedRecords);
    const declaration = proofDeclarationFor(manifest, stream);
    const verdict = evaluateStreamCoherence(envelope, declaration);

    if (!verdict.proven) {
      failures.push(
        `${label}: shared oracle reports proven=false, reason=${verdict.reason} (envelope: checkpoint=${JSON.stringify(envelope.checkpoint)}, collected=${envelope.collected}, considered=${envelope.considered}, covered=${envelope.covered})`
      );
      continue;
    }

    provenSummary.push(label);
  }

  const provenLine = `${provenSummary.length} stream(s) proven: ${provenSummary.join(", ")}`;
  const unexercisedLine = `${unexercisedSummary.length} stream(s) unexercised (checked against the ratchet, not asserted here): ${unexercisedSummary.join(", ")}`;

  assert.deepEqual(
    failures,
    [],
    `verified-coverage contract violated for ${failures.length} exercised stream(s):\n${failures.map((f) => `  - ${f}`).join("\n")}\n${provenLine}\n${unexercisedLine}`
  );
  assert.ok(
    provenSummary.length > 0,
    `expected at least one stream to be proven this run — the gate is not exercising anything.\n${unexercisedLine}`
  );

  // Every one of the 5 shared CoverageProofStrategy variants must be
  // mechanically exercised somewhere in THIS gate run — the four
  // window-bounding strategies via a proven required stream in
  // provenSummary above, and parent_detail_accounting via a direct call to
  // the real GroupMe probe (it is excluded from window-bounding by design,
  // and its own manifest stream is required:false so it cannot appear in
  // provenSummary itself — see runParentDetailAccountingProbe's doc comment).
  // This gate CALLS the probe directly rather than trusting a narratively
  // adjacent `test(...)` block to have run: deleting or breaking that
  // separate capability-pin test can no longer leave this assertion green.
  const provenStrategies = new Set<CoverageProofStrategy>();
  for (const label of provenSummary) {
    const [connectorKey, stream] = label.split(".", 2) as [string, string];
    const manifest = readManifest(connectorKey);
    const strategy = manifest ? proofDeclarationFor(manifest, stream).coverage_strategy : null;
    if (strategy) {
      provenStrategies.add(strategy);
    }
  }

  const parentDetailProbe = await runParentDetailAccountingProbe();
  assert.ok(parentDetailProbe.ok, parentDetailProbe.report);

  for (const strategy of ALL_COVERAGE_PROOF_STRATEGIES) {
    if (strategy === "parent_detail_accounting") {
      // Verified above via the direct probe call, not window-bounding
      // proof — a bare `provenStrategies.has(...)` check would be the wrong
      // question for the one strategy where `boundary_shortfall`, not
      // `proven: true`, IS the expected/discriminating outcome.
      continue;
    }
    assert.ok(
      provenStrategies.has(strategy),
      `expected at least one proven stream for strategy ${strategy} in this run's required-stream loop — proven strategies: ${[...provenStrategies].join(", ")}`
    );
  }
});

// ─── Ratchet: unexercised coverage cannot silently grow ────────────────────

test("ratchet: every unexercised required stream is a deliberate, checked-in entry — no silent new gaps, no stale entries", () => {
  const actuallyUnexercised = new Set<string>();
  for (const { connectorKey, stream } of allRequiredStreamPairs()) {
    const driverEntry = CONNECTOR_DRIVERS[connectorKey];
    const covers = driverEntry?.coveredStreams.includes(stream) ?? false;
    if (!covers) {
      actuallyUnexercised.add(`${connectorKey}.${stream}`);
    }
  }

  const newUnlistedGaps = [...actuallyUnexercised]
    .filter((label) => !KNOWN_UNEXERCISED_COVERAGE.has(label))
    .sort((a, b) => a.localeCompare(b));
  const staleListedEntries = [...KNOWN_UNEXERCISED_COVERAGE]
    .filter((label) => !actuallyUnexercised.has(label))
    .sort((a, b) => a.localeCompare(b));

  assert.deepEqual(
    newUnlistedGaps,
    [],
    `${newUnlistedGaps.length} required stream(s) are unexercised without a checked-in reason — a new production-ready/real-unlisted connector or manifest edit bypassed this gate silently. Add a deliberate entry to KNOWN_UNEXERCISED_COVERAGE in coverage-conformance-drivers.ts naming why, or register a driver: ${newUnlistedGaps.join(", ")}`
  );
  assert.deepEqual(
    staleListedEntries,
    [],
    `${staleListedEntries.length} entries in KNOWN_UNEXERCISED_COVERAGE no longer correspond to an actually-unexercised required stream (a driver now covers them, or the manifest no longer requires them) — remove the stale entry so the allowlist reflects reality: ${staleListedEntries.join(", ")}`
  );
});

// ─── Capability pins: permanent claims about what each driver proves ──────
//
// Unlike a "known gap" pin (which asserts today's broken state and would
// itself start failing the moment a connector lane lands its fix), these
// assert properties that stay true regardless of the current pass/fail
// state of any one connector: the driver mechanism itself reaches the real
// production code path and the shared oracle can express both a nonzero and
// a genuinely empty (considered=covered=0) proven verdict from it. They
// exist to prove the gate is not vacuous — if these ever fail, the DRIVERS
// or the ENVELOPE DERIVATION are broken, independent of whether any one
// connector currently passes the aggregate gate above.

test("capability: Amazon's real emitOrdersCoverage path proves under the shared oracle for a nonzero 'orders' run", async () => {
  const { envelope, verdict } = await runAndEvaluate(CONNECTOR_DRIVERS.amazon, "orders", "amazon");
  assert.deepEqual(verdict, { proven: true, reason: "enumeration_boundary" });
  assert.equal(envelope.considered, 1);
  assert.equal(envelope.covered, 1);
});

test("capability: Amazon's real emitOrdersCoverage path proves verified emptiness under the shared oracle when the boundary is genuinely empty", async () => {
  const { envelope, verdict } = await runAndEvaluate(AMAZON_ZERO_RESULT_DRIVER, "orders", "amazon");
  assert.deepEqual(verdict, { proven: true, reason: "enumeration_boundary" });
  assert.equal(envelope.considered, 0);
  assert.equal(envelope.covered, 0);
});

test("capability: Reddit's real collectAllStreams path proves under the shared oracle for all six required checkpoint_window streams with a schema-valid fixture", async () => {
  const driver = CONNECTOR_DRIVERS.reddit;
  assert.ok(driver);
  const result = await driver.run();
  if (!result.exercised) {
    assert.fail(`reddit driver reported unexercised: ${result.reason}`);
  }
  const manifest = readManifest("reddit");
  assert.ok(manifest);
  for (const stream of ["submitted", "comments", "saved", "upvoted", "downvoted", "hidden"]) {
    const envelope = deriveStreamEnvelope(result.messages, stream, result.skippedRecords);
    // The happy-path fixture must be schema-valid end to end: considered ===
    // covered === 1 proves every considered record was ALSO accounted for,
    // not merely that a considered count was reported (which the earlier,
    // schema-invalid `t3_coverage_conformance` fixture also produced while
    // silently reporting covered=0 — a gap the oracle-fidelity fix below
    // closes).
    assert.equal(envelope.considered, 1, `${stream}: considered`);
    assert.equal(envelope.covered, 1, `${stream}: covered — a schema-invalid fixture record would read 0 here`);
    assert.deepEqual(envelope.skipped, null, `${stream}: no validation-rejected record expected`);
    const verdict = evaluateStreamCoherence(envelope, proofDeclarationFor(manifest, stream));
    assert.equal(verdict.proven, true, `${stream}: expected proven, got ${verdict.reason}`);
  }
});

test("mutation: a schema-invalid Reddit record is not laundered into proven coverage — proves skippedRecords fidelity, not just message presence", async () => {
  const manifest = readManifest("reddit");
  assert.ok(manifest);
  const result = await REDDIT_MALFORMED_DRIVER.run();
  if (!result.exercised) {
    assert.fail(`reddit malformed driver reported unexercised: ${result.reason}`);
  }
  for (const stream of ["submitted", "comments", "saved", "upvoted", "downvoted", "hidden"]) {
    const envelope = deriveStreamEnvelope(result.messages, stream, result.skippedRecords);
    // The malformed fixture considers exactly one record per stream, and
    // that record fails schema validation — proving the harness actually
    // saw the failure (considered=1) rather than silently dropping it
    // (which would read considered=null, a different and less informative
    // failure mode).
    assert.equal(envelope.considered, 1, `${stream}: considered (the record was weighed)`);
    assert.equal(envelope.covered, 0, `${stream}: covered (the record was rejected, not accounted for)`);
    assert.ok(envelope.skipped, `${stream}: skippedRecords must surface as envelope.skipped`);
    const verdict = evaluateStreamCoherence(envelope, proofDeclarationFor(manifest, stream));
    assert.equal(
      verdict.proven,
      false,
      `${stream}: a validation-rejected record must not read proven (got reason=${verdict.reason})`
    );
    assert.equal(
      verdict.reason,
      "unresolved_attempt",
      `${stream}: the shared oracle's rule 1 (unresolved attempt) must fire before the checkpoint/considered rules ever get a chance to launder this`
    );
  }
});

test("mutation: without skippedRecords fidelity, the malformed Reddit fixture no longer falsely reads proven — the explicit-covered-numerator fix (coherence.ts) independently closes this, on top of the skippedRecords fidelity fix", async () => {
  // Re-derive the envelope EXACTLY as the pre-skippedRecords-fix
  // deriveStreamEnvelope did — ignoring skippedRecords entirely. Before the
  // reference-contract oracle fix (the explicit-covered-count rule), this
  // read PROVEN via `enumeration_boundary`'s "closed window bounds rather
  // than counts" branch, because a window-bounding strategy's `covered`
  // shortfall was ignored once the checkpoint closed — the exact false pass
  // the skippedRecords fidelity change closed for THIS gate. The oracle fix
  // now rejects the identical envelope on its own terms: Reddit's malformed
  // fixture emits an explicit `covered: 0` against `considered: 1` (never
  // absent), so rule 2's covered-numerator check catches it even with
  // `skipped: null` — two independent defenses against the same shape of
  // bug, not a redundant assertion (skippedRecords fidelity still matters
  // for streams that don't emit an explicit covered count at all).
  const result = await REDDIT_MALFORMED_DRIVER.run();
  if (!result.exercised) {
    assert.fail(`reddit malformed driver reported unexercised: ${result.reason}`);
  }
  const manifest = readManifest("reddit");
  assert.ok(manifest);
  const envelopeWithoutSkipFidelity = deriveStreamEnvelope(result.messages, "submitted", []);
  assert.deepEqual(
    envelopeWithoutSkipFidelity.skipped,
    null,
    "confirms the pre-fix code path: with skippedRecords withheld, the envelope reports no skip at all"
  );
  assert.equal(envelopeWithoutSkipFidelity.considered, 1);
  assert.equal(envelopeWithoutSkipFidelity.covered, 0, "the malformed record was never credited");
  const verdictWithoutSkipFidelity = evaluateStreamCoherence(
    envelopeWithoutSkipFidelity,
    proofDeclarationFor(manifest, "submitted")
  );
  assert.equal(
    verdictWithoutSkipFidelity.proven,
    false,
    "the explicit covered:0 < considered:1 numerator check now catches this independently of skip fidelity"
  );
  assert.equal(verdictWithoutSkipFidelity.reason, "boundary_shortfall");
});

test("capability: Apple Contacts' real subprocess entrypoint proves under the shared oracle for all three required full_inventory streams", async () => {
  const driver = CONNECTOR_DRIVERS.apple_contacts;
  assert.ok(driver);
  const result = await driver.run();
  if (!result.exercised) {
    assert.fail(`apple_contacts driver reported unexercised: ${result.reason}`);
  }
  const manifest = readManifest("apple_contacts");
  assert.ok(manifest);
  for (const stream of ["address_books", "contacts", "contact_groups"]) {
    const envelope = deriveStreamEnvelope(result.messages, stream);
    const verdict = evaluateStreamCoherence(envelope, proofDeclarationFor(manifest, stream));
    assert.equal(verdict.proven, true, `${stream}: expected proven, got ${verdict.reason}`);
  }
});

// ─── snapshot_import_receipt: Google Messages `messages` ───────────────────

test("capability: Google Messages' real subprocess entrypoint proves under the shared oracle for a nonzero snapshot_import_receipt run", async () => {
  const { envelope, verdict } = await runAndEvaluate(CONNECTOR_DRIVERS.google_messages, "messages", "google_messages");
  assert.equal(verdict.proven, true, `expected proven, got ${verdict.reason}`);
  assert.equal(envelope.considered, 2);
  assert.equal(envelope.covered, 2);
});

test("capability: Google Messages' real subprocess entrypoint proves verified emptiness for a genuinely empty archive", async () => {
  const { envelope, verdict } = await runAndEvaluate(GOOGLE_MESSAGES_EMPTY_DRIVER, "messages", "google_messages");
  assert.equal(verdict.proven, true, `expected proven, got ${verdict.reason}`);
  assert.equal(envelope.considered, 0);
  assert.equal(envelope.covered, 0);
});

test("mutation: gmcli schema drift on messages produces a real SKIP_RESULT, not laundered into proven coverage", async () => {
  const { envelope, result, verdict } = await runAndEvaluate(
    GOOGLE_MESSAGES_MALFORMED_DRIVER,
    "messages",
    "google_messages"
  );
  const skip = result.exercised
    ? result.messages.find(
        (m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
          m.type === "SKIP_RESULT" && m.stream === "messages"
      )
    : undefined;
  assert.ok(skip, "expected a real production SKIP_RESULT for messages, not a synthetic envelope");
  assert.deepEqual(envelope.skipped, { reason: skip?.reason });
  assert.equal(verdict.proven, false, `a schema-drift SKIP_RESULT must not read proven (got reason=${verdict.reason})`);
  assert.equal(verdict.reason, "unresolved_attempt");
});

test("mutation: gmcli not-paired failure produces a real SKIP_RESULT for messages, not laundered into proven coverage", async () => {
  // Unlike the schema-drift mutation above, this connector treats an
  // unpaired device as a soft, user-actionable skip: DONE still reports
  // "succeeded" (verified against connectors/google_messages/
  // integration.test.ts's own "not paired" test) — proving the gate reads
  // the real SKIP_RESULT itself as what withholds proof, not the run's
  // overall success/failure.
  const { envelope, result, verdict } = await runAndEvaluate(
    GOOGLE_MESSAGES_NOT_PAIRED_DRIVER,
    "messages",
    "google_messages"
  );
  const done = result.exercised ? doneMessage(result.messages) : undefined;
  assert.equal(done?.status, "succeeded", "sanity: this connector treats not-paired as a soft skip, not a run failure");
  const skip = result.exercised
    ? result.messages.find(
        (m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
          m.type === "SKIP_RESULT" && m.stream === "messages"
      )
    : undefined;
  assert.equal(skip?.reason, "gmcli_not_paired");
  assert.deepEqual(envelope.skipped, { reason: "gmcli_not_paired" });
  assert.equal(verdict.proven, false, `a not-paired SKIP_RESULT must not read proven (got reason=${verdict.reason})`);
  assert.equal(verdict.reason, "unresolved_attempt");
});

test("mutation: a driver's genuinely failed DONE (Apple Contacts, rejected credentials) fails every stream it was meant to prove, not silently exempted", async () => {
  const result = await APPLE_CONTACTS_AUTH_FAILURE_DRIVER.run();
  if (!result.exercised) {
    assert.fail(`apple_contacts auth-failure driver reported unexercised: ${result.reason}`);
  }
  const done = doneMessage(result.messages);
  assert.equal(done?.status, "failed", "a rejected-credential run's real DONE must report failed");
  assert.equal(done?.error?.code, "auth_failed");
  // The aggregate gate's own failed-DONE check (see the main test above)
  // is what actually turns this into a hard failure for
  // address_books/contacts/contact_groups; this pin exists so that check
  // has a permanent, real-production counterexample to run against,
  // independent of whether Apple Contacts' happy-path fixture currently
  // passes.
});

// ─── singleton_presence: YNAB `account_stats` ──────────────────────────────

test("capability: YNAB's real ynabCollect path (via its DI request seam) proves under the shared oracle for a nonzero singleton_presence run", async () => {
  const { envelope, verdict } = await runAndEvaluate(CONNECTOR_DRIVERS.ynab, "account_stats", "ynab");
  assert.equal(verdict.proven, true, `expected proven, got ${verdict.reason}`);
  assert.equal(envelope.considered, 1);
  assert.equal(envelope.covered, 1);
});

test("mutation: a zero-budget YNAB run emits no account_stats coverage — absence of evidence must not be laundered into proven", async () => {
  const { result, verdict } = await runAndEvaluate(YNAB_ACCOUNT_STATS_ZERO_BUDGETS_DRIVER, "account_stats", "ynab");
  if (result.exercised) {
    const coverage = result.messages.find(
      (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
        m.type === "DETAIL_COVERAGE" && m.stream === "account_stats"
    );
    assert.equal(coverage, undefined, "no budgets ran, so no account_stats coverage should be fabricated");
  }
  assert.equal(verdict.proven, false, `zero budgets must not read proven (got reason=${verdict.reason})`);
});

test("mutation: a real two-budget YNAB run with one malformed account leaves account_stats covered < considered — the shared oracle must reject it, not launder it via the closed checkpoint window", async () => {
  const { envelope, verdict } = await runAndEvaluate(
    YNAB_ACCOUNT_STATS_TWO_BUDGETS_ONE_MALFORMED_DRIVER,
    "account_stats",
    "ynab"
  );
  // Drives production's real collectAccountsAndStats loop end to end; this
  // is not a synthetic envelope or a hardcoded fixture count — considered=2
  // and covered=1 fall out of validateRecord actually rejecting budget B's
  // malformed account_stats record.
  assert.equal(envelope.considered, 2, "both budgets' accounts were enumerated");
  assert.equal(envelope.covered, 1, "only budget A's account was validly accounted for");
  assert.equal(
    verdict.proven,
    false,
    `an explicit covered shortfall must fail even though singleton_presence is window-bounding and the checkpoint closed (got proven=true, reason=${verdict.reason})`
  );
  // `trackAndEmit` still attempts the malformed record, so the real runtime's
  // skip bookkeeping fires (rule 1, unresolved_attempt) before rule 2's
  // considered/covered comparison ever runs — a schema-invalid row is a
  // strictly stronger signal than a bare shortfall, and rule 1 correctly
  // outranks rule 2 (see coherence.ts's precedence doc). This still proves
  // the exact claim this test exists for: covered=1 < considered=2 is NEVER
  // laundered into `proven: true` through the real production loop, for
  // either reason. The explicit-covered-numerator rule itself (a shortfall
  // with NO skip in play) is proven directly by
  // packages/reference-contract/test/evidence-coherence.test.ts's
  // "an explicit covered shortfall on a closed window..." cases.
  assert.equal(verdict.reason, "unresolved_attempt");
});

test("capability: the ynab ratchet correctly names every remaining real required stream (account_stats is now driven; the rest stay undriven by design)", () => {
  const manifest = readManifest("ynab");
  assert.ok(manifest);
  const requiredStreams = proofRequiredStreams(manifest);
  assert.ok(
    requiredStreams.length > 0,
    "ynab must declare required proof-demanding streams for this pin to be meaningful"
  );
  assert.equal("ynab" in CONNECTOR_DRIVERS, true, "ynab.account_stats is now driven via ynabCollect's DI seam");
  for (const stream of requiredStreams) {
    if (CONNECTOR_DRIVERS.ynab?.coveredStreams.includes(stream)) {
      continue;
    }
    assert.ok(
      KNOWN_UNEXERCISED_COVERAGE.has(`ynab.${stream}`),
      `ynab.${stream} is required but missing from KNOWN_UNEXERCISED_COVERAGE`
    );
  }
});

// ─── GroupMe required streams: terminal evidence capability pins ───────────
//
// These pins use the same real collect() path as the aggregate driver. They
// are deliberately about the terminal evidence shape, not merely record
// counts: a clean empty inventory must carry explicit 0/0 coverage, and a
// multi-page walk must report the complete enumerated boundary even when the
// fingerprint cursor emits fewer (or no) records.

test("capability: GroupMe's four required streams are registered in the connector-neutral coverage gate", () => {
  assert.deepEqual(
    CONNECTOR_DRIVERS.groupme?.coveredStreams,
    ["groups", "group_messages", "direct_messages", "direct_chat_messages"],
    "the gate must exercise every GroupMe stream whose manifest requires proof"
  );
});

test("capability: GroupMe's empty direct inventory emits measured 0/0 proof for both direct streams", async () => {
  const result = await GROUPME_ZERO_DIRECT_INVENTORY_DRIVER.run();
  if (!result.exercised) {
    assert.fail(`groupme zero-direct driver reported unexercised: ${result.reason}`);
  }
  const manifest = readManifest("groupme");
  assert.ok(manifest, "GroupMe manifest must exist for the coverage oracle");

  for (const stream of ["direct_messages", "direct_chat_messages"]) {
    const envelope = deriveStreamEnvelope(result.messages, stream, result.skippedRecords);
    const verdict = evaluateStreamCoherence(envelope, proofDeclarationFor(manifest, stream));
    assert.equal(envelope.collected, 0, `${stream} has no inventory, so it emits no records`);
    assert.equal(envelope.considered, 0, `${stream} must report an observed empty boundary, not null`);
    assert.equal(envelope.covered, 0, `${stream} must preserve the explicit empty numerator`);
    assert.equal(verdict.proven, true, `${stream} has a clean, measured empty boundary`);
    assert.equal(verdict.reason, "enumeration_boundary");
  }

  for (const stream of ["groups", "group_messages"]) {
    const envelope = deriveStreamEnvelope(result.messages, stream, result.skippedRecords);
    const verdict = evaluateStreamCoherence(envelope, proofDeclarationFor(manifest, stream));
    assert.equal(envelope.considered, 1, `${stream} observed the non-empty group side of the fixture`);
    assert.equal(envelope.covered, 1);
    assert.equal(verdict.proven, true, `${stream} proves in the same non-degenerate run`);
  }
});

test("capability: GroupMe's high-volume group walk folds every page and group into terminal coverage", async () => {
  const { envelope, verdict } = await runAndEvaluate(GROUPME_HIGH_VOLUME_DRIVER, "group_messages", "groupme");
  const expectedMessages = 205 * 2;

  assert.equal(
    envelope.considered,
    expectedMessages,
    "terminal considered must include all pages from both groups, not only the first page"
  );
  assert.equal(
    envelope.covered,
    expectedMessages,
    "terminal covered must preserve the full measured group-message boundary"
  );
  assert.equal(verdict.proven, true);
  assert.equal(verdict.reason, "enumeration_boundary");
});

// ─── parent_detail_accounting: GroupMe `attachments` (required: false) ────
//
// The one strategy the shared oracle excludes from window-bounding
// (coherence.ts's strategyBoundsWindowRatherThanCounting deliberately omits
// it): its numerator must actually satisfy its denominator, so
// `boundary_shortfall` is reachable ONLY through this strategy. `attachments`
// is `required: false` in groupme.json, so it cannot appear in
// allRequiredStreamPairs()/the aggregate gate/ratchet above — these pins are
// its entire proof surface, mirroring how AMAZON_ZERO_RESULT_DRIVER and
// REDDIT_MALFORMED_DRIVER already prove claims outside the required-stream
// loop.

test("capability: GroupMe's real collect() path reaches a genuine boundary_shortfall for parent_detail_accounting when a blob backend is unconfigured", async () => {
  const { envelope, verdict } = await runAndEvaluate(GROUPME_ATTACHMENTS_SHORTFALL_DRIVER, "attachments", "groupme");
  assert.equal(envelope.considered, 1, "the one attachment was considered");
  assert.equal(envelope.covered, 0, "no blob backend configured — hydration_status stays 'deferred', never covered");
  assert.equal(
    verdict.proven,
    false,
    `an uncovered attachment must not read proven under parent_detail_accounting (got reason=${verdict.reason})`
  );
  assert.equal(
    verdict.reason,
    "boundary_shortfall",
    "parent_detail_accounting is excluded from window-bounding — covered < considered must surface as a real shortfall, not enumeration_boundary"
  );
});

test("mutation: GroupMe withholds only the failed attachment parent while preserving the successful sibling's report", async () => {
  const result = await GROUPME_ATTACHMENTS_WITHHELD_DRIVER.run();
  if (!result.exercised) {
    assert.fail(`groupme withheld driver reported unexercised: ${result.reason}`);
  }
  const coverage = result.messages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      m.type === "DETAIL_COVERAGE" && m.stream === "attachments"
  );
  assert.equal(coverage.length, 1, "the failed group_messages parent must emit no coverage report");
  assert.equal(coverage[0]?.state_stream, "direct_chat_messages");
  assert.equal(coverage[0]?.considered, 1);
  assert.equal(coverage[0]?.covered, 0, "the successful parent still reports its real unconfigured-backend shortfall");
});

test("capability: groupme.attachments is required:false and therefore absent from the aggregate required-stream gate/ratchet by construction", () => {
  const manifest = readManifest("groupme");
  assert.ok(manifest);
  const requiredStreams = proofRequiredStreams(manifest);
  assert.ok(
    !requiredStreams.includes("attachments"),
    "attachments must stay required:false in the manifest for this pin's premise to hold — its proof lives in the capability pins above, not the required-stream loop"
  );
  assert.ok(
    !KNOWN_UNEXERCISED_COVERAGE.has("groupme.attachments"),
    "attachments is not a required stream, so it must not appear in the required-stream ratchet either"
  );
});
