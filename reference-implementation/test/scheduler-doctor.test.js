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

import { canonicalConnectorKey } from '../server/connector-key.js';

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

test('scheduler-doctor projects persisted history facts into existing schedule fields after restart', async () => {
  // Once `/_ref/schedules` started carrying history-derived `last_*` and
  // `next_due_at` fields, a persisted schedule whose in-memory active-run
  // row already cleared must NOT show up as `never_ran` and must NOT be
  // counted toward `would_fire` until its interval has elapsed. The
  // dashboard reads the same envelope; the doctor stays aligned with it.
  const lastFinishedAt = new Date(Date.now() - 60_000).toISOString(); // ran 1 minute ago
  const nextDueAt = new Date(Date.now() + 3_540_000).toISOString(); // due in 59 minutes
  const lastStartedAt = new Date(Date.now() - 120_000).toISOString();
  const listing = {
    object: 'list',
    data: [
      {
        connector_id: 'gmail',
        enabled: true,
        effective_mode: 'automatic',
        ineligibility_reason: null,
        interval_seconds: 3600,
        last_started_at: lastStartedAt,
        last_finished_at: lastFinishedAt,
        last_successful_at: lastFinishedAt,
        last_error_code: null,
        next_due_at: nextDueAt,
        active_run_id: null,
      },
    ],
  };

  const { server, url } = await startFakeAs(listing);
  try {
    const { code, stdout, stderr } = await runProbe(url);
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary.total, 1);
    assert.equal(summary.enabled, 1);
    assert.equal(
      summary.never_ran,
      0,
      'persisted history means gmail is not never_ran',
    );
    assert.equal(
      summary.automatic,
      0,
      'gmail ran 1m ago with a 1h interval; not currently inside its dispatch window',
    );
    const gmail = summary.schedules[0];
    assert.equal(gmail.would_fire, false, 'next_due_at is in the future');
    assert.equal(gmail.last_started_at, lastStartedAt);
    assert.equal(gmail.last_finished_at, lastFinishedAt);
    assert.equal(gmail.next_due_at, nextDueAt);
  } finally {
    server.close();
  }
});

test('scheduler-doctor surfaces skip-only history without flipping last_started_at', async () => {
  // A connector that the scheduler keeps skipping (not_ready / needs_human /
  // disabled grant) never spawns a child process. The controller's history
  // index records `last_finished_at` from `scheduler_last_run_times` but
  // intentionally leaves `last_started_at` null because the run never
  // started. The doctor must (a) NOT classify the schedule as `never_ran`
  // (we have evidence the scheduler is acting on it), and (b) still surface
  // the failure code if a recent attempt failed terminally. This is what
  // lets an operator tell "ran but currently idle" apart from "currently
  // being skipped".
  const lastFinishedAt = new Date(Date.now() - 60_000).toISOString();
  const nextDueAt = new Date(Date.now() + 60_000).toISOString();
  const listing = {
    object: 'list',
    data: [
      {
        connector_id: 'amazon',
        enabled: true,
        effective_mode: 'automatic',
        ineligibility_reason: null,
        interval_seconds: 1800,
        last_started_at: null,
        last_finished_at: lastFinishedAt,
        last_successful_at: null,
        last_error_code: 'not_ready: collector not paired',
        next_due_at: nextDueAt,
        active_run_id: null,
      },
    ],
  };
  const { server, url } = await startFakeAs(listing);
  try {
    const { code, stdout } = await runProbe(url);
    assert.equal(code, 0);
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary.never_ran, 0, 'skip-only history is still evidence of activity');
    assert.equal(summary.automatic, 0, 'not currently due');
    const amazon = summary.schedules[0];
    assert.equal(amazon.last_started_at, null, 'skip records do not populate last_started_at');
    assert.equal(amazon.last_finished_at, lastFinishedAt);
    assert.equal(amazon.last_error_code, 'not_ready: collector not paired');
  } finally {
    server.close();
  }
});

