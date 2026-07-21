// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the UNTESTED opaque search-pagination cursor codecs:
 *   - `encodeSearchLexicalCursor` / `decodeSearchLexicalCursor`
 *     (`operations/rs-search-lexical/index.ts`)
 *   - `encodeSearchSemanticCursor` / `decodeSearchSemanticCursor`
 *     (`operations/rs-search-semantic/index.ts`)
 *
 * Both carry the same `{snap, off}` payload — a snapshot id + an offset into it —
 * and back the `next_cursor` on `GET /v1/search` and `GET /v1/search/semantic`.
 * The contract pinned here:
 *
 *   - lexical encode is `base64url(JSON.stringify({snap, off}))`; decode is the
 *     inverse and round-trips exactly;
 *   - semantic encode PREFIXES the same base64url body with the literal `sem1.`;
 *     decode requires that prefix, strips it, then decodes the body;
 *   - decode is TOLERANT (returns null, never throws) for: non-base64url/bad
 *     JSON, a payload missing `snap` (string) or `off` (number), and — for
 *     semantic — a cursor lacking the `sem1.` prefix;
 *   - CROSS-SURFACE guard: a lexical cursor handed to the semantic decoder
 *     returns null (the documented "cursor from /v1/search passed to
 *     /v1/search/semantic → invalid_cursor" scenario).
 *
 * Both modules are pure (zero imports). No DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeSearchLexicalCursor,
  decodeSearchLexicalCursor,
} from '../operations/rs-search-lexical/index.ts';
import {
  encodeSearchSemanticCursor,
  decodeSearchSemanticCursor,
} from '../operations/rs-search-semantic/index.ts';

const SEMANTIC_PREFIX = 'sem1.';

// --- lexical ----------------------------------------------------------------

test('lexical cursor: round-trips {snap, off} exactly', () => {
  const payload = { snap: 'snap_abc', off: 40 };
  const decoded = decodeSearchLexicalCursor(encodeSearchLexicalCursor(payload));
  assert.deepEqual(decoded, payload, `decoded: ${JSON.stringify(decoded)}`);
});

test('lexical encode: is base64url of the JSON payload (no +/= chars, decodes back)', () => {
  const encoded = encodeSearchLexicalCursor({ snap: 'snap_1', off: 0 });
  assert.equal(/[+/=]/.test(encoded), false, `must be base64url-clean: ${encoded}`);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), { snap: 'snap_1', off: 0 });
});

test('lexical decode: preserves offset 0 (does not treat 0 as missing)', () => {
  const decoded = decodeSearchLexicalCursor(encodeSearchLexicalCursor({ snap: 's', off: 0 }));
  assert.strictEqual(decoded.off, 0, 'offset 0 must survive as a number');
});

test('lexical decode: returns null for a non-base64url / non-JSON cursor', () => {
  const garbage = Buffer.from('not json at all', 'utf8').toString('base64url');
  assert.equal(decodeSearchLexicalCursor(garbage), null, 'bad JSON => null');
});

test('lexical decode: returns null when snap is not a string', () => {
  const bad = Buffer.from(JSON.stringify({ snap: 123, off: 10 }), 'utf8').toString('base64url');
  assert.equal(decodeSearchLexicalCursor(bad), null, 'non-string snap => null');
});

test('lexical decode: returns null when off is not a number', () => {
  const bad = Buffer.from(JSON.stringify({ snap: 's', off: '10' }), 'utf8').toString('base64url');
  assert.equal(decodeSearchLexicalCursor(bad), null, 'non-number off => null');
});

test('lexical decode: drops extra fields, returning only {snap, off}', () => {
  const bloated = Buffer.from(
    JSON.stringify({ snap: 's', off: 5, extra: 'ignore-me' }),
    'utf8',
  ).toString('base64url');
  assert.deepEqual(decodeSearchLexicalCursor(bloated), { snap: 's', off: 5 });
});

// --- semantic ---------------------------------------------------------------

test('semantic cursor: round-trips {snap, off} exactly and carries the sem1. prefix', () => {
  const payload = { snap: 'snap_sem', off: 60 };
  const encoded = encodeSearchSemanticCursor(payload);
  assert.equal(encoded.startsWith(SEMANTIC_PREFIX), true, `semantic cursor must carry the prefix: ${encoded}`);
  assert.deepEqual(decodeSearchSemanticCursor(encoded), payload);
});

test('semantic encode: body after the prefix is the same base64url as the lexical encoding', () => {
  const payload = { snap: 'snap_x', off: 7 };
  const semantic = encodeSearchSemanticCursor(payload);
  const lexical = encodeSearchLexicalCursor(payload);
  assert.equal(semantic, SEMANTIC_PREFIX + lexical, `semantic=${semantic} lexical=${lexical}`);
});

test('semantic decode: returns null when the sem1. prefix is missing', () => {
  // A valid base64url {snap,off} body WITHOUT the prefix must be rejected.
  const bodyOnly = encodeSearchLexicalCursor({ snap: 's', off: 1 });
  assert.equal(decodeSearchSemanticCursor(bodyOnly), null, 'missing prefix => null');
});

test('semantic decode: a WRONG same-length prefix is rejected, not blindly sliced', () => {
  // Take a real semantic cursor and replace its "sem1." prefix with a different
  // 5-char marker. The decoder must reject it via the prefix CHECK — not merely
  // slice 5 chars off and decode whatever remains (which would wrongly succeed
  // because the body after a same-length prefix is still a valid payload).
  const real = encodeSearchSemanticCursor({ snap: 'snap_wrongpfx', off: 33 });
  assert.equal(real.startsWith(SEMANTIC_PREFIX), true, 'sanity: real cursor has sem1. prefix');
  const swapped = 'XXXX.' + real.slice(SEMANTIC_PREFIX.length); // same length (5), wrong marker
  assert.equal(
    decodeSearchSemanticCursor(swapped),
    null,
    'a non-sem1. prefix of equal length must be rejected by the prefix check',
  );
});

test('semantic decode: returns null for a prefixed but malformed body', () => {
  const bad = SEMANTIC_PREFIX + Buffer.from('nope', 'utf8').toString('base64url');
  assert.equal(decodeSearchSemanticCursor(bad), null, 'prefixed garbage => null');
});

test('semantic decode: returns null when a prefixed payload is missing off', () => {
  const bad = SEMANTIC_PREFIX + Buffer.from(JSON.stringify({ snap: 's' }), 'utf8').toString('base64url');
  assert.equal(decodeSearchSemanticCursor(bad), null, 'prefixed payload missing off => null');
});

// --- cross-surface isolation ------------------------------------------------

test('cross-surface: a lexical cursor handed to the semantic decoder returns null', () => {
  const lexical = encodeSearchLexicalCursor({ snap: 'snap_1', off: 20 });
  assert.equal(
    decodeSearchSemanticCursor(lexical),
    null,
    'lexical cursor must be invalid_cursor on the semantic surface',
  );
});
