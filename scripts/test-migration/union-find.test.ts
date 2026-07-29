// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { UnionFind } from "./union-find.ts";

test("two ids unioned together find() to the same root", () => {
  const uf = new UnionFind();
  uf.add("a");
  uf.add("b");
  uf.union("a", "b");
  assert.equal(uf.find("a"), uf.find("b"));
});

test("ids never unioned stay in separate components", () => {
  const uf = new UnionFind();
  uf.add("a");
  uf.add("b");
  assert.notEqual(uf.find("a"), uf.find("b"));
});

test("union is transitive: a-b and b-c puts a, b, c in one component", () => {
  const uf = new UnionFind();
  for (const id of ["a", "b", "c"]) {
    uf.add(id);
  }
  uf.union("a", "b");
  uf.union("b", "c");
  const root = uf.find("a");
  assert.equal(uf.find("b"), root);
  assert.equal(uf.find("c"), root);
});

test("union is idempotent and order-independent", () => {
  const uf = new UnionFind();
  for (const id of ["x", "y", "z"]) {
    uf.add(id);
  }
  uf.union("x", "y");
  uf.union("x", "y"); // repeat, must not throw or corrupt state
  uf.union("z", "x");
  const root = uf.find("x");
  assert.equal(uf.find("y"), root);
  assert.equal(uf.find("z"), root);
});

test("ids() returns every id added, exactly once", () => {
  const uf = new UnionFind();
  uf.add("a");
  uf.add("b");
  uf.add("a"); // re-add, must not duplicate
  uf.union("a", "b");
  assert.deepEqual([...uf.ids()].sort(), ["a", "b"]);
});

test("find() path-compresses without changing the resulting component membership", () => {
  const uf = new UnionFind();
  for (const id of ["a", "b", "c", "d"]) {
    uf.add(id);
  }
  uf.union("a", "b");
  uf.union("b", "c");
  uf.union("c", "d");
  const rootBefore = uf.find("d");
  // Re-run find on every id (triggers path compression internally); the
  // component structure (who maps to whom) must be unchanged afterward.
  for (const id of ["a", "b", "c", "d"]) {
    uf.find(id);
  }
  assert.equal(uf.find("a"), rootBefore);
  assert.equal(uf.find("d"), rootBefore);
});
