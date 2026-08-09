// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectionScopeFingerprint,
  DEFAULT_RECENT_HISTORY_DAYS,
  resolveNamedCollectionScope,
} from "../src/evidence/index.ts";

const NOW = "2026-08-09T00:00:00.000Z";

test("recent history with no day count defaults to DEFAULT_RECENT_HISTORY_DAYS", () => {
  const scope = resolveNamedCollectionScope({ kind: "recent" }, NOW);
  assert.deepEqual(scope, { since: "2026-07-10T00:00:00.000Z" });
  assert.equal(DEFAULT_RECENT_HISTORY_DAYS, 30);
});

test("recent history honors an explicit day count", () => {
  const scope = resolveNamedCollectionScope({ kind: "recent", days: 7 }, NOW);
  assert.deepEqual(scope, { since: "2026-08-02T00:00:00.000Z" });
});

test("a non-positive explicit day count falls back to the default rather than producing a bogus boundary", () => {
  const scope = resolveNamedCollectionScope({ kind: "recent", days: 0 }, NOW);
  assert.deepEqual(scope, { since: "2026-07-10T00:00:00.000Z" });
});

test("all history resolves to null (unscoped), not an empty object", () => {
  assert.equal(resolveNamedCollectionScope({ kind: "all" }, NOW), null);
  assert.equal(collectionScopeFingerprint(resolveNamedCollectionScope({ kind: "all" }, NOW)), "unscoped");
});

test("custom passes through a well-formed since and source_roots", () => {
  const scope = resolveNamedCollectionScope(
    { kind: "custom", since: "2026-01-01T00:00:00Z", source_roots: ["pdpp", "waspflow"] },
    NOW
  );
  assert.deepEqual(scope, { since: "2026-01-01T00:00:00Z", source_roots: ["pdpp", "waspflow"] });
});

test("custom with neither field resolves to null, matching the unscoped encoding", () => {
  assert.equal(resolveNamedCollectionScope({ kind: "custom" }, NOW), null);
});

test("custom drops non-string/blank source_roots entries rather than sending malformed data downstream", () => {
  const scope = resolveNamedCollectionScope(
    { kind: "custom", source_roots: ["pdpp", "  ", 42 as unknown as string] },
    NOW
  );
  assert.deepEqual(scope, { source_roots: ["pdpp"] });
});

test("recent and custom-since-equivalent choices produce the same fingerprint", () => {
  const recent = resolveNamedCollectionScope({ kind: "recent", days: 30 }, NOW);
  const custom = resolveNamedCollectionScope({ kind: "custom", since: "2026-07-10T00:00:00.000Z" }, NOW);
  assert.equal(collectionScopeFingerprint(recent), collectionScopeFingerprint(custom));
});
