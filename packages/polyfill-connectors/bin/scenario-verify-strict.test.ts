// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the expert-review repair lane (FIX 1-5 in this repo's task
 * split):
 *   - FIX 1 (src/scenario/validate.ts): pure unit tests for every named
 *     rejection `validateScenario` throws — no subprocess, fast.
 *   - FIX 2 (bin/scenario-verify.ts's subprocess driving): subprocess-level
 *     tests for (b) a non-JSON stdout line, (c) more than one DONE / a
 *     message after DONE, (d) subprocess nonzero exit despite a succeeded
 *     DONE — each against a small misbehaving stub connector fixture under
 *     src/test-fixtures/.
 *   - FIX 3 (identity/digest binding): unit tests for
 *     `computeDeclarationDigest`/`computeSourceDigest`, plus a CLI-level
 *     connector-id mismatch test.
 *   - FIX 4 (coverage exactness): `full_refresh` is only claimed when run 0
 *     truly proves a from-scratch collection.
 *   - FIX 5 (compound-key collision): `messagesToRecordsAndState`'s
 *     JSON.stringify-based key encoding does not collide the way a
 *     fixed-separator join could.
 *
 * Also (repair wave 3A, third independent review, P1-1): pure unit tests for
 * `src/scenario/claims.ts`'s `evaluateClaimEligibility` — the centralized
 * claim-eligibility evaluator `bin/scenario-verify.ts` consults before
 * printing `recorded_replay: PASS`. See that section below for the full
 * rationale; kept here (rather than in bin/scenario-cli.test.ts) because it
 * is pure/no-subprocess, matching this file's existing "fast, no subprocess"
 * sections (FIX 1, FIX 3's digest helpers, FIX 5).
 *
 * bin/scenario-cli.test.ts (owned by a different lane, currently being
 * rewritten) is NOT run or imported from here.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashCanonicalJson } from "@pdpp/collector-runtime";
import { buildBrowserStalenessLimitation, evaluateClaimEligibility } from "../src/scenario/claims.ts";
import type { ConnectorScenario, ScenarioRun } from "../src/scenario/format.ts";
import { isNamespaceIsolationAvailable } from "../src/scenario/isolation.ts";
import { messagesToRecordsAndState, type ProtocolMessage } from "../src/scenario/subprocess-fetch-preloads.ts";
import {
  computeDeclarationDigest,
  computeSourceDigest,
  ScenarioValidationError,
  validateScenario,
} from "../src/scenario/validate.ts";
import { driverEvidenceSatisfied } from "../src/scenario/wire-registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const VERIFY_CLI_PATH = join(PACKAGE_ROOT, "bin", "scenario-verify.ts");
const FIXTURES_DIR = join(PACKAGE_ROOT, "src", "test-fixtures");

function runVerifyCli(args: readonly string[]): { code: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", VERIFY_CLI_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ─── FIX 1: validateScenario — pure, no subprocess ─────────────────────────

function baseValidScenario(): ConnectorScenario {
  return {
    format: "pdpp.connector-scenario/1",
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
        interactions: [
          {
            seq: 1,
            request: { method: "GET", origin: "https://toy.example", path: "/widgets", query: [] },
            response: { status: 200, body: { id: "w1" } },
          },
        ],
        expected: {
          records: {
            widgets: { count: 1, ids: ["w1"], ops: ["upsert"], record_sha256s: [hashCanonicalJson({ id: "w1" })] },
          },
          final_state: {},
        },
      },
    ],
  };
}

function assertRejects(scenario: ConnectorScenario, expectedReason: string): void {
  assert.throws(
    () => validateScenario(scenario),
    (err: unknown) => {
      assert.ok(err instanceof ScenarioValidationError, `expected ScenarioValidationError, got ${String(err)}`);
      assert.equal(err.reason, expectedReason);
      return true;
    }
  );
}

test("validateScenario: happy path — a well-formed scenario passes", () => {
  assert.doesNotThrow(() => validateScenario(baseValidScenario()));
});

test("validateScenario: rejects format !== pdpp.connector-scenario/1", () => {
  const scenario = baseValidScenario();
  // @ts-expect-error deliberately wrong format for the test
  scenario.format = "pdpp.connector-scenario/0";
  assertRejects(scenario, "unsupported_format");
});

test("validateScenario: rejects capture.complete !== true", () => {
  const scenario = baseValidScenario();
  scenario.capture.complete = false;
  assertRejects(scenario, "capture_incomplete");
});

test("validateScenario: rejects missing connector.id", () => {
  const scenario = baseValidScenario();
  scenario.connector.id = "";
  assertRejects(scenario, "missing_connector_id");
});

test("validateScenario: rejects runs.length === 0", () => {
  const scenario = baseValidScenario();
  scenario.runs = [];
  assertRejects(scenario, "no_runs");
});

test("validateScenario: rejects state_from_run self-reference", () => {
  const scenario = baseValidScenario();
  scenario.runs.push(structuredCloneRun(scenario.runs[0] as ScenarioRun));
  const run1 = scenario.runs[1] as ScenarioRun;
  run1.start.state_from_run = 1;
  assertRejects(scenario, "state_from_run_self_reference");
});

test("validateScenario: rejects state_from_run forward reference", () => {
  const scenario = baseValidScenario();
  scenario.runs.push(structuredCloneRun(scenario.runs[0] as ScenarioRun));
  const run0 = scenario.runs[0] as ScenarioRun;
  run0.start.state_from_run = 1;
  assertRejects(scenario, "state_from_run_forward_reference");
});

test("validateScenario: rejects state_from_run out-of-range", () => {
  // -1 is neither a self-reference (run index 0) nor a forward reference
  // (it's not > 0), so it isolates the out-of-range check specifically.
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  run0.start.state_from_run = -1;
  assertRejects(scenario, "state_from_run_out_of_range");
});

test("validateScenario: rejects duplicate interaction seq within a run", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const [firstInteraction] = run0.interactions;
  assert.ok(firstInteraction);
  run0.interactions.push({ ...firstInteraction, seq: 1 });
  assertRejects(scenario, "duplicate_seq");
});

test("validateScenario: rejects nonpositive interaction seq", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const [firstInteraction] = run0.interactions;
  assert.ok(firstInteraction);
  firstInteraction.seq = 0;
  assertRejects(scenario, "nonpositive_seq");
});

test("validateScenario: rejects duplicate user_interactions seq", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  run0.user_interactions = [
    { seq: 1, prompt: { kind: "otp", message: "code?" }, response: { status: "success", value: "123456" } },
    { seq: 1, prompt: { kind: "otp", message: "code again?" }, response: { status: "success", value: "654321" } },
  ];
  assertRejects(scenario, "duplicate_seq");
});

test("validateScenario: rejects nonpositive user_interactions seq", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  run0.user_interactions = [
    { seq: -1, prompt: { kind: "otp", message: "code?" }, response: { status: "success", value: "123456" } },
  ];
  assertRejects(scenario, "nonpositive_seq");
});

test("validateScenario: rejects a request missing method", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const [firstInteraction] = run0.interactions;
  assert.ok(firstInteraction);
  firstInteraction.request.method = "";
  assertRejects(scenario, "malformed_request");
});

test("validateScenario: rejects a request missing origin", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const [firstInteraction] = run0.interactions;
  assert.ok(firstInteraction);
  // @ts-expect-error deliberately malformed for the test
  firstInteraction.request.origin = undefined;
  assertRejects(scenario, "malformed_request");
});

