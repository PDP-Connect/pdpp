// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';

import { canUseConnectorWideRunSummaryFallback } from '../server/ref-control.ts';

// Mutation-killing complement for the singleton connector-wide run-summary
// fallback (`canUseConnectorWideRunSummaryFallback`) and, through it, the
// connection-matcher it delegates to. This projection decides whether a run
// summary that lacks a per-connection binding may hydrate a connection row's
// last-run / freshness evidence. Borrowing the wrong run paints stale freshness,
// so the matcher's arms are load-bearing.
//
// The existing operation tests cover the singleton gate and the browser-profile
// mismatch/match. This file pins the matcher arms those cases don't isolate:
//
//   - a NON-browser summary bound by `connector_instance_id`;
//   - a NON-browser summary bound by the alternate `connection_id` field;
//   - the browser profile-key coalesce to the instance id when no explicit
//     browser profile key is supplied;
//   - a matching binding OVERRIDES the singleton gate is NOT true — the gate is
//     first, so even a perfect match is refused when the count isn't 1.
//
// Pure — no DB.

const SINGLETON = { activeVisibleConnectionCount: 1 };

test('non-browser summary matches by connector_instance_id (binds the row)', () => {
  const summary = {
    id: 'run_api',
    run_id: 'run_api',
    browser_surface_profile_key: null,
    connector_instance_id: 'cin_target',
  };
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      ...SINGLETON,
      browserSurfaceProfileKey: null,
      connectorInstanceId: 'cin_target',
      summary,
    }),
    true,
    'an api run explicitly tagged to this instance binds directly'
  );
  // A summary tagged to a DIFFERENT instance still falls through to the
  // legacy-unscoped branch (no profile key) → allowed as a singleton borrow.
  // So to prove the instance-id arm is real, use a summary with a profile key
  // that would otherwise refuse it, tagged to the wrong instance:
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      ...SINGLETON,
      browserSurfaceProfileKey: 'p:cin_target',
      connectorInstanceId: 'cin_target',
      summary: { id: 'r', run_id: 'r', browser_surface_profile_key: 'p:other', connector_instance_id: 'cin_other' },
    }),
    false,
    'a browser run tagged to another instance/profile is refused, not borrowed'
  );
});

test('non-browser summary matches by the alternate connection_id field', () => {
  const summary = {
    id: 'run_legacy',
    run_id: 'run_legacy',
    browser_surface_profile_key: null,
    // Older spine rows carried `connection_id` rather than `connector_instance_id`.
    connection_id: 'cin_legacy',
  };
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      ...SINGLETON,
      browserSurfaceProfileKey: null,
      connectorInstanceId: 'cin_legacy',
      summary,
    }),
    true,
    'the connection_id arm binds the same as connector_instance_id'
  );
});

test('browser profile key coalesces to the instance id when no explicit profile key is passed', () => {
  // browserSurfaceProfileKey is null, so the matcher compares the summary key
  // against the connectorInstanceId. A summary keyed to the instance id matches.
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      ...SINGLETON,
      browserSurfaceProfileKey: null,
      connectorInstanceId: 'cin_x',
      summary: { id: 'r', run_id: 'r', browser_surface_profile_key: 'cin_x' },
    }),
    true,
    'a browser run keyed to the instance id matches when no explicit profile key is given'
  );
  // Same setup but the key does NOT equal the instance id → refused (it is a
  // browser run with a mismatched profile, not a legacy unscoped run).
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      ...SINGLETON,
      browserSurfaceProfileKey: null,
      connectorInstanceId: 'cin_x',
      summary: { id: 'r', run_id: 'r', browser_surface_profile_key: 'cin_y' },
    }),
    false,
    'a browser run keyed to a different instance is not borrowed even for a singleton'
  );
});

test('the singleton gate precedes any binding match (a perfect match with count != 1 is still refused)', () => {
  const perfectMatch = {
    id: 'r',
    run_id: 'r',
    browser_surface_profile_key: null,
    connector_instance_id: 'cin_target',
  };
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      activeVisibleConnectionCount: 0,
      browserSurfaceProfileKey: null,
      connectorInstanceId: 'cin_target',
      summary: perfectMatch,
    }),
    false,
    'zero active visible connections short-circuits before the match check'
  );
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      activeVisibleConnectionCount: 3,
      browserSurfaceProfileKey: null,
      connectorInstanceId: 'cin_target',
      summary: perfectMatch,
    }),
    false,
    'more than one active visible connection short-circuits before the match check'
  );
});
