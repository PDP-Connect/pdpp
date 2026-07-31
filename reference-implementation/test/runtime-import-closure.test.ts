// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { relativeRuntimeImportSpecifiers } from "../../scripts/test-migration/import-resolution.ts";

const REFERENCE_IMPLEMENTATION_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNTIME_SOURCE_DIRECTORIES = ["server", "runtime", "lib", "operations", "cli", "connectors", "examples"];
const MODULE_NOT_FOUND_PATTERN = /ERR_MODULE_NOT_FOUND/;
const AUTH_JS_PATTERN = /auth\.js/;

interface RuntimeImportVariant {
  description: string;
  source: string;
}

const STALE_IMPORT_VARIANTS: RuntimeImportVariant[] = [
  { description: "comment-separated side-effect static import", source: 'import /* stale extension */ "./auth.js";\n' },
  { description: "export-named-from", source: 'export { auth } from "./auth.js";\n' },
  { description: "export-star-from", source: 'export * from "./auth.js";\n' },
  {
    description: "comment-separated dynamic import",
    source:
      'export async function loadAuth() { return await import /* stale extension */ (/* path */ "./auth.js" /* close */); }\n',
  },
  {
    description: "comment-separated new URL dynamic import",
    source:
      'export async function loadAuth() { return await import /* dynamic */ (new /* URL */ URL(/* stale extension */ "./auth.js", import /* meta */.meta.url).href); }\n',
  },
];

function runtimeSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return runtimeSourceFiles(entryPath);
    }
    const isRuntimeSource =
      (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.js");
    return entry.isFile() && isRuntimeSource ? [entryPath] : [];
  });
}

function staleRelativeJsImports(filePath: string): Array<{ line: number; specifier: string }> {
  const stale: Array<{ line: number; specifier: string }> = [];
  for (const { line, specifier } of relativeRuntimeImportSpecifiers(readFileSync(filePath, "utf8"), filePath)) {
    const jsTarget = resolve(dirname(filePath), specifier);
    const tsTarget = `${jsTarget.slice(0, -".js".length)}.ts`;
    if (!existsSync(jsTarget) && existsSync(tsTarget)) {
      stale.push({ line, specifier });
    }
  }
  return stale;
}

function runNativeNode(script: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolveResult({ code, stderr });
    });
  });
}

test("production runtime has no local .js import specifier whose source moved to .ts", () => {
  const stale = RUNTIME_SOURCE_DIRECTORIES.flatMap((directory) =>
    runtimeSourceFiles(join(REFERENCE_IMPLEMENTATION_ROOT, directory)).flatMap((filePath) =>
      staleRelativeJsImports(filePath).map((match) => ({
        ...match,
        file: relative(REFERENCE_IMPLEMENTATION_ROOT, filePath),
      }))
    )
  );

  assert.deepEqual(stale, []);
});

test("oracle catches side-effect, re-export, dynamic, and new URL stale import variants", () => {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-runtime-import-closure-"));
  try {
    writeFileSync(join(directory, "auth.ts"), "export const auth = true;\n");
    for (const [index, variant] of STALE_IMPORT_VARIANTS.entries()) {
      const entry = join(directory, `variant-${index}.ts`);
      writeFileSync(entry, variant.source);
      assert.deepEqual(staleRelativeJsImports(entry), [{ line: 1, specifier: "./auth.js" }], variant.description);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("oracle ignores comments, package names, and retained JavaScript artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-runtime-import-closure-"));
  try {
    writeFileSync(join(directory, "auth.js"), "export const auth = true;\n");
    const entry = join(directory, "entry.ts");
    writeFileSync(
      entry,
      [
        "// import './missing.js';",
        'import packageName from "ipaddr.js";',
        'import /* retained artifact */ "./auth.js";',
        "void packageName;",
      ].join("\n")
    );
    assert.deepEqual(staleRelativeJsImports(entry), []);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("native Node rejects every stale import grammar variant", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-runtime-import-closure-"));
  try {
    writeFileSync(join(directory, "auth.ts"), "export const auth = true;\n");
    const results = await Promise.all(
      STALE_IMPORT_VARIANTS.map(async (variant, index) => {
        const entry = join(directory, `variant-${index}.ts`);
        writeFileSync(entry, variant.source);
        const entryUrl = pathToFileURL(entry).href;
        const result = await runNativeNode(
          `const runtime = await import(${JSON.stringify(entryUrl)}); await runtime.loadAuth?.();`
        );
        return { result, variant };
      })
    );
    for (const { result, variant } of results) {
      assert.equal(result.code, 1, variant.description);
      assert.match(result.stderr, MODULE_NOT_FOUND_PATTERN, variant.description);
      assert.match(result.stderr, AUTH_JS_PATTERN, variant.description);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
