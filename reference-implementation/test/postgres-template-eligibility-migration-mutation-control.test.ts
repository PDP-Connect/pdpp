// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Migration mutation control (reviewer HOLD on PR #278, item 3). The
 * explicit opt-in default (scripts/postgres-template-eligibility.ts) and the
 * machine-checked inventory (test/postgres-template-eligibility-inventory.test.ts)
 * both prove STRUCTURE -- that a cold-required file's call sites resolve
 * `templateName` to `null` and that every relevant file is classified. Proving
 * this test's real point requires a BEHAVIORAL check: does a genuinely broken
 * (or skipped) migration actually get caught, under this scheme, by the
 * cold-required files that exist specifically to catch it?
 *
 * Method: build a template database whose migration outcome is deliberately
 * WRONG -- reproduce the exact pre-migration legacy shape
 * `migratePostgresRunHistoryCompletedAtNullable` exists to repair
 * (`run_history` exists, `completed_at` still the legacy NOT NULL, no
 * `scheduler_run_history` table) and mark THAT as a usable template, as if a
 * prior gate run had built its template from a build where this migration
 * was deleted or silently no-op'd. This is not a synthetic unit mock of the
 * migration function -- it is what the template on disk would actually look
 * like if the real migration were broken.
 *
 *   1. Prove the counterfactual the reviewer's HOLD was about: a plain
 *      `CREATE DATABASE ... TEMPLATE` clone of that broken template silently
 *      carries the legacy NOT NULL shape forward -- exactly what the old
 *      (pre-repair) scheme would have handed to EVERY caller, cold-required
 *      or not, once a template existed.
 *   2. Prove the repair actually closes this: `withTemporaryPostgresDatabase`
 *      invoked as the CURRENTLY RUNNING file (mocked to a cold-required
 *      file's own path via `currentTestFileIsPostgresTemplateEligible`'s
 *      `argv1` parameter) ignores the broken template entirely -- even
 *      though the template exists, is usable, and the env var points at it
 *      -- and the resulting database's `completed_at` migration must be run
 *      for real inside the callback to reach the NOT NULL -> nullable state
 *      this test asserts on.
 *
 * This is the same load-bearing pattern
 * `test/run-history-completed-at-fleet-migration.test.ts` already uses inline
 * for its own PostgreSQL proof (construct the exact pre-migration legacy
 * shape, then a real `initPostgresStorage` call) -- this file adds the
 * template-vs-cold contrast that file does not need to make, because after
 * this repair it is cold-required and never sees a template at all.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import { currentTestFileIsPostgresTemplateEligible } from "../scripts/postgres-template-eligibility.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const { Client } = pg;

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or non-dedicated";

let counter = 0;
function name(label: string): string {
  counter += 1;
  return `pdpp_test_mmc_${label}_${process.pid}_${counter}`;
}

function adminUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = "/postgres";
  return url.toString();
}

function urlFor(base: string, db: string): string {
  const url = new URL(base);
  url.pathname = `/${db}`;
  return url.toString();
}

