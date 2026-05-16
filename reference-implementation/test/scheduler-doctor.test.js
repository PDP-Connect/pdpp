// Proves the scheduler-doctor probe script surfaces an honest runtime
// verdict from a /_ref/schedules listing. The script is the AI-friendly
// equivalent of "did the scheduler loop pick up my Docker schedule?" —
// it must classify enabled/ineligible/never-ran without false positives.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = join(__dirname, '..', 'scripts', 'scheduler-doctor.mjs');

function startFakeAs(listing) {
  return startFakeAsWith({ schedules: listing });
}

function startFakeAsWith({ schedules, connectors = null }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/_ref/schedules') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(schedules));
        return;
      }
      if (req.url === '/_ref/connectors' && connectors) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(connectors));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function runProbe(asUrl, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, PDPP_OWNER_PASSWORD: '', ...extraEnv };
    const child = spawn(process.execPath, [PROBE_PATH, '--as-url', asUrl, '--json'], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test('scheduler-doctor classifies enabled, ineligible, paused, and never-ran schedules', async () => {
  const listing = {
    object: 'list',
    data: [
      {
        connector_id: 'spotify',
        enabled: true,
        effective_mode: 'automatic',
        ineligibility_reason: null,
        interval_seconds: 3600,
        last_started_at: null,
        next_due_at: '2026-05-15T10:00:00.000Z',
        active_run_id: null,
      },
      {
        connector_id: 'github',
        enabled: true,
        effective_mode: 'automatic',
        ineligibility_reason: 'Connector refresh policy is not background-safe; automatic scheduling is disabled.',
        interval_seconds: 1800,
        last_started_at: '2026-05-14T09:00:00.000Z',
        active_run_id: null,
      },
      {
        connector_id: 'reddit',
        enabled: false,
        effective_mode: 'paused',
        ineligibility_reason: null,
        interval_seconds: 1800,
        last_started_at: null,
        active_run_id: null,
      },
      {
        connector_id: 'slack',
        enabled: true,
        effective_mode: 'automatic',
        ineligibility_reason: null,
        interval_seconds: 7200,
        last_started_at: '2026-05-15T08:00:00.000Z',
        last_successful_at: '2026-05-15T08:00:30.000Z',
        active_run_id: 'run_42',
      },
    ],
  };

  const { server, url } = await startFakeAs(listing);
  try {
    const { code, stdout, stderr } = await runProbe(url);
    assert.equal(code, 0, `probe exit code 0; stderr: ${stderr}`);
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary.total, 4);
    assert.equal(summary.enabled, 3, 'three schedules have enabled=true');
    assert.equal(summary.automatic, 2, 'two would actually fire (spotify, slack)');
    assert.equal(summary.ineligible, 1, 'one enabled-but-ineligible (github)');
    assert.equal(summary.never_ran, 1, 'spotify would fire but has never started');
    assert.equal(summary.has_active_run, 1, 'slack has an active run');

    const byId = new Map(summary.schedules.map((s) => [s.connector_id, s]));
    assert.equal(byId.get('spotify').would_fire, true);
    assert.equal(byId.get('github').would_fire, false, 'ineligible reason blocks would_fire');
    assert.equal(byId.get('reddit').would_fire, false, 'disabled blocks would_fire');
    assert.equal(byId.get('slack').would_fire, true);
  } finally {
    server.close();
  }
});

test('scheduler-doctor exits non-zero when the AS endpoint is unreachable', async () => {
  // 127.0.0.1:1 is the canonical "rejecting" loopback address for this
  // assertion: it's a privileged port with no listener, so the TCP
  // connect fails fast and the probe's error path runs deterministically.
  const { code, stderr } = await runProbe('http://127.0.0.1:1');
  assert.equal(code, 1);
  assert.match(stderr, /cannot reach/);
});

test('scheduler-doctor handles an empty schedules listing without crashing', async () => {
  const { server, url } = await startFakeAs({ object: 'list', data: [] });
  try {
    const { code, stdout } = await runProbe(url);
    assert.equal(code, 0);
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary.total, 0);
    assert.equal(summary.automatic, 0);
    assert.equal(summary.schedules.length, 0);
  } finally {
    server.close();
  }
});

