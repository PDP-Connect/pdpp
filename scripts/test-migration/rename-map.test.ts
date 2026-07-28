// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRenameMap } from "./rename-map.ts";

const AT_LEAST_ONE_SOURCE_PATH_PATTERN = /at least one source path/;
const DOES_NOT_EXIST_ON_DISK_PATTERN = /does not exist on disk/;
const DESTINATION_ALREADY_EXISTS_PATTERN = /destination already exists/;
const NOT_A_JS_MJS_CJS_PATH_PATTERN = /not a \.js\/\.mjs\/\.cjs path/;
const REPOSITORY_RELATIVE_PATTERN = /repository-relative/;
const DUPLICATE_SOURCE_PATH_PATTERN = /duplicate source path/;

function withTempRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-rename-map-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("buildRenameMap maps .js -> .ts by default", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "foo.test.js"), "");
    const map = buildRenameMap(["foo.test.js"], dir);
    assert.equal(map.byFromPath.get("foo.test.js"), "foo.test.ts");
    assert.equal(map.byToPath.get("foo.test.ts"), "foo.test.js");
    assert.deepEqual(map.entries, [{ fromPath: "foo.test.js", toPath: "foo.test.ts" }]);
  });
});

test("buildRenameMap maps .mjs and .cjs -> .ts", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "a.test.mjs"), "");
    writeFileSync(join(dir, "b.test.cjs"), "");
    const map = buildRenameMap(["a.test.mjs", "b.test.cjs"], dir);
    assert.equal(map.byFromPath.get("a.test.mjs"), "a.test.ts");
    assert.equal(map.byFromPath.get("b.test.cjs"), "b.test.ts");
  });
});

test("buildRenameMap fails closed: empty input", () => {
  withTempRepo((dir) => {
    assert.throws(() => buildRenameMap([], dir), AT_LEAST_ONE_SOURCE_PATH_PATTERN);
  });
});

test("buildRenameMap fails closed: source does not exist", () => {
  withTempRepo((dir) => {
    assert.throws(() => buildRenameMap(["missing.test.js"], dir), DOES_NOT_EXIST_ON_DISK_PATTERN);
  });
});

test("buildRenameMap fails closed: destination already exists", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "foo.test.js"), "");
    writeFileSync(join(dir, "foo.test.ts"), "");
    assert.throws(() => buildRenameMap(["foo.test.js"], dir), DESTINATION_ALREADY_EXISTS_PATTERN);
  });
});

test("buildRenameMap fails closed: not a .js/.mjs/.cjs path", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "foo.test.ts"), "");
    assert.throws(() => buildRenameMap(["foo.test.ts"], dir), NOT_A_JS_MJS_CJS_PATH_PATTERN);
  });
});

test("buildRenameMap fails closed: path escapes repository", () => {
  withTempRepo((dir) => {
    assert.throws(() => buildRenameMap(["../escape.test.js"], dir), REPOSITORY_RELATIVE_PATTERN);
    assert.throws(() => buildRenameMap(["/abs/escape.test.js"], dir), REPOSITORY_RELATIVE_PATTERN);
  });
});

test("buildRenameMap fails closed: duplicate source path", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "foo.test.js"), "");
    assert.throws(() => buildRenameMap(["foo.test.js", "foo.test.js"], dir), DUPLICATE_SOURCE_PATH_PATTERN);
  });
});
