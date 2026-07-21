import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cooldownProfileForConnector,
  CHATGPT_COOLDOWN_PROFILE,
  DEFAULT_COOLDOWN_PROFILE,
} from '../runtime/scheduler-source-pressure-cooldown.ts';

// Mutation-killing complement for cooldownProfileForConnector's CONNECTOR-ID
// KEY PARSING — the projection that maps a decorated connector id onto a
// per-provider cooldown profile. The existing suite proves it always returns a
// real (non-null/non-Infinity) profile and covers `chatgpt` / `chatgpt:default`,
// but does not isolate the two-stage base extraction `id.split(":")[0].split(
// "@")[0]`, so dropping either split would survive. Pure — no DB.

test('resolves the chatgpt profile from a bare id and from :-decorated ids', () => {
  assert.equal(cooldownProfileForConnector('chatgpt'), CHATGPT_COOLDOWN_PROFILE);
  assert.equal(cooldownProfileForConnector('chatgpt:some-instance'), CHATGPT_COOLDOWN_PROFILE);
});

test('strips an @-suffix (and a :-then-@ decoration) down to the provider base', () => {
  // The base is taken before the first ':' AND before the first '@'.
  assert.equal(cooldownProfileForConnector('chatgpt@acct-1'), CHATGPT_COOLDOWN_PROFILE, '@-suffix stripped');
  assert.equal(
    cooldownProfileForConnector('chatgpt:instance@acct-1'),
    CHATGPT_COOLDOWN_PROFILE,
    'the : split happens first, then @ is stripped from that segment'
  );
});

test('an unknown provider base falls back to the DEFAULT profile', () => {
  assert.equal(cooldownProfileForConnector('amazon'), DEFAULT_COOLDOWN_PROFILE);
  assert.equal(cooldownProfileForConnector('amazon:acct@x'), DEFAULT_COOLDOWN_PROFILE);
  // A base that merely starts with the known key but isn't equal must NOT match.
  assert.equal(cooldownProfileForConnector('chatgptx'), DEFAULT_COOLDOWN_PROFILE, 'prefix is not a match');
});

test('null / undefined / empty connector id falls back to DEFAULT without throwing', () => {
  assert.equal(cooldownProfileForConnector(null), DEFAULT_COOLDOWN_PROFILE);
  assert.equal(cooldownProfileForConnector(undefined), DEFAULT_COOLDOWN_PROFILE);
  assert.equal(cooldownProfileForConnector(''), DEFAULT_COOLDOWN_PROFILE);
});
