// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A PERSISTED `count_state: "known_zero"` must re-prove itself at the READ
 * boundary, not merely at the write that produced it.
 *
 * `count_state` is derived once, when an evidence row is repaired, and then
 * served verbatim out of `stream_records_json`. Repair classification never
 * inspects that column: a row whose checkpoint and total have not moved is
 * classified as needing no repair, forever. So a `known_zero` written before
 * positive proof was required keeps reaching every consumer — on a row whose
 * `record_snapshot.state` reads a perfectly healthy `current`, which is
 * exactly why the staleness downgrade never catches it.
 *
 * Ruling R2 governs both directions. Checkpoint commitment alone never proves
 * coverage; and the converse — the prohibition at stake here — is that a
 * stream with no positive coverage evidence, and in the worst case no runtime
 * fact whatsoever, must never assert a proven exact zero. `unobserved` is the
 * honest state for an absence of evidence.
 *
 * The judgement is the shared contract invariant (`evaluateStreamCoherence` in
 * `@pdpp/reference-contract/evidence`), reached through
 * `persistedZeroRetainsCoverageProof` so the RI cannot drift from conformance
 * tooling on the same facts.
 *
 * The third test is the COUNTERWEIGHT: a genuinely proven zero must survive.
 * Withdrawing true zeros would trade one dishonest claim for another.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { listConnectorSummaries } from "../server/ref-control.ts";

const OWNER = "owner_local";
const NOW = "2026-08-09T00:00:00.000Z";

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-persisted-count-state-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function seedManifestConnector(connectorId: string, streams: string[]): void {
  const manifest = {
    capabilities: {
      public_listing: { tier: "supported" },
    },
    connector_id: connectorId,
    display_name: connectorId,
    protocol_version: "0.1.0",
    streams: streams.map((name: string) => ({
      coverage_strategy: "full_inventory",
      name,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    })),
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
}

function seedInstance(connectorInstanceId: string, connectorId: string): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, OWNER, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

/**
 * Write the evidence row DIRECTLY, bypassing the repair engine, to reproduce a
 * row persisted by the pre-fix producer. Going through `reconcile...` would
 * derive a fresh, already-correct `count_state` and prove nothing about what
 * the read boundary does with a historical one.
 *
 * `dirty = 0` + `record_snapshot_state = 'current'` is the load-bearing part
 * of the fixture: this is a row that repair classification will never revisit
 * and that the staleness downgrade will never touch.
 */
function seedPersistedEvidenceRow({
  connectorId,
  connectorInstanceId,
  countState,
  stream,
  streamLatestFacts,
}: {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly countState: string;
  readonly stream: string;
  readonly streamLatestFacts: unknown;
}): void {
  getDb()
    .prepare(
      `INSERT INTO connector_summary_evidence(
         connector_instance_id, connector_id, display_name, status, source_kind,
         total_records, stream_count, stream_records_json, dirty, computed_at, state,
         record_snapshot_state, terminal_facts_state, manifest_declaration_state,
         retained_bytes_state, stream_latest_facts_json
       ) VALUES (?, ?, ?, 'active', 'account', 0, 0, ?, 0, ?, 'fresh',
                 'current', 'current', 'current', 'current', ?)`
    )
    .run(
      connectorInstanceId,
      connectorId,
      connectorId,
      JSON.stringify([
        {
          count_state: countState,
          declaration_state: "declared",
          record_count: 0,
          retained_record_count: null,
          stream,
        },
      ]),
      NOW,
      streamLatestFacts === null ? null : JSON.stringify(streamLatestFacts)
    );
}

async function streamEntryFor(connectorInstanceId: string, stream: string) {
  const summaries = await listConnectorSummaries(null, { concurrency: 1 });
  const summary = summaries.find((row) => row.connector_instance_id === connectorInstanceId);
  assert.ok(summary, "the connection is visible");
  const entry = summary.stream_records.find((row) => row.stream === stream);
  assert.ok(entry, `the declared stream ${stream} is visible`);
  return { entry, summary };
}

/** One stored latest-attempt fact entry, in the shape the read model persists. */
function storedFact(stream: string, fact: Record<string, unknown>) {
  return {
    [stream]: {
      event_seq: 1,
      evidence_as_of: NOW,
      fact: { collected: 0, considered: null, covered: null, pending_detail_gaps: 0, skipped: null, stream, ...fact },
      run_id: "run_1",
    },
  };
}

test("(a) a persisted known_zero with NO runtime fact at all presents as unobserved", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/persisted-no-fact";
    seedManifestConnector(connectorId, ["messages"]);
    seedInstance("cin_persisted_no_fact", connectorId);
    // The worst shape found on the live fleet: a historical `known_zero` on a
    // row carrying no per-stream runtime fact whatsoever. There is nothing
    // that could constitute evidence, so the claim is pure synthesis.
    seedPersistedEvidenceRow({
      connectorId,
      connectorInstanceId: "cin_persisted_no_fact",
      countState: "known_zero",
      stream: "messages",
      streamLatestFacts: null,
    });

    const { entry, summary } = await streamEntryFor("cin_persisted_no_fact", "messages");
    assert.equal(
      entry.count_state,
      "unobserved",
      "no runtime fact is an absence of evidence — it must never present as a proven exact zero"
    );
    assert.equal(
      summary.total_records_state,
      "unobserved",
      "the aggregate must not re-assert at the connection level the claim the per-stream read just withdrew"
    );
  }));

