// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executeRepair,
  type GmailTooLargeRepairArgs,
  parseArgs,
  validateArgs,
} from "../scripts/repair/settle-gmail-too-large-detail-gaps.ts";
import { closeDb, initDb } from "../server/db.ts";
import { createSqliteConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";

const CONNECTOR_INSTANCE_ID = "cin_repair_exact";
const NOW = "2026-08-02T13:00:00.000Z";
const LIMIT_ERROR = /from 1 to 500/;
const UNSUPPORTED_ARGUMENT_ERROR = /unsupported repair argument/;

function withTempDb(
  fn: (store: ReturnType<typeof createSqliteConnectorDetailGapStore>) => Promise<void>
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-gmail-repair-db-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn(createSqliteConnectorDetailGapStore());
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function repairArgs(apply: boolean): GmailTooLargeRepairArgs {
  return {
    apply,
    connectorId: "gmail",
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    errorClass: "too_large",
    limit: 100,
    stream: "attachments",
  };
}

test(
  "Gmail too_large repair is exact-scope, dry-run by default, idempotent, and cannot touch retryable rows",
  withTempDb(async (store) => {
    const right = await store.upsertPendingGap({
      connectorId: "gmail",
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      detailLocator: { attachment_id: "right:2", kind: "gmail.attachment_detail" },
      gapId: "gap-repair-right",
      grantId: "grant_repair",
      lastError: { class: "too_large", message: "attachment exceeds max size: 30062404 > 26214400 bytes" },
      now: NOW,
      parentStream: "messages",
      reason: "temporary_unavailable",
      recordKey: "right:2",
      stream: "attachments",
    });
    const retryable = await store.upsertPendingGap({
      connectorId: "gmail",
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      detailLocator: { attachment_id: "retry:2", kind: "gmail.attachment_detail" },
      gapId: "gap-repair-retryable",
      grantId: "grant_repair",
      lastError: { class: "imap_download_failed", message: "Connection not available" },
      now: NOW,
      parentStream: "messages",
      reason: "temporary_unavailable",
      recordKey: "retry:2",
      stream: "attachments",
    });
    const wrongStream = await store.upsertPendingGap({
      connectorId: "gmail",
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      detailLocator: { attachment_id: "wrong-stream:2", kind: "gmail.attachment_detail" },
      gapId: "gap-repair-wrong-stream",
      grantId: "grant_repair",
      lastError: { class: "too_large", message: "wrong stream" },
      now: NOW,
      parentStream: "messages",
      reason: "temporary_unavailable",
      recordKey: "wrong-stream:2",
      stream: "messages",
    });
    const wrongInstance = await store.upsertPendingGap({
      connectorId: "gmail",
      connectorInstanceId: "cin_other_instance",
      detailLocator: { attachment_id: "wrong-instance:2", kind: "gmail.attachment_detail" },
      gapId: "gap-repair-wrong-instance",
      grantId: "grant_repair",
      lastError: { class: "too_large", message: "wrong instance" },
      now: NOW,
      parentStream: "messages",
      reason: "temporary_unavailable",
      recordKey: "wrong-instance:2",
      stream: "attachments",
    });
    const wrongConnector = await store.upsertPendingGap({
      connectorId: "amazon",
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      detailLocator: { kind: "amazon.order_detail", order_id: "wrong-connector" },
      gapId: "gap-repair-wrong-connector",
      grantId: "grant_repair",
      lastError: { class: "too_large", message: "wrong connector" },
      now: NOW,
      parentStream: "orders",
      reason: "temporary_unavailable",
      recordKey: "wrong-connector",
      stream: "order_items",
    });
    assert.ok(right && retryable && wrongStream && wrongInstance && wrongConnector);

    const dryRun = await executeRepair(store, repairArgs(false), NOW);
    assert.deepEqual(dryRun, {
      applied: false,
      connector_id: "gmail",
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      emitted_at: NOW,
      error_class: "too_large",
      gap_ids: ["gap-repair-right"],
      limit: 100,
      matched: 1,
      object: "gmail_too_large_gap_settlement_receipt",
      stream: "attachments",
      terminalized: 0,
      version: 1,
    });
    assert.equal((await store.getGapById("gap-repair-right"))?.status, "pending");
    assert.equal((await store.getGapById("gap-repair-retryable"))?.status, "pending");

    const applied = await executeRepair(store, repairArgs(true), NOW);
    assert.deepEqual(applied, {
      applied: true,
      connector_id: "gmail",
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      emitted_at: NOW,
      error_class: "too_large",
      gap_ids: ["gap-repair-right"],
      limit: 100,
      matched: 1,
      object: "gmail_too_large_gap_settlement_receipt",
      stream: "attachments",
      terminalized: 1,
      version: 1,
    });
    const terminal = await store.getGapById("gap-repair-right");
    assert.ok(terminal);
    assert.equal(terminal.status, "terminal");
    assert.equal(terminal.reason, "too_large");
    assert.deepEqual(terminal.last_error, right.last_error);
    assert.equal((await store.getGapById("gap-repair-retryable"))?.status, "pending");
    assert.equal((await store.getGapById("gap-repair-wrong-stream"))?.status, "pending");
    assert.equal((await store.getGapById("gap-repair-wrong-instance"))?.status, "pending");
    assert.equal((await store.getGapById("gap-repair-wrong-connector"))?.status, "pending");

    const secondApply = await executeRepair(store, repairArgs(true), "2026-08-02T13:01:00.000Z");
    assert.equal(secondApply.matched, 0);
    assert.equal(secondApply.terminalized, 0);
    assert.deepEqual(secondApply.gap_ids, []);

    const laterUpsert = await store.upsertPendingGap({
      connectorId: "gmail",
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      detailLocator: { attachment_id: "right:2", changed: true, kind: "gmail.attachment_detail" },
      gapId: "gap-repair-right",
      grantId: "grant_repair",
      lastError: { class: "imap_download_failed", message: "Connection not available later" },
      lastRunId: "run_later",
      now: "2026-08-02T13:02:00.000Z",
      parentStream: "messages",
      reason: "temporary_unavailable",
      recordKey: "right:2",
      stream: "attachments",
    });
    assert.ok(laterUpsert);
    assert.equal(laterUpsert.status, "terminal");
    assert.equal(laterUpsert.reason, "too_large");
    assert.deepEqual(laterUpsert.last_error, right.last_error);
  })
);

test("Gmail too_large repair rejects omitted or broadened scopes before touching the store", () => {
  const valid = parseArgs([
    "--connector-id=gmail",
    `--connector-instance-id=${CONNECTOR_INSTANCE_ID}`,
    "--stream=attachments",
    "--class=too_large",
  ]);
  assert.equal(validateArgs(valid), null);
  const omittedClass = parseArgs([
    "--connector-id=gmail",
    `--connector-instance-id=${CONNECTOR_INSTANCE_ID}`,
    "--stream=attachments",
  ]);
  assert.equal(validateArgs(omittedClass), "--class=too_large is required");
  assert.equal(validateArgs({ ...valid, connectorId: "amazon" }), "--connector-id=gmail is required");
  assert.equal(validateArgs({ ...valid, stream: "messages" }), "--stream=attachments is required");
  assert.equal(validateArgs({ ...valid, errorClass: "imap_download_failed" }), "--class=too_large is required");
  assert.throws(() => parseArgs([...Object.keys({}), "--limit=501"]), LIMIT_ERROR);
  assert.throws(() => parseArgs(["--unknown=value"]), UNSUPPORTED_ARGUMENT_ERROR);
});
