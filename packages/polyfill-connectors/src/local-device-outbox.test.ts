import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("LocalDeviceOutbox requeues dead letters by redacted error class", async () => {
  const outbox = new LocalDeviceOutbox({ path: await tempOutboxPath() });
  const sourceInstanceId = "src-1";
  try {
    for (const [id, error] of [
      ["src-1:record_batch:502", "local device request failed: 502"],
      ["src-1:record_batch:timeout", "local device request timed out after 30000ms"],
      ["src-1:record_batch:400", "local device request failed: 400 invalid_request"],
    ] as const) {
      outbox.enqueue({
        id,
        kind: "record_batch",
        payload: { id },
        sourceInstanceId,
      });
      const [claim] = outbox.claimReady({ holder: "worker-a", leaseMs: 60_000, sourceInstanceId });
      assert.ok(claim);
      outbox.deadLetter({
        error,
        holder: "worker-a",
        id: claim.id,
        leaseEpoch: claim.lease_epoch,
      });
    }

    const transientClassPattern =
      /^(?:local device request failed: (?:408|429|5\d\d)(?:\b|$)|local device request timed out after\b)/i;

    assert.deepEqual(
      outbox.requeueDeadLetters({
        dryRun: true,
        errorClassPattern: transientClassPattern,
        sourceInstanceId,
      }),
      { matched: 2, requeued: 0 }
    );

    assert.deepEqual(
      outbox.requeueDeadLetters({
        errorClassPattern: transientClassPattern,
        sourceInstanceId,
      }),
      { matched: 2, requeued: 2 }
    );

    assert.equal(outbox.get("src-1:record_batch:502")?.status, "ready");
    assert.equal(outbox.get("src-1:record_batch:timeout")?.status, "ready");
    assert.equal(outbox.get("src-1:record_batch:400")?.status, "dead_letter");
    assert.equal(outbox.summary({ sourceInstanceId }).deadLetter, 1);
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

test("hasObservedStream / countRecordBatches detect coverage records across statuses and ignore dead letters", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // A drained content batch carrying a coverage_diagnostics record.
    outbox.enqueue({
      id: "rb-coverage",
      kind: "record_batch",
      payload: {
        records: [
          { data: { id: "s-1" }, stream: "sessions" },
          { data: { id: "c-1" }, stream: "coverage_diagnostics" },
        ],
      },
      sourceInstanceId: "src-1",
    });
    const [claim] = outbox.claimReady({ holder: "w", leaseMs: 60_000, sourceInstanceId: "src-1" });
    assert.ok(claim);
    outbox.acknowledge({ holder: "w", id: claim.id, leaseEpoch: claim.lease_epoch });

    // Coverage observation survives a clean drain (succeeded rows are retained).
    assert.equal(outbox.hasObservedStream({ sourceInstanceId: "src-1", stream: "coverage_diagnostics" }), true);
    assert.equal(outbox.hasObservedStream({ sourceInstanceId: "src-1", stream: "messages" }), false);
    assert.equal(outbox.countRecordBatches({ sourceInstanceId: "src-1" }), 1);

    // Isolation: a different source instance sees none of this.
    assert.equal(outbox.hasObservedStream({ sourceInstanceId: "src-2", stream: "coverage_diagnostics" }), false);
    assert.equal(outbox.countRecordBatches({ sourceInstanceId: "src-2" }), 0);

    // A coverage record that only ever dead-lettered must NOT count, and a
    // dead-letter record batch is excluded from the record-batch count.
    outbox.enqueue({
      id: "rb-dl",
      kind: "record_batch",
      payload: { records: [{ data: { id: "c-2" }, stream: "coverage_diagnostics" }] },
      sourceInstanceId: "src-3",
    });
    const [dlClaim] = outbox.claimReady({ holder: "w", leaseMs: 60_000, sourceInstanceId: "src-3" });
    assert.ok(dlClaim);
    outbox.deadLetter({ error: "terminal", holder: "w", id: dlClaim.id, leaseEpoch: dlClaim.lease_epoch });
    assert.equal(outbox.hasObservedStream({ sourceInstanceId: "src-3", stream: "coverage_diagnostics" }), false);
    assert.equal(outbox.countRecordBatches({ sourceInstanceId: "src-3" }), 0);
  } finally {
    outbox.close();
  }
});

test("enqueue maintains the observed-stream index so coverage detection never reparses payloads", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id: "rb-1",
      kind: "record_batch",
      payload: {
        records: [
          { data: { id: "s-1" }, stream: "sessions" },
          { data: { id: "c-1" }, stream: "coverage_diagnostics" },
        ],
      },
      sourceInstanceId: "src-1",
    });
  } finally {
    outbox.close();
  }

  // Prove the probe reads the index, not the payload: blank out payload_json
  // for the row out-of-band. A payload-scanning implementation would now miss
  // the stream; the index-backed one still answers true.
  const raw = new DatabaseSync(path);
  try {
    const indexRows = raw
      .prepare("SELECT stream FROM local_device_observed_stream WHERE source_instance_id = ? ORDER BY stream")
      .all("src-1")
      .map((row) => (row as { stream: string }).stream);
    assert.deepEqual(indexRows, ["coverage_diagnostics", "sessions"]);
    raw.prepare("UPDATE local_device_outbox SET payload_json = '{}' WHERE id = ?").run("rb-1");
  } finally {
    raw.close();
  }

  const reopened = new LocalDeviceOutbox({ path });
  try {
    assert.equal(reopened.hasObservedStream({ sourceInstanceId: "src-1", stream: "coverage_diagnostics" }), true);
    assert.equal(reopened.hasObservedStream({ sourceInstanceId: "src-1", stream: "messages" }), false);
  } finally {
    reopened.close();
  }
});

