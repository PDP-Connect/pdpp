// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  autoCompactOutboxIfBloated,
  DEFAULT_COLLECTOR_AUTO_COMPACT_POLICY,
  resolveCollectorAutoCompactPolicy,
} from "./collector-runner.ts";
import { LocalDeviceOutbox } from "./local-device-outbox.ts";

async function tempOutboxPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pdpp-auto-compact-")), "outbox.sqlite");
}

/**
 * Seed `count` succeeded record_batch rows carrying a ~2 KiB payload each so a
 * later prune leaves a large reclaimable freelist. Mirrors the helper in
 * local-device-outbox.test.ts so these tests exercise the same bloat shape.
 */
function seedFatSucceededRows(path: string, sourceInstanceId: string, count: number): void {
  new LocalDeviceOutbox({ path }).close();
  const db = new DatabaseSync(path);
  try {
    const blob = "x".repeat(2000);
    const stamp = "2026-06-04T00:00:00.000Z";
    const insert = db.prepare(
      `INSERT INTO local_device_outbox (
         id, source_instance_id, kind, status, payload_json, body_hash,
         attempt_count, next_attempt_at, acknowledged_at, created_at, updated_at
       ) VALUES (?, ?, 'record_batch', 'succeeded', ?, 'hash', 0, ?, ?, ?, ?)`
    );
    db.exec("BEGIN");
    for (let index = 0; index < count; index++) {
      insert.run(
        `${sourceInstanceId}:fat:${index}`,
        sourceInstanceId,
        JSON.stringify({ blob, index }),
        stamp,
        stamp,
        stamp,
        stamp
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/** Insert one `ready` (unsent) row so the lane reads as not-quiet. */
function seedReadyRow(path: string, sourceInstanceId: string): void {
  const db = new DatabaseSync(path);
  try {
    const stamp = "2026-06-04T00:00:00.000Z";
    db.prepare(
      `INSERT INTO local_device_outbox (
         id, source_instance_id, kind, status, payload_json, body_hash,
         attempt_count, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'record_batch', 'ready', '{"records":[]}', 'hash', 0, ?, ?, ?)`
    ).run(`${sourceInstanceId}:ready:0`, sourceInstanceId, stamp, stamp, stamp);
  } finally {
    db.close();
  }
}

/**
 * Bloat then prune an outbox so it has a large freelist and only `keepCount`
 * live succeeded rows remain. Returns the on-disk size after the prune.
 */
function bloatAndPrune(path: string, sourceInstanceId: string, seed: number, keepCount: number): number {
  seedFatSucceededRows(path, sourceInstanceId, seed);
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.pruneSent({ dryRun: false, keepCount, sourceInstanceId });
  } finally {
    outbox.close();
  }
  return statSync(path).size;
}

test("resolveCollectorAutoCompactPolicy returns the byte-bounded default with no overrides", () => {
  const policy = resolveCollectorAutoCompactPolicy(undefined, {});
  assert.deepEqual(policy, DEFAULT_COLLECTOR_AUTO_COMPACT_POLICY);
  assert.equal(policy.enabled, true);
  assert.equal(policy.minReclaimableBytes, 512 * 1024 * 1024);
});

test("resolveCollectorAutoCompactPolicy honors a run-config override", () => {
  const policy = resolveCollectorAutoCompactPolicy({ minReclaimableBytes: 1024 }, {});
  assert.equal(policy.minReclaimableBytes, 1024);
  assert.equal(policy.enabled, true);
});

test("PDPP_COLLECTOR_AUTO_COMPACT=0 disables the run-time compact", () => {
  for (const value of ["0", "false", "off", "no", "FALSE"]) {
    const policy = resolveCollectorAutoCompactPolicy(undefined, { PDPP_COLLECTOR_AUTO_COMPACT: value });
    assert.equal(policy.enabled, false, `expected ${value} to disable`);
  }
});

test("env override takes precedence over run-config and tunes the byte threshold", () => {
  const policy = resolveCollectorAutoCompactPolicy(
    { minReclaimableBytes: 1024 },
    { PDPP_COLLECTOR_AUTO_COMPACT_MIN_RECLAIM_BYTES: "2048" }
  );
  assert.equal(policy.minReclaimableBytes, 2048);
});

test("malformed env override falls through to the lower-precedence value", () => {
  const policy = resolveCollectorAutoCompactPolicy(
    { minReclaimableBytes: 1024 },
    { PDPP_COLLECTOR_AUTO_COMPACT_MIN_RECLAIM_BYTES: "-3" }
  );
  assert.equal(policy.minReclaimableBytes, 1024);
});

test("auto-compact reclaims the freelist and shrinks the file on a bloated, quiet lane", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-bloat-quiet";
  // 4,000 fat rows pruned to 100 leaves a multi-MiB freelist; threshold is set
  // low enough to trigger but above zero so it is a real gate.
  const sizeAfterPrune = bloatAndPrune(path, sourceInstanceId, 4000, 100);
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const before = outbox.pageStats();
    assert.ok(before.reclaimableBytes > 1024 * 1024, "prune must leave >1 MiB reclaimable");

    const result = autoCompactOutboxIfBloated({
      outbox,
      policy: { enabled: true, minReclaimableBytes: 1024 * 1024 },
    });

    assert.equal(result.enabled, true);
    assert.equal(result.compacted, true);
    assert.equal(result.reason, "compacted");
    assert.ok(result.reclaimedBytes > 0, "must report reclaimed bytes");
    assert.equal(outbox.pageStats().freelistPages, 0, "freelist is emptied by the rebuild");
    assert.ok(statSync(path).size < sizeAfterPrune, "on-disk file must shrink");
    // Lossless: the retained succeeded rows survive the rebuild.
    assert.equal(outbox.summary({ sourceInstanceId }).succeeded, 100);
  } finally {
    outbox.close();
  }
});

test("auto-compact is a no-op below the reclaimable-bytes threshold (no whole-file rebuild)", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-below-threshold";
  const sizeAfterPrune = bloatAndPrune(path, sourceInstanceId, 4000, 100);
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const reclaimable = outbox.pageStats().reclaimableBytes;
    // Threshold one byte above the actual freelist: never worth a rebuild.
    const result = autoCompactOutboxIfBloated({
      outbox,
      policy: { enabled: true, minReclaimableBytes: reclaimable + 1 },
    });

    assert.equal(result.compacted, false);
    assert.equal(result.reason, "below_threshold");
    assert.equal(result.reclaimedBytes, 0);
    assert.equal(statSync(path).size, sizeAfterPrune, "file must not change");
    assert.ok(outbox.pageStats().freelistPages > 0, "freelist is left intact");
  } finally {
    outbox.close();
  }
});

