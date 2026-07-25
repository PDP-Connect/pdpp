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
  type ArtifactReceipt,
  assertArtifactReceipt,
  assertCleanWorkingTreeStatus,
  assertReceiptPathOutsideWorktree,
  assertSiblingCandidateEvidence,
  fileSha256,
  packageClosureSha256,
  SELF_PACKAGE_NAME,
  SIBLING_CANDIDATE_SCHEMA,
  type SiblingCandidateEvidence,
} from "../scripts/artifact-receipt.ts";
import { assertInstalledPackageMatchesTarball, resolveReceiptOutputPath } from "../scripts/pack-install-run.ts";
import { assertManifestTargets, assertPackedFiles, type PackageManifest } from "../scripts/package-contract.ts";

const SYMLINK = /symlink/;
const STALE_OR_REPLAYED_RECEIPT = /stale or replayed receipt/;
const STALE_OR_REPLAYED_EVIDENCE = /stale or replayed evidence/;
const SOURCE_CLOSURE_REJECTS_SYMLINK = /source closure rejects symlink/;
const CLEAN_TRACKED_AND_UNTRACKED = /clean tracked and untracked/;
const CLEAN_WORKING_TREE = /clean working tree/;
const OUTSIDE_THE_WORKING_TREE = /outside the working tree/;
const SELF_CANDIDATE_SHAPE = new RegExp(
  `${SELF_PACKAGE_NAME.replace(/[/]/g, "\\/")} candidate must carry a self-candidate sha256`
);
const SELF_CANDIDATE_MISSING = new RegExp(
  `receipt must bind ${SELF_PACKAGE_NAME.replace(/[/]/g, "\\/")} candidate provenance`
);

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const MISSING_TARGET = /is missing/;
const SOURCE_TARGET = /must point into \.\/dist\//;
const SOURCE_FILE = /source file leaked/;
const SOURCE_FALLBACK = /resolved from source instead of the offline consumer/;
const REPLAYED_RECEIPT = /stale or replayed receipt/;

function manifest(overrides: Partial<PackageManifest> = {}): PackageManifest {
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

function receipt(): ArtifactReceipt {
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
    dependencyTree: { name: "consumer", version: "1.0.0" },
    tarballFiles: ["package.json", "dist/src/index.js"],
    stdio: { toolContract: "schema", toolResultVersion: "artifact-proof" },
    candidates: {
      ...Object.fromEntries(
        ["@pdpp/cli", "@pdpp/read-core"].map((packageName) => [
          packageName,
          {
            schema: SIBLING_CANDIDATE_SCHEMA,
            packageName,
            baseGitSha: "base",
            headGitSha: "head",
            sourceClosureSha256: "source",
            sourceTarballSha256: "source-tarball",
            tarballSha256: "candidate-tarball",
          },
        ])
      ),
      [SELF_PACKAGE_NAME]: { sha256: "mcp-tarball-sha" },
    },
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
  assert.throws(() => resolveReceiptOutputPath(danglingLeaf), SYMLINK);
  assert.equal(existsSync(target), false);

  const outside = mkdtempSync(join(tmpdir(), "pdpp-mcp-receipt-outside-"));
  const parentLink = join(root, "linked-parent");
  symlinkSync(outside, parentLink);
  assert.throws(() => resolveReceiptOutputPath(join(parentLink, "receipt.json")), SYMLINK);
});

function siblingCandidates(value: ArtifactReceipt): Record<string, SiblingCandidateEvidence> {
  const cliCandidate = value.candidates["@pdpp/cli"];
  const readCoreCandidate = value.candidates["@pdpp/read-core"];
  assert.ok(cliCandidate && !("sha256" in cliCandidate), "fixture must declare a sibling-shaped @pdpp/cli candidate");
  assert.ok(
    readCoreCandidate && !("sha256" in readCoreCandidate),
    "fixture must declare a sibling-shaped @pdpp/read-core candidate"
  );
  return { "@pdpp/cli": cliCandidate, "@pdpp/read-core": readCoreCandidate };
}

