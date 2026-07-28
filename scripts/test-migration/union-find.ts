// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal string-keyed union-find (disjoint-set), path-compressed on
 * find. Used by helper-family.ts to group test files that share ANY
 * helper-surface key into one connected component — a file can join a
 * family through more than one shared key, and union-find is the
 * standard, provably-correct way to collapse that into disjoint groups
 * without an O(n^2) pairwise comparison.
 */
export class UnionFind {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
    }
  }

  find(id: string): string {
    let root = id;
    let next = this.parent.get(root);
    while (next !== undefined && next !== root) {
      root = next;
      next = this.parent.get(root);
    }
    this.parent.set(id, root);
    return root;
  }

  ids(): string[] {
    return [...this.parent.keys()];
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootA, rootB);
    }
  }
}
