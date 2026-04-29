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
  //    invariant that downstream summarizers rely on. The seed deliberately
  //    uses a *non-monotonic* `occurred_at` schedule so that a driver that
  //    sorts by wall-clock time would diverge from the append sequence — the
  //    only property that makes this scenario pass is honoring the append
  //    order itself.
  t('append/list preserves append order even when occurred_at is non-monotonic', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const traceId = 'trc_seq_1';
      // Wall-clock schedule decoupled from append index. If the driver sorted
      // by occurred_at it would produce: c (00), a (05), e (07), b (10), d (12).
      // The append order is: a, b, c, d, e. Any timestamp-ordered driver
      // therefore fails this scenario.
      const sequence = [
        { tag: 'a', occurred_at: '2026-04-01T00:00:05.000Z' },
        { tag: 'b', occurred_at: '2026-04-01T00:00:10.000Z' },
        { tag: 'c', occurred_at: '2026-04-01T00:00:00.000Z' },
        { tag: 'd', occurred_at: '2026-04-01T00:00:12.000Z' },
        { tag: 'e', occurred_at: '2026-04-01T00:00:07.000Z' },
      ];
      const appended = [];
      for (const step of sequence) {
        const r = await driver.append(evt({
          trace_id: traceId,
          event_type: `reference.test.${step.tag}`,
          occurred_at: step.occurred_at,
        }));
        assert.ok(r && r.event_id, 'append must return a record with event_id');
        appended.push(r.event_id);
      }

      const page = await driver.listPage('trace', traceId, { limit: 100 });
      const eventIds = page.events.map((e) => e.event_id);
      assert.deepEqual(
        eventIds,
        appended,
        'listPage must return events in append order, not occurred_at order',
      );
      const types = page.events.map((e) => e.event_type);
      assert.deepEqual(
        types,
        sequence.map((s) => `reference.test.${s.tag}`),
        'listPage must surface event_type in append order, not occurred_at order',
      );
    } finally {
      await driver.teardown();
    }
  });

  // 1b. Append-order tiebreaker when occurred_at is identical across events.
  //     A driver that orders by occurred_at alone would produce an undefined
  //     order across these events; the append sequence is the only stable
  //     answer, and downstream summarizers depend on it.
  t('append order is preserved when multiple events share the same occurred_at', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const traceId = 'trc_seq_tie';
      const sharedTs = '2026-04-01T01:00:00.000Z';
      const tags = ['a', 'b', 'c', 'd'];
      const appended = [];
      for (const tag of tags) {
        const r = await driver.append(evt({
          trace_id: traceId,
          event_type: `reference.test.${tag}`,
          occurred_at: sharedTs,
        }));
        appended.push(r.event_id);
      }

      const page = await driver.listPage('trace', traceId, { limit: 100 });
      const eventIds = page.events.map((e) => e.event_id);
      assert.deepEqual(
        eventIds,
        appended,
        'listPage must use append sequence as the tiebreaker when occurred_at is identical',
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
  //    rely on this being stable. The seed schedule deliberately makes the
  //    last *appended* event carry an *earlier* `occurred_at` than its
  //    predecessor — a clock-skew shape that real-world emitters can produce
  //    when retried or when several actors share the same correlation. A
  //    driver that returned the wall-clock max as the terminal event would
  //    surface the wrong row.
  t('latest event lookup returns the most recently appended event even with non-monotonic occurred_at', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const traceId = 'trc_terminal';
      // Append schedule (index, event_type, occurred_at):
      //   0 start    2026-04-03T00:00:00Z
      //   1 progress 2026-04-03T00:00:05Z
      //   2 progress 2026-04-03T00:00:30Z   <- highest occurred_at
      //   3 finish   2026-04-03T00:00:10Z   <- last appended; earlier than [2]
      const schedule = [
        { type: 'start',    status: 'in_progress', occurred_at: '2026-04-03T00:00:00.000Z' },
        { type: 'progress', status: 'in_progress', occurred_at: '2026-04-03T00:00:05.000Z' },
        { type: 'progress', status: 'in_progress', occurred_at: '2026-04-03T00:00:30.000Z' },
        { type: 'finish',   status: 'succeeded',   occurred_at: '2026-04-03T00:00:10.000Z' },
      ];
      let lastId = null;
      for (const step of schedule) {
        const r = await driver.append(evt({
          trace_id: traceId,
          event_type: `reference.test.${step.type}`,
          status: step.status,
          occurred_at: step.occurred_at,
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
        'terminal event must be the last appended event, not the max-occurred_at event');
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
  t('correlation summary reports full extent even when timeline is large and non-monotonic', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const grantId = 'grnt_extent';
      const baseTs = Date.parse('2026-04-04T00:00:00.000Z');
      // Deliberately non-monotonic in append order. Summary extent is a
      // wall-clock aggregate (MIN/MAX occurred_at), while timeline listing and
      // terminal lookup remain append-order obligations.
      const offsets = [5000, 1000, 9000, 3000, 11000, 0, 7000, 2000, 10000, 4000, 8000, 6000];
      const occurredValues = offsets.map((offset) => new Date(baseTs + offset).toISOString());
      const firstIso = occurredValues.reduce((min, value) => (value < min ? value : min));
      const lastIso = occurredValues.reduce((max, value) => (value > max ? value : max));
      for (let i = 0; i < occurredValues.length; i += 1) {
        const occurred = occurredValues[i];
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
      assert.equal(row.event_count, occurredValues.length,
        'summary event_count must equal the full correlation extent');
      assert.equal(row.first_at, firstIso,
        'summary first_at must equal the earliest event');
      assert.equal(row.last_at, lastIso,
        'summary last_at must equal the latest event');
    } finally {
      await driver.teardown();
    }
  });

  // 4b. Pagination remains stable across pages when every event in the
  //     timeline shares the *same* occurred_at. A driver that orders by
  //     wall-clock time and uses a backend-private physical row identity as
  //     a tiebreaker can still pass the single-page tied-timestamp scenario
  //     above while losing ordering once the timeline is read in chunks
  //     small enough to require a cursor. This scenario forces a paged walk
  //     through tied-timestamp events and verifies the visited sequence
  //     matches the append order with no overlap or gap.
  t('paged walk preserves append order when every event shares the same occurred_at', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const traceId = 'trc_paging_tie';
      const sharedTs = '2026-04-06T00:00:00.000Z';
      const total = 9;
      const ids = [];
      for (let i = 0; i < total; i += 1) {
        const r = await driver.append(evt({
          trace_id: traceId,
          event_type: `reference.test.paged_tie_${i.toString(16)}`,
          occurred_at: sharedTs,
        }));
        ids.push(r.event_id);
      }

      const collected = [];
      let cursor = null;
      let pages = 0;
      while (pages < 20) {
        const page = await driver.listPage('trace', traceId, { limit: 2, cursor });
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
        'paged walk over tied-timestamp events must visit each event exactly once in append order',
      );
      assert.equal(
        new Set(collected).size,
        collected.length,
        'paged walk over tied-timestamp events must not repeat events across pages',
      );
      assert.ok(
        pages >= Math.ceil(total / 2),
        `expected at least ${Math.ceil(total / 2)} pages of size 2 over ${total} events`,
      );
    } finally {
      await driver.teardown();
    }
  });

  // 4c. Interleaved appends across two correlations must each surface a
  //     paged walk that respects the *correlation-local* append order. A
  //     driver that confused inter-correlation order (for instance, by
  //     mixing physical row identity into a per-correlation cursor without
  //     the correlation bound) would surface foreign events or skip rows
  //     when the same backend page boundary fell between two correlations.
  t('paged walk per correlation is stable when correlations are interleaved', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const traceA = 'trc_interleaved_a';
      const traceB = 'trc_interleaved_b';
      const sharedTs = '2026-04-07T00:00:00.000Z';
      // Interleave appends across both correlations; deliberately mix in a
      // matching shared occurred_at so the only stable order is append.
      const sequence = [
        { trace: traceA, tag: 'a0' },
        { trace: traceB, tag: 'b0' },
        { trace: traceA, tag: 'a1' },
        { trace: traceB, tag: 'b1' },
        { trace: traceA, tag: 'a2' },
        { trace: traceB, tag: 'b2' },
        { trace: traceA, tag: 'a3' },
        { trace: traceB, tag: 'b3' },
        { trace: traceA, tag: 'a4' },
        { trace: traceB, tag: 'b4' },
      ];
      const idsByTrace = { [traceA]: [], [traceB]: [] };
      for (const step of sequence) {
        const r = await driver.append(evt({
          trace_id: step.trace,
          event_type: `reference.test.interleaved_${step.tag}`,
          occurred_at: sharedTs,
        }));
        idsByTrace[step.trace].push(r.event_id);
      }

      for (const [traceId, expected] of Object.entries(idsByTrace)) {
        const collected = [];
        let cursor = null;
        let pages = 0;
        while (pages < 20) {
          const page = await driver.listPage('trace', traceId, { limit: 2, cursor });
          pages += 1;
          for (const ev of page.events) {
            assert.equal(
              ev.trace_id,
              traceId,
              `paged walk for ${traceId} must not surface events from a sibling correlation`,
            );
            collected.push(ev.event_id);
          }
          if (!page.truncated) {
            assert.equal(page.next_cursor, null, 'next_cursor must be null on the final page');
            break;
          }
          assert.ok(page.next_cursor, 'next_cursor must be present when the page is truncated');
          cursor = page.next_cursor;
        }

        assert.deepEqual(
          collected,
          expected,
          `paged walk for ${traceId} must visit every event in correlation-local append order`,
        );
        assert.equal(
          new Set(collected).size,
          collected.length,
          `paged walk for ${traceId} must not repeat events`,
        );
      }
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
