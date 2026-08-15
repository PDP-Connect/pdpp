// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Migration-safe scoped terminal history (Sol fourth-verdict P1.1 /
 * minimum-closure item 1): "Backfill only terminal spine_events rows whose
 * new column is null, deriving the exact same precedence from
 * data_json.connector_instance_id then data_json.connection_id... Add
 * upgrade-shaped SQLite and real-PostgreSQL tests that create old-schema/
 * old-row data before bootstrap, then exercise the real scoped route and
 * startup fold. Prove historical facts and checkpoints converge without
 * reading unrelated connections."
 *
 * Sol's deterministic reproduction: a migration-shaped terminal event with
 * `data_json.connector_instance_id` set but the new
 * `spine_events.connector_instance_id` column NULL folds
 * `{folded:0, participants:0}` on the SCOPED path (the real single-
 * connection route, `getConnectorSummaryForRoute`) while the checkpoint
 * stays put — historical evidence silently incomplete after upgrade.
 *
 * This file proves the fix: a bounded, idempotent, set-based backfill
 * migration (`migrateSpineEventsConnectorInstanceIdBackfill` on SQLite, the
 * equivalent inline `UPDATE` in the Postgres bootstrap DDL) that runs on
 * `initDb`/`initPostgresStorage` and converges pre-existing terminal rows
 * whose column is NULL but whose `data_json` carries a genuine identity —
 * without touching rows attributed to OTHER connections, and without
 * touching non-terminal event types.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  foldConnectorSummaryStreamFacts,
  getConnectorSummaryEvidence as getConnectorSummaryEvidenceUntyped,
  rebuildConnectorSummaryEvidence,
  runBoundedSummaryEvidenceSweep,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { getConnectorSummaryForRoute } from "../server/ref-control.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

// `getConnectorSummaryEvidence`'s return is genuinely `| null` (an absent
// connector instance) — every call in this file expects a real row to have
// been created by the preceding seed step, so this wrapper asserts that and
// returns the narrowed non-null evidence.
type ConnectorSummaryEvidence = NonNullable<Awaited<ReturnType<typeof getConnectorSummaryEvidenceUntyped>>>;

async function getConnectorSummaryEvidence(connectorInstanceId: string): Promise<ConnectorSummaryEvidence> {
  const evidence = await getConnectorSummaryEvidenceUntyped(connectorInstanceId);
  assert.ok(evidence, `expected summary evidence for ${connectorInstanceId}`);
  return evidence;
}

// `better-sqlite3`'s `.get()` return type is opaque to a caller reading
// specific columns from an ad-hoc SELECT; each call site here reads exactly
// the column(s) it declared in its own SQL, so this asserts the row exists
// (the SELECT's WHERE targets a row this test just inserted) and narrows to
// the caller-declared shape.
function requireRow<T>(row: T | null | undefined): T {
  assert.ok(row, "expected a row for the just-inserted fixture");
  return row;
}

const NOW = "2026-07-17T00:00:00.000Z";

const MANIFEST = {
  capabilities: { public_listing: { tier: "supported" } },
  connector_id: "spine-backfill-target",
  display_name: "Spine Backfill Target",
  protocol_version: "0.1.0",
  streams: [{ name: "messages", primary_key: ["id"] }],
  version: "1.0.0",
};

const UNRELATED_MANIFEST = {
  capabilities: { public_listing: { tier: "supported" } },
  connector_id: "spine-backfill-unrelated",
  display_name: "Spine Backfill Unrelated",
  protocol_version: "0.1.0",
  streams: [{ name: "messages", primary_key: ["id"] }],
  version: "1.0.0",
};

// ─── SQLite ─────────────────────────────────────────────────────────────

