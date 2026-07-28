// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import assert from "node:assert/strict";
import test from "node:test";
import { buildWindowEnvelope as buildWindowEnvelopeUntyped } from "../server/record-field-window.ts";

// buildWindowEnvelope is imported from checkJs:false JS, so TS infers its
// parameter/return shape only from what it can see in the destructuring
// defaults, which omits matchStartChars/matchEndChars (both optional,
// source-verified params of the real function). This wrapper restates the
// full contract (params and return shape) verified against the source body.
interface WindowEnvelopeInput {
  limit: number;
  matchEndChars?: number | null;
  matchStartChars?: number | null;
  offset: number;
  text: string;
  totalChars: number;
}

interface WindowEnvelope {
  complete: boolean;
  end_chars: number;
  has_more: boolean;
  limit_chars: number;
  match_end_chars: number | null;
  match_start_chars: number | null;
  next_offset_chars: number | null;
  previous_offset_chars: number | null;
  start_chars: number;
  text: string;
  total_chars: number;
}

function buildWindowEnvelope(input: WindowEnvelopeInput): WindowEnvelope {
  return buildWindowEnvelopeUntyped(input);
}

test("previous_offset_chars mid-clamps to 0 when 0 < start < limit (not negative, not null)", () => {
  const env = buildWindowEnvelope({ limit: 10, offset: 3, text: "abcde", totalChars: 100 });
  assert.deepEqual(env, {
    complete: false,
    end_chars: 8,
    has_more: true,
    limit_chars: 10,
    match_end_chars: null,
    match_start_chars: null,
    next_offset_chars: 8,
    previous_offset_chars: 0,
    start_chars: 3,
    text: "abcde",
    total_chars: 100,
  });
});

test("mid-field window with room on both sides: prev=20, next=80, has_more, not complete", () => {
  const text = "x".repeat(30);
  const env = buildWindowEnvelope({ limit: 30, offset: 50, text, totalChars: 100 });
  assert.deepEqual(env, {
    complete: false,
    end_chars: 80,
    has_more: true,
    limit_chars: 30,
    match_end_chars: null,
    match_start_chars: null,
    next_offset_chars: 80,
    previous_offset_chars: 20,
    start_chars: 50,
    text,
    total_chars: 100,
  });
});

test("window starting at 0 and reaching the end is complete, has no more, and has null cursors", () => {
  const text = "y".repeat(100);
  const env = buildWindowEnvelope({ limit: 100, offset: 0, text, totalChars: 100 });
  assert.deepEqual(env, {
    complete: true,
    end_chars: 100,
    has_more: false,
    limit_chars: 100,
    match_end_chars: null,
    match_start_chars: null,
    next_offset_chars: null,
    previous_offset_chars: null,
    start_chars: 0,
    text,
    total_chars: 100,
  });
});

test("mid-field window reaching the end is NOT complete even though has_more is false", () => {
  const text = "z".repeat(90);
  const env = buildWindowEnvelope({ limit: 200, offset: 10, text, totalChars: 100 });
  assert.deepEqual(env, {
    complete: false,
    end_chars: 100,
    has_more: false,
    limit_chars: 200,
    match_end_chars: null,
    match_start_chars: null,
    next_offset_chars: null,
    previous_offset_chars: 0,
    start_chars: 10,
    text,
    total_chars: 100,
  });
});

test("end_chars clamps to total_chars when offset + text overshoots", () => {
  const text = "q".repeat(30);
  const env = buildWindowEnvelope({ limit: 30, offset: 90, text, totalChars: 100 });
  assert.deepEqual(env, {
    complete: false,
    end_chars: 100,
    has_more: false,
    limit_chars: 30,
    match_end_chars: null,
    match_start_chars: null,
    next_offset_chars: null,
    previous_offset_chars: 60,
    start_chars: 90,
    text,
    total_chars: 100,
  });
});

test("start_chars and end_chars clamp to total_chars when offset > total_chars", () => {
  const env = buildWindowEnvelope({ limit: 30, offset: 200, text: "anything", totalChars: 100 });
  assert.deepEqual(env, {
    complete: false,
    end_chars: 100,
    has_more: false,
    limit_chars: 30,
    match_end_chars: null,
    match_start_chars: null,
    next_offset_chars: null,
    previous_offset_chars: 70,
    start_chars: 100,
    text: "anything",
    total_chars: 100,
  });
});

test("match coords default to null and echo through when supplied", () => {
  const noMatch = buildWindowEnvelope({ limit: 10, offset: 0, text: "abc", totalChars: 100 });
  assert.deepEqual(noMatch, {
    complete: false,
    end_chars: 3,
    has_more: true,
    limit_chars: 10,
    match_end_chars: null,
    match_start_chars: null,
    next_offset_chars: 3,
    previous_offset_chars: null,
    start_chars: 0,
    text: "abc",
    total_chars: 100,
  });

  const withMatch = buildWindowEnvelope({
    limit: 10,
    matchEndChars: 7,
    matchStartChars: 4,
    offset: 0,
    text: "abc",
    totalChars: 100,
  });
  assert.deepEqual(withMatch, {
    complete: false,
    end_chars: 3,
    has_more: true,
    limit_chars: 10,
    match_end_chars: 7,
    match_start_chars: 4,
    next_offset_chars: 3,
    previous_offset_chars: null,
    start_chars: 0,
    text: "abc",
    total_chars: 100,
  });
});

test("full envelope shape is pinned (all documented fields present)", () => {
  const env = buildWindowEnvelope({ limit: 5, offset: 5, text: "hello", totalChars: 20 });
  assert.deepEqual(env, {
    complete: false,
    end_chars: 10,
    has_more: true,
    limit_chars: 5,
    match_end_chars: null,
    match_start_chars: null,
    next_offset_chars: 10,
    previous_offset_chars: 0,
    start_chars: 5,
    text: "hello",
    total_chars: 20,
  });
});
