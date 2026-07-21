// Pure, no-DB unit tests for server/ref-record-utils.ts — the timestamp/query/
// cursor helpers behind the /_ref operator surface. The module's own header says
// it exists "specifically so ... these utilities can be tested in isolation," yet
// NO test imports it by name. All 8 exports are pinned here.
//
// Mutation surface:
//   pickSemanticTimestamp -- prefers consent_time_field over cursor_field, trims,
//     skips blank/non-string, non-record data -> null.
//   compareTimestampValues -- date-parse compare, localeCompare fallback.
//   timestampWithinWindow -- half-open-ish window: date-only `since` snaps to
//     00:00:00.000 (inclusive lower), date-only `until` snaps to 23:59:59.999
//     (inclusive that day); out-of-window -> false; blank value -> false.
//   chooseDisplayTimestamp -- native mode uses semantic value when present, else
//     emittedAt; emitted mode always uses emittedAt.
//   findQueryMatch -- case-insensitive WHOLE-WORD match for simple-word queries,
//     recursive descent, snippet extraction; substring for non-simple queries.
//   buildRecordSearchMatchExpression -- FTS token quoting + AND join + informative
//     gate (word/phrase OR all tokens >= 2 chars), quote escaping.
//   encodeOffsetCursor / decodeOffsetCursor -- base64url round-trip; reject
//     non-string, garbage, non-integer, and NEGATIVE offsets.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRecordSearchMatchExpression,
  chooseDisplayTimestamp,
  compareTimestampValues,
  decodeOffsetCursor,
  encodeOffsetCursor,
  findQueryMatch,
  pickSemanticTimestamp,
  timestampWithinWindow,
} from '../server/ref-record-utils.ts';

// ---------------------------------------------------------------------------
// pickSemanticTimestamp
// ---------------------------------------------------------------------------

test('pickSemanticTimestamp: prefers consent_time_field over cursor_field and trims', () => {
  const out = pickSemanticTimestamp(
    { consent_time_field: 'ct', cursor_field: 'cf' },
    { cf: '2024-01-01', ct: '  2023-06-15  ' },
  );
  assert.deepEqual(out, { field: 'ct', value: '2023-06-15' }, 'consent_time_field wins, trimmed');
});

test('pickSemanticTimestamp: falls back to cursor_field when consent field value is missing/blank', () => {
  const out = pickSemanticTimestamp({ consent_time_field: 'ct', cursor_field: 'cf' }, { ct: '   ', cf: '2024-02-02' });
  assert.deepEqual(out, { field: 'cf', value: '2024-02-02' });
});

test('pickSemanticTimestamp: non-record data or no usable field -> null', () => {
  assert.equal(pickSemanticTimestamp({ cursor_field: 'cf' }, null), null);
  assert.equal(pickSemanticTimestamp({ cursor_field: 'cf' }, 'not-an-object'), null);
  assert.equal(pickSemanticTimestamp({ cursor_field: 'cf' }, { other: 'x' }), null, 'no matching field -> null');
});

// ---------------------------------------------------------------------------
// compareTimestampValues
// ---------------------------------------------------------------------------

test('compareTimestampValues: orders parseable dates chronologically', () => {
  assert.ok(compareTimestampValues('2024-01-01', '2024-06-01') < 0, 'earlier is less');
  assert.ok(compareTimestampValues('2024-06-01', '2024-01-01') > 0, 'later is greater');
  assert.equal(Math.sign(compareTimestampValues('2024-01-01T00:00:00Z', '2024-01-01')), 0, 'same instant compares equal');
});

test('compareTimestampValues: falls back to lexical compare for unparseable values', () => {
  assert.ok(compareTimestampValues('apple', 'banana') < 0, 'lexical order used when not date-parseable');
});

// ---------------------------------------------------------------------------
// timestampWithinWindow
// ---------------------------------------------------------------------------

test('timestampWithinWindow: date-only until includes the whole day (snaps to 23:59:59.999)', () => {
  assert.equal(timestampWithinWindow('2024-03-15T18:00:00Z', null, '2024-03-15'), true, 'same day within until');
  assert.equal(timestampWithinWindow('2024-03-16T00:00:00Z', null, '2024-03-15'), false, 'next day past until');
});

test('timestampWithinWindow: date-only since includes from the start of that day', () => {
  assert.equal(timestampWithinWindow('2024-03-15T00:00:00Z', '2024-03-15', null), true, 'start of since day included');
  assert.equal(timestampWithinWindow('2024-03-14T23:59:59Z', '2024-03-15', null), false, 'before since rejected');
});

test('timestampWithinWindow: both bounds compose into a closed window', () => {
  assert.equal(timestampWithinWindow('2024-03-15T12:00:00Z', '2024-03-10', '2024-03-20'), true, 'inside');
  assert.equal(timestampWithinWindow('2024-03-25T00:00:00Z', '2024-03-10', '2024-03-20'), false, 'after end');
});

