// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanFileForStaleLiteralPaths } from "./literal-path-scan.ts";
import { buildRenameMap } from "./rename-map.ts";

function withTempRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-literal-scan-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("catches an exact string-literal match against a pre-rename path (fixture 2's exact shape)", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "server-widget.js"), "");
    const renameMap = buildRenameMap(["server-widget.js"], dir);
    const src = "read('server-widget.js');\n";
    const hits = scanFileForStaleLiteralPaths(src, "f.ts", renameMap);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.matchedOldPath, "server-widget.js");
  });
});

test("catches a path-boundary substring match (e.g. a literal built with a leading directory prefix that still names the file exactly)", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, "server"), { recursive: true });
    writeFileSync(join(dir, "server", "widget.js"), "");
    const renameMap = buildRenameMap(["server/widget.js"], dir);
    // A literal that ends with "/server/widget.js" (e.g. built from an
    // absolute repo-root prefix at runtime) still names the exact
    // pre-rename path and must be caught.
    const src = "read('/absolute/repo/root/server/widget.js');\n";
    const hits = scanFileForStaleLiteralPaths(src, "f.ts", renameMap);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.matchedOldPath, "server/widget.js");
  });
});

test("does not false-match unrelated string literals", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "server-widget.js"), "");
    const renameMap = buildRenameMap(["server-widget.js"], dir);
    const src = "const x = 'completely unrelated string';\n";
    const hits = scanFileForStaleLiteralPaths(src, "f.ts", renameMap);
    assert.deepEqual(hits, []);
  });
});

test("scans template-literal segments too", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "server-widget.js"), "");
    const renameMap = buildRenameMap(["server-widget.js"], dir);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is a literal fixture SOURCE-CODE-AS-STRING sample containing a template literal, not accidental JS interpolation.
    const src = "const p = `${root}/server-widget.js`;\n";
    const hits = scanFileForStaleLiteralPaths(src, "f.ts", renameMap);
    assert.equal(hits.length, 1);
  });
});

test("clean after the literal is updated to the post-rename path", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "server-widget.js"), "");
    const renameMap = buildRenameMap(["server-widget.js"], dir);
    const staleSrc = "read('server-widget.js');\n";
    const fixedSrc = "read('server-widget.ts');\n";
    assert.equal(scanFileForStaleLiteralPaths(staleSrc, "f.ts", renameMap).length, 1);
    assert.equal(scanFileForStaleLiteralPaths(fixedSrc, "f.ts", renameMap).length, 0);
  });
});

test("reports the line number of the stale literal", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "server-widget.js"), "");
    const renameMap = buildRenameMap(["server-widget.js"], dir);
    const src = "const a = 1;\nconst b = 2;\nread('server-widget.js');\n";
    const hits = scanFileForStaleLiteralPaths(src, "f.ts", renameMap);
    assert.equal(hits[0]?.line, 3);
  });
});
