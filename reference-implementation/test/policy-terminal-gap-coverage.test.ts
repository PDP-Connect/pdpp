// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GMAIL_ATTACHMENT_TOO_LARGE_POLICY_DISPOSITION } from "../runtime/terminal-policy-disposition.ts";
import { closeDb, initDb } from "../server/db.ts";
import { buildCollectionReport, getRepairBlockingTerminalGapCountsByStream } from "../server/ref-control.ts";
import { createSqliteConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";

const CONNECTOR_ID = "gmail";
const CONNECTION_ID = "cin_policy_terminal_coverage";
const SIBLING_CONNECTION_ID = "cin_policy_terminal_sibling";
const NOW = "2026-08-02T12:00:00.000Z";
const POLICY_PROOF = {
  configured_limit_bytes: 25,
  kind: GMAIL_ATTACHMENT_TOO_LARGE_POLICY_DISPOSITION,
  observed_size_bytes: 26,
} as const;
const INVALID_POLICY_DISPOSITION = /invalid terminal policy disposition/;

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
  const [entry] = buildCollectionReport({
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
  } satisfies BuildCollectionReportInput);
  assert.ok(entry);
  return entry.coverage_condition;
}

async function settleValidatedPolicy(
  store: ReturnType<typeof createSqliteConnectorDetailGapStore>,
  connectorInstanceId: string,
  gapId: string
): Promise<void> {
  const detailLocator = { attachment_id: gapId, kind: "gmail.attachment_detail" };
  const lastError = { class: "too_large", message: "attachment exceeds configured size" };
  const gap = await store.upsertPendingGap({
    connectorId: CONNECTOR_ID,
    connectorInstanceId,
    detailLocator,
    gapId,
    lastError,
    now: NOW,
    reason: "temporary_unavailable",
    recordKey: gapId,
    stream: "attachments",
  });
  assert.ok(gap);
  assert.deepEqual(
    await store.claimPendingGaps([gap.gap_id], {
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
      leaseId: `lease-${gapId}`,
      runId: `run-${gapId}`,
    }),
    [gap.gap_id]
  );
  const terminal = await store.settleLeasedGapTerminal(
    { gapId: gap.gap_id, leaseId: `lease-${gapId}`, runId: `run-${gapId}` },
    {
      connectorId: CONNECTOR_ID,
      connectorInstanceId,
      detailLocator,
      gapId,
      lastError,
      now: NOW,
      reason: "too_large",
      recordKey: gapId,
      stream: "attachments",
    },
    POLICY_PROOF
  );
  assert.ok(terminal);
  assert.deepEqual(terminal.policy_disposition, POLICY_PROOF);
}

test(
  "SQLite policy coverage requires immutable validated terminal settlement and respects instance scope",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    await settleValidatedPolicy(store, CONNECTION_ID, "gap_valid_policy");
    await settleValidatedPolicy(store, SIBLING_CONNECTION_ID, "gap_sibling_policy");

    const notFound = await store.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: CONNECTION_ID,
      detailLocator: { attachment_id: "not-found", kind: "gmail.attachment_detail" },
      gapId: "gap_not_found",
      lastError: { class: "not_found", message: "provider no longer has attachment" },
      now: NOW,
      reason: "not_found",
      recordKey: "not-found",
      stream: "attachments",
    });
    assert.ok(notFound);
    await store.markGapStatus(notFound.gap_id, "terminal", {
      lastError: { class: "not_found", message: "generic mutation" },
      now: NOW,
      reason: "too_large",
    });

    assert.deepEqual(
      await store.countGapsByStatusByStreamForConnector(CONNECTOR_ID, {
        connectorInstanceId: CONNECTION_ID,
        policyDisposition: GMAIL_ATTACHMENT_TOO_LARGE_POLICY_DISPOSITION,
        status: "terminal",
      }),
      [{ count: 1, stream: "attachments" }],
      "generic status mutation cannot write or fabricate policy disposition"
    );
    assert.equal(
      await store.countGapsByStatusForConnector(CONNECTOR_ID, {
        connectorInstanceId: CONNECTION_ID,
        status: "terminal",
      }),
      2,
      "all terminal inventory is preserved"
    );
    const repairBlocking = await getRepairBlockingTerminalGapCountsByStream(store, CONNECTOR_ID, CONNECTION_ID);
    assert.deepEqual(repairBlocking, new Map([["attachments", 1]]));
    assert.equal(collectionCoverage(repairBlocking ?? new Map()), "terminal_gap");

    const invalid = await store.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: CONNECTION_ID,
      detailLocator: { attachment_id: "invalid", kind: "gmail.attachment_detail" },
      gapId: "gap_invalid_proof",
      lastError: { class: "too_large", message: "too large" },
      now: NOW,
      reason: "too_large",
      recordKey: "invalid",
      stream: "attachments",
    });
    assert.ok(invalid);
    await store.claimPendingGaps([invalid.gap_id], {
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
      leaseId: "lease-invalid",
      runId: "run-invalid",
    });
    await assert.rejects(
      store.settleLeasedGapTerminal(
        { gapId: invalid.gap_id, leaseId: "lease-invalid", runId: "run-invalid" },
        {
          connectorId: CONNECTOR_ID,
          connectorInstanceId: CONNECTION_ID,
          detailLocator: { attachment_id: "invalid", kind: "gmail.attachment_detail" },
          gapId: invalid.gap_id,
          lastError: { class: "too_large", message: "too large" },
          reason: "too_large",
          recordKey: "invalid",
          stream: "attachments",
        },
        { ...POLICY_PROOF, observed_size_bytes: 25 }
      ),
      INVALID_POLICY_DISPOSITION
    );
  })
);

