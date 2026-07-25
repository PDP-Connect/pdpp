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
// The receipt's own package, keyed into `candidates` alongside its two real
// siblings but with a distinct, narrower shape (SelfCandidateEvidence) since
// it is verified by installed-tree hash rather than rebuilt sibling
// provenance — see SelfCandidateEvidence and assertSelfCandidateEvidence.
export const SELF_PACKAGE_NAME = "@pdpp/mcp-server";

export interface SourceIdentity {
  baseGitSha: string;
  headGitSha: string;
  sourceClosureSha256: string;
}

export interface ReceiptIdentity extends SourceIdentity {
  tarballSha256: string;
}

export interface SiblingCandidateEvidence {
  baseGitSha: string;
  headGitSha: string;
  packageName: string;
  releaseCandidateVersion?: string;
  schema: string;
  sourceClosureSha256: string;
  sourceTarballSha256: string;
  tarballSha256: string;
}

export interface SiblingCandidateExpected {
  packageName: string;
  sourceIdentity: SourceIdentity;
  sourceTarballSha256: string;
  tarballPath: string;
}

// The receipt's own package entry in `candidates`: verified by hashing the
// installed tree against the packed tarball (assertInstalledPackageMatchesTarball
// in pack-install-run.ts), not by rebuilding sibling source provenance, so it
// carries no schema/baseGitSha/headGitSha/packageName/sourceClosureSha256/
// sourceTarballSha256 fields — those would be dishonest to claim here.
export interface SelfCandidateEvidence {
  installedRoot?: string;
  sha256: string;
}

export type CandidateEvidence = (SiblingCandidateEvidence & { installedRoot?: string }) | SelfCandidateEvidence;

function isSelfCandidateEvidence(candidate: CandidateEvidence): candidate is SelfCandidateEvidence {
  return typeof (candidate as Partial<SelfCandidateEvidence>).sha256 === "string";
}

export interface ArtifactReceipt {
  baseGitSha: string;
  bins: unknown[];
  candidates: Record<string, CandidateEvidence>;
  commands: string[];
  dependencyTree: unknown;
  exports: unknown[];
  headGitSha: string;
  node: { execPath: string; version: string };
  packageManager: { npmVersion: string; pnpmVersion: string };
  schema: string;
  sourceClosureSha256: string;
  stdio: unknown;
  tarballFiles: string[];
  tarballSha256: string;
  workingTreeClean: boolean;
}

type ArtifactReceiptExpected = Partial<ReceiptIdentity> & {
  candidates?: Record<string, SiblingCandidateEvidence>;
};