test("a record_batch carrying no records is indexed (sentinel) and never treated as legacy unindexed", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({ id: "rb-empty", kind: "record_batch", payload: { records: [] }, sourceInstanceId: "src-1" });
  } finally {
    outbox.close();
  }
  const raw = new DatabaseSync(path);
  try {
    const count = raw
      .prepare("SELECT COUNT(*) AS n FROM local_device_observed_stream WHERE outbox_id = ?")
      .get("rb-empty") as { n: number | bigint };
    assert.equal(Number(count.n), 1, "an empty-records batch must still carry one sentinel index row");
  } finally {
    raw.close();
  }
});

test("hasObservedStream backfills a legacy (pre-index) outbox within budget and answers exactly", async () => {
  const path = await tempOutboxPath();
  // Build a legacy v1 outbox (no observed-stream index table) directly.
  seedLegacyV1Outbox(path, [
    { id: "legacy-1", sourceInstanceId: "src-1", streams: ["sessions"] },
    { id: "legacy-2", sourceInstanceId: "src-1", streams: ["coverage_diagnostics"] },
    { id: "legacy-3", sourceInstanceId: "src-2", streams: ["messages"] },
  ]);

  const outbox = new LocalDeviceOutbox({ path });
  try {
    // The schema upgrade backfilled the index from the legacy rows.
    assert.equal(outbox.hasObservedStream({ sourceInstanceId: "src-1", stream: "coverage_diagnostics" }), true);
    assert.equal(outbox.hasObservedStream({ sourceInstanceId: "src-1", stream: "sessions" }), true);
    assert.equal(outbox.hasObservedStream({ sourceInstanceId: "src-1", stream: "messages" }), false);
    // Source isolation survives the migration.
    assert.equal(outbox.hasObservedStream({ sourceInstanceId: "src-2", stream: "coverage_diagnostics" }), false);
    assert.equal(outbox.countRecordBatches({ sourceInstanceId: "src-1" }), 2);
  } finally {
    outbox.close();
  }
});

