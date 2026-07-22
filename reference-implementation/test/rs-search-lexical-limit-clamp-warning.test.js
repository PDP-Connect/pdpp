// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pin the `limit_clamped` warning contract at the pure parse layer of the
// lexical search operation.
//
// `parseSearchLexicalParams` clamps `limit` to the advertised page-size cap AND
// emits a structured `limit_clamped` warning when — and only when — the raw
// limit parsed to a finite integer strictly greater than the cap. The existing
// operation test (rs-search-lexical-operation.test.js) pins the CLAMPED VALUE
// (25/100/0/7); search-limit-clamp.test.js exercises the warning through the
// full executeSearchLexical path. Neither pins the warning's structured shape
// or its exact emission boundary at the parse layer:
//
//   - the warning is emitted iff requested > MAX_LIMIT (100)
//   - exactly MAX_LIMIT is in-range → no warning
//   - a non-positive / unparseable / absent limit falls back to the default
//     page size but is NOT a clamp → no warning (nothing to honestly report)
//   - the warning carries { code: 'limit_clamped', param: 'limit',
//     detail: { requested_limit, max_limit } }
//
// A drift here changes what a client sees in `meta.warnings` across every read
// surface (REST/MCP/dashboard/CLI) that shares this identifier. Pure, DB-free,
// no grant/token surface.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSearchLexicalParams } from '../operations/rs-search-lexical/index.ts';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

function limitWarnings(query) {
  return parseSearchLexicalParams(query).warnings.filter((w) => w.code === 'limit_clamped');
}

test('an over-cap limit clamps the value and emits exactly one structured limit_clamped warning', () => {
  const parsed = parseSearchLexicalParams({ q: 'foo', limit: '500' });
  assert.equal(parsed.limit, MAX_LIMIT, 'the page is bounded to the cap');

  const warns = parsed.warnings.filter((w) => w.code === 'limit_clamped');
  assert.equal(warns.length, 1, 'exactly one limit_clamped warning');
  const w = warns[0];
  assert.equal(w.code, 'limit_clamped');
  assert.equal(w.param, 'limit');
  assert.deepEqual(w.detail, { requested_limit: 500, max_limit: MAX_LIMIT });
});

test('a limit exactly at the cap is in-range: clamps to the cap value but emits no warning', () => {
  const parsed = parseSearchLexicalParams({ q: 'foo', limit: '100' });
  assert.equal(parsed.limit, MAX_LIMIT);
  assert.equal(limitWarnings({ q: 'foo', limit: '100' }).length, 0, 'exactly MAX_LIMIT is not a clamp');
});

test('a limit one over the cap is the first value that warns', () => {
  const warns = limitWarnings({ q: 'foo', limit: '101' });
  assert.equal(warns.length, 1);
  assert.deepEqual(warns[0].detail, { requested_limit: 101, max_limit: MAX_LIMIT });
});

test('an over-cap fractional limit reports the floored requested value', () => {
  // Number('150.9') → 150.9; the derivation floors before comparing/reporting.
  const warns = limitWarnings({ q: 'foo', limit: '150.9' });
  assert.equal(warns.length, 1);
  assert.equal(warns[0].detail.requested_limit, 150);
});

test('absent, zero, negative, and non-numeric limits fall back to default with NO warning', () => {
  // clampLimit sends each of these to DEFAULT_LIMIT; none is an honest "clamp".
  for (const query of [
    { q: 'foo' },                 // absent
    { q: 'foo', limit: '0' },     // zero
    { q: 'foo', limit: '-5' },    // negative
    { q: 'foo', limit: 'abc' },   // non-numeric
    { q: 'foo', limit: '' },      // empty string
  ]) {
    const parsed = parseSearchLexicalParams(query);
    assert.equal(parsed.limit, DEFAULT_LIMIT, `${JSON.stringify(query)} → default page size`);
    assert.equal(
      parsed.warnings.filter((w) => w.code === 'limit_clamped').length,
      0,
      `${JSON.stringify(query)} must not emit a limit_clamped warning`,
    );
  }
});

test('an in-range explicit limit below the cap neither changes nor warns', () => {
  const parsed = parseSearchLexicalParams({ q: 'foo', limit: '7' });
  assert.equal(parsed.limit, 7);
  assert.equal(parsed.warnings.filter((w) => w.code === 'limit_clamped').length, 0);
});
