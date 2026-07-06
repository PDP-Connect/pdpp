// Pin the semantic search cursor id-form and the mutual isolation between the
// lexical and semantic cursor codecs.
//
// The semantic operation test covers the sem1. prefix and invalid_cursor
// mapping THROUGH executeSearchSemantic (full snapshot fixtures). This file
// pins the pure codec contract directly, plus the property the operation
// tests only touch indirectly: a cursor minted for one search endpoint MUST
// NOT decode as a valid cursor for the other. That mutual isolation is what
// realizes the spec scenario "cursor from /v1/search passed to
// /v1/search/semantic → invalid_cursor" (and its reverse), and it hinges on
// the literal `sem1.` prefix being both required by the semantic decoder and
// absent from lexical cursors.
//
// Pure, DB-free, no grant/token surface — assertions observe the codecs only.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeSearchLexicalCursor,
  decodeSearchLexicalCursor,
} from '../operations/rs-search-lexical/index.ts';
import {
  encodeSearchSemanticCursor,
  decodeSearchSemanticCursor,
} from '../operations/rs-search-semantic/index.ts';

test('semantic encode → decode round-trips and carries the literal sem1. prefix', () => {
  const payload = { snap: 'snap_sem', off: 12 };
  const token = encodeSearchSemanticCursor(payload);
  assert.ok(token.startsWith('sem1.'), 'semantic cursors carry the sem1. prefix on the wire');
  assert.deepEqual(decodeSearchSemanticCursor(token), payload);
});

test('semantic decode rejects a body without the sem1. prefix', () => {
  // A well-formed base64url(JSON) body but no prefix — exactly a lexical cursor.
  const bodyOnly = Buffer.from(JSON.stringify({ snap: 'x', off: 0 }), 'utf8').toString('base64url');
  assert.equal(decodeSearchSemanticCursor(bodyOnly), null);
  assert.equal(decodeSearchSemanticCursor('sem2.' + bodyOnly), null, 'a different prefix is rejected');
});

test('semantic decode returns null for a malformed body and non-string input', () => {
  assert.equal(decodeSearchSemanticCursor('sem1.not-base64-json'), null);
  assert.equal(decodeSearchSemanticCursor('sem1.'), null, 'prefix with empty body');
  assert.equal(decodeSearchSemanticCursor(''), null);
  // Non-string inputs must be tolerated (the decoder guards typeof).
  assert.equal(decodeSearchSemanticCursor(null), null);
  assert.equal(decodeSearchSemanticCursor(undefined), null);
});

test('semantic decode returns null when the JSON is valid but the shape is wrong', () => {
  const enc = (obj) => 'sem1.' + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  assert.equal(decodeSearchSemanticCursor(enc({ snap: 'x' })), null, 'off missing');
  assert.equal(decodeSearchSemanticCursor(enc({ off: 3 })), null, 'snap missing');
  assert.equal(decodeSearchSemanticCursor(enc({ snap: 5, off: 3 })), null, 'snap wrong type');
  assert.equal(decodeSearchSemanticCursor(enc({ snap: 'x', off: '3' })), null, 'off wrong type');
});

test('semantic decode strips extra fields to the canonical snap/off pair', () => {
  const token = 'sem1.' + Buffer.from(JSON.stringify({ snap: 's', off: 4, extra: 1 }), 'utf8').toString('base64url');
  const decoded = decodeSearchSemanticCursor(token);
  assert.deepEqual(decoded, { snap: 's', off: 4 });
});

test('a lexical cursor does NOT decode as a valid semantic cursor', () => {
  // Realizes "cursor from /v1/search passed to /v1/search/semantic →
  // invalid_cursor": the lexical cursor has no sem1. prefix.
  const lexical = encodeSearchLexicalCursor({ snap: 'snap_lex', off: 5 });
  assert.doesNotMatch(lexical, /^sem1\./, 'lexical cursors have no sem1. prefix');
  assert.equal(decodeSearchSemanticCursor(lexical), null);
});

test('a semantic cursor does NOT decode as a valid lexical cursor', () => {
  // The reverse direction: the sem1. prefix makes the base64url body undecodable
  // as bare lexical JSON, so the lexical decoder rejects it.
  const semantic = encodeSearchSemanticCursor({ snap: 'snap_sem', off: 9 });
  assert.equal(decodeSearchLexicalCursor(semantic), null);
});