test("validateScenario: rejects a request missing path", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const [firstInteraction] = run0.interactions;
  assert.ok(firstInteraction);
  // @ts-expect-error deliberately malformed for the test
  firstInteraction.request.path = undefined;
  assertRejects(scenario, "malformed_request");
});

test("validateScenario: rejects a request whose query is not an array of pairs", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const [firstInteraction] = run0.interactions;
  assert.ok(firstInteraction);
  // @ts-expect-error deliberately malformed for the test
  firstInteraction.request.query = { page: "1" };
  assertRejects(scenario, "malformed_request");
});

test("validateScenario: rejects a response missing status", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const [firstInteraction] = run0.interactions;
  assert.ok(firstInteraction);
  // @ts-expect-error deliberately malformed for the test
  firstInteraction.response.status = undefined;
  assertRejects(scenario, "malformed_response");
});

test("validateScenario: rejects ids.length !== count", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const { widgets } = run0.expected.records;
  assert.ok(widgets);
  widgets.count = 2;
  assertRejects(scenario, "expectation_length_mismatch");
});

test("validateScenario: rejects ids.length !== record_sha256s.length", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const { widgets } = run0.expected.records;
  assert.ok(widgets);
  widgets.record_sha256s = [];
  assertRejects(scenario, "expectation_length_mismatch");
});

// ─── P1 (eighth review): ops is MANDATORY — validateScenario negative controls ──

test("validateScenario: aligned ops passes (baseValidScenario already carries ops:['upsert'])", () => {
  assert.doesNotThrow(() => validateScenario(baseValidScenario()));
});

test("validateScenario: rejects a stream expectation missing ops entirely", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const { widgets } = run0.expected.records;
  assert.ok(widgets);
  // biome-ignore lint/performance/noDelete: deliberately simulating a scenario file that never carries the (now mandatory) field, not a hot path.
  delete (widgets as { ops?: unknown }).ops;
  assertRejects(scenario, "missing_ops");
});

test("validateScenario: rejects one stream missing ops in a multi-stream run (the other stream's ops stay valid)", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  run0.expected.records.gadgets = {
    count: 1,
    ids: ["g1"],
    ops: ["upsert"],
    record_sha256s: [hashCanonicalJson({ id: "g1" })],
  };
  const { widgets } = run0.expected.records;
  assert.ok(widgets);
  // biome-ignore lint/performance/noDelete: same simulated-missing-field case as the single-stream test above.
  delete (widgets as { ops?: unknown }).ops;
  assertRejects(scenario, "missing_ops");
});

test("validateScenario: rejects ops.length misaligned with ids.length", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const { widgets } = run0.expected.records;
  assert.ok(widgets);
  widgets.ops = ["upsert", "upsert"];
  assertRejects(scenario, "ops_length_mismatch");
});

test("validateScenario: rejects an op literal outside 'upsert'|'delete'", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  const { widgets } = run0.expected.records;
  assert.ok(widgets);
  widgets.ops = ["archive" as unknown as "upsert"];
  assertRejects(scenario, "invalid_op_literal");
});

function structuredCloneRun(run: ScenarioRun): ScenarioRun {
  return JSON.parse(JSON.stringify(run)) as ScenarioRun;
}

// ─── recorded-browser driver: validateScenario shape checks ───────────────

function browserDriverRun(overrides: {
  har_entry_count?: unknown;
  har_path?: unknown;
  storage_state_path?: unknown;
}): ScenarioRun {
  return {
    environment: {
      network: {
        driver: "recorded-browser",
        har_path: "run-0.har",
        storage_state_path: "run-0.storage-state.json",
        har_entry_count: 3,
        ...overrides,
      } as never,
    },
    start: { scope: { streams: [{ name: "widgets" }] }, state: null },
    interactions: [],
    expected: { records: {}, final_state: {} },
  };
}

test("validateScenario: a well-formed recorded-browser run passes", () => {
  const scenario = baseValidScenario();
  scenario.runs[0] = { ...(scenario.runs[0] as ScenarioRun), ...browserDriverRun({}) };
  assert.doesNotThrow(() => validateScenario(scenario));
});

test("validateScenario: rejects a recorded-browser run with empty har_path", () => {
  const scenario = baseValidScenario();
  scenario.runs[0] = { ...(scenario.runs[0] as ScenarioRun), ...browserDriverRun({ har_path: "" }) };
  assertRejects(scenario, "malformed_browser_environment");
});

test("validateScenario: rejects a recorded-browser run missing har_path", () => {
  const scenario = baseValidScenario();
  scenario.runs[0] = { ...(scenario.runs[0] as ScenarioRun), ...browserDriverRun({ har_path: undefined }) };
  assertRejects(scenario, "malformed_browser_environment");
});

test("validateScenario: rejects a recorded-browser run with empty storage_state_path", () => {
  const scenario = baseValidScenario();
  scenario.runs[0] = { ...(scenario.runs[0] as ScenarioRun), ...browserDriverRun({ storage_state_path: "" }) };
  assertRejects(scenario, "malformed_browser_environment");
});

test("validateScenario: rejects a recorded-browser run with a non-integer har_entry_count", () => {
  const scenario = baseValidScenario();
  scenario.runs[0] = { ...(scenario.runs[0] as ScenarioRun), ...browserDriverRun({ har_entry_count: 1.5 }) };
  assertRejects(scenario, "malformed_browser_environment");
});

test("validateScenario: rejects a recorded-browser run with a negative har_entry_count", () => {
  const scenario = baseValidScenario();
  scenario.runs[0] = { ...(scenario.runs[0] as ScenarioRun), ...browserDriverRun({ har_entry_count: -1 }) };
  assertRejects(scenario, "malformed_browser_environment");
});

test("validateScenario: a recorded-browser run with har_entry_count: 0 passes shape validation (vacuousness is a claims-layer concern, not a validate.ts rejection)", () => {
  const scenario = baseValidScenario();
  scenario.runs[0] = { ...(scenario.runs[0] as ScenarioRun), ...browserDriverRun({ har_entry_count: 0 }) };
  assert.doesNotThrow(() => validateScenario(scenario));
});

test("validateScenario: a recorded-http run is unaffected by the new recorded-browser shape check (regression control)", () => {
  const scenario = baseValidScenario();
  const run0 = scenario.runs[0] as ScenarioRun;
  run0.environment = { network: { driver: "recorded-http" } };
  assert.doesNotThrow(() => validateScenario(scenario));
});

// ─── FIX 3: digest helpers — pure, filesystem-based ────────────────────────

