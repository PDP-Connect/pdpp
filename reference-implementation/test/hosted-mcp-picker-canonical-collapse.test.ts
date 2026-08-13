// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/performance/useTopLevelRegex: rejection assertions keep their expected error pattern local.

/**
 * Hosted MCP picker — legacy-alias suppression is enforced by canonical
 * connector identity at the registration layer.
 *
 * `openspec/specs/agent-consent-bundling/spec.md` ("Hosted MCP connection
 * presentation SHALL use shared connector identity") requires that when both
 * a legacy local-collector connector id (`claude_code`) and its canonical id
 * (`claude-code`) are registered, the hosted MCP picker SHALL NOT show a stale
 * zero-record legacy duplicate as a separate owner-facing source.
 *
 * The reference implementation satisfies this through ONE canonical path
 * rather than a second picker-level dedup mechanism: `registerConnector`
 * canonicalizes the manifest's `connector_id` via
 * `normalizeConnectorManifestForStorage` (auth.js) and upserts under the
 * canonical key with `ON CONFLICT (connector_id) DO UPDATE`. Both the legacy
 * alias and the canonical id therefore resolve to the same connector row.
 *
 * `listHostedMcpPickerRows` (server/index.js) enumerates exactly
 * `listRegisteredConnectorIds()`, so if the storage layer cannot hold two
 * rows for the same canonical connector, the picker cannot render a legacy
 * duplicate. This regression locks that invariant at the layer that actually
 * enforces it; the existing hosted-mcp-oauth picker-render tests cover the
 * 1:1 mapping from registered ids to picker rows.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { getConnectorManifest, listRegisteredConnectorIds, registerConnector } from "../server/auth.ts";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { closeDb, initDb } from "../server/db.ts";

function claudeCodeManifest(connectorId: string, displayName: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: displayName,
    manifest_uri: connectorId.startsWith("http") ? connectorId : "https://registry.pdpp.org/connectors/claude-code",
    protocol_version: "0.1.0",
    streams: [
      {
        consent_time_field: "ts",
        cursor_field: "ts",
        name: "sessions",
        primary_key: ["id"],
        query: {},
        schema: {
          properties: {
            id: { type: "string" },
            ts: { format: "date-time", type: "string" },
          },
          required: ["id", "ts"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

test("registering a legacy local-collector alias and its canonical id yields one canonical connector row", async () => {
  initDb();
  try {
    const canonical = claudeCodeManifest("https://registry.pdpp.dev/connectors/claude-code", "Claude Code (canonical)");
    const legacyAlias = claudeCodeManifest("claude_code", "Claude Code (legacy alias)");

    // Both manifests resolve to the same canonical short key.
    assert.equal(canonicalConnectorKeyFromManifest(canonical), "claude-code");
    assert.equal(canonicalConnectorKeyFromManifest(legacyAlias), "claude-code");

    await registerConnector(canonical);
    await registerConnector(legacyAlias);

    const ids = await listRegisteredConnectorIds();
    const claudeRows = ids.filter((id: string) => id === "claude-code");

    // The picker enumerates exactly these ids: one canonical row, no
    // separate legacy-alias source, no URL-shaped duplicate.
    assert.deepEqual(claudeRows, ["claude-code"], "exactly one canonical claude-code row");
    assert.ok(!ids.includes("claude_code"), "legacy snake_case alias must not survive as a separate row");
    assert.ok(
      !ids.includes("https://registry.pdpp.dev/connectors/claude-code"),
      "URL-shaped connector id must not survive as a separate row"
    );
  } finally {
    closeDb();
  }
});

test("alias registered before its canonical id still collapses to one canonical row", async () => {
  initDb();
  try {
    // Reverse registration order: a stale legacy row landing first must not
    // produce a duplicate when the canonical manifest is later registered.
    await registerConnector(claudeCodeManifest("claude_code", "Claude Code (legacy alias)"));
    await registerConnector(
      claudeCodeManifest("https://registry.pdpp.dev/connectors/claude-code", "Claude Code (canonical)")
    );

    const ids = await listRegisteredConnectorIds();
    assert.deepEqual(
      ids.filter((id: string) => id === "claude-code"),
      ["claude-code"],
      "exactly one canonical claude-code row regardless of registration order"
    );
    assert.ok(!ids.includes("claude_code"), "legacy snake_case alias must not survive as a separate row");
  } finally {
    closeDb();
  }
});

test("registerConnector accepts connector_key plus manifest_uri manifests", async () => {
  initDb();
  try {
    const manifest = {
      capabilities: { human_interaction: [] },
      connector_key: "custom-source",
      display_name: "Custom Source",
      manifest_uri: "https://example.test/manifests/custom-source",
      protocol_version: "0.1.0",
      streams: [
        {
          consent_time_field: "updated_at",
          cursor_field: "updated_at",
          name: "items",
          primary_key: ["id"],
          query: {},
          schema: {
            properties: {
              id: { type: "string" },
              updated_at: { format: "date-time", type: "string" },
            },
            required: ["id", "updated_at"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
      ],
      version: "1.0.0",
    };

    const registeredId = await registerConnector(manifest);
    assert.equal(registeredId, "custom-source");
    assert.deepEqual(await listRegisteredConnectorIds(), ["custom-source"]);

    const storedManifest = await getConnectorManifest("custom-source");
    assert.ok(storedManifest, "registered connector manifest is persisted");
    assert.equal(storedManifest.connector_id, "custom-source");
    assert.equal(storedManifest.connector_key, "custom-source");
    assert.equal(storedManifest.manifest_uri, "https://example.test/manifests/custom-source");
  } finally {
    closeDb();
  }
});

test("registerConnector rejects mismatched connector_key and connector_id", async () => {
  initDb();
  try {
    const mismatched = {
      ...claudeCodeManifest("github", "Mismatched"),
      connector_key: "slack",
    };
    await assert.rejects(() => registerConnector(mismatched), /connector_key must match|connector_id must match/);
  } finally {
    closeDb();
  }
});
