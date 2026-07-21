// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the reference-side retention adapter
// (runtime/browser-surface/retained-surface-connectors.ts). The adapter maps the
// reference's connector id forms (URLs, aliases) to the bare connector runtime
// name and delegates to the shared connector-runtime browser-surface policy
// (packages/polyfill-connectors/src/browser-surface-policy.ts), which is the
// single source of truth for page preservation + surface-process retention.
//
// Mutation surface:
//   - `chatgpt` (and its canonical-key aliases / URL forms) retains;
//   - an unregistered connector does not;
//   - resolution is by canonical connector key so URL forms map to the same
//     policy entry.

import assert from 'node:assert/strict';
import test from 'node:test';

import { connectorRetainsSurfaceProcess } from '../runtime/browser-surface/retained-surface-connectors.ts';

test('connectorRetainsSurfaceProcess: ChatGPT is a retained credential boundary', () => {
  assert.equal(connectorRetainsSurfaceProcess('chatgpt'), true);
});

test('connectorRetainsSurfaceProcess: ChatGPT URL / registry form resolves via canonical key', () => {
  assert.equal(connectorRetainsSurfaceProcess('https://registry.pdpp.org/connectors/chatgpt'), true);
});

test('connectorRetainsSurfaceProcess: unregistered connectors are NOT retained', () => {
  for (const id of ['chase', 'usaa', 'amazon', 'reddit', 'gmail', 'github', 'unknown']) {
    assert.equal(connectorRetainsSurfaceProcess(id), false, `${id} must not retain`);
  }
});

test('connectorRetainsSurfaceProcess: empty / nonsense ids do not retain', () => {
  assert.equal(connectorRetainsSurfaceProcess(''), false);
  assert.equal(connectorRetainsSurfaceProcess('   '), false);
});