test("computeDeclarationDigest: sha256 of the exact manifest bytes, sensitive to any byte change", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-verify-digest-test-"));
  try {
    const manifestPath = join(tmpDir, "toy.json");
    writeFileSync(manifestPath, JSON.stringify({ connector_key: "toy" }));
    const digestA = computeDeclarationDigest(manifestPath);
    const digestB = computeDeclarationDigest(manifestPath);
    assert.equal(digestA, digestB, "digest must be deterministic for unchanged bytes");
    assert.match(digestA, /^[0-9a-f]{64}$/);

    writeFileSync(manifestPath, JSON.stringify({ connector_key: "toy", extra: true }));
    const digestC = computeDeclarationDigest(manifestPath);
    assert.notEqual(digestC, digestA, "a byte-level manifest change must change the digest");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("computeSourceDigest: sha256 over sorted relative paths + per-file content, excluding .test.ts and fixtures dirs", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-verify-source-digest-test-"));
  try {
    const connectorDir = join(tmpDir, "toy");
    mkdirSync(connectorDir, { recursive: true });
    writeFileSync(join(connectorDir, "index.ts"), "export const x = 1;\n");
    writeFileSync(join(connectorDir, "index.test.ts"), "// excluded\n");
    mkdirSync(join(connectorDir, "__fixtures__"), { recursive: true });
    writeFileSync(join(connectorDir, "__fixtures__", "sample.json"), "{}");

    const baseline = computeSourceDigest(connectorDir);
    assert.match(baseline, /^[0-9a-f]{64}$/);

    // Editing the excluded test file must NOT change the digest.
    writeFileSync(join(connectorDir, "index.test.ts"), "// edited, still excluded\n");
    assert.equal(computeSourceDigest(connectorDir), baseline, "editing a .test.ts file must not affect source_digest");

    // Editing the excluded fixtures file must NOT change the digest either.
    writeFileSync(join(connectorDir, "__fixtures__", "sample.json"), '{"edited":true}');
    assert.equal(computeSourceDigest(connectorDir), baseline, "editing a fixtures/ file must not affect source_digest");

    // Editing an INCLUDED source file MUST change the digest — this is the
    // actual drift signal source_digest exists to catch.
    writeFileSync(join(connectorDir, "index.ts"), "export const x = 2;\n");
    assert.notEqual(
      computeSourceDigest(connectorDir),
      baseline,
      "editing a real source file must change source_digest (this is 'source drift since capture')"
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── FIX 3: CLI-level connector-id mismatch (fails before any subprocess) ──

test("scenario-verify CLI: connector arg not matching scenario.connector.id fails before spawning anything", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-verify-identity-test-"));
  try {
    const scenarioPath = join(tmpDir, "scenario.json");
    const scenario = baseValidScenario();
    scenario.connector.id = "actual-connector";
    writeFileSync(scenarioPath, JSON.stringify(scenario));

    // The --entrypoint target doesn't need to exist / be runnable: the
    // identity check must fail BEFORE any attempt to resolve or spawn it.
    const result = runVerifyCli([
      "different-connector-arg",
      "--entrypoint",
      join(FIXTURES_DIR, "scenario-verify-garbage-stdout-line.ts"),
      scenarioPath,
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /does not match scenario\.connector\.id/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── FIX 2: subprocess-level strictness (b, c, d) ──────────────────────────

function nonVacuousSingleRunScenario(connectorId: string, expectedRecordId: string): ConnectorScenario {
  return {
    format: "pdpp.connector-scenario/1",
    connector: { id: connectorId },
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
        interactions: [],
        expected: {
          records: {
            widgets: {
              count: 1,
              ids: [expectedRecordId],
              ops: ["upsert"],
              record_sha256s: ["irrelevant-never-reached"],
            },
          },
          final_state: {},
        },
      },
    ],
  };
}

function writeScenarioFixture(tmpDir: string, connectorId: string): string {
  const scenarioPath = join(tmpDir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(nonVacuousSingleRunScenario(connectorId, "w1")));
  return scenarioPath;
}

test("scenario-verify subprocess strictness (b): a non-JSON stdout line fails the run instead of being silently discarded", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-verify-garbage-line-test-"));
  try {
    const scenarioPath = writeScenarioFixture(tmpDir, "garbage-stdout-connector");
    const result = runVerifyCli([
      "garbage-stdout-connector",
      "--entrypoint",
      join(FIXTURES_DIR, "scenario-verify-garbage-stdout-line.ts"),
      scenarioPath,
    ]);

    assert.notEqual(result.code, 0, "a non-JSON stdout line must fail verification, not pass silently");
    assert.match(result.stdout, /run 0: FAIL/);
    assert.match(result.stdout, /non-JSON stdout line/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Repair wave 6 (P2-2 duty 1) — verify side: a well-formed JSON object whose
// `type` is not one of `wire-registry.ts`'s `KNOWN_MESSAGE_TYPES` fails the
// run, distinct from (b)'s non-JSON-line case above — this line parses fine,
// only its `type` is unrecognized.
test("scenario-verify subprocess strictness: an unrecognized message type fails the run (well-formed JSON, unknown type)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-verify-unknown-type-test-"));
  try {
    const scenarioPath = writeScenarioFixture(tmpDir, "unknown-type-connector");
    const result = runVerifyCli([
      "unknown-type-connector",
      "--entrypoint",
      join(FIXTURES_DIR, "scenario-verify-unknown-message-type.ts"),
      scenarioPath,
    ]);

    assert.notEqual(result.code, 0, "an unrecognized message type must fail verification, not pass silently");
    assert.match(result.stdout, /run 0: FAIL/);
    assert.match(result.stdout, /unrecognized type/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("scenario-verify subprocess strictness (c): a message emitted after DONE fails the run", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-verify-after-done-test-"));
  try {
    const scenarioPath = writeScenarioFixture(tmpDir, "message-after-done-connector");
    const result = runVerifyCli([
      "message-after-done-connector",
      "--entrypoint",
      join(FIXTURES_DIR, "scenario-verify-message-after-done.ts"),
      scenarioPath,
    ]);

    assert.notEqual(result.code, 0, "a message after DONE must fail verification");
    assert.match(result.stdout, /run 0: FAIL/);
    assert.match(result.stdout, /after DONE/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("scenario-verify subprocess strictness (c): more than one DONE fails the run", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-verify-dup-done-test-"));
  try {
    const scenarioPath = writeScenarioFixture(tmpDir, "duplicate-done-connector");
    const result = runVerifyCli([
      "duplicate-done-connector",
      "--entrypoint",
      join(FIXTURES_DIR, "scenario-verify-duplicate-done.ts"),
      scenarioPath,
    ]);

    assert.notEqual(result.code, 0, "more than one DONE must fail verification");
    assert.match(result.stdout, /run 0: FAIL/);
    assert.match(result.stdout, /after DONE/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("scenario-verify subprocess strictness (d): subprocess nonzero exit fails the run even when DONE said succeeded", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-verify-crash-after-done-test-"));
  try {
    const scenarioPath = writeScenarioFixture(tmpDir, "succeeds-then-crashes-connector");
    const result = runVerifyCli([
      "succeeds-then-crashes-connector",
      "--entrypoint",
      join(FIXTURES_DIR, "scenario-verify-succeeds-then-crashes.ts"),
      scenarioPath,
    ]);

    assert.notEqual(result.code, 0, "a nonzero subprocess exit must fail verification despite a succeeded DONE");
    assert.match(result.stdout, /run 0: FAIL/);
    assert.match(result.stdout, /nonzero code/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── FIX 4: coverage exactness ──────────────────────────────────────────────

test("scenario-verify CLI: full_refresh is claimed for a real from-scratch run (null seed, >=1 interaction proxy via expected record, >=1 expected record)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-verify-coverage-test-"));
  try {
    const scenarioPath = join(tmpDir, "scenario.json");
    const recordHash = hashCanonicalJson({ id: "w1", name: "Widget w1" });
    const scenario: ConnectorScenario = {
      format: "pdpp.connector-scenario/1",
      connector: { id: "hardcoded-record-connector" },
      capture: {
        captured_at: "2026-08-01T00:00:00.000Z",
        evidence_class: "synthetic-spike",
        privacy_class: "local-only",
        recorder_version: "test",
        complete: true,
      },
      runs: [
        {
          // One real HTTP interaction (the fixture connector makes exactly
          // one fetch call) AND >=1 expected record — the two conditions
          // FIX 4's fullRefreshProven requires alongside a null seed state.
          start: { scope: { streams: [{ name: "widgets" }] }, state: null },
          interactions: [
            {
              seq: 1,
              request: { method: "GET", origin: "https://toy.example", path: "/widgets", query: [] },
              response: { status: 200, content_type: "application/json", body: { id: "w1", name: "Widget w1" } },
            },
          ],
          expected: {
            records: { widgets: { count: 1, ids: ["w1"], ops: ["upsert"], record_sha256s: [recordHash] } },
            final_state: { widgets: { last_id: "w1" } },
          },
        },
      ],
    };
    writeFileSync(scenarioPath, JSON.stringify(scenario));

    const result = runVerifyCli([
      "hardcoded-record-connector",
      "--entrypoint",
      join(FIXTURES_DIR, "scenario-verify-hardcoded-record-connector.ts"),
      scenarioPath,
    ]);

    assert.equal(result.code, 0, `expected PASS; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stdout, /coverage: empty_state_run/);
    // The "streams exercised" informational line only prints when verifying
    // a real registered connector (it reads manifests/<id>.json) — this
    // test drives a --entrypoint fixture with no manifest, so that line is
    // correctly absent here; see bin/scenario-cli.test.ts's registered-
    // connector coverage instead for the manifest-comparison path (owned by
    // another lane).
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("scenario-verify CLI: full_refresh is NOT claimed when run 0 expects zero records (interactions happened but nothing was proven collected)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-verify-coverage-vacuous-records-test-"));
  try {
    const scenarioPath = join(tmpDir, "scenario.json");
    const scenario: ConnectorScenario = {
      format: "pdpp.connector-scenario/1",
      connector: { id: "no-records-connector" },
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
          interactions: [
            {
              seq: 1,
              request: { method: "GET", origin: "https://toy.example", path: "/widgets", query: [] },
              response: { status: 200, body: { ok: true } },
            },
          ],
          expected: {
            // Zero expected records — the run happened but proved nothing
            // was actually collected, so full_refresh must not be claimed.
            records: {},
            final_state: {},
          },
        },
      ],
    };
    writeFileSync(scenarioPath, JSON.stringify(scenario));

    // A connector that makes exactly the recorded request but emits no
    // records at all reuses the garbage-stdout fixture's sibling shape —
    // simplest is to point at a fixture that never touches fetch and simply
    // completes with zero records; scenario-verify-hardcoded-record-connector
    // always emits one record, so that fixture is not suitable here. Use a
    // minimal DONE-only stub instead (no records, no fetch).
    const result = runVerifyCli([
      "no-records-connector",
      "--entrypoint",
      join(FIXTURES_DIR, "scenario-verify-no-records-connector.ts"),
      scenarioPath,
    ]);

    assert.equal(result.code, 0, `expected PASS; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.doesNotMatch(result.stdout, /coverage: empty_state_run(,|\n)/);
    assert.match(result.stdout, /coverage: \(none\)/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── FIX 5: compound-key collision regression ──────────────────────────────

test("messagesToRecordsAndState: compound keys use JSON.stringify encoding, so distinct arrays never collide", () => {
  const messagesAb: ProtocolMessage[] = [
    { type: "RECORD", stream: "items", key: ["ab", "c"], data: { v: 1 }, emitted_at: "2026-01-01T00:00:00.000Z" },
  ];
  const messagesBc: ProtocolMessage[] = [
    { type: "RECORD", stream: "items", key: ["a", "bc"], data: { v: 2 }, emitted_at: "2026-01-01T00:00:00.000Z" },
  ];

  const { records: recordsAb } = messagesToRecordsAndState(messagesAb);
  const { records: recordsBc } = messagesToRecordsAndState(messagesBc);

  assert.equal(recordsAb.length, 1);
  assert.equal(recordsBc.length, 1);
  assert.notEqual(
    recordsAb[0]?.id,
    recordsBc[0]?.id,
    '["ab","c"] and ["a","bc"] must canonicalize to different ids — a fixed-separator join could collide these'
  );
  assert.equal(recordsAb[0]?.id, JSON.stringify(["ab", "c"]));
  assert.equal(recordsBc[0]?.id, JSON.stringify(["a", "bc"]));
});

test("messagesToRecordsAndState: a plain string key is preserved as-is", () => {
  const messages: ProtocolMessage[] = [
    { type: "RECORD", stream: "items", key: "plain-string-id", data: {}, emitted_at: "2026-01-01T00:00:00.000Z" },
  ];
  const { records } = messagesToRecordsAndState(messages);
  assert.equal(records[0]?.id, "plain-string-id");
});

// P1-1 (seventh review): `assertValidRecordMessage` (wire-registry.ts) now
// validates `key`'s shape at the wire boundary BEFORE
// `messagesToRecordsAndState` reaches `canonicalRecordKey` at all, so an
// unsupported key shape is now rejected as a `MalformedRecordMessageError`
// naming the exact wire-boundary violation, rather than the previous
// deeper-layer "unsupported key shape" throw from `canonicalRecordKey`
// itself. Same invariant (a malformed key must never be silently dropped),
// caught one layer earlier with a more specific, named error.
test("messagesToRecordsAndState: an unsupported key shape throws rather than dropping the record silently", () => {
  const messages: ProtocolMessage[] = [
    { type: "RECORD", stream: "items", key: 12_345, data: {}, emitted_at: "2026-01-01T00:00:00.000Z" },
  ];
  assert.throws(() => messagesToRecordsAndState(messages), /malformed RECORD message at the wire boundary.*key/);
});

// ─── P1-1 (repair wave 3A, third independent review; declaration-binding
// split repair wave 4): centralized claim-eligibility evaluator ───────────
//
// `bin/scenario-verify.ts` used to print `recorded_replay: PASS` the moment
// every per-run comparison passed. That conflated "the replay matched what
// was recorded" (verifyScenario's job) with "this replay's provenance and
// isolation actually back the stronger claim" — eight independent conditions
// (src/scenario/claims.ts's module doc: (a) registered connector, (b1)
// captured-time declaration digest present, (b2) captured-time source
// digest present, (c1) current declaration digest computed, (c2) current
// source digest computed, (d) every run declares environment.network.driver,
// (e) every run has expected.protocol_trace, (f) namespace isolation active,
// (g) no run observed an unsupported evidence surface/ASSISTANCE), any one
// of which failing means recorded_replay overclaims. `evaluateClaimEligibility`
// is the single place that now decides this — tested here directly and
// purely (no subprocess), one test per limitation condition, plus the
// all-conditions-met case and the six negative-control scenarios the repair
// task calls out by name (source-only historical, declaration-only, missing
// current manifest, missing current connector source, legacy top-level
// digests only, complete modern captured_with).

/** Builds a scenario meeting EVERY `evaluateClaimEligibility` condition
 *  except (a)/(b)/(c)/(f), which the caller supplies directly as function
 *  arguments (they aren't read off the scenario at all). `includeEnvironment`/
 *  `includeProtocolTrace` control whether run 0 carries the fields
 *  conditions (d)/(e) check — omitted via a conditional spread rather than
 *  `delete`/`= undefined`, since this package's `exactOptionalPropertyTypes`
 *  forbids assigning `undefined` to an optional field that's typed to
 *  exclude it explicitly. */
function eligibleScenario(
  options: { includeEnvironment?: boolean; includeProtocolTrace?: boolean } = {}
): ConnectorScenario {
  const includeEnvironment = options.includeEnvironment ?? true;
  const includeProtocolTrace = options.includeProtocolTrace ?? true;
  return {
    format: "pdpp.connector-scenario/1",
    connector: { id: "toy", captured_with: { declaration_digest: "a".repeat(64), source_digest: "b".repeat(64) } },
    capture: {
      captured_at: "2026-08-01T00:00:00.000Z",
      evidence_class: "non_loopback_contact_observed",
      privacy_class: "local-only",
      recorder_version: "test",
      complete: true,
    },
    runs: [
      {
        ...(includeEnvironment ? { environment: { network: { driver: "recorded-http" as const } } } : {}),
        start: { scope: { streams: [{ name: "widgets" }] }, state: null },
        interactions: [
          {
            seq: 1,
            request: { method: "GET", origin: "https://toy.example", path: "/widgets", query: [] },
            response: { status: 200, body: { id: "w1" } },
          },
        ],
        expected: {
          records: {
            widgets: { count: 1, ids: ["w1"], ops: ["upsert"], record_sha256s: [hashCanonicalJson({ id: "w1" })] },
          },
          final_state: {},
          ...(includeProtocolTrace
            ? { protocol_trace: [{ kind: "done" as const, status: "succeeded" as const, records_emitted: 1 }] }
            : {}),
        },
      },
    ],
  };
}

/** Every `evaluateClaimEligibility` digest/withholding observation, all
 *  eligible — the caller overrides individual fields per test. Repair wave 6
 *  (P1-1): `driverEvidenceSatisfied: true` here matches `eligibleScenario()`
 *  always carrying >=1 recorded interaction (run 0's `widgets` GET) — see
 *  the P1-1 test block below for the condition's own dedicated tests. */
function eligibleDigestObservations(): {
  capturedDeclarationDigestPresent: boolean;
  capturedSourceDigestPresent: boolean;
  currentDeclarationDigestComputed: boolean;
  currentSourceDigestComputed: boolean;
  observedUnsupportedEvidenceSurface: boolean;
  driverEvidenceSatisfied: boolean;
  isolationEvidenceBoundaryProven: boolean;
  preexistingSocketsUnderReadOnlyBinds: readonly string[];
  preexistingSocketScanIncomplete: boolean;
  preexistingSocketScanUnreadablePaths: readonly string[];
} {
  return {
    capturedDeclarationDigestPresent: true,
    capturedSourceDigestPresent: true,
    currentDeclarationDigestComputed: true,
    currentSourceDigestComputed: true,
    observedUnsupportedEvidenceSurface: false,
    driverEvidenceSatisfied: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketScanIncomplete: false,
    preexistingSocketScanUnreadablePaths: [],
    preexistingSocketsUnderReadOnlyBinds: [],
  };
}

test("evaluateClaimEligibility: every condition met — claim: recorded_replay, no limitations", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
  });
  assert.deepEqual(decision, { claim: "recorded_replay" });
});

test("evaluateClaimEligibility: condition (a) fails — --entrypoint override yields 'unbound entrypoint replay'", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: true,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["unbound entrypoint replay"]);
});

test("evaluateClaimEligibility: condition (b1) fails — no capture-time declaration digest", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    capturedDeclarationDigestPresent: false,
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["no capture-time declaration digest"]);
});

test("evaluateClaimEligibility: condition (b2) fails — no capture-time source digest", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    capturedSourceDigestPresent: false,
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["no capture-time source digest"]);
});

test("evaluateClaimEligibility: condition (c1) fails — current manifest missing, declaration digest not computed", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    currentDeclarationDigestComputed: false,
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["current manifest missing - declaration digest not computed"]);
});

test("evaluateClaimEligibility: condition (c2) fails — current connector source missing, source digest not computed", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    currentSourceDigestComputed: false,
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["current connector source missing - source digest not computed"]);
});

// ─── Named negative controls (repair wave 4 task list) ────────────────────

test("evaluateClaimEligibility negative control: source-only historical scenario (declaration digest never captured) withholds on the declaration half only", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    capturedDeclarationDigestPresent: false,
    capturedSourceDigestPresent: true,
    currentDeclarationDigestComputed: true,
    currentSourceDigestComputed: true,
    observedUnsupportedEvidenceSurface: false,
    driverEvidenceSatisfied: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketsUnderReadOnlyBinds: [],
    preexistingSocketScanIncomplete: false,
    preexistingSocketScanUnreadablePaths: [],
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["no capture-time declaration digest"]);
});

test("evaluateClaimEligibility negative control: declaration-only scenario (source digest never captured) withholds on the source half only", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    capturedDeclarationDigestPresent: true,
    capturedSourceDigestPresent: false,
    currentDeclarationDigestComputed: true,
    currentSourceDigestComputed: true,
    observedUnsupportedEvidenceSurface: false,
    driverEvidenceSatisfied: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketsUnderReadOnlyBinds: [],
    preexistingSocketScanIncomplete: false,
    preexistingSocketScanUnreadablePaths: [],
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["no capture-time source digest"]);
});

test("evaluateClaimEligibility negative control: missing current manifest (declaration side uncomputable) withholds on the declaration half only", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    capturedDeclarationDigestPresent: true,
    capturedSourceDigestPresent: true,
    currentDeclarationDigestComputed: false,
    currentSourceDigestComputed: true,
    observedUnsupportedEvidenceSurface: false,
    driverEvidenceSatisfied: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketsUnderReadOnlyBinds: [],
    preexistingSocketScanIncomplete: false,
    preexistingSocketScanUnreadablePaths: [],
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["current manifest missing - declaration digest not computed"]);
});

test("evaluateClaimEligibility negative control: missing current connector source (source side uncomputable) withholds on the source half only", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    capturedDeclarationDigestPresent: true,
    capturedSourceDigestPresent: true,
    currentDeclarationDigestComputed: true,
    currentSourceDigestComputed: false,
    observedUnsupportedEvidenceSurface: false,
    driverEvidenceSatisfied: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketsUnderReadOnlyBinds: [],
    preexistingSocketScanIncomplete: false,
    preexistingSocketScanUnreadablePaths: [],
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["current connector source missing - source digest not computed"]);
});

test("evaluateClaimEligibility negative control: legacy top-level digests only (captured_with itself absent, both digests fall back false) withholds on both halves", () => {
  // Mirrors bin/scenario-verify.ts's reportCaptureSourceDigests: a scenario
  // with no captured_with at all (only the deprecated top-level
  // declaration_digest/source_digest, which that function does read as a
  // fallback for the REPORT line) still means captured*DigestPresent is
  // computed off `captured_with` — this test asserts the two independent
  // limitations that fire when captured_with itself never made it into the
  // scenario, i.e. the harness could not bind either half.
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    capturedDeclarationDigestPresent: false,
    capturedSourceDigestPresent: false,
    currentDeclarationDigestComputed: true,
    currentSourceDigestComputed: true,
    observedUnsupportedEvidenceSurface: false,
    driverEvidenceSatisfied: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketsUnderReadOnlyBinds: [],
    preexistingSocketScanIncomplete: false,
    preexistingSocketScanUnreadablePaths: [],
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["no capture-time declaration digest", "no capture-time source digest"]);
});

