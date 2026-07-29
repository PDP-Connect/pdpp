// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression fixtures for T1's test-migration equivalence oracle (T1-SAMPLE
 * lane, 2026-07-25). Both defects below were REAL and were observed on the
 * (now-disposed) internal migration branch at commit `d6520367b` during an
 * earlier `.js` -> `.ts` migration of
 * `reference-implementation/server/streaming/*`. That branch was twice
 * rejected and closed before either defect could be captured as a fixture
 * upstream — these tests are the harvest, written directly against the
 * historical diff rather than invented.
 *
 * Both fixtures simulate the failure mechanically (a synthetic temp source
 * tree) rather than depending on live repo files, so they keep discriminating
 * even after this repo's own migration completes and the historical bug sites
 * no longer exist in their broken form.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

function withTempTree<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-t1-rename-fixture-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// ── Fixture 1: the path-depth import bug ───────────────────────────────────
//
// Concrete instance harvested from d6520367b (streaming cohort 2):
//
//   test/run-interaction-stream-cdp-adapter.test.js imports the adapter it
//   is testing. Before the migration:
//     import { createCdpCompanion } from '../server/streaming/cdp-adapter.js';
//   After the rename+typing commit, the specifier picked up an EXTRA leading
//   '../' segment:
//     import { createCdpCompanion } from '../../server/streaming/cdp-adapter.ts';
//   (identical mistake, same commit, in run-interaction-stream-neko-adapter.test.js).
//
//   reference-implementation/test/ and reference-implementation/server/ are
//   SIBLINGS one level below reference-implementation/. The correct relative
//   specifier from a file directly in test/ is '../server/...' (up one, into
//   server/). '../../server/...' walks up TWO levels — out of
//   reference-implementation/ entirely — and resolves to a path that does not
//   exist on disk. This is silent at review time (the diff looks like a
//   plausible import-path edit) and loud only at run time (MODULE_NOT_FOUND),
//   which is exactly why T1's equivalence oracle must check import resolution
//   mechanically rather than relying on human diff review.
//
// This fixture proves the oracle assertion: for every renamed file, the
// resolved path of every relative import specifier that pointed at an
// existing file BEFORE a rename must still point at an existing file AFTER
// it. It reproduces the historical off-by-one exactly (extra '../') against
// a synthetic tree shaped like reference-implementation/{server,test}/.

test('rename regression: off-by-one "../" in a relative import specifier is caught by import-resolution check', () => {
  withTempTree((root: string) => {
    // Shape: <root>/reference-implementation/{server/streaming, test}
    const refImpl = join(root, "reference-implementation");
    const serverStreaming = join(refImpl, "server", "streaming");
    const testDir = join(refImpl, "test");
    mkdirSync(serverStreaming, { recursive: true });
    mkdirSync(testDir, { recursive: true });

    // The "adapter" module (post-rename target, .ts in the real migration;
    // plain .mjs here since this fixture must run standalone under
    // node --test without a TS loader).
    writeFileSync(join(serverStreaming, "cdp-adapter.mjs"), "export function createCdpCompanion() { return 'ok'; }\n");

    // CORRECT specifier depth, mirroring the pre-migration import.
    const correctSpecifier = "../server/streaming/cdp-adapter.mjs";
    // BUGGED specifier depth, mirroring the exact historical off-by-one.
    const buggedSpecifier = "../../server/streaming/cdp-adapter.mjs";

    const testFileUrl = pathToFileURL(join(testDir, "run-interaction-stream-cdp-adapter.test.mjs"));

    function resolves(specifier: string): boolean {
      try {
        // new URL(specifier, base) is the same resolution algorithm Node's
        // ESM loader applies to a relative import specifier; this is a
        // static, syscall-light equivalent to attempting the import that a
        // migration-equivalence check can run over hundreds of files fast.
        const resolved = new URL(specifier, testFileUrl);
        // Must exist on disk to be a real resolution, not just a syntactically
        // valid URL.
        readFileSync(resolved);
        return true;
      } catch {
        return false;
      }
    }

    assert.equal(resolves(correctSpecifier), true, "the correct, pre-migration-depth specifier must resolve");
    assert.equal(
      resolves(buggedSpecifier),
      false,
      'the historical off-by-one ("../../" instead of "../") must NOT resolve — ' +
        "this is the exact defect that shipped in d6520367b for " +
        "run-interaction-stream-cdp-adapter.test.js and run-interaction-stream-neko-adapter.test.js"
    );
  });
});

