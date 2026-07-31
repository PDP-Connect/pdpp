// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REFERENCE_IMPLEMENTATION_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNTIME_SOURCE_DIRECTORIES = ["server", "runtime", "lib", "operations", "cli", "connectors", "examples"];
const RELATIVE_JS_IMPORT_PATTERN =
  /\b(?:from\s*|import\s*\(\s*|new URL\(\s*)["'](?<specifier>\.{1,2}\/[^'"]+\.js)["']/g;
const MODULE_NOT_FOUND_PATTERN = /ERR_MODULE_NOT_FOUND/;
const AUTH_JS_PATTERN = /auth\.js/;

function runtimeSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return runtimeSourceFiles(entryPath);
    }
    return entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) ? [entryPath] : [];
  });
}

function staleRelativeJsImports(filePath: string): Array<{ line: number; specifier: string }> {
  const source = readFileSync(filePath, "utf8");
  const stale: Array<{ line: number; specifier: string }> = [];
  for (const match of source.matchAll(RELATIVE_JS_IMPORT_PATTERN)) {
    const specifier = match.groups?.specifier;
    if (!specifier) {
      continue;
    }
    const jsTarget = resolve(dirname(filePath), specifier);
    const tsTarget = `${jsTarget.slice(0, -".js".length)}.ts`;
    if (!existsSync(jsTarget) && existsSync(tsTarget)) {
      const line = source.slice(0, match.index).split("\n").length;
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

test("native Node rejects the stale dynamic .js import class used by the deployed runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-runtime-import-closure-"));
  try {
    writeFileSync(join(directory, "auth.ts"), "export const auth = true;\n");
    writeFileSync(
      join(directory, "search.ts"),
      'export async function loadAuth() { return await import(new URL("./auth.js", import.meta.url).href); }\n'
    );
    const searchUrl = pathToFileURL(join(directory, "search.ts")).href;
    const result = await runNativeNode(
      `const search = await import(${JSON.stringify(searchUrl)}); await search.loadAuth();`
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, MODULE_NOT_FOUND_PATTERN);
    assert.match(result.stderr, AUTH_JS_PATTERN);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
