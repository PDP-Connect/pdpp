/**
 * Record read conformance harness.
 *
 * Test-only helper. Defines durable record-read obligations of the reference
 * architecture as reusable scenarios that any candidate implementation can be
 * run against by supplying a small driver object.
 *
 * The driver shape is intentionally narrow and *semantic*: it only describes
 * the evidence a conformance test needs (seeding records, listing with
 * grant/projection/filter/cursor, advancing a `changes_since` watermark). It
 * is not exported from production code and SHALL NOT be treated as a
 * production `RecordStore` read contract.
 *
 * Driver shape:
 *
 *   {
 *     async setup(): void
 *     async teardown(): void
 *
 *     // Seed records into the harness stream. Each record is
 *     //   { key: string, data: object, emitted_at?: string, op?: 'upsert'|'delete' }
 *     // Drivers must seed in the given order. Default `op` is 'upsert'.
 *     // `stream` defaults to CONFORMANCE_STREAM.
 *     async seed(records, { stream } = {}): void
 *
 *     // Perform a list call.
 *     //
 *     // params (all optional):
 *     //   { stream, limit, order: 'asc'|'desc', cursor, fields: string[],
 *     //     filter: object, changes_since: string,
 *     //     grantFields: string[] }
 *     //
 *     // `stream` defaults to CONFORMANCE_STREAM. Drivers must accept either
 *     // CONFORMANCE_STREAM or CONFORMANCE_NULLABLE_CURSOR_STREAM.
 *     //
 *     // `grantFields` narrows the *grant* (not the request) to a subset of
 *     // fields. When omitted, the grant is wide-open for the seeded stream.
 *     // Drivers MAY ignore `grantFields` only if they prove projection some
 *     // other way — but the SQLite reference must honor it, since projection
 *     // leakage from the grant is one of the harness's core invariants.
 *     //
 *     // Returns the canonical list response shape:
 *     //   { object: 'list', data, has_more, next_cursor?, next_changes_since? }
 *     async list(params): { data, has_more, next_cursor?, next_changes_since? }
 *   }
 *
 * The harness registers a fixed manifest shape (CONFORMANCE_MANIFEST) for
 * its scenarios. Drivers must conform to that shape; it covers the read-side
 * surfaces the spec calls out (cursor on a non-null date-time on the primary
 * stream, a separate nullable-cursor stream for the missing-bucket scenario,
 * nullable scalars for projection, range/exact filters declared on a few
 * fields).
 *
 * Spec: openspec/changes/add-record-read-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';

/**
 * The fixed connector_id and stream the harness uses. Drivers should register
 * a manifest under this id whose shape matches CONFORMANCE_MANIFEST below.
 */
export const CONFORMANCE_CONNECTOR_ID =
  'https://test.pdpp.org/connectors/record-read-conformance';
export const CONFORMANCE_STREAM = 'items';

/**
 * A second stream whose `cursor_field` is nullable, used to exercise the
 * missing/null cursor-field bucket. Mirrors real polyfill manifests like
 * ynab.budgets.
 */
export const CONFORMANCE_NULLABLE_CURSOR_STREAM = 'budgets';

/**
 * Canonical manifest the harness expects. Exposed so drivers can register it
 * at setup time. Schema covers:
 *   - non-null date-time `created_at` for cursor (avoids null-bucket noise
 *     in pagination scenarios that are not specifically about nulls).
 *   - nullable date-time `updated_at` for null-bucket pagination scenarios.
 *   - nullable scalars (`label`, `score`) for projection + exact/range filters.
 *   - grant-scoped projection of `secret` (a field most tests narrow out of
 *     the grant to prove projection does not leak).
 */
export const CONFORMANCE_MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: CONFORMANCE_CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Record Read Conformance',
  runtime_requirements: { bindings: { network: { required: true } } },
  streams: [
    {
      name: CONFORMANCE_STREAM,
      semantics: 'mutable_state',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: ['string', 'null'] },
          score: { type: ['integer', 'null'] },
          secret: { type: ['string', 'null'] },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: ['string', 'null'], format: 'date-time' },
        },
        required: ['id', 'created_at'],
      },
      primary_key: ['id'],
      cursor_field: 'created_at',
      selection: { fields: true, resources: true },
      query: {
        range_filters: {
          score: ['gte', 'gt', 'lte', 'lt'],
          updated_at: ['gte', 'lt'],
        },
      },
    },
    {
      name: CONFORMANCE_NULLABLE_CURSOR_STREAM,
      semantics: 'mutable_state',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          last_modified_on: {
            type: ['string', 'null'],
            format: 'date-time',
          },
        },
        required: ['id', 'name'],
      },
      primary_key: ['id'],
      cursor_field: 'last_modified_on',
      selection: { fields: true, resources: true },
    },
  ],
};

/**
 * Five rows that exercise pagination ordering (created_at asc), exact/range
 * filter selectivity, and field projection. Used by most scenarios;
 * deterministic by id.
 */
