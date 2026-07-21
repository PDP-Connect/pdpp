/**
 * Lexical retrieval conformance — in-memory second adapter.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/lexical-retrieval-conformance.js` against an honestly-declared
 * in-memory driver (token-frequency scoring, `higher_is_better`). The
 * memory driver does not impersonate SQLite FTS5; it advertises a
 * different backend identity and a different score direction, and still
 * passes every portable invariant the harness encodes.
 *
 * Together with the SQLite run and the falsifiability run, this proves
 * the harness encodes durable lexical-retrieval obligations rather than
 * FTS5 query shape.
 *
 * Spec: openspec/changes/add-lexical-retrieval-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';

import { createMemoryLexicalRetrievalDriver } from './helpers/memory-lexical-retrieval-driver.js';
import { runLexicalRetrievalConformance } from './helpers/lexical-retrieval-conformance.js';

runLexicalRetrievalConformance({
  label: 'memory',
  test,
  makeDriver: () => createMemoryLexicalRetrievalDriver(),
});
