// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConnectScopeRequest,
  DEFAULT_CONNECT_RECENT_DAYS,
  describeConnectScopeChoice,
  recentSinceDays,
} from "../src/connect-scope.ts";

const NOW = "2026-08-09T00:00:00.000Z";
const SERVER_DEFAULT_PATTERN = /server default/;
const ALL_HISTORY_PATTERN = /all history/;
const RECENT_30_PATTERN = /recent 30 day/;
const RECENT_7_PATTERN = /recent 7 day/;
const CUSTOM_SINCE_PATTERN = /custom \(since=2026-07-01/;

test("unspecified sends no collection_scope field at all (undefined, not null)", () => {
  const body = buildConnectScopeRequest({ kind: "unspecified" }, NOW);
  assert.equal(body, undefined);
});

test("explicit all sends collection_scope: null, distinct from unspecified", () => {
  const body = buildConnectScopeRequest({ kind: "all" }, NOW);
  assert.equal(body, null);
  assert.notEqual(body, buildConnectScopeRequest({ kind: "unspecified" }, NOW));
});

test("recent with no day count defaults to DEFAULT_CONNECT_RECENT_DAYS", () => {
  const body = buildConnectScopeRequest({ kind: "recent" }, NOW);
  assert.deepEqual(body, { since: recentSinceDays(NOW, DEFAULT_CONNECT_RECENT_DAYS) });
  assert.equal(DEFAULT_CONNECT_RECENT_DAYS, 30);
});

test("recent honors an explicit day count", () => {
  const body = buildConnectScopeRequest({ kind: "recent", recentDays: 7 }, NOW);
  assert.deepEqual(body, { since: recentSinceDays(NOW, 7) });
});

test("recent with a non-positive day count falls back to the default", () => {
  const body = buildConnectScopeRequest({ kind: "recent", recentDays: 0 }, NOW);
  assert.deepEqual(body, { since: recentSinceDays(NOW, DEFAULT_CONNECT_RECENT_DAYS) });
});

test("custom passes through since and source_roots", () => {
  const body = buildConnectScopeRequest(
    { kind: "custom", since: "2026-07-01T00:00:00.000Z", sourceRoots: ["proj-a", "proj-b"] },
    NOW
  );
  assert.deepEqual(body, { since: "2026-07-01T00:00:00.000Z", source_roots: ["proj-a", "proj-b"] });
});

test("custom with neither since nor source_roots resolves to an explicit full pass (null)", () => {
  const body = buildConnectScopeRequest({ kind: "custom" }, NOW);
  assert.equal(body, null);
});

test("describeConnectScopeChoice names the boundary for every kind", () => {
  assert.match(describeConnectScopeChoice({ kind: "unspecified" }, NOW), SERVER_DEFAULT_PATTERN);
  assert.match(describeConnectScopeChoice({ kind: "all" }, NOW), ALL_HISTORY_PATTERN);
  assert.match(describeConnectScopeChoice({ kind: "recent" }, NOW), RECENT_30_PATTERN);
  assert.match(describeConnectScopeChoice({ kind: "recent", recentDays: 7 }, NOW), RECENT_7_PATTERN);
  assert.match(
    describeConnectScopeChoice({ kind: "custom", since: "2026-07-01T00:00:00.000Z" }, NOW),
    CUSTOM_SINCE_PATTERN
  );
});

test("recentSinceDays matches @pdpp/reference-contract's day-math exactly (cross-package equivalence)", async () => {
  const { resolveNamedCollectionScope } = await import(
    "../../reference-contract/src/evidence/named-collection-scope.ts"
  );
  for (const days of [1, 7, 30, 90, 365]) {
    const local = recentSinceDays(NOW, days);
    const contract = resolveNamedCollectionScope({ days, kind: "recent" }, NOW);
    assert.equal(local, contract?.since, `drift on recentSinceDays(${days}) vs reference-contract's resolver`);
  }
});
