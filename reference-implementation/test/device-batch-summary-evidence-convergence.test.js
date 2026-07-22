// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenSpec task 2.2 / 6.1 residual (openspec/changes/reconcile-active-summary-evidence
 * design.md "Acceptance Strategy"): `connector-summary-evidence-no-op-and-
 * failure-conformance.test.js`'s "accepted replay" and "partial-prefix
 * resume" cases construct their scenario by calling `ingestRecord` directly,
 * record-by-record — never through the real device-batch HTTP entry point
 * (`/_ref/device-exporters/:id/ingest-batches`, exercised by
 * `device-ingest-conformance.test.js`'s driver). `connector-summary-evidence-
 * throughput-integration.test.js`'s manifest/backfill-ordering case is also
 * real but strictly serial (M1 registers, then ingest, then M2 registers,
 * then ingest) rather than a genuine race.
 *
 * This file closes both residuals using the SAME real production entry
 * points and fault-injection seams `device-ingest-conformance.test.js`
 * already exercises for throughput/idempotency correctness, layering new
 * `connector_summary_evidence` assertions on top rather than reinventing the
 * device-batch protocol:
 *
 * - an accepted replay of an already-committed batch (the same construction
 *   `runDuplicateAndNewerWriterOracle` and the phase-fault matrix's "replay"
 *   step use: re-POST the identical batch envelope after it is durably
 *   accepted) must not double-count `total_records` or move the composite
 *   checkpoint;
 * - a partial-prefix resume (the same construction `runPhaseFaultMatrix`
 *   uses: `__setDeviceIngestPhaseFaultHookForTest` throws after the durable
 *   phase commits records but before the batch reservation reaches
 *   `accepted`, then the client resumes by re-POSTing the whole original
 *   batch) must repair only the genuinely new suffix, not double-count the
 *   already-committed prefix, and land on the correct final checkpoint;
 * - a genuine manifest-registration race against an in-flight device batch,
 *   using the exact same `inside-instance-fence` pause hook
 *   (`__setSqliteRecordSortBackfillPhaseHookForTest` /
 *   `__setPostgresRecordSortBackfillPhaseHookForTest`) that
 *   `device-ingest-conformance.test.js`'s `runManifestRegistrationOracle`
 *   uses for its "registration-first" scenario, must converge
 *   `connector_summary_evidence` correctly regardless of which side actually
 *   lands first.
 *
 * Both SQLite and a real disposable PostgreSQL database run every case here
 * (the `ORACLES`-style backend loop below), matching design.md's Acceptance
 * Strategy requirement that forced fixtures run against both backends, not
 * SQLite alone.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { registerConnector } from '../server/auth.js';
import { COLLECTOR_PROTOCOL_VERSION } from '../server/collector-protocol.ts';
import { reconcileConnectorSummaryEvidence } from '../server/connector-summary-evidence-engine.ts';
import { getConnectorSummaryEvidence } from '../server/connector-summary-read-model.ts';
import { closeDb, getDb, initDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import {
  __setSqliteRecordSortBackfillPhaseHookForTest,
} from '../server/records.js';
import {
  __setDeviceIngestPhaseFaultHookForTest,
} from '../server/routes/ref-device-exporters.ts';
import { __setPostgresRecordSortBackfillPhaseHookForTest } from '../server/postgres-records.js';
import { closePostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const PROTOCOL_HEADERS = { 'X-PDPP-Collector-Protocol': COLLECTOR_PROTOCOL_VERSION };

let unique = 0;
function nextId(prefix) {
  unique += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${unique}`;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, label, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonical(value[key])]),
  );
}

function bodyHash(records) {
  return createHash('sha256').update(JSON.stringify(canonical(records))).digest('hex');
}

function deviceRecord(key, content, { op = 'upsert', timestamp = '2026-07-17T00:00:00.000Z' } = {}) {
  return {
    stream: 'messages',
    record_key: key,
    emitted_at: timestamp,
    op,
    data: op === 'delete' ? {} : { id: key, session_id: `session-${key}`, role: 'user', type: 'text', content, timestamp },
  };
}

