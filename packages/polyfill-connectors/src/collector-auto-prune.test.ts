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
 * acknowledged drain leaves behind, dated `ackedAt` so the age bound can be
 * exercised deterministically without waiting real wall-clock days.
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

test("resolveCollectorAutoPrunePolicy returns the conservative default with no overrides", () => {
  const policy = resolveCollectorAutoPrunePolicy(undefined, {});
  assert.deepEqual(policy, DEFAULT_COLLECTOR_AUTO_PRUNE_POLICY);
  assert.equal(policy.enabled, true);
  assert.equal(policy.keepRecentCount, 1000);
  assert.equal(policy.keepWithinDays, 30);
});

test("resolveCollectorAutoPrunePolicy honors a run-config override", () => {
  const policy = resolveCollectorAutoPrunePolicy({ keepRecentCount: 5, keepWithinDays: 1 }, {});
  assert.equal(policy.keepRecentCount, 5);
  assert.equal(policy.keepWithinDays, 1);
  assert.equal(policy.enabled, true);
});

test("PDPP_COLLECTOR_AUTO_PRUNE=0 disables the run-time prune", () => {
  for (const value of ["0", "false", "off", "no", "FALSE"]) {
    const policy = resolveCollectorAutoPrunePolicy(undefined, { PDPP_COLLECTOR_AUTO_PRUNE: value });
    assert.equal(policy.enabled, false, `expected ${value} to disable`);
  }
});

test("env overrides take precedence over run-config and tune the bounds", () => {
  const policy = resolveCollectorAutoPrunePolicy(
    { keepRecentCount: 5, keepWithinDays: 2 },
    { PDPP_COLLECTOR_AUTO_PRUNE_KEEP_COUNT: "100", PDPP_COLLECTOR_AUTO_PRUNE_KEEP_DAYS: "7" }
  );
  assert.equal(policy.keepRecentCount, 100);
  assert.equal(policy.keepWithinDays, 7);
});

test("malformed env overrides fall through to the lower-precedence value", () => {
  const policy = resolveCollectorAutoPrunePolicy(
    { keepRecentCount: 5, keepWithinDays: 2 },
    { PDPP_COLLECTOR_AUTO_PRUNE_KEEP_COUNT: "-3", PDPP_COLLECTOR_AUTO_PRUNE_KEEP_DAYS: "abc" }
  );
  assert.equal(policy.keepRecentCount, 5);
  assert.equal(policy.keepWithinDays, 2);
});

test("autoPruneSucceededOutbox prunes succeeded rows over both bounds and reports the count", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-prune";
  // 50 acknowledged rows, all dated 90 days ago, with a keep-recent bound of 10.
  // 10 survive on the count bound; the other 40 are both outside the recent set
  // AND older than the 30-day age floor, so they prune.
  seedSucceededRows(path, sourceInstanceId, 50, "2026-03-01T00:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const result = autoPruneSucceededOutbox({
      now: new Date("2026-06-04T00:00:00.000Z"),
      outbox,
      policy: { enabled: true, keepRecentCount: 10, keepWithinDays: 30 },
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

test("autoPruneSucceededOutbox keeps recent rows even when all rows are old (count bound holds)", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-recent";
  // Only 5 rows, all old. keepRecentCount=10 means every row is in the
  // most-recent-10 set, so nothing prunes despite all being past the age floor.
  seedSucceededRows(path, sourceInstanceId, 5, "2026-01-01T00:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const result = autoPruneSucceededOutbox({
      now: new Date("2026-06-04T00:00:00.000Z"),
      outbox,
      policy: { enabled: true, keepRecentCount: 10, keepWithinDays: 30 },
      sourceInstanceId,
    });
    assert.equal(result.pruned, 0);
    assert.equal(outbox.summary({ sourceInstanceId }).succeeded, 5);
  } finally {
    outbox.close();
  }
});

test("autoPruneSucceededOutbox keeps rows within the age window even past the count bound", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-young";
  // 50 rows acknowledged today, keepRecentCount=10. The 40 outside the recent
  // set are still younger than the 30-day floor, so the age bound protects
  // them — nothing prunes. A row survives if recent by count OR by age.
  seedSucceededRows(path, sourceInstanceId, 50, "2026-06-03T00:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const result = autoPruneSucceededOutbox({
      now: new Date("2026-06-04T00:00:00.000Z"),
      outbox,
      policy: { enabled: true, keepRecentCount: 10, keepWithinDays: 30 },
      sourceInstanceId,
    });
    assert.equal(result.matched, 0);
    assert.equal(result.pruned, 0);
    assert.equal(outbox.summary({ sourceInstanceId }).succeeded, 50);
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

    // Acknowledge nothing for ready (re-fail it back), retry one, dead-letter one,
    // leave one leased. The remaining "ready" item we re-fail to a ready/retry state.
    const retry = byId.get("r:retry");
    const dead = byId.get("r:dead");
    const ready = byId.get("r:ready");
    assert.ok(retry && dead && ready);
    outbox.failRetryable({ error: "boom", holder, id: retry.id, leaseEpoch: retry.lease_epoch, retryBackoffMs: 1 });
    outbox.deadLetter({ error: "terminal", holder, id: dead.id, leaseEpoch: dead.lease_epoch });
    outbox.failRetryable({ error: "boom", holder, id: ready.id, leaseEpoch: ready.lease_epoch, retryBackoffMs: 0 });

    const before = outbox.summary({ sourceInstanceId });
    assert.equal(before.succeeded, 0);

    // Aggressive policy: keep nothing, prune everything older than -1 day.
    const result = autoPruneSucceededOutbox({
      now: new Date("2026-07-04T00:00:00.000Z"),
      outbox,
      policy: { enabled: true, keepRecentCount: 0, keepWithinDays: 0 },
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

test("autoPruneSucceededOutbox keeps a succeeded row alongside non-succeeded work, pruning only the succeeded over-retention tail", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-mixed";
  const holder = "holder-2";
  // Seed 30 old succeeded rows directly.
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
      now: new Date("2026-06-04T00:00:00.000Z"),
      outbox,
      policy: { enabled: true, keepRecentCount: 5, keepWithinDays: 30 },
      sourceInstanceId,
    });
    // 30 succeeded, keep 5 recent → 25 are both old and outside the recent set.
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
      now: new Date("2026-06-04T00:00:00.000Z"),
      outbox,
      policy: { enabled: false, keepRecentCount: 0, keepWithinDays: 0 },
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
      now: new Date("2026-06-04T00:00:00.000Z"),
      outbox,
      policy: { enabled: true, keepRecentCount: 5, keepWithinDays: 30 },
      sourceInstanceId: "src-a",
    });
    assert.equal(result.pruned, 25);
    assert.equal(outbox.summary({ sourceInstanceId: "src-a" }).succeeded, 5);
    assert.equal(outbox.summary({ sourceInstanceId: "src-b" }).succeeded, 20, "other source untouched");
  } finally {
    outbox.close();
  }
});