function withTempDbPath(fn: (dbPath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-spine-backfill-"));
    const dbPath = join(dir, "pdpp.sqlite");
    try {
      await fn(dbPath);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedSqliteConnection(connectorInstanceId: string, connectorId: string, manifest: unknown): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_local', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, connectorId, connectorInstanceId, NOW, NOW);
}

let sqliteEventSeq = 0;

/**
 * Insert a terminal event with `data_json` identity but the
 * `connector_instance_id` COLUMN left NULL — the exact migration-shaped
 * (pre-upgrade) row shape Sol's verdict reproduced. `column` accepts an
 * explicit override so a test can simulate "this row predates the column"
 * by inserting it as NULL directly, distinct from a genuinely unattributed
 * legacy event (identityFields null).
 */
function seedSqliteTerminalEventOldShape(
  connectorInstanceId: string,
  streams: unknown,
  { identityFields = true }: { identityFields?: boolean } = {}
): number {
  sqliteEventSeq += 1;
  const data = {
    ...(identityFields ? { connection_id: connectorInstanceId, connector_instance_id: connectorInstanceId } : {}),
    collection_facts: { reference_only: true, schema_version: 1, streams },
  };
  // This fixture is intentionally pre-trigger as well as pre-column: a
  // current write is source-stamped immediately and must not masquerade as
  // an upgrade-era row.
  getDb().exec("DROP TRIGGER IF EXISTS stamp_terminal_manifest_generation");
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       )
       VALUES(?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, NULL, ?, '1')`
    )
    .run(
      `evt_${sqliteEventSeq}`,
      sqliteEventSeq,
      NOW,
      NOW,
      `trace_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      JSON.stringify(data)
    );
  return sqliteEventSeq;
}

test(
  "SQLite: migration backfills identity and a never-advanced connection consumes pre-generation terminal facts as current",
  withTempDbPath(async (dbPath) => {
    // Boot 1: create the connection + a current evidence row at checkpoint 0
    // (no terminal events exist yet) — the migration/column/index already
    // exist from this boot forward.
    initDb(dbPath);
    seedSqliteConnection("cin_backfill_target", MANIFEST.connector_id, MANIFEST);
    await rebuildConnectorSummaryEvidence();
    const before = await getConnectorSummaryEvidence("cin_backfill_target");
    assert.equal(before.stream_facts_event_seq, 0, "starts genuinely checkpointed-empty, not unobserved");

    // Insert a migration-shaped terminal event: data_json carries the
    // identity, but the column is NULL — exactly what a row written before
    // this migration existed would look like.
    const targetEventSeq = seedSqliteTerminalEventOldShape("cin_backfill_target", [
      { record_count: 7, resolved: true, stream: "messages" },
    ]);
    const preBackfillColumn = requireRow<{ connector_instance_id: string | null }>(
      getDb().prepare("SELECT connector_instance_id FROM spine_events WHERE event_id = ?").get(`evt_${targetEventSeq}`)
    );
    assert.equal(preBackfillColumn.connector_instance_id, null, "fixture: the column is genuinely NULL before reboot");
    closeDb();

    // Boot 2 ("the upgrade boot"): initDb runs the backfill migration.
    initDb(dbPath);
    const postBackfillColumn = requireRow<{ connector_instance_id: string | null }>(
      getDb().prepare("SELECT connector_instance_id FROM spine_events WHERE event_id = ?").get(`evt_${targetEventSeq}`)
    );
    assert.equal(
      postBackfillColumn.connector_instance_id,
      "cin_backfill_target",
      "the backfill migration populates the column from data_json.connector_instance_id on the next boot"
    );

    const manifestGenerationRow = requireRow<{ manifest_generation: number | null }>(
      getDb().prepare("SELECT manifest_generation FROM spine_events WHERE event_id = ?").get(`evt_${targetEventSeq}`)
    );
    assert.equal(
      manifestGenerationRow.manifest_generation,
      null,
      "identity migration never invents a source generation for an old terminal row"
    );

    // fix-pre-provenance-terminal-generation-semantics: the connection's
    // durable generation has never advanced past 0, so the real SCOPED path
    // consumes the unstamped event as current-generation evidence — the
    // pre-provenance era and generation 0 are the same declaration epoch.
    const scoped = await foldConnectorSummaryStreamFacts(["cin_backfill_target"]);
    assert.equal(scoped.participants, 1);
    assert.equal(scoped.folded, 1, "a never-advanced connection consumes its unstamped terminal history as current");
    assert.equal(scoped.refused, 0);

    const evidence = await getConnectorSummaryEvidence("cin_backfill_target");
    assert.equal(
      evidence.stream_facts_event_seq,
      targetEventSeq,
      "the pre-provenance event advances the current terminal checkpoint"
    );
    assert.ok(evidence.stream_latest_facts, "the pre-provenance fact is now the current stored fact map");
    assert.equal(evidence.terminal_facts?.state, "current");
    assert.equal(evidence.terminal_facts?.reason_code, null);

    closeDb();
  })
);

