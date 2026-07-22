// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record mutation conformance harness.
 *
 * This is a test-only helper. It defines the durable record-mutation
 * obligations of the reference architecture as reusable scenarios that any
 * candidate implementation can be run against by supplying a small driver
 * object.
 *
 * The driver shape is intentionally narrow: it only describes the evidence a
 * conformance test needs (mutation, fault injection, durable read-back), not
 * a generic record store. It is not exported from production code and SHALL
 * NOT be treated as a `RecordStore` contract.
 *
 * Driver shape:
 *
 *   {
 *     async setup(): void                      // create/reset durable storage
 *     async teardown(): void                   // release durable storage
 *     async ingestUpsert(key, payload): { changed: boolean }
 *     async ingestDelete(key):           { changed: boolean }
 *     async directDelete(key):           number   // 1 changed, 0 noop
 *     async readLive(key):               { record_key, record_json, version, deleted } | null
 *     async readChanges():               Array<{ version, record_key, record_json, deleted }>
 *     async readVersionCounter():        number | null
 *     async setIngestFault(hookOrNull):  void   // throw at named points or null clear
 *     async setDeleteFault(hookOrNull):  void
 *   }
 *
 * Drivers MAY treat ingest delete and direct delete as the same path
 * internally, but MUST expose both entry points so the harness can pin the
 * difference between the change-feed contracts.
 *
 * Spec: openspec/changes/add-record-mutation-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';

/**
 * Run the record mutation conformance suite against a driver.
 *
 * @param {object} options
 * @param {string} options.label                         distinguishes the driver in test names
 * @param {(name: string, fn: () => Promise<void>) => void} options.test  test runner (e.g. `node:test`'s `test`)
 * @param {() => Promise<object> | object} options.makeDriver               returns a fresh driver per scenario
 */
