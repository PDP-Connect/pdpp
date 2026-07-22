// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { deleteAllRecordsForConnector, ingestRecord } from '../server/records.js';

test('deleteAllRecordsForConnector canonicalizes first-party registry URLs before deleting records', async () => {
  initDb(':memory:');
  try {
    const storageTarget = {
      connector_id: 'github',
      connector_instance_id: 'cin_test_github_fixture_transition',
    };
    await ingestRecord(storageTarget, {
      stream: 'commits',
      key: 'gh:commit:abc1',
      data: {
        id: 'gh:commit:abc1',
        repo_full_name: 'seedowner/personal-site',
        message: 'fixture commit that must not survive manifest reconciliation',
      },
      op: 'upsert',
      emitted_at: '2026-04-25T00:00:00.000Z',
    });

    const result = await deleteAllRecordsForConnector('https://registry.pdpp.org/connectors/github');

    assert.equal(result.deletedCount, 1);
    assert.deepEqual(result.streams, ['commits']);
    const remaining = getDb()
      .prepare('SELECT COUNT(*) AS count FROM records WHERE connector_id = ?')
      .get('github');
    assert.equal(Number(remaining.count || 0), 0);
  } finally {
    closeDb();
  }
});
