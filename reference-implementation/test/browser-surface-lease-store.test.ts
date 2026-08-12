// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
import type { BrowserSurfaceLease } from "@opendatalabs/remote-surface/leases";
// biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
import Database from "better-sqlite3";
import { Pool } from "pg";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  type BrowserSurfaceLeaseStore,
  type BrowserSurfaceWithPersistenceMetadata,
  browserSurfaceConnectionIdentityKey,
  createPostgresBrowserSurfaceLeaseStore,
  createSqliteBrowserSurfaceLeaseStore,
} from "../server/stores/browser-surface-lease-store.ts";

const POSTGRES_SCOPED_IDENTITY_PREDICATE =
  /WHERE \(connector_id = \$1 AND profile_key = \$2 AND surface_subject_id IS NOT DISTINCT FROM \$3\)/;
const UNFILTERED_BROWSER_SURFACE_QUERY = /SELECT \* FROM browser_(surface_leases|surfaces) ORDER BY/;
const OVER_CAP_CONNECTION_IDENTITIES = /at most 25 connection identities/;
const INDUCED_POSTGRES_SCOPED_FIXTURE_FAILURE = /induced Postgres scoped-fixture setup failure/;

function surface(
  overrides: Partial<BrowserSurfaceWithPersistenceMetadata> = {}
): BrowserSurfaceWithPersistenceMetadata {
  return {
    backend: "neko",
    cdp_url: "http://neko:9222",
    connector_id: "chatgpt",
    created_at: "2026-05-12T12:00:00.000Z",
    health: "ready",
    last_used_at: "2026-05-12T12:00:00.000Z",
    profile_key: "chatgpt",
    stream_base_url: "http://neko:8080",
    surface_id: "surface_1",
    ...overrides,
  };
}

type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

function omitUndefined<T extends object>(value: Overrides<T>): T {
  const result = {} as T;
  for (const key of Object.keys(value) as (keyof T)[]) {
    const propertyValue = value[key];
    if (propertyValue !== undefined) {
      result[key] = propertyValue;
    }
  }
  return result;
}

function lease(overrides: Overrides<BrowserSurfaceLease> = {}): BrowserSurfaceLease {
  const defaults: BrowserSurfaceLease = {
    connector_id: "chatgpt",
    expires_at: "2026-05-12T12:05:01.000Z",
    fencing_token: 1,
    lease_id: "lease_1",
    leased_at: "2026-05-12T12:00:02.000Z",
    priority_class: "interactive",
    profile_key: "chatgpt",
    requested_at: "2026-05-12T12:00:01.000Z",
    run_id: "run_1",
    status: "leased",
    surface_id: "surface_1",
  };
  return omitUndefined<BrowserSurfaceLease>({ ...defaults, ...overrides });
}

function mustExist<T>(value: T | null, description: string): T {
  assert.ok(value, description);
  return value;
}

