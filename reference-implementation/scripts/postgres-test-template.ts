// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds, once per gate run, a Postgres TEMPLATE database carrying the fully
 * bootstrapped RI schema (all tables/indexes/migrations) and the test-sentinel
 * marker, so per-file/per-test database provisioning can `CREATE DATABASE ...
 * TEMPLATE <template>` -- a filesystem-level copy -- instead of re-running
 * ~2000 lines of DDL from scratch every time.
 *
 * Measured motivation (local/GATE-POSTGRES-PROVISIONING-0901.md): schema
 * bootstrap is ~85-90% of per-file Postgres provisioning cost, and none of it
 * is network round-trip count -- it is the fixed cost of building ~91 index
 * relations from scratch. `CREATE DATABASE ... TEMPLATE` copies the already-
 * built index files instead of rebuilding them.
 *
 * FAIL-CLOSED CONTRACT: a missing or unusable template must throw, never
 * silently fall back to `CREATE DATABASE` without a template. A silent
 * fallback would defeat the point of measuring speedup honestly (a run that
 * "looks the same" but quietly stopped using the fast path), and worse, it
 * would hide a broken template build behind normal-looking (slow) green runs.
 */

// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { provisionTestDatabase } from "../server/postgres-test-database-guard.ts";

const { Client } = pg;

/**
 * Distinct advisory-lock key from `POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK`
 * (postgres-storage.ts) -- that lock serializes concurrent bootstraps of ONE
 * already-selected database; this one serializes concurrent *template
 * builds* across parallel gate workers, taken on the admin ("postgres")
 * connection before any template database exists.
 */
const TEMPLATE_BUILD_SERIALIZATION_LOCK = [482_571, 151];

function adminUrl(connectionString: string): string {
  const url = new URL(connectionString);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrl(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Derive the per-run template database name from the same runnerId used for per-file names, so concurrent runs on a shared cluster never collide. */
export function deriveDedicatedPostgresTemplateName(runnerId: string): string {
  return `pdpp_test_template_${runnerId}`;
}

async function withAdminClient<T>(
  connectionString: string,
  fn: (client: InstanceType<typeof Client>) => Promise<T>
): Promise<T> {
  const client = new Client({ connectionString: adminUrl(connectionString) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function templateIsUsable(client: InstanceType<typeof Client>, templateName: string): Promise<boolean> {
  const {
    rows: [row],
  } = await client.query<{ datistemplate: boolean; datallowconn: boolean }>(
    "SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1",
    [templateName]
  );
  // A template mid-build (or left over from a crashed prior run) would not
  // yet have datistemplate=true set -- treat that as "not usable", not as
  // "usable but somehow wrong", so a stale half-built database is rebuilt
  // rather than trusted.
  return row?.datistemplate === true && row?.datallowconn === false;
}

/**
 * Build (or verify) the per-run Postgres test template database. Idempotent
 * and safe under concurrent callers: callers race for
 * `TEMPLATE_BUILD_SERIALIZATION_LOCK` on the admin connection, the winner
 * builds, losers wait for the lock and then verify the winner's result
 * instead of rebuilding.
 *
 * Returns the template database name. Throws on any failure -- there is no
 * return value meaning "couldn't build a template, proceed without one";
 * callers that want that fallback must catch and decide explicitly, and this
 * harness's own call sites do not.
 */
export async function ensurePostgresTestTemplate(baseConnectionString: string, runnerId: string): Promise<string> {
  const templateName = deriveDedicatedPostgresTemplateName(runnerId);

  await withAdminClient(baseConnectionString, async (admin) => {
    await admin.query("SELECT pg_advisory_lock($1, $2)", TEMPLATE_BUILD_SERIALIZATION_LOCK);
    try {
      if (await templateIsUsable(admin, templateName)) {
        return;
      }

      // Not usable (absent, or a stale half-built leftover from a crashed
      // prior attempt under the same runnerId -- extremely unlikely given
      // runnerId is a fresh random hex per run, but handled explicitly
      // rather than assumed away): drop and rebuild from scratch.
      await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(templateName)} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${quotedIdentifier(templateName)}`);

      const templateUrl = databaseUrl(baseConnectionString, templateName);
      // Stamp the sentinel BEFORE bootstrapping schema, exactly like every
      // other scratch-database creation path in this harness --
      // provisionTestDatabase refuses to stamp a database holding real data,
      // and the database is provably empty one statement after CREATE
      // DATABASE, so this ordering is honest.
      await provisionTestDatabase(templateUrl);
      // Run the REAL, unmodified initPostgresStorage -- the exact chokepoint
      // every Postgres-backed test file already goes through today (guard
      // check + bootstrapPostgresSchema). This is the one-time cost the
      // template amortizes; every later clone skips it entirely.
      await initPostgresStorage({ backend: "postgres", databaseUrl: templateUrl });
      // initPostgresStorage leaves the process-global pool pointed at the
      // template. Close it so the template build does not leak a live
      // pool/connection into the caller, which would also hold
      // datallowconn=false hostage (ALTER DATABASE ... datallowconn fails
      // while the pool's own connections are still open against it).
      await closePostgresStorage();

      await admin.query(
        `ALTER DATABASE ${quotedIdentifier(templateName)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`
      );

      if (!(await templateIsUsable(admin, templateName))) {
        throw new Error(
          `Postgres test template build for "${templateName}" completed but the database is not marked as a usable template afterward (datistemplate/datallowconn check failed). Refusing to let callers clone from it.`
        );
      }
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1, $2)", TEMPLATE_BUILD_SERIALIZATION_LOCK);
    }
  });

  return templateName;
}

/**
 * Verify a named template database is present and usable. Used by clone call
 * sites that received a template name via env var from a different process
 * (the child test process did not build the template itself, so it cannot
 * assume the name it was handed is still good) -- throws loudly rather than
 * cloning from, or silently skipping, a template that turns out to be gone.
 */
export async function assertPostgresTestTemplateUsable(
  baseConnectionString: string,
  templateName: string
): Promise<void> {
  await withAdminClient(baseConnectionString, async (admin) => {
    if (!(await templateIsUsable(admin, templateName))) {
      throw new Error(
        `Postgres test template "${templateName}" is missing or not usable (expected datistemplate=true, datallowconn=false). Refusing to fall back to a from-scratch bootstrap silently -- if the template was supposed to exist, this is the bug; if templating is not wanted, unset PDPP_TEST_POSTGRES_TEMPLATE instead.`
      );
    }
  });
}

/** Drop the per-run template database. Best-effort: called during gate teardown, after which nothing else needs the template. */
export async function dropPostgresTestTemplate(baseConnectionString: string, templateName: string): Promise<void> {
  await withAdminClient(baseConnectionString, async (admin) => {
    // A template must have IS_TEMPLATE cleared before it can be dropped.
    await admin.query(`ALTER DATABASE ${quotedIdentifier(templateName)} WITH IS_TEMPLATE false`).catch(() => {
      // Best-effort: if this fails the DROP below will surface a clearer error.
    });
    await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(templateName)} WITH (FORCE)`);
  });
}