test('scheduler-doctor only reports never_ran for genuinely never-fired schedules', async () => {
  // Distinguishes a fresh enrollment (no history, would fire on next tick)
  // from a recently-completed schedule (has history, currently idle).
  const lastFinishedAt = new Date(Date.now() - 60_000).toISOString();
  const futureDue = new Date(Date.now() + 3_540_000).toISOString();
  const listing = {
    object: 'list',
    data: [
      {
        connector_id: 'fresh',
        enabled: true,
        effective_mode: 'automatic',
        ineligibility_reason: null,
        interval_seconds: 3600,
        last_started_at: null,
        last_finished_at: null,
        last_successful_at: null,
        last_error_code: null,
        next_due_at: null,
        active_run_id: null,
      },
      {
        connector_id: 'idle',
        enabled: true,
        effective_mode: 'automatic',
        ineligibility_reason: null,
        interval_seconds: 3600,
        last_started_at: new Date(Date.now() - 120_000).toISOString(),
        last_finished_at: lastFinishedAt,
        last_successful_at: lastFinishedAt,
        last_error_code: null,
        next_due_at: futureDue,
        active_run_id: null,
      },
    ],
  };
  const { server, url } = await startFakeAs(listing);
  try {
    const { code, stdout } = await runProbe(url);
    assert.equal(code, 0);
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary.never_ran, 1, 'only the genuinely never-fired schedule counts');
    assert.equal(summary.automatic, 1, 'fresh is due now, idle is not');
    const byId = new Map(summary.schedules.map((s) => [s.connector_id, s]));
    assert.equal(byId.get('fresh').would_fire, true);
    assert.equal(byId.get('idle').would_fire, false);
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
    assert.equal(
      summary.schedules[0].connector_id,
      canonicalConnectorKey(spotifyManifest.connector_id),
    );
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await new Promise((resolve) => server.asServer.close(resolve));
    await new Promise((resolve) => server.rsServer.close(resolve));
    closeDb();
  }
});