function batch(device, batchId, records, batchSeq = 1) {
  return {
    batch_id: batchId,
    batch_seq: batchSeq,
    body_hash: bodyHash(records),
    connector_id: device.connector_id,
    device_id: device.device_id,
    records,
    source_instance_id: device.source_instance_id,
  };
}

function deterministicBackend() {
  return {
    model: () => 'device-batch-summary-evidence-stub',
    dimensions: () => 3,
    distanceMetric: () => 'cosine',
    available: () => true,
    supportsDeviceAttemptDeadline: () => true,
    embedDocument: async () => new Float32Array([0.1, 0.2, 0.3]),
    embedQuery: async () => new Float32Array([0.1, 0.2, 0.3]),
  };
}

async function closeServer(server) {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (httpServer) => new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 2000);
    httpServer.close(() => {
      if (!settled) { settled = true; clearTimeout(timeout); resolve(); }
    });
  });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
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

function authHeaders(deviceToken) {
  return { Authorization: `Bearer ${deviceToken}`, ...PROTOCOL_HEADERS };
}

async function enrollDevice(asUrl, localBindingName) {
  const code = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: 'codex',
    local_binding_name: localBindingName,
  });
  assert.equal(code.status, 201, JSON.stringify(code.body));
  const enrolled = await postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { enrollment_code: code.body.enrollment_code },
    PROTOCOL_HEADERS,
  );
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  return enrolled.body;
}

function deviceIngestUrl(asUrl, device) {
  return `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`;
}

function databaseUrl(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function adminUrl(url) {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

async function withTemporaryPostgres(fn) {
  const pg = await import('pg');
  const { Pool } = pg.default;
  const admin = new Pool({ connectionString: adminUrl(DEDICATED_POSTGRES_URL) });
  const database = `pdpp_devbatch_summary_${process.pid}_${Date.now()}_${unique}`;
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.query(`CREATE DATABASE "${database}"`);
  try {
    await fn(databaseUrl(DEDICATED_POSTGRES_URL, database));
  } finally {
    await closePostgresStorage().catch(() => undefined);
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await admin.end();
  }
}

function createDriver(kind, server) {
  const asUrl = `http://localhost:${server.asPort}`;
  return {
    kind,
    asUrl,
    async enroll(name) {
      return await enrollDevice(asUrl, `${name}-${nextId('binding')}`);
    },
    async ingest(device, request) {
      return await postJson(deviceIngestUrl(asUrl, device), request, authHeaders(device.device_token));
    },
    target(instanceId) {
      return { connector_id: 'codex', connector_instance_id: instanceId };
    },
    async manifest() {
      const row = kind === 'sqlite'
        ? getDb().prepare('SELECT manifest FROM connectors WHERE connector_id = ?').get('codex')
        : (await postgresQuery('SELECT manifest FROM connectors WHERE connector_id = $1', ['codex'])).rows[0];
      assert.ok(row, 'the shipped codex connector must be registered before device ingest');
      return typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest;
    },
    async registerManifest(manifest, options = {}) {
      await registerConnector(manifest, options);
    },
  };
}

async function withBackend(kind, fn) {
  const backend = deterministicBackend();
  if (kind === 'sqlite') {
    const server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      semanticRetrievalBackend: backend,
    });
    try {
      await server.startupBackfillDone?.catch(() => undefined);
      await fn(createDriver(kind, server));
    } finally {
      __setDeviceIngestPhaseFaultHookForTest(null);
      __setSqliteRecordSortBackfillPhaseHookForTest(null);
      __setPostgresRecordSortBackfillPhaseHookForTest(null);
      await closeServer(server);
      closeDb();
    }
    return;
  }

  await withTemporaryPostgres(async (url) => {
    initDb(':memory:');
    const server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      storageBackend: 'postgres',
      databaseUrl: url,
      semanticRetrievalBackend: backend,
    });
    try {
      await server.startupBackfillDone?.catch(() => undefined);
      await fn(createDriver(kind, server));
    } finally {
      __setDeviceIngestPhaseFaultHookForTest(null);
      __setSqliteRecordSortBackfillPhaseHookForTest(null);
      __setPostgresRecordSortBackfillPhaseHookForTest(null);
      await closeServer(server);
      await closePostgresStorage().catch(() => undefined);
      closeDb();
    }
  });
}

