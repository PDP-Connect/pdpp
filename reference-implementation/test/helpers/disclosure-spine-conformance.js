/**
 * Disclosure spine conformance harness.
 *
 * Test-only helper. Defines durable disclosure-spine obligations of the
 * reference architecture as reusable scenarios that any candidate
 * implementation can be run against by supplying a small driver object.
 *
 * The driver shape is intentionally narrow and *semantic*: it speaks in terms
 * of appending events, listing a correlation timeline (paged), looking up the
 * latest/terminal event, and listing correlation summaries. It does not
 * expose raw SQL, query builders, framework routes, or a generic repository
 * surface. It is not exported from production code and SHALL NOT be treated
 * as a production `DisclosureSpineStore` contract.
 *
 * Driver shape:
 *
 *   {
 *     async setup(): void
 *     async teardown(): void
 *
 *     // Append a single spine event. Input is a plain object, not a row.
 *     // Caller may set occurred_at, status, event_type, data, and
 *     // correlation tags (trace_id/grant_id/run_id/etc). The driver MUST
 *     // record events in append order and return a record with at least
 *     // { event_id, event_type, occurred_at, status }.
 *     async append(input): EventRecord
 *
 *     // List one correlation's timeline as a single page bounded by `limit`.
 *     // `kind` is one of 'trace' | 'grant' | 'run'; `id` is the correlation
 *     // value. Returns:
 *     //   { events: EventRecord[], next_cursor: string | null,
 *     //     truncated: boolean }
 *     // Drivers MUST preserve append order across pages.
 *     async listPage(kind, id, { limit, cursor } = {}): PageResult
 *
 *     // List per-correlation summaries for a `kind`, optionally filtered by
 *     // status/since/until. Drivers MUST return summary rows whose
 *     // `event_count`, `first_at`, and `last_at` reflect the *full*
 *     // correlation extent — never the truncated hydration window.
 *     // Returns: { summaries: SummaryRow[] }
 *     async listSummaries(kind, filters = {}): { summaries }
 *   }
 *
 * Spec: openspec/changes/add-disclosure-spine-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';

/**
 * A small, deterministic event template used by most scenarios. The shape
 * mirrors what production callers actually emit: an event_type, a status, a
 * correlation triple (trace/grant/run), and a free-form `data` object.
 */
function evt(overrides) {
  return {
    event_type: 'reference.test.event',
    status: 'succeeded',
    actor_type: 'system',
    actor_id: 'pdpp_reference',
    object_type: 'event',
    ...overrides,
  };
}

/**
 * Run the disclosure spine conformance suite against a driver.
 *
 * @param {object} options
 * @param {string} options.label                         distinguishes the driver in test names
 * @param {(name: string, fn: () => Promise<void>) => void} options.test  test runner (e.g. `node:test`'s `test`)
 * @param {() => Promise<object> | object} options.makeDriver               returns a fresh driver per scenario
 */