test("(b) a persisted known_zero whose checkpoint never staged or committed presents as unobserved", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/persisted-open-checkpoint";
    seedManifestConnector(connectorId, ["messages"]);
    // A runtime fact EXISTS but its checkpoint never closed and it carries no
    // measured `considered` boundary. Under Ruling R2 an unresolved attempt
    // may not be laundered into a coverage claim — and here not even a
    // committed checkpoint is on offer. Both open-checkpoint states the live
    // fleet produces are seeded on their own connections and asserted together.
    const openCheckpoints = ["not_staged", "not_committed"] as const;
    for (const checkpoint of openCheckpoints) {
      const instanceId = `cin_open_${checkpoint}`;
      seedInstance(instanceId, connectorId);
      seedPersistedEvidenceRow({
        connectorId,
        connectorInstanceId: instanceId,
        countState: "known_zero",
        stream: "messages",
        streamLatestFacts: storedFact("messages", { checkpoint }),
      });
    }

    const entries = await Promise.all(
      openCheckpoints.map((checkpoint) => streamEntryFor(`cin_open_${checkpoint}`, "messages"))
    );
    for (const [index, { entry }] of entries.entries()) {
      assert.equal(
        entry.count_state,
        "unobserved",
        `checkpoint=${openCheckpoints[index]} is an open attempt, not positive coverage evidence`
      );
    }
  }));

test("(c) COUNTERWEIGHT: a genuinely proven zero keeps reading known_zero", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/persisted-proven-zero";
    seedManifestConnector(connectorId, ["messages"]);
    seedInstance("cin_persisted_proven_zero", connectorId);
    // Positive coverage evidence: the run MEASURED its enumeration boundary at
    // the enumeration site and found nothing in it (`considered: 0`), and its
    // checkpoint committed. That is a real statement — "I enumerated the
    // boundary and it held zero items" — not an absence of one. This is the
    // exact-zero claim the fix must preserve.
    seedPersistedEvidenceRow({
      connectorId,
      connectorInstanceId: "cin_persisted_proven_zero",
      countState: "known_zero",
      stream: "messages",
      streamLatestFacts: storedFact("messages", { checkpoint: "committed", considered: 0, covered: 0 }),
    });

    const { entry, summary } = await streamEntryFor("cin_persisted_proven_zero", "messages");
    assert.equal(entry.record_count, 0, "fixture premise: no live canonical records");
    assert.equal(
      entry.count_state,
      "known_zero",
      "a measured enumeration boundary of zero is a PROVEN exact zero — the fix must not over-correct true zeros away"
    );
    assert.equal(
      summary.total_records_state,
      "known_zero",
      "an aggregate over exclusively proven zeros is itself a proven zero"
    );
  }));