test(
  "SQLite: a genuine generation transition permanently refuses prior unstamped and stamped-zero history",
  withTempDbPath(async (dbPath) => {
    initDb(dbPath);
    seedSqliteConnection("cin_backfill_transition", MANIFEST.connector_id, MANIFEST);
    await rebuildConnectorSummaryEvidence();

    // Pre-transition: an unstamped (pre-provenance) terminal event at
    // generation 0 — consumed as current, per the fix above. Reboot first so
    // the identity-backfill migration populates the event's
    // `connector_instance_id` column from `data_json` (a scoped fold reads
    // that column directly, not `data_json`).
    seedSqliteTerminalEventOldShape("cin_backfill_transition", [
      { record_count: 5, resolved: true, stream: "messages" },
    ]);
    closeDb();
    initDb(dbPath);
    const preTransition = await foldConnectorSummaryStreamFacts(["cin_backfill_transition"]);
    assert.equal(preTransition.folded, 1);
    const beforeTransition = await getConnectorSummaryEvidence("cin_backfill_transition");
    assert.equal(beforeTransition.terminal_facts?.state, "current");

    // A genuine manifest transition: advance the connection's durable
    // generation directly (mirrors what `persistManifestAndAdvanceGenerations`
    // does on a real manifest change: `manifest_generation = manifest_generation
    // + 1`, `dirty = 1, state = 'stale'`), then let the real reconcile barrier
    // sync the evidence row's own `manifest_generation` column — exactly as
    // the production registry transaction plus its reconcile pass would.
    getDb()
      .prepare("UPDATE connector_instances SET manifest_generation = 1 WHERE connector_instance_id = ?")
      .run("cin_backfill_transition");
    getDb()
      .prepare("UPDATE connector_summary_evidence SET dirty = 1, state = 'stale' WHERE connector_instance_id = ?")
      .run("cin_backfill_transition");
    await rebuildConnectorSummaryEvidence();

    // A converged fold pass with ZERO new terminal events since the
    // transition boundary (the ordinary case immediately after
    // `rebuildConnectorSummaryEvidence()`'s own reconcile-triggered fold)
    // MUST preserve the transition's historical write, not silently heal to
    // current on pure silence — `seedFoldState` now seeds
    // `generationCurrentByInstance` from each participant's own incoming
    // `terminal_facts_state`, so "no qualifying event this round" inherits
    // the row's already-non-current verdict instead of defaulting to true.
    const rightAfterTransition = await getConnectorSummaryEvidence("cin_backfill_transition");
    assert.equal(
      rightAfterTransition.terminal_facts?.state,
      "stale",
      "a converged zero-new-event fold pass after a generation transition must preserve the historical write"
    );
    assert.equal(rightAfterTransition.terminal_facts?.reason_code, "terminal_facts_historical");

    // Simulate the pre-transition event now carrying a generation-0 stamp
    // (as if it had been stamped just before the transition landed) and
    // force one more fold pass. The event already sits at/below this
    // connection's checkpoint (nothing new to read), so `folded`/`refused`
    // are both genuinely zero this pass — the assertion that matters is that
    // the state stays historical, not that this specific pass counts a refusal.
    getDb().exec(
      "UPDATE spine_events SET manifest_generation = 0 WHERE connector_instance_id = 'cin_backfill_transition' AND manifest_generation IS NULL"
    );
    const afterTransition = await foldConnectorSummaryStreamFacts(["cin_backfill_transition"]);
    assert.equal(
      afterTransition.folded,
      0,
      "post-transition, the generation-0-stamped history is not consumed as new proof"
    );

    const evidence = await getConnectorSummaryEvidence("cin_backfill_transition");
    assert.equal(evidence.terminal_facts?.state, "stale");
    assert.equal(evidence.terminal_facts?.reason_code, "terminal_facts_historical");

    // A post-transition terminal event, stamped with the new generation, IS
    // consumed as current.
    getDb().exec("DROP TRIGGER IF EXISTS stamp_terminal_manifest_generation");
    getDb()
      .prepare(
        `INSERT INTO spine_events(
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, manifest_generation, data_json, version
         )
         VALUES('evt_post_transition', (SELECT COALESCE(MAX(event_seq),0)+1 FROM spine_events), 'run.completed', ?, ?, 'test', 'trace_post', 'runtime', 'test-connector', 'run', 'run_post', 'succeeded', 'run_post', 'cin_backfill_transition', 1, ?, '1')`
      )
      .run(
        NOW,
        NOW,
        JSON.stringify({
          collection_facts: {
            reference_only: true,
            schema_version: 1,
            streams: [{ record_count: 11, resolved: true, stream: "messages" }],
          },
          connection_id: "cin_backfill_transition",
          connector_instance_id: "cin_backfill_transition",
        })
      );
    const postTransitionFold = await foldConnectorSummaryStreamFacts(["cin_backfill_transition"]);
    assert.equal(
      postTransitionFold.folded,
      1,
      "a post-transition, correctly-stamped terminal event is consumed as current"
    );
    const finalEvidence = await getConnectorSummaryEvidence("cin_backfill_transition");
    assert.equal(finalEvidence.terminal_facts?.state, "current");

    closeDb();
  })
);