test("receipt validation recomputes persisted sibling provenance", () => {
  const value = receipt();
  assert.doesNotThrow(() => assertArtifactReceipt(value, { candidates: siblingCandidates(value) }));
  const cliCandidate = value.candidates["@pdpp/cli"];
  assert.ok(cliCandidate, "fixture must declare an @pdpp/cli candidate");
  const forged: ArtifactReceipt = {
    ...value,
    candidates: {
      ...value.candidates,
      "@pdpp/cli": { ...cliCandidate, headGitSha: "forged-or-replayed-head" },
    },
  };
  assert.throws(
    () => assertArtifactReceipt(forged, { candidates: siblingCandidates(value) }),
    STALE_OR_REPLAYED_RECEIPT
  );
});

test("receipt validation rejects a malformed mcp-server self-candidate", () => {
  const value = receipt();

  // Missing entirely.
  const { [SELF_PACKAGE_NAME]: _dropped, ...candidatesWithoutSelf } = value.candidates;
  assert.throws(() => assertArtifactReceipt({ ...value, candidates: candidatesWithoutSelf }), SELF_CANDIDATE_MISSING);

  // Sibling-shaped instead of self-candidate-shaped (the exact mutation the
  // pre-fix double-cast in pack-install-run.ts would have silently allowed
  // through both tsc and this runtime check).
  const siblingShapedSelf: ArtifactReceipt = {
    ...value,
    candidates: {
      ...value.candidates,
      [SELF_PACKAGE_NAME]: {
        schema: SIBLING_CANDIDATE_SCHEMA,
        packageName: SELF_PACKAGE_NAME,
        baseGitSha: "base",
        headGitSha: "head",
        sourceClosureSha256: "source",
        sourceTarballSha256: "source-tarball",
        tarballSha256: "candidate-tarball",
      },
    },
  };
  assert.throws(() => assertArtifactReceipt(siblingShapedSelf), SELF_CANDIDATE_SHAPE);

  // Correctly shaped self-candidate must pass.
  assert.doesNotThrow(() => assertArtifactReceipt(value));
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
    STALE_OR_REPLAYED_EVIDENCE
  );
  assert.throws(
    () => assertSiblingCandidateEvidence({ ...evidence, sourceTarballSha256: "stale-source-tarball" }, expected),
    STALE_OR_REPLAYED_EVIDENCE
  );
  assert.throws(
    () => assertSiblingCandidateEvidence({ ...evidence, tarballSha256: "arbitrary-supplied-bytes" }, expected),
    STALE_OR_REPLAYED_EVIDENCE
  );
});

test("source closure fails closed on symlinks and receipt emission needs a clean tree", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-mcp-source-closure-"));
  writeFileSync(join(root, "source.js"), "export const source = true;\n");
  writeFileSync(join(root, "outside.js"), "export const outside = true;\n");
  symlinkSync(join(root, "outside.js"), join(root, "linked.js"));
  assert.throws(() => packageClosureSha256(root), SOURCE_CLOSURE_REJECTS_SYMLINK);
  assert.doesNotThrow(() => assertCleanWorkingTreeStatus(""));
  assert.throws(
    () => assertCleanWorkingTreeStatus(" M packages/mcp-server/src/index.js\n"),
    CLEAN_TRACKED_AND_UNTRACKED
  );
  assert.throws(() => assertCleanWorkingTreeStatus("?? replayed-receipt.json\n"), CLEAN_TRACKED_AND_UNTRACKED);
});

test("receipt attests to a clean tree and cannot be emitted into it", () => {
  assert.doesNotThrow(() => assertArtifactReceipt(receipt()));
  assert.throws(() => assertArtifactReceipt({ ...receipt(), workingTreeClean: false }), CLEAN_WORKING_TREE);
  assert.doesNotThrow(() => assertReceiptPathOutsideWorktree("/evidence/receipt.json", "/worktree"));
  assert.throws(
    () => assertReceiptPathOutsideWorktree("/worktree/receipt.json", "/worktree"),
    OUTSIDE_THE_WORKING_TREE
  );
});

test("checked-in package contract points only at emitted files", () => {
  const checkedInManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => assertManifestTargets(checkedInManifest, packageRoot));
});
