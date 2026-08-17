// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule } from "./is-main-module.ts";

test("isMainModule: returns true when importMetaUrl matches process.argv[1]", () => {
  const [, entry] = process.argv;
  assert.ok(entry, "test assumes process.argv[1] is set");
  const matching = pathToFileURL(entry).href;
  assert.equal(isMainModule(matching), true);
});

test("isMainModule: returns false for unrelated module URL", () => {
  assert.equal(isMainModule("file:///tmp/not-the-entry.ts"), false);
});

test("isMainModule: returns true when process.argv[1] is an npm-style symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-main-module-"));
  const realEntry = join(dir, "dist", "bin.js");
  const symlinkEntry = join(dir, "pdpp-local-collector");
  mkdirSync(join(dir, "dist"));
  writeFileSync(realEntry, "");
  symlinkSync(realEntry, symlinkEntry);

  const [, saved] = process.argv;
  process.argv[1] = symlinkEntry;
  try {
    assert.equal(isMainModule(pathToFileURL(realEntry).href), true);
    assert.equal(realpathSync(symlinkEntry), realEntry);
  } finally {
    if (saved !== undefined) {
      process.argv[1] = saved;
    }
  }
});

test("isMainModule: returns false when process.argv[1] is missing", () => {
  const [, saved] = process.argv;
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
