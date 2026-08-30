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

test("workflow supplies the pull-request base SHA to the date checker", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(
    workflow,
    /name: Check pull-request spec Date headers are not stale\n\s+if: github\.event_name == 'pull_request'\n\s+run: pnpm spec:dates -- --base "\$\{\{ github\.event\.pull_request\.base\.sha \}\}"/
  );
});

test("workflow supplies the immutable push before SHA and fully checks branch creation", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(
    workflow,
    new RegExp(
      `name: Check push spec Date headers are not stale\\n\\s+if: github\\.event_name == 'push' && github\\.event\\.before != '${ZERO_SHA}'\\n\\s+run: pnpm spec:dates -- --base "\\$\\{\\{ github\\.event\\.before \\}\\}"`
    )
  );
  assert.match(
    workflow,
    new RegExp(
      `name: Check all spec Date headers are not stale\\n\\s+if: github\\.event_name == 'workflow_dispatch' \\|\\| \\(github\\.event_name == 'push' && github\\.event\\.before == '${ZERO_SHA}'\\)\\n\\s+run: pnpm spec:dates`
    )
  );
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

test("a deletion-only body edit is substantive, even though its new-side range collapses to the header boundary", () => {
  withFixture((repo) => {
    // Base body is a single line, so deleting it produces `@@ -6 +5,0 @@` from
    // a real `git -U0` diff: new-side start(5)+count(0)-1 = 4, which sits
    // exactly at HEADER_LINE_COUNT. The old code only ever looked at the new
    // side, so this collapsed range was misread as "still inside the header"
    // and the deletion was silently ignored.
    repo.writeSpec("# Fixture\n\nStatus: Draft\nDate: 2026-01-01\n\n");
    repo.commit("delete the only body line", "2026-01-02");

    const result = run(repo.root, ["--base", repo.base]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /spec-fixture\.md: Date: 2026-01-01 is stale/);
  });
});

test("a replacement hunk that crosses from the header into the body is substantive", () => {
  withFixture((repo) => {
    // Base spec has a one-line header gap; rewrite lines 4-5 (Date line plus
    // the following blank line) together with a body change so the hunk's
    // range spans both the header and the body in one edit.
    repo.writeSpec("# Fixture\n\nStatus: Draft\nDate: 2026-01-01\nRevised body.\n");
    repo.commit("replace across header/body boundary", "2026-01-02");

    const result = run(repo.root, ["--base", repo.base]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /spec-fixture\.md: Date: 2026-01-01 is stale/);
  });
});

test("an insertion-only body edit is substantive", () => {
  withFixture((repo) => {
    repo.writeSpec("# Fixture\n\nStatus: Draft\nDate: 2026-01-01\n\nBase body.\nInserted line.\n");
    repo.commit("insert a new body line", "2026-01-02");

    const result = run(repo.root, ["--base", repo.base]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /spec-fixture\.md: Date: 2026-01-01 is stale/);
  });
});

test("a pure header edit (Date stamp) is not substantive", () => {
  withFixture((repo) => {
    repo.writeSpec("# Fixture\n\nStatus: Draft\nDate: 2026-01-02\n\nBase body.\n");
    repo.commit("stamp date only", "2026-01-02");

    const result = run(repo.root, ["--base", repo.base]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed \(1 spec checked\)/);
  });
});

test("a body-only whitespace edit (blank-line reflow) is not substantive", () => {
  withFixture((repo) => {
    // isHeaderOnlyOrWhitespaceHunk treats an added/removed line as
    // whitespace-only when its trimmed content is empty — a blank-line
    // reflow, per the file's own policy comment — not a trailing-space
    // change to a line that has real content (that's a content-line change).
    repo.writeSpec("# Fixture\n\nStatus: Draft\nDate: 2026-01-01\n\nBase body.\n\n");
    repo.commit("blank-line reflow only", "2026-01-02");

    const result = run(repo.root, ["--base", repo.base]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed \(1 spec checked\)/);
  });
});
