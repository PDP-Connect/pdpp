// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { assertTestDatabase } from "../server/postgres-test-database-guard.ts";
import { dedicatedPostgresTestUrl } from "../test/helpers/dedicated-postgres-test-url.ts";

export interface PostgresProfilePreflightOptions {
  assertDatabase?: (url: string) => Promise<void>;
  isDedicatedUrl?: (url: string | undefined) => string | null;
  primaryUrl: string | undefined;
  profile: "memory-default" | "postgres";
  restoreUrl: string | undefined;
}

function databaseIdentity(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.username}@${parsed.hostname}:${parsed.port}${parsed.pathname}`;
}

/**
 * Prove every persistent PostgreSQL target before any test child can run.
 *
 * The ordinary runner creates and sentinel-provisions a fresh database for
 * each file. The backup/restore oracle additionally uses its configured
 * restore URL directly, so it needs the same admission check at the profile
 * boundary. Checking the primary URL too keeps the operator's base target
 * disposable and makes its role explicit.
 */
export async function assertPostgresProfilePreflight({
  assertDatabase = assertTestDatabase,
  isDedicatedUrl = dedicatedPostgresTestUrl,
  primaryUrl,
  profile,
  restoreUrl,
}: PostgresProfilePreflightOptions): Promise<void> {
  if (profile === "memory-default") {
    return;
  }
  const primary = isDedicatedUrl(primaryUrl);
  if (!primary) {
    throw new Error("PDPP_TEST_POSTGRES_URL must be a query- and fragment-free dedicated loopback PostgreSQL test URL");
  }
  if (!restoreUrl) {
    throw new Error("postgres profile requires PDPP_TEST_POSTGRES_RESTORE_URL");
  }
  const restore = isDedicatedUrl(restoreUrl);
  if (!restore) {
    throw new Error(
      "PDPP_TEST_POSTGRES_RESTORE_URL must be a query- and fragment-free dedicated loopback PostgreSQL test URL"
    );
  }
  if (databaseIdentity(primary) === databaseIdentity(restore)) {
    throw new Error("PDPP_TEST_POSTGRES_RESTORE_URL must name a database distinct from PDPP_TEST_POSTGRES_URL");
  }
  await assertDatabase(primary);
  await assertDatabase(restore);
}
