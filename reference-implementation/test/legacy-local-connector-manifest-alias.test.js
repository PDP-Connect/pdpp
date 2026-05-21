import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { getConnectorManifest, registerConnector } from '../server/auth.js';

const NOW = '2026-05-20T12:00:00.000Z';
const CLAUDE_CANONICAL_ID = 'https://registry.pdpp.org/connectors/claude-code';

function withTmpDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-legacy-local-manifest-'));
    initDb(join(dir, 'pdpp.sqlite'));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function validManifest(connectorId) {
  return {
    protocol_version: '0.1.0',
    connector_id: connectorId,
    version: '0.3.0',
    display_name: 'Claude Code',
    streams: [
      {
        name: 'messages',
        semantics: 'event_log',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
            text: { type: 'string' },
          },
          required: ['id', 'timestamp'],
        },
        primary_key: ['id'],
        cursor_field: 'timestamp',
        consent_time_field: 'timestamp',
        selection: { fields: true, resources: true },
      },
    ],
  };
}

function insertStaleLegacyManifest(connectorId) {
  getDb()
    .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(
      connectorId,
      JSON.stringify({
        connector_id: connectorId,
        display_name: 'stale local collector placeholder',
        streams: [],
      }),
      NOW,
    );
}

test('legacy local connector ids read through canonical manifest schemas', withTmpDb(async () => {
  await registerConnector(validManifest(CLAUDE_CANONICAL_ID));
  insertStaleLegacyManifest('claude_code');

  const manifest = await getConnectorManifest('claude_code');

  assert.equal(manifest.connector_id, 'claude_code');
  assert.equal(manifest.display_name, 'Claude Code');
  assert.deepEqual(manifest.streams.map((stream) => stream.name), ['messages']);
}));

test('non-aliased malformed connector manifests still fail closed', withTmpDb(async () => {
  insertStaleLegacyManifest('unknown_legacy_local');

  await assert.rejects(
    () => getConnectorManifest('unknown_legacy_local'),
    /Connector manifest for unknown_legacy_local is malformed or no longer valid/,
  );
}));
