// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves `getChangedFiles` against a REAL, isolated git repository driven by
 * real `git mv` / `mv` + `git add -A` / `git commit` — not a hand-assembled
 * `ChangedAndDeleted` shape. A synthetic shape can only prove `select.ts`'s
 * logic is internally consistent with an assumed git output; it cannot prove
 * the assumption about git's actual output is correct. This suite exists
 * because that exact gap (an untested assumption about how git reports a
 * rename) previously let a real `git mv` silently resolve to
 * `{"kind":"related","testFiles":[]}` and exit 0 having run zero tests.
 *
 * Each repo is a throwaway `mkdtemp` directory, `git init`'d fresh and
 * discarded in `after()` — never the real package's own git tree.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { getChangedFiles } from "./cli.ts";

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
}

function initRepo(repoRoot: string): void {
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
}

function commitAll(repoRoot: string, message: string): void {
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", message]);
}

describe("getChangedFiles: real git repository, real rename operations", () => {
  let repoRoot: string;

  before(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "related-tests-cli-real-git-"));
    initRepo(repoRoot);
    mkdirSync(join(repoRoot, "connectors", "acme"), { recursive: true });
    writeFileSync(join(repoRoot, "connectors", "acme", "index.ts"), "export const acme = 1;\n");
    commitAll(repoRoot, "initial: add connectors/acme/index.ts");
  });

  after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("a committed rename via `git mv` reports the old path as deleted, not silently dropped", () => {
    const baseRef = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    git(repoRoot, ["mv", "connectors/acme/index.ts", "connectors/acme/index-renamed.ts"]);
    commitAll(repoRoot, "rename via git mv");

    const { changedRelativePaths, deletedRelativePaths } = getChangedFiles(repoRoot, baseRef);

    assert.deepEqual(deletedRelativePaths, ["connectors/acme/index.ts"]);
    assert.deepEqual(changedRelativePaths, ["connectors/acme/index-renamed.ts"]);

    // Revert so later tests in this file start from the original committed shape.
    git(repoRoot, ["mv", "connectors/acme/index-renamed.ts", "connectors/acme/index.ts"]);
    commitAll(repoRoot, "revert rename");
  });

  test("a staged rename via `git mv` (uncommitted) reports the old path as deleted", () => {
    const baseRef = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    git(repoRoot, ["mv", "connectors/acme/index.ts", "connectors/acme/index-staged-renamed.ts"]);

    const { changedRelativePaths, deletedRelativePaths } = getChangedFiles(repoRoot, baseRef);

    assert.deepEqual(deletedRelativePaths, ["connectors/acme/index.ts"]);
    assert.deepEqual(changedRelativePaths, ["connectors/acme/index-staged-renamed.ts"]);

    git(repoRoot, ["reset", "-q", "HEAD", "--", "connectors/acme"]);
    git(repoRoot, ["checkout", "--", "connectors/acme/index.ts"]);
    rmSync(join(repoRoot, "connectors", "acme", "index-staged-renamed.ts"), { force: true });
  });

  test("an unstaged filesystem rename (plain `mv`, no `git add`) reports the old path as deleted", () => {
    const baseRef = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    renameSync(
      join(repoRoot, "connectors", "acme", "index.ts"),
      join(repoRoot, "connectors", "acme", "index-fs-renamed.ts")
    );

    const { changedRelativePaths, deletedRelativePaths } = getChangedFiles(repoRoot, baseRef);

    assert.deepEqual(deletedRelativePaths, ["connectors/acme/index.ts"]);
    assert.deepEqual(changedRelativePaths, ["connectors/acme/index-fs-renamed.ts"]);

    renameSync(
      join(repoRoot, "connectors", "acme", "index-fs-renamed.ts"),
      join(repoRoot, "connectors", "acme", "index.ts")
    );
  });

  test("a rename staged via `mv` + `git add -A` (the ordinary developer workflow) reports the old path as deleted", () => {
    const baseRef = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    renameSync(
      join(repoRoot, "connectors", "acme", "index.ts"),
      join(repoRoot, "connectors", "acme", "index-add-a-renamed.ts")
    );
    git(repoRoot, ["add", "-A", "--", "connectors/acme"]);
    const statusPorcelain = git(repoRoot, ["status", "--porcelain", "--", "connectors/acme"]);
    assert.match(statusPorcelain, /^R {2}/);

    const { changedRelativePaths, deletedRelativePaths } = getChangedFiles(repoRoot, baseRef);

    assert.deepEqual(deletedRelativePaths, ["connectors/acme/index.ts"]);
    assert.deepEqual(changedRelativePaths, ["connectors/acme/index-add-a-renamed.ts"]);

    git(repoRoot, ["reset", "-q", "HEAD", "--", "connectors/acme"]);
    git(repoRoot, ["checkout", "--", "connectors/acme/index.ts"]);
    rmSync(join(repoRoot, "connectors", "acme", "index-add-a-renamed.ts"), { force: true });
  });

  test("a rename plus a small edit (high similarity, git would classify as a rename) still reports the old path as deleted", () => {
    const original = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join("\n");
    writeFileSync(join(repoRoot, "connectors", "acme", "index.ts"), `${original}\n`);
    commitAll(repoRoot, "grow index.ts before rename+edit");
    const baseRef = git(repoRoot, ["rev-parse", "HEAD"]).trim();

    git(repoRoot, ["mv", "connectors/acme/index.ts", "connectors/acme/index-renamed-edited.ts"]);
    writeFileSync(
      join(repoRoot, "connectors", "acme", "index-renamed-edited.ts"),
      `${original}\nexport const tail = 1;\n`
    );
    git(repoRoot, ["add", "-A"]);

    // Confirm git itself would call this a high-similarity rename without --no-renames.
    const renameStatus = git(repoRoot, ["diff", "--cached", "-M", "--diff-filter=R", "--name-status"]);
    assert.match(renameStatus, /^R\d{3}\t/);

    const { changedRelativePaths, deletedRelativePaths } = getChangedFiles(repoRoot, baseRef);

    assert.deepEqual(deletedRelativePaths, ["connectors/acme/index.ts"]);
    assert.deepEqual(changedRelativePaths, ["connectors/acme/index-renamed-edited.ts"]);

    git(repoRoot, ["reset", "-q", "HEAD", "--", "connectors/acme"]);
    git(repoRoot, ["checkout", "--", "connectors/acme/index.ts"]);
    rmSync(join(repoRoot, "connectors", "acme", "index-renamed-edited.ts"), { force: true });
  });

  test("a rename to a path with spaces and non-ASCII characters still reports the old path as deleted and the new path is not silently dropped", () => {
    const baseRef = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    mkdirSync(join(repoRoot, "connectors", "acme", "weird dir"), { recursive: true });
    git(repoRoot, ["mv", "connectors/acme/index.ts", "connectors/acme/weird dir/idx é.ts"]);

    const { changedRelativePaths, deletedRelativePaths } = getChangedFiles(repoRoot, baseRef);

    assert.deepEqual(deletedRelativePaths, ["connectors/acme/index.ts"]);
    assert.deepEqual(changedRelativePaths, ["connectors/acme/weird dir/idx é.ts"]);

    git(repoRoot, ["reset", "-q", "HEAD", "--", "connectors/acme"]);
    git(repoRoot, ["checkout", "--", "connectors/acme/index.ts"]);
    rmSync(join(repoRoot, "connectors", "acme", "weird dir"), { recursive: true, force: true });
  });

  test("an added file with a non-ASCII name is reported, not silently dropped by path-quoting", () => {
    const baseRef = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repoRoot, "connectors", "acme", "café-módulo.ts"), "export const x = 1;\n");
    git(repoRoot, ["add", "--", "connectors/acme/café-módulo.ts"]);

    const { changedRelativePaths, deletedRelativePaths } = getChangedFiles(repoRoot, baseRef);

    assert.deepEqual(deletedRelativePaths, []);
    assert.deepEqual(changedRelativePaths, ["connectors/acme/café-módulo.ts"]);

    git(repoRoot, ["reset", "-q", "HEAD", "--", "connectors/acme"]);
    rmSync(join(repoRoot, "connectors", "acme", "café-módulo.ts"), { force: true });
  });

  test("a plain deletion (no rename) still reports the old path as deleted", () => {
    const baseRef = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    rmSync(join(repoRoot, "connectors", "acme", "index.ts"));

    const { changedRelativePaths, deletedRelativePaths } = getChangedFiles(repoRoot, baseRef);

    assert.deepEqual(deletedRelativePaths, ["connectors/acme/index.ts"]);
    assert.deepEqual(changedRelativePaths, []);

    git(repoRoot, ["checkout", "--", "connectors/acme/index.ts"]);
  });

  test("a truly empty diff (HEAD against itself, clean tree) reports no changes and no deletions", () => {
    const baseRef = git(repoRoot, ["rev-parse", "HEAD"]).trim();

    const { changedRelativePaths, deletedRelativePaths } = getChangedFiles(repoRoot, baseRef);

    assert.deepEqual(changedRelativePaths, []);
    assert.deepEqual(deletedRelativePaths, []);
  });
});