test('controller.listSchedules projects persisted history when no active run is present', async () => {
  // Live durable contract test: prove `ScheduleApi.last_*` and `next_due_at`
  // are sourced from `scheduler_run_history` + `scheduler_last_run_times`
  // when the in-memory active-run row is absent. This is the operator-API
  // contract: the doctor, the dashboard, and any future consumer of
  // `/_ref/schedules` rely on it. Without this, an operator who restarts
  // the reference server sees null last-run timestamps even when history
  // is intact.
  const { startServer } = await import('../server/index.js');
  const { getDefaultSchedulerStore } = await import('../server/stores/scheduler-store.ts');
  const { closeDb } = await import('../server/db.js');
  const { readFileSync } = await import('node:fs');
  const REFERENCE_IMPL_DIR = join(__dirname, '..');
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  // Records, schedules, and history are keyed by the canonical connector key
  // (the controller/ingest path canonicalizes the manifest's URL-shaped
  // connector_id). Store-direct seeds below must use the same canonical key,
  // and projected rows surface it. See canonicalize-connector-keys.
  const canonicalSpotifyId = canonicalConnectorKey(spotifyManifest.connector_id);
  const ownerPassword = 'scheduler-doctor-test-pw-2';

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

    // Simulate a completed run by writing a succeeded history row plus
    // the matching `scheduler_last_run_times` entry the runtime would
    // have written. This is the exact state a freshly restarted server
    // sees on disk for any connector that ran successfully before the
    // last restart.
    const store = getDefaultSchedulerStore();
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const completedAt = new Date(Date.now() - 60_000).toISOString();
    const olderFailedStartedAt = new Date(Date.now() - 240_000).toISOString();
    const olderFailedCompletedAt = new Date(Date.now() - 180_000).toISOString();
    await Promise.resolve(
      store.appendRunHistory({
        connectorId: canonicalSpotifyId,
        source: { kind: 'connector', id: canonicalSpotifyId },
        status: 'failed',
        recordsEmitted: 0,
        reportedRecordsEmitted: 0,
        checkpointSummary: null,
        knownGaps: [],
        connectorError: { code: 'older_failure', message: 'older failure' },
        runId: 'run_test_history_older_failure',
        traceId: 'trace_test_history_older_failure',
        failureReason: 'older_failure',
        terminalReason: 'older_terminal_failure',
        startedAt: olderFailedStartedAt,
        completedAt: olderFailedCompletedAt,
        attempt: 1,
      }),
    );
    await Promise.resolve(
      store.appendRunHistory({
        connectorId: canonicalSpotifyId,
        source: { kind: 'connector', id: canonicalSpotifyId },
        status: 'succeeded',
        recordsEmitted: 7,
        reportedRecordsEmitted: 7,
        checkpointSummary: null,
        knownGaps: [],
        connectorError: null,
        runId: 'run_test_history_projection',
        traceId: 'trace_test_history_projection',
        failureReason: null,
        terminalReason: null,
        startedAt,
        completedAt,
        attempt: 1,
      }),
    );
    await Promise.resolve(
      store.upsertLastRunTime(
        canonicalSpotifyId,
        Date.parse(completedAt),
        new Date().toISOString(),
      ),
    );

    const schedules = await server.controller.listSchedules();
    assert.equal(schedules.length, 1);
    const spotify = schedules[0];
    assert.equal(spotify.connector_id, canonicalSpotifyId);
    assert.equal(spotify.active_run_id, null, 'no in-memory active run');
    assert.equal(spotify.last_started_at, startedAt, 'projected from history row');
    assert.equal(spotify.last_finished_at, completedAt, 'projected from history row');
    assert.equal(spotify.last_successful_at, completedAt, 'projected from history row');
    assert.equal(spotify.last_error_code, null, 'newer success clears older failure code');
    assert.equal(spotify.next_due_at, new Date(Date.parse(completedAt) + 3600_000).toISOString());

    // `getSchedule` (single-row read) must surface the same projection.
    const single = await server.controller.getSchedule(canonicalSpotifyId);
    assert.ok(single, 'single-row getSchedule succeeds');
    assert.equal(single.last_started_at, startedAt);
    assert.equal(single.last_finished_at, completedAt);
    assert.equal(single.next_due_at, spotify.next_due_at);

    // End-to-end doctor probe must reflect the same facts.
    const { code, stdout, stderr } = await runProbe(asUrl, { PDPP_OWNER_PASSWORD: ownerPassword });
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary.never_ran, 0, 'history is projected; not never_ran');
    assert.equal(summary.automatic, 0, 'next_due_at is ~59min away; not currently due');
    const probedSpotify = summary.schedules[0];
    assert.equal(probedSpotify.last_started_at, startedAt);
    assert.equal(probedSpotify.last_finished_at, completedAt);
    assert.equal(probedSpotify.next_due_at, spotify.next_due_at);
    assert.equal(probedSpotify.would_fire, false);
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await new Promise((resolve) => server.asServer.close(resolve));
    await new Promise((resolve) => server.rsServer.close(resolve));
    closeDb();
  }
});

