// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTABLE_PERMISSION = /[1357]/;
const TEST_ARTIFACT_PATH = /(^|\/)\.?.+\.test\.(?:js|mjs|cjs|ts|mts|cts)$/;
const NPM_PACK_JSON = /(\[\s*\{[\s\S]*\])\s*$/;

// Loosely typed on purpose: this describes the runtime shape of an untrusted
// `package.json` read from disk, which assertManifestTargets/assertPackedFiles
// validate rather than assume — an `as PackageManifest` cast at the read site
// doesn't guarantee any of these fields actually have the declared shape.
export interface PackageManifest {
  bin: unknown;
  dependencies?: Record<string, string>;
  exports: unknown;
  files: string[];
  name: string;
}

interface ExportTarget {
  label: string;
  target: string;
}

interface NpmPackEntry {
  filename: string;
  files: Array<{ path: string }>;
}

function assertInsideDist(root: string, target: string, label: string): string {
  assert.equal(typeof target, "string", `${label} must be a string target`);
  assert.equal(target.startsWith("./dist/"), true, `${label} must point into ./dist/: ${target}`);

  const distRoot = resolve(root, "dist");
  const targetPath = resolve(root, target);
  const targetRelative = relative(distRoot, targetPath);
  assert.equal(
    targetRelative === "" || (!targetRelative.startsWith(`..${sep}`) && targetRelative !== ".."),
    true,
    `${label} escapes dist/: ${target}`
  );
  assert.equal(existsSync(targetPath), true, `${label} is missing: ${target}`);
  assert.equal(statSync(targetPath).isFile(), true, `${label} must resolve to a file: ${target}`);
  return targetPath;
}

export function collectExportTargets(value: unknown, label: string, targets: ExportTarget[]): void {
  if (typeof value === "string") {
    targets.push({ label, target: value });
    return;
  }
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${label} is invalid`);
  for (const [condition, target] of Object.entries(value as Record<string, unknown>)) {
    collectExportTargets(target, `${label}.${condition}`, targets);
  }
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, label);
  return value as Record<string, unknown>;
}

export function declaredExportSpecifiers(manifest: PackageManifest): string[] {
  const specifiers: string[] = [];
  const exportsMap = assertPlainObject(manifest.exports, "package must declare exports");
  for (const subpath of Object.keys(exportsMap)) {
    specifiers.push(subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`);
  }
  return specifiers;
}

export function assertManifestTargets(manifest: PackageManifest, root: string): void {
  assert.equal(manifest.name, "@pdpp/mcp-server", "package manifest must identify @pdpp/mcp-server");
  assert.equal(Array.isArray(manifest.files), true, "package manifest must have a files allowlist");
  assert.equal(manifest.files.includes("dist/"), true, "package files must include dist/");
  for (const forbidden of ["src/", "bin/", "test/", "scripts/"]) {
    assert.equal(manifest.files.includes(forbidden), false, `package files must not publish ${forbidden}`);
  }

  const exportTargets: ExportTarget[] = [];
  const exportsMap = assertPlainObject(manifest.exports, "package must declare exports");
  for (const [subpath, value] of Object.entries(exportsMap)) {
    collectExportTargets(value, `exports[${JSON.stringify(subpath)}]`, exportTargets);
  }
  assert.ok(exportTargets.length > 0, "package must expose at least one export");
  for (const { label, target } of exportTargets) {
    assert.equal(
      target.endsWith(".js") || target.endsWith(".d.ts"),
      true,
      `${label} must point to emitted JavaScript or declarations: ${target}`
    );
    assertInsideDist(root, target, label);
  }

  const binMap = assertPlainObject(manifest.bin, "package must declare a bin map") as Record<string, string>;
  for (const [name, target] of Object.entries(binMap)) {
    const targetPath = assertInsideDist(root, target, `bin.${name}`);
    assert.equal(target.endsWith(".js"), true, `bin.${name} must point to emitted JavaScript: ${target}`);
    assert.match(
      (statSync(targetPath).mode % 0o1000).toString(8),
      EXECUTABLE_PERMISSION,
      `bin.${name} must be executable: ${target}`
    );
    assert.equal(
      readFileSync(targetPath, "utf8").startsWith("#!/usr/bin/env node"),
      true,
      `bin.${name} must retain its node shebang: ${target}`
    );
  }

  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    assert.equal(typeof range, "string", `dependency ${name} must declare a string range`);
    assert.equal(
      range.startsWith("workspace:") || range.startsWith("file:"),
      false,
      `dependency ${name} must be publishable: ${range}`
    );
  }
}

export function assertPackedFiles(manifest: PackageManifest, packedFiles: string[]): void {
  const files = new Set(packedFiles);
  for (const file of files) {
    assert.equal(file.startsWith("src/"), false, `source file leaked into package: ${file}`);
    assert.equal(file.startsWith("bin/"), false, `source bin leaked into package: ${file}`);
    assert.equal(file.startsWith("test/"), false, `test file leaked into package: ${file}`);
    assert.equal(file.startsWith("scripts/"), false, `build script leaked into package: ${file}`);
    assert.equal(TEST_ARTIFACT_PATH.test(file), false, `test artifact leaked into package: ${file}`);
    assert.equal(file.endsWith(".ts") && !file.endsWith(".d.ts"), false, `raw TypeScript leaked into package: ${file}`);
  }

  const exportTargets: ExportTarget[] = [];
  const exportsMap = assertPlainObject(manifest.exports, "package must declare exports");
  for (const [subpath, value] of Object.entries(exportsMap)) {
    collectExportTargets(value, `exports[${JSON.stringify(subpath)}]`, exportTargets);
  }
  for (const { target } of exportTargets) {
    assert.equal(files.has(target.slice(2)), true, `packed export target is missing: ${target}`);
  }
  const binMap = assertPlainObject(manifest.bin, "package must declare a bin map") as Record<string, string>;
  for (const [name, target] of Object.entries(binMap)) {
    assert.equal(files.has(target.slice(2)), true, `packed bin target is missing: ${name} -> ${target}`);
  }
}

export function parseNpmPackOutput(output: string): NpmPackEntry[] {
  const match = output.match(NPM_PACK_JSON);
  assert.ok(match, "npm pack did not produce a trailing JSON payload");
  return JSON.parse(match[1] as string) as NpmPackEntry[];
}

export function packAndInspect(root: string, manifest: PackageManifest): NpmPackEntry {
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  });
  const [pack] = parseNpmPackOutput(output);
  assert.ok(pack, "npm pack produced no entries");
  assertPackedFiles(
    manifest,
    pack.files.map((file) => file.path)
  );
  return pack;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as PackageManifest;
  assertManifestTargets(manifest, packageRoot);
  const pack = packAndInspect(packageRoot, manifest);
  try {
    process.stdout.write(
      `Validated MCP tarball files (${pack.files.length}): ${pack.files.map((file) => file.path).join(", ")}\n`
    );
  } finally {
    rmSync(resolve(packageRoot, pack.filename), { force: true });
  }
}