test(
  "SQLite: the backfill does not cross connections and leaves genuinely unattributable legacy events refused",
  withTempDbPath(async (dbPath) => {
    initDb(dbPath);
    seedSqliteConnection("cin_backfill_target", MANIFEST.connector_id, MANIFEST);
    seedSqliteConnection("cin_backfill_unrelated", UNRELATED_MANIFEST.connector_id, UNRELATED_MANIFEST);
    await rebuildConnectorSummaryEvidence();

    const targetSeq = seedSqliteTerminalEventOldShape("cin_backfill_target", [
      { record_count: 3, resolved: true, stream: "messages" },
    ]);
    const unrelatedSeq = seedSqliteTerminalEventOldShape("cin_backfill_unrelated", [
      { record_count: 9, resolved: true, stream: "messages" },
    ]);
    // A genuinely unattributable legacy event: no identity in data_json at
    // all (a real pre-scoping connector-wide event) — the backfill must
    // leave this NULL, not fabricate an attribution.
    const unattributedSeq = seedSqliteTerminalEventOldShape("cin_backfill_target", [], { identityFields: false });
    closeDb();

    initDb(dbPath);
    const rows = getDb()
      .prepare("SELECT event_id, connector_instance_id FROM spine_events WHERE event_id IN (?, ?, ?)")
      .all(`evt_${targetSeq}`, `evt_${unrelatedSeq}`, `evt_${unattributedSeq}`) as Array<{
      event_id: string;
      connector_instance_id: string | null;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.event_id, r.connector_instance_id]));
    assert.equal(byId[`evt_${targetSeq}`], "cin_backfill_target");
    assert.equal(byId[`evt_${unrelatedSeq}`], "cin_backfill_unrelated");
    assert.equal(
      byId[`evt_${unattributedSeq}`],
      null,
      "a genuinely unattributable legacy event (no identity in data_json) stays NULL — the backfill never fabricates one"
    );

    // Scoped fold for the target sees ONLY its own backfilled row — the
    // unattributed event's column is genuinely NULL, so it can never match
    // the scoped `connector_instance_id IN (...)` read at all (it is never
    // "scoped in", not merely refused). The source-attributed event IS
    // consumed as current (never-advanced, generation 0) — proving no
    // blanket resurrection: attribution is still the load-bearing gate, only
    // the generation-match predicate changed.
    const scoped = await foldConnectorSummaryStreamFacts(["cin_backfill_target"]);
    assert.equal(
      scoped.participants,
      1,
      "only the source-attributed row is scoped in; the unattributed row is invisible to a scoped read"
    );
    assert.equal(scoped.folded, 1, "the source-attributed legacy event is consumed as current-generation evidence");
    assert.equal(scoped.refused, 0);

    const targetEvidence = await getConnectorSummaryEvidence("cin_backfill_target");
    assert.ok(
      targetEvidence.stream_latest_facts,
      "the attributed pre-provenance fact is now the current stored fact map"
    );
    assert.equal(targetEvidence.terminal_facts?.state, "current");
    const unrelatedEvidence = await getConnectorSummaryEvidence("cin_backfill_unrelated");
    assert.equal(
      unrelatedEvidence.stream_facts_event_seq,
      0,
      "the unrelated connection is untouched by the target-scoped fold"
    );

    closeDb();
  })
);

