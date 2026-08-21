// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTABLE_PERMISSION = /[1357]/;
const TEST_ARTIFACT_PATH = /(^|\/)\.?.+\.test\.(?:js|mjs|cjs|ts|mts|cts)$/;
const NPM_PACK_JSON = /(\[\s*\{[\s\S]*\])\s*$/;
const NPM_PACK_JSON_OBJECT = /(\{\s*"[^"]*"\s*:\s*\{[\s\S]*\})\s*$/;

// Node's built-in module names, with and without the `node:` prefix.
const NODE_BUILTIN_SPECIFIERS = new Set<string>(builtinModules.flatMap((name) => [name, `node:${name}`]));

// Static `import`/`export` are anchored to the start of a line (optionally
// indented): tsc/esbuild output always emits these as statements starting a
// line, never mid-expression, so anchoring avoids false positives on runtime
// code that merely contains the words "import"/"export" inside a string or
// property access. `export` additionally requires a trailing `from "…"` —
// the only valid syntax for a re-export naming a module specifier.
const STATIC_IMPORT_OR_EXPORT_FROM =
  /^[ \t]*(?:import\s+(?:[^"'\n;]*?\s+from\s+)?["']([^"'.][^"']*)["']|export\s+[^"'\n;]*?\s+from\s+["']([^"'.][^"']*)["'])/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g;
const REQUIRE_CALL = /\brequire\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g;

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

/**
 * Resolve a bare import specifier to the npm package name it names: the
 * whole specifier for an unscoped package (`zod` from `zod/v4`), or the
 * first two path segments for a scoped package (`@pdpp/read-core` from
 * `@pdpp/read-core/records`).
 */
function bareSpecifierPackageName(specifier: string): string {
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    return segments.slice(0, 2).join("/");
  }
  return segments[0] ?? specifier;
}

function isBareSpecifier(specifier: string): boolean {
  return !(specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:"));
}

/**
 * Extract every bare (non-relative, non-absolute) import/export/require
 * specifier a compiled `.js`/`.mjs`/`.d.ts` file references: static
 * `import … from "x"` (including the bare side-effect form `import "x"`),
 * `export … from "x"`, dynamic `import("x")`, and `require("x")`.
 */
function bareImportSpecifiers(source: string): Set<string> {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(STATIC_IMPORT_OR_EXPORT_FROM)) {
    const specifier = match[1] ?? match[2];
    if (specifier && isBareSpecifier(specifier) && !specifier.startsWith("node:")) {
      specifiers.add(specifier);
    }
  }
  for (const pattern of [DYNAMIC_IMPORT, REQUIRE_CALL]) {
    for (const [, specifier] of source.matchAll(pattern)) {
      if (specifier && isBareSpecifier(specifier) && !specifier.startsWith("node:")) {
        specifiers.add(specifier);
      }
    }
  }
  return specifiers;
}

/**
 * Every published `@pdpp/local-collector` 1.5.1-1.5.4 shipped a compiled
 * `import … from "@pdpp/reference-contract/common"` that was not in
 * `dependencies` and does not exist on the npm registry: it resolved for
 * every developer through the pnpm workspace link and failed closed for
 * every real npm install with `ERR_MODULE_NOT_FOUND`. Neither
 * `assertManifestTargets` (declared dependency sections only) nor
 * `assertPackedFiles` (packed file layout only) looks at what the packed
 * code actually imports, so a bare specifier undeclared in package.json
 * can slip through both untouched. This closes that gap: every bare import,
 * export-from, dynamic import(), and require() specifier compiled into the
 * packed `.js`/`.mjs`/`.d.ts` files must resolve to either a Node builtin or
 * a package the manifest actually declares as a real (non-workspace,
 * non-file:) dependency.
 */
export function assertBareSpecifiersResolve(manifest: PackageManifest, root: string, packedFiles: string[]): void {
  const declaredPackages = new Set<string>(Object.keys(manifest.dependencies ?? {}));

  for (const file of packedFiles) {
    if (!(file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".d.ts"))) {
      continue;
    }
    const source = readFileSync(resolve(root, file), "utf8");
    for (const specifier of bareImportSpecifiers(source)) {
      const packageName = bareSpecifierPackageName(specifier);
      if (NODE_BUILTIN_SPECIFIERS.has(specifier) || NODE_BUILTIN_SPECIFIERS.has(packageName)) {
        continue;
      }
      if (declaredPackages.has(packageName)) {
        continue;
      }
      if (packageName.startsWith("@pdpp/")) {
        throw new Error(
          `${file} imports private workspace package "${packageName}" (specifier "${specifier}") which is not ` +
            "declared in dependencies. This is the exact defect that made every published @pdpp/local-collector " +
            "1.5.1-1.5.4 unrunnable (ERR_MODULE_NOT_FOUND on every install). Declare a real dependency, vendor " +
            "the needed symbol, or rewrite the specifier at build time before packing."
        );
      }
      throw new Error(
        `${file} imports "${specifier}" (package "${packageName}") which is not declared in dependencies and is ` +
          "not a Node builtin. A clean npm install of this package would fail to resolve this import at runtime."
      );
    }
  }
}

export function parseNpmPackOutput(output: string): NpmPackEntry[] {
  // npm's `pack --json` output shape changed across major versions: older npm
  // (<=11) emits a top-level array of one record; npm 12 emits an object
  // keyed by package name instead. Accept either, and tolerate `npm warn`
  // lines ahead of the JSON payload (observed in this environment), rather
  // than pinning this check to one npm major/config shape.
  const arrayMatch = output.match(NPM_PACK_JSON);
  if (arrayMatch) {
    return JSON.parse(arrayMatch[1] as string) as NpmPackEntry[];
  }
  const objectMatch = output.match(NPM_PACK_JSON_OBJECT);
  assert.ok(objectMatch, "npm pack did not produce a trailing JSON payload");
  const parsed = JSON.parse(objectMatch[1] as string) as Record<string, NpmPackEntry>;
  return Object.values(parsed);
}

export function packAndInspect(root: string, manifest: PackageManifest): NpmPackEntry {
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  });
  const [pack] = parseNpmPackOutput(output);
  assert.ok(pack, "npm pack produced no entries");
  const packedFiles = pack.files.map((file) => file.path);
  assertPackedFiles(manifest, packedFiles);
  assertBareSpecifiersResolve(manifest, root, packedFiles);
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
