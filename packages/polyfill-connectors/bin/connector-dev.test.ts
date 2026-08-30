// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end proof for `bin/connector-dev.ts` — the "run and watch it work"
 * developer command — driven as a REAL subprocess (not an in-process
 * import) against test-only fixture connectors, with no live credentials.
 *
 * Uses the `--entrypoint` dev/test-only override (see connector-dev.ts's
 * module docstring) to point the CLI at
 * `src/test-fixtures/connector-dev-cli-fixture.ts` and the existing
 * `src/test-fixtures/protocol-subprocess-fails-after-record.ts` fixture
 * instead of a registered production connector, so this proves the CLI's
 * own spawn/stream/summarize/exit-code behavior without touching
 * `src/orchestrator.ts`'s manifest registry.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunSummary } from "../src/run-summary.ts";
import {
  type CheckpointEvidence,
  classifyFailureEnvironment,
  type LastState,
  resolveCaptureOnFailureEnv,
} from "./connector-dev.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const CLI_PATH = join(PACKAGE_ROOT, "bin", "connector-dev.ts");
const fixturePath = (name: string): string => join(PACKAGE_ROOT, "src", "test-fixtures", name);
/** `bin/connector-dev.ts`'s own `lastStatePath` — reimplemented here (not
 *  imported) so this test asserts on the SAME path convention a real
 *  developer would compute by hand, rather than trusting the module under
 *  test to describe its own output location correctly. */
const lastStatePathFor = (connector: string): string => join(PACKAGE_ROOT, "runs", connector, "last-state.json");