test('controller.listSchedules suppresses stale error code and next_due_at when manifest has gated the schedule', async () => {
  // Reddit-shape regression: an enabled schedule row exists from before
  // the connector's manifest was tightened to `background_safe: false`.
  // The persisted history carries `schedule.gave_up` and `not_ready`
  // entries from the doomed automatic runs the runtime attempted before
  // the gate landed. After gating:
  //   - the scheduler manager filters the row out of the runnable set;
  //   - `ineligibility_reason` reflects the current gate;
  //   - `last_error_code` MUST NOT continue to advertise the old
  //     `schedule.gave_up` / `not_ready` failure mode as if the
  //     scheduler were still actively failing the connector;
  //   - `next_due_at` MUST be null (no automatic run will fire).
  // Historical timestamps remain because they describe what already
  // happened. This is the contract the scheduler-doctor GATE verdict and
  // the dashboard "not runnable" chip both rely on.
  const { startServer } = await import('../server/index.js');
  const { getDefaultSchedulerStore } = await import('../server/stores/scheduler-store.ts');
  const { closeDb } = await import('../server/db.js');
  const { readFileSync } = await import('node:fs');
  const REFERENCE_IMPL_DIR = join(__dirname, '..');
  // Use the polyfill Reddit manifest directly — it is the live shape
  // the manifest reconcile installs at startup, with refresh_policy
  // {recommended_mode: 'manual', background_safe: false}. Pinning the
  // test to the shipped manifest also fails closed if a future edit
  // ever relaxes Reddit's policy back to automatic without owner intent.
  const POLYFILL_MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, '..', 'packages', 'polyfill-connectors', 'manifests');
  const redditManifest = JSON.parse(
    readFileSync(join(POLYFILL_MANIFESTS_DIR, 'reddit.json'), 'utf8'),
  );
  // Schedule rows and history are keyed by the canonical connector key. The
  // store-direct seeds below bypass the controller, so they must use the
  // canonical key themselves to match what listSchedules/getSchedule read.
  // See canonicalize-connector-keys.
  const canonicalRedditId = canonicalConnectorKey(redditManifest.connector_id);
  const ownerPassword = 'scheduler-doctor-reddit-gate-pw';

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
      body: JSON.stringify(redditManifest),
    });
    assert.equal(registerResp.status, 201);

    // Insert a persisted enabled schedule row directly through the
    // store, bypassing the controller's eligibility check. This is the
    // exact shape of a row that was enabled before the manifest gate
    // landed.
    const store = getDefaultSchedulerStore();
    const now = new Date().toISOString();
    await Promise.resolve(
      store.createSchedule({
        connector_id: canonicalRedditId,
        interval_seconds: 1800,
        jitter_seconds: 0,
        enabled: true,
        created_at: now,
        updated_at: now,
      }),
    );

    // Persist a history shape matching the task brief: prior `not_ready`
    // skips and a terminal `schedule.gave_up` event. The most recent row
    // is a `skipped` with the gave_up payload — exactly what the brief
    // describes ("historical schedule.gave_up from 12 terminal failures",
    // "not_ready: required browser runtime is not configured...").
    const olderFailedStartedAt = new Date(Date.now() - 600_000).toISOString();
    const olderFailedCompletedAt = new Date(Date.now() - 540_000).toISOString();
    const skipCompletedAt = new Date(Date.now() - 60_000).toISOString();
    await Promise.resolve(
      store.appendRunHistory({
        connectorId: canonicalRedditId,
        source: { kind: 'connector', id: canonicalRedditId },
        status: 'failed',
        recordsEmitted: 0,
        reportedRecordsEmitted: 0,
        checkpointSummary: null,
        knownGaps: [],
        connectorError: null,
        runId: 'run_test_reddit_failed',
        traceId: 'trace_test_reddit_failed',
        failureReason: 'browser_runtime_not_configured',
        terminalReason: 'browser_runtime_not_configured',
        startedAt: olderFailedStartedAt,
        completedAt: olderFailedCompletedAt,
        attempt: 12,
      }),
    );
    await Promise.resolve(
      store.appendRunHistory({
        connectorId: canonicalRedditId,
        source: { kind: 'connector', id: canonicalRedditId },
        status: 'skipped',
        recordsEmitted: 0,
        reportedRecordsEmitted: null,
        checkpointSummary: null,
        knownGaps: [],
        connectorError: null,
        runId: null,
        traceId: null,
        failureReason: null,
        terminalReason: null,
        error: 'schedule.gave_up: {"reason_class":"not_ready","final_consecutive_failures":12,"last_success_at":null}',
        startedAt: skipCompletedAt,
        completedAt: skipCompletedAt,
        attempt: 0,
      }),
    );
    await Promise.resolve(
      store.upsertLastRunTime(
        canonicalRedditId,
        Date.parse(skipCompletedAt),
        new Date().toISOString(),
      ),
    );

    const schedules = await server.controller.listSchedules();
    assert.equal(schedules.length, 1, 'reddit schedule row is listed');
    const reddit = schedules[0];

    assert.equal(reddit.connector_id, canonicalRedditId);
    assert.equal(reddit.enabled, true, 'persisted operator intent is preserved');
    assert.match(
      reddit.ineligibility_reason ?? '',
      /background-safe|manual/,
      'gated by manifest refresh_policy',
    );

    // The core repair: under a manifest gate, the row is administratively
    // benched. The stale `schedule.gave_up` / `not_ready` error code from
    // the prior automatic regime must not continue to advertise itself
    // as the current failure mode.
    assert.equal(
      reddit.last_error_code,
      null,
      'gated row does not surface stale historical error code as current state',
    );
    assert.equal(
      reddit.next_due_at,
      null,
      'gated row will not fire automatically; next_due_at is fiction',
    );

    // Historical anchors stay truthful — they describe events that
    // really happened, regardless of whether the row can fire again.
    assert.equal(reddit.last_finished_at, skipCompletedAt);
    assert.equal(
      reddit.last_started_at,
      olderFailedStartedAt,
      'last terminal run that actually started is preserved',
    );
    assert.equal(reddit.last_successful_at, null);

    // Single-row read must agree.
    const single = await server.controller.getSchedule(canonicalRedditId);
    assert.ok(single);
    assert.equal(single.last_error_code, null);
    assert.equal(single.next_due_at, null);
    assert.match(single.ineligibility_reason ?? '', /background-safe|manual/);

    // End-to-end doctor probe: GATE, not FIRE; would_fire=false; no
    // stale last_error_code leaks through the JSON surface either.
    const { code, stdout, stderr } = await runProbe(asUrl, { PDPP_OWNER_PASSWORD: ownerPassword });
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary.total, 1);
    assert.equal(summary.enabled, 1);
    assert.equal(summary.ineligible, 1, 'reddit is enabled-but-ineligible');
    assert.equal(summary.automatic, 0, 'gated row does not fire');
    assert.equal(summary.never_ran, 0, 'reddit has run history');
    const probedReddit = summary.schedules[0];
    assert.equal(probedReddit.would_fire, false);
    assert.equal(probedReddit.last_error_code, null);
    assert.equal(probedReddit.next_due_at, null);
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await new Promise((resolve) => server.asServer.close(resolve));
    await new Promise((resolve) => server.rsServer.close(resolve));
    closeDb();
  }
});

