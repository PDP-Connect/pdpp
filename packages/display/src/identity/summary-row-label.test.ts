// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { grantRowLabel, runRowLabel, traceRowLabel } from "./summary-row-label.ts";

const RUN_ID_PATTERN = /run_\d/;
const RUN_PREFIX_PATTERN = /^run_/;

test("runRowLabel leads with the connector, never the run id", () => {
  assert.equal(runRowLabel({ connector_id: "github" }), "github");
  const label = runRowLabel({ connector_id: "slack" } as Record<string, unknown>);
  assert.equal(label, "slack");
  assert.ok(!RUN_ID_PATTERN.test(label));
});

test("runRowLabel falls back source -> provider -> 'Run'", () => {
  assert.equal(runRowLabel({ source: { id: "ynab", kind: "connector" } }), "ynab");
  assert.equal(runRowLabel({ provider_id: "acme" }), "provider acme");
  assert.equal(runRowLabel({}), "Run");
  assert.equal(runRowLabel({ connector_id: "   " }), "Run");
});

test("runRowLabel uses the source display label without technical kind prefixes", () => {
  const label = runRowLabel({ source: { id: "gmail", kind: "connector" } });
  assert.equal(label, "Gmail");
  assert.ok(!label.includes(":"));
});

test("traceRowLabel prefers source, then provider, then client, then kind", () => {
  assert.equal(traceRowLabel({ source: { id: "github", kind: "connector" } }), "github");
  assert.equal(traceRowLabel({ provider_id: "github" }), "github");
  assert.equal(traceRowLabel({ client: { client_name: "Claude" }, client_id: "cli_42" }), "Claude");
  assert.equal(traceRowLabel({ client_id: "abc123" }), "client abc123");
  assert.equal(traceRowLabel({ kinds: ["", "  ", "record.write"] }), "record.write");
  assert.equal(traceRowLabel({}), "Trace");
});

test("grantRowLabel prefers source, then connector, then client, then provider", () => {
  assert.equal(grantRowLabel({ source: { id: "slack", kind: "connector" } }), "slack");
  assert.equal(grantRowLabel({ connector_id: "gmail" }), "Gmail");
  assert.equal(grantRowLabel({ client: { client_name: "Claude" }, client_id: "cli_42" }), "Claude");
  assert.equal(grantRowLabel({ client_id: "cli_42" }), "client cli_42");
  assert.equal(grantRowLabel({ provider_id: "p9" }), "provider p9");
  assert.equal(grantRowLabel({}), "Grant");
});

test("no helper ever returns a raw artifact id", () => {
  const runId = "run_1780463950373";
  for (const label of [runRowLabel({}), traceRowLabel({}), grantRowLabel({})]) {
    assert.ok(!label.includes(runId));
    assert.ok(!RUN_PREFIX_PATTERN.test(label));
  }
});
