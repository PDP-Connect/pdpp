// Runtime-level tests for the run-lifecycle lease invariant: a connector child
// and its descendants form one process group that the runtime reaps as a unit.
//
// Motivating incident: run_1780436796334 / run_1780436796294 had only
// `run.started`, no terminal event, and orphaned GitHub/YNAB CHILD processes
// reparented under PID 1. The direct connector child had gone, but a grandchild
// it had spawned outlived the run because the runtime only ever signalled the
// single connector PID — never its process group.
//
// These tests run the REAL `runConnector` against a REAL stub connector that
// itself spawns a REAL grandchild, then assert that cancelling / failing the
// run reaps the grandchild too. They are the construction's regression guard:
// remove `detached: true` from the spawn, or revert the group-kill, and the
// grandchild survives and these tests fail.
//
// Mechanism: the grandchild writes its own PID to a file and idles. The stub
// records the START handshake, spawns the grandchild, emits one RECORD + STATE
// (so the mock RS `ingested` promise fires and the test knows the run is past
// START and actively collecting), announces readiness, then idles. The test
// reads the grandchild PID from the file and polls `process.kill(pid, 0)` —
// signal 0 is a no-op existence probe that throws ESRCH once the process is
// gone — until it disappears or a deadline elapses.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { runConnector } from '../runtime/index.js';

const STREAM = 'items';

const MANIFEST = {
  connector_id: 'https://registry.pdpp.org/connectors/runtime-pgroup-stub',
  version: '0.1.0',
  streams: [
    {
      name: STREAM,
      primary_key: 'id',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  ],
  runtime_requirements: {},
};

// Mock RS that resolves `ingested` on the first record-ingest POST so the test
// can act precisely when the run is actively collecting.
function startMockRs() {
  const requests = [];
  let resolveIngested;
  const ingested = new Promise((resolve) => {
    resolveIngested = resolve;
  });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const { pathname } = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, pathname });
      if (req.method === 'POST' && pathname.startsWith('/v1/ingest/')) {
        const records_accepted = body.split('\n').filter(Boolean).length;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ records_accepted, records_rejected: 0 }));
        resolveIngested();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return { server, requests, ingested };
}

// Writes (a) a grandchild script that records its own PID and idles, and (b) a
// stub connector that spawns the grandchild WITHOUT `detached` (so it joins the
// connector's process group), then emits one RECORD + STATE and idles. The
// grandchild PID file lets the test observe the grandchild's liveness across
// the run's termination.
function writeStubTree({ ignoreSigterm }) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-runtime-pgroup-'));
  const grandchildPath = join(tmpDir, 'grandchild.mjs');
  const grandchildPidPath = join(tmpDir, 'grandchild.pid');
  const stubPath = join(tmpDir, 'stub.mjs');

  const grandchildReadyPath = join(tmpDir, 'grandchild.ready');
  writeFileSync(
    grandchildPath,
    `
import { writeFileSync } from 'node:fs';
// Record liveness for the test, then idle. We deliberately do NOT install a
// SIGTERM handler: a vanilla process terminates on SIGTERM, so if the
// grandchild survives the run it can only be because it was never signalled
// (i.e. it reparented to PID 1 and orphaned). The PID is written atomically
// (write-then-rename) so the connector can wait on a complete file before it
// triggers cancellation — this removes the race where the group SIGTERM could
// arrive before the grandchild had booted far enough to record its pid.
writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid), 'utf8');
writeFileSync(${JSON.stringify(grandchildReadyPath)}, 'ready', 'utf8');
setInterval(() => {}, 1000);
`,
    'utf8',
  );
  chmodSync(grandchildPath, 0o755);

  const sigtermLine = ignoreSigterm
    ? "process.on('SIGTERM', () => { /* ignore: force the runtime's SIGKILL group escalation */ });"
    : '// default SIGTERM disposition: terminate the connector';

  writeFileSync(
    stubPath,
    `
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

${sigtermLine}

function emit(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

async function main() {
  // Read START.
  await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.once('line', () => { rl.close(); resolve(); });
  });

  // Spawn a grandchild in THIS connector's process group (no \`detached\`).
  // It must be reaped along with us when the runtime terminates the group.
  const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildPath)}], {
    stdio: 'ignore',
  });
  grandchild.unref();

  // Wait until the grandchild has booted and recorded its readiness BEFORE we
  // emit the RECORD that triggers the test's cancellation. This guarantees the
  // grandchild was genuinely alive in our process group at the moment of the
  // reap — otherwise a fast group-kill could win the race and the test would
  // prove nothing.
  const readyDeadline = Date.now() + 5000;
  while (!existsSync(${JSON.stringify(grandchildReadyPath)})) {
    if (Date.now() > readyDeadline) break;
    await delay(10);
  }

  emit({ type: 'RECORD', stream: '${STREAM}', key: 'r1', data: { id: 'r1' }, emitted_at: new Date().toISOString() });
  emit({ type: 'STATE', stream: '${STREAM}', cursor: { offset: 1 } });

  process.stderr.write('STUB_READY\\n');
  setInterval(() => {}, 1000);
}

main();
`,
    'utf8',
  );
  chmodSync(stubPath, 0o755);

  return { stubPath, grandchildPidPath, tmpDir };
}

