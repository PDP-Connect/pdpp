/**
 * Lexical retrieval conformance harness.
 *
 * Test-only helper. Defines the durable lexical-retrieval obligations of the
 * reference architecture as reusable scenarios that any candidate driver can
 * be run against by supplying a small driver object.
 *
 * The driver shape is intentionally narrow and *semantic*: it speaks in terms
 * of upserting indexed text for a record's declared lexical fields, deleting
 * a record's index rows, deleting all rows for a (connector_id, stream), and
 * running a query that returns a deterministically-ordered ranked list with
 * snippet metadata. It does not expose raw SQL, FTS5 query syntax, query
 * builders, framework routes, or a generic `LexicalIndex` repository surface.
 * It is not exported from production code and SHALL NOT be treated as a
 * production `LexicalIndex` contract — the production reference still routes
 * `/v1/search` through `runLexicalSearch` directly.
 *
 * Driver shape:
 *
 *   {
 *     async setup(): void
 *     async teardown(): void
 *
 *     // Backend identity. Drivers MUST advertise enough metadata that
 *     // callers can reason about portability without inspecting code.
 *     identity(): {
 *       backend_kind: string,                  // free-form identifier, e.g. 'sqlite-fts5', 'memory-substring'
 *       tokenizer: 'unicode61' | 'substring' | 'token-frequency' | string,
 *       case_sensitive: boolean,
 *       supports_phrase_query: boolean,
 *       score: {
 *         kind: 'bm25' | 'token_frequency' | 'none' | string,
 *         order: 'lower_is_better' | 'higher_is_better' | 'unordered',
 *         value_semantics: 'implementation_relative' | 'normalized' | 'absolute',
 *       },
 *       supports_snippets: boolean,
 *     }
 *
 *     // Upsert a single record's indexed text. `fields` is { field: text }
 *     // for every declared lexical field on this stream. Drivers MUST treat
 *     // upsert as replace-all-rows-for-this-record.
 *     async upsert({ connectorId, stream, recordKey, fields }): void
 *
 *     // Delete one record's index rows entirely.
 *     async deleteRecord({ connectorId, stream, recordKey }): void
 *
 *     // Delete every row for a (connector_id, stream).
 *     async deleteStream({ connectorId, stream }): void
 *
 *     // Run a query against one (connector_id, stream) over the supplied
 *     // searchable fields. Drivers return a deterministic list of hits in
 *     // their declared score order. Each hit has:
 *     //   {
 *     //     recordKey: string,
 *     //     matchedFields: string[],   // subset of `searchableFields`
 *     //     snippet: { field: string, text: string } | null,
 *     //     score: number              // backend-relative; semantics declared in identity()
 *     //   }
 *     async search({ connectorId, stream, searchableFields, q }):
 *       Array<HitRecord>
 *   }
 *
 * Spec: openspec/changes/add-lexical-retrieval-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';

const CONNECTOR_A = 'https://test.pdpp.org/connectors/lex-a';
const STREAM_POSTS = 'posts';

function buildSeedRecords() {
  // Records are designed so:
  //  - "alpha" matches r1 strongly (title + body) and r3 weakly (body only)
  //  - "beta"  matches r2 only
  //  - "gamma" matches r1 (body) and r4 (title)
  //  - "delta" matches nothing (no-result probe)
  // Drivers will see different absolute score values; the harness only
  // asserts ordering and presence/absence properties.
  return [
    {
      recordKey: 'r1',
      fields: { title: 'alpha topic', body: 'alpha gamma in body' },
    },
    {
      recordKey: 'r2',
      fields: { title: 'beta topic', body: 'beta only here' },
    },
    {
      recordKey: 'r3',
      fields: { title: 'unrelated', body: 'alpha mention but quiet' },
    },
    {
      recordKey: 'r4',
      fields: { title: 'gamma plus extras', body: 'no other tokens' },
    },
  ];
}

async function seedDefault(driver) {
  for (const rec of buildSeedRecords()) {
    await driver.upsert({
      connectorId: CONNECTOR_A,
      stream: STREAM_POSTS,
      recordKey: rec.recordKey,
      fields: rec.fields,
    });
  }
}

function recordKeysOf(hits) {
  return hits.map((h) => h.recordKey);
}

/**
 * Run the lexical-retrieval conformance suite against a driver.
 *
 * @param {object} options
 * @param {string} options.label                              distinguishes the driver in test names
 * @param {(name: string, fn: () => Promise<void>) => void} options.test  test runner (e.g. node:test's `test`)
 * @param {() => Promise<object> | object} options.makeDriver returns a fresh driver per scenario
 */
