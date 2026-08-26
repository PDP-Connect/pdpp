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

// ---------------------------------------------------------------------------
// In-flight-run guard (owner-wait defect, 2026-08-23).
//
// The TTL asks "has the owner abandoned this setup?". A run holding a durable
// controller claim (`controller_active_runs`) is direct evidence he has not —
// most acutely when the connector has asked him for a 2FA code and is waiting
// on his answer. Retiring such a shell kills his attempt for a reason that has
// nothing to do with the provider.
//
// The guard defers retirement for the life of a real run; it never cancels it.
// Every terminal path (success, failure, owner cancel, assistance timeout,
// boot reconciliation) deletes the claim, after which the shell retires on the
// next sweep — so an abandoned shell still expires.
// ---------------------------------------------------------------------------

// A shell already past its TTL, i.e. the sweep would revoke it but for a claim.
const expiredShell = () => shell("cin_venmo", { status: "active" });

test("does NOT retire an expired shell while a run against it is in flight", () => {
  assert.deepEqual(
    expiredEnrollmentShellIds([expiredShell()], NOW, new Set(["cin_venmo"])),
    [],
    "a shell the owner is actively signing into must survive its TTL"
  );
});

test("DOES retire an expired shell when no run is in flight (no regression)", () => {
  assert.deepEqual(
    expiredEnrollmentShellIds([expiredShell()], NOW, new Set()),
    ["cin_venmo"],
    "an abandoned shell must still expire — the TTL is not defeated"
  );
});

test("the in-flight guard is scoped to the claiming shell, not the whole sweep", () => {
  // An unrelated connection's run must not shelter a genuinely abandoned shell.
  const shells = [expiredShell(), shell("cin_abandoned")];
  assert.deepEqual(expiredEnrollmentShellIds(shells, NOW, new Set(["cin_venmo"])), ["cin_abandoned"]);
});

test("a shell whose owner-interaction wait has itself timed out expires normally", () => {
  // The eventual bound: when the owner never answers, the runtime's assistance
  // timeout terminates the run (`runtime/index.ts` -> run.assistance_timed_out)
  // and `runSingleAttempt`'s `finally` deletes the claim. The next sweep sees
  // an empty claim set and retires the shell. No shell is immortal.
  const claimsAfterInteractionTimeout = new Set<string>();
  assert.deepEqual(expiredEnrollmentShellIds([expiredShell()], NOW, claimsAfterInteractionTimeout), ["cin_venmo"]);
});

test("retireExpiredBrowserEnrollmentShells does not revoke a shell whose run is in flight", async () => {
  const { store, updateStatusCalls } = fakeStore([expiredShell()]);
  const retired = await retireExpiredBrowserEnrollmentShells(
    { ...store, listRunInFlightInstanceIds: () => Promise.resolve(["cin_venmo"]) },
    { now: NOW }
  );

  assert.deepEqual(retired, []);
  assert.equal(updateStatusCalls.length, 0, "the sweep must not write to a shell backing a live run");
});

test("retireExpiredBrowserEnrollmentShells revokes once the in-flight claim is released", async () => {
  const { store, updateStatusCalls } = fakeStore([expiredShell()]);
  const retired = await retireExpiredBrowserEnrollmentShells(
    { ...store, listRunInFlightInstanceIds: () => Promise.resolve([]) },
    { now: NOW }
  );

  assert.deepEqual(retired, ["cin_venmo"]);
  assert.equal(updateStatusCalls[0]?.args.status, "revoked");
});