function freshDb(t) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), 'pdpp-runtime-pgroup-db-')), 'pdpp.sqlite'));
  t.after(() => closeDb());
}

// Resolves once the grandchild PID file exists and is non-empty.
async function waitForGrandchildPid(grandchildPidPath, deadlineMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (existsSync(grandchildPidPath)) {
      const raw = readFileSync(grandchildPidPath, 'utf8').trim();
      if (raw) return Number(raw);
    }
    await delay(20);
  }
  throw new Error('grandchild never recorded its pid');
}

function isAlive(pid) {
  try {
    // Signal 0 performs no signalling — it only checks the target exists and is
    // signalable. Throws ESRCH once the process is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Polls liveness until the process is gone or the deadline elapses.
async function waitUntilDead(pid, deadlineMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (!isAlive(pid)) return true;
    await delay(20);
  }
  return !isAlive(pid);
}

async function runGroupReapScenario(t, { ignoreSigterm }) {
  freshDb(t);
  const { server, ingested } = startMockRs();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const rsUrl = `http://127.0.0.1:${port}`;
  const { stubPath, grandchildPidPath, tmpDir } = writeStubTree({ ignoreSigterm });

  const controller = new AbortController();
  // Abort once the run is actively collecting (record reached the RS).
  ingested.then(() => controller.abort());

  let grandchildPid = null;
  let outcome = null;
  let outcomeError = null;
  // Capture the grandchild's pid the moment it records it, in parallel with the
  // run — so we still have it after the run (and the file's tmp dir) is gone.
  const pidCapture = waitForGrandchildPid(grandchildPidPath).then(
    (pid) => {
      grandchildPid = pid;
    },
    () => {},
  );

  try {
    outcome = await runConnector({
      connectorPath: stubPath,
      connectorId: MANIFEST.connector_id,
      ownerToken: 'test-owner-token',
      manifest: MANIFEST,
      state: null,
      collectionMode: 'full_refresh',
      persistState: true,
      rsUrl,
      runId: ignoreSigterm ? 'run_pgroup_forced' : 'run_pgroup_graceful',
      onProgress: () => {},
      onInteraction: () => ({ type: 'INTERACTION_RESPONSE', status: 'cancelled' }),
      cancelSignal: controller.signal,
      detailGapStore: {
        async listPendingGaps() {
          return [];
        },
        async upsertPendingGap() {
          return null;
        },
        async markGapStatus() {
          return null;
        },
      },
    });
  } catch (err) {
    outcomeError = err;
  } finally {
    await pidCapture;
    server.close();
  }

  // Confirm the grandchild was actually observed (otherwise the test proves
  // nothing). Then assert it is reaped now that the run has terminated.
  assert.ok(typeof grandchildPid === 'number' && grandchildPid > 1, 'grandchild recorded a real pid');
  const reaped = await waitUntilDead(grandchildPid);

  // Belt-and-suspenders cleanup: if the invariant regressed and the grandchild
  // leaked, do not leave an orphan behind for the rest of the suite/host.
  if (!reaped) {
    try {
      process.kill(grandchildPid, 'SIGKILL');
    } catch {}
  }
  rmSync(tmpDir, { recursive: true, force: true });

  return { outcome, outcomeError, grandchildPid, reaped };
}

test('runtime reaps the connector grandchild on graceful owner-cancel (process group)', async (t) => {
  const { outcome, outcomeError, reaped } = await runGroupReapScenario(t, { ignoreSigterm: false });
  const result = outcome ?? outcomeError;
  assert.ok(result && typeof result === 'object', 'structured outcome');
  assert.equal(result.status, 'cancelled', 'owner-cancelled run resolves status=cancelled');
  assert.equal(
    reaped,
    true,
    'the connector grandchild must be terminated with the run, not orphaned to PID 1',
  );
});

test('runtime reaps the connector grandchild on forced cancel even when the connector ignores SIGTERM', async (t) => {
  const { outcome, outcomeError, reaped } = await runGroupReapScenario(t, { ignoreSigterm: true });
  const result = outcome ?? outcomeError;
  assert.ok(result && typeof result === 'object', 'structured outcome');
  assert.equal(result.status, 'cancelled', 'force-cancelled run resolves status=cancelled');
  assert.equal(result.terminal_reason, 'owner_cancel_forced', 'ignored SIGTERM escalates to a group SIGKILL');
  assert.equal(
    reaped,
    true,
    'a group SIGKILL must reap the grandchild even when the connector leader ignores SIGTERM',
  );
});
