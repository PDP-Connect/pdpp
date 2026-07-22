// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import test from 'node:test';

import pg from 'pg';

import { __setRegisterConnectorPhaseHookForTest, registerConnector } from '../server/auth.js';
import { COLLECTOR_PROTOCOL_VERSION } from '../server/collector-protocol.ts';
import {
  __setConnectorInstanceWritePhaseHookForTest,
  connectorInstanceWriteCoordinatorStatsForTests,
  withConnectorInstanceWrite,
} from '../server/connector-instance-write-coordinator.ts';
import { closeDb, getDb, initDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import {
  __setRecordIndexFaultHookForTest,
  __setSqliteRecordSortBackfillPhaseHookForTest,
  deleteAllRecords,
  deleteRecord,
  ingestRecord,
  setClientEventEnqueueHook,
} from '../server/records.js';
import {
  __setDeviceIngestPhaseFaultHookForTest,
} from '../server/routes/ref-device-exporters.ts';
import { __setLexicalBackfillPhaseHookForTest, lexicalIndexBackfillForManifest } from '../server/search.js';
import { configureSemanticBackend, semanticIndexBackfillForManifest } from '../server/search-semantic.js';
import { closePostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import { __setPostgresRecordSortBackfillPhaseHookForTest } from '../server/postgres-records.js';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';

const { Pool } = pg;
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

function vectorForText(text) {
  const digest = createHash('sha256').update(String(text)).digest();
  return new Float32Array([
    digest.readUInt16BE(0) / 65_535,
    digest.readUInt16BE(2) / 65_535,
    digest.readUInt16BE(4) / 65_535,
  ]);
}

function normalizedVector(vector) {
  return Array.from(vector, (value) => Number(Number(value).toFixed(5)));
}

function normalizedBlobVector(value) {
  const bytes = Buffer.from(value);
  return normalizedVector(new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
  ));
}

function deviceRecord(key, content, {
  op = 'upsert',
  nested = null,
  timestamp = '2026-07-16T12:00:00.000Z',
  fields = {},
} = {}) {
  return {
    stream: 'messages',
    record_key: key,
    emitted_at: timestamp,
    op,
    data: op === 'delete'
      ? {}
      : {
          id: key,
          session_id: `session-${key}`,
          role: 'user',
          type: 'text',
          content,
          timestamp,
          ...(nested ? { nested } : {}),
          ...fields,
        },
  };
}

function directRecord(key, content, options = {}) {
  const record = deviceRecord(key, content, options);
  return {
    stream: record.stream,
    key: record.record_key,
    emitted_at: record.emitted_at,
    data: record.data,
    op: record.op,
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

function deterministicBackend({ onEmbed = null } = {}) {
  let embedHook = onEmbed;
  let documentCalls = 0;
  return {
    model: () => 'device-ingest-conformance-stub',
    dimensions: () => 3,
    distanceMetric: () => 'cosine',
    available: () => true,
    supportsDeviceAttemptDeadline: () => true,
    embedDocument: async (text) => {
      documentCalls += 1;
      await embedHook?.(text);
      return vectorForText(text);
    },
    embedQuery: async (text) => vectorForText(text),
    calls: () => documentCalls,
    setEmbedHook: (hook) => { embedHook = hook; },
  };
}

async function closeServer(server) {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (httpServer) => new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, 2000);
    httpServer.close(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  await Promise.allSettled([
    closeOne(server.asServer),
    closeOne(server.rsServer),
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
  const admin = new Pool({ connectionString: adminUrl(DEDICATED_POSTGRES_URL) });
  const database = `pdpp_ingest_oracle_${process.pid}_${Date.now()}_${unique}`;
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.query(`CREATE DATABASE "${database}"`);
  try {
    await fn(databaseUrl(DEDICATED_POSTGRES_URL, database));
  } finally {
    await closePostgresStorage().catch(() => undefined);
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await admin.end();
  }
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
      await fn(createDriver({ kind, server, semanticBackend: backend }));
    } finally {
      __setConnectorInstanceWritePhaseHookForTest(null);
      __setDeviceIngestPhaseFaultHookForTest(null);
      __setRecordIndexFaultHookForTest(null);
      __setSqliteRecordSortBackfillPhaseHookForTest(null);
      __setRegisterConnectorPhaseHookForTest(null);
      __setLexicalBackfillPhaseHookForTest(null);
      __setPostgresRecordSortBackfillPhaseHookForTest(null);
      setClientEventEnqueueHook(null);
      configureSemanticBackend(backend);
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
      await fn(createDriver({ kind, server, semanticBackend: backend }));
    } finally {
      __setConnectorInstanceWritePhaseHookForTest(null);
      __setDeviceIngestPhaseFaultHookForTest(null);
      __setRecordIndexFaultHookForTest(null);
      __setSqliteRecordSortBackfillPhaseHookForTest(null);
      __setRegisterConnectorPhaseHookForTest(null);
      __setLexicalBackfillPhaseHookForTest(null);
      __setPostgresRecordSortBackfillPhaseHookForTest(null);
      setClientEventEnqueueHook(null);
      configureSemanticBackend(backend);
      await closeServer(server);
      await closePostgresStorage().catch(() => undefined);
      closeDb();
    }
  });
}

function createDriver({ kind, server, semanticBackend }) {
  const asUrl = `http://localhost:${server.asPort}`;
  const sql = {
    async rows(sqlite, postgres, params = []) {
      if (kind === 'sqlite') return getDb().prepare(sqlite).all(...params);
      return (await postgresQuery(postgres, params)).rows;
    },
    async one(sqlite, postgres, params = []) {
      const rows = await this.rows(sqlite, postgres, params);
      return rows[0] ?? null;
    },
    async execute(sqlite, postgres, params = []) {
      if (kind === 'sqlite') return getDb().prepare(sqlite).run(...params);
      return await postgresQuery(postgres, params);
    },
  };
  const normalizeOutcome = (row) => {
    if (!row) return null;
    return {
      ...row,
      batch_seq: Number(row.batch_seq),
      record_count: Number(row.record_count),
      durable_prefix_count: Number(row.durable_prefix_count),
      response_json: row.response_json == null
        ? null
        : (typeof row.response_json === 'string' ? JSON.parse(row.response_json) : row.response_json),
    };
  };

  return {
    kind,
    asUrl,
    embeddingCalls: () => semanticBackend.calls(),
    setEmbeddingHook: (hook) => semanticBackend.setEmbedHook(hook),
    disableSemanticBackend: () => configureSemanticBackend(null),
    restoreSemanticBackend: () => configureSemanticBackend(semanticBackend),
    async enroll(name) {
      return await enrollDevice(asUrl, `${name}-${nextId('binding')}`);
    },
    async ingest(device, request) {
      return await postJson(deviceIngestUrl(asUrl, device), request, authHeaders(device.device_token));
    },
    async outcome(device, batchId) {
      const row = await sql.one(
        `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                connector_id, batch_seq, status, http_status, response_json,
                record_count, durable_prefix_count, manifest_fingerprint,
                semantic_capability_identity, created_at, accepted_at
           FROM device_ingest_batch_outcomes WHERE device_id = ? AND batch_id = ?`,
        `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                connector_id, batch_seq, status, http_status, response_json::text AS response_json,
                record_count, durable_prefix_count, manifest_fingerprint,
                semantic_capability_identity, created_at, accepted_at
           FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2`,
        [device.device_id, batchId],
      );
      return normalizeOutcome(row);
    },
    async outcomes(device) {
      const rows = await sql.rows(
        `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                connector_id, batch_seq, status, http_status, response_json,
                record_count, durable_prefix_count, manifest_fingerprint,
                semantic_capability_identity, created_at, accepted_at
           FROM device_ingest_batch_outcomes WHERE device_id = ? ORDER BY batch_id`,
        `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                connector_id, batch_seq, status, http_status, response_json::text AS response_json,
                record_count, durable_prefix_count, manifest_fingerprint,
                semantic_capability_identity, created_at, accepted_at
           FROM device_ingest_batch_outcomes WHERE device_id = $1 ORDER BY batch_id`,
        [device.device_id],
      );
      return rows.map(normalizeOutcome);
    },
    async record(instanceId, key, streamName = 'messages') {
      const row = await sql.one(
        `SELECT record_json, deleted, version, semantic_time
           FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?`,
        `SELECT record_json, deleted, version, cursor_value, primary_key_text, semantic_time
           FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
        [instanceId, streamName, key],
      );
      if (!row) return null;
      const recordJson = typeof row.record_json === 'string' ? JSON.parse(row.record_json) : row.record_json;
      let sqliteLogicalFacts = null;
      if (kind === 'sqlite') {
        const manifestRow = await sql.one(
          'SELECT manifest FROM connectors WHERE connector_id = ?',
          'SELECT manifest FROM connectors WHERE connector_id = $1',
          ['codex'],
        );
        const manifest = typeof manifestRow?.manifest === 'string'
          ? JSON.parse(manifestRow.manifest)
          : manifestRow?.manifest;
        const stream = manifest?.streams?.find((entry) => entry?.name === streamName) ?? null;
        const primaryFields = Array.isArray(stream?.primary_key)
          ? stream.primary_key
          : (typeof stream?.primary_key === 'string' ? [stream.primary_key] : ['id']);
        sqliteLogicalFacts = {
          cursor: typeof stream?.cursor_field === 'string' ? (recordJson[stream.cursor_field] ?? null) : null,
          primary: primaryFields
            .map((field) => recordJson[field] ?? key)
            .map((value) => String(value ?? ''))
            .join('\u0001'),
        };
      }
      return {
        ...row,
        deleted: Boolean(row.deleted),
        version: Number(row.version),
        record_json: recordJson,
        record_json_raw: typeof row.record_json === 'string' ? row.record_json : JSON.stringify(row.record_json),
        // SQLite stores the canonical payload plus manifest-derived semantic
        // time; PostgreSQL additionally materializes cursor/key columns.
        // Normalize the real representations against the current persisted
        // manifest without inventing SQLite columns.
        cursor_value: row.cursor_value ?? sqliteLogicalFacts?.cursor ?? null,
        primary_key_text: row.primary_key_text ?? sqliteLogicalFacts?.primary ?? key,
      };
    },
    async changes(instanceId, key) {
      const row = await sql.one(
        `SELECT COUNT(*) AS count FROM record_changes
          WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = ?`,
        `SELECT COUNT(*)::integer AS count FROM record_changes
          WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2`,
        [instanceId, key],
      );
      return Number(row.count);
    },
    async versions(instanceId) {
      const row = await sql.one(
        `SELECT COALESCE(max_version, 0) AS max_version
           FROM version_counter WHERE connector_instance_id = ? AND stream = 'messages'`,
        `SELECT COALESCE(max_version, 0)::bigint AS max_version
           FROM version_counter WHERE connector_instance_id = $1 AND stream = 'messages'`,
        [instanceId],
      );
      return Number(row?.max_version ?? 0);
    },
    async history(instanceId, key) {
      return await sql.rows(
        `SELECT version, deleted FROM record_changes
          WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = ? ORDER BY version`,
        `SELECT version, deleted FROM record_changes
          WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2 ORDER BY version`,
        [instanceId, key],
      ).then((rows) => rows.map((row) => ({ version: Number(row.version), deleted: Boolean(row.deleted) })));
    },
    async lexical(instanceId, key) {
      return await sql.rows(
        `SELECT field, text FROM lexical_search_index
          WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = ? ORDER BY field`,
        `SELECT field, value AS text FROM lexical_search_index
          WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2 ORDER BY field`,
        [instanceId, key],
      );
    },
    async semantic(instanceId, key) {
      if (kind === 'sqlite') {
        return getDb().prepare(
          `SELECT scope_key, record_key FROM semantic_search_rowid
            WHERE connector_instance_id = ? AND record_key = ? ORDER BY scope_key`,
        ).all(instanceId, key);
      }
      return await sql.rows(
        `SELECT scope_key, record_key FROM semantic_search_blob
          WHERE connector_instance_id = ? AND record_key = ? ORDER BY scope_key`,
        `SELECT scope_key, record_key FROM semantic_search_blob
          WHERE connector_instance_id = $1 AND record_key = $2 ORDER BY scope_key`,
        [instanceId, key],
      );
    },
    async semanticWithEmbedding(instanceId, key) {
      if (kind === 'sqlite') {
        if (getDb().vectorIndexKind === 'sqlite-vec') {
          const rows = getDb().prepare(
            `SELECT mapping.scope_key, mapping.record_key, vec.embedding
               FROM semantic_search_rowid AS mapping
               JOIN semantic_search_vec AS vec ON vec.rowid = mapping.rowid
              WHERE mapping.connector_instance_id = ? AND mapping.record_key = ?
              ORDER BY mapping.scope_key`,
          ).all(instanceId, key);
          return rows.map((row) => ({
            scope_key: row.scope_key,
            record_key: row.record_key,
            embedding: normalizedBlobVector(row.embedding),
          }));
        }
        const rows = getDb().prepare(
          `SELECT scope_key, record_key, embedding
             FROM semantic_search_blob
            WHERE connector_instance_id = ? AND record_key = ?
            ORDER BY scope_key`,
        ).all(instanceId, key);
        return rows.map((row) => ({
          scope_key: row.scope_key,
          record_key: row.record_key,
          embedding: normalizedBlobVector(row.embedding),
        }));
      }
      const rows = await sql.rows(
        `SELECT scope_key, record_key, embedding FROM semantic_search_blob
          WHERE connector_instance_id = ? AND record_key = ? ORDER BY scope_key`,
        `SELECT scope_key, record_key, embedding::text AS embedding FROM semantic_search_blob
          WHERE connector_instance_id = $1 AND record_key = $2 ORDER BY scope_key`,
        [instanceId, key],
      );
      return rows.map((row) => ({
        scope_key: row.scope_key,
        record_key: row.record_key,
        embedding: normalizedVector(JSON.parse(row.embedding)),
      }));
    },
    async derivedState(instanceId) {
      const [lexicalMeta, semanticMeta, semanticProgress] = await Promise.all([
        sql.rows(
          `SELECT stream, fields_fingerprint FROM lexical_search_meta
            WHERE connector_instance_id = ? ORDER BY stream`,
          `SELECT stream, fields_fingerprint FROM lexical_search_meta
            WHERE connector_instance_id = $1 ORDER BY stream`,
          [instanceId],
        ),
        sql.rows(
          `SELECT stream, fields_fingerprint, model_id, dimensions, distance_metric
             FROM semantic_search_meta WHERE connector_instance_id = ? ORDER BY stream`,
          `SELECT stream, fields_fingerprint, model_id, dimensions, distance_metric
             FROM semantic_search_meta WHERE connector_instance_id = $1 ORDER BY stream`,
          [instanceId],
        ),
        sql.rows(
          `SELECT stream, fields_fingerprint, model_id, dimensions, distance_metric
             FROM semantic_search_backfill_progress WHERE connector_instance_id = ? ORDER BY stream`,
          `SELECT stream, fields_fingerprint, model_id, dimensions, distance_metric
             FROM semantic_search_backfill_progress WHERE connector_instance_id = $1 ORDER BY stream`,
          [instanceId],
        ),
      ]);
      return { lexicalMeta, semanticMeta, semanticProgress };
    },
    async snapshot({ device, batchId, keys }) {
      const records = {};
      const histories = {};
      const lexical = {};
      const semantic = {};
      for (const key of keys) {
        records[key] = await this.record(device.connector_instance_id, key);
        histories[key] = await this.history(device.connector_instance_id, key);
        lexical[key] = await this.lexical(device.connector_instance_id, key);
        semantic[key] = await this.semantic(device.connector_instance_id, key);
      }
      return {
        outcome: await this.outcome(device, batchId),
        outcomes: await this.outcomes(device),
        records,
        histories,
        lexical,
        semantic,
        versionCounter: await this.versions(device.connector_instance_id),
        derived: await this.derivedState(device.connector_instance_id),
        diagnostics: await this.diagnosticsSnapshot(device, device.source_instance_id),
      };
    },
    async eraseDerived(instanceId, key) {
      await sql.execute(
        `DELETE FROM lexical_search_index WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = ?`,
        `DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2`,
        [instanceId, key],
      );
      if (kind === 'sqlite') {
        const rowids = getDb().prepare(
          'SELECT rowid FROM semantic_search_rowid WHERE connector_instance_id = ? AND record_key = ?',
        ).all(instanceId, key);
        for (const row of rowids) {
          getDb().prepare('DELETE FROM semantic_search_vec WHERE rowid = ?').run(row.rowid);
        }
        getDb().prepare('DELETE FROM semantic_search_rowid WHERE connector_instance_id = ? AND record_key = ?').run(instanceId, key);
        getDb().prepare('DELETE FROM semantic_search_blob WHERE connector_instance_id = ? AND record_key = ?').run(instanceId, key);
      } else {
        await sql.execute(
          'DELETE FROM semantic_search_blob WHERE connector_instance_id = ? AND record_key = ?',
          'DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND record_key = $2',
          [instanceId, key],
        );
      }
    },
    async corruptDerived(instanceId, key) {
      if (kind === 'sqlite') {
        getDb().prepare(
          `DELETE FROM lexical_search_index
            WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = ?`,
        ).run(instanceId, key);
        getDb().prepare(
          `INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text)
           VALUES('codex', ?, 'messages', ?, 'content', 'corrupt lexical value')`,
        ).run(instanceId, key);
      } else {
        await postgresQuery(
          `UPDATE lexical_search_index SET value = 'corrupt lexical value'
            WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2 AND field = 'content'`,
          [instanceId, key],
        );
      }
      await this.eraseDerived(instanceId, key);
      if (kind === 'sqlite') {
        getDb().prepare(
          `INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text)
           VALUES('codex', ?, 'messages', ?, 'content', 'corrupt lexical value')`,
        ).run(instanceId, key);
      } else {
        await postgresQuery(
          `INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, value)
           VALUES('codex', $1, 'messages', $2, 'content', 'corrupt lexical value')`,
          [instanceId, key],
        );
      }
    },
    async mutateOutcomeIdentity(device, batchId, column, value) {
      assert.ok(new Set(['body_hash', 'source_instance_id', 'connector_instance_id', 'connector_id', 'batch_seq']).has(column));
      if (kind === 'sqlite') {
        getDb().prepare(`UPDATE device_ingest_batch_outcomes SET ${column} = ? WHERE device_id = ? AND batch_id = ?`)
          .run(value, device.device_id, batchId);
      } else {
        await postgresQuery(
          `UPDATE device_ingest_batch_outcomes SET ${column} = $1 WHERE device_id = $2 AND batch_id = $3`,
          [value, device.device_id, batchId],
        );
      }
    },
    async manifest() {
      let row = await sql.one(
        'SELECT manifest FROM connectors WHERE connector_id = ?',
        'SELECT manifest FROM connectors WHERE connector_id = $1',
        ['codex'],
      );
      // Enrollment is the shipped production path that materializes a local
      // connector catalog row. Do not seed it through direct SQL: registration
      // and subsequent backfill tests must exercise the same public path.
      if (!row) {
        await enrollDevice(asUrl, nextId('manifest-primer'));
        row = await sql.one(
          'SELECT manifest FROM connectors WHERE connector_id = ?',
          'SELECT manifest FROM connectors WHERE connector_id = $1',
          ['codex'],
        );
      }
      assert.ok(row, 'the shipped codex connector must be registered before device ingest');
      return typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest;
    },
    async registerManifest(manifest, options = {}) {
      await registerConnector(manifest, options);
    },
    target(instanceId) {
      return { connector_id: 'codex', connector_instance_id: instanceId };
    },
    async diagnosticsSnapshot(device, sourceInstanceId) {
      const response = await fetch(`${asUrl}/_ref/device-exporters/diagnostics`, {
        headers: { Accept: 'application/json' },
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      const deviceRow = payload.data.find((entry) => entry.device_id === device.device_id);
      assert.ok(deviceRow);
      const source = deviceRow.source_instances.find((entry) => entry.source_instance_id === sourceInstanceId);
      assert.ok(source);
      return {
        device: {
          last_ingest_at: deviceRow.last_ingest_at,
          last_heartbeat_at: deviceRow.last_heartbeat_at,
          stale: deviceRow.stale,
          last_error: deviceRow.last_error,
        },
        source: {
          accepted_record_count: source.accepted_record_count,
          rejected_record_count: source.rejected_record_count,
          last_ingest_at: source.last_ingest_at,
          last_heartbeat_at: source.last_heartbeat_at,
          last_heartbeat_status: source.last_heartbeat_status,
          records_pending: source.records_pending,
          outbox_diagnostics: source.outbox_diagnostics,
          outbox_state: source.outbox_state,
          local_collector_gaps: source.local_collector_gaps,
          local_collector_coverage: source.local_collector_coverage,
          last_error: source.last_error,
        },
      };
    },
    async diagnostics(device, sourceInstanceId) {
      return (await this.diagnosticsSnapshot(device, sourceInstanceId)).source;
    },
  };
}

async function configureMessagesManifest(driver, mutation = null) {
  const manifest = structuredClone(await driver.manifest());
  const messages = manifest.streams.find((stream) => stream.name === 'messages');
  assert.ok(messages, 'shipped codex manifest must retain messages');
  messages.query.search.lexical_fields = ['content'];
  messages.query.search.semantic_fields = ['content'];
  mutation?.(messages, manifest);
  await driver.registerManifest(manifest);
  const persisted = await driver.manifest();
  const persistedMessages = persisted.streams.find((stream) => stream.name === 'messages');
  assert.deepEqual(persistedMessages.query.search.lexical_fields, messages.query.search.lexical_fields);
  assert.deepEqual(persistedMessages.query.search.semantic_fields, messages.query.search.semantic_fields);
  return manifest;
}

async function enrollConfiguredDevice(driver, name, mutation = null) {
  const device = await driver.enroll(name);
  await configureMessagesManifest(driver, mutation);
  return device;
}

function notificationVersions(notifications) {
  return notifications.map((change) => change.version);
}

function diagnosticFreshnessInputs(diagnostics) {
  return {
    device: {
      last_heartbeat_at: diagnostics.device.last_heartbeat_at,
      stale: diagnostics.device.stale,
      last_error: diagnostics.device.last_error,
    },
    source: {
      last_heartbeat_at: diagnostics.source.last_heartbeat_at,
      last_heartbeat_status: diagnostics.source.last_heartbeat_status,
      records_pending: diagnostics.source.records_pending,
      outbox_diagnostics: diagnostics.source.outbox_diagnostics,
      outbox_state: diagnostics.source.outbox_state,
      local_collector_gaps: diagnostics.source.local_collector_gaps,
      local_collector_coverage: diagnostics.source.local_collector_coverage,
      last_error: diagnostics.source.last_error,
    },
  };
}

function assertStoredAcceptedResponse(outcome, device, request) {
  assert.equal(outcome.http_status, 201);
  assert.ok(outcome.accepted_at);
  assert.deepEqual(outcome.response_json, {
    object: 'device_ingest_batch_result',
    device_id: device.device_id,
    connector_instance_id: device.connector_instance_id,
    source_instance_id: device.source_instance_id,
    batch_id: request.batch_id,
    body_hash: request.body_hash,
    status: 'accepted',
    accepted_record_count: outcome.record_count,
    rejected_record_count: 0,
  });
}

async function assertOutcomeIdentity(driver, device, request, { status = 'accepted' } = {}) {
  const outcome = await driver.outcome(device, request.batch_id);
  assert.ok(outcome, 'the batch reservation is directly persisted');
  assert.equal(outcome.status, status);
  assert.equal(outcome.device_id, device.device_id);
  assert.equal(outcome.batch_id, request.batch_id);
  assert.equal(outcome.body_hash, request.body_hash);
  assert.equal(outcome.source_instance_id, device.source_instance_id);
  assert.equal(outcome.connector_instance_id, device.connector_instance_id);
  assert.equal(outcome.connector_id, 'codex');
  assert.equal(outcome.batch_seq, request.batch_seq);
  assert.ok(outcome.manifest_fingerprint);
  assert.ok(outcome.semantic_capability_identity);
  assert.ok(outcome.created_at);
  assert.ok(outcome.durable_prefix_count >= 0 && outcome.durable_prefix_count <= outcome.record_count);
  if (status === 'accepted') assertStoredAcceptedResponse(outcome, device, request);
  return outcome;
}

async function assertAcceptedFinalState(driver, {
  device,
  request,
  batchId,
  key,
  content,
  version,
  changes,
  notifications,
}) {
  const outcome = await driver.outcome(device, batchId);
  assert.equal(outcome.status, 'accepted');
  assert.equal(Number(outcome.durable_prefix_count), Number(outcome.record_count));
  if (request) assertStoredAcceptedResponse(outcome, device, request);
  if (request) await assertOutcomeIdentity(driver, device, request);

  const record = await driver.record(device.connector_instance_id, key);
  assert.ok(record);
  assert.equal(record.deleted, false);
  assert.equal(record.record_json.content, content);
  assert.equal(record.version, version);
  assert.equal(record.cursor_value, record.record_json.timestamp);
  assert.equal(record.primary_key_text, key);
  assert.equal(record.semantic_time, record.record_json.timestamp);
  assert.equal(await driver.changes(device.connector_instance_id, key), changes);
  assert.equal(await driver.versions(device.connector_instance_id), version);
  assert.deepEqual(await driver.lexical(device.connector_instance_id, key), [{ field: 'content', text: content }]);
  assert.deepEqual(await driver.semantic(device.connector_instance_id, key), [
    { scope_key: JSON.stringify(['messages', 'content']), record_key: key },
  ]);
  assert.deepEqual(notificationVersions(notifications), Array.from({ length: changes }, (_, index) => index + 1));
  const derived = await driver.derivedState(device.connector_instance_id);
  assert.equal(derived.lexicalMeta.filter((row) => row.stream === 'messages').length, 1);
  assert.equal(derived.semanticMeta.filter((row) => row.stream === 'messages').length, 1);
  assert.equal(derived.semanticProgress.filter((row) => row.stream === 'messages').length, 0);
}

async function runPhaseFaultMatrix(driver) {
  const phases = [
    ['after-reservation', 'route'],
    ['after-durable-record', 'route'],
    ['after-durable-phase', 'route'],
    ['after-lexical-index', 'derived'],
    ['after-semantic-index', 'derived'],
    ['after-accepted-commit', 'route'],
  ];

  for (const [phase, hookKind] of phases) {
    const device = await enrollConfiguredDevice(driver, `phase-${phase}`);
    const key = `key-${phase}`;
    const suffixKey = `${key}-suffix`;
    const records = phase === 'after-durable-record'
      ? [
          deviceRecord(key, `content-${phase}`),
          deviceRecord(suffixKey, `content-${phase}-suffix`, { timestamp: '2026-07-16T12:00:01.000Z' }),
        ]
      : [deviceRecord(key, `content-${phase}`)];
    const request = batch(device, nextId('phase'), records);
    const notifications = [];
    let fired = false;
    setClientEventEnqueueHook((change) => notifications.push(change));
    const throwOnce = (point) => {
      if (!fired && point === phase) {
        fired = true;
        throw new Error('deterministic test phase interruption');
      }
    };
    try {
      if (hookKind === 'route') __setDeviceIngestPhaseFaultHookForTest(throwOnce);
      else __setRecordIndexFaultHookForTest(throwOnce);
      const interrupted = await driver.ingest(device, request);
      assert.equal(interrupted.status, 503, `${phase} must surface only retryable HTTP state`);
      assert.equal(interrupted.body.error.code, 'device_ingest_retryable');
    } finally {
      __setDeviceIngestPhaseFaultHookForTest(null);
      __setRecordIndexFaultHookForTest(null);
    }

    const beforeSnapshot = await driver.snapshot({
      device,
      batchId: request.batch_id,
      keys: [key, suffixKey],
    });
    const beforeResume = beforeSnapshot.outcome;
    const committed = phase !== 'after-reservation';
    const expectedPrefix = phase === 'after-reservation' ? 0 : (phase === 'after-durable-record' ? 1 : records.length);
    assert.equal(beforeResume.status, phase === 'after-accepted-commit' ? 'accepted' : 'processing');
    if (beforeResume.status === 'processing') {
      assert.equal(beforeResume.accepted_at, null);
      assert.equal(beforeResume.http_status, null);
      assert.equal(beforeResume.response_json, null);
    } else {
      assert.equal(beforeResume.http_status, 201);
      assert.ok(beforeResume.accepted_at);
      assert.ok(beforeResume.response_json);
    }
    assert.equal(Number(beforeResume.durable_prefix_count), expectedPrefix);
    assert.equal(await driver.changes(device.connector_instance_id, key), committed ? 1 : 0);
    assert.equal(beforeSnapshot.histories[key].length, committed ? 1 : 0);
    assert.equal(beforeSnapshot.versionCounter, committed ? 1 : 0);
    assert.equal(
      await driver.changes(device.connector_instance_id, suffixKey),
      phase === 'after-durable-record' ? 0 : 0,
      'the durable-record interruption cannot commit an unvisited suffix',
    );
    assert.deepEqual(notificationVersions(notifications), committed ? [1] : []);

    const resumed = await driver.ingest(device, request);
    assert.equal(resumed.status, 201);
    const replay = await driver.ingest(device, request);
    assert.equal(replay.status, 201);
    if (phase === 'after-durable-record') {
      const first = await driver.record(device.connector_instance_id, key);
      const second = await driver.record(device.connector_instance_id, suffixKey);
      assert.deepEqual(
        { firstVersion: first.version, secondVersion: second.version, changes: await driver.versions(device.connector_instance_id) },
        { firstVersion: 1, secondVersion: 2, changes: 2 },
        'retry starts at the persisted prefix and only writes the suffix',
      );
      assert.deepEqual(notificationVersions(notifications), [1, 2]);
      assert.equal((await assertOutcomeIdentity(driver, device, request)).durable_prefix_count, 2);
      assert.deepEqual(await driver.lexical(device.connector_instance_id, suffixKey), [{ field: 'content', text: `content-${phase}-suffix` }]);
      assert.deepEqual(await driver.semantic(device.connector_instance_id, suffixKey), [
        { scope_key: JSON.stringify(['messages', 'content']), record_key: suffixKey },
      ]);
      continue;
    }
    await assertAcceptedFinalState(driver, {
      device,
      request,
      batchId: request.batch_id,
      key,
      content: `content-${phase}`,
      version: 1,
      changes: 1,
      notifications,
    });
  }
  setClientEventEnqueueHook(null);
}

async function runConcurrentIdentityOracle(driver) {
  const device = await enrollConfiguredDevice(driver, 'concurrent-identity');
  const key = 'same-identity';
  const request = batch(device, nextId('concurrent'), [deviceRecord(key, 'one logical execution')]);
  const notifications = [];
  setClientEventEnqueueHook((change) => notifications.push(change));
  const enteredEmbedding = deferred();
  const releaseEmbedding = deferred();
  let heldEmbedding = false;
  driver.setEmbeddingHook(async () => {
    if (!heldEmbedding) {
      heldEmbedding = true;
      enteredEmbedding.resolve();
      await releaseEmbedding.promise;
    }
  });
  try {
    const firstPromise = driver.ingest(device, request);
    await within(enteredEmbedding.promise, 'the first identical request to enter embedding');
    let secondSettled = false;
    const secondPromise = driver.ingest(device, request).then((value) => {
      secondSettled = true;
      return value;
    });
    await yieldImmediate();
    assert.equal(secondSettled, false, 'the simultaneous replay must wait for the first real HTTP execution');
    releaseEmbedding.resolve();
    const [first, second] = await within(
      Promise.all([firstPromise, secondPromise]),
      'simultaneous identical HTTP requests',
    );
    assert.deepEqual([first.status, second.status].sort(), [201, 201]);
    assert.deepEqual(first.body, second.body, 'both requests return the one stored accepted response');
    assert.equal(driver.embeddingCalls(), 1, 'same identity performs one semantic execution');
    await assertAcceptedFinalState(driver, {
      device,
      request,
      batchId: request.batch_id,
      key,
      content: 'one logical execution',
      version: 1,
      changes: 1,
      notifications,
    });

    const differentRecords = [...request.records, deviceRecord('other-identity', 'different verified body')];
    const directIdentityMutations = [
      ['source_instance_id', 'other-authorized-source'],
      ['connector_instance_id', 'other-authorized-instance'],
      ['connector_id', 'other-canonical-connector'],
      ['batch_seq', request.batch_seq + 1],
    ];
    const conflicts = [
      { label: 'body hash', request: { ...request, records: differentRecords, body_hash: bodyHash(differentRecords) } },
      ...directIdentityMutations.map(([column, value]) => ({ label: column, column, value })),
    ];
    for (const conflict of conflicts) {
      if (conflict.column) {
        // Source/instance/canonical-id identity is resolved by authorized route
        // context and therefore cannot all be varied in a valid single-device
        // HTTP envelope. Mutate only this existing reservation through the
        // store fixture seam, then prove the shipped HTTP route takes conflict
        // precedence before any work. It is restored immediately afterwards.
        await driver.mutateOutcomeIdentity(device, request.batch_id, conflict.column, conflict.value);
      }
      // The mutation above deliberately changes only one reservation identity
      // member. From that exact setup state, the conflicting HTTP request must
      // be a zero-effect read: outcomes, derived state, and diagnostics are as
      // important here as record versions and notifications.
      const beforeConflict = await driver.snapshot({ device, batchId: request.batch_id, keys: [key] });
      const response = await driver.ingest(device, conflict.request ?? request);
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'device_batch_conflict');
      const afterConflict = await driver.snapshot({ device, batchId: request.batch_id, keys: [key] });
      assert.deepEqual(afterConflict, beforeConflict, `${conflict.label} conflict has no persistence or diagnostic effect`);
      assert.equal(await driver.changes(device.connector_instance_id, key), 1);
      assert.equal(await driver.versions(device.connector_instance_id), 1);
      assert.deepEqual(notificationVersions(notifications), [1]);
      if (conflict.column) {
        const canonical = {
          source_instance_id: device.source_instance_id,
          connector_instance_id: device.connector_instance_id,
          connector_id: 'codex',
          batch_seq: request.batch_seq,
        };
        await driver.mutateOutcomeIdentity(device, request.batch_id, conflict.column, canonical[conflict.column]);
      }
    }
  } finally {
    releaseEmbedding.resolve();
    driver.setEmbeddingHook(null);
    setClientEventEnqueueHook(null);
  }
}

async function runDuplicateAndNewerWriterOracle(driver) {
  for (const [label, records, expected] of [
    [
      'upsert-to-upsert',
      [deviceRecord('duplicate-upsert', 'A'), deviceRecord('duplicate-upsert', 'B', { timestamp: '2026-07-16T12:00:01.000Z' })],
      { key: 'duplicate-upsert', content: 'B', deleted: false, newerContent: 'newer direct B' },
    ],
    [
      'upsert-to-delete',
      [deviceRecord('duplicate-delete', 'A'), deviceRecord('duplicate-delete', '', { op: 'delete', timestamp: '2026-07-16T12:00:01.000Z' })],
      { key: 'duplicate-delete', content: null, deleted: true, newerContent: 'newer direct revival' },
    ],
  ]) {
    const device = await enrollConfiguredDevice(driver, `duplicate-${label}`);
    const request = batch(device, nextId(`duplicate-${label}`), records);
    const notifications = [];
    const failurePoints = ['after-lexical-index', 'after-semantic-index'];
    let failures = 0;
    setClientEventEnqueueHook((change) => notifications.push(change));
    __setRecordIndexFaultHookForTest((point) => {
      if (point === failurePoints[failures]) {
        failures += 1;
        throw new Error(`repeated post-durable index interruption at ${point}`);
      }
    });
    try {
      assert.equal((await driver.ingest(device, request)).status, 503);
      assert.equal((await driver.ingest(device, request)).status, 503);
    } finally {
      __setRecordIndexFaultHookForTest(null);
    }
    const stranded = await driver.outcome(device, request.batch_id);
    assert.equal(stranded.status, 'processing');
    assert.equal(stranded.durable_prefix_count, 2);
    const beforeNewer = await driver.record(device.connector_instance_id, expected.key);
    assert.equal(beforeNewer.deleted, expected.deleted);
    assert.equal(beforeNewer.version, 2);
    assert.equal(await driver.changes(device.connector_instance_id, expected.key), 2);
    assert.deepEqual(notificationVersions(notifications), [1, 2]);
    if (expected.deleted) {
      assert.deepEqual(await driver.lexical(device.connector_instance_id, expected.key), []);
      assert.deepEqual(await driver.semantic(device.connector_instance_id, expected.key), []);
    } else {
      assert.equal(beforeNewer.record_json.content, expected.content);
      assert.deepEqual(await driver.lexical(device.connector_instance_id, expected.key), [{ field: 'content', text: expected.content }]);
      assert.deepEqual(await driver.semantic(device.connector_instance_id, expected.key), [
        { scope_key: JSON.stringify(['messages', 'content']), record_key: expected.key },
      ]);
    }

    // The older reservation is deliberately still processing. A newer direct
    // authoritative write now wins before the old retry rereads its final
    // records; the retry may repair indexes but cannot restore A/B or a tombstone.
    await ingestRecord(
      driver.target(device.connector_instance_id),
      directRecord(expected.key, expected.newerContent, { timestamp: '2026-07-16T12:00:02.000Z' }),
    );
    assert.equal((await driver.record(device.connector_instance_id, expected.key)).version, 3);
    assert.equal((await driver.ingest(device, request)).status, 201);
    assert.equal((await driver.ingest(device, request)).status, 201);
    const final = await driver.record(device.connector_instance_id, expected.key);
    assert.deepEqual(
      { deleted: final.deleted, content: final.record_json.content, version: final.version, changes: await driver.changes(device.connector_instance_id, expected.key) },
      { deleted: false, content: expected.newerContent, version: 3, changes: 3 },
    );
    assert.deepEqual(notificationVersions(notifications), [1, 2, 3], 'resuming a durable prefix emits no duplicate notification');
    assert.deepEqual(await driver.lexical(device.connector_instance_id, expected.key), [{ field: 'content', text: expected.newerContent }]);
    assert.deepEqual(await driver.semantic(device.connector_instance_id, expected.key), [
      { scope_key: JSON.stringify(['messages', 'content']), record_key: expected.key },
    ]);
    assert.equal((await assertOutcomeIdentity(driver, device, request)).status, 'accepted');
    setClientEventEnqueueHook(null);
  }
}

async function runRepairAndCanonicalOracle(driver) {
  const device = await enrollConfiguredDevice(driver, 'derived-repair');
  const request = batch(device, nextId('repair'), [deviceRecord('repair-key', 'repair derived state')]);
  const notifications = [];
  setClientEventEnqueueHook((change) => notifications.push(change));
  let failSemantic = true;
  __setRecordIndexFaultHookForTest((point) => {
    if (point === 'after-lexical-index' && failSemantic) {
      failSemantic = false;
      throw new Error('processing reservation keeps a corruptible derived phase');
    }
  });
  try {
    assert.equal((await driver.ingest(device, request)).status, 503);
  } finally {
    __setRecordIndexFaultHookForTest(null);
  }
  await driver.corruptDerived(device.connector_instance_id, 'repair-key');
  assert.deepEqual(await driver.lexical(device.connector_instance_id, 'repair-key'), [
    { field: 'content', text: 'corrupt lexical value' },
  ]);
  assert.deepEqual(await driver.semantic(device.connector_instance_id, 'repair-key'), []);
  const corruptOutcome = await driver.outcome(device, request.batch_id);
  assert.deepEqual(
    { status: corruptOutcome.status, prefix: corruptOutcome.durable_prefix_count, acceptedAt: corruptOutcome.accepted_at },
    { status: 'processing', prefix: 1, acceptedAt: null },
  );
  assert.equal(await driver.changes(device.connector_instance_id, 'repair-key'), 1);
  driver.disableSemanticBackend();
  try {
    const unavailable = await driver.ingest(device, request);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error.code, 'device_ingest_retryable');
    const stranded = await driver.outcome(device, request.batch_id);
    assert.equal(stranded.status, 'processing');
    assert.equal(stranded.durable_prefix_count, 1);
    assert.equal(await driver.changes(device.connector_instance_id, 'repair-key'), 1);
    assert.deepEqual(notificationVersions(notifications), [1]);
  } finally {
    driver.restoreSemanticBackend();
  }
  assert.equal((await driver.ingest(device, request)).status, 201);
  await assertAcceptedFinalState(driver, {
    device,
    request,
    batchId: request.batch_id,
    key: 'repair-key',
    content: 'repair derived state',
    version: 1,
    changes: 1,
    notifications,
  });
  setClientEventEnqueueHook(null);

  const nestedDevice = await enrollConfiguredDevice(driver, 'canonical-nested');
  const original = [
    deviceRecord('nested-prefix', 'prefix', {
      nested: { z: { b: 2, a: 1 }, a: [{ z: 3, a: 4 }, { d: { b: 6, a: 5 }, c: 7 }] },
    }),
    deviceRecord('nested-suffix', 'suffix', { nested: { b: { y: 2, x: 1 }, a: true }, timestamp: '2026-07-16T12:00:03.000Z' }),
  ];
  const reordered = [
    deviceRecord('nested-prefix', 'prefix', {
      nested: { a: [{ a: 4, z: 3 }, { c: 7, d: { a: 5, b: 6 } }], z: { a: 1, b: 2 } },
    }),
    deviceRecord('nested-suffix', 'suffix', { nested: { a: true, b: { x: 1, y: 2 } }, timestamp: '2026-07-16T12:00:03.000Z' }),
  ];
  const nestedBatch = batch(nestedDevice, nextId('canonical-nested'), original);
  assert.equal(bodyHash(original), bodyHash(reordered));
  __setDeviceIngestPhaseFaultHookForTest((point, inputIndex) => {
    if (point === 'after-durable-record' && inputIndex === 0) throw new Error('partial prefix');
  });
  try {
    assert.equal((await driver.ingest(nestedDevice, nestedBatch)).status, 503);
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
  }
  const partial = await driver.outcome(nestedDevice, nestedBatch.batch_id);
  assert.deepEqual(
    { status: partial.status, prefix: partial.durable_prefix_count, acceptedAt: partial.accepted_at },
    { status: 'processing', prefix: 1, acceptedAt: null },
  );
  const prefix = await driver.record(nestedDevice.connector_instance_id, 'nested-prefix');
  assert.deepEqual(prefix.record_json, canonical(original[0].data));
  if (driver.kind === 'sqlite') {
    assert.equal(prefix.record_json_raw, JSON.stringify(canonical(original[0].data)), 'SQLite stores canonical nested JSON bytes');
  }
  const resumed = { ...nestedBatch, records: reordered, body_hash: bodyHash(reordered) };
  assert.equal((await driver.ingest(nestedDevice, resumed)).status, 201);
  assert.equal((await driver.ingest(nestedDevice, nestedBatch)).status, 201);
  assert.equal(await driver.changes(nestedDevice.connector_instance_id, 'nested-prefix'), 1);
  assert.equal(await driver.changes(nestedDevice.connector_instance_id, 'nested-suffix'), 1);
  const canonicalPrefix = await driver.record(nestedDevice.connector_instance_id, 'nested-prefix');
  assert.deepEqual(canonicalPrefix.record_json, canonical(reordered[0].data), 'PostgreSQL JSONB and SQLite JSON agree structurally');
  if (driver.kind === 'sqlite') {
    assert.equal(canonicalPrefix.record_json_raw, JSON.stringify(canonical(reordered[0].data)));
  }
}

async function runStrandedDiagnosticsOracle(driver) {
  const device = await enrollConfiguredDevice(driver, 'stranded-diagnostics');
  const request = batch(device, nextId('stranded'), [deviceRecord('stranded-key', 'not yet accepted')]);
  const initialDiagnostics = await driver.diagnosticsSnapshot(device, device.source_instance_id);
  assert.deepEqual(
    {
      accepted: initialDiagnostics.source.accepted_record_count,
      rejected: initialDiagnostics.source.rejected_record_count,
      sourceLastIngestAt: initialDiagnostics.source.last_ingest_at,
      deviceLastIngestAt: initialDiagnostics.device.last_ingest_at,
    },
    { accepted: 0, rejected: 0, sourceLastIngestAt: null, deviceLastIngestAt: null },
  );
  __setDeviceIngestPhaseFaultHookForTest((point, inputIndex) => {
    if (point === 'after-durable-record' && inputIndex === 0) throw new Error('strand after durable prefix');
  });
  try {
    assert.equal((await driver.ingest(device, request)).status, 503);
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
  }
  const processing = await driver.outcome(device, request.batch_id);
  assert.deepEqual(
    { status: processing.status, acceptedAt: processing.accepted_at, prefix: Number(processing.durable_prefix_count) },
    { status: 'processing', acceptedAt: null, prefix: 1 },
  );
  assert.equal((await driver.record(device.connector_instance_id, 'stranded-key')).version, 1);
  assert.equal(await driver.changes(device.connector_instance_id, 'stranded-key'), 1);
  const strandedDiagnostics = await driver.diagnosticsSnapshot(device, device.source_instance_id);
  assert.deepEqual(
    {
      accepted: strandedDiagnostics.source.accepted_record_count,
      rejected: strandedDiagnostics.source.rejected_record_count,
      sourceLastIngestAt: strandedDiagnostics.source.last_ingest_at,
      deviceLastIngestAt: strandedDiagnostics.device.last_ingest_at,
    },
    { accepted: 0, rejected: 0, sourceLastIngestAt: null, deviceLastIngestAt: null },
    'a durable processing prefix is neither an accepted nor rejected diagnostic outcome',
  );
  assert.deepEqual(
    diagnosticFreshnessInputs(strandedDiagnostics),
    diagnosticFreshnessInputs(initialDiagnostics),
    'a processing prefix cannot advance any exposed freshness input',
  );
  const processingOutcomes = await driver.outcomes(device);
  assert.deepEqual(
    processingOutcomes.map((outcome) => ({ batchId: outcome.batch_id, status: outcome.status, acceptedAt: outcome.accepted_at })),
    [{ batchId: request.batch_id, status: 'processing', acceptedAt: null }],
  );
  assert.deepEqual(
    processingOutcomes.filter((outcome) => ['accepted', 'rejected'].includes(outcome.status)),
    [],
    'a processing reservation must not have terminal diagnostic membership',
  );

  // The assertions above only prove the shape of a raw row read directly
  // against `device_ingest_batch_outcomes`; they never drive the production
  // ordinary-terminal-list seam a real caller actually uses
  // (`GET /_ref/device-exporters/diagnostics` -> `buildDeviceExporterDiagnostics`
  // -> `store.listBatchOutcomes` -> `aggregateOutcomeStats`, which is an
  // unfiltered list that filters to `status === 'accepted' | 'rejected'` only
  // inside the route's in-memory reducer). Nor is the zero-count assertion
  // above (`strandedDiagnostics.source.accepted_record_count === 0`) sensitive
  // to a broken filter: a stranded `processing` row's `response_json` is null,
  // so it contributes 0 to `accepted_record_count` whether or not the status
  // check is correct. Accept a second, independent batch on the same source
  // while the first stays stranded in `processing`, then re-read diagnostics
  // through the real HTTP route: a filter regression that lets a `processing`
  // row leak into the terminal aggregate (e.g. `status !== 'rejected'` instead
  // of `status === 'accepted'`) would corrupt this non-zero count, so this is
  // a non-vacuous proof that the production seam discriminates correctly.
  const coexisting = batch(device, nextId('stranded-coexisting'), [deviceRecord('coexisting-key', 'accepted while sibling is stranded')]);
  assert.equal((await driver.ingest(device, coexisting)).status, 201);
  const coexistingOutcome = await driver.outcome(device, coexisting.batch_id);
  const coexistingAcceptedAt = coexistingOutcome.accepted_at;
  assert.ok(coexistingAcceptedAt);
  const mixedDiagnostics = await driver.diagnosticsSnapshot(device, device.source_instance_id);
  assert.deepEqual(
    {
      accepted: mixedDiagnostics.source.accepted_record_count,
      rejected: mixedDiagnostics.source.rejected_record_count,
      sourceLastIngestAt: mixedDiagnostics.source.last_ingest_at,
    },
    { accepted: 1, rejected: 0, sourceLastIngestAt: coexistingAcceptedAt },
    'the production diagnostics route attributes the accepted sibling batch and nothing from the still-stranded processing batch',
  );
  const mixedOutcomes = await driver.outcomes(device);
  assert.deepEqual(
    mixedOutcomes
      .map((outcome) => ({ batchId: outcome.batch_id, status: outcome.status }))
      .sort((a, b) => a.batchId.localeCompare(b.batchId)),
    [
      { batchId: coexisting.batch_id, status: 'accepted' },
      { batchId: request.batch_id, status: 'processing' },
    ].sort((a, b) => a.batchId.localeCompare(b.batchId)),
    'the stranded batch remains processing while its sibling reaches a terminal status',
  );

  assert.equal((await driver.ingest(device, request)).status, 201);
  const acceptedOutcome = await driver.outcome(device, request.batch_id);
  const acceptedAt = acceptedOutcome.accepted_at;
  assert.ok(acceptedAt);
  const acceptedDiagnostics = await driver.diagnosticsSnapshot(device, device.source_instance_id);
  assert.deepEqual(
    {
      accepted: acceptedDiagnostics.source.accepted_record_count,
      rejected: acceptedDiagnostics.source.rejected_record_count,
      sourceLastIngestAt: acceptedDiagnostics.source.last_ingest_at,
      deviceLastIngestAt: acceptedDiagnostics.device.last_ingest_at,
    },
    // Two batches are now terminal (`coexisting` accepted earlier, `request`
    // accepted here); the count includes both and freshness tracks whichever
    // accepted_at is later, proving the production seam aggregates across
    // multiple terminal rows rather than merely tolerating a single one.
    { accepted: 2, rejected: 0, sourceLastIngestAt: acceptedAt, deviceLastIngestAt: acceptedAt },
    'diagnostics derive acceptance exactly from the persisted terminal timestamp',
  );
  assert.deepEqual(
    diagnosticFreshnessInputs(acceptedDiagnostics),
    diagnosticFreshnessInputs(initialDiagnostics),
    'acceptance changes ingest recency, not heartbeat/outbox/coverage freshness inputs',
  );
  assert.deepEqual(
    (await driver.outcomes(device))
      .map((outcome) => ({ batchId: outcome.batch_id, status: outcome.status, acceptedAt: outcome.accepted_at }))
      .sort((a, b) => a.batchId.localeCompare(b.batchId)),
    [
      { batchId: coexisting.batch_id, status: 'accepted', acceptedAt: coexistingAcceptedAt },
      { batchId: request.batch_id, status: 'accepted', acceptedAt },
    ].sort((a, b) => a.batchId.localeCompare(b.batchId)),
  );
  const beforeReplay = await driver.snapshot({ device, batchId: request.batch_id, keys: ['stranded-key'] });
  assert.equal((await driver.ingest(device, request)).status, 201);
  const afterReplay = await driver.snapshot({ device, batchId: request.batch_id, keys: ['stranded-key'] });
  assert.deepEqual(afterReplay, beforeReplay, 'accepted replay cannot change diagnostics or persisted state');
}

async function generationManifests(driver) {
  const m1 = await configureMessagesManifest(driver, (messages, manifest) => {
    delete manifest.storage_binding;
    messages.primary_key = ['id'];
    messages.cursor_field = 'timestamp';
    messages.consent_time_field = 'timestamp';
    messages.schema.properties.updated_at = { type: 'string', format: 'date-time' };
    messages.query.search.lexical_fields = ['content'];
    messages.query.search.semantic_fields = ['content'];
  });
  const m2 = structuredClone(m1);
  const stream = m2.streams.find((entry) => entry.name === 'messages');
  stream.primary_key = ['session_id'];
  stream.cursor_field = 'updated_at';
  stream.consent_time_field = 'updated_at';
  stream.query.search.lexical_fields = ['role'];
  stream.query.search.semantic_fields = ['role'];
  return { m1, m2 };
}

function generationRecord(key, content, timestamp = '2026-07-16T12:00:00.000Z', sessionId = key) {
  return deviceRecord(key, content, {
    timestamp,
    fields: {
      // Keep the key valid under both M1 and M2 so a retry can refresh only
      // frozen manifest facts rather than allocating a replacement record.
      session_id: sessionId,
      updated_at: '2026-07-16T14:00:00.000Z',
    },
  });
}

async function assertM2GenerationFinal(driver, {
  device,
  request,
  key,
  notifications,
  expectedChanges = 1,
  expectedPrimary = key,
  notificationVersionsExpected = Array.from({ length: expectedChanges }, (_, index) => index + 1),
  m1Fingerprint = null,
}) {
  const outcome = await assertOutcomeIdentity(driver, device, request);
  assert.equal(outcome.status, 'accepted');
  assert.equal(outcome.http_status, 201);
  assert.ok(outcome.accepted_at);
  assert.equal(outcome.durable_prefix_count, outcome.record_count);
  if (m1Fingerprint) assert.notEqual(outcome.manifest_fingerprint, m1Fingerprint, 'accepted retry records the M2 generation');
  const row = await driver.record(device.connector_instance_id, key);
  assert.deepEqual(
    {
      cursor: row.cursor_value,
      primary: row.primary_key_text,
      semanticTime: row.semantic_time,
      version: row.version,
      changes: await driver.changes(device.connector_instance_id, key),
    },
    {
      cursor: '2026-07-16T14:00:00.000Z',
      primary: expectedPrimary,
      semanticTime: '2026-07-16T14:00:00.000Z',
      version: expectedChanges,
      changes: expectedChanges,
    },
  );
  assert.deepEqual(await driver.lexical(device.connector_instance_id, key), [{ field: 'role', text: 'user' }]);
  assert.deepEqual(await driver.semantic(device.connector_instance_id, key), [
    { scope_key: JSON.stringify(['messages', 'role']), record_key: key },
  ]);
  assert.deepEqual(notificationVersions(notifications), notificationVersionsExpected);
  const derived = await driver.derivedState(device.connector_instance_id);
  assert.equal(derived.lexicalMeta.filter((entry) => entry.stream === 'messages').length, 1);
  assert.equal(derived.semanticMeta.filter((entry) => entry.stream === 'messages').length, 1);
  assert.equal(derived.semanticProgress.filter((entry) => entry.stream === 'messages').length, 0);
}

async function assertPostgresRegistrationStreamIsolation(driver) {
  if (driver.kind !== 'postgres') return;

  const device = await driver.enroll('registration-stream-isolation');
  const { m2 } = await generationManifests(driver);
  const key = 'same-key-in-two-streams';
  await ingestRecord(driver.target(device.connector_instance_id), {
    stream: 'sessions',
    key,
    emitted_at: '2026-07-16T12:00:00.000Z',
    op: 'upsert',
    data: {
      id: key,
      last_event_at: '2026-07-16T12:01:00.000Z',
      started_at: '2026-07-16T12:02:00.000Z',
    },
  });
  await ingestRecord(
    driver.target(device.connector_instance_id),
    directRecord(key, 'message remains independent', {
      fields: {
        session_id: 'message-primary-key',
        updated_at: '2026-07-16T12:04:00.000Z',
      },
    }),
  );

  // This is the public registration path. M2 changes the messages sort facts
  // while sessions keeps its declared facts. The two rows intentionally share
  // record_key, which proves repair writes must retain stream in their identity.
  await driver.registerManifest(m2);
  const session = await driver.record(device.connector_instance_id, key, 'sessions');
  const message = await driver.record(device.connector_instance_id, key, 'messages');
  assert.deepEqual(
    {
      cursor: session.cursor_value,
      primaryKey: session.primary_key_text,
      semanticTime: session.semantic_time,
    },
    {
      cursor: '2026-07-16T12:01:00.000Z',
      primaryKey: key,
      semanticTime: '2026-07-16T12:02:00.000Z',
    },
    'messages registration repair cannot overwrite sessions sort facts with the same record key',
  );
  assert.deepEqual(
    {
      cursor: message.cursor_value,
      primaryKey: message.primary_key_text,
      semanticTime: message.semantic_time,
    },
    {
      cursor: '2026-07-16T12:04:00.000Z',
      primaryKey: 'message-primary-key',
      semanticTime: '2026-07-16T12:04:00.000Z',
    },
  );
}

async function runManifestRegistrationOracle(driver) {
  // M1 gets a durable prefix, then M2 performs its complete shipped
  // registration/backfill before the old reservation retries.
  const afterDevice = await driver.enroll('manifest-registration-last');
  const { m1, m2 } = await generationManifests(driver);
  const afterRequest = batch(afterDevice, nextId('manifest-registration-last'), [generationRecord('manifest-last', 'after device')]);
  const afterNotifications = [];
  setClientEventEnqueueHook((change) => afterNotifications.push(change));
  __setDeviceIngestPhaseFaultHookForTest((point) => {
    if (point === 'after-durable-phase') throw new Error('hold M1 after durable phase');
  });
  try {
    assert.equal((await driver.ingest(afterDevice, afterRequest)).status, 503);
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
  }
  const m1Outcome = await assertOutcomeIdentity(driver, afterDevice, afterRequest, { status: 'processing' });
  assert.equal(m1Outcome.durable_prefix_count, 1);
  await driver.registerManifest(m2);
  assert.equal((await driver.ingest(afterDevice, afterRequest)).status, 201);
  await assertM2GenerationFinal(driver, {
    device: afterDevice,
    request: afterRequest,
    key: 'manifest-last',
    notifications: afterNotifications,
    m1Fingerprint: m1Outcome.manifest_fingerprint,
  });
  setClientEventEnqueueHook(null);

  // The inverse ordering queues complete M2 registration/backfill before the
  // M1-origin request can enter the same instance fence.
  const beforeDevice = await driver.enroll('manifest-registration-first');
  await driver.registerManifest(m1);
  await ingestRecord(driver.target(beforeDevice.connector_instance_id), {
    stream: 'sessions',
    key: 'registration-order-seed',
    emitted_at: '2026-07-16T11:00:00.000Z',
    op: 'upsert',
    data: {
      id: 'registration-order-seed',
      last_event_at: '2026-07-16T11:00:00.000Z',
      started_at: '2026-07-16T10:00:00.000Z',
    },
  });
  const m2BackfillAtTarget = deferred();
  const releaseM2Backfill = deferred();
  const pauseM2AtTarget = async (point, context) => {
    if (point === 'inside-instance-fence' && context.connectorInstanceId === beforeDevice.connector_instance_id) {
      m2BackfillAtTarget.resolve();
      await releaseM2Backfill.promise;
    }
  };
  if (driver.kind === 'postgres') __setPostgresRecordSortBackfillPhaseHookForTest(pauseM2AtTarget);
  else __setSqliteRecordSortBackfillPhaseHookForTest(pauseM2AtTarget);
  let inverseRegistration;
  try {
    inverseRegistration = driver.registerManifest(m2);
    await within(m2BackfillAtTarget.promise, 'M2 sort backfill to own the target instance');
    // Registration owns the same-instance fence before the device request is
    // issued, so this is a deterministic registration-first order.
    const beforeRequest = batch(beforeDevice, nextId('manifest-registration-first'), [generationRecord('manifest-first', 'before device')]);
    const beforeNotifications = [];
    setClientEventEnqueueHook((change) => beforeNotifications.push(change));
    const devicePromise = driver.ingest(beforeDevice, beforeRequest);
    releaseM2Backfill.resolve();
    await within(inverseRegistration, 'registration-first M2 backfills');
    assert.equal((await within(devicePromise, 'device ingest queued behind M2 registration')).status, 201);
    await assertM2GenerationFinal(driver, {
      device: beforeDevice,
      request: beforeRequest,
      key: 'manifest-first',
      notifications: beforeNotifications,
    });
    setClientEventEnqueueHook(null);
  } finally {
    releaseM2Backfill.resolve();
    __setLexicalBackfillPhaseHookForTest(null);
    __setSqliteRecordSortBackfillPhaseHookForTest(null);
    __setPostgresRecordSortBackfillPhaseHookForTest(null);
    await Promise.allSettled([inverseRegistration].filter(Boolean));
  }

  // Once M1 is terminal, M2's actual registration/backfill is explicitly the
  // final writer: it must refresh durable sort facts as well as both indexes.
  const terminalDevice = await driver.enroll('manifest-terminal-before-m2');
  await driver.registerManifest(m1);
  const terminalRequest = batch(terminalDevice, nextId('manifest-terminal-before-m2'), [
    generationRecord('manifest-terminal', 'accepted under M1', '2026-07-16T12:00:00.000Z', 'manifest-terminal-m2-primary'),
  ]);
  const terminalNotifications = [];
  setClientEventEnqueueHook((change) => terminalNotifications.push(change));
  assert.equal((await driver.ingest(terminalDevice, terminalRequest)).status, 201);
  await driver.registerManifest(m2);
  await assertM2GenerationFinal(driver, {
    device: terminalDevice,
    request: terminalRequest,
    key: 'manifest-terminal',
    notifications: terminalNotifications,
    expectedPrimary: 'manifest-terminal-m2-primary',
  });
  setClientEventEnqueueHook(null);

  // This is the literal mid-prefix drift case: M2 is persisted after record
  // zero and before record one. Registration is paused only after persistence
  // so the held M1 attempt reaches its generation-fenced acceptance and fails;
  // its real backfills then finish before the no-prefix-replay retry.
  const midDevice = await driver.enroll('manifest-mid-prefix');
  await driver.registerManifest(m1);
  const midRequest = batch(midDevice, nextId('manifest-mid-prefix'), [
    generationRecord('manifest-mid-prefix', 'first durable'),
    generationRecord('manifest-mid-suffix', 'second durable', '2026-07-16T12:00:01.000Z'),
  ]);
  const midPersisted = deferred();
  const releaseMidBackfill = deferred();
  let midRegistration;
  let registered = false;
  const midNotifications = [];
  setClientEventEnqueueHook((change) => midNotifications.push(change));
  __setRegisterConnectorPhaseHookForTest(async (point) => {
    if (point === 'after-manifest-persisted') {
      midPersisted.resolve();
      await releaseMidBackfill.promise;
    }
  });
  __setDeviceIngestPhaseFaultHookForTest(async (point, inputIndex) => {
    if (point === 'after-durable-record' && inputIndex === 0 && !registered) {
      registered = true;
      midRegistration = driver.registerManifest(m2);
      await within(midPersisted.promise, 'mid-prefix M2 manifest persistence');
    }
  });
  try {
    assert.equal((await driver.ingest(midDevice, midRequest)).status, 503, 'M1 cannot accept after M2 persists');
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
    releaseMidBackfill.resolve();
    await within(Promise.allSettled([midRegistration].filter(Boolean)), 'mid-prefix M2 backfills');
    __setRegisterConnectorPhaseHookForTest(null);
  }
  const midOutcome = await driver.outcome(midDevice, midRequest.batch_id);
  assert.deepEqual(
    { status: midOutcome.status, prefix: midOutcome.durable_prefix_count, acceptedAt: midOutcome.accepted_at },
    { status: 'processing', prefix: 2, acceptedAt: null },
  );
  assert.equal(await driver.changes(midDevice.connector_instance_id, 'manifest-mid-prefix'), 1);
  assert.equal(await driver.changes(midDevice.connector_instance_id, 'manifest-mid-suffix'), 1);
  assert.deepEqual(notificationVersions(midNotifications), [1, 2]);
  assert.equal((await driver.ingest(midDevice, midRequest)).status, 201);
  await assertM2GenerationFinal(driver, {
    device: midDevice,
    request: midRequest,
    key: 'manifest-mid-prefix',
    notifications: midNotifications,
    notificationVersionsExpected: [1, 2],
    m1Fingerprint: midOutcome.manifest_fingerprint,
  });
  const midSuffix = await driver.record(midDevice.connector_instance_id, 'manifest-mid-suffix');
  assert.deepEqual(
    { cursor: midSuffix.cursor_value, primary: midSuffix.primary_key_text, semanticTime: midSuffix.semantic_time, version: midSuffix.version },
    { cursor: '2026-07-16T14:00:00.000Z', primary: 'manifest-mid-suffix', semanticTime: '2026-07-16T14:00:00.000Z', version: 2 },
  );
  assert.deepEqual(await driver.lexical(midDevice.connector_instance_id, 'manifest-mid-suffix'), [{ field: 'role', text: 'user' }]);
  assert.deepEqual(await driver.semantic(midDevice.connector_instance_id, 'manifest-mid-suffix'), [
    { scope_key: JSON.stringify(['messages', 'role']), record_key: 'manifest-mid-suffix' },
  ]);
  assert.deepEqual(notificationVersions(midNotifications), [1, 2]);
  setClientEventEnqueueHook(null);

  await assertPostgresRegistrationStreamIsolation(driver);
}

function collisionHistory(...deletedByVersion) {
  return deletedByVersion.map((deleted, index) => ({ version: index + 1, deleted }));
}

function activeCollisionExpected({ content, version, history, notifications, outcomeStatus }) {
  return {
    outcomeStatus,
    record: {
      deleted: false,
      content,
      version,
      cursor: '2026-07-16T12:00:00.000Z',
      primary: 'collision',
      semanticTime: '2026-07-16T12:00:00.000Z',
    },
    history,
    versionCounter: version,
    lexical: [{ field: 'content', text: content }],
    semantic: [{
      scope_key: JSON.stringify(['messages', 'content']),
      record_key: 'collision',
      embedding: normalizedVector(vectorForText(content)),
    }],
    derived: { lexicalMeta: 1, semanticMeta: 1, semanticProgress: 0 },
    notifications,
  };
}

function deletedCollisionExpected({ version, history, notifications, outcomeStatus }) {
  return {
    outcomeStatus,
    record: { deleted: true, version },
    history,
    versionCounter: version,
    lexical: [],
    semantic: [],
    derived: { lexicalMeta: 1, semanticMeta: 1, semanticProgress: 0 },
    notifications,
  };
}

function absentCollisionExpected({ notifications, outcomeStatus }) {
  return {
    outcomeStatus,
    record: null,
    history: [],
    versionCounter: 0,
    lexical: [],
    semantic: [],
    derived: { lexicalMeta: 0, semanticMeta: 0, semanticProgress: 0 },
    notifications,
  };
}

async function collisionSnapshot(driver, device, request, notifications) {
  const row = await driver.record(device.connector_instance_id, 'collision');
  const derived = await driver.derivedState(device.connector_instance_id);
  const outcome = await driver.outcome(device, request.batch_id);
  return {
    outcomeStatus: outcome?.status ?? null,
    record: row == null
      ? null
      : row.deleted
        ? { deleted: true, version: row.version }
        : {
            deleted: false,
            content: row.record_json.content,
            version: row.version,
            cursor: row.cursor_value,
            primary: row.primary_key_text,
            semanticTime: row.semantic_time,
          },
    history: await driver.history(device.connector_instance_id, 'collision'),
    versionCounter: await driver.versions(device.connector_instance_id),
    lexical: await driver.lexical(device.connector_instance_id, 'collision'),
    semantic: await driver.semanticWithEmbedding(device.connector_instance_id, 'collision'),
    derived: {
      lexicalMeta: derived.lexicalMeta.filter((entry) => entry.stream === 'messages').length,
      semanticMeta: derived.semanticMeta.filter((entry) => entry.stream === 'messages').length,
      semanticProgress: derived.semanticProgress.filter((entry) => entry.stream === 'messages').length,
    },
    notifications: notificationVersions(
      notifications.filter((change) => change.connectorInstanceId === device.connector_instance_id),
    ),
  };
}

function firstCollisionExpected(writerName, order) {
  if (order === 'device-first') {
    return activeCollisionExpected({
      content: 'device final',
      version: 2,
      history: collisionHistory(false, false),
      notifications: [2],
      outcomeStatus: 'accepted',
    });
  }
  if (writerName === 'direct-upsert') {
    return activeCollisionExpected({
      content: 'direct final',
      version: 2,
      history: collisionHistory(false, false),
      notifications: [2],
      outcomeStatus: null,
    });
  }
  if (writerName === 'direct-delete') {
    return deletedCollisionExpected({
      version: 2,
      history: collisionHistory(false, true),
      notifications: [],
      outcomeStatus: null,
    });
  }
  if (writerName === 'stream-delete') {
    return absentCollisionExpected({ notifications: [], outcomeStatus: null });
  }
  return activeCollisionExpected({
    content: 'initial state',
    version: 1,
    history: collisionHistory(false),
    notifications: [],
    outcomeStatus: null,
  });
}

function finalCollisionExpected(writerName, order) {
  if (order === 'direct-first') {
    if (writerName === 'stream-delete') {
      return activeCollisionExpected({
        content: 'device final',
        version: 1,
        history: collisionHistory(false),
        notifications: [1],
        outcomeStatus: 'accepted',
      });
    }
    const history = writerName === 'direct-delete'
      ? collisionHistory(false, true, false)
      : writerName === 'direct-upsert'
        ? collisionHistory(false, false, false)
        : collisionHistory(false, false);
    return activeCollisionExpected({
      content: 'device final',
      version: history.length,
      history,
      notifications: writerName === 'direct-delete'
        ? [3]
        : history.length === 3
          ? [2, 3]
          : [2],
      outcomeStatus: 'accepted',
    });
  }
  if (writerName === 'direct-upsert') {
    return activeCollisionExpected({
      content: 'direct final',
      version: 3,
      history: collisionHistory(false, false, false),
      notifications: [2, 3],
      outcomeStatus: 'accepted',
    });
  }
  if (writerName === 'direct-delete') {
    return deletedCollisionExpected({
      version: 3,
      history: collisionHistory(false, false, true),
      notifications: [2],
      outcomeStatus: 'accepted',
    });
  }
  if (writerName === 'stream-delete') {
    return absentCollisionExpected({ notifications: [2], outcomeStatus: 'accepted' });
  }
  return activeCollisionExpected({
    content: 'device final',
    version: 2,
    history: collisionHistory(false, false),
    notifications: [2],
    outcomeStatus: 'accepted',
  });
}

async function runWriterCollisionOracle(driver) {
  const writers = [
    {
      name: 'direct-upsert',
      apply: async (target, manifest) => await ingestRecord(target, directRecord('collision', 'direct final')),
    },
    {
      name: 'direct-delete',
      apply: async (target) => await deleteRecord(target, 'messages', 'collision'),
    },
    {
      name: 'stream-delete',
      apply: async (target) => await deleteAllRecords(target, 'messages'),
    },
    {
      name: 'lexical-backfill',
      apply: async (_target, manifest) => await lexicalIndexBackfillForManifest({ manifest }),
    },
    {
      name: 'semantic-backfill',
      apply: async (_target, manifest) => await semanticIndexBackfillForManifest({ manifest }),
    },
  ];

  for (const writer of writers) {
    for (const order of ['device-first', 'direct-first']) {
      const device = await driver.enroll(`${writer.name}-${order}`);
      const sibling = await driver.enroll(`${writer.name}-${order}-sibling`);
      await configureMessagesManifest(driver);
      const manifest = await driver.manifest();
      manifest.storage_binding = { connector_instance_id: device.connector_instance_id };
      const target = driver.target(device.connector_instance_id);
      await ingestRecord(target, directRecord('collision', 'initial state'));
      const notifications = [];
      setClientEventEnqueueHook((change) => notifications.push(change));
      const request = batch(device, nextId(`${writer.name}-${order}`), [deviceRecord('collision', 'device final')]);
      const holderRelease = deferred();
      const holderEntered = deferred();
      const holder = withConnectorInstanceWrite(device.connector_instance_id, async () => {
        holderEntered.resolve();
        await holderRelease.promise;
      });
      await within(holderEntered.promise, `${writer.name} ordering holder`);

      const firstEnqueued = deferred();
      const secondEnqueued = deferred();
      const secondAcquired = deferred();
      const releaseSecond = deferred();
      let enqueued = 0;
      let acquired = 0;
      __setConnectorInstanceWritePhaseHookForTest(async (stage, context) => {
        if (context.connectorInstanceId !== device.connector_instance_id) return;
        if (stage === 'before_key_acquire') {
          enqueued += 1;
          if (enqueued === 1) firstEnqueued.resolve();
          if (enqueued === 2) secondEnqueued.resolve();
          return;
        }
        acquired += 1;
        if (acquired === 2) {
          secondAcquired.resolve();
          await releaseSecond.promise;
        }
      });

      let firstPromise;
      let secondPromise;
      let deviceResult;
      try {
        const deviceOperation = async () => {
          const result = await driver.ingest(device, request);
          deviceResult = result;
          return result;
        };
        const directOperation = async () => await writer.apply(target, manifest);
        firstPromise = order === 'device-first' ? deviceOperation() : directOperation();
        await within(firstEnqueued.promise, `${writer.name} first writer enqueue`);
        secondPromise = order === 'device-first' ? directOperation() : deviceOperation();
        await within(secondEnqueued.promise, `${writer.name} second writer enqueue`);

        const siblingRequest = batch(sibling, nextId('sibling-overlap'), [deviceRecord('sibling', 'overlaps')]);
        assert.equal((await driver.ingest(sibling, siblingRequest)).status, 201, 'different instances continue while both target writers are queued');
        const siblingRow = await driver.record(sibling.connector_instance_id, 'sibling');
        assert.equal(siblingRow.record_json.content, 'overlaps');

        holderRelease.resolve();
        await within(
          Promise.all([holder, firstPromise, secondAcquired.promise]),
          `${writer.name} first writer completion and second-writer barrier`,
        );
        assert.deepEqual(
          await collisionSnapshot(driver, device, request, notifications),
          firstCollisionExpected(writer.name, order),
          `${writer.name} ${order} state at the first writer acknowledgement`,
        );

        releaseSecond.resolve();
        await within(secondPromise, `${writer.name} second writer completion`);
        assert.equal(deviceResult.status, 201);
        assert.deepEqual(
          await collisionSnapshot(driver, device, request, notifications),
          finalCollisionExpected(writer.name, order),
          `${writer.name} ${order} state at the second writer acknowledgement`,
        );
      } finally {
        holderRelease.resolve();
        releaseSecond.resolve();
        __setConnectorInstanceWritePhaseHookForTest(null);
        await Promise.allSettled([holder, firstPromise, secondPromise].filter(Boolean));
      }
      const coordinator = connectorInstanceWriteCoordinatorStatsForTests();
      assert.deepEqual(
        { activeWriters: coordinator.activeWriters, activeOwnerships: coordinator.activeOwnerships, queuedWriters: coordinator.queuedWriters },
        { activeWriters: 0, activeOwnerships: 0, queuedWriters: 0 },
      );
      setClientEventEnqueueHook(null);
    }
  }
}

const ORACLES = [
  ['phase fault/resume matrix', runPhaseFaultMatrix],
  ['simultaneous identity matrix', runConcurrentIdentityOracle],
  ['duplicate and newer writer matrix', runDuplicateAndNewerWriterOracle],
  ['derived repair and canonical records', runRepairAndCanonicalOracle],
  ['stranded processing diagnostics', runStrandedDiagnosticsOracle],
  ['registration/backfill ordering', runManifestRegistrationOracle],
  ['device/direct writer collision matrix', runWriterCollisionOracle],
];

for (const [name, oracle] of ORACLES) {
  test(`SQLite device-ingest conformance: ${name}`, async () => {
    await withBackend('sqlite', oracle);
  });
  test(`PostgreSQL device-ingest conformance: ${name}`, {
    skip: !DEDICATED_POSTGRES_URL,
  }, async () => {
    await withBackend('postgres', oracle);
  });
}
