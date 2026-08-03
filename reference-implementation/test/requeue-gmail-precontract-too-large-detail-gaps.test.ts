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
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresConnectorDetailGapStore,
  createSqliteConnectorDetailGapStore,
} from "../server/stores/connector-detail-gap-store.ts";

const NOW = "2026-08-03T01:00:00.000Z";
const CONNECTOR_INSTANCE_ID = "cin_precontract_remeasurement";
const OTHER_INSTANCE_ID = "cin_precontract_remeasurement_other";
const LIMIT_ERROR = /from 1 to 500/;
const MUTATION_DISCRIMINATOR_ERROR = /mutation-discriminator=.* is required/;
const UNSUPPORTED_ARGUMENT_ERROR = /unsupported repair argument/;

type GapStore = ReturnType<typeof createSqliteConnectorDetailGapStore>;

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

function gapInput(gapId: string, connectorInstanceId = CONNECTOR_INSTANCE_ID) {
  return {
    connectorId: "gmail",
    connectorInstanceId,
    detailLocator: { attachment_id: gapId, kind: "gmail.attachment_detail" },
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

async function seedUnprovenTerminal(store: GapStore, gapId: string, connectorInstanceId = CONNECTOR_INSTANCE_ID) {
  const input = gapInput(gapId, connectorInstanceId);
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
  const remeasure = await seedUnprovenTerminal(store, "gap_remeasure");
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
  assert.deepEqual(dryRun.gap_ids, ["gap_remeasure"]);
  assert.equal(dryRun.matched, 1);
  assert.equal(dryRun.requeued, 0);
  assert.equal((await store.getGapById("gap_remeasure"))?.status, "terminal", "dry run is non-mutating");

  const apply = await executeRepair(store, repairArgs(true), NOW);
  assert.deepEqual(apply.gap_ids, ["gap_remeasure"]);
  assert.equal(apply.matched, 1);
  assert.equal(apply.requeued, 1);
  const after = await store.getGapById("gap_remeasure");
  assert.ok(after);
  assert.equal(after.status, "pending");
  assert.equal(after.policy_disposition, null);
  assert.deepEqual(after.detail_locator, remeasure.detail_locator, "repair preserves locator/record identity");
  assert.deepEqual(after.last_error, remeasure.last_error, "repair preserves historical terminal evidence");
  assert.equal(after.last_run_id, remeasure.last_run_id, "repair creates no run outcome");
  assert.equal(after.recovered_run_id, remeasure.recovered_run_id, "repair does not fabricate recovery");
  assert.equal(after.attempt_count, remeasure.attempt_count, "repair does not fabricate a provider attempt");

  const secondApply = await executeRepair(store, repairArgs(true), "2026-08-03T01:01:00.000Z");
  assert.deepEqual(secondApply.gap_ids, []);
  assert.equal(secondApply.matched, 0);
  assert.equal(secondApply.requeued, 0, "apply is idempotent");
  assert.equal((await store.getGapById("gap_proven"))?.status, "terminal", "validated policy remains terminal");
  assert.deepEqual((await store.getGapById("gap_proven"))?.policy_disposition, proven.policy_disposition);
  assert.equal((await store.getGapById("gap_other_instance"))?.status, "terminal", "other instances are isolated");
  assert.equal((await store.getGapById("gap_wrong_stream"))?.status, "terminal", "other streams are isolated");
  assert.equal((await store.getGapById("gap_wrong_class"))?.status, "terminal", "other terminal classes are isolated");
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

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

test("real PostgreSQL pre-contract Gmail remeasurement preserves proof exclusion, isolation, and CAS", {
  skip: !POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL, "PostgreSQL URL is configured when this test runs");
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const instanceId = `${CONNECTOR_INSTANCE_ID}_${suffix}`;
  const otherInstanceId = `${OTHER_INSTANCE_ID}_${suffix}`;
  initDb(":memory:");
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  try {
    const store = createPostgresConnectorDetailGapStore();
    const pgArgs = { ...repairArgs(false), connectorInstanceId: instanceId };
    const remeasure = await seedUnprovenTerminal(store, `gap_remeasure_${suffix}`, instanceId);
    await store.upsertPendingGap({ ...gapInput(`gap_proven_${suffix}`), connectorInstanceId: instanceId });
    // The policy row is seeded under the requested instance rather than the
    // SQLite fixture default, then settled through the same lease authority.
    const [claimed] = await store.claimPendingGaps([`gap_proven_${suffix}`], {
      leaseExpiresAt: "2026-08-03T02:00:00.000Z",
      leaseId: `lease_pg_${suffix}`,
      runId: "run_policy_pg",
    });
    assert.equal(claimed, `gap_proven_${suffix}`);
    await store.settleLeasedGapTerminal(
      { gapId: `gap_proven_${suffix}`, leaseId: `lease_pg_${suffix}`, runId: "run_policy_pg" },
      { ...gapInput(`gap_proven_${suffix}`), connectorInstanceId: instanceId, lastRunId: "run_policy_pg" },
      { configured_limit_bytes: 26_214_400, kind: "gmail_attachment_too_large", observed_size_bytes: 30_062_404 }
    );
    await seedUnprovenTerminal(store, `gap_other_${suffix}`, otherInstanceId);

    const dryRun = await executeRepair(store, pgArgs, NOW);
    assert.deepEqual(dryRun.gap_ids, [`gap_remeasure_${suffix}`]);
    const [first, second] = await Promise.all([
      executeRepair(store, { ...pgArgs, apply: true }, NOW),
      executeRepair(store, { ...pgArgs, apply: true }, NOW),
    ]);
    assert.equal(first.requeued + second.requeued, 1, "Postgres CAS permits one mutation");
    const after = await store.getGapById(`gap_remeasure_${suffix}`);
    assert.ok(after);
    assert.equal(after.status, "pending");
    assert.deepEqual(after.detail_locator, remeasure.detail_locator);
    assert.deepEqual(after.last_error, remeasure.last_error);
    assert.equal(after.last_run_id, remeasure.last_run_id);
    assert.equal((await store.getGapById(`gap_proven_${suffix}`))?.status, "terminal");
    assert.deepEqual((await store.getGapById(`gap_proven_${suffix}`))?.policy_disposition, {
      configured_limit_bytes: 26_214_400,
      kind: "gmail_attachment_too_large",
      observed_size_bytes: 30_062_404,
    });
    assert.equal((await store.getGapById(`gap_other_${suffix}`))?.status, "terminal");
  } finally {
    await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_instance_id = ANY($1::text[])", [
      [instanceId, otherInstanceId],
    ]);
    await closePostgresStorage();
    closeDb();
  }
});
