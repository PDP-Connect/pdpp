// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { matchesRecoveryInstance, resolveSchedulerMarkers } from "../runtime/scheduler/recovery-instance-scope.ts";

test("legacy null-instance gaps belong to the default instance only", () => {
  assert.equal(matchesRecoveryInstance(null, "connector-a", "connector-a"), true);
  assert.equal(matchesRecoveryInstance(undefined, "connector-a", "connector-a"), true);
  assert.equal(matchesRecoveryInstance(null, "owner-b-instance", "connector-a"), false);
  assert.equal(matchesRecoveryInstance("owner-b-instance", "owner-b-instance", "connector-a"), true);
  assert.equal(matchesRecoveryInstance("owner-b-instance", "connector-a", "connector-a"), false);
});

test("legacy marker evidence is durable beyond the in-memory history window", async () => {
  const calls: Array<{ sinceCompletedAt: string | null; connectorInstanceId: string }> = [];
  const evidence = await resolveSchedulerMarkers(
    (_connectorId, connectorInstanceId, _prefix, _reasonClass, sinceCompletedAt) => {
      calls.push({ connectorInstanceId, sinceCompletedAt });
      return true;
    },
    "connector-a",
    "connector-a",
    [{ completedAt: "2026-08-11T00:00:00.000Z", status: "failed" }],
    "connector:legacy",
    false,
    false
  );

  assert.deepEqual(evidence, { backoffStarted: true, gaveUp: true });
  assert.deepEqual(calls, [
    { connectorInstanceId: "connector-a", sinceCompletedAt: null },
    { connectorInstanceId: "connector-a", sinceCompletedAt: null },
  ]);
});
