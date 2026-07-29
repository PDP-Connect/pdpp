// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresRecordReadDriver } from "./helpers/postgres-record-read-driver.ts";
import { CONFORMANCE_NULLABLE_CURSOR_STREAM } from "./helpers/record-read-conformance.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const SEEDED_RECORDS = [
  {
    data: {
      id: "b_present_old",
      last_modified_on: "2026-01-01T00:00:00Z",
      name: "Present Old",
    },
    key: "b_present_old",
  },
  {
    data: {
      id: "b_present_new",
      last_modified_on: "2026-02-01T00:00:00Z",
      name: "Present New",
    },
    key: "b_present_new",
  },
  {
    data: {
      id: "b_missing",
      name: "Missing Cursor",
    },
    key: "b_missing",
  },
  {
    data: {
      id: "b_null",
      last_modified_on: null,
      name: "Null Cursor",
    },
    key: "b_null",
  },
];

async function fetchAllPages(
  driver: ReturnType<typeof createPostgresRecordReadDriver>,
  { order, limit }: { order: "asc" | "desc"; limit: number },
  cursor: string | undefined,
  depth: number,
  acc: { id: string }[]
): Promise<{ id: string }[]> {
  if (depth >= 10) {
    assert.fail(`${order} pagination did not terminate within 10 pages`);
  }
  const params = {
    limit,
    order,
    stream: CONFORMANCE_NULLABLE_CURSOR_STREAM,
  };
  const page = await driver.list(cursor === undefined ? params : { ...params, cursor });
  const merged = acc.concat(page.data as { id: string }[]);
  if (!page.has_more) {
    assert.equal(page.next_cursor, undefined, `${order} final page must omit next_cursor`);
    return merged;
  }
  assert.equal(typeof page.next_cursor, "string", `${order} truncated page must emit next_cursor`);
  assert.notEqual(page.next_cursor, cursor, `${order} next_cursor must advance`);
  return fetchAllPages(driver, { limit, order }, page.next_cursor as string, depth + 1, merged);
}

async function collectPages(
  driver: ReturnType<typeof createPostgresRecordReadDriver>,
  opts: { order: "asc" | "desc"; limit: number }
): Promise<string[]> {
  const rows = await fetchAllPages(driver, opts, undefined, 0, []);
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, `${opts.order} pagination must not repeat rows`);
  return ids;
}

if (POSTGRES_URL) {
  test("postgres nullable record cursor pages through the null bucket in asc order", async () => {
    const driver = createPostgresRecordReadDriver({ connectionString: POSTGRES_URL });
    await driver.setup();
    try {
      await driver.seed(SEEDED_RECORDS, { stream: CONFORMANCE_NULLABLE_CURSOR_STREAM });

      assert.deepEqual(
        await collectPages(driver, { limit: 2, order: "asc" }),
        ["b_present_old", "b_present_new", "b_missing", "b_null"],
        "asc pagination must visit present cursor rows first, then missing/null rows in pk order"
      );
    } finally {
      await driver.teardown();
    }
  });

  test("postgres nullable record cursor pages stably in desc order", async () => {
    const driver = createPostgresRecordReadDriver({ connectionString: POSTGRES_URL });
    await driver.setup();
    try {
      await driver.seed(SEEDED_RECORDS, { stream: CONFORMANCE_NULLABLE_CURSOR_STREAM });

      assert.deepEqual(
        await collectPages(driver, { limit: 3, order: "desc" }),
        ["b_null", "b_missing", "b_present_new", "b_present_old"],
        "desc pagination must visit missing/null rows first, then present cursor rows in reverse order"
      );
    } finally {
      await driver.teardown();
    }
  });
} else {
  test("postgres nullable record cursor oracle (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
  }, () => {
    // skip
  });
}
