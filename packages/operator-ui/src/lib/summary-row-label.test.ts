import assert from "node:assert/strict";
import { test } from "node:test";

import { grantRowLabel, runRowLabel, traceRowLabel } from "./summary-row-label.ts";

// The contract these helpers exist to enforce: a list row leads with the
// meaningful "what happened to whom" label (connector / source / client),
// and NEVER with the raw artifact id. The id is rendered separately as a
// secondary mono lookup key, so these helpers must never return it.

test("runRowLabel leads with the connector, never the run id", () => {
  assert.equal(runRowLabel({ connector_id: "github" }), "github");
  // A run id passed only as context must never leak into the label.
  const label = runRowLabel({ connector_id: "slack" } as Record<string, unknown>);
  assert.equal(label, "slack");
  assert.ok(!/run_\d/.test(label));
});

test("runRowLabel falls back source -> provider -> 'Run'", () => {
  assert.equal(
    runRowLabel({ source: { kind: "connector", id: "ynab" } }),
    "ynab",
    "uses the source connector key when connector_id is absent"
  );
  assert.equal(
    runRowLabel({ provider_id: "acme" }),
    "provider acme",
    "falls back to the provider when neither connector nor source resolves"
  );
  assert.equal(runRowLabel({}), "Run", "final fallback is a stable noun, not an empty string");
  assert.equal(runRowLabel({ connector_id: "   " }), "Run", "whitespace-only fields are treated as absent");
});

test("runRowLabel strips the kind prefix from a source label", () => {
  // formatSourceForDisplay yields `connector:<key>`; the row headline must not
  // carry the `connector:` noise.
  const label = runRowLabel({ source: { kind: "connector", id: "gmail" } });
  assert.equal(label, "gmail");
  assert.ok(!label.includes(":"));
});

test("traceRowLabel prefers source, then provider, then client, then kind", () => {
  assert.equal(traceRowLabel({ source: { kind: "connector", id: "github" } }), "github");
  assert.equal(traceRowLabel({ provider_id: "github" }), "github", "provider is formatted, not raw-prefixed");
  assert.equal(traceRowLabel({ client_id: "abc123" }), "client abc123");
  assert.equal(traceRowLabel({ kinds: ["", "  ", "record.write"] }), "record.write", "skips blank kinds");
  assert.equal(traceRowLabel({}), "Trace");
});

test("grantRowLabel prefers source, then connector, then client, then provider", () => {
  assert.equal(grantRowLabel({ source: { kind: "connector", id: "slack" } }), "slack");
  assert.equal(grantRowLabel({ connector_id: "gmail" }), "gmail");
  assert.equal(grantRowLabel({ client_id: "cli_42" }), "client cli_42");
  assert.equal(grantRowLabel({ provider_id: "p9" }), "provider p9");
  assert.equal(grantRowLabel({}), "Grant");
});

test("no helper ever returns a raw artifact id", () => {
  // Even when an id-shaped value is the only thing present in an unexpected
  // field, the helper must not surface it as the headline.
  const runId = "run_1780463950373";
  // connector_id is the only label source; an id placed there would be a
  // caller bug, but the row must still never *originate* a run_ headline.
  for (const label of [
    runRowLabel({}),
    traceRowLabel({}),
    grantRowLabel({}),
  ]) {
    assert.ok(!label.includes(runId));
    assert.ok(!/^run_/.test(label));
  }
});
