import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const LOCAL_SOURCE_CONNECTOR_FILES = [
  new URL("../connectors/claude_code/index.ts", import.meta.url),
  new URL("../connectors/codex/index.ts", import.meta.url),
];

test("local source collectors do not materialize whole source files", () => {
  for (const file of LOCAL_SOURCE_CONNECTOR_FILES) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /import\s+\{[^}]*\breadFile\b[^}]*\}\s+from\s+"node:fs\/promises"/,
      `${file.pathname} must use bounded previews instead of fs/promises.readFile`
    );
    assert.doesNotMatch(source, /\bawait\s+readFile\(/, `${file.pathname} must not await readFile()`);
  }
});

test("Codex session collection does not materialize the full thread table", () => {
  const codexSource = readFileSync(new URL("../connectors/codex/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(codexSource, /\.all\(\)/, "Codex collector must stream SQLite thread rows with iterate()");
  assert.match(codexSource, /\.iterate\(\)/, "Codex collector should use the SQLite row iterator");
});
