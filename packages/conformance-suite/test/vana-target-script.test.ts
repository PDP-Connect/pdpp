// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The Vana target script must never rewrite the checkout it is pointed at.
//
// WHAT THIS PROTECTS, and why it is a test rather than a comment. Until
// 2026-09-18 `scripts/vana-target.sh` composed its target by running
//
//   git -C "$PDPP_VANA_PS" checkout -B pdpp-conformance-composed "$VANA_REF"
//
// inside the caller's personal-server-ts checkout. That is a destructive write
// to a directory the script does not own: it moves whatever branch the caller
// had checked out onto a ref the script chose. It reset a live development
// branch three times in one day and dropped a commit that had already been
// pushed. Nothing failed loudly — a conformance run "succeeded" and the damage
// was only visible in the reflog.
//
// THE PLAUSIBLE DEFECT is that some later edit reintroduces a write to
// PDPP_VANA_PS: a `checkout`, a `reset`, a `merge` run in the wrong directory,
// or a `git worktree add` that names a branch instead of `--detach`. Every one
// of those is a one-word change and none of them is visible in a diff read
// quickly. So the oracle is behavioural, not textual: run the real script's
// real compose step against a throwaway repository and assert that the
// repository's branch, HEAD and working tree are byte-for-byte where they were.
//
// The fixture repository is built here rather than reused from anywhere on
// disk, because a test that damages a real checkout to prove the script does
// not damage checkouts would be self-defeating. Nothing outside the temp
// directory is touched.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "vana-target.sh");

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "conformance@pdpp.invalid",
      GIT_AUTHOR_NAME: "conformance",
      GIT_COMMITTER_EMAIL: "conformance@pdpp.invalid",
      GIT_COMMITTER_NAME: "conformance",
    },
  }).trim();
}

/**
 * A minimal stand-in for a personal-server-ts checkout: enough structure for
 * the script's own preflight checks (a packages/server directory and the
 * pdpp-auth.ts route it refuses to run without), two commits, and a named
 * branch checked out — so a stray `checkout -B` has something to destroy.
 */
function makeFixtureCheckout(): { readonly dir: string; readonly ref: string } {
  const root = mkdtempSync(join(tmpdir(), "pdpp-vana-guard-"));
  tempRoots.push(root);
  const dir = join(root, "personal-server-ts");
  mkdirSync(join(dir, "packages", "server", "src", "routes"), { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=main", dir);

  writeFileSync(join(dir, "packages", "server", "src", "routes", "pdpp-auth.ts"), "export const as = 1;\n");
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "base");
  const ref = git(dir, "rev-parse", "HEAD");

  // A second commit on a DIFFERENT branch, which is the branch left checked
  // out. The old code would have moved `pdpp-conformance-composed`, but the
  // damage in practice was to whatever branch the caller was on, so the
  // fixture reproduces that: HEAD is on a feature branch whose tip is not the
  // ref under test.
  git(dir, "checkout", "--quiet", "-b", "live-development-branch");
  writeFileSync(join(dir, "work-in-progress.ts"), "export const wip = 2;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "unpushed work");

  return { dir, ref };
}

function runCompose(checkout: string, ref: string): { readonly stateDir: string; readonly composedHead: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "pdpp-vana-guard-state-"));
  tempRoots.push(stateDir);
  const composedHead = execFileSync("bash", [SCRIPT, "compose"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PDPP_VANA_PS: checkout,
      PDPP_VANA_REF: ref,
      PDPP_VANA_STATE_DIR: stateDir,
    },
  }).trim();
  return { composedHead, stateDir };
}

test("composing a target leaves the caller's branch and HEAD exactly where they were", () => {
  const { dir, ref } = makeFixtureCheckout();

  const branchBefore = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  const headBefore = git(dir, "rev-parse", "HEAD");
  const statusBefore = git(dir, "status", "--porcelain");
  assert.equal(branchBefore, "live-development-branch");
  assert.notEqual(headBefore, ref, "fixture must have HEAD off the ref under test, or the test proves nothing");

  runCompose(dir, ref);

  assert.equal(
    git(dir, "rev-parse", "--abbrev-ref", "HEAD"),
    branchBefore,
    "vana-target.sh moved the caller's checkout onto a different branch"
  );
  assert.equal(
    git(dir, "rev-parse", "HEAD"),
    headBefore,
    "vana-target.sh moved the caller's HEAD. This is the 2026-09-18 defect: it dropped a pushed commit."
  );
  assert.equal(git(dir, "status", "--porcelain"), statusBefore, "vana-target.sh modified the caller's working tree");
});

test("composing a target creates no branch in the caller's repository", () => {
  const { dir, ref } = makeFixtureCheckout();
  const branchesBefore = git(dir, "branch", "--list", "--format=%(refname:short)");

  runCompose(dir, ref);

  // `--detach` is the whole mechanism: a worktree checked out on a named
  // branch would both create a ref here and make that branch unavailable to
  // the caller. Comparing the full branch list catches either.
  assert.equal(
    git(dir, "branch", "--list", "--format=%(refname:short)"),
    branchesBefore,
    "vana-target.sh created a branch in a repository it does not own"
  );
});

test("the composed tree is a separate directory checked out at the ref under test", () => {
  const { dir, ref } = makeFixtureCheckout();

  const { composedHead, stateDir } = runCompose(dir, ref);

  // The positive control: the guard above would also pass if the script had
  // quietly stopped composing anything at all. This asserts it really did
  // produce the requested tree, somewhere that is not the caller's checkout.
  assert.equal(composedHead, ref, "the composed worktree is not at the requested ref");
  const runDir = join(stateDir, "tree");
  assert.equal(git(runDir, "rev-parse", "HEAD"), ref);
  assert.notEqual(runDir, dir);
  assert.equal(
    git(runDir, "rev-parse", "--abbrev-ref", "HEAD"),
    "HEAD",
    "the private worktree must be detached, so it holds no branch the caller could want"
  );
});
