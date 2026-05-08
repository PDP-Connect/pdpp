/**
 * Regression: the Express-compat `res` shim in `server/transport.js` must
 * expose `header()` and `set()` as chainable aliases of `setHeader()`.
 *
 * Bug: the shim originally defined only `setHeader`. Handlers that used
 * Express idioms — `res.status(N).header('WWW-Authenticate', …).json(body)`
 * (notably the streaming-routes 401 path in `pdppError()`) — crashed with
 * `res.status(...).header is not a function`. Fastify's lifecycle then
 * converted the throw into a 500, masking the intended status.
 *
 * Fix: define `header(field, value)` (with object-form fan-out) and `set`
 * as a thin alias, both returning `this` so the call chain stays intact.
 *
 * Strategy: register tiny routes on a real `createApp()` instance, use
 * `res.status().header().json()` and `res.status().set().json()` chains,
 * and assert the response status / headers / body via `fastify.inject()`
 * (no port binding, no network).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../server/transport.js';

test('res.status(N).header(name, value).json(body) works and chains', async () => {
  const app = createApp();
  app.get('/header-chain', (_req, res) => {
    res
      .status(401)
      .header('WWW-Authenticate', 'Bearer realm="pdpp"')
      .json({ error: 'invalid_token' });
  });
  await app.fastify.ready();

  const reply = await app.fastify.inject({ method: 'GET', url: '/header-chain' });

  assert.equal(reply.statusCode, 401, 'status() must propagate to the response');
  assert.equal(
    reply.headers['www-authenticate'],
    'Bearer realm="pdpp"',
    'header() must set the response header',
  );
  assert.deepEqual(JSON.parse(reply.body), { error: 'invalid_token' });
});

test('res.status(N).set(name, value).json(body) works and chains', async () => {
  const app = createApp();
  app.get('/set-chain', (_req, res) => {
    res
      .status(403)
      .set('X-Forbid-Reason', 'no_grant')
      .json({ error: 'forbidden' });
  });
  await app.fastify.ready();

  const reply = await app.fastify.inject({ method: 'GET', url: '/set-chain' });

  assert.equal(reply.statusCode, 403);
  assert.equal(reply.headers['x-forbid-reason'], 'no_grant');
  assert.deepEqual(JSON.parse(reply.body), { error: 'forbidden' });
});

test('res.header() accepts object form and sets all keys', async () => {
  const app = createApp();
  app.get('/header-object', (_req, res) => {
    res
      .status(200)
      .header({
        'X-One': '1',
        'X-Two': '2',
      })
      .json({ ok: true });
  });
  await app.fastify.ready();

  const reply = await app.fastify.inject({ method: 'GET', url: '/header-object' });

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.headers['x-one'], '1');
  assert.equal(reply.headers['x-two'], '2');
});
