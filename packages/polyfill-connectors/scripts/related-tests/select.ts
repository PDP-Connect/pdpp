// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Selects the `node --test` file list for a set of changed files: either a
 * bounded related-test set, or the sentinel meaning "run the full suite
 * unconditionally" — this module never chooses partial selection on
 * uncertainty, only on a graph it has explicitly verified it can trust (see
 * `graph.ts`) and changed files it has explicitly verified are
 * statically-resolvable (see `fallback-inventory.ts`).
 */

import { buildFallbackInventory, isFixturePath } from "./fallback-inventory.ts";
import type { DependencyGraph } from "./graph.ts";

export const FULL_SUITE = "FULL_SUITE" as const;

export interface SelectionResult {
  readonly kind: "related" | typeof FULL_SUITE;
  /** Human-readable reason, always present, for logging/auditing why full-suite fired. */
  readonly reason: string;
  /** Present only when kind === "related". Package-relative *.test.ts paths. */
  readonly testFiles?: readonly string[];
}

function isTestFile(relativePath: string): boolean {
  return relativePath.endsWith(".test.ts");
}

/**
 * BFS over dependents: a changed non-test file selects every test file that
 * transitively depends on it (including itself, if it is already a test
 * file). Traversal only ever walks `dependents` edges the graph already
 * verified are trustworthy (see `assertGraphIsTrustworthy` in graph.ts) —
 * there is no separate "unknown edge" case inside this walk, because
 * anything the graph cannot resolve was already fenced into the full-suite
 * fallback before this function runs.
 */
function collectDependentTestFiles(graph: DependencyGraph, changedFile: string): Set<string> {
  const selected = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [changedFile];

  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: queue.length > 0 guarantees shift() returns a value
    const current = queue.shift()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (isTestFile(current)) {
      selected.add(current);
    }

    const node = graph.modules.get(current);
    if (!node) {
      continue;
    }
    for (const dependent of node.dependents) {
      if (!visited.has(dependent)) {
        queue.push(dependent);
      }
    }
  }

  return selected;
}

export interface SelectTestsInput {
  /** Every package-relative *.ts path the package considers source (used to build the fallback inventory). */
  readonly allRelativePaths: readonly string[];
  /** Package-relative paths that changed, as reported by git. */
  readonly changedRelativePaths: readonly string[];
  readonly graph: DependencyGraph;
  readonly packageRoot: string;
}

export function selectRelatedTests(input: SelectTestsInput): SelectionResult {
  const { packageRoot, graph, allRelativePaths, changedRelativePaths } = input;

  if (changedRelativePaths.length === 0) {
    return { kind: "related", testFiles: [], reason: "no changed files" };
  }

  const fallback = buildFallbackInventory(packageRoot, allRelativePaths);

  for (const changed of changedRelativePaths) {
    if (isFixturePath(changed)) {
      return {
        kind: FULL_SUITE,
        reason: `changed file "${changed}" is under a fixtures directory; fixture contents are not represented in the static import graph`,
      };
    }
    if (fallback.dynamicImportSites.has(changed)) {
      return {
        kind: FULL_SUITE,
        reason: `changed file "${changed}" contains a dynamic import()/require() call site; its true reach is not fully represented in the static import graph`,
      };
    }
    if (!(graph.modules.has(changed) || isTestFile(changed)) && changed.endsWith(".ts")) {
      return {
        kind: FULL_SUITE,
        reason: `changed file "${changed}" is a .ts source file absent from the dependency graph (unparseable or unresolved shape)`,
      };
    }
  }

  const selected = new Set<string>();
  for (const changed of changedRelativePaths) {
    if (!changed.endsWith(".ts")) {
      return {
        kind: FULL_SUITE,
        reason: `changed file "${changed}" is not a .ts source file; its impact on the test suite cannot be classified by this selector`,
      };
    }
    for (const testFile of collectDependentTestFiles(graph, changed)) {
      selected.add(testFile);
    }
  }

  return {
    kind: "related",
    testFiles: [...selected].sort(),
    reason: `${changedRelativePaths.length} changed file(s) resolved to ${selected.size} related test file(s) via the static import graph`,
  };
}
