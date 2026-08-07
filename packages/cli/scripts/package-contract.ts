// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const TEST_ARTIFACT = /(^|\/)\.?.+\.test\.(?:js|mjs|cjs|ts|mts|cts)$/;
const WHITESPACE = /\s/;
const NPM_PACK_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

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
