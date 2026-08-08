// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fast, deterministic test for the mock-mutation gate's pure detection
 * logic (`findPathLiteralSites`). Does NOT re-run the full mutation sweep
 * — spawning `node --test` once per detected literal across all 42
 * connectors takes minutes and belongs to the standalone script
 * (`node --import tsx scripts/mock-mutation-check.ts`), not this
 * package's normal `pnpm test` run. This file only proves the detector
 * finds the shapes real connector tests use, and that it stays silent on
 * shapes that aren't path matchers (so it doesn't waste a mutation trial
 * — or worse, report a false WEAK — on an unrelated string literal).
 *
 * THE RATCHET: this is also where a future PR pins specific connectors
 * from advisory (report-only) to blocking. Today nothing here fails the
 * build on a WEAK or UNKNOWN verdict — see scripts/mock-mutation-check.ts
 * for why (34/42 connectors are unproven; most have no mutable mock
 * surface at all). When a connector's mutation verdict is deliberately
 * hardened (all its path literals proven load-bearing, kept that way), add
 * a case here asserting `checkConnector(name).verdict === "PASS"` for that
 * one connector by name — the same one-entry-at-a-time promotion shape as
 * `no-await-in-loops-allowlist.ts`. No such promotion has happened yet.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { findPathLiteralSites } from "../scripts/mock-mutation-check.ts";

test("findPathLiteralSites: detects === string-equality path matchers", () => {
  const source = ['if (path === "/System/Info") {', "  respond();", "}"].join("\n");
  const sites = findPathLiteralSites("fake.test.ts", source);
  assert.deepEqual(
    sites.map((s) => s.literal),
    ["/System/Info"]
  );
  assert.equal(sites[0]?.line, 1);
});

test("findPathLiteralSites: detects .startsWith and .includes path matchers", () => {
  const source = [
    'if (path.startsWith("/api/")) {',
    "  return notFound();",
    "}",
    'if (path.includes("/Users/test-user-123/Items")) {',
    "  return items();",
    "}",
  ].join("\n");
  const sites = findPathLiteralSites("fake.test.ts", source);
  assert.deepEqual(
    sites.map((s) => s.literal),
    ["/api/", "/Users/test-user-123/Items"]
  );
});

test("findPathLiteralSites: ignores comment lines quoting a path", () => {
  const source = [
    "// Jellyfin serves its REST API at the root, NOT under /api/ — a request",
    "// path with that prefix indicates a regression to a URL shape that 404s.",
    " * See /api/ for background.",
    'if (path === "/System/Info") {',
    "  respond();",
    "}",
  ].join("\n");
  const sites = findPathLiteralSites("fake.test.ts", source);
  assert.deepEqual(
    sites.map((s) => s.literal),
    ["/System/Info"],
    "commented-out path mentions must not be treated as executable matchers"
  );
});

test("findPathLiteralSites: ignores non-path string literals and non-matcher comparisons", () => {
  const source = [
    'const label = "not a path";',
    'assert.equal(status, "ok");',
    'const greeting = "/not/really/checked" + suffix;', // string concat — not a matcher shape
  ].join("\n");
  const sites = findPathLiteralSites("fake.test.ts", source);
  assert.deepEqual(sites, [], "no `===`, `.startsWith(...)`, or `.includes(...)` path-matcher shape is present");
});

test("findPathLiteralSites: returns empty for a file with zero path literals (the UNKNOWN case)", () => {
  const source = [
    "const fetchStub = () => Promise.resolve({ ok: true });",
    "test('does nothing HTTP-shaped', () => {});",
  ].join("\n");
  assert.deepEqual(findPathLiteralSites("fake.test.ts", source), []);
});

test("findPathLiteralSites: records the correct file and 1-indexed line for a multi-line file", () => {
  const source = ["", "", 'if (url === "/Users/Me") {', "  ok();", "}"].join("\n");
  const sites = findPathLiteralSites("connectors/jellyfin/integration.test.ts", source);
  assert.deepEqual(sites, [{ file: "connectors/jellyfin/integration.test.ts", line: 3, literal: "/Users/Me" }]);
});
