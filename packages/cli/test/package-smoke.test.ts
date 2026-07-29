// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertManifestTargets, assertPackedFiles, parseNpmPackOutput } from "../scripts/package-contract.ts";
import { getFileMode, getPdppCacheLayout, writePdppSecretFile } from "../src/cache-layout.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const npmEnv = {
  ...process.env,
  npm_config_cache: join(tmpdir(), "pdpp-cli-package-smoke-npm-cache"),
};

test("package manifest stays intentionally narrow", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(manifest.name, "@pdpp/cli");
  assert.deepEqual(manifest.bin, { pdpp: "./dist/bin/pdpp.js" });
  assert.equal(manifest.exports["."].import, "./dist/src/index.js");
  assert.equal(manifest.exports["."].types, "./dist/src/index.d.ts");
  assert.equal(manifest.publishConfig.tag, "latest");
  assert.equal(manifest.publishConfig.provenance, false);
  assert.equal(Object.hasOwn(manifest, "dependencies"), false);
  assert.equal(Object.hasOwn(manifest, "main"), false);
  assert.equal(Object.hasOwn(manifest, "directories"), false);
  assert.equal(Object.hasOwn(manifest, "author"), false);
});

test("npm package contents stay narrowly allowlisted", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assertManifestTargets(manifest, packageRoot);
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: npmEnv,
  });

  assert.equal(result.status, 0, result.stderr);

  const [pack] = parseNpmPackOutput(result.stdout);
  const files = pack.files.map((file) => file.path).sort();
  assertPackedFiles(manifest, files);
  assert.equal(files.includes("dist/bin/pdpp.js"), true);
  assert.equal(files.includes("dist/src/index.js"), true);

  for (const file of files) {
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(file, /^\.env/);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(file, /^\.pdpp\//);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(file, /^server\//);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(file, /^test\//);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(file, /sqlite|fixture|capture|screenshot/i);
  }
});

test("cache layout is explicit and secret files are owner-only", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pdpp-cli-cache-"));
  try {
    const layout = getPdppCacheLayout(join(tempRoot, ".pdpp"));
    assert.equal(layout.clientsDir, join(tempRoot, ".pdpp", "clients"));
    assert.equal(layout.gitignoreFile, join(tempRoot, ".pdpp", ".gitignore"));
    assert.equal(
      layout.credentialFile("https://provider.test/path"),
      join(tempRoot, ".pdpp", "clients", "provider.test.json")
    );

    const secretPath = layout.credentialFile("https://provider.test/path");
    writePdppSecretFile(secretPath, "secret-value");
    assert.equal(getFileMode(secretPath), 0o600);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("packed CLI installs and starts in an empty project", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pdpp-cli-pack-"));
  const packageDir = join(tempRoot, "package");

  try {
    mkdirSync(packageDir);

    const packResult = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tempRoot], {
      cwd: packageRoot,
      encoding: "utf8",
      env: npmEnv,
    });
    assert.equal(packResult.status, 0, packResult.stderr);

    const [pack] = parseNpmPackOutput(packResult.stdout);
    const tarball = join(tempRoot, pack.filename);

    assert.equal(spawnSync("npm", ["init", "-y"], { cwd: packageDir, env: npmEnv }).status, 0);
    const installResult = spawnSync("npm", ["install", tarball], {
      cwd: packageDir,
      encoding: "utf8",
      env: npmEnv,
    });
    assert.equal(installResult.status, 0, installResult.stderr);

    const helpResult = spawnSync(join(packageDir, "node_modules/.bin/pdpp"), ["--help"], {
      encoding: "utf8",
    });
    assert.equal(helpResult.status, 0, helpResult.stderr);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.match(helpResult.stdout, /PDPP CLI/);

    // Outside the monorepo and without @pdpp/local-collector installed,
    // `pdpp collector ...` must fail fast with a single-line install hint
    // (per openspec/changes/publish-pdpp-local-collector design §1). The
    // shim resolves @pdpp/local-collector lazily, so the CLI tarball stays
    // slim and free of Playwright.
    const collectorResult = spawnSync(join(packageDir, "node_modules/.bin/pdpp"), ["collector", "advertise"], {
      encoding: "utf8",
    });
    assert.notEqual(collectorResult.status, 0);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.match(collectorResult.stderr, /@pdpp\/local-collector/);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.match(collectorResult.stderr, /npm i -g @pdpp\/local-collector|npx -y @pdpp\/local-collector/);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(collectorResult.stderr, /not distributed with @pdpp\/cli yet/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});
