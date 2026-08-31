// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Verify the cross-repository runtime artifacts consumed by the PDPP train.
 *
 * These packages are vendored as tarballs because the two repositories are
 * separate workspaces.  A package.json version alone is not an artifact
 * identity: this check binds the consumer pins, archive contents, and hashes
 * before a package can be treated as the reviewed #36 output.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_PACKAGE_VERSION = "1.0.0";
const PRIOR_PACKAGE_VERSION = "0.0.2";

export const EXPECTED_PACKAGES = [
  {
    name: "@pdpp/collector-runtime",
    archive: "vendor/pdpp-collector-runtime-1.0.0.tgz",
  },
  {
    name: "@pdpp/connector-protocol",
    archive: "vendor/pdpp-connector-protocol-1.0.0.tgz",
  },
] as const;

interface PackageManifest {
  dependencies?: Record<string, string>;
  name?: string;
  version?: string;
}

const SHA256_SUM_LINE = /^(?<sha>[0-9a-f]{64}) {2}(?<path>vendor\/[^\s]+)$/;
const LOCK_INTEGRITY = /resolution: \{integrity: sha512-([^,}]+)/;

function fail(message: string): never {
  throw new Error(`PDPP vendored package pin verification failed: ${message}`);
}

function readJson(path: string): PackageManifest {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
  } catch (error) {
    fail(`cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function digest(path: string, algorithm: "sha256" | "sha512"): string {
  return createHash(algorithm).update(readFileSync(path)).digest("hex");
}

function archivePackageManifest(path: string): PackageManifest {
  try {
    return JSON.parse(
      execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" })
    ) as PackageManifest;
  } catch (error) {
    fail(`cannot read package/package.json from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readSha256Sums(repoRoot: string): Map<string, string> {
  const sums = readFileSync(join(repoRoot, "vendor/SHA256SUMS"), "utf8");
  const records = new Map<string, string>();
  for (const line of sums.split("\n")) {
    const match = SHA256_SUM_LINE.exec(line);
    const sha = match?.groups?.sha;
    const path = match?.groups?.path;
    if (sha && path) {
      records.set(path, sha);
    }
  }
  return records;
}

function assertConsumerPin(repoRoot: string, relativePath: string, packageName: string, archive: string): void {
  const manifest = readJson(join(repoRoot, relativePath));
  const expectedSpecifier = `file:${relativePath.startsWith("reference-implementation/") ? "../" : "../../"}${archive}`;
  const actual = manifest.dependencies?.[packageName];
  if (actual !== expectedSpecifier) {
    fail(`${relativePath} must pin ${packageName} to ${expectedSpecifier}, got ${JSON.stringify(actual)}`);
  }
}

export function verifyPdppVendoredPackagePins(repoRoot: string): void {
  const sums = readSha256Sums(repoRoot);
  const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const consumerPaths = ["reference-implementation/package.json", "packages/polyfill-connectors/package.json"];

  for (const expected of EXPECTED_PACKAGES) {
    const archivePath = join(repoRoot, expected.archive);
    const archiveManifest = archivePackageManifest(archivePath);
    if (archiveManifest.name !== expected.name || archiveManifest.version !== EXPECTED_PACKAGE_VERSION) {
      fail(
        `${expected.archive} contains ${JSON.stringify({ name: archiveManifest.name, version: archiveManifest.version })}; ` +
          `expected ${expected.name}@${EXPECTED_PACKAGE_VERSION}`
      );
    }

    const actualSha256 = digest(archivePath, "sha256");
    const expectedSha256 = sums.get(expected.archive);
    if (expectedSha256 !== actualSha256) {
      fail(`${expected.archive} SHA-256 is ${actualSha256}, expected ${JSON.stringify(expectedSha256)}`);
    }

    const actualSha512 = digest(archivePath, "sha512");
    const lockNeedle = `  '${expected.name}@file:${expected.archive}':`;
    const lockStart = lockfile.indexOf(lockNeedle);
    const lockSection = lockStart === -1 ? "" : lockfile.slice(lockStart, lockStart + 320);
    const lockMatch = LOCK_INTEGRITY.exec(lockSection);
    if (!lockMatch) {
      fail(`pnpm-lock.yaml has no integrity for ${expected.archive}`);
    }
    const [, encodedLockSha512] = lockMatch;
    if (!encodedLockSha512) {
      fail(`pnpm-lock.yaml has an empty integrity for ${expected.archive}`);
    }
    const decodedLockSha512 = Buffer.from(encodedLockSha512, "base64").toString("hex");
    if (decodedLockSha512 !== actualSha512) {
      fail(`${expected.archive} SHA-512 does not match pnpm-lock.yaml`);
    }

    for (const consumerPath of consumerPaths) {
      assertConsumerPin(repoRoot, consumerPath, expected.name, expected.archive);
    }
    if (lockfile.includes(expected.archive.replace(EXPECTED_PACKAGE_VERSION, PRIOR_PACKAGE_VERSION))) {
      fail(`pnpm-lock.yaml retains a stale ${PRIOR_PACKAGE_VERSION} pin for ${expected.name}`);
    }
  }

  const runtimeManifest = archivePackageManifest(join(repoRoot, EXPECTED_PACKAGES[0].archive));
  if (runtimeManifest.dependencies?.["@pdpp/connector-protocol"] !== EXPECTED_PACKAGE_VERSION) {
    fail(`collector-runtime must depend on connector-protocol ${EXPECTED_PACKAGE_VERSION} exactly`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyPdppVendoredPackagePins(fileURLToPath(new URL("..", import.meta.url)));
  console.log("PDPP vendored package pins: verified");
}
