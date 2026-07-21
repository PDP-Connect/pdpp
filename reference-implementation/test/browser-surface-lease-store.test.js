import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { Pool } from "pg";

import { closeDb, getDb, initDb } from "../server/db.js";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.js";
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

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

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
      surface_subject_id: "owner@example.com",
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

test("preserves a durable browser generation hash across ordinary SQLite surface upserts", async () => {
  const store = setup();
  try {
    const observedHash = "a".repeat(64);
    await store.upsertSurface(surface({ container_id: "container-1", browser_generation_hash: observedHash }));
    await store.upsertSurface(surface({ container_id: "container-1", last_used_at: "2026-05-12T12:01:00.000Z" }));

    assert.equal((await store.getSurface("surface_1")).browser_generation_hash, observedHash);
    await store.updateBrowserGenerationHash("surface_1", "b".repeat(64));
    assert.equal((await store.getSurface("surface_1")).browser_generation_hash, "b".repeat(64));
    await store.upsertSurface(surface({ container_id: "container-2" }));
    assert.equal((await store.getSurface("surface_1")).browser_generation_hash, undefined);
  } finally {
    teardown();
  }
});

test("persists terminal deferred retained leases with retained_capacity_reserved and excludes them from non-terminal listings", async () => {
  const store = setup();
  try {
    const deferredLease = lease({
      lease_id: "lease_retained_deferred",
      surface_id: undefined,
      run_id: "run_retained_deferred",
      status: "deferred",
      leased_at: undefined,
      released_at: "2026-05-12T12:01:00.000Z",
      wait_reason: "retained_capacity_reserved",
    });

    await store.upsertLease(deferredLease);

    assert.deepEqual(await store.getLease("lease_retained_deferred"), deferredLease);
    assert.deepEqual(await store.listNonTerminalLeases(), []);
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
      window_settle_endpoint: "http://allocator.local/pdpp/window-settle",
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

test("SQLite repair clears active surface pointers whose leases are terminal or missing", async () => {
  const store = setup();
  try {
    const activeSurface = surface({
      surface_id: "surface_active",
      active_lease_id: "lease_active",
    });
    const releasedSurface = surface({
      surface_id: "surface_released",
      active_lease_id: "lease_released",
    });
    const missingSurface = surface({
      surface_id: "surface_missing",
      active_lease_id: "lease_missing",
    });
    await store.upsertSurface(activeSurface);
    await store.upsertSurface(releasedSurface);
    await store.upsertSurface(missingSurface);
    await store.upsertLease(lease({ lease_id: "lease_active", surface_id: "surface_active" }));
    await store.upsertLease(
      lease({
        lease_id: "lease_released",
        surface_id: "surface_released",
        status: "released",
        released_at: "2026-05-12T12:01:00.000Z",
      }),
    );

    await store.repairStaleSurfaceActiveLeases();

    assert.equal((await store.getSurface("surface_active")).active_lease_id, "lease_active");
    assert.equal((await store.getSurface("surface_released")).active_lease_id, undefined);
    assert.equal((await store.getSurface("surface_missing")).active_lease_id, undefined);
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
      "window_settle_endpoint",
    ]) {
      assert.ok(columns.includes(column), `expected browser_surfaces.${column}`);
    }
  } finally {
    teardown();
  }
});

test("SQLite browser surface upgrade adds browser_generation_hash to an existing table", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-browser-surface-upgrade-"));
  const dbPath = join(dir, "legacy.sqlite");
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE browser_surfaces (
      surface_id TEXT PRIMARY KEY,
      backend TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      surface_subject_id TEXT,
      account_key TEXT,
      surface_mode TEXT,
      surface_source TEXT,
      cdp_url TEXT NOT NULL,
      stream_base_url TEXT NOT NULL,
      stream_origin TEXT,
      health TEXT NOT NULL,
      container_id TEXT,
      container_name TEXT,
      profile_dir TEXT,
      profile_volume TEXT,
      active_lease_id TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    )
  `);
  legacy.close();
  try {
    initDb(dbPath);
    const columns = getDb().prepare("PRAGMA table_info(browser_surfaces)").all().map((row) => row.name);
    assert.ok(columns.includes("browser_generation_hash"));
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
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
    assert.match(schema, /'retained_capacity_reserved'/);

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
        'lease_retained_reserved',
        'chatgpt',
        'chatgpt-retained',
        'run_retained_reserved',
        'deferred',
        'scheduled_refresh',
        '2026-05-12T12:00:03.000Z',
        '2026-05-12T12:05:03.000Z',
        4,
        'retained_capacity_reserved'
      )
    `).run();

    const rows = getDb().prepare("SELECT lease_id FROM browser_surface_leases ORDER BY lease_id").all();
    assert.deepEqual(rows.map((row) => row.lease_id), [
      "lease_retained_reserved",
      "lease_start_failed",
      "lease_starting",
      "legacy_waiting",
    ]);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite migration preserves surface_subject_id when retained_capacity_reserved is the only missing reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-browser-surface-lease-subject-"));
  const dbPath = join(dir, "legacy.sqlite");
  const legacy = new Database(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE browser_surfaces (
        surface_id TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        profile_key TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        surface_subject_id TEXT,
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
        surface_subject_id TEXT,
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
          'starting_surface',
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
          'surface_start_failed',
          'surface_readiness_timeout',
          'incompatible_static_profile',
          'launch_precondition_failed',
          'lease_wait_timeout'
        ))
      );

      INSERT INTO browser_surface_leases(
        lease_id,
        connector_id,
        profile_key,
        surface_subject_id,
        run_id,
        status,
        priority_class,
        requested_at,
        expires_at,
        fencing_token,
        wait_reason
      )
      VALUES (
        'legacy_subject',
        'chatgpt',
        'chatgpt',
        'subject-sentinel',
        'run_legacy_subject',
        'leased',
        'owner_interactive',
        '2026-05-12T12:00:00.000Z',
        '2026-05-12T12:05:00.000Z',
        1,
        NULL
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
    assert.match(schema, /'retained_capacity_reserved'/);

    const migrated = getDb()
      .prepare("SELECT surface_subject_id, wait_reason FROM browser_surface_leases WHERE lease_id = ?")
      .get("legacy_subject");
    assert.equal(migrated.surface_subject_id, "subject-sentinel");
    assert.equal(migrated.wait_reason, null);

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
        'lease_retained_reserved_subject',
        'chatgpt',
        'chatgpt-retained',
        'run_retained_reserved_subject',
        'deferred',
        'scheduled_refresh',
        '2026-05-12T12:00:01.000Z',
        '2026-05-12T12:05:01.000Z',
        2,
        'retained_capacity_reserved'
      )
    `).run();

    const retained = getDb()
      .prepare("SELECT wait_reason FROM browser_surface_leases WHERE lease_id = ?")
      .get("lease_retained_reserved_subject");
    assert.equal(retained.wait_reason, "retained_capacity_reserved");
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
    window_settle_endpoint: "http://neko-surface-pg:9223/pdpp/window-settle",
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
    "http://neko-surface-pg:9223/pdpp/window-settle",
    "starting",
    "container_pg",
    "pdpp-neko-surface-pg",
    "/var/lib/pdpp/neko-profiles/pg-hash",
    "pdpp_neko_profile_pg_hash",
    null,
    "lease_pg",
    "2026-05-12T12:00:00.000Z",
    "2026-05-12T12:00:00.000Z",
  ]);
  assert.deepEqual(await store.getSurface("surface_dynamic_pg"), dynamicSurface);
});

test("Postgres browser_surface_leases DDL admits retained_capacity_reserved in create and startup constraint refresh", () => {
  const source = readFileSync(new URL("../server/postgres-storage.js", import.meta.url), "utf8");
  const occurrences = source.match(/'retained_capacity_reserved'/g) ?? [];
  assert.equal(occurrences.length, 2);

  const createStart = source.indexOf("CREATE TABLE IF NOT EXISTS browser_surface_leases");
  const createEnd = source.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_browser_surface_leases_one_non_terminal_run");
  assert.ok(createStart >= 0 && createEnd > createStart);
  assert.match(source.slice(createStart, createEnd), /'retained_capacity_reserved'/);

  const refreshStart = source.indexOf("ALTER TABLE browser_surface_leases");
  const refreshEnd = source.indexOf("CREATE TABLE IF NOT EXISTS scheduler_run_history");
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  assert.match(source.slice(refreshStart, refreshEnd), /'retained_capacity_reserved'/);
});

if (!POSTGRES_URL) {
  test(
    "Postgres browser-surface lease upgrade preserves surface_subject_id and admits retained_capacity_reserved (skipped: PDPP_TEST_POSTGRES_URL unset)",
    { skip: true },
    () => {},
  );
} else {
  test("Postgres browser-surface lease upgrade preserves surface_subject_id and admits retained_capacity_reserved", async () => {
    const admin = new Pool({ connectionString: POSTGRES_URL });
    try {
      await admin.query("DROP TABLE IF EXISTS browser_surface_leases");
      await admin.query("DROP TABLE IF EXISTS browser_surfaces");
      await admin.query(`
        CREATE TABLE browser_surface_leases (
          lease_id TEXT PRIMARY KEY,
          surface_id TEXT,
          connector_id TEXT NOT NULL,
          profile_key TEXT NOT NULL,
          surface_subject_id TEXT,
          account_key TEXT,
          run_id TEXT NOT NULL,
          status TEXT NOT NULL CONSTRAINT browser_surface_leases_status_check CHECK (status IN (
            'waiting_for_browser_surface',
            'starting_surface',
            'leased',
            'released',
            'expired',
            'deferred',
            'cancelled',
            'surface_failed'
          )),
          priority_class TEXT NOT NULL CHECK (priority_class IN ('owner_interactive', 'scheduled_refresh')),
          requested_at TEXT NOT NULL,
          leased_at TEXT,
          released_at TEXT,
          expires_at TEXT NOT NULL,
          fencing_token INTEGER NOT NULL,
          wait_reason TEXT CONSTRAINT browser_surface_leases_wait_reason_check CHECK (
            wait_reason IS NULL OR wait_reason IN (
              'capacity_full',
              'surface_starting',
              'surface_unhealthy',
              'surface_start_failed',
              'surface_readiness_timeout',
              'incompatible_static_profile',
              'launch_precondition_failed',
              'lease_wait_timeout'
            )
          )
        );

        INSERT INTO browser_surface_leases(
          lease_id,
          connector_id,
          profile_key,
          surface_subject_id,
          run_id,
          status,
          priority_class,
          requested_at,
          expires_at,
          fencing_token,
          wait_reason
        )
        VALUES (
          'legacy_pg_subject',
          'chatgpt',
          'chatgpt',
          'subject-sentinel',
          'run_pg_legacy_subject',
          'leased',
          'owner_interactive',
          '2026-05-12T12:00:00.000Z',
          '2026-05-12T12:05:00.000Z',
          1,
          NULL
        );
      `);

      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
      try {
        const legacyRow = (
          await postgresQuery(
            "SELECT surface_subject_id, wait_reason FROM browser_surface_leases WHERE lease_id = $1",
            ["legacy_pg_subject"],
          )
        ).rows[0];
        assert.equal(legacyRow.surface_subject_id, "subject-sentinel");
        assert.equal(legacyRow.wait_reason, null);
        const generationColumn = (
          await postgresQuery(
            `SELECT 1 FROM information_schema.columns
             WHERE table_name = 'browser_surfaces' AND column_name = 'browser_generation_hash'`,
          )
        ).rows[0];
        assert.ok(generationColumn, "Postgres upgrade adds browser_generation_hash");

        await postgresQuery(`
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
            'lease_retained_reserved_pg',
            'chatgpt',
            'chatgpt-retained',
            'run_pg_retained_reserved',
            'deferred',
            'scheduled_refresh',
            '2026-05-12T12:00:01.000Z',
            '2026-05-12T12:05:01.000Z',
            2,
            'retained_capacity_reserved'
          )
        `);

        const retainedRow = (
          await postgresQuery(
            "SELECT wait_reason FROM browser_surface_leases WHERE lease_id = $1",
            ["lease_retained_reserved_pg"],
          )
        ).rows[0];
        assert.equal(retainedRow.wait_reason, "retained_capacity_reserved");
      } finally {
        await closePostgresStorage();
      }
    } finally {
      await admin.query("DROP TABLE IF EXISTS browser_surface_leases");
      await admin.query("DROP TABLE IF EXISTS browser_surfaces");
      await admin.end();
    }
  });
}

test(
  "Postgres browser generation hash upsert preserves same-container state and clears on container replacement",
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    const store = createPostgresBrowserSurfaceLeaseStore();
    const id = `surface_generation_${Date.now()}`;
    try {
      await store.upsertSurface(surface({ surface_id: id, container_id: "pg-container-1", browser_generation_hash: "a".repeat(64) }));
      await store.upsertSurface(surface({ surface_id: id, container_id: "pg-container-1" }));
      assert.equal((await store.getSurface(id)).browser_generation_hash, "a".repeat(64));
      await store.upsertSurface(surface({ surface_id: id, container_id: "pg-container-2" }));
      assert.equal((await store.getSurface(id)).browser_generation_hash, undefined);
    } finally {
      await postgresQuery("DELETE FROM browser_surfaces WHERE surface_id = $1", [id]);
      await closePostgresStorage();
    }
  },
);

test("Postgres repair clears active surface pointers not backed by non-terminal leases", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  const store = createPostgresBrowserSurfaceLeaseStore(client);

  await store.repairStaleSurfaceActiveLeases();

  assert.match(queries[0].sql, /UPDATE browser_surfaces/);
  assert.match(queries[0].sql, /active_lease_id = NULL/);
  assert.match(queries[0].sql, /status NOT IN/);
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