test("evaluateClaimEligibility negative control: complete modern captured_with (eligible modulo isolation) — every digest condition holds, only isolation withholds", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: false,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["network isolation: process-local only - descendant escape not excluded"]);
});

test("evaluateClaimEligibility: condition (d) fails — a run without environment.network.driver === recorded-http yields 'environment driver not declared for every run'", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario({ includeEnvironment: false }),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["environment driver not declared for every run"]);
});

test("evaluateClaimEligibility: condition (e) fails — a legacy scenario without expected.protocol_trace yields 'legacy scenario without protocol trace'", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario({ includeProtocolTrace: false }),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["legacy scenario without protocol trace"]);
});

test("evaluateClaimEligibility: condition (f) fails — isolation not active yields 'network isolation: process-local only - descendant escape not excluded'", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: false,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["network isolation: process-local only - descendant escape not excluded"]);
});

test("evaluateClaimEligibility: condition (g) fails — an observed ASSISTANCE/ASSISTANCE_STATUS withholds with the named limitation", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    observedUnsupportedEvidenceSurface: true,
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, [
    "connector exercised an evidence surface the oracle cannot observe (ASSISTANCE)",
  ]);
});

test("evaluateClaimEligibility: multiple failing conditions are all reported at once, not just the first", () => {
  const scenario = eligibleScenario({ includeEnvironment: false, includeProtocolTrace: false });
  const decision = evaluateClaimEligibility({
    scenario,
    isEntrypointOverride: true,
    capturedDeclarationDigestPresent: false,
    capturedSourceDigestPresent: false,
    currentDeclarationDigestComputed: false,
    currentSourceDigestComputed: false,
    observedUnsupportedEvidenceSurface: true,
    driverEvidenceSatisfied: false,
    isNamespaceIsolationActive: false,
    isolationEvidenceBoundaryProven: false,
    preexistingSocketsUnderReadOnlyBinds: [],
    preexistingSocketScanIncomplete: false,
    preexistingSocketScanUnreadablePaths: [],
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, [
    "unbound entrypoint replay",
    "no capture-time declaration digest",
    "no capture-time source digest",
    "current manifest missing - declaration digest not computed",
    "current connector source missing - source digest not computed",
    "environment driver not declared for every run",
    "legacy scenario without protocol trace",
    "network isolation: process-local only - descendant escape not excluded",
    "connector exercised an evidence surface the oracle cannot observe (ASSISTANCE)",
    "no recorded provider interaction - driver evidence for recorded-http not satisfied",
  ]);
});

// This is the "drive with the existing fixtures/flags" case from the repair
// task: with every OTHER condition held eligible, the actual host's real
// `isNamespaceIsolationAvailable()` capability decides the outcome —
// branched explicitly so this test passes on both host types (a namespace-
// isolation-capable host gets the full recorded_replay claim; a host
// without it — this sandbox, per isolation.ts's own module docstring
// finding — correctly gets withheld with exactly the isolation limitation).
test("evaluateClaimEligibility: with every other condition eligible, the claim tracks this host's real isolation capability", () => {
  const capability = isNamespaceIsolationAvailable();
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: capability.available,
  });
  if (capability.available) {
    assert.deepEqual(decision, { claim: "recorded_replay" });
  } else {
    assert.equal(decision.claim, "diagnostic_replay");
    assert.ok(decision.claim === "diagnostic_replay");
    assert.deepEqual(decision.limitations, ["network isolation: process-local only - descendant escape not excluded"]);
  }
});

