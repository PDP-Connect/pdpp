#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Hermetic guard for scripts/check-pdpp-vendored-package-pins.ts.
//
// Builds a minimal fixture repo (fake tarballs, SHA256SUMS, pnpm-lock.yaml,
// consumer package.json files) so the checker's logic is exercised without
// touching the real vendor/ artifacts. The mutants below prove the checker
// actually rejects a stale pnpm-lock.yaml pin at EITHER prior package
// version (0.0.1, from before the tarball-vendoring switch; 0.0.2, the
// version immediately preceding the current 1.0.0 pin) — not just the one
// version this repo happened to move from most recently.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EXPECTED_PACKAGE_VERSION,
  EXPECTED_PACKAGES,
  verifyPdppVendoredPackagePins,
} from "./check-pdpp-vendored-package-pins.ts";

function packFixtureTarball(archivePath: string, manifest: Record<string, unknown>): void {
  const stageDir = mkdtempSync(join(tmpdir(), "pdpp-pin-fixture-stage-"));
  const packageDir = join(stageDir, "package");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify(manifest, null, 2));
  execFileSync("tar", ["-czf", archivePath, "-C", stageDir, "package"]);
  rmSync(stageDir, { recursive: true, force: true });
}

function sha256Sum(path: string): string {
  return execFileSync("sha256sum", [path], { encoding: "utf8" }).split(/\s+/)[0] ?? "";
}

function sha512IntegrityBase64(path: string): string {
  const hex = execFileSync("sha512sum", [path], { encoding: "utf8" }).split(/\s+/)[0] ?? "";
  return Buffer.from(hex, "hex").toString("base64");
}

/**
 * A minimal, otherwise-fully-valid fixture repo pinned at EXPECTED_PACKAGE_VERSION.
 * Callers mutate one thing (a stale lockfile pin, a wrong hash, ...) per test.
 */
function buildValidFixtureRepo(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "pdpp-pin-fixture-repo-"));
  mkdirSync(join(root, "vendor"), { recursive: true });
  mkdirSync(join(root, "packages/polyfill-connectors"), { recursive: true });

  const runtimeArchive = EXPECTED_PACKAGES[0].archive;
  const protocolArchive = EXPECTED_PACKAGES[1].archive;
  const runtimePath = join(root, runtimeArchive);
  const protocolPath = join(root, protocolArchive);

  packFixtureTarball(protocolPath, {
    name: "@pdpp/connector-protocol",
    version: EXPECTED_PACKAGE_VERSION,
  });
  packFixtureTarball(runtimePath, {
    name: "@pdpp/collector-runtime",
    version: EXPECTED_PACKAGE_VERSION,
    dependencies: { "@pdpp/connector-protocol": EXPECTED_PACKAGE_VERSION },
  });

  const runtimeSha256 = sha256Sum(runtimePath);
  const protocolSha256 = sha256Sum(protocolPath);
  writeFileSync(
    join(root, "vendor/SHA256SUMS"),
    `${runtimeSha256}  ${runtimeArchive}\n${protocolSha256}  ${protocolArchive}\n`
  );

  const runtimeIntegrity = sha512IntegrityBase64(runtimePath);
  const protocolIntegrity = sha512IntegrityBase64(protocolPath);
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    [
      `  '@pdpp/collector-runtime@file:${runtimeArchive}':`,
      `    resolution: {integrity: sha512-${runtimeIntegrity}, tarball: file:${runtimeArchive}}`,
      `  '@pdpp/connector-protocol@file:${protocolArchive}':`,
      `    resolution: {integrity: sha512-${protocolIntegrity}, tarball: file:${protocolArchive}}`,
      "",
    ].join("\n")
  );

  writeFileSync(
    join(root, "packages/polyfill-connectors/package.json"),
    JSON.stringify(
      {
        dependencies: {
          "@pdpp/collector-runtime": `file:../../${runtimeArchive}`,
          "@pdpp/connector-protocol": `file:../../${protocolArchive}`,
        },
      },
      null,
      2
    )
  );

  return { root };
}

function cleanupFixtureRepo(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test("a fully valid fixture repo passes", () => {
  const { root } = buildValidFixtureRepo();
  try {
    assert.doesNotThrow(() => verifyPdppVendoredPackagePins(root));
  } finally {
    cleanupFixtureRepo(root);
  }
});

for (const staleVersion of ["0.0.1", "0.0.2"]) {
  test(`rejects a pnpm-lock.yaml that retains a stale ${staleVersion} pin alongside the current one`, () => {
    const { root } = buildValidFixtureRepo();
    try {
      const staleArchive = EXPECTED_PACKAGES[0].archive.replace(EXPECTED_PACKAGE_VERSION, staleVersion);
      const lockPath = join(root, "pnpm-lock.yaml");
      const staleLine = `  '@pdpp/collector-runtime@file:${staleArchive}':\n    resolution: {integrity: sha512-deadbeef, tarball: file:${staleArchive}}\n`;
      writeFileSync(lockPath, staleLine, { flag: "a" });

      assert.throws(
        () => verifyPdppVendoredPackagePins(root),
        (error: unknown) => {
          assert.match((error as Error).message, new RegExp(`stale ${staleVersion.replace(".", "\\.")} pin`));
          return true;
        }
      );
    } finally {
      cleanupFixtureRepo(root);
    }
  });
}

test("rejects a collector-runtime tarball whose packed dependency is not pinned to the expected version", () => {
  const { root } = buildValidFixtureRepo();
  try {
    const runtimeArchive = EXPECTED_PACKAGES[0].archive;
    const runtimePath = join(root, runtimeArchive);
    packFixtureTarball(runtimePath, {
      name: "@pdpp/collector-runtime",
      version: EXPECTED_PACKAGE_VERSION,
      dependencies: { "@pdpp/connector-protocol": "0.0.1" },
    });
    const runtimeSha256 = sha256Sum(runtimePath);
    const protocolArchive = EXPECTED_PACKAGES[1].archive;
    const protocolSha256 = sha256Sum(join(root, protocolArchive));
    writeFileSync(
      join(root, "vendor/SHA256SUMS"),
      `${runtimeSha256}  ${runtimeArchive}\n${protocolSha256}  ${protocolArchive}\n`
    );
    const runtimeIntegrity = sha512IntegrityBase64(runtimePath);
    const protocolIntegrity = sha512IntegrityBase64(join(root, protocolArchive));
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      [
        `  '@pdpp/collector-runtime@file:${runtimeArchive}':`,
        `    resolution: {integrity: sha512-${runtimeIntegrity}, tarball: file:${runtimeArchive}}`,
        `  '@pdpp/connector-protocol@file:${protocolArchive}':`,
        `    resolution: {integrity: sha512-${protocolIntegrity}, tarball: file:${protocolArchive}}`,
        "",
      ].join("\n")
    );

    assert.throws(
      () => verifyPdppVendoredPackagePins(root),
      (error: unknown) => {
        assert.match((error as Error).message, /connector-protocol 1\.0\.0 exactly/);
        return true;
      }
    );
  } finally {
    cleanupFixtureRepo(root);
  }
});
