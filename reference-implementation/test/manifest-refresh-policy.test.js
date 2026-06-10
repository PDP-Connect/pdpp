/**
 * Validation coverage for `capabilities.refresh_policy` declarations.
 *
 * `refresh_policy` is reference/polyfill metadata, not finalized PDPP core
 * protocol. The reference's connector registry validator should accept
 * conservative declarations and reject obviously malformed ones so connector
 * authors get fast feedback instead of silently shipping bad scheduling
 * hints. See:
 *   openspec/changes/add-connector-refresh-policy-controls/specs/polyfill-runtime/spec.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function withHarness(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

async function registerConnectorManifest(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: resp.status, body };
}

function makeManifest({ connectorIdSuffix, refreshPolicy }) {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: `https://registry.pdpp.test/connectors/refresh-policy-${connectorIdSuffix}`,
    version: '0.1.0',
    display_name: 'Refresh policy fixture',
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: 'notes',
        semantics: 'mutable_state',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            received_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'received_at'],
        },
        primary_key: ['id'],
        cursor_field: 'received_at',
        selection: { fields: true, resources: true },
      },
    ],
  };
  if (refreshPolicy !== undefined) {
    manifest.capabilities = { refresh_policy: refreshPolicy };
  }
  return manifest;
}

test('manifest without capabilities still registers (refresh_policy is optional)', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ connectorIdSuffix: 'absent' }),
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test('valid full refresh_policy is accepted', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'full-valid',
        refreshPolicy: {
          recommended_mode: 'automatic',
          recommended_interval_seconds: 900,
          minimum_interval_seconds: 300,
          maximum_staleness_seconds: 3600,
          interaction_posture: 'credentials',
          session_lifetime_seconds: 1800,
          rate_limit_sensitivity: 'low',
          bot_detection_sensitivity: 'low',
          background_safe: true,
          assisted_after_owner_auth: true,
          rationale: 'Durable credentials, low rate-limit risk.',
        },
      }),
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test('minimal valid refresh_policy (mode + rationale) is accepted', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'minimal-valid',
        refreshPolicy: {
          recommended_mode: 'manual',
          rationale: 'Bank login requires owner attention.',
        },
      }),
    );
    assert.equal(status, 201);
  });
});

test('refresh_policy missing recommended_mode is rejected', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'missing-mode',
        refreshPolicy: { rationale: 'No mode declared.' },
      }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /recommended_mode/);
  });
});

test('refresh_policy with unknown recommended_mode is rejected', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'bad-mode',
        refreshPolicy: {
          recommended_mode: 'frequent',
          rationale: 'Made-up mode.',
        },
      }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /recommended_mode/);
  });
});

test('refresh_policy missing rationale is rejected', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'missing-rationale',
        refreshPolicy: { recommended_mode: 'automatic' },
      }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /rationale/);
  });
});

test('refresh_policy interval seconds must be positive integers', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'bad-interval',
        refreshPolicy: {
          recommended_mode: 'automatic',
          recommended_interval_seconds: 0,
          rationale: 'Zero interval.',
        },
      }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /recommended_interval_seconds/);
  });
});

test('refresh_policy recommended_interval_seconds must be >= minimum_interval_seconds', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'recommended-below-minimum',
        refreshPolicy: {
          recommended_mode: 'automatic',
          recommended_interval_seconds: 60,
          minimum_interval_seconds: 300,
          rationale: 'Recommended below minimum.',
        },
      }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /minimum_interval_seconds/);
  });
});

test('refresh_policy with unknown interaction_posture is rejected', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'bad-posture',
        refreshPolicy: {
          recommended_mode: 'automatic',
          interaction_posture: 'biometric_likely',
          rationale: 'Made-up posture.',
        },
      }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /interaction_posture/);
  });
});

test('refresh_policy with non-boolean background_safe is rejected', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'bad-background-safe',
        refreshPolicy: {
          recommended_mode: 'automatic',
          background_safe: 'yes',
          rationale: 'String instead of boolean.',
        },
      }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /background_safe/);
  });
});

test('refresh_policy with non-boolean assisted_after_owner_auth is rejected', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'bad-assisted-after-owner-auth',
        refreshPolicy: {
          recommended_mode: 'automatic',
          assisted_after_owner_auth: 'yes',
          rationale: 'String instead of boolean.',
        },
      }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /assisted_after_owner_auth/);
  });
});

test('refresh_policy with unknown sensitivity level is rejected', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'bad-sensitivity',
        refreshPolicy: {
          recommended_mode: 'automatic',
          rate_limit_sensitivity: 'extreme',
          rationale: 'Made-up sensitivity level.',
        },
      }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /rate_limit_sensitivity/);
  });
});

test('refresh_policy with unknown keys is rejected', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'unknown-key',
        refreshPolicy: {
          recommended_mode: 'automatic',
          rationale: 'Unknown key declared.',
          retry_after_seconds: 60,
        },
      }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /retry_after_seconds/);
  });
});

test('non-object refresh_policy is rejected', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: 'array-policy',
        refreshPolicy: ['automatic'],
      }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /refresh_policy/);
  });
});