test("hasObservedStream is bounded on a giant legacy outbox: over-budget unindexed backlog returns null", async () => {
  const path = await tempOutboxPath();
  const budget = 5000;
  // Seed more unindexed legacy rows for one lane than the bounded scan budget,
  // none on the queried stream. Opening the DB does NO payload work (the index
  // is populated lazily), so all of these are unindexed at probe time. A
  // payload-scanning probe would reparse all of them; the bounded one must
  // refuse and return null rather than scan unboundedly.
  const seed = Array.from({ length: budget + 50 }, (_value, index) => ({
    id: `legacy-${index}`,
    sourceInstanceId: "src-big",
    streams: ["messages"],
  }));
  seedLegacyV1Outbox(path, seed);

  const outbox = new LocalDeviceOutbox({ path });
  try {
    // The queried stream was never present, and the unindexed backlog exceeds
    // the budget, so the probe reports "unknown" instead of a false negative
    // from a partial scan.
    assert.equal(outbox.hasObservedStream({ sourceInstanceId: "src-big", stream: "coverage_diagnostics" }), null);
  } finally {
    outbox.close();
  }
});

test("countRecordBatches reads indexed status/kind columns only and ignores dead letters", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({ id: "rb-a", kind: "record_batch", payload: { records: [] }, sourceInstanceId: "src-1" });
    outbox.enqueue({ id: "rb-b", kind: "record_batch", payload: { records: [] }, sourceInstanceId: "src-1" });
    outbox.enqueue({ id: "cp-1", kind: "checkpoint", payload: { state: 1 }, sourceInstanceId: "src-1" });
    const [claim] = outbox.claimReady({ holder: "w", leaseMs: 60_000, sourceInstanceId: "src-1" });
    assert.ok(claim);
    outbox.deadLetter({ error: "terminal", holder: "w", id: claim.id, leaseEpoch: claim.lease_epoch });
    // One of the two record batches dead-lettered; the checkpoint never counts.
    assert.equal(outbox.countRecordBatches({ sourceInstanceId: "src-1" }), 1);
  } finally {
    outbox.close();
  }
});

// --- compact / disk reclaim (local-collector-memory-slvp-v1) ---
//
// Invariant: prune deletes rows but the file never shrinks on its own
// (auto_vacuum=NONE); compact() runs VACUUM to return the freelist to disk
// without dropping any row — succeeded or unsent.

