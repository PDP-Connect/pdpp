/**
 * Honesty guard for the trace list status → Endorse mapping.
 *
 * PDPP discipline: unknown reads unknown — an unrecognized trace status
 * must render the neutral `unknown` badge, NEVER a definite `revoked`.
 * Before this fix the `default` arm returned `"revoked"`, painting
 * uncertainty as a terminal fact.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { traceEndorseStatus } from "./trace-endorse-status.ts";

test("unknown / unrecognized trace status maps to neutral 'unknown', never 'revoked'", () => {
  assert.equal(traceEndorseStatus("unknown"), "unknown");
  assert.equal(traceEndorseStatus("some_status_the_console_has_never_seen"), "unknown");
  assert.equal(traceEndorseStatus(""), "unknown");

  // The specific regression this pins shut: indeterminate must not be revoked.
  assert.notEqual(traceEndorseStatus("unknown"), "revoked");
});

test("known trace statuses keep their definite variants", () => {
  assert.equal(traceEndorseStatus("succeeded"), "active");
  assert.equal(traceEndorseStatus("started"), "continuous");
  assert.equal(traceEndorseStatus("in_progress"), "continuous");
  assert.equal(traceEndorseStatus("failed"), "denied");
  assert.equal(traceEndorseStatus("rejected"), "denied");
});
