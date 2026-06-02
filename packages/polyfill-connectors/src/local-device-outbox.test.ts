import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildLocalDeviceOutboxId, classifyDeadLetterError, LocalDeviceOutbox } from "./local-device-outbox.ts";

test("LocalDeviceOutbox persists ready work and reopens from disk", async () => {
  const path = await tempOutboxPath();
  const clock = fixedClock("2026-05-19T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock, path });
  outbox.enqueue({
    id: "src-1:record_batch:1",
    kind: "record_batch",
    payload: { records: [{ key: "m-1" }] },
    sourceInstanceId: "src-1",
  });
  outbox.close();

  const reopened = new LocalDeviceOutbox({ clock, path });
  try {
    const items = reopened.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, "src-1:record_batch:1");
    assert.equal(items[0]?.status, "ready");
    assert.deepEqual(items[0]?.payload, { records: [{ key: "m-1" }] });
    assert.match(items[0]?.body_hash ?? "", /^[a-f0-9]{64}$/);
  } finally {
    reopened.close();
  }
});

test("LocalDeviceOutbox supports deterministic ids and idempotent enqueue", async () => {
  const outbox = new LocalDeviceOutbox({ path: await tempOutboxPath() });
  try {
    const id = buildLocalDeviceOutboxId({
      kind: "record_batch",
      parts: ["messages", 1],
      sourceInstanceId: "src-1",
    });
    const first = outbox.enqueue({
      id,
      kind: "record_batch",
      payload: { records: [{ key: "m-1" }] },
      sourceInstanceId: "src-1",
    });
    const second = outbox.enqueue({
      id,
      kind: "record_batch",
      payload: { records: [{ key: "m-1" }] },
      sourceInstanceId: "src-1",
    });
    assert.equal(second.id, first.id);
    assert.equal(outbox.list().length, 1);
    assert.throws(
      () =>
        outbox.enqueue({
          id,
          kind: "record_batch",
          payload: { records: [{ key: "different" }] },
          sourceInstanceId: "src-1",
        }),
      /id collision/
    );
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox claims ready work with holder, epoch, and lease deadline", async () => {
  let now = new Date("2026-05-19T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path: await tempOutboxPath() });
  try {
    outbox.enqueue({
      id: "src-1:checkpoint:1",
      kind: "checkpoint",
      payload: { stream: "messages", state: "cursor-1" },
      sourceInstanceId: "src-1",
    });
    outbox.enqueue({
      id: "src-2:gap:1",
      kind: "gap",
      payload: { reason: "policy_budget" },
      sourceInstanceId: "src-2",
    });

    const claimed = outbox.claimReady({
      holder: "worker-a",
      leaseMs: 30_000,
      sourceInstanceId: "src-1",
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.id, "src-1:checkpoint:1");
    assert.equal(claimed[0]?.status, "leased");
    assert.equal(claimed[0]?.lease_holder, "worker-a");
    assert.equal(claimed[0]?.lease_epoch, 1);
    assert.equal(claimed[0]?.lease_until, "2026-05-19T12:00:30.000Z");

    // The src-2 item remains ready and independently claimable.
    assert.equal(outbox.summary({ sourceInstanceId: "src-2" }).ready, 1);

    now = new Date("2026-05-19T12:00:31.000Z");
    assert.equal(outbox.summary({ sourceInstanceId: "src-1" }).staleLeases, 1);
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox can exclude checkpoint rows while batch-claiming ready work", async () => {
  const outbox = new LocalDeviceOutbox({
    clock: () => new Date("2026-05-19T12:00:00.000Z"),
    path: await tempOutboxPath(),
  });
  try {
    outbox.enqueue({
      id: "src-1:record_batch:1",
      kind: "record_batch",
      payload: { records: [1] },
      sourceInstanceId: "src-1",
    });
    outbox.enqueue({
      id: "src-1:checkpoint:1",
      kind: "checkpoint",
      payload: { state: { cursor: "c1" } },
      sourceInstanceId: "src-1",
    });
    outbox.enqueue({
      id: "src-1:record_batch:2",
      kind: "record_batch",
      payload: { records: [2] },
      sourceInstanceId: "src-1",
    });

    const claimed = outbox.claimReady({
      excludeKinds: ["checkpoint"],
      holder: "worker-a",
      leaseMs: 30_000,
      limit: 4,
      sourceInstanceId: "src-1",
    });

    assert.deepEqual(
      claimed.map((item) => item.id),
      ["src-1:record_batch:1", "src-1:record_batch:2"]
    );
    assert.equal(outbox.get("src-1:checkpoint:1")?.status, "ready");
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox recovers expired leases and fences stale acknowledgements", async () => {
  let now = new Date("2026-05-19T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path: await tempOutboxPath() });
  try {
    outbox.enqueue({
      id: "src-1:record_batch:1",
      kind: "record_batch",
      payload: { records: [] },
      sourceInstanceId: "src-1",
    });
    const firstClaim = outbox.claimReady({ holder: "worker-a", leaseMs: 1000 });
    assert.equal(firstClaim[0]?.lease_epoch, 1);

    now = new Date("2026-05-19T12:00:02.000Z");
    assert.equal(outbox.recoverExpiredLeases(), 1);
    const secondClaim = outbox.claimReady({ holder: "worker-b", leaseMs: 60_000 });
    assert.equal(secondClaim[0]?.lease_holder, "worker-b");
    assert.equal(secondClaim[0]?.lease_epoch, 2);

    assert.throws(
      () => outbox.acknowledge({ holder: "worker-a", id: "src-1:record_batch:1", leaseEpoch: 1 }),
      /lease not current/
    );

    outbox.acknowledge({ holder: "worker-b", id: "src-1:record_batch:1", leaseEpoch: 2 });
    const item = outbox.get("src-1:record_batch:1");
    assert.equal(item?.status, "succeeded");
    assert.equal(item?.acknowledged_at, "2026-05-19T12:00:02.000Z");
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox handles retry and dead-letter transitions", async () => {
  let now = new Date("2026-05-19T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path: await tempOutboxPath() });
  try {
    outbox.enqueue({
      id: "src-1:blob_upload:1",
      kind: "blob_upload",
      payload: { blob: "b1" },
      sourceInstanceId: "src-1",
    });
    const [claim] = outbox.claimReady({ holder: "worker-a", leaseMs: 60_000 });
    assert.ok(claim);
    outbox.failRetryable({
      error: "temporary 503",
      holder: "worker-a",
      id: claim.id,
      leaseEpoch: claim.lease_epoch,
      retryBackoffMs: 15_000,
    });

    let item = outbox.get(claim.id);
    assert.equal(item?.status, "ready");
    assert.equal(item?.attempt_count, 1);
    assert.equal(item?.next_attempt_at, "2026-05-19T12:00:15.000Z");
    assert.equal(item?.last_error, "temporary 503");
    assert.equal(outbox.claimReady({ holder: "worker-a", leaseMs: 60_000 }).length, 0);

    now = new Date("2026-05-19T12:00:16.000Z");
    const [retryClaim] = outbox.claimReady({ holder: "worker-a", leaseMs: 60_000 });
    assert.ok(retryClaim);
    outbox.deadLetter({
      error: "parse failure",
      holder: "worker-a",
      id: retryClaim.id,
      leaseEpoch: retryClaim.lease_epoch,
    });
    item = outbox.get(retryClaim.id);
    assert.equal(item?.status, "dead_letter");
    assert.equal(item?.attempt_count, 2);
    assert.equal(item?.last_error, "parse failure");
    assert.equal(outbox.summary().deadLetter, 1);
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox requeues dead letters by source, kind, and limit", async () => {
  const outbox = new LocalDeviceOutbox({
    clock: fixedClock("2026-05-19T12:00:00.000Z"),
    path: await tempOutboxPath(),
  });
  try {
    for (const [id, kind, sourceInstanceId] of [
      ["src-1:record_batch:1", "record_batch", "src-1"],
      ["src-1:record_batch:2", "record_batch", "src-1"],
      ["src-1:gap:1", "gap", "src-1"],
      ["src-2:record_batch:1", "record_batch", "src-2"],
    ] as const) {
      outbox.enqueue({
        id,
        kind,
        payload: { id, secret: "not surfaced" },
        sourceInstanceId,
      });
      const [claim] = outbox.claimReady({ holder: "worker-a", leaseMs: 60_000, sourceInstanceId });
      assert.ok(claim);
      outbox.deadLetter({
        error: "terminal",
        holder: "worker-a",
        id: claim.id,
        leaseEpoch: claim.lease_epoch,
      });
    }

    assert.deepEqual(
      outbox.requeueDeadLetters({
        dryRun: true,
        kind: "record_batch",
        limit: 1,
        sourceInstanceId: "src-1",
      }),
      { matched: 1, requeued: 0 }
    );
    assert.equal(outbox.summary({ sourceInstanceId: "src-1" }).deadLetter, 3);

    assert.deepEqual(
      outbox.requeueDeadLetters({
        kind: "record_batch",
        limit: 1,
        sourceInstanceId: "src-1",
      }),
      { matched: 1, requeued: 1 }
    );

    const summary = outbox.summary({ sourceInstanceId: "src-1" });
    assert.equal(summary.ready, 1);
    assert.equal(summary.deadLetter, 2);
    const requeued = outbox.get("src-1:record_batch:1");
    assert.equal(requeued?.status, "ready");
    assert.equal(requeued?.attempt_count, 0);
    assert.equal(requeued?.last_error, null);

    assert.equal(outbox.summary({ sourceInstanceId: "src-2" }).deadLetter, 1);
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox deletes only succeeded rows by id", async () => {
  const outbox = new LocalDeviceOutbox({ path: await tempOutboxPath() });
  try {
    outbox.enqueue({
      id: "src-1:gap:succeeded",
      kind: "gap",
      payload: { reason: "policy_budget" },
      sourceInstanceId: "src-1",
    });
    outbox.enqueue({
      id: "src-1:gap:ready",
      kind: "gap",
      payload: { reason: "policy_budget" },
      sourceInstanceId: "src-1",
    });
    const [claim] = outbox.claimReady({ holder: "worker-a", leaseMs: 60_000, limit: 1, sourceInstanceId: "src-1" });
    assert.ok(claim);
    outbox.acknowledge({ holder: "worker-a", id: claim.id, leaseEpoch: claim.lease_epoch });
    const otherId = claim.id === "src-1:gap:succeeded" ? "src-1:gap:ready" : "src-1:gap:succeeded";

    assert.equal(outbox.deleteSucceeded(claim.id), true);
    assert.equal(outbox.get(claim.id), null);
    assert.equal(outbox.deleteSucceeded(otherId), false);
    assert.equal(outbox.get(otherId)?.status, "ready");
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox rejects lease transitions after expiry even before recovery", async () => {
  let now = new Date("2026-05-19T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path: await tempOutboxPath() });
  try {
    outbox.enqueue({
      id: "src-1:record_batch:1",
      kind: "record_batch",
      payload: { records: [] },
      sourceInstanceId: "src-1",
    });
    const [claim] = outbox.claimReady({ holder: "worker-a", leaseMs: 1000 });
    assert.ok(claim);

    now = new Date("2026-05-19T12:00:02.000Z");
    assert.throws(
      () => outbox.acknowledge({ holder: "worker-a", id: claim.id, leaseEpoch: claim.lease_epoch }),
      /lease not current/
    );
    assert.throws(
      () =>
        outbox.failRetryable({
          error: "late retry",
          holder: "worker-a",
          id: claim.id,
          leaseEpoch: claim.lease_epoch,
          retryBackoffMs: 1000,
        }),
      /lease not current/
    );
    assert.throws(
      () =>
        outbox.deadLetter({
          error: "late dead-letter",
          holder: "worker-a",
          id: claim.id,
          leaseEpoch: claim.lease_epoch,
        }),
      /lease not current/
    );

    assert.equal(outbox.recoverExpiredLeases({ sourceInstanceId: "src-1" }), 1);
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox renews only the current unexpired lease holder", async () => {
  let now = new Date("2026-05-19T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path: await tempOutboxPath() });
  try {
    outbox.enqueue({
      id: "src-1:record_batch:1",
      kind: "record_batch",
      payload: { records: [] },
      sourceInstanceId: "src-1",
    });
    const [claim] = outbox.claimReady({ holder: "worker-a", leaseMs: 1000 });
    assert.ok(claim);
    const renewed = outbox.renewLease({
      holder: "worker-a",
      id: claim.id,
      leaseEpoch: claim.lease_epoch,
      leaseMs: 60_000,
    });
    assert.equal(renewed.lease_until, "2026-05-19T12:01:00.000Z");

    assert.throws(
      () =>
        outbox.renewLease({
          holder: "worker-b",
          id: claim.id,
          leaseEpoch: claim.lease_epoch,
          leaseMs: 60_000,
        }),
      /lease not current/
    );

    now = new Date("2026-05-19T12:01:01.000Z");
    assert.throws(
      () =>
        outbox.renewLease({
          holder: "worker-a",
          id: claim.id,
          leaseEpoch: claim.lease_epoch,
          leaseMs: 60_000,
        }),
      /lease not current/
    );
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox can recover expired leases by source instance", async () => {
  let now = new Date("2026-05-19T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path: await tempOutboxPath() });
  try {
    for (const sourceInstanceId of ["src-1", "src-2"]) {
      outbox.enqueue({
        id: `${sourceInstanceId}:record_batch:1`,
        kind: "record_batch",
        payload: { records: [] },
        sourceInstanceId,
      });
      outbox.claimReady({ holder: "worker-a", leaseMs: 1000, sourceInstanceId });
    }

    now = new Date("2026-05-19T12:00:02.000Z");
    assert.equal(outbox.recoverExpiredLeases({ sourceInstanceId: "src-1" }), 1);
    assert.equal(outbox.summary({ sourceInstanceId: "src-1" }).ready, 1);
    assert.equal(outbox.summary({ sourceInstanceId: "src-2" }).leased, 1);
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox.summary aggregates large queues with one SQL pass", async () => {
  let now = new Date("2026-05-19T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path: await tempOutboxPath() });
  try {
    const sourceInstanceId = "src-bulk";
    const futureBackoff = new Date("2026-05-19T13:00:00.000Z");
    for (let index = 0; index < 250; index++) {
      outbox.enqueue({
        id: `${sourceInstanceId}:record_batch:${index}`,
        kind: "record_batch",
        payload: { records: [{ key: `m-${index}` }] },
        sourceInstanceId,
      });
    }
    // 50 of them get pushed into "retrying" (status=ready, next_attempt_at in the future)
    for (let index = 0; index < 50; index++) {
      const [claim] = outbox.claimReady({ holder: "worker-bulk", leaseMs: 60_000, sourceInstanceId });
      assert.ok(claim);
      outbox.failRetryable({
        error: "503",
        holder: "worker-bulk",
        id: claim.id,
        leaseEpoch: claim.lease_epoch,
        retryBackoffMs: futureBackoff.getTime() - now.getTime(),
      });
    }
    // 20 succeed.
    for (let index = 0; index < 20; index++) {
      const [claim] = outbox.claimReady({ holder: "worker-bulk", leaseMs: 60_000, sourceInstanceId });
      assert.ok(claim);
      outbox.acknowledge({ holder: "worker-bulk", id: claim.id, leaseEpoch: claim.lease_epoch });
    }
    // 5 currently leased; advance clock so 3 of them become stale.
    const longLease: { id: string; epoch: number }[] = [];
    for (let index = 0; index < 5; index++) {
      const [claim] = outbox.claimReady({
        holder: "worker-bulk",
        leaseMs: index < 3 ? 1000 : 60_000,
        sourceInstanceId,
      });
      assert.ok(claim);
      longLease.push({ epoch: claim.lease_epoch, id: claim.id });
    }
    now = new Date("2026-05-19T12:00:02.000Z");

    const summary = outbox.summary({ sourceInstanceId });
    // 250 enqueued total
    assert.equal(summary.total, 250);
    // 20 succeeded
    assert.equal(summary.succeeded, 20);
    // 5 still leased
    assert.equal(summary.leased, 5);
    // 3 of the leases have expired
    assert.equal(summary.staleLeases, 3);
    // 50 retrying (their next_attempt_at is in the future)
    assert.equal(summary.retrying, 50);
    // ready = total - succeeded - leased - deadLetter = 250 - 20 - 5 = 225
    assert.equal(summary.ready, 225);
    assert.equal(summary.deadLetter, 0);
    assert.ok(summary.oldestReadyAt);
    // The aggregate summary must agree with the slow per-row computation:
    const items = outbox.list({ sourceInstanceId });
    const slow = {
      deadLetter: items.filter((i) => i.status === "dead_letter").length,
      leased: items.filter((i) => i.status === "leased").length,
      ready: items.filter((i) => i.status === "ready").length,
      succeeded: items.filter((i) => i.status === "succeeded").length,
    };
    assert.equal(summary.ready, slow.ready);
    assert.equal(summary.leased, slow.leased);
    assert.equal(summary.succeeded, slow.succeeded);
    assert.equal(summary.deadLetter, slow.deadLetter);
    // Avoid unused-var warning
    assert.equal(longLease.length, 5);
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox.summary scopes by source instance without scanning others", async () => {
  const outbox = new LocalDeviceOutbox({ path: await tempOutboxPath() });
  try {
    outbox.enqueue({ id: "src-a:r:1", kind: "record_batch", payload: { x: 1 }, sourceInstanceId: "src-a" });
    outbox.enqueue({ id: "src-a:r:2", kind: "record_batch", payload: { x: 2 }, sourceInstanceId: "src-a" });
    outbox.enqueue({ id: "src-b:r:1", kind: "record_batch", payload: { x: 3 }, sourceInstanceId: "src-b" });
    assert.equal(outbox.summary({ sourceInstanceId: "src-a" }).total, 2);
    assert.equal(outbox.summary({ sourceInstanceId: "src-b" }).total, 1);
    assert.equal(outbox.summary().total, 3);
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox exposes payload-light production queries for large retained queues", async () => {
  const outbox = new LocalDeviceOutbox({ path: await tempOutboxPath() });
  try {
    outbox.enqueue({
      id: "src-a:batch:1",
      kind: "record_batch",
      payload: { batchSeq: 41, records: [{ key: "a", value: "x".repeat(10_000) }] },
      sourceInstanceId: "src-a",
    });
    outbox.enqueue({
      id: "src-a:batch:2",
      kind: "record_batch",
      payload: { batchSeq: 42, records: [{ key: "b", value: "y".repeat(10_000) }] },
      sourceInstanceId: "src-a",
    });
    outbox.enqueue({
      id: "src-a:gap:1",
      kind: "gap",
      payload: { reason: "policy_budget", retryable: true },
      sourceInstanceId: "src-a",
    });
    outbox.enqueue({
      id: "src-b:batch:1",
      kind: "record_batch",
      payload: { batchSeq: 99, records: [{ key: "other-source" }] },
      sourceInstanceId: "src-b",
    });

    const [first] = outbox.claimReady({ holder: "worker-a", leaseMs: 60_000, sourceInstanceId: "src-a" });
    assert.ok(first);
    outbox.acknowledge({ holder: "worker-a", id: first.id, leaseEpoch: first.lease_epoch });

    assert.equal(outbox.maxRecordBatchSeq({ sourceInstanceId: "src-a" }), 42);
    assert.equal(outbox.countOpenGaps({ sourceInstanceId: "src-a" }), 1);
    assert.equal(outbox.hasNonSucceededWork({ excludeKinds: ["gap"], sourceInstanceId: "src-a" }), true);
    assert.equal(
      outbox.hasNonSucceededPredecessor({
        beforeInsertOrder: Number.MAX_SAFE_INTEGER,
        kinds: ["record_batch", "gap"],
        sourceInstanceId: "src-a",
      }),
      true
    );
    assert.deepEqual(
      outbox
        .listByKind({ kind: "gap", sourceInstanceId: "src-a", statuses: ["ready", "leased"] })
        .map((item) => item.id),
      ["src-a:gap:1"]
    );
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox preserves gap rows durably with source-instance scoping and lifecycle transitions", async () => {
  let now = new Date("2026-05-19T12:00:00.000Z");
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ clock: () => now, path });
  try {
    outbox.enqueue({
      id: "src-1:gap:policy-budget",
      kind: "gap",
      payload: {
        connectorId: "fixture",
        firstSeenAt: now.toISOString(),
        nextAttemptBackoffMs: 60_000,
        reason: "policy_budget",
        retryable: true,
        sourceInstanceId: "src-1",
      },
      sourceInstanceId: "src-1",
    });
    outbox.enqueue({
      id: "src-2:gap:other",
      kind: "gap",
      payload: {
        connectorId: "fixture",
        firstSeenAt: now.toISOString(),
        nextAttemptBackoffMs: 60_000,
        reason: "connector_child_failure",
        retryable: true,
        sourceInstanceId: "src-2",
      },
      sourceInstanceId: "src-2",
    });

    // Source-instance scoping: claims only see the right instance's gap row.
    const claimedOther = outbox.claimReady({
      holder: "worker-a",
      leaseMs: 30_000,
      sourceInstanceId: "src-1",
    });
    assert.equal(claimedOther.length, 1);
    assert.equal(claimedOther[0]?.kind, "gap");
    assert.equal(claimedOther[0]?.id, "src-1:gap:policy-budget");

    // Retryable transition: a gap row can be failed retryable like any other kind.
    const firstClaim = claimedOther[0];
    assert.ok(firstClaim, "expected claimed gap row");
    outbox.failRetryable({
      error: "destination not ready",
      holder: "worker-a",
      id: firstClaim.id,
      leaseEpoch: firstClaim.lease_epoch,
      retryBackoffMs: 60_000,
    });
    const afterFail = outbox.get("src-1:gap:policy-budget");
    assert.equal(afterFail?.status, "ready");
    assert.equal(afterFail?.attempt_count, 1);
    assert.equal(afterFail?.next_attempt_at, "2026-05-19T12:01:00.000Z");

    // Dead-letter transition is reachable when terminal (e.g. malformed gap).
    now = new Date("2026-05-19T12:01:01.000Z");
    const reclaimed = outbox.claimReady({ holder: "worker-a", leaseMs: 30_000, sourceInstanceId: "src-1" });
    const reclaim = reclaimed[0];
    assert.ok(reclaim, "expected reclaim of the gap row");
    assert.equal(reclaim.kind, "gap");
    outbox.deadLetter({
      error: "terminal",
      holder: "worker-a",
      id: reclaim.id,
      leaseEpoch: reclaim.lease_epoch,
    });
    const afterDead = outbox.get("src-1:gap:policy-budget");
    assert.equal(afterDead?.status, "dead_letter");
    assert.equal(outbox.summary({ sourceInstanceId: "src-1" }).deadLetter, 1);
    assert.equal(outbox.summary({ sourceInstanceId: "src-2" }).ready, 1);

    outbox.close();
    // Durable: a fresh process must observe both gap rows.
    const reopened = new LocalDeviceOutbox({ clock: () => now, path });
    try {
      const items = reopened.list();
      assert.equal(items.length, 2);
      const kinds = items.map((i) => i.kind).sort();
      assert.deepEqual(kinds, ["gap", "gap"]);
      const payload = items.find((i) => i.id === "src-2:gap:other")?.payload as { reason: string };
      assert.equal(payload.reason, "connector_child_failure");
    } finally {
      reopened.close();
    }
  } catch (err) {
    outbox.close();
    throw err;
  }
});

test("LocalDeviceOutbox.deadLetterErrorSummary groups by redacted error class with counts", async () => {
  const outbox = new LocalDeviceOutbox({
    clock: fixedClock("2026-05-19T12:00:00.000Z"),
    path: await tempOutboxPath(),
  });
  try {
    // Three rows fail with the same server-rejection shape, one with a
    // distinct transport error, one with a host path that must be scrubbed.
    const rows: [string, string][] = [
      ["src-1:record_batch:1", "local device request failed: 400 invalid_request"],
      ["src-1:record_batch:2", "local device request failed: 400 invalid_request"],
      ["src-1:record_batch:3", "local device request failed: 400 invalid_request"],
      ["src-1:record_batch:4", "fetch failed: ECONNREFUSED"],
      ["src-1:record_batch:5", "ENOENT: no such file /home/user/.local/state/pdpp/x.sqlite"],
    ];
    for (const [id, error] of rows) {
      outbox.enqueue({ id, kind: "record_batch", payload: { id }, sourceInstanceId: "src-1" });
      const [claim] = outbox.claimReady({ holder: "w", leaseMs: 60_000, sourceInstanceId: "src-1" });
      assert.ok(claim);
      outbox.deadLetter({ error, holder: "w", id: claim.id, leaseEpoch: claim.lease_epoch });
    }

    const summary = outbox.deadLetterErrorSummary({ sourceInstanceId: "src-1" });
    assert.equal(summary.dead_letter_count, 5);
    assert.equal(summary.null_error_count, 0);
    // Most common class first, with its count collapsed across the 3 rows.
    assert.equal(summary.top_classes[0]?.error_class, "local device request failed: 400 invalid_request");
    assert.equal(summary.top_classes[0]?.count, 3);
    // The host path must be scrubbed in the surfaced class.
    const pathClass = summary.top_classes.find((c) => c.error_class.includes("ENOENT"));
    assert.ok(pathClass, "expected an ENOENT class");
    assert.ok(!pathClass?.error_class.includes("/home/user"), "host path must be redacted");
    assert.ok(pathClass?.error_class.includes("[PATH]"), "host path must be replaced with [PATH]");
  } finally {
    outbox.close();
  }
});

test("LocalDeviceOutbox.deadLetterErrorSummary is empty on a clean outbox", async () => {
  const outbox = new LocalDeviceOutbox({ path: await tempOutboxPath() });
  try {
    outbox.enqueue({ id: "src-1:record_batch:1", kind: "record_batch", payload: { k: 1 }, sourceInstanceId: "src-1" });
    const summary = outbox.deadLetterErrorSummary({ sourceInstanceId: "src-1" });
    assert.equal(summary.dead_letter_count, 0);
    assert.equal(summary.null_error_count, 0);
    assert.deepEqual(summary.top_classes, []);
  } finally {
    outbox.close();
  }
});

test("classifyDeadLetterError preserves status shape and scrubs secrets, paths, and volatile ids", () => {
  // HTTP status code (3 digits) survives so the class stays readable.
  assert.equal(
    classifyDeadLetterError("local device request failed: 400 invalid_request"),
    "local device request failed: 400 invalid_request"
  );
  // Credential markers are redacted.
  assert.equal(
    classifyDeadLetterError("auth error authorization=Bearer-supersecretvalue123456789 denied").includes("supersecret"),
    false
  );
  // 6-digit OTP-shaped runs are redacted.
  assert.ok(classifyDeadLetterError("otp mismatch 482913").includes("[REDACTED_OTP]"));
  // Long volatile ids and multi-digit sequence numbers collapse so classes group.
  const a = classifyDeadLetterError("batch 1780341172584 rejected for run abcdef0123456789");
  const b = classifyDeadLetterError("batch 1780341199999 rejected for run 99887766aabbccdd");
  assert.equal(a, b, "structurally identical errors must collapse to one class");
  assert.equal(a, "batch [ID] rejected for run [ID]");
  // Only the first line is used.
  assert.equal(classifyDeadLetterError("first line\nsecond line with /root/secret"), "first line");
});

async function tempOutboxPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pdpp-local-outbox-")), "outbox.sqlite");
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}
