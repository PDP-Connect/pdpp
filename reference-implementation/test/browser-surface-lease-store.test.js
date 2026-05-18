import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { closeDb, getDb, initDb } from "../server/db.js";
import {
  createPostgresBrowserSurfaceLeaseStore,
  createSqliteBrowserSurfaceLeaseStore,
} from "../server/stores/browser-surface-lease-store.ts";

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

test("persists starting dynamic surface metadata for allocator reconciliation", async () => {
  const store = setup();
  try {
    const startingSurface = surface({
      surface_id: "surface_dynamic_1",
      profile_key: "https://registry.pdpp.org/connectors/chatgpt",
      account_key: "owner@example.com",
      surface_mode: "dynamic",
      surface_source: "allocator",
      cdp_url: "http://allocator.local/surfaces/surface_dynamic_1/cdp",
      stream_base_url: "http://reference.test/_ref/browser-surfaces/surface_dynamic_1",
      stream_origin: "http://neko-surface-dynamic-1:8080",
      health: "starting",
      container_id: "container_123",
      container_name: "pdpp-neko-surface-dynamic-1",
      profile_dir: "/var/lib/pdpp/neko-profiles/chatgpt-hash",
      profile_volume: "pdpp_neko_profile_chatgpt_hash",
      active_lease_id: "lease_starting",
    });
    const startingLease = lease({
      lease_id: "lease_starting",
      surface_id: "surface_dynamic_1",
      profile_key: "https://registry.pdpp.org/connectors/chatgpt",
      account_key: "owner@example.com",
      run_id: "run_starting",
      status: "starting_surface",
      leased_at: undefined,
      wait_reason: "surface_starting",
    });

    await store.upsertSurface(startingSurface);
    await store.upsertLease(startingLease);

    assert.deepEqual(await store.getSurface("surface_dynamic_1"), startingSurface);
    assert.deepEqual(await store.getLease("lease_starting"), startingLease);
    assert.deepEqual(await store.listSurfaces(), [startingSurface]);
    assert.deepEqual(await store.listNonTerminalLeases(), [startingLease]);
  } finally {
    teardown();
  }
});

test("SQLite browser surface schema exposes dynamic allocator metadata columns", () => {
  setup();
  try {
    const columns = getDb().prepare("PRAGMA table_info(browser_surfaces)").all().map((row) => row.name);
    for (const column of [
      "surface_mode",
      "surface_source",
      "container_name",
      "profile_dir",
      "profile_volume",
      "stream_origin",
    ]) {
      assert.ok(columns.includes(column), `expected browser_surfaces.${column}`);
    }
  } finally {
    teardown();
  }
});

