/**
 * Regression for the timeline DISPLAY-TIME bug: every timeline row's displayAt
 * silently fell back to emitted_at (ingest time), so day-group headers and row
 * times showed when a record was INGESTED, not when it HAPPENED — and they
 * contradicted the semantic-time SORT (server-side `semantic_time` column).
 *
 * Root cause: bundled manifests set `connector_id` to the registry URI
 * (https://registry.pdpp.org/connectors/usaa) and `connector_key` to the plain
 * key ("usaa"); stored records carry the plain key. The per-connector timestamp
 * metadata was indexed by the URI, so EVERY lookup against a record's plain
 * connector_id missed → null metadata → fallback to emitted_at.
 *
 * Fix: index the metadata by the canonical short key (manifestConnectorKey).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickSearchDisplayTimestamp, searchTimestampMetadataKey } from "../lib/search-record-timestamps.ts";
import { manifestConnectorKey } from "./explore-data-assembler.ts";

test("manifestConnectorKey prefers connector_key (the plain key records carry)", () => {
  assert.equal(
    manifestConnectorKey({ connector_id: "https://registry.pdpp.org/connectors/usaa", connector_key: "usaa" }),
    "usaa"
  );
  assert.equal(
    manifestConnectorKey({
      connector_id: "https://registry.pdpp.org/connectors/claude-code",
      connector_key: "claude-code",
    }),
    "claude-code"
  );
});

test("manifestConnectorKey falls back to the last URL path segment when connector_key is absent", () => {
  assert.equal(manifestConnectorKey({ connector_id: "https://registry.pdpp.org/connectors/usaa" }), "usaa");
});

test("manifestConnectorKey passes a plain key through unchanged", () => {
  assert.equal(manifestConnectorKey({ connector_id: "google-maps" }), "google-maps");
  assert.equal(manifestConnectorKey({ connector_id: "usaa", connector_key: "usaa" }), "usaa");
});

test("reproduce-the-bug: metadata keyed by the canonical key resolves a record's semantic date (not emitted_at)", () => {
  // A bundled manifest as shipped: URI connector_id, plain connector_key.
  const manifest = {
    connector_id: "https://registry.pdpp.org/connectors/usaa",
    connector_key: "usaa",
    streams: [{ name: "transactions", consent_time_field: "date", cursor_field: "date" }],
  };
  // Build metadata the FIXED way — keyed by the canonical key.
  const key = manifestConnectorKey(manifest);
  const metadata = new Map([
    [searchTimestampMetadataKey(key, "transactions"), { consent_time_field: "date", cursor_field: "date" }],
  ]);

  // A record as stored: plain connector_id, a bare transaction date in data.
  const record = { connector_id: "usaa", stream: "transactions", emitted_at: "2026-04-20T03:40:15.058Z" };
  const data = { date: "2026-12-26", amount: 100_000 };

  const lookedUp = metadata.get(searchTimestampMetadataKey(record.connector_id, record.stream)) ?? null;
  assert.ok(lookedUp, "metadata MUST resolve for the record's plain connector_id");

  const display = pickSearchDisplayTimestamp({ data, emittedAt: record.emitted_at, metadata: lookedUp });
  assert.equal(display.value, "2026-12-26", "displayAt must be the transaction date, not emitted_at");
  assert.equal(display.isSemantic, true);

  // The bug: keyed by the URI, the lookup misses and falls back to emitted_at.
  const buggy = new Map([
    [
      searchTimestampMetadataKey(manifest.connector_id, "transactions"),
      { consent_time_field: "date", cursor_field: "date" },
    ],
  ]);
  const buggyLookup = buggy.get(searchTimestampMetadataKey(record.connector_id, record.stream)) ?? null;
  const buggyDisplay = pickSearchDisplayTimestamp({ data, emittedAt: record.emitted_at, metadata: buggyLookup });
  assert.equal(buggyDisplay.value, record.emitted_at, "URI-keyed metadata misses → emitted_at fallback (the bug)");
});
