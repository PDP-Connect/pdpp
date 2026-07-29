// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds small, disposable, REAL git repositories shaped like a minimal
 * slice of reference-implementation/ — used by the mutation oracle
 * (mutation-oracle.ts) to prove the equivalence oracle discriminates real
 * defects, and by stage-a.test.ts / equivalence-oracle.test.ts for
 * unit-level coverage. A real git repo is required (not a plain directory)
 * because `trackedFiles()` (scripts/test-accounting/inventory.ts) shells
 * out to `git ls-files` — this tool's oracle must be tested against the
 * same primitive it uses in production, not a mock of it.
 *
 * IDENTITY HAZARD (packet-mandated): every git invocation here uses
 * `-c user.email=... -c user.name=...` PER CALL, never `git config
 * --global` or a persistent local config write, and every fixture lives
 * under a fresh `mkdtempSync` directory that is never the caller's own
 * worktree.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FIXTURE_GIT_EMAIL = "pdpp-t1-fixture@example.com";
const FIXTURE_GIT_NAME = "PDPP T1 Fixture";

export interface FixtureFile {
  content: string;
  path: string;
}

export interface FixtureRepo {
  dir: string;
  git: (args: string[]) => string;
  writeAndCommit: (files: FixtureFile[], message: string) => void;
}

function git(dir: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", `user.email=${FIXTURE_GIT_EMAIL}`, "-c", `user.name=${FIXTURE_GIT_NAME}`, ...args],
    {
      cwd: dir,
      encoding: "utf8",
    }
  );
}

/**
 * Creates a fresh, disposable git repository under a temp directory. The
 * caller is responsible for calling `disposeFixtureRepo` when done (or
 * relying on the caller's own try/finally, matching the
 * withTempTree/withTempDir convention used elsewhere in this tool's test
 * suite and in the harvested regression fixtures).
 */
export function createFixtureRepo(prefix = "pdpp-t1-fixture-"): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, ["init", "-q"]);
  git(dir, ["commit", "--allow-empty", "-q", "-m", "empty root"]);
  return {
    dir,
    git: (args: string[]) => git(dir, args),
    writeAndCommit(files: FixtureFile[], message: string): void {
      for (const file of files) {
        const absolute = join(dir, file.path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, file.content, "utf8");
      }
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", message]);
    },
  };
}

export function disposeFixtureRepo(repo: FixtureRepo): void {
  rmSync(repo.dir, { recursive: true, force: true });
}

/** Convenience: a minimal, real `test('name', fn)` node:test file body. */
export function nodeTestFileBody(testNames: string[], options: { skip?: Record<string, string> } = {}): string {
  const lines = ["import assert from 'node:assert/strict';", "import test from 'node:test';", ""];
  for (const name of testNames) {
    const skipExpr = options.skip?.[name];
    const optionsArg = skipExpr ? `, { skip: ${skipExpr} }` : "";
    lines.push(`test(${JSON.stringify(name)}${optionsArg}, () => {`, "  assert.equal(1, 1);", "});", "");
  }
  return lines.join("\n");
}
