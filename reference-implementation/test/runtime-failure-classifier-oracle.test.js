// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRuntimeFailure } from '../runtime/classify-runtime-failure.js';

function errorWithMessage(message) {
  return new Error(message);
}

test('classifyRuntimeFailure preserves an explicit failure_reason override', () => {
  const err = errorWithMessage('Connector emitted invalid PROGRESS.message: expected non-empty string');
  err.failure_reason = 'custom_reason';

  assert.equal(classifyRuntimeFailure(err), 'custom_reason');
});

test('classifyRuntimeFailure maps invalid interaction handler responses', () => {
  assert.equal(
    classifyRuntimeFailure(errorWithMessage('Interaction handler returned an invalid INTERACTION_RESPONSE envelope')),
    'interaction_handler_invalid_response'
  );
  assert.equal(
    classifyRuntimeFailure(errorWithMessage('Invalid INTERACTION_RESPONSE status: paused')),
    'interaction_handler_invalid_response'
  );
});

test('classifyRuntimeFailure maps connector protocol violations', () => {
  const messages = [
    'Connector emitted invalid PROGRESS.message: expected non-empty string',
    'Connector emitted invalid DONE.error: expected string',
    'Connector emitted DETAIL_COVERAGE for undeclared stream: transactions',
    'Connector emitted RECORD after DONE',
    'Connector exit code 1 does not match DONE status: succeeded',
    'Connector emitted unknown message type: SURPRISE',
  ];

  for (const message of messages) {
    assert.equal(
      classifyRuntimeFailure(errorWithMessage(message)),
      'connector_protocol_violation',
      message
    );
  }
});

test('classifyRuntimeFailure defaults unrecognized failures to runtime_error', () => {
  assert.equal(classifyRuntimeFailure(errorWithMessage('unexpected runtime failure')), 'runtime_error');
  assert.equal(classifyRuntimeFailure(null), 'runtime_error');
  assert.equal(classifyRuntimeFailure({}), 'runtime_error');
  assert.equal(classifyRuntimeFailure({ message: 'plain object failure' }), 'runtime_error');
});
