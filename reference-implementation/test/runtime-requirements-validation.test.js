/**
 * Unit coverage for the UNTESTED manifest-validation shaper
 * `validateRuntimeRequirements` (`server/connector-manifest-validation.ts`).
 *
 * It validates a connector manifest's `runtime_requirements` block (bindings +
 * external_tools), THROWING a typed `invalidConnectorManifest` (carrying the
 * supplied `code`) per violation, or returning when absent/valid.
 *
 * Pinned here:
 *   - ACCEPT: no runtime_requirements; bindings only; a valid external tool.
 *   - bindings REJECT: requirements not an object; bindings not an object; an
 *     unsupported binding key; a binding value that is not an object; a
 *     non-boolean `required`.
 *   - external_tools REJECT (only reachable once bindings is present — see the
 *     short-circuit test): not an array; an unsupported tool key; a missing
 *     required string field (name/license/purpose); a duplicate tool name; a
 *     `detect` without a command; a negative `detect.exit_code`.
 *   - SHORT-CIRCUIT: when `bindings` is absent, the function returns BEFORE
 *     external_tools is validated — so an invalid external_tools with no bindings
 *     is (by contract) not rejected here.
 *
 * Pure — the module imports only connector-key helpers (no DB). No fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRuntimeRequirements } from '../server/connector-manifest-validation.ts';

const CODE = 'invalid_connector_manifest';

// external_tools validation is only reached when `bindings` is present, so tests
// that probe external_tools include an (empty, valid) bindings object.
function withBindingsAndTools(external_tools) {
  return { runtime_requirements: { bindings: {}, external_tools } };
}

function assertRejects(manifest, messagePart) {
  assert.throws(
    () => validateRuntimeRequirements(manifest, CODE),
    (err) => {
      assert.equal(err.code, CODE, `code: ${err.code}`);
      assert.ok(String(err.message).includes(messagePart), `message ${JSON.stringify(err.message)} lacks ${JSON.stringify(messagePart)}`);
      return true;
    },
  );
}

// --- accept paths -----------------------------------------------------------

test('validateRuntimeRequirements: returns when runtime_requirements is absent', () => {
  assert.equal(validateRuntimeRequirements({}, CODE), undefined);
  assert.equal(validateRuntimeRequirements({ runtime_requirements: null }, CODE), undefined);
});

test('validateRuntimeRequirements: accepts valid bindings', () => {
  assert.equal(
    validateRuntimeRequirements(
      { runtime_requirements: { bindings: { browser: { required: true }, network: {} } } },
      CODE,
    ),
    undefined,
  );
});

test('validateRuntimeRequirements: accepts a valid external tool (with bindings present)', () => {
  assert.equal(
    validateRuntimeRequirements(
      withBindingsAndTools([{ name: 'git', license: 'GPL-2.0', purpose: 'clone repos' }]),
      CODE,
    ),
    undefined,
  );
});

// --- bindings reject paths --------------------------------------------------

test('validateRuntimeRequirements: rejects non-object requirements or bindings', () => {
  assertRejects({ runtime_requirements: 'x' }, 'runtime_requirements must be an object');
  assertRejects({ runtime_requirements: { bindings: 'x' } }, 'runtime_requirements.bindings must be an object');
});

test('validateRuntimeRequirements: rejects an unsupported binding key', () => {
  assertRejects({ runtime_requirements: { bindings: { gpu: {} } } }, 'bindings has unsupported keys: gpu');
});

test('validateRuntimeRequirements: rejects a non-object binding value and a non-boolean required', () => {
  assertRejects({ runtime_requirements: { bindings: { browser: 'x' } } }, 'bindings.browser must be an object');
  assertRejects(
    { runtime_requirements: { bindings: { browser: { required: 'yes' } } } },
    'bindings.browser.required must be a boolean',
  );
});

// --- external_tools reject paths (bindings present) -------------------------

test('validateRuntimeRequirements: rejects external_tools that is not an array', () => {
  assertRejects(withBindingsAndTools('x'), 'external_tools must be an array');
});

test('validateRuntimeRequirements: rejects an unsupported external tool key', () => {
  assertRejects(
    withBindingsAndTools([{ name: 'git', license: 'x', purpose: 'y', bogus: 1 }]),
    'external_tools[0] has unsupported keys: bogus',
  );
});

test('validateRuntimeRequirements: rejects a tool missing a required string field', () => {
  assertRejects(withBindingsAndTools([{ license: 'x', purpose: 'y' }]), 'external_tools[0].name must be a non-empty string');
  assertRejects(withBindingsAndTools([{ name: 'git', purpose: 'y' }]), 'external_tools[0].license must be a non-empty string');
});

test('validateRuntimeRequirements: rejects a duplicate tool name', () => {
  assertRejects(
    withBindingsAndTools([
      { name: 'git', license: 'a', purpose: 'b' },
      { name: 'git', license: 'c', purpose: 'd' },
    ]),
    "external_tools duplicates tool 'git'",
  );
});

test('validateRuntimeRequirements: rejects a detect without a command and a negative exit_code', () => {
  assertRejects(
    withBindingsAndTools([{ name: 'git', license: 'a', purpose: 'b', detect: {} }]),
    'external_tools[0].detect.command must be a non-empty string',
  );
  assertRejects(
    withBindingsAndTools([{ name: 'git', license: 'a', purpose: 'b', detect: { command: 'git --version', exit_code: -1 } }]),
    'external_tools[0].detect.exit_code must be a non-negative integer',
  );
});

// --- short-circuit contract -------------------------------------------------

test('validateRuntimeRequirements: external_tools is NOT validated when bindings is absent (early return)', () => {
  // No bindings => the function returns before ever reaching external_tools, so
  // an otherwise-invalid external_tools value is not rejected here.
  assert.equal(
    validateRuntimeRequirements({ runtime_requirements: { external_tools: 'not-an-array' } }, CODE),
    undefined,
    'absent bindings short-circuits external_tools validation',
  );
});
