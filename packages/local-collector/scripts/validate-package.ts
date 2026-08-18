// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
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

/**
 * Node's built-in module names, with and without the `node:` prefix, so the
 * bare-specifier check below works regardless of which form the compiled
 * output uses.
 */
const NODE_BUILTIN_SPECIFIERS = new Set<string>(builtinModules.flatMap((name) => [name, `node:${name}`]));

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
  "dist/polyfill-connectors/connectors/imessage/index.js",
  "dist/polyfill-connectors/connectors/google_takeout/index.js",
  "dist/polyfill-connectors/connectors/apple_photos/index.js",
  "dist/polyfill-connectors/connectors/google_messages/index.js",
]);

const packInfo = (await npmPackMetadata({ cwd: packageRoot })) as PackMetadata;
const packedFiles = packInfo.files.map((file) => file.path).sort((a, b) => a.localeCompare(b));
const packedFileSet = new Set(packedFiles);

assertPublishedEntrypoints(packageJson, packedFileSet);
await assertLiteralRelativeImportsResolve(packedFiles, packedFileSet);
await assertBareSpecifiersResolve(packageJson, packedFiles);

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
  // iMessage reads chat.db via node:sqlite (built into Node.js), not a
  // spawned `sqlite3` binary — a regression to shelling out would silently
  // break the zero-install npx promise on hosts without that binary on
  // PATH. See connectors/imessage/index.ts's module doc.
  /execFileSync?\s*\(\s*["']sqlite3["']/,
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

/**
 * The exact defect this check exists to catch: every published
 * `@pdpp/local-collector` 1.5.1-1.5.4 shipped a compiled `import … from
 * "@pdpp/reference-contract/common"` that is NOT in `dependencies` and does
 * not exist on the npm registry. It resolved for every developer through the
 * pnpm workspace link and failed closed for every real npm install with
 * `ERR_MODULE_NOT_FOUND` on any invocation, including `--version`.
 *
 * `assertLiteralRelativeImportsResolve` above only checks relative
 * specifiers (package-owned, safe to resolve without executing arbitrary
 * code) and the earlier dependency-section scan only checks what the
 * manifest *declares* — neither one looks at what the packed *code* actually
 * imports. A bare specifier can be undeclared in package.json and still slip
 * through both checks untouched. This closes that gap: every bare import,
 * export-from, dynamic import(), and require() specifier compiled into the
 * packed `.js`/`.mjs`/`.d.ts` files must resolve to either a Node builtin or
 * a package the manifest actually declares as a real (non-workspace)
 * dependency.
 */
// biome-ignore lint/suspicious/noShadow: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
async function assertBareSpecifiersResolve(manifest: Manifest, packedFiles: string[]): Promise<void> {
  const declaredPackages = new Set<string>([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);

  const candidateFiles = packedFiles.filter(
    (file) => file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".d.ts")
  );
  const fileChecks = await Promise.all(
    candidateFiles.map(async (packedFile) => ({
      packedFile,
      source: await readFile(path.join(packageRoot, packedFile), "utf8"),
    }))
  );

  for (const { packedFile, source } of fileChecks) {
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
          `${packedFile} imports private workspace package "${packageName}" (specifier "${specifier}") which is ` +
            "not declared in dependencies/peerDependencies/optionalDependencies and does not exist on the npm " +
            "registry. This is the exact defect that made every published @pdpp/local-collector 1.5.1-1.5.4 " +
            "unrunnable (ERR_MODULE_NOT_FOUND on every install). Vendor the needed symbol, declare a real " +
            "dependency, or rewrite the specifier at build time before packing."
        );
      }
      throw new Error(
        `${packedFile} imports "${specifier}" (package "${packageName}") which is not declared in ` +
          "dependencies/peerDependencies/optionalDependencies and is not a Node builtin. A clean npm install of " +
          "this package would fail to resolve this import at runtime."
      );
    }
  }
}

/**
 * Resolve a bare import specifier to the npm package name it names: the
 * whole specifier for an unscoped package (`zod` from `zod/v4`), or the
 * first two path segments for a scoped package (`@pdpp/reference-contract`
 * from `@pdpp/reference-contract/common`).
 */
export function bareSpecifierPackageName(specifier: string): string {
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
 * `node:`-prefixed specifiers are excluded here (handled as builtins by the
 * caller) so the private-package guidance below never fires on them.
 *
 * Static `import`/`export` are anchored to the start of a line (optionally
 * indented): tsc/esbuild output always emits these as statements starting a
 * line, never mid-expression, so anchoring avoids false positives on runtime
 * code that merely contains the words "import"/"export" inside a string or
 * property access (e.g. `line.startsWith("export ")`) — a real risk here
 * since this package's own CLI parses env-var-style `export FOO=bar` lines.
 * `export` additionally requires a trailing `from "…"` — that is the only
 * valid syntax for a re-export naming a module specifier; a bare
 * `export "x"` is not legal JS and would otherwise be a false-positive trap.
 */
export function bareImportSpecifiers(source: string): Set<string> {
  const specifiers = new Set<string>();
  const staticImport =
    /^[ \t]*(?:import\s+(?:[^"'\n;]*?\s+from\s+)?["']([^"'.][^"']*)["']|export\s+[^"'\n;]*?\s+from\s+["']([^"'.][^"']*)["'])/gm;
  const dynamicImport = /\bimport\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g;
  const requireCall = /\brequire\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g;
  for (const match of source.matchAll(staticImport)) {
    const specifier = match[1] ?? match[2];
    if (specifier && isBareSpecifier(specifier) && !specifier.startsWith("node:")) {
      specifiers.add(specifier);
    }
  }
  for (const pattern of [dynamicImport, requireCall]) {
    for (const [, specifier] of source.matchAll(pattern)) {
      if (isBareSpecifier(specifier) && !specifier.startsWith("node:")) {
        specifiers.add(specifier);
      }
    }
  }
  return specifiers;
}
