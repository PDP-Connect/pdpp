// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { relative, resolve, sep } from "node:path";

const TEST_ARTIFACT = /(^|\/)\.?.+\.test\.(?:js|mjs|cjs|ts|mts|cts)$/;
const WHITESPACE = /\s/;
const NPM_PACK_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

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

interface ExportTarget {
  label: string;
  target: string;
}

interface NpmPackResult {
  filename: string;
  files: Array<{ path: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeNpmPackPayload(payload: unknown): NpmPackResult[] {
  let entries: unknown[];
  if (Array.isArray(payload)) {
    entries = payload;
  } else if (isRecord(payload)) {
    entries = typeof payload.filename === "string" ? [payload] : Object.values(payload);
  } else {
    entries = [];
  }

  assert.ok(entries.length > 0, "npm pack did not produce a non-empty JSON payload");
  return entries.map((entry, index) => {
    assert.ok(isRecord(entry), `npm pack result ${index} is not an object`);
    assert.equal(typeof entry.filename, "string", `npm pack result ${index} has no filename`);
    assert.ok(Array.isArray(entry.files), `npm pack result ${index} has no files list`);
    for (const [fileIndex, file] of entry.files.entries()) {
      assert.ok(isRecord(file), `npm pack result ${index} file ${fileIndex} is not an object`);
      assert.equal(typeof file.path, "string", `npm pack result ${index} file ${fileIndex} has no path`);
    }
    return entry as unknown as NpmPackResult;
  });
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
  dependencies?: Record<string, string>;
  exports: Record<string, unknown>;
  files: string[];
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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
  return segments[0];
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
      if (isBareSpecifier(specifier) && !specifier.startsWith("node:")) {
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
 * code actually imports, so a bare specifier undeclared in package.json can
 * slip through both untouched. This closes that gap: every bare import,
 * export-from, dynamic import(), and require() specifier compiled into the
 * packed `.js`/`.mjs`/`.d.ts` files must resolve to either a Node builtin or
 * a package the manifest actually declares as a real (non-workspace,
 * non-file:) dependency. `@pdpp/cli` currently declares no runtime
 * dependencies at all, so today this means: no bare specifiers other than
 * Node builtins may appear in the packed output.
 */
export function assertBareSpecifiersResolve(
  manifest: PackageManifest,
  extractedRoot: string,
  packedFiles: string[]
): void {
  const declaredPackages = new Set<string>([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);

  for (const file of packedFiles) {
    if (!(file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".d.ts"))) {
      continue;
    }
    const source = readFileSync(resolve(extractedRoot, file), "utf8");
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
            "declared in dependencies/peerDependencies/optionalDependencies. This is the exact defect that made " +
            "every published @pdpp/local-collector 1.5.1-1.5.4 unrunnable (ERR_MODULE_NOT_FOUND on every " +
            "install). Declare a real dependency, vendor the needed symbol, or rewrite the specifier at build " +
            "time before packing."
        );
      }
      throw new Error(
        `${file} imports "${specifier}" (package "${packageName}") which is not declared in ` +
          "dependencies/peerDependencies/optionalDependencies and is not a Node builtin. A clean npm install of " +
          "this package would fail to resolve this import at runtime."
      );
    }
  }
}

export function parseNpmPackOutput(output: string): NpmPackResult[] {
  assert.ok(
    Buffer.byteLength(output, "utf8") <= NPM_PACK_OUTPUT_MAX_BYTES,
    `npm pack output exceeds the ${NPM_PACK_OUTPUT_MAX_BYTES}-byte limit`
  );

  const trimmed = output.trimEnd();
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    let searchEnd = trimmed.length;
    while (searchEnd > 0 && payload === undefined) {
      const newline = trimmed.lastIndexOf("\n", searchEnd - 1);
      const lineStart = newline + 1;
      const lineEnd = searchEnd;
      let candidateStart = lineStart;
      while (candidateStart < lineEnd && WHITESPACE.test(trimmed[candidateStart] ?? "")) {
        candidateStart += 1;
      }

      if (trimmed[candidateStart] === "[" || trimmed[candidateStart] === "{") {
        try {
          payload = JSON.parse(trimmed.slice(candidateStart));
        } catch {
          // A nested array/object line is not the root payload; keep looking
          // toward the beginning of the bounded output.
        }
      }

      searchEnd = newline >= 0 ? newline : 0;
    }
  }

  assert.ok(payload !== undefined, "npm pack did not produce a trailing JSON payload");
  return normalizeNpmPackPayload(payload);
}
