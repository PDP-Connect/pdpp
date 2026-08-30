// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// These CLI tests use a tiny Git repository because the boundary at risk is
// history plus final-tree comparison. A direct helper test would not prove the
// command resolves the supplied base, selects files from it, and then reads
// their real history together.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("./spec-date-check.ts", import.meta.url));

interface Fixture {
  base: string;
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

test("--base excludes a restored spec whose final content matches that base", () => {
  withFixture((repo) => {
    repo.writeSpec("# Fixture\n\nStatus: Draft\nDate: 2026-01-01\n\nTemporary body.\n");
    repo.commit("substantive edit", "2026-01-02");
    repo.writeSpec("# Fixture\n\nStatus: Draft\nDate: 2026-01-01\n\nBase body.\n");
    repo.commit("restore base content", "2026-01-03");

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

test("--base fails closed when its commit cannot be resolved", () => {
  withFixture((repo) => {
    const result = run(repo.root, ["--base", "does-not-exist"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--base must resolve to a commit: does-not-exist/);
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
