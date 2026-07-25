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
import { createHash } from 'node:crypto';
import test from 'node:test';

import { COLLECTOR_PROTOCOL_VERSION } from '../server/collector-protocol.ts';
import { closeDb, initDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { withConnectorInstanceWrite } from '../server/connector-instance-write-coordinator.ts';
import { closePostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import { __setEnrollPhaseFaultHookForTest } from '../server/routes/ref-device-exporters.ts';
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

async function mintCode(asUrl, localBindingName, connectorId = 'codex') {
  const code = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: connectorId,
    local_binding_name: localBindingName,
  });
  assert.equal(code.status, 201, JSON.stringify(code.body));
  return code.body.enrollment_code;
}

async function exchangeCode(asUrl, enrollmentCode) {
  return await postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { enrollment_code: enrollmentCode },
    PROTOCOL_HEADERS,
  );
}

async function enrollDevice(asUrl, localBindingName, connectorId = 'codex') {
  const enrollmentCode = await mintCode(asUrl, localBindingName, connectorId);
  const enrolled = await exchangeCode(asUrl, enrollmentCode);
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  return enrolled.body;
}

function canonicalValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) output[key] = canonicalValue(value[key]);
  }
  return output;
}

function bodyHash(records) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(records))).digest('hex');
}

function messageRecord(id, timestamp = '2026-07-16T00:00:00.000Z') {
  return {
    stream: 'messages',
    record_key: id,
    emitted_at: timestamp,
    data: { id, session_id: id, role: 'user', content: 'seed', type: 'text', timestamp },
  };
}

async function ingestOneRecord(asUrl, device) {
  const records = [messageRecord(`msg_${device.device_id}`)];
  const batch = {
    batch_id: `batch_${device.device_id}`,
    batch_seq: 1,
    body_hash: bodyHash(records),
    connector_id: device.connector_id,
    device_id: device.device_id,
    records,
    source_instance_id: device.source_instance_id,
  };
  const response = await postJson(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
    batch,
    { Authorization: `Bearer ${device.device_token}`, ...PROTOCOL_HEADERS },
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.status, 'accepted', JSON.stringify(response.body));
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

// Live counterexample (post-deploy, f0a6fe0fe): a direct enroll POST returned a
// typed 503 connector_instance_busy while the fresh code stayed pending, with
// controller_active_runs=0 and an idle Postgres session after
// `SELECT pg_try_advisory_lock`. D1 only skips `ensureReferenceConnectorCatalogEntry`'s
// retrieval-index backfill (`registerConnector(..., { backfillRetrievalIndexes: false })`).
// `registerConnector` (auth.js) ALSO unconditionally runs
// `postgresBackfillRecordSortPositionsForManifest` on the Postgres branch, BEFORE the
// `backfillRetrievalIndexes` short-circuit. That function enumerates every
// `connector_instance_id` already holding records under the manifest's `connector_id`
// (`codex` / `claude-code` — shared across every device enrolled for that connector
// type, not scoped to the instance being enrolled) and takes `withConnectorInstanceWrite`
// — the SAME fence bulk ingest holds — for each one it finds. The design.md "zero rows
// for a fresh enroll" argument only holds for the very first-ever enroll of a connector
// type; it is false once ANY device has ever ingested a record for that connector_id,
// which is the live steady state, not a fresh install.
//
// This test enrolls and ingests one record for a FIRST codex device (populating
// `records` for connector_id=codex), then saturates the admission gate on that first
// device's connector_instance_id, then enrolls a SECOND, independent codex device while
// the gate is held. Before D4 this reproduces the live failure (blocks on the fence /
// times out as busy). After D4 the second enroll completes promptly.
test('D4 (Postgres): a SECOND enroll for an already-ingesting connector type completes while the writer-admission gate is saturated', {
  skip: DEDICATED_POSTGRES_URL ? false : 'set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener',
}, async () => {
  const previousLimit = process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT;
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
          // First device: real enroll + real ingest, so `records` now has a
          // row under connector_id=codex for THIS device's connector_instance_id.
          const firstDevice = await enrollDevice(asUrl, 'codex-first-device');
          await ingestOneRecord(asUrl, firstDevice);

          // Saturate the single admission slot with a held writer on the
          // FIRST device's connector_instance_id — this is what bulk ingest
          // does live while a collector drains.
          const entered = deferred();
          const release = deferred();
          const held = withConnectorInstanceWrite(firstDevice.connector_instance_id, async () => {
            entered.resolve();
            await release.promise;
          });
          await entered.promise;

          // Mint + exchange a SECOND, independent codex enrollment code WHILE
          // the first device's fence is held. A coupled enroll (pre-D4) runs
          // postgresBackfillRecordSortPositionsForManifest, which enumerates
          // connector_instance_id's for connector_id=codex — including the
          // first device's — and blocks entering its held fence.
          const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
            connector_id: 'codex',
            local_binding_name: 'codex-second-device',
          });
          assert.equal(codeResp.status, 201);

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
                  () => reject(new Error(
                    'second enroll did not resolve while the first device\'s writer gate was held — ' +
                    'still coupled to the ingest fence via postgresBackfillRecordSortPositionsForManifest',
                  )),
                  6000,
                ),
              ),
            ]);
          } finally {
            release.resolve();
            await held.catch(() => undefined);
          }

          assert.equal(enrollResp.status, 201, 'second enroll must succeed while the first device\'s writer gate is saturated');
          assert.ok(enrollResp.body.device_token, 'second enroll must return a device token');
          assert.notEqual(
            enrollResp.body.connector_instance_id,
            firstDevice.connector_instance_id,
            'the two devices must remain distinct connector instances',
          );
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

