import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule } from "./is-main-module.ts";

test("isMainModule: returns true when importMetaUrl matches process.argv[1]", () => {
  const entry = process.argv[1];
  assert.ok(entry, "test assumes process.argv[1] is set");
  const matching = pathToFileURL(entry).href;
  assert.equal(isMainModule(matching), true);
});

test("isMainModule: returns false for unrelated module URL", () => {
  assert.equal(isMainModule("file:///tmp/not-the-entry.ts"), false);
});

test("isMainModule: returns false when process.argv[1] is missing", () => {
  const saved = process.argv[1];
  // process.argv is `string[]` but we're intentionally simulating the
  // pathological "no entry" case. Setting to empty string exercises the
  // `!entry` guard without mutating the length.
  process.argv[1] = "";
  try {
    assert.equal(isMainModule("file:///anything.ts"), false);
  } finally {
    if (saved !== undefined) {
      process.argv[1] = saved;
    }
  }
});
