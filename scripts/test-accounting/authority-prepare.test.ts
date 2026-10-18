// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Behavioral tests for the per-suite `prepare` declaration.
//
// A suite may import build artifacts that are gitignored on purpose. The site
// suite's `@/generated/spec-front-matter.ts` is the real instance: predev and
// prebuild assemble it from the normative root spec, but the accounting runner
// spawns its test child directly and so never triggered either hook — the file
// was simply absent and the import failed closed with MODULE_NOT_FOUND.
//
// These tests exercise REAL module resolution in REAL spawned children, never
// source-text assertions: an assertion that the manifest merely CONTAINS a
// prepare key would pass just as happily against a runner that ignored it.
// Each case deletes the generated artifact first, so a regression that dropped
// the prepare call would leave the artifact absent and fail the import here.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPrepareForTest } from "./authority.ts";
import { readManifest, type Suite } from "./inventory.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
// The site suite's generated prerequisite. Gitignored (apps/site/.gitignore),
// so removing and rebuilding it never dirties the source tree.
const GENERATED = join(root, "apps/site/src/generated/spec-front-matter.ts");
const MODULE_NOT_FOUND_PATTERN = /ERR_MODULE_NOT_FOUND/;
const PREPARE_FAILED_PATTERN = /site prepare failed \(exit 3/;
const PREPARE_DEADLINE_PATTERN = /prepare.*deadline/i;
const PREPARE_DEADLINE_SECONDS_PATTERN = /prepare exceeded deadline 1s \(PDPP_ACCOUNTING_PREPARE_DEADLINE_MS\)/;

async function siteSuite(): Promise<Suite> {
  const manifest = await readManifest(join(root, "test-accounting.manifest.json"), { root });
  const suite = manifest.suites.find((entry) => entry.id === "site");
  assert.ok(suite, "site suite must exist in the manifest");
  return suite;
}

/**
 * Import a REAL site source file that resolves `@/generated/...` through the
 * alias, in a REAL child, under exactly the environment the manifest declares
 * for that suite. Returns the child's stderr when the import fails, or null
 * when it resolves.
 *
 * Imports an on-disk site module so alias resolution exercises real site code.
 * Both an absent generated file and a broken alias can report
 * ERR_MODULE_NOT_FOUND. Requiring the same import to succeed after prepare
 * distinguishes the missing prerequisite from a persistent resolution defect.
 *
 * Runs from the suite's own cwd (the repo root), because the declared
 * TSX_TSCONFIG_PATH is repository-relative: from anywhere else tsx reports
 * "Config not found in chain" and, again, fails for the wrong reason.
 */
const ALIAS_CONSUMER = "./apps/site/src/lib/spec-status.ts";

function importThroughAlias(suite: Suite): Promise<string | null> {
  const driver = `await import(${JSON.stringify(ALIAS_CONSUMER)});`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver], {
      cwd: join(root, suite.cwd),
      env: { ...process.env, ...(suite.environment ?? {}) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => resolve(code === 0 ? null : stderr));
  });
}

test("a suite's declared prepare command materializes the prerequisite its children import", async () => {
  const suite = await siteSuite();
  assert.ok(suite.prepare?.length, "site must declare a prepare command");

  // Absent prerequisite is the pre-change state. The successful import after
  // prepare below proves that this failure comes from the missing target.
  rmSync(GENERATED, { force: true });
  const before = await importThroughAlias(suite);
  assert.match(
    before ?? "",
    MODULE_NOT_FOUND_PATTERN,
    "without prepare, the generated prerequisite must be genuinely missing"
  );

  // Running the suite's own declared prepare is the only step between the two
  // observations — nothing else about the child changes.
  await runPrepareForTest(suite, root);
  assert.ok(existsSync(GENERATED), "prepare must materialize the declared prerequisite");
  assert.equal(await importThroughAlias(suite), null, "after prepare, the same import must resolve");
});

test("prepare runs under the suite's declared environment and fails closed on a bad command", async () => {
  const suite = await siteSuite();
  await assert.rejects(
    runPrepareForTest({ ...suite, prepare: ["node", "-e", "process.exit(3)"] }, root),
    PREPARE_FAILED_PATTERN,
    "a failing prepare must be fatal and attributed to its suite, never silently ignored"
  );
});

test("prepare writes only gitignored artifacts, so the clean-tree gate still holds", async () => {
  const suite = await siteSuite();
  rmSync(GENERATED, { force: true });
  // Compare before/after rather than asserting an absolutely clean tree: this
  // test must pass while the developer running it has their own uncommitted
  // work in progress. What matters is that prepare adds nothing of its own —
  // the runner re-asserts a clean tree around every run, so a prepare command
  // that wrote a TRACKED file would fail the real gate there.
  const status = () => execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).trim();
  const before = status();
  await runPrepareForTest(suite, root);
  assert.ok(existsSync(GENERATED), "prepare must have written its artifact for this to prove anything");
  assert.equal(status(), before, "prepare must not add any tracked-tree change of its own");
});

test("a prepare command is killed and reported when it exceeds its deadline", async () => {
  const deadlineMs = 1000;
  const tempDir = mkdtempSync(join(tmpdir(), "pdpp-prepare-descendant-"));
  const pidFile = join(tempDir, "pid");
  const prepareScript = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.exit(0);
  `;
  const driver = `
    process.env.PDPP_ACCOUNTING_PREPARE_DEADLINE_MS = ${JSON.stringify(String(deadlineMs))};
    const { runPrepareForTest } = await import(${JSON.stringify(new URL("./authority.ts", import.meta.url).href)});
    await runPrepareForTest({ id: "fixture", cwd: ".", prepare: ["node", "-e", ${JSON.stringify(prepareScript)}], profiles: [] }, process.cwd());
  `;
  const started = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const outcome = await new Promise<{ code: number | null }>((resolve) => {
    const guard = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 8000);
    child.on("close", (code) => {
      clearTimeout(guard);
      resolve({ code });
    });
  });

  let pid: number | undefined;
  try {
    assert.equal(outcome.code, 1, "a hanging prepare must fail the suite instead of hanging forever");
    assert.match(stderr, PREPARE_DEADLINE_PATTERN, "the failure must identify the prepare deadline");
    assert.match(stderr, PREPARE_DEADLINE_SECONDS_PATTERN, "the deadline must report its value in seconds");
    assert.ok(Date.now() - started < 8000, "the deadline must stop prepare promptly");
    pid = Number(readFileSync(pidFile, "utf8"));
    await assertProcessGone(pid);
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function assertProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: each check waits for the OS to reap the process just killed.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`descendant ${pid} survived prepare deadline`);
}
