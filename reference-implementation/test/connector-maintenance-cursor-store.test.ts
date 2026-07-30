// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { createConnectorMaintenanceCursorStore } from "../server/stores/connector-maintenance-cursor-store.ts";

test("SQLite maintenance cursor fences an expired stale writer from replacing a completed cursor", async () => {
  initDb(":memory:");
  try {
    const storeA = createConnectorMaintenanceCursorStore();
    const storeB = createConnectorMaintenanceCursorStore();
    const seeded = await storeA.acquire({ leaseDurationMs: 1, nowIso: "2026-07-30T00:00:00.000Z" });
    assert.ok(seeded);
    assert.equal(
      await storeA.commit({
        lease: seeded,
        resumeAfterId: "cin_a",
        updatedAt: "2026-07-30T00:00:00.000Z",
      }),
      true
    );
    const stale = await storeA.acquire({ leaseDurationMs: 1, nowIso: "2026-07-30T00:01:00.000Z" });
    assert.ok(stale);
    assert.equal(stale.resumeAfterId, "cin_a");
    const current = await storeB.acquire({ leaseDurationMs: 1, nowIso: "2026-07-30T00:01:01.000Z" });
    assert.ok(current);
    assert.equal(current.resumeAfterId, "cin_a");
    assert.equal(
      await storeB.commit({ lease: current, resumeAfterId: null, updatedAt: "2026-07-30T00:01:01.000Z" }),
      true
    );
    assert.equal(
      await storeA.commit({ lease: stale, resumeAfterId: "cin_b", updatedAt: "2026-07-30T00:01:02.000Z" }),
      false
    );
    const completed = await storeA.acquire({ leaseDurationMs: 1, nowIso: "2026-07-30T00:01:03.000Z" });
    assert.ok(completed);
    assert.equal(completed.resumeAfterId, null);
  } finally {
    closeDb();
  }
});