async function configureMessagesManifest(driver) {
  const manifest = structuredClone(await driver.manifest());
  const messages = manifest.streams.find((stream) => stream.name === 'messages');
  assert.ok(messages, 'shipped codex manifest must retain messages');
  messages.query.search.lexical_fields = ['content'];
  messages.query.search.semantic_fields = ['content'];
  await driver.registerManifest(manifest);
  return manifest;
}

async function enrollConfiguredDevice(driver, name) {
  const device = await driver.enroll(name);
  await configureMessagesManifest(driver);
  return device;
}

/**
 * Read the composite checkpoint for one connection's summary-evidence row
 * directly (it is an internal storage column, not part of the shaped
 * envelope `getConnectorSummaryEvidence` returns), the same way
 * `connector-summary-evidence-no-op-and-failure-conformance.test.js` does
 * for SQLite — extended here to also work against a real Postgres backend.
 */
async function checkpointFor(driver, connectorInstanceId) {
  if (driver.kind === 'sqlite') {
    return getDb()
      .prepare('SELECT record_checkpoint_json FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get(connectorInstanceId)?.record_checkpoint_json ?? null;
  }
  const result = await postgresQuery(
    'SELECT record_checkpoint_json::text AS record_checkpoint_json FROM connector_summary_evidence WHERE connector_instance_id = $1',
    [connectorInstanceId],
  );
  return result.rows[0]?.record_checkpoint_json ?? null;
}

// ---------------------------------------------------------------------------
// 1. Accepted replay through the real device-batch HTTP entry point.
// ---------------------------------------------------------------------------

async function runAcceptedReplayOracle(driver) {
  const device = await enrollConfiguredDevice(driver, 'accepted-replay');
  const request = batch(device, nextId('accepted-replay'), [
    deviceRecord('replay-msg-1', 'first'),
    deviceRecord('replay-msg-2', 'second', { timestamp: '2026-07-17T00:00:01.000Z' }),
  ]);

  const first = await driver.ingest(device, request);
  assert.equal(first.status, 201, 'the original batch is accepted');

  const warm = await reconcileConnectorSummaryEvidence(null);
  assert.ok(warm.repaired >= 1, 'fixture premise: the connection converges after the original batch');
  const evidenceAfterBatch = await getConnectorSummaryEvidence(device.connector_instance_id);
  assert.equal(evidenceAfterBatch.total_records, 2, 'fixture premise: both records from the batch are counted');
  const checkpointAfterBatch = await checkpointFor(driver, device.connector_instance_id);

  // The client replays the identical batch envelope through the real device
  // HTTP route — e.g. it never observed the 200/201 response and retries.
  // device-ingest-conformance.test.js's stranded-diagnostics oracle and
  // duplicate-writer oracle both prove this replay is a persistence/
  // diagnostics no-op at the device-batch layer; this proves the summary
  // primitive converges the same way.
  const replay = await driver.ingest(device, request);
  assert.equal(replay.status, 201, 'an accepted replay of the identical batch is re-accepted, not rejected');

  const result = await reconcileConnectorSummaryEvidence(null);
  assert.equal(result.repaired, 0, 'the accepted replay triggers zero repair work — nothing changed');
  assert.equal(
    await checkpointFor(driver, device.connector_instance_id),
    checkpointAfterBatch,
    'the composite checkpoint is unchanged by the replay',
  );

  const evidenceAfterReplay = await getConnectorSummaryEvidence(device.connector_instance_id);
  assert.equal(evidenceAfterReplay.total_records, 2, 'the replay does not double-count the two-record batch');
}

// ---------------------------------------------------------------------------
// 2. Partial-prefix resume through the real device-batch HTTP entry point,
//    using the same phase-fault seam runPhaseFaultMatrix uses.
// ---------------------------------------------------------------------------

async function runPartialPrefixResumeOracle(driver) {
  const device = await enrollConfiguredDevice(driver, 'partial-prefix-resume');
  const key1 = 'prefix-msg-1';
  const key2 = 'prefix-msg-2';
  const key3 = 'prefix-msg-3';
  const request = batch(device, nextId('partial-prefix'), [
    deviceRecord(key1, 'one'),
    deviceRecord(key2, 'two', { timestamp: '2026-07-17T00:00:01.000Z' }),
    deviceRecord(key3, 'three', { timestamp: '2026-07-17T00:00:02.000Z' }),
  ]);

  // Force the durable phase to fail after committing the first record but
  // before the batch reaches `accepted` — the exact `after-durable-record`
  // seam runPhaseFaultMatrix uses to build a real partial durable prefix.
  let fired = false;
  __setDeviceIngestPhaseFaultHookForTest((point, inputIndex) => {
    if (!fired && point === 'after-durable-record' && inputIndex === 0) {
      fired = true;
      throw new Error('deterministic partial-prefix interruption');
    }
  });
  try {
    const interrupted = await driver.ingest(device, request);
    assert.equal(interrupted.status, 503, 'the interrupted batch surfaces only retryable HTTP state');
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
  }

  const midway = await reconcileConnectorSummaryEvidence(null);
  assert.ok(midway.repaired >= 1, 'fixture premise: the primitive observes the durably-committed prefix');
  const midwayEvidence = await getConnectorSummaryEvidence(device.connector_instance_id);
  assert.equal(midwayEvidence.total_records, 1, 'only the durably-committed prefix record is visible mid-resume');
  const checkpointMidway = await checkpointFor(driver, device.connector_instance_id);

  // The client resumes by re-sending the WHOLE original batch: the first
  // record replays as a no-op (already committed), and the remaining two are
  // genuinely new — the same resume construction runPhaseFaultMatrix uses.
  const resumed = await driver.ingest(device, request);
  assert.equal(resumed.status, 201, 'the resumed batch is accepted');
  const resumedReplay = await driver.ingest(device, request);
  assert.equal(resumedReplay.status, 201, 'a further replay after full acceptance is also accepted, not rejected');

  const result = await reconcileConnectorSummaryEvidence(null);
  assert.equal(result.repaired, 1, 'the resumed batch repairs exactly the one connection whose checkpoint moved');
  assert.notEqual(
    await checkpointFor(driver, device.connector_instance_id),
    checkpointMidway,
    'the checkpoint DID move once, reflecting the newly-landed suffix',
  );

  const finalEvidence = await getConnectorSummaryEvidence(device.connector_instance_id);
  assert.equal(finalEvidence.total_records, 3, 'the resumed batch lands the full 3 records without duplicating the already-committed prefix');

  // A second reconcile after full convergence is idempotent.
  const secondPass = await reconcileConnectorSummaryEvidence(null);
  assert.equal(secondPass.repaired, 0, 'a second pass after full convergence repairs nothing further');
}

// ---------------------------------------------------------------------------
// 3. Genuine manifest-registration race against an in-flight device batch —
//    the same `inside-instance-fence` pause hook
//    device-ingest-conformance.test.js's runManifestRegistrationOracle uses
//    for its "registration-first" scenario.
// ---------------------------------------------------------------------------

async function runManifestRaceOracle(driver) {
  const device = await enrollConfiguredDevice(driver, 'manifest-race');

  // Seed one record under the current (M1) manifest and let the primitive
  // converge, establishing a baseline before the race.
  const seedRequest = batch(device, nextId('manifest-race-seed'), [deviceRecord('race-seed', 'before race')]);
  assert.equal((await driver.ingest(device, seedRequest)).status, 201);
  const seedResult = await reconcileConnectorSummaryEvidence(null);
  assert.ok(seedResult.repaired >= 1, 'fixture premise: the connection converges under M1 before the race');

  // Build M2: same connector/stream, with different declared search fields
  // (mirrors generationManifests' M1->M2 shift) so registration performs a
  // real backfill that takes the per-instance write fence.
  const m2 = structuredClone(await driver.manifest());
  const messages = m2.streams.find((stream) => stream.name === 'messages');
  messages.query.search.lexical_fields = ['role'];
  messages.query.search.semantic_fields = ['role'];

  const backfillAtTarget = deferred();
  const releaseBackfill = deferred();
  const pauseAtTarget = async (point, context) => {
    if (point === 'inside-instance-fence' && context.connectorInstanceId === device.connector_instance_id) {
      backfillAtTarget.resolve();
      await releaseBackfill.promise;
    }
  };
  if (driver.kind === 'postgres') __setPostgresRecordSortBackfillPhaseHookForTest(pauseAtTarget);
  else __setSqliteRecordSortBackfillPhaseHookForTest(pauseAtTarget);

  let registration;
  let raceRequest;
  try {
    // M2 registration enters the instance fence for this connection's
    // sort-backfill and pauses there — the exact "registration owns the
    // fence, then a device request races in" ordering
    // runManifestRegistrationOracle's second scenario constructs.
    registration = driver.registerManifest(m2);
    await within(backfillAtTarget.promise, 'M2 sort backfill to own the target instance');

    // While registration holds the fence, issue a real device batch against
    // the SAME connection — it must queue behind the fence, not interleave
    // with it or corrupt summary evidence.
    raceRequest = batch(device, nextId('manifest-race'), [
      deviceRecord('race-during-registration', 'during race', { timestamp: '2026-07-17T00:00:05.000Z' }),
    ]);
    const devicePromise = driver.ingest(device, raceRequest);

    releaseBackfill.resolve();
    await within(registration, 'M2 registration/backfill completes');
    const deviceResult = await within(devicePromise, 'device ingest queued behind M2 registration');
    assert.equal(deviceResult.status, 201, 'the raced device batch is accepted once the registration fence releases');
  } finally {
    releaseBackfill.resolve();
    __setSqliteRecordSortBackfillPhaseHookForTest(null);
    __setPostgresRecordSortBackfillPhaseHookForTest(null);
    await Promise.allSettled([registration].filter(Boolean));
  }

  // Whichever actually landed first at the storage layer, the summary
  // primitive must converge on the true post-race state: both records
  // visible, manifest_declaration current under M2, no lost update.
  const result = await reconcileConnectorSummaryEvidence(null);
  assert.ok(result.discovered >= 1);
  const finalEvidence = await getConnectorSummaryEvidence(device.connector_instance_id);
  assert.equal(finalEvidence.total_records, 2, 'both the pre-race and raced records survive the registration race, none lost or duplicated');
  assert.equal(finalEvidence.manifest_declaration.state, 'current', 'the manifest declaration is current (not unavailable/failed) after the race settles');

  const persistedManifestRow = driver.kind === 'sqlite'
    ? getDb().prepare('SELECT manifest FROM connectors WHERE connector_id = ?').get('codex')
    : (await postgresQuery('SELECT manifest FROM connectors WHERE connector_id = $1', ['codex'])).rows[0];
  const persistedManifest = typeof persistedManifestRow.manifest === 'string'
    ? JSON.parse(persistedManifestRow.manifest)
    : persistedManifestRow.manifest;
  const persistedMessages = persistedManifest.streams.find((stream) => stream.name === 'messages');
  assert.deepEqual(persistedMessages.query.search.lexical_fields, ['role'], 'the manifest fingerprint is not orphaned/stale — M2 is the durably stored manifest after the race');

  // A second reconcile pass after the race settles is idempotent.
  const secondPass = await reconcileConnectorSummaryEvidence(null);
  assert.equal(secondPass.repaired, 0, 'a second pass after the race settles repairs nothing further');
}

const ORACLES = [
  ['accepted replay converges the summary primitive without double-counting', runAcceptedReplayOracle],
  ['partial-prefix resume converges the summary primitive on the correct final state', runPartialPrefixResumeOracle],
  ['manifest registration racing an in-flight device batch converges the summary primitive with no lost update', runManifestRaceOracle],
];

for (const [name, oracle] of ORACLES) {
  test(`SQLite device-batch summary-evidence convergence: ${name}`, async () => {
    await withBackend('sqlite', oracle);
  });
  test(`PostgreSQL device-batch summary-evidence convergence: ${name}`, {
    skip: !DEDICATED_POSTGRES_URL,
  }, async () => {
    await withBackend('postgres', oracle);
  });
}
