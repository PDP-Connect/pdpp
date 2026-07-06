/**
 * Unit coverage for the UNTESTED CLI request/response read-model shapers:
 *   - appendQuery (`cli/lib/common.js`): builds a URL with query params, SKIPPING
 *     undefined/null/empty-string values and coercing the rest to strings
 *     (overwriting an existing same-named param).
 *   - extractReferenceQueryMetadata (`cli/lib/fetch.js`): reads the reference
 *     `Request-Id` / `PDPP-Reference-Trace-Id` response headers into
 *     `{request_id, reference_trace_id}` (null when absent).
 *   - attachReferenceQueryMetadata (`cli/lib/fetch.js`): merges those into a
 *     plain-object response body (only the keys that are present); leaves
 *     non-object bodies (null / array) untouched.
 *
 * Pure — a tiny header duck-type shim stands in for a Fetch Headers object. No
 * DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { appendQuery } from '../cli/lib/common.js';
import { attachReferenceQueryMetadata, extractReferenceQueryMetadata } from '../cli/lib/fetch.js';

// Header shim: .get(name) returns the mapped value or null (Fetch semantics).
function headers(map = {}) {
  return { get: (name) => (name in map ? map[name] : null) };
}

// --- appendQuery ------------------------------------------------------------

test('appendQuery: appends provided params and coerces values to strings', () => {
  assert.equal(appendQuery('https://rs.example.com/p', { a: '1', b: 2 }), 'https://rs.example.com/p?a=1&b=2');
});

test('appendQuery: skips undefined, null, and empty-string values', () => {
  assert.equal(
    appendQuery('https://rs.example.com/p', { a: '', b: null, c: undefined, d: 'keep' }),
    'https://rs.example.com/p?d=keep',
    'only non-empty values are set',
  );
});

test('appendQuery: overwrites an existing same-named query param', () => {
  assert.equal(appendQuery('https://rs.example.com/p?a=old', { a: 'new' }), 'https://rs.example.com/p?a=new');
});

test('appendQuery: an empty params object leaves the URL unchanged', () => {
  assert.equal(appendQuery('https://rs.example.com/p?x=1', {}), 'https://rs.example.com/p?x=1');
});

// --- extractReferenceQueryMetadata ------------------------------------------

test('extractReferenceQueryMetadata: reads both reference headers', () => {
  assert.deepEqual(
    extractReferenceQueryMetadata(headers({ 'Request-Id': 'req_1', 'PDPP-Reference-Trace-Id': 'trace_1' })),
    { request_id: 'req_1', reference_trace_id: 'trace_1' },
  );
});

test('extractReferenceQueryMetadata: absent headers => null fields', () => {
  assert.deepEqual(extractReferenceQueryMetadata(headers({})), { request_id: null, reference_trace_id: null });
  assert.deepEqual(extractReferenceQueryMetadata(null), { request_id: null, reference_trace_id: null }, 'null headers safe');
});

// --- attachReferenceQueryMetadata -------------------------------------------

test('attachReferenceQueryMetadata: merges present reference metadata into a plain-object body', () => {
  assert.deepEqual(
    attachReferenceQueryMetadata({ object: 'list' }, headers({ 'Request-Id': 'req_1', 'PDPP-Reference-Trace-Id': 'trace_1' })),
    { object: 'list', request_id: 'req_1', reference_trace_id: 'trace_1' },
  );
});

test('attachReferenceQueryMetadata: attaches only the metadata keys that are present', () => {
  assert.deepEqual(
    attachReferenceQueryMetadata({ object: 'list' }, headers({ 'Request-Id': 'req_only' })),
    { object: 'list', request_id: 'req_only' },
    'reference_trace_id omitted when its header is absent',
  );
});

test('attachReferenceQueryMetadata: with only the trace header, request_id is OMITTED (no undefined key)', () => {
  // Only the trace header is present, so the "nothing to attach" early return is
  // skipped, but request_id must NOT be added as an undefined-valued key.
  const out = attachReferenceQueryMetadata({ object: 'list' }, headers({ 'PDPP-Reference-Trace-Id': 'trace_only' }));
  assert.deepEqual(out, { object: 'list', reference_trace_id: 'trace_only' }, `out: ${JSON.stringify(out)}`);
  assert.equal('request_id' in out, false, 'request_id key must be absent, not undefined');
});

test('attachReferenceQueryMetadata: returns the body unchanged when no reference metadata is present', () => {
  const body = { object: 'list' };
  assert.equal(attachReferenceQueryMetadata(body, headers({})), body, 'same reference back when nothing to attach');
});

test('attachReferenceQueryMetadata: leaves non-object bodies untouched', () => {
  assert.equal(attachReferenceQueryMetadata(null, headers({ 'Request-Id': 'r' })), null, 'null passthrough');
  const arr = [1, 2, 3];
  assert.equal(attachReferenceQueryMetadata(arr, headers({ 'Request-Id': 'r' })), arr, 'array passthrough (same ref)');
});
