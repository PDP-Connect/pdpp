// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { OWNER_SESSION_DEFAULT_TTL_SECONDS } from '../server/owner-session.ts';

const INDEX_SOURCE = new URL('../server/index.js', import.meta.url);

test('owner auth config exposes an explicit session TTL env override', async () => {
  const src = await readFile(INDEX_SOURCE, 'utf8');
  assert.match(src, /PDPP_OWNER_SESSION_TTL_SECONDS/);
  assert.match(src, /ownerAuthSessionTtlSeconds/);
  assert.match(src, /Number\.isInteger\(sessionTtlRaw\)/);
  assert.match(src, /\^\[1-9\]\\d\*\$/);
  assert.match(src, /sessionTtlSeconds/);
});

test('owner session default TTL is seven days, not an indefinite session', () => {
  assert.equal(OWNER_SESSION_DEFAULT_TTL_SECONDS, 604800);
});
