import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recordIndexWorkStatsForTests,
  withRecordIndexWorkForTests,
} from '../server/records.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('record index admission times out only its waiter and transfers one FIFO permit', async () => {
  const previous = {
    limit: process.env.PDPP_INGEST_INDEX_WORK_LIMIT,
    queue: process.env.PDPP_INGEST_INDEX_WORK_QUEUE_LIMIT,
    deadline: process.env.PDPP_INGEST_INDEX_WORK_ACQUIRE_DEADLINE_MS,
  };
  process.env.PDPP_INGEST_INDEX_WORK_LIMIT = '1';
  process.env.PDPP_INGEST_INDEX_WORK_QUEUE_LIMIT = '4';
  process.env.PDPP_INGEST_INDEX_WORK_ACQUIRE_DEADLINE_MS = '15';

  const entered = deferred();
  const release = deferred();
  let operations = 0;
  const first = withRecordIndexWorkForTests(async () => {
    operations += 1;
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    assert.deepEqual(recordIndexWorkStatsForTests(), { active: 1, queued: 0 });

    const timedOut = withRecordIndexWorkForTests(async () => {
      operations += 1;
    });
    await assert.rejects(timedOut, (err) => err?.code === 'record_index_busy');
    assert.deepEqual(recordIndexWorkStatsForTests(), { active: 1, queued: 0 });

    const later = withRecordIndexWorkForTests(async () => {
      operations += 1;
      assert.deepEqual(recordIndexWorkStatsForTests(), { active: 1, queued: 0 });
    });
    assert.deepEqual(recordIndexWorkStatsForTests(), { active: 1, queued: 1 });
    release.resolve();
    await Promise.all([first, later]);
    assert.equal(operations, 2, 'the timed-out waiter must never start work');
    assert.deepEqual(recordIndexWorkStatsForTests(), { active: 0, queued: 0 });
  } finally {
    release.resolve();
    await first.catch(() => {});
    if (previous.limit === undefined) delete process.env.PDPP_INGEST_INDEX_WORK_LIMIT;
    else process.env.PDPP_INGEST_INDEX_WORK_LIMIT = previous.limit;
    if (previous.queue === undefined) delete process.env.PDPP_INGEST_INDEX_WORK_QUEUE_LIMIT;
    else process.env.PDPP_INGEST_INDEX_WORK_QUEUE_LIMIT = previous.queue;
    if (previous.deadline === undefined) delete process.env.PDPP_INGEST_INDEX_WORK_ACQUIRE_DEADLINE_MS;
    else process.env.PDPP_INGEST_INDEX_WORK_ACQUIRE_DEADLINE_MS = previous.deadline;
  }
});