export function runLexicalRetrievalConformance({ label, test, makeDriver }) {
  const t = (name, fn) => test(`[lexical-conformance:${label}] ${name}`, fn);

  // 1. Backend identity is honest and machine-readable.
  //
  // The harness intentionally accepts a wide range of identities. What it
  // refuses is a driver that advertises FTS5/bm25 semantics it cannot
  // demonstrate. Specifically: a driver that claims `score.kind === 'bm25'`
  // and `score.order === 'lower_is_better'` must actually return scores
  // where better-ranked hits have *smaller* numeric values. This is the
  // honesty gate that prevents a memory driver from impersonating FTS5.
  t('advertises required backend identity fields', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const id = driver.identity();
      assert.equal(typeof id, 'object', 'identity() must return an object');
      assert.equal(typeof id.backend_kind, 'string', 'backend_kind required');
      assert.ok(id.backend_kind.length > 0, 'backend_kind must be non-empty');
      assert.equal(typeof id.tokenizer, 'string', 'tokenizer required');
      assert.equal(typeof id.case_sensitive, 'boolean', 'case_sensitive required');
      assert.equal(typeof id.supports_phrase_query, 'boolean', 'supports_phrase_query required');
      assert.equal(typeof id.supports_snippets, 'boolean', 'supports_snippets required');
      assert.equal(typeof id.score, 'object', 'score block required');
      assert.equal(typeof id.score.kind, 'string', 'score.kind required');
      assert.ok(
        ['lower_is_better', 'higher_is_better', 'unordered'].includes(id.score.order),
        `score.order must be a known direction (got ${id.score.order})`,
      );
      assert.equal(
        typeof id.score.value_semantics,
        'string',
        'score.value_semantics required',
      );
    } finally {
      await driver.teardown();
    }
  });

  // 2. Upsert + query over declared searchable fields.
  //
  // Pins the basic obligation: indexed text becomes findable, and matched
  // fields are restricted to the declared/searchable set passed at query
  // time. The harness does not assume a specific ranking algorithm; it
  // only asserts presence/absence and matched-field correctness.
  t('upsert + query returns hits restricted to declared searchable fields', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await seedDefault(driver);
      const hits = await driver.search({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        searchableFields: ['title', 'body'],
        q: 'alpha',
      });
      const keys = new Set(recordKeysOf(hits));
      assert.ok(keys.has('r1'), 'r1 (alpha in title and body) must match');
      assert.ok(keys.has('r3'), 'r3 (alpha in body only) must match');
      assert.ok(!keys.has('r2'), 'r2 has no alpha — must not match');
      assert.ok(!keys.has('r4'), 'r4 has no alpha — must not match');
      for (const hit of hits) {
        for (const f of hit.matchedFields) {
          assert.ok(
            ['title', 'body'].includes(f),
            `matched_fields entry '${f}' is not in declared searchable fields`,
          );
        }
      }
    } finally {
      await driver.teardown();
    }
  });

  // 3. Searchable-field gating: a query restricted to ['title'] MUST NOT
  //    surface records that only matched on `body`. This is the structural
  //    realization of the spec rule that field gating happens before the
  //    index is consulted.
  t('searchable-field restriction excludes hits matched only on excluded fields', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await seedDefault(driver);
      const hits = await driver.search({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        searchableFields: ['title'],
        q: 'alpha',
      });
      const keys = new Set(recordKeysOf(hits));
      assert.ok(keys.has('r1'), 'r1 has alpha in title — must still match');
      assert.ok(
        !keys.has('r3'),
        'r3 only has alpha in body — must NOT match when searchableFields=[title]',
      );
      for (const hit of hits) {
        assert.deepEqual(
          hit.matchedFields,
          ['title'],
          'matched_fields must be limited to the declared searchable set',
        );
      }
    } finally {
      await driver.teardown();
    }
  });

  // 4. Delete one record removes it from subsequent queries.
  t('deleteRecord removes the record from subsequent queries', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await seedDefault(driver);
      await driver.deleteRecord({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        recordKey: 'r1',
      });
      const hits = await driver.search({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        searchableFields: ['title', 'body'],
        q: 'alpha',
      });
      const keys = new Set(recordKeysOf(hits));
      assert.ok(!keys.has('r1'), 'r1 was deleted — must not appear');
      assert.ok(keys.has('r3'), 'r3 still present — must still match alpha');
    } finally {
      await driver.teardown();
    }
  });

  // 5. Delete-by-stream removes every record for that (connector, stream).
  t('deleteStream removes every indexed record for that connector+stream', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await seedDefault(driver);
      await driver.deleteStream({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
      });
      const hits = await driver.search({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        searchableFields: ['title', 'body'],
        q: 'alpha',
      });
      assert.equal(hits.length, 0, 'every record was dropped — query must return zero hits');
    } finally {
      await driver.teardown();
    }
  });

  // 6. Upsert is replace-all-rows-for-this-record. After re-upserting r1
  //    with new content that no longer mentions "alpha", a query for
  //    "alpha" must NOT return r1. This rules out drivers that only
  //    append index rows on upsert.
  t('upsert replaces existing index rows for the same record', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await seedDefault(driver);
      await driver.upsert({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        recordKey: 'r1',
        fields: { title: 'topic only', body: 'no token here' },
      });
      const hits = await driver.search({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        searchableFields: ['title', 'body'],
        q: 'alpha',
      });
      const keys = new Set(recordKeysOf(hits));
      assert.ok(
        !keys.has('r1'),
        'r1 was overwritten with non-matching text — must not match alpha',
      );
      assert.ok(keys.has('r3'), 'r3 still has alpha — must still match');
    } finally {
      await driver.teardown();
    }
  });

  // 7. Score metadata matches the advertised direction.
  //
  // For drivers that advertise `lower_is_better` or `higher_is_better`,
  // the hits MUST be returned in monotonic score order. The harness does
  // not enforce a particular ranking *quality*; it enforces that the score
  // values the driver attaches to each hit agree with the order it
  // chooses to return them in. `unordered` drivers are exempt.
  t('result ordering agrees with advertised score direction', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await seedDefault(driver);
      const id = driver.identity();
      const hits = await driver.search({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        searchableFields: ['title', 'body'],
        q: 'alpha',
      });
      assert.ok(hits.length >= 2, 'need at least two hits to verify order');
      for (const hit of hits) {
        assert.equal(typeof hit.score, 'number', 'each hit must carry a numeric score');
        assert.ok(Number.isFinite(hit.score), 'score must be finite');
      }
      if (id.score.order === 'lower_is_better') {
        for (let i = 1; i < hits.length; i += 1) {
          assert.ok(
            hits[i - 1].score <= hits[i].score,
            `lower_is_better violated at index ${i}: ${hits[i - 1].score} > ${hits[i].score}`,
          );
        }
      } else if (id.score.order === 'higher_is_better') {
        for (let i = 1; i < hits.length; i += 1) {
          assert.ok(
            hits[i - 1].score >= hits[i].score,
            `higher_is_better violated at index ${i}: ${hits[i - 1].score} < ${hits[i].score}`,
          );
        }
      }
    } finally {
      await driver.teardown();
    }
  });

  // 8. Deterministic ordering for ties.
  //
  // Re-running the same query against the same indexed state MUST produce
  // the same record_key sequence. This pins the obligation that ties in
  // the primary score are broken by a stable secondary key (typically
  // record_key) so paged callers get stable cursors.
  t('repeated identical queries produce identical ordering (deterministic ties)', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      // Seed a workload designed to produce ties: identical text across
      // multiple records. A naive driver that orders by Map insertion
      // order or hash bucket order will diverge across runs.
      const tieRecords = ['t1', 't2', 't3', 't4'].map((rk) => ({
        recordKey: rk,
        fields: { title: 'omega omega omega', body: 'omega body' },
      }));
      for (const rec of tieRecords) {
        await driver.upsert({
          connectorId: CONNECTOR_A,
          stream: STREAM_POSTS,
          recordKey: rec.recordKey,
          fields: rec.fields,
        });
      }
      const a = await driver.search({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        searchableFields: ['title', 'body'],
        q: 'omega',
      });
      const b = await driver.search({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        searchableFields: ['title', 'body'],
        q: 'omega',
      });
      assert.deepEqual(
        recordKeysOf(a),
        recordKeysOf(b),
        'identical query against identical state must return identical ordering',
      );
    } finally {
      await driver.teardown();
    }
  });

  // 9. Snippet behavior: when a driver advertises snippet support, the
  //    snippet text MUST be substring of the source text from the
  //    matched field — not generated content. The harness tolerates
  //    snippet markers (e.g. ellipses for truncation) by checking that
  //    the alphanumeric core of the snippet appears verbatim in the
  //    source text. Drivers that do not advertise snippet support may
  //    return null.
  t('snippet text is extracted from source field, not generated', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const distinctiveText = 'pdpp_snippet_marker phrase that should appear';
      await driver.upsert({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        recordKey: 'r_snippet',
        fields: {
          title: 'unrelated heading',
          body: distinctiveText,
        },
      });
      const id = driver.identity();
      const hits = await driver.search({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        searchableFields: ['title', 'body'],
        q: 'pdpp_snippet_marker',
      });
      const hit = hits.find((h) => h.recordKey === 'r_snippet');
      assert.ok(hit, 'expected the seeded record to match its distinctive marker');
      if (id.supports_snippets) {
        assert.ok(hit.snippet, 'driver advertises snippet support — snippet must be present');
        assert.equal(typeof hit.snippet.field, 'string', 'snippet.field must be a string');
        assert.equal(typeof hit.snippet.text, 'string', 'snippet.text must be a string');
        assert.equal(
          hit.snippet.field,
          'body',
          'snippet field must be the field that actually matched',
        );
        // Strip optional truncation markers and compare on the
        // alphanumeric core. This tolerates `…`, `...`, FTS5 mark
        // characters, etc., without coupling the harness to one
        // backend's snippet syntax. Strip HTML-like highlight tags (`<mark>`,
        // `</mark>`) FIRST so the tag-name letters do not pollute the core
        // (SQLite emits one `<mark>…</mark>` pair; Postgres ts_headline marks
        // each token, so the tags must be removed before alphanumeric coring).
        const stripMarks = (s) => s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
        const core = stripMarks(hit.snippet.text).replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
        const sourceCore = distinctiveText.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
        // The snippet must carry real content: a non-empty core (an empty
        // string is a substring of everything, so guard it) that is genuinely
        // extracted from the source body. The matched marker token MUST appear
        // in the snippet. A fabricated/generated snippet that merely echoes
        // the query term, or an empty snippet, must fail.
        assert.ok(core.length > 0, `snippet text must be non-empty after stripping marks. got=${hit.snippet.text}`);
        assert.ok(
          core.includes('pdpp_snippet_marker') && sourceCore.includes(core),
          `snippet text must be extracted from the source body and contain the matched marker. got=${hit.snippet.text}`,
        );
      }
    } finally {
      await driver.teardown();
    }
  });

  // 10. No-result behavior: a query with no matching tokens MUST return
  //     an empty list, not throw, and not surface unrelated records.
  t('query for an unindexed token returns an empty result list', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await seedDefault(driver);
      const hits = await driver.search({
        connectorId: CONNECTOR_A,
        stream: STREAM_POSTS,
        searchableFields: ['title', 'body'],
        q: 'delta',
      });
      assert.equal(hits.length, 0, 'no record contains delta — must return zero hits');
    } finally {
      await driver.teardown();
    }
  });
}
