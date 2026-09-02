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

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { provisionTestDatabase } from "../server/postgres-test-database-guard.ts";

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Digest of the source file that defines `bootstrapPostgresSchema` and every
 * migration function it runs. This is the reviewer-required P2 fix: the
 * template's usability was previously verified only by
 * `datistemplate`/`datallowconn` (does *a* template exist and accept no
 * connections), which says nothing about whether the SCHEMA/MIGRATION CODE
 * that built it is the same code this process would run today. A template
 * built by a stale worker process, or reused across a code change mid-run
 * some other way, could otherwise be silently treated as usable while
 * carrying an outdated migration set. Binding this digest into the
 * template's metadata row and re-checking it on every clone closes that gap:
 * a template built from different migration source now fails closed instead
 * of being trusted.
 */
async function currentPostgresStorageSourceDigest(): Promise<string> {
  const source = await readFile(join(__dirname, "..", "server", "postgres-storage.ts"), "utf8");
  return createHash("sha256").update(source).digest("hex");
}

/**
 * Metadata lives on the fixed `postgres` admin database, NOT inside the
 * template database itself -- `ALLOW_CONNECTIONS false` (set once a template
 * is marked usable) blocks every connection to the template, including
 * superuser ones, so a metadata table stored there would be unreadable
 * exactly when callers need to read it (verified directly: a superuser
 * `psql` connect to a datallowconn=false database throws "is not currently
 * accepting connections", no exception for the owning role). Keyed by
 * template name so multiple runners' templates can coexist on one cluster.
 */
const TEMPLATE_METADATA_TABLE = "pdpp_test_template_metadata";

interface TemplateMetadata {
  builtAt: string;
  runnerId: string;
  schemaSourceDigest: string;
}

async function ensureTemplateMetadataTable(admin: InstanceType<typeof Client>): Promise<void> {
  await admin.query(
    `CREATE TABLE IF NOT EXISTS ${TEMPLATE_METADATA_TABLE} (
       template_name text PRIMARY KEY,
       runner_id text NOT NULL,
       schema_source_digest text NOT NULL,
       built_at timestamptz NOT NULL DEFAULT now()
     )`
  );
}

async function writeTemplateMetadata(
  admin: InstanceType<typeof Client>,
  templateName: string,
  metadata: TemplateMetadata
): Promise<void> {
  await ensureTemplateMetadataTable(admin);
  await admin.query(
    `INSERT INTO ${TEMPLATE_METADATA_TABLE} (template_name, runner_id, schema_source_digest)
       VALUES ($1, $2, $3)
     ON CONFLICT (template_name) DO UPDATE
       SET runner_id = EXCLUDED.runner_id,
           schema_source_digest = EXCLUDED.schema_source_digest,
           built_at = now()`,
    [templateName, metadata.runnerId, metadata.schemaSourceDigest]
  );
}

async function readTemplateMetadata(
  admin: InstanceType<typeof Client>,
  templateName: string
): Promise<TemplateMetadata | null> {
  await ensureTemplateMetadataTable(admin);
  const {
    rows: [row],
  } = await admin.query<{ runner_id: string; schema_source_digest: string; built_at: string }>(
    `SELECT runner_id, schema_source_digest, built_at::text AS built_at
       FROM ${TEMPLATE_METADATA_TABLE}
      WHERE template_name = $1`,
    [templateName]
  );
  if (!row) {
    return null;
  }
  return { builtAt: row.built_at, runnerId: row.runner_id, schemaSourceDigest: row.schema_source_digest };
}

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
 * Identity check beyond `templateIsUsable`'s pg_database flags (P2 fix): the
 * template's metadata row's `schema_source_digest` must match the digest of
 * THIS process's own `postgres-storage.ts`. A clone call site that receives
 * a template name via env var (a different process than the one that built
 * it) cannot otherwise tell a template built from the current migration
 * source apart from one built by stale worker state or an unrelated prior
 * run that happened to reuse a colliding name.
 */
async function templateMatchesCurrentSchemaSource(
  admin: InstanceType<typeof Client>,
  templateName: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const metadata = await readTemplateMetadata(admin, templateName);
  if (!metadata) {
    return {
      ok: false,
      reason:
        "no metadata row found (template was not built by this codebase's own template builder, or its metadata row was lost)",
    };
  }
  const expectedDigest = await currentPostgresStorageSourceDigest();
  if (metadata.schemaSourceDigest !== expectedDigest) {
    return {
      ok: false,
      reason: `schema source digest mismatch: template was built from postgres-storage.ts digest ${metadata.schemaSourceDigest.slice(0, 12)}..., this process's postgres-storage.ts digests to ${expectedDigest.slice(0, 12)}... -- the migration/bootstrap code has changed since this template was built`,
    };
  }
  return { ok: true };
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

      // Write metadata AFTER the template is confirmed usable (marked +
      // verified), so a metadata row's presence always implies a real,
      // successfully-built template stands behind it -- never the reverse
      // ordering, which could leave a metadata row pointing at a template
      // build that failed partway through marking.
      await writeTemplateMetadata(admin, templateName, {
        builtAt: new Date().toISOString(),
        runnerId,
        schemaSourceDigest: await currentPostgresStorageSourceDigest(),
      });
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
    const identity = await templateMatchesCurrentSchemaSource(admin, templateName);
    if (!identity.ok) {
      throw new Error(
        `Postgres test template "${templateName}" failed identity verification: ${identity.reason}. Refusing to clone from a template that cannot be proven to match this process's own migration code -- a stale or foreign template could otherwise mask a real migration defect.`
      );
    }
  });
}

/** Drop the per-run template database and its metadata row. Best-effort: called during gate teardown, after which nothing else needs the template. */
export async function dropPostgresTestTemplate(baseConnectionString: string, templateName: string): Promise<void> {
  await withAdminClient(baseConnectionString, async (admin) => {
    // A template must have IS_TEMPLATE cleared before it can be dropped.
    await admin.query(`ALTER DATABASE ${quotedIdentifier(templateName)} WITH IS_TEMPLATE false`).catch(() => {
      // Best-effort: if this fails the DROP below will surface a clearer error.
    });
    await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(templateName)} WITH (FORCE)`);
    // Best-effort: an orphaned metadata row for a dropped template is inert
    // (readTemplateMetadata's caller always checks templateIsUsable's
    // pg_database flags first, which fail immediately once the database is
    // gone), but dropping it keeps the shared admin table from accumulating
    // rows for every runner that has ever passed through this cluster.
    await admin.query(`DELETE FROM ${TEMPLATE_METADATA_TABLE} WHERE template_name = $1`, [templateName]).catch(() => {
      // Best-effort: the metadata table may not exist yet on a fresh cluster.
    });
  });
}
