// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The manifest-generation counter is a COARSE fence: it advances on any byte
 * of any manifest (`auth.ts` `persistManifestAndAdvanceGenerations`). The
 * terminal-facts fold, however, reads no manifest content at all — it folds
 * `collection_facts.streams` off the spine event, keyed by stream name. The
 * only manifest section it depends on is the set of declared stream names,
 * which is exactly what `manifest_fingerprint` already records.
 *
 * Measured on the owner's live instance immediately after a deploy: 18 of 29
 * connections sat at `terminal_facts_state='stale'` /
 * `terminal_facts_historical` while their data was intact and their last runs
 * had succeeded. A boot-time reconcile of 24 manifests — an edit to
 * `capabilities.refresh_policy`, a section the fold never reads — was enough
 * to blank the board, and only a completed RUN could clear it.
 *
 * These probes pin the distinction the generation counter alone cannot make:
 *
 *   Probe 1: a manifest edit OUTSIDE the streams section advances the
 *   generation but must NOT discard terminal facts.
 *
 *   Probe 2: a manifest edit that changes the declared streams still DOES
 *   discard them — facts folded under an old declaration cannot be
 *   reattached to a changed one. The fence is narrowed, never removed.
 *
 * Both drive the real production entry point
 * (`reconcileConnectorSummaryEvidence`) against real SQLite.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { invalidateConnectorSummariesCache, listConnectorSummaries } from "../server/ref-control.ts";

const OWNER = "owner_local";
const NOW = "2026-08-21T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/fine-grained-invalidation";
const INSTANCE_ID = "cin_fine_grained_invalidation";
const STREAM = "messages";

interface JsonRecord {
  [key: string]: any;
}

