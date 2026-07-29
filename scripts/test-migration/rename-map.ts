// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The rename map is the single source of truth for a batch of `.js` -> `.ts`
 * test-file renames. Every other module in this tool (the Stage A rewriter,
 * the literal-path scanner, the equivalence oracle) reads the SAME map
 * instance rather than deriving its own notion of "what got renamed" —
 * this is a proven precondition carried over from the T1-SAMPLE measurement
 * (see the T1-SAMPLE measurement report §4.2): the historical
 * off-by-one import bug and the stale-literal-path bug both shipped because
 * the specifier rewrite and the literal-path check had no shared source of
 * truth to drift apart from.
 */

import { existsSync } from "node:fs";
import { extname, join } from "node:path";

export interface RenameEntry {
  /** Repository-relative path before the rename, e.g. "reference-implementation/test/foo.test.js". */
  fromPath: string;
  /** Repository-relative path after the rename, e.g. "reference-implementation/test/foo.test.ts". */
  toPath: string;
}

export interface RenameMap {
  /** fromPath -> toPath */
  byFromPath: Map<string, string>;
  /** toPath -> fromPath */
  byToPath: Map<string, string>;
  entries: RenameEntry[];
}

const JS_EXTENSION_PATTERN = /\.(?:js|mjs|cjs)$/;

function tsPathFor(jsPath: string): string {
  const ext = extname(jsPath);
  if (ext === ".mjs" || ext === ".cjs") {
    // Preserve module-kind intent: an .mjs/.cjs source becomes .ts (source-only
    // TS under NodeNext already covers ESM/CJS resolution uniformly per this
    // repo's tsconfig; there is no .mts/.cts convention in this codebase).
    return `${jsPath.slice(0, -ext.length)}.ts`;
  }
  return `${jsPath.slice(0, -3)}.ts`;
}

/**
 * Builds a rename map from a list of repository-relative `.js`/`.mjs`/`.cjs`
 * paths. Fails closed (throws) rather than silently skipping anything that
 * doesn't fit the precondition — Stage A must never run on a partially-formed
 * map.
 */
export function buildRenameMap(fromPaths: string[], repoRoot: string): RenameMap {
  if (fromPaths.length === 0) {
    throw new Error("rename map: at least one source path is required");
  }
  const byFromPath = new Map<string, string>();
  const byToPath = new Map<string, string>();
  const entries: RenameEntry[] = [];
  for (const fromPath of fromPaths) {
    if (!JS_EXTENSION_PATTERN.test(fromPath)) {
      throw new Error(`rename map: not a .js/.mjs/.cjs path: ${fromPath}`);
    }
    if (fromPath.includes("..") || fromPath.startsWith("/")) {
      throw new Error(`rename map: path must be repository-relative: ${fromPath}`);
    }
    if (!existsSync(join(repoRoot, fromPath))) {
      throw new Error(`rename map: source file does not exist on disk: ${fromPath}`);
    }
    const toPath = tsPathFor(fromPath);
    if (existsSync(join(repoRoot, toPath))) {
      throw new Error(`rename map: destination already exists on disk: ${toPath}`);
    }
    if (byFromPath.has(fromPath)) {
      throw new Error(`rename map: duplicate source path: ${fromPath}`);
    }
    if (byToPath.has(toPath)) {
      throw new Error(`rename map: two sources rename to the same destination: ${toPath}`);
    }
    byFromPath.set(fromPath, toPath);
    byToPath.set(toPath, fromPath);
    entries.push({ fromPath, toPath });
  }
  return { entries, byFromPath, byToPath };
}
