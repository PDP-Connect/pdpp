// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const ARTIFACT_RECEIPT_SCHEMA = "pdpp.mcp-server.emitted-artifact/v1";
export const SIBLING_CANDIDATE_SCHEMA = "pdpp.mcp-server.sibling-candidate/v1";
export const BASELINE_SHA = "b121068ed5f7abfe0f60ed1a50b6de026990059a";

function packageFiles(packageRoot) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      const path = join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `source closure rejects symlink: ${relative(packageRoot, path)}`);
      if (entry.isDirectory()) {
        visit(path);
      }
      if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  visit(packageRoot);
  return files;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function fileSha256(path) {
  return sha256(readFileSync(path));
}

export function packageClosureSha256(packageRoot) {
  const hash = createHash("sha256");
  for (const path of packageFiles(packageRoot)) {
    hash.update(relative(packageRoot, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function gitSha(packageRoot, args) {
  return execFileSync("git", args, { cwd: packageRoot, encoding: "utf8" }).trim();
}

export function currentSourceIdentity(packageRoot) {
  return {
    baseGitSha: gitSha(packageRoot, ["merge-base", "HEAD", BASELINE_SHA]),
    headGitSha: gitSha(packageRoot, ["rev-parse", "HEAD"]),
    sourceClosureSha256: packageClosureSha256(packageRoot),
  };
}

export function assertCleanWorkingTreeStatus(status) {
  assert.equal(status, "", "receipt emission requires a clean tracked and untracked working tree");
}

export function assertCleanWorkingTree(packageRoot) {
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assertCleanWorkingTreeStatus(status);
}

export function assertReceiptPathOutsideWorktree(receiptPath, worktreeRoot) {
  const receiptRelativePath = relative(worktreeRoot, receiptPath);
  assert.equal(
    receiptRelativePath === ".." || receiptRelativePath.startsWith(`..${sep}`),
    true,
    "receipt output must be outside the working tree"
  );
}

export function currentReceiptIdentity(packageRoot, tarballPath) {
  return {
    ...currentSourceIdentity(packageRoot),
    tarballSha256: fileSha256(tarballPath),
  };
}

export function assertSiblingCandidateEvidence(candidate, expected) {
  assert.equal(candidate?.schema, SIBLING_CANDIDATE_SCHEMA, "sibling candidate schema changed");
  assert.equal(candidate?.packageName, expected.packageName, "sibling candidate package changed");
  assert.equal(candidate?.baseGitSha, expected.sourceIdentity.baseGitSha, "sibling candidate base changed (stale or replayed evidence)");
  assert.equal(candidate?.headGitSha, expected.sourceIdentity.headGitSha, "sibling candidate head changed (stale or replayed evidence)");
  assert.equal(
    candidate?.sourceClosureSha256,
    expected.sourceIdentity.sourceClosureSha256,
    "sibling candidate source closure changed (stale or replayed evidence)"
  );
  assert.equal(
    candidate?.sourceTarballSha256,
    expected.sourceTarballSha256,
    "sibling candidate source tarball changed (stale or replayed evidence)"
  );
  assert.equal(
    candidate?.tarballSha256,
    fileSha256(expected.tarballPath),
    "sibling candidate tarball changed (stale or replayed evidence)"
  );
}

export function assertArtifactReceipt(receipt, expected = {}) {
  assert.equal(receipt?.schema, ARTIFACT_RECEIPT_SCHEMA, "receipt schema changed");
  assert.equal(typeof receipt?.node?.version, "string", "receipt must record Node version");
  assert.equal(typeof receipt?.node?.execPath, "string", "receipt must record Node executable");
  assert.equal(typeof receipt?.packageManager?.npmVersion, "string", "receipt must record npm version");
  assert.equal(typeof receipt?.packageManager?.pnpmVersion, "string", "receipt must record pnpm version");
  assert.equal(typeof receipt?.baseGitSha, "string", "receipt must record base SHA");
  assert.equal(typeof receipt?.headGitSha, "string", "receipt must record head SHA");
  assert.equal(typeof receipt?.sourceClosureSha256, "string", "receipt must record source closure hash");
  assert.equal(typeof receipt?.tarballSha256, "string", "receipt must record tarball hash");
  assert.equal(receipt?.workingTreeClean, true, "receipt must attest to a clean working tree");
  assert.ok(Array.isArray(receipt?.exports), "receipt must inventory exports");
  assert.ok(Array.isArray(receipt?.bins), "receipt must inventory bins");
  assert.ok(Array.isArray(receipt?.commands), "receipt must record executed commands");
  for (const packageName of ["@pdpp/cli", "@pdpp/read-core"]) {
    const candidate = receipt?.candidates?.[packageName];
    assert.equal(candidate?.schema, SIBLING_CANDIDATE_SCHEMA, `receipt must bind ${packageName} candidate provenance`);
    for (const field of [
      "baseGitSha",
      "headGitSha",
      "sourceClosureSha256",
      "sourceTarballSha256",
      "tarballSha256",
    ]) {
      assert.equal(typeof candidate?.[field], "string", `receipt must record ${packageName} ${field}`);
    }
  }

  const { candidates: expectedCandidates, ...expectedFields } = expected;
  for (const [field, value] of Object.entries(expectedFields)) {
    assert.equal(receipt[field], value, `receipt ${field} binding changed (stale or replayed receipt)`);
  }
  if (expectedCandidates) {
    for (const packageName of ["@pdpp/cli", "@pdpp/read-core"]) {
      const actual = receipt.candidates[packageName];
      const expectedCandidate = expectedCandidates[packageName];
      assert.ok(expectedCandidate, `current ${packageName} provenance is missing`);
      for (const field of [
        "baseGitSha",
        "headGitSha",
        "sourceClosureSha256",
        "sourceTarballSha256",
        "tarballSha256",
      ]) {
        assert.equal(
          actual[field],
          expectedCandidate[field],
          `receipt ${packageName} ${field} binding changed (stale or replayed receipt)`
        );
      }
    }
  }
}

export function assertReceiptFresh(receipt, packageRoot, tarballPath, candidates) {
  assertArtifactReceipt(receipt, { ...currentReceiptIdentity(packageRoot, tarballPath), candidates });
}

export function readNpmVersion() {
  return execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
}

export function readPnpmVersion(executable = "pnpm") {
  return execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
}

export function assertFileExists(path, label) {
  assert.equal(existsSync(path), true, `${label} is missing: ${path}`);
}
