// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { npmPackMetadata } from "./pack-metadata.ts";

interface Manifest {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  main?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  types?: string;
}

interface PackedFileInfo {
  path: string;
}

interface PackMetadata {
  files: PackedFileInfo[];
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as Manifest;

for (const [sectionName, deps] of Object.entries({
  dependencies: packageJson.dependencies,
  optionalDependencies: packageJson.optionalDependencies,
  peerDependencies: packageJson.peerDependencies,
})) {
  for (const [name, range] of Object.entries(deps ?? {})) {
    assert.equal(typeof range, "string", `${sectionName}.${name} must use a string range`);
    assert.equal(range.startsWith("workspace:"), false, `${sectionName}.${name} leaks workspace range ${range}`);
    assert.equal(name.startsWith("@pdpp/"), false, `${sectionName}.${name} leaks private package dependency`);
  }
}

const requiredFiles = new Set([
  "README.md",
  "dist/local-collector/bin/pdpp-local-collector.js",
  "dist/local-collector/src/errors.js",
  "dist/local-collector/src/runner.js",
  "dist/polyfill-connectors/connectors/claude_code/index.js",
  "dist/polyfill-connectors/connectors/codex/index.js",
]);

const packInfo = (await npmPackMetadata({ cwd: packageRoot })) as PackMetadata;
const packedFiles = packInfo.files.map((file) => file.path).sort((a, b) => a.localeCompare(b));
const packedFileSet = new Set(packedFiles);

assertPublishedEntrypoints(packageJson, packedFileSet);
await assertLiteralRelativeImportsResolve(packedFiles, packedFileSet);

for (const file of requiredFiles) {
  assert.equal(packedFiles.includes(file), true, `missing required package file: ${file}`);
}
for (const file of packedFiles) {
  assert.equal(file.startsWith("src/"), false, `source file leaked into package: ${file}`);
  assert.equal(file.startsWith("bin/"), false, `source bin leaked into package: ${file}`);
  assert.equal(file.startsWith("test/"), false, `test file leaked into package: ${file}`);
  assert.equal(/(^|\/).+\.test\./.test(file), false, `test artifact leaked into package: ${file}`);
  assert.equal(file.includes("node_modules/"), false, `node_modules leaked into package: ${file}`);
  if (file.endsWith(".ts") && !file.endsWith(".d.ts")) {
    throw new Error(`raw TypeScript leaked into package: ${file}`);
  }
}

const forbidden = [
  /(?:from\s+|import\s*\(|require\s*\()\s*["']playwright["']/,
  /(?:from\s+|import\s*\(|require\s*\()\s*["']patchright["']/,
  /(?:from\s+|import\s*\(|require\s*\()\s*["']imapflow["']/,
  /(?:from\s+|import\s*\(|require\s*\()\s*["']pdf-parse["']/,
  /(?:from\s+|import\s*\(|require\s*\()\s*["']better-sqlite3["']/,
  /(?:from\s+|import\s*\(|require\s*\()\s*["']linkedom["']/,
  /["']workspace:/,
];
const forbiddenChecks = await Promise.all(
  packedFiles
    .filter((file) => file.endsWith(".js") || file.endsWith(".d.ts") || file === "package.json")
    .map(async (file) => ({
      file,
      text: await readFile(path.join(packageRoot, file), "utf8"),
    }))
);
for (const { file, text } of forbiddenChecks) {
  for (const pattern of forbidden) {
    assert.equal(pattern.test(text), false, `${file} contains forbidden pattern ${pattern}`);
  }
}

/**
 * Resolve every public manifest target against the candidate package. This is
 * deliberately stricter than testing that `dist/` exists: an export condition,
 * root import, declaration, or bin can otherwise point at an omitted file and
 * still leave `npm pack` green.
 */

// biome-ignore lint/suspicious/noShadow: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
function assertPublishedEntrypoints(manifest: Manifest, packedFileSet: Set<string>): void {
  assert.equal(typeof manifest.main, "string", "package.json.main must be a string");
  assert.equal(typeof manifest.types, "string", "package.json.types must be a string");
  assert.ok(manifest.exports && typeof manifest.exports === "object", "package.json.exports must be an object");
  assert.ok(
    (manifest.exports as Record<string, unknown>)["."],
    "package root export is intentional and must be declared"
  );

  const exportsRoot = manifest.exports as Record<string, unknown>;
  const rootExport = exportsRoot["."] as Record<string, unknown>;
  assert.equal(
    rootExport.import,
    manifest.main,
    "package root import must resolve to the declared programmatic main entrypoint"
  );
  assert.equal(
    rootExport.types,
    manifest.types,
    "package root types must resolve to the declared programmatic declaration"
  );

  const targets = [
    ["main", manifest.main || ""],
    ["types", manifest.types || ""],
    ...collectExportTargets(manifest.exports),
    ...Object.entries(manifest.bin ?? {}).map(([name, target]) => [`bin.${name}`, target]),
  ] as [string, string][];
  for (const [label, target] of targets) {
    assert.equal(typeof target, "string", `${label} must resolve to a string target`);
    const packedPath = target.startsWith("./") ? target.slice(2) : target;
    assert.equal(path.posix.isAbsolute(packedPath), false, `${label} must be package-relative: ${target}`);
    assert.equal(path.posix.normalize(packedPath).startsWith("../"), false, `${label} escapes the package: ${target}`);
    assert.equal(packedFileSet.has(packedPath), true, `${label} resolves to an unpacked file: ${target}`);
    assert.equal(
      // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      /\.ts$/.test(packedPath) && !/\.d\.ts$/.test(packedPath),
      false,
      `${label} points to source TypeScript: ${target}`
    );
  }
}

function collectExportTargets(exportsField: unknown, label = "exports"): [string, string][] {
  if (typeof exportsField === "string") {
    return [[label, exportsField]];
  }
  assert.ok(exportsField && typeof exportsField === "object", `${label} must be a string or condition object`);
  return Object.entries(exportsField as Record<string, unknown>).flatMap(([key, value]) =>
    collectExportTargets(value, `${label}.${key}`)
  );
}

/**
 * Check the emitted module graph, including literal dynamic imports. A missing
 * lazy target does not fail an ordinary import smoke, but it is still a broken
 * published artifact. Only literal relative specifiers are package-owned and
 * therefore resolvable without executing arbitrary connector behavior.
 */

// biome-ignore lint/suspicious/noShadow: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
async function assertLiteralRelativeImportsResolve(packedFiles: string[], packedFileSet: Set<string>): Promise<void> {
  const fileChecks = await Promise.all(
    packedFiles
      .filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))
      .map(async (packedFile) => ({
        packedFile,
        source: await readFile(path.join(packageRoot, packedFile), "utf8"),
      }))
  );

  for (const { packedFile, source } of fileChecks) {
    for (const specifier of literalRelativeSpecifiers(source)) {
      const sourcePath = path.join(packageRoot, packedFile);
      const targetPath = fileURLToPath(new URL(specifier, pathToFileURL(sourcePath)));
      const packedTarget = path.relative(packageRoot, targetPath).split(path.sep).join("/");
      assert.equal(
        packedTarget.startsWith("../") || path.isAbsolute(packedTarget),
        false,
        `${packedFile} relative import escapes the package: ${specifier}`
      );
      assert.equal(
        packedFileSet.has(packedTarget),
        true,
        `${packedFile} has an unresolved relative import: ${specifier} -> ${packedTarget}`
      );
      // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      await stat(targetPath);
    }
  }
}

function literalRelativeSpecifiers(source: string): Set<string> {
  const specifiers = new Set<string>();
  const staticImport = /\b(?:import|export)\s+(?:[^"'\n]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g;
  const dynamicImport = /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  for (const pattern of [staticImport, dynamicImport]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return specifiers;
}
