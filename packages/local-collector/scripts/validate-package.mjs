// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));

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

const { stdout } = await execFileAsync("npm", ["pack", "--json", "--ignore-scripts"], {
  cwd: packageRoot,
  maxBuffer: 1024 * 1024,
});
const packInfo = JSON.parse(stdout)[0];
const packedFiles = packInfo.files.map((file) => file.path).sort();
const tarballPath = path.join(packageRoot, packInfo.filename);

try {
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
    // The pnpm workspace protocol only ever appears as a quoted dependency
    // specifier ("workspace:*"); a bare /workspace:/ also matches legitimate
    // identifiers like the slack_workspace credential field.
    /["']workspace:/,
  ];
  for (const file of packedFiles) {
    if (!(file.endsWith(".js") || file.endsWith(".d.ts") || file === "package.json")) {
      continue;
    }
    const text = await readFile(path.join(packageRoot, file), "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(text), false, `${file} contains forbidden pattern ${pattern}`);
    }
  }
} finally {
  await rm(tarballPath, { force: true });
}
