// Discriminating regression test: startup semantic backfill must detect and
// repair a record that was durably written but never got its index
// maintenance run (simulating a crash between commit and background index
// completion). Originally written as a failing probe against
// semanticBackfillIndexIsInSync's upper-bound-only comparison
// (indexCount <= maxIndexRows), which could report "in sync" even while a
// specific record's row was missing as long as the total count didn't
// exceed the ceiling. Fixed by comparing indexCount to the EXACT expected
// row count instead. This file now proves the fix, not the gap.
import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";
import {
  configureSemanticBackend,
  makeStubBackend,
  semanticIndexBackfillForManifest,
} from "../server/search-semantic.ts";

function target(connectorInstanceId: string) {
  return { connector_id: "crash-gap", connector_instance_id: connectorInstanceId };
}

function record(stream: string, key: string, subject: string) {
  return {
    data: { id: key, subject },
    emitted_at: "2026-07-16T00:00:00.000Z",
    key,
    stream,
  };
}

const baseManifest = {
  capabilities: { human_interaction: [] },
  connector_id: "crash-gap",
  display_name: "Crash gap probe",
  manifest_uri: "https://registry.pdpp.dev/connectors/crash-gap",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      query: { search: {} },
      schema: {
        properties: { id: { type: "string" }, subject: { type: "string" } },
        required: ["id", "subject"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

const semanticManifest = {
  connector_id: "crash-gap",
  streams: [{ name: "items", query: { search: { semantic_fields: ["subject"] } } }],
};

test("startup semantic backfill catches a record whose index maintenance never ran (crash-abandoned deferred index work)", async () => {
  initDb(":memory:");
  configureSemanticBackend(makeStubBackend({ dimensions: 8 }));
  try {
    await registerConnector(baseManifest);
    // Record 1: normal ingest, index maintenance runs (deferIndexes defaults false).
    await ingestRecord(target("cin_crash_gap_a"), record("items", "k1", "indexed normally"));

    // Establish steady-state meta (fields_fingerprint/model/dims persisted)
    // via a first backfill pass BEFORE the crash-abandoned record exists —
    // this is the realistic "server has run before, meta already exists"
    // condition. Only after this does the discriminator (does a SUBSEQUENT
    // backfill catch a newly under-indexed record?) actually test anything;
    // on a cold DB with no meta row, `!metaRow` alone forces a full rebuild
    // regardless of the count-sync logic, which doesn't discriminate.
    await semanticIndexBackfillForManifest({ manifest: semanticManifest });

    // Record 2: simulate crash-abandoned deferred index work — durable write
    // happened (deferIndexes: true skips maintainRecordIndexes entirely, same
    // end state as a process dying before the fire-and-forget promise runs).
    await ingestRecord(target("cin_crash_gap_a"), record("items", "k2", "never indexed"), {
      deferIndexes: true,
    });

    // Second backfill pass = "server restarted again" with meta already in place.
    await semanticIndexBackfillForManifest({ manifest: semanticManifest });

    // If backfill is a real repair mechanism, a second explicit backfill call
    // (simulating "server restarted again") should find nothing left to do,
    // AND the record should actually be present in the index. Assert directly.

    // Use the DB directly to check whether k2's semantic index row exists.
    // scope_key encodes stream+field; the stub backend uses the blob-flat
    // fallback table since sqlite-vec is not loaded in this probe.
    const { getDb } = await import("../server/db.ts");
    const rowidRows = getDb()
      .prepare("SELECT DISTINCT record_key FROM semantic_search_rowid WHERE connector_instance_id = ?")
      .all("cin_crash_gap_a") as { record_key: string }[];
    const blobRows = getDb()
      .prepare("SELECT DISTINCT record_key FROM semantic_search_blob WHERE connector_instance_id = ?")
      .all("cin_crash_gap_a") as { record_key: string }[];
    const keys = [...new Set([...rowidRows, ...blobRows].map((r) => r.record_key))].sort();
    assert.deepEqual(keys, ["k1", "k2"], "startup backfill should have caught the crash-abandoned record k2");
  } finally {
    closeDb();
  }
});
