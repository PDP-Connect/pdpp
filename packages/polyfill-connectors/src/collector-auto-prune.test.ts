// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  autoPruneSucceededOutbox,
  DEFAULT_COLLECTOR_AUTO_PRUNE_POLICY,
  resolveCollectorAutoPrunePolicy,
} from "./collector-runner.ts";
import { LocalDeviceOutbox } from "./local-device-outbox.ts";

async function tempOutboxPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pdpp-auto-prune-")), "outbox.sqlite");
}

/**
 * Seed `count` succeeded `record_batch` rows directly, mirroring what an
 * acknowledged drain leaves behind, all dated `ackedAt`. The automatic prune is
 * bounded by count alone, so `ackedAt` only affects the manual age-based CLI
 * path (exercised elsewhere) — here it lets a test assert that recency of
 * acknowledgement never protects a row from the count cap.
 */
function seedSucceededRows(path: string, sourceInstanceId: string, count: number, ackedAt: string): void {
  new LocalDeviceOutbox({ path }).close();
  const db = new DatabaseSync(path);
  try {
    const insert = db.prepare(
      `INSERT INTO local_device_outbox (
         id, source_instance_id, kind, status, payload_json, body_hash,
         attempt_count, next_attempt_at, acknowledged_at, created_at, updated_at
       ) VALUES (?, ?, 'record_batch', 'succeeded', '{"records":[]}', 'hash', 0, ?, ?, ?, ?)`
    );
    db.exec("BEGIN");
    for (let index = 0; index < count; index++) {
      insert.run(`${sourceInstanceId}:row:${index}`, sourceInstanceId, ackedAt, ackedAt, ackedAt, ackedAt);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

test("resolveCollectorAutoPrunePolicy returns the count-bounded default with no overrides", () => {
  const policy = resolveCollectorAutoPrunePolicy(undefined, {});
  assert.deepEqual(policy, DEFAULT_COLLECTOR_AUTO_PRUNE_POLICY);
  assert.equal(policy.enabled, true);
  // The default cap equals the runner's own per-run / per-queue bound
  // (maxEnqueuedBatchesPerRun / maxQueueDepth), not an arbitrary fraction.
  assert.equal(policy.keepRecentCount, 10_000);
  // The policy is count-only: there is no age knob to defeat the cap.
  assert.equal("keepWithinDays" in policy, false);
});

test("resolveCollectorAutoPrunePolicy honors a run-config override", () => {
  const policy = resolveCollectorAutoPrunePolicy({ keepRecentCount: 5 }, {});
  assert.equal(policy.keepRecentCount, 5);
  assert.equal(policy.enabled, true);
});

test("PDPP_COLLECTOR_AUTO_PRUNE=0 disables the run-time prune", () => {
  for (const value of ["0", "false", "off", "no", "FALSE"]) {
    const policy = resolveCollectorAutoPrunePolicy(undefined, { PDPP_COLLECTOR_AUTO_PRUNE: value });
    assert.equal(policy.enabled, false, `expected ${value} to disable`);
  }
});

test("env override takes precedence over run-config and tunes the count bound", () => {
  const policy = resolveCollectorAutoPrunePolicy(
    { keepRecentCount: 5 },
    { PDPP_COLLECTOR_AUTO_PRUNE_KEEP_COUNT: "100" }
  );
  assert.equal(policy.keepRecentCount, 100);
});

test("malformed env override falls through to the lower-precedence value", () => {
  const policy = resolveCollectorAutoPrunePolicy(
    { keepRecentCount: 5 },
    { PDPP_COLLECTOR_AUTO_PRUNE_KEEP_COUNT: "-3" }
  );
  assert.equal(policy.keepRecentCount, 5);
});

test("autoPruneSucceededOutbox prunes succeeded rows over the count bound and reports the count", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-prune";
  // 50 acknowledged rows; keep the most-recent 10. The other 40 are outside the
  // recent set, so they prune. Age is irrelevant — these are dated 90 days ago.
  seedSucceededRows(path, sourceInstanceId, 50, "2026-03-01T00:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const result = autoPruneSucceededOutbox({
      outbox,
      policy: { enabled: true, keepRecentCount: 10 },
      sourceInstanceId,
    });
    assert.equal(result.enabled, true);
    assert.equal(result.matched, 40);
    assert.equal(result.pruned, 40);
    assert.equal(outbox.summary({ sourceInstanceId }).succeeded, 10);
  } finally {
    outbox.close();
  }
});