function runCli(args: readonly string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("connector-dev CLI: succeeding fixture streams RECORD/PROGRESS/STATE lines, exits 0, writes a matching summary", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "connector-dev-test-"));
  const summaryPath = join(tmpDir, "summary.json");
  try {
    const result = runCli([
      "connector-dev-cli-fixture",
      "--entrypoint",
      fixturePath("connector-dev-cli-fixture.ts"),
      "--summary-out",
      summaryPath,
    ]);

    assert.equal(result.code, 0, `expected exit 0; stderr=${result.stderr}`);

    // START echo.
    assert.match(result.stdout, /START connector-dev-cli-fixture/);
    // Live per-stream RECORD count line (first record prints immediately).
    assert.match(result.stdout, /RECORD\s+\[items] 1 record\(s\) so far/);
    // PROGRESS line surfaced verbatim.
    assert.match(result.stdout, /PROGRESS\s+\[items] collecting synthetic items/);
    // STATE commit line.
    assert.match(result.stdout, /STATE\s+\[items] checkpoint committed/);
    // The intentionally-invalid row becomes a SKIP_RESULT warning.
    assert.match(result.stdout, /WARN\s+\[items] skip: shape_check_failed/);
    // Terminal summary block.
    assert.match(result.stdout, /DONE/);
    assert.match(result.stdout, /items\s+3 record\(s\)\s+state_emitted=true/);
    assert.match(result.stdout, /skips: 1/);
    assert.match(result.stdout, new RegExp(`summary written to: ${summaryPath}`));
    assert.match(result.stdout, /STATUS succeeded/);

    assert.ok(existsSync(summaryPath), "summary file must be written");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
    assert.equal(summary.format, "pdpp.run-summary/1");
    assert.equal(summary.generated_by, "connector-dev");
    assert.equal(summary.connector, "connector-dev-cli-fixture");
    assert.equal(summary.streams.items?.records, 3);
    assert.equal(summary.streams.items?.state_emitted, true);
    assert.equal(summary.skips, 1);
    assert.equal(summary.done.status, "succeeded");
    assert.ok(summary.duration_ms >= 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("connector-dev CLI: failing fixture exits non-zero, prints the failure kind, and writes a failed summary", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "connector-dev-test-"));
  const summaryPath = join(tmpDir, "summary.json");
  try {
    const result = runCli([
      "protocol-subprocess-fails-after-record",
      "--entrypoint",
      fixturePath("protocol-subprocess-fails-after-record.ts"),
      "--summary-out",
      summaryPath,
    ]);

    assert.notEqual(result.code, 0, "a terminal failure must exit non-zero");
    assert.match(result.stdout, /RECORD\s+\[items] 1 record\(s\) so far/);
    assert.match(result.stdout, /FAILED\s+retryable: retry budget exhausted/i);

    assert.ok(existsSync(summaryPath), "summary file must still be written on failure");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
    assert.equal(summary.done.status, "failed");
    assert.equal(summary.done.error?.retryable, true);
    assert.match(summary.done.error?.message ?? "", /retry budget exhausted/i);
    assert.equal(summary.streams.items?.records, 1);
    assert.equal(summary.streams.items?.state_emitted, false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("connector-dev CLI: default summary path is under runs/<connector>/ when --summary-out is omitted", () => {
  const result = runCli(["connector-dev-cli-fixture", "--entrypoint", fixturePath("connector-dev-cli-fixture.ts")]);

  assert.equal(result.code, 0, `expected exit 0; stderr=${result.stderr}`);
  const match = /summary written to: (.+runs\/connector-dev-cli-fixture\/.+-summary\.json)/.exec(result.stdout);
  assert.ok(match, `expected default summary path in stdout; got: ${result.stdout}`);
  const writtenPath = match?.[1]?.trim();
  assert.ok(writtenPath && existsSync(writtenPath), "default-path summary file must exist");
  if (writtenPath) {
    rmSync(writtenPath, { force: true });
  }
});

// ─── Interaction answering (src/test-fixtures/connector-dev-interaction-
// fixture.ts emits ONE `otp` INTERACTION mid-run, then a record whose
// `otp_value` field is exactly the response value — see that fixture's doc
// comment for why this makes the answering path's effect observable) ──────

test("connector-dev CLI: --answer <index>=<value> completes an INTERACTION and the run succeeds", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "connector-dev-interaction-test-"));
  const summaryPath = join(tmpDir, "summary.json");
  try {
    const result = runCli([
      "connector-dev-interaction-fixture",
      "--entrypoint",
      fixturePath("connector-dev-interaction-fixture.ts"),
      "--answer",
      "0=555111",
      "--summary-out",
      summaryPath,
    ]);

    assert.equal(result.code, 0, `expected exit 0; stderr=${result.stderr}`);
    assert.match(result.stdout, /PROMPT\s+needs otp: Enter the verification code/);
    assert.match(result.stdout, /STATE\s+\[items] checkpoint committed/);
    assert.match(result.stdout, /STATUS succeeded/);
    assert.doesNotMatch(result.stdout, /PROMPT\s+FAILED/);

    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
    assert.equal(summary.done.status, "succeeded");
    assert.equal(summary.streams.items?.records, 2);
    assert.equal(summary.streams.items?.state_emitted, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("connector-dev CLI: no --answer and no TTY fails loudly, naming the unanswered prompt", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "connector-dev-interaction-test-"));
  const summaryPath = join(tmpDir, "summary.json");
  try {
    const result = runCli([
      "connector-dev-interaction-fixture",
      "--entrypoint",
      fixturePath("connector-dev-interaction-fixture.ts"),
      "--summary-out",
      summaryPath,
    ]);

    assert.notEqual(result.code, 0, "an unanswered interaction with no TTY must fail non-zero");
    assert.match(result.stdout, /PROMPT\s+needs otp: Enter the verification code/);
    assert.match(
      result.stdout,
      /PROMPT\s+FAILED \(no --answer, no TTY\): otp — Enter the verification code shown on your device\./
    );
    assert.match(
      result.stdout,
      /unanswered prompt: otp — Enter the verification code shown on your device\. \(request_id=/
    );
    assert.match(result.stdout, /FAILED\s+terminal:/);

    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
    assert.equal(summary.done.status, "failed");
    // The fixture's before-prompt record still made it through — proves the
    // failure is specifically the unanswered interaction, not a spawn/crash.
    assert.equal(summary.streams.items?.records, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── DONE-finality honesty: a succeeded DONE is not self-certifying ───────

test("connector-dev CLI: a succeeded DONE followed by a nonzero exit is reported as a failure, not a success", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "connector-dev-done-then-exit1-test-"));
  const summaryPath = join(tmpDir, "summary.json");
  try {
    const result = runCli([
      "connector-dev-done-then-exit1-fixture",
      "--entrypoint",
      fixturePath("connector-dev-done-then-exit1-fixture.ts"),
      "--summary-out",
      summaryPath,
    ]);

    assert.notEqual(
      result.code,
      0,
      `a DONE(succeeded) followed by exit 1 must still fail non-zero; stdout=${result.stdout}`
    );
    assert.doesNotMatch(result.stdout, /STATUS succeeded/);
    assert.match(result.stdout, /FAILED\s+protocol_violation: nonzero_exit_after_done/);

    // The summary artifact is still written (mirrors the other failure
    // paths) and its own DONE.status is honestly "succeeded" — the CLI's
    // exit code/printed FAILED line is what carries the real verdict, not a
    // rewrite of the connector's own claim.
    assert.ok(existsSync(summaryPath), "summary file must still be written");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
    assert.equal(summary.done.status, "succeeded");
    assert.equal(summary.streams.items?.records, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── --streams and --seed-last-state (src/test-fixtures/connector-dev-
// scope-state-fixture.ts declares two streams, `items` and `extras` —
// matching connector-dev.ts's `ENTRYPOINT_MODE_STREAMS` — and echoes the
// requested stream set plus an incrementing per-stream cursor derived from
// incoming state, so both flags' effects are observable in the run's own
// output/artifacts rather than just exercised as inert plumbing) ─────────

test("connector-dev CLI: --streams subsets START.scope — the fixture only sees and emits for the named streams", () => {
  const connector = `connector-dev-streams-subset-${String(process.pid)}`;
  const tmpDir = mkdtempSync(join(tmpdir(), "connector-dev-streams-test-"));
  const summaryPath = join(tmpDir, "summary.json");
  try {
    const result = runCli([
      connector,
      "--entrypoint",
      fixturePath("connector-dev-scope-state-fixture.ts"),
      "--streams",
      "items",
      "--summary-out",
      summaryPath,
    ]);

    assert.equal(result.code, 0, `expected exit 0; stdout=${result.stdout} stderr=${result.stderr}`);
    // START echo names only the scoped stream, not the fixture's full set.
    assert.match(result.stdout, new RegExp(`START ${connector} — streams: items$`, "m"));
    // The fixture's own PROGRESS line proves `ctx.requested` (built from
    // START.scope.streams by connector-runtime.ts) contained ONLY "items" —
    // not that the CLI merely printed a narrower banner while still sending
    // everything.
    assert.match(result.stdout, /PROGRESS\s+\[items] requested streams: items$/m);
    // No RECORD/STATE for the scoped-out "extras" stream at all.
    assert.doesNotMatch(result.stdout, /\[extras]/);

    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
    assert.equal(summary.streams.items?.records, 1);
    assert.equal(summary.streams.extras, undefined);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(join(PACKAGE_ROOT, "runs", connector), { recursive: true, force: true });
  }
});

test("connector-dev CLI: --streams naming an unknown stream fails, listing the fixture's actual stream names", () => {
  const connector = `connector-dev-streams-unknown-${String(process.pid)}`;
  const tmpDir = mkdtempSync(join(tmpdir(), "connector-dev-streams-test-"));
  const summaryPath = join(tmpDir, "summary.json");
  try {
    const result = runCli([
      connector,
      "--entrypoint",
      fixturePath("connector-dev-scope-state-fixture.ts"),
      "--streams",
      "items,bogus",
      "--summary-out",
      summaryPath,
    ]);

    assert.notEqual(result.code, 0, "an unknown --streams name must fail non-zero");
    assert.match(
      result.stdout,
      /FAILED\s+--streams named unknown stream\(s\): bogus\. Available streams: items, extras/
    );
    // Fails BEFORE spawning the connector: no START/PROGRESS line at all.
    assert.doesNotMatch(result.stdout, /^START/m);
    assert.ok(!existsSync(summaryPath), "no summary should be written for a pre-flight arg failure");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(join(PACKAGE_ROOT, "runs", connector), { recursive: true, force: true });
  }
});

test("connector-dev CLI: --seed-last-state round-trips a prior run's committed cursor into the next run's START.state", () => {
  const connector = `connector-dev-seed-roundtrip-${String(process.pid)}`;
  const tmpDir = mkdtempSync(join(tmpdir(), "connector-dev-seed-test-"));
  const summaryPath1 = join(tmpDir, "summary-1.json");
  const summaryPath2 = join(tmpDir, "summary-2.json");
  const lastStatePath = lastStatePathFor(connector);
  try {
    // Run 1: no prior state, so the fixture's incoming cursor is empty and
    // it commits `{ seen: 1 }` for both streams.
    const result1 = runCli([
      connector,
      "--entrypoint",
      fixturePath("connector-dev-scope-state-fixture.ts"),
      "--summary-out",
      summaryPath1,
    ]);
    assert.equal(result1.code, 0, `run 1 failed; stdout=${result1.stdout} stderr=${result1.stderr}`);
    assert.doesNotMatch(result1.stdout, /^SEEDED/m, "run 1 has no --seed-last-state, so no SEEDED line");

    assert.ok(existsSync(lastStatePath), "last-state.json must exist after a DONE that emitted STATE");
    const lastStateAfterRun1 = JSON.parse(readFileSync(lastStatePath, "utf8")) as LastState;
    assert.equal(lastStateAfterRun1.connector, connector);
    assert.deepEqual(lastStateAfterRun1.state, { items: { seen: 1 }, extras: { seen: 1 } });

    // Run 2: --seed-last-state reads run 1's committed cursor back into
    // START.state — the fixture's own increment-from-incoming-state logic
    // makes the seed's effect observable: `seen` goes from 1 to 2, which
    // could only happen if the seeded value actually reached ctx.state.
    const result2 = runCli([
      connector,
      "--entrypoint",
      fixturePath("connector-dev-scope-state-fixture.ts"),
      "--seed-last-state",
      "--summary-out",
      summaryPath2,
    ]);
    assert.equal(result2.code, 0, `run 2 failed; stdout=${result2.stdout} stderr=${result2.stderr}`);
    assert.match(
      result2.stdout,
      new RegExp(`^SEEDED   state from ${lastStatePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(run of .+\\)$`, "m")
    );

    const lastStateAfterRun2 = JSON.parse(readFileSync(lastStatePath, "utf8")) as LastState;
    assert.deepEqual(lastStateAfterRun2.state, { items: { seen: 2 }, extras: { seen: 2 } });

    const summary2 = JSON.parse(readFileSync(summaryPath2, "utf8")) as RunSummary;
    assert.equal(summary2.streams.items?.records, 1);
    assert.equal(summary2.streams.extras?.records, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(join(PACKAGE_ROOT, "runs", connector), { recursive: true, force: true });
  }
});

test("connector-dev CLI: --seed-last-state with no prior run fails clearly, naming the missing file", () => {
  const connector = `connector-dev-seed-missing-${String(process.pid)}`;
  const tmpDir = mkdtempSync(join(tmpdir(), "connector-dev-seed-missing-test-"));
  const summaryPath = join(tmpDir, "summary.json");
  const lastStatePath = lastStatePathFor(connector);
  assert.ok(!existsSync(lastStatePath), "precondition: no prior last-state.json for this fresh connector name");
  try {
    const result = runCli([
      connector,
      "--entrypoint",
      fixturePath("connector-dev-scope-state-fixture.ts"),
      "--seed-last-state",
      "--summary-out",
      summaryPath,
    ]);

    assert.notEqual(result.code, 0, "--seed-last-state with no prior state must fail non-zero");
    assert.match(
      result.stdout,
      new RegExp(
        `FAILED   --seed-last-state: no prior run state at ${lastStatePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; ` +
          "run once without the flag first, then re-run with --seed-last-state\\."
      )
    );
    // Fails BEFORE spawning the connector: no START line, no summary.
    assert.doesNotMatch(result.stdout, /^START/m);
    assert.ok(!existsSync(summaryPath), "no summary should be written for a pre-flight arg failure");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(join(PACKAGE_ROOT, "runs", connector), { recursive: true, force: true });
  }
});

// ─── FIX 1: default-on failure-evidence retention ─────────────────────────
//
// Per the grounding research (leading failure-diagnostic tools retain
// evidence by default in their primary run mode), `connector-dev` sets
// `PDPP_CAPTURE_ON_FAILURE=1` for the subprocess unless the developer
// explicitly opts out. `resolveCaptureOnFailureEnv` is pure and covered
// directly below; the CLI-level tests confirm the resolved value actually
// reaches the subprocess by reading it back via
// `connector-dev-env-echo-fixture.ts`'s stderr echo (a real stub the
// production code path writes through, not a parallel assertion route).

test("resolveCaptureOnFailureEnv: unset environment defaults to on (1)", () => {
  assert.equal(resolveCaptureOnFailureEnv(false, {}), "1");
});

test("resolveCaptureOnFailureEnv: --no-capture disables regardless of environment", () => {
  assert.equal(resolveCaptureOnFailureEnv(true, {}), undefined);
  assert.equal(resolveCaptureOnFailureEnv(true, { PDPP_CAPTURE_ON_FAILURE: "1" }), undefined);
});

test("resolveCaptureOnFailureEnv: an explicit 0 already in the environment is respected, not overridden", () => {
  assert.equal(resolveCaptureOnFailureEnv(false, { PDPP_CAPTURE_ON_FAILURE: "0" }), "0");
});

test("resolveCaptureOnFailureEnv: an explicit 1 already in the environment stays 1", () => {
  assert.equal(resolveCaptureOnFailureEnv(false, { PDPP_CAPTURE_ON_FAILURE: "1" }), "1");
});

test("connector-dev CLI: default run sets PDPP_CAPTURE_ON_FAILURE=1 for the subprocess and prints the policy line", () => {
  const result = runCli([
    "connector-dev-env-echo-fixture",
    "--entrypoint",
    fixturePath("connector-dev-env-echo-fixture.ts"),
  ]);

  assert.equal(result.code, 0, `expected exit 0; stderr=${result.stderr}`);
  assert.match(result.stdout, /^capture: on-failure \(default; --no-capture to disable\)$/m);
  assert.match(result.stderr, /PDPP_CAPTURE_ON_FAILURE_ECHO=1/);
});

test("connector-dev CLI: --no-capture disables retention and the subprocess sees it unset", () => {
  const result = runCli([
    "connector-dev-env-echo-fixture",
    "--entrypoint",
    fixturePath("connector-dev-env-echo-fixture.ts"),
    "--no-capture",
  ]);

  assert.equal(result.code, 0, `expected exit 0; stderr=${result.stderr}`);
  assert.match(result.stdout, /^capture: disabled \(--no-capture\)$/m);
  assert.match(result.stderr, /PDPP_CAPTURE_ON_FAILURE_ECHO=__unset__/);
});

test("connector-dev CLI: an explicit PDPP_CAPTURE_ON_FAILURE=0 already in the environment is passed through untouched", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      CLI_PATH,
      "connector-dev-env-echo-fixture",
      "--entrypoint",
      fixturePath("connector-dev-env-echo-fixture.ts"),
    ],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PDPP_CAPTURE_ON_FAILURE: "0",
      },
      encoding: "utf8",
      timeout: 30_000,
    }
  );

  assert.equal(result.status, 0, `expected exit 0; stderr=${result.stderr}`);
  assert.match(result.stdout, /^capture: disabled \(PDPP_CAPTURE_ON_FAILURE=0 already set in environment\)$/m);
  assert.match(result.stderr, /PDPP_CAPTURE_ON_FAILURE_ECHO=0/);
});

// ─── FIX 2: evidence + closed taxonomy (pure predicate coverage) ──────────
//
// `classifyFailureEnvironment` is a pure fold over checkpoint evidence, so
// it is exercised directly rather than through a real Playwright capture —
// synthesizing the exact metadata shape `readCheckpointEvidence` would have
// produced from real `pages/<label>.json` + `dom/<label>.html` files.

function checkpoint(url: string, domBytes: number, label = "checkpoint"): CheckpointEvidence {
  return { label, url, domBytes };
}

test("classifyFailureEnvironment: no checkpoints -> no classification (evidence-only, no guess)", () => {
  assert.equal(classifyFailureEnvironment([]), undefined);
});

test("classifyFailureEnvironment: healthy checkpoints at a real origin with a normal DOM size -> no classification", () => {
  const checkpoints = [checkpoint("https://venmo.com/login", 45_000, "signin-loaded")];
  assert.equal(classifyFailureEnvironment(checkpoints), undefined);
});

test("classifyFailureEnvironment: a real-origin checkpoint with a degenerate-small DOM -> viewport_zero", () => {
  // Mirrors the motivating incident: the page LANDED at a real origin (the
  // venmo fix means about:blank no longer masks this) but a 0x0 viewport
  // never laid out content, so the DOM read back near-empty.
  const checkpoints = [checkpoint("https://venmo.com/account", 39, "auth-probe")];
  assert.deepEqual(classifyFailureEnvironment(checkpoints), { kind: "viewport_zero" });
});

test("classifyFailureEnvironment: about:blank as the LAST checkpoint after an earlier real origin -> navigation_incomplete", () => {
  const checkpoints = [
    checkpoint("https://venmo.com/login", 45_000, "signin-loaded"),
    checkpoint("about:blank", 39, "auth-probe"),
  ];
  assert.deepEqual(classifyFailureEnvironment(checkpoints), { kind: "navigation_incomplete" });
});

test("classifyFailureEnvironment: about:blank as the ONLY checkpoint (never reached a real origin) -> no classification", () => {
  // No real origin was ever reached, so this is not "navigation started but
  // didn't finish" — it's simply no evidence of any navigation attempt at
  // all. The closed taxonomy does not guess a cause here.
  const checkpoints = [checkpoint("about:blank", 39, "auth-probe")];
  assert.equal(classifyFailureEnvironment(checkpoints), undefined);
});

test("classifyFailureEnvironment: viewport_zero takes priority when both patterns are present in the same run", () => {
  const checkpoints = [
    checkpoint("https://venmo.com/login", 45_000, "signin-loaded"),
    checkpoint("https://venmo.com/account", 39, "auth-probe"),
  ];
  assert.deepEqual(classifyFailureEnvironment(checkpoints), { kind: "viewport_zero" });
});

// ─── FIX 2: evidence pointers printed on a real CLI failure ───────────────

test("connector-dev CLI: a failure with capture disabled prints evidence:none and does not invent a diagnosis", () => {
  const result = runCli([
    "protocol-subprocess-fails-after-record",
    "--entrypoint",
    fixturePath("protocol-subprocess-fails-after-record.ts"),
    "--no-capture",
  ]);

  assert.notEqual(result.code, 0, "a terminal failure must exit non-zero");
  assert.match(result.stdout, /FAILED\s+retryable: retry budget exhausted/i);
  assert.match(result.stdout, /evidence: none retained for this run \(capture disabled/);
  // No free-text speculative hint branches (the old "hint: a provider
  // request failed to execute..." wording) survive this failure path.
  assert.doesNotMatch(result.stdout, /hint:/);
});

test("connector-dev CLI: a failure with capture enabled but no browser checkpoints prints the evidence dir and no false classification", () => {
  const tmpCaptureRoot = mkdtempSync(join(tmpdir(), "connector-dev-capture-root-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        CLI_PATH,
        "protocol-subprocess-fails-after-record",
        "--entrypoint",
        fixturePath("protocol-subprocess-fails-after-record.ts"),
      ],
      {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
          PDPP_CAPTURE_ROOT_DIR: tmpCaptureRoot,
        },
        encoding: "utf8",
        timeout: 30_000,
      }
    );

    assert.notEqual(result.status, 0, "a terminal failure must exit non-zero");
    assert.match(result.stdout, /^capture: on-failure \(default; --no-capture to disable\)$/m);
    // This fixture is not browser-shaped, so createCaptureSession() runs (the
    // directory exists) but no `pages/*.json` checkpoints were ever written —
    // the evidence-dir pointer must still print, with no invented checkpoint
    // line and no environment classification for evidence that isn't there.
    assert.match(result.stdout, new RegExp(`evidence: ${tmpCaptureRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(result.stdout, /evidence: checkpoint/);
    assert.doesNotMatch(result.stdout, /environment: browser viewport/);
    assert.doesNotMatch(result.stdout, /navigation_incomplete:/);
  } finally {
    rmSync(tmpCaptureRoot, { recursive: true, force: true });
  }
});
