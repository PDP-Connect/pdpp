// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deployment diagnostics — unit coverage for the reference operator
 * /deployment surface.
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
  DISK_ERROR_BYTES,
  DISK_WARN_BYTES,
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
    GOOGLE_DATAPORTABILITY_CLIENT_ID: 'google-client-id.apps.googleusercontent.com',
    GOOGLE_DATAPORTABILITY_CLIENT_SECRET: 'google-client-secret-should-never-appear',
    GOOGLE_DATAPORTABILITY_REDIRECT_URI: 'https://pdpp.example/_ref/provider-auth/callback',
    PDPP_RS_SEARCH_POSTGRES_BM25_BACKEND: 'pg_search',
    PDPP_DCR_INITIAL_ACCESS_TOKENS: 'real-token-value-should-never-appear',
    PDPP_OWNER_PASSWORD: 'owner-password-should-never-appear',
    NODE_ENV: 'production',
  });
  const googleClientIdEntry = report.find((e) => e.name === 'GOOGLE_DATAPORTABILITY_CLIENT_ID');
  assert.ok(googleClientIdEntry, 'Google Data Portability client id entry is present');
  assert.equal(googleClientIdEntry.provenance, 'present');
  assert.equal(googleClientIdEntry.value, 'google-client-id.apps.googleusercontent.com');
  assert.equal(googleClientIdEntry.secret, false);

  const googleClientSecretEntry = report.find((e) => e.name === 'GOOGLE_DATAPORTABILITY_CLIENT_SECRET');
  assert.ok(googleClientSecretEntry, 'Google Data Portability client secret entry is present');
  assert.equal(googleClientSecretEntry.provenance, 'redacted');
  assert.equal(googleClientSecretEntry.value, null, 'Google OAuth client secret MUST NOT reach the dashboard');
  assert.equal(googleClientSecretEntry.secret, true);

  const googleRedirectEntry = report.find((e) => e.name === 'GOOGLE_DATAPORTABILITY_REDIRECT_URI');
  assert.ok(googleRedirectEntry, 'Google Data Portability redirect URI entry is present');
  assert.equal(googleRedirectEntry.provenance, 'present');
  assert.equal(googleRedirectEntry.value, 'https://pdpp.example/_ref/provider-auth/callback');
  assert.equal(googleRedirectEntry.secret, false);

  const bm25BackendEntry = report.find((e) => e.name === 'PDPP_RS_SEARCH_POSTGRES_BM25_BACKEND');
  assert.ok(bm25BackendEntry, 'BM25 backend selector entry is present');
  assert.equal(bm25BackendEntry.provenance, 'present');
  assert.equal(bm25BackendEntry.value, 'pg_search');
  assert.equal(bm25BackendEntry.secret, false);

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

// ─── runtime capability posture ────────────────────────────────────────────

function runtimeCapsFromBuilder(input) {
  return buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: ':memory:',
    manifests: [],
    indexState: null,
    env: {},
    runtimeCapabilities: input,
  });
}

test('runtime_capabilities: absent input renders an empty/host-default report with no warnings', () => {
  const report = runtimeCapsFromBuilder(null);
  assert.equal(report.runtime_capabilities.in_container, false);
  assert.equal(report.runtime_capabilities.collector_paired, false);
  // The default report flags `network` only — diagnostics has no input
  // so it cannot honestly claim more.
  assert.equal(report.runtime_capabilities.bindings.network, true);
  assert.equal(report.runtime_capabilities.bindings.browser, false);
  const codes = report.warnings.map((w) => w.code);
  assert.ok(!codes.includes('browser_connectors_need_collector'));
});

test('runtime_capabilities: containerized provider without collector warns', () => {
  const report = runtimeCapsFromBuilder({
    bindings: { network: true, filesystem: true, browser: false, local_device: false },
    collector_paired: false,
    in_container: true,
  });
  const warning = report.warnings.find((w) => w.code === 'browser_connectors_need_collector');
  assert.ok(warning, 'containerized provider w/o collector raises an actionable warning');
  assert.match(warning.message, /collector/);
});

test('runtime_capabilities: containerized provider with collector paired suppresses warning', () => {
  const report = runtimeCapsFromBuilder({
    bindings: { network: true, filesystem: true, browser: false, local_device: false },
    collector_paired: true,
    in_container: true,
  });
  const codes = report.warnings.map((w) => w.code);
  assert.ok(!codes.includes('browser_connectors_need_collector'));
  assert.equal(report.runtime_capabilities.collector_paired, true);
});

