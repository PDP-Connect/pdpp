// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * stream-mint-probe.mjs
 *
 * Deterministic, OTP-free probe for the run-interaction streaming path.
 * Runs the authoritative streaming test suite and captures output to
 * tmp/workstreams/stream-debug/<timestamp>-probe.jsonl so failures are debuggable without
 * a live connector or owner interaction.
 *
 * Usage:
 *   node scripts/stream-mint-probe.mjs
 *
 * Exit 0 = all probes passed. Exit 1 = one or more failures.
 *
 * What this covers (delegates to the test suite):
 *   1. Mint fails closed with 503 when no companion is configured.
 *   2. Mint succeeds with mock companion and returns expected shape.
 *   3. SSE /events attach delivers `attached` then `backend_ready`.
 *   4. n.eko entry redirect includes usr/pwd when auto-login is configured.
 *   5. Idempotent re-mint with same key returns same token.
 *   6. Resolving the interaction tears the streaming session down.
 *   7. n.eko adapter viewport / stealth / CDP navigation logic.
 *   8. Neko surface allocator lifecycle (provision, stop, healthcheck).
 *
 * These are the exact code paths that produce "Couldn't reach the browser
 * stream after several tries" — making failures deterministic and capturable
 * without a live run.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEBUG_DIR = join(REPO_ROOT, "tmp", "workstreams", "stream-debug");
const NOW = new Date().toISOString().replace(/[:.]/g, "-");
const FIXTURE_PATH = join(DEBUG_DIR, `${NOW}-stream-mint-probe.jsonl`);

mkdirSync(DEBUG_DIR, { recursive: true });

const TEST_FILES = [
  "reference-implementation/test/run-interaction-stream-routes.test.js",
  "reference-implementation/test/run-interaction-stream-neko-adapter.test.js",
  "reference-implementation/test/run-interaction-stream-playground.test.js",
  "reference-implementation/test/neko-surface-allocator-server.test.js",
  "reference-implementation/test/neko-surface-allocator.test.js",
];

console.log(`[stream-mint-probe] running ${TEST_FILES.length} test files`);
console.log(`[stream-mint-probe] fixture -> ${FIXTURE_PATH}\n`);

let exitCode = 0;
const results = [];

for (const file of TEST_FILES) {
  const label = file.split("/").pop();
  const startMs = Date.now();
  let output = "";
  let passed = 0;
  let failed = 0;
  let status = "pass";

  try {
    output = execFileSync(process.execPath, ["--test", file], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Parse node:test summary lines for counts.
    for (const line of output.split("\n")) {
      const passMatch = line.match(/^\u2139 pass (\d+)/);
      const failMatch = line.match(/^\u2139 fail (\d+)/);
      if (passMatch) passed = parseInt(passMatch[1], 10);
      if (failMatch) failed = parseInt(failMatch[1], 10);
    }
    if (failed > 0) {
      status = "fail";
      exitCode = 1;
    }
    console.log(
      `  ${status === "pass" ? "PASS" : "FAIL"} ${label}  (${passed}p/${failed}f in ${Date.now() - startMs}ms)`
    );
  } catch (err) {
    status = "fail";
    exitCode = 1;
    output = err.stdout || err.message;
    console.error(`  FAIL ${label}  ERROR: ${err.message.split("\n")[0]}`);
  }

  const record = {
    probe: "stream-mint",
    file: label,
    status,
    passed,
    failed,
    durationMs: Date.now() - startMs,
    capturedAt: new Date().toISOString(),
    // Trim verbose pino log lines from output before persisting
    output: output
      .split("\n")
      .filter((l) => !l.match(/^\[ntfy\]|\bINFO\b|\bDEBUG\b/))
      .join("\n")
      .trim(),
  };
  results.push(record);
  appendFileSync(FIXTURE_PATH, JSON.stringify(record) + "\n", "utf8");
}

const total = results.reduce((s, r) => s + r.passed + r.failed, 0);
const totalPass = results.reduce((s, r) => s + r.passed, 0);
const totalFail = results.reduce((s, r) => s + r.failed, 0);

console.log(`\n[stream-mint-probe] ${totalPass}/${total} passed, ${totalFail} failed`);
console.log(`[stream-mint-probe] fixture written to ${FIXTURE_PATH}`);

process.exit(exitCode);
