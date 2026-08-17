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
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runPrepareForTest } from "./authority.ts";
import { readManifest, type Suite } from "./inventory.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
// The site suite's generated prerequisite. Gitignored (apps/site/.gitignore),
// so removing and rebuilding it never dirties the source tree.
const GENERATED = join(root, "apps/site/src/generated/spec-front-matter.ts");
const MODULE_NOT_FOUND_PATTERN = /Cannot find module/;
const PREPARE_FAILED_PATTERN = /site prepare failed \(exit 3/;

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
 * Deliberately imports an on-disk file rather than using `node -e`: tsx anchors
 * tsconfig `paths` to the importing file's location, so an `-e` string (which
 * has no location) fails with a bare "Cannot find package '@/generated'" before
 * the alias is ever applied. That would make the pre-change assertion below pass
 * for the wrong reason — a baseline resolution failure rather than the absent
 * prerequisite this gate is about.
 *
 * Runs from the suite's own cwd (the repo root), because the declared
 * TSX_TSCONFIG_PATH is repository-relative: from anywhere else tsx reports
 * "Config not found in chain" and, again, fails for the wrong reason.
 */
const ALIAS_CONSUMER = "./apps/site/src/components/pdpp-concept/spec-status.ts";

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

  // Absent prerequisite is the pre-change state: the alias resolves (tsx reads
  // the declared tsconfig) but the target file does not exist.
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
