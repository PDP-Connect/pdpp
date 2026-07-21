// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record read conformance — Postgres second adapter (env-gated).
 *
 * Runs the reusable conformance scenarios from
 * `helpers/record-read-conformance.js` against a Postgres-backed driver
 * that re-implements record-read directly in Postgres, with no coupling to
 * the SQLite reference helpers (`server/records.js`, `server/db.js`,
 * `server/auth.js`). This is the env-gated half of the second-adapter
 * proof: a *portable* read-side proof that the harness pins PDPP behavior
 * rather than SQLite accidents.
 *
 * Environment gate:
 *   - When `PDPP_TEST_POSTGRES_URL` is set, each scenario provisions a
 *     fresh, uniquely-named schema in `setup()` and drops it in
 *     `teardown()`, so concurrent runs and partial failures stay
 *     contained. The expected target is the Compose Postgres proof
 *     service (see `add-compose-postgres-proof-service`).
 *   - When the env var is unset, this file registers a single skipped
 *     test so the suite still acknowledges the proof exists but does not
 *     fail in environments without Postgres.
 *
 * The Postgres dependency (`pg`) is dev-scoped on
 * `reference-implementation` because this is a test-only spike. There is
 * no production Postgres adapter, no `PDPP_STORAGE_BACKEND`, no
 * `PDPP_DATABASE_URL`, and no Kysely being introduced.
 *
 * Spec: openspec/changes/add-record-read-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 *       (second-adapter requirement from
 *        openspec/changes/add-second-conformance-adapters/).
 */

import test from 'node:test';

import { createPostgresRecordReadDriver } from './helpers/postgres-record-read-driver.js';
import { runRecordReadConformance } from './helpers/record-read-conformance.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('postgres record-read conformance (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  runRecordReadConformance({
    label: 'postgres',
    test,
    makeDriver: () =>
      createPostgresRecordReadDriver({ connectionString: POSTGRES_URL }),
  });
}
