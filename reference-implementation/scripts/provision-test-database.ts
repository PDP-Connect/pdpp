// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI entrypoint for `provisionTestDatabase` (see
 * `server/postgres-test-database-guard.ts`), for callers that need to stamp
 * the test sentinel onto a database from outside a test process -- namely
 * CI workflows that stand up a shared Postgres service (e.g.
 * `.github/workflows/pr89-seam-receipt.yml`), which hand the suite a raw,
 * unprovisioned database via `PDPP_TEST_POSTGRES_URL` rather than creating
 * one through `withTemporaryPostgresDatabase` or the dedicated-per-file test
 * runner path (both of which already call `provisionTestDatabase` inline).
 *
 * This script does not duplicate the guard's logic or its sentinel
 * schema/table/marker names -- it only wires `provisionTestDatabase` to a
 * command-line argument so it can run as a CI step.
 */

import { provisionTestDatabase } from "../server/postgres-test-database-guard.ts";

const [, , databaseUrl] = process.argv;
if (!databaseUrl) {
  console.error("usage: provision-test-database.ts <postgres-connection-url>");
  process.exit(1);
}

await provisionTestDatabase(databaseUrl);
console.log("Provisioned test database sentinel.");