// Live counterexample (post-deploy, ace356a7d): the same PENDING code returned
// HTTP 500 / Postgres 23505 duplicate connector_instances_pkey on retry.
// Causal sequence proven here: a first enroll attempt reaches identity
// creation (device, connector instance, source instance all durably written),
// then fails BEFORE consumeEnrollmentCode — the code stays `pending` while the
// identity rows persist. Before D5, retrying that still-pending code re-runs
// performFirstEnrollment from scratch: it generates a FRESH random device_id
// and source_instance_id (no way to know a device already exists for this
// code), but connector_instances' id is independently deterministic from
// (owner, connector, source_kind, source_binding_key) — unrelated to the
// device_id — so the retry's INSERT collides with the orphaned first
// attempt's row on connector_instances_pkey. D2 does not help: it only
// activates for a CONSUMED code (the transport-loss-after-consume case); this
// code never reached consume.
//
// This test injects the exact failure point via __setEnrollPhaseFaultHookForTest
// ("after_identity_before_consume", wired in performFirstEnrollment right after
// upsertSourceInstance and before the credential rotation + consume), then
// retries the SAME still-pending code with the hook cleared. Asserts: the
// retry returns 201 (not 500/23505), consumes the code exactly once, and
// converges on ONE device / ONE source instance / ONE connector instance / ONE
// active credential — never two.
test('D5 (Postgres): retrying a still-PENDING code after a partial first attempt (identity created, consume never reached) resumes idempotently', {
  skip: DEDICATED_POSTGRES_URL ? false : 'set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener',
}, async () => {
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
        const enrollmentCode = await mintCode(asUrl, 'codex-partial-write');

        // First attempt: identity creation succeeds, then the injected fault
        // throws before consumeEnrollmentCode runs. The code must remain
        // pending and no response is ever sent for this attempt.
        __setEnrollPhaseFaultHookForTest((point) => {
          if (point === 'after_identity_before_consume') {
            throw new Error('injected: writer-pressure failure after identity creation, before consume');
          }
        });
        try {
          await exchangeCode(asUrl, enrollmentCode);
        } finally {
          __setEnrollPhaseFaultHookForTest(null);
        }

        const codeRow = await postgresQuery('SELECT status, device_id FROM device_enrollment_codes');
        assert.equal(codeRow.rows[0]?.status, 'pending', 'code must remain pending after the partial first attempt');

        const devicesAfterFirstAttempt = await postgresQuery('SELECT device_id FROM device_exporters');
        assert.equal(devicesAfterFirstAttempt.rows.length, 1, 'identity creation must have left exactly one orphaned device row');

        // Retry the SAME still-pending code with the fault cleared. This must
        // NOT re-run identity creation from scratch (which would 23505 on the
        // deterministic connector_instances row) — it must resume.
        const retryResp = await exchangeCode(asUrl, enrollmentCode);
        assert.equal(retryResp.status, 201, `retry of a partial-write pending code must return 201, got: ${JSON.stringify(retryResp.body)}`);
        assert.ok(retryResp.body.device_token, 'retry must return a device token');
        assert.match(retryResp.body.connector_instance_id, /^cin_/);

        // Convergence: exactly one device, one source instance, one connector
        // instance, one active credential — never two, regardless of how many
        // attempts touched this code.
        const devices = await postgresQuery('SELECT device_id FROM device_exporters');
        assert.equal(devices.rows.length, 1, 'exactly one device must exist after resume');
        assert.equal(devices.rows[0].device_id, retryResp.body.device_id);

        const sourceInstances = await postgresQuery(
          'SELECT source_instance_id FROM device_source_instances WHERE device_id = $1',
          [retryResp.body.device_id],
        );
        assert.equal(sourceInstances.rows.length, 1, 'exactly one source instance must exist for the device');

        const connectorInstances = await postgresQuery(
          'SELECT connector_instance_id FROM connector_instances WHERE connector_id = $1',
          ['codex'],
        );
        assert.equal(connectorInstances.rows.length, 1, 'exactly one connector instance must exist for this binding');

        const activeCredentials = await postgresQuery(
          "SELECT credential_id FROM device_ingest_credentials WHERE device_id = $1 AND status = 'active'",
          [retryResp.body.device_id],
        );
        assert.equal(activeCredentials.rows.length, 1, 'exactly one active credential must exist after resume');

        // Code consumed exactly once, bound to the same device the retry returned.
        const finalCodeRow = await postgresQuery('SELECT status, device_id FROM device_enrollment_codes');
        assert.equal(finalCodeRow.rows[0].status, 'consumed');
        assert.equal(finalCodeRow.rows[0].device_id, retryResp.body.device_id);

        // The retry's token must actually work — proves it was really delivered.
        const heartbeat = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(retryResp.body.device_id)}/heartbeat`,
          { status: 'healthy' },
          { Authorization: `Bearer ${retryResp.body.device_token}`, ...PROTOCOL_HEADERS },
        );
        assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));
      } finally {
        __setEnrollPhaseFaultHookForTest(null);
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    },
  );
});

// Adversarial: a still-PENDING code with NO existing device row must still
// take the normal first-enrollment path (not be misrouted into the D5 resume
// path, which requires an existing device to prove a same-binding retry).
test('D5 adversarial (Postgres): a pending code with no prior attempt still enrolls normally', {
  skip: DEDICATED_POSTGRES_URL ? false : 'set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener',
}, async () => {
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
        const enrolled = await enrollDevice(asUrl, 'codex-fresh-no-prior-attempt');
        assert.ok(enrolled.device_token);
        const devices = await postgresQuery('SELECT device_id FROM device_exporters');
        assert.equal(devices.rows.length, 1);
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    },
  );
});

// D5 concurrency, real Postgres connections: genuinely concurrent FIRST
// attempts (no prior successful enroll) for the same still-pending code, sent
// as true parallel HTTP requests against a real Postgres backend — the class
// of race SQLite's single-writer serialization can mask. Proves
// ON CONFLICT(device_id) DO NOTHING (createDevice) and rotateDeviceCredential
// (in place of a plain createCredential insert) converge concurrent first
// attempts on exactly one device, one connector instance, one source
// instance, and one active credential, with none raising 23505.
test('D5 concurrency (Postgres): genuinely concurrent first attempts for the same pending code converge with no 23505', {
  skip: DEDICATED_POSTGRES_URL ? false : 'set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener',
}, async () => {
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
        const enrollmentCode = await mintCode(asUrl, 'codex-pg-concurrent-first-attempt');

        const attempts = await Promise.all([
          exchangeCode(asUrl, enrollmentCode),
          exchangeCode(asUrl, enrollmentCode),
          exchangeCode(asUrl, enrollmentCode),
          exchangeCode(asUrl, enrollmentCode),
        ]);
        for (const a of attempts) {
          assert.equal(a.status, 201, `every concurrent first attempt must return 201 (never 500/23505), got: ${JSON.stringify(a.body)}`);
        }
        const deviceIds = new Set(attempts.map((a) => a.body.device_id));
        assert.equal(deviceIds.size, 1, 'concurrent first attempts must converge on exactly one device');

        const devices = await postgresQuery('SELECT device_id FROM device_exporters');
        assert.equal(devices.rows.length, 1, 'exactly one device row must exist');

        const connectorInstances = await postgresQuery(
          'SELECT connector_instance_id FROM connector_instances WHERE connector_id = $1',
          ['codex'],
        );
        assert.equal(connectorInstances.rows.length, 1, 'exactly one connector instance row must exist');

        const sourceInstances = await postgresQuery(
          'SELECT source_instance_id FROM device_source_instances WHERE device_id = $1',
          [devices.rows[0].device_id],
        );
        assert.equal(sourceInstances.rows.length, 1, 'exactly one source instance row must exist');

        const activeCredentials = await postgresQuery(
          "SELECT credential_id FROM device_ingest_credentials WHERE device_id = $1 AND status = 'active'",
          [devices.rows[0].device_id],
        );
        assert.equal(activeCredentials.rows.length, 1, 'exactly one active credential must exist');

        const tokens = attempts.map((a) => a.body.device_token);
        const heartbeats = await Promise.all(
          tokens.map((token) => postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(devices.rows[0].device_id)}/heartbeat`,
            { status: 'healthy' },
            { Authorization: `Bearer ${token}`, ...PROTOCOL_HEADERS },
          )),
        );
        const workingCount = heartbeats.filter((r) => r.status === 200).length;
        assert.equal(workingCount, 1, 'exactly one of the concurrently-issued tokens must be current');
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    },
  );
});
