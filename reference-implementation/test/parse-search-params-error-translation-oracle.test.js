// Pure-logic oracle for the ERROR-TRANSLATION contract of parseSearchParams
// (server/search.js), the /v1/search wrapper. It delegates to
// parseSearchLexicalParams and translates the internal typed
// SearchLexicalRequestError into a plain Error that PRESERVES .code and .param
// so the route surfaces the same typed vocabulary. lexical-retrieval.test.js
// asserts the error MESSAGES but not the .code/.param carry-over — the property
// this oracle pins. A mutation dropping the carry-over would degrade a typed
// 4xx to a generic 500 with no failing test. No DB.

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSearchParams } from '../server/search.js';

test('parseSearchParams returns normalized params for a valid query', () => {
  const params = parseSearchParams({ q: 'pasta', limit: '5' });
  assert.equal(params.q, 'pasta');
  assert.equal(params.limit, 5);
  assert.equal(params.cursor, null);
  assert.equal(params.streams, null);
  assert.equal(params.filter, null);
  assert.deepEqual(params.warnings, []);
});

test('parseSearchParams rethrows a plain Error carrying code + param on a missing q', () => {
  assert.throws(
    () => parseSearchParams({}),
    (err) => {
      assert.equal(err.constructor.name, 'Error'); // plain Error, not the internal typed class
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'q');
      assert.ok(err.message.includes('q is required'));
      return true;
    }
  );
});

test('parseSearchParams preserves code + param for unsupported-param and connection-alias errors', () => {
  assert.throws(
    () => parseSearchParams({ q: 'x', bogus: 'y' }),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'bogus');
      return true;
    }
  );
  assert.throws(
    () => parseSearchParams({ q: 'x', connection_id: 'a', connector_instance_id: 'b' }),
    (err) => {
      assert.equal(err.code, 'invalid_argument');
      assert.equal(err.param, 'connector_instance_id');
      return true;
    }
  );
});
