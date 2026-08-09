// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { defaultUndeclaredScope, resolveEffectiveEnrollmentScope } from "../src/evidence/index.ts";

const NOW = "2026-08-09T00:00:00.000Z";
const UNSPECIFIED = { kind: "unspecified" } as const;
const PATH_SEPARATORS = /[\\/]/;
const WIDER_THAN_SERVER_PATTERN = /wider than the server-declared boundary/;
const UNSCOPED_ALL_HISTORY_PATTERN = /unscoped \(all-history\) pass/;

/** Segment-prefix containment, mirroring collection-scope-enumeration.ts's real rule closely enough for these tests. */
function pathContainsOrIsWithin(root: string, candidate: string): boolean {
  const norm = (v: string) => v.split(PATH_SEPARATORS).filter(Boolean);
  const rootParts = norm(root);
  const candidateParts = norm(candidate);
  if (rootParts.length === 0) {
    return true;
  }
  if (rootParts.length > candidateParts.length) {
    return false;
  }
  return rootParts.every((part, i) => part === candidateParts[i]);
}

test("neither side declares a boundary: the default is RECENT, never an implicit full pass", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: UNSPECIFIED,
    now: NOW,
    pathContainsOrIsWithin,
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
    pathContainsOrIsWithin,
    serverDeclared: null,
  });
  assert.deepEqual(scoped.accepted && scoped.effective, { since: "2026-06-01T00:00:00.000Z" });
});

test("server declares nothing, device EXPLICITLY declares all (scope: null): honored as unscoped", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: null },
    now: NOW,
    pathContainsOrIsWithin,
    serverDeclared: null,
  });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.accepted && verdict.effective, null);
});

test("unspecified device request is distinct from an explicit all request: unspecified defaults to recent, explicit all does not", () => {
  const unspecified = resolveEffectiveEnrollmentScope({
    device: UNSPECIFIED,
    now: NOW,
    pathContainsOrIsWithin,
    serverDeclared: null,
  });
  const explicitAll = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: null },
    now: NOW,
    pathContainsOrIsWithin,
    serverDeclared: null,
  });
  assert.notDeepEqual(unspecified.accepted && unspecified.effective, explicitAll.accepted && explicitAll.effective);
});

test("server declares a boundary, device is unspecified: the server's boundary wins unchanged", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: UNSPECIFIED,
    now: NOW,
    pathContainsOrIsWithin,
    serverDeclared: { since: "2026-05-01T00:00:00.000Z" },
  });
  assert.deepEqual(verdict.accepted && verdict.effective, { since: "2026-05-01T00:00:00.000Z" });
});

test("device since at or after server since is accepted as a narrowing", () => {
  const equal = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { since: "2026-06-01T00:00:00.000Z" } },
    now: NOW,
    pathContainsOrIsWithin,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z" },
  });
  assert.equal(equal.accepted, true);

  const narrower = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { since: "2026-07-01T00:00:00.000Z" } },
    now: NOW,
    pathContainsOrIsWithin,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z" },
  });
  assert.equal(narrower.accepted, true);
  assert.deepEqual(narrower.accepted && narrower.effective, { since: "2026-07-01T00:00:00.000Z" });
});

test("device since BEFORE server since is REJECTED as widening, not clamped", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { since: "2026-01-01T00:00:00.000Z" } },
    now: NOW,
    pathContainsOrIsWithin,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z" },
  });
  assert.equal(verdict.accepted, false);
  assert.match((verdict as { reason: string }).reason, WIDER_THAN_SERVER_PATTERN);
});

test("device declaring no since at all, against a server since, is REJECTED as widening", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { source_roots: ["proj-a"] } },
    now: NOW,
    pathContainsOrIsWithin,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z" },
  });
  assert.equal(verdict.accepted, false);
});

test("device explicitly requesting all (scope: null) against a server boundary is REJECTED as widening", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: null },
    now: NOW,
    pathContainsOrIsWithin,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z" },
  });
  assert.equal(verdict.accepted, false);
  assert.match((verdict as { reason: string }).reason, UNSCOPED_ALL_HISTORY_PATTERN);
});

test("device root nested inside a server root is accepted as a narrowing", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { source_roots: ["/home/u/code/pdpp/sub"] } },
    now: NOW,
    pathContainsOrIsWithin,
    serverDeclared: { source_roots: ["/home/u/code/pdpp"] },
  });
  assert.equal(verdict.accepted, true);
  assert.deepEqual(verdict.accepted && verdict.effective, { source_roots: ["/home/u/code/pdpp/sub"] });
});

test("device root outside every server root is REJECTED as widening", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { source_roots: ["/home/u/code/other-project"] } },
    now: NOW,
    pathContainsOrIsWithin,
    serverDeclared: { source_roots: ["/home/u/code/pdpp"] },
  });
  assert.equal(verdict.accepted, false);
});

test("device declaring no roots at all, against server roots, is REJECTED as widening", () => {
  const verdict = resolveEffectiveEnrollmentScope({
    device: { kind: "declared", scope: { since: "2026-07-01T00:00:00.000Z" } },
    now: NOW,
    pathContainsOrIsWithin,
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
    pathContainsOrIsWithin,
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
    pathContainsOrIsWithin,
    serverDeclared: { since: "2026-06-01T00:00:00.000Z", source_roots: ["/home/u/code/pdpp"] },
  });
  assert.equal(verdict.accepted, true);
});