function baseSeed() {
  return [
    {
      key: 'r1',
      data: {
        id: 'r1', label: 'alpha', score: 1, secret: 's1',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-10T00:00:00Z',
      },
    },
    {
      key: 'r2',
      data: {
        id: 'r2', label: 'beta', score: 5, secret: 's2',
        created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-10T00:00:00Z',
      },
    },
    {
      key: 'r3',
      data: {
        id: 'r3', label: 'beta', score: 3, secret: 's3',
        created_at: '2026-03-01T00:00:00Z', updated_at: null,
      },
    },
    {
      key: 'r4',
      data: {
        id: 'r4', label: null, score: null, secret: 's4',
        created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-10T00:00:00Z',
      },
    },
    {
      key: 'r5',
      data: {
        id: 'r5', label: 'gamma', score: 9, secret: 's5',
        created_at: '2026-05-01T00:00:00Z', updated_at: null,
      },
    },
  ];
}

/**
 * Run the record read conformance suite against a driver.
 *
 * @param {object} options
 * @param {string} options.label                         distinguishes the driver in test names
 * @param {(name: string, fn: () => Promise<void>) => void} options.test  test runner (e.g. `node:test`'s `test`)
 * @param {() => Promise<object> | object} options.makeDriver               returns a fresh driver per scenario
 */
