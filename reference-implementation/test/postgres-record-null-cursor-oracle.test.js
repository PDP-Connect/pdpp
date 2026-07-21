import assert from 'node:assert/strict';
import test from 'node:test';

import { createPostgresRecordReadDriver } from './helpers/postgres-record-read-driver.js';
import { CONFORMANCE_NULLABLE_CURSOR_STREAM } from './helpers/record-read-conformance.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const SEEDED_RECORDS = [
  {
    key: 'b_present_old',
    data: {
      id: 'b_present_old',
      name: 'Present Old',
      last_modified_on: '2026-01-01T00:00:00Z',
    },
  },
  {
    key: 'b_present_new',
    data: {
      id: 'b_present_new',
      name: 'Present New',
      last_modified_on: '2026-02-01T00:00:00Z',
    },
  },
  {
    key: 'b_missing',
    data: {
      id: 'b_missing',
      name: 'Missing Cursor',
    },
  },
  {
    key: 'b_null',
    data: {
      id: 'b_null',
      name: 'Null Cursor',
      last_modified_on: null,
    },
  },
];

async function collectPages(driver, { order, limit }) {
  const collected = [];
  let cursor;
  let pages = 0;

  while (pages < 10) {
    const page = await driver.list({
      stream: CONFORMANCE_NULLABLE_CURSOR_STREAM,
      order,
      limit,
      cursor,
    });
    pages += 1;
    collected.push(...page.data.map((row) => row.id));

    if (!page.has_more) {
      assert.equal(page.next_cursor, undefined, `${order} final page must omit next_cursor`);
      break;
    }

    assert.equal(typeof page.next_cursor, 'string', `${order} truncated page must emit next_cursor`);
    assert.notEqual(page.next_cursor, cursor, `${order} next_cursor must advance`);
    cursor = page.next_cursor;
  }

  assert.ok(pages < 10, `${order} pagination did not terminate`);
  assert.equal(
    new Set(collected).size,
    collected.length,
    `${order} pagination must not repeat rows`,
  );

  return collected;
}

if (!POSTGRES_URL) {
  test('postgres nullable record cursor oracle (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('postgres nullable record cursor pages through the null bucket in asc order', async () => {
    const driver = createPostgresRecordReadDriver({ connectionString: POSTGRES_URL });
    await driver.setup();
    try {
      await driver.seed(SEEDED_RECORDS, { stream: CONFORMANCE_NULLABLE_CURSOR_STREAM });

      assert.deepEqual(
        await collectPages(driver, { order: 'asc', limit: 2 }),
        ['b_present_old', 'b_present_new', 'b_missing', 'b_null'],
        'asc pagination must visit present cursor rows first, then missing/null rows in pk order',
      );
    } finally {
      await driver.teardown();
    }
  });

  test('postgres nullable record cursor pages stably in desc order', async () => {
    const driver = createPostgresRecordReadDriver({ connectionString: POSTGRES_URL });
    await driver.setup();
    try {
      await driver.seed(SEEDED_RECORDS, { stream: CONFORMANCE_NULLABLE_CURSOR_STREAM });

      assert.deepEqual(
        await collectPages(driver, { order: 'desc', limit: 3 }),
        ['b_null', 'b_missing', 'b_present_new', 'b_present_old'],
        'desc pagination must visit missing/null rows first, then present cursor rows in reverse order',
      );
    } finally {
      await driver.teardown();
    }
  });
}
