// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { parseDeviceScopeRequest, resolveEnrollmentScope } from "../server/enrollment-scope-narrowing.ts";

const NOW = "2026-08-09T00:00:00.000Z";

test("resolveEnrollmentScope rejects a device request offering an ANCESTOR of the server-declared root as a widening, not a narrowing", () => {
  // This is the P1 finding's exact reproduction, run through the RI's own
  // server-facing wrapper: a server scoped a connection to a narrow project
  // directory; the device requests the wider PARENT directory at connect
  // time. That must be rejected, not accepted with the wider root effective.
  const verdict = resolveEnrollmentScope({
    device: { kind: "declared", scope: { source_roots: ["/home/tim/projects"] } },
    now: NOW,
    serverDeclared: { source_roots: ["/home/tim/projects/work-only-client"] },
  });
  assert.equal(verdict.accepted, false);
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