test('controller.listSchedules projects last failure code from history when no active run', async () => {
  // Companion to the success-projection test: a connector whose latest
  // history row is `failed` must surface `last_error_code` from the
  // persisted `terminal_reason` (preferred) or `failure_reason` fallback.
  // Combined with `last_finished_at`, the dashboard and the doctor can
  // both render an actionable "ran but failed N minutes ago" state.
  const { startServer } = await import('../server/index.js');
  const { getDefaultSchedulerStore } = await import('../server/stores/scheduler-store.ts');
  const { closeDb } = await import('../server/db.js');
  const { readFileSync } = await import('node:fs');
  const REFERENCE_IMPL_DIR = join(__dirname, '..');
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  // Store-direct history seeds must use the canonical connector key — the
  // controller projects history under it. See canonicalize-connector-keys.
  const canonicalSpotifyId = canonicalConnectorKey(spotifyManifest.connector_id);
  const ownerPassword = 'scheduler-doctor-test-pw-3';

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

    const store = getDefaultSchedulerStore();
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const completedAt = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 2; i++) {
      const olderStartedAt = new Date(Date.now() - (420_000 - i * 120_000)).toISOString();
      const olderCompletedAt = new Date(Date.now() - (360_000 - i * 120_000)).toISOString();
      await Promise.resolve(
        store.appendRunHistory({
          connectorId: canonicalSpotifyId,
          source: { kind: 'connector', id: canonicalSpotifyId },
          status: 'failed',
          recordsEmitted: 0,
          reportedRecordsEmitted: 0,
          checkpointSummary: null,
          knownGaps: [],
          connectorError: { code: 'spotify_oauth_expired', message: 'access token expired' },
          runId: `run_test_history_failed_${i}`,
          traceId: `trace_test_history_failed_${i}`,
          failureReason: 'auth_failed',
          terminalReason: 'auth_failed_terminal',
          startedAt: olderStartedAt,
          completedAt: olderCompletedAt,
          attempt: i + 1,
        }),
      );
    }
    await Promise.resolve(
      store.appendRunHistory({
        connectorId: canonicalSpotifyId,
        source: { kind: 'connector', id: canonicalSpotifyId },
        status: 'failed',
        recordsEmitted: 0,
        reportedRecordsEmitted: 0,
        checkpointSummary: null,
        knownGaps: [],
        connectorError: { code: 'spotify_oauth_expired', message: 'access token expired' },
        runId: 'run_test_history_failed',
        traceId: 'trace_test_history_failed',
        failureReason: 'auth_failed',
        terminalReason: 'auth_failed_terminal',
        startedAt,
        completedAt,
        attempt: 3,
      }),
    );
    await Promise.resolve(
      store.upsertLastRunTime(
        canonicalSpotifyId,
        Date.parse(completedAt),
        new Date().toISOString(),
      ),
    );

    const schedules = await server.controller.listSchedules();
    const spotify = schedules[0];
    assert.equal(spotify.last_started_at, startedAt);
    assert.equal(spotify.last_finished_at, completedAt);
    assert.equal(spotify.last_successful_at, null, 'no successful run on record');
    assert.equal(
      spotify.last_error_code,
      'auth_failed_terminal',
      'terminal_reason takes precedence over failure_reason',
    );
    assert.ok(spotify.scheduler_backoff, 'scheduler backoff projection is present after durable failures');
    assert.equal(spotify.scheduler_backoff.backoff_applied, true);
    assert.equal(spotify.scheduler_backoff.consecutive_failures, 3);
    assert.equal(spotify.scheduler_backoff.reason_class, 'terminal:auth_failed_terminal');
    assert.equal(spotify.scheduler_backoff.recommended_health_state, 'cooling_off');
    assert.equal(
      spotify.scheduler_backoff.next_run_at,
      new Date(Date.parse(completedAt) + 3600_000).toISOString(),
    );
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await new Promise((resolve) => server.asServer.close(resolve));
    await new Promise((resolve) => server.rsServer.close(resolve));
    closeDb();
  }
});