// ─── Bounded P1 repair (external review of ab415be6c): isolation evidence
// boundary — launcher trust + recursive read-only, on TOP of namespace
// activity alone ────────────────────────────────────────────────────────────
//
// The review found that `isNamespaceIsolationActive: true` (the OS
// namespaces genuinely exist) was being treated as sufficient for
// `recorded_replay`, even though two separate defects meant the FILESYSTEM
// half of that isolation could be unproven: the `unshare`/`bwrap` launcher
// binaries were resolved through the caller's inherited `$PATH` (a
// PATH-prepended fake launcher could be selected), and the unshare
// mechanism's `--rbind` submounts only had their top mount remounted
// read-only, leaving nested mounts under a `ro` bind writable. These tests
// pin that namespace-active alone can never reach `recorded_replay` — the
// new `isolationEvidenceBoundaryProven` observation must ALSO be true.

test("evaluateClaimEligibility: namespace isolation active but isolationEvidenceBoundaryProven false withholds recorded_replay (launcher trust / recursive-ro not proven)", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
    isolationEvidenceBoundaryProven: false,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, [
    "network isolation: launcher trust or recursive read-only filesystem closure not proven for this run",
  ]);
});

test("evaluateClaimEligibility: namespace isolation active AND isolationEvidenceBoundaryProven true — recorded_replay is reachable again", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketsUnderReadOnlyBinds: [],
  });
  assert.deepEqual(decision, { claim: "recorded_replay" });
});

