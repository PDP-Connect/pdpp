// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getConnectorManifest, registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-05-20T12:00:00.000Z";
const CLAUDE_CANONICAL_ID = "https://registry.pdpp.dev/connectors/claude-code";

function withTmpDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-legacy-local-manifest-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function validManifest(connectorId: string) {
  return {
    connector_id: connectorId,
    display_name: "Claude Code",
    manifest_uri: "https://registry.pdpp.dev/connectors/claude-code",
    protocol_version: "0.1.0",
    streams: [
      {
        consent_time_field: "timestamp",
        cursor_field: "timestamp",
        name: "messages",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            timestamp: { format: "date-time", type: "string" },
          },
          required: ["id", "timestamp"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "0.3.0",
  };
}

function insertStaleLegacyManifest(connectorId: string): void {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(
      connectorId,
      JSON.stringify({
        connector_id: connectorId,
        display_name: "stale local collector placeholder",
        streams: [],
      }),
      NOW
    );
}

test(
  "legacy local connector ids read through canonical manifest schemas",
  withTmpDb(async () => {
    await registerConnector(validManifest(CLAUDE_CANONICAL_ID));
    insertStaleLegacyManifest("claude_code");

    const manifest = await getConnectorManifest("claude_code");

    assert.ok(manifest, "canonical manifest exists");
    assert.equal(manifest.connector_id, "claude-code");
    assert.equal(manifest.display_name, "Claude Code");
    assert.ok(Array.isArray(manifest.streams), "canonical manifest streams exist");
    assert.deepEqual(
      manifest.streams.map((stream) => stream.name),
      ["messages"]
    );
  })
);

test(
  "non-aliased malformed connector manifests still fail closed",
  withTmpDb(async () => {
    insertStaleLegacyManifest("unknown_legacy_local");

    await assert.rejects(
      () => getConnectorManifest("unknown_legacy_local"),
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      /Connector manifest for unknown_legacy_local is malformed or no longer valid/
    );
  })
);

// google_takeout/apple_photos/google_messages previously had NO coverage here
// (only claude_code was pinned) and their alias entries had silently dropped
// out of auth.ts's own, independently-hand-maintained alias table — see
// docs/inbox/report-connector-knowledge-clusters-bc.md. auth.ts now derives
// its table from connector-key.ts's legacyLocalAliasMap(), and this pins that
// every legacy alias it declares actually resolves through getConnectorManifest.
for (const [legacyId, canonicalId] of [
  ["google_takeout", "google-takeout"],
  ["apple_photos", "apple-photos"],
  ["google_messages", "google-messages"],
] as const) {
  test(
    `legacy local connector id ${legacyId} reads through its canonical manifest (${canonicalId})`,
    withTmpDb(async () => {
      await registerConnector(validManifest(`https://registry.pdpp.dev/connectors/${canonicalId}`));
      insertStaleLegacyManifest(legacyId);

      const manifest = await getConnectorManifest(legacyId);

      assert.ok(manifest, `canonical manifest exists for ${legacyId}`);
      assert.equal(manifest.connector_id, canonicalId);
    })
  );
}
