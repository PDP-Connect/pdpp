import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
import { createSqliteBrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";

function surface(overrides = {}) {
  return {
    surface_id: "surface_1",
    backend: "neko",
    profile_key: "chatgpt",
    connector_id: "chatgpt",
    cdp_url: "http://neko:9222",
    stream_base_url: "http://neko:8080",
    health: "ready",
    created_at: "2026-05-12T12:00:00.000Z",
    last_used_at: "2026-05-12T12:00:00.000Z",
    ...overrides,
  };
}

function lease(overrides = {}) {
  return Object.fromEntries(Object.entries({
    lease_id: "lease_1",
    surface_id: "surface_1",
    connector_id: "chatgpt",
    profile_key: "chatgpt",
    run_id: "run_1",
    status: "leased",
    priority_class: "owner_interactive",
    requested_at: "2026-05-12T12:00:01.000Z",
    leased_at: "2026-05-12T12:00:02.000Z",
    expires_at: "2026-05-12T12:05:01.000Z",
    fencing_token: 1,
    ...overrides,
  }).filter(([, value]) => value !== undefined));
}

function setup() {
  initDb();
  return createSqliteBrowserSurfaceLeaseStore();
}

function teardown() {
  closeDb();
}

test("persists and reloads browser surfaces and leases as domain objects", async () => {
  const store = setup();
  try {
    const persistedSurface = surface({
      account_key: "owner@example.com",
      active_lease_id: "lease_1",
      container_id: "neko_static",
    });
    const persistedLease = lease({
      account_key: "owner@example.com",
    });

    await store.upsertSurface(persistedSurface);
    await store.upsertLease(persistedLease);

    assert.deepEqual(await store.getSurface("surface_1"), persistedSurface);
    assert.deepEqual(await store.getLease("lease_1"), persistedLease);
    assert.deepEqual(await store.listSurfaces(), [persistedSurface]);
    assert.deepEqual(await store.listNonTerminalLeases(), [persistedLease]);
  } finally {
    teardown();
  }
});

test("queued browser-surface leases are separate from controller_active_runs", async () => {
  const store = setup();
  try {
    const queued = lease({
      lease_id: "lease_waiting",
      surface_id: undefined,
      run_id: "run_waiting",
      status: "waiting_for_browser_surface",
      priority_class: "scheduled_refresh",
      leased_at: undefined,
      wait_reason: "capacity_full",
    });

    await store.upsertLease(queued);

    assert.deepEqual(await store.getLease("lease_waiting"), queued);
    const activeRunCount = getDb().prepare("SELECT COUNT(*) AS count FROM controller_active_runs").get().count;
    assert.equal(activeRunCount, 0);
  } finally {
    teardown();
  }
});

test("SQLite schema rejects duplicate non-terminal leases for the same run", async () => {
  const store = setup();
  try {
    await store.upsertLease(lease({ lease_id: "lease_a", surface_id: undefined, status: "waiting_for_browser_surface" }));

    assert.throws(
      () => {
        getDb()
          .prepare(
            `INSERT INTO browser_surface_leases(
              lease_id, connector_id, profile_key, run_id, status, priority_class,
              requested_at, expires_at, fencing_token
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "lease_b",
            "gmail",
            "gmail",
            "run_1",
            "waiting_for_browser_surface",
            "scheduled_refresh",
            "2026-05-12T12:00:03.000Z",
            "2026-05-12T12:05:03.000Z",
            2
          );
      },
      /UNIQUE constraint failed: browser_surface_leases\.run_id/
    );

    await store.upsertLease(lease({
      lease_id: "lease_released",
      run_id: "run_1",
      surface_id: undefined,
      status: "released",
      priority_class: "scheduled_refresh",
      leased_at: undefined,
      released_at: "2026-05-12T12:00:04.000Z",
    }));
  } finally {
    teardown();
  }
});

test("SQLite schema rejects two active leased rows for the same surface", async () => {
  const store = setup();
  try {
    await store.upsertSurface(surface());
    await store.upsertLease(lease({ lease_id: "lease_a", run_id: "run_a" }));

    assert.throws(
      () => {
        getDb()
          .prepare(
            `INSERT INTO browser_surface_leases(
              lease_id, surface_id, connector_id, profile_key, run_id, status, priority_class,
              requested_at, leased_at, expires_at, fencing_token
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "lease_b",
            "surface_1",
            "chatgpt",
            "chatgpt",
            "run_b",
            "leased",
            "owner_interactive",
            "2026-05-12T12:00:03.000Z",
            "2026-05-12T12:00:04.000Z",
            "2026-05-12T12:05:03.000Z",
            2
          );
      },
      /UNIQUE constraint failed: browser_surface_leases\.surface_id/
    );
  } finally {
    teardown();
  }
});

test("SQLite schema rejects duplicate pending connector/profile/account leases", async () => {
  const store = setup();
  try {
    await store.upsertLease(
      lease({
        account_key: "owner",
        lease_id: "lease_a",
        leased_at: undefined,
        run_id: "run_a",
        status: "waiting_for_browser_surface",
        surface_id: undefined,
      })
    );

    assert.throws(
      () => {
        getDb()
          .prepare(
            `INSERT INTO browser_surface_leases(
              lease_id, connector_id, profile_key, account_key, run_id, status, priority_class,
              requested_at, expires_at, fencing_token
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "lease_b",
            "chatgpt",
            "chatgpt",
            "owner",
            "run_b",
            "waiting_for_browser_surface",
            "scheduled_refresh",
            "2026-05-12T12:00:03.000Z",
            "2026-05-12T12:05:03.000Z",
            2
          );
      },
      /UNIQUE constraint failed/
    );
  } finally {
    teardown();
  }
});

test("transaction seam rolls back lease and surface writes together", async () => {
  const store = setup();
  try {
    await assert.rejects(
      store.withLeaseTransaction(async (tx) => {
        await tx.upsertSurface(surface({ surface_id: "surface_tx" }));
        await tx.upsertLease(lease({ lease_id: "lease_tx", surface_id: "surface_tx", run_id: "run_tx" }));
        throw new Error("boom");
      }),
      /boom/
    );

    assert.equal(await store.getSurface("surface_tx"), null);
    assert.equal(await store.getLease("lease_tx"), null);
  } finally {
    teardown();
  }
});

test("terminal update and token-fenced surface clear are idempotent store operations", async () => {
  const store = setup();
  try {
    await store.upsertSurface(surface({ active_lease_id: "lease_1" }));
    await store.upsertLease(lease());

    const released = await store.updateLeaseTerminal("lease_1", "released", {
      releasedAt: "2026-05-12T12:01:00.000Z",
    });
    const staleLeaseClear = await store.clearSurfaceActiveLease("surface_1", "stale_lease", 1);
    const staleTokenClear = await store.clearSurfaceActiveLease("surface_1", "lease_1", 999);
    const cleared = await store.clearSurfaceActiveLease("surface_1", "lease_1", 1);

    assert.equal(released.status, "released");
    assert.equal(released.released_at, "2026-05-12T12:01:00.000Z");
    assert.equal(staleLeaseClear.active_lease_id, "lease_1");
    assert.equal(staleTokenClear.active_lease_id, "lease_1");
    assert.equal(cleared.active_lease_id, undefined);
    assert.deepEqual(await store.listNonTerminalLeases(), []);
  } finally {
    teardown();
  }
});
