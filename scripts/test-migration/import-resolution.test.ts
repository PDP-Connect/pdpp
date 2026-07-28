// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { relativeImportSpecifiers, resolvesOnDisk, verifyFileImportsResolve } from "./import-resolution.ts";

function withTempTree(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-import-resolution-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("relativeImportSpecifiers finds import/export/require specifiers, ignores bare specifiers", () => {
  const src = [
    "import { a } from '../server/a.js';",
    "export { b } from './b.ts';",
    "export * from './c.js';",
    "const d = require('./d.js');",
    "import fs from 'node:fs';",
    "import pkg from 'some-package';",
    "",
  ].join("\n");
  const found = relativeImportSpecifiers(src, "f.ts").map((o) => o.specifier);
  assert.deepEqual(found, ["../server/a.js", "./b.ts", "./c.js", "./d.js"]);
});

test("resolvesOnDisk finds an exact-extension relative specifier", () => {
  withTempTree((dir) => {
    mkdirSync(join(dir, "server"), { recursive: true });
    writeFileSync(join(dir, "server", "widget.ts"), "");
    mkdirSync(join(dir, "test"), { recursive: true });
    const base = join(dir, "test", "foo.test.ts");
    writeFileSync(base, "");
    assert.equal(resolvesOnDisk("../server/widget.ts", base), true);
  });
});

test("resolvesOnDisk fails an off-by-one '../' specifier (fixture 1's exact shape)", () => {
  withTempTree((dir) => {
    mkdirSync(join(dir, "reference-implementation", "server", "streaming"), { recursive: true });
    writeFileSync(join(dir, "reference-implementation", "server", "streaming", "cdp-adapter.ts"), "");
    mkdirSync(join(dir, "reference-implementation", "test"), { recursive: true });
    const base = join(dir, "reference-implementation", "test", "foo.test.ts");
    writeFileSync(base, "");
    assert.equal(resolvesOnDisk("../server/streaming/cdp-adapter.ts", base), true);
    assert.equal(resolvesOnDisk("../../server/streaming/cdp-adapter.ts", base), false);
  });
});

test("resolvesOnDisk resolves an extension-less specifier by trying known extensions", () => {
  withTempTree((dir) => {
    mkdirSync(join(dir, "server"), { recursive: true });
    writeFileSync(join(dir, "server", "widget.ts"), "");
    const base = join(dir, "foo.test.ts");
    writeFileSync(base, "");
    assert.equal(resolvesOnDisk("./server/widget", base), true);
  });
});

test("verifyFileImportsResolve returns empty for a file whose imports all resolve", () => {
  withTempTree((dir) => {
    mkdirSync(join(dir, "server"), { recursive: true });
    writeFileSync(join(dir, "server", "widget.ts"), "");
    const base = join(dir, "foo.test.ts");
    const src = "import { widget } from './server/widget.ts';\n";
    writeFileSync(base, src);
    assert.deepEqual(verifyFileImportsResolve(src, base), []);
  });
});

test("verifyFileImportsResolve reports every unresolved specifier with its line number", () => {
  withTempTree((dir) => {
    const base = join(dir, "foo.test.ts");
    const src = "import { a } from './missing-a.ts';\nimport { b } from './missing-b.ts';\n";
    writeFileSync(base, src);
    const unresolved = verifyFileImportsResolve(src, base);
    assert.equal(unresolved.length, 2);
    assert.equal(unresolved[0]?.line, 1);
    assert.equal(unresolved[1]?.line, 2);
  });
});
