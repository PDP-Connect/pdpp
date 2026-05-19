import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildLocalDeviceOutboxId, LocalDeviceOutbox } from "./local-device-outbox.ts";

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

async function tempOutboxPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pdpp-local-outbox-")), "outbox.sqlite");
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}
