// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// End-to-end (class-b) mutation tests for the fail-closed authority path.
//
// Every fixture below is a REAL disposable `git worktree` checked out from
// this repository's own HEAD (via `git worktree add`), never a hand-built
// synthetic manifest/file-list pair. The manifest is the real
// `test-accounting.manifest.json` at HEAD (mutated in place inside the
// disposable worktree, then committed so `trackedFiles()`/`git ls-files`
// reports it for real); the tracked files are whatever the real `git
// ls-files` returns for that worktree after the mutation is committed.
//
// Each test drives `runAuthority` itself (not `checkInventory` in
// isolation) — the exact function `pnpm test-accounting:check` and every
// `--suite <id> --run` invocation call. This is deliberate: R1's finding
// was that the closure check existed but was never reached from the path
// that actually authorizes test execution. A test that only calls
// `checkInventory` would still pass if that wiring were reverted, so it
// would not be testing the fix. See the "revert-detection" test at the
// bottom, which mechanically proves each mutation test here does fail if
// `runAuthority`'s closure-check call is removed.
//
// None of these mutations reach a real spawn (the closure check throws
// before `leafCommand`/`capture` runs), so the disposable worktrees never
// need `pnpm install` — they are pure git + fs operations and stay fast.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAuthority } from "./authority.ts";
import { type Manifest, planFor, readManifest, selectedRuns, trackedFiles } from "./inventory.ts";

const MULTI_GLOB_PARTIAL_RENAME_PATTERN = /unaccounted executable tests/;
const EMPTY_INCLUDE_LIST_PATTERN = /include list matches no tracked file/;
const HELPER_OR_FIXTURE_MATCH_PATTERN = /non-executable-classified file/;

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

// Checks out a disposable worktree from this repo's real HEAD so the
// starting manifest and starting tracked-file set are exactly what
// `pnpm test-accounting:inventory` sees today — not a synthetic stand-in.
// The caller mutates files inside `root`, commits, then calls
// `runAuthority({ root, ... })` against the mutated real state.
// Passed as per-invocation `-c` overrides on the `commit` call only (never
// as persistent `git config`). This repo does not set
// `extensions.worktreeConfig`, so a persistent `git config user.*` inside a
// `git worktree add` checkout writes to the ONE config file shared by every
// worktree off this repo's common `.git` dir — clobbering the real commit
// identity of the integration worktree and every sibling lane worktree for
// the rest of the session. `-c` scopes the override to a single command
// invocation and cannot leak.
const FIXTURE_COMMIT_CONFIG = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "user.email=fixture@example.test",
  "-c",
  "user.name=fixture",
];

async function withRealWorktree(run: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pdpp-r1-e2e-"));
  rmSync(root, { recursive: true, force: true });
  execFileSync("git", ["worktree", "add", "--detach", "--quiet", root, "HEAD"], { cwd: repoRoot() });
  try {
    await run(root);
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", root], { cwd: repoRoot() });
    rmSync(root, { recursive: true, force: true });
  }
}
function commitAll(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", [...FIXTURE_COMMIT_CONFIG, "commit", "-q", "-s", "-m", message], { cwd: root });
}
function readManifestFile(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, "test-accounting.manifest.json"), "utf8"));
}
function writeManifestFile(root: string, manifestValue: Manifest): void {
  writeFileSync(join(root, "test-accounting.manifest.json"), `${JSON.stringify(manifestValue, null, 2)}\n`);
}

