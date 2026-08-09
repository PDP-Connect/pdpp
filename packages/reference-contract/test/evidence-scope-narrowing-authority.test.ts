// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { defaultUndeclaredScope, pathIsWithinOrEqual, resolveEffectiveEnrollmentScope } from "../src/evidence/index.ts";

const NOW = "2026-08-09T00:00:00.000Z";
const UNSPECIFIED = { kind: "unspecified" } as const;
const WIDER_THAN_SERVER_PATTERN = /wider than the server-declared boundary/;
const UNSCOPED_ALL_HISTORY_PATTERN = /unscoped \(all-history\) pass/;

test("neither side declares a boundary: the default is RECENT, never an implicit full pass", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: UNSPECIFIED,
    now: NOW,
    serverDeclared: null,
  });
  assert.equal(verdict.accepted, true);
  assert.deepEqual(verdict.accepted && verdict.effective, defaultUndeclaredScope(NOW));
  assert.deepEqual(defaultUndeclaredScope(NOW), { since: "2026-07-10T00:00:00.000Z" });
});

test("server declares nothing, device declares a scoped boundary: honored as-is", () => {
  const scoped = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { since: "2026-06-01T00:00:00.000Z" } },
    now: NOW,
    serverDeclared: null,
  });
  assert.deepEqual(scoped.accepted && scoped.effective, { since: "2026-06-01T00:00:00.000Z" });
});

test("server declares nothing, device EXPLICITLY declares all (scope: null): honored as unscoped", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: null },
    now: NOW,
    serverDeclared: null,
  });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.accepted && verdict.effective, null);
});

test("unspecified device request is distinct from an explicit all request: unspecified defaults to recent, explicit all does not", () => {
  const unspecified = resolveEffectiveEnrollmentScope({
    device: UNSPECIFIED,
    now: NOW,
    serverDeclared: null,
  });
  const explicitAll = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: null },
    now: NOW,
    serverDeclared: null,
  });
  assert.notDeepEqual(unspecified.accepted && unspecified.effective, explicitAll.accepted && explicitAll.effective);
});

test("server declares a boundary, device is unspecified: the server's boundary wins unchanged", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: UNSPECIFIED,
    now: NOW,
    serverDeclared: { since: "2026-05-01T00:00:00.000Z" },
  });
  assert.deepEqual(verdict.accepted && verdict.effective, { since: "2026-05-01T00:00:00.000Z" });
});

test("device since at or after server since is accepted as a narrowing", () => {
  const equal = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { since: "2026-06-01T00:00:00.000Z" } },
    now: NOW,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z" },
  });
  assert.equal(equal.accepted, true);

  const narrower = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { since: "2026-07-01T00:00:00.000Z" } },
    now: NOW,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z" },
  });
  assert.equal(narrower.accepted, true);
  assert.deepEqual(narrower.accepted && narrower.effective, { since: "2026-07-01T00:00:00.000Z" });
});

test("device since BEFORE server since is REJECTED as widening, not clamped", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { since: "2026-01-01T00:00:00.000Z" } },
    now: NOW,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z" },
  });
  assert.equal(verdict.accepted, false);
  assert.match((verdict as { reason: string }).reason, WIDER_THAN_SERVER_PATTERN);
});

test("device declaring no since at all, against a server since, is REJECTED as widening", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { source_roots: ["proj-a"] } },
    now: NOW,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z" },
  });
  assert.equal(verdict.accepted, false);
});

test("device explicitly requesting all (scope: null) against a server boundary is REJECTED as widening", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: null },
    now: NOW,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z" },
  });
  assert.equal(verdict.accepted, false);
  assert.match((verdict as { reason: string }).reason, UNSCOPED_ALL_HISTORY_PATTERN);
});

test("device root nested inside a server root is accepted as a narrowing", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { source_roots: ["/home/u/code/pdpp/sub"] } },
    now: NOW,
    serverDeclared: { source_roots: ["/home/u/code/pdpp"] },
  });
  assert.equal(verdict.accepted, true);
  assert.deepEqual(verdict.accepted && verdict.effective, { source_roots: ["/home/u/code/pdpp/sub"] });
});

test("device root outside every server root is REJECTED as widening", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { source_roots: ["/home/u/code/other-project"] } },
    now: NOW,
    serverDeclared: { source_roots: ["/home/u/code/pdpp"] },
  });
  assert.equal(verdict.accepted, false);
});

