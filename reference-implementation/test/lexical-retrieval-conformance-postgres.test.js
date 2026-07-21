// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs the shared lexical-retrieval conformance suite against the REAL Postgres
 * lexical search path, the search-side analogue of
 * `record-read-conformance-postgres.test.js`.
 *
 *   - When `PDPP_TEST_POSTGRES_URL` is set, each scenario provisions a fresh
 *     driver that calls the production `postgresLexical*` functions against the
 *     configured Postgres test database.
 *   - When the env var is unset, this file registers a single skipped test so
 *     the suite stays green in environments without a Postgres service.
 *
 * Before this file, the lexical-retrieval conformance contract was pinned only
 * against the SQLite and memory backends, so the Postgres lexical path could
 * diverge from the declared behavior without any test failing.
 */

import test from 'node:test';
import { createPostgresLexicalRetrievalDriver } from './helpers/postgres-lexical-retrieval-driver.js';
import { runLexicalRetrievalConformance } from './helpers/lexical-retrieval-conformance.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('postgres lexical-retrieval conformance (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  runLexicalRetrievalConformance({
    label: 'postgres',
    test,
    makeDriver: () => createPostgresLexicalRetrievalDriver({ databaseUrl: POSTGRES_URL }),
  });
}
