// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Postgres-backed reproduction of the live Codex enrollment blocker
// (decouple-device-enrollment-from-ingest-writer-admission, design D1).
//
// On the real Postgres backend, enrollment used to run a retrieval-index
// backfill inside `withConnectorInstanceWrite` — the SAME writer-admission gate
// and `pg_try_advisory_lock` that bulk ingest holds. When that gate is
// saturated, enrollment blocked on lock acquisition (the observed client hang
// with an idle Postgres session) or was rejected with connector_instance_busy.
//
// This test saturates the global admission gate (active limit forced to 1) by
// holding one writer on an unrelated instance, then drives a real enroll. After
// D1 the enroll no longer enters the fence, so it completes promptly. Before D1
// it would block until the held writer released (or time out as busy).
//
// Skipped unless PDPP_TEST_POSTGRES_URL points at the dedicated loopback
// listener.

import assert from 'node:assert/strict';
import test from 'node:test';

import { COLLECTOR_PROTOCOL_VERSION } from '../server/collector-protocol.ts';
import { closeDb, initDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { withConnectorInstanceWrite } from '../server/connector-instance-write-coordinator.ts';
import { closePostgresStorage } from '../server/postgres-storage.js';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';
import { withTemporaryPostgresDatabase } from './helpers/postgres-temp-database.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(POSTGRES_URL);
const PROTOCOL_HEADERS = { 'X-PDPP-Collector-Protocol': COLLECTOR_PROTOCOL_VERSION };

let dbCounter = 0;
function tempDbName() {
  dbCounter += 1;
  return `pdpp_enroll_admission_${process.pid}_${dbCounter}`;
}

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('D1 (Postgres): enroll completes while the writer-admission gate is saturated by unrelated ingest', {
  skip: DEDICATED_POSTGRES_URL ? false : 'set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener',
}, async () => {
  const previousLimit = process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT;
  // Force the global admission gate down to a single active writer so one held
  // writer saturates it — the deterministic stand-in for live bulk ingest.
  process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT = '1';
  try {
    await withTemporaryPostgresDatabase(
      { connectionString: DEDICATED_POSTGRES_URL, databaseName: tempDbName(), closeConnections: closePostgresStorage },
      async (url) => {
        initDb(':memory:');
        const server = await startServer({
          quiet: true,
          asPort: 0,
          rsPort: 0,
          dbPath: ':memory:',
          storageBackend: 'postgres',
          databaseUrl: url,
        });
        await server.startupBackfillDone?.catch(() => undefined);
        const asUrl = `http://localhost:${server.asPort}`;
        try {
          // Saturate the single admission slot with a held writer on an
          // unrelated instance — this is what bulk ingest does live.
          const entered = deferred();
          const release = deferred();
          const held = withConnectorInstanceWrite('cin_unrelated_bulk_ingest', async () => {
            entered.resolve();
            await release.promise;
          });
          await entered.promise;

          // Mint + exchange an enrollment code WHILE the gate is saturated.
          const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
            connector_id: 'codex',
            local_binding_name: 'codex-home-admission',
          });
          assert.equal(codeResp.status, 201);

          // A coupled enroll (pre-D1) would block on admission until the held
          // writer releases (or time out as busy). We enroll WITHOUT releasing
          // the writer, and bound the wait: if the enroll does not resolve while
          // the gate is held, it is still coupled to the ingest fence. Release
          // is guaranteed afterward so teardown never hangs on the held writer.
          let enrollResp;
          try {
            enrollResp = await Promise.race([
              postJson(
                `${asUrl}/_ref/device-exporters/enroll`,
                { enrollment_code: codeResp.body.enrollment_code },
                PROTOCOL_HEADERS,
              ),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error('enroll did not resolve while the writer gate was held — still coupled to the ingest fence')),
                  6000,
                ),
              ),
            ]);
          } finally {
            release.resolve();
            await held.catch(() => undefined);
          }

          // After D1 the enroll does not touch the fence, so it returns 201 with
          // a device token even though the only writer slot is held elsewhere.
          assert.equal(enrollResp.status, 201, 'enroll must succeed while the writer gate is saturated');
          assert.ok(enrollResp.body.device_token, 'enroll must return a device token');
          assert.match(enrollResp.body.connector_instance_id, /^cin_/);
        } finally {
          await closeServer(server);
          await closePostgresStorage().catch(() => undefined);
          closeDb();
        }
      },
    );
  } finally {
    if (previousLimit === undefined) {
      delete process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT;
    } else {
      process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT = previousLimit;
    }
  }
});