test("evaluateClaimEligibility: namespace isolation NOT active reports only the coarser process-local limitation, never BOTH isolation limitations at once", () => {
  // When isolation isn't active at all, the boundary-proof limitation is
  // redundant with (and would be confusing alongside) the coarser
  // process-local-only limitation — evaluateClaimEligibility's `else if`
  // must report exactly one of the two, never both.
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: false,
    isolationEvidenceBoundaryProven: false,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["network isolation: process-local only - descendant escape not excluded"]);
});

// ─── Repository-UDS exception, reconciled (P1, external review of ab415be6c)
// ────────────────────────────────────────────────────────────────────────────
//
// Recursive read-only closes the ability to CREATE a socket under a ro
// bind, but not the ability to DIAL one that already existed at spawn time
// — see claims.ts's `preexistingSocketsUnderReadOnlyBinds` doc comment.
// These tests pin the eligibility gate's own handling of the scan result:
// a non-empty result withholds recorded_replay and names every path found;
// an empty result does not withhold on this condition at all.

test("evaluateClaimEligibility: a non-empty preexistingSocketsUnderReadOnlyBinds withholds recorded_replay and names the socket path", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketsUnderReadOnlyBinds: ["/repo/root/.leftover.sock"],
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, [
    "pre-existing socket(s) found under a read-only bind at spawn time, dialable despite recursive read-only: /repo/root/.leftover.sock",
  ]);
});

test("evaluateClaimEligibility: multiple preexistingSocketsUnderReadOnlyBinds are all named in one limitation, comma-joined", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketsUnderReadOnlyBinds: ["/repo/root/a.sock", "/repo/root/nested/b.sock"],
  });
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, [
    "pre-existing socket(s) found under a read-only bind at spawn time, dialable despite recursive read-only: /repo/root/a.sock, /repo/root/nested/b.sock",
  ]);
});

test("evaluateClaimEligibility: an empty preexistingSocketsUnderReadOnlyBinds does not withhold on this condition — recorded_replay reachable", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketsUnderReadOnlyBinds: [],
  });
  assert.deepEqual(decision, { claim: "recorded_replay" });
});

// ─── Scan-completeness gate (P1-2, external review of ced8300be) ──────────
//
// A scan that could not fully enumerate a subtree is NOT the same fact as
// "scanned, found nothing" — `preexistingSocketScanIncomplete` must
// independently withhold `recorded_replay`, on the same severity as a
// non-empty `preexistingSocketsUnderReadOnlyBinds`, even when the socket
// list itself is empty (an incomplete scan means that empty list cannot be
// trusted as exhaustive).

test("evaluateClaimEligibility: preexistingSocketScanIncomplete withholds recorded_replay even when preexistingSocketsUnderReadOnlyBinds is empty", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketsUnderReadOnlyBinds: [],
    preexistingSocketScanIncomplete: true,
    preexistingSocketScanUnreadablePaths: ["/repo/.pdpp-blocked-subtree"],
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, [
    "pre-existing-socket scan could not fully enumerate one or more read-only bind subtrees (unreadable path(s), possibly hiding a dialable socket): /repo/.pdpp-blocked-subtree",
  ]);
});

test("evaluateClaimEligibility: a non-empty preexistingSocketsUnderReadOnlyBinds takes priority over preexistingSocketScanIncomplete (the more specific, more actionable limitation wins)", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
    isolationEvidenceBoundaryProven: true,
    preexistingSocketsUnderReadOnlyBinds: ["/repo/found.sock"],
    preexistingSocketScanIncomplete: true,
    preexistingSocketScanUnreadablePaths: ["/repo/.pdpp-blocked-subtree"],
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, [
    "pre-existing socket(s) found under a read-only bind at spawn time, dialable despite recursive read-only: /repo/found.sock",
  ]);
});