test("terminal aggregate parsing fails closed on malformed, duplicate, or independently failed reads", async () => {
  const allRows = [{ count: "2", stream: " attachments " }];
  const policyRows = [{ count: 1, stream: "attachments" }];
  const normalized = await getRepairBlockingTerminalGapCountsByStream(
    {
      countGapsByStatusByStreamForConnector: (_connectorId: string, options: { policyDisposition?: string | null }) =>
        options.policyDisposition ? policyRows : allRows,
    } as never,
    CONNECTOR_ID,
    CONNECTION_ID
  );
  assert.deepEqual(
    normalized,
    new Map([["attachments", 1]]),
    "safe count strings and stream whitespace normalize once"
  );

  const malformedResults = await Promise.all(
    [
      [{ count: Number.NaN, stream: "attachments" }],
      [
        { count: 1, stream: "attachments" },
        { count: 1, stream: "attachments" },
      ],
    ].map((rows) =>
      getRepairBlockingTerminalGapCountsByStream(
        { countGapsByStatusByStreamForConnector: () => rows } as never,
        CONNECTOR_ID,
        CONNECTION_ID
      )
    )
  );
  for (const result of malformedResults) {
    assert.equal(result, null);
  }
  const policyExceedsTotal = await getRepairBlockingTerminalGapCountsByStream(
    {
      countGapsByStatusByStreamForConnector: (_connectorId: string, options: { policyDisposition?: string | null }) =>
        options.policyDisposition ? [{ count: 2, stream: "attachments" }] : [{ count: 1, stream: "attachments" }],
    } as never,
    CONNECTOR_ID,
    CONNECTION_ID
  );
  assert.equal(policyExceedsTotal, null);
  const policyStreamAbsent = await getRepairBlockingTerminalGapCountsByStream(
    {
      countGapsByStatusByStreamForConnector: (_connectorId: string, options: { policyDisposition?: string | null }) =>
        options.policyDisposition ? [{ count: 1, stream: "messages" }] : [{ count: 1, stream: "attachments" }],
    } as never,
    CONNECTOR_ID,
    CONNECTION_ID
  );
  assert.equal(policyStreamAbsent, null);
  const independentlyFailed = await getRepairBlockingTerminalGapCountsByStream(
    {
      countGapsByStatusByStreamForConnector: (_connectorId: string, options: { policyDisposition?: string | null }) => {
        if (options.policyDisposition) {
          throw new Error("policy aggregate unavailable");
        }
        return [{ count: 1, stream: "attachments" }];
      },
    } as never,
    CONNECTOR_ID,
    CONNECTION_ID
  );
  assert.equal(independentlyFailed, null);
  const totalReadFailed = await getRepairBlockingTerminalGapCountsByStream(
    {
      countGapsByStatusByStreamForConnector: (_connectorId: string, options: { policyDisposition?: string | null }) => {
        if (!options.policyDisposition) {
          throw new Error("terminal aggregate unavailable");
        }
        return [{ count: 1, stream: "attachments" }];
      },
    } as never,
    CONNECTOR_ID,
    CONNECTION_ID
  );
  assert.equal(totalReadFailed, null);
});