test('runtime_capabilities: provider runtime advertising browser does not warn even without collector', () => {
  // X11/VNC override case: the provider declares it can render a visible
  // browser. No need for a collector to satisfy browser-required
  // connectors, so no warning fires.
  const report = runtimeCapsFromBuilder({
    bindings: { network: true, filesystem: true, browser: true, local_device: false },
    collector_paired: false,
    in_container: true,
  });
  const codes = report.warnings.map((w) => w.code);
  assert.ok(!codes.includes('browser_connectors_need_collector'));
});

test('runtime_capabilities: report shape never carries a raw bridge token field', () => {
  // Defense in depth — the report shape should not introduce a `token`
  // field. A future refactor that revives the old bridge field should
  // fail this test loudly.
  const report = runtimeCapsFromBuilder({
    bindings: { network: true, filesystem: true, browser: false, local_device: true },
    collector_paired: true,
    in_container: false,
  });
  const blob = JSON.stringify(report.runtime_capabilities);
  assert.ok(!blob.toLowerCase().includes('"token":'),
    'serialized runtime_capabilities must not include a token field at any nesting level');
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

test('lexical backend posture defaults to SQLite FTS without warnings', () => {
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend(),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: ':memory:',
    manifests: [{ manifest: manifestWithSemantic(), provenance: 'polyfill-registered' }],
    indexState: 'built',
    env: {},
  });

  assert.deepEqual(report.lexical.backend, {
    active: 'sqlite_fts5',
    configured: false,
    fallback: false,
    pg_search: {
      available: false,
      state: 'not_applicable',
    },
  });
  assert.ok(!report.warnings.some((w) => w.code === 'lexical_bm25_fallback'));
});

test('lexical backend posture reports pg_search fallback without changing active backend', () => {
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend(),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: '/var/lib/pdpp/postgres',
    manifests: [{ manifest: manifestWithSemantic(), provenance: 'polyfill-registered' }],
    indexState: 'built',
    lexicalBackend: {
      active: 'postgres_native_fts',
      configured: true,
      fallback: true,
      pg_search: {
        available: false,
        state: 'fallback_unavailable',
      },
    },
    env: {},
  });

  assert.equal(report.lexical.backend.active, 'postgres_native_fts');
  assert.equal(report.lexical.backend.configured, true);
  assert.equal(report.lexical.backend.fallback, true);
  assert.deepEqual(report.lexical.backend.pg_search, {
    available: false,
    state: 'fallback_unavailable',
  });
  const warning = report.warnings.find((w) => w.code === 'lexical_bm25_fallback');
  assert.ok(warning, 'requested-but-unavailable pg_search emits an operator warning');
  assert.match(warning.message, /native Postgres full-text search/);
  assert.match(warning.message, /recall disclosure/);
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
    assert.ok(Array.isArray(body.disk_headroom), 'route wiring must include disk_headroom as array');
    assert.ok(body.disk_headroom.length > 0, 'disk_headroom must have at least one entry');
    assert.equal(body.disk_headroom[0].path, ':memory:');

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

// ─── physical footprint (surface-database-physical-footprint §3) ────────────
//
// The pure builder pre-computes nothing itself — the runtime adapter supplies
// `physicalFootprint`. These pin the contract: the `database` block carries
// the footprint when supplied, degrades to null/null when absent or SQLite,
// and never fabricates a 0. `database.path` is always preserved.

test('database block carries physical_bytes + top_relations from a Postgres footprint input', () => {
  const report = buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: '/var/lib/postgresql/data',
    manifests: [],
    indexState: null,
    env: {},
    physicalFootprint: {
      physical_bytes: 54_975_581_388, // ~51 GB
      top_relations: [
        { name: 'lexical_search_fts', bytes: 21_000_000_000 },
        { name: 'records', bytes: 9_000_000_000 },
        { name: 'spine_events', bytes: 4_000_000_000 },
      ],
    },
  });

  assert.equal(report.database.path, '/var/lib/postgresql/data', 'path is preserved');
  assert.equal(report.database.physical_bytes, 54_975_581_388);
  assert.ok(Array.isArray(report.database.top_relations));
  assert.equal(report.database.top_relations.length, 3);
  assert.equal(report.database.top_relations[0].name, 'lexical_search_fts');
  assert.equal(report.database.top_relations[0].bytes, 21_000_000_000);
  // The largest relation never exceeds the whole — sanity on the test fixture
  // and the property the helper guarantees.
  assert.ok(report.database.top_relations[0].bytes <= report.database.physical_bytes);
});

