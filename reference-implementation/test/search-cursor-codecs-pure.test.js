// Pure, no-DB unit tests for the search pagination cursor codecs in
// operations/rs-search-lexical/index.ts and operations/rs-search-semantic/index.ts.
// None are imported by name. These encode/decode the {snap, off} search cursor
// that carries the pinned snapshot id + offset for the next page; a decoder that
// fails to reject a malformed cursor would paginate against the wrong snapshot.
//
// Contrast pinned here: the LEXICAL cursor is a bare base64url(JSON), while the
// SEMANTIC cursor is namespaced with a `sem1.` prefix — a semantic decode of a
// bare (unprefixed) payload MUST return null. Both decoders return null (never
// throw) on any malformed input.
//
// Mutation surface:
//   encode/decodeSearchLexicalCursor -- base64url(JSON) round-trip; requires snap
//     (string) + off (number), else null; garbage -> null.
//   encode/decodeSearchSemanticCursor -- `sem1.`-prefixed; same field validation;
//     a missing/incorrect prefix -> null.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeSearchLexicalCursor,
  encodeSearchLexicalCursor,
} from '../operations/rs-search-lexical/index.ts';
import {
  decodeSearchSemanticCursor,
  encodeSearchSemanticCursor,
} from '../operations/rs-search-semantic/index.ts';

function bareB64(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------
// lexical cursor
// ---------------------------------------------------------------------------

test('lexical: encode -> decode round-trips {snap, off}', () => {
  const encoded = encodeSearchLexicalCursor({ snap: 'snap-1', off: 40 });
  assert.deepEqual(decodeSearchLexicalCursor(encoded), { snap: 'snap-1', off: 40 });
});

test('lexical: a bare base64url(JSON) with the right shape decodes (no prefix required)', () => {
  assert.deepEqual(decodeSearchLexicalCursor(bareB64({ snap: 's', off: 0 })), { snap: 's', off: 0 });
});

test('lexical: missing/mistyped snap or off -> null', () => {
  assert.equal(decodeSearchLexicalCursor(bareB64({ snap: 's' })), null, 'missing off -> null');
  assert.equal(decodeSearchLexicalCursor(bareB64({ off: 5 })), null, 'missing snap -> null');
  assert.equal(decodeSearchLexicalCursor(bareB64({ snap: 5, off: 'x' })), null, 'wrong types -> null');
});

test('lexical: garbage / non-JSON -> null (never throws)', () => {
  assert.equal(decodeSearchLexicalCursor('%%% not base64url %%%'), null);
  assert.equal(decodeSearchLexicalCursor(Buffer.from('not json', 'utf8').toString('base64url')), null);
});

// ---------------------------------------------------------------------------
// semantic cursor (namespaced with a sem1. prefix)
// ---------------------------------------------------------------------------

test('semantic: encode -> decode round-trips {snap, off}', () => {
  const encoded = encodeSearchSemanticCursor({ snap: 'snap-2', off: 10 });
  assert.deepEqual(decodeSearchSemanticCursor(encoded), { snap: 'snap-2', off: 10 });
});

test('semantic: the encoded cursor carries the sem1. namespace prefix', () => {
  const encoded = encodeSearchSemanticCursor({ snap: 's', off: 0 });
  assert.ok(encoded.startsWith('sem1.'), `semantic cursor should be sem1.-prefixed, got ${encoded}`);
});

test('semantic: a bare (unprefixed) payload is REJECTED even with the right shape', () => {
  assert.equal(
    decodeSearchSemanticCursor(bareB64({ snap: 's', off: 0 })),
    null,
    'a lexical-shaped (unprefixed) cursor must not decode as a semantic cursor',
  );
});

test('semantic: missing/mistyped fields and garbage -> null', () => {
  // Build a correctly-prefixed but shape-invalid cursor.
  const badShape = `sem1.${bareB64({ snap: 's' })}`;
  assert.equal(decodeSearchSemanticCursor(badShape), null, 'prefixed but missing off -> null');
  assert.equal(decodeSearchSemanticCursor('sem1.@@@notb64@@@'), null, 'prefixed garbage -> null');
  assert.equal(decodeSearchSemanticCursor(42), null, 'non-string input -> null');
});

// ---------------------------------------------------------------------------
// cross-codec isolation
// ---------------------------------------------------------------------------

test('cross: a semantic cursor does not decode as lexical, and vice-versa', () => {
  const semantic = encodeSearchSemanticCursor({ snap: 's', off: 3 });
  // The lexical decoder would try to base64url-decode the whole "sem1.<body>"
  // string; the leading "sem1." makes it not a valid bare payload -> null.
  assert.equal(decodeSearchLexicalCursor(semantic), null, 'semantic cursor is not a valid lexical cursor');

  const lexical = encodeSearchLexicalCursor({ snap: 's', off: 3 });
  assert.equal(decodeSearchSemanticCursor(lexical), null, 'lexical cursor lacks the sem1. prefix');
});
