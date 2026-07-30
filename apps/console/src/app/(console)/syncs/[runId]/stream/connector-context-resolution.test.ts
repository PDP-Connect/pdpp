// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Executable proof for the stream page's multi-instance connector-label
 * resolution (gate finding #6, 2026-07-29 revision). See
 * `connector-context-resolution.ts` for the full before/after narrative.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildConnectorContext, resolveConnectorSummaryRouteId } from "./connector-context-resolution.ts";

test("resolveConnectorSummaryRouteId prefers the exact connection instance when known", () => {
  assert.equal(resolveConnectorSummaryRouteId("strava", "cin_work_account"), "cin_work_account");
});

test("resolveConnectorSummaryRouteId falls back to the bare connector id when no instance is known", () => {
  assert.equal(resolveConnectorSummaryRouteId("strava", null), "strava");
});

test("buildConnectorContext: a resolved match uses that connection's OWN display name", () => {
  const context = buildConnectorContext("strava", {
    connector_display_name: "Strava",
    display_name: "Strava (work account)",
  });
  assert.deepEqual(context, { connectorId: "strava", displayName: "Strava (work account)" });
});

test("buildConnectorContext: an unresolved match (ambiguous connector_id or unknown route id) degrades to the generic connector label, never a sibling connection's name", () => {
  // This is the intentional migration behavior change: previously, an
  // ambiguous connector_id resolved via client-side `.find()` to the FIRST
  // configured connection sharing that type — silently attaching a
  // possibly-wrong sibling's display_name. The reference-scoped read now
  // returns no match at all in this case, and this function must degrade
  // to the generic connector-type label rather than fabricate or guess.
  const context = buildConnectorContext("strava", undefined);
  assert.equal(context.connectorId, "strava");
  assert.ok(context.displayName.length > 0, "must be a non-empty generic connector-type label");
  // Never a specific connection's own display_name — that would mean the
  // fallback silently attached a possibly-wrong sibling connection's label.
  assert.notEqual(context.displayName, "Strava (work account)");
});

test("buildConnectorContext never throws when the match carries no display fields", () => {
  const context = buildConnectorContext("strava", { connector_display_name: "", display_name: "" });
  assert.equal(context.connectorId, "strava");
  assert.equal(typeof context.displayName, "string");
  assert.ok(context.displayName.length > 0, "must fall back to a non-empty label, never a blank string");
});