test("device root that is an ANCESTOR (parent) of the server root is REJECTED as widening, not accepted as contained (P1 regression)", () => {
  // The exact bypass from the red-team review: a device offering the parent
  // directory of the server-declared root must not be treated as "inside"
  // it. Run directly against the real resolveEffectiveEnrollmentScope with
  // no test-local reimplementation of the path predicate.
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { source_roots: ["/home/tim/projects"] } },
    now: NOW,
    serverDeclared: { source_roots: ["/home/tim/projects/work-only-client"] },
  });
  assert.equal(verdict.accepted, false);
  assert.match((verdict as { reason: string }).reason, WIDER_THAN_SERVER_PATTERN);
});

test("device root that is the server root's GRANDPARENT (whole home directory) is REJECTED as widening", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { source_roots: ["/home/tim"] } },
    now: NOW,
    serverDeclared: { source_roots: ["/home/tim/projects/work-only-client"] },
  });
  assert.equal(verdict.accepted, false);
});

test("device declaring no roots at all, against server roots, is REJECTED as widening", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { since: "2026-07-01T00:00:00.000Z" } },
    now: NOW,
    serverDeclared: { source_roots: ["/home/u/code/pdpp"] },
  });
  assert.equal(verdict.accepted, false);
});

test("narrower on one axis cannot trade width on the other: both axes must independently narrow", () => {
  // since is narrower (later), but source_roots widens (device declares
  // nothing where the server restricted to one project) -> must reject.
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { since: "2026-07-01T00:00:00.000Z" } },
    now: NOW,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z", source_roots: ["/home/u/code/pdpp"] },
  });
  assert.equal(verdict.accepted, false);
});

test("both axes narrower simultaneously is accepted", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: {
      kind: "declared",
      scope: { since: "2026-07-01T00:00:00.000Z", source_roots: ["/home/u/code/pdpp/sub"] },
    },
    now: NOW,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z", source_roots: ["/home/u/code/pdpp"] },
  });
  assert.equal(verdict.accepted, true);
});

// Direct unit coverage of the canonical directional containment authority
// itself, per the review's requested matrix: parent-root widening, exact
// match, descendant, sibling, normalized dot/dotdot, absolute/relative and
// separator counterweights.
test("pathIsWithinOrEqual: exact match is within", () => {
  assert.equal(pathIsWithinOrEqual("/a/b/c", "/a/b/c"), true);
});

test("pathIsWithinOrEqual: strict descendant is within", () => {
  assert.equal(pathIsWithinOrEqual("/a/b", "/a/b/c/d"), true);
});

test("pathIsWithinOrEqual: strict ancestor (parent) is NOT within — the P1 bypass shape", () => {
  assert.equal(pathIsWithinOrEqual("/a/b/c", "/a/b"), false);
  assert.equal(pathIsWithinOrEqual("/a/b/c", "/a"), false);
});

test("pathIsWithinOrEqual: sibling directories sharing a path prefix are NOT within", () => {
  assert.equal(pathIsWithinOrEqual("/a/proj", "/a/proj-secrets"), false);
  assert.equal(pathIsWithinOrEqual("/a/proj", "/a/other"), false);
});

test("pathIsWithinOrEqual: normalized `.` segments are inert", () => {
  assert.equal(pathIsWithinOrEqual("/a/proj", "/a/./proj/./sub"), true);
});

test("pathIsWithinOrEqual: normalized `..` segments resolve before comparison, cannot escape the bound", () => {
  assert.equal(pathIsWithinOrEqual("/a/proj", "/a/proj/../../etc/passwd"), false);
  assert.equal(pathIsWithinOrEqual("/a/proj", "/a/other/../proj/x"), true);
});

test("pathIsWithinOrEqual: absolute vs relative spellings compare by segments, not by string form", () => {
  assert.equal(pathIsWithinOrEqual("a/b", "a/b/c"), true);
  assert.equal(pathIsWithinOrEqual("a/b/c", "a/b"), false);
});

test("pathIsWithinOrEqual: separator counterweights — mixed / and \\ still compare by segment", () => {
  assert.equal(pathIsWithinOrEqual("a\\b", "a/b/c"), true);
  assert.equal(pathIsWithinOrEqual("a/b/c", "a\\b"), false);
});

test("pathIsWithinOrEqual: empty bound (no path restriction) is satisfied by anything", () => {
  assert.equal(pathIsWithinOrEqual("", "/anything"), true);
});
