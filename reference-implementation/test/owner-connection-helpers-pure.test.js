// Pure, no-DB unit tests for the shared owner-connection route helpers in
// server/routes/_owner-connection-helpers.ts. No test imports this module by name.
// These are the audit/label/error-mapping helpers shared by every owner-connection
// mutation adapter (run/revoke/delete/reactivate/schedule), so a regression here
// mis-labels audit events or mis-maps error statuses across the whole family.
//
// Mutation surface:
//   auditActorKind -- token-kind -> actor-label decision table (owner->owner_agent,
//     client/mcp_package passthrough, everything else -> unknown).
//   readConnectionTarget -- selector routes to connectionId (decoded) vs canonical
//     connectorKey (decoded then canonicalized); URL-decoding of path params.
//   httpStatusForOperationError -- code -> HTTP status via codeToStatus, unknown/
//     missing code -> 500.
//   rethrowAsAmbiguousConnection -- ONLY 'ambiguous_connector_instance' is mapped to
//     the public AmbiguousConnectionError; any other error is rethrown unchanged.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditActorKind,
  httpStatusForOperationError,
  readConnectionTarget,
  rethrowAsAmbiguousConnection,
} from '../server/routes/_owner-connection-helpers.ts';

// ---------------------------------------------------------------------------
// auditActorKind
// ---------------------------------------------------------------------------

test('auditActorKind: owner token -> owner_agent', () => {
  assert.equal(auditActorKind({ tokenInfo: { pdpp_token_kind: 'owner' } }), 'owner_agent');
});

test('auditActorKind: client and mcp_package pass through as-is', () => {
  assert.equal(auditActorKind({ tokenInfo: { pdpp_token_kind: 'client' } }), 'client');
  assert.equal(auditActorKind({ tokenInfo: { pdpp_token_kind: 'mcp_package' } }), 'mcp_package');
});

test('auditActorKind: unknown / absent token kind -> unknown', () => {
  assert.equal(auditActorKind({ tokenInfo: { pdpp_token_kind: 'something_else' } }), 'unknown');
  assert.equal(auditActorKind({ tokenInfo: {} }), 'unknown');
  assert.equal(auditActorKind({}), 'unknown');
});

// ---------------------------------------------------------------------------
// readConnectionTarget
// ---------------------------------------------------------------------------

const idCtx = { canonicalConnectorKey: (v) => (v === 'gmail-url' ? 'gmail' : null) };

test('readConnectionTarget: connection_id selector decodes the path param, connectorKey null', () => {
  const out = readConnectionTarget(idCtx, { params: { connectionId: 'cin%2F123' } }, 'connection_id');
  assert.deepEqual(out, { connectionId: 'cin/123', connectorKey: null }, 'URL-decoded connectionId');
});

test('readConnectionTarget: connector_id selector canonicalizes the decoded key, connectionId null', () => {
  const out = readConnectionTarget(idCtx, { params: { connectorId: 'gmail-url' } }, 'connector_id');
  assert.deepEqual(out, { connectionId: null, connectorKey: 'gmail' }, 'canonicalized connector key');
});

test('readConnectionTarget: connector_id falls back to the raw value when canonicalization returns null', () => {
  const out = readConnectionTarget(idCtx, { params: { connectorId: 'unknown-conn' } }, 'connector_id');
  assert.equal(out.connectorKey, 'unknown-conn', 'raw key retained when not canonicalizable');
});

test('readConnectionTarget: absent path param yields null on the selected side', () => {
  assert.deepEqual(readConnectionTarget(idCtx, { params: {} }, 'connection_id'), { connectionId: null, connectorKey: null });
  assert.deepEqual(readConnectionTarget(idCtx, { params: {} }, 'connector_id'), { connectionId: null, connectorKey: null });
});

// ---------------------------------------------------------------------------
// httpStatusForOperationError
// ---------------------------------------------------------------------------

test('httpStatusForOperationError: maps known codes via codeToStatus', () => {
  assert.equal(httpStatusForOperationError({ code: 'not_found' }), 404);
  assert.equal(httpStatusForOperationError({ code: 'invalid_request' }), 400);
  assert.equal(httpStatusForOperationError({ code: 'ambiguous_connection' }), 409);
});

test('httpStatusForOperationError: unknown or missing code defaults to 500', () => {
  assert.equal(httpStatusForOperationError({ code: 'totally_made_up_code' }), 500);
  assert.equal(httpStatusForOperationError({}), 500);
  assert.equal(httpStatusForOperationError(null), 500);
  assert.equal(httpStatusForOperationError(new Error('no code')), 500);
});

// ---------------------------------------------------------------------------
// rethrowAsAmbiguousConnection
// ---------------------------------------------------------------------------

class FakeAmbiguousConnectionError extends Error {
  constructor(message, availableConnections) {
    super(message);
    this.code = 'ambiguous_connection';
    this.availableConnections = availableConnections;
  }
}

function ambiguousCtx() {
  return {
    AmbiguousConnectionError: FakeAmbiguousConnectionError,
    listActiveBindingsForGrant: async () => [
      { connectorInstanceId: 'ci-1', displayName: 'Personal' },
      { connectorInstanceId: 'ci-2', displayName: 'Work' },
    ],
    projectBindingForWire: (b) => ({ connection_id: b.connectorInstanceId, display_name: b.displayName }),
  };
}

test('rethrowAsAmbiguousConnection: maps ambiguous_connector_instance to the public AmbiguousConnectionError with the binding list', async () => {
  await assert.rejects(
    () => rethrowAsAmbiguousConnection(ambiguousCtx(), { code: 'ambiguous_connector_instance' }, 'owner-1', 'gmail'),
    (err) => {
      assert.ok(err instanceof FakeAmbiguousConnectionError, 'mapped to AmbiguousConnectionError');
      assert.equal(err.code, 'ambiguous_connection');
      assert.deepEqual(err.availableConnections, [
        { connection_id: 'ci-1', display_name: 'Personal' },
        { connection_id: 'ci-2', display_name: 'Work' },
      ], 'projected wire connections carried on the error');
      return true;
    },
  );
});

test('rethrowAsAmbiguousConnection: any OTHER error code is rethrown unchanged (not mapped)', async () => {
  const original = { code: 'connection_not_found', message: 'nope' };
  await assert.rejects(
    () => rethrowAsAmbiguousConnection(ambiguousCtx(), original, 'owner-1', 'gmail'),
    (err) => {
      assert.equal(err, original, 'the exact original error is rethrown');
      assert.ok(!(err instanceof FakeAmbiguousConnectionError), 'NOT wrapped as ambiguous');
      return true;
    },
  );
});

test('rethrowAsAmbiguousConnection: filters out bindings that project to null', async () => {
  const ctx = ambiguousCtx();
  ctx.projectBindingForWire = (b) => (b.connectorInstanceId === 'ci-2' ? null : { connection_id: b.connectorInstanceId });
  await assert.rejects(
    () => rethrowAsAmbiguousConnection(ctx, { code: 'ambiguous_connector_instance' }, 'owner-1', 'gmail'),
    (err) => {
      assert.deepEqual(err.availableConnections, [{ connection_id: 'ci-1' }], 'null projections dropped');
      return true;
    },
  );
});
