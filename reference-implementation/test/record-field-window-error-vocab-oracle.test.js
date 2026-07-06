// Pure-logic oracle for the field-window typed-error vocabulary and the
// fail-closed field-scope gate (server/record-field-window.js).
//
// The field-window path emits a typed FieldWindowError vocabulary the route
// surfaces verbatim and the MCP adapter forwards: each error carries .code and
// .httpStatus so authorization/validation meaning is preserved end to end. This
// oracle observes (never changes) that vocabulary and the fail-closed
// assertFieldVisibleToGrant gate — a null/undefined projection means every
// field is visible, but any non-array or not-included field fails closed with
// field_not_granted (403) BEFORE any field bytes are read.
//
// This is a no-DB oracle: these are pure functions and import without Postgres.
//
// Spec: openspec/changes/add-mcp-content-ladder/specs/mcp-adapter/spec.md

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fieldWindowError,
  FieldWindowError,
  assertFieldVisibleToGrant,
} from '../server/record-field-window.js';

function isFieldWindowError(code, httpStatus) {
  return (err) => {
    assert.ok(err instanceof FieldWindowError, 'expected a FieldWindowError');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    assert.equal(err.httpStatus, httpStatus, `expected httpStatus ${httpStatus}, got ${err.httpStatus}`);
    return true;
  };
}

test('fieldWindowError constructs a typed FieldWindowError carrying code + httpStatus', () => {
  const err = fieldWindowError('invalid_window', 'm', 400);
  assert.ok(err instanceof FieldWindowError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'FieldWindowError');
  assert.equal(err.code, 'invalid_window');
  assert.equal(err.httpStatus, 400);
  assert.equal(err.message, 'm');
});

test('assertFieldVisibleToGrant throws field_not_granted (403) for an out-of-scope field', () => {
  assert.throws(
    () => assertFieldVisibleToGrant('secret', ['public', 'other']),
    isFieldWindowError('field_not_granted', 403)
  );
});

test('assertFieldVisibleToGrant treats null/undefined projection as every-field-visible', () => {
  assert.doesNotThrow(() => assertFieldVisibleToGrant('body', null));
  assert.doesNotThrow(() => assertFieldVisibleToGrant('body', undefined));
});

test('assertFieldVisibleToGrant allows an in-scope field', () => {
  assert.doesNotThrow(() => assertFieldVisibleToGrant('body', ['body']));
});

test('assertFieldVisibleToGrant fails closed when effectiveFields is a non-array', () => {
  assert.throws(
    () => assertFieldVisibleToGrant('x', 'not-an-array'),
    isFieldWindowError('field_not_granted', 403)
  );
});
