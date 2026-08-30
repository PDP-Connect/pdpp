// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The conservative fallback surface: files a static import graph cannot
 * trust to fully represent, so ANY change to them (or to a file inside a
 * fixtures directory) forces the full suite instead of graph-based
 * selection.
 *
 * This is textual, not graph-based, by design. Verified directly against
 * this package's own `src/orchestrator.ts`: `await
 * import(moduleSpecifier(REFERENCE_IMPL_DIR, "server/index.ts"))` — a
 * computed specifier — produces NO edge at all in dependency-cruiser's
 * output (not even an unresolved one; it is simply absent). A selector that
 * only trusted the graph would treat orchestrator.ts as a leaf with no
 * dependents-of-dynamic-import relationship, which is exactly backwards: it
 * is a file whose true reach the graph cannot see. Grepping call sites is
 * the only way to know which files fall into that category.
 */

import { readFileSync } from "node:fs";

const FIXTURES_PATH_SEGMENT = /(^|\/)(fixtures|__fixtures__)(\/|$)/;
const DYNAMIC_IMPORT_CALL = /\bimport\s*\(/;
const REQUIRE_CALL = /\brequire\s*\(/;

export interface FallbackInventory {
  /**
   * Package-relative paths of source files that themselves CONTAIN a dynamic
   * `import(...)` or `require(...)` call site. A change to one of these
   * files forces the full suite, because the graph cannot enumerate what it
   * dynamically reaches.
   */
  readonly dynamicImportSites: ReadonlySet<string>;
  /** Package-relative paths considered fixture data — any change here forces the full suite. */
  readonly fixturePaths: ReadonlySet<string>;
}

export function isFixturePath(relativePath: string): boolean {
  return FIXTURES_PATH_SEGMENT.test(relativePath);
}

/**
 * True if the file's own source text contains a dynamic `import(` or
 * `require(` call. Textual, not AST-based: a false positive (e.g. the
 * substring appears inside a comment or string) only widens the fallback,
 * which is the safe direction for a fail-closed check. A false negative
 * would not be — see the module-level comment for why this must stay
 * textual rather than trusting the graph's own dynamic-edge detection.
 */
export function containsDynamicImportOrRequire(sourceText: string): boolean {
  return DYNAMIC_IMPORT_CALL.test(sourceText) || REQUIRE_CALL.test(sourceText);
}

export function buildFallbackInventory(packageRoot: string, allRelativePaths: readonly string[]): FallbackInventory {
  const fixturePaths = new Set<string>();
  const dynamicImportSites = new Set<string>();

  for (const relativePath of allRelativePaths) {
    if (isFixturePath(relativePath)) {
      fixturePaths.add(relativePath);
      continue;
    }
    const sourceText = readFileSync(`${packageRoot}/${relativePath}`, "utf8");
    if (containsDynamicImportOrRequire(sourceText)) {
      dynamicImportSites.add(relativePath);
    }
  }

  return { fixturePaths, dynamicImportSites };
}
