#!/usr/bin/env node
/**
 * Fixture-based tests for the wrapper-lane risk classifier in workstreams-status.mjs.
 *
 * Runs workstreams-status.mjs --no-fail against a minimal fake repo layout and
 * asserts that thin-transcript risks are emitted or suppressed as expected.
 *
 * Run: node scripts/workstreams-status-risk-classifier.test.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const statusScript = join(__dirname, "workstreams-status.mjs");

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`PASS: ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`FAIL: ${label}\n  ${detail}`);
  failed++;
}

/**
 * Run workstreams-status.mjs --no-fail against a fake wrapper directory
 * containing a single lane with the given status.json fields.
 * Returns stdout as a string.
 */
function runWithFixture(statusData) {
  const tmp = mkdtempSync(join(tmpdir(), "ws-status-test-"));
  try {
    // Fake git repo so the script can parse worktrees / branch status.
    execFileSync("git", ["init", "--quiet", tmp]);
    execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "--quiet", "-m", "init"]);

    const lane = statusData.lane ?? "test-lane";
    const ts = "20260101T000000Z";
    const artifactDir = join(tmp, "tmp", "workstreams", "claude-wrapper", lane, ts);
    mkdirSync(artifactDir, { recursive: true });

    writeFileSync(
      join(artifactDir, "status.json"),
      JSON.stringify({ lane, started_at: ts, ended_at: "2026-01-01T00:30:00Z", ...statusData })
    );

    // workstreams-status.mjs resolves repoRoot via git; we must run from the fake repo.
    return execFileSync("node", [statusScript, "--no-fail"], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, HOME: process.env.HOME },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Test cases ---

// 1. Aborted lane with zero transcript_bytes must NOT appear in Risks.
try {
  const out = runWithFixture({
    lane: "ri-connector-green-no-human-v3",
    status: "aborted",
    report_state: "absent",
    exit_code: 130,
    transcript_bytes: 0,
  });
  if (out.includes("thin-transcript")) {
    fail("aborted/zero-bytes: thin-transcript risk emitted (should be suppressed)", out);
  } else {
    pass("aborted/zero-bytes: thin-transcript risk suppressed");
  }
} catch (err) {
  fail("aborted/zero-bytes: script threw", err.message);
}

// 2. Aborted lane with zero transcript_bytes must still appear in Wrapper Lanes inventory.
try {
  const out = runWithFixture({
    lane: "ri-connector-green-no-human-v3",
    status: "aborted",
    report_state: "absent",
    exit_code: 130,
    transcript_bytes: 0,
  });
  if (!out.includes("aborted")) {
    fail("aborted/zero-bytes: lane not visible in Wrapper Lanes inventory", out);
  } else {
    pass("aborted/zero-bytes: lane visible in Wrapper Lanes inventory");
  }
} catch (err) {
  fail("aborted/zero-bytes: script threw", err.message);
}

// 3. Completed lane with zero transcript_bytes MUST appear as a thin-transcript risk.
try {
  const out = runWithFixture({
    lane: "ri-some-completed-lane",
    status: "completed",
    report_state: "present",
    exit_code: 0,
    transcript_bytes: 0,
  });
  if (!out.includes("thin-transcript")) {
    fail("completed/zero-bytes: thin-transcript risk not emitted (should surface)", out);
  } else {
    pass("completed/zero-bytes: thin-transcript risk correctly surfaced");
  }
} catch (err) {
  fail("completed/zero-bytes: script threw", err.message);
}

// 4. Failed lane with zero transcript_bytes MUST appear as a thin-transcript risk.
try {
  const out = runWithFixture({
    lane: "ri-some-failed-lane",
    status: "failed",
    report_state: "absent",
    exit_code: 1,
    transcript_bytes: 0,
  });
  if (!out.includes("thin-transcript")) {
    fail("failed/zero-bytes: thin-transcript risk not emitted (should surface)", out);
  } else {
    pass("failed/zero-bytes: thin-transcript risk correctly surfaced");
  }
} catch (err) {
  fail("failed/zero-bytes: script threw", err.message);
}

// 5. Completed lane with a large transcript must NOT appear as a thin-transcript risk.
try {
  const out = runWithFixture({
    lane: "ri-healthy-lane",
    status: "completed",
    report_state: "present",
    exit_code: 0,
    transcript_bytes: 50000,
  });
  if (out.includes("thin-transcript")) {
    fail("completed/large-bytes: thin-transcript risk emitted unexpectedly", out);
  } else {
    pass("completed/large-bytes: no false thin-transcript risk");
  }
} catch (err) {
  fail("completed/large-bytes: script threw", err.message);
}

// 6. Recovered report-only lane whose branch no longer exists must NOT appear as a live risk.
try {
  const out = runWithFixture({
    branch: "workstream/already-parked",
    lane: "ri-recovered-parked-lane",
    status: "complete",
    report_state: "recovered",
    recovered: true,
    exit_code: 0,
    transcript_bytes: 1,
  });
  if (out.includes("thin-transcript")) {
    fail("recovered/parked: thin-transcript risk emitted for historical lane", out);
  } else if (!out.includes("ri-recovered-parked-lane")) {
    fail("recovered/parked: lane disappeared from wrapper inventory", out);
  } else {
    pass("recovered/parked: no live risk, still visible in inventory");
  }
} catch (err) {
  fail("recovered/parked: script threw", err.message);
}

// 7. Completed report-bearing lane whose branch no longer exists must NOT appear as a live risk.
try {
  const out = runWithFixture({
    branch: "workstream/already-merged",
    lane: "ri-completed-merged-lane",
    status: "complete",
    report_state: "present",
    recovered: false,
    exit_code: 0,
    transcript_bytes: 127,
  });
  if (out.includes("thin-transcript")) {
    fail("completed/merged: thin-transcript risk emitted for historical lane", out);
  } else if (!out.includes("ri-completed-merged-lane")) {
    fail("completed/merged: lane disappeared from wrapper inventory", out);
  } else {
    pass("completed/merged: no live risk, still visible in inventory");
  }
} catch (err) {
  fail("completed/merged: script threw", err.message);
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
