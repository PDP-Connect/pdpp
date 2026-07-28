// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * stream-mint-probe.ts
 *
 * Deterministic, OTP-free probe for the run-interaction streaming path.
 * Runs the authoritative streaming test suite and captures output to
 * tmp/workstreams/stream-debug/<timestamp>-probe.jsonl so failures are debuggable without
 * a live connector or owner interaction.
 *
 * Usage:
 *   node --import tsx scripts/stream-mint-probe.ts
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
const TIMESTAMP_SANITIZE_PATTERN = /[:.]/g;
const NOW = new Date().toISOString().replace(TIMESTAMP_SANITIZE_PATTERN, "-");
const FIXTURE_PATH = join(DEBUG_DIR, `${NOW}-stream-mint-probe.jsonl`);

mkdirSync(DEBUG_DIR, { recursive: true });

const TEST_FILES = [
  "reference-implementation/test/run-interaction-stream-routes.test.ts",
  "reference-implementation/test/run-interaction-stream-neko-adapter.test.ts",
  "reference-implementation/test/run-interaction-stream-playground.test.ts",
  "reference-implementation/test/neko-surface-allocator-server.test.ts",
  "reference-implementation/test/neko-surface-allocator.test.ts",
];

console.log(`[stream-mint-probe] running ${TEST_FILES.length} test files`);
console.log(`[stream-mint-probe] fixture -> ${FIXTURE_PATH}\n`);

interface ProbeRecord {
  capturedAt: string;
  durationMs: number;
  failed: number;
  file: string;
  output: string;
  passed: number;
  probe: string;
  status: "pass" | "fail";
}

let exitCode = 0;
const results: ProbeRecord[] = [];

const NODE_TEST_PASS_PATTERN = /^ℹ pass (\d+)/;
const NODE_TEST_FAIL_PATTERN = /^ℹ fail (\d+)/;
const NOISY_LOG_LINE_PATTERN = /^\[ntfy\]|\bINFO\b|\bDEBUG\b/;

interface ExecError {
  message: string;
  stdout?: string;
}

for (const file of TEST_FILES) {
  const label = file.split("/").pop() ?? file;
  const startMs = Date.now();
  let output = "";
  let passed = 0;
  let failed = 0;
  let status: "pass" | "fail" = "pass";

  try {
    output = execFileSync(process.execPath, ["--test", file], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Parse node:test summary lines for counts.
    for (const line of output.split("\n")) {
      const passMatch = NODE_TEST_PASS_PATTERN.exec(line);
      const failMatch = NODE_TEST_FAIL_PATTERN.exec(line);
      if (passMatch?.[1]) {
        passed = Number.parseInt(passMatch[1], 10);
      }
      if (failMatch?.[1]) {
        failed = Number.parseInt(failMatch[1], 10);
      }
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
    const execErr = err as ExecError;
    output = execErr.stdout || execErr.message;
    console.error(`  FAIL ${label}  ERROR: ${execErr.message.split("\n")[0]}`);
  }

  const record: ProbeRecord = {
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
      .filter((l) => !NOISY_LOG_LINE_PATTERN.test(l))
      .join("\n")
      .trim(),
  };
  results.push(record);
  appendFileSync(FIXTURE_PATH, `${JSON.stringify(record)}\n`, "utf8");
}

const total = results.reduce((s, r) => s + r.passed + r.failed, 0);
const totalPass = results.reduce((s, r) => s + r.passed, 0);
const totalFail = results.reduce((s, r) => s + r.failed, 0);

console.log(`\n[stream-mint-probe] ${totalPass}/${total} passed, ${totalFail} failed`);
console.log(`[stream-mint-probe] fixture written to ${FIXTURE_PATH}`);

process.exit(exitCode);
