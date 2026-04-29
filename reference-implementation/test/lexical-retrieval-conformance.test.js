/**
 * Lexical retrieval conformance — SQLite reference driver.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/lexical-retrieval-conformance.js` against the current SQLite
 * FTS5-backed reference implementation (`searchIndexInsertRow`,
 * `searchIndexDeleteByRecordKey`, `searchIndexDeleteByStream`,
 * `bm25(lexical_search_index)`, `snippet(...)`).
 *
 * This run pins the FTS5 reference's lexical semantics. The existing
 * public-contract tests in `lexical-retrieval.test.js` still cover the
 * `/v1/search` HTTP route end-to-end; this suite is the storage-level
 * conformance baseline before any future `LexicalIndex` extraction.
 *
 * Spec: openspec/changes/add-lexical-retrieval-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';

import { runLexicalRetrievalConformance } from './helpers/lexical-retrieval-conformance.js';
import { createSqliteLexicalRetrievalDriver } from './helpers/sqlite-lexical-retrieval-driver.js';

runLexicalRetrievalConformance({
  label: 'sqlite-reference',
  test,
  makeDriver: () => createSqliteLexicalRetrievalDriver(),
});
