// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed admission guard for real-Postgres TEST lanes.
 *
 * Background (the incident this exists to prevent): a Postgres-backed test
 * read `PDPP_TEST_POSTGRES_URL` and called `initPostgresStorage` directly
 * against it, provisioning no scratch database of its own. Someone ran that
 * file with the variable pointed at the PRODUCTION database. The suite wrote
 * 42 stray rows across 12 connector instances into real owner data. That was
 * the MILD outcome: these suites also do destructive setup (DELETE/TRUNCATE
 * of the streams they exercise), so the same hole could have destroyed real
 * records rather than merely littering them.
 *
 * WHY A SENTINEL AND NOT A BLACKLIST
 *
 * The tempting fix is to refuse known-production URLs (host, port, database
 * name). That fails OPEN: it only refuses the production spellings someone
 * remembered to enumerate. A new host, a container remap, a connection made
 * through a different port forward, a restored copy of production under
 * another name -- each sails straight through a blacklist, and the failure is
 * silent data loss. A URL-shape allowlist (`dedicatedPostgresTestUrl`) is
 * better and stays in force at the runner boundary, but it still only proves
 * the URL *looks* like a test URL. It cannot prove the database *behind* that
 * URL is a scratch database: the dedicated test listener also hosts hand-made
 * databases, and nothing stops a production database from being reachable at
 * a test-shaped address (a port-forward to :55447 is one command).
 *
 * So authority here is derived from the DATABASE'S OWN CONTENTS, not from its
 * address. A test database must carry a sentinel table this module writes,
 * and no admission is possible without it:
 *
 *   1. POSITIVE MARKER (fail-closed). The target must contain the sentinel
 *      table `pdpp_test_guard.pdpp_test_database_sentinel` with a matching
 *      marker row (its own schema, so a suite that legitimately runs
 *      `DROP SCHEMA public CASCADE` does not erase its own admission). A
 *      database nobody explicitly provisioned as a test database has no
 *      sentinel, so it is REFUSED BY DEFAULT. Production has no sentinel and
 *      can never acquire one by accident -- only `provisionTestDatabase()`
 *      writes it, and that function refuses to run against a database holding
 *      real data (see 2). Absence of evidence is refusal, which is what makes
 *      this fail closed: the unknown case is the refused case.
 *
 *   2. REAL-OWNER-DATA REFUSAL (defense in depth). Even WITH a sentinel, the
 *      target is refused if `public.records` is non-empty at admission time,
 *      i.e. it holds data this run did not create.
 *      This closes the residual path where a sentinel is stamped onto a
 *      database that already holds real data (a restored production dump, or
 *      a production database someone stamped by hand). Marker and data must
 *      agree; disagreement is refusal.
 *
 * Both checks run BEFORE any pool is opened for writing, and a refusal throws
 * a loud, immediate, named error. There is deliberately NO silent-skip path:
 * a skip would let CI go green while covering nothing, which is how a hole
 * like this survives. Refusal is an error, never a skip.
 *
 * The guard is scoped to test execution. It activates only for a process that
 * declares itself a test lane (`PDPP_TEST_POSTGRES_URL` set, or an explicit
 * `PDPP_REQUIRE_TEST_DATABASE=1`); the product's own production boot is
 * untouched and never consults it.
 */

import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";

/**
 * The sentinel lives in its OWN schema, not in `public`.
 *
 * A real suite (`test/browser-surface-lease-store.test.ts`) legitimately runs
 * `DROP SCHEMA public CASCADE` to prove the empty-database bootstrap path. A
 * sentinel in `public` is destroyed by that, and every later
 * `initPostgresStorage` in the file is then refused -- the guard would break
 * honest tests. Keeping the marker in a separate schema means the product's
 * own schema can be dropped and rebuilt freely while the "this database is
 * scratch" fact survives, which is the fact the guard actually needs.
 */
export const TEST_DATABASE_SENTINEL_SCHEMA = "pdpp_test_guard";

/** The sentinel table every admissible test database must carry. */
export const TEST_DATABASE_SENTINEL_TABLE = "pdpp_test_database_sentinel";

/** Fully-qualified sentinel table, safe against a `DROP SCHEMA public CASCADE`. */
const SENTINEL_RELATION = `${TEST_DATABASE_SENTINEL_SCHEMA}.${TEST_DATABASE_SENTINEL_TABLE}`;

