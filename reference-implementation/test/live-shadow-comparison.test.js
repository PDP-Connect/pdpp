/**
 * Live shadow comparison gate for `RenderedVerdict`.
 *
 * This is intentionally opt-in because it reads the operator's live Postgres
 * database. It does not mutate the DB, trigger connector runs, write grants, or
 * touch the live stack. Enable with:
 *
 *   PDPP_LIVE_CONNECTOR_HEALTH_GATE=1 \
 *   PDPP_STORAGE_BACKEND=postgres \
 *   PDPP_DATABASE_URL=postgres://pdpp:pdpp@127.0.0.1:55432/pdpp \
 *   node --test --import tsx reference-implementation/test/live-shadow-comparison.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";

import { initDb } from "../server/db.js";
import { closePostgresStorage, initPostgresStorage, resolveStorageBackend } from "../server/postgres-storage.js";
import { listConnectorSummaries } from "../server/ref-control.ts";

function enabled() {
  return process.env.PDPP_LIVE_CONNECTOR_HEALTH_GATE === "1";
}

function oldHeadline(snapshot) {
  const stateMap = {
    blocked: "Can't collect",
    cooling_off: "Healthy",
    degraded: "Needs you",
    healthy: "Healthy",
    idle: "Healthy",
    needs_attention: "Needs you",
    unknown: "Checking",
  };
  return stateMap[snapshot.state] ?? "Checking";
}

function classify(summary) {
  const snapshot = summary.connection_health;
  const verdict = summary.rendered_verdict;
  const oldLabel = oldHeadline(snapshot);
  const newLabel = verdict.pill.label;

  if (oldLabel === newLabel) {
    return "no_change";
  }

  if (oldLabel === "Healthy" && newLabel === "Needs you" && snapshot.axes.freshness === "stale") {
    return "fixed_lie";
  }

  if (newLabel === "Can't collect" && snapshot.axes.coverage === "terminal_gap") {
    return "fixed_lie";
  }

  if (newLabel === "Can't collect" && snapshot.axes.outbox === "stalled") {
    return "fixed_lie";
  }

  // A stricter, non-owner-interrupting verdict can be the intended silence
  // correction when the new channel is calm and the old UI had no channel.
  if (verdict.channel === "calm" && oldLabel !== newLabel) {
    return "deliberate_silence_correction";
  }

  return "unexpected_drift";
}

test("live-shadow-comparison: production projection has no unexpected drift", { skip: !enabled() }, async () => {
  await initDb(":memory:");
  await initPostgresStorage(resolveStorageBackend(), {});
  try {
    const summaries = await listConnectorSummaries(null, { concurrency: 1 });
    assert.ok(summaries.length > 0, "live connection set is non-empty");

    const results = summaries.map((summary) => {
      const classification = classify(summary);
      return {
        channel: summary.rendered_verdict.channel,
        classification,
        connection_id: summary.connection_id,
        connector_id: summary.connector_id,
        coverage: summary.connection_health.axes.coverage,
        display_name: summary.display_name,
        freshness: summary.connection_health.axes.freshness,
        new_label: summary.rendered_verdict.pill.label,
        old_label: oldHeadline(summary.connection_health),
        outbox: summary.connection_health.axes.outbox,
        state: summary.connection_health.state,
      };
    });

    const counts = results.reduce((acc, row) => {
      acc[row.classification] = (acc[row.classification] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`live-shadow-comparison ${JSON.stringify({ count: results.length, counts, results }, null, 2)}`);

    const unexpected = results.filter((row) => row.classification === "unexpected_drift");
    assert.deepEqual(unexpected, [], "unexpected drift blocks owner-surface migration");
  } finally {
    await closePostgresStorage();
  }
});

