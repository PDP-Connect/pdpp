// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ARTIFACT_RECEIPT_SCHEMA,
  SIBLING_CANDIDATE_SCHEMA,
  assertArtifactReceipt,
  assertCleanWorkingTreeStatus,
  assertReceiptPathOutsideWorktree,
  assertSiblingCandidateEvidence,
  fileSha256,
  packageClosureSha256,
} from "../scripts/artifact-receipt.mjs";
import { assertInstalledPackageMatchesTarball } from "../scripts/pack-install-run.mjs";
import { resolveReceiptOutputPath } from "../scripts/pack-install-run.mjs";
import { assertManifestTargets, assertPackedFiles } from "../scripts/package-contract.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const MISSING_TARGET = /is missing/;
const SOURCE_TARGET = /must point into \.\/dist\//;
const SOURCE_FILE = /source file leaked/;
const SOURCE_FALLBACK = /resolved from source instead of the offline consumer/;
const REPLAYED_RECEIPT = /stale or replayed receipt/;

function manifest(overrides = {}) {
  return {
    name: "@pdpp/mcp-server",
    bin: { "pdpp-mcp-server": "./dist/bin/pdpp-mcp-server.js" },
    exports: { ".": "./dist/src/index.js", "./server": "./dist/src/server.js" },
    files: ["dist/", "README.md"],
    dependencies: { "@pdpp/cli": ">=0.18.11 <1.0.0" },
    ...overrides,
  };
}

function emittedFixture() {
  const root = mkdtempSync(join(tmpdir(), "pdpp-mcp-artifact-contract-"));
  mkdirSync(join(root, "dist", "src"), { recursive: true });
  mkdirSync(join(root, "dist", "bin"), { recursive: true });
  writeFileSync(join(root, "dist", "src", "index.js"), "export const artifact = true;\n");
  writeFileSync(join(root, "dist", "src", "server.js"), "export const server = true;\n");
  writeFileSync(join(root, "dist", "bin", "pdpp-mcp-server.js"), '#!/usr/bin/env node\nconsole.log("mcp");\n');
  chmodSync(join(root, "dist", "bin", "pdpp-mcp-server.js"), 0o755);
  return root;
}

function receipt() {
  return {
    schema: ARTIFACT_RECEIPT_SCHEMA,
    baseGitSha: "base",
    headGitSha: "head",
    sourceClosureSha256: "source",
    tarballSha256: "tarball",
    workingTreeClean: true,
    node: { version: "v25.8.2", execPath: "/node" },
    packageManager: { npmVersion: "11.18.0", pnpmVersion: "10.33.0" },
    exports: [],
    bins: [],
    commands: [],
    candidates: Object.fromEntries(
      ["@pdpp/cli", "@pdpp/read-core"].map((packageName) => [
        packageName,
        {
          schema: SIBLING_CANDIDATE_SCHEMA,
          baseGitSha: "base",
          headGitSha: "head",
          sourceClosureSha256: "source",
          sourceTarballSha256: "source-tarball",
          tarballSha256: "candidate-tarball",
        },
      ])
    ),
  };
}

test("artifact contract rejects a missing declared export", () => {
  assert.throws(
    () => assertManifestTargets(manifest({ exports: { ".": "./dist/src/missing.js" } }), emittedFixture()),
    MISSING_TARGET
  );
});

test("artifact contract rejects a missing declared bin", () => {
  assert.throws(
    () => assertManifestTargets(manifest({ bin: { "pdpp-mcp-server": "./dist/bin/missing.js" } }), emittedFixture()),
    MISSING_TARGET
  );
});

test("artifact contract rejects a source fallback target and packed source files", () => {
  const root = emittedFixture();
  assert.throws(() => assertManifestTargets(manifest({ exports: { ".": "./src/index.js" } }), root), SOURCE_TARGET);
  assert.throws(
    () =>
      assertPackedFiles(manifest(), [
        "src/index.js",
        "dist/src/index.js",
        "dist/src/server.js",
        "dist/bin/pdpp-mcp-server.js",
      ]),
    SOURCE_FILE
  );
});

