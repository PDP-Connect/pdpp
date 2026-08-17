// Probe: does startup LEXICAL backfill detect a record that was durably
// written but never got its index maintenance run (crash-abandoned)?
import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";
import { lexicalIndexBackfillForManifest } from "../server/search.ts";

function target(connectorInstanceId: string) {
  return { connector_id: "crash-gap-lex", connector_instance_id: connectorInstanceId };
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
  connector_id: "crash-gap-lex",
  display_name: "Crash gap lexical probe",
  manifest_uri: "https://registry.pdpp.dev/connectors/crash-gap-lex",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      query: { search: { lexical_fields: ["subject"] } },
      schema: {
        properties: { id: { type: "string" }, subject: { type: "string" } },
        required: ["id", "subject"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
  ],
  version: "0.1.0",
};

// A SEPARATE manifest object (never passed to registerConnector, which
// rejects unknown fields) pinning storage_binding.connector_instance_id to
// the SAME id `ingestRecord` writes to below. Without this,
// resolveLexicalBackfillConnectorInstanceIds falls back to
// listActiveOwnerBindingsForConnectors (no owner binding exists for a raw
// direct-ingest probe) and then to the synthetic default account instance
// id -- a DIFFERENT (empty) scope than the one this probe actually wrote to,
// so the drift-check would trivially report "in sync" against zero records
// and prove nothing about the real comparison logic. Production callers
// reach this same pinned path via a real owner binding or an explicit
// storage_binding; this is the narrowest way to exercise the identical code
// path (`search.ts` reads `manifest.storage_binding?.connector_instance_id`
// as a plain property, independent of registerConnector's schema gate).
const backfillManifest = { ...baseManifest, storage_binding: { connector_instance_id: "cin_crash_gap_lex_a" } };

test("PROBE: startup lexical backfill catches a record whose index maintenance never ran", async () => {
  initDb(":memory:");
  try {
    await registerConnector(baseManifest);
    await ingestRecord(target("cin_crash_gap_lex_a"), record("items", "k1", "indexed normally"));
    await lexicalIndexBackfillForManifest({ manifest: backfillManifest });

    await ingestRecord(target("cin_crash_gap_lex_a"), record("items", "k2", "never indexed"), {
      deferIndexes: true,
    });

    const metaBefore = getDb()
      .prepare("SELECT * FROM lexical_search_meta WHERE connector_instance_id = ?")
      .all("cin_crash_gap_lex_a");
    console.log("meta before second backfill:", metaBefore);
    const recordsCount = getDb()
      .prepare("SELECT COUNT(*) as n FROM records WHERE connector_instance_id = ? AND stream = ? AND deleted = 0")
      .get("cin_crash_gap_lex_a", "items");
    console.log("live records count:", recordsCount);

    await lexicalIndexBackfillForManifest({ manifest: backfillManifest });

    const rows = getDb()
      .prepare("SELECT DISTINCT record_key FROM lexical_search_index WHERE connector_instance_id = ?")
      .all("cin_crash_gap_lex_a") as { record_key: string }[];
    const keys = [...new Set(rows.map((r) => r.record_key))].sort();
    console.log("lexical indexed keys after second startup backfill:", keys);
    assert.deepEqual(keys, ["k1", "k2"], "lexical startup backfill should have caught the crash-abandoned record k2");
  } finally {
    closeDb();
  }
});
