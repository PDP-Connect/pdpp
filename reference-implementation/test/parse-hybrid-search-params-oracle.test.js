// Pure-logic oracle for parseHybridSearchParams (server/search-hybrid.js), the
// server-side wrapper the GET /v1/search/hybrid route uses. It delegates param
// validation to parseSearchHybridParams and translates the typed
// SearchHybridRequestError into a plain Error that PRESERVES .code and .param
// so the route surfaces the same typed vocabulary. Previously untested by name.
// A mutation that dropped the .code/.param carry-over would silently degrade the
// route's error contract to a generic 500 with no failing test. No DB.

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHybridSearchParams } from '../server/search-hybrid.js';

test('parseHybridSearchParams returns normalized params for a valid query', () => {
  const params = parseHybridSearchParams({ q: 'pasta', limit: '5' });
  assert.equal(params.q, 'pasta');
  assert.equal(params.limit, 5);
  assert.equal(params.streams, null);
  assert.equal(params.filter, null);
  assert.deepEqual(params.warnings, []);
});

test('parseHybridSearchParams rethrows a plain Error carrying code + param on a missing q', () => {
  assert.throws(
    () => parseHybridSearchParams({}),
    (err) => {
      // Translated to a plain Error (not the internal typed class) but the
      // typed vocabulary is preserved.
      assert.equal(err.constructor.name, 'Error');
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'q');
      assert.ok(err.message.includes('q is required'));
      return true;
    }
  );
});

test('parseHybridSearchParams preserves code + param for cursor, unsupported-param, and alias errors', () => {
  assert.throws(
    () => parseHybridSearchParams({ q: 'x', cursor: 'abc' }),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'cursor');
      return true;
    }
  );
  assert.throws(
    () => parseHybridSearchParams({ q: 'x', bogus: 'y' }),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'bogus');
      return true;
    }
  );
  assert.throws(
    () => parseHybridSearchParams({ q: 'x', connection_id: 'a', connector_instance_id: 'b' }),
    (err) => {
      assert.equal(err.code, 'invalid_argument');
      assert.equal(err.param, 'connector_instance_id');
      return true;
    }
  );
});
