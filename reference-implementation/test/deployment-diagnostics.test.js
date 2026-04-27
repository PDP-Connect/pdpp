/**
 * Deployment diagnostics — unit coverage for the reference operator
 * /dashboard/deployment surface.
 *
 * Pins the two must-hold properties from:
 *   openspec/changes/make-semantic-retrieval-operational/
 *     specs/reference-implementation-architecture/spec.md
 *
 * 1. Secrets are redacted in the environment report, both via explicit
 *    allowlist entries and via the name-pattern heuristic.
 * 2. Zero semantic participation is reported independently from backend/
 *    index readiness — a ready backend + built index + zero streams is
 *    a distinct warning state, not silent success.
 *
 * Covers tasks.md §2.4 (the diagnostics slice's regression test).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeploymentDiagnostics,
  buildEnvironmentReport,
  computeParticipation,
  shouldAttemptSemanticUplift,
} from '../server/deployment-diagnostics.ts';
import { startServer } from '../server/index.js';

// Minimal fake backend so tests don't reach for @huggingface/transformers
// or any real embedding runtime. Identity-only surface — matches the
// DiagnosticsBackend interface the helper consumes.
function fakeBackend(overrides = {}) {
  return {
    model: () => 'test-model',
    dimensions: () => 64,
    distanceMetric: () => 'cosine',
    available: () => true,
    languageBias: () => null,
    ...overrides,
  };
}

function manifestWithSemantic() {
  return {
    connector_id: 'https://test.pdpp.org/connectors/a',
    display_name: 'A',
    streams: [
      {
        name: 'posts',
        query: { search: { semantic_fields: ['title', 'body'] } },
      },
      {
        name: 'comments',
        query: { search: { semantic_fields: ['body'] } },
      },
    ],
  };
}

function manifestWithoutSemantic() {
  return {
    connector_id: 'https://test.pdpp.org/connectors/b',
    display_name: 'B',
    streams: [{ name: 'saved' }],
  };
}

// ─── §2.4 — redaction ───────────────────────────────────────────────────────

test('buildEnvironmentReport redacts explicitly-secret allowlist entries', () => {
  const report = buildEnvironmentReport({
    PDPP_DCR_INITIAL_ACCESS_TOKENS: 'real-token-value-should-never-appear',
    PDPP_OWNER_PASSWORD: 'owner-password-should-never-appear',
    NODE_ENV: 'production',
  });
  const tokenEntry = report.find((e) => e.name === 'PDPP_DCR_INITIAL_ACCESS_TOKENS');
  assert.ok(tokenEntry, 'secret allowlist entry is present');
  assert.equal(tokenEntry.provenance, 'redacted');
  assert.equal(tokenEntry.value, null, 'redacted entries MUST NOT carry the raw value');
  assert.equal(tokenEntry.secret, true);

  const ownerPasswordEntry = report.find((e) => e.name === 'PDPP_OWNER_PASSWORD');
  assert.ok(ownerPasswordEntry, 'owner password entry is present');
  assert.equal(ownerPasswordEntry.provenance, 'redacted');
  assert.equal(ownerPasswordEntry.value, null, 'owner password MUST NOT reach the dashboard');
  assert.equal(ownerPasswordEntry.secret, true);

  // Non-secret allowlist entries surface the actual value.
  const nodeEnv = report.find((e) => e.name === 'NODE_ENV');
  assert.ok(nodeEnv);
  assert.equal(nodeEnv.provenance, 'present');
  assert.equal(nodeEnv.value, 'production');
  assert.equal(nodeEnv.secret, false);

  // Absent entries are labeled absent, not redacted.
  const asPort = report.find((e) => e.name === 'AS_PORT');
  assert.ok(asPort);
  assert.equal(asPort.provenance, 'absent');
  assert.equal(asPort.value, null);
});

test('buildEnvironmentReport never leaks a raw secret value', () => {
  const secret = 'sk-live-never-render-me';
  const report = buildEnvironmentReport({
    PDPP_DCR_INITIAL_ACCESS_TOKENS: secret,
  });
  for (const entry of report) {
    assert.notEqual(entry.value, secret,
      `env entry ${entry.name} must not expose the raw secret value`);
  }
});

test('buildEnvironmentReport ignores non-allowlisted variables entirely', () => {
  // An unrelated env var (even if set) MUST NOT leak through: the allowlist
  // is the entire surface, blocklist-style name matching is only the
  // secondary defense for allowlist entries whose names look secret-ish.
  const report = buildEnvironmentReport({
    RANDOM_INTERNAL_FLAG: 'should-not-appear',
    HOME: '/home/user',
  });
  assert.equal(
    report.find((e) => e.name === 'RANDOM_INTERNAL_FLAG'),
    undefined,
    'non-allowlisted env vars must not appear in the report',
  );
  assert.equal(
    report.find((e) => e.name === 'HOME'),
    undefined,
    'HOME is not on the allowlist and must not appear',
  );
});

// ─── host-browser bridge posture ───────────────────────────────────────────

function bridgePostureFromBuilder(input) {
  // Build a minimal diagnostics report just to read the host_browser_bridge
  // section out of the structured shape — keeps these tests honest about
  // what the dashboard actually sees rather than poking the helper directly.
  return buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: ':memory:',
    manifests: [],
    indexState: null,
    env: {},
    hostBrowserBridge: input,
  });
}

test('host browser bridge: absent input renders disabled with not_checked reachability', () => {
  const report = bridgePostureFromBuilder(null);
  assert.equal(report.host_browser_bridge.mode, 'disabled');
  assert.equal(report.host_browser_bridge.url, null);
  assert.equal(report.host_browser_bridge.token_configured, false);
  assert.equal(report.host_browser_bridge.daily_chrome_acknowledged, false);
  assert.equal(report.host_browser_bridge.misconfigured_reason, null);
  assert.equal(report.host_browser_bridge.reachability.status, 'not_checked');
  // No bridge warnings should fire when the bridge is absent — operators
  // who do not opt in must not see noise.
  const codes = report.warnings.map((w) => w.code);
  assert.ok(!codes.includes('host_browser_bridge_misconfigured'));
  assert.ok(!codes.includes('host_browser_bridge_unreachable'));
  assert.ok(!codes.includes('host_browser_bridge_daily_chrome'));
});

test('host browser bridge: misconfigured input warns and surfaces reason', () => {
  const report = bridgePostureFromBuilder({
    mode: 'misconfigured',
    url: 'ws://host.docker.internal:7670',
    tokenConfigured: false,
    dailyChromeAcknowledged: false,
    misconfiguredReason: 'PDPP_HOST_BROWSER_BRIDGE_URL is set but PDPP_HOST_BROWSER_BRIDGE_TOKEN is empty',
    reachability: { status: 'not_checked', reason: 'Skipped because no token is configured.' },
  });
  assert.equal(report.host_browser_bridge.mode, 'misconfigured');
  assert.equal(report.host_browser_bridge.token_configured, false);
  // The configured URL is surfaced even in the misconfigured state so the
  // operator can see what they typed; the token never crosses this surface.
  assert.equal(report.host_browser_bridge.url, 'ws://host.docker.internal:7670');
  const warning = report.warnings.find((w) => w.code === 'host_browser_bridge_misconfigured');
  assert.ok(warning, 'misconfigured bridge raises a warning');
  assert.match(warning.message, /PDPP_HOST_BROWSER_BRIDGE_TOKEN/);
});

test('host browser bridge: configured + unreachable warns with cause', () => {
  const report = bridgePostureFromBuilder({
    mode: 'configured',
    url: 'ws://host.docker.internal:7670',
    tokenConfigured: true,
    dailyChromeAcknowledged: false,
    misconfiguredReason: null,
    reachability: { status: 'unreachable', reason: 'connect ECONNREFUSED 192.168.65.2:7670' },
  });
  const warning = report.warnings.find((w) => w.code === 'host_browser_bridge_unreachable');
  assert.ok(warning, 'unreachable bridge raises a warning');
  assert.match(warning.message, /ws:\/\/host\.docker\.internal:7670/);
  assert.match(warning.message, /ECONNREFUSED/);
});

test('host browser bridge: daily chrome opt-in warns even when reachable', () => {
  const report = bridgePostureFromBuilder({
    mode: 'configured',
    url: 'ws://host.docker.internal:7670',
    tokenConfigured: true,
    dailyChromeAcknowledged: true,
    misconfiguredReason: null,
    reachability: { status: 'ok' },
  });
  assert.equal(report.host_browser_bridge.daily_chrome_acknowledged, true);
  const warning = report.warnings.find((w) => w.code === 'host_browser_bridge_daily_chrome');
  assert.ok(warning, 'daily-chrome opt-in raises a per-deploy warning');
});

test('host browser bridge: report shape never carries a raw token field', () => {
  // Defense in depth — the input type does not even accept a raw token,
  // and the report shape must not introduce one. A future refactor that
  // adds a "token" field to either side should fail this test loudly.
  const report = bridgePostureFromBuilder({
    mode: 'configured',
    url: 'ws://host.docker.internal:7670',
    tokenConfigured: true,
    dailyChromeAcknowledged: false,
    misconfiguredReason: null,
    reachability: { status: 'ok' },
  });
  assert.ok(!('token' in report.host_browser_bridge),
    'host_browser_bridge MUST NOT include a token field');
  // Serialize and grep — even nested string interpolation must not embed a token.
  const blob = JSON.stringify(report.host_browser_bridge);
  assert.ok(!blob.toLowerCase().includes('"token":'),
    'serialized posture must not include a token field at any nesting level');
});

// ─── §2.4 — zero participation reported separately from readiness ──────────

test('zero participation warning fires even when backend+index are ready', () => {
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend(),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: '/tmp/test.sqlite',
    manifests: [
      { manifest: manifestWithoutSemantic(), provenance: 'polyfill-registered' },
    ],
    indexState: 'built',
    env: {},
  });

  const codes = report.warnings.map((w) => w.code);
  assert.ok(
    codes.includes('zero_participation'),
    `zero_participation warning MUST fire; got warnings=${JSON.stringify(codes)}`,
  );

  // Backend/index must still report ready — the two axes are distinct.
  assert.equal(report.semantic.backend.configured, true);
  assert.equal(report.semantic.backend.available, true);
  assert.equal(report.semantic.index.kind, 'sqlite-vec');
  assert.equal(report.semantic.index.state, 'built');

  // Participation is honestly zero.
  assert.equal(report.semantic.participation.connector_count, 0);
  assert.equal(report.semantic.participation.field_count, 0);
  assert.deepEqual(report.semantic.participation.tuples, []);

  // Backend-unavailable warning MUST NOT fire — that's a different axis.
  assert.ok(!codes.includes('backend_unavailable'));
});

test('no zero participation warning when at least one field participates', () => {
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend(),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: '/tmp/test.sqlite',
    manifests: [
      { manifest: manifestWithSemantic(), provenance: 'polyfill-registered' },
    ],
    indexState: 'built',
    env: {},
  });
  const codes = report.warnings.map((w) => w.code);
  assert.ok(!codes.includes('zero_participation'));
  assert.equal(report.semantic.participation.connector_count, 1);
  assert.equal(report.semantic.participation.stream_count, 2);
  assert.equal(report.semantic.participation.field_count, 3);
});

test('lexical backfill progress is surfaced as a distinct warning', () => {
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend(),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: '/tmp/test.sqlite',
    manifests: [{ manifest: manifestWithSemantic(), provenance: 'polyfill-registered' }],
    indexState: 'built',
    lexicalBackfillProgress: {
      id: 'lexical_backfill_1',
      connector_id: 'https://test.pdpp.org/connectors/a',
      stream: 'posts',
      phase: 'rebuilding',
      active_jobs: 1,
      manifest_streams_checked: 1,
      manifest_streams_total: 2,
      records_scanned: 500,
      records_total: 1000,
      indexed_rows: 750,
      started_at: '2026-04-24T20:00:00.000Z',
      updated_at: '2026-04-24T20:00:05.000Z',
    },
    env: {},
  });

  assert.equal(report.lexical.index.state, 'building');
  assert.equal(report.lexical.index.backfill_progress?.records_scanned, 500);
  assert.equal(report.lexical.index.backfill_progress?.indexed_rows, 750);
  assert.ok(report.warnings.some((w) => w.code === 'lexical_building_index'));
  assert.equal(report.semantic.index.state, 'built');
});

test('backend unavailability is reported even with zero participation', () => {
  // An operator staring at empty semantic results needs to see BOTH
  // axes — the backend being unavailable AND the corpus being empty —
  // because each has a different remediation.
  const report = buildDeploymentDiagnostics({
    backend: null,
    db: { vectorIndexKind: 'blob-flat' },
    dbPath: ':memory:',
    manifests: [],
    indexState: null,
    env: {},
  });
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes('backend_unavailable'));
  assert.ok(codes.includes('zero_participation'));
  assert.ok(codes.includes('vector_index_fallback'));
  assert.equal(report.semantic.backend.configured, false);
  assert.equal(report.semantic.backend.available, false);
  assert.equal(report.semantic.index.state, null);
});

test('stale index warning fires when indexState is "stale"', () => {
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend(),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: '/tmp/test.sqlite',
    manifests: [
      { manifest: manifestWithSemantic(), provenance: 'polyfill-registered' },
    ],
    indexState: 'stale',
    env: {},
  });
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes('stale_index'));
  // Participation is fine, so zero_participation must NOT fire even though
  // the index is stale.
  assert.ok(!codes.includes('zero_participation'));
});

test('building index warning fires when indexState is "building"', () => {
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend(),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: '/tmp/test.sqlite',
    manifests: [
      { manifest: manifestWithSemantic(), provenance: 'polyfill-registered' },
    ],
    indexState: 'building',
    env: {},
  });
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes('building_index'));
  assert.ok(!codes.includes('zero_participation'));
});

test('building index diagnostics include optional backfill progress', () => {
  const progress = {
    id: 'semantic_backfill_1',
    connector_id: 'https://test.pdpp.org/connectors/a',
    stream: 'posts',
    phase: 'rebuilding',
    active_jobs: 1,
    manifest_streams_checked: 1,
    manifest_streams_total: 2,
    records_scanned: 500,
    records_total: 1000,
    indexed_vectors: 700,
    started_at: '2026-04-24T10:00:00.000Z',
    updated_at: '2026-04-24T10:00:05.000Z',
  };
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend(),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: '/tmp/test.sqlite',
    manifests: [
      { manifest: manifestWithSemantic(), provenance: 'polyfill-registered' },
    ],
    indexState: 'building',
    backfillProgress: progress,
    env: {},
  });
  assert.deepEqual(report.semantic.index.backfill_progress, progress);
});

test('backend reports unavailable when available() returns false', () => {
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend({ available: () => false }),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: '/tmp/test.sqlite',
    manifests: [
      { manifest: manifestWithSemantic(), provenance: 'polyfill-registered' },
    ],
    indexState: 'built',
    env: {},
  });
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes('backend_unavailable'));
  assert.equal(report.semantic.backend.configured, true);
  assert.equal(report.semantic.backend.available, false);
});

test('missing model cache + disabled downloads are reported', () => {
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend({
      modelCachePath: () => '/var/cache/embed',
      modelCachePresent: () => false,
      downloadAllowed: () => false,
    }),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: '/tmp/test.sqlite',
    manifests: [
      { manifest: manifestWithSemantic(), provenance: 'polyfill-registered' },
    ],
    indexState: 'built',
    env: {},
  });
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes('missing_model_cache'));
  assert.ok(codes.includes('download_disabled'));
});

// ─── participation computation ─────────────────────────────────────────────

test('computeParticipation returns deterministically sorted tuples', () => {
  const out = computeParticipation([
    {
      manifest: {
        connector_id: 'z',
        streams: [{ name: 'b', query: { search: { semantic_fields: ['y', 'x'] } } }],
      },
      provenance: 'polyfill-registered',
    },
    {
      manifest: {
        connector_id: 'a',
        streams: [{ name: 'a', query: { search: { semantic_fields: ['b', 'a'] } } }],
      },
      provenance: 'native',
    },
  ]);
  assert.deepEqual(
    out.tuples.map((t) => `${t.connector_id}/${t.stream}/${t.field}`),
    ['a/a/a', 'a/a/b', 'z/b/x', 'z/b/y'],
  );
});

test('computeParticipation ignores malformed streams without crashing', () => {
  const out = computeParticipation([
    {
      manifest: {
        connector_id: 'ok',
        streams: [
          { name: 'good', query: { search: { semantic_fields: ['title'] } } },
          { /* missing name */ query: { search: { semantic_fields: ['x'] } } },
          { name: '' }, // empty name
          { name: 'has-bad-fields', query: { search: { semantic_fields: [1, null, ''] } } },
        ],
      },
      provenance: 'polyfill-registered',
    },
    { manifest: { /* no connector_id */ }, provenance: 'polyfill-registered' },
  ]);
  assert.equal(out.field_count, 1);
  assert.equal(out.tuples[0].stream, 'good');
  assert.equal(out.tuples[0].field, 'title');
});

