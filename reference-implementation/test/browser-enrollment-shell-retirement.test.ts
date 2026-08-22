// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure browser-enrollment-shell TTL classifier
// (server/browser-enrollment-shell-retirement.ts).
//
// `expiredEnrollmentShellIds` takes a shell list and an explicit `now`
// (no clock) and returns the ids to retire. Its four independent guards —
// status must be draft|active, binding kind must be browser_enrollment_shell,
// enrollment_expires_at must be a string, and expiresMs <= nowMs with NaN
// rejection — are each pinned below so a dropped guard turns the suite red.
//
// The store-writing variant, `retireExpiredBrowserEnrollmentShells`, is
// exercised separately below (quiet-expiry defect fix, owner ruling
// 2026-08-22) against a fake `updateStatus` spy, to pin that it records WHY a
// shell was revoked at the moment of revocation rather than leaving that to
// be reverse-guessed later.

import { strict as assert } from "node:assert/strict";
import { test } from "node:test";

import {
  expiredEnrollmentShellIds,
  retireExpiredBrowserEnrollmentShells,
  TTL_EXPIRED_REVOCATION_REASON,
} from "../server/browser-enrollment-shell-retirement.ts";

const NOW = "2026-07-02T00:00:00.000Z";

function shell(id: string, overrides: Record<string, unknown> = {}) {
  return {
    connectorInstanceId: id,
    sourceBinding: {
      enrollment_expires_at: "2026-06-01T00:00:00.000Z", // well before NOW
      kind: "browser_enrollment_shell",
    },
    status: "draft",
    ...overrides,
  };
}

test("retires an expired draft shell", () => {
  assert.deepEqual(expiredEnrollmentShellIds([shell("a")], NOW), ["a"]);
});

test("retires an expired active shell (active != completed)", () => {
  assert.deepEqual(expiredEnrollmentShellIds([shell("a", { status: "active" })], NOW), ["a"]);
});

test("does not retire shells in other statuses", () => {
  assert.deepEqual(expiredEnrollmentShellIds([shell("a", { status: "revoked" })], NOW), []);
  assert.deepEqual(expiredEnrollmentShellIds([shell("a", { status: "completed" })], NOW), []);
});

test("does not retire when the binding kind is not a browser-enrollment shell", () => {
  const wrongKind = shell("a", {
    sourceBinding: { enrollment_expires_at: "2026-06-01T00:00:00.000Z", kind: "something_else" },
  });
  assert.deepEqual(expiredEnrollmentShellIds([wrongKind], NOW), []);
});

test("does not retire when the binding is missing or null", () => {
  assert.deepEqual(expiredEnrollmentShellIds([shell("a", { sourceBinding: null })], NOW), []);
  assert.deepEqual(expiredEnrollmentShellIds([shell("a", { sourceBinding: undefined })], NOW), []);
});

test("treats a non-string enrollment_expires_at as not-yet-expired", () => {
  const noTtl = shell("a", {
    sourceBinding: { enrollment_expires_at: undefined, kind: "browser_enrollment_shell" },
  });
  assert.deepEqual(expiredEnrollmentShellIds([noTtl], NOW), []);
  const numericTtl = shell("a", {
    sourceBinding: { enrollment_expires_at: 12_345, kind: "browser_enrollment_shell" },
  });
  assert.deepEqual(expiredEnrollmentShellIds([numericTtl], NOW), []);
});

test("treats an unparseable enrollment_expires_at (NaN) as not-yet-expired", () => {
  const badDate = shell("a", {
    sourceBinding: { enrollment_expires_at: "not-a-date", kind: "browser_enrollment_shell" },
  });
  assert.deepEqual(expiredEnrollmentShellIds([badDate], NOW), []);
});

test("does NOT retire a shell whose TTL is in the future", () => {
  const future = shell("a", {
    sourceBinding: { enrollment_expires_at: "2026-08-01T00:00:00.000Z", kind: "browser_enrollment_shell" },
  });
  assert.deepEqual(expiredEnrollmentShellIds([future], NOW), []);
});

test("retires a shell whose TTL is exactly now (inclusive boundary)", () => {
  // Guard is `expiresMs <= nowMs`, so expiry == now is retired.
  const atBoundary = shell("a", {
    sourceBinding: { enrollment_expires_at: NOW, kind: "browser_enrollment_shell" },
  });
  assert.deepEqual(expiredEnrollmentShellIds([atBoundary], NOW), ["a"]);
});

test("filters a mixed list to only the expired, eligible shells", () => {
  const shells = [
    shell("expired-draft"),
    shell("expired-active", { status: "active" }),
    shell("future", {
      sourceBinding: { enrollment_expires_at: "2027-01-01T00:00:00.000Z", kind: "browser_enrollment_shell" },
    }),
    shell("wrong-status", { status: "revoked" }),
  ];
  assert.deepEqual(expiredEnrollmentShellIds(shells, NOW), ["expired-draft", "expired-active"]);
});

test("returns an empty array for an empty input", () => {
  assert.deepEqual(expiredEnrollmentShellIds([], NOW), []);
});

// Quiet-expiry defect fix (owner ruling 2026-08-22): the store-writing sweep
// must record WHY it revoked a shell, not just THAT it did. A fake store
// spies on the exact args passed to `updateStatus`.
function fakeStore(shells: ReturnType<typeof shell>[]) {
  const updateStatusCalls: Array<{ connectorInstanceId: string; args: Record<string, unknown> }> = [];
  return {
    store: {
      listDraftBrowserEnrollmentShells() {
        return Promise.resolve(shells);
      },
      updateStatus(connectorInstanceId: string, args: Record<string, unknown>) {
        updateStatusCalls.push({ args, connectorInstanceId });
        return Promise.resolve(null);
      },
    },
    updateStatusCalls,
  };
}

test("retireExpiredBrowserEnrollmentShells stamps ttl_expired as the revocation reason", async () => {
  const { store, updateStatusCalls } = fakeStore([shell("a")]);
  const retired = await retireExpiredBrowserEnrollmentShells(store, { now: NOW });

  assert.deepEqual(retired, ["a"]);
  assert.equal(updateStatusCalls.length, 1);
  assert.deepEqual(
    updateStatusCalls[0]?.args.sourceBindingPatch,
    { revocation_reason: TTL_EXPIRED_REVOCATION_REASON },
    "the sweep must record the true cause at the moment of revocation, not leave it to be guessed later"
  );
  assert.equal(updateStatusCalls[0]?.args.status, "revoked");
});

test("retireExpiredBrowserEnrollmentShells stamps the reason for every shell it retires, not just the first", async () => {
  const { store, updateStatusCalls } = fakeStore([shell("a"), shell("b", { status: "active" })]);
  await retireExpiredBrowserEnrollmentShells(store, { now: NOW });

  assert.equal(updateStatusCalls.length, 2);
  for (const call of updateStatusCalls) {
    assert.deepEqual(call.args.sourceBindingPatch, { revocation_reason: TTL_EXPIRED_REVOCATION_REASON });
  }
});

test("retireExpiredBrowserEnrollmentShells does not call updateStatus at all when nothing is expired", async () => {
  const { store, updateStatusCalls } = fakeStore([
    shell("future", {
      sourceBinding: { enrollment_expires_at: "2027-01-01T00:00:00.000Z", kind: "browser_enrollment_shell" },
    }),
  ]);
  const retired = await retireExpiredBrowserEnrollmentShells(store, { now: NOW });

  assert.deepEqual(retired, []);
  assert.equal(updateStatusCalls.length, 0);
});
