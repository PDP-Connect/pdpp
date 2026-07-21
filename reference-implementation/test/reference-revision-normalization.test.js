// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit tests for the reference-revision header helpers in
 * `server/reference-revision.ts`.
 *
 * `provider-metadata.test.js` only imports the header-NAME constant. The
 * value-resolution path — explicit-override precedence and the header-safety
 * NORMALIZATION (strip control/non-ASCII bytes, collapse whitespace to `-`) —
 * has no by-name coverage. This file pins the explicit-override branch and
 * the setter without invoking the git/package fallback.
 *
 * The normalization is header-injection defense: a mutant that drops the
 * control-character strip or the whitespace-collapse would let a raw newline
 * or space into an HTTP header value, and turns red here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PDPP_REFERENCE_REVISION_HEADER,
  resolveReferenceRevision,
  setReferenceRevisionHeader,
} from '../server/reference-revision.ts';

test('resolveReferenceRevision: an explicit override is trimmed and returned verbatim when clean', () => {
  assert.equal(resolveReferenceRevision({ referenceRevision: 'build-123' }), 'build-123');
  // Surrounding whitespace is trimmed.
  assert.equal(resolveReferenceRevision({ referenceRevision: '  build-123  ' }), 'build-123');
});

test('resolveReferenceRevision: normalization strips control/non-ASCII bytes and collapses whitespace to dashes', () => {
  // Interior whitespace (spaces/tabs) collapses to single dashes.
  assert.equal(resolveReferenceRevision({ referenceRevision: 'my build\t123' }), 'my-build-123');
  // A control character (newline) inside the value is removed, then the
  // surrounding whitespace collapses — no raw newline can reach the header.
  const withNewline = resolveReferenceRevision({ referenceRevision: 'a\nb' });
  assert.ok(!/[\n\r]/.test(withNewline), `header value must not contain a newline: ${JSON.stringify(withNewline)}`);
  // Non-ASCII bytes are stripped entirely.
  assert.equal(resolveReferenceRevision({ referenceRevision: 'revéé' }), 'rev');
});

test('resolveReferenceRevision: a control-only override normalizes to empty and falls through to the derived revision', () => {
  // These bytes survive the OUTER `.trim()` (trim only strips whitespace) so
  // the explicit branch is entered, but `normalizeHeaderValue` strips them to
  // empty — so the `if (normalized)` guard MUST reject them and fall through to
  // the derived `pdpp-reference@<version>+<git>` value. (A mutant that returns
  // the empty override here is caught by the startsWith check.)
  const derived = resolveReferenceRevision({ referenceRevision: '\x01\x02\x7f' });
  assert.ok(
    derived.startsWith('pdpp-reference@'),
    `expected derived revision when the override normalizes to empty, got ${JSON.stringify(derived)}`,
  );
});

test('setReferenceRevisionHeader: sets the canonical header name to the given value', () => {
  const headers = {};
  const fakeRes = {
    setHeader(name, value) {
      headers[name] = value;
    },
  };
  setReferenceRevisionHeader(fakeRes, 'build-xyz');
  assert.equal(headers[PDPP_REFERENCE_REVISION_HEADER], 'build-xyz');
  assert.equal(PDPP_REFERENCE_REVISION_HEADER, 'PDPP-Reference-Revision');
});
