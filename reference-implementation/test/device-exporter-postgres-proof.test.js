// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import pg from 'pg';
import pino from 'pino';
import test from 'node:test';

import { COLLECTOR_PROTOCOL_VERSION } from '../server/collector-protocol.ts';
import { fingerprintDeviceAttemptManifest } from '../server/device-ingest-attempt-context.ts';
import { startServer } from '../server/index.js';
import { closeDb, getDb, initDb } from '../server/db.js';
import { ingestRecord, setClientEventEnqueueHook } from '../server/records.js';
import { makeLocalTransformerBackend } from '../server/search-semantic.js';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';
import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from '../server/postgres-storage.js';
import {
  advancePostgresDeviceIngestPrefix,
  createPostgresDeviceExporterStore,
} from '../server/stores/device-exporter-store.ts';

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(POSTGRES_URL);
const PROTOCOL_HEADERS = { 'X-PDPP-Collector-Protocol': COLLECTOR_PROTOCOL_VERSION };
const FAILSTOP_SERVER_FIXTURE = fileURLToPath(new URL('./fixtures/device-ingest-failstop-server.mjs', import.meta.url));

let tempCounter = 0;
function tempDbName() {
  tempCounter += 1;
  return `pdpp_device_ingest_${process.pid}_${Date.now()}_${tempCounter}`;
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

async function withTempPostgres(fn) {
  const admin = new Pool({ connectionString: adminUrl(POSTGRES_URL) });
  const name = tempDbName();
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = databaseUrl(POSTGRES_URL, name);
  try {
    await fn(url);
  } finally {
    await closePostgresStorage().catch(() => undefined);
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined);
    await admin.end();
  }
}

async function closeServer(server) {
  if (!server) return;
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function withServer(url, options, fn) {
  initDb(':memory:');
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    storageBackend: 'postgres',
    databaseUrl: url,
    ...options,
  });
  await server.startupBackfillDone?.catch(() => undefined);
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl, server });
  } finally {
    await closeServer(server);
    await closePostgresStorage().catch(() => undefined);
    closeDb();
  }
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

