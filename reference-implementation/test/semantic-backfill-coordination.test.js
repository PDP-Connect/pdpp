import assert from 'node:assert/strict';
import test from 'node:test';

import { getDb, closeDb, initDb } from '../server/db.js';
import { registerConnector } from '../server/auth.js';
import { ingestRecord } from '../server/records.js';
import { connectorInstanceWriteCoordinatorStatsForTests, withConnectorInstanceWrite } from '../server/connector-instance-write-coordinator.ts';
import {
  configureSemanticBackend,
  makeStubBackend,
  semanticIndexBackfillForManifest,
} from '../server/search-semantic.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function target(connectorInstanceId) {
  return { connector_id: 'semantic-fence', connector_instance_id: connectorInstanceId };
}

function record(stream, key, subject) {
  return {
    stream,
    key,
    data: { id: key, subject },
    emitted_at: '2026-07-16T00:00:00.000Z',
  };
}

const baseManifest = {
  protocol_version: '0.1.0',
  connector_id: 'semantic-fence',
  display_name: 'Semantic fence test',
  capabilities: { human_interaction: [] },
  streams: [
    {
      name: 'first',
      primary_key: ['id'],
      schema: { type: 'object', required: ['id', 'subject'], properties: { id: { type: 'string' }, subject: { type: 'string' } } },
      query: { search: {} },
    },
    {
      name: 'later',
      primary_key: ['id'],
      schema: { type: 'object', required: ['id', 'subject'], properties: { id: { type: 'string' }, subject: { type: 'string' } } },
      query: { search: {} },
    },
  ],
};

const semanticManifest = {
  connector_id: 'semantic-fence',
  streams: [
    { name: 'first', query: { search: { semantic_fields: ['subject'] } } },
    { name: 'later', query: { search: { semantic_fields: ['subject'] } } },
  ],
};

test('semantic backfill holds one instance fence through later-stream meta completion while another instance proceeds', async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const laterEntered = deferred();
  const releaseLater = deferred();
  const stub = makeStubBackend({ dimensions: 8 });
  const blockingBackend = {
    ...stub,
    embedDocument: async (text) => {
      if (text === 'first blocked') {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      if (text === 'later blocked') {
        laterEntered.resolve();
        await releaseLater.promise;
      }
      return stub.embedDocument(text);
    },
  };

  initDb(':memory:');
  configureSemanticBackend(blockingBackend);
  let backfill = null;
  let sameInstanceIngest = null;
  let otherInstanceIngest = null;
  try {
    await registerConnector(baseManifest);
    await ingestRecord(target('cin_semantic_fence_a'), record('first', 'a-first', 'first blocked'));
    await ingestRecord(target('cin_semantic_fence_a'), record('later', 'a-later', 'later blocked'));
    assert.deepEqual(connectorInstanceWriteCoordinatorStatsForTests(), {
      activeWriters: 0,
      activeOwnerships: 0,
      keyedEntries: 0,
      queuedWriters: 0,
    });

    backfill = semanticIndexBackfillForManifest({ manifest: semanticManifest });
    const firstStarted = await Promise.race([
      firstEntered.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(
      firstStarted,
      true,
      `the first stream must start before the test creates a competing writer: ${JSON.stringify(connectorInstanceWriteCoordinatorStatsForTests())}`,
    );

    let sameInstanceFinished = false;
    sameInstanceIngest = ingestRecord(
      target('cin_semantic_fence_a'),
      record('first', 'a-after', 'must wait for full backfill'),
    ).then(() => { sameInstanceFinished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(connectorInstanceWriteCoordinatorStatsForTests(), {
      activeWriters: 2,
      activeOwnerships: 1,
      keyedEntries: 1,
      queuedWriters: 0,
    });

    // This is an actual direct-ingest path, not a coordinator-only probe. It
    // proves a different connector instance is not serialized behind A.
    let otherInstanceFinished = false;
    otherInstanceIngest = ingestRecord(
      target('cin_semantic_fence_b'),
      record('first', 'b-first', 'other instance proceeds'),
    ).then(() => { otherInstanceFinished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    await otherInstanceIngest;
    assert.equal(otherInstanceFinished, true);
    assert.equal(sameInstanceFinished, false);

    releaseFirst.resolve();
    await laterEntered.promise;
    assert.equal(sameInstanceFinished, false, 'A stays fenced until its later stream has completed');

    releaseLater.resolve();
    await backfill;
    await sameInstanceIngest;

    const meta = getDb().prepare(
      `SELECT stream FROM semantic_search_meta
        WHERE connector_instance_id = ? ORDER BY stream`,
    ).all('cin_semantic_fence_a');
    assert.deepEqual(meta.map((row) => row.stream), ['first', 'later']);
  } finally {
    releaseFirst.resolve();
    releaseLater.resolve();
    await Promise.allSettled([backfill, sameInstanceIngest, otherInstanceIngest].filter(Boolean));
    configureSemanticBackend(null);
    closeDb();
  }
});

test('direct ingest queued before semantic backfill is repaired by the later per-instance backfill', async () => {
  const connectorInstanceId = 'cin_semantic_reverse';
  const stub = makeStubBackend({ dimensions: 8 });
  initDb(':memory:');
  configureSemanticBackend(stub);
  let held = null;
  let directIngest = null;
  let backfill = null;
  try {
    await registerConnector(baseManifest);
    // The initial row makes the instance discoverable while the later direct
    // ingest is still queued behind the test-held instance fence.
    await ingestRecord(target(connectorInstanceId), record('first', 'existing', 'existing semantic row'));
    const entered = deferred();
    const release = deferred();
    const heldPromise = withConnectorInstanceWrite(connectorInstanceId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    held = { held: heldPromise, release };
    directIngest = ingestRecord(
      target(connectorInstanceId),
      record('first', 'direct-first', 'durable before semantic rebuild'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    backfill = semanticIndexBackfillForManifest({ manifest: semanticManifest });
    held.release.resolve();
    await held.held;
    await directIngest;
    await backfill;
    const indexed = getDb().prepare(`
      SELECT record_key FROM semantic_search_blob
       WHERE connector_instance_id = ? AND record_key = 'direct-first'
      UNION ALL
      SELECT record_key FROM semantic_search_rowid
       WHERE connector_instance_id = ? AND record_key = 'direct-first'
    `).get(connectorInstanceId, connectorInstanceId);
    assert.equal(indexed.record_key, 'direct-first');
  } finally {
    held?.release.resolve();
    await Promise.allSettled([held?.held, directIngest, backfill].filter(Boolean));
    configureSemanticBackend(null);
    closeDb();
  }
});