export function runDisclosureSpineConformance({ label, test, makeDriver }) {
  const t = (name, fn) => test(`[conformance:${label}] ${name}`, fn);

  // 1. Append/list ordering for a single correlation. Pins the append-order
  //    invariant that downstream summarizers rely on.
  t('append/list preserves append order across one trace correlation', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const traceId = 'trc_seq_1';
      const baseTs = Date.parse('2026-04-01T00:00:00.000Z');
      const sequence = ['a', 'b', 'c', 'd', 'e'];
      const appended = [];
      for (let i = 0; i < sequence.length; i += 1) {
        const r = await driver.append(evt({
          trace_id: traceId,
          event_type: `reference.test.${sequence[i]}`,
          // Strictly increasing timestamps — keeps "append order == time order"
          // a property of the seed, so any driver that orders by occurred_at
          // OR by insertion order produces the same sequence.
          occurred_at: new Date(baseTs + i * 1000).toISOString(),
        }));
        assert.ok(r && r.event_id, 'append must return a record with event_id');
        appended.push(r.event_id);
      }

      const page = await driver.listPage('trace', traceId, { limit: 100 });
      const eventIds = page.events.map((e) => e.event_id);
      assert.deepEqual(
        eventIds,
        appended,
        'listPage must return events in append order',
      );
      const types = page.events.map((e) => e.event_type);
      assert.deepEqual(
        types,
        sequence.map((s) => `reference.test.${s}`),
        'listPage must surface event_type unchanged in append order',
      );
    } finally {
      await driver.teardown();
    }
  });

  // 2. Pagination/cursor: a small `limit` against a longer timeline must
  //    walk the full set with no overlap or gap, ending with a null cursor
  //    when there is no more.
  t('listPage cursor walks the full timeline without overlap or gap', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const traceId = 'trc_paging';
      const total = 7;
      const baseTs = Date.parse('2026-04-02T00:00:00.000Z');
      const ids = [];
      for (let i = 0; i < total; i += 1) {
        const r = await driver.append(evt({
          trace_id: traceId,
          event_type: 'reference.test.page',
          occurred_at: new Date(baseTs + i * 1000).toISOString(),
        }));
        ids.push(r.event_id);
      }

      const collected = [];
      let cursor = null;
      let pages = 0;
      while (pages < 20) {
        const page = await driver.listPage('trace', traceId, { limit: 3, cursor });
        pages += 1;
        for (const ev of page.events) collected.push(ev.event_id);
        if (!page.truncated) {
          assert.equal(
            page.next_cursor,
            null,
            'next_cursor must be null on the final page',
          );
          break;
        }
        assert.ok(
          page.next_cursor,
          'next_cursor must be present when the page is truncated',
        );
        cursor = page.next_cursor;
      }

      assert.deepEqual(
        collected,
        ids,
        'paged walk must visit every event exactly once, in append order',
      );
      assert.equal(
        new Set(collected).size,
        collected.length,
        'paged walk must not repeat events across pages',
      );
      assert.ok(pages >= 3, `expected at least 3 pages of size 3 over ${total} events`);
    } finally {
      await driver.teardown();
    }
  });

  // 3. Terminal/latest event lookup. The last event in a correlation's
  //    timeline is the terminal event; consumers (summary, status derivation)
  //    rely on this being stable.
  t('latest event lookup returns the most recently appended event', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const traceId = 'trc_terminal';
      const baseTs = Date.parse('2026-04-03T00:00:00.000Z');
      const types = ['start', 'progress', 'progress', 'finish'];
      let lastId = null;
      for (let i = 0; i < types.length; i += 1) {
        const r = await driver.append(evt({
          trace_id: traceId,
          event_type: `reference.test.${types[i]}`,
          status: i === types.length - 1 ? 'succeeded' : 'in_progress',
          occurred_at: new Date(baseTs + i * 1000).toISOString(),
        }));
        lastId = r.event_id;
      }

      // The harness exercises latest-event lookup via listPage with a generous
      // limit and inspects the last element. This is the same shape the
      // reference summarizer relies on.
      const page = await driver.listPage('trace', traceId, { limit: 100 });
      const terminal = page.events.at(-1);
      assert.ok(terminal, 'timeline must have at least one event');
      assert.equal(terminal.event_id, lastId,
        'terminal event must be the last appended event');
      assert.equal(terminal.event_type, 'reference.test.finish');
      assert.equal(terminal.status, 'succeeded');
    } finally {
      await driver.teardown();
    }
  });

  // 4. Correlation summary aggregate extent. The summary's first_at, last_at,
  //    and event_count must reflect the *full* correlation, not the truncated
  //    hydration window. This is the invariant that protects the SQL
  //    `GROUP BY` extent against degradation when a correlation overflows the
  //    summarizer's per-row hydration cap.
  t('correlation summary reports full extent even when timeline is large', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const grantId = 'grnt_extent';
      const total = 12;
      const baseTs = Date.parse('2026-04-04T00:00:00.000Z');
      let firstIso = null;
      let lastIso = null;
      for (let i = 0; i < total; i += 1) {
        const occurred = new Date(baseTs + i * 1000).toISOString();
        if (i === 0) firstIso = occurred;
        if (i === total - 1) lastIso = occurred;
        await driver.append(evt({
          grant_id: grantId,
          event_type: i === 0 ? 'grant.issued' : 'grant.event',
          status: 'succeeded',
          occurred_at: occurred,
        }));
      }

      const { summaries } = await driver.listSummaries('grant');
      const row = summaries.find((s) => s.id === grantId);
      assert.ok(row, `summary for ${grantId} not found in ${JSON.stringify(summaries.map((s) => s.id))}`);
      assert.equal(row.event_count, total,
        'summary event_count must equal the full correlation extent');
      assert.equal(row.first_at, firstIso,
        'summary first_at must equal the earliest event');
      assert.equal(row.last_at, lastIso,
        'summary last_at must equal the latest event');
    } finally {
      await driver.teardown();
    }
  });

  // 5. Rejected vs served event visibility. A correlation whose terminal
  //    event is rejected must surface that rejection in the summary status —
  //    rejected events MUST remain visible (they are the audit signal), and
  //    MUST NOT be silently rewritten to "succeeded".
  t('rejected terminal events stay visible in timeline and surface as summary status', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const grantId = 'grnt_rejected';
      const baseTs = Date.parse('2026-04-05T00:00:00.000Z');
      await driver.append(evt({
        grant_id: grantId,
        event_type: 'grant.requested',
        status: 'in_progress',
        occurred_at: new Date(baseTs).toISOString(),
      }));
      await driver.append(evt({
        grant_id: grantId,
        event_type: 'grant.rejected',
        status: 'rejected',
        occurred_at: new Date(baseTs + 1000).toISOString(),
        data: { reason: 'owner_denied' },
      }));

      const page = await driver.listPage('grant', grantId, { limit: 100 });
      const statuses = page.events.map((e) => e.status);
      const types = page.events.map((e) => e.event_type);
      assert.ok(
        statuses.includes('rejected'),
        `timeline must retain the rejected event status; saw ${JSON.stringify(statuses)}`,
      );
      assert.ok(
        types.includes('grant.rejected'),
        `timeline must retain the grant.rejected event_type; saw ${JSON.stringify(types)}`,
      );

      const { summaries } = await driver.listSummaries('grant');
      const row = summaries.find((s) => s.id === grantId);
      assert.ok(row, 'rejected grant must appear in summary listing');
      assert.ok(
        row.status === 'rejected' || row.status === 'failed' || row.status === 'denied',
        `summary status for a rejected grant must be a terminal-failure label, got '${row.status}'`,
      );
    } finally {
      await driver.teardown();
    }
  });
}