function manifest(options: { recommendedMode: string; streams: readonly string[] }): JsonRecord {
  return {
    capabilities: {
      public_listing: { tier: "supported" },
      // The section the live incident actually edited across 24 manifests,
      // and the one the terminal fold never reads.
      refresh_policy: { recommended_mode: options.recommendedMode },
    },
    connector_id: CONNECTOR_ID,
    display_name: "Fine-Grained Invalidation Probe",
    protocol_version: "0.1.0",
    streams: options.streams.map((name) => ({
      coverage_strategy: "full_inventory",
      name,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    })),
    version: "1.0.0",
  };
}

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-fine-grained-invalidation-"));
  invalidateConnectorSummariesCache();
  initDb(join(dir, "pdpp.sqlite"));
  try {
    return await fn();
  } finally {
    invalidateConnectorSummariesCache();
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function seed(initialManifest: JsonRecord): void {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(initialManifest), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(INSTANCE_ID, OWNER, CONNECTOR_ID, "Fine-Grained Invalidation Probe", INSTANCE_ID, NOW, NOW);
}

/**
 * Stand in for a completed run's folded terminal facts: a row whose terminal
 * component is genuinely `current` with real facts attached. This is the
 * state the live incident destroyed — intact, attributable, run-backed
 * evidence — so it is what the probes must protect.
 */
function stampFoldedTerminalFacts(): void {
  getDb()
    .prepare(
      `UPDATE connector_summary_evidence
          SET terminal_facts_state = 'current',
              terminal_facts_reason_code = NULL,
              stream_latest_facts_json = ?,
              stream_facts_event_seq = 42
        WHERE connector_instance_id = ?`
    )
    .run(
      JSON.stringify({ [STREAM]: { event_seq: 42, fact: { checkpoint: "committed", stream: STREAM } } }),
      INSTANCE_ID
    );
}

/**
 * Advance the generation the way the real boundary does
 * (`persistManifestAndAdvanceGenerations`): rewrite the manifest and bump
 * every affected connection's counter in the same step.
 */
function persistManifestAndAdvanceGeneration(next: JsonRecord): void {
  getDb().prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?").run(JSON.stringify(next), CONNECTOR_ID);
  getDb()
    .prepare("UPDATE connector_instances SET manifest_generation = manifest_generation + 1 WHERE connector_id = ?")
    .run(CONNECTOR_ID);
}

function terminalFacts(): JsonRecord {
  const row = getDb()
    .prepare(
      `SELECT terminal_facts_state, terminal_facts_reason_code, stream_latest_facts_json, manifest_generation
         FROM connector_summary_evidence WHERE connector_instance_id = ?`
    )
    .get(INSTANCE_ID);
  assert.ok(row, "the probe connection must have an evidence row");
  return row as JsonRecord;
}

test("a manifest edit outside the streams section does not blank terminal facts", () =>
  withTempDb(async () => {
    seed(manifest({ recommendedMode: "automatic", streams: [STREAM] }));
    await reconcileConnectorSummaryEvidence(null);
    stampFoldedTerminalFacts();

    // The exact live trigger: edit `refresh_policy.recommended_mode` only.
    // The declared streams are byte-identical before and after.
    persistManifestAndAdvanceGeneration(manifest({ recommendedMode: "manual", streams: [STREAM] }));
    const generationBefore = Number(terminalFacts().manifest_generation);

    await reconcileConnectorSummaryEvidence(null);

    const after = terminalFacts();
    assert.ok(
      Number(after.manifest_generation) > generationBefore,
      "the outer generation fence still advances — it is narrowed at the consumer, not disarmed at the source"
    );
    assert.equal(
      after.terminal_facts_state,
      "current",
      "coverage evidence does not read refresh_policy, so editing it must not invalidate the evidence"
    );
    assert.notEqual(after.terminal_facts_reason_code, "manifest_generation_changed");
    assert.ok(
      String(after.stream_latest_facts_json ?? "").includes(STREAM),
      "the folded facts themselves survive; a run must not be required to restore them"
    );
  }));

test("an unreadable declaration falls back to the coarse generation verdict", () =>
  withTempDb(async () => {
    seed(manifest({ recommendedMode: "automatic", streams: [STREAM] }));
    await reconcileConnectorSummaryEvidence(null);
    stampFoldedTerminalFacts();

    // A legacy row (written before fingerprints existed) or a manifest the
    // declaration reader cannot parse leaves one side of the comparison
    // unknown. "Unknown" is not "unchanged": with no declaration to compare,
    // the narrow fence cannot prove the facts are still attributable, so the
    // outer generation verdict must stand. Fail closed — this is the
    // direction that costs a run, never the one that shows false evidence.
    getDb()
      .prepare("UPDATE connector_summary_evidence SET manifest_fingerprint = NULL WHERE connector_instance_id = ?")
      .run(INSTANCE_ID);
    persistManifestAndAdvanceGeneration(manifest({ recommendedMode: "manual", streams: [STREAM] }));

    await reconcileConnectorSummaryEvidence(null);

    const after = terminalFacts();
    assert.equal(
      after.terminal_facts_state,
      "stale",
      "with no declaration to compare, the conservative generation fence still applies"
    );
    assert.equal(after.terminal_facts_reason_code, "manifest_generation_changed");
  }));

test("a manifest edit that changes the declared streams still blanks terminal facts", () =>
  withTempDb(async () => {
    seed(manifest({ recommendedMode: "automatic", streams: [STREAM] }));
    await reconcileConnectorSummaryEvidence(null);
    stampFoldedTerminalFacts();

    // A real declaration change: the fold keys facts by stream name, so facts
    // folded under the old declaration are no longer attributable.
    persistManifestAndAdvanceGeneration(manifest({ recommendedMode: "automatic", streams: [STREAM, "reactions"] }));

    await reconcileConnectorSummaryEvidence(null);

    const after = terminalFacts();
    assert.equal(
      after.terminal_facts_state,
      "stale",
      "narrowing the fence must not disarm it: a changed declaration still invalidates"
    );
    assert.equal(after.terminal_facts_reason_code, "manifest_generation_changed");
    assert.equal(after.stream_latest_facts_json, null, "facts from a superseded declaration are discarded, not reused");
  }));

test("the health boundary stays fail-closed, so the fix belongs upstream of it", () =>
  withTempDb(async () => {
    seed(manifest({ recommendedMode: "automatic", streams: [STREAM] }));
    await reconcileConnectorSummaryEvidence(null);

    // The shape all 16 blocked rows held on the live instance: the run-scoped
    // terminal fact is absent, while the record evidence beside it is current
    // and intact (2.4M records on claude-code, 1.3M on codex).
    //
    // It is tempting to read that as an inconsistency and carve
    // `terminal_facts_historical` out of `evidenceUnreliableSources` — one row
    // backing the LIST projection while reading projection-unreliable for
    // HEALTH. That carve-out is deliberately NOT made here. The design's
    // "Health boundary" rule states the terminal component is a
    // `ProjectionReliable` input at highest precedence and "cannot be
    // overwritten", and `connector-summary-historical-terminal-facts-health.
    // test.ts` guards it: a legacy fact must never stand in as current proof.
    //
    // The two consumers are not actually in contradiction. They read DIFFERENT
    // components of the row — the list gates on `record_snapshot`, health gates
    // on `terminal_facts` — which is the documented "components are
    // independent" design, not an accident. The real defect was never that
    // health distrusts a missing terminal fact; it was that the fact went
    // missing at all for connections whose declarations never changed. So the
    // fix belongs upstream, at the invalidation boundary the probes above pin,
    // and this boundary stays fail-closed.
    getDb()
      .prepare(
        `UPDATE connector_summary_evidence
            SET terminal_facts_state = 'stale',
                terminal_facts_reason_code = 'terminal_facts_historical',
                record_snapshot_state = 'current'
          WHERE connector_instance_id = ?`
      )
      .run(INSTANCE_ID);

    invalidateConnectorSummariesCache();
    const summaries = (await listConnectorSummaries(null, {
      concurrency: 1,
      includeRunSummaries: false,
    })) as JsonRecord[];
    const summary = summaries.find((row) => row.connector_instance_id === INSTANCE_ID);
    assert.ok(summary, "the probe connection must be listed");
    const projection = summary.connection_health.conditions.find(
      (candidate: JsonRecord) => candidate.type === "ProjectionReliable"
    );
    assert.equal(
      projection?.status,
      "false",
      "the health boundary stays fail-closed; the invalidation fence upstream is what was fixed"
    );

    // And when it does fire, it now names a cause whose remedy is a run.
    assert.equal(projection?.reason, "projection_superseded_by_definition_change");
    assert.equal(projection?.remediation?.action, "retry_by_runtime");
  }));

test("a remove-and-readd that returns to an identical declaration still invalidates", () =>
  withTempDb(async () => {
    seed(manifest({ recommendedMode: "automatic", streams: [STREAM] }));
    await reconcileConnectorSummaryEvidence(null);
    stampFoldedTerminalFacts();

    // ABA: drop the stream and add it back before any reconcile observes the
    // gap. The declaration ends byte-identical, so the fingerprint alone reads
    // "unchanged" — but the facts folded before the removal must not be
    // reattached to the re-added stream. The monotonic counter is what still
    // sees it: the generation advanced twice, so a declaration state passed
    // unobserved, and an unobserved state is not evidence of continuity.
    persistManifestAndAdvanceGeneration(manifest({ recommendedMode: "automatic", streams: ["other"] }));
    persistManifestAndAdvanceGeneration(manifest({ recommendedMode: "automatic", streams: [STREAM] }));

    await reconcileConnectorSummaryEvidence(null);

    const after = terminalFacts();
    assert.equal(
      after.terminal_facts_state,
      "stale",
      "an unobserved multi-step advance falls back to the coarse verdict; a value cannot prove a history"
    );
    assert.equal(after.stream_latest_facts_json, null, "pre-removal facts are not restored by a re-add");
  }));