/**
 * Seed `count` succeeded record_batch rows carrying a ~2 KiB payload each so a
 * later prune leaves a large freelist the compact can reclaim. Returns once the
 * rows are committed.
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

test("compact reclaims the freelist a prune leaves behind (file shrinks) and preserves all rows", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-compact";
  // 4,000 fat succeeded rows (~8 MiB of payload) so the freelist after prune is
  // unmistakably large.
  seedFatSucceededRows(path, sourceInstanceId, 4000);
  const outbox = new LocalDeviceOutbox({ path });
  try {
    const sizeFull = statSync(path).size;

    // Prune all but the most-recent 100. The file does NOT shrink: deleted rows
    // become freelist pages (auto_vacuum=NONE), which is the whole motivation.
    const pruned = outbox.pruneSent({ dryRun: false, keepCount: 100, sourceInstanceId });
    assert.equal(pruned.pruned, 3900);
    const sizeAfterPrune = statSync(path).size;
    assert.equal(sizeAfterPrune, sizeFull, "prune alone must NOT shrink the file (auto_vacuum=NONE)");

    const before = outbox.pageStats();
    assert.ok(before.freelistPages > 0, "prune must leave reclaimable free pages");
    assert.equal(before.reclaimableBytes, before.freelistPages * before.pageSizeBytes);

    const result = outbox.compact();
    assert.ok(result.reclaimedBytes > 0, "compact must return bytes to the filesystem");
    assert.ok(result.after.pageCount < result.before.pageCount, "page count must drop");
    assert.equal(result.after.freelistPages, 0, "freelist is emptied by the rebuild");

    const sizeAfterCompact = statSync(path).size;
    assert.ok(sizeAfterCompact < sizeAfterPrune, "compact must shrink the on-disk file");

    // Every retained row survived the rebuild.
    assert.equal(outbox.summary({ sourceInstanceId }).succeeded, 100);
  } finally {
    outbox.close();
  }
});

test("compact preserves unsent (ready/leased/dead-letter) rows — VACUUM is lossless", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-compact-unsent";
  const holder = "holder-compact";
  const outbox = new LocalDeviceOutbox({ clock: () => new Date("2026-06-04T00:00:00.000Z"), path });
  try {
    // Fat succeeded rows to create a freelist, then prune them.
    seedFatSucceededRows(path, sourceInstanceId, 1000);
    const reopened = new LocalDeviceOutbox({ path });
    reopened.pruneSent({ dryRun: false, keepCount: 0, sourceInstanceId });
    reopened.close();

    // Live unsent work that must survive the rebuild.
    outbox.enqueue({ id: "u:ready", kind: "record_batch", payload: { records: [] }, sourceInstanceId });
    outbox.enqueue({ id: "u:dead", kind: "record_batch", payload: { records: [] }, sourceInstanceId });
    const claimed = outbox.claimReady({ holder, leaseMs: 600_000, limit: 2, sourceInstanceId });
    const dead = claimed.find((item) => item.id === "u:dead");
    const ready = claimed.find((item) => item.id === "u:ready");
    assert.ok(dead && ready);
    outbox.deadLetter({ error: "terminal", holder, id: dead.id, leaseEpoch: dead.lease_epoch });
    // Leave u:ready leased (in flight) so a leased row is present at compact time.

    assert.ok(outbox.countNonSucceeded() >= 2, "ready/leased/dead-letter rows are counted as non-succeeded");

    outbox.compact();

    const after = outbox.summary({ sourceInstanceId });
    assert.equal(after.deadLetter, 1, "dead-letter row survives the rebuild");
    assert.equal(after.leased, 1, "leased row survives the rebuild");
    // The leased row's payload is intact and re-readable.
    const readyRow = outbox.get("u:ready");
    assert.ok(readyRow, "leased row is still present by id after compact");
    assert.equal(readyRow.status, "leased");
  } finally {
    outbox.close();
  }
});

test("countNonSucceeded counts ready/leased/dead-letter across all sources, ignoring succeeded", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ clock: () => new Date("2026-06-04T00:00:00.000Z"), path });
  try {
    // One succeeded row on src-a (does not count).
    outbox.enqueue({ id: "a:sent", kind: "record_batch", payload: { records: [] }, sourceInstanceId: "src-a" });
    const [sent] = outbox.claimReady({ holder: "w", leaseMs: 600_000, sourceInstanceId: "src-a" });
    assert.ok(sent);
    outbox.acknowledge({ holder: "w", id: sent.id, leaseEpoch: sent.lease_epoch });
    // Ready rows on two different sources (both count).
    outbox.enqueue({ id: "a:ready", kind: "record_batch", payload: { records: [] }, sourceInstanceId: "src-a" });
    outbox.enqueue({ id: "b:ready", kind: "record_batch", payload: { records: [] }, sourceInstanceId: "src-b" });

    assert.equal(outbox.countNonSucceeded(), 2, "both ready rows count; the succeeded row does not");
  } finally {
    outbox.close();
  }
});

test("compact on an already-tight file reclaims ~nothing and keeps every row", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-tight";
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({ id: "keep-1", kind: "record_batch", payload: { records: [] }, sourceInstanceId });
    const before = outbox.pageStats();
    const result = outbox.compact();
    // Nothing was deleted, so there is no meaningful freelist to reclaim.
    assert.equal(result.reclaimedBytes >= 0, true);
    assert.ok(result.after.pageCount <= before.pageCount + 1, "tight file does not grow materially");
    assert.equal(outbox.summary({ sourceInstanceId }).ready, 1, "the one row survives");
  } finally {
    outbox.close();
  }
});

async function tempOutboxPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pdpp-local-outbox-")), "outbox.sqlite");
}

/**
 * Seed a schema-v1 (pre-observed-stream-index) outbox file directly, so tests
 * can exercise the legacy backfill / bounded-scan fallback. Mirrors the v1
 * table DDL and inserts `record_batch` rows whose payloads carry the given
 * stream names — but creates NO `local_device_observed_stream` table, exactly
 * as a database created before this index existed would look.
 */
