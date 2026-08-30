// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// These CLI tests use a tiny Git repository because the boundary at risk is
// history plus final-tree comparison. A direct helper test would not prove the
// command resolves the supplied base, selects files from it, and then reads
// their real history together.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("./spec-date-check.ts", import.meta.url));
const WORKFLOW = fileURLToPath(new URL("../.github/workflows/spec-check.yml", import.meta.url));
const ZERO_SHA = "0".repeat(40);

interface Fixture {
  base: string;
  defaultBranch: string;
  root: string;
  writeSpec(text: string): void;
  commit(message: string, date: string): void;
}

function git(root: string, args: string[], date?: string): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: date
      ? {
          ...process.env,
          GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
          GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
        }
      : process.env,
  }).trim();
}

function fixture(date = "2026-01-01"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pdpp-spec-dates-"));
  mkdirSync(join(root, "scripts"));
  cpSync(CHECKER, join(root, "scripts", "spec-date-check.ts"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "user.name", "fixture"]);

  const writeSpec = (text: string) => writeFileSync(join(root, "spec-fixture.md"), text);
  writeSpec(["# Fixture", "", "Status: Draft", `Date: ${date}`, "", "Base body.", ""].join("\n"));
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"], date);

  return {
    base: git(root, ["rev-parse", "HEAD"]),
    defaultBranch: git(root, ["branch", "--show-current"]),
    root,
    writeSpec,
    commit(message: string, commitDate: string) {
      git(root, ["add", "."]);
      git(root, ["commit", "--quiet", "-m", message], commitDate);
    },
  };
}

function run(root: string, args: string[]) {
  return spawnSync("node", ["scripts/spec-date-check.ts", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function withFixture(action: (repo: Fixture) => void, date?: string): void {
  const repo = fixture(date);
  try {
    action(repo);
  } finally {
    rmSync(repo.root, { force: true, recursive: true });
  }
}

test("workflow passes the pull-request base SHA without a doubled pnpm argument boundary", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(
    workflow,
    /name: Check pull-request spec Date headers are not stale\n\s+if: github\.event_name == 'pull_request'\n\s+run: pnpm spec:dates --base "\$\{\{ github\.event\.pull_request\.base\.sha \}\}"/
  );
  assert.doesNotMatch(workflow, /pnpm spec:dates -- --base/);
});

test("workflow supplies the immutable push before SHA and fully checks branch creation", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(
    workflow,
    new RegExp(
      `name: Check push spec Date headers are not stale\\n\\s+if: github\\.event_name == 'push' && github\\.event\\.before != '${ZERO_SHA}'\\n\\s+run: pnpm spec:dates --base "\\$\\{\\{ github\\.event\\.before \\}\\}"`
    )
  );
  assert.match(
    workflow,
    new RegExp(
      `name: Check all spec Date headers are not stale\\n\\s+if: github\\.event_name == 'workflow_dispatch' \\|\\| \\(github\\.event_name == 'push' && github\\.event\\.before == '${ZERO_SHA}'\\)\\n\\s+run: pnpm spec:dates`
    )
  );
});

test("stale-date advice uses the dedicated write script entrypoint", () => {
  const checker = readFileSync(CHECKER, "utf8");
  assert.match(checker, /Run 'pnpm spec:dates:write' to stamp/);
  assert.doesNotMatch(checker, /pnpm spec:dates -- --write/);
});

test("--base excludes a restored spec across a no-fast-forward merge whose final blob matches that base", () => {
  withFixture((repo) => {
    git(repo.root, ["switch", "--quiet", "-c", "topic"]);
    repo.writeSpec("# Fixture\n\nStatus: Draft\nDate: 2026-01-01\n\nTemporary body.\n");
    repo.commit("substantive edit", "2026-01-02");
    repo.writeSpec("# Fixture\n\nStatus: Draft\nDate: 2026-01-01\n\nBase body.\n");
    repo.commit("restore base content", "2026-01-03");
    git(repo.root, ["switch", "--quiet", repo.defaultBranch]);
    git(repo.root, ["merge", "--quiet", "--no-ff", "topic"]);

    const result = run(repo.root, ["--base", repo.base]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed \(0 specs checked\)/);
  });
});

test("--base still checks a spec whose final content differs from that base", () => {
  withFixture((repo) => {
    repo.writeSpec("# Fixture\n\nStatus: Draft\nDate: 2026-01-01\n\nChanged body.\n");
    repo.commit("substantive edit", "2026-01-02");

    const result = run(repo.root, ["--base", repo.base]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /spec-fixture\.md: Date: 2026-01-01 is stale/);
  });
});

test("--base fails closed when its commit cannot be resolved, including GitHub's zero SHA", () => {
  withFixture((repo) => {
    for (const base of ["does-not-exist", ZERO_SHA]) {
      const result = run(repo.root, ["--base", base]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`--base must resolve to a commit: ${base}`));
    }
  });
});

test("default mode checks every root spec", () => {
  withFixture((repo) => {
    repo.writeSpec("# Fixture\n\nStatus: Draft\nDate: 2026-01-01\n\nChanged body.\n");
    repo.commit("substantive edit", "2026-01-02");

    const result = run(repo.root, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /spec-fixture\.md: Date: 2026-01-01 is stale/);
  });
});