test("consumer proof rejects an installed package symlinked to source", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-mcp-source-fallback-"));
  const tarRoot = join(root, "tar");
  const consumerRoot = join(root, "consumer");
  const sourceRoot = join(root, "source");
  mkdirSync(join(tarRoot, "package"), { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(join(consumerRoot, "node_modules", "@pdpp"), { recursive: true });
  writeFileSync(
    join(tarRoot, "package", "package.json"),
    JSON.stringify({ name: "@pdpp/mcp-server", version: "1.0.0" })
  );
  writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({ name: "@pdpp/mcp-server", version: "1.0.0" }));
  const tarball = join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", tarRoot, "package"]);
  symlinkSync(sourceRoot, join(consumerRoot, "node_modules", "@pdpp", "mcp-server"));
  assert.throws(
    () => assertInstalledPackageMatchesTarball({ consumerRoot, packageName: "@pdpp/mcp-server", tarball }),
    SOURCE_FALLBACK
  );
});

// `@pdpp/cli` (and `@pdpp/mcp-server`, `@pdpp/read-core`) are real packages
// already published on the public npm registry. pack-install-run.mjs used to
// install every candidate tarball under one blanket `pnpm add --offline`,
// which incidentally also proved the two local `@pdpp/*` deps could never
// resolve from the registry. That single flag broke when @pdpp/mcp-server
// gained an ordinary external dependency (@modelcontextprotocol/sdk) with no
// offline-store entry in this environment — this is pre-existing
// artifact-harness debt (the flag was never scoped to "the two local
// candidates only"), not an MCP behavior regression. The fix scopes
// `--offline` to just the local-candidate install step and lets a second,
// separate step install the package with real external dependencies online.
// This test reproduces that exact shape against the real, live registry (the
// same one a `file:`-tarball @pdpp/cli could otherwise silently fall back
// to) and proves the pnpm-workspace.yaml `overrides` pin still forces the
// local tarball's exact bytes through an *online* `pnpm add`, not the real
// published package.
test(
  "pnpm-workspace overrides pin a local candidate tarball through an online install, not the public registry",
  { skip: process.env.PDPP_SKIP_NETWORK_TESTS ? "network tests disabled" : false },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pdpp-mcp-online-override-"));
    const fakeCliRoot = join(root, "fake-cli");
    const consumerRoot = join(root, "consumer");
    mkdirSync(fakeCliRoot, { recursive: true });
    mkdirSync(consumerRoot, { recursive: true });

    // A local @pdpp/cli candidate with content that could never be mistaken
    // for the real published package (different version, marker file).
    const localMarker = "local-candidate-not-the-published-package";
    writeFileSync(
      join(fakeCliRoot, "package.json"),
      JSON.stringify({ name: "@pdpp/cli", version: "0.0.0-local-candidate", private: false })
    );
    writeFileSync(join(fakeCliRoot, "MARKER.txt"), `${localMarker}\n`);
    const tarball = join(root, "pdpp-cli-local-candidate.tgz");
    execFileSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: fakeCliRoot });
    // npm pack names the tarball from the manifest; rename to a stable path.
    const packedName = join(root, "pdpp-cli-0.0.0-local-candidate.tgz");
    execFileSync("mv", [packedName, tarball]);

    execFileSync("npm", ["init", "--yes"], { cwd: consumerRoot });
    writeFileSync(
      join(consumerRoot, "pnpm-workspace.yaml"),
      `packages:\n  - .\noverrides:\n  "@pdpp/cli": "file:${tarball}"\n`
    );
    // Intentionally no --offline here: this is the online step's exact shape.
    execFileSync("pnpm", ["add", "--ignore-scripts", "@pdpp/cli"], {
      cwd: consumerRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
    });

    const installedRoot = assertInstalledPackageMatchesTarball({
      consumerRoot,
      packageName: "@pdpp/cli",
      tarball,
    });
    const installedManifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
    assert.equal(installedManifest.version, "0.0.0-local-candidate");
    assert.equal(
      readFileSync(join(installedRoot, "MARKER.txt"), "utf8").trim(),
      localMarker,
      "override must install the local candidate tarball's exact bytes, not the published @pdpp/cli"
    );
  }
);

test("receipt validation rejects stale/replayed source closure and tarball drift", () => {
  assert.throws(
    () =>
      assertArtifactReceipt(
        { ...receipt(), sourceClosureSha256: "replayed-source" },
        { sourceClosureSha256: "source" }
      ),
    REPLAYED_RECEIPT
  );
  assert.throws(
    () => assertArtifactReceipt({ ...receipt(), tarballSha256: "drifted-tarball" }, { tarballSha256: "tarball" }),
    REPLAYED_RECEIPT
  );
});

