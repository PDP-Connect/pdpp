// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDeviceScopeRequest,
  pathContainsOrIsWithin,
  resolveEnrollmentScope,
} from "../server/enrollment-scope-narrowing.ts";

const NOW = "2026-08-09T00:00:00.000Z";

test("pathContainsOrIsWithin stays byte-identical to polyfill-connectors's real implementation", async () => {
  const { pathContainsOrIsWithin: realImpl } = await import(
    "../../packages/polyfill-connectors/src/collection-scope-enumeration.ts"
  );
  const cases: [string, string][] = [
    ["/home/u/code/pdpp", "/home/u/code/pdpp"],
    ["/home/u/code/pdpp", "/home/u/code/pdpp/sub"],
    ["/home/u/code/pdpp", "/home/u/code/other"],
    ["", "/anything"],
    ["/a/b/c", "/a/b"],
    ["a", "a/b/c"],
  ];
  for (const [root, candidate] of cases) {
    assert.equal(
      pathContainsOrIsWithin(root, candidate),
      realImpl(root, candidate),
      `drift on pathContainsOrIsWithin(${JSON.stringify(root)}, ${JSON.stringify(candidate)})`
    );
  }
});

test("parseDeviceScopeRequest: an absent field is unspecified, not a declared full pass", () => {
  const parsed = parseDeviceScopeRequest(undefined);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.request, { kind: "unspecified" });
});

test("parseDeviceScopeRequest: an explicit null is a declared full pass", () => {
  const parsed = parseDeviceScopeRequest(null);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.request, { kind: "declared", scope: null });
});

test("parseDeviceScopeRequest: an empty object is also a declared full pass", () => {
  const parsed = parseDeviceScopeRequest({});
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.request, { kind: "declared", scope: null });
});

test("parseDeviceScopeRequest: rejects an unparseable since", () => {
  const parsed = parseDeviceScopeRequest({ since: "not-a-date" });
  assert.equal(parsed.ok, false);
});

test("parseDeviceScopeRequest: rejects a malformed source_roots entry", () => {
  const parsed = parseDeviceScopeRequest({ source_roots: ["ok", ""] });
  assert.equal(parsed.ok, false);
});

test("parseDeviceScopeRequest: accepts a well-formed since + source_roots", () => {
  const parsed = parseDeviceScopeRequest({ since: "2026-07-01T00:00:00.000Z", source_roots: ["proj"] });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.request, {
    kind: "declared",
    scope: { since: "2026-07-01T00:00:00.000Z", source_roots: ["proj"] },
  });
});

test("resolveEnrollmentScope defaults to recent when nothing is declared on either side", () => {
  const verdict = resolveEnrollmentScope({ device: { kind: "unspecified" }, now: NOW, serverDeclared: null });
  assert.equal(verdict.accepted, true);
  assert.deepEqual(verdict.accepted && verdict.effective, { since: "2026-07-10T00:00:00.000Z" });
});

test("resolveEnrollmentScope rejects a device request that widens a server-declared boundary", () => {
  const verdict = resolveEnrollmentScope({
    device: { kind: "declared", scope: null },
    now: NOW,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z" },
  });
  assert.equal(verdict.accepted, false);
});