test("evaluateClaimEligibility: preexistingSocketScanIncomplete is irrelevant when isolation itself is not active (the coarser limitation fires instead)", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: false,
    isolationEvidenceBoundaryProven: false,
    preexistingSocketsUnderReadOnlyBinds: [],
    preexistingSocketScanIncomplete: true,
    preexistingSocketScanUnreadablePaths: ["/repo/.pdpp-blocked-subtree"],
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["network isolation: process-local only - descendant escape not excluded"]);
});

test("evaluateClaimEligibility: the socket-scan limitation only fires when isolation is active AND the evidence boundary is proven (not a fourth, independent gate)", () => {
  // If isolation isn't active at all, the coarser process-local limitation
  // must fire instead — a non-empty socket scan result is meaningless
  // (and, in bin/scenario-verify.ts's real wiring, always empty) when
  // isolation was never active for this run.
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: false,
    isolationEvidenceBoundaryProven: false,
    preexistingSocketsUnderReadOnlyBinds: ["/repo/root/.leftover.sock"],
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, ["network isolation: process-local only - descendant escape not excluded"]);
});

// ─── Repair wave 6, P1-1: driver-evidence prerequisite ─────────────────────
//
// `wire-registry.ts`'s `DRIVER_EVIDENCE_POLICIES` map — `recorded-http`'s
// entry is satisfied only when the scenario has >=1 recorded HTTP
// interaction across its runs. Consumption of a recorded interaction (every
// recorded interaction actually being replayed, none left over) is a
// SEPARATE, already-enforced check — `src/scenario/replay.ts`'s
// `ReplayFetch.assertAllConsumed()`, invoked by `src/scenario/verify.ts`'s
// `verifyRun` for every run, already fails the run with an
// `unconsumed_interactions` `VerifyFailure` when a recorded interaction goes
// unconsumed. `src/scenario/scenario.test.ts`'s "unconsumed interaction: a
// recorded interaction the collector never requests fails verification"
// test (line ~156 as of this wave) already covers that path end-to-end
// against a real `verifyScenario` call; the negative control below cites it
// rather than duplicating it, and separately re-asserts the SAME
// `assertAllConsumed` behavior at the unit level (bypassing the subprocess
// CLI) so this file's own P1-1 section is self-contained without a second
// full end-to-end harness.

function scenarioWithInteractionCount(interactionCount: number): ConnectorScenario {
  const base = eligibleScenario();
  const [run0] = base.runs;
  if (!run0) {
    throw new Error("test setup: eligibleScenario() must have at least one run");
  }
  const interactions =
    interactionCount === 0
      ? []
      : Array.from({ length: interactionCount }, (_unused, i) => ({
          seq: i + 1,
          request: { method: "GET", origin: "https://toy.example", path: `/widgets/${String(i)}`, query: [] },
          response: { status: 200, body: { id: `w${String(i)}` } },
        }));
  return { ...base, runs: [{ ...run0, interactions }] };
}

test("driverEvidenceSatisfied: 'recorded-http' is satisfied when the scenario has >=1 recorded HTTP interaction", () => {
  assert.equal(driverEvidenceSatisfied("recorded-http", scenarioWithInteractionCount(1)), true);
});

test("driverEvidenceSatisfied: 'recorded-http' is NOT satisfied when the scenario has zero recorded HTTP interactions", () => {
  assert.equal(driverEvidenceSatisfied("recorded-http", scenarioWithInteractionCount(0)), false);
});

test("driverEvidenceSatisfied: an undeclared driver (undefined) is unsatisfied, fail-closed", () => {
  assert.equal(driverEvidenceSatisfied(undefined, scenarioWithInteractionCount(1)), false);
});

test("driverEvidenceSatisfied: an unimplemented/unknown driver name is unsatisfied, fail-closed (no policy entry = not evidenced)", () => {
  assert.equal(driverEvidenceSatisfied("some-future-browser-driver", scenarioWithInteractionCount(1)), false);
});

