// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executeRepair,
  type GmailPrecontractRemeasurementArgs,
  PRECONTRACT_REMEASUREMENT_DISCRIMINATOR,
  parseArgs,
  validateArgs,
} from "../scripts/repair/requeue-gmail-precontract-too-large-detail-gaps.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import {
  createPostgresConnectorDetailGapStore,
  createSqliteConnectorDetailGapStore,
} from "../server/stores/connector-detail-gap-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const NOW = "2026-08-03T01:00:00.000Z";
const CONNECTOR_INSTANCE_ID = "cin_precontract_remeasurement";
const OTHER_INSTANCE_ID = "cin_precontract_remeasurement_other";
const LIMIT_ERROR = /from 1 to 500/;
const MUTATION_DISCRIMINATOR_ERROR = /mutation-discriminator=.* is required/;
const UNSUPPORTED_ARGUMENT_ERROR = /unsupported repair argument/;

type GapStore =
  | ReturnType<typeof createPostgresConnectorDetailGapStore>
  | ReturnType<typeof createSqliteConnectorDetailGapStore>;

function repairArgs(apply: boolean): GmailPrecontractRemeasurementArgs {
  return {
    apply,
    connectorId: "gmail",
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    errorClass: "too_large",
    limit: 100,
    mutationDiscriminator: PRECONTRACT_REMEASUREMENT_DISCRIMINATOR,
    stream: "attachments",
  };
}

function gapInput(
  gapId: string,
  connectorInstanceId = CONNECTOR_INSTANCE_ID,
  detailLocator: unknown = { attachment_id: `${gapId}:2`, kind: "gmail.attachment_detail" }
) {
  return {
    connectorId: "gmail",
    connectorInstanceId,
    detailLocator,
    gapId,
    grantId: "grant_precontract_remeasurement",
    lastError: { class: "too_large", message: "legacy terminal evidence without structured proof" },
    lastRunId: "run_historical",
    now: NOW,
    parentStream: "messages",
    reason: "too_large",
    recordKey: gapId,
    scope: { retained: true },
    source: { id: "gmail", kind: "connector" },
    stream: "attachments",
  };
}

async function seedUnprovenTerminal(
  store: GapStore,
  gapId: string,
  connectorInstanceId = CONNECTOR_INSTANCE_ID,
  detailLocator?: unknown
) {
  const input =
    detailLocator === undefined
      ? gapInput(gapId, connectorInstanceId)
      : gapInput(gapId, connectorInstanceId, detailLocator);
  const pending = await store.upsertPendingGap(input);
  assert.ok(pending, "pending row is stored");
  const terminal = await store.markGapStatus(gapId, "terminal", {
    lastError: input.lastError,
    now: NOW,
    reason: "too_large",
    runId: "run_historical",
  });
  assert.ok(terminal, "legacy terminal row is stored");
  return terminal;
}

async function seedProvenTerminal(store: GapStore, gapId: string) {
  const input = gapInput(gapId);
  const pending = await store.upsertPendingGap(input);
  assert.ok(pending, "pending policy row is stored");
  const [claimed] = await store.claimPendingGaps([gapId], {
    leaseExpiresAt: "2026-08-03T02:00:00.000Z",
    leaseId: `lease_${gapId}`,
    runId: "run_policy",
  });
  assert.equal(claimed, gapId, "policy row is leased before terminal settlement");
  const terminal = await store.settleLeasedGapTerminal(
    { gapId, leaseId: `lease_${gapId}`, runId: "run_policy" },
    { ...input, lastRunId: "run_policy" },
    {
      configured_limit_bytes: 26_214_400,
      kind: "gmail_attachment_too_large",
      observed_size_bytes: 30_062_404,
    }
  );
  assert.ok(terminal, "policy row is terminally settled");
  return terminal;
}

