// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  dateDirectoryInRange,
  isPathWithinSourceRoots,
  pathContainsOrIsWithin,
  projectDirMatchesSourceRoots,
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
  assert.equal(
    dateDirectoryInRange({ day: "15", month: "06", year: "2026" }, scope),
    true,
    "records later that same day are in range; per-record filtering resolves the day"
  );
  assert.equal(dateDirectoryInRange({ day: "16", month: "06", year: "2026" }, scope), true);
});

// Codex names directories in LOCAL time but stamps records in UTC. Verified in
// ~/.codex/sessions: dir 2025/11/09 holds "2025-11-09T23:03:26.107Z" (6h skew),
// and across a 40-file sample three files sat in a directory whose day differs
// from their own UTC day (dir 2025-12-14 holding 2025-12-15T01:37:23Z). So the
// day BEFORE the boundary may still hold in-range records and must be kept.
test("the day before the boundary is kept, because a local-time directory can hold later UTC records", () => {
  const scope = { since: "2026-06-15T00:00:00.000Z" };
  assert.equal(
    dateDirectoryInRange({ day: "14", month: "06", year: "2026" }, scope),
    true,
    "a directory named 06-14 local can contain 06-15 UTC records; pruning it would silently drop them"
  );
  assert.equal(
    dateDirectoryInRange({ day: "13", month: "06", year: "2026" }, scope),
    false,
    "two days before the boundary is unreachable under any fixed offset, so it is still pruned"
  );
});

test("the one-day margin carries across month and year edges", () => {
  assert.equal(
    dateDirectoryInRange({ day: "31", month: "12", year: "2025" }, { since: "2026-01-01T00:00:00.000Z" }),
    true,
    "the previous year's last day can still hold in-range UTC records"
  );
  assert.equal(
    dateDirectoryInRange({ day: "30", month: "12", year: "2025" }, { since: "2026-01-01T00:00:00.000Z" }),
    false
  );
});

test("dot-segment traversal is resolved before containment is decided", () => {
  const scope = { source_roots: ["/a/proj"] };
  assert.equal(
    isPathWithinSourceRoots("/a/proj/../../etc/passwd", scope),
    false,
    "a candidate that climbs out of the root must not read as contained"
  );
  assert.equal(isPathWithinSourceRoots("/a/proj/./sub/file.jsonl", scope), true, "`.` segments are inert");
  assert.equal(
    isPathWithinSourceRoots("/a/other/../proj/x", scope),
    true,
    "a path that resolves INTO the root is contained, however it is spelled"
  );
});

test("a declared root cannot climb above its own first segment", () => {
  assert.equal(
    isPathWithinSourceRoots("/etc/passwd", { source_roots: ["/a/../.."] }),
    true,
    "a root that resolves to nothing declares no narrowing rather than escaping upward"
  );
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

// Claude Code flattens each project's absolute path into a single directory
// name (`/home/u/code/pdpp` -> `-home-u-code-pdpp`). An owner declares the
// natural path; matching their input against the raw flattened name would find
// nothing and silently collect an empty set.
test("a natural absolute path selects its flattened project directory", () => {
  const scope = { source_roots: ["/home/u/code/pdpp"] };
  assert.equal(projectDirMatchesSourceRoots("-home-u-code-pdpp", scope), true);
  assert.equal(
    projectDirMatchesSourceRoots("-home-u-code-pdpp-sub", scope),
    true,
    "a nested project is inside the root"
  );
  assert.equal(projectDirMatchesSourceRoots("-home-u-code-other", scope), false);
});

test("both dot encodings are accepted, because both appear in real corpora", () => {
  // Verified against a live ~/.claude/projects (2,347 dirs): `/home/u/.tmp/x`
  // appears as `-home-u--tmp-x` while `.claude` sometimes survives as `-.claude`.
  // Rejecting either encoding would silently exclude real projects.
  const scope = { source_roots: ["/home/u/.tmp/proj"] };
  assert.equal(projectDirMatchesSourceRoots("-home-u--tmp-proj", scope), true, "dot folded into a dash");
  assert.equal(projectDirMatchesSourceRoots("-home-u-.tmp-proj", scope), true, "dot preserved");
});

test("a bare project name is accepted as the final segment only", () => {
  const scope = { source_roots: ["pdpp"] };
  assert.equal(projectDirMatchesSourceRoots("-home-u-code-pdpp", scope), true);
  // Deliberately NOT matched: `-` is ambiguous between a path separator and a
  // literal dash, so `-pdpp-worktree` could be the project `/…/pdpp/worktree`
  // OR the unrelated project `/…/pdpp-worktree`. Matching it would silently
  // widen the boundary; an owner who means the nested one names its full path.
  assert.equal(projectDirMatchesSourceRoots("-home-u-code-pdpp-worktree", scope), false);
});

// Counterweights: the bare-name convenience must not become a substring match.
test("a bare root never widens onto a longer sibling name", () => {
  assert.equal(
    projectDirMatchesSourceRoots("-home-u-code-real", { source_roots: ["rea"] }),
    false,
    "`rea` must not select `real` — a prefix match would silently widen the declared boundary"
  );
  assert.equal(
    projectDirMatchesSourceRoots("-home-u-code-proj-secrets", { source_roots: ["proj"] }),
    false,
    "`proj` must not select `proj-secrets`"
  );
  assert.equal(
    projectDirMatchesSourceRoots("-home-u-code-mypdpp", { source_roots: ["pdpp"] }),
    false,
    "a segment must be whole; `pdpp` does not select `mypdpp`"
  );
});

test("an absolute root never widens onto a longer sibling path", () => {
  assert.equal(
    projectDirMatchesSourceRoots("-home-u-code-pdpp2", { source_roots: ["/home/u/code/pdpp"] }),
    false,
    "the encoded root must be followed by a separator boundary, not any character"
  );
});

test("no declared roots leaves every project directory in scope", () => {
  assert.equal(projectDirMatchesSourceRoots("-anything", null), true);
  assert.equal(projectDirMatchesSourceRoots("-anything", { source_roots: [] }), true);
});