test('controller.listSchedules does not expose raw scheduler error messages as error codes', async () => {
  const { startServer } = await import('../server/index.js');
  const { getDefaultSchedulerStore } = await import('../server/stores/scheduler-store.ts');
  const { closeDb } = await import('../server/db.js');
  const { readFileSync } = await import('node:fs');
  const REFERENCE_IMPL_DIR = join(__dirname, '..');
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  // Store-direct history seeds must use the canonical connector key — the
  // controller projects history under it. See canonicalize-connector-keys.
  const canonicalSpotifyId = canonicalConnectorKey(spotifyManifest.connector_id);
  const ownerPassword = 'scheduler-doctor-redaction-pw';
  const secret = 'secret-token-should-not-leak';

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

    const completedAt = new Date(Date.now() - 60_000).toISOString();
    await Promise.resolve(
      getDefaultSchedulerStore().appendRunHistory({
        connectorId: canonicalSpotifyId,
        source: { kind: 'connector', id: canonicalSpotifyId },
        status: 'failed',
        recordsEmitted: 0,
        reportedRecordsEmitted: 0,
        checkpointSummary: null,
        knownGaps: [],
        connectorError: null,
        runId: 'run_test_history_raw_error',
        traceId: 'trace_test_history_raw_error',
        failureReason: null,
        terminalReason: null,
        error: `network failed with ${secret}`,
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        completedAt,
        attempt: 1,
      }),
    );
    await Promise.resolve(
      getDefaultSchedulerStore().upsertLastRunTime(
        canonicalSpotifyId,
        Date.parse(completedAt),
        new Date().toISOString(),
      ),
    );

    const schedules = await server.controller.listSchedules();
    assert.equal(schedules[0].last_error_code, 'scheduler_error');
    assert.doesNotMatch(JSON.stringify(schedules), new RegExp(secret));

    const { code, stdout, stderr } = await runProbe(asUrl, { PDPP_OWNER_PASSWORD: ownerPassword });
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    assert.doesNotMatch(stdout, new RegExp(secret));
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await new Promise((resolve) => server.asServer.close(resolve));
    await new Promise((resolve) => server.rsServer.close(resolve));
    closeDb();
  }
});
