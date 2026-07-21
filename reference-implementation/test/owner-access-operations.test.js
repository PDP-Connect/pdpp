// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for the additive owner-access reference
 * contracts (OpenSpec change redesign-owner-console-product-experience,
 * tasks 10.C.1–3). Pins request validation, envelope shapes, and error →
 * status mapping without a live server. Owner-scoping and bearer redaction
 * are host-capability concerns exercised in the integration test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeAsDcrUpdate } from '../operations/as-dcr-update/index.ts';
import { executeRefClientTokenRevoke } from '../operations/ref-client-token-revoke/index.ts';
import {
  RefClientTokensListInvalidRequestError,
  executeRefClientTokensList,
} from '../operations/ref-client-tokens-list/index.ts';

// ── as.dcr.update (10.C.1) ───────────────────────────────────────────────────

test('as.dcr.update passes a valid client_name to the capability and returns 200', async () => {
  const outcome = await executeAsDcrUpdate(
    { clientId: 'cli_1', body: { client_name: ' Renamed ' }, actingSubjectId: 'owner' },
    {
      updateRegisteredClientName: (clientId, ctx) => {
        assert.equal(clientId, 'cli_1');
        // The operation forwards the raw string; the capability trims.
        assert.equal(ctx.clientName, ' Renamed ');
        assert.equal(ctx.actingSubjectId, 'owner');
        return { client_id: 'cli_1', client_name: 'Renamed', created_at: 't', updated_at: 'u' };
      },
    },
  );
  assert.equal(outcome.outcome, 'success');
  assert.equal(outcome.status, 200);
  assert.equal(outcome.client.client_name, 'Renamed');
});

test('as.dcr.update rejects empty / non-object / extra-field bodies with 400 without calling the capability', async () => {
  let called = false;
  const deps = { updateRegisteredClientName: () => { called = true; throw new Error('should not run'); } };
  for (const body of [null, [], {}, { client_name: '   ' }, { client_name: 'ok', redirect_uris: [] }]) {
    const outcome = await executeAsDcrUpdate({ clientId: 'cli_1', body, actingSubjectId: 'owner' }, deps);
    assert.equal(outcome.outcome, 'failure');
    assert.equal(outcome.status, 400);
    assert.equal(outcome.errorCode, 'invalid_client_metadata');
  }
  assert.equal(called, false, 'invalid bodies must never reach the capability');
});

test('as.dcr.update maps capability error codes to HTTP status', async () => {
  const cases = [
    ['not_found', 404],
    ['forbidden', 403],
    ['invalid_client_metadata', 400],
    ['weird', 400],
  ];
  for (const [code, status] of cases) {
    const outcome = await executeAsDcrUpdate(
      { clientId: 'cli_1', body: { client_name: 'x' }, actingSubjectId: 'owner' },
      { updateRegisteredClientName: () => { const e = new Error('nope'); e.code = code; throw e; } },
    );
    assert.equal(outcome.outcome, 'failure');
    assert.equal(outcome.status, status);
    assert.equal(outcome.errorCode, code);
  }
});

// ── ref.client.tokens.list (10.C.2) ──────────────────────────────────────────

test('ref.client.tokens.list requires owner=true and wraps the projection in a list envelope', async () => {
  await assert.rejects(
    () => executeRefClientTokensList({ owner: undefined }, { listActiveTokensForOwnerClient: () => [] }),
    RefClientTokensListInvalidRequestError,
  );
  await assert.rejects(
    () => executeRefClientTokensList({ owner: true }, { listActiveTokensForOwnerClient: () => [] }),
    RefClientTokensListInvalidRequestError,
  );

  const rows = [
    { object: 'owner_client_token', token_id_public: 'tok_aaa', token_kind: 'owner', created_at: 't', expires_at: null },
  ];
  const envelope = await executeRefClientTokensList(
    { owner: 'true' },
    { listActiveTokensForOwnerClient: () => Promise.resolve(rows) },
  );
  assert.equal(envelope.object, 'list');
  assert.deepEqual(envelope.data, rows);
  // The operation never invents a token_id; it only forwards the projection.
  for (const row of envelope.data) {
    assert.ok(!('token_id' in row));
    assert.ok(row.token_id_public.startsWith('tok_'));
  }
});

// ── ref.client.token.revoke (10.C.3) ─────────────────────────────────────────

test('ref.client.token.revoke forwards ids and returns a typed revocation envelope', async () => {
  const outcome = await executeRefClientTokenRevoke(
    { clientId: 'cli_1', tokenIdPublic: 'tok_aaa', actingSubjectId: 'owner' },
    {
      revokeOwnerClientTokenByPublicId: (clientId, tokenIdPublic, subjectId) => {
        assert.equal(clientId, 'cli_1');
        assert.equal(tokenIdPublic, 'tok_aaa');
        assert.equal(subjectId, 'owner');
        return { revoked: true, token_id_public: 'tok_aaa' };
      },
    },
  );
  assert.equal(outcome.outcome, 'success');
  assert.equal(outcome.status, 200);
  assert.deepEqual(outcome.body, {
    object: 'owner_client_token_revocation',
    revoked: true,
    token_id_public: 'tok_aaa',
  });
});

test('ref.client.token.revoke reports revoked:false for an unknown-but-owned token id (idempotent)', async () => {
  const outcome = await executeRefClientTokenRevoke(
    { clientId: 'cli_1', tokenIdPublic: 'tok_missing', actingSubjectId: 'owner' },
    { revokeOwnerClientTokenByPublicId: () => ({ revoked: false, token_id_public: 'tok_missing' }) },
  );
  assert.equal(outcome.outcome, 'success');
  assert.equal(outcome.body.revoked, false);
});

test('ref.client.token.revoke maps capability error codes to HTTP status', async () => {
  for (const [code, status] of [['not_found', 404], ['forbidden', 403], ['other', 400]]) {
    const outcome = await executeRefClientTokenRevoke(
      { clientId: 'cli_1', tokenIdPublic: 'tok_aaa', actingSubjectId: 'owner' },
      { revokeOwnerClientTokenByPublicId: () => { const e = new Error('x'); e.code = code; throw e; } },
    );
    assert.equal(outcome.outcome, 'failure');
    assert.equal(outcome.status, status);
    assert.equal(outcome.errorCode, code);
  }
});