test("REGRESSION (v1 flaw): rows ALL acknowledged today still prune down to the count cap", async () => {
  // This is the exact incident shape v1 could not handle: a large succeeded
  // tail whose rows are ALL acknowledged within the last few minutes/days.
  // v1 ANDed a 30-day age floor with the count cap, so nothing younger than 30
  // days ever pruned — the owner's 170k-row / 35 GB outbox (all acked over ~15 days)
  // would have reclaimed ZERO rows on the next run. The count-only bound must
  // reclaim everything beyond the cap regardless of how fresh the rows are.
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-fresh-flood";
  // 5,000 rows all acknowledged "today" (well inside any age window).
  seedSucceededRows(path, sourceInstanceId, 5000, "2026-06-04T00:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const result = autoPruneSucceededOutbox({
      outbox,
      policy: { enabled: true, keepRecentCount: 1000 },
      sourceInstanceId,
    });
    assert.equal(result.matched, 4000, "every row past the cap matches, regardless of recency");
    assert.equal(result.pruned, 4000);
    assert.equal(
      outbox.summary({ sourceInstanceId }).succeeded,
      1000,
      "the tail is capped at keepRecentCount even when no row is old"
    );
  } finally {
    outbox.close();
  }
});

test("REGRESSION (incident shape): a 15-day spread of fresh rows is capped on the first pass", async () => {
  // The live incident's succeeded rows spanned ~2026-05-20 .. 2026-06-04 (~15
  // days) — none older than the 30-day floor. Seed rows spread across that
  // window and prove the cap reclaims the whole over-cap tail in one pass.
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-incident-15d";
  const dbSeed = new LocalDeviceOutbox({ path });
  dbSeed.close();
  const db = new DatabaseSync(path);
  try {
    const insert = db.prepare(
      `INSERT INTO local_device_outbox (
         id, source_instance_id, kind, status, payload_json, body_hash,
         attempt_count, next_attempt_at, acknowledged_at, created_at, updated_at
       ) VALUES (?, ?, 'record_batch', 'succeeded', '{"records":[]}', 'hash', 0, ?, ?, ?, ?)`
    );
    db.exec("BEGIN");
    // 3,000 rows spread one-per-row across 2026-05-20 .. 2026-06-04 (15 days).
    const startMs = Date.parse("2026-05-20T00:00:00.000Z");
    const endMs = Date.parse("2026-06-04T00:00:00.000Z");
    const total = 3000;
    for (let index = 0; index < total; index++) {
      const ms = startMs + Math.round(((endMs - startMs) * index) / (total - 1));
      const acked = new Date(ms).toISOString();
      insert.run(`${sourceInstanceId}:row:${index}`, sourceInstanceId, acked, acked, acked, acked);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const result = autoPruneSucceededOutbox({
      outbox,
      policy: { enabled: true, keepRecentCount: 1000 },
      sourceInstanceId,
    });
    assert.equal(result.pruned, 2000, "all but the most-recent 1,000 prune on the first pass");
    assert.equal(outbox.summary({ sourceInstanceId }).succeeded, 1000);
  } finally {
    outbox.close();
  }
});

test("autoPruneSucceededOutbox keeps every row when the count is within the bound", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-recent";
  // Only 5 rows, keepRecentCount=10 → every row is in the most-recent set, so
  // nothing prunes. (They are old, proving age does not force a prune either.)
  seedSucceededRows(path, sourceInstanceId, 5, "2026-01-01T00:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const result = autoPruneSucceededOutbox({
      outbox,
      policy: { enabled: true, keepRecentCount: 10 },
      sourceInstanceId,
    });
    assert.equal(result.pruned, 0);
    assert.equal(outbox.summary({ sourceInstanceId }).succeeded, 5);
  } finally {
    outbox.close();
  }
});

test("autoPruneSucceededOutbox never prunes ready, leased, retrying, or dead-letter rows", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-statuses";
  const holder = "holder-1";
  const outbox = new LocalDeviceOutbox({ clock: () => new Date("2026-06-04T00:00:00.000Z"), path });
  try {
    // ready: a fresh enqueue that is never claimed.
    outbox.enqueue({ id: "r:ready", kind: "record_batch", payload: { records: [] }, sourceInstanceId });
    // leased: claimed and held (lease still live).
    outbox.enqueue({ id: "r:leased", kind: "record_batch", payload: { records: [] }, sourceInstanceId });
    // retrying: claimed then failed back to ready with an attempt count.
    outbox.enqueue({ id: "r:retry", kind: "record_batch", payload: { records: [] }, sourceInstanceId });
    // dead_letter: claimed then dead-lettered.
    outbox.enqueue({ id: "r:dead", kind: "record_batch", payload: { records: [] }, sourceInstanceId });

    const leased = outbox.claimReady({ holder, leaseMs: 600_000, limit: 4, sourceInstanceId });
    assert.equal(leased.length, 4);
    const byId = new Map(leased.map((item) => [item.id, item]));

    const retry = byId.get("r:retry");
    const dead = byId.get("r:dead");
    const ready = byId.get("r:ready");
    assert.ok(retry && dead && ready);
    outbox.failRetryable({ error: "boom", holder, id: retry.id, leaseEpoch: retry.lease_epoch, retryBackoffMs: 1 });
    outbox.deadLetter({ error: "terminal", holder, id: dead.id, leaseEpoch: dead.lease_epoch });
    outbox.failRetryable({ error: "boom", holder, id: ready.id, leaseEpoch: ready.lease_epoch, retryBackoffMs: 0 });

    const before = outbox.summary({ sourceInstanceId });
    assert.equal(before.succeeded, 0);

    // Most aggressive count bound possible: keep nothing.
    const result = autoPruneSucceededOutbox({
      outbox,
      policy: { enabled: true, keepRecentCount: 0 },
      sourceInstanceId,
    });
    assert.equal(result.pruned, 0, "no succeeded rows means nothing prunes");

    const after = outbox.summary({ sourceInstanceId });
    assert.equal(after.total, before.total, "no row was deleted");
    assert.equal(after.total, 4, "ready + leased + dead-letter all preserved");
    assert.equal(after.deadLetter, 1);
    assert.equal(after.leased, 1);
    // `ready` counts every ready-status row (both failed-back items); `retrying`
    // is the subset of those whose backoff is still in the future, so it never
    // adds to the row total. Two rows were failed back to ready.
    assert.equal(after.ready, 2);
    assert.equal(after.succeeded, 0);
  } finally {
    outbox.close();
  }
});

