// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import { currentTestFileIsPostgresTemplateEligible } from "../../scripts/postgres-template-eligibility.ts";
import { assertPostgresTestTemplateUsable } from "../../scripts/postgres-test-template.ts";
import { provisionTestDatabase } from "../../server/postgres-test-database-guard.ts";

const { Pool } = pg;

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

async function waitForDatabaseConnectionsToClose(
  admin: InstanceType<typeof Pool>,
  databaseName: string,
  deadlineMs: number
): Promise<void> {
  const result = await admin.query<{ connection_count: number }>(
    `SELECT count(*)::integer AS connection_count
       FROM pg_stat_activity
      WHERE datname = $1
        AND pid <> pg_backend_pid()`,
    [databaseName]
  );
  if (Number(result.rows[0]?.connection_count ?? 0) === 0 || Date.now() >= deadlineMs) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  await waitForDatabaseConnectionsToClose(admin, databaseName, deadlineMs);
}

/**
 * Run a callback against a disposable database on a shared Postgres cluster.
 *
 * `DROP DATABASE ... WITH (FORCE)` is deliberate: test failures or a missed
 * pool shutdown must not turn into a durable database leak on the proof
 * cluster. The repository's Postgres test image is pg16, which supports it.
 */
export async function withTemporaryPostgresDatabase(
  {
    connectionString,
    databaseName,
    closeConnections,
    templateName = currentTestFileIsPostgresTemplateEligible() ? process.env.PDPP_TEST_POSTGRES_TEMPLATE : null,
    templateIdentity = templateName && templateName === process.env.PDPP_TEST_POSTGRES_TEMPLATE
      ? process.env.PDPP_TEST_POSTGRES_TEMPLATE_IDENTITY
      : undefined,
  }: {
    connectionString: string;
    databaseName: string;
    closeConnections?: () => Promise<void>;
    /**
     * Identity token the run that built `templateName` handed this process
     * (PDPP_TEST_POSTGRES_TEMPLATE_IDENTITY, set by scripts/run-tests.ts
     * beside PDPP_TEST_POSTGRES_TEMPLATE). When present, the clone-time
     * check refuses any template whose recorded identity differs, so a
     * same-named template from another run or an altered metadata row is
     * never cloned. Defaults from the environment whenever `templateName`
     * is the run's own template.
     */
    templateIdentity?: string;
    /**
     * Clone from this Postgres TEMPLATE database instead of bootstrapping
     * schema from scratch inside the callback.
     *
     * DEFAULT IS COLD. The default resolves PDPP_TEST_POSTGRES_TEMPLATE (set
     * by scripts/run-tests.ts when it built a per-run template) only when
     * the CURRENTLY RUNNING test file appears on the explicit allowlist in
     * scripts/postgres-template-eligibility.ts; every other file -- and any
     * file that registry has never heard of -- defaults to `null` (a real,
     * from-scratch bootstrap), regardless of whether a template happens to
     * exist for this run. This is deliberate: cold-bootstrap, migration,
     * recovery, receipt, and deadlock authority tests must never be able to
     * silently start passing against an already-migrated clone because a
     * template happened to be built for some *other* file in the same run.
     * Pass an explicit `string` to opt a specific call site into templating
     * regardless of file eligibility, or explicit `null` to force cold
     * regardless of eligibility (e.g. a test that specifically wants to
     * exercise cold bootstrap from inside an otherwise-eligible file).
     */
    templateName?: string | null;
  },
  callback: (databaseUrl: string) => Promise<unknown>
): Promise<unknown> {
  const admin = new Pool({ connectionString: adminUrl(connectionString) });
  const database = quotedIdentifier(databaseName);
  let created = false;
  // biome-ignore lint/suspicious/noEvolvingTypes: localized test assertion preserves its explicit contract.
  // biome-ignore lint/suspicious/noImplicitAnyLet: localized test assertion preserves its explicit contract.
  let result;
  // biome-ignore lint/suspicious/noEvolvingTypes: localized test assertion preserves its explicit contract.
  // biome-ignore lint/suspicious/noImplicitAnyLet: localized test assertion preserves its explicit contract.
  let operationError;

  try {
    if (templateName) {
      // Fail loudly if the template is missing/stale rather than silently
      // falling back to a from-scratch CREATE DATABASE -- a quiet fallback
      // would hide a broken template behind a normal-looking (slow) pass.
      await assertPostgresTestTemplateUsable(connectionString, templateName, { expectedIdentity: templateIdentity });
    }
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    // Identifier is safe: quotedIdentifier() already escaped databaseName;
    // templateName here is always either undefined/null or a value this
    // same process received from run-tests.ts's own runnerId-derived name
    // (scripts/postgres-test-template.ts), never external input.
    await admin.query(
      templateName
        ? `CREATE DATABASE ${database} TEMPLATE ${quotedIdentifier(templateName)}`
        : `CREATE DATABASE ${database}`
    );
    created = true;
    const createdUrl = databaseUrl(connectionString, databaseName);
    if (!templateName) {
      // This helper is the OTHER place (besides the test runner) that brings
      // a scratch Postgres database into existence, so it is the other place
      // that must stamp the test sentinel. Without the stamp,
      // `initPostgresStorage` fail-closed refuses the database the callback
      // was just handed -- correctly, since an unmarked database is
      // indistinguishable from production to the guard. The database was
      // created empty one statement ago, so stamping it is honest. When
      // cloning from a template, the clone already carries the template's own
      // sentinel row byte-for-byte, so stamping again would be redundant (not
      // wrong -- provisionTestDatabase is idempotent -- but the whole point of
      // templating is skipping exactly this kind of extra round-trip).
      await provisionTestDatabase(createdUrl);
    }
    result = await callback(createdUrl);
  } catch (error) {
    operationError = error;
  }

  // biome-ignore lint/suspicious/noEvolvingTypes: localized test assertion preserves its explicit contract.
  const cleanupErrors = [];

  if (created) {
    if (closeConnections) {
      try {
        await closeConnections();
        // node-postgres can resolve Pool.end() immediately before the server
        // observes the final client socket disconnect. Give that graceful
        // shutdown a bounded window before the FORCE fallback below; otherwise
        // DROP can deliver an administrator-command error to an already-finished
        // test request and turn clean teardown into a nondeterministic failure.
        await waitForDatabaseConnectionsToClose(admin, databaseName, Date.now() + 2000);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  try {
    await admin.end();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      `temporary Postgres database operation and cleanup both failed for ${databaseName}`
    );
  }
  if (operationError) {
    throw operationError;
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, `could not clean up temporary Postgres database ${databaseName}`);
  }

  return result;
}