async function assertRemeasurementContract(store: GapStore): Promise<void> {
  const remeasure = await seedUnprovenTerminal(store, "gap_legacy_attachment_id_only");
  const fullLocator = await seedUnprovenTerminal(store, "gap_full_locator", CONNECTOR_INSTANCE_ID, {
    kind: "gmail.attachment_detail",
    message_id: "message_full_locator",
    part_index: "2",
  });
  const malformedLocators = [
    { gapId: "gap_kind_only", locator: { kind: "gmail.attachment_detail" } },
    { gapId: "gap_empty_attachment_id", locator: { attachment_id: "", kind: "gmail.attachment_detail" } },
    {
      gapId: "gap_malformed_attachment_id_no_separator",
      locator: { attachment_id: "message_without_part", kind: "gmail.attachment_detail" },
    },
    {
      gapId: "gap_malformed_attachment_id_empty_message",
      locator: { attachment_id: ":2", kind: "gmail.attachment_detail" },
    },
    {
      gapId: "gap_malformed_attachment_id_empty_part",
      locator: { attachment_id: "message:", kind: "gmail.attachment_detail" },
    },
  ];
  await Promise.all(
    malformedLocators.map(async ({ gapId, locator }) =>
      seedUnprovenTerminal(store, gapId, CONNECTOR_INSTANCE_ID, locator)
    )
  );
  const proven = await seedProvenTerminal(store, "gap_proven");
  await seedUnprovenTerminal(store, "gap_other_instance", OTHER_INSTANCE_ID);
  const wrongStream = await store.upsertPendingGap({
    ...gapInput("gap_wrong_stream"),
    stream: "messages",
  });
  assert.ok(wrongStream);
  await store.markGapStatus("gap_wrong_stream", "terminal", {
    lastError: gapInput("gap_wrong_stream").lastError,
    now: NOW,
    reason: "too_large",
  });
  const wrongClass = await store.upsertPendingGap({
    ...gapInput("gap_wrong_class"),
    lastError: { class: "imap_download_failed", message: "Connection not available" },
  });
  assert.ok(wrongClass);
  await store.markGapStatus("gap_wrong_class", "terminal", {
    lastError: { class: "imap_download_failed", message: "Connection not available" },
    now: NOW,
    reason: "too_large",
  });

  const dryRun = await executeRepair(store, repairArgs(false), NOW);
  assert.deepEqual(dryRun.gap_ids, ["gap_full_locator", "gap_legacy_attachment_id_only"]);
  assert.equal(dryRun.matched, 2);
  assert.equal(dryRun.requeued, 0);
  assert.equal(
    (await store.getGapById("gap_legacy_attachment_id_only"))?.status,
    "terminal",
    "dry run is non-mutating"
  );

  const apply = await executeRepair(store, repairArgs(true), NOW);
  assert.deepEqual(apply.gap_ids, ["gap_full_locator", "gap_legacy_attachment_id_only"]);
  assert.equal(apply.matched, 2);
  assert.equal(apply.requeued, 2);
  const after = await store.getGapById("gap_legacy_attachment_id_only");
  assert.ok(after);
  assert.equal(after.status, "pending");
  assert.equal(after.policy_disposition, null);
  assert.deepEqual(after.detail_locator, remeasure.detail_locator, "repair preserves locator/record identity");
  assert.deepEqual(after.last_error, remeasure.last_error, "repair preserves historical terminal evidence");
  assert.equal(after.last_run_id, remeasure.last_run_id, "repair creates no run outcome");
  assert.equal(after.recovered_run_id, remeasure.recovered_run_id, "repair does not fabricate recovery");
  assert.equal(after.attempt_count, remeasure.attempt_count, "repair does not fabricate a provider attempt");
  assert.equal((await store.getGapById("gap_full_locator"))?.status, "pending", "full locator is requeued");
  assert.deepEqual((await store.getGapById("gap_full_locator"))?.detail_locator, fullLocator.detail_locator);

  const secondApply = await executeRepair(store, repairArgs(true), "2026-08-03T01:01:00.000Z");
  assert.deepEqual(secondApply.gap_ids, []);
  assert.equal(secondApply.matched, 0);
  assert.equal(secondApply.requeued, 0, "apply is idempotent");
  assert.equal((await store.getGapById("gap_proven"))?.status, "terminal", "validated policy remains terminal");
  assert.deepEqual((await store.getGapById("gap_proven"))?.policy_disposition, proven.policy_disposition);
  assert.equal((await store.getGapById("gap_other_instance"))?.status, "terminal", "other instances are isolated");
  assert.equal((await store.getGapById("gap_wrong_stream"))?.status, "terminal", "other streams are isolated");
  assert.equal((await store.getGapById("gap_wrong_class"))?.status, "terminal", "other terminal classes are isolated");
  const malformedRows = await Promise.all(
    malformedLocators.map(async ({ gapId }) => ({ gapId, status: (await store.getGapById(gapId))?.status }))
  );
  for (const { gapId, status } of malformedRows) {
    assert.equal(status, "terminal", `${gapId} cannot enter recovery`);
  }
}

