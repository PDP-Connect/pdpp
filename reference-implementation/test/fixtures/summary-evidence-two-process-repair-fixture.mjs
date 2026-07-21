/**
 * Genuine second-OS-process participant for the connector-summary-evidence
 * SQLite interleaving oracle
 * (test/connector-summary-evidence-engine-two-process-interleaving.test.js).
 *
 * better-sqlite3 is fully synchronous and single-connection within one
 * Node.js process, so no amount of `async`/`await` juggling inside ONE
 * process can construct a genuine concurrent read-then-write race — the
 * event loop guarantees the two calls never truly overlap. A real race
 * against SQLite's WAL-mode write lock requires a SECOND OS process with its
 * own SQLite connection against the SAME database file. This script is that
 * second process.
 *
 * Protocol (stdio-based, matching this repo's existing spawned-fixture
 * pattern in test/fixtures/device-ingest-failstop-server.mjs):
 *   1. Opens the database file at PDPP_TWO_PROCESS_FIXTURE_DB_PATH.
 *   2. Prints `{"ready":true}` to stdout once open.
 *   3. Blocks (waiting for a single line) on stdin for the parent's "go".
 *   4. On "go", immediately calls reconcileConnectorSummaryEvidence for
 *      PDPP_TWO_PROCESS_FIXTURE_CONNECTOR_INSTANCE_ID. The engine's
 *      test-only PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS hook (set via
 *      inherited env, same value the parent uses) holds whichever process
 *      wins BEGIN IMMEDIATE inside its transaction for the delay window,
 *      forcing the loser to genuinely block on SQLite's write lock rather
 *      than racing on timing luck.
 *   5. Prints one final JSON line with the repair result and exits 0, or
 *      prints `{"error":...}` and exits 1 on any thrown error.
 */
import { createInterface } from 'node:readline';

import { closeDb, initDb } from '../../server/db.js';
import { reconcileConnectorSummaryEvidence } from '../../server/connector-summary-evidence-engine.ts';

const dbPath = process.env.PDPP_TWO_PROCESS_FIXTURE_DB_PATH;
const connectorInstanceId = process.env.PDPP_TWO_PROCESS_FIXTURE_CONNECTOR_INSTANCE_ID;
if (!dbPath || !connectorInstanceId) {
  throw new Error('two-process repair fixture requires PDPP_TWO_PROCESS_FIXTURE_DB_PATH and PDPP_TWO_PROCESS_FIXTURE_CONNECTOR_INSTANCE_ID');
}

initDb(dbPath);

async function waitForGoLine() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  return new Promise((resolve) => {
    rl.once('line', (line) => {
      rl.close();
      resolve(line);
    });
  });
}

process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);

try {
  await waitForGoLine();
  const startedAt = Date.now();
  const result = await reconcileConnectorSummaryEvidence([connectorInstanceId]);
  const finishedAt = Date.now();
  process.stdout.write(`${JSON.stringify({ pid: process.pid, startedAt, finishedAt, result })}\n`);
  closeDb();
  process.exit(0);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, error: error instanceof Error ? error.message : String(error) })}\n`);
  closeDb();
  process.exit(1);
}
