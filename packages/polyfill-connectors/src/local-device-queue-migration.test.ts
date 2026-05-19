import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalDeviceOutbox } from "./local-device-outbox.ts";
import { importLegacyLocalDeviceQueue, inspectLegacyLocalDeviceQueue } from "./local-device-queue-migration.ts";

test("inspectLegacyLocalDeviceQueue reports a missing queue as empty", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "pdpp-legacy-queue-")), "missing.json");
  const report = await inspectLegacyLocalDeviceQueue(path);
  assert.equal(report.exists, false);
  assert.equal(report.total, 0);
  assert.equal(report.importable, 0);
});

test("importLegacyLocalDeviceQueue imports pending and in-flight work then quarantines the legacy file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-legacy-queue-"));
  const queuePath = join(dir, "queue.json");
  const quarantinePath = join(dir, "queue.json.quarantine");
  await writeFile(
    queuePath,
    `${JSON.stringify(
      {
        items: [
          legacyItem({ batchId: "batch-pending", status: "pending" }),
          legacyItem({ batchId: "batch-in-flight", status: "in_flight" }),
          legacyItem({ batchId: "batch-sent", status: "sent" }),
          legacyItem({ batchId: "batch-dead", status: "permanent_failure" }),
          { batch_id: 123, status: "pending" },
        ],
      },
      null,
      2
    )}\n`
  );
  const outbox = new LocalDeviceOutbox({ path: join(dir, "outbox.sqlite") });
  try {
    const inspected = await inspectLegacyLocalDeviceQueue(queuePath);
    assert.equal(inspected.exists, true);
    assert.equal(inspected.total, 5);
    assert.equal(inspected.importable, 2);
    assert.equal(inspected.sent, 1);
    assert.equal(inspected.permanentFailure, 1);
    assert.equal(inspected.invalid, 1);

    const result = await importLegacyLocalDeviceQueue({
      outbox,
      quarantinePath,
      queuePath,
    });
    assert.equal(result.imported, 2);
    assert.equal(result.quarantinePath, quarantinePath);
    assert.equal(outbox.summary().ready, 2);
    assert.equal(
      outbox.list().every((item) => item.kind === "record_batch"),
      true
    );
    assert.equal(
      outbox.list().every((item) => item.source_instance_id === "src-1"),
      true
    );

    const quarantined = await readFile(quarantinePath, "utf8");
    assert.match(quarantined, /batch-pending/);
    await assert.rejects(() => readFile(queuePath, "utf8"), /ENOENT/);
  } finally {
    outbox.close();
  }
});

test("inspectLegacyLocalDeviceQueue treats malformed top-level items as invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-legacy-queue-"));
  const queuePath = join(dir, "queue.json");
  await writeFile(queuePath, `${JSON.stringify({ items: { batch_id: 123, status: "pending" } })}\n`);

  const inspected = await inspectLegacyLocalDeviceQueue(queuePath);
  assert.equal(inspected.exists, true);
  assert.equal(inspected.total, 1);
  assert.equal(inspected.importable, 0);
  assert.equal(inspected.invalid, 1);
});

function legacyItem(input: { batchId: string; status: "pending" | "in_flight" | "sent" | "permanent_failure" }) {
  return {
    available_at: "2026-05-19T12:00:00.000Z",
    batch_id: input.batchId,
    batch_seq: input.batchId === "batch-in-flight" ? 2 : 1,
    created_at: "2026-05-19T12:00:00.000Z",
    records: [
      {
        connector_id: "codex",
        data: { id: input.batchId },
        device_id: "device-1",
        emitted_at: "2026-05-19T12:00:00.000Z",
        record_key: input.batchId,
        source_instance_id: "src-1",
        stream: "messages",
      },
    ],
    retry_count: 0,
    source_instance_id: "src-1",
    status: input.status,
    updated_at: "2026-05-19T12:00:00.000Z",
  };
}