/**
 * The write path (`buildRepairedRow` in connector-summary-evidence-engine.ts)
 * derives `observed` — and therefore whether a zero record_count becomes
 * `known_zero` vs `unobserved` — SOLELY from the record-source checkpoint
 * (`version_counter`), which is written per-record on ingest. A stream that
 * completes a requested, fully-enumerated pass and finds zero records never
 * allocates a version, so it is persisted `unobserved` even though the SAME
 * run's own facts (`collection_facts`) already carry positive proof of a
 * completed zero-result enumeration. This reproduces the live GroupMe UAT
 * connection (cin_5804a2ff36cd303e22762745): direct_messages/
 * direct_chat_messages committed a checkpoint and collected 0 records in a
 * successful run, yet `stream_records[].count_state` read `unobserved`
 * indistinguishable from a stream that was never requested at all.
 *
 * Tests (d)/(e) are the fail-before/pass-after pair for this asymmetry;
 * (f) is the counterweight proving an unobserved stream with NO run-side
 * proof is correctly left alone (never fabricated into known_zero).
 */
test("(d) a persisted unobserved row with a proven completed zero-enumeration upgrades to known_zero", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/persisted-unobserved-proven-zero";
    seedManifestConnector(connectorId, ["direct_messages"]);
    seedInstance("cin_persisted_unobserved_proven_zero", connectorId);
    // Reproduces the write-path gap directly: countState is persisted
    // "unobserved" (no version_counter entry — buildRepairedRow's only proof
    // channel), but the run's own facts prove a completed, measured
    // zero-result enumeration (checkpoint committed, considered: 0).
    seedPersistedEvidenceRow({
      connectorId,
      connectorInstanceId: "cin_persisted_unobserved_proven_zero",
      countState: "unobserved",
      stream: "direct_messages",
      streamLatestFacts: storedFact("direct_messages", { checkpoint: "committed", considered: 0, covered: 0 }),
    });

    const { entry, summary } = await streamEntryFor("cin_persisted_unobserved_proven_zero", "direct_messages");
    assert.equal(entry.record_count, 0, "fixture premise: no live canonical records");
    assert.equal(
      entry.count_state,
      "known_zero",
      "a persisted unobserved row backed by a proven completed zero-enumeration must upgrade to known_zero — the write path's missing proof channel must not survive at the read boundary"
    );
    assert.equal(
      summary.total_records_state,
      "known_zero",
      "the aggregate must reflect the read-corrected per-stream proof, not the persisted unobserved claim"
    );
  }));

test("(e) a persisted unobserved row whose checkpoint never closed stays unobserved (no false upgrade)", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/persisted-unobserved-open-checkpoint";
    seedManifestConnector(connectorId, ["direct_chat_messages"]);
    seedInstance("cin_persisted_unobserved_open", connectorId);
    // Mirrors the GroupMe live connection's MOST RECENT (cancelled) run: a
    // runtime fact exists but the checkpoint never committed
    // ("Staged stream state was not committed"). An unresolved attempt must
    // not be laundered into a coverage claim in either direction.
    seedPersistedEvidenceRow({
      connectorId,
      connectorInstanceId: "cin_persisted_unobserved_open",
      countState: "unobserved",
      stream: "direct_chat_messages",
      streamLatestFacts: storedFact("direct_chat_messages", { checkpoint: "not_committed" }),
    });

    const { entry } = await streamEntryFor("cin_persisted_unobserved_open", "direct_chat_messages");
    assert.equal(
      entry.count_state,
      "unobserved",
      "an open/uncommitted checkpoint is not positive coverage evidence — must never upgrade to known_zero"
    );
  }));

test("(f) COUNTERWEIGHT: a persisted unobserved row with NO runtime fact at all stays unobserved", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/persisted-unobserved-no-fact";
    seedManifestConnector(connectorId, ["direct_messages"]);
    seedInstance("cin_persisted_unobserved_no_fact", connectorId);
    // A genuinely never-requested/never-run stream: no runtime fact
    // whatsoever. The fix must not fabricate a zero claim for the absence of
    // any evidence.
    seedPersistedEvidenceRow({
      connectorId,
      connectorInstanceId: "cin_persisted_unobserved_no_fact",
      countState: "unobserved",
      stream: "direct_messages",
      streamLatestFacts: null,
    });

    const { entry } = await streamEntryFor("cin_persisted_unobserved_no_fact", "direct_messages");
    assert.equal(
      entry.count_state,
      "unobserved",
      "no runtime fact at all must never upgrade to known_zero — this is the genuinely-never-observed case"
    );
  }));