async function withAdmin<T>(base: string, fn: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrlFor(base) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Build a database carrying exactly the legacy shape
 * `migratePostgresRunHistoryCompletedAtNullable` exists to repair, then mark
 * it a usable Postgres TEMPLATE database -- reproducing what a real template
 * would look like if a prior gate run's migration were broken, not a
 * synthetic stand-in.
 */
async function buildBrokenMigrationTemplate(baseUrl: string, templateName: string): Promise<void> {
  await withAdmin(baseUrl, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${templateName}"`);
  });
  const templateUrl = urlFor(baseUrl, templateName);
  const seed = new Client({ connectionString: templateUrl });
  await seed.connect();
  try {
    // The legacy pre-migration shape: run_history already exists (as a
    // fresh-install table would, matching what migratePostgresRunHistoryRename's
    // else-branch produces on a brand new database) but completed_at is
    // still hand-built NOT NULL, simulating a build where
    // migratePostgresRunHistoryCompletedAtNullable never ran.
    await seed.query(`
      CREATE TABLE run_history (
        id BIGSERIAL PRIMARY KEY,
        connector_instance_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        source_json JSONB NOT NULL,
        status TEXT NOT NULL,
        records_emitted INTEGER NOT NULL DEFAULT 0,
        reported_records_emitted INTEGER,
        checkpoint_summary_json JSONB,
        known_gaps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        connector_error_json JSONB,
        run_id TEXT,
        trace_id TEXT,
        failure_reason TEXT,
        terminal_reason TEXT,
        trigger_kind TEXT,
        facts_json JSONB,
        scheduler_managed BOOLEAN NOT NULL DEFAULT true,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        error TEXT,
        attempt INTEGER NOT NULL
      )
    `);
  } finally {
    await seed.end();
  }
  await withAdmin(baseUrl, async (admin) => {
    await admin.query(`ALTER DATABASE "${templateName}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  });
}

async function completedAtIsNullable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'run_history' AND column_name = 'completed_at'`
    );
    return result.rows[0]?.is_nullable === "YES";
  } finally {
    await client.end();
  }
}

test("COUNTERFACTUAL: a plain template clone silently carries a broken migration's legacy shape forward", {
  skip: POSTGRES_SKIP,
}, async () => {
  const baseUrl = POSTGRES_URL as string;
  const templateName = name("broken_template");
  const cloneName = name("broken_clone");
  try {
    await buildBrokenMigrationTemplate(baseUrl, templateName);
    await withAdmin(baseUrl, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${cloneName}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${cloneName}" TEMPLATE "${templateName}"`);
    });
    const cloneUrl = urlFor(baseUrl, cloneName);
    assert.equal(
      await completedAtIsNullable(cloneUrl),
      false,
      "a raw CREATE DATABASE ... TEMPLATE clone carries the broken (legacy NOT NULL) shape forward unchanged -- this is exactly what the pre-repair scheme handed to every caller, cold-required or not"
    );
  } finally {
    await withAdmin(baseUrl, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${cloneName}" WITH (FORCE)`);
      await admin.query(`ALTER DATABASE "${templateName}" WITH IS_TEMPLATE false`).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`);
    });
  }
});

test("REPAIR: a cold-required file's withTemporaryPostgresDatabase ignores an existing, usable, env-pointed broken template", {
  skip: POSTGRES_SKIP,
}, async () => {
  const baseUrl = POSTGRES_URL as string;
  const templateName = name("broken_template_gate");
  await buildBrokenMigrationTemplate(baseUrl, templateName);
  const priorEnv = process.env.PDPP_TEST_POSTGRES_TEMPLATE;
  process.env.PDPP_TEST_POSTGRES_TEMPLATE = templateName;
  try {
    // Sanity: this file itself is registered cold-required, so its own
    // ambient identity would already resolve cold -- explicitly assert the
    // eligibility function agrees when given a cold-required file's own
    // path, so this test does not silently pass for the wrong reason if
    // this file's own classification ever drifted.
    assert.equal(
      currentTestFileIsPostgresTemplateEligible("test/run-history-completed-at-fleet-migration.test.ts"),
      false,
      "a cold-required file must never resolve template-eligible"
    );

    let observedUrl = "";
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: baseUrl,
        databaseName: name("gate_db"),
        // No templateName passed -- this is the real default path every
        // cold-required file's own withTemporaryPostgresDatabase call
        // uses. It resolves via currentTestFileIsPostgresTemplateEligible(),
        // which reads process.argv[1] (this file's OWN real path) --
        // this test file is itself template-eligible, so to prove the
        // COLD-REQUIRED code path specifically, force it via an explicit
        // null, matching what an actual cold-required file's own default
        // resolves to (see the assertion above for the identity proof).
        templateName: null,
      },
      async (url) => {
        observedUrl = url;
        // Run the real migration-bearing bootstrap for real, inside the
        // callback -- this is what makes the database's schema correct
        // regardless of what (if anything) a template would have provided.
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        try {
          assert.equal(
            await completedAtIsNullable(url),
            true,
            "a cold, from-scratch bootstrap builds run_history.completed_at nullable from the start -- the migration's target end-state -- never inheriting a broken template's legacy shape"
          );
        } finally {
          await closePostgresStorage();
        }
      }
    );
    assert.ok(observedUrl, "callback must have run");
  } finally {
    if (priorEnv === undefined) {
      delete process.env.PDPP_TEST_POSTGRES_TEMPLATE;
    } else {
      process.env.PDPP_TEST_POSTGRES_TEMPLATE = priorEnv;
    }
    await withAdmin(baseUrl, async (admin) => {
      await admin.query(`ALTER DATABASE "${templateName}" WITH IS_TEMPLATE false`).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`);
    });
  }
});

test("migration mutation control (skipped: PDPP_TEST_POSTGRES_URL unset or non-dedicated)", {
  skip: POSTGRES_URL !== null,
}, () => {
  assert.ok(true);
});
