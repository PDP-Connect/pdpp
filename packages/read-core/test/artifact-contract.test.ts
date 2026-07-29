// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertRunnableTestFiles, discoverTestFiles } from "../scripts/discover-tests.ts";
import { assertNpmBinding } from "../scripts/npm-runtime.ts";
import { assertManifestTargets, assertPackedFiles } from "../scripts/validate-package.ts";
import { assertExactRuntime, exactNodeVersion } from "../scripts/verify-node-22.14.ts";

const buildCommandPattern = /"pnpm", \["exec", "tsc", "--project", "tsconfig\.build\.json"\]/;
const forbiddenBuildCommandPattern = /--noEmit|copyFile/;
const execPathPattern = /process\.execPath/;
const floatingRuntimePattern = /node@22\.14\.0|npx|latest|lts\//;
const runtimeFloorErrorPattern = /requires Node v22\.14\.0/;
const executableDriftPattern = /npm executable drifted/;
const versionDriftPattern = /npm version drifted/;
const missingFilePattern = /ENOENT/;
const missingPackedMainPattern = /missing packed main target/;
const sourceLeakPattern = /missing packed export target|source file leaked/;
const missingRuntimePattern = /without a configured runtime/;

test("build delegates dist emission to TypeScript rather than copying source", async () => {
  const buildScript = await readFile(new URL("../scripts/build.ts", import.meta.url), "utf8");
  assert.match(buildScript, buildCommandPattern);
  assert.doesNotMatch(buildScript, forbiddenBuildCommandPattern);
});

test("the exact Node floor is an explicit matrix artifact gate", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const matrixScript = await readFile(new URL("../scripts/verify-node-22.14.ts", import.meta.url), "utf8");
  assert.equal(
    manifest.scripts["verify:node-22.14"],
    "pnpm build && node --experimental-strip-types scripts/verify-node-22.14.ts"
  );
  assert.equal(manifest.main, undefined);
  assert.match(matrixScript, execPathPattern);
  assert.doesNotMatch(matrixScript, floatingRuntimePattern);
  assert.equal(exactNodeVersion, "v22.14.0");
});

test("the floor oracle rejects every non-exact runtime", () => {
  assert.throws(() => assertExactRuntime("v22.14.1"), runtimeFloorErrorPattern);
});

test("npm binding rejects a mutated executable path", () => {
  const expected = { executable: "/runtime/bin/npm", version: "10.9.2" };
  assert.throws(
    () => assertNpmBinding({ ...expected, executable: "/other/bin/npm" }, expected),
    executableDriftPattern
  );
});

test("npm binding rejects a mutated version", () => {
  const expected = { executable: "/runtime/bin/npm", version: "10.9.2" };
  assert.throws(() => assertNpmBinding({ ...expected, version: "11.0.0" }, expected), versionDriftPattern);
});

test("artifact validation rejects a missing emitted export target", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pdpp-read-core-missing-target-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await assert.rejects(assertManifestTargets({ exports: { ".": "./dist/missing.js" } }, root), missingFilePattern);
});

test("artifact validation rejects dangling package targets", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pdpp-read-core-dangling-target-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist/index.js"), "export {};\n");
  await writeFile(path.join(root, "index.js"), "export {};\n");

  const manifest = { exports: { ".": "./dist/index.js" }, main: "./index.js" };
  await assertManifestTargets(manifest, root);
  assert.throws(() => assertPackedFiles(["dist/index.js"], manifest), missingPackedMainPattern);
});

test("artifact validation rejects source-only package contents", () => {
  assert.throws(
    () => assertPackedFiles(["README.md", "package.json", "src/index.js"], { exports: { ".": "./src/index.js" } }),
    sourceLeakPattern
  );
});

test("test discovery finds a renamed TypeScript test and refuses to silently skip it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pdpp-read-core-discovery-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const testDir = path.join(root, "test");
  await mkdir(testDir);
  const names = [
    "legacy-artifact-contract.test.cjs",
    "renamed-artifact-contract.test.cts",
    "legacy-artifact-contract.test.js",
    "legacy-artifact-contract.test.mjs",
    "renamed-artifact-contract.test.mts",
    "renamed-artifact-contract.test.ts",
  ];
  await Promise.all(names.map((name) => writeFile(path.join(testDir, name), "export {};\n")));

  const discovered = await discoverTestFiles(root);
  assert.deepEqual(
    discovered.map((file) => path.basename(file)),
    [...names].sort()
  );
  assert.throws(() => assertRunnableTestFiles(discovered), missingRuntimePattern);
});
