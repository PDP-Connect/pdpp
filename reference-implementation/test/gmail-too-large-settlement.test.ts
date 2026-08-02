// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runConnector } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import { createSqliteConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";

const CONNECTOR_ID = "gmail";
const CONNECTOR_INSTANCE_ID = "cin_gmail_tail";
const GRANT_ID = "grant_gmail_tail";
const SEEDED_AT = "2026-08-02T12:00:00.000Z";
const POLICY_PROOF = {
  configured_limit_bytes: 26_214_400,
  kind: "gmail_attachment_too_large",
  observed_size_bytes: 30_062_404,
} as const;

const POLICY_ROWS = [
  ["1676747841192606552:2", "attachment exceeds max size: 29830196 > 26214400 bytes"],
  ["1664530199333491124:2", "attachment exceeds max size: 30062404 > 26214400 bytes"],
  ["1603990324753116597:2", "attachment exceeds max size: 29209135 > 26214400 bytes"],
  ["1604002995330049893:2", "attachment exceeds max size: 28957723 > 26214400 bytes"],
] as const;

interface ConnectorHandle {
  cleanup: () => void;
  connectorPath: string;
}

function createTerminalPolicyConnector(startPath: string): ConnectorHandle {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-gmail-too-large-connector-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const start = JSON.parse(line);
  if (start.type !== 'START') return;
  writeFileSync(${JSON.stringify(startPath)}, JSON.stringify(start), 'utf8');
  for (const gap of start.detail_gaps || []) {
    if (!String(gap.gap_id).startsWith('gmail-policy-')) continue;
    process.stdout.write(JSON.stringify({
      type: 'DETAIL_GAP',
      reference_only: true,
      status: 'terminal',
      retryable: false,
      stream: gap.stream,
      parent_stream: 'messages',
      record_key: gap.record_key,
      detail_locator: gap.detail_locator,
      reason: 'too_large',
      last_error: {
        class: 'too_large',
        message: gap.record_key === '1676747841192606552:2'
          ? 'attachment exceeds max size: 29830196 > 26214400 bytes'
          : gap.record_key === '1664530199333491124:2'
            ? 'attachment exceeds max size: 30062404 > 26214400 bytes'
            : gap.record_key === '1603990324753116597:2'
              ? 'attachment exceeds max size: 29209135 > 26214400 bytes'
              : 'attachment exceeds max size: 28957723 > 26214400 bytes'
      },
      detail: {
        class: 'too_large',
        policy_disposition: {
          kind: 'gmail_attachment_too_large',
          observed_size_bytes: 30062404,
          configured_limit_bytes: 26214400
        }
      },
      gap_id: gap.gap_id,
      lease_id: gap.lease_id
    }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.stdout.write('', () => process.exit(0));
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

function fakeAdmitRunConnection(input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}): Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return Promise.resolve({
    connectorId: input.connectorId,
    connectorInstanceId: input.connectorInstanceId ?? CONNECTOR_INSTANCE_ID,
    ownerSubjectId: input.ownerSubjectId ?? "owner_local",
  });
}

function withTempDb(
  fn: (store: ReturnType<typeof createSqliteConnectorDetailGapStore>) => Promise<void>
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-gmail-too-large-db-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn(createSqliteConnectorDetailGapStore());
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

test(
  "four served Gmail too_large rows terminalize, preserve evidence, and stop starving ordinary siblings",
  withTempDb(async (store) => {
    const policyGapIds: string[] = [];
    for (const [index, [recordKey, message]] of POLICY_ROWS.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential inserts preserve the diagnosis-shaped queue order under SQLite.
      const gap = await store.upsertPendingGap({
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        detailLocator: {
          attachment_id: recordKey,
          kind: "gmail.attachment_detail",
          message_id: recordKey.split(":")[0],
          part_index: recordKey.split(":")[1],
        },
        discoveredRunId: "run_preexisting",
        gapId: `gmail-policy-${String(index).padStart(2, "0")}`,
        grantId: GRANT_ID,
        lastError: { class: "too_large", message },
        lastRunId: "run_preexisting",
        now: SEEDED_AT,
        parentStream: "messages",
        reason: "temporary_unavailable",
        recordKey,
        scope: { streams: ["attachments"] },
        source: { id: CONNECTOR_ID, kind: "connector" },
        stream: "attachments",
      });
      assert.ok(gap);
      policyGapIds.push(gap.gap_id);
    }

    const siblingGapIds: string[] = [];
    for (let index = 0; index < 31; index += 1) {
      const recordKey = `gmail-sibling-${String(index).padStart(2, "0")}`;
      // biome-ignore lint/performance/noAwaitInLoops: Sequential inserts preserve the diagnosis-shaped queue order under SQLite.
      const gap = await store.upsertPendingGap({
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        detailLocator: { attachment_id: recordKey, kind: "gmail.attachment_detail" },
        discoveredRunId: "run_preexisting",
        gapId: `gmail-sibling-${String(index).padStart(2, "0")}`,
        grantId: GRANT_ID,
        lastError: { class: "imap_download_failed", message: "Connection not available" },
        lastRunId: "run_preexisting",
        now: SEEDED_AT,
        parentStream: "messages",
        reason: "temporary_unavailable",
        recordKey,
        scope: { streams: ["attachments"] },
        source: { id: CONNECTOR_ID, kind: "connector" },
        stream: "attachments",
      });
      assert.ok(gap);
      siblingGapIds.push(gap.gap_id);
    }

    const firstStartDir = mkdtempSync(join(tmpdir(), "pdpp-gmail-too-large-start-"));
    const firstStartPath = join(firstStartDir, "start.json");
    const firstConnector = createTerminalPolicyConnector(firstStartPath);
    let firstStart: { detail_gaps: Array<{ gap_id: string; lease_id?: string }> } | null = null;
    try {
      const firstRun = await runConnector({
        admitRunConnection: fakeAdmitRunConnection,
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        connectorPath: firstConnector.connectorPath,
        detailGapStore: store,
        grantId: GRANT_ID,
        manifest: { streams: [{ name: "attachments" }] },
        ownerToken: "owner",
        persistState: false,
        scope: { streams: [{ name: "attachments" }] },
      });
      assert.equal(firstRun.status, "succeeded");
      firstStart = JSON.parse(readFileSync(firstStartPath, "utf8")) as {
        detail_gaps: Array<{ gap_id: string; lease_id?: string }>;
      };
    } finally {
      firstConnector.cleanup();
      rmSync(firstStartDir, { force: true, recursive: true });
    }
    assert.ok(firstStart);
    assert.equal(
      firstStart.detail_gaps.length,
      35,
      "the diagnosis-shaped page must serve all four policy rows plus siblings"
    );
    assert.deepEqual(
      firstStart.detail_gaps.slice(0, 4).map((gap) => gap.gap_id),
      policyGapIds,
      "stable queue order serves the four policy rows at the head of the tail"
    );
    for (const [index, [recordKey, message]] of POLICY_ROWS.entries()) {
      const policyGapId = policyGapIds[index];
      assert.ok(policyGapId);
      // biome-ignore lint/performance/noAwaitInLoops: Each assertion reads one exact row so evidence failures identify the policy key.
      const gap = await store.getGapById(policyGapId);
      assert.ok(gap);
      assert.equal(gap.status, "terminal");
      assert.equal(gap.reason, "too_large");
      assert.equal(gap.attempt_count, 0, "policy settlement must not create provider attempt evidence");
      assert.equal(gap.lease_id, null);
      assert.equal(gap.recovered_run_id, null, "terminal policy settlement must not manufacture recovery evidence");
      assert.deepEqual(gap.last_error, { class: "too_large", message });
      assert.equal(gap.record_key, recordKey);
    }

    const pendingAfterFirstRun = await store.listPendingGaps({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      grantId: GRANT_ID,
      limit: 500,
      streams: ["attachments"],
    });
    assert.deepEqual(
      pendingAfterFirstRun.map((gap) => gap.gap_id),
      siblingGapIds,
      "terminal policy rows must leave the ordinary retryable sibling queue"
    );
    assert.ok(
      pendingAfterFirstRun.every((gap) => {
        const lastError = gap.last_error as { message?: unknown } | null;
        return gap.status === "pending" && lastError?.message === "Connection not available";
      }),
      "Connection not available siblings remain retryable"
    );

    const secondStartDir = mkdtempSync(join(tmpdir(), "pdpp-gmail-too-large-start-"));
    const secondStartPath = join(secondStartDir, "start.json");
    const secondConnector = createTerminalPolicyConnector(secondStartPath);
    let secondStart: { detail_gaps: Array<{ gap_id: string }> } | null = null;
    try {
      const secondRun = await runConnector({
        admitRunConnection: fakeAdmitRunConnection,
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        connectorPath: secondConnector.connectorPath,
        detailGapStore: store,
        grantId: GRANT_ID,
        manifest: { streams: [{ name: "attachments" }] },
        ownerToken: "owner",
        persistState: false,
        scope: { streams: [{ name: "attachments" }] },
      });
      assert.equal(secondRun.status, "succeeded");
      secondStart = JSON.parse(readFileSync(secondStartPath, "utf8")) as {
        detail_gaps: Array<{ gap_id: string }>;
      };
    } finally {
      secondConnector.cleanup();
      rmSync(secondStartDir, { force: true, recursive: true });
    }
    assert.ok(secondStart);
    assert.deepEqual(
      secondStart.detail_gaps.map((gap) => gap.gap_id),
      siblingGapIds,
      "the next recovery run admits ordinary siblings after policy closure"
    );

    const [firstPolicyGapId] = policyGapIds;
    assert.ok(firstPolicyGapId);
    const laterUpsert = await store.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      detailLocator: { attachment_id: POLICY_ROWS[0][0], changed: true, kind: "gmail.attachment_detail" },
      discoveredRunId: "run_later",
      gapId: firstPolicyGapId,
      grantId: GRANT_ID,
      lastError: { class: "imap_download_failed", message: "Connection not available later" },
      lastRunId: "run_later",
      now: "2026-08-02T12:15:00.000Z",
      parentStream: "messages",
      reason: "temporary_unavailable",
      recordKey: POLICY_ROWS[0][0],
      scope: { streams: ["attachments"] },
      source: { id: CONNECTOR_ID, kind: "connector" },
      stream: "attachments",
    });
    assert.ok(laterUpsert);
    assert.equal(laterUpsert.status, "terminal");
    assert.equal(laterUpsert.reason, "too_large");
    assert.deepEqual(laterUpsert.last_error, {
      class: "too_large",
      message: POLICY_ROWS[0][1],
    });
  })
);

test(
  "terminal Gmail settlement is lease-owned, preserves exact evidence, and fails closed on a stale lease",
  withTempDb(async (store) => {
    const error = { class: "too_large", message: "attachment exceeds max size: 30062404 > 26214400 bytes" };
    const seeded = await store.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      detailLocator: { attachment_id: "cas:2", kind: "gmail.attachment_detail" },
      gapId: "gmail-cas-policy",
      grantId: GRANT_ID,
      lastError: error,
      now: SEEDED_AT,
      parentStream: "messages",
      reason: "temporary_unavailable",
      recordKey: "cas:2",
      stream: "attachments",
    });
    assert.ok(seeded);
    const [claimed] = await store.claimPendingGaps([seeded.gap_id], {
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
      leaseId: "lease-cas-current",
      runId: "run-cas-current",
    });
    assert.equal(claimed, seeded.gap_id);

    const terminalInput = {
      connectorId: CONNECTOR_ID,
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      detailLocator: { attachment_id: "cas:2", kind: "gmail.attachment_detail" },
      gapId: seeded.gap_id,
      grantId: GRANT_ID,
      lastError: error,
      lastRunId: "run-cas-current",
      parentStream: "messages",
      reason: "too_large",
      recordKey: "cas:2",
      stream: "attachments",
    } as const;

    const stale = await store.settleLeasedGapTerminal(
      { gapId: seeded.gap_id, leaseId: "lease-cas-stale", runId: "run-cas-current" },
      terminalInput,
      POLICY_PROOF
    );
    assert.equal(stale, null);
    const stillLeased = await store.getGapById(seeded.gap_id);
    assert.ok(stillLeased);
    assert.equal(stillLeased.status, "in_progress");
    assert.equal(stillLeased.lease_id, "lease-cas-current");

    const terminal = await store.settleLeasedGapTerminal(
      { gapId: seeded.gap_id, leaseId: "lease-cas-current", runId: "run-cas-current" },
      terminalInput,
      POLICY_PROOF
    );
    assert.ok(terminal);
    assert.equal(terminal.status, "terminal");
    assert.equal(terminal.reason, "too_large");
    assert.equal(terminal.attempt_count, 0);
    assert.equal(terminal.last_attempt_at, null);
    assert.equal(terminal.lease_id, null);
    assert.deepEqual(terminal.last_error, error);
    assert.deepEqual(terminal.policy_disposition, POLICY_PROOF);
  })
);
