// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Manifest } from "./test-accounting/inventory.ts";
import { accountingEventLine } from "./test-accounting/receipt.ts";
import { changedFiles, executedTests, selectFastTests, suiteArgv } from "./test-fast.ts";

const manifest: Manifest = {
  schema: "pdpp.test-accounting/v3",
  inventory_base_sha: "0".repeat(40),
  suites: ["display", "operator-ui"].map((id) => ({
    id,
    cwd: ".",
    loader: "node-test",
    authority_argument: null,
    command: ["node", "--test"],
    profiles: [{ id: "default", required: true, skip_reasons: {} }],
    include: [`packages/${id}/src/**/*.test.ts`],
  })),
  exclusions: [
    {
      path: "packages/display/src/release.test.ts",
      suite: "display",
      profile: "default",
      reason: "release gate",
      owner: "release",
      expires: "2027-12-31",
    },
  ],
};

const sources: Record<string, string> = {
  "packages/display/package.json": JSON.stringify({ name: "@pdpp/display", exports: { ".": "./src/index.ts" } }),
  "packages/display/src/index.ts": "export { label } from './label.ts';\n",
  "packages/display/src/label.ts": "export const label = 'a';\n",
  "packages/display/src/unused.ts": "export const unused = true;\n",
  "packages/display/src/label.test.ts": "import { label } from './index.ts';\n",
  "packages/display/src/other.test.ts": "export const other = true;\n",
  "packages/display/src/release.test.ts": "export const release = true;\n",
  "packages/operator-ui/package.json": JSON.stringify({ name: "@pdpp/operator-ui", exports: {} }),
  "packages/operator-ui/src/consumer.ts": "import { label } from '@pdpp/display';\nexport { label };\n",
  "packages/operator-ui/src/consumer.test.ts": "import './consumer.ts';\n",
  "packages/operator-ui/src/other.test.ts": "export const other = true;\n",
  "docs/notes.md": "notes\n",
  "package.json": "{}\n",
};

