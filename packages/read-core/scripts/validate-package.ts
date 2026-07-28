// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { type NpmRuntime, resolveNpmRuntime, runNpm } from "./npm-runtime.ts";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const emittedJavaScriptPattern = /^\.\/dist\/.+\.js$/;
const packageRelativePattern = /^\.\//;
const pathSeparatorPattern = /[\\/]/;
const testArtifactPattern = /(^|\/)\.test\./;
const packJsonPattern = /^\[\s*\{/m;
const scopedPackagePattern = /^@/;
const packageNameSeparatorPattern = /\//;
const packageEntryPattern = /^package\//;
const lexicographicCompare = (left: string, right: string): number => left.localeCompare(right);

interface PackageManifest {
  bin?: string | Record<string, string>;
  exports?: Record<string, string | Record<string, unknown>>;
  main?: string;
  name: string;
  types?: string;
  version: string;
}

interface PackInfo {
  files: Array<{ path: string }>;
}

export function exportedTargets(manifest: PackageManifest): string[] {
  return Object.values(manifest.exports ?? {}).flatMap((target) => (typeof target === "string" ? [target] : []));
}

export function declaredFileTargets(manifest: PackageManifest): [string, string][] {
  const targets: [string, string][] = exportedTargets(manifest).map((target) => ["exports", target]);
  if (typeof manifest.main === "string") {
    targets.push(["main", manifest.main]);
  }
  if (typeof manifest.types === "string") {
    targets.push(["types", manifest.types]);
  }
  const binTargets = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
  for (const target of binTargets) {
    if (typeof target === "string") {
      targets.push(["bin", target]);
    }
  }
  return targets;
}

export async function assertManifestTargets(manifest: PackageManifest, root: string): Promise<void> {
  const targets = exportedTargets(manifest);
  assert.ok(targets.length > 0, "package.json must declare at least one export target");
  for (const target of targets) {
    assert.match(target, emittedJavaScriptPattern, `export target must be emitted JavaScript: ${target}`);
  }
  const declaredTargets = declaredFileTargets(manifest);
  for (const [field, target] of declaredTargets) {
    assert.equal(
      path.isAbsolute(target) || path.win32.isAbsolute(target),
      false,
      `${field} must be package-relative: ${target}`
    );
    assert.equal(
      target.split(pathSeparatorPattern).includes(".."),
      false,
      `${field} must stay within the package: ${target}`
    );
  }
  await Promise.all(
    declaredTargets.map(([, target]) => stat(path.join(root, target.replace(packageRelativePattern, ""))))
  );
}

export function assertPackedFiles(packedFiles: string[], manifest: PackageManifest): void {
  for (const [field, target] of declaredFileTargets(manifest)) {
    assert.ok(
      packedFiles.includes(target.replace(packageRelativePattern, "")),
      `missing packed ${field} target: ${target}`
    );
  }

  for (const file of packedFiles) {
    assert.equal(file.startsWith("src/"), false, `source file leaked into package: ${file}`);
    assert.equal(file.startsWith("test/"), false, `test file leaked into package: ${file}`);
    assert.equal(file.startsWith("scripts/"), false, `build script leaked into package: ${file}`);
    assert.equal(testArtifactPattern.test(file), false, `test artifact leaked into package: ${file}`);
    assert.equal(file.endsWith(".ts") && !file.endsWith(".d.ts"), false, `raw TypeScript leaked into package: ${file}`);
    assert.equal(file.endsWith(".d.ts"), false, `unexpected declaration artifact leaked into package: ${file}`);
  }
}

export function parsePackInfo(output: string): PackInfo | null {
  const jsonStart = output.search(packJsonPattern);
  return jsonStart === -1 ? null : JSON.parse(output.slice(jsonStart))[0];
}

export async function packAndInspect(
  root: string,
  manifest: PackageManifest,
  options: { npmRuntime?: NpmRuntime; env?: NodeJS.ProcessEnv } = {}
): Promise<{
  npmExecutable: string;
  npmVersion: string;
  packedFiles: string[];
  tarballHash: string;
  tarballPath: string;
}> {
  const tarballFilename = `${manifest.name.replace(scopedPackagePattern, "").replace(packageNameSeparatorPattern, "-")}-${manifest.version}.tgz`;
  const tarballPath = path.join(root, tarballFilename);
  await rm(tarballPath, { force: true });
  const npmRuntime = options.npmRuntime ?? (await resolveNpmRuntime(options.env ?? process.env));
  const { stdout } = await runNpm(npmRuntime, ["pack", "--json", "--ignore-scripts"], { cwd: root });
  const packInfo = parsePackInfo(stdout);
  await stat(tarballPath);
  const { stdout: tarListing } = (await execFileAsync("tar", ["-tzf", tarballPath])) as { stdout: string };
  const packedFiles = tarListing
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(packageEntryPattern, ""))
    .sort(lexicographicCompare);
  if (packInfo) {
    assert.deepEqual(
      packedFiles,
      packInfo.files.map((file) => file.path).sort(lexicographicCompare),
      "npm and tar file lists must agree"
    );
  }
  assertPackedFiles(packedFiles, manifest);
  const tarballHash = createHash("sha256")
    .update(await readFile(tarballPath))
    .digest("hex");
  return {
    npmExecutable: npmRuntime.executable,
    npmVersion: npmRuntime.version,
    packedFiles,
    tarballHash,
    tarballPath,
  };
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as PackageManifest;
  assert.equal(
    (manifest as unknown as { types?: string }).types,
    undefined,
    "read-core does not expose a declaration contract"
  );
  await assertManifestTargets(manifest, packageRoot);
  const { npmExecutable, npmVersion, packedFiles, tarballHash, tarballPath } = await packAndInspect(
    packageRoot,
    manifest
  );
  try {
    process.stdout.write(`Validated npm: ${npmExecutable} (${npmVersion})\n`);
    process.stdout.write(`Validated tarball sha256: ${tarballHash}\n`);
    process.stdout.write(`Validated tarball files (${packedFiles.length}): ${packedFiles.join(", ")}\n`);
  } finally {
    await rm(tarballPath, { force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