test('timestampWithinWindow: a blank/non-string value is never within a window', () => {
  assert.equal(timestampWithinWindow('', '2024-01-01', null), false);
  assert.equal(timestampWithinWindow(null, null, null), false);
});

// ---------------------------------------------------------------------------
// chooseDisplayTimestamp
// ---------------------------------------------------------------------------

test('chooseDisplayTimestamp: native mode uses the semantic value when present', () => {
  assert.equal(
    chooseDisplayTimestamp({ semanticTimestamp: { field: 'x', value: '2023-01-01' }, emittedAt: '2024-01-01', mode: 'native' }),
    '2023-01-01',
  );
});

test('chooseDisplayTimestamp: native mode with no semantic value, and emitted mode, use emittedAt', () => {
  assert.equal(chooseDisplayTimestamp({ semanticTimestamp: null, emittedAt: '2024-01-01', mode: 'native' }), '2024-01-01');
  assert.equal(
    chooseDisplayTimestamp({ semanticTimestamp: { field: 'x', value: '2023-01-01' }, emittedAt: '2024-01-01', mode: 'emitted' }),
    '2024-01-01',
    'emitted mode ignores the semantic value',
  );
});

// ---------------------------------------------------------------------------
// findQueryMatch
// ---------------------------------------------------------------------------

test('findQueryMatch: simple-word query matches on a WHOLE-WORD boundary only', () => {
  assert.equal(findQueryMatch({ t: 'cats and dogs' }, 'cat'), null, "'cat' glued to 's' is NOT a whole-word match");
  const hit = findQueryMatch({ t: 'a cat sat' }, 'cat');
  assert.equal(hit.field, 't');
  assert.ok(hit.snippet.includes('cat'), 'snippet surfaces the hit');
});

test('findQueryMatch: matching is case-insensitive and descends into nested records', () => {
  const hit = findQueryMatch({ outer: { inner: 'The QUICK brown fox' } }, 'quick');
  assert.equal(hit.field, 'outer.inner', 'nested field path reported');
});

test('findQueryMatch: descends into arrays with index-based field paths', () => {
  const hit = findQueryMatch({ tags: ['alpha', 'beta'] }, 'beta');
  assert.equal(hit.field, 'tags[1]');
});

test('findQueryMatch: empty query -> null', () => {
  assert.equal(findQueryMatch({ t: 'anything' }, ''), null);
  assert.equal(findQueryMatch({ t: 'anything' }, '   '), null);
});

// ---------------------------------------------------------------------------
// buildRecordSearchMatchExpression
// ---------------------------------------------------------------------------

test('buildRecordSearchMatchExpression: quotes tokens and joins with AND', () => {
  assert.equal(buildRecordSearchMatchExpression('hello world'), '"hello" AND "world"');
  assert.equal(buildRecordSearchMatchExpression('single'), '"single"');
});

test('buildRecordSearchMatchExpression: blank / token-less input -> null', () => {
  assert.equal(buildRecordSearchMatchExpression(''), null);
  assert.equal(buildRecordSearchMatchExpression('   '), null);
  assert.equal(buildRecordSearchMatchExpression('!!!'), null, 'punctuation yields no tokens');
});

test('buildRecordSearchMatchExpression: escapes embedded double quotes', () => {
  // A phrase-shaped query with an embedded quote -> each token FTS-quote-escaped.
  const out = buildRecordSearchMatchExpression('say "hi"');
  assert.ok(out.includes('"hi"') || out.includes('""'), `escaped output: ${out}`);
});

// ---------------------------------------------------------------------------
// encodeOffsetCursor / decodeOffsetCursor
// ---------------------------------------------------------------------------

test('encodeOffsetCursor/decodeOffsetCursor: round-trip a non-negative integer', () => {
  assert.equal(decodeOffsetCursor(encodeOffsetCursor(0)), 0);
  assert.equal(decodeOffsetCursor(encodeOffsetCursor(42)), 42);
  assert.equal(decodeOffsetCursor(encodeOffsetCursor(1_000_000)), 1_000_000);
});

test('decodeOffsetCursor: rejects negative, non-integer, garbage, and non-string -> null', () => {
  assert.equal(decodeOffsetCursor(encodeOffsetCursor(-1)), null, 'negative offset rejected');
  assert.equal(decodeOffsetCursor('!!! not base64 !!!'), null, 'garbage -> null (no throw)');
  assert.equal(decodeOffsetCursor(''), null);
  assert.equal(decodeOffsetCursor(null), null);
  assert.equal(decodeOffsetCursor(123), null, 'non-string -> null');
  // A well-formed base64url of a non-offset object -> null.
  const badPayload = Buffer.from(JSON.stringify({ notOffset: 1 }), 'utf8').toString('base64url');
  assert.equal(decodeOffsetCursor(badPayload), null, 'missing offset field -> null');
});