/**
 * One-use capabilities for a real child process that must share a parent
 * test's already-admitted database. They live beside the sentinel so the
 * capability is bound to one database, not to an inherited environment URL.
 */
const CHILD_ATTACHMENT_RELATION = `${TEST_DATABASE_SENTINEL_SCHEMA}.pdpp_test_database_child_attachments`;
const CHILD_ATTACHMENT_TTL_SECONDS = 60;

/** The marker value written into the sentinel table. */
export const TEST_DATABASE_SENTINEL_MARKER = "pdpp-ephemeral-test-database";

/**
 * Tables whose contents mean "this database holds real owner data". `records`
 * is the substantive one -- it is where the incident's stray rows landed and
 * where real personal data lives.
 */
const OWNER_DATA_TABLE = "records";

export class ProductionDatabaseRefusedError extends Error {
  readonly code = "PDPP_PRODUCTION_DATABASE_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "ProductionDatabaseRefusedError";
  }
}

/** Redact credentials so a refusal can name the target without leaking a password. */
export function describeTarget(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "<unparseable database url>";
  }
}

/**
 * True when this process is a test lane whose Postgres target must be proven
 * to be a scratch database. Product/production boots return false and are
 * never subject to the sentinel requirement.
 */
export function testDatabaseGuardActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PDPP_TEST_POSTGRES_URL) || env.PDPP_REQUIRE_TEST_DATABASE === "1";
}

async function withClient<T>(databaseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function relationExists(client: Client, qualifiedRelation: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [
    qualifiedRelation,
  ]);
  return result.rows[0]?.exists === true;
}

function childAttachmentDigest(attachment: string): string {
  return createHash("sha256").update(attachment).digest("hex");
}

async function assertProvisionedTestDatabase(client: Client, target: string): Promise<void> {
  if (!(await relationExists(client, SENTINEL_RELATION))) {
    throw new ProductionDatabaseRefusedError(
      `REFUSING to run tests against ${target}: it carries no "${SENTINEL_RELATION}" table, so it is NOT a provisioned test database and may be PRODUCTION. Tests must run against a database provisioned by provisionTestDatabase() (the RI test runner does this per file). This is fail-closed by design: an unmarked database is always refused.`
    );
  }
  const marker = await client.query<{ marker: string }>(`SELECT marker FROM ${SENTINEL_RELATION} WHERE marker = $1`, [
    TEST_DATABASE_SENTINEL_MARKER,
  ]);
  if (marker.rows.length === 0) {
    throw new ProductionDatabaseRefusedError(
      `REFUSING to run tests against ${target}: "${SENTINEL_RELATION}" exists but carries no "${TEST_DATABASE_SENTINEL_MARKER}" marker row, so this database was not provisioned as a PDPP test database.`
    );
  }
}

async function assertNoOwnerDataAtAdmission(client: Client, target: string): Promise<void> {
  if (await relationExists(client, `public.${OWNER_DATA_TABLE}`)) {
    const preexisting = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.${OWNER_DATA_TABLE}`
    );
    const rowCount = Number(preexisting.rows[0]?.count ?? "0");
    if (rowCount > 0) {
      throw new ProductionDatabaseRefusedError(
        `REFUSING to run tests against ${target}: it carries a test sentinel BUT already holds ${rowCount} row(s) in "${OWNER_DATA_TABLE}" at admission time. This is pre-existing data in a database marked as scratch -- refusing rather than writing into it.`
      );
    }
  }
}

/**
 * Stamp a database as an ephemeral test database.
 *
 * Refuses to stamp a database that already holds owner data, so a sentinel can
 * never be minted onto production (or onto a restored production dump). This
 * is what keeps check (1) honest: the marker cannot be obtained by a database
 * that has real records in it.
 */
export async function provisionTestDatabase(databaseUrl: string): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    if (await relationExists(client, `public.${OWNER_DATA_TABLE}`)) {
      const existing = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.${OWNER_DATA_TABLE}`
      );
      const rowCount = Number(existing.rows[0]?.count ?? "0");
      if (rowCount > 0) {
        throw new ProductionDatabaseRefusedError(
          `REFUSING to provision a test sentinel on ${describeTarget(databaseUrl)}: it already contains ${rowCount} row(s) in "${OWNER_DATA_TABLE}", so it holds real data and is NOT a scratch test database. Point PDPP_TEST_POSTGRES_URL at a dedicated, empty test database.`
        );
      }
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_DATABASE_SENTINEL_SCHEMA}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${SENTINEL_RELATION} (
         marker text PRIMARY KEY,
         provisioned_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    await client.query(`INSERT INTO ${SENTINEL_RELATION} (marker) VALUES ($1) ON CONFLICT DO NOTHING`, [
      TEST_DATABASE_SENTINEL_MARKER,
    ]);
  });
}

