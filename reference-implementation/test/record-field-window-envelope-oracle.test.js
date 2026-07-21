// Pure-math oracle for buildWindowEnvelope (server/record-field-window.js).
//
// buildWindowEnvelope computes the paging math that EVERY read_record_field /
// GET /v1/streams/{stream}/records/{record_id}/field-window response carries:
// start/end clamping to total_chars, the two-condition `complete`, `has_more`,
// and the next/previous_offset_chars paging cursors. The DB-backed conformance
// test (record-field-window-substrate.test.js) exercises this only through the
// storage path and never asserts the pure math at its boundaries.
//
// This is a no-DB oracle: buildWindowEnvelope is pure and imports without a
// Postgres connection. It pins the genuinely-unpinned boundaries — the
// previous_offset_chars mid-clamp (0 < start < limit => 0, not negative, not
// null), the two-condition `complete` (start===0 AND end>=total), and the
// start/end clamps to total_chars.
//
// Spec: openspec/changes/add-mcp-content-ladder/specs/mcp-adapter/spec.md

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWindowEnvelope } from '../server/record-field-window.js';

test('previous_offset_chars mid-clamps to 0 when 0 < start < limit (not negative, not null)', () => {
  const env = buildWindowEnvelope({ text: 'abcde', totalChars: 100, offset: 3, limit: 10 });
  assert.deepEqual(env, {
    text: 'abcde',
    total_chars: 100,
    start_chars: 3,
    end_chars: 8,
    limit_chars: 10,
    complete: false,
    has_more: true,
    match_start_chars: null,
    match_end_chars: null,
    next_offset_chars: 8,
    previous_offset_chars: 0,
  });
});

test('mid-field window with room on both sides: prev=20, next=80, has_more, not complete', () => {
  const text = 'x'.repeat(30);
  const env = buildWindowEnvelope({ text, totalChars: 100, offset: 50, limit: 30 });
  assert.deepEqual(env, {
    text,
    total_chars: 100,
    start_chars: 50,
    end_chars: 80,
    limit_chars: 30,
    complete: false,
    has_more: true,
    match_start_chars: null,
    match_end_chars: null,
    next_offset_chars: 80,
    previous_offset_chars: 20,
  });
});

test('window starting at 0 and reaching the end is complete, has no more, and has null cursors', () => {
  const text = 'y'.repeat(100);
  const env = buildWindowEnvelope({ text, totalChars: 100, offset: 0, limit: 100 });
  assert.deepEqual(env, {
    text,
    total_chars: 100,
    start_chars: 0,
    end_chars: 100,
    limit_chars: 100,
    complete: true,
    has_more: false,
    match_start_chars: null,
    match_end_chars: null,
    next_offset_chars: null,
    previous_offset_chars: null,
  });
});

test('mid-field window reaching the end is NOT complete even though has_more is false', () => {
  const text = 'z'.repeat(90);
  const env = buildWindowEnvelope({ text, totalChars: 100, offset: 10, limit: 200 });
  assert.deepEqual(env, {
    text,
    total_chars: 100,
    start_chars: 10,
    end_chars: 100,
    limit_chars: 200,
    complete: false,
    has_more: false,
    match_start_chars: null,
    match_end_chars: null,
    next_offset_chars: null,
    previous_offset_chars: 0,
  });
});

test('end_chars clamps to total_chars when offset + text overshoots', () => {
  const text = 'q'.repeat(30);
  const env = buildWindowEnvelope({ text, totalChars: 100, offset: 90, limit: 30 });
  assert.deepEqual(env, {
    text,
    total_chars: 100,
    start_chars: 90,
    end_chars: 100,
    limit_chars: 30,
    complete: false,
    has_more: false,
    match_start_chars: null,
    match_end_chars: null,
    next_offset_chars: null,
    previous_offset_chars: 60,
  });
});

test('start_chars and end_chars clamp to total_chars when offset > total_chars', () => {
  const env = buildWindowEnvelope({ text: 'anything', totalChars: 100, offset: 200, limit: 30 });
  assert.deepEqual(env, {
    text: 'anything',
    total_chars: 100,
    start_chars: 100,
    end_chars: 100,
    limit_chars: 30,
    complete: false,
    has_more: false,
    match_start_chars: null,
    match_end_chars: null,
    next_offset_chars: null,
    previous_offset_chars: 70,
  });
});

test('match coords default to null and echo through when supplied', () => {
  const noMatch = buildWindowEnvelope({ text: 'abc', totalChars: 100, offset: 0, limit: 10 });
  assert.deepEqual(noMatch, {
    text: 'abc',
    total_chars: 100,
    start_chars: 0,
    end_chars: 3,
    limit_chars: 10,
    complete: false,
    has_more: true,
    match_start_chars: null,
    match_end_chars: null,
    next_offset_chars: 3,
    previous_offset_chars: null,
  });

  const withMatch = buildWindowEnvelope({
    text: 'abc',
    totalChars: 100,
    offset: 0,
    limit: 10,
    matchStartChars: 4,
    matchEndChars: 7,
  });
  assert.deepEqual(withMatch, {
    text: 'abc',
    total_chars: 100,
    start_chars: 0,
    end_chars: 3,
    limit_chars: 10,
    complete: false,
    has_more: true,
    match_start_chars: 4,
    match_end_chars: 7,
    next_offset_chars: 3,
    previous_offset_chars: null,
  });
});

test('full envelope shape is pinned (all documented fields present)', () => {
  const env = buildWindowEnvelope({ text: 'hello', totalChars: 20, offset: 5, limit: 5 });
  assert.deepEqual(env, {
    text: 'hello',
    total_chars: 20,
    start_chars: 5,
    end_chars: 10,
    limit_chars: 5,
    complete: false,
    has_more: true,
    match_start_chars: null,
    match_end_chars: null,
    next_offset_chars: 10,
    previous_offset_chars: 0,
  });
});
