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

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { listRegisteredConnectorIds, registerConnector } from '../server/auth.js';
import { canonicalConnectorKeyFromManifest } from '../server/connector-key.js';

function claudeCodeManifest(connectorId, displayName) {
  return {
    protocol_version: '0.1.0',
    connector_id: connectorId,
    version: '1.0.0',
    display_name: displayName,
    capabilities: { human_interaction: [] },
    streams: [
      {
        name: 'sessions',
        primary_key: ['id'],
        cursor_field: 'ts',
        consent_time_field: 'ts',
        schema: {
          type: 'object',
          required: ['id', 'ts'],
          properties: {
            id: { type: 'string' },
            ts: { type: 'string', format: 'date-time' },
          },
        },
        query: {},
        selection: { fields: { mode: 'explicit' } },
      },
    ],
  };
}

test('registering a legacy local-collector alias and its canonical id yields one canonical connector row', async () => {
  initDb();
  try {
    const canonical = claudeCodeManifest(
      'https://registry.pdpp.org/connectors/claude-code',
      'Claude Code (canonical)',
    );
    const legacyAlias = claudeCodeManifest('claude_code', 'Claude Code (legacy alias)');

    // Both manifests resolve to the same canonical short key.
    assert.equal(canonicalConnectorKeyFromManifest(canonical), 'claude-code');
    assert.equal(canonicalConnectorKeyFromManifest(legacyAlias), 'claude-code');

    await registerConnector(canonical);
    await registerConnector(legacyAlias);

    const ids = await listRegisteredConnectorIds();
    const claudeRows = ids.filter((id) => id === 'claude-code');

    // The picker enumerates exactly these ids: one canonical row, no
    // separate legacy-alias source, no URL-shaped duplicate.
    assert.deepEqual(claudeRows, ['claude-code'], 'exactly one canonical claude-code row');
    assert.ok(!ids.includes('claude_code'), 'legacy snake_case alias must not survive as a separate row');
    assert.ok(
      !ids.includes('https://registry.pdpp.org/connectors/claude-code'),
      'URL-shaped connector id must not survive as a separate row',
    );
  } finally {
    closeDb();
  }
});

test('alias registered before its canonical id still collapses to one canonical row', async () => {
  initDb();
  try {
    // Reverse registration order: a stale legacy row landing first must not
    // produce a duplicate when the canonical manifest is later registered.
    await registerConnector(claudeCodeManifest('claude_code', 'Claude Code (legacy alias)'));
    await registerConnector(
      claudeCodeManifest('https://registry.pdpp.org/connectors/claude-code', 'Claude Code (canonical)'),
    );

    const ids = await listRegisteredConnectorIds();
    assert.deepEqual(
      ids.filter((id) => id === 'claude-code'),
      ['claude-code'],
      'exactly one canonical claude-code row regardless of registration order',
    );
    assert.ok(!ids.includes('claude_code'), 'legacy snake_case alias must not survive as a separate row');
  } finally {
    closeDb();
  }
});