test("auto-compact defers when the lane is not quiet (unsent work present)", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-not-quiet";
  const sizeAfterPrune = bloatAndPrune(path, sourceInstanceId, 4000, 100);
  // A single ready row makes the lane non-quiet even though the freelist is large.
  seedReadyRow(path, sourceInstanceId);
  const outbox = new LocalDeviceOutbox({ path });
  try {
    assert.ok(outbox.pageStats().reclaimableBytes > 1024 * 1024, "freelist is over threshold");
    assert.equal(outbox.countNonSucceeded(), 1, "one unsent row present");

    const result = autoCompactOutboxIfBloated({
      outbox,
      policy: { enabled: true, minReclaimableBytes: 1024 * 1024 },
    });

    assert.equal(result.compacted, false);
    assert.equal(result.reason, "lane_not_quiet");
    assert.equal(statSync(path).size, sizeAfterPrune, "file must not change while work is unsent");
    assert.ok(outbox.pageStats().freelistPages > 0, "freelist is preserved for a later quiet run");
  } finally {
    outbox.close();
  }
});

test("auto-compact is a no-op when disabled, never opening a write transaction", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-disabled";
  const sizeAfterPrune = bloatAndPrune(path, sourceInstanceId, 4000, 100);
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const result = autoCompactOutboxIfBloated({
      outbox,
      policy: { enabled: false, minReclaimableBytes: 0 },
    });

    assert.equal(result.enabled, false);
    assert.equal(result.compacted, false);
    assert.equal(result.reason, "disabled");
    assert.equal(statSync(path).size, sizeAfterPrune, "disabled policy must touch nothing");
  } finally {
    outbox.close();
  }
});
