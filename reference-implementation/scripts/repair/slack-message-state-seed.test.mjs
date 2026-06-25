import assert from 'node:assert/strict';
import test from 'node:test';

import { backupTableName, mergeMessagesState, parseArgs, validateArgs } from './slack-message-state-seed.mjs';

test('parseArgs requires an explicit connector instance id', () => {
  assert.equal(validateArgs(parseArgs([])), '--connector-instance-id is required');
  assert.equal(validateArgs(parseArgs(['--connector-instance-id=cin_123'])), null);
  assert.equal(parseArgs(['--connector-instance-id=cin_123', '--apply', '--json']).apply, true);
});

test('mergeMessagesState preserves existing fields and seeds retained channel cursors', () => {
  const merged = mergeMessagesState(
    {
      archive_dir: '/archive',
      fetched_at: '2026-06-25T00:00:00.000Z',
      last_ts: '2000.000000',
      channel_last_ts: {
        C_EXISTING: '1500.000000',
        C_SHARED: '3000.000000',
      },
      observed_channel_ids: ['C_EXISTING'],
    },
    {
      C_NEW: '2500.000000',
      C_SHARED: '2000.000000',
    }
  );

  assert.equal(merged.archive_dir, '/archive');
  assert.equal(merged.fetched_at, '2026-06-25T00:00:00.000Z');
  assert.equal(merged.last_ts, '3000.000000');
  assert.deepEqual(merged.channel_last_ts, {
    C_EXISTING: '1500.000000',
    C_NEW: '2500.000000',
    C_SHARED: '3000.000000',
  });
  assert.deepEqual(merged.observed_channel_ids, ['C_EXISTING', 'C_NEW', 'C_SHARED']);
});

test('backupTableName is deterministic shape-safe and bounded for Postgres identifiers', () => {
  const name = backupTableName({
    connectorInstanceId: 'cin_f565a96cb0a114b0a27e9606',
    stamp: '20260625193000',
  });
  assert.match(name, /^sms_seed_backup_[a-f0-9]{8}__/);
  assert.ok(name.length <= 63);
});
