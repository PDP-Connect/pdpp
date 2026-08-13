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
        semantics: "event_log",
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
