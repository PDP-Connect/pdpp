import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import {
  configureSemanticBackend,
  makeStubBackend,
  semanticIndexUpsert,
  semanticWorkStatsForTests,
} from '../server/search-semantic.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function restoreEnv(name, previous) {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function upsert(recordKey, text) {
  return semanticIndexUpsert({
    connectorId: 'semantic-admission',
    connectorInstanceId: 'cin_semantic_admission',
    stream: 'messages',
    recordKey,
    data: { text },
    declaredFields: ['text'],
  });
}

test('timed semantic admission removes its waiter without stealing a later FIFO permit', async () => {
  const previousDeadline = process.env.PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS;
  const previousLimit = process.env.PDPP_SEMANTIC_WORK_LIMIT;
  const previousQueue = process.env.PDPP_SEMANTIC_WORK_QUEUE_LIMIT;
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const thirdEntered = deferred();
  const base = makeStubBackend({ dimensions: 8 });
  const backend = {
    ...base,
    embedDocument: async (text) => {
      if (text === 'first') {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      if (text === 'third') {
        thirdEntered.resolve();
      }
      return base.embedDocument(text);
    },
  };

  process.env.PDPP_SEMANTIC_WORK_LIMIT = '1';
  process.env.PDPP_SEMANTIC_WORK_QUEUE_LIMIT = '2';
  process.env.PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS = '10';
  initDb(':memory:');
  configureSemanticBackend(backend);
  try {
    const first = upsert('first', 'first');
    await firstEntered.promise;
    const timedOut = upsert('second', 'second');
    await assert.rejects(timedOut, (error) => error?.code === 'semantic_work_busy');
    assert.deepEqual(semanticWorkStatsForTests(), { active: 1, queued: 0 });

    const third = upsert('third', 'third');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(semanticWorkStatsForTests(), { active: 1, queued: 1 });
    releaseFirst.resolve();
    await Promise.all([first, third]);
    await thirdEntered.promise;
    assert.deepEqual(semanticWorkStatsForTests(), { active: 0, queued: 0 });
  } finally {
    configureSemanticBackend(null);
    closeDb();
    restoreEnv('PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS', previousDeadline);
    restoreEnv('PDPP_SEMANTIC_WORK_LIMIT', previousLimit);
    restoreEnv('PDPP_SEMANTIC_WORK_QUEUE_LIMIT', previousQueue);
  }
});