export function runRecordMutationConformance({ label, test, makeDriver }) {
  const t = (name, fn) => test(`[conformance:${label}] ${name}`, fn);

  t('changed writes allocate unique monotonic versions', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const r1 = await driver.ingestUpsert('a', { v: 1 });
      const r2 = await driver.ingestUpsert('b', { v: 1 });
      const r3 = await driver.ingestUpsert('a', { v: 2 });

      assert.equal(r1.changed, true);
      assert.equal(r2.changed, true);
      assert.equal(r3.changed, true);

      const versions = (await driver.readChanges()).map((row) => row.version);
      assert.deepEqual(versions, [1, 2, 3]);
      assert.equal(new Set(versions).size, versions.length);
      for (let i = 1; i < versions.length; i++) {
        assert.ok(
          versions[i] > versions[i - 1],
          `version ${versions[i]} must exceed ${versions[i - 1]}`,
        );
      }

      assert.equal(await driver.readVersionCounter(), 3);

      const liveA = await driver.readLive('a');
      assert.equal(liveA.version, 3);
    } finally {
      await driver.teardown();
    }
  });

  t('identical re-ingest does not append record_changes or advance version_counter', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.ingestUpsert('a', { v: 1 });
      const before = await driver.readChanges();
      const counterBefore = await driver.readVersionCounter();

      const second = await driver.ingestUpsert('a', { v: 1 });
      assert.equal(second.changed, false);

      const after = await driver.readChanges();
      assert.deepEqual(after, before, 'record_changes must not change for a no-op re-ingest');
      assert.equal(
        await driver.readVersionCounter(),
        counterBefore,
        'version_counter must not advance for a no-op re-ingest',
      );
    } finally {
      await driver.teardown();
    }
  });

  t('repeated ingest delete does not append duplicate delete or advance version_counter', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.ingestUpsert('a', { v: 1 });
      const firstDelete = await driver.ingestDelete('a');
      assert.equal(firstDelete.changed, true);

      const counterAfterDelete = await driver.readVersionCounter();
      const changesAfterDelete = await driver.readChanges();
      assert.equal(counterAfterDelete, 2);
      assert.equal(
        changesAfterDelete.filter((row) => row.deleted === 1).length,
        1,
      );

      const repeatDelete = await driver.ingestDelete('a');
      assert.equal(repeatDelete.changed, false);

      assert.equal(
        await driver.readVersionCounter(),
        counterAfterDelete,
        'version_counter must not advance for a repeated delete',
      );
      assert.deepEqual(
        await driver.readChanges(),
        changesAfterDelete,
        'record_changes must not gain a duplicate delete row',
      );

      const ghostDelete = await driver.ingestDelete('never-was');
      assert.equal(ghostDelete.changed, false);
      assert.equal(await driver.readVersionCounter(), counterAfterDelete);
      assert.deepEqual(await driver.readChanges(), changesAfterDelete);
    } finally {
      await driver.teardown();
    }
  });

  t('successful direct delete appends exactly one delete change and advances version_counter once', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.ingestUpsert('a', { v: 1 });
      const counterBefore = await driver.readVersionCounter();
      const changesBefore = await driver.readChanges();
      assert.equal(counterBefore, 1);
      assert.equal(changesBefore.length, 1);

      const result = await driver.directDelete('a');
      assert.equal(result, 1);

      const changesAfter = await driver.readChanges();
      assert.equal(changesAfter.length, changesBefore.length + 1);
      const deleteRow = changesAfter[changesAfter.length - 1];
      assert.equal(deleteRow.deleted, 1);
      assert.equal(deleteRow.record_key, 'a');
      assert.equal(deleteRow.version, counterBefore + 1);

      assert.equal(await driver.readVersionCounter(), counterBefore + 1);

      const live = await driver.readLive('a');
      assert.equal(live.deleted, 1);
      assert.equal(live.version, counterBefore + 1);
    } finally {
      await driver.teardown();
    }
  });

  t('direct delete on an absent record is a no-op for record_changes and version_counter', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.ingestUpsert('a', { v: 1 });
      const counterBefore = await driver.readVersionCounter();
      const changesBefore = await driver.readChanges();

      const result = await driver.directDelete('never-was');
      assert.equal(result, 0);

      assert.deepEqual(
        await driver.readChanges(),
        changesBefore,
        'record_changes must not change for an absent-record direct delete',
      );
      assert.equal(
        await driver.readVersionCounter(),
        counterBefore,
        'version_counter must not advance for an absent-record direct delete',
      );
      assert.equal(await driver.readLive('never-was'), null);
    } finally {
      await driver.teardown();
    }
  });

  t('direct delete on an already-deleted record is a no-op for record_changes and version_counter', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.ingestUpsert('a', { v: 1 });
      const firstDelete = await driver.directDelete('a');
      assert.equal(firstDelete, 1);

      const counterAfterDelete = await driver.readVersionCounter();
      const changesAfterDelete = await driver.readChanges();

      const repeat = await driver.directDelete('a');
      assert.equal(repeat, 0);

      assert.equal(
        await driver.readVersionCounter(),
        counterAfterDelete,
        'version_counter must not advance for a repeated direct delete',
      );
      assert.deepEqual(
        await driver.readChanges(),
        changesAfterDelete,
        'record_changes must not gain a duplicate delete row for a repeated direct delete',
      );
    } finally {
      await driver.teardown();
    }
  });

  t('failure between ingest live mutation and record_changes append rolls back the durable unit', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.ingestUpsert('a', { v: 1 });
      const baselineLive = await driver.readLive('a');
      const baselineCounter = await driver.readVersionCounter();
      const baselineChanges = await driver.readChanges();
      assert.equal(baselineLive.version, 1);
      assert.equal(baselineCounter, 1);

      await driver.setIngestFault((point) => {
        if (point === 'after-records-mutation') {
          throw new Error('injected fault between records and record_changes (ingest)');
        }
      });

      await assert.rejects(
        () => driver.ingestUpsert('a', { v: 2 }),
        /injected fault/,
      );

      await driver.setIngestFault(null);

      const liveAfter = await driver.readLive('a');
      assert.deepEqual(
        liveAfter,
        baselineLive,
        'live records row must not advance when ingest aborts',
      );
      assert.equal(
        await driver.readVersionCounter(),
        baselineCounter,
        'version_counter must not advance when ingest aborts',
      );
      assert.deepEqual(
        await driver.readChanges(),
        baselineChanges,
        'record_changes must not gain a row when ingest aborts',
      );

      const recovered = await driver.ingestUpsert('a', { v: 3 });
      assert.equal(recovered.changed, true);
      assert.equal(await driver.readVersionCounter(), baselineCounter + 1);
      const recoveredChanges = await driver.readChanges();
      const newRow = recoveredChanges[recoveredChanges.length - 1];
      assert.equal(newRow.version, baselineCounter + 1);
      assert.equal(newRow.deleted, 0);
    } finally {
      await driver.setIngestFault(null);
      await driver.teardown();
    }
  });

  t('failure between direct-delete live mutation and record_changes append rolls back the durable unit', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.ingestUpsert('a', { v: 1 });
      const baselineLive = await driver.readLive('a');
      const baselineCounter = await driver.readVersionCounter();
      const baselineChanges = await driver.readChanges();
      assert.equal(baselineLive.deleted, 0);
      assert.equal(baselineLive.version, 1);
      assert.equal(baselineCounter, 1);

      await driver.setDeleteFault((point) => {
        if (point === 'after-records-mutation') {
          throw new Error('injected fault between records and record_changes (delete)');
        }
      });

      await assert.rejects(
        () => driver.directDelete('a'),
        /injected fault/,
      );

      await driver.setDeleteFault(null);

      const liveAfter = await driver.readLive('a');
      assert.deepEqual(
        liveAfter,
        baselineLive,
        'live records row must not advance when direct delete aborts',
      );
      assert.equal(
        await driver.readVersionCounter(),
        baselineCounter,
        'version_counter must not advance when direct delete aborts',
      );
      assert.deepEqual(
        await driver.readChanges(),
        baselineChanges,
        'record_changes must not gain a row when direct delete aborts',
      );

      const recovered = await driver.directDelete('a');
      assert.equal(recovered, 1);
      assert.equal(await driver.readVersionCounter(), baselineCounter + 1);
      const recoveredChanges = await driver.readChanges();
      const newRow = recoveredChanges[recoveredChanges.length - 1];
      assert.equal(newRow.version, baselineCounter + 1);
      assert.equal(newRow.deleted, 1);
    } finally {
      await driver.setDeleteFault(null);
      await driver.teardown();
    }
  });

  t('record_changes is contiguous across mixed ingest/delete/direct-delete writes', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.ingestUpsert('a', { v: 1 });           // v=1
      await driver.ingestUpsert('b', { v: 1 });           // v=2
      await driver.ingestUpsert('a', { v: 1 });           // no-op
      await driver.ingestDelete('b');                     // v=3
      await driver.ingestDelete('b');                     // no-op
      const directNoop = await driver.directDelete('b');  // already-deleted no-op
      assert.equal(directNoop, 0);
      await driver.ingestUpsert('c', { v: 1 });           // v=4
      const directDelete = await driver.directDelete('a'); // v=5
      assert.equal(directDelete, 1);

      const versions = (await driver.readChanges()).map((row) => row.version);
      assert.deepEqual(versions, [1, 2, 3, 4, 5]);
      assert.equal(
        await driver.readVersionCounter(),
        versions[versions.length - 1],
      );
      assert.equal(new Set(versions).size, versions.length);
    } finally {
      await driver.teardown();
    }
  });

  t('cleared ingest fault hook has no effect on subsequent ingest', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.setIngestFault(() => {
        throw new Error('should not run');
      });
      await driver.setIngestFault(null);

      const r = await driver.ingestUpsert('a', { v: 1 });
      assert.equal(r.changed, true);
      assert.equal(await driver.readVersionCounter(), 1);
    } finally {
      await driver.teardown();
    }
  });

  t('cleared delete fault hook has no effect on subsequent direct delete', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.ingestUpsert('a', { v: 1 });

      await driver.setDeleteFault(() => {
        throw new Error('should not run');
      });
      await driver.setDeleteFault(null);

      const result = await driver.directDelete('a');
      assert.equal(result, 1);
      assert.equal(await driver.readVersionCounter(), 2);
    } finally {
      await driver.teardown();
    }
  });
}