test("evaluateClaimEligibility: driverEvidenceSatisfied: false yields the named limitation, even with every other condition eligible", () => {
  const decision = evaluateClaimEligibility({
    scenario: eligibleScenario(),
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    driverEvidenceSatisfied: false,
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, [
    "no recorded provider interaction - driver evidence for recorded-http not satisfied",
  ]);
});

// Negative control 1 (review's list): zero interactions + expected records
// present -> diagnostic only. A scenario whose run 0 declares an expected
// record but recorded ZERO interactions cannot have driver evidence for
// recorded-http (nothing was ever recorded), independent of whether that
// same scenario would ALSO fail plain verification for a different reason
// (an unmatched request) — this test isolates the ELIGIBILITY decision, not
// verifyScenario's pass/fail, matching this file's existing "pure,
// no-subprocess" claims-eligibility tests above.
test("evaluateClaimEligibility negative control: zero interactions + expected records present -> diagnostic only (driver evidence unsatisfied)", () => {
  const scenario = scenarioWithInteractionCount(0);
  assert.ok(Object.keys(scenario.runs[0]?.expected.records ?? {}).length > 0, "test setup: run 0 must expect records");
  const decision = evaluateClaimEligibility({
    scenario,
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    driverEvidenceSatisfied: driverEvidenceSatisfied("recorded-http", scenario),
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, [
    "no recorded provider interaction - driver evidence for recorded-http not satisfied",
  ]);
});

// Negative control 2 (review's list): zero interactions + protocol trace
// present -> diagnostic only. A scenario can carry a well-formed
// `expected.protocol_trace` (condition (e) satisfied) while still never
// having recorded a single HTTP interaction (e.g. a connector run that only
// emitted STATE/DONE, no RECORD-producing fetch) — protocol-trace presence
// and driver evidence are independent facts, and this asserts the latter
// still withholds even when the former is fully satisfied.
test("evaluateClaimEligibility negative control: zero interactions + protocol_trace present -> diagnostic only (driver evidence unsatisfied)", () => {
  const scenario = scenarioWithInteractionCount(0);
  assert.ok(scenario.runs[0]?.expected.protocol_trace !== undefined, "test setup: run 0 must carry a protocol_trace");
  const decision = evaluateClaimEligibility({
    scenario,
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    driverEvidenceSatisfied: driverEvidenceSatisfied("recorded-http", scenario),
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, [
    "no recorded provider interaction - driver evidence for recorded-http not satisfied",
  ]);
});

// Negative control 3 (review's list): >=1 CONSUMED interaction -> eligible
// (modulo other conditions). Mirrors the "every condition met" happy-path
// test above, but built through `scenarioWithInteractionCount` /
// `driverEvidenceSatisfied` directly rather than the shared
// `eligibleDigestObservations()` helper, to prove the driver-evidence
// condition alone does not withhold when real evidence exists.
test("evaluateClaimEligibility negative control: >=1 recorded HTTP interaction -> driver evidence satisfied, eligible modulo other conditions", () => {
  const scenario = scenarioWithInteractionCount(1);
  const decision = evaluateClaimEligibility({
    scenario,
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    driverEvidenceSatisfied: driverEvidenceSatisfied("recorded-http", scenario),
    isNamespaceIsolationActive: true,
  });
  assert.deepEqual(decision, { claim: "recorded_replay" });
});

// Negative control 4 (review's list): assert the EXISTING unconsumed-
// interaction verification failure still fires — this is deliberately NOT
// re-implemented here (P1-1's own doc comment in wire-registry.ts explains
// why: `assertAllConsumed()` already owns this, and duplicating it here
// would be exactly the "consumption enforcement in two places" this task
// was told not to create). `src/scenario/scenario.test.ts`'s "unconsumed
// interaction: a recorded interaction the collector never requests fails
// verification" test already proves this end-to-end via `verifyScenario`;
// this test re-confirms the same underlying behavior at the `ReplayFetch`
// unit level (the primitive `assertAllConsumed` actually is), so a reader
// of THIS file's driver-evidence section can see the citation is accurate
// without cross-referencing scenario.test.ts.
test("negative control: unconsumed recorded interaction still fails verification via assertAllConsumed (cites scenario.test.ts's end-to-end coverage)", async () => {
  const { createReplayFetch } = await import("../src/scenario/replay.ts");
  const run: ScenarioRun = {
    start: { scope: { streams: [{ name: "widgets" }] }, state: null },
    interactions: [
      {
        seq: 1,
        request: { method: "GET", origin: "https://toy.example", path: "/a", query: [] },
        response: { status: 200, body: {} },
      },
      {
        seq: 2,
        request: { method: "GET", origin: "https://toy.example", path: "/b", query: [] },
        response: { status: 200, body: {} },
      },
    ],
    expected: { records: {}, final_state: {} },
  };
  const replay = createReplayFetch(run, []);
  await replay.fetch("https://toy.example/a");
  assert.throws(() => replay.assertAllConsumed(), /seq \[2\]/);
});

// ─── recorded-browser driver: DRIVER_EVIDENCE_POLICIES + claim eligibility ─
//
// Mirrors the recorded-http driver-evidence section immediately above, one
// for one, for the browser driver added alongside browser-har-replay.ts:
//   - `driverEvidenceSatisfied("recorded-browser", ...)` mirrors
//     recorded-http's "at least one recorded interaction" bar with "at
//     least one run declaring recorded-browser with a positive
//     har_entry_count" (wire-registry.ts's DRIVER_EVIDENCE_POLICIES).
//   - `evaluateClaimEligibility` on a recorded-browser scenario NEVER
//     reaches `recorded_replay` — condition (d)
//     (`everyRunDeclaresRecordedHttpDriver`) checks the literal
//     "recorded-http" — a structural cap, not a bug, per claims.ts's module
//     doc comment ("RECORDED-BROWSER IS STRUCTURALLY CAPPED").
//   - every earned `diagnostic_replay: PASS` for a recorded-browser
//     scenario carries `buildBrowserStalenessLimitation(captured_at)` —
//     unconditionally, not gated on any other condition.

function browserEligibleScenario(harEntryCount = 3): ConnectorScenario {
  return {
    format: "pdpp.connector-scenario/1",
    connector: { id: "toy", captured_with: { declaration_digest: "a".repeat(64), source_digest: "b".repeat(64) } },
    capture: {
      captured_at: "2026-08-01T00:00:00.000Z",
      evidence_class: "non_loopback_contact_observed",
      privacy_class: "local-only",
      recorder_version: "test",
      complete: true,
    },
    runs: [
      {
        environment: {
          network: {
            driver: "recorded-browser",
            har_path: "run-0.har",
            storage_state_path: "run-0.storage-state.json",
            har_entry_count: harEntryCount,
          },
        },
        start: { scope: { streams: [{ name: "widgets" }] }, state: null },
        interactions: [],
        expected: {
          records: {
            widgets: { count: 1, ids: ["w1"], ops: ["upsert"], record_sha256s: [hashCanonicalJson({ id: "w1" })] },
          },
          final_state: {},
          protocol_trace: [{ kind: "done", status: "succeeded", records_emitted: 1 }],
        },
      },
    ],
  };
}

test("driverEvidenceSatisfied: 'recorded-browser' is satisfied when a run declares it with har_entry_count > 0", () => {
  assert.equal(driverEvidenceSatisfied("recorded-browser", browserEligibleScenario(3)), true);
});

test("driverEvidenceSatisfied: 'recorded-browser' is NOT satisfied when har_entry_count is 0 (zero recorded HAR entries — vacuous, mirrors recorded-http's zero-interaction case)", () => {
  assert.equal(driverEvidenceSatisfied("recorded-browser", browserEligibleScenario(0)), false);
});

test("driverEvidenceSatisfied: 'recorded-browser' is NOT satisfied when no run declares that driver at all", () => {
  const scenario = eligibleScenario(); // declares "recorded-http", not "recorded-browser"
  assert.equal(driverEvidenceSatisfied("recorded-browser", scenario), false);
});

test("evaluateClaimEligibility: a recorded-browser scenario NEVER reaches recorded_replay, even with every other condition eligible", () => {
  const scenario = browserEligibleScenario(3);
  const decision = evaluateClaimEligibility({
    scenario,
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    driverEvidenceSatisfied: driverEvidenceSatisfied("recorded-browser", scenario),
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  // Exactly two limitations: condition (d) fails because the driver
  // declared is "recorded-browser", not the literal "recorded-http"
  // everyRunDeclaresRecordedHttpDriver checks — PLUS the mandatory
  // staleness disclaimer, unconditional whenever any run is browser-driven.
  assert.deepEqual(decision.limitations, [
    "non-recorded-http driver - canonical replay is defined only for recorded-http",
    buildBrowserStalenessLimitation("2026-08-01T00:00:00.000Z"),
  ]);
});

test("evaluateClaimEligibility: a recorded-browser scenario with zero HAR entries reports BOTH the browser-specific driver-evidence limitation and the staleness disclaimer", () => {
  const scenario = browserEligibleScenario(0);
  const decision = evaluateClaimEligibility({
    scenario,
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    driverEvidenceSatisfied: driverEvidenceSatisfied("recorded-browser", scenario),
    isNamespaceIsolationActive: true,
  });
  assert.equal(decision.claim, "diagnostic_replay");
  assert.ok(decision.claim === "diagnostic_replay");
  assert.deepEqual(decision.limitations, [
    "non-recorded-http driver - canonical replay is defined only for recorded-http",
    "no recorded HAR entries - driver evidence for recorded-browser not satisfied",
    buildBrowserStalenessLimitation("2026-08-01T00:00:00.000Z"),
  ]);
});

test("evaluateClaimEligibility: the staleness limitation names the scenario's own capture.captured_at, not a fixed string", () => {
  const scenario = browserEligibleScenario(3);
  scenario.capture.captured_at = "2019-01-01T00:00:00.000Z";
  const decision = evaluateClaimEligibility({
    scenario,
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    driverEvidenceSatisfied: driverEvidenceSatisfied("recorded-browser", scenario),
    isNamespaceIsolationActive: true,
  });
  assert.ok(decision.claim === "diagnostic_replay");
  assert.ok(
    decision.limitations.includes(
      "recorded-browser: verified against capture of 2019-01-01T00:00:00.000Z; asserts nothing about the live provider"
    )
  );
});

test("evaluateClaimEligibility: a recorded-http scenario NEVER carries the browser staleness limitation (regression control — the disclaimer is browser-only)", () => {
  const scenario = eligibleScenario();
  const decision = evaluateClaimEligibility({
    scenario,
    isEntrypointOverride: false,
    ...eligibleDigestObservations(),
    isNamespaceIsolationActive: true,
  });
  assert.deepEqual(decision, { claim: "recorded_replay" });
  // The happy-path recorded-http case reaches recorded_replay with ZERO
  // limitations at all — asserting this explicitly (not just "doesn't
  // include the browser string") proves the browser-only trigger condition
  // (anyRunDeclaresBrowserDriver) didn't fire a false positive on an
  // ordinary recorded-http scenario.
});
