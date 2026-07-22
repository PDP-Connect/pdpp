// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    priority_class: "interactive",
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
const POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK = [482571, 150];
const POSTGRES_LEASE_PRIORITY_MIGRATION_LOCK = [482571, 151];

function runIsolatedPostgresBootstrap(databaseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { closePostgresStorage, initPostgresStorage } from './server/postgres-storage.js';
       await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });
       await closePostgresStorage();`,
    ], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PDPP_TEST_POSTGRES_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`isolated postgres bootstrap exited ${code}: ${output}`));
    });
  });
}

async function assertNoPriorityBootstrapLocks(admin) {
  const locks = await admin.query(`
    SELECT count(*)::int AS count FROM pg_locks
    WHERE locktype = 'advisory' AND classid = $1 AND objid IN ($2, $3)
  `, [
    POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK[0],
    POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK[1],
    POSTGRES_LEASE_PRIORITY_MIGRATION_LOCK[1],
  ]);
  assert.equal(locks.rows[0].count, 0, 'public bootstrap leaves no advisory locks behind');
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
    assert.match(schema, /'interactive'/);
    assert.match(schema, /'background'/);
    assert.doesNotMatch(schema, /'owner_interactive'|'scheduled_refresh'/);
    assert.equal(
      getDb().prepare("SELECT priority_class FROM browser_surface_leases WHERE lease_id = 'legacy_waiting'").get()
        .priority_class,
      'background',
    );

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
        'interactive',
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
        'interactive',
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
        'background',
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
        'background',
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

test("SQLite lease migration upgrades mixed priority rows and preserves supported dependent objects atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-browser-surface-lease-mixed-"));
  const dbPath = join(dir, "legacy.sqlite");
  const legacy = new Database(dbPath);
  try {
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE browser_surfaces (
        surface_id TEXT PRIMARY KEY, backend TEXT NOT NULL, profile_key TEXT NOT NULL,
        connector_id TEXT NOT NULL, cdp_url TEXT NOT NULL, stream_base_url TEXT NOT NULL,
        health TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL,
        active_lease_id TEXT
      );
      INSERT INTO browser_surfaces VALUES ('surface_mixed', 'neko', 'chatgpt', 'chatgpt', 'http://neko:9222', 'http://neko:8080', 'ready', '2026-05-12T12:00:00Z', '2026-05-12T12:00:00Z', NULL);
      CREATE TABLE browser_surface_leases (
        lease_id TEXT PRIMARY KEY,
        surface_id TEXT REFERENCES browser_surfaces(surface_id),
        connector_id TEXT NOT NULL,
        profile_key TEXT NOT NULL,
        account_key TEXT,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('waiting_for_browser_surface', 'leased', 'released', 'expired', 'deferred', 'cancelled', 'surface_failed')),
        priority_class TEXT NOT NULL CHECK (priority_class IN ('owner_interactive', 'scheduled_refresh', 'interactive', 'background')),
        requested_at TEXT NOT NULL,
        leased_at TEXT,
        released_at TEXT,
        expires_at TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        wait_reason TEXT CHECK (wait_reason IS NULL OR wait_reason IN ('capacity_full', 'surface_starting', 'surface_unhealthy', 'surface_start_failed', 'surface_readiness_timeout', 'incompatible_static_profile', 'launch_precondition_failed', 'lease_wait_timeout')),
        migration_sentinel TEXT NOT NULL DEFAULT 'kept'
      );
      CREATE INDEX custom_lease_sentinel_idx ON browser_surface_leases(migration_sentinel);
      CREATE TABLE lease_audit (lease_id TEXT NOT NULL);
      CREATE TRIGGER custom_lease_audit AFTER INSERT ON browser_surface_leases
        BEGIN INSERT INTO lease_audit VALUES (NEW.lease_id); END;
      CREATE TABLE lease_refs (lease_id TEXT REFERENCES browser_surface_leases(lease_id));
      INSERT INTO browser_surface_leases(lease_id, surface_id, connector_id, profile_key, run_id, status, priority_class, requested_at, expires_at, fencing_token, migration_sentinel)
        VALUES ('legacy_owner', 'surface_mixed', 'chatgpt', 'chatgpt', 'run_owner', 'leased', 'owner_interactive', '2026-05-12T12:00:00Z', '2026-05-12T12:05:00Z', 1, 'sentinel');
      INSERT INTO browser_surface_leases(lease_id, surface_id, connector_id, profile_key, run_id, status, priority_class, requested_at, expires_at, fencing_token)
        VALUES ('already_current', NULL, 'chatgpt', 'chatgpt', 'run_current', 'leased', 'background', '2026-05-12T12:00:01Z', '2026-05-12T12:05:01Z', 2);
      INSERT INTO lease_refs VALUES ('legacy_owner');
    `);
  } finally {
    legacy.close();
  }
  try {
    initDb(dbPath);
    assert.deepEqual(getDb().prepare("SELECT lease_id, priority_class, migration_sentinel FROM browser_surface_leases ORDER BY lease_id").all(), [
      { lease_id: 'already_current', priority_class: 'background', migration_sentinel: 'kept' },
      { lease_id: 'legacy_owner', priority_class: 'interactive', migration_sentinel: 'sentinel' },
    ]);
    assert.ok(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'custom_lease_sentinel_idx'").get());
    assert.ok(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_lease_audit'").get());
    assert.equal(getDb().prepare('PRAGMA foreign_key_check').all().length, 0);
    getDb().prepare(`INSERT INTO browser_surface_leases(lease_id, connector_id, profile_key, run_id, status, priority_class, requested_at, expires_at, fencing_token)
      VALUES ('triggered', 'chatgpt', 'chatgpt', 'run_triggered', 'leased', 'interactive', '2026-05-12T12:00:02Z', '2026-05-12T12:05:02Z', 3)`).run();
    assert.deepEqual(getDb().prepare("SELECT lease_id FROM lease_audit WHERE lease_id = 'triggered'").all(), [{ lease_id: 'triggered' }]);
    closeDb();
    initDb(dbPath);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM browser_surface_leases WHERE priority_class IN ('owner_interactive', 'scheduled_refresh')").get().count, 0);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite lease migration fails closed for an unsupported priority constraint", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-browser-surface-lease-unknown-"));
  const dbPath = join(dir, "legacy.sqlite");
  const legacy = new Database(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE browser_surface_leases (
        lease_id TEXT PRIMARY KEY, surface_id TEXT, connector_id TEXT NOT NULL, profile_key TEXT NOT NULL,
        account_key TEXT, run_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('waiting_for_browser_surface', 'starting_surface', 'leased', 'released', 'expired', 'deferred', 'cancelled', 'surface_failed')),
        priority_class TEXT NOT NULL CHECK (priority_class IN ('owner_interactive', 'scheduled_refresh', 'emergency')),
        requested_at TEXT NOT NULL, leased_at TEXT, released_at TEXT, expires_at TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        wait_reason TEXT CHECK (wait_reason IS NULL OR wait_reason IN ('capacity_full', 'surface_starting', 'surface_unhealthy', 'surface_start_failed', 'surface_readiness_timeout', 'incompatible_static_profile', 'launch_precondition_failed', 'lease_wait_timeout', 'retained_capacity_reserved'))
      );
      INSERT INTO browser_surface_leases VALUES ('unsupported', NULL, 'chatgpt', 'chatgpt', NULL, 'run', 'leased', 'emergency', '2026-05-12T12:00:00Z', NULL, NULL, '2026-05-12T12:05:00Z', 1, NULL);
    `);
  } finally {
    legacy.close();
  }
  try {
    assert.throws(() => initDb(dbPath), /Unsupported browser_surface_leases priority_class CHECK shape/);
    const verify = new Database(dbPath);
    try {
      assert.equal(verify.prepare("SELECT priority_class FROM browser_surface_leases WHERE lease_id = 'unsupported'").get().priority_class, 'emergency');
      assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('browser_surface_leases') WHERE name = 'surface_subject_id'").get().count, 0);
    } finally {
      verify.close();
    }
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

test("Postgres browser_surface_leases DDL admits retained_capacity_reserved without broad priority-check discovery", () => {
  const source = readFileSync(new URL("../server/postgres-storage.js", import.meta.url), "utf8");
  const occurrences = source.match(/'retained_capacity_reserved'/g) ?? [];
  assert.equal(occurrences.length, 3);

  const createStart = source.indexOf("CREATE TABLE IF NOT EXISTS browser_surface_leases");
  const createEnd = source.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_browser_surface_leases_one_non_terminal_run");
  assert.ok(createStart >= 0 && createEnd > createStart);
  assert.match(source.slice(createStart, createEnd), /'retained_capacity_reserved'/);

  assert.doesNotMatch(source, /pg_get_constraintdef\(oid\) LIKE '%priority_class%'/);
  assert.match(source, /Unsupported browser_surface_leases priority CHECK shape/);
});

test(
  "Postgres simultaneous empty public bootstraps use polling without concurrent-index deadlock",
  { skip: !POSTGRES_URL },
  async () => {
    const admin = new Pool({ connectionString: POSTGRES_URL });
    try {
      await closePostgresStorage();
      await admin.query('DROP SCHEMA public CASCADE');
      await admin.query('CREATE SCHEMA public');
      await Promise.all([runIsolatedPostgresBootstrap(POSTGRES_URL), runIsolatedPostgresBootstrap(POSTGRES_URL)]);

      const canonical = await admin.query(`
        SELECT
          to_regclass('public.browser_surface_leases') AS leases,
          to_regclass('public.lexical_search_index') AS lexical,
          (SELECT count(*)::int FROM pg_constraint
             WHERE conrelid = 'browser_surface_leases'::regclass
               AND conname = 'browser_surface_leases_priority_class_check') AS priority_checks,
          (SELECT indisvalid FROM pg_index
             WHERE indexrelid = 'idx_pg_lexical_search_scope_document'::regclass) AS lexical_index_valid
      `);
      assert.deepEqual(canonical.rows[0], {
        leases: 'browser_surface_leases',
        lexical: 'lexical_search_index',
        priority_checks: 1,
        lexical_index_valid: true,
      });
      await assertNoPriorityBootstrapLocks(admin);
    } finally {
      await closePostgresStorage();
      await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
      await admin.query('CREATE SCHEMA IF NOT EXISTS public');
      await admin.end();
    }
  },
);

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
          priority_class TEXT NOT NULL CONSTRAINT legacy_priority_class_check CHECK (
            priority_class IN ('owner_interactive', 'scheduled_refresh')
          ),
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

        INSERT INTO browser_surface_leases(
          lease_id, connector_id, profile_key, surface_subject_id, run_id, status,
          priority_class, requested_at, expires_at, fencing_token
        ) VALUES (
          'legacy_pg_background', 'chatgpt', 'chatgpt', 'subject-sentinel',
          'run_pg_legacy_background', 'leased', 'scheduled_refresh',
          '2026-05-12T12:00:01.000Z', '2026-05-12T12:05:01.000Z', 2
        );

        ALTER TABLE browser_surface_leases
          ADD CONSTRAINT preserve_priority_status_invariant
          CHECK (priority_class IS NOT NULL AND status IS NOT NULL);
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
        assert.equal(
          (await postgresQuery("SELECT priority_class FROM browser_surface_leases WHERE lease_id = $1", ["legacy_pg_subject"])).rows[0]
            .priority_class,
          "interactive",
        );
        assert.equal(
          (await postgresQuery("SELECT priority_class FROM browser_surface_leases WHERE lease_id = $1", ["legacy_pg_background"])).rows[0]
            .priority_class,
          "background",
        );
        const preservedConstraint = await postgresQuery(`
          SELECT oid FROM pg_constraint
          WHERE conrelid = 'browser_surface_leases'::regclass
            AND conname = 'preserve_priority_status_invariant'
        `);
        assert.equal(preservedConstraint.rowCount, 1, 'unrelated compound priority check is retained');
        const priorityConstraint = await postgresQuery(`
          SELECT oid FROM pg_constraint
          WHERE conrelid = 'browser_surface_leases'::regclass
            AND conname = 'browser_surface_leases_priority_class_check'
        `);
        assert.equal(priorityConstraint.rowCount, 1);
        const priorityOid = priorityConstraint.rows[0].oid;
        await admin.query(`
          CREATE TABLE priority_migration_ddl_events (
            command_tag TEXT NOT NULL,
            object_identity TEXT NOT NULL
          );
          CREATE OR REPLACE FUNCTION capture_priority_migration_ddl()
          RETURNS event_trigger AS $$
          BEGIN
            INSERT INTO priority_migration_ddl_events(command_tag, object_identity)
            SELECT command_tag, object_identity FROM pg_event_trigger_ddl_commands();
          END;
          $$ LANGUAGE plpgsql;
          CREATE EVENT TRIGGER capture_priority_migration_ddl
            ON ddl_command_end EXECUTE FUNCTION capture_priority_migration_ddl();
        `);
        await closePostgresStorage();
        await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
        assert.equal(
          (await postgresQuery(`
            SELECT oid FROM pg_constraint
            WHERE conrelid = 'browser_surface_leases'::regclass
              AND conname = 'browser_surface_leases_priority_class_check'
          `)).rows[0].oid,
          priorityOid,
          'a current priority schema is a priority-DDL no-op on the second boot',
        );
        assert.equal(
          (await admin.query(`
            SELECT count(*)::int AS count FROM priority_migration_ddl_events
            WHERE command_tag = 'ALTER TABLE' AND object_identity = 'public.browser_surface_leases'
          `)).rows[0].count,
          0,
          'a current priority schema takes no priority ALTER TABLE DDL path on the second boot',
        );
        await admin.query('DROP EVENT TRIGGER capture_priority_migration_ddl');
        await admin.query('DROP FUNCTION capture_priority_migration_ddl()');
        await admin.query('DROP TABLE priority_migration_ddl_events');
        await assert.rejects(
          postgresQuery(`
            INSERT INTO browser_surface_leases(
              lease_id, connector_id, profile_key, run_id, status, priority_class,
              requested_at, expires_at, fencing_token
            ) VALUES (
              'legacy_value_rejected', 'chatgpt', 'chatgpt', 'run_rejected', 'leased',
              'scheduled_refresh', '2026-05-12T12:00:02.000Z', '2026-05-12T12:05:02.000Z', 3
            )
          `),
          /check constraint/i,
        );
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
            'background',
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
  "Postgres simultaneous legacy boots serialize priority migration before catalog discovery",
  { skip: !POSTGRES_URL },
  async () => {
    const admin = new Pool({ connectionString: POSTGRES_URL });
    try {
      // Start from a fully bootstrapped schema so this exercise isolates the
      // historical priority migration through public initializers, rather than
      // inventing a partial bootstrap shape.
      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
      await closePostgresStorage();
      await admin.query(`
        ALTER TABLE browser_surface_leases
          DROP CONSTRAINT browser_surface_leases_priority_class_check;
        ALTER TABLE browser_surface_leases
          ADD CONSTRAINT legacy_priority_class_check
          CHECK (priority_class IN ('owner_interactive', 'scheduled_refresh'));
        INSERT INTO browser_surface_leases(
          lease_id, connector_id, profile_key, run_id, status, priority_class,
          requested_at, expires_at, fencing_token
        ) VALUES
          ('concurrent_legacy_owner', 'chatgpt', 'chatgpt', 'run_concurrent_owner', 'released', 'owner_interactive', '2026-05-12T12:00:00Z', '2026-05-12T12:05:00Z', 1),
          ('concurrent_legacy_background', 'chatgpt', 'chatgpt', 'run_concurrent_background', 'released', 'scheduled_refresh', '2026-05-12T12:00:01Z', '2026-05-12T12:05:01Z', 2);
      `);

      await Promise.all([runIsolatedPostgresBootstrap(POSTGRES_URL), runIsolatedPostgresBootstrap(POSTGRES_URL)]);

      assert.deepEqual(
        (await admin.query(`
          SELECT priority_class FROM browser_surface_leases
          WHERE lease_id IN ('concurrent_legacy_owner', 'concurrent_legacy_background')
          ORDER BY lease_id
        `)).rows.map((row) => row.priority_class),
        ['background', 'interactive'],
      );
      const priorityConstraints = await admin.query(`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'browser_surface_leases'::regclass AND contype = 'c'
      `);
      const exactCurrent = priorityConstraints.rows.filter((constraint) => (
        constraint.conname === 'browser_surface_leases_priority_class_check'
        && constraint.definition.includes("'interactive'::text")
        && constraint.definition.includes("'background'::text")
      ));
      assert.equal(exactCurrent.length, 1, 'concurrent starters leave one exact current priority constraint');
      await assertNoPriorityBootstrapLocks(admin);
    } finally {
      await closePostgresStorage();
      await admin.query("DROP TABLE IF EXISTS browser_surface_leases");
      await admin.query("DROP TABLE IF EXISTS browser_surfaces");
      await admin.end();
    }
  },
);

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
      priority_class: "background",
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
            "background",
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
      priority_class: "background",
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
            "interactive",
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
            "background",
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