// ─── §7.3 — blended-search gate on zero participation ─────────────────────

test('shouldAttemptSemanticUplift: advertised + participation > 0 → true', () => {
  assert.equal(shouldAttemptSemanticUplift({ advertised: true, participationFieldCount: 1 }), true);
  assert.equal(shouldAttemptSemanticUplift({ advertised: true, participationFieldCount: 42 }), true);
});

test('shouldAttemptSemanticUplift: advertised + zero participation → false', () => {
  // This is the load-bearing case: an empty semantic index must NOT look
  // like a successful semantic uplift. The dashboard's blended search must
  // skip the call entirely so the page does not imply semantic retrieval
  // ran and found nothing.
  assert.equal(
    shouldAttemptSemanticUplift({ advertised: true, participationFieldCount: 0 }),
    false,
    'advertised + zero participation must NOT trigger a semantic uplift call',
  );
});

test('shouldAttemptSemanticUplift: not advertised → false regardless of participation', () => {
  assert.equal(shouldAttemptSemanticUplift({ advertised: false, participationFieldCount: 0 }), false);
  assert.equal(shouldAttemptSemanticUplift({ advertised: false, participationFieldCount: 10 }), false);
});

// ─── /_ref/deployment route — end-to-end over HTTP ─────────────────────────

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