function mustRow<T>(value: T | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

function matchesIdentity(
  row: { readonly connector_id: string; readonly profile_key: string; readonly surface_subject_id?: string },
  identity: { readonly connector_id: string; readonly profile_key: string; readonly surface_subject_id: string | null }
): boolean {
  return (
    row.connector_id === identity.connector_id &&
    row.profile_key === identity.profile_key &&
    (row.surface_subject_id ?? null) === identity.surface_subject_id
  );
}

function identityKeyForRow(row: {
  readonly connector_id: string;
  readonly profile_key: string;
  readonly surface_subject_id?: string;
}): string {
  return browserSurfaceConnectionIdentityKey({
    connector_id: row.connector_id,
    profile_key: row.profile_key,
    surface_subject_id: row.surface_subject_id ?? null,
  });
}

function typedDb(): Database.Database {
  return getDb() as object as Database.Database;
}

function setup() {
  initDb();
  return createSqliteBrowserSurfaceLeaseStore();
}

function teardown() {
  closeDb();
}

async function assertProfileProvenanceCompatibility(
  store: Pick<BrowserSurfaceLeaseStore, "getSurface" | "upsertSurface">,
  surfaceId: string
): Promise<void> {
  await store.upsertSurface(
    surface({
      profile_dir: "/var/lib/pdpp/neko-profiles/connection-a",
      profile_key: "connection-a",
      profile_volume: "neko-profile-connection-a",
      surface_id: surfaceId,
    })
  );
  await store.upsertSurface(surface({ health: "unhealthy", profile_key: "connection-b", surface_id: surfaceId }));
  const cleared = mustExist(await store.getSurface(surfaceId), "changed-key surface exists");
  assert.equal(cleared.profile_key, "connection-b");
  assert.equal(cleared.profile_dir, undefined, "a changed profile key cannot retain the old profile path");
  assert.equal(cleared.profile_volume, undefined, "a changed profile key cannot retain the old profile volume");

  await store.upsertSurface(
    surface({
      health: "unhealthy",
      profile_dir: "/var/lib/pdpp/neko-profiles/connection-b-partial",
      profile_key: "connection-b-partial",
      surface_id: surfaceId,
    })
  );
  const partial = mustExist(await store.getSurface(surfaceId), "partial replacement surface exists");
  assert.equal(partial.profile_dir, undefined, "a changed key needs a complete replacement provenance pair");
  assert.equal(partial.profile_volume, undefined, "partial replacement provenance cannot cross-bind volume");

  await store.upsertSurface(
    surface({
      profile_dir: "/var/lib/pdpp/neko-profiles/connection-c",
      profile_key: "connection-c",
      profile_volume: "neko-profile-connection-c",
      surface_id: surfaceId,
    })
  );
  const replaced = mustExist(await store.getSurface(surfaceId), "explicit replacement surface exists");
  assert.equal(replaced.profile_key, "connection-c");
  assert.equal(replaced.profile_dir, "/var/lib/pdpp/neko-profiles/connection-c");
  assert.equal(replaced.profile_volume, "neko-profile-connection-c");
}

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK = [482_571, 150];
const POSTGRES_LEASE_PRIORITY_MIGRATION_LOCK = [482_571, 151];

function runIsolatedPostgresBootstrap(databaseUrl: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { closePostgresStorage, initPostgresStorage } from './server/postgres-storage.ts';
       await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });
       await closePostgresStorage();`,
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, PDPP_TEST_POSTGRES_URL: databaseUrl },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`isolated postgres bootstrap exited ${code}: ${output}`));
      }
    });
  });
}

async function assertNoPriorityBootstrapLocks(admin: Pool) {
  const locks = await admin.query(
    `
    SELECT count(*)::int AS count FROM pg_locks
    WHERE locktype = 'advisory' AND classid = $1 AND objid IN ($2, $3)
  `,
    [
      POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK[0],
      POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK[1],
      POSTGRES_LEASE_PRIORITY_MIGRATION_LOCK[1],
    ]
  );
  assert.equal(locks.rows[0].count, 0, "public bootstrap leaves no advisory locks behind");
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

test("SQLite scoped browser-surface reads match filtered global rows for 0, 1, and 25 identities", async () => {
  const store = setup();
  try {
    const identities = Array.from({ length: 25 }, (_, index) => ({
      connector_id: "shared_connector",
      profile_key: "shared_profile",
      surface_subject_id: `subject_${String(index).padStart(2, "0")}`,
    }));
    await Promise.all(
      identities.flatMap((identity, index) => [
        store.upsertSurface(
          surface({
            connector_id: identity.connector_id,
            profile_key: identity.profile_key,
            surface_id: `surface_${index}`,
            surface_subject_id: identity.surface_subject_id,
          })
        ),
        store.upsertLease(
          lease({
            connector_id: identity.connector_id,
            lease_id: `lease_${index}`,
            profile_key: identity.profile_key,
            run_id: `run_${index}`,
            surface_id: `surface_${index}`,
            surface_subject_id: identity.surface_subject_id,
          })
        ),
      ])
    );
    const cases = [[], identities.slice(0, 1), identities] as const;
    const [globalLeases, globalNonTerminalLeases, globalSurfaces, batches] = await Promise.all([
      store.listLeases(),
      store.listNonTerminalLeases(),
      store.listSurfaces(),
      Promise.all(cases.map((requested) => store.readForConnectionIdentities(requested))),
    ]);
    for (const [caseIndex, requested] of cases.entries()) {
      const batch = mustRow(batches[caseIndex], `scope ${caseIndex} has a batch result`);
      assert.equal(batch.size, requested.length, "every requested identity remains explicit");
      for (const identity of requested) {
        const key = browserSurfaceConnectionIdentityKey(identity);
        const rows = mustRow(batch.get(key), `requested identity ${key} is explicit`);
        assert.deepEqual(
          rows.leases,
          globalLeases.filter((row) => matchesIdentity(row, identity))
        );
        assert.deepEqual(
          rows.non_terminal_leases,
          globalNonTerminalLeases.filter((row) => matchesIdentity(row, identity))
        );
        assert.deepEqual(
          rows.surfaces,
          globalSurfaces.filter((row) => matchesIdentity(row, identity))
        );
      }
    }
    const missing = { connector_id: "missing_connector", profile_key: "missing_profile", surface_subject_id: null };
    const missingRows = mustRow(
      (await store.readForConnectionIdentities([missing])).get(browserSurfaceConnectionIdentityKey(missing)),
      "missing identity remains explicit"
    );
    assert.deepEqual(missingRows, { identity: missing, leases: [], non_terminal_leases: [], surfaces: [] });
    assert.throws(
      () =>
        store.readForConnectionIdentities([
          ...identities,
          { connector_id: "overflow", profile_key: "overflow", surface_subject_id: "overflow" },
        ]),
      OVER_CAP_CONNECTION_IDENTITIES
    );
  } finally {
    teardown();
  }
});

test("Postgres scoped browser-surface reads use two bounded identity queries and never global lists", async () => {
  const calls: { params: unknown[]; sql: string }[] = [];
  const identities = Array.from({ length: 25 }, (_, index) => ({
    connector_id: "shared_connector",
    profile_key: "shared_profile",
    surface_subject_id: `subject_${index}`,
  }));
  const leases = identities.map((identity, index) =>
    lease({
      connector_id: identity.connector_id,
      lease_id: `lease_${index}`,
      profile_key: identity.profile_key,
      run_id: `run_${index}`,
      surface_id: `surface_${index}`,
      surface_subject_id: identity.surface_subject_id,
    })
  );
  const surfaces = identities.map((identity, index) =>
    surface({
      connector_id: identity.connector_id,
      profile_key: identity.profile_key,
      surface_id: `surface_${index}`,
      surface_subject_id: identity.surface_subject_id,
    })
  );
  const store = createPostgresBrowserSurfaceLeaseStore({
    // biome-ignore lint/suspicious/useAwait: async test double preserves the store dependency contract.
    async query(sql: string, params: unknown[] = []) {
      calls.push({ params, sql });
      assert.match(sql, POSTGRES_SCOPED_IDENTITY_PREDICATE);
      assert.doesNotMatch(sql, UNFILTERED_BROWSER_SURFACE_QUERY);
      const keys = new Set(
        Array.from({ length: params.length / 3 }, (_, index) =>
          browserSurfaceConnectionIdentityKey({
            connector_id: String(params[index * 3]),
            profile_key: String(params[index * 3 + 1]),
            surface_subject_id: (params[index * 3 + 2] as string | null) ?? null,
          })
        )
      );
      const rows = sql.includes("browser_surface_leases") ? leases : surfaces;
      return {
        rows: rows.filter((row) => keys.has(identityKeyForRow(row))) as never,
      };
    },
  });

  assert.equal((await store.readForConnectionIdentities([])).size, 0);
  assert.equal(calls.length, 0, "empty scope makes no database query");
  const firstIdentity = mustRow(identities[0], "first identity");
  const firstLease = mustRow(leases[0], "first lease");
  const firstSurface = mustRow(surfaces[0], "first surface");
  const one = await store.readForConnectionIdentities([firstIdentity]);
  assert.equal(one.size, 1);
  assert.equal(calls.length, 2, "one leases query and one surfaces query for one identity");
  assert.deepEqual(calls[0]?.params, ["shared_connector", "shared_profile", "subject_0"]);
  assert.deepEqual(mustRow(one.get(browserSurfaceConnectionIdentityKey(firstIdentity)), "one identity result"), {
    identity: firstIdentity,
    leases: [firstLease],
    non_terminal_leases: [firstLease],
    surfaces: [firstSurface],
  });
  calls.length = 0;

  const all = await store.readForConnectionIdentities(identities);
  const lastIdentity = mustRow(identities[24], "25th identity");
  const lastLease = mustRow(leases[24], "25th lease");
  const lastSurface = mustRow(surfaces[24], "25th surface");
  assert.equal(all.size, 25);
  assert.equal(calls.length, 2, "one leases query and one surfaces query for 25 identities");
  assert.equal(mustRow(calls[0], "leases query").params.length, 75);
  assert.equal(mustRow(calls[1], "surfaces query").params.length, 75);
  assert.deepEqual(mustRow(all.get(browserSurfaceConnectionIdentityKey(lastIdentity)), "25th identity result"), {
    identity: lastIdentity,
    leases: [lastLease],
    non_terminal_leases: [lastLease],
    surfaces: [lastSurface],
  });
});

interface PostgresScopedFixtureIdentity {
  readonly connector_id: string;
  readonly profile_key: string;
  readonly surface_subject_id: string;
}

async function assertNoPostgresScopedFixtureRows(connectorId: string): Promise<void> {
  const [leases, surfaces] = await Promise.all([
    postgresQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM browser_surface_leases WHERE connector_id = $1",
      [connectorId]
    ),
    postgresQuery<{ count: number }>("SELECT count(*)::int AS count FROM browser_surfaces WHERE connector_id = $1", [
      connectorId,
    ]),
  ]);
  assert.equal(Number(leases.rows[0]?.count ?? -1), 0, "fixture cleanup leaves no browser-surface leases");
  assert.equal(Number(surfaces.rows[0]?.count ?? -1), 0, "fixture cleanup leaves no browser surfaces");
}

async function cleanupPostgresScopedFixture(connectorId: string): Promise<void> {
  await postgresQuery("DELETE FROM browser_surface_leases WHERE connector_id = $1", [connectorId]);
  await postgresQuery("DELETE FROM browser_surfaces WHERE connector_id = $1", [connectorId]);
  await assertNoPostgresScopedFixtureRows(connectorId);
}

async function withPostgresScopedFixture<T>(
  input: {
    readonly fail_after_surface_index?: number;
    readonly identities: readonly PostgresScopedFixtureIdentity[];
    readonly run_prefix: string;
    readonly store: BrowserSurfaceLeaseStore;
  },
  body: () => Promise<T>
): Promise<T> {
  const connectorId = input.identities[0]?.connector_id;
  assert.ok(connectorId, "Postgres fixture requires at least one identity");
  try {
    for (const [index, identity] of input.identities.entries()) {
      const surfaceId = `${input.run_prefix}_surface_${index}`;
      // biome-ignore lint/performance/noAwaitInLoops: each surface must commit before its FK-linked lease.
      await input.store.upsertSurface(
        surface({
          connector_id: identity.connector_id,
          profile_key: identity.profile_key,
          surface_id: surfaceId,
          surface_subject_id: identity.surface_subject_id,
        })
      );
      if (index === input.fail_after_surface_index) {
        throw new Error("induced Postgres scoped-fixture setup failure");
      }
      await input.store.upsertLease(
        lease({
          connector_id: identity.connector_id,
          lease_id: `${input.run_prefix}_lease_${index}`,
          profile_key: identity.profile_key,
          run_id: `${input.run_prefix}_run_${index}`,
          surface_id: surfaceId,
          surface_subject_id: identity.surface_subject_id,
        })
      );
    }
    return await body();
  } finally {
    await cleanupPostgresScopedFixture(connectorId);
  }
}

test("Postgres scoped browser-surface reads match filtered global rows for 0, 1, and 25 identities", {
  skip: !POSTGRES_URL,
}, async () => {
  const databaseUrl = mustExist(POSTGRES_URL ?? null, "PDPP_TEST_POSTGRES_URL is set (test is skipped otherwise)");
  const runPrefix = `scoped_observation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const connectorId = `${runPrefix}_connector`;
  const profileKey = `${runPrefix}_profile`;
  const identities = Array.from({ length: 25 }, (_, index) => ({
    connector_id: connectorId,
    profile_key: profileKey,
    surface_subject_id: `${runPrefix}_subject_${index}`,
  }));
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const store = createPostgresBrowserSurfaceLeaseStore();
  try {
    await withPostgresScopedFixture({ identities, run_prefix: runPrefix, store }, async () => {
      const cases = [[], identities.slice(0, 1), identities] as const;
      const [globalLeases, globalNonTerminalLeases, globalSurfaces, batches] = await Promise.all([
        store.listLeases(),
        store.listNonTerminalLeases(),
        store.listSurfaces(),
        Promise.all(cases.map((requested) => store.readForConnectionIdentities(requested))),
      ]);
      for (const [caseIndex, requested] of cases.entries()) {
        const batch = mustRow(batches[caseIndex], `Postgres scope ${caseIndex} has a batch result`);
        assert.equal(batch.size, requested.length);
        for (const identity of requested) {
          const rows = mustRow(batch.get(browserSurfaceConnectionIdentityKey(identity)), "Postgres identity result");
          assert.deepEqual(
            rows.leases,
            globalLeases.filter((row) => matchesIdentity(row, identity))
          );
          assert.deepEqual(
            rows.non_terminal_leases,
            globalNonTerminalLeases.filter((row) => matchesIdentity(row, identity))
          );
          assert.deepEqual(
            rows.surfaces,
            globalSurfaces.filter((row) => matchesIdentity(row, identity))
          );
        }
      }
    });
    const failedRunPrefix = `${runPrefix}_failed_setup`;
    const failedConnectorId = `${failedRunPrefix}_connector`;
    await assert.rejects(
      withPostgresScopedFixture(
        {
          fail_after_surface_index: 1,
          identities: identities.slice(0, 3).map((identity) => ({ ...identity, connector_id: failedConnectorId })),
          run_prefix: failedRunPrefix,
          store,
        },
        async () => assert.fail("induced fixture setup failure must prevent the test body")
      ),
      INDUCED_POSTGRES_SCOPED_FIXTURE_FAILURE
    );
    await assertNoPostgresScopedFixtureRows(failedConnectorId);
  } finally {
    await closePostgresStorage();
  }
});

