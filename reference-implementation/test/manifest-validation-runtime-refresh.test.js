// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for validateRuntimeRequirements + validateRefreshPolicyCapability
// in server/connector-manifest-validation.ts. Both were unpinned by name.
//
// These validators gate what a connector manifest may declare for its runtime
// bindings + external tools and its refresh policy; a loosened check silently
// admits a malformed manifest at registration.
//
// NOTE (pinned quirk): validateRuntimeRequirements returns EARLY when
// `runtime_requirements.bindings` is absent, so `external_tools` is only validated
// when `bindings` is also declared. These tests include `bindings` for the
// external-tools cases and pin the early-return behavior explicitly.
//
// Mutation surface:
//   validateRuntimeRequirements -- object-shape guards, RUNTIME_REQUIREMENT_BINDINGS
//     allowlist, `required` boolean, external_tools object/array shape, required
//     name/license/purpose strings, DUPLICATE tool-name rejection, detect.command
//     string, detect.exit_code non-negative integer.
//   validateRefreshPolicyCapability -- REFRESH_POLICY_ALLOWED_KEYS allowlist,
//     recommended_mode enum (automatic|manual|paused), required rationale.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateRefreshPolicyCapability,
  validateRuntimeRequirements,
} from '../server/connector-manifest-validation.ts';

const CODE = 'invalid_request';

function expectReject(fn, msgIncludes) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, CODE, `expected ${CODE}, got ${err.code}`);
    if (msgIncludes) assert.ok(err.message.includes(msgIncludes), `message "${err.message}" should include "${msgIncludes}"`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// validateRuntimeRequirements — bindings
// ---------------------------------------------------------------------------

test('validateRuntimeRequirements: absent runtime_requirements / bindings is a pass', () => {
  assert.doesNotThrow(() => validateRuntimeRequirements({}, CODE));
  assert.doesNotThrow(() => validateRuntimeRequirements({ runtime_requirements: {} }, CODE), 'no bindings -> early return pass');
});

test('validateRuntimeRequirements: a recognized binding with a boolean required passes', () => {
  assert.doesNotThrow(() =>
    validateRuntimeRequirements({ runtime_requirements: { bindings: { browser: { required: true } } } }, CODE),
  );
});

test('validateRuntimeRequirements: an unsupported binding key is rejected', () => {
  expectReject(
    () => validateRuntimeRequirements({ runtime_requirements: { bindings: { teleport: {} } } }, CODE),
    'unsupported keys: teleport',
  );
});

test('validateRuntimeRequirements: a non-boolean `required` is rejected', () => {
  expectReject(
    () => validateRuntimeRequirements({ runtime_requirements: { bindings: { network: { required: 'yes' } } } }, CODE),
    'required must be a boolean',
  );
});

test('validateRuntimeRequirements: non-object runtime_requirements or bindings is rejected', () => {
  expectReject(() => validateRuntimeRequirements({ runtime_requirements: [] }, CODE), 'must be an object');
  expectReject(() => validateRuntimeRequirements({ runtime_requirements: { bindings: [] } }, CODE), 'bindings must be an object');
});

// ---------------------------------------------------------------------------
// validateRuntimeRequirements — external_tools (requires bindings present)
// ---------------------------------------------------------------------------

const withBindings = { bindings: { network: { required: true } } };

test('validateRuntimeRequirements: external_tools is only validated when bindings is declared (pinned quirk)', () => {
  // WITHOUT bindings, a clearly-invalid external_tools entry is NOT validated
  // (early return) — this pins the current behavior so a refactor that reorders
  // the checks is caught.
  assert.doesNotThrow(
    () => validateRuntimeRequirements({ runtime_requirements: { external_tools: [{ bogus: 1 }] } }, CODE),
    'no bindings -> external_tools not reached',
  );
  // WITH bindings, the same invalid entry IS rejected.
  expectReject(
    () => validateRuntimeRequirements({ runtime_requirements: { ...withBindings, external_tools: [{ bogus: 1 }] } }, CODE),
  );
});

test('validateRuntimeRequirements: external_tools requires name/license/purpose non-empty strings', () => {
  expectReject(
    () => validateRuntimeRequirements({ runtime_requirements: { ...withBindings, external_tools: [{ license: 'MIT', purpose: 'x' }] } }, CODE),
    'name must be a non-empty string',
  );
});

test('validateRuntimeRequirements: duplicate external tool names are rejected', () => {
  expectReject(
    () => validateRuntimeRequirements({
      runtime_requirements: {
        ...withBindings,
        external_tools: [
          { name: 'git', license: 'MIT', purpose: 'vcs' },
          { name: 'git', license: 'MIT', purpose: 'vcs again' },
        ],
      },
    }, CODE),
    "duplicates tool 'git'",
  );
});

test('validateRuntimeRequirements: detect.exit_code must be a non-negative integer', () => {
  expectReject(
    () => validateRuntimeRequirements({
      runtime_requirements: {
        ...withBindings,
        external_tools: [{ name: 'git', license: 'MIT', purpose: 'vcs', detect: { command: 'git --version', exit_code: -1 } }],
      },
    }, CODE),
    'exit_code must be a non-negative integer',
  );
  // A valid detect passes.
  assert.doesNotThrow(() => validateRuntimeRequirements({
    runtime_requirements: {
      ...withBindings,
      external_tools: [{ name: 'git', license: 'MIT', purpose: 'vcs', detect: { command: 'git --version', exit_code: 0 } }],
    },
  }, CODE));
});

// ---------------------------------------------------------------------------
// validateRefreshPolicyCapability
// ---------------------------------------------------------------------------

test('validateRefreshPolicyCapability: absent capabilities / refresh_policy is a pass', () => {
  assert.doesNotThrow(() => validateRefreshPolicyCapability({}, CODE));
  assert.doesNotThrow(() => validateRefreshPolicyCapability({ capabilities: {} }, CODE));
});

test('validateRefreshPolicyCapability: a well-formed refresh_policy passes', () => {
  assert.doesNotThrow(() =>
    validateRefreshPolicyCapability({ capabilities: { refresh_policy: { recommended_mode: 'automatic', rationale: 'daily sync' } } }, CODE),
  );
});

test('validateRefreshPolicyCapability: an unsupported policy key is rejected', () => {
  expectReject(
    () => validateRefreshPolicyCapability({ capabilities: { refresh_policy: { recommended_mode: 'manual', rationale: 'x', bogus: 1 } } }, CODE),
    'unsupported keys: bogus',
  );
});

test('validateRefreshPolicyCapability: recommended_mode must be automatic/manual/paused', () => {
  expectReject(
    () => validateRefreshPolicyCapability({ capabilities: { refresh_policy: { recommended_mode: 'turbo', rationale: 'x' } } }, CODE),
    'recommended_mode must be one of',
  );
  // each valid mode passes
  for (const mode of ['automatic', 'manual', 'paused']) {
    assert.doesNotThrow(() =>
      validateRefreshPolicyCapability({ capabilities: { refresh_policy: { recommended_mode: mode, rationale: 'x' } } }, CODE),
      `${mode} is a valid mode`,
    );
  }
});

test('validateRefreshPolicyCapability: rationale is required (non-empty string)', () => {
  expectReject(
    () => validateRefreshPolicyCapability({ capabilities: { refresh_policy: { recommended_mode: 'manual' } } }, CODE),
    'rationale must be a non-empty',
  );
});