test("SQLite migration widens browser-surface lease enum constraints in existing DBs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-browser-surface-lease-"));
  const dbPath = join(dir, "legacy.sqlite");
  const legacy = new Database(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE browser_surfaces (
        surface_id TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        profile_key TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        account_key TEXT,
        cdp_url TEXT NOT NULL,
        stream_base_url TEXT NOT NULL,
        health TEXT NOT NULL,
        container_id TEXT,
        active_lease_id TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        CHECK (backend IN ('neko')),
        CHECK (health IN ('starting', 'ready', 'unhealthy', 'stopping'))
      );

      CREATE TABLE browser_surface_leases (
        lease_id        TEXT PRIMARY KEY,
        surface_id      TEXT,
        connector_id    TEXT NOT NULL,
        profile_key     TEXT NOT NULL,
        account_key     TEXT,
        run_id          TEXT NOT NULL,
        status          TEXT NOT NULL,
        priority_class  TEXT NOT NULL,
        requested_at    TEXT NOT NULL,
        leased_at       TEXT,
        released_at     TEXT,
        expires_at      TEXT NOT NULL,
        fencing_token   INTEGER NOT NULL,
        wait_reason     TEXT,
        CHECK (status IN (
          'waiting_for_browser_surface',
          'leased',
          'released',
          'expired',
          'deferred',
          'cancelled',
          'surface_failed'
        )),
        CHECK (priority_class IN ('owner_interactive', 'scheduled_refresh')),
        CHECK (wait_reason IS NULL OR wait_reason IN (
          'capacity_full',
          'surface_starting',
          'surface_unhealthy',
          'incompatible_static_profile',
          'launch_precondition_failed',
          'lease_wait_timeout'
        ))
      );

      INSERT INTO browser_surface_leases(
        lease_id,
        connector_id,
        profile_key,
        run_id,
        status,
        priority_class,
        requested_at,
        expires_at,
        fencing_token,
        wait_reason
      )
      VALUES (
        'legacy_waiting',
        'chatgpt',
        'chatgpt',
        'run_legacy',
        'waiting_for_browser_surface',
        'scheduled_refresh',
        '2026-05-12T12:00:00.000Z',
        '2026-05-12T12:05:00.000Z',
        1,
        'capacity_full'
      );
    `);
  } finally {
    legacy.close();
  }

  try {
    initDb(dbPath);
    const schema = getDb()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'browser_surface_leases'")
      .get().sql;
    assert.match(schema, /'starting_surface'/);
    assert.match(schema, /'surface_start_failed'/);

    getDb().prepare(`
      INSERT INTO browser_surface_leases(
        lease_id,
        connector_id,
        profile_key,
        run_id,
        status,
        priority_class,
        requested_at,
        expires_at,
        fencing_token,
        wait_reason
      )
      VALUES (
        'lease_start_failed',
        'chatgpt',
        'chatgpt',
        'run_start_failed',
        'surface_failed',
        'owner_interactive',
        '2026-05-12T12:00:01.000Z',
        '2026-05-12T12:05:01.000Z',
        2,
        'surface_start_failed'
      )
    `).run();
    getDb().prepare(`
      INSERT INTO browser_surface_leases(
        lease_id,
        connector_id,
        profile_key,
        run_id,
        status,
        priority_class,
        requested_at,
        expires_at,
        fencing_token,
        wait_reason
      )
      VALUES (
        'lease_starting',
        'chatgpt',
        'chatgpt-dynamic',
        'run_starting',
        'starting_surface',
        'owner_interactive',
        '2026-05-12T12:00:02.000Z',
        '2026-05-12T12:05:02.000Z',
        3,
        'surface_readiness_timeout'
      )
    `).run();

    const rows = getDb().prepare("SELECT lease_id FROM browser_surface_leases ORDER BY lease_id").all();
    assert.deepEqual(rows.map((row) => row.lease_id), [
      "lease_start_failed",
      "lease_starting",
      "legacy_waiting",
    ]);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Postgres store maps dynamic surface metadata with the same persistence shape", async () => {
  const dynamicSurface = surface({
    surface_id: "surface_dynamic_pg",
    surface_mode: "dynamic",
    surface_source: "allocator",
    stream_origin: "http://neko-surface-pg:8080",
    health: "starting",
    container_id: "container_pg",
    container_name: "pdpp-neko-surface-pg",
    profile_dir: "/var/lib/pdpp/neko-profiles/pg-hash",
    profile_volume: "pdpp_neko_profile_pg_hash",
    active_lease_id: "lease_pg",
  });
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("SELECT * FROM browser_surfaces")) {
        return { rows: [dynamicSurface] };
      }
      return { rows: [] };
    },
  };
  const store = createPostgresBrowserSurfaceLeaseStore(client);

  await store.upsertSurface(dynamicSurface);

  assert.deepEqual(queries[0].params, [
    "surface_dynamic_pg",
    "neko",
    "chatgpt",
    "chatgpt",
    null,
    null,
    "dynamic",
    "allocator",
    "http://neko:9222",
    "http://neko:8080",
    "http://neko-surface-pg:8080",
    "starting",
    "container_pg",
    "pdpp-neko-surface-pg",
    "/var/lib/pdpp/neko-profiles/pg-hash",
    "pdpp_neko_profile_pg_hash",
    "lease_pg",
    "2026-05-12T12:00:00.000Z",
    "2026-05-12T12:00:00.000Z",
  ]);
  assert.deepEqual(await store.getSurface("surface_dynamic_pg"), dynamicSurface);
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