function fixture(): { root: string; files: string[]; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pdpp-test-fast-"));
  for (const [path, content] of Object.entries(sources)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, files: Object.keys(sources), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function selected(changed: string[]): { fallback: boolean; files: string[] } {
  const { root, files, cleanup } = fixture();
  try {
    const result = selectFastTests(root, manifest, files, changed);
    return { fallback: result.fallback, files: result.suites.flatMap((suite) => suite.files) };
  } finally {
    cleanup();
  }
}

test("changed test selects itself and excludes release-policy tests", () => {
  assert.deepEqual(selected(["packages/display/src/label.test.ts"]), {
    fallback: false,
    files: ["packages/display/src/label.test.ts"],
  });
  assert.deepEqual(selected(["packages/display/src/release.test.ts"]), { fallback: false, files: [] });
});

test("changed source selects only tests whose transitive imports reach it", () => {
  assert.deepEqual(selected(["packages/display/src/label.ts"]), {
    fallback: false,
    files: ["packages/display/src/label.test.ts", "packages/operator-ui/src/consumer.test.ts"],
  });
});

test("literal dynamic imports form graph edges", () => {
  const { root, files, cleanup } = fixture();
  try {
    writeFileSync(join(root, "packages/display/src/label.test.ts"), "await import('./label.ts');\n");
    const selection = selectFastTests(root, manifest, files, ["packages/display/src/label.ts"]);
    assert.equal(selection.fallback, false);
    assert.ok(
      selection.suites.find((suite) => suite.id === "display")?.files.includes("packages/display/src/label.test.ts")
    );
  } finally {
    cleanup();
  }
});

test("package change includes its tests and dependent importers", () => {
  assert.deepEqual(selected(["packages/display/package.json"]), {
    fallback: false,
    files: [
      "packages/display/src/label.test.ts",
      "packages/display/src/other.test.ts",
      "packages/operator-ui/src/consumer.test.ts",
    ],
  });
});

test("unknown, config, unmapped source and deleted files fall back to every default test", () => {
  for (const path of [
    "docs/notes.md",
    "package.json",
    "packages/display/src/unused.ts",
    "packages/display/src/deleted.ts",
  ]) {
    const result = selected([path]);
    assert.equal(result.fallback, true, path);
    assert.equal(result.files.length, 4, path);
  }
});

test("deleted tests trigger fallback without being passed to the test runner", () => {
  const { root, files, cleanup } = fixture();
  try {
    const deleted = "packages/display/src/label.test.ts";
    rmSync(join(root, deleted));
    const selection = selectFastTests(
      root,
      manifest,
      files.filter((path) => path !== deleted),
      [deleted]
    );
    assert.equal(selection.fallback, true);
    assert.deepEqual(selection.suites.find((suite) => suite.id === "display")?.files, [
      "packages/display/src/other.test.ts",
    ]);
  } finally {
    cleanup();
  }
});

test("no changes select no tests", () => {
  assert.deepEqual(selected([]), { fallback: false, files: [] });
});

test("git input includes committed, staged, unstaged and untracked paths but respects gitignore", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-test-fast-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(root, "committed.ts"), "a\n");
    writeFileSync(join(root, "staged.ts"), "a\n");
    writeFileSync(join(root, "unstaged.ts"), "a\n");
    git("add", ".gitignore", "committed.ts", "staged.ts", "unstaged.ts");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(join(root, "committed.ts"), "b\n");
    git("add", "committed.ts");
    git("commit", "-qm", "change");
    writeFileSync(join(root, "staged.ts"), "b\n");
    git("add", "staged.ts");
    writeFileSync(join(root, "unstaged.ts"), "b\n");
    writeFileSync(join(root, "untracked.ts"), "b\n");
    writeFileSync(join(root, "ignored.ts"), "b\n");
    assert.deepEqual(changedFiles(root, base).paths, ["committed.ts", "staged.ts", "unstaged.ts", "untracked.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a selected shell test file is passed to the manifest's shell leaf", () => {
  const suite = { ...manifest.suites[0], loader: "shell", command: ["bash", "leaf.sh"] } as Manifest["suites"][number];
  assert.deepEqual(suiteArgv(suite, ["scripts/a.test.sh"], "/repo", "/x/events"), [
    "bash",
    "leaf.sh",
    "scripts/a.test.sh",
  ]);
});

test("node suites print the spec reporter and write structured events, with the gate's local concurrency", () => {
  const node = { ...manifest.suites[0], command: ["node", "--test", "--test-reporter", "x/node-reporter.ts"] };
  assert.deepEqual(suiteArgv(node as Manifest["suites"][number], ["a.test.ts"], "/repo", "/x/events"), [
    "node",
    "--test",
    "--test-concurrency=2",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=/repo/x/node-reporter.ts",
    "--test-reporter-destination=/x/events",
    "a.test.ts",
  ]);
});

const event = (type: string, name: string, skip?: boolean | string) =>
  accountingEventLine({ type, details: { type: "test", name, ...(skip === undefined ? {} : { skip }) } });

test("the zero-test guard counts executed structured events and rejects spoofs", () => {
  assert.equal(
    executedTests("node-test", `${event("test:pass", "a")}\n${event("test:fail", "b")}\n`, ["r/a.test.ts"]),
    2
  );
  // A test that merely logs a spec-style summary produces no structured events.
  assert.equal(executedTests("node-test", "ℹ tests 12\nℹ pass 12\n", ["r/a.test.ts"]), 0);
  assert.equal(executedTests("node-test", "", ["r/a.test.ts"]), 0);
  assert.equal(
    executedTests(
      "node-test",
      `${event("test:pass", "a (skipped: no db)", true)}\n${event("test:pass", "b", "off")}\n`,
      ["r/a.test.ts"]
    ),
    0
  );
  // Node reports a test-less file as one passing event named after the file.
  assert.equal(executedTests("node-test", `${event("test:pass", "r/a.test.ts")}\n`, ["r/a.test.ts"]), 0);
  assert.equal(executedTests("shell", "PASS: fake\n", ["a.sh", "b.sh"]), 2);
});

const LABEL = "packages/display/src/label.ts";
const OTHER_TEST = "packages/display/src/other.test.ts";

function selectedAfter(edit: (root: string) => void, changed: string[]): string[] {
  const { root, files, cleanup } = fixture();
  try {
    edit(root);
    return selectFastTests(root, manifest, [...files, "packages/display/src/helper.ts"], changed).suites.flatMap(
      (suite) => suite.files
    );
  } finally {
    cleanup();
  }
}

test("a test whose helper has a computed import is selected by any source change", () => {
  const picked = selectedAfter(
    (root) => {
      writeFileSync(join(root, "packages/display/src/helper.ts"), "export const load = (name) => import(name);\n");
      writeFileSync(join(root, OTHER_TEST), "import './helper.ts';\n");
    },
    [LABEL]
  );
  assert.deepEqual(picked, [
    "packages/display/src/label.test.ts",
    OTHER_TEST,
    "packages/operator-ui/src/consumer.test.ts",
  ]);
});

test("computed imports, new URL(computed), require( and unparseable files all make a test a wildcard", () => {
  for (const body of [
    "await import('./' + name);\n",
    "new URL(name, import.meta.url);\n",
    "require (name);\n",
    "const = ;\n",
  ]) {
    const picked = selectedAfter((root) => writeFileSync(join(root, OTHER_TEST), body), [LABEL]);
    assert.ok(picked.includes(OTHER_TEST), body);
  }
});

test("site content producers are global inputs because generated content has no import edge", () => {
  for (const path of ["apps/site/source.config.ts", "apps/site/scripts/sync-spec-docs.mjs"]) {
    const { root, files, cleanup } = fixture();
    try {
      const selection = selectFastTests(root, manifest, [...files, path], [path]);
      assert.equal(selection.fallback, true, path);
      assert.ok(selection.reason?.startsWith("global input"), path);
    } finally {
      cleanup();
    }
  }
});

test("an import named only in a comment or a string is not an edge", () => {
  const { root, files, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "packages/display/src/other.test.ts"),
      "// import './label.ts';\n/* await import('./label.ts') */\nconst text = \"import './label.ts'\";\n"
    );
    const selection = selectFastTests(root, manifest, files, ["packages/display/src/label.ts"]);
    assert.equal(selection.fallback, false);
    assert.deepEqual(
      selection.suites.flatMap((suite) => suite.files),
      ["packages/display/src/label.test.ts", "packages/operator-ui/src/consumer.test.ts"]
    );
  } finally {
    cleanup();
  }
});