// ── Fixture 2: source-inspection test reads a path that a rename moves ─────
//
// Concrete instance harvested from d6520367b:
//   reference-implementation/test/remote-surface-reference-boundary.test.js
//   defines:
//     function read(path) {
//       return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
//     }
//   and calls it with REPO-ROOT-RELATIVE STRING LITERALS naming source files
//   by path, e.g. read('reference-implementation/server/streaming/routes.js'),
//   then regex-asserts on the raw text content (e.g.
//   assert.match(routes, /\/_ref\/runs\/:runId\/run-interaction-stream/)).
//
//   These literal paths have NO mechanical link to the files they name — an
//   AST-based rename codemod that rewrites import specifiers will not find
//   them, because they are plain strings, not import statements. When
//   routes.js became routes.ts, this file's read() call had to be
//   hand-updated in the same commit (it was, in this instance) or the test
//   would break in one of two ways:
//     (a) LOUD: readFileSync throws ENOENT if the literal path is left
//         pointing at the deleted .js file (repo-root-relative-string
//         breakage from renames is what T1 §6 item 10 calls out as a defect
//         class distinct from #1, above);
//     (b) SILENT/VACUOUS: if a stub or duplicate were ever left behind at the
//         old path (not the case here, but a realistic codemod failure
//         mode), the assertions would keep matching stale content and the
//         test would report green while testing nothing live.
//
// This fixture proves the oracle assertion: for every test file, every
// repo-root-relative *string literal* argument that names a path under a
// renamed set of files must be updated in lockstep with the rename — and a
// scripted check (grep for string literals matching the old path, resolved
// relative to repo root) must fail the migration if any survive, rather than
// relying on the codemod's import-rewrite pass (which has no visibility into
// plain strings) to catch it.

test("rename regression: literal string path to a source-inspection read() target is caught by literal-path scan", () => {
  withTempTree((root: string) => {
    const refImpl = join(root, "reference-implementation");
    const serverStreaming = join(refImpl, "server", "streaming");
    const testDir = join(refImpl, "test");
    mkdirSync(serverStreaming, { recursive: true });
    mkdirSync(testDir, { recursive: true });

    // Simulates the routes module BEFORE the rename.
    const oldRelPath = "reference-implementation/server/streaming/routes.js";
    // Simulates the routes module AFTER the rename (the real target).
    const newRelPath = "reference-implementation/server/streaming/routes.ts";
    writeFileSync(
      join(serverStreaming, "routes.ts"),
      "export const ROUTE = '/_ref/runs/:runId/run-interaction-stream';\n"
    );
    // Old path deliberately does NOT exist post-rename (mirrors `git mv`).

    // A boundary test that inspects source via a literal, repo-root-relative
    // path string — same shape as remote-surface-reference-boundary.test.js's
    // read() helper — captured BEFORE it was updated for the rename.
    const staleTestBody = [
      "function read(path) {",
      "  return require('node:fs').readFileSync(path, 'utf8');",
      "}",
      `const routes = read(${JSON.stringify(join(root, oldRelPath))});`,
      "module.exports = { routes };",
    ].join("\n");
    writeFileSync(join(testDir, "remote-surface-reference-boundary.test.cjs"), staleTestBody);

    // The literal-path scan T1 must run: for a given rename map (old -> new
    // relative path), grep every test file's source text for the OLD path as
    // a string literal. Any hit is a migration-equivalence failure, because
    // it proves a source-inspection test was not updated in lockstep.
    // biome-ignore lint/suspicious/noShadow: localized test assertion preserves its explicit contract.
    function scanForStaleLiteralPaths(testFileText: string, renameMap: Map<string, string>): string[] {
      const hits: string[] = [];
      for (const [oldPath] of renameMap) {
        if (testFileText.includes(oldPath)) {
          hits.push(oldPath);
        }
      }
      return hits;
    }

    const renameMap = new Map([[oldRelPath, newRelPath]]);
    const testFileText = readFileSync(join(testDir, "remote-surface-reference-boundary.test.cjs"), "utf8");
    const staleHits = scanForStaleLiteralPaths(testFileText, renameMap);

    assert.deepEqual(
      staleHits,
      [oldRelPath],
      "a literal-path scan must catch a source-inspection test still naming the pre-rename .js path — " +
        "this is the class of defect T1 §6 item 10 identifies in remote-surface-reference-boundary.test.js " +
        "against server/streaming/routes.js and run-target-registry.js"
    );

    // And prove the corollary: once the literal is corrected, the scan is
    // clean and the file (now) actually resolves against the post-rename tree.
    const fixedTestBody = staleTestBody.replace(oldRelPath, newRelPath);
    const fixedHits = scanForStaleLiteralPaths(fixedTestBody, renameMap);
    assert.deepEqual(fixedHits, [], "after correcting the literal to the post-rename path, the scan must be clean");

    const fixedAbsolutePath = join(root, newRelPath);
    assert.doesNotThrow(
      () => readFileSync(fixedAbsolutePath, "utf8"),
      "the corrected literal path must actually resolve on disk post-rename"
    );
  });
});
