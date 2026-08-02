// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { buildCollectionReport, getRepairBlockingTerminalGapCountsByStream } from "../server/ref-control.ts";
import { createSqliteConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";

const CONNECTOR_ID = "gmail";
const CONNECTION_ID = "cin_policy_terminal_coverage";
const NOW = "2026-08-02T12:00:00.000Z";

type BuildCollectionReportInput = Parameters<typeof buildCollectionReport>[0];

function withTempDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-policy-terminal-coverage-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function collectionCoverage(
  terminalDetailGapsByStream: ReadonlyMap<string, number>
): ReturnType<typeof buildCollectionReport>[number]["coverage_condition"] {
  const input: BuildCollectionReportInput = {
    attentionOpen: false,
    collectionFacts: {
      streams: [
        {
          checkpoint: "committed",
          collected: 1,
          considered: 1,
          covered: 1,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "attachments",
        },
      ],
    },
    freshness: "fresh",
    manifestStreams: [],
    refresh: null,
    terminalDetailGapsByStream,
  };
  const [entry] = buildCollectionReport(input);
  assert.ok(entry);
  return entry.coverage_condition;
}

test(
  "policy-terminal gaps remain counted evidence but never become connector repair coverage",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const policy = await store.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: CONNECTION_ID,
      gapId: "gap_policy_too_large",
      now: NOW,
      reason: "too_large",
      recordKey: "message-policy:attachment-1",
      stream: "attachments",
    });
    const providerFailure = await store.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: CONNECTION_ID,
      gapId: "gap_provider_not_found",
      now: NOW,
      reason: "not_found",
      recordKey: "message-missing:attachment-2",
      stream: "attachments",
    });
    assert.ok(policy);
    assert.ok(providerFailure);
    await store.markGapStatus(policy.gap_id, "terminal", { now: NOW, reason: "too_large" });
    await store.markGapStatus(providerFailure.gap_id, "terminal", { now: NOW, reason: "not_found" });

    assert.equal(
      await store.countGapsByStatusForConnector(CONNECTOR_ID, {
        connectorInstanceId: CONNECTION_ID,
        status: "terminal",
      }),
      2,
      "both terminal rows remain in the honest historical inventory"
    );
    assert.deepEqual(
      await store.countGapsByStatusByStreamForConnectorInstanceIds([CONNECTION_ID], {
        reasons: ["too_large"],
        status: "terminal",
      }),
      new Map([[CONNECTION_ID, new Map([["attachments", 1]])]]),
      "reason-scoped batch aggregation selects policy evidence without changing it"
    );

    const repairBlocking = await getRepairBlockingTerminalGapCountsByStream(store, CONNECTOR_ID, CONNECTION_ID);
    assert.deepEqual(
      repairBlocking,
      new Map([["attachments", 1]]),
      "only the independently terminal provider failure can require a connector fix"
    );
    assert.equal(collectionCoverage(repairBlocking ?? new Map()), "terminal_gap");

    await store.markGapStatus(providerFailure.gap_id, "recovered", { now: NOW, runId: "run_recovered" });
    const policyOnly = await getRepairBlockingTerminalGapCountsByStream(store, CONNECTOR_ID, CONNECTION_ID);
    assert.deepEqual(policyOnly, new Map(), "the policy row is still terminal but has no repair disposition");
    assert.equal(
      collectionCoverage(policyOnly ?? new Map()),
      "complete",
      "changing the policy filter back to status-only would turn this into terminal_gap"
    );
    assert.equal(
      await store.countGapsByStatusForConnector(CONNECTOR_ID, {
        connectorInstanceId: CONNECTION_ID,
        status: "terminal",
      }),
      1,
      "the policy terminal row was retained rather than relabeled, removed, or recovered"
    );
  })
);
