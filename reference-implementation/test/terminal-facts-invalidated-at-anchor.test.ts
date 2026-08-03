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

import {
  forwardEvidenceInvalidatedAtMs,
  hasForwardEvidenceDebt,
  isManifestGenerationInvalidatedDebt,
} from "../runtime/recovery-decision.ts";
import {
  backfillTerminalFactsInvalidatedAt,
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

// ─── backfillTerminalFactsInvalidatedAt (second gate REVISE, item 3) ───────
//
// Automatic rollout for a PRE-EXISTING non-current row that predates this
// column: the write path above only stamps an anchor at the MOMENT
// terminal_facts_state transitions non-current, which never happens for a
// legacy row that was ALREADY non-current before this migration landed.
// Without a repair, that row would sit at invalidatedAtMs: null forever,
// meaning it (a) never enters bounded reproof (out-of-scope check is
// unaffected, but even once in scope, it can never admit) OR (b) if scope
// were determined differently, would keep re-triggering the second gate's
// null-anchor defect. backfillTerminalFactsInvalidatedAt closes this: a
// bounded, backend-neutral, single-row repair the scheduler probe calls
// once it observes an in-scope row with no anchor.

test("SQLite: backfillTerminalFactsInvalidatedAt stamps a legacy non-current row that predates the column", async () => {
  await withTempDb(async () => {
    seedInstance("cin_legacy", "gmail");
    await rebuildConnectorSummaryEvidence();
    // Simulate a legacy row: non-current state, but NO invalidated_at (as if
    // this row was written before the column/write-path existed).
    getDb()
      .prepare("UPDATE connector_summary_evidence SET terminal_facts_state = 'stale' WHERE connector_instance_id = ?")
      .run("cin_legacy");
    assert.equal(rawInvalidatedAt("cin_legacy"), null, "premise: genuinely legacy — non-current but unanchored");

    const before = Date.now();
    await backfillTerminalFactsInvalidatedAt("cin_legacy");
    const after = Date.now();

    const evidence = await getConnectorSummaryEvidence("cin_legacy");
    const invalidatedAtMs = forwardEvidenceInvalidatedAtMs(evidence);
    assert.ok(invalidatedAtMs !== null, "the legacy row now has a durable anchor");
    assert.ok(invalidatedAtMs >= before && invalidatedAtMs <= after, "stamped at the moment of the repair call");
    assert.equal(isManifestGenerationInvalidatedDebt(evidence), true, "still correctly in scope after backfill");
  });
});

test("SQLite: backfillTerminalFactsInvalidatedAt is a no-op for a row already anchored (never resets an existing stamp)", async () => {
  await withTempDb(async () => {
    seedInstance("cin_already_anchored", "gmail");
    await rebuildConnectorSummaryEvidence();
    bumpEvidenceGeneration("cin_already_anchored", 1);
    seedTerminalEventAtGeneration({
      collected: 10,
      connectorInstanceId: "cin_already_anchored",
      manifestGeneration: 0,
      occurredAt: "2026-08-01T00:01:00.000Z",
      runId: "run_old",
    });
    await foldConnectorSummaryStreamFacts();
    const originalAnchor = rawInvalidatedAt("cin_already_anchored");
    assert.ok(originalAnchor, "premise: already anchored by the ordinary write path");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await backfillTerminalFactsInvalidatedAt("cin_already_anchored");

    assert.equal(
      rawInvalidatedAt("cin_already_anchored"),
      originalAnchor,
      "the guarded UPDATE's WHERE clause (terminal_facts_invalidated_at IS NULL) must never overwrite an existing anchor"
    );
  });
});

test("SQLite: backfillTerminalFactsInvalidatedAt is a no-op for a genuinely current row (never fabricates an anchor for in-scope=false)", async () => {
  await withTempDb(async () => {
    seedInstance("cin_current", "gmail");
    await rebuildConnectorSummaryEvidence();
    // Fresh row: current, unobserved -> terminal_facts_state defaults to
    // 'unobserved', which IS non-current (in scope) until a genuine fold
    // pass proves otherwise. Force it explicitly to 'current' to test the
    // out-of-scope guard specifically.
    getDb()
      .prepare("UPDATE connector_summary_evidence SET terminal_facts_state = 'current' WHERE connector_instance_id = ?")
      .run("cin_current");

    await backfillTerminalFactsInvalidatedAt("cin_current");

    assert.equal(
      rawInvalidatedAt("cin_current"),
      null,
      "a genuinely current row must never receive a fabricated anchor — the WHERE clause's terminal_facts_state != 'current' guard prevents it"
    );
  });
});

test("SQLite: a probe-driven backfill-then-reread sequence produces a usable anchor on the VERY NEXT read (the scheduler wiring's own pattern)", async () => {
  await withTempDb(async () => {
    seedInstance("cin_probe_backfill", "gmail");
    await rebuildConnectorSummaryEvidence();
    getDb()
      .prepare("UPDATE connector_summary_evidence SET terminal_facts_state = 'stale' WHERE connector_instance_id = ?")
      .run("cin_probe_backfill");

    // Mirrors scheduler-manager-factory.ts's getForwardEvidenceInvalidatedAtMs:
    // read, detect null-but-in-scope, backfill, re-read.
    let evidence = await getConnectorSummaryEvidence("cin_probe_backfill");
    assert.equal(isManifestGenerationInvalidatedDebt(evidence), true);
    assert.equal(forwardEvidenceInvalidatedAtMs(evidence), null, "premise: legacy row, no anchor yet");
    await backfillTerminalFactsInvalidatedAt("cin_probe_backfill");
    evidence = await getConnectorSummaryEvidence("cin_probe_backfill");

    assert.ok(
      forwardEvidenceInvalidatedAtMs(evidence) !== null,
      "the very next read after backfill returns a usable anchor -- this is the automatic rollout path for every pre-existing manifest-generation-invalidated connection, not just newly-invalidated ones"
    );
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
    // Second gate REVISE (2026-08-03): the prior version of this test never
    // called rebuildConnectorSummaryEvidence() after seeding the connection,
    // so connector_summary_evidence had no row at all when the test read it
    // -- the test failed with "evidence row exists" and had never actually
    // exercised the Postgres write path it claimed to prove. Mirrors every
    // SQLite test above (each calls rebuildConnectorSummaryEvidence()
    // immediately after seedInstance()).
    await rebuildConnectorSummaryEvidence();
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

test("real PostgreSQL: backfillTerminalFactsInvalidatedAt stamps a legacy non-current row, is a no-op once anchored or when current (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  if (!POSTGRES_URL) {
    return;
  }
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  const connectorInstanceId = "cin_pg_backfill";
  const currentInstanceId = "cin_pg_backfill_current";
  try {
    const now = new Date().toISOString();
    await seedPostgresConnection(connectorInstanceId, now);
    await rebuildConnectorSummaryEvidence();
    // Simulate a legacy row: non-current but predating the column/write path.
    await postgresQuery(
      "UPDATE connector_summary_evidence SET terminal_facts_state = 'stale' WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(await rawPostgresInvalidatedAt(connectorInstanceId), null, "premise: legacy, unanchored");

    await backfillTerminalFactsInvalidatedAt(connectorInstanceId);
    const stamped = await rawPostgresInvalidatedAt(connectorInstanceId);
    assert.ok(stamped, "backfill stamps a legacy non-current row on Postgres too");

    // No-op once anchored.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await backfillTerminalFactsInvalidatedAt(connectorInstanceId);
    assert.equal(
      await rawPostgresInvalidatedAt(connectorInstanceId),
      stamped,
      "backfill never overwrites an existing anchor on Postgres"
    );

    // No-op for a genuinely current row.
    await seedPostgresConnection(currentInstanceId, now);
    await rebuildConnectorSummaryEvidence();
    await postgresQuery(
      "UPDATE connector_summary_evidence SET terminal_facts_state = 'current' WHERE connector_instance_id = $1",
      [currentInstanceId]
    );
    await backfillTerminalFactsInvalidatedAt(currentInstanceId);
    assert.equal(
      await rawPostgresInvalidatedAt(currentInstanceId),
      null,
      "backfill never fabricates an anchor for a genuinely current row on Postgres"
    );
  } finally {
    // Both instances share PG_MANIFEST.connector_id — clean up together in
    // one call so the shared connectors row is only deleted once every
    // referencing instance is already gone (a partial cleanup mid-failure
    // would otherwise violate the connector_instances FK).
    await cleanupPostgres([connectorInstanceId, currentInstanceId]);
    await closePostgresStorage();
  }
});