function packageFiles(packageRoot: string): string[] {
  const files: string[] = [];
  function visit(directory: string): void {
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

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

export function packageClosureSha256(packageRoot: string): string {
  const hash = createHash("sha256");
  for (const path of packageFiles(packageRoot)) {
    hash.update(relative(packageRoot, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function gitSha(packageRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: packageRoot, encoding: "utf8" }).trim();
}

export function currentSourceIdentity(packageRoot: string): SourceIdentity {
  return {
    baseGitSha: gitSha(packageRoot, ["merge-base", "HEAD", BASELINE_SHA]),
    headGitSha: gitSha(packageRoot, ["rev-parse", "HEAD"]),
    sourceClosureSha256: packageClosureSha256(packageRoot),
  };
}

export function assertCleanWorkingTreeStatus(status: string): void {
  assert.equal(status, "", "receipt emission requires a clean tracked and untracked working tree");
}

export function assertCleanWorkingTree(packageRoot: string): void {
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assertCleanWorkingTreeStatus(status);
}

export function assertReceiptPathOutsideWorktree(receiptPath: string, worktreeRoot: string): void {
  const receiptRelativePath = relative(worktreeRoot, receiptPath);
  assert.equal(
    receiptRelativePath === ".." || receiptRelativePath.startsWith(`..${sep}`),
    true,
    "receipt output must be outside the working tree"
  );
}

export function currentReceiptIdentity(packageRoot: string, tarballPath: string): ReceiptIdentity {
  return {
    ...currentSourceIdentity(packageRoot),
    tarballSha256: fileSha256(tarballPath),
  };
}

export function assertSiblingCandidateEvidence(
  candidate: SiblingCandidateEvidence,
  expected: SiblingCandidateExpected
): void {
  assert.equal(candidate.schema, SIBLING_CANDIDATE_SCHEMA, "sibling candidate schema changed");
  assert.equal(candidate.packageName, expected.packageName, "sibling candidate package changed");
  assert.equal(
    candidate.baseGitSha,
    expected.sourceIdentity.baseGitSha,
    "sibling candidate base changed (stale or replayed evidence)"
  );
  assert.equal(
    candidate.headGitSha,
    expected.sourceIdentity.headGitSha,
    "sibling candidate head changed (stale or replayed evidence)"
  );
  assert.equal(
    candidate.sourceClosureSha256,
    expected.sourceIdentity.sourceClosureSha256,
    "sibling candidate source closure changed (stale or replayed evidence)"
  );
  assert.equal(
    candidate.sourceTarballSha256,
    expected.sourceTarballSha256,
    "sibling candidate source tarball changed (stale or replayed evidence)"
  );
  assert.equal(
    candidate.tarballSha256,
    fileSha256(expected.tarballPath),
    "sibling candidate tarball changed (stale or replayed evidence)"
  );
}

export function assertSelfCandidateShape(candidate: CandidateEvidence | undefined): SelfCandidateEvidence {
  assert.ok(candidate, `receipt must bind ${SELF_PACKAGE_NAME} candidate provenance`);
  assert.equal(
    isSelfCandidateEvidence(candidate),
    true,
    `receipt ${SELF_PACKAGE_NAME} candidate must carry a self-candidate sha256, not sibling-shaped fields`
  );
  return candidate as SelfCandidateEvidence;
}

function assertSiblingCandidateShape(
  candidate: CandidateEvidence | undefined,
  packageName: string
): SiblingCandidateEvidence & { installedRoot?: string } {
  assert.ok(candidate, `receipt must bind ${packageName} candidate provenance`);
  assert.equal(
    isSelfCandidateEvidence(candidate),
    false,
    `receipt ${packageName} candidate must carry sibling-shaped fields, not a self-candidate sha256`
  );
  return candidate as SiblingCandidateEvidence & { installedRoot?: string };
}

export function assertArtifactReceipt(receipt: ArtifactReceipt, expected: ArtifactReceiptExpected = {}): void {
  assert.equal(receipt.schema, ARTIFACT_RECEIPT_SCHEMA, "receipt schema changed");
  assert.equal(typeof receipt.node.version, "string", "receipt must record Node version");
  assert.equal(typeof receipt.node.execPath, "string", "receipt must record Node executable");
  assert.equal(typeof receipt.packageManager.npmVersion, "string", "receipt must record npm version");
  assert.equal(typeof receipt.packageManager.pnpmVersion, "string", "receipt must record pnpm version");
  assert.equal(typeof receipt.baseGitSha, "string", "receipt must record base SHA");
  assert.equal(typeof receipt.headGitSha, "string", "receipt must record head SHA");
  assert.equal(typeof receipt.sourceClosureSha256, "string", "receipt must record source closure hash");
  assert.equal(typeof receipt.tarballSha256, "string", "receipt must record tarball hash");
  assert.equal(receipt.workingTreeClean, true, "receipt must attest to a clean working tree");
  assert.ok(Array.isArray(receipt.exports), "receipt must inventory exports");
  assert.ok(Array.isArray(receipt.bins), "receipt must inventory bins");
  assert.ok(Array.isArray(receipt.commands), "receipt must record executed commands");
  for (const packageName of ["@pdpp/cli", "@pdpp/read-core"]) {
    const candidate = assertSiblingCandidateShape(receipt.candidates[packageName], packageName);
    assert.equal(candidate.schema, SIBLING_CANDIDATE_SCHEMA, `receipt must bind ${packageName} candidate provenance`);
    for (const field of [
      "baseGitSha",
      "headGitSha",
      "sourceClosureSha256",
      "sourceTarballSha256",
      "tarballSha256",
    ] as const) {
      assert.equal(typeof candidate[field], "string", `receipt must record ${packageName} ${field}`);
    }
  }
  const selfCandidate = assertSelfCandidateShape(receipt.candidates[SELF_PACKAGE_NAME]);
  assert.equal(typeof selfCandidate.sha256, "string", `receipt must record ${SELF_PACKAGE_NAME} tarball hash`);

  const { candidates: expectedCandidates, ...expectedFields } = expected;
  for (const [field, value] of Object.entries(expectedFields)) {
    assert.equal(
      receipt[field as keyof ArtifactReceipt],
      value,
      `receipt ${field} binding changed (stale or replayed receipt)`
    );
  }
  if (expectedCandidates) {
    for (const packageName of ["@pdpp/cli", "@pdpp/read-core"]) {
      const actual = assertSiblingCandidateShape(receipt.candidates[packageName], packageName);
      const expectedCandidate: SiblingCandidateEvidence | undefined = expectedCandidates[packageName];
      assert.ok(expectedCandidate, `current ${packageName} provenance is missing`);
      for (const field of [
        "baseGitSha",
        "headGitSha",
        "sourceClosureSha256",
        "sourceTarballSha256",
        "tarballSha256",
      ] as const) {
        assert.equal(
          actual[field],
          expectedCandidate[field],
          `receipt ${packageName} ${field} binding changed (stale or replayed receipt)`
        );
      }
    }
  }
}

export function assertReceiptFresh(
  receipt: ArtifactReceipt,
  packageRoot: string,
  tarballPath: string,
  candidates: Record<string, SiblingCandidateEvidence>
): void {
  assertArtifactReceipt(receipt, { ...currentReceiptIdentity(packageRoot, tarballPath), candidates });
}

export function readNpmVersion(): string {
  return execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
}

export function readPnpmVersion(executable = "pnpm"): string {
  return execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
}

export function assertFileExists(path: string, label: string): void {
  assert.equal(existsSync(path), true, `${label} is missing: ${path}`);
}