test("preserves a durable browser generation hash across ordinary SQLite surface upserts", async () => {
  const store = setup();
  try {
    const observedHash = "a".repeat(64);
    await store.upsertSurface(surface({ browser_generation_hash: observedHash, container_id: "container-1" }));
    await store.upsertSurface(surface({ container_id: "container-1", last_used_at: "2026-05-12T12:01:00.000Z" }));

    assert.equal(
      mustExist(await store.getSurface("surface_1"), "surface_1 exists").browser_generation_hash,
      observedHash
    );
    await store.updateBrowserGenerationHash("surface_1", "b".repeat(64));
    assert.equal(
      mustExist(await store.getSurface("surface_1"), "surface_1 exists").browser_generation_hash,
      "b".repeat(64)
    );
    await store.upsertSurface(surface({ container_id: "container-2" }));
    assert.equal(mustExist(await store.getSurface("surface_1"), "surface_1 exists").browser_generation_hash, undefined);
  } finally {
    teardown();
  }
});

test("persists terminal deferred retained leases with retained_capacity_reserved and excludes them from non-terminal listings", async () => {
  const store = setup();
  try {
    const deferredLease = lease({
      lease_id: "lease_retained_deferred",
      leased_at: undefined,
      released_at: "2026-05-12T12:01:00.000Z",
      run_id: "run_retained_deferred",
      status: "deferred",
      surface_id: undefined,
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
      account_key: "owner@example.com",
      active_lease_id: "lease_starting",
      cdp_url: "http://allocator.local/surfaces/surface_dynamic_1/cdp",
      container_id: "container_123",
      container_name: "pdpp-neko-surface-dynamic-1",
      health: "starting",
      profile_dir: "/var/lib/pdpp/neko-profiles/chatgpt-hash",
      profile_key: "https://registry.pdpp.dev/connectors/chatgpt",
      profile_volume: "pdpp_neko_profile_chatgpt_hash",
      stream_base_url: "http://reference.test/_ref/browser-surfaces/surface_dynamic_1",
      stream_origin: "http://neko-surface-dynamic-1:8080",
      surface_id: "surface_dynamic_1",
      surface_mode: "dynamic",
      surface_source: "allocator",
      window_settle_endpoint: "http://allocator.local/pdpp/window-settle",
    });
    const startingLease = lease({
      account_key: "owner@example.com",
      lease_id: "lease_starting",
      leased_at: undefined,
      profile_key: "https://registry.pdpp.dev/connectors/chatgpt",
      run_id: "run_starting",
      status: "starting_surface",
      surface_id: "surface_dynamic_1",
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

test("persists and retains allocator profile-path provenance across surface health updates", async () => {
  const store = setup();
  try {
    const allocated = surface({
      allocator_metadata: { profile_path: "/var/lib/pdpp/neko-profiles/chatgpt-connection" },
      container_id: "container_profile_provenance",
      profile_volume: "neko-profile-chatgpt-connection",
      surface_id: "surface_profile_provenance",
    });
    await store.upsertSurface(allocated);
    assert.equal(
      (await store.getSurface(allocated.surface_id))?.profile_dir,
      "/var/lib/pdpp/neko-profiles/chatgpt-connection"
    );

    const { allocator_metadata: _allocatorMetadata, ...healthUpdate } = allocated;
    await store.upsertSurface({ ...healthUpdate, health: "unhealthy" });
    assert.equal(
      (await store.getSurface(allocated.surface_id))?.profile_dir,
      "/var/lib/pdpp/neko-profiles/chatgpt-connection",
      "health reconciliation must not erase durable profile provenance"
    );
    assert.equal(
      (await store.getSurface(allocated.surface_id))?.profile_volume,
      "neko-profile-chatgpt-connection",
      "same-key health reconciliation must retain profile volume with its path"
    );
  } finally {
    teardown();
  }
});

test("SQLite clears stale profile provenance on a profile-key change and accepts an explicit replacement", async () => {
  const store = setup();
  try {
    await assertProfileProvenanceCompatibility(store, "surface_profile_compatibility_sqlite");
  } finally {
    teardown();
  }
});

test("SQLite repair clears active surface pointers whose leases are terminal or missing", async () => {
  const store = setup();
  try {
    const activeSurface = surface({
      active_lease_id: "lease_active",
      surface_id: "surface_active",
    });
    const releasedSurface = surface({
      active_lease_id: "lease_released",
      surface_id: "surface_released",
    });
    const missingSurface = surface({
      active_lease_id: "lease_missing",
      surface_id: "surface_missing",
    });
    await store.upsertSurface(activeSurface);
    await store.upsertSurface(releasedSurface);
    await store.upsertSurface(missingSurface);
    await store.upsertLease(lease({ lease_id: "lease_active", surface_id: "surface_active" }));
    await store.upsertLease(
      lease({
        lease_id: "lease_released",
        released_at: "2026-05-12T12:01:00.000Z",
        status: "released",
        surface_id: "surface_released",
      })
    );

    await store.repairStaleSurfaceActiveLeases();

    assert.equal(
      mustExist(await store.getSurface("surface_active"), "surface_active exists").active_lease_id,
      "lease_active"
    );
    assert.equal(
      mustExist(await store.getSurface("surface_released"), "surface_released exists").active_lease_id,
      undefined
    );
    assert.equal(
      mustExist(await store.getSurface("surface_missing"), "surface_missing exists").active_lease_id,
      undefined
    );
  } finally {
    teardown();
  }
});

test("SQLite browser surface schema exposes dynamic allocator metadata columns", () => {
  setup();
  try {
    const columns = typedDb()
      .prepare<[], { name: string }>("PRAGMA table_info(browser_surfaces)")
      .all()
      .map((row) => row.name);
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
    const columns = typedDb()
      .prepare<[], { name: string }>("PRAGMA table_info(browser_surfaces)")
      .all()
      .map((row) => row.name);
    assert.ok(columns.includes("browser_generation_hash"));
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
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
    const schemaRow = typedDb()
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'browser_surface_leases'"
      )
      .get();
    assert.ok(schemaRow);
    const schema = schemaRow.sql;
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(schema, /'starting_surface'/);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(schema, /'surface_start_failed'/);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(schema, /'retained_capacity_reserved'/);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(schema, /'interactive'/);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(schema, /'background'/);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(schema, /'owner_interactive'|'scheduled_refresh'/);
    const legacyWaitingRow = typedDb()
      .prepare<[], { priority_class: string }>(
        "SELECT priority_class FROM browser_surface_leases WHERE lease_id = 'legacy_waiting'"
      )
      .get();
    assert.ok(legacyWaitingRow);
    assert.equal(legacyWaitingRow.priority_class, "background");

    getDb()
      .prepare(`
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
    `)
      .run();
    getDb()
      .prepare(`
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
    `)
      .run();
    getDb()
      .prepare(`
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
    `)
      .run();

    const rows = typedDb()
      .prepare<[], { lease_id: string }>("SELECT lease_id FROM browser_surface_leases ORDER BY lease_id")
      .all();
    assert.deepEqual(
      rows.map((row) => row.lease_id),
      ["lease_retained_reserved", "lease_start_failed", "lease_starting", "legacy_waiting"]
    );
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
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
    const schemaRow = typedDb()
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'browser_surface_leases'"
      )
      .get();
    assert.ok(schemaRow);
    const schema = schemaRow.sql;
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(schema, /'starting_surface'/);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(schema, /'surface_start_failed'/);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(schema, /'retained_capacity_reserved'/);

    const migrated = typedDb()
      .prepare<[string], { surface_subject_id: string | null; wait_reason: string | null }>(
        "SELECT surface_subject_id, wait_reason FROM browser_surface_leases WHERE lease_id = ?"
      )
      .get("legacy_subject");
    assert.ok(migrated);
    assert.equal(migrated.surface_subject_id, "subject-sentinel");
    assert.equal(migrated.wait_reason, null);

    getDb()
      .prepare(`
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
    `)
      .run();

    const retained = typedDb()
      .prepare<[string], { wait_reason: string | null }>(
        "SELECT wait_reason FROM browser_surface_leases WHERE lease_id = ?"
      )
      .get("lease_retained_reserved_subject");
    assert.ok(retained);
    assert.equal(retained.wait_reason, "retained_capacity_reserved");
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
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
    assert.deepEqual(
      getDb()
        .prepare("SELECT lease_id, priority_class, migration_sentinel FROM browser_surface_leases ORDER BY lease_id")
        .all(),
      [
        { lease_id: "already_current", migration_sentinel: "kept", priority_class: "background" },
        { lease_id: "legacy_owner", migration_sentinel: "sentinel", priority_class: "interactive" },
      ]
    );
    assert.ok(
      getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'custom_lease_sentinel_idx'").get()
    );
    assert.ok(
      getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_lease_audit'").get()
    );
    assert.equal(getDb().prepare("PRAGMA foreign_key_check").all().length, 0);
    getDb()
      .prepare(`INSERT INTO browser_surface_leases(lease_id, connector_id, profile_key, run_id, status, priority_class, requested_at, expires_at, fencing_token)
      VALUES ('triggered', 'chatgpt', 'chatgpt', 'run_triggered', 'leased', 'interactive', '2026-05-12T12:00:02Z', '2026-05-12T12:05:02Z', 3)`)
      .run();
    assert.deepEqual(getDb().prepare("SELECT lease_id FROM lease_audit WHERE lease_id = 'triggered'").all(), [
      { lease_id: "triggered" },
    ]);
    closeDb();
    initDb(dbPath);
    const remainingLegacyPriorityCount = typedDb()
      .prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM browser_surface_leases WHERE priority_class IN ('owner_interactive', 'scheduled_refresh')"
      )
      .get();
    assert.ok(remainingLegacyPriorityCount);
    assert.equal(remainingLegacyPriorityCount.count, 0);
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
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
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.throws(() => initDb(dbPath), /Unsupported browser_surface_leases priority_class CHECK shape/);
    const verify = new Database(dbPath);
    try {
      const unsupportedRow = verify
        .prepare<[], { priority_class: string }>(
          "SELECT priority_class FROM browser_surface_leases WHERE lease_id = 'unsupported'"
        )
        .get();
      assert.ok(unsupportedRow);
      assert.equal(unsupportedRow.priority_class, "emergency");
      const surfaceSubjectIdColumnCount = verify
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM pragma_table_info('browser_surface_leases') WHERE name = 'surface_subject_id'"
        )
        .get();
      assert.ok(surfaceSubjectIdColumnCount);
      assert.equal(surfaceSubjectIdColumnCount.count, 0);
    } finally {
      verify.close();
    }
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Postgres store maps dynamic surface metadata with the same persistence shape", async () => {
  const dynamicSurface = surface({
    active_lease_id: "lease_pg",
    container_id: "container_pg",
    container_name: "pdpp-neko-surface-pg",
    health: "starting",
    profile_dir: "/var/lib/pdpp/neko-profiles/pg-hash",
    profile_volume: "pdpp_neko_profile_pg_hash",
    stream_origin: "http://neko-surface-pg:8080",
    surface_id: "surface_dynamic_pg",
    surface_mode: "dynamic",
    surface_source: "allocator",
    window_settle_endpoint: "http://neko-surface-pg:9223/pdpp/window-settle",
  });
  interface QueryCall {
    readonly params: unknown[];
    readonly sql: string;
  }
  const queries: QueryCall[] = [];
  const dynamicSurfaceRow = {
    account_key: dynamicSurface.account_key ?? null,
    active_lease_id: dynamicSurface.active_lease_id ?? null,
    backend: dynamicSurface.backend,
    browser_generation_hash: dynamicSurface.browser_generation_hash ?? null,
    cdp_url: dynamicSurface.cdp_url,
    connector_id: dynamicSurface.connector_id,
    container_id: dynamicSurface.container_id ?? null,
    container_name: dynamicSurface.container_name ?? null,
    created_at: dynamicSurface.created_at,
    health: dynamicSurface.health,
    last_used_at: dynamicSurface.last_used_at,
    profile_dir: dynamicSurface.profile_dir ?? null,
    profile_key: dynamicSurface.profile_key,
    profile_volume: dynamicSurface.profile_volume ?? null,
    stream_base_url: dynamicSurface.stream_base_url,
    stream_origin: dynamicSurface.stream_origin ?? null,
    surface_id: dynamicSurface.surface_id,
    surface_mode: dynamicSurface.surface_mode ?? null,
    surface_source: dynamicSurface.surface_source ?? null,
    surface_subject_id: dynamicSurface.surface_subject_id ?? null,
    window_settle_endpoint: dynamicSurface.window_settle_endpoint ?? null,
  };
  const client = {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async query(sql: string, params: unknown[] = []) {
      queries.push({ params, sql });
      if (sql.includes("SELECT * FROM browser_surfaces")) {
        return { rows: [dynamicSurfaceRow] };
      }
      return { rows: [] };
    },
  };
  const store = createPostgresBrowserSurfaceLeaseStore(client);

  await store.upsertSurface(dynamicSurface);

  assert.deepEqual(mustExist(queries[0] ?? null, "at least one query recorded").params, [
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
  const source = readFileSync(new URL("../server/postgres-storage.ts", import.meta.url), "utf8");
  const occurrences = source.match(/'retained_capacity_reserved'/g) ?? [];
  assert.equal(occurrences.length, 3);

  const createStart = source.indexOf("CREATE TABLE IF NOT EXISTS browser_surface_leases");
  const createEnd = source.indexOf(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_browser_surface_leases_one_non_terminal_run"
  );
  assert.ok(createStart >= 0 && createEnd > createStart);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(source.slice(createStart, createEnd), /'retained_capacity_reserved'/);

  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.doesNotMatch(source, /pg_get_constraintdef\(oid\) LIKE '%priority_class%'/);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(source, /Unsupported browser_surface_leases priority CHECK shape/);
});

test("Postgres simultaneous empty public bootstraps use polling without concurrent-index deadlock", {
  skip: !POSTGRES_URL,
}, async () => {
  const postgresUrl = mustExist(POSTGRES_URL ?? null, "PDPP_TEST_POSTGRES_URL is set (test is skipped otherwise)");
  const admin = new Pool({ connectionString: postgresUrl });
  try {
    await closePostgresStorage();
    await admin.query("DROP SCHEMA public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await Promise.all([runIsolatedPostgresBootstrap(postgresUrl), runIsolatedPostgresBootstrap(postgresUrl)]);

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
      leases: "browser_surface_leases",
      lexical: "lexical_search_index",
      lexical_index_valid: true,
      priority_checks: 1,
    });
    await assertNoPriorityBootstrapLocks(admin);
  } finally {
    await closePostgresStorage();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA IF NOT EXISTS public");
    await admin.end();
  }
});

if (POSTGRES_URL) {
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
        const legacyRow = mustRow(
          (
            await postgresQuery(
              "SELECT surface_subject_id, wait_reason FROM browser_surface_leases WHERE lease_id = $1",
              ["legacy_pg_subject"]
            )
          ).rows[0],
          "legacy subject row exists"
        );
        assert.equal(legacyRow.surface_subject_id, "subject-sentinel");
        assert.equal(legacyRow.wait_reason, null);
        assert.equal(
          mustRow(
            (
              await postgresQuery("SELECT priority_class FROM browser_surface_leases WHERE lease_id = $1", [
                "legacy_pg_subject",
              ])
            ).rows[0],
            "legacy subject priority row exists"
          ).priority_class,
          "interactive"
        );
        assert.equal(
          mustRow(
            (
              await postgresQuery("SELECT priority_class FROM browser_surface_leases WHERE lease_id = $1", [
                "legacy_pg_background",
              ])
            ).rows[0],
            "legacy background priority row exists"
          ).priority_class,
          "background"
        );
        const preservedConstraint = await postgresQuery(`
          SELECT oid FROM pg_constraint
          WHERE conrelid = 'browser_surface_leases'::regclass
            AND conname = 'preserve_priority_status_invariant'
        `);
        assert.equal(preservedConstraint.rowCount, 1, "unrelated compound priority check is retained");
        const priorityConstraint = await postgresQuery(`
          SELECT oid FROM pg_constraint
          WHERE conrelid = 'browser_surface_leases'::regclass
            AND conname = 'browser_surface_leases_priority_class_check'
        `);
        assert.equal(priorityConstraint.rowCount, 1);
        const priorityOid = mustRow(priorityConstraint.rows[0], "priority constraint row exists").oid;
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
          mustRow(
            (
              await postgresQuery(`
            SELECT oid FROM pg_constraint
            WHERE conrelid = 'browser_surface_leases'::regclass
              AND conname = 'browser_surface_leases_priority_class_check'
          `)
            ).rows[0],
            "priority constraint row still exists"
          ).oid,
          priorityOid,
          "a current priority schema is a priority-DDL no-op on the second boot"
        );
        assert.equal(
          (
            await admin.query(`
            SELECT count(*)::int AS count FROM priority_migration_ddl_events
            WHERE command_tag = 'ALTER TABLE' AND object_identity = 'public.browser_surface_leases'
          `)
          ).rows[0].count,
          0,
          "a current priority schema takes no priority ALTER TABLE DDL path on the second boot"
        );
        await admin.query("DROP EVENT TRIGGER capture_priority_migration_ddl");
        await admin.query("DROP FUNCTION capture_priority_migration_ddl()");
        await admin.query("DROP TABLE priority_migration_ddl_events");
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
          // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
          /check constraint/i
        );
        // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
        const generationColumn = (
          await postgresQuery(
            `SELECT 1 FROM information_schema.columns
             WHERE table_name = 'browser_surfaces' AND column_name = 'browser_generation_hash'`
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

        const retainedRow = mustRow(
          (
            await postgresQuery("SELECT wait_reason FROM browser_surface_leases WHERE lease_id = $1", [
              "lease_retained_reserved_pg",
            ])
          ).rows[0],
          "retained lease row exists"
        );
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
} else {
  test("Postgres browser-surface lease upgrade preserves surface_subject_id and admits retained_capacity_reserved (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
  }, () => {});
}

test("Postgres simultaneous legacy boots serialize priority migration before catalog discovery", {
  skip: !POSTGRES_URL,
}, async () => {
  const postgresUrl = mustExist(POSTGRES_URL ?? null, "PDPP_TEST_POSTGRES_URL is set (test is skipped otherwise)");
  const admin = new Pool({ connectionString: postgresUrl });
  try {
    // Start from a fully bootstrapped schema so this exercise isolates the
    // historical priority migration through public initializers, rather than
    // inventing a partial bootstrap shape.
    await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
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

    await Promise.all([runIsolatedPostgresBootstrap(postgresUrl), runIsolatedPostgresBootstrap(postgresUrl)]);

    assert.deepEqual(
      (
        await admin.query(`
          SELECT priority_class FROM browser_surface_leases
          WHERE lease_id IN ('concurrent_legacy_owner', 'concurrent_legacy_background')
          ORDER BY lease_id
        `)
      ).rows.map((row) => row.priority_class),
      ["background", "interactive"]
    );
    const priorityConstraints = await admin.query(`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'browser_surface_leases'::regclass AND contype = 'c'
      `);
    const exactCurrent = priorityConstraints.rows.filter(
      (constraint) =>
        constraint.conname === "browser_surface_leases_priority_class_check" &&
        constraint.definition.includes("'interactive'::text") &&
        constraint.definition.includes("'background'::text")
    );
    assert.equal(exactCurrent.length, 1, "concurrent starters leave one exact current priority constraint");
    await assertNoPriorityBootstrapLocks(admin);
  } finally {
    await closePostgresStorage();
    await admin.query("DROP TABLE IF EXISTS browser_surface_leases");
    await admin.query("DROP TABLE IF EXISTS browser_surfaces");
    await admin.end();
  }
});

test("Postgres browser generation hash upsert preserves same-container state and clears on container replacement", {
  skip: !POSTGRES_URL,
}, async () => {
  const postgresUrl = mustExist(POSTGRES_URL ?? null, "PDPP_TEST_POSTGRES_URL is set (test is skipped otherwise)");
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
  const store = createPostgresBrowserSurfaceLeaseStore();
  const id = `surface_generation_${Date.now()}`;
  try {
    await store.upsertSurface(
      surface({ browser_generation_hash: "a".repeat(64), container_id: "pg-container-1", surface_id: id })
    );
    await store.upsertSurface(surface({ container_id: "pg-container-1", surface_id: id }));
    assert.equal(mustExist(await store.getSurface(id), "surface exists").browser_generation_hash, "a".repeat(64));
    await store.upsertSurface(surface({ container_id: "pg-container-2", surface_id: id }));
    assert.equal(mustExist(await store.getSurface(id), "surface exists").browser_generation_hash, undefined);
  } finally {
    await postgresQuery("DELETE FROM browser_surfaces WHERE surface_id = $1", [id]);
    await closePostgresStorage();
  }
});

test("Postgres clears stale profile provenance on a profile-key change and accepts an explicit replacement", {
  skip: !POSTGRES_URL,
}, async () => {
  const postgresUrl = mustExist(POSTGRES_URL ?? null, "PDPP_TEST_POSTGRES_URL is set (test is skipped otherwise)");
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
  const store = createPostgresBrowserSurfaceLeaseStore();
  const id = `surface_profile_compatibility_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    await assertProfileProvenanceCompatibility(store, id);
  } finally {
    await postgresQuery("DELETE FROM browser_surfaces WHERE surface_id = $1", [id]);
    await closePostgresStorage();
  }
});

test("Postgres repair clears active surface pointers not backed by non-terminal leases", async () => {
  interface QueryCall {
    readonly params: unknown[];
    readonly sql: string;
  }
  const queries: QueryCall[] = [];
  const client = {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async query(sql: string, params: unknown[] = []) {
      queries.push({ params, sql });
      return { rows: [] };
    },
  };
  const store = createPostgresBrowserSurfaceLeaseStore(client);

  await store.repairStaleSurfaceActiveLeases();

  const firstQuery = mustExist(queries[0] ?? null, "at least one query recorded");
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(firstQuery.sql, /UPDATE browser_surfaces/);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(firstQuery.sql, /active_lease_id = NULL/);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(firstQuery.sql, /status NOT IN/);
});

test("queued browser-surface leases are separate from controller_active_runs", async () => {
  const store = setup();
  try {
    const queued = lease({
      lease_id: "lease_waiting",
      leased_at: undefined,
      priority_class: "background",
      run_id: "run_waiting",
      status: "waiting_for_browser_surface",
      surface_id: undefined,
      wait_reason: "capacity_full",
    });

    await store.upsertLease(queued);

    assert.deepEqual(await store.getLease("lease_waiting"), queued);
    const activeRunCountRow = typedDb()
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM controller_active_runs")
      .get();
    assert.ok(activeRunCountRow);
    assert.equal(activeRunCountRow.count, 0);
  } finally {
    teardown();
  }
});

test("SQLite schema rejects duplicate non-terminal leases for the same run", async () => {
  const store = setup();
  try {
    await store.upsertLease(
      lease({ lease_id: "lease_a", status: "waiting_for_browser_surface", surface_id: undefined })
    );

    assert.throws(() => {
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
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    }, /UNIQUE constraint failed: browser_surface_leases\.run_id/);

    await store.upsertLease(
      lease({
        lease_id: "lease_released",
        leased_at: undefined,
        priority_class: "background",
        released_at: "2026-05-12T12:00:04.000Z",
        run_id: "run_1",
        status: "released",
        surface_id: undefined,
      })
    );
  } finally {
    teardown();
  }
});

test("SQLite schema rejects two active leased rows for the same surface", async () => {
  const store = setup();
  try {
    await store.upsertSurface(surface());
    await store.upsertLease(lease({ lease_id: "lease_a", run_id: "run_a" }));

    assert.throws(() => {
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
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    }, /UNIQUE constraint failed: browser_surface_leases\.surface_id/);
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

    assert.throws(() => {
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
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    }, /UNIQUE constraint failed/);
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
        await tx.upsertLease(lease({ lease_id: "lease_tx", run_id: "run_tx", surface_id: "surface_tx" }));
        throw new Error("boom");
      }),
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
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

    const released = mustExist(
      await store.updateLeaseTerminal("lease_1", "released", {
        releasedAt: "2026-05-12T12:01:00.000Z",
      }),
      "lease_1 terminal update returns the updated lease"
    );
    const staleLeaseClear = mustExist(
      await store.clearSurfaceActiveLease("surface_1", "stale_lease", 1),
      "surface_1 exists for stale-lease-id clear"
    );
    const staleTokenClear = mustExist(
      await store.clearSurfaceActiveLease("surface_1", "lease_1", 999),
      "surface_1 exists for stale-token clear"
    );
    const cleared = mustExist(
      await store.clearSurfaceActiveLease("surface_1", "lease_1", 1),
      "surface_1 exists for the fenced clear"
    );

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