test("receipt output rejects dangling leaf and parent symlinks before any write", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-mcp-receipt-path-"));
  const target = join(root, "target.json");
  const danglingLeaf = join(root, "dangling-receipt.json");
  symlinkSync(target, danglingLeaf);
  assert.throws(() => resolveReceiptOutputPath(danglingLeaf), /symlink/);
  assert.equal(existsSync(target), false);

  const outside = mkdtempSync(join(tmpdir(), "pdpp-mcp-receipt-outside-"));
  const parentLink = join(root, "linked-parent");
  symlinkSync(outside, parentLink);
  assert.throws(() => resolveReceiptOutputPath(join(parentLink, "receipt.json")), /symlink/);
});

test("receipt validation recomputes persisted sibling provenance", () => {
  const value = receipt();
  assert.doesNotThrow(() => assertArtifactReceipt(value, { candidates: value.candidates }));
  const forged = {
    ...value,
    candidates: {
      ...value.candidates,
      "@pdpp/cli": { ...value.candidates["@pdpp/cli"], headGitSha: "forged-or-replayed-head" },
    },
  };
  assert.throws(
    () => assertArtifactReceipt(forged, { candidates: value.candidates }),
    /stale or replayed receipt/
  );
});

test("checker reproduction rejects stale sibling evidence before consumer installation", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-mcp-sibling-evidence-"));
  const candidateTarball = join(root, "candidate.tgz");
  writeFileSync(candidateTarball, "fresh-reviewed-candidate");
  const sourceIdentity = {
    baseGitSha: "base",
    headGitSha: "reviewed-head",
    sourceClosureSha256: "reviewed-source-closure",
  };
  const evidence = {
    schema: SIBLING_CANDIDATE_SCHEMA,
    packageName: "@pdpp/cli",
    ...sourceIdentity,
    sourceTarballSha256: "fresh-source-tarball",
    tarballSha256: fileSha256(candidateTarball),
  };
  const expected = {
    packageName: "@pdpp/cli",
    sourceIdentity,
    sourceTarballSha256: "fresh-source-tarball",
    tarballPath: candidateTarball,
  };
  assert.doesNotThrow(() => assertSiblingCandidateEvidence(evidence, expected));
  assert.throws(
    () => assertSiblingCandidateEvidence({ ...evidence, headGitSha: "stale-head" }, expected),
    /stale or replayed evidence/
  );
  assert.throws(
    () => assertSiblingCandidateEvidence({ ...evidence, sourceTarballSha256: "stale-source-tarball" }, expected),
    /stale or replayed evidence/
  );
  assert.throws(
    () => assertSiblingCandidateEvidence({ ...evidence, tarballSha256: "arbitrary-supplied-bytes" }, expected),
    /stale or replayed evidence/
  );
});

test("source closure fails closed on symlinks and receipt emission needs a clean tree", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-mcp-source-closure-"));
  writeFileSync(join(root, "source.js"), "export const source = true;\n");
  writeFileSync(join(root, "outside.js"), "export const outside = true;\n");
  symlinkSync(join(root, "outside.js"), join(root, "linked.js"));
  assert.throws(() => packageClosureSha256(root), /source closure rejects symlink/);
  assert.doesNotThrow(() => assertCleanWorkingTreeStatus(""));
  assert.throws(() => assertCleanWorkingTreeStatus(" M packages/mcp-server/src/index.js\n"), /clean tracked and untracked/);
  assert.throws(() => assertCleanWorkingTreeStatus("?? replayed-receipt.json\n"), /clean tracked and untracked/);
});

test("receipt attests to a clean tree and cannot be emitted into it", () => {
  assert.doesNotThrow(() => assertArtifactReceipt(receipt()));
  assert.throws(() => assertArtifactReceipt({ ...receipt(), workingTreeClean: false }), /clean working tree/);
  assert.doesNotThrow(() => assertReceiptPathOutsideWorktree("/evidence/receipt.json", "/worktree"));
  assert.throws(() => assertReceiptPathOutsideWorktree("/worktree/receipt.json", "/worktree"), /outside the working tree/);
});

test("checked-in package contract points only at emitted files", () => {
  const checkedInManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => assertManifestTargets(checkedInManifest, packageRoot));
});