test('scheduler-doctor surfaces NOSCHED for auto-eligible registered connectors with no persisted row', async () => {
  // Cross-references /_ref/connectors against /_ref/schedules so an
  // operator can see registered, background-safe, automatic connectors
  // that simply have no schedule row yet (e.g., notion/oura/strava in
  // SLVP Docker before the operator enrolls them). MANUAL flags rows
  // that are correctly absent because the manifest gates them.
  const schedules = { object: 'list', data: [] };
  const connectors = {
    object: 'list',
    data: [
      {
        connector_id: 'notion',
        refresh_policy: {
          recommended_mode: 'automatic',
          background_safe: true,
        },
      },
      {
        connector_id: 'amazon',
        refresh_policy: {
          recommended_mode: 'manual',
          background_safe: false,
        },
      },
      {
        connector_id: 'reddit',
        refresh_policy: {
          recommended_mode: 'manual',
          background_safe: false,
        },
      },
    ],
  };
  const { server, url } = await startFakeAsWith({ schedules, connectors });
  try {
    const { code, stdout, stderr } = await runProbe(url);
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary.total, 0, 'no persisted schedule rows');
    assert.equal(summary.eligible_unscheduled, 1, 'one auto-eligible connector lacks a schedule row');
    assert.equal(summary.manual_unscheduled, 2, 'amazon and reddit are correctly unscheduled');

    const byId = new Map(summary.schedules.map((s) => [s.connector_id, s]));
    assert.equal(byId.get('notion').kind, 'no_schedule_eligible');
    assert.equal(byId.get('notion').would_fire, false, 'no row means no automatic fire');
    assert.equal(byId.get('notion').ineligibility_reason, null);
    assert.equal(byId.get('amazon').kind, 'no_schedule_manual');
    assert.match(byId.get('amazon').ineligibility_reason, /background-safe|manual|paused/);
    assert.equal(byId.get('reddit').kind, 'no_schedule_manual');
  } finally {
    server.close();
  }
});

test('scheduler-doctor does not duplicate connectors that have a persisted schedule row', async () => {
  const schedules = {
    object: 'list',
    data: [
      {
        connector_id: 'spotify',
        enabled: true,
        effective_mode: 'automatic',
        ineligibility_reason: null,
        interval_seconds: 3600,
        last_started_at: null,
        next_due_at: null,
        active_run_id: null,
      },
    ],
  };
  const connectors = {
    object: 'list',
    data: [
      {
        connector_id: 'spotify',
        refresh_policy: { recommended_mode: 'automatic', background_safe: true },
      },
    ],
  };
  const { server, url } = await startFakeAsWith({ schedules, connectors });
  try {
    const { code, stdout } = await runProbe(url);
    assert.equal(code, 0);
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary.total, 1);
    assert.equal(summary.eligible_unscheduled, 0, 'spotify is not double-counted');
    assert.equal(summary.schedules.length, 1);
    assert.equal(summary.schedules[0].kind, 'persisted');
  } finally {
    server.close();
  }
});

test('scheduler-doctor reads a real /_ref/schedules from a live reference server with owner-password auth', async () => {
  const { startServer } = await import('../server/index.js');
  const { closeDb } = await import('../server/db.js');
  const { readFileSync } = await import('node:fs');
  const REFERENCE_IMPL_DIR = join(__dirname, '..');
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  const ownerPassword = 'scheduler-doctor-test-pw';

  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: ownerPassword,
  });

  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const registerResp = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);
    await server.controller.upsertSchedule(spotifyManifest.connector_id, {
      interval_seconds: 3600,
      jitter_seconds: 0,
      enabled: true,
    });

    const { code, stdout, stderr } = await runProbe(asUrl, { PDPP_OWNER_PASSWORD: ownerPassword });
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary.total, 1, 'one persisted schedule');
    assert.equal(summary.enabled, 1);
    assert.equal(summary.automatic, 1, 'spotify is background-safe; would_fire is true');
    assert.equal(summary.schedules[0].connector_id, spotifyManifest.connector_id);
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await new Promise((resolve) => server.asServer.close(resolve));
    await new Promise((resolve) => server.rsServer.close(resolve));
    closeDb();
  }
});