test('database block degrades to null/null when no footprint is supplied (SQLite/absent)', () => {
  const report = buildDeploymentDiagnostics({
    backend: fakeBackend(),
    db: { vectorIndexKind: 'sqlite-vec' },
    dbPath: '/tmp/test.sqlite',
    manifests: [],
    indexState: 'built',
    env: {},
    // physicalFootprint omitted — the SQLite/absent path.
  });
  assert.equal(report.database.path, '/tmp/test.sqlite', 'path still reported');
  assert.equal(report.database.physical_bytes, null, 'no fabricated 0 for an unmeasured backend');
  assert.equal(report.database.top_relations, null);
});

test('database block treats an explicit null footprint (read failure) as unmeasured', () => {
  const report = buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: '/var/lib/postgresql/data',
    manifests: [],
    indexState: null,
    env: {},
    physicalFootprint: { physical_bytes: null, top_relations: null },
  });
  assert.equal(report.database.physical_bytes, null);
  assert.equal(report.database.top_relations, null);
  assert.equal(report.database.path, '/var/lib/postgresql/data', 'rest of the block is intact');
});

test('database block never carries a fabricated 0 for a non-numeric footprint total', () => {
  const report = buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: '/var/lib/postgresql/data',
    manifests: [],
    indexState: null,
    env: {},
    // A malformed total (e.g. a stringly-typed bigint that slipped through)
    // must degrade to unmeasured, not coerce to 0.
    physicalFootprint: { physical_bytes: Number.NaN, top_relations: [{ name: 'x', bytes: 1 }] },
  });
  assert.equal(report.database.physical_bytes, null, 'NaN total degrades to null, not 0');
  assert.equal(report.database.top_relations, null, 'relations are dropped when the total is unmeasured');
});

test('physical footprint block carries no secrets, payloads, or URLs beyond relation names + sizes', () => {
  const report = buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: '/var/lib/postgresql/data',
    manifests: [],
    indexState: null,
    env: { PDPP_OWNER_PASSWORD: 'should-never-appear' },
    physicalFootprint: {
      physical_bytes: 1234,
      top_relations: [{ name: 'records', bytes: 1000 }],
    },
  });
  // The database block is only a path + total + {name,bytes} pairs. Assert
  // the relation rows carry exactly those two keys and nothing else.
  for (const relation of report.database.top_relations) {
    assert.deepEqual(Object.keys(relation).sort(), ['bytes', 'name']);
  }
  const blob = JSON.stringify(report.database);
  assert.ok(!blob.includes('should-never-appear'), 'no env/secret leaks into the database block');
});

// ─── disk headroom ──────────────────────────────────────────────────────────

function buildWithDisk(diskHeadroom) {
  return buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: ':memory:',
    manifests: [],
    indexState: null,
    env: {},
    diskHeadroom,
  });
}

test('disk_headroom block is empty array when not supplied', () => {
  const report = buildWithDisk(undefined);
  assert.ok(Array.isArray(report.disk_headroom), 'disk_headroom is an array');
  assert.equal(report.disk_headroom.length, 0);
  // low_disk_headroom warning must not fire when headroom is unmeasured.
  assert.ok(!report.warnings.some((w) => w.code === 'low_disk_headroom'));
});

test('disk_headroom block has one entry with null free_bytes when probe returned null', () => {
  const report = buildWithDisk({ path: '/data', free_bytes: null, total_bytes: null });
  assert.ok(Array.isArray(report.disk_headroom), 'disk_headroom is an array');
  assert.equal(report.disk_headroom.length, 1);
  assert.equal(report.disk_headroom[0].free_bytes, null);
  assert.ok(!report.warnings.some((w) => w.code === 'low_disk_headroom'));
});

test('no low_disk_headroom warning when free space exceeds warn threshold', () => {
  const report = buildWithDisk({
    path: '/data',
    free_bytes: DISK_WARN_BYTES + 1,
    total_bytes: 100 * 1024 * 1024 * 1024,
  });
  assert.equal(report.disk_headroom[0]?.free_bytes, DISK_WARN_BYTES + 1);
  assert.ok(!report.warnings.some((w) => w.code === 'low_disk_headroom'));
});

test('low_disk_headroom warning fires when free space is below warn threshold', () => {
  const report = buildWithDisk({
    path: '/data',
    free_bytes: DISK_WARN_BYTES - 1,
    total_bytes: 100 * 1024 * 1024 * 1024,
  });
  const warning = report.warnings.find((w) => w.code === 'low_disk_headroom');
  assert.ok(warning, 'low_disk_headroom warning must fire below warn threshold');
  assert.match(warning.message, /docker system prune/);
});

