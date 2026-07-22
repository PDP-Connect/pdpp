// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the two contract-validation.ts exports that had NO
// by-name coverage: buildResponseContractErrorBody (the 500 /
// internal_contract_error server-side envelope) and applyResponseValidation's
// non-canary short-circuit.
//
// route-contract-validation.test.js already pins the allowlist introspection
// (isRequestValidationEnforced/isResponseCanary/list*) and applyRequestValidation
// through the HTTP surface; this file deliberately does not re-cover those.
//
// Mutation surface:
//   buildResponseContractErrorBody -- MUST emit status-500-shaped envelope with
//     code 'internal_contract_error', type 'api_error' (the >=500 bucket), the
//     operation id embedded in the message, and the request id echoed. Validator
//     errors must NOT leak into the wire body.
//   applyResponseValidation -- a NON-canary operation is a pass-through
//     ({ok:true, validated:false}); it must not attempt validation.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyResponseValidation,
  buildResponseContractErrorBody,
  isResponseCanary,
} from '../server/contract-validation.ts';

// ---------------------------------------------------------------------------
// buildResponseContractErrorBody
// ---------------------------------------------------------------------------

test('buildResponseContractErrorBody: emits internal_contract_error with api_error type', () => {
  const body = buildResponseContractErrorBody({ operationId: 'getRsDiscoveryIndex', requestId: 'req_abc' });
  assert.equal(body.error.code, 'internal_contract_error');
  // status 500 maps to the api_error bucket (errorTypeForStatus default).
  assert.equal(body.error.type, 'api_error', '500 uses the api_error type, not a 4xx type');
  assert.equal(body.error.request_id, 'req_abc', 'request id echoed');
  assert.ok(body.error.message.includes('getRsDiscoveryIndex'), 'operation id embedded in message');
});

test('buildResponseContractErrorBody: does NOT leak validator internals / param into the wire body', () => {
  const body = buildResponseContractErrorBody({ operationId: 'op', requestId: 'r' });
  // param was passed null -> the envelope must omit `param` entirely.
  assert.ok(!('param' in body.error), 'null param is omitted from the envelope');
  assert.deepEqual(Object.keys(body).sort(), ['error'], 'only an error member on the body');
  // No AJV/validator error arrays are surfaced on the wire.
  assert.equal(body.error.errors, undefined);
  assert.equal(body.error.validation, undefined);
});

test('buildResponseContractErrorBody: message names the specific operation', () => {
  const a = buildResponseContractErrorBody({ operationId: 'opA', requestId: 'r1' });
  const b = buildResponseContractErrorBody({ operationId: 'opB', requestId: 'r1' });
  assert.notEqual(a.error.message, b.error.message, 'message varies by operation id');
  assert.ok(a.error.message.includes('opA'));
  assert.ok(b.error.message.includes('opB'));
});

// ---------------------------------------------------------------------------
// applyResponseValidation: non-canary short-circuit
// ---------------------------------------------------------------------------

test('applyResponseValidation: a non-canary operation is a pass-through, not validated', () => {
  // Sanity: the operation we pick is genuinely NOT a canary.
  assert.equal(isResponseCanary('someRandomNonCanaryOp'), false);
  const out = applyResponseValidation({
    operationId: 'someRandomNonCanaryOp',
    status: 200,
    payload: { anything: 'goes', shape: [1, 2, 3] }, // would violate a schema if one applied
  });
  assert.deepEqual(out, { ok: true, validated: false }, 'non-canary op is not validated and passes');
});

test('applyResponseValidation: even a clearly-malformed payload passes when the op is non-canary', () => {
  const out = applyResponseValidation({ operationId: 'notACanary', status: 500, payload: null });
  assert.equal(out.ok, true, 'non-canary never fails closed');
  assert.equal(out.validated, false);
});
