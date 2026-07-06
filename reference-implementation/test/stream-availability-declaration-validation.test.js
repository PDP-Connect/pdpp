/**
 * Unit coverage for the UNTESTED manifest-validation shaper
 * `validateStreamAvailabilityDeclaration` (`server/connector-manifest-validation.ts`).
 *
 * It inspects a stream's `availability` block and THROWS a typed
 * `invalidConnectorManifest` (carrying the supplied `code`) for each violation,
 * or returns when the block is absent/valid. Every message is scoped by the
 * stream name. Pinned here:
 *
 *   - ACCEPT: no availability; a bare valid `state`; `unsupported_in_mode` with a
 *     `mode`; a valid non-empty `future_modes` array.
 *   - REJECT: availability not an object; an unsupported key; a bad `state`;
 *     `unsupported_in_mode` missing `mode`; a blank `mode`/`reason`; a
 *     `future_modes` that is empty or contains a non-string.
 *
 * Pure — the module imports only connector-key helpers (no DB). No fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateStreamAvailabilityDeclaration } from '../server/connector-manifest-validation.ts';

const CODE = 'invalid_connector_manifest';

function stream(availability, name = 'orders') {
  return availability === undefined ? { name } : { name, availability };
}

function assertRejects(availability, messagePart) {
  assert.throws(
    () => validateStreamAvailabilityDeclaration(stream(availability), CODE),
    (err) => {
      assert.equal(err.code, CODE, `code: ${err.code}`);
      assert.ok(String(err.message).includes("Stream 'orders'"), `message must be stream-scoped: ${err.message}`);
      assert.ok(String(err.message).includes(messagePart), `message ${JSON.stringify(err.message)} lacks ${JSON.stringify(messagePart)}`);
      return true;
    },
  );
}

// --- accept paths -----------------------------------------------------------

test('validateStreamAvailabilityDeclaration: returns when availability is absent or null', () => {
  assert.equal(validateStreamAvailabilityDeclaration({ name: 'orders' }, CODE), undefined);
  assert.equal(validateStreamAvailabilityDeclaration({ name: 'orders', availability: null }, CODE), undefined);
});

test('validateStreamAvailabilityDeclaration: accepts each valid state', () => {
  for (const state of ['supported', 'experimental', 'deprecated']) {
    assert.equal(validateStreamAvailabilityDeclaration(stream({ state }), CODE), undefined, state);
  }
});

test('validateStreamAvailabilityDeclaration: accepts unsupported_in_mode with a mode', () => {
  assert.equal(
    validateStreamAvailabilityDeclaration(stream({ state: 'unsupported_in_mode', mode: 'browser' }), CODE),
    undefined,
  );
});

test('validateStreamAvailabilityDeclaration: accepts a non-empty future_modes array of strings', () => {
  assert.equal(
    validateStreamAvailabilityDeclaration(stream({ state: 'experimental', future_modes: ['browser', 'api'] }), CODE),
    undefined,
  );
});

// --- reject paths -----------------------------------------------------------

test('validateStreamAvailabilityDeclaration: rejects availability that is not an object', () => {
  assertRejects('x', 'availability must be an object');
  assertRejects([], 'availability must be an object');
});

test('validateStreamAvailabilityDeclaration: rejects an unsupported availability key', () => {
  assertRejects({ state: 'supported', bogus: 1 }, 'unsupported keys: bogus');
});

test('validateStreamAvailabilityDeclaration: rejects a bad or missing state', () => {
  assertRejects({ state: 'maybe' }, 'availability.state must be one of');
  assertRejects({}, 'availability.state must be one of');
});

test('validateStreamAvailabilityDeclaration: rejects unsupported_in_mode without a mode', () => {
  assertRejects(
    { state: 'unsupported_in_mode' },
    'availability.mode must be a non-empty string when state is unsupported_in_mode',
  );
});

test('validateStreamAvailabilityDeclaration: rejects a blank mode or reason', () => {
  assertRejects({ state: 'unsupported_in_mode', mode: '   ' }, 'availability.mode must be a non-empty string');
  assertRejects({ state: 'supported', reason: '  ' }, 'availability.reason must be a non-empty string');
});

test('validateStreamAvailabilityDeclaration: rejects an empty or non-string future_modes', () => {
  assertRejects({ state: 'supported', future_modes: [] }, 'future_modes must be a non-empty array of strings');
  assertRejects({ state: 'supported', future_modes: [1, 2] }, 'future_modes must be a non-empty array of strings');
  assertRejects({ state: 'supported', future_modes: ['ok', ''] }, 'future_modes must be a non-empty array of strings');
  assertRejects({ state: 'supported', future_modes: 'browser' }, 'future_modes must be a non-empty array of strings');
});