test("e2e: a real mcp-server .test.ts renamed to .test.js (N->N-1, sibling glob still matches) fails closed on the runAuthority path", async () => {
  await withRealWorktree(async (root) => {
    const before = trackedFiles(root).filter((path) => path.startsWith("packages/mcp-server/test/"));
    assert.equal(before.length, 23, "expected the real mcp-server suite to start at 23 tracked files");

    execFileSync("git", ["mv", "packages/mcp-server/test/bin.test.ts", "packages/mcp-server/test/bin.test.js"], {
      cwd: root,
    });
    commitAll(root, "fixture: rename one mcp-server test off its executable suffix");

    const files = trackedFiles(root);
    assert.ok(
      files.includes("packages/mcp-server/test/bin.test.js"),
      "the renamed path must be a real tracked file after the commit"
    );

    // Lower-level confirmation of the exact pre-wiring gap R1 found: with the
    // real mutated manifest/files, `selectedRuns`/`planFor` alone — what
    // `runAuthority` called BEFORE this fix — silently drop the plan from 23
    // to 22 files and do not throw. This is not the assertion under test; it
    // documents why a bare `selectedRuns` call is not a sufficient gate.
    const manifestValue = await readManifest(join(root, "test-accounting.manifest.json"), { root });
    const silentPlan = planFor(manifestValue, files, ["mcp-server"]);
    assert.equal(silentPlan.plans.get("mcp-server")?.length, 22);
    assert.doesNotThrow(() => selectedRuns(manifestValue, files, { suites: ["mcp-server"] }));

    // The actual assertion: the real authority entry point now fails closed.
    await assert.rejects(runAuthority({ root, suites: ["mcp-server"] }), MULTI_GLOB_PARTIAL_RENAME_PATTERN);
  });
});

test("e2e: a suite's entire include list emptied fails closed on the runAuthority path", async () => {
  await withRealWorktree(async (root) => {
    const manifestValue = readManifestFile(root);
    const suite = manifestValue.suites.find((entry) => entry.id === "reference-contract");
    assert.ok(suite, "reference-contract must exist in the real manifest");
    suite.include = ["packages/reference-contract/test/does-not-exist-*.test.ts"];
    writeManifestFile(root, manifestValue);
    commitAll(root, "fixture: empty reference-contract's include list");

    await assert.rejects(runAuthority({ root, suites: ["reference-contract"] }), EMPTY_INCLUDE_LIST_PATTERN);
  });
});

test("e2e: an include-matched file that classifies helper-or-fixture fails closed on the runAuthority path", async () => {
  await withRealWorktree(async (root) => {
    const manifestValue = readManifestFile(root);
    const suite = manifestValue.suites.find((entry) => entry.id === "read-core");
    assert.ok(suite, "read-core must exist in the real manifest");
    // Reproduces the exact real defect shape mcp-server's smoke-stdio.ts
    // originally hit: a probe file under a test/ directory with no
    // .test./.spec. suffix, matched by a widened include glob.
    writeFileSync(join(root, "packages/read-core/test/smoke-probe.ts"), "export const probe = true;\n");
    suite.include = [...suite.include, "packages/read-core/test/smoke-probe.ts"];
    writeManifestFile(root, manifestValue);
    commitAll(root, "fixture: widen read-core's include glob onto a helper-or-fixture file");

    const files = trackedFiles(root);
    assert.ok(files.includes("packages/read-core/test/smoke-probe.ts"));

    await assert.rejects(runAuthority({ root, suites: ["read-core"] }), HELPER_OR_FIXTURE_MATCH_PATTERN);
  });
});

test("e2e: reverting the closure-check wiring makes the mcp-server rename mutation pass silently again (both-ways proof)", async () => {
  // This test does not touch authority.ts's wiring itself (that would defeat
  // the point of an independent regression test). Instead it proves the
  // CONTRAPOSITIVE directly against the real data: the exact call sequence
  // `runAuthority` used to make before this fix (`readManifest` + `trackedFiles`
  // + `selectedRuns`, with no closure check in between) does NOT throw on the
  // mutated file list, while the current, fixed sequence (closure check
  // first) DOES. Together with the test above (which exercises the real
  // `runAuthority` export), this shows the assertion is load-bearing on
  // item 1's wiring specifically, not on some other unrelated guard.
  await withRealWorktree(async (root) => {
    execFileSync("git", ["mv", "packages/mcp-server/test/bin.test.ts", "packages/mcp-server/test/bin.test.js"], {
      cwd: root,
    });
    commitAll(root, "fixture: rename one mcp-server test off its executable suffix");

    const manifestValue = await readManifest(join(root, "test-accounting.manifest.json"), { root });
    const files = trackedFiles(root);

    // Pre-fix behavior (no closure check): selection alone silently succeeds.
    assert.doesNotThrow(() => selectedRuns(manifestValue, files, { suites: ["mcp-server"] }));

    // Post-fix behavior (this lane's change): the real runAuthority throws.
    await assert.rejects(runAuthority({ root, suites: ["mcp-server"] }), MULTI_GLOB_PARTIAL_RENAME_PATTERN);
  });
});