test("autoPruneSucceededOutbox keeps a succeeded row alongside non-succeeded work, pruning only the succeeded over-cap tail", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-mixed";
  const holder = "holder-2";
  // Seed 30 succeeded rows directly.
  seedSucceededRows(path, sourceInstanceId, 30, "2026-01-01T00:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => new Date("2026-06-04T00:00:00.000Z"), path });
  try {
    // Add live ready + dead-letter work that must survive any prune.
    outbox.enqueue({ id: "live:ready", kind: "record_batch", payload: { records: [] }, sourceInstanceId });
    outbox.enqueue({ id: "live:dead", kind: "record_batch", payload: { records: [] }, sourceInstanceId });
    const claimed = outbox.claimReady({ holder, leaseMs: 600_000, limit: 2, sourceInstanceId });
    const dead = claimed.find((item) => item.id === "live:dead");
    assert.ok(dead);
    outbox.deadLetter({ error: "terminal", holder, id: dead.id, leaseEpoch: dead.lease_epoch });
    // Release the other lease back to ready so it counts as open ready work.
    const stillLeased = claimed.find((item) => item.id === "live:ready");
    assert.ok(stillLeased);
    outbox.failRetryable({
      error: "release",
      holder,
      id: stillLeased.id,
      leaseEpoch: stillLeased.lease_epoch,
      retryBackoffMs: 0,
    });

    const result = autoPruneSucceededOutbox({
      outbox,
      policy: { enabled: true, keepRecentCount: 5 },
      sourceInstanceId,
    });
    // 30 succeeded, keep 5 recent → 25 prune.
    assert.equal(result.pruned, 25);
    const after = outbox.summary({ sourceInstanceId });
    assert.equal(after.succeeded, 5);
    assert.equal(after.deadLetter, 1, "dead-letter survives");
    assert.equal(after.ready, 1, "live ready work survives");
  } finally {
    outbox.close();
  }
});

test("autoPruneSucceededOutbox is a no-op when disabled", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-disabled";
  seedSucceededRows(path, sourceInstanceId, 50, "2026-01-01T00:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const result = autoPruneSucceededOutbox({
      outbox,
      policy: { enabled: false, keepRecentCount: 0 },
      sourceInstanceId,
    });
    assert.equal(result.enabled, false);
    assert.equal(result.pruned, 0);
    assert.equal(outbox.summary({ sourceInstanceId }).succeeded, 50, "disabled prune leaves every row");
  } finally {
    outbox.close();
  }
});

test("autoPruneSucceededOutbox scopes the prune to one source instance", async () => {
  const path = await tempOutboxPath();
  seedSucceededRows(path, "src-a", 30, "2026-01-01T00:00:00.000Z");
  // Re-open and seed a second source's rows on the same DB file.
  const db = new DatabaseSync(path);
  try {
    const insert = db.prepare(
      `INSERT INTO local_device_outbox (
         id, source_instance_id, kind, status, payload_json, body_hash,
         attempt_count, next_attempt_at, acknowledged_at, created_at, updated_at
       ) VALUES (?, 'src-b', 'record_batch', 'succeeded', '{"records":[]}', 'hash', 0, ?, ?, ?, ?)`
    );
    const old = "2026-01-01T00:00:00.000Z";
    db.exec("BEGIN");
    for (let index = 0; index < 20; index++) {
      insert.run(`src-b:row:${index}`, old, old, old, old);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }

  const outbox = new LocalDeviceOutbox({ path });
  try {
    const result = autoPruneSucceededOutbox({
      outbox,
      policy: { enabled: true, keepRecentCount: 5 },
      sourceInstanceId: "src-a",
    });
    assert.equal(result.pruned, 25);
    assert.equal(outbox.summary({ sourceInstanceId: "src-a" }).succeeded, 5);
    assert.equal(outbox.summary({ sourceInstanceId: "src-b" }).succeeded, 20, "other source untouched");
  } finally {
    outbox.close();
  }
});