async function enrollDevice(asUrl, localBindingName, connectorId = 'codex') {
  const code = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: connectorId,
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

function authHeaders(deviceToken) {
  return { Authorization: `Bearer ${deviceToken}`, ...PROTOCOL_HEADERS };
}

async function setMessagesManifest(mutator) {
  const row = await postgresQuery('SELECT manifest FROM connectors WHERE connector_id = $1', ['codex']);
  const manifest = typeof row.rows[0]?.manifest === 'string' ? JSON.parse(row.rows[0].manifest) : row.rows[0]?.manifest;
  const messages = manifest.streams.find((stream) => stream.name === 'messages');
  mutator(messages, manifest);
  const manifestJson = JSON.stringify(manifest);
  await postgresQuery('UPDATE connectors SET manifest = $1::jsonb WHERE connector_id = $2', [manifestJson, 'codex']);
  getDb().prepare('UPDATE connectors SET manifest = ? WHERE connector_id = ?').run(manifestJson, 'codex');
}

function recordFor(id, value, timestamp = '2026-07-16T00:00:00.000Z') {
  return {
    stream: 'messages',
    record_key: id,
    emitted_at: timestamp,
    data: {
      id,
      session_id: id,
      role: 'user',
      content: value,
      type: 'text',
      timestamp,
    },
  };
}

function batchFor(device, batchId, records, batchSeq = 1) {
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

function deterministicBackend({ model = () => 'pg-device-proof', delayMs = 0, onEmbed = null, vector = [0.25, 0.5, 0.75] } = {}) {
  let calls = 0;
  return {
    model,
    dimensions: () => 3,
    distanceMetric: () => 'cosine',
    available: () => true,
    supportsDeviceAttemptDeadline: () => true,
    embedDocument: async (text) => {
      calls += 1;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (onEmbed) await onEmbed(text);
      return new Float32Array(vector);
    },
    embedQuery: async () => new Float32Array(vector),
    calls: () => calls,
  };
}

function vectorBytes(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function capturingLogger(lines) {
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(Buffer.from(chunk).toString('utf8'));
      callback();
    },
  });
  return pino({
    level: 'info',
    redact: {
      paths: ['access_token', 'refresh_token', 'req.headers.authorization', '*.access_token', '*.refresh_token'],
      censor: '<redacted>',
    },
  }, destination);
}

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startFailStopServerFixture(databaseUrl, mode) {
  const child = spawn(process.execPath, [FAILSTOP_SERVER_FIXTURE], {
    env: {
      ...process.env,
      PDPP_FAILSTOP_FIXTURE_DATABASE_URL: databaseUrl,
      PDPP_FAILSTOP_FIXTURE_MODE: mode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += Buffer.from(chunk).toString('utf8'); });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const ready = new Promise((resolve, reject) => {
    lines.on('line', (line) => {
      output += `${line}\n`;
      try {
        const parsed = JSON.parse(line);
        if (parsed.ready === true) resolve(parsed);
      } catch {}
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`fail-stop fixture exited before ready: ${code ?? signal}`)));
  });
  let readiness;
  try {
    readiness = await within(ready, 20000, 'fail-stop fixture startup exceeded 20s');
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return {
    asUrl: `http://127.0.0.1:${readiness.asPort}`,
    child,
    exit,
    output: () => output,
  };
}

async function awaitFixtureExit(fixture, timeoutMs = 10000) {
  return within(fixture.exit, timeoutMs, `fixture exit exceeded ${timeoutMs}ms`);
}

async function stopServerFixture(fixture) {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill('SIGTERM');
  return awaitFixtureExit(fixture);
}

if (!DEDICATED_POSTGRES_URL) {
  test('PostgreSQL device exporter proof (skipped: dedicated disposable URL not selected)', { skip: true }, () => {});
} else {
  test('PostgreSQL bootstrap preserves processing reservations and migrates only legacy accepted rows', async () => {
    await withTempPostgres(async (url) => {
      initDb(':memory:');
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      const suffix = `${process.pid}_${Date.now()}`;
      const connectorId = `migration_${suffix}`;
      const deviceId = `device_${suffix}`;
      const batchId = `processing_${suffix}`;
      const legacyBatchId = `legacy_${suffix}`;
      const manifest = { connector_id: connectorId, version: '1.0.0', streams: [] };
      const identity = {
        deviceId,
        batchId,
        bodyHash: 'a'.repeat(64),
        sourceInstanceId: `source_${suffix}`,
        connectorInstanceId: `instance_${suffix}`,
        connectorId,
        batchSeq: 1,
      };
      await postgresQuery(
        `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
         VALUES($1, $2, $3, 'active', $4, $4)`,
        [deviceId, `owner_${suffix}`, 'migration-proof', '2026-07-16T00:00:00.000Z'],
      );
      await postgresQuery('INSERT INTO connectors(connector_id, manifest) VALUES($1, $2::jsonb)', [connectorId, JSON.stringify(manifest)]);
      await postgresQuery(
        `INSERT INTO device_ingest_batch_outcomes(
           device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
           connector_id, batch_seq, status, record_count, durable_prefix_count,
           manifest_fingerprint, semantic_capability_identity, created_at
         ) VALUES($1, $2, $3, $4, $5, $6, $7, 'processing', 2, 1, $8, $9, $10)`,
        [
          identity.deviceId,
          identity.batchId,
          identity.bodyHash,
          identity.sourceInstanceId,
          identity.connectorInstanceId,
          identity.connectorId,
          identity.batchSeq,
          fingerprintDeviceAttemptManifest(manifest),
          'migration-semantic',
          '2026-07-16T00:00:00.000Z',
        ],
      );
      await postgresQuery(
        `INSERT INTO device_ingest_batch_outcomes(
           device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
           connector_id, batch_seq, status, response_json, record_count,
           durable_prefix_count, created_at
         ) VALUES($1, $2, $3, $4, $5, $6, $7, 'accepted', $8::jsonb, 0, 0, $9)`,
        [
          deviceId,
          legacyBatchId,
          'b'.repeat(64),
          identity.sourceInstanceId,
          identity.connectorInstanceId,
          connectorId,
          2,
          JSON.stringify({ accepted_record_count: 3 }),
          '2026-07-16T00:00:01.000Z',
        ],
      );

      await bootstrapPostgresSchema();
      const afterBootstrap = await postgresQuery(
        `SELECT batch_id, status, durable_prefix_count, record_count, accepted_at, response_json
           FROM device_ingest_batch_outcomes WHERE batch_id = ANY($1::text[]) ORDER BY batch_id`,
        [[batchId, legacyBatchId]],
      );
      const processing = afterBootstrap.rows.find((row) => row.batch_id === batchId);
      const legacy = afterBootstrap.rows.find((row) => row.batch_id === legacyBatchId);
      assert.deepEqual(
        { status: processing.status, prefix: processing.durable_prefix_count, acceptedAt: processing.accepted_at, response: processing.response_json },
        { status: 'processing', prefix: 1, acceptedAt: null, response: null },
      );
      assert.equal(legacy.status, 'accepted');
      assert.equal(Number(legacy.record_count), 3);
      assert.equal(Number(legacy.durable_prefix_count), 3);
      assert.ok(legacy.accepted_at);

      await withPostgresTransaction((client) => advancePostgresDeviceIngestPrefix(client, {
        ...identity,
        recordCount: 2,
      }, 1));
      const store = createPostgresDeviceExporterStore();
      const accepted = await store.completeProcessingBatch({
        ...identity,
        recordCount: 2,
        manifestFingerprint: fingerprintDeviceAttemptManifest(manifest),
        semanticCapabilityIdentity: 'migration-semantic',
        acceptedAt: '2026-07-16T00:00:02.000Z',
        httpStatus: 201,
        response: { accepted_record_count: 2, rejected_record_count: 0 },
        getCurrentSemanticCapabilityIdentity: () => 'migration-semantic',
      });
      assert.equal(accepted.status, 'accepted', 'the preserved processing row can resume normally');
      assert.equal(accepted.durablePrefixCount, 2);
    });
  });

  test('PostgreSQL route preserves duplicate upsert/delete final state and exact replay', async () => {
    await withTempPostgres(async (url) => {
      const backend = deterministicBackend();
      await withServer(url, { semanticRetrievalBackend: backend }, async ({ asUrl }) => {
        const device = await enrollDevice(asUrl, `pg-duplicate-${Date.now()}`);
        const records = [
          { ...recordFor('same-key', 'before-delete'), op: 'upsert' },
          { stream: 'messages', record_key: 'same-key', emitted_at: '2026-07-16T00:00:01.000Z', data: {}, op: 'delete' },
        ];
        const batch = batchFor(device, 'pg-duplicate-upsert-delete', records);
        const accepted = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token),
        );
        assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
        const replay = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token),
        );
        assert.equal(replay.status, 201);
        assert.deepEqual(replay.body, accepted.body);
        const beforeIdentityConflict = await postgresQuery(
          `SELECT
             (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1)::integer AS records,
             (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1)::integer AS changes,
             (SELECT COUNT(*) FROM device_ingest_batch_outcomes WHERE device_id = $2)::integer AS outcomes`,
          [device.connector_instance_id, device.device_id],
        );
        const identityConflict = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          { ...batch, connector_id: 'claude-code' },
          authHeaders(device.device_token),
        );
        assert.equal(identityConflict.status, 409);
        assert.equal(identityConflict.body.error.code, 'device_batch_conflict');
        const afterIdentityConflict = await postgresQuery(
          `SELECT
             (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1)::integer AS records,
             (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1)::integer AS changes,
             (SELECT COUNT(*) FROM device_ingest_batch_outcomes WHERE device_id = $2)::integer AS outcomes`,
          [device.connector_instance_id, device.device_id],
        );
        assert.deepEqual(afterIdentityConflict.rows[0], beforeIdentityConflict.rows[0]);
        const durable = await postgresQuery(
          `SELECT deleted, version FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
          [device.connector_instance_id, 'messages', 'same-key'],
        );
        assert.deepEqual({ deleted: durable.rows[0].deleted, version: Number(durable.rows[0].version) }, { deleted: true, version: 2 });
        const changes = await postgresQuery(
          'SELECT COUNT(*)::integer AS count FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3',
          [device.connector_instance_id, 'messages', 'same-key'],
        );
        assert.equal(changes.rows[0].count, 2);
        const lexical = await postgresQuery(
          'SELECT COUNT(*)::integer AS count FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3',
          [device.connector_instance_id, 'messages', 'same-key'],
        );
        const semantic = await postgresQuery(
          'SELECT COUNT(*)::integer AS count FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $2 AND record_key = $3',
          [device.connector_instance_id, '["messages",%', 'same-key'],
        );
        assert.equal(lexical.rows[0].count, 0);
        assert.equal(semantic.rows[0].count, 0);
      });
    });
  });

  test('PostgreSQL HTTP partial failure rolls back input 1 and resumes the sticky prefix', async () => {
    await withTempPostgres(async (url) => {
      const suffix = `${process.pid}_${Date.now()}`;
      const trigger = `pdpp_test_fail_ingest_${suffix}`;
      const functionName = `pdpp_test_fail_ingest_fn_${suffix}`;
      const flagTable = `pdpp_test_fail_ingest_flag_${suffix}`;
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      await postgresQuery(`CREATE TABLE ${flagTable}(enabled BOOLEAN NOT NULL)`);
      await postgresQuery(`INSERT INTO ${flagTable}(enabled) VALUES(TRUE)`);
      await postgresQuery(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF (SELECT enabled FROM ${flagTable} LIMIT 1) AND NEW.record_key = 'second-key' THEN
            RAISE EXCEPTION 'private-pg-trigger-sentinel';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await postgresQuery(`CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);

      const backend = deterministicBackend();
      await withServer(url, { semanticRetrievalBackend: backend }, async ({ asUrl }) => {
        let notifications = [];
        try {
          const device = await enrollDevice(asUrl, `pg-partial-${Date.now()}`);
          await setMessagesManifest((messages) => { messages.query.search.semantic_fields = ['content']; });
          notifications = [];
          setClientEventEnqueueHook((change) => notifications.push(change));
          const records = [recordFor('first-key', 'first'), recordFor('second-key', 'second')];
          const batch = batchFor(device, 'pg-partial-failure', records);
          const failed = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token),
          );
            assert.equal(failed.status, 503, JSON.stringify(failed.body));
            assert.equal(failed.body.error.code, 'device_ingest_retryable');
            assert.doesNotMatch(JSON.stringify(failed.body), /private-pg-trigger-sentinel/);
            const partial = await postgresQuery(
              `SELECT
                 (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS records,
                 (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS changes,
                 (SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = 'messages') AS max_version,
                 (SELECT durable_prefix_count FROM device_ingest_batch_outcomes WHERE device_id = $2 AND batch_id = $3) AS prefix`,
              [device.connector_instance_id, device.device_id, batch.batch_id],
            );
            assert.deepEqual(
              { records: partial.rows[0].records, changes: partial.rows[0].changes, maxVersion: Number(partial.rows[0].max_version), prefix: Number(partial.rows[0].prefix) },
              { records: 1, changes: 1, maxVersion: 1, prefix: 1 },
            );
            assert.equal(notifications.length, 1);
            assert.deepEqual(
              notifications.map((change) => change.version),
              [1],
              'the changed durable prefix must publish its allocated PostgreSQL version',
            );

            await postgresQuery(`UPDATE ${flagTable} SET enabled = FALSE`);
            const resumed = await postJson(
              `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
              batch,
              authHeaders(device.device_token),
            );
            assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
            const complete = await postgresQuery(
              `SELECT
                 (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS records,
                 (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS changes,
                 (SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = 'messages') AS max_version,
                 (SELECT version FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'first-key') AS first_version,
                 (SELECT version FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'second-key') AS second_version,
                 (SELECT durable_prefix_count FROM device_ingest_batch_outcomes WHERE device_id = $2 AND batch_id = $3) AS prefix`,
              [device.connector_instance_id, device.device_id, batch.batch_id],
            );
            assert.deepEqual(
              {
                records: complete.rows[0].records,
                changes: complete.rows[0].changes,
                maxVersion: Number(complete.rows[0].max_version),
                firstVersion: Number(complete.rows[0].first_version),
                secondVersion: Number(complete.rows[0].second_version),
                prefix: Number(complete.rows[0].prefix),
              },
              { records: 2, changes: 2, maxVersion: 2, firstVersion: 1, secondVersion: 2, prefix: 2 },
            );
            assert.equal(notifications.length, 2);
            assert.deepEqual(
              notifications.map((change) => change.version),
              [1, 2],
              'resume must publish the second allocated PostgreSQL version without replaying the first',
            );
            const completedOutcome = await postgresQuery(
              'SELECT status, durable_prefix_count, record_count FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2',
              [device.device_id, batch.batch_id],
            );
            assert.deepEqual(completedOutcome.rows[0], { status: 'accepted', durable_prefix_count: 2, record_count: 2 });
            const callsBeforeReplay = backend.calls();
            const replay = await postJson(
              `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
              batch,
              authHeaders(device.device_token),
            );
            assert.equal(replay.status, 201);
            assert.deepEqual(replay.body, resumed.body);
            assert.equal(backend.calls(), callsBeforeReplay);
            assert.equal(notifications.length, 2);
          } finally {
            setClientEventEnqueueHook(null);
            await postgresQuery(`DROP TRIGGER IF EXISTS ${trigger} ON records`).catch(() => undefined);
            await postgresQuery(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => undefined);
            await postgresQuery(`DROP TABLE IF EXISTS ${flagTable}`).catch(() => undefined);
          }
        });
    });
  });

  test('PostgreSQL retry rereads a newer writer and repairs derived facts without a third version or notification', async () => {
    let failFirst = true;
    const backend = deterministicBackend({
      vector: [0.2, 0.3, 0.4],
      onEmbed: async (text) => {
        if (failFirst && text.includes('payload-a')) {
          failFirst = false;
          throw new Error('private-pg-semantic-backend-sentinel');
        }
      },
    });
    await withTempPostgres(async (url) => {
      await withServer(url, { semanticRetrievalBackend: backend }, async ({ asUrl }) => {
        const device = await enrollDevice(asUrl, `pg-interleave-${Date.now()}`);
        await setMessagesManifest((messages) => { messages.query.search.semantic_fields = ['content']; });
        const notifications = [];
        setClientEventEnqueueHook((change) => notifications.push(change));
        try {
          const records = [recordFor('same-key', 'payload-a')];
          const batch = batchFor(device, 'pg-authoritative-interleave', records);
          const first = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token),
          );
          assert.equal(first.status, 503, JSON.stringify(first.body));
          assert.equal(first.body.error.code, 'device_ingest_retryable');
          assert.doesNotMatch(JSON.stringify(first.body), /private-pg-semantic-backend-sentinel/);
          await ingestRecord(
            { connector_id: 'codex', connector_instance_id: device.connector_instance_id },
            { stream: 'messages', key: 'same-key', emitted_at: '2026-07-16T00:00:01.000Z', data: { ...records[0].data, content: 'payload-b', role: 'assistant', timestamp: '2026-07-16T00:00:01.000Z' } },
          );
          assert.equal(notifications.length, 2);
          const directCurrent = await postgresQuery(
            `SELECT record_json, emitted_at, cursor_value, semantic_time
               FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key'`,
            [device.connector_instance_id],
          );
          assert.equal(directCurrent.rows[0].record_json.content, 'payload-b');
          assert.equal(new Date(directCurrent.rows[0].emitted_at).toISOString(), '2026-07-16T00:00:01.000Z');
          const retry = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token),
          );
          assert.equal(retry.status, 201, JSON.stringify(retry.body));
          const durable = await postgresQuery(
            `SELECT version, record_json, cursor_value, primary_key_text, semantic_time
               FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
            [device.connector_instance_id, 'messages', 'same-key'],
          );
          assert.equal(Number(durable.rows[0].version), 2);
          assert.equal(durable.rows[0].record_json.content, 'payload-b');
          assert.equal(durable.rows[0].cursor_value, '2026-07-16T00:00:01.000Z');
          assert.equal(durable.rows[0].primary_key_text, 'same-key');
          assert.equal(durable.rows[0].semantic_time, '2026-07-16T00:00:01.000Z');
          assert.equal(notifications.length, 2);
          const lexical = await postgresQuery(
            `SELECT value FROM lexical_search_index
              WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key' AND field = 'content'`,
            [device.connector_instance_id],
          );
          assert.equal(lexical.rows[0].value, 'payload-b');
          const semantic = await postgresQuery(
            `SELECT embedding::text AS embedding FROM semantic_search_blob
              WHERE connector_instance_id = $1 AND scope_key LIKE '["messages",%' AND record_key = 'same-key'`,
            [device.connector_instance_id],
          );
          assert.equal(semantic.rowCount, 1);
          assert.match(semantic.rows[0].embedding, /0\.2/);
        } finally {
          setClientEventEnqueueHook(null);
        }
      });
    });
  });

  test('PostgreSQL manifest drift repairs cursor, primary-key, and semantic durable facts', async () => {
    let changed = false;
    const backend = deterministicBackend({
      model: () => changed ? 'pg-drift-b' : 'pg-drift-a',
      onEmbed: async () => {
        if (!changed) {
          changed = true;
          await setMessagesManifest((messages) => {
            messages.schema.properties.updated_at = { type: 'string', format: 'date-time' };
            messages.cursor_field = 'updated_at';
            messages.consent_time_field = 'updated_at';
            messages.primary_key = ['session_id'];
            messages.query.search.semantic_fields = ['role'];
          });
        }
      },
    });
    await withTempPostgres(async (url) => {
      await withServer(url, { semanticRetrievalBackend: backend }, async ({ asUrl }) => {
        const device = await enrollDevice(asUrl, `pg-drift-${Date.now()}`);
        const records = [recordFor('same-key', 'drift-content')];
        records[0].data.updated_at = '2026-07-16T13:00:00.000Z';
        const batch = batchFor(device, 'pg-manifest-drift', records);
        const first = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token),
        );
        assert.equal(first.status, 503, JSON.stringify(first.body));
        const stale = await postgresQuery(
          `SELECT cursor_value, primary_key_text, semantic_time
             FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key'`,
          [device.connector_instance_id],
        );
        const staleOutcome = await postgresQuery(
          `SELECT durable_prefix_count FROM device_ingest_batch_outcomes
             WHERE device_id = $1 AND batch_id = $2`,
          [device.device_id, batch.batch_id],
        );
        assert.equal(Number(staleOutcome.rows[0].durable_prefix_count), 1);
        assert.equal(stale.rows[0].cursor_value, '2026-07-16T00:00:00.000Z');
        assert.equal(stale.rows[0].primary_key_text, 'same-key');
        assert.equal(stale.rows[0].semantic_time, '2026-07-16T00:00:00.000Z');
        const retry = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token),
        );
        assert.equal(retry.status, 201, JSON.stringify(retry.body));
        const repaired = await postgresQuery(
          `SELECT cursor_value, primary_key_text, semantic_time
             FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key'`,
          [device.connector_instance_id],
        );
        assert.deepEqual(repaired.rows[0], {
          cursor_value: '2026-07-16T13:00:00.000Z',
          primary_key_text: 'same-key',
          semantic_time: '2026-07-16T13:00:00.000Z',
        });

        // Prove the remaining-suffix/no-op seam separately from the skipped
        // prefix repair above. A fresh reservation over an anchored identical
        // row must repair all manifest-derived columns without a new version.
        await postgresQuery(
          `UPDATE records
              SET cursor_value = 'stale-cursor',
                  primary_key_text = 'stale-primary',
                  semantic_time = '2026-07-16T00:00:00.000Z'
            WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key'`,
          [device.connector_instance_id],
        );
        const freshNoop = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          { ...batch, batch_id: 'pg-fresh-noop-derived-repair' },
          authHeaders(device.device_token),
        );
        assert.equal(freshNoop.status, 201, JSON.stringify(freshNoop.body));
        const freshNoopRepair = await postgresQuery(
          `SELECT version, cursor_value, primary_key_text, semantic_time
             FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key'`,
          [device.connector_instance_id],
        );
        assert.deepEqual(
          {
            version: Number(freshNoopRepair.rows[0].version),
            cursor_value: freshNoopRepair.rows[0].cursor_value,
            primary_key_text: freshNoopRepair.rows[0].primary_key_text,
            semantic_time: freshNoopRepair.rows[0].semantic_time,
          },
          {
            version: 1,
            cursor_value: '2026-07-16T13:00:00.000Z',
            primary_key_text: 'same-key',
            semantic_time: '2026-07-16T13:00:00.000Z',
          },
        );
      });
    });
  });

  test('PostgreSQL HTTP 100-record correctness and bounded deterministic latency', async () => {
    const previousConcurrency = process.env.PDPP_INGEST_FINAL_INDEX_PLAN_CONCURRENCY;
    const previousSemanticLimit = process.env.PDPP_SEMANTIC_WORK_LIMIT;
    const previousDeadline = process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS;
    process.env.PDPP_INGEST_FINAL_INDEX_PLAN_CONCURRENCY = '4';
    process.env.PDPP_SEMANTIC_WORK_LIMIT = '4';
    process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS = '10000';
    try {
      const backend = deterministicBackend({ delayMs: 80 });
      await withTempPostgres(async (url) => {
        await withServer(url, { semanticRetrievalBackend: backend }, async ({ asUrl }) => {
          const device = await enrollDevice(asUrl, `pg-100-${Date.now()}`);
          await setMessagesManifest((messages) => { messages.query.search.semantic_fields = ['content']; });
          const records = Array.from({ length: 100 }, (_, index) => recordFor(`row-${String(index).padStart(3, '0')}`, `payload-${index}`));
          const batch = batchFor(device, 'pg-100-correctness', records);
          const started = performance.now();
          const accepted = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token),
          );
          const elapsedMs = performance.now() - started;
          assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
          assert.ok(elapsedMs < 6500, `deterministic overlap latency ${elapsedMs.toFixed(1)}ms exceeded 6500ms`);
          const counts = await postgresQuery(
            `SELECT
               (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND deleted = FALSE)::integer AS records,
               (SELECT COUNT(*) FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS lexical,
               (SELECT COUNT(*) FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE '["messages",%')::integer AS semantic,
               (SELECT durable_prefix_count FROM device_ingest_batch_outcomes WHERE device_id = $2 AND batch_id = $3) AS prefix`,
            [device.connector_instance_id, device.device_id, batch.batch_id],
          );
          assert.equal(counts.rows[0].records, 100);
          assert.ok(counts.rows[0].lexical >= 100);
          assert.equal(counts.rows[0].semantic, 100);
          assert.equal(Number(counts.rows[0].prefix), 100);
          const callsBeforeReplay = backend.calls();
          const replayStarted = performance.now();
          const replay = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token),
          );
          const replayElapsedMs = performance.now() - replayStarted;
          assert.equal(replay.status, 201);
          assert.deepEqual(replay.body, accepted.body);
          assert.equal(backend.calls(), callsBeforeReplay, 'accepted replay must not perform semantic work');
          console.log(JSON.stringify({ oracle: 'postgres-http-100', elapsedMs, replayElapsedMs, embedCalls: callsBeforeReplay }));
        });
      });
    } finally {
      for (const [name, value] of [
        ['PDPP_INGEST_FINAL_INDEX_PLAN_CONCURRENCY', previousConcurrency],
        ['PDPP_SEMANTIC_WORK_LIMIT', previousSemanticLimit],
        ['PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS', previousDeadline],
      ]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('spawned server fail-stops on unconfirmed child exit and restart resumes the PostgreSQL reservation', async () => {
    await withTempPostgres(async (url) => {
      const payloadSentinel = 'private-spawned-failstop-record-sentinel';
      let failedServer;
      let recoveryServer;
      try {
        failedServer = await startFailStopServerFixture(url, 'fail');
        const device = await enrollDevice(failedServer.asUrl, `pg-failstop-${Date.now()}`);
        const records = [recordFor('failstop-record', payloadSentinel)];
        const batch = batchFor(device, 'pg-spawned-failstop-restart', records);
        const inFlight = postJson(
          `${failedServer.asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token),
        ).then(
          (response) => ({ response }),
          (error) => ({ error }),
        );
        const failedExit = await awaitFixtureExit(failedServer, 10000);
        assert.deepEqual(failedExit, { code: 1, signal: null }, 'unconfirmed SIGKILL receipt must fail-stop the server nonzero');
        const interrupted = await inFlight;
        assert.ok(interrupted.error, 'the fail-stopped parent must not acknowledge the interrupted request');

        const verify = new Pool({ connectionString: url });
        try {
          const processing = await verify.query(
            `SELECT
               (SELECT status FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2) AS status,
               (SELECT durable_prefix_count FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2) AS prefix,
               (SELECT COUNT(*) FROM records WHERE connector_instance_id = $3 AND stream = 'messages')::integer AS records,
               (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $3 AND stream = 'messages')::integer AS changes,
               (SELECT version FROM records WHERE connector_instance_id = $3 AND stream = 'messages' AND record_key = 'failstop-record') AS version`,
            [device.device_id, batch.batch_id, device.connector_instance_id],
          );
          assert.deepEqual(
            {
              status: processing.rows[0].status,
              prefix: Number(processing.rows[0].prefix),
              records: processing.rows[0].records,
              changes: processing.rows[0].changes,
              version: Number(processing.rows[0].version),
            },
            { status: 'processing', prefix: 1, records: 1, changes: 1, version: 1 },
          );
        } finally {
          await verify.end();
        }

        recoveryServer = await startFailStopServerFixture(url, 'recover');
        const resumed = await postJson(
          `${recoveryServer.asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token),
        );
        assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
        const replay = await postJson(
          `${recoveryServer.asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token),
        );
        assert.equal(replay.status, 201);
        assert.deepEqual(replay.body, resumed.body);

        const after = new Pool({ connectionString: url });
        try {
          const accepted = await after.query(
            `SELECT
               (SELECT status FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2) AS status,
               (SELECT durable_prefix_count FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2) AS prefix,
               (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $3 AND stream = 'messages')::integer AS changes,
               (SELECT version FROM records WHERE connector_instance_id = $3 AND stream = 'messages' AND record_key = 'failstop-record') AS version,
               (SELECT COUNT(*) FROM lexical_search_index WHERE connector_instance_id = $3 AND stream = 'messages' AND record_key = 'failstop-record')::integer AS lexical,
               (SELECT COUNT(*) FROM semantic_search_blob WHERE connector_instance_id = $3 AND record_key = 'failstop-record')::integer AS semantic`,
            [device.device_id, batch.batch_id, device.connector_instance_id],
          );
          assert.deepEqual(
            {
              status: accepted.rows[0].status,
              prefix: Number(accepted.rows[0].prefix),
              changes: accepted.rows[0].changes,
              version: Number(accepted.rows[0].version),
              lexical: accepted.rows[0].lexical,
              semantic: accepted.rows[0].semantic,
            },
            { status: 'accepted', prefix: 1, changes: 1, version: 1, lexical: 1, semantic: 1 },
          );
        } finally {
          await after.end();
        }

        const recoveryExit = await stopServerFixture(recoveryServer);
        assert.deepEqual(recoveryExit, { code: 0, signal: null });
        const captured = `${failedServer.output()}${recoveryServer.output()}`;
        assert.equal(captured.includes(payloadSentinel), false);
        assert.equal(captured.includes(device.device_token), false);
        assert.equal(captured.includes('pdpp_test'), false);
      } finally {
        if (failedServer?.child.exitCode === null && failedServer?.child.signalCode === null) {
          failedServer.child.kill('SIGKILL');
        }
        if (recoveryServer?.child.exitCode === null && recoveryServer?.child.signalCode === null) {
          recoveryServer.child.kill('SIGKILL');
        }
      }
    });
  });

  test('real local child + PostgreSQL HTTP preserves exact 100-record output, latency, lifecycle, and privacy', {
    skip: process.env.PDPP_REAL_LOCAL_TRANSFORMER_POSTGRES_ORACLE !== '1',
  }, async () => {
    const environment = {
      PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS: '90000',
      PDPP_INGEST_FINAL_INDEX_PLAN_CONCURRENCY: '4',
      PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS: '60000',
      PDPP_SEMANTIC_WORK_LIMIT: '1',
      PDPP_SEMANTIC_WORK_QUEUE_LIMIT: '16',
    };
    const previous = new Map(Object.keys(environment).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(environment)) process.env[name] = value;
    let embedCalls = 0;
    let backend = null;
    const logLines = [];
    const logger = capturingLogger(logLines);
    const payloadSentinel = 'private-real-local-payload-sentinel SELECT pg_sleep(99) /owner/private/path';
    const responses = [];
    const credentialSentinels = [];
    let receipt = null;
    try {
      const rawBackend = makeLocalTransformerBackend(undefined, {
        executorOptions: {
          deadlineMs: 60000,
          queueLimit: 16,
          workLimit: 1,
        },
      });
      assert.equal(rawBackend.available(), true, 'the real local model cache must be present with downloads disabled');
      backend = {
        ...rawBackend,
        embedDocument: async (text) => {
          embedCalls += 1;
          return rawBackend.embedDocument(text);
        },
      };
      const content = Array.from({ length: 100 }, (_, index) =>
        index === 0 ? payloadSentinel : `real local transformer HTTP equality record ${index}`,
      );
      const expectedVectors = [];
      for (const value of content) expectedVectors.push(await backend.embedDocument(value));
      const baselineCalls = embedCalls;
      backend.resetExecutionTelemetry();

      await withTempPostgres(async (url) => {
        await withServer(url, { logger, semanticRetrievalBackend: backend }, async ({ asUrl }) => {
          const device = await enrollDevice(asUrl, `pg-real-local-${Date.now()}`);
          credentialSentinels.push(device.device_token);
          await setMessagesManifest((messages) => {
            messages.query.search.lexical_fields = ['content'];
            messages.query.search.semantic_fields = ['content'];
          });
          const batches = [0, 1].map((batchIndex) => {
            const records = content.map((value, index) =>
              recordFor(`real-${batchIndex}-${String(index).padStart(3, '0')}`, value),
            );
            return batchFor(device, `pg-real-local-100-${batchIndex}`, records, batchIndex + 1);
          });
          const elapsed = [];
          for (const batch of batches) {
            const started = performance.now();
            const accepted = await postJson(
              `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
              batch,
              authHeaders(device.device_token),
            );
            elapsed.push(performance.now() - started);
            responses.push(accepted.body);
            assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
          }
          assert.ok(elapsed.every((value) => value < 30000), `real local HTTP latency exceeded 30s: ${elapsed.join(', ')}`);
          assert.ok(elapsed.reduce((sum, value) => sum + value, 0) < 60000, 'two real 100-record batches must retain 2x margin inside the collector pass');

          const expectedCallsAfterIngest = baselineCalls + 200;
          assert.equal(embedCalls, expectedCallsAfterIngest, 'each required semantic row must execute exactly once');
          const replayStarted = performance.now();
          const replay = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batches[0],
            authHeaders(device.device_token),
          );
          const replayElapsedMs = performance.now() - replayStarted;
          responses.push(replay.body);
          assert.equal(replay.status, 201);
          assert.deepEqual(replay.body, responses[0]);
          assert.equal(embedCalls, expectedCallsAfterIngest, 'accepted replay must execute no local-transformer work');
          assert.ok(replayElapsedMs < 2000, `accepted replay took ${replayElapsedMs.toFixed(1)}ms`);

          const counts = await postgresQuery(
            `SELECT
               (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND deleted = FALSE)::integer AS records,
               (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS changes,
               (SELECT COUNT(*) FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS lexical,
               (SELECT COUNT(*) FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key = $2)::integer AS semantic,
               (SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = 'messages') AS max_version,
               (SELECT COUNT(*) FROM device_ingest_batch_outcomes WHERE device_id = $3 AND status = 'accepted')::integer AS accepted_outcomes,
               (SELECT MIN(durable_prefix_count) FROM device_ingest_batch_outcomes WHERE device_id = $3) AS min_prefix`,
            [device.connector_instance_id, JSON.stringify(['messages', 'content']), device.device_id],
          );
          assert.deepEqual(
            {
              records: counts.rows[0].records,
              changes: counts.rows[0].changes,
              lexical: counts.rows[0].lexical,
              semantic: counts.rows[0].semantic,
              maxVersion: Number(counts.rows[0].max_version),
              acceptedOutcomes: counts.rows[0].accepted_outcomes,
              minPrefix: Number(counts.rows[0].min_prefix),
            },
            { records: 200, changes: 200, lexical: 200, semantic: 200, maxVersion: 200, acceptedOutcomes: 2, minPrefix: 100 },
          );

          const lexical = await postgresQuery(
            `SELECT record_key, value
               FROM lexical_search_index
              WHERE connector_instance_id = $1 AND stream = 'messages' AND field = 'content'
              ORDER BY record_key`,
            [device.connector_instance_id],
          );
          assert.equal(lexical.rowCount, 200);
          for (const row of lexical.rows) {
            const index = Number(row.record_key.slice(-3));
            assert.equal(row.value, content[index]);
          }

          const semantic = await postgresQuery(
            `SELECT record_key, embedding::text AS embedding
               FROM semantic_search_blob
              WHERE connector_instance_id = $1 AND scope_key = $2
              ORDER BY record_key`,
            [device.connector_instance_id, JSON.stringify(['messages', 'content'])],
          );
          assert.equal(semantic.rowCount, 200);
          for (const row of semantic.rows) {
            const index = Number(row.record_key.slice(-3));
            const actual = Float32Array.from(JSON.parse(row.embedding));
            assert.equal(
              vectorBytes(actual).equals(vectorBytes(expectedVectors[index])),
              true,
              `PostgreSQL vector bytes diverged for ${row.record_key}`,
            );
          }

          const telemetry = backend.executionTelemetry();
          assert.equal(telemetry.childHighWater, 1);
          assert.equal(telemetry.pendingJobs, 0);
          assert.ok(telemetry.peakChildRssBytes > 0);
          receipt = {
            oracle: 'postgres-http-real-local-100x2',
            elapsedMs: elapsed,
            replayElapsedMs,
            embedCalls,
            childHighWater: telemetry.childHighWater,
            peakChildRssBytes: telemetry.peakChildRssBytes,
          };

          const serializedResponses = JSON.stringify(responses);
          assert.doesNotMatch(serializedResponses, /private-real-local-payload-sentinel|pg_sleep|\/owner\/private\/path/);
          assert.equal(serializedResponses.includes(device.device_token), false);
          assert.equal(serializedResponses.includes('pdpp_test'), false);
        });
      });
    } finally {
      try {
        if (backend) {
          const closeStarted = performance.now();
          await within(backend.close(), 10000, 'real local child close exceeded 10s');
          const lifecycle = backend.executionTelemetry();
          assert.equal(lifecycle.pendingJobs, 0);
          assert.equal(lifecycle.childPid, null);
          assert.equal(lifecycle.terminating, false);
          assert.ok(performance.now() - closeStarted < 10000);
        }
        logger.flush?.();
        const captured = logLines.join('');
        assert.doesNotMatch(captured, /private-real-local-payload-sentinel|pg_sleep|\/owner\/private\/path/);
        assert.equal(captured.includes('pdpp_test'), false, 'captured logs must not expose the PostgreSQL credential sentinel');
        assert.equal(captured.includes(process.env.PDPP_EMBEDDING_CACHE_DIR || '/cache/path/not-configured'), false);
        for (const sentinel of credentialSentinels) assert.equal(captured.includes(sentinel), false);
      } finally {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }
    assert.ok(receipt);
    console.log(JSON.stringify(receipt));
  });

}
