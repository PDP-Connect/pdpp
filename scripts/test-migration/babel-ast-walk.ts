// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared generic recursive-descent walker over a @babel/parser AST. Every
 * visitor in this tool (import-resolution.ts, literal-path-scan.ts,
 * static-test-inventory.ts, stage-b.ts, catch-clause-narrowing.ts)
 * independently re-implemented the same "visit every child property,
 * skipping loc/start/end/type, recursing into arrays and objects"
 * traversal — pulling it out here is a pure DRY move (one traversal
 * primitive, several independent visit callbacks), not a design change to
 * any of them; each caller's own node-matching logic is untouched.
 */

const SKIPPED_KEYS = new Set(["loc", "start", "end", "type"]);

/**
 * Visits `node` and every descendant reachable through its own properties
 * (excluding loc/start/end/type, which are never AST children). `onNode` is
 * called for every non-null object node, including the root; it may push
 * results into a closure, exactly like the pre-extraction inline visitors
 * did.
 */
export function walkBabelAst(node: unknown, onNode: (node: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  const typed = node as Record<string, unknown>;
  onNode(typed);
  for (const key of Object.keys(typed)) {
    if (SKIPPED_KEYS.has(key)) {
      continue;
    }
    const value = typed[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        walkBabelAst(item, onNode);
      }
    } else if (value && typeof value === "object") {
      walkBabelAst(value, onNode);
    }
  }
}
