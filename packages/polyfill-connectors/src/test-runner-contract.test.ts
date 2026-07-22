import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("package test runner bounds file concurrency and retains a finite hang guard", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: { test: string };
  };

  assert.match(packageJson.scripts.test, /node --test/);
  assert.match(packageJson.scripts.test, /--test-concurrency=2/);
  assert.match(packageJson.scripts.test, /--test-timeout=120000/);
  assert.doesNotMatch(packageJson.scripts.test, /--test-timeout=30000/);
});