export function runRecordReadConformance({ label, test, makeDriver }) {
  const t = (name, fn) => test(`[conformance:${label}] ${name}`, fn);

  // 1. Stable pagination, no overlap or skip across pages, asc order.
  t('paginates the full set in ascending cursor order with stable boundaries', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(baseSeed());

      const collected = [];
      let cursor;
      let pages = 0;
      // Limit 2 against 5 rows -> exactly 3 pages (2, 2, 1).
      while (pages < 10) {
        const page = await driver.list({ limit: 2, order: 'asc', cursor });
        pages += 1;
        for (const row of page.data) collected.push(row.id);
        if (!page.has_more) {
          assert.equal(page.next_cursor, undefined,
            'next_cursor must be omitted on the last page');
          break;
        }
        assert.ok(page.next_cursor,
          'next_cursor must be present when has_more is true');
        cursor = page.next_cursor;
      }

      assert.deepEqual(
        collected,
        ['r1', 'r2', 'r3', 'r4', 'r5'],
        'pagination must visit every row exactly once, in cursor order',
      );
      assert.equal(new Set(collected).size, collected.length,
        'pagination must not repeat rows across pages');
      assert.equal(pages, 3, 'expected exactly 3 pages of size 2 over 5 rows');
    } finally {
      await driver.teardown();
    }
  });

  // 2. Cursor round-trip — same cursor on a fresh driver instance returns
  // the next page's rows. Pins the cursor token's portability.
  t('cursor token round-trips across an independent list call', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(baseSeed());

      const first = await driver.list({ limit: 2, order: 'asc' });
      assert.equal(first.has_more, true);
      assert.deepEqual(first.data.map((r) => r.id), ['r1', 'r2']);

      // Use the cursor as if it had been stashed by a separate caller.
      const second = await driver.list({
        limit: 10,
        order: 'asc',
        cursor: first.next_cursor,
      });
      assert.deepEqual(
        second.data.map((r) => r.id),
        ['r3', 'r4', 'r5'],
        'cursor must resume exactly after the prior page',
      );
      assert.equal(second.has_more, false);
    } finally {
      await driver.teardown();
    }
  });

  // 3. Missing/null cursor-field bucket — present rows first (asc cursor
  // order), then missing-bucket rows in pk-asc order. Exercised on the
  // separate nullable-cursor stream so the primary stream's cursor stays
  // non-null and pagination scenarios above remain unambiguous.
  t('null-cursor rows go to the missing bucket after present rows in asc order', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(
        [
          { key: 'b_a', data: { id: 'b_a', name: 'A', last_modified_on: '2026-01-01T00:00:00Z' } },
          { key: 'b_b', data: { id: 'b_b', name: 'B', last_modified_on: '2026-02-01T00:00:00Z' } },
          { key: 'b_n1', data: { id: 'b_n1', name: 'N1', last_modified_on: null } },
          { key: 'b_n2', data: { id: 'b_n2', name: 'N2', last_modified_on: null } },
        ],
        { stream: CONFORMANCE_NULLABLE_CURSOR_STREAM },
      );

      const all = await driver.list({
        stream: CONFORMANCE_NULLABLE_CURSOR_STREAM,
        limit: 100,
        order: 'asc',
      });
      assert.deepEqual(
        all.data.map((r) => r.id),
        ['b_a', 'b_b', 'b_n1', 'b_n2'],
        'present-cursor rows in asc cursor order, then missing-bucket rows in pk-asc order',
      );
      assert.equal(all.has_more, false);
    } finally {
      await driver.teardown();
    }
  });

  // 4. changes_since=beginning bootstrap.
  t('changes_since=beginning returns all live rows and a next_changes_since watermark', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(baseSeed());

      const bootstrap = await driver.list({
        limit: 100,
        changes_since: 'beginning',
      });
      const ids = bootstrap.data.map((r) => r.id).sort();
      assert.deepEqual(
        ids,
        ['r1', 'r2', 'r3', 'r4', 'r5'],
        'beginning bootstrap must include every live row',
      );
      assert.ok(
        bootstrap.next_changes_since,
        'beginning bootstrap must yield next_changes_since for follow-up reads',
      );
      assert.equal(bootstrap.has_more, false);
    } finally {
      await driver.teardown();
    }
  });

  // 5. changes_since cursor returns only new changes after the bootstrap.
  t('changes_since cursor delivers only writes newer than the watermark', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(baseSeed());
      const bootstrap = await driver.list({
        limit: 100,
        changes_since: 'beginning',
      });
      const watermark = bootstrap.next_changes_since;
      assert.ok(watermark);

      // Write one new row + one update.
      await driver.seed([
        {
          key: 'r6',
          data: {
            id: 'r6', label: 'delta', score: 7, secret: 's6',
            created_at: '2026-06-01T00:00:00Z', updated_at: null,
          },
        },
        {
          key: 'r2',
          data: {
            id: 'r2', label: 'beta-v2', score: 5, secret: 's2',
            created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-15T00:00:00Z',
          },
        },
      ]);

      const delta = await driver.list({
        limit: 100,
        changes_since: watermark,
      });
      const deltaIds = delta.data.map((r) => r.id).sort();
      assert.deepEqual(
        deltaIds,
        ['r2', 'r6'],
        'changes_since must surface only the new and updated rows',
      );
      assert.ok(delta.next_changes_since,
        'follow-up changes_since must yield a fresh watermark');
    } finally {
      await driver.teardown();
    }
  });

  // 6. Grant projection: a field outside the grant must never leak.
  t('grant field projection drops fields not in the grant', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(baseSeed());

      const restricted = await driver.list({
        limit: 100,
        order: 'asc',
        grantFields: ['id', 'label', 'created_at'],
      });
      for (const row of restricted.data) {
        assert.ok(row.data, `row ${row.id} missing data`);
        assert.equal(
          'secret' in row.data, false,
          `row ${row.id} leaked ungranted field 'secret': ${JSON.stringify(row.data)}`,
        );
        assert.equal(
          'score' in row.data, false,
          `row ${row.id} leaked ungranted field 'score': ${JSON.stringify(row.data)}`,
        );
        // Granted fields should be present (when underlying value is set).
        assert.ok('id' in row.data, `row ${row.id} missing granted 'id'`);
      }
    } finally {
      await driver.teardown();
    }
  });

  // 7. Request projection narrows further (and stays inside grant).
  t('request fields narrow the response below an open grant', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(baseSeed());

      const projected = await driver.list({
        limit: 100,
        order: 'asc',
        fields: ['id', 'label'],
      });
      for (const row of projected.data) {
        const keys = Object.keys(row.data);
        // `created_at` is required and required fields are always retained,
        // but anything outside (id, label, created_at) must be absent.
        for (const k of keys) {
          assert.ok(
            ['id', 'label', 'created_at'].includes(k),
            `row ${row.id} returned unrequested field '${k}'`,
          );
        }
        assert.ok('id' in row.data);
      }
    } finally {
      await driver.teardown();
    }
  });

  // 8. Exact filter on a scalar field.
  t('exact filter returns only matching rows', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(baseSeed());

      const beta = await driver.list({
        limit: 100,
        order: 'asc',
        filter: { label: 'beta' },
      });
      assert.deepEqual(
        beta.data.map((r) => r.id),
        ['r2', 'r3'],
        'exact filter on label=beta should surface r2 and r3 only',
      );

      // Filter must drop, not crash, when no rows match.
      const ghost = await driver.list({
        limit: 100,
        filter: { label: 'never' },
      });
      assert.deepEqual(ghost.data, [], 'no-match exact filter must return empty data');
      assert.equal(ghost.has_more, false);
    } finally {
      await driver.teardown();
    }
  });

  // 9. Range filter on a declared numeric field.
  t('range filter applies bounds and excludes nulls', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(baseSeed());

      const inRange = await driver.list({
        limit: 100,
        order: 'asc',
        filter: { score: { gte: 3, lte: 6 } },
      });
      assert.deepEqual(
        inRange.data.map((r) => r.id),
        ['r2', 'r3'],
        'range gte=3,lte=6 should select score=5 (r2) and score=3 (r3) only',
      );

      // r4 has score=null and must NOT match a wide-open range.
      const wide = await driver.list({
        limit: 100,
        order: 'asc',
        filter: { score: { gte: -1000, lte: 1000 } },
      });
      const wideIds = wide.data.map((r) => r.id).sort();
      assert.deepEqual(
        wideIds,
        ['r1', 'r2', 'r3', 'r5'],
        'wide range must still exclude null-score rows',
      );
    } finally {
      await driver.teardown();
    }
  });
}
