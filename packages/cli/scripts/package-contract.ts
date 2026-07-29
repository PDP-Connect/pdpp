// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const TEST_ARTIFACT = /(^|\/)\.?.+\.test\.(?:js|mjs|cjs|ts|mts|cts)$/;
const NPM_PACK_JSON = /(\[\s*\{[\s\S]*\])\s*$/;

interface ExportTarget {
  label: string;
  target: string;
}

function assertInsideDist(packageRoot: string, target: string, label: string): { target: string; targetPath: string } {
  assert.equal(typeof target, "string", `${label} must be a string target`);
  assert.equal(target.startsWith("./dist/"), true, `${label} must point into ./dist/: ${target}`);

  const distRoot = resolve(packageRoot, "dist");
  const targetPath = resolve(packageRoot, target);
  const targetRelative = relative(distRoot, targetPath);
  assert.equal(
    targetRelative === "" || (!targetRelative.startsWith(`..${sep}`) && targetRelative !== ".."),
    true,
    `${label} escapes dist/: ${target}`
  );
  assert.equal(existsSync(targetPath), true, `${label} is missing: ${target}`);
  return { target, targetPath };
}

function collectExportTargets(value: unknown, label: string, targets: ExportTarget[]): void {
  if (typeof value === "string") {
    targets.push({ label, target: value });
    return;
  }
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${label} is invalid`);
  for (const [condition, target] of Object.entries(value as Record<string, unknown>)) {
    collectExportTargets(target, `${label}.${condition}`, targets);
  }
}

export interface PackageManifest {
  bin: Record<string, string>;
  exports: Record<string, unknown>;
  files: string[];
  name: string;
}

export function assertManifestTargets(manifest: unknown, packageRoot: string): asserts manifest is PackageManifest {
  const m = manifest as PackageManifest;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  assert.equal(m?.name, "@pdpp/cli", "package manifest must identify @pdpp/cli");
  assert.equal(Array.isArray(m.files), true, "package manifest must have a files allowlist");
  assert.equal(m.files.includes("dist/"), true, "package files must include dist/");
  for (const forbidden of ["src/", "bin/", "test/"]) {
    assert.equal(m.files.includes(forbidden), false, `package files must not publish ${forbidden}`);
  }

  const exportTargets: ExportTarget[] = [];
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  assert.equal(m.exports !== null && typeof m.exports === "object", true, "package must declare exports");
  for (const [subpath, value] of Object.entries(m.exports)) {
    collectExportTargets(value, `exports[${JSON.stringify(subpath)}]`, exportTargets);
  }
  assert.ok(exportTargets.length > 0, "package must expose at least one export");

  for (const { label, target } of exportTargets) {
    const { targetPath } = assertInsideDist(packageRoot, target, label);
    assert.equal(
      target.endsWith(".js") || target.endsWith(".d.ts"),
      true,
      `${label} must point to emitted JavaScript or declarations: ${target}`
    );
    assert.equal(statSync(targetPath).isFile(), true, `${label} must resolve to a file: ${target}`);
  }

  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  assert.equal(m.bin !== null && typeof m.bin === "object", true, "package must declare a bin map");
  for (const [name, target] of Object.entries(m.bin)) {
    const { targetPath } = assertInsideDist(packageRoot, target, `bin.${name}`);
    assert.equal(target.endsWith(".js"), true, `bin.${name} must point to emitted JavaScript: ${target}`);
    assert.equal(statSync(targetPath).isFile(), true, `bin.${name} must resolve to a file: ${target}`);
    // biome-ignore lint/suspicious/noBitwiseOperators: intentional bitwise check for executable bit
    assert.notEqual(statSync(targetPath).mode & 0o111, 0, `bin.${name} must be executable: ${target}`);
    assert.equal(
      readFileSync(targetPath, "utf8").startsWith("#!/usr/bin/env node"),
      true,
      `bin.${name} must retain its node shebang: ${target}`
    );
  }
}

export function assertPackedFiles(manifest: PackageManifest, packedFiles: string[]): void {
  const files = new Set(packedFiles);
  for (const file of files) {
    assert.equal(file.startsWith("src/"), false, `source file leaked into package: ${file}`);
    assert.equal(file.startsWith("bin/"), false, `source bin leaked into package: ${file}`);
    assert.equal(file.startsWith("test/"), false, `test file leaked into package: ${file}`);
    assert.equal(TEST_ARTIFACT.test(file), false, `test artifact leaked into package: ${file}`);
    assert.equal(file.endsWith(".ts") && !file.endsWith(".d.ts"), false, `raw TypeScript leaked into package: ${file}`);
  }

  const exportTargets: ExportTarget[] = [];
  for (const [subpath, value] of Object.entries(manifest.exports)) {
    collectExportTargets(value, `exports[${JSON.stringify(subpath)}]`, exportTargets);
  }
  for (const { target } of exportTargets) {
    assert.equal(files.has(target.slice(2)), true, `packed export target is missing: ${target}`);
  }
  for (const [name, target] of Object.entries(manifest.bin)) {
    assert.equal(files.has(target.slice(2)), true, `packed bin target is missing: ${name} -> ${target}`);
  }
}

export function parseNpmPackOutput(output: string): Array<{ filename: string }> {
  const match = output.match(NPM_PACK_JSON);
  assert.ok(match, "npm pack did not produce a trailing JSON payload");
  return JSON.parse(match[1]) as Array<{ filename: string }>;
}