test(
  "SQLite: the real mounted route and startup sweep converge a never-advanced connection to current terminal facts after reboot",
  withTempDbPath(async (dbPath) => {
    initDb(dbPath);
    seedSqliteConnection("cin_backfill_route", MANIFEST.connector_id, MANIFEST);
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, version, deleted)
         VALUES (?, 'cin_backfill_route', 'messages', 'r1', '{}', ?, ?, 1, 0)`
      )
      .run(MANIFEST.connector_id, NOW, NOW);
    await rebuildConnectorSummaryEvidence();
    const routeEventSeq = seedSqliteTerminalEventOldShape("cin_backfill_route", [
      { record_count: 1, resolved: true, stream: "messages" },
    ]);
    closeDb();

    initDb(dbPath);
    const routeSummary = await getConnectorSummaryForRoute("cin_backfill_route");
    assert.ok(routeSummary, "the real single-connection route resolves after the upgrade boot");
    assert.equal(routeSummary.total_records, 1);
    assert.equal(
      routeSummary.stream_records?.find((s) => s.stream === "messages")?.record_count,
      1,
      "canonical records remain visible independently of terminal provenance"
    );

    // fix-pre-provenance-terminal-generation-semantics: this connection has
    // never advanced past generation 0, so its pre-provenance terminal event
    // is consumed as current — no per-row repair, no data migration, this is
    // the existing reconcile-before-read barrier replaying it under the new
    // fold-contract version.
    assert.equal(routeSummary.terminal_facts.state, "current");

    // The startup sweep (which pages connections into the same scoped
    // barrier) independently converges to the same current verdict.
    const sweep = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: 25 });
    assert.equal(sweep.incomplete, false);
    const evidence = await getConnectorSummaryEvidence("cin_backfill_route");
    assert.equal(evidence.stream_facts_event_seq, routeEventSeq);
    assert.equal(evidence.terminal_facts?.state, "current");

    closeDb();
  })
);

// ─── Postgres (gated) ───────────────────────────────────────────────────

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function postgresUrl(): string {
  assert.ok(POSTGRES_URL, "PostgreSQL test requires PDPP_TEST_POSTGRES_URL");
  return POSTGRES_URL;
}

async function seedPostgresConnection(
  connectorInstanceId: string,
  connectorId: string,
  manifest: unknown
): Promise<void> {
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    connectorId,
    JSON.stringify(manifest),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [connectorInstanceId, connectorId, NOW]
  );
}

let postgresEventSeq = 0;

async function seedPostgresTerminalEventOldShape(
  connectorInstanceId: string,
  streams: unknown,
  { identityFields = true }: { identityFields?: boolean } = {}
): Promise<string> {
  postgresEventSeq += 1;
  const data = {
    ...(identityFields ? { connection_id: connectorInstanceId, connector_instance_id: connectorInstanceId } : {}),
    collection_facts: { reference_only: true, schema_version: 1, streams },
  };
  await postgresQuery("ALTER TABLE spine_events DISABLE TRIGGER stamp_terminal_manifest_generation");
  try {
    await postgresQuery(
      `INSERT INTO spine_events(
       event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
     )
     VALUES($1, (SELECT COALESCE(MAX(event_seq),0)+1 FROM spine_events), 'run.completed', $2, $2, 'test', $3, 'runtime', 'test-connector', 'run', $4, 'succeeded', $5, NULL, $6::jsonb, '1')`,
      [
        `evt_pg_backfill_${postgresEventSeq}`,
        NOW,
        `trace_pg_backfill_${postgresEventSeq}`,
        `run_pg_backfill_${postgresEventSeq}`,
        `run_pg_backfill_${postgresEventSeq}`,
        JSON.stringify(data),
      ]
    );
  } finally {
    await postgresQuery("ALTER TABLE spine_events ENABLE TRIGGER stamp_terminal_manifest_generation");
  }
  return `evt_pg_backfill_${postgresEventSeq}`;
}

async function cleanupPostgres() {
  for (const connectorId of [MANIFEST.connector_id, UNRELATED_MANIFEST.connector_id]) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_id = $1", [connectorId]);
    await postgresQuery("DELETE FROM records WHERE connector_id = $1", [connectorId]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_id = $1", [connectorId]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
  }
  await postgresQuery("DELETE FROM spine_events WHERE event_id LIKE $1", ["evt_pg_backfill_%"]);
  postgresEventSeq = 0;
}

test("real PostgreSQL: migration backfills identity and a never-advanced connection consumes pre-generation terminal facts as current (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/suspicious/noEvolvingTypes: test fixture inference is intentionally widened
  // biome-ignore lint/suspicious/noImplicitAnyLet: value is assigned after backend initialization
  let beforeCheckpoint;
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl() });
  try {
    await cleanupPostgres();
    await seedPostgresConnection("cin_backfill_target_pg", MANIFEST.connector_id, MANIFEST);
    await rebuildConnectorSummaryEvidence();
    const before = await getConnectorSummaryEvidence("cin_backfill_target_pg");
    beforeCheckpoint = Number(before.stream_facts_event_seq);

    const eventId = await seedPostgresTerminalEventOldShape("cin_backfill_target_pg", [
      { record_count: 7, resolved: true, stream: "messages" },
    ]);
    const preBackfill = await postgresQuery<{ connector_instance_id: string | null }>(
      "SELECT connector_instance_id FROM spine_events WHERE event_id = $1",
      [eventId]
    );
    const preBackfillRow = requireRow(preBackfill.rows[0]);
    assert.equal(preBackfillRow.connector_instance_id, null, "fixture: genuinely NULL before reboot");
  } finally {
    await closePostgresStorage();
  }

  // "Reboot": close and reopen storage — the bootstrap DDL (including the
  // backfill UPDATE) runs again on initPostgresStorage.
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl() });
  try {
    const eventRow = await postgresQuery<{ connector_instance_id: string | null; manifest_generation: number | null }>(
      "SELECT event_id, connector_instance_id, manifest_generation FROM spine_events WHERE event_id LIKE 'evt_pg_backfill_%' ORDER BY event_seq DESC LIMIT 1"
    );
    const backfilledEvent = requireRow(eventRow.rows[0]);
    assert.equal(
      backfilledEvent.connector_instance_id,
      "cin_backfill_target_pg",
      "the backfill UPDATE populates the column from data_json on the next bootstrap"
    );
    assert.equal(backfilledEvent.manifest_generation, null, "bootstrap does not invent legacy source provenance");

    // fix-pre-provenance-terminal-generation-semantics: never-advanced
    // (generation 0) connection consumes its unstamped terminal event as
    // current.
    const scoped = await foldConnectorSummaryStreamFacts(["cin_backfill_target_pg"]);
    assert.equal(scoped.participants, 1);
    assert.equal(scoped.folded, 1);
    assert.equal(scoped.refused, 0);

    const evidence = await getConnectorSummaryEvidence("cin_backfill_target_pg");
    assert.ok(
      Number(evidence.stream_facts_event_seq) > beforeCheckpoint,
      "the pre-provenance event advances the checkpoint"
    );
    assert.ok(evidence.stream_latest_facts, "the pre-provenance fact is now current");
    assert.equal(evidence.terminal_facts?.state, "current");
    assert.equal(evidence.terminal_facts?.reason_code, null);
  } finally {
    await cleanupPostgres();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: a genuine generation transition permanently refuses prior unstamped history (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl() });
  try {
    await cleanupPostgres();
    await seedPostgresConnection("cin_backfill_transition_pg", MANIFEST.connector_id, MANIFEST);
    await rebuildConnectorSummaryEvidence();
    await seedPostgresTerminalEventOldShape("cin_backfill_transition_pg", [
      { record_count: 5, resolved: true, stream: "messages" },
    ]);
  } finally {
    await closePostgresStorage();
  }

  // "Reboot": the bootstrap DDL (including the identity backfill UPDATE)
  // runs again on initPostgresStorage, populating the event's
  // connector_instance_id column from data_json.
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl() });
  try {
    const preTransition = await foldConnectorSummaryStreamFacts(["cin_backfill_transition_pg"]);
    assert.equal(preTransition.folded, 1, "never-advanced connection consumes the pre-provenance event as current");
    const beforeTransition = await getConnectorSummaryEvidence("cin_backfill_transition_pg");
    assert.equal(beforeTransition.terminal_facts?.state, "current");

    // A genuine manifest transition: advance the durable generation and
    // dirty evidence, mirroring the production registry transaction
    // (`persistManifestAndAdvanceGenerations`: `manifest_generation =
    // manifest_generation + 1`, `dirty = 1, state = 'stale'`).
    await postgresQuery("UPDATE connector_instances SET manifest_generation = 1 WHERE connector_instance_id = $1", [
      "cin_backfill_transition_pg",
    ]);
    await postgresQuery(
      "UPDATE connector_summary_evidence SET dirty = 1, state = 'stale' WHERE connector_instance_id = $1",
      ["cin_backfill_transition_pg"]
    );
    await rebuildConnectorSummaryEvidence();

    // A converged fold pass with ZERO new terminal events since the
    // transition boundary MUST preserve the transition's historical write,
    // not silently heal to current on pure silence — `seedFoldState` seeds
    // `generationCurrentByInstance` from each participant's own incoming
    // `terminal_facts_state`, so "no qualifying event this round" inherits
    // the row's already-non-current verdict instead of defaulting to true.
    const rightAfterTransition = await getConnectorSummaryEvidence("cin_backfill_transition_pg");
    assert.equal(
      rightAfterTransition.terminal_facts?.state,
      "stale",
      "a converged zero-new-event fold pass after a generation transition must preserve the historical write"
    );
    assert.equal(rightAfterTransition.terminal_facts?.reason_code, "terminal_facts_historical");

    // Simulate the pre-transition event now carrying a generation-0 stamp
    // and force one more fold pass. The event already sits at/below this
    // connection's checkpoint (nothing new to read), so `folded` is
    // genuinely zero this pass — the assertion that matters is that the
    // state stays historical.
    await postgresQuery(
      "UPDATE spine_events SET manifest_generation = 0 WHERE connector_instance_id = $1 AND manifest_generation IS NULL",
      ["cin_backfill_transition_pg"]
    );

    const afterTransition = await foldConnectorSummaryStreamFacts(["cin_backfill_transition_pg"]);
    assert.equal(
      afterTransition.folded,
      0,
      "post-transition, the generation-0-stamped history is not consumed as new proof"
    );

    const evidence = await getConnectorSummaryEvidence("cin_backfill_transition_pg");
    assert.equal(evidence.terminal_facts?.state, "stale");
    assert.equal(evidence.terminal_facts?.reason_code, "terminal_facts_historical");
  } finally {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [
      "cin_backfill_transition_pg",
    ]);
    await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", ["cin_backfill_transition_pg"]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [
      "cin_backfill_transition_pg",
    ]);
    await cleanupPostgres();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: the backfill does not cross connections and leaves genuinely unattributable legacy events NULL", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl() });
  let targetEventId = "";
  let unrelatedEventId = "";
  let unattributedEventId = "";
  let unrelatedBaseline = 0;
  try {
    await cleanupPostgres();
    await seedPostgresConnection("cin_backfill_target_pg", MANIFEST.connector_id, MANIFEST);
    await seedPostgresConnection("cin_backfill_unrelated_pg", UNRELATED_MANIFEST.connector_id, UNRELATED_MANIFEST);
    await rebuildConnectorSummaryEvidence();
    unrelatedBaseline = Number((await getConnectorSummaryEvidence("cin_backfill_unrelated_pg")).stream_facts_event_seq);

    targetEventId = await seedPostgresTerminalEventOldShape("cin_backfill_target_pg", [
      { record_count: 3, resolved: true, stream: "messages" },
    ]);
    unrelatedEventId = await seedPostgresTerminalEventOldShape("cin_backfill_unrelated_pg", [
      { record_count: 9, resolved: true, stream: "messages" },
    ]);
    unattributedEventId = await seedPostgresTerminalEventOldShape("cin_backfill_target_pg", [], {
      identityFields: false,
    });
  } finally {
    await closePostgresStorage();
  }

  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl() });
  try {
    const rows = await postgresQuery<{ connector_instance_id: string | null; event_id: string }>(
      "SELECT event_id, connector_instance_id FROM spine_events WHERE event_id = ANY($1::text[])",
      [[targetEventId, unrelatedEventId, unattributedEventId]]
    );
    const byId = Object.fromEntries(rows.rows.map((row) => [row.event_id, row.connector_instance_id]));
    assert.equal(byId[targetEventId], "cin_backfill_target_pg");
    assert.equal(byId[unrelatedEventId], "cin_backfill_unrelated_pg");
    assert.equal(
      byId[unattributedEventId],
      null,
      "a genuinely unattributable legacy event stays NULL on real PostgreSQL too"
    );

    // Scoped fold sees ONLY the source-attributed row — the unattributed
    // event's column is genuinely NULL, so it can never match the scoped
    // `connector_instance_id = ANY(...)` read (invisible, not merely
    // refused). The attributed event IS consumed as current
    // (never-advanced, generation 0).
    const scoped = await foldConnectorSummaryStreamFacts(["cin_backfill_target_pg"]);
    assert.equal(scoped.participants, 1);
    assert.equal(scoped.folded, 1);
    assert.equal(scoped.refused, 0);

    const unrelatedEvidence = await getConnectorSummaryEvidence("cin_backfill_unrelated_pg");
    assert.equal(
      Number(unrelatedEvidence.stream_facts_event_seq),
      unrelatedBaseline,
      "the unrelated connection is untouched by the target-scoped fold"
    );
  } finally {
    await cleanupPostgres();
    await closePostgresStorage();
  }
});