test("retireExpiredBrowserEnrollmentShells reads claims AFTER shells, so a run starting mid-sweep is seen", async () => {
  // Race safety: the claim read must observe any run admitted after the shell
  // list was taken. Reading claims first would leave exactly the window this
  // guard exists to close. This fake admits a run between the two reads.
  const updateStatusCalls: Array<{ connectorInstanceId: string; args: Record<string, unknown> }> = [];
  let runAdmitted = false;
  const retired = await retireExpiredBrowserEnrollmentShells(
    {
      listDraftBrowserEnrollmentShells() {
        // The owner starts his setup run immediately after the sweep lists shells.
        runAdmitted = true;
        return Promise.resolve([expiredShell()]);
      },
      listRunInFlightInstanceIds() {
        return Promise.resolve(runAdmitted ? ["cin_venmo"] : []);
      },
      updateStatus(connectorInstanceId: string, args: Record<string, unknown>) {
        updateStatusCalls.push({ args, connectorInstanceId });
        return Promise.resolve(null);
      },
    },
    { now: NOW }
  );

  assert.deepEqual(retired, [], "a run admitted after the shell read must still be observed by the claim read");
  assert.equal(updateStatusCalls.length, 0);
});

// ─── Credentialed shells are not abandoned setups ───────────────────────────
//
// Production, 2026-08-26: a venmo shell was created 12:08:53 with the owner's
// genuine password captured, its run FAILED at 12:39:07 (so it was no longer
// in flight), the TTL expired at 14:08:53, and the sweep revoked it 39 seconds
// later. Seven venmo shells died that way, stranding his real credential on
// revoked rows behind seven "Setup never completed" cards.
//
// The TTL asks "has the owner abandoned this?". A captured credential answers
// no, exactly as an in-flight run does.

test("a shell holding a captured credential is NOT retired on wall-clock alone", () => {
  assert.deepEqual(
    expiredEnrollmentShellIds([shell("venmo-1")], NOW, new Set(), new Set(["venmo-1"])),
    [],
    "the owner typed his password into this shell; the clock must not throw that away"
  );
});

test("an UNcredentialed shell still ages out normally — this is not immortality", () => {
  assert.deepEqual(
    expiredEnrollmentShellIds([shell("abandoned-1")], NOW, new Set(), new Set(["someone-else"])),
    ["abandoned-1"],
    "a shell that never captured a credential is a genuinely abandoned setup"
  );
});

test("credential and run guards are independent — either one alone spares the shell", () => {
  // Only a run in flight.
  assert.deepEqual(expiredEnrollmentShellIds([shell("a")], NOW, new Set(["a"]), new Set()), []);
  // Only a credential.
  assert.deepEqual(expiredEnrollmentShellIds([shell("a")], NOW, new Set(), new Set(["a"])), []);
  // Neither.
  assert.deepEqual(expiredEnrollmentShellIds([shell("a")], NOW, new Set(), new Set()), ["a"]);
});

test("the sweep spares a credentialed shell end to end and records nothing for it", async () => {
  const revoked: string[] = [];
  const retired = await retireExpiredBrowserEnrollmentShells(
    {
      listCredentialedInstanceIds: () => Promise.resolve(["keeps-credential"]),
      listDraftBrowserEnrollmentShells: () => Promise.resolve([shell("keeps-credential"), shell("no-credential")]),
      listRunInFlightInstanceIds: () => Promise.resolve([]),
      updateStatus: (connectorInstanceId: string) => {
        revoked.push(connectorInstanceId);
        return Promise.resolve(undefined);
      },
    },
    { now: NOW }
  );

  assert.deepEqual(retired, ["no-credential"], "only the uncredentialed shell is retired");
  assert.deepEqual(revoked, ["no-credential"], "no status write may touch the credentialed shell");
});

test("a store that cannot report credentials degrades to the historical behavior", async () => {
  // `listCredentialedInstanceIds` is optional so existing callers and fakes
  // keep compiling. Absent means "none known", which is the pre-fix behavior —
  // never a crash, and never a silent skip of every retirement.
  const retired = await retireExpiredBrowserEnrollmentShells(
    {
      listDraftBrowserEnrollmentShells: () => Promise.resolve([shell("a")]),
      updateStatus: () => Promise.resolve(undefined),
    },
    { now: NOW }
  );
  assert.deepEqual(retired, ["a"]);
});