function seedLegacyV1Outbox(
  path: string,
  rows: ReadonlyArray<{ id: string; sourceInstanceId: string; streams: readonly string[] }>
): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE local_device_outbox (
        id TEXT PRIMARY KEY,
        source_instance_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_holder TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_until TEXT,
        last_error TEXT,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const insert = db.prepare(
      `INSERT INTO local_device_outbox (
         id, source_instance_id, kind, status, payload_json, body_hash,
         attempt_count, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'record_batch', 'succeeded', ?, 'hash', 0, ?, ?, ?)`
    );
    const stamp = "2026-05-19T12:00:00.000Z";
    for (const row of rows) {
      const payload = JSON.stringify({
        records: row.streams.map((stream, index) => ({ data: { id: `${stream}-${index}` }, stream })),
      });
      insert.run(row.id, row.sourceInstanceId, payload, stamp, stamp, stamp);
    }
  } finally {
    db.close();
  }
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

/**
 * Bulk-insert `count` succeeded `record_batch` rows directly into a current
 * (v2) outbox file, fast enough to seed past SQLite's per-statement variable
 * limit. Opening a `LocalDeviceOutbox` first creates the v2 schema; the raw
 * inserts then mirror what an acknowledged drain leaves behind, without the
 * per-row hashing/index cost of 30k+ real enqueues.
 */
function seedSucceededRows(path: string, sourceInstanceId: string, count: number): void {
  new LocalDeviceOutbox({ path }).close();
  const db = new DatabaseSync(path);
  try {
    const insert = db.prepare(
      `INSERT INTO local_device_outbox (
         id, source_instance_id, kind, status, payload_json, body_hash,
         attempt_count, next_attempt_at, acknowledged_at, created_at, updated_at
       ) VALUES (?, ?, 'record_batch', 'succeeded', '{"records":[]}', 'hash', 0, ?, ?, ?, ?)`
    );
    const stamp = "2026-05-19T12:00:00.000Z";
    db.exec("BEGIN");
    for (let index = 0; index < count; index++) {
      insert.run(`${sourceInstanceId}:row:${index}`, sourceInstanceId, stamp, stamp, stamp, stamp);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

test("pruneSent deletes a backlog larger than SQLite's per-statement variable limit", async () => {
  // The live incident shape: ~170k succeeded rows. A single
  // `DELETE ... WHERE id IN (...)` over that set throws "too many SQL
  // variables" (limit ~32,766). pruneSent must chunk and delete them all.
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-huge";
  // One over the variable limit is enough to force >1 chunk and prove the
  // single-statement path would have failed.
  const total = 32_767 + 10;
  seedSucceededRows(path, sourceInstanceId, total);

  const outbox = new LocalDeviceOutbox({ path });
  try {
    assert.equal(outbox.summary({ sourceInstanceId }).succeeded, total);
    const result = outbox.pruneSent({ dryRun: false, keepCount: 0, sourceInstanceId });
    assert.equal(result.matched, total);
    assert.equal(result.pruned, total);
    assert.equal(outbox.summary({ sourceInstanceId }).succeeded, 0);
  } finally {
    outbox.close();
  }
});

test("requeueDeadLetters requeues a backlog larger than the per-statement variable limit", async () => {
  const path = await tempOutboxPath();
  const sourceInstanceId = "src-dl-huge";
  const total = 32_767 + 5;
  // Seed dead-letter rows directly (status override) on the current schema.
  new LocalDeviceOutbox({ path }).close();
  const db = new DatabaseSync(path);
  try {
    const insert = db.prepare(
      `INSERT INTO local_device_outbox (
         id, source_instance_id, kind, status, payload_json, body_hash,
         attempt_count, next_attempt_at, last_error, created_at, updated_at
       ) VALUES (?, ?, 'record_batch', 'dead_letter', '{"records":[]}', 'hash', 5, ?, '400', ?, ?)`
    );
    const stamp = "2026-05-19T12:00:00.000Z";
    db.exec("BEGIN");
    for (let index = 0; index < total; index++) {
      insert.run(`${sourceInstanceId}:dl:${index}`, sourceInstanceId, stamp, stamp, stamp);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }

  const outbox = new LocalDeviceOutbox({ path });
  try {
    const result = outbox.requeueDeadLetters({ sourceInstanceId });
    assert.equal(result.matched, total);
    assert.equal(result.requeued, total);
    assert.equal(outbox.summary({ sourceInstanceId }).deadLetter, 0);
    assert.equal(outbox.summary({ sourceInstanceId }).ready, total);
  } finally {
    outbox.close();
  }
});
