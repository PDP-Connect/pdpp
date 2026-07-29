// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { SpineSummary } from "../lib/spine.ts";
import { canUseConnectorWideRunSummaryFallback } from "../server/ref-control.ts";

function baseSummary(overrides: Partial<SpineSummary>): SpineSummary {
  return {
    actor_id: "actor",
    actor_type: "connector",
    client_id: null,
    connector_id: "connector",
    event_count: 0,
    failure: null,
    first_at: "2026-01-01T00:00:00.000Z",
    grant_id: null,
    kinds: ["run"],
    last_at: "2026-01-01T00:00:00.000Z",
    needs_input: false,
    request_id: null,
    run_id: null,
    source: null,
    source_id: null,
    source_kind: null,
    status: "succeeded",
    trace_id: null,
    ...overrides,
  };
}

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

test("non-browser summary matches by connector_instance_id (binds the row)", () => {
  const summary = baseSummary({
    connector_instance_id: "cin_target",
    id: "run_api",
    run_id: "run_api",
  });
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      ...SINGLETON,
      browserSurfaceProfileKey: null,
      connectorInstanceId: "cin_target",
      summary,
    }),
    true,
    "an api run explicitly tagged to this instance binds directly"
  );
  // A summary tagged to a DIFFERENT instance still falls through to the
  // legacy-unscoped branch (no profile key) → allowed as a singleton borrow.
  // So to prove the instance-id arm is real, use a summary with a profile key
  // that would otherwise refuse it, tagged to the wrong instance:
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      ...SINGLETON,
      browserSurfaceProfileKey: "p:cin_target",
      connectorInstanceId: "cin_target",
      summary: baseSummary({
        browser_surface_profile_key: "p:other",
        connector_instance_id: "cin_other",
        id: "r",
        run_id: "r",
      }),
    }),
    false,
    "a browser run tagged to another instance/profile is refused, not borrowed"
  );
});

test("non-browser summary matches by the alternate connection_id field", () => {
  // Older spine rows carried `connection_id` rather than `connector_instance_id`.
  const summary = baseSummary({
    connection_id: "cin_legacy",
    id: "run_legacy",
    run_id: "run_legacy",
  });
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      ...SINGLETON,
      browserSurfaceProfileKey: null,
      connectorInstanceId: "cin_legacy",
      summary,
    }),
    true,
    "the connection_id arm binds the same as connector_instance_id"
  );
});

test("browser profile key coalesces to the instance id when no explicit profile key is passed", () => {
  // browserSurfaceProfileKey is null, so the matcher compares the summary key
  // against the connectorInstanceId. A summary keyed to the instance id matches.
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      ...SINGLETON,
      browserSurfaceProfileKey: null,
      connectorInstanceId: "cin_x",
      summary: baseSummary({ browser_surface_profile_key: "cin_x", id: "r", run_id: "r" }),
    }),
    true,
    "a browser run keyed to the instance id matches when no explicit profile key is given"
  );
  // Same setup but the key does NOT equal the instance id → refused (it is a
  // browser run with a mismatched profile, not a legacy unscoped run).
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      ...SINGLETON,
      browserSurfaceProfileKey: null,
      connectorInstanceId: "cin_x",
      summary: baseSummary({ browser_surface_profile_key: "cin_y", id: "r", run_id: "r" }),
    }),
    false,
    "a browser run keyed to a different instance is not borrowed even for a singleton"
  );
});

test("the singleton gate precedes any binding match (a perfect match with count != 1 is still refused)", () => {
  const perfectMatch = baseSummary({
    connector_instance_id: "cin_target",
    id: "r",
    run_id: "r",
  });
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      activeVisibleConnectionCount: 0,
      browserSurfaceProfileKey: null,
      connectorInstanceId: "cin_target",
      summary: perfectMatch,
    }),
    false,
    "zero active visible connections short-circuits before the match check"
  );
  assert.equal(
    canUseConnectorWideRunSummaryFallback({
      activeVisibleConnectionCount: 3,
      browserSurfaceProfileKey: null,
      connectorInstanceId: "cin_target",
      summary: perfectMatch,
    }),
    false,
    "more than one active visible connection short-circuits before the match check"
  );
});
