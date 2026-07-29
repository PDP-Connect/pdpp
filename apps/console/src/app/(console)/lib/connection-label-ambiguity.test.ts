// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral coverage for the shared "label needed" ambiguity rule.
 *
 * Node strips the TS types and runs the helper directly; it imports only the
 * dependency-free shared connector-display labeler (the same one the records
 * list and the grant pin use), so these are real behavior assertions. This
 * mirrors `grants/request/connection-pin.test.ts`.
 *
 * The invariant under test: a fallback connector-type label ("Amazon") is only
 * "label needed" when it is AMBIGUOUS — two or more unnamed connections of the
 * same connector type. A single connection of a type keeps its honest type name
 * with no rename nag (the bug this lane closed: every never-renamed Amazon /
 * USAA / GitHub / YNAB was prompted to rename).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ambiguousFallbackLabelKeys, hasFallbackLabel, isLabelNeeded } from "./connection-label-ambiguity.ts";
import type { ConnectorOverview } from "./rs-client.ts";

/** Minimal ConnectorOverview-shaped fixture. */
function overview({
  connectorId,
  displayName,
  connectionId,
}: {
  connectorId: string;
  displayName?: string;
  connectionId: string;
}): ConnectorOverview {
  return {
    connectionId,
    connector: {
      connector_id: connectorId,
      ...(displayName === undefined ? {} : { display_name: displayName }),
      streams: [],
    },
    connectorDisplayName: connectorId,
    isRunning: false,
    lastRun: null,
    lastSuccessfulRun: null,
    streams: [],
    totalRecords: 0,
  };
}

test("a single unnamed connection of a type is NOT label-needed", () => {
  const overviews = [
    overview({ connectionId: "cin_amazon", connectorId: "amazon", displayName: "Amazon" }),
    overview({ connectionId: "cin_usaa", connectorId: "usaa" }),
    overview({ connectionId: "cin_github", connectorId: "github", displayName: "GitHub" }),
    overview({ connectionId: "cin_ynab", connectorId: "ynab", displayName: "YNAB" }),
  ];
  const keys = ambiguousFallbackLabelKeys(overviews);
  assert.equal(keys.size, 0, "no single-of-type fallback should be flagged");
  for (const o of overviews) {
    assert.equal(isLabelNeeded(o, keys), false);
  }
});

test("two unnamed connections of the SAME type are both label-needed", () => {
  const loneAmazon = overview({ connectionId: "cin_amazon", connectorId: "amazon", displayName: "Amazon" });
  const overviews = [
    overview({ connectionId: "cin_gmail_a", connectorId: "gmail", displayName: "Gmail" }),
    overview({ connectionId: "cin_gmail_b", connectorId: "gmail" }),
    loneAmazon,
  ];
  const keys = ambiguousFallbackLabelKeys(overviews);
  assert.deepEqual(new Set(keys), new Set(["cin_gmail_a", "cin_gmail_b"]));
  // The lone Amazon is never nagged even when another type is ambiguous.
  assert.equal(isLabelNeeded(loneAmazon, keys), false);
});

test("a renamed connection is never label-needed, and disambiguates its siblings", () => {
  // One Gmail owner-named, one unnamed → the named one is not a fallback at
  // all, so only ONE unnamed Gmail remains. A single unnamed of a type is not
  // ambiguous, so nothing is flagged.
  const namedGmail = overview({ connectionId: "cin_gmail_a", connectorId: "gmail", displayName: "Personal Gmail" });
  const unnamedGmail = overview({ connectionId: "cin_gmail_b", connectorId: "gmail" });
  const overviews = [namedGmail, unnamedGmail];
  const keys = ambiguousFallbackLabelKeys(overviews);
  assert.equal(keys.size, 0);
  assert.equal(hasFallbackLabel(namedGmail), false);
  assert.equal(hasFallbackLabel(unnamedGmail), true);
});

test("three unnamed of a type are all label-needed", () => {
  const overviews = [
    overview({ connectionId: "cin_cc_1", connectorId: "claude-code" }),
    overview({ connectionId: "cin_cc_2", connectorId: "claude-code" }),
    overview({ connectionId: "cin_cc_3", connectorId: "claude-code" }),
  ];
  const keys = ambiguousFallbackLabelKeys(overviews);
  assert.equal(keys.size, 3);
});

test("ambiguity is order-independent", () => {
  const a = overview({ connectionId: "cin_s1", connectorId: "slack" });
  const b = overview({ connectionId: "cin_s2", connectorId: "slack" });
  const forward = ambiguousFallbackLabelKeys([a, b]);
  const reverse = ambiguousFallbackLabelKeys([b, a]);
  assert.deepEqual(new Set(forward), new Set(reverse));
});

test("empty input yields no flagged connections", () => {
  assert.equal(ambiguousFallbackLabelKeys([]).size, 0);
});
