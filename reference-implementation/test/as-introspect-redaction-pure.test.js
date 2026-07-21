// Pure, no-DB unit tests for the RFC 7662 introspection operation in
// operations/as-introspect/index.ts. No test imports it by name. It validates
// token presence and REDACTS the AS-internal `grant_storage_binding` field from
// the public introspection response — a security-critical redaction that must
// never leak the internal storage binding to introspection callers.
//
// The introspect capability is stubbed so we can assert the operation's own
// validation + redaction logic without a token store.
//
// RED note: this is auth-surface. The tests only OBSERVE the outcome + redaction;
// no token/grant state is created or modified.
//
// Mutation surface:
//   - missing/empty token -> failure/400/invalid_request/"Missing token parameter".
//   - success -> introspect(token) called, grant_storage_binding stripped, all
//     other fields (active, scope, etc.) preserved.

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeAsIntrospect } from '../operations/as-introspect/index.ts';

test('executeAsIntrospect: a missing token is a 400 invalid_request failure', async () => {
  for (const token of [null, undefined, '']) {
    const out = await executeAsIntrospect({ token }, { introspect: () => ({ active: true }) });
    assert.equal(out.outcome, 'failure');
    assert.equal(out.status, 400);
    assert.equal(out.errorCode, 'invalid_request');
    assert.equal(out.errorMessage, 'Missing token parameter');
  }
});

test('executeAsIntrospect: a present token calls introspect and returns a success outcome', async () => {
  let receivedToken = null;
  const out = await executeAsIntrospect(
    { token: 'tok_abc' },
    {
      introspect: (t) => {
        receivedToken = t;
        return { active: true, scope: 'read' };
      },
    },
  );
  assert.equal(receivedToken, 'tok_abc', 'the token is forwarded to introspect');
  assert.equal(out.outcome, 'success');
  assert.equal(out.publicInfo.active, true);
  assert.equal(out.publicInfo.scope, 'read', 'non-sensitive fields preserved');
});

test('executeAsIntrospect: REDACTS grant_storage_binding from the public response', async () => {
  const out = await executeAsIntrospect(
    { token: 'tok_abc' },
    {
      introspect: () => ({
        active: true,
        client_id: 'cli',
        grant_storage_binding: { connector_id: 'gmail', connector_instance_id: 'ci-1' },
      }),
    },
  );
  assert.equal(out.outcome, 'success');
  assert.ok(!('grant_storage_binding' in out.publicInfo), 'AS-internal grant_storage_binding must not leak');
  assert.equal(out.publicInfo.active, true, 'other fields survive the redaction');
  assert.equal(out.publicInfo.client_id, 'cli');
});

test('executeAsIntrospect: an inactive-token response is passed through (minus the redacted field)', async () => {
  const out = await executeAsIntrospect(
    { token: 'tok_x' },
    { introspect: () => ({ active: false, grant_storage_binding: { connector_id: 'x' } }) },
  );
  assert.equal(out.publicInfo.active, false, 'active:false preserved');
  assert.ok(!('grant_storage_binding' in out.publicInfo), 'redaction applies even to inactive tokens');
});