test('/_ref/deployment returns a structured report with zero participation by default', async () => {
  // Default startServer wiring: stub backend configured, no connectors
  // registered, so participation is zero even though the backend is ready.
  // This is exactly the scenario §2.3 calls out — "backend ready, but the
  // first-party corpus contributes no semantic fields".
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  try {
    const resp = await fetch(`http://localhost:${server.asPort}/_ref/deployment`);
    assert.equal(resp.status, 200);
    const body = await resp.json();

    // Structural shape.
    assert.ok(body.semantic);
    assert.ok(body.semantic.backend);
    assert.ok(body.semantic.index);
    assert.ok(body.semantic.participation);
    assert.ok(Array.isArray(body.environment));
    assert.ok(Array.isArray(body.warnings));

    // Backend is ready (stub), participation is zero, zero_participation
    // warning is raised.
    assert.equal(body.semantic.backend.configured, true);
    assert.equal(body.semantic.backend.available, true);
    assert.equal(body.semantic.participation.field_count, 0);
    const codes = body.warnings.map((w) => w.code);
    assert.ok(codes.includes('zero_participation'));

    // Every env entry is either absent, present, or redacted — no leaked
    // secret values and no raw environment dump.
    for (const entry of body.environment) {
      assert.ok(['absent', 'present', 'redacted'].includes(entry.provenance));
    }
  } finally {
    await closeServer(server);
  }
});

