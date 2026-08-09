// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  dateDirectoryInRange,
  isPathWithinSourceRoots,
  pathContainsOrIsWithin,
  readEnumerationScope,
  scopeBoundsEnumeration,
  shouldDescendIntoDirectory,
} from "./collection-scope-enumeration.ts";

test("no declared boundary leaves every path in scope", () => {
  assert.equal(isPathWithinSourceRoots("anything/at/all", null), true);
  assert.equal(isPathWithinSourceRoots("anything", { source_roots: [] }), true);
  assert.equal(shouldDescendIntoDirectory("anything", null), true);
});

test("root membership is segment-wise, so a sibling prefix is not silently selected", () => {
  const scope = { source_roots: ["proj"] };
  assert.equal(isPathWithinSourceRoots("proj/session.jsonl", scope), true);
  assert.equal(
    isPathWithinSourceRoots("proj-secrets/session.jsonl", scope),
    false,
    "string-prefix matching would widen the owner's declared boundary"
  );
});

test("a walker may descend through an ancestor to reach a selected root", () => {
  const scope = { source_roots: ["a/b/c"] };
  assert.equal(shouldDescendIntoDirectory("a", scope), true);
  assert.equal(shouldDescendIntoDirectory("a/b", scope), true);
  assert.equal(shouldDescendIntoDirectory("a/b/c", scope), true);
  assert.equal(shouldDescendIntoDirectory("a/b/d", scope), false, "an unrelated sibling subtree is pruned unlisted");
  // ...but the ancestor itself is not a selected leaf.
  assert.equal(isPathWithinSourceRoots("a", scope), false);
});

test("path containment tolerates either separator", () => {
  assert.equal(pathContainsOrIsWithin("a/b", "a\\b\\c"), true);
  assert.equal(pathContainsOrIsWithin("a/b", "a/x"), false);
});

test("date-encoded directories prune whole years and months before listing them", () => {
  const scope = { since: "2026-06-15T00:00:00.000Z" };
  assert.equal(dateDirectoryInRange({ year: "2025" }, scope), false, "a whole prior year is pruned");
  assert.equal(dateDirectoryInRange({ year: "2027" }, scope), true);
  assert.equal(dateDirectoryInRange({ month: "05", year: "2026" }, scope), false);
  assert.equal(dateDirectoryInRange({ month: "07", year: "2026" }, scope), true);
});

test("the boundary day itself is never pruned — it straddles the instant", () => {
  const scope = { since: "2026-06-15T12:00:00.000Z" };
  assert.equal(dateDirectoryInRange({ day: "14", month: "06", year: "2026" }, scope), false);
  assert.equal(
    dateDirectoryInRange({ day: "15", month: "06", year: "2026" }, scope),
    true,
    "records later that same day are in range; per-record filtering resolves the day"
  );
  assert.equal(dateDirectoryInRange({ day: "16", month: "06", year: "2026" }, scope), true);
});

test("an unreadable boundary never silently excludes data", () => {
  assert.equal(dateDirectoryInRange({ day: "01", month: "01", year: "2000" }, { since: "not-a-date" }), true);
  assert.equal(dateDirectoryInRange({ year: "not-a-year" }, { since: "2026-06-15T00:00:00.000Z" }), true);
  assert.equal(dateDirectoryInRange({ year: "2026" }, null), true);
});

test("the boundary is read off the stream scopes the runtime already threads through", () => {
  const requested = new Map([
    ["skills", {}],
    ["sessions", { source_roots: ["proj-a"], time_range: { since: "2026-06-01T00:00:00.000Z" } }],
  ]);
  assert.deepEqual(readEnumerationScope(requested, ["skills", "sessions"]), {
    since: "2026-06-01T00:00:00.000Z",
    source_roots: ["proj-a"],
  });
  assert.equal(readEnumerationScope(new Map([["sessions", {}]]), ["sessions"]), null);
});

test("scopeBoundsEnumeration distinguishes a bounded run from a merely filtered one", () => {
  assert.equal(scopeBoundsEnumeration(null), false);
  assert.equal(scopeBoundsEnumeration({ since: null, source_roots: [] }), false);
  assert.equal(scopeBoundsEnumeration({ since: "2026-06-01T00:00:00.000Z" }), true);
  assert.equal(scopeBoundsEnumeration({ source_roots: ["proj"] }), true);
});