/**
 * Admit `databaseUrl` for test use, or throw.
 *
 * Throws `ProductionDatabaseRefusedError` when the target lacks the sentinel
 * (the default for any database nobody provisioned as a test database --
 * production included) or when it holds owner data predating the sentinel.
 * Never returns a "skip" signal: a refusal is always an error.
 */
export async function assertTestDatabase(databaseUrl: string): Promise<void> {
  const target = describeTarget(databaseUrl);
  await withClient(databaseUrl, async (client) => {
    // Defense in depth: a sentinel alone is not enough. `provisionTestDatabase`
    // only stamps an empty database, so at stamping time `records` held zero
    // rows. Any row present here that this run did not create therefore means
    // the sentinel was minted onto a database that has since acquired -- or
    // always held -- real data (a restored production dump, or a hand-stamped
    // real database). `records` is checked for emptiness at admission, BEFORE
    // the suite writes anything: within a run, admission happens first, so a
    // non-empty `records` at this moment is never this run's own output.
    //
    // Note: `records` deliberately has no created_at/ingested-at column to key
    // a time comparison off, so "predates this run" is expressed as "present
    // at admission time" -- which is the stricter and simpler test.
    await assertProvisionedTestDatabase(client, target);
    await assertNoOwnerDataAtAdmission(client, target);
  });
}

/**
 * Mint a short-lived, single-use child capability after ordinary empty
 * admission. This exists only for deterministic parent/child race fixtures:
 * the parent admits the empty database, then writes the state the child must
 * observe. The capability is stored in that same database and cannot admit a
 * different target.
 */
export async function createAlreadyAdmittedTestDatabaseChildAttachment(databaseUrl: string): Promise<string> {
  const target = describeTarget(databaseUrl);
  const attachment = randomBytes(32).toString("base64url");
  await withClient(databaseUrl, async (client) => {
    await assertProvisionedTestDatabase(client, target);
    await assertNoOwnerDataAtAdmission(client, target);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${CHILD_ATTACHMENT_RELATION} (
         attachment_digest text PRIMARY KEY,
         expires_at timestamptz NOT NULL
       )`
    );
    await client.query(`DELETE FROM ${CHILD_ATTACHMENT_RELATION} WHERE expires_at <= now()`);
    await client.query(
      `INSERT INTO ${CHILD_ATTACHMENT_RELATION} (attachment_digest, expires_at)
       VALUES ($1, now() + ($2 * interval '1 second'))`,
      [childAttachmentDigest(attachment), CHILD_ATTACHMENT_TTL_SECONDS]
    );
  });
  return attachment;
}

/**
 * Consume a parent-minted child capability. This deliberately does not rerun
 * the empty-row check: the parent proved emptiness before minting it, and the
 * child is attaching specifically to observe the rows its parent then wrote.
 * Sentinel validation and an atomic, database-local, one-use claim keep this
 * test-only seam from authorizing arbitrary populated databases.
 */
export async function claimAlreadyAdmittedTestDatabaseChildAttachment(
  databaseUrl: string,
  attachment: string | undefined
): Promise<void> {
  const target = describeTarget(databaseUrl);
  if (!attachment) {
    throw new ProductionDatabaseRefusedError(
      `REFUSING to run tests against ${target}: a child attaching to an already-admitted test database requires a parent-minted attachment capability.`
    );
  }
  await withClient(databaseUrl, async (client) => {
    await assertProvisionedTestDatabase(client, target);
    if (!(await relationExists(client, CHILD_ATTACHMENT_RELATION))) {
      throw new ProductionDatabaseRefusedError(
        `REFUSING to run tests against ${target}: it has no parent-minted child attachment capability.`
      );
    }
    const claimed = await client.query<{ attachment_digest: string }>(
      `DELETE FROM ${CHILD_ATTACHMENT_RELATION}
        WHERE attachment_digest = $1 AND expires_at > now()
        RETURNING attachment_digest`,
      [childAttachmentDigest(attachment)]
    );
    if (claimed.rows.length === 0) {
      throw new ProductionDatabaseRefusedError(
        `REFUSING to run tests against ${target}: the child attachment capability is missing, expired, or already consumed.`
      );
    }
  });
}
