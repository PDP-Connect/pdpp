// Unit tests for the reference-revision header helpers
// (server/reference-revision.ts) — the DETERMINISTIC surface only.
//
// `resolveReferenceRevision` has a pure early-return: when an explicit
// `referenceRevision` is supplied it is normalized (trimmed, non-printable
// characters stripped, whitespace runs collapsed to '-') and returned before
// any git/package/env lookup. These tests exercise ONLY that explicit-input
// path (env-independent) plus the trivial header setter; the git/env fallback
// is non-deterministic and out of scope.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  PDPP_REFERENCE_REVISION_HEADER,
  resolveReferenceRevision,
  setReferenceRevisionHeader,
} from '../server/reference-revision.ts';

test('resolveReferenceRevision returns an explicit revision trimmed', () => {
  assert.equal(resolveReferenceRevision({ referenceRevision: '  v1.2.3  ' }), 'v1.2.3');
});

test('resolveReferenceRevision collapses whitespace runs to a single dash', () => {
  assert.equal(resolveReferenceRevision({ referenceRevision: 'a b\tc' }), 'a-b-c');
  assert.equal(resolveReferenceRevision({ referenceRevision: 'x   y' }), 'x-y');
});

test('resolveReferenceRevision strips non-printable and non-ASCII characters', () => {
  // A control char (\x01) is stripped, leaving the printable neighbors joined.
  assert.equal(resolveReferenceRevision({ referenceRevision: 'a\x01b' }), 'ab');
  // A DEL char (\x7f, above the \x7e printable ceiling) is also stripped.
  assert.equal(resolveReferenceRevision({ referenceRevision: 'a\x7fb' }), 'ab');
});

test('resolveReferenceRevision preserves the printable ASCII range', () => {
  assert.equal(resolveReferenceRevision({ referenceRevision: 'pdpp@1.0.0+abcdef' }), 'pdpp@1.0.0+abcdef');
});

test('PDPP_REFERENCE_REVISION_HEADER is the canonical header name', () => {
  assert.equal(PDPP_REFERENCE_REVISION_HEADER, 'PDPP-Reference-Revision');
});

test('setReferenceRevisionHeader writes the value under the canonical header', () => {
  const calls = [];
  const res = { setHeader: (name, value) => calls.push([name, value]) };
  setReferenceRevisionHeader(res, 'pdpp-reference@1.0.0+abc123');
  assert.deepEqual(calls, [[PDPP_REFERENCE_REVISION_HEADER, 'pdpp-reference@1.0.0+abc123']]);
});
