// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { assertArtifactReceipt, bindNodeEnvironment, gitHeadSha } from "../scripts/artifact-receipt.ts";
import { discoverTestFiles, needsTsx } from "../scripts/discover-tests.ts";
import { assertManifestTargets } from "../scripts/package-contract.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function makeManifest(overrides = {}) {
  return {
    name: "@pdpp/cli",
    bin: { pdpp: "./dist/bin/pdpp.js" },
    exports: { ".": "./dist/src/index.js" },
    files: ["dist/", "README.md"],
    ...overrides,
  };
}

function emittedFixture({ executable = true, shebang = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pdpp-cli-artifact-contract-"));
  mkdirSync(join(root, "dist", "bin"), { recursive: true });
  mkdirSync(join(root, "dist", "src"), { recursive: true });
  writeFileSync(join(root, "dist", "src", "index.js"), "export const artifact = true;\n");
  writeFileSync(
    join(root, "dist", "bin", "pdpp.js"),
    `${shebang ? "#!/usr/bin/env node\n" : ""}console.log('pdpp');\n`
  );
  chmodSync(join(root, "dist", "bin", "pdpp.js"), executable ? 0o755 : 0o644);
  return root;
}

test("artifact contract rejects a missing declared export", () => {
  const root = emittedFixture();
  assert.throws(
    () => assertManifestTargets(makeManifest({ exports: { ".": "./dist/src/missing.js" } }), root),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    /is missing/
  );
});

test("artifact contract rejects a missing declared bin", () => {
  const root = emittedFixture();
  assert.throws(
    () => assertManifestTargets(makeManifest({ bin: { pdpp: "./dist/bin/missing.js" } }), root),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    /is missing/
  );
});

test("artifact contract rejects source-only package targets", () => {
  const root = emittedFixture();
  assert.throws(
    () => assertManifestTargets(makeManifest({ exports: { ".": "./src/index.js" } }), root),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    /must point into \.\/dist\//
  );
});

test("artifact contract rejects a bin that loses its executable mode", () => {
  const root = emittedFixture({ executable: false });
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.throws(() => assertManifestTargets(makeManifest(), root), /must be executable/);
});

test("artifact contract rejects a bin that loses its shebang", () => {
  const root = emittedFixture({ shebang: false });
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.throws(() => assertManifestTargets(makeManifest(), root), /must retain its node shebang/);
});

test("extension-complete discovery and loader selection are exact", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-cli-test-discovery-"));
  const cases = [
    { extension: "js", needsTsx: false },
    { extension: "mjs", needsTsx: false },
    { extension: "cjs", needsTsx: false },
    { extension: "ts", needsTsx: true },
    { extension: "mts", needsTsx: true },
    { extension: "cts", needsTsx: true },
  ];
  const expected = cases
    .map(({ extension }) => join(root, `renamed-contract.test.${extension}`))
    .sort((a, b) => a.localeCompare(b));
  for (const file of expected) {
    writeFileSync(file, "export {};\n");
  }
  const unsupported = join(root, "renamed-contract.test.jsx");
  writeFileSync(unsupported, "export {};\n");
  writeFileSync(join(root, "not-a-test.ts"), "export {};\n");

  const files = await discoverTestFiles(root);
  assert.deepEqual(files, expected);
  assert.equal(files.includes(unsupported), false);

  const jsFamily = cases
    .filter(({ needsTsx: expectsTsx }) => !expectsTsx)
    .map(({ extension }) => join(root, `renamed-contract.test.${extension}`));
  assert.equal(needsTsx(jsFamily), false);
  for (const { extension } of cases.filter(({ needsTsx: expectsTsx }) => expectsTsx)) {
    assert.equal(needsTsx([join(root, `renamed-contract.test.${extension}`)]), true);
  }
});

test("artifact receipt rejects a child runtime that escapes the pinned Node", () => {
  const receipt = {
    nodeVersion: "v22.14.0",
    gitHeadSha: "head",
    packageContentSha256: "content",
    tarballSha256: "tarball",
    subprocesses: [{ label: "npx pdpp --help", version: "v25.8.2", execPath: "/other/node" }],
  };

  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.throws(() => assertArtifactReceipt(receipt, { nodeVersion: "v22.14.0" }), /escaped the pinned Node runtime/);
});

test("artifact receipt binds revision, content, and tarball identities", () => {
  const receipt = {
    nodeVersion: "v22.14.0",
    gitHeadSha: "head",
    packageContentSha256: "content",
    tarballSha256: "tarball",
    nodeExecPath: "/node-22.14/bin/node",
    subprocesses: [{ label: "pnpm build", version: "v22.14.0", execPath: "/node-22.14/bin/node" }],
  };

  assert.doesNotThrow(() =>
    assertArtifactReceipt(receipt, {
      nodeVersion: "v22.14.0",
      nodeExecPath: "/node-22.14/bin/node",
      gitHeadSha: "head",
      packageContentSha256: "content",
      tarballSha256: "tarball",
    })
  );
  assert.throws(
    () => assertArtifactReceipt({ ...receipt, tarballSha256: "changed" }, { tarballSha256: "tarball" }),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    /tarball binding changed/
  );
  assert.throws(
    () => assertArtifactReceipt({ ...receipt, gitHeadSha: "changed" }, { gitHeadSha: "head" }),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    /revision binding changed/
  );
  assert.throws(
    () => assertArtifactReceipt({ ...receipt, packageContentSha256: "changed" }, { packageContentSha256: "content" }),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    /content binding changed/
  );
  assert.throws(
    () => assertArtifactReceipt(receipt, { nodeVersion: "v22.14.0", nodeExecPath: "/other/node" }),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    /Node executable binding changed/
  );
});

test("Node gate environment puts the exact executable directory first", () => {
  const env = bindNodeEnvironment({ PATH: "/other/bin" }, "/node-22.14/bin/node");
  assert.equal(env.PATH, ["/node-22.14/bin", "/other/bin"].join(":"));
});

test("artifact receipt accepts only an explicitly bound full commit SHA without git", () => {
  const previous = process.env.PDPP_ARTIFACT_GIT_HEAD_SHA;
  try {
    process.env.PDPP_ARTIFACT_GIT_HEAD_SHA = "a".repeat(40);
    assert.equal(gitHeadSha("/path/without/a/git/repository"), "a".repeat(40));
    process.env.PDPP_ARTIFACT_GIT_HEAD_SHA = "not-a-commit";
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.throws(() => gitHeadSha("/path/without/a/git/repository"), /must bind one full commit SHA/);
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_ARTIFACT_GIT_HEAD_SHA;
    } else {
      process.env.PDPP_ARTIFACT_GIT_HEAD_SHA = previous;
    }
  }
});

test("the checked-in package contract points only at emitted files", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => assertManifestTargets(manifest, packageRoot));
});
