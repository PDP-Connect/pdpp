// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres driver for the generic, connector-agnostic record-identity-
 * generation reconcile mechanism (env-gated on `PDPP_TEST_POSTGRES_URL`).
 *
 * `polyfill-manifest-reconcile-invalidation.test.ts` proves the full set of
 * behaviors — fresh-instance seeding, scoped per-instance invalidation,
 * sibling-connection survival, idempotent repeats — against SQLite only.
 * `setRecordIdentityGeneration`, `listRecordIdentityGenerationsByConnector`,
 * `deleteAllRecordsForConnector`'s Postgres branch
 * (`postgresDeleteAllRecordsForConnector`), and the Postgres
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS record_identity_generation`
 * migration in `bootstrapPostgresSchema` had ZERO test execution anywhere in
 * the repo before this file — schema-level parity with SQLite was provable
 * only by reading the two `.sql`/query-builder call sites side by side, not
 * behaviorally. This file re-runs the connector-agnostic generation
 * scenarios against a real Postgres backend so the parity claim is proven,
 * not inferred.
 *
 * Also proves genuine cross-process concurrency safety for
 * `reconcileRecordIdentityGeneration`: two independent OS processes running
 * the SAME reconcile pass for the SAME connector at the same time. The
 * per-instance delete phase is already fenced by `withConnectorInstanceWrite`
 * (a real `pg_advisory_lock` on Postgres — see
 * `connector-instance-write-coordinator.ts`), and the checkpoint write is a
 * bare `SET record_identity_generation = <shipped value>` (not an
 * increment), so two processes racing the same transition converge on the
 * identical final state regardless of interleaving. This is safety by
 * idempotent construction, not by a CAS/lock spanning the whole reconcile
 * sequence — the two-process test below empirically confirms that no
 * interleaving of list → delete → set across two real processes ever
 * produces record loss for a sibling instance or a torn/regressed
 * checkpoint.
 *
 * Target for local runs:
 *   docker run --rm -d --name pg-pilot -p 55463:5432 \
 *     -e POSTGRES_USER=pdpp -e POSTGRES_PASSWORD=pdpp \
 *     -e POSTGRES_DB=pdpp_pilot \
 *     pgvector/pgvector:pg16
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55463/pdpp_pilot \
 *     node --import tsx --test test/polyfill-manifest-reconcile-invalidation-postgres.test.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerConnector as registerConnectorUntyped } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { reconcilePolyfillManifests } from "../server/polyfill-manifest-reconcile.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord as ingestRecordUntyped } from "../server/records.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const DEFAULT_VALUE_ZERO_RE = /0/;

interface Manifest {
  capabilities?: {
    record_identity?: { generation?: number };
    [key: string]: unknown;
  };
  connector_id: string;
  streams: { name: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

const registerConnector = registerConnectorUntyped as (
  manifest: Manifest,
  options?: { backfillRetrievalIndexes?: boolean }
) => Promise<unknown>;
const ingestRecordForInstance = ingestRecordUntyped as (
  storageTarget: { connector_id: string; connector_instance_id: string },
  record: { stream: string; key: string; data: Record<string, unknown>; emitted_at: string }
) => Promise<unknown>;

if (POSTGRES_URL) {
  const databaseUrl: string = POSTGRES_URL;
  const CONNECTOR_ID = "generation-fixture-pg";

  function generationManifestV1(overrides: Partial<Manifest> = {}): Manifest {
    return {
      connector_id: CONNECTOR_ID,
      connector_key: CONNECTOR_ID,
      display_name: "Generation fixture connector (Postgres)",
      protocol_version: "0.1.0",
      runtime_requirements: { bindings: { filesystem: { required: true } } },
      streams: [
        {
          name: "items",
          primary_key: ["id"],
          schema: {
            properties: { content: { type: "string" }, id: { type: "string" } },
            required: ["id"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "append_only",
        },
      ],
      version: "0.1.0",
      ...overrides,
    };
  }

  function generationManifestV2(overrides: Partial<Manifest> = {}): Manifest {
    return generationManifestV1({
      capabilities: { record_identity: { generation: 1 } },
      version: "0.2.0",
      ...overrides,
    });
  }

  async function seedGenerationInstance(connectorInstanceId: string, sourceBindingKey: string): Promise<void> {
    const store = createPostgresConnectorInstanceStore();
    await store.upsert({
      connectorId: CONNECTOR_ID,
      connectorInstanceId,
      createdAt: "2026-06-01T00:00:00Z",
      displayName: connectorInstanceId,
      ownerSubjectId: "owner-generation-pg-test",
      sourceBinding: { account_hint: sourceBindingKey },
      sourceBindingKey,
      sourceKind: "account",
      status: "active",
      updatedAt: "2026-06-01T00:00:00Z",
    });
  }

  async function ingestOldGenerationItems(connectorInstanceId: string): Promise<void> {
    const items = [
      { content: "first", id: "old-scheme:0" },
      { content: "second", id: "old-scheme:1" },
    ];
    for (const data of items) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await ingestRecordForInstance(
        { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId },
        { data, emitted_at: "2026-06-05T09:15:22Z", key: data.id, stream: "items" }
      );
    }
  }

  async function recordCount(connectorInstanceId?: string): Promise<number> {
    const row = connectorInstanceId
      ? (
          await postgresQuery<{ n: string }>(
            "SELECT COUNT(*)::int AS n FROM records WHERE connector_id = $1 AND connector_instance_id = $2 AND deleted = FALSE",
            [CONNECTOR_ID, connectorInstanceId]
          )
        ).rows[0]
      : (
          await postgresQuery<{ n: string }>(
            "SELECT COUNT(*)::int AS n FROM records WHERE connector_id = $1 AND deleted = FALSE",
            [CONNECTOR_ID]
          )
        ).rows[0];
    return Number(row?.n ?? 0);
  }

  async function recordIdentityGeneration(connectorInstanceId: string): Promise<number> {
    const result = await postgresQuery<{ generation: number | string }>(
      "SELECT record_identity_generation AS generation FROM connector_instances WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const row = result.rows[0];
    assert.ok(row, `expected a connector_instances row for ${connectorInstanceId}`);
    return Number(row.generation);
  }

  function writeManifestsDir(rootDir: string, subdir: string, manifests: Record<string, Manifest>): string {
    const dir = join(rootDir, subdir);
    mkdirSync(dir, { recursive: true });
    for (const [filename, manifest] of Object.entries(manifests)) {
      writeFileSync(join(dir, filename), JSON.stringify(manifest, null, 2));
    }
    return dir;
  }

  async function cleanupFixtureState(): Promise<void> {
    await postgresQuery("DELETE FROM records WHERE connector_id = $1", [CONNECTOR_ID]);
    await postgresQuery("DELETE FROM record_changes WHERE connector_id = $1", [CONNECTOR_ID]);
    await postgresQuery("DELETE FROM blob_bindings WHERE connector_id = $1", [CONNECTOR_ID]);
    await postgresQuery("DELETE FROM version_counter WHERE connector_id = $1", [CONNECTOR_ID]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_id = $1", [CONNECTOR_ID]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
  }

  function withPostgresFixture(fn: (ctx: { dir: string }) => Promise<void>): () => Promise<void> {
    return async () => {
      initDb(":memory:");
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      const dir = mkdtempSync(join(tmpdir(), "pdpp-reconcile-invalidate-pg-"));
      try {
        await cleanupFixtureState();
        await fn({ dir });
      } finally {
        await cleanupFixtureState();
        rmSync(dir, { force: true, recursive: true });
        await closePostgresStorage();
        closeDb();
      }
    };
  }

  test(
    "[postgres] fresh schema: bootstrapPostgresSchema adds record_identity_generation as BIGINT NOT NULL DEFAULT 0",
    withPostgresFixture(async () => {
      const result = await postgresQuery<{ data_type: string; column_default: string; is_nullable: string }>(
        `SELECT data_type, column_default, is_nullable FROM information_schema.columns
         WHERE table_name = 'connector_instances' AND column_name = 'record_identity_generation'`
      );
      // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
      const column = result.rows[0];
      assert.ok(column, "record_identity_generation column exists on connector_instances after bootstrap");
      assert.equal(column.data_type, "bigint", "column type matches the documented BIGINT parity with SQLite INTEGER");
      assert.equal(column.is_nullable, "NO", "column is NOT NULL, matching the SQLite arm");
      assert.match(column.column_default, DEFAULT_VALUE_ZERO_RE, "column default is 0, matching the SQLite arm");
    })
  );

  test(
    "[postgres] migration is idempotent: re-running initPostgresStorage against an already-migrated DB does not error or reset data",
    withPostgresFixture(async () => {
      await registerConnector(generationManifestV1());
      await seedGenerationInstance("cin_gen_pg_migration", "migration@example.com");
      await postgresQuery(
        "UPDATE connector_instances SET record_identity_generation = 7 WHERE connector_instance_id = $1",
        ["cin_gen_pg_migration"]
      );

      // Re-run the bootstrap path a second time against the same DB, exactly
      // as a server restart would.
      await initPostgresStorage({ backend: "postgres", databaseUrl });

      assert.equal(
        await recordIdentityGeneration("cin_gen_pg_migration"),
        7,
        "re-running the migration (ADD COLUMN IF NOT EXISTS) must not reset an existing checkpoint"
      );
    })
  );

  test(
    "[postgres] listRecordIdentityGenerationsByConnector and setRecordIdentityGeneration round-trip against the real Postgres branch",
    withPostgresFixture(async () => {
      await registerConnector(generationManifestV1());
      await seedGenerationInstance("cin_gen_pg_list_a", "list-a@example.com");
      await seedGenerationInstance("cin_gen_pg_list_b", "list-b@example.com");

      const { listRecordIdentityGenerationsByConnector, setRecordIdentityGeneration } = await import(
        "../server/records.ts"
      );

      const initial = await listRecordIdentityGenerationsByConnector(CONNECTOR_ID);
      assert.deepEqual(
        [...initial].sort((a, b) => a.connectorInstanceId.localeCompare(b.connectorInstanceId)),
        [
          { connectorInstanceId: "cin_gen_pg_list_a", generation: 0 },
          { connectorInstanceId: "cin_gen_pg_list_b", generation: 0 },
        ],
        "both freshly-seeded instances start at generation 0 under a manifest with no declared generation"
      );

      await setRecordIdentityGeneration("cin_gen_pg_list_a", 3);
      assert.equal(
        await recordIdentityGeneration("cin_gen_pg_list_a"),
        3,
        "setRecordIdentityGeneration writes the exact value"
      );
      assert.equal(
        await recordIdentityGeneration("cin_gen_pg_list_b"),
        0,
        "setRecordIdentityGeneration scopes to exactly the targeted instance"
      );

      const afterSet = await listRecordIdentityGenerationsByConnector(CONNECTOR_ID);
      const byId = new Map(afterSet.map((row) => [row.connectorInstanceId, row.generation]));
      assert.equal(byId.get("cin_gen_pg_list_a"), 3);
      assert.equal(byId.get("cin_gen_pg_list_b"), 0);
    })
  );

  test(
    "[postgres] new instance created after the manifest already declares generation 1 is seeded at 1, not 0 (upsert's Postgres COALESCE subquery)",
    withPostgresFixture(async () => {
      await registerConnector(generationManifestV2());
      await seedGenerationInstance("cin_gen_pg_fresh", "fresh@example.com");
      assert.equal(
        await recordIdentityGeneration("cin_gen_pg_fresh"),
        1,
        "the Postgres upsert seeding subquery (manifest #>> '{capabilities,record_identity,generation}') must match the SQLite json_extract arm"
      );
    })
  );

  test(
    "[postgres] reconciliation invalidates prior-generation records for an instance behind the shipped manifest's declared record_identity.generation",
    withPostgresFixture(async ({ dir }) => {
      await registerConnector(generationManifestV1());
      await seedGenerationInstance("cin_gen_pg_solo", "solo@example.com");
      assert.equal(
        await recordIdentityGeneration("cin_gen_pg_solo"),
        0,
        "baseline: fresh instance checkpoint starts at 0"
      );

      await ingestOldGenerationItems("cin_gen_pg_solo");
      assert.equal(await recordCount(), 2, "baseline: old-generation items persisted");

      const manifestsDir = writeManifestsDir(dir, "polyfill", { "generation-fixture-pg.json": generationManifestV2() });
      const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

      const lines: string[] = [];
      const summary = await reconcilePolyfillManifests({
        enabled: true,
        log: (line) => lines.push(line),
        manifestsDir,
        referenceFixturesDir,
      });

      assert.equal(await recordCount(), 0, "old-generation records are invalidated on the real Postgres delete branch");
      assert.equal(summary.invalidatedConnectors, 1);
      assert.equal(summary.invalidatedRecords, 2);
      assert.equal(summary.updated, 1, "manifest was re-registered to v0.2.0");
      assert.equal(summary.errors, 0);
      assert.equal(
        await recordIdentityGeneration("cin_gen_pg_solo"),
        1,
        "instance checkpoint advances to the shipped generation via the Postgres setRecordIdentityGeneration branch"
      );

      const invalidationLine = lines.find((line) => line.includes("invalidated"));
      assert.ok(
        invalidationLine,
        "reconciliation emits an invalidation log line for the Postgres generation transition"
      );
    })
  );

  test(
    "[postgres] two instances of the same connector: invalidation touches ONLY the instance behind the declared generation; the caught-up sibling and its data survive untouched",
    withPostgresFixture(async ({ dir }) => {
      await registerConnector(generationManifestV1());
      await seedGenerationInstance("cin_gen_pg_behind", "behind@example.com");
      await ingestOldGenerationItems("cin_gen_pg_behind");

      const manifestsDirV2 = writeManifestsDir(dir, "polyfill-v2", {
        "generation-fixture-pg.json": generationManifestV2(),
      });
      await reconcilePolyfillManifests({
        enabled: true,
        log: () => {
          /* intentionally empty */
        },
        manifestsDir: manifestsDirV2,
        referenceFixturesDir: writeManifestsDir(dir, "reference-v2", {}),
      });
      assert.equal(await recordCount("cin_gen_pg_behind"), 0, "cin_gen_pg_behind's old-generation data is gone");
      assert.equal(await recordIdentityGeneration("cin_gen_pg_behind"), 1);

      // Created AFTER the manifest already declares generation 1: seeded at 1
      // directly by the Postgres upsert subquery, never touched by reconcile.
      await seedGenerationInstance("cin_gen_pg_caught_up", "caught-up@example.com");
      assert.equal(await recordIdentityGeneration("cin_gen_pg_caught_up"), 1);
      await ingestRecordForInstance(
        { connector_id: CONNECTOR_ID, connector_instance_id: "cin_gen_pg_caught_up" },
        {
          data: { content: "current-scheme", id: "current-scheme:0" },
          emitted_at: "2026-06-06T09:15:22Z",
          key: "current-scheme:0",
          stream: "items",
        }
      );
      assert.equal(await recordCount("cin_gen_pg_caught_up"), 1, "baseline: only the caught-up instance has data");

      // An unrelated manifest edit (new description) bumps content but not
      // the declared generation. Reconciliation fires (manifest changed) and
      // must find zero instances behind generation 1.
      const evolved = generationManifestV2({ display_name: "Generation fixture connector (Postgres, copy revised)" });
      const manifestsDirV3 = writeManifestsDir(dir, "polyfill-v3", { "generation-fixture-pg.json": evolved });
      const summary = await reconcilePolyfillManifests({
        enabled: true,
        log: () => {
          /* intentionally empty */
        },
        manifestsDir: manifestsDirV3,
        referenceFixturesDir: writeManifestsDir(dir, "reference-v3", {}),
      });

      assert.equal(summary.updated, 1, "manifest copy edit still re-registers");
      assert.equal(
        summary.invalidatedConnectors,
        0,
        "no instance is behind generation 1 -- the caught-up sibling must NOT be invalidated"
      );
      assert.equal(summary.invalidatedRecords, 0);
      assert.equal(
        await recordCount("cin_gen_pg_caught_up"),
        1,
        "the caught-up instance's current-generation record survives untouched"
      );
      assert.equal(
        await recordIdentityGeneration("cin_gen_pg_behind"),
        1,
        "already-reconciled sibling checkpoint is unchanged"
      );
      assert.equal(
        await recordIdentityGeneration("cin_gen_pg_caught_up"),
        1,
        "caught-up instance checkpoint is unchanged"
      );

      // Prove the sibling is not just present but genuinely still
      // collectable (not left in some half-torn-down state).
      await ingestRecordForInstance(
        { connector_id: CONNECTOR_ID, connector_instance_id: "cin_gen_pg_caught_up" },
        {
          data: { content: "still collectable", id: "current-scheme:1" },
          emitted_at: "2026-06-07T09:15:22Z",
          key: "current-scheme:1",
          stream: "items",
        }
      );
      assert.equal(await recordCount("cin_gen_pg_caught_up"), 2, "caught-up instance remains fully collectable");
    })
  );

  test(
    "[postgres] repeating an already-completed generation reconcile is idempotent: no further invalidation, no checkpoint regression, no error",
    withPostgresFixture(async ({ dir }) => {
      await registerConnector(generationManifestV1());
      await seedGenerationInstance("cin_gen_pg_repeat", "repeat@example.com");
      await ingestOldGenerationItems("cin_gen_pg_repeat");

      const manifestsDir = writeManifestsDir(dir, "polyfill", { "generation-fixture-pg.json": generationManifestV2() });
      const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

      const first = await reconcilePolyfillManifests({
        enabled: true,
        log: () => {
          /* intentionally empty */
        },
        manifestsDir,
        referenceFixturesDir,
      });
      assert.equal(first.invalidatedRecords, 2);
      assert.equal(await recordIdentityGeneration("cin_gen_pg_repeat"), 1);

      // Re-run reconciliation with the SAME shipped manifest content the
      // connector is already registered under -- an ordinary repeat
      // startup, not a further manifest change.
      const second = await reconcilePolyfillManifests({
        enabled: true,
        log: () => {
          /* intentionally empty */
        },
        manifestsDir,
        referenceFixturesDir,
      });

      assert.equal(second.unchanged, 1, "second pass detects the manifest as unchanged");
      assert.equal(second.invalidatedConnectors, 0, "repeat reconcile must not invalidate again");
      assert.equal(second.invalidatedRecords, 0);
      assert.equal(second.errors, 0);
      assert.equal(
        await recordIdentityGeneration("cin_gen_pg_repeat"),
        1,
        "checkpoint is unchanged (not regressed, not incremented) by the idempotent repeat"
      );
      assert.equal(await recordCount("cin_gen_pg_repeat"), 0, "no new records materialize from the idempotent repeat");
    })
  );

  // ─── Genuine cross-process concurrency proof ────────────────────────────
  //
  // Two independent OS processes (not two in-process async calls -- see the
  // rationale in connector-instance-delete-upsert-two-process-race.test.ts
  // for why an in-process race proves nothing about the real
  // pg_advisory_lock coordination) run the FULL reconcileRecordIdentityGeneration
  // sequence concurrently against the SAME connector, SAME instance, SAME
  // shipped generation. Both list the instance as behind, both invalidate,
  // both set the checkpoint to the identical shipped value. This is safety
  // by idempotent construction (see file header), not by a lock spanning the
  // whole reconcile sequence -- this test proves that construction holds
  // under a REAL race, not just by code inspection.
  const FIXTURE_PATH = fileURLToPath(
    new URL("./fixtures/record-identity-generation-reconcile-race-fixture.mjs", import.meta.url)
  );

  function spawnFixture(env: Record<string, string | undefined>) {
    const child = spawn(process.execPath, [FIXTURE_PATH], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdoutBuffer = "";
    const lines: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let idx = stdoutBuffer.indexOf("\n");
      while (idx >= 0) {
        const line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        const waiter = waiters.shift();
        if (waiter) {
          waiter(line);
        } else {
          lines.push(line);
        }
        idx = stdoutBuffer.indexOf("\n");
      }
    });
    function nextLine(): Promise<string> {
      if (lines.length > 0) {
        const line = lines.shift();
        assert.ok(line !== undefined);
        return Promise.resolve(line);
      }
      return new Promise((resolve) => waiters.push(resolve));
    }
    const exitCode = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    return { exitCode, nextLine };
  }

  test(
    "[postgres] two genuine OS processes running reconcileRecordIdentityGeneration concurrently for the SAME connector/instance converge on the identical checkpoint with no record loss for a sibling instance",
    withPostgresFixture(async ({ dir }) => {
      await registerConnector(generationManifestV1());
      await seedGenerationInstance("cin_gen_pg_race_target", "race-target@example.com");
      await ingestOldGenerationItems("cin_gen_pg_race_target");

      // A sibling instance already caught up to generation 1 BEFORE the race
      // starts -- must survive both processes' reconcile passes untouched.
      await seedGenerationInstance("cin_gen_pg_race_sibling", "race-sibling@example.com");
      await postgresQuery(
        "UPDATE connector_instances SET record_identity_generation = 1 WHERE connector_instance_id = $1",
        ["cin_gen_pg_race_sibling"]
      );
      await ingestRecordForInstance(
        { connector_id: CONNECTOR_ID, connector_instance_id: "cin_gen_pg_race_sibling" },
        {
          data: { content: "sibling-current", id: "current-scheme:sibling" },
          emitted_at: "2026-06-08T00:00:00Z",
          key: "current-scheme:sibling",
          stream: "items",
        }
      );

      const manifestsDir = writeManifestsDir(dir, "polyfill", { "generation-fixture-pg.json": generationManifestV2() });
      const referenceFixturesDir = writeManifestsDir(dir, "reference", {});

      const childEnv = {
        PDPP_TEST_POSTGRES_URL: POSTGRES_URL,
        // Widens the gap between reading a checkpoint and acting on it in
        // BOTH processes so their list-then-act windows deterministically
        // overlap, rather than relying on OS process-scheduling luck (which
        // 5/5 manual runs showed was not enough on its own — process B's
        // Node startup + Postgres connect latency alone routinely let
        // process A's reconcile fully commit first). See
        // testOnlyRecordIdentityReconcileDelay in polyfill-manifest-reconcile.ts.
        PDPP_TEST_RECORD_IDENTITY_RECONCILE_DELAY_MS: "300",
        RACE_MANIFESTS_DIR: manifestsDir,
        RACE_REFERENCE_FIXTURES_DIR: referenceFixturesDir,
      };
      const childA = spawnFixture(childEnv);
      const childB = spawnFixture(childEnv);

      const readyA = JSON.parse(await childA.nextLine());
      const readyB = JSON.parse(await childB.nextLine());
      assert.equal(readyA.ready, true, "process A failed to become ready");
      assert.equal(readyB.ready, true, "process B failed to become ready");

      // Fire both reconcile passes as close together in wall-clock terms as
      // possible -- neither process waits for the other's completion.
      const [resultA, resultB] = await Promise.all([
        (async () => {
          const line = await childA.nextLine();
          const code = await childA.exitCode;
          return { code, outcome: JSON.parse(line) };
        })(),
        (async () => {
          const line = await childB.nextLine();
          const code = await childB.exitCode;
          return { code, outcome: JSON.parse(line) };
        })(),
      ]);

      assert.equal(resultA.code, 0, `process A must exit cleanly: ${JSON.stringify(resultA.outcome)}`);
      assert.equal(resultB.code, 0, `process B must exit cleanly: ${JSON.stringify(resultB.outcome)}`);
      assert.equal(
        resultA.outcome.ok,
        true,
        `process A's reconcile must not error: ${JSON.stringify(resultA.outcome)}`
      );
      assert.equal(
        resultB.outcome.ok,
        true,
        `process B's reconcile must not error: ${JSON.stringify(resultB.outcome)}`
      );

      // The definitive invariant, checked directly against durable state
      // after BOTH processes have fully completed.
      assert.equal(
        await recordIdentityGeneration("cin_gen_pg_race_target"),
        1,
        "CRITICAL: the raced instance's checkpoint must converge to exactly the shipped generation, never torn or regressed"
      );
      assert.equal(
        await recordCount("cin_gen_pg_race_target"),
        0,
        "CRITICAL: the raced instance's old-generation records must be fully invalidated exactly once in effect, regardless of which process's delete/list interleaving won"
      );
      assert.equal(
        await recordIdentityGeneration("cin_gen_pg_race_sibling"),
        1,
        "CRITICAL: the already-caught-up sibling's checkpoint must be untouched by either racing process"
      );
      assert.equal(
        await recordCount("cin_gen_pg_race_sibling"),
        1,
        "CRITICAL: the already-caught-up sibling's current-generation record must survive both racing reconcile passes untouched"
      );

      // Across the two processes, the sum of invalidatedRecords they each
      // individually observed must be consistent with EXACTLY ONE effective
      // invalidation of the target instance's 2 records -- either one
      // process invalidated both and the other saw zero already-behind
      // instances, or (if genuinely interleaved) the total deleted count
      // actually removed from the table never exceeds 2, proven directly by
      // the recordCount assertion above rather than by summing self-reported
      // counters (which could double-count if both processes raced the
      // SELECT before either DELETE committed).
      const totalReportedInvalidations = resultA.outcome.invalidatedRecords + resultB.outcome.invalidatedRecords;
      assert.ok(
        totalReportedInvalidations >= 0 && totalReportedInvalidations <= 4,
        `each process reports at most the full 2-record set it observed as behind; got A=${resultA.outcome.invalidatedRecords} B=${resultB.outcome.invalidatedRecords}`
      );
    })
  );
} else {
  test("record-identity-generation reconcile Postgres oracle (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
  }, () => {});
}
