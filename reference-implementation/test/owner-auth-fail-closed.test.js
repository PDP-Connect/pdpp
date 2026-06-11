/**
 * requireOwnerSession fail-closed behavior (security audit S-1, lane A1).
 *
 * Before the fix, `requireOwnerSession` did `if (!enabled) next()` — an unset
 * PDPP_OWNER_PASSWORD silently opened every protected owner route. Now the
 * disabled-auth branch only falls through when the host says so
 * (`allowUnauthenticatedWhenDisabled`); otherwise it fails closed (401 JSON /
 * login redirect). These tests drive the middleware directly with a tiny
 * request/response shim — the same fabrication style the module documents.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createOwnerAuthPlaceholder } from '../server/owner-auth.ts';

function makeReqRes({ accept } = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    redirectedTo: null,
    _sent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    json(body) {
      this.body = body;
      this._sent = true;
      return this;
    },
    send(body) {
      this.body = body;
      this._sent = true;
      return this;
    },
    redirect(url) {
      this.redirectedTo = url;
      this._sent = true;
    },
    end() {
      this._sent = true;
    },
  };
  const req = {
    method: 'GET',
    url: '/_ref/connectors',
    originalUrl: '/_ref/connectors',
    headers: accept ? { accept } : {},
  };
  return { req, res };
}

function runRequireOwnerSession(auth, opts) {
  const { req, res } = makeReqRes(opts);
  let nextCalled = false;
  auth.requireOwnerSession(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

// ── disabled + NOT allowed (hosted defense-in-depth) → fail closed ───────────
test('disabled auth + allowUnauthenticatedWhenDisabled=false → JSON caller gets 401, no next()', () => {
  const auth = createOwnerAuthPlaceholder({
    password: null,
    allowUnauthenticatedWhenDisabled: false,
  });
  assert.equal(auth.enabled, false, 'no password → auth disabled');
  const { res, nextCalled } = runRequireOwnerSession(auth, { accept: 'application/json' });
  assert.equal(nextCalled, false, 'must NOT fall through to the protected handler');
  assert.equal(res.statusCode, 401, 'unauthenticated owner route returns 401');
  assert.equal(res.body?.error?.code, 'owner_session_required');
});

test('disabled auth + allowUnauthenticatedWhenDisabled=false → HTML caller redirects to /owner/login', () => {
  const auth = createOwnerAuthPlaceholder({
    password: null,
    allowUnauthenticatedWhenDisabled: false,
  });
  const { res, nextCalled } = runRequireOwnerSession(auth, { accept: 'text/html' });
  assert.equal(nextCalled, false);
  assert.ok(res.redirectedTo?.startsWith('/owner/login?return_to='), 'browser redirected to login');
});

// ── disabled + allowed (local-dev / override) → open fall-through preserved ──
test('disabled auth + allowUnauthenticatedWhenDisabled=true → falls through (local-dev convenience)', () => {
  const auth = createOwnerAuthPlaceholder({
    password: null,
    allowUnauthenticatedWhenDisabled: true,
  });
  const { res, nextCalled } = runRequireOwnerSession(auth, { accept: 'application/json' });
  assert.equal(nextCalled, true, 'local-dev open behavior preserved');
  assert.equal(res._sent, false, 'no response written when falling through');
});

test('default (no posture supplied) preserves the historical open fall-through', () => {
  // buildAsApp defaults the flag to true when no posture is supplied, so
  // low-level fixtures that construct the placeholder directly stay open.
  const auth = createOwnerAuthPlaceholder({ password: null });
  const { nextCalled } = runRequireOwnerSession(auth, { accept: 'application/json' });
  assert.equal(nextCalled, true);
});

// ── enabled (password set) → always requires a session regardless of flag ────
test('enabled auth + no session → 401 even when allowUnauthenticatedWhenDisabled=true', () => {
  const auth = createOwnerAuthPlaceholder({
    password: 'secret',
    allowUnauthenticatedWhenDisabled: true,
  });
  assert.equal(auth.enabled, true);
  const { res, nextCalled } = runRequireOwnerSession(auth, { accept: 'application/json' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body?.error?.code, 'owner_session_required');
});
