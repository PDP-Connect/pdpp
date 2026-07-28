// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createMagicString } from "./magic-string.ts";
import { detectStageBClusters, propagateClusterType } from "./stage-b.ts";

const DIR_STRING_ANNOTATION_PATTERN = /\(dir: string\)/g;
const WITH_TEMP_QUERY_DIR_DECLARATION_PATTERN = /function withTempQueryDir\(fn\) \{/;

const WITH_TEMP_QUERY_DIR_SOURCE = [
  "function withTempQueryDir(fn) {",
  "  const dir = mkdtemp();",
  "  return fn(dir);",
  "}",
  "",
  "test('a', () => { withTempQueryDir((dir) => { use(dir); }); });",
  "test('b', () => { withTempQueryDir((dir) => { use(dir); }); });",
  "test('c', () => { withTempQueryDir((dir) => { use(dir); }); });",
  "",
].join("\n");

test("detects a positional-parameter cluster shaped like withTempQueryDir((dir) => {...}) (real corpus shape, 16 sites in query-registry.test.ts)", () => {
  const [cluster, ...rest] = detectStageBClusters(WITH_TEMP_QUERY_DIR_SOURCE, "f.ts");
  assert.equal(rest.length, 0);
  assert.ok(cluster, "expected a cluster");
  assert.equal(cluster.calleeName, "withTempQueryDir");
  assert.deepEqual(cluster.paramShape, { kind: "positional", names: ["dir"] });
  assert.equal(cluster.callSites.length, 3);
  assert.equal(cluster.potentialErrorMassReduction, 3);
});

const WITH_GMAIL_HARNESS_SOURCE = [
  "async function withGmailHarness(fn) {",
  "  return fn({ asUrl: 'x', rsUrl: 'y', connectorId: 'z' });",
  "}",
  "",
  "test('a', async () => { await withGmailHarness(async ({ asUrl, rsUrl, connectorId }) => { use(asUrl, rsUrl, connectorId); }); });",
  "test('b', async () => { await withGmailHarness(async ({ asUrl, rsUrl, connectorId }) => { use(asUrl, rsUrl, connectorId); }); });",
  "",
].join("\n");

test("detects a destructured-parameter cluster shaped like withGmailHarness(async ({...}) => {...}) (real corpus shape, 9 sites in b4-blob-fetch-conformance.test.ts)", () => {
  const [cluster, ...rest] = detectStageBClusters(WITH_GMAIL_HARNESS_SOURCE, "f.ts");
  assert.equal(rest.length, 0);
  assert.ok(cluster, "expected a cluster");
  assert.equal(cluster.calleeName, "withGmailHarness");
  assert.equal(cluster.paramShape.kind, "destructured");
  assert.deepEqual(cluster.paramShape.names, ["asUrl", "connectorId", "rsUrl"]);
  assert.equal(cluster.callSites.length, 2);
});

test("a helper called only ONCE is not reported as a cluster (no propagation win)", () => {
  const src = [
    "function withTempDir(fn) { return fn('x'); }",
    "test('a', () => { withTempDir((dir) => { use(dir); }); });",
    "",
  ].join("\n");
  const clusters = detectStageBClusters(src, "f.ts");
  assert.equal(clusters.length, 0);
});

test("already-annotated callback parameters are excluded from the cluster (nothing left to propagate)", () => {
  const src = [
    "function withTempDir(fn) { return fn('x'); }",
    "test('a', () => { withTempDir((dir: string) => { use(dir); }); });",
    "test('b', () => { withTempDir((dir: string) => { use(dir); }); });",
    "",
  ].join("\n");
  const clusters = detectStageBClusters(src, "f.ts");
  assert.equal(clusters.length, 0);
});

test("clusters are ranked by potentialErrorMassReduction descending", () => {
  const src = [
    "function withA(fn) { return fn('x'); }",
    "function withB(fn) { return fn({ p: 1, q: 2 }); }",
    "test('a1', () => { withA((x) => { use(x); }); });",
    "test('a2', () => { withA((x) => { use(x); }); });",
    "test('b1', () => { withB(({ p, q }) => { use(p, q); }); });",
    "test('b2', () => { withB(({ p, q }) => { use(p, q); }); });",
    "test('b3', () => { withB(({ p, q }) => { use(p, q); }); });",
    "",
  ].join("\n");
  const [first, second, ...rest] = detectStageBClusters(src, "f.ts");
  assert.equal(rest.length, 0);
  assert.ok(first && second, "expected exactly two clusters");
  // withB: 3 sites * 2 destructured names = 6; withA: 2 sites * 1 name = 2.
  assert.equal(first.calleeName, "withB");
  assert.equal(first.potentialErrorMassReduction, 6);
  assert.equal(second.calleeName, "withA");
  assert.equal(second.potentialErrorMassReduction, 2);
});

test("a helper with more than one parameter is not clustered (different, non-propagable shape)", () => {
  const src = [
    "function withTwo(fn, extra) { return fn('x'); }",
    "test('a', () => { withTwo((dir) => { use(dir); }, 1); });",
    "test('b', () => { withTwo((dir) => { use(dir); }, 2); });",
    "",
  ].join("\n");
  const clusters = detectStageBClusters(src, "f.ts");
  assert.equal(clusters.length, 0);
});

test("propagateClusterType inserts the given annotation verbatim at every call site, never inferring it", () => {
  const [cluster] = detectStageBClusters(WITH_TEMP_QUERY_DIR_SOURCE, "f.ts");
  if (!cluster) {
    throw new Error("expected a cluster");
  }
  const rewritten = propagateClusterType(WITH_TEMP_QUERY_DIR_SOURCE, cluster, ": string", createMagicString);
  const occurrences = [...rewritten.matchAll(DIR_STRING_ANNOTATION_PATTERN)];
  assert.equal(occurrences.length, 3, "the authored annotation must land at all 3 call sites, and nowhere else");
  // The declaration site's own `fn` parameter must be untouched — Stage B
  // propagates to CALL sites only, never guesses/touches the declaration.
  assert.match(rewritten, WITH_TEMP_QUERY_DIR_DECLARATION_PATTERN);
});

test("propagateClusterType is a pure text operation: the rewritten source still parses", () => {
  const [cluster] = detectStageBClusters(WITH_GMAIL_HARNESS_SOURCE, "f.ts");
  if (!cluster) {
    throw new Error("expected a cluster");
  }
  const rewritten = propagateClusterType(
    WITH_GMAIL_HARNESS_SOURCE,
    cluster,
    ": { asUrl: string; rsUrl: string; connectorId: string }",
    createMagicString
  );
  assert.doesNotThrow(() => detectStageBClusters(rewritten, "f.ts"));
});
