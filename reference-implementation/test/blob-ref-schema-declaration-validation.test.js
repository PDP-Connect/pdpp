/**
 * Unit coverage for the UNTESTED manifest-validation shaper
 * `validateBlobRefSchemaDeclaration` (`server/connector-manifest-validation.ts`).
 *
 * It enforces the blob-indirection field-schema contract: a `blob_ref` field
 * must be an object (or nullable object) whose `properties` declare
 * `blob_id:string`, `mime_type:string`, `size_bytes:integer`, `sha256:string`,
 * and whose `required` includes `blob_id`. Each violation THROWS a typed
 * `invalidConnectorManifest` (carrying the supplied `code`), scoped by stream
 * name. Returns (void) when valid.
 *
 * Pinned here:
 *   - ACCEPT: a fully-valid blob_ref (object, and nullable object union).
 *   - REJECT: not an object; no `properties`; `properties` not an object; a
 *     missing declared property; a property with the wrong `type`; `required`
 *     absent/without `blob_id`.
 *
 * Pure — the module imports only connector-key helpers (no DB). No fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateBlobRefSchemaDeclaration } from '../server/connector-manifest-validation.ts';

const CODE = 'invalid_connector_manifest';
const STREAM = { name: 'attachments' };

function validBlobRefProperties() {
  return {
    blob_id: { type: 'string' },
    mime_type: { type: 'string' },
    size_bytes: { type: 'integer' },
    sha256: { type: 'string' },
  };
}

function validBlobRefSchema(overrides = {}) {
  return { type: 'object', properties: validBlobRefProperties(), required: ['blob_id'], ...overrides };
}

function assertRejects(fieldSchema, messagePart) {
  assert.throws(
    () => validateBlobRefSchemaDeclaration(STREAM, fieldSchema, CODE),
    (err) => {
      assert.equal(err.code, CODE, `code: ${err.code}`);
      assert.ok(String(err.message).includes("Stream 'attachments'"), `stream-scoped: ${err.message}`);
      assert.ok(String(err.message).includes(messagePart), `message ${JSON.stringify(err.message)} lacks ${JSON.stringify(messagePart)}`);
      return true;
    },
  );
}

// --- accept paths -----------------------------------------------------------

test('validateBlobRefSchemaDeclaration: accepts a fully-valid blob_ref object', () => {
  assert.equal(validateBlobRefSchemaDeclaration(STREAM, validBlobRefSchema(), CODE), undefined);
});

test('validateBlobRefSchemaDeclaration: accepts a nullable object union type', () => {
  assert.equal(
    validateBlobRefSchemaDeclaration(STREAM, validBlobRefSchema({ type: ['object', 'null'] }), CODE),
    undefined,
    'a ["object","null"] type still satisfies schemaTypeIncludes(object)',
  );
});

// --- reject paths -----------------------------------------------------------

test('validateBlobRefSchemaDeclaration: rejects a non-object field schema', () => {
  assertRejects({ type: 'string' }, 'blob_ref must be an object or nullable object');
});

test('validateBlobRefSchemaDeclaration: rejects a missing or non-object properties', () => {
  assertRejects({ type: 'object' }, 'blob_ref must declare object properties');
  assertRejects({ type: 'object', properties: 'x' }, 'blob_ref must declare object properties');
  assertRejects({ type: 'object', properties: [] }, 'blob_ref must declare object properties');
});

test('validateBlobRefSchemaDeclaration: rejects a missing required property', () => {
  const props = validBlobRefProperties();
  delete props.size_bytes;
  assertRejects({ type: 'object', properties: props, required: ['blob_id'] }, 'blob_ref.size_bytes must be type integer');
});

test('validateBlobRefSchemaDeclaration: rejects a property with the wrong type', () => {
  const props = validBlobRefProperties();
  props.size_bytes = { type: 'string' }; // must be integer
  assertRejects({ type: 'object', properties: props, required: ['blob_id'] }, 'blob_ref.size_bytes must be type integer');

  const props2 = validBlobRefProperties();
  props2.blob_id = { type: 'integer' }; // must be string
  assertRejects({ type: 'object', properties: props2, required: ['blob_id'] }, 'blob_ref.blob_id must be type string');
});

test('validateBlobRefSchemaDeclaration: rejects when required does not include blob_id', () => {
  assertRejects(validBlobRefSchema({ required: [] }), 'blob_ref must require blob_id');
  assertRejects(validBlobRefSchema({ required: ['mime_type'] }), 'blob_ref must require blob_id');
  // required absent entirely (not an array) also fails the blob_id requirement.
  assertRejects(validBlobRefSchema({ required: undefined }), 'blob_ref must require blob_id');
});
