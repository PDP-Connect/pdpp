// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable `terminal_facts_invalidated_at` anchor (fix-uat-manifest-reproof-governor,
 * gate REVISE 2026-08-03). Proves the write path stamped by this fix through
 * the REAL fold/repair pipeline on both storage backends — schema presence,
 * atomic stamp-on-first-invalidation, preserved-not-reset across repeated
 * still-non-current passes, cleared-on-heal, and restart persistence
 * (the anchor must survive a process restart, unlike the reverted
 * `runtime.lastRunTime`-based first version of this fix).
 *
 * Mirrors `connector-summary-historical-checkpoint-advance.test.ts`'s
 * generation-transition seeding pattern (a real manifest-fingerprint bump:
 * `bumpEvidenceGeneration` + a terminal event stamped at the OLD generation)
 * and `forward-evidence-debt-wired-probe.test.ts`'s SQLite/Postgres dual-
 * backend structure.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { forwardEvidenceInvalidatedAtMs, hasForwardEvidenceDebt } from "../runtime/recovery-decision.ts";
import {
  foldConnectorSummaryStreamFacts,
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const OWNER = "owner_local";
const NOW = "2026-08-01T00:00:00.000Z";

// ─── SQLite ─────────────────────────────────────────────────────────────────

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-terminal-facts-invalidated-at-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

async function withTempDbPath<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-terminal-facts-invalidated-at-restart-"));
  const dbPath = join(dir, "pdpp.sqlite");
  try {
    initDb(dbPath);
    return await fn(dbPath);
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function seedInstance(connectorInstanceId: string, connectorId: string) {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       VALUES(?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, OWNER, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

let seededEventSeq = 0;

function seedTerminalEventAtGeneration({
  connectorInstanceId,
  occurredAt,
  runId,
  manifestGeneration,
  collected,
}: {
  connectorInstanceId: string;
  occurredAt: string;
  runId: string;
  manifestGeneration: number;
  collected: number;
}) {
  seededEventSeq += 1;
  const data = {
    collection_facts: {
      reference_only: true,
      schema_version: 1,
      streams: [{ checkpoint: "committed", collected, stream: "messages" }],
    },
    connection_id: connectorInstanceId,
    connector_instance_id: connectorInstanceId,
  };
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
         connector_instance_id, manifest_generation
       )
       VALUES(?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, ?, '1', ?, ?)`
    )
    .run(
      `evt_${seededEventSeq}`,
      seededEventSeq,
      occurredAt,
      occurredAt,
      `trace_${seededEventSeq}`,
      runId,
      runId,
      JSON.stringify(data),
      connectorInstanceId,
      manifestGeneration
    );
  return seededEventSeq;
}

function bumpEvidenceGeneration(connectorInstanceId: string, manifestGeneration: number) {
  getDb()
    .prepare("UPDATE connector_summary_evidence SET manifest_generation = ? WHERE connector_instance_id = ?")
    .run(manifestGeneration, connectorInstanceId);
}

function rawInvalidatedAt(connectorInstanceId: string): string | null {
  const row = getDb()
    .prepare("SELECT terminal_facts_invalidated_at FROM connector_summary_evidence WHERE connector_instance_id = ?")
    .get<{ terminal_facts_invalidated_at: string | null }>(connectorInstanceId);
  assert.ok(row, "evidence row exists");
  return row.terminal_facts_invalidated_at;
}

test("SQLite: schema — terminal_facts_invalidated_at column exists and defaults to NULL for a fresh row", async () => {
  await withTempDb(async () => {
    seedInstance("cin_schema", "gmail");
    await rebuildConnectorSummaryEvidence();
    assert.equal(rawInvalidatedAt("cin_schema"), null);
  });
});

test("SQLite: a manifest-generation transition atomically stamps terminal_facts_invalidated_at the SAME pass terminal_facts_state flips non-current", async () => {
  await withTempDb(async () => {
    seedInstance("cin_hist", "gmail");
    await rebuildConnectorSummaryEvidence();
    // The connection's durable generation has already moved to 1 (a real
    // manifest-fingerprint transition), but its terminal history predates
    // that — stamped at the OLD generation 0.
    bumpEvidenceGeneration("cin_hist", 1);
    assert.equal(
      rawInvalidatedAt("cin_hist"),
      null,
      "premise: no invalidation stamped before any fold pass observes the mismatch"
    );

    seedTerminalEventAtGeneration({
      collected: 10,
      connectorInstanceId: "cin_hist",
      manifestGeneration: 0,
      occurredAt: "2026-08-01T00:01:00.000Z",
      runId: "run_old_1",
    });

    const before = Date.now();
    const pass = await foldConnectorSummaryStreamFacts();
    const after = Date.now();
    assert.equal(pass.refused, 1, "the generation-mismatched event is refused, not folded");

    const evidence = await getConnectorSummaryEvidence("cin_hist");
    assert.ok(evidence);
    assert.equal(evidence.terminal_facts.state, "stale");
    const invalidatedAtMs = forwardEvidenceInvalidatedAtMs(evidence);
    assert.ok(
      invalidatedAtMs !== null,
      "the invalidation moment is stamped in the SAME pass that flips state non-current"
    );
    assert.ok(
      invalidatedAtMs >= before && invalidatedAtMs <= after,
      "the stamped timestamp is the moment of THIS write, not a fabricated or carried-forward value"
    );
    assert.equal(
      hasForwardEvidenceDebt(evidence, Date.now(), 60 * 60 * 1000),
      true,
      "premise: this row genuinely reads as forward-evidence debt"
    );
  });
});

test("SQLite: a repeated still-non-current pass PRESERVES the original invalidation moment (never resets the clock)", async () => {
  await withTempDb(async () => {
    seedInstance("cin_hist", "gmail");
    await rebuildConnectorSummaryEvidence();
    bumpEvidenceGeneration("cin_hist", 1);
    seedTerminalEventAtGeneration({
      collected: 10,
      connectorInstanceId: "cin_hist",
      manifestGeneration: 0,
      occurredAt: "2026-08-01T00:01:00.000Z",
      runId: "run_old_1",
    });

    await foldConnectorSummaryStreamFacts();
    const firstInvalidatedAt = rawInvalidatedAt("cin_hist");
    assert.ok(firstInvalidatedAt, "premise: first pass stamped the anchor");

    // Simulate real elapsed time between passes (a periodic maintenance
    // tick) so a reset bug would be observable as a changed timestamp.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const secondPass = await foldConnectorSummaryStreamFacts();
    assert.equal(secondPass.eventsRead, 0, "no new terminal history since the first pass — nothing new to fold");

    const secondInvalidatedAt = rawInvalidatedAt("cin_hist");
    assert.equal(
      secondInvalidatedAt,
      firstInvalidatedAt,
      "a repeated still-refused pass must NOT re-stamp — the anchor must reflect the ORIGINAL invalidation moment for the reproof cadence to bound correctly, not the most recent observation"
    );
  });
});

test("SQLite: a later current-generation terminal event heals the row and CLEARS terminal_facts_invalidated_at back to NULL", async () => {
  await withTempDb(async () => {
    seedInstance("cin_hist", "gmail");
    await rebuildConnectorSummaryEvidence();
    bumpEvidenceGeneration("cin_hist", 1);
    seedTerminalEventAtGeneration({
      collected: 10,
      connectorInstanceId: "cin_hist",
      manifestGeneration: 0,
      occurredAt: "2026-08-01T00:01:00.000Z",
      runId: "run_old",
    });

    await foldConnectorSummaryStreamFacts();
    assert.ok(rawInvalidatedAt("cin_hist"), "premise: invalidated after the first (refused) pass");

    // A genuinely new run lands, correctly stamped at the connection's
    // CURRENT generation (1) — the exact healing event the reproof run this
    // fix admits early is meant to produce.
    seedTerminalEventAtGeneration({
      collected: 42,
      connectorInstanceId: "cin_hist",
      manifestGeneration: 1,
      occurredAt: "2026-08-01T00:05:00.000Z",
      runId: "run_current",
    });

    const healingPass = await foldConnectorSummaryStreamFacts();
    assert.equal(healingPass.folded, 1);

    const healed = await getConnectorSummaryEvidence("cin_hist");
    assert.ok(healed);
    assert.equal(healed.terminal_facts.state, "current");
    assert.equal(
      forwardEvidenceInvalidatedAtMs(healed),
      null,
      "the anchor clears to NULL the moment the state returns to current"
    );
    assert.equal(rawInvalidatedAt("cin_hist"), null);
    // `hasForwardEvidenceDebt`'s own age bound (over per-stream
    // `evidence_as_of`, unrelated to this fix) is exercised by
    // recovery-decision.test.ts's own suite — not re-asserted here with a
    // fixed-past fixture timestamp, which would read as debt for reasons
    // this test isn't proving. The load-bearing proof for THIS fix is the
    // state/anchor pair above: healing clears both `terminal_facts_state`
    // and `terminal_facts_invalidated_at` together, atomically, in the SAME
    // write.
  });
});

test("SQLite restart: the invalidation anchor survives closing and reopening the SAME on-disk database", async () => {
  await withTempDbPath(async (dbPath) => {
    seedInstance("cin_restart", "gmail");
    await rebuildConnectorSummaryEvidence();
    bumpEvidenceGeneration("cin_restart", 1);
    seedTerminalEventAtGeneration({
      collected: 10,
      connectorInstanceId: "cin_restart",
      manifestGeneration: 0,
      occurredAt: "2026-08-01T00:01:00.000Z",
      runId: "run_old",
    });
    await foldConnectorSummaryStreamFacts();
    const stampedBeforeRestart = rawInvalidatedAt("cin_restart");
    assert.ok(stampedBeforeRestart, "premise: stamped before the simulated restart");

    // Simulate a process restart: close and reopen the SAME on-disk
    // database file (mirrors scheduler-synthesized-attention-revalidation.test.ts's
    // "real restart" pattern for the analogous synthesized_revalidation_state anchor).
    closeDb();
    initDb(dbPath);

    const afterRestart = rawInvalidatedAt("cin_restart");
    assert.equal(
      afterRestart,
      stampedBeforeRestart,
      "the durable anchor must survive a process restart — unlike the reverted runtime.lastRunTime-based first version of this fix, which was purely in-memory per scheduler run and could not bound a fleet-wide restart cohort correctly"
    );
    const evidence = await getConnectorSummaryEvidence("cin_restart");
    assert.equal(forwardEvidenceInvalidatedAtMs(evidence), Date.parse(stampedBeforeRestart as string));
  });
});

// ─── Postgres (gated) — schema/write/read parity ───────────────────────────

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

const PG_MANIFEST = {
  capabilities: { public_listing: { listed: true, status: "test" } },
  connector_id: "terminal-facts-invalidated-at-pg",
  display_name: "Terminal Facts Invalidated At PG",
  protocol_version: "0.1.0",
  streams: [{ name: "messages", primary_key: ["id"] }],
  version: "1.0.0",
};

async function seedPostgresConnection(connectorInstanceId: string, now: string): Promise<void> {
  await postgresQuery(
    "INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3) ON CONFLICT (connector_id) DO NOTHING",
    [PG_MANIFEST.connector_id, JSON.stringify(PG_MANIFEST), now]
  );
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [connectorInstanceId, PG_MANIFEST.connector_id, now]
  );
}

async function seedPostgresTerminalEventAtGeneration(
  connectorInstanceId: string,
  occurredAt: string,
  runId: string,
  manifestGeneration: number,
  collected: number
): Promise<void> {
  const data = {
    collection_facts: {
      reference_only: true,
      schema_version: 1,
      streams: [{ checkpoint: "committed", collected, stream: "messages" }],
    },
    connection_id: connectorInstanceId,
    connector_instance_id: connectorInstanceId,
  };
  await postgresQuery(
    `INSERT INTO spine_events(
       event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, manifest_generation, data_json, version
     ) VALUES($1, (SELECT COALESCE(MAX(event_seq),0)+1 FROM spine_events), 'run.completed', $2, $2, 'test', $3, 'runtime', 'test-connector', 'run', $4, 'succeeded', $4, $5, $6, $7::jsonb, '1')`,
    [
      `evt_pg_invalidated_${connectorInstanceId}_${runId}`,
      occurredAt,
      `trace_${connectorInstanceId}_${runId}`,
      runId,
      connectorInstanceId,
      manifestGeneration,
      JSON.stringify(data),
    ]
  );
}

async function bumpPostgresEvidenceGeneration(connectorInstanceId: string, manifestGeneration: number): Promise<void> {
  await postgresQuery(
    "UPDATE connector_summary_evidence SET manifest_generation = $2 WHERE connector_instance_id = $1",
    [connectorInstanceId, manifestGeneration]
  );
}

async function rawPostgresInvalidatedAt(connectorInstanceId: string): Promise<string | null> {
  const result = await postgresQuery(
    "SELECT terminal_facts_invalidated_at FROM connector_summary_evidence WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  const row = result.rows[0] as { terminal_facts_invalidated_at: string | null } | undefined;
  assert.ok(row, "evidence row exists");
  return row.terminal_facts_invalidated_at;
}

async function cleanupPostgres(connectorInstanceIds: string[]): Promise<void> {
  for await (const id of connectorInstanceIds) {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [id]);
    await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [id]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [id]);
  }
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [PG_MANIFEST.connector_id]);
}

test("real PostgreSQL: a manifest-generation transition atomically stamps terminal_facts_invalidated_at, preserved across repeats, cleared on heal (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  if (!POSTGRES_URL) {
    return;
  }
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  const connectorInstanceId = "cin_pg_invalidated_at";
  try {
    const now = new Date().toISOString();
    await seedPostgresConnection(connectorInstanceId, now);
    await bumpPostgresEvidenceGeneration(connectorInstanceId, 1);
    assert.equal(await rawPostgresInvalidatedAt(connectorInstanceId), null, "premise: no anchor before any fold pass");

    await seedPostgresTerminalEventAtGeneration(connectorInstanceId, now, "run_old", 0, 10);
    await foldConnectorSummaryStreamFacts();

    const evidence = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.ok(evidence);
    assert.equal(evidence.terminal_facts.state, "stale");
    const firstInvalidatedAtMs = forwardEvidenceInvalidatedAtMs(evidence);
    assert.ok(firstInvalidatedAtMs !== null, "stamped in the same pass state flips non-current, on Postgres too");

    // Repeated pass with no new terminal history: must preserve, not reset.
    await foldConnectorSummaryStreamFacts();
    const afterRepeat = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.equal(
      forwardEvidenceInvalidatedAtMs(afterRepeat),
      firstInvalidatedAtMs,
      "Postgres write path also preserves the original invalidation moment across repeated still-refused passes"
    );

    // Heal with a current-generation event.
    await seedPostgresTerminalEventAtGeneration(connectorInstanceId, now, "run_current", 1, 42);
    await foldConnectorSummaryStreamFacts();
    const healed = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.ok(healed);
    assert.equal(healed.terminal_facts.state, "current");
    assert.equal(
      forwardEvidenceInvalidatedAtMs(healed),
      null,
      "Postgres write path also clears the anchor to NULL on healing"
    );
  } finally {
    await cleanupPostgres([connectorInstanceId]);
    await closePostgresStorage();
  }
});