test('low_disk_headroom warning fires (critically) when free space is below error threshold', () => {
  const report = buildWithDisk({
    path: '/data',
    free_bytes: DISK_ERROR_BYTES - 1,
    total_bytes: 50 * 1024 * 1024 * 1024,
  });
  const warning = report.warnings.find((w) => w.code === 'low_disk_headroom');
  assert.ok(warning, 'low_disk_headroom warning must fire below error threshold');
  assert.match(warning.message, /No space left on device/);
  // Must not suggest automatic data deletion.
  assert.ok(
    !warning.message.toLowerCase().includes('auto-delete') &&
      !warning.message.toLowerCase().includes('automatically delete'),
    'warning must not suggest automatic data deletion',
  );
  assert.ok(!warning.message.includes('--volumes'), 'warning must not recommend deleting Docker volumes');
});

test('disk_headroom block carries path, free_bytes, and total_bytes from input', () => {
  const report = buildWithDisk({
    path: '/mnt/data',
    free_bytes: 10 * 1024 * 1024 * 1024,
    total_bytes: 200 * 1024 * 1024 * 1024,
  });
  assert.ok(Array.isArray(report.disk_headroom));
  assert.equal(report.disk_headroom.length, 1);
  assert.equal(report.disk_headroom[0]?.path, '/mnt/data');
  assert.equal(report.disk_headroom[0]?.free_bytes, 10 * 1024 * 1024 * 1024);
  assert.equal(report.disk_headroom[0]?.total_bytes, 200 * 1024 * 1024 * 1024);
  // Single FS — no mount_label (keeps copy terse for single-FS deployments).
  assert.equal(report.disk_headroom[0]?.mount_label, undefined);
});

// ─── workload-aware warning ─────────────────────────────────────────────────

test('low_disk_headroom warning includes workload hint when free < largest relation', () => {
  const report = buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: ':memory:',
    manifests: [],
    indexState: null,
    env: {},
    // 4 GiB free — below warn (5 GiB) and below largest relation (6 GiB).
    diskHeadroom: {
      path: '/data',
      free_bytes: 4 * 1024 * 1024 * 1024,
      total_bytes: 100 * 1024 * 1024 * 1024,
    },
    physicalFootprint: {
      physical_bytes: 50 * 1024 * 1024 * 1024,
      top_relations: [
        { name: 'records', bytes: 6 * 1024 * 1024 * 1024 },
      ],
    },
  });
  const warning = report.warnings.find((w) => w.code === 'low_disk_headroom');
  assert.ok(warning, 'low_disk_headroom warning must fire');
  assert.ok(
    warning.message.includes('VACUUM FULL'),
    'workload hint must mention VACUUM FULL when free < largest relation',
  );
  assert.ok(warning.message.includes('records'), 'hint names the largest relation');
});

test('low_disk_headroom warning omits workload hint when free >= largest relation', () => {
  const report = buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: ':memory:',
    manifests: [],
    indexState: null,
    env: {},
    // 4 GiB free — below warn (5 GiB) but ABOVE largest relation (3 GiB).
    diskHeadroom: {
      path: '/data',
      free_bytes: 4 * 1024 * 1024 * 1024,
      total_bytes: 100 * 1024 * 1024 * 1024,
    },
    physicalFootprint: {
      physical_bytes: 50 * 1024 * 1024 * 1024,
      top_relations: [
        { name: 'records', bytes: 3 * 1024 * 1024 * 1024 },
      ],
    },
  });
  const warning = report.warnings.find((w) => w.code === 'low_disk_headroom');
  assert.ok(warning, 'low_disk_headroom warning must still fire (absolute threshold)');
  assert.ok(
    !warning.message.includes('VACUUM FULL'),
    'workload hint must NOT appear when free >= largest relation',
  );
});

test('low_disk_headroom workload hint is absent when footprint is unavailable (SQLite)', () => {
  const report = buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: ':memory:',
    manifests: [],
    indexState: null,
    env: {},
    diskHeadroom: {
      path: '/data',
      free_bytes: 4 * 1024 * 1024 * 1024,
      total_bytes: 100 * 1024 * 1024 * 1024,
    },
    // no physicalFootprint supplied → degrade silently
  });
  const warning = report.warnings.find((w) => w.code === 'low_disk_headroom');
  assert.ok(warning, 'warning fires on absolute threshold even without footprint');
  assert.ok(!warning.message.includes('VACUUM FULL'), 'no workload hint when footprint is absent');
});