test("pre-contract Gmail remeasurement is dry-run-first, exact, provenance-preserving, and idempotent on SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-gmail-precontract-remeasurement-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    await assertRemeasurementContract(createSqliteConnectorDetailGapStore());
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("pre-contract Gmail remeasurement has a mutation discriminator and rejects broadened CLI scopes", () => {
  const valid = parseArgs([
    "--connector-id=gmail",
    `--connector-instance-id=${CONNECTOR_INSTANCE_ID}`,
    "--stream=attachments",
    "--class=too_large",
    `--mutation-discriminator=${PRECONTRACT_REMEASUREMENT_DISCRIMINATOR}`,
  ]);
  assert.equal(validateArgs(valid), null);
  assert.match(validateArgs({ ...valid, mutationDiscriminator: null }) ?? "", MUTATION_DISCRIMINATOR_ERROR);
  assert.equal(validateArgs({ ...valid, connectorId: "amazon" }), "--connector-id=gmail is required");
  assert.equal(validateArgs({ ...valid, stream: "messages" }), "--stream=attachments is required");
  assert.equal(validateArgs({ ...valid, errorClass: "not_found" }), "--class=too_large is required");
  assert.throws(() => parseArgs(["--limit=501"]), LIMIT_ERROR);
  assert.throws(() => parseArgs(["--unknown=value"]), UNSUPPORTED_ARGUMENT_ERROR);
});

test("concurrent pre-contract Gmail remeasurement applies claim one terminal row at most once on SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-gmail-precontract-race-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    const store = createSqliteConnectorDetailGapStore();
    await seedUnprovenTerminal(store, "gap_race");
    const [first, second] = await Promise.all([
      executeRepair(store, repairArgs(true), NOW),
      executeRepair(store, repairArgs(true), NOW),
    ]);
    assert.equal(first.requeued + second.requeued, 1, "status/disposition CAS permits one mutation");
    assert.equal((await store.getGapById("gap_race"))?.status, "pending");
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

test("real disposable PostgreSQL remeasurement has SQLite locator, proof, isolation, and CAS parity", {
  skip: !POSTGRES_URL && "PDPP_TEST_POSTGRES_URL must target the dedicated loopback proof service",
}, async () => {
  assert.ok(POSTGRES_URL, "PostgreSQL URL targets the dedicated loopback proof service");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_gmail_remeasurement_${process.pid.toString(16).padStart(8, "0")}_${Date.now().toString(36)}`,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      try {
        const store = createPostgresConnectorDetailGapStore();
        await assertRemeasurementContract(store);
        await seedUnprovenTerminal(store, "gap_race");
        const [first, second] = await Promise.all([
          executeRepair(store, repairArgs(true), NOW),
          executeRepair(store, repairArgs(true), NOW),
        ]);
        assert.equal(first.requeued + second.requeued, 1, "PostgreSQL CAS permits one mutation");
        assert.equal((await store.getGapById("gap_race"))?.status, "pending");
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});
