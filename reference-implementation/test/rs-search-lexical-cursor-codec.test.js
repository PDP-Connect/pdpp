// Pin the lexical search cursor id-form: the opaque handle a client pages
// forward with. `encodeSearchLexicalCursor`/`decodeSearchLexicalCursor` are a
// base64url(JSON) codec over `{ snap, off }`. The operation test USES the
// encoder to build a stale-snapshot fixture, but the codec's own contract —
// exact round-trip, base64url (not plain base64) wire form, and the
// malformed → null rule that hosts map to `invalid_cursor` — had no direct
// coverage. A silent change to the encoding or a loosened decoder validation
// would corrupt paging without a by-name test noticing.
//
// Pure, DB-free, no grant/token surface — assertions observe the codec only.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeSearchLexicalCursor,
  decodeSearchLexicalCursor,
} from '../operations/rs-search-lexical/index.ts';

test('encode → decode round-trips the snapshot id and offset exactly', () => {
  for (const payload of [
    { snap: 'snap_abc', off: 0 },
    { snap: 'snap_abc', off: 42 },
    { snap: 'snap-with-dashes_and_UPPER', off: 1000000 },
  ]) {
    const token = encodeSearchLexicalCursor(payload);
    assert.equal(typeof token, 'string');
    assert.deepEqual(decodeSearchLexicalCursor(token), payload);
  }
});

test('the cursor is base64url (JSON) — url-safe, no + / = padding characters', () => {
  // A snapshot id crafted so its JSON base64 would contain +/ in plain base64;
  // base64url must emit - and _ instead and drop padding.
  const token = encodeSearchLexicalCursor({ snap: '???>>>???', off: 255 });
  assert.doesNotMatch(token, /[+/=]/, 'base64url must not contain +, /, or = padding');
  // And it must decode with Node's base64url back to the exact JSON payload.
  const json = Buffer.from(token, 'base64url').toString('utf8');
  assert.deepEqual(JSON.parse(json), { snap: '???>>>???', off: 255 });
});

test('decode returns null for a non-base64url / non-JSON blob (host maps to invalid_cursor)', () => {
  // '@@@' contains characters outside the base64url alphabet; the decoded bytes
  // are not valid JSON, so the JSON.parse in the decoder throws and we get null.
  assert.equal(decodeSearchLexicalCursor('@@@'), null);
  assert.equal(decodeSearchLexicalCursor('not a cursor'), null);
  assert.equal(decodeSearchLexicalCursor(''), null);
});

test('decode returns null when the JSON is valid but the shape is wrong', () => {
  const enc = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  // Missing off, wrong types, or a non-object payload all fail the type guard.
  assert.equal(decodeSearchLexicalCursor(enc({ snap: 'x' })), null, 'off missing');
  assert.equal(decodeSearchLexicalCursor(enc({ off: 3 })), null, 'snap missing');
  assert.equal(decodeSearchLexicalCursor(enc({ snap: 5, off: 3 })), null, 'snap wrong type');
  assert.equal(decodeSearchLexicalCursor(enc({ snap: 'x', off: '3' })), null, 'off wrong type');
  assert.equal(decodeSearchLexicalCursor(enc([1, 2, 3])), null, 'array payload');
  assert.equal(decodeSearchLexicalCursor(enc('just a string')), null, 'scalar payload');
});

test('decode strips extra fields, returning only the canonical snap/off pair', () => {
  const enc = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const token = enc({ snap: 'snap_x', off: 9, injected: 'ignored', nested: { a: 1 } });
  const decoded = decodeSearchLexicalCursor(token);
  assert.deepEqual(decoded, { snap: 'snap_x', off: 9 });
  assert.equal(Object.keys(decoded).length, 2, 'only snap and off survive');
});

test('offset 0 is a valid, distinct cursor (not treated as absent)', () => {
  const token = encodeSearchLexicalCursor({ snap: 'snap_first', off: 0 });
  const decoded = decodeSearchLexicalCursor(token);
  assert.deepEqual(decoded, { snap: 'snap_first', off: 0 });
  assert.equal(decoded.off, 0);
});