// ─── multi-mount awareness ──────────────────────────────────────────────────

test('disk_headroom: single entry when pgDiskHeadroom is on same filesystem (total_bytes heuristic)', () => {
  const sharedTotal = 100 * 1024 * 1024 * 1024;
  const report = buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: ':memory:',
    manifests: [],
    indexState: null,
    env: {},
    diskHeadroom: {
      path: '/data',
      free_bytes: 20 * 1024 * 1024 * 1024,
      total_bytes: sharedTotal,
    },
    // Same total_bytes → same FS → deduplicated.
    pgDiskHeadroom: {
      path: '/var/lib/postgresql/data',
      free_bytes: 20 * 1024 * 1024 * 1024,
      total_bytes: sharedTotal,
    },
  });
  assert.equal(report.disk_headroom.length, 1, 'same FS must be deduplicated to one entry');
  assert.equal(report.disk_headroom[0]?.mount_label, undefined, 'no label for a single FS');
});

test('disk_headroom: two entries when pgDiskHeadroom is on a distinct filesystem', () => {
  const report = buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: ':memory:',
    manifests: [],
    indexState: null,
    env: {},
    diskHeadroom: {
      path: '/data',
      free_bytes: 20 * 1024 * 1024 * 1024,
      total_bytes: 100 * 1024 * 1024 * 1024,
    },
    // Different total_bytes → different FS → both reported.
    pgDiskHeadroom: {
      path: '/var/lib/postgresql/data',
      free_bytes: 8 * 1024 * 1024 * 1024,
      total_bytes: 50 * 1024 * 1024 * 1024,
    },
  });
  assert.equal(report.disk_headroom.length, 2, 'distinct FS must produce two entries');
  const dataEntry = report.disk_headroom.find((e) => e.mount_label === 'data');
  const pgEntry = report.disk_headroom.find((e) => e.mount_label === 'postgres');
  assert.ok(dataEntry, 'first entry labeled "data"');
  assert.ok(pgEntry, 'second entry labeled "postgres"');
  assert.equal(dataEntry?.path, '/data');
  assert.equal(pgEntry?.path, '/var/lib/postgresql/data');
});

test('disk_headroom: postgres entry reported as "unmeasured" when probe returned null free_bytes', () => {
  // Simulates the reference container not having the PG volume mounted.
  // The entry is still present (never a false green) but its free_bytes is null
  // and no warning fires for it.
  const report = buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: ':memory:',
    manifests: [],
    indexState: null,
    env: {},
    diskHeadroom: {
      path: '/data',
      free_bytes: 20 * 1024 * 1024 * 1024,
      total_bytes: 100 * 1024 * 1024 * 1024,
    },
    pgDiskHeadroom: {
      path: '/var/lib/postgresql/data',
      free_bytes: null,
      total_bytes: null,
    },
  });
  // total_bytes both null → cannot confirm same FS → report both.
  const pgEntry = report.disk_headroom.find((e) => e.mount_label === 'postgres');
  assert.ok(pgEntry, 'unmeasured postgres mount must still be reported (never a false green)');
  assert.equal(pgEntry?.free_bytes, null);
  // Only one warning fires (for the data dir being above thresholds → none here)
  // — the unmeasured PG entry does not generate a spurious warning.
  const diskWarnings = report.warnings.filter((w) => w.code === 'low_disk_headroom');
  assert.equal(diskWarnings.length, 0, 'no warning for the unmeasured pg entry');
});

test('never suggests automatic data deletion (pin for all disk warning variants)', () => {
  // Error threshold — includes workload hint.
  const withWorkload = buildDeploymentDiagnostics({
    backend: null,
    db: null,
    dbPath: ':memory:',
    manifests: [],
    indexState: null,
    env: {},
    diskHeadroom: {
      path: '/data',
      free_bytes: 1 * 1024 * 1024 * 1024,  // < error threshold
      total_bytes: 100 * 1024 * 1024 * 1024,
    },
    physicalFootprint: {
      physical_bytes: 50 * 1024 * 1024 * 1024,
      top_relations: [{ name: 'records', bytes: 3 * 1024 * 1024 * 1024 }],
    },
  });
  for (const w of withWorkload.warnings.filter((w) => w.code === 'low_disk_headroom')) {
    assert.ok(
      !w.message.toLowerCase().includes('auto-delete') &&
        !w.message.toLowerCase().includes('automatically delete'),
      'warning must not suggest automatic data deletion',
    );
    assert.ok(!w.message.includes('--volumes'), 'warning must not recommend deleting Docker volumes');
  }
});
