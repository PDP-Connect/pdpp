import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { closeDb } from '../../server/db.js';
import { startServer } from '../../server/index.js';
import { closePostgresStorage, postgresQuery } from '../../server/postgres-storage.js';
import { makeLocalTransformerBackend } from '../../server/search-semantic.js';

class NeverExitingTransformerChild extends EventEmitter {
  constructor() {
    super();
    this.pid = process.pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  }

  kill() {
    return true;
  }
}

function deterministicRecoveryBackend() {
  const vector = new Float32Array([0.25, 0.5, 0.75]);
  return {
    model: () => 'failstop-recovery',
    dimensions: () => vector.length,
    distanceMetric: () => 'cosine',
    available: () => true,
    supportsDeviceAttemptDeadline: () => true,
    embedDocument: async () => vector,
    embedQuery: async () => vector,
    close: async () => undefined,
  };
}

function failStopBackend() {
  return makeLocalTransformerBackend({
    profileId: 'failstop-test',
    modelId: 'never-exits',
    dimensions: 3,
    distanceMetric: 'cosine',
    dtype: 'q4',
    cacheDir: '/not-read-by-fake-child',
    downloadAllowed: true,
    languageBias: null,
  }, {
    executorOptions: {
      deadlineMs: 30,
      termGraceMs: 30,
      killGraceMs: 30,
      queueLimit: 1,
      workLimit: 1,
      spawnChild: () => new NeverExitingTransformerChild(),
    },
  });
}

const mode = process.env.PDPP_FAILSTOP_FIXTURE_MODE;
const databaseUrl = process.env.PDPP_FAILSTOP_FIXTURE_DATABASE_URL;
if (!databaseUrl || (mode !== 'fail' && mode !== 'recover')) {
  throw new Error('fail-stop fixture requires mode and database URL');
}

process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS = '5000';
process.env.PDPP_INGEST_FINAL_INDEX_PLAN_CONCURRENCY = '1';
process.env.PDPP_SEMANTIC_WORK_LIMIT = '1';

const backend = mode === 'fail' ? failStopBackend() : deterministicRecoveryBackend();
const server = await startServer({
  asPort: 0,
  awaitStartupBackfill: true,
  databaseUrl,
  dbPath: ':memory:',
  quiet: true,
  rsPort: 0,
  semanticRetrievalBackend: backend,
  startClientEventDeliveryWorker: false,
  storageBackend: 'postgres',
});

const manifestResult = await postgresQuery('SELECT manifest FROM connectors WHERE connector_id = $1', ['codex']);
const manifest = typeof manifestResult.rows[0]?.manifest === 'string'
  ? JSON.parse(manifestResult.rows[0].manifest)
  : manifestResult.rows[0]?.manifest;
const messages = manifest.streams.find((stream) => stream.name === 'messages');
messages.query.search.lexical_fields = ['content'];
messages.query.search.semantic_fields = ['content'];
const manifestJson = JSON.stringify(manifest);
await postgresQuery('UPDATE connectors SET manifest = $1::jsonb WHERE connector_id = $2', [manifestJson, 'codex']);

process.stdout.write(`${JSON.stringify({ asPort: server.asPort, mode, ready: true })}\n`);

async function shutdown() {
  server.abortStartupBackfill?.('fixture shutdown');
  server.schedulerManager?.stop?.();
  server.stopBrowserSurfaceLeaseSweep?.();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
    backend.close?.(),
  ]);
  await closePostgresStorage();
  closeDb();
  process.exit(0);
}

process.once('SIGTERM', () => { shutdown().catch(() => process.exit(2)); });
process.once('SIGINT', () => { shutdown().catch(() => process.exit(2)); });