test('/_ref/deployment reports backend_unavailable when semantic is disabled', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    semanticRetrievalSupported: false,
  });
  try {
    const resp = await fetch(`http://localhost:${server.asPort}/_ref/deployment`);
    const body = await resp.json();
    const codes = body.warnings.map((w) => w.code);
    assert.ok(codes.includes('backend_unavailable'));
    assert.equal(body.semantic.backend.configured, false);
    assert.equal(body.semantic.index.state, null);
  } finally {
    await closeServer(server);
  }
});

test('diagnostics report lists manifest provenance for operator inspection', () => {
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend(),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: '/tmp/test.sqlite',
    manifests: [
      { manifest: manifestWithSemantic(), provenance: 'polyfill-registered' },
      { manifest: manifestWithoutSemantic(), provenance: 'polyfill-registered' },
    ],
    indexState: 'built',
    env: {},
  });
  assert.equal(report.manifests.length, 2);
  const a = report.manifests.find((m) => m.connector_id === 'https://test.pdpp.org/connectors/a');
  assert.ok(a);
  assert.equal(a.semantic_stream_count, 2);
  const b = report.manifests.find((m) => m.connector_id === 'https://test.pdpp.org/connectors/b');
  assert.ok(b);
  assert.equal(b.semantic_stream_count, 0);
});
