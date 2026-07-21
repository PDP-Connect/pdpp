// Unit tests for the pure terminal-gap policy resolvers
// (server/stores/terminal-gap-classifier.js).
//
// `terminalGapProfileForConnector` resolves an EXPLICIT per-connector profile
// (or null) by canonical connector-key prefix; `resolveTerminalGapPolicy`
// ALWAYS returns a real policy, falling back to the safe default so no
// connector can land on a path that silently skips terminalization (spec
// §10-A "impossible by construction"). The `?? DEFAULT` fallback is the
// load-bearing guard pinned below.
//
// NOTE: the error classifiers (`classifyRecoveryError`, `isNonTransientError`,
// `isAuthFailure`) are intentionally out of scope — they are auth/forbidden
// classification code.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  CHATGPT_PROVIDER_PROFILE,
  DEFAULT_TERMINAL_GAP_PROFILE,
  resolveTerminalGapPolicy,
  terminalGapProfileForConnector,
} from '../server/stores/terminal-gap-classifier.js';

test('terminalGapProfileForConnector returns the chatgpt profile for the bare key', () => {
  assert.equal(terminalGapProfileForConnector('chatgpt'), CHATGPT_PROVIDER_PROFILE);
});

test('terminalGapProfileForConnector matches on the connector-key prefix', () => {
  // Instance-scoped ids resolve to the base profile.
  assert.equal(terminalGapProfileForConnector('chatgpt:default'), CHATGPT_PROVIDER_PROFILE);
  assert.equal(terminalGapProfileForConnector('chatgpt@v2'), CHATGPT_PROVIDER_PROFILE);
  assert.equal(terminalGapProfileForConnector('chatgpt:default@v2'), CHATGPT_PROVIDER_PROFILE);
});

test('terminalGapProfileForConnector returns null for unregistered / invalid ids', () => {
  assert.equal(terminalGapProfileForConnector('gmail'), null);
  assert.equal(terminalGapProfileForConnector('chatgpt-lookalike'), null); // no ':'/'@' split → whole string
  assert.equal(terminalGapProfileForConnector(''), null);
  assert.equal(terminalGapProfileForConnector(null), null);
  assert.equal(terminalGapProfileForConnector(42), null);
});

test('resolveTerminalGapPolicy returns the explicit profile when registered', () => {
  assert.equal(resolveTerminalGapPolicy('chatgpt'), CHATGPT_PROVIDER_PROFILE);
  assert.equal(resolveTerminalGapPolicy('chatgpt:default'), CHATGPT_PROVIDER_PROFILE);
  assert.equal(CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts, 3);
});

test('resolveTerminalGapPolicy falls back to the safe default for unregistered connectors', () => {
  // This is the §10-A "impossible by construction" guard: NEVER null.
  assert.equal(resolveTerminalGapPolicy('gmail'), DEFAULT_TERMINAL_GAP_PROFILE);
  assert.equal(resolveTerminalGapPolicy('some-unaudited-connector'), DEFAULT_TERMINAL_GAP_PROFILE);
  assert.equal(resolveTerminalGapPolicy(''), DEFAULT_TERMINAL_GAP_PROFILE);
  assert.equal(resolveTerminalGapPolicy(null), DEFAULT_TERMINAL_GAP_PROFILE);
  assert.equal(DEFAULT_TERMINAL_GAP_PROFILE.maxRecoveryAttempts, 5);
});

test('resolveTerminalGapPolicy always returns a real policy object (never null/undefined)', () => {
  for (const id of ['chatgpt', 'gmail', '', null, undefined, 'x:y@z']) {
    const policy = resolveTerminalGapPolicy(id);
    assert.ok(policy && typeof policy.maxRecoveryAttempts === 'number', `policy for ${String(id)} must be real`);
  }
});
