/**
 * Scheduled-path static-secret injection regression suite.
 *
 * Incident (2026-06-09): four connections were migrated env→store, but the
 * scheduler launched connector children via `runConnector` WITHOUT consulting
 * the encrypted credential store — only `controller.runNow` (the manual path)
 * resolved `staticSecretEnv`. When the container was recreated with the
 * credential env vars as EMPTY STRINGS (compose `${VAR:-}` mappings), every
 * scheduled static-secret run raised `credentials_required`
 * ("github needs: GITHUB_P...") and auto-cancelled, while the store rows sat
 * unread.
 *
 * These tests pin the fixed contract:
 *   1. With NO usable credential env vars (absent or empty-string), a store
 *      row satisfies a scheduled run for every static-secret registry
 *      connector (chatgpt / github / gmail / ynab / slack) — the child receives the
 *      store-recovered values, and empty-string process env NEVER shadows
 *      them, including browser-backed username/password connectors.
 *   2. A connection with a store row never raises `credentials_required` on
 *      the scheduled path (and the control case proves the simulation is
 *      honest: without the resolver the same child DOES raise it).
 *   3. A missing/revoked source-scoped credential fails closed: the launch is
 *      refused, no connector child is spawned, and the failure is recorded —
 *      never a fallback to a stale or process-global secret.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { closeDb } from '../server/db.js';
import { runConnector } from '../runtime/index.js';
import { createScheduler } from '../runtime/scheduler.ts';
import {
  buildConnectionScopedSecretEnv,
  STATIC_SECRET_CONNECTOR_REGISTRY,
} from '../../packages/polyfill-connectors/src/static-secret-injection.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BACKGROUND_SAFE_MANIFEST = {
  capabilities: {
    refresh_policy: { recommended_mode: 'automatic', background_safe: true },
  },
  streams: [{ name: 'items' }],
};

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 2000);
    srv.close(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { status: resp.status, body };
}

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  assert.equal(approveResp.status, 200);
  const { body: token } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: device.device_code,
    }).toString(),
  });
  return token.access_token;
}

async function waitFor(condition, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for scheduler run to complete');
}

/**
 * Connector child that snapshots the named env vars it actually received and
 * succeeds. The snapshot file is the test's proof of exactly what crossed the
 * spawn boundary.
 */
function writeEnvSnapshotConnector(tmpDir, name, envVarNames) {
  const snapshotPath = join(tmpDir, `${name}-env.json`);
  const connectorPath = join(tmpDir, `${name}-connector.mjs`);
  writeFileSync(connectorPath, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const names = ${JSON.stringify(envVarNames)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  const seen = {};
  for (const name of names) {
    seen[name] = process.env[name] ?? null;
  }
  writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify(seen), 'utf8');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');
  return { connectorPath, snapshotPath };
}

/**
 * Connector child that mimics `packages/polyfill-connectors/src/auth.ts`:
 * empty-string env counts as MISSING; when no alias is satisfied it raises a
 * `credentials` interaction (the exact failure mode of the incident) and
 * fails when the response is not a success.
 */
function writeCredentialsRequiredConnector(tmpDir, name, envAliases) {
  const connectorPath = join(tmpDir, `${name}-auth-connector.mjs`);
  writeFileSync(connectorPath, `
import { createInterface } from 'node:readline';

const aliases = ${JSON.stringify(envAliases)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let interactionPending = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const satisfied = aliases.some((aliasName) => Boolean(process.env[aliasName]));
    if (satisfied) {
      process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
      process.exit(0);
    }
    interactionPending = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'req_creds_1',
      kind: 'credentials',
      message: '${name} needs: ' + aliases[0] + '. Set in .env.local for persistence.',
      timeout_seconds: 30,
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE' && interactionPending) {
    interactionPending = false;
    process.stdout.write(JSON.stringify({
      type: 'DONE',
      status: 'failed',
      records_emitted: 0,
      error: { message: '${name}_credentials_missing', retryable: false },
    }) + '\\n');
    process.exit(0);
  }
});
`, 'utf8');
  return { connectorPath };
}

/** Set every named env var to the empty string; returns a restore fn. */
function withEmptyStringEnv(names) {
  const previous = new Map();
  for (const name of names) {
    previous.set(name, process.env[name]);
    process.env[name] = '';
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

/**
 * Per-connector fixture: a fake recovered store credential plus the env vars
 * the child must end up seeing. Uses the REAL injection registry + builder so
 * the test fails if the registry mapping drifts.
 */
const STORE_FIXTURES = {
  amazon: {
    recovered: {
      credentialKind: 'username_password',
      secret: JSON.stringify({
        password: 'stored-amazon-password',
        username: 'owner@example.com',
      }),
    },
    sourceBinding: null,
    expectedEnv: {
      AMAZON_PASSWORD: 'stored-amazon-password',
      AMAZON_USERNAME: 'owner@example.com',
    },
  },
  chase: {
    recovered: {
      credentialKind: 'username_password',
      secret: JSON.stringify({
        password: 'stored-chase-password',
        username: 'owner@example.com',
      }),
    },
    sourceBinding: null,
    expectedEnv: {
      CHASE_PASSWORD: 'stored-chase-password',
      CHASE_USERNAME: 'owner@example.com',
    },
  },
  chatgpt: {
    recovered: {
      credentialKind: 'username_password',
      secret: JSON.stringify({
        password: 'stored-chatgpt-password',
        username: 'owner@example.com',
      }),
    },
    sourceBinding: null,
    expectedEnv: {
      CHATGPT_PASSWORD: 'stored-chatgpt-password',
      CHATGPT_USERNAME: 'owner@example.com',
    },
  },
  github: {
    recovered: { credentialKind: 'personal_access_token', secret: 'stored-github-pat' },
    sourceBinding: null,
    expectedEnv: {
      GITHUB_PERSONAL_ACCESS_TOKEN: 'stored-github-pat',
      GITHUB_TOKEN: 'stored-github-pat',
    },
  },
  gmail: {
    recovered: { credentialKind: 'app_password', secret: 'stored-gmail-app-password' },
    sourceBinding: { setup_fields: { account_email: 'owner@example.com' } },
    expectedEnv: {
      GOOGLE_APP_PASSWORD_PDPP: 'stored-gmail-app-password',
      GMAIL_APP_PASSWORD: 'stored-gmail-app-password',
      GMAIL_ADDRESS: 'owner@example.com',
      GMAIL_USER: 'owner@example.com',
    },
  },
  ynab: {
    recovered: { credentialKind: 'personal_access_token', secret: 'stored-ynab-pat' },
    sourceBinding: null,
    expectedEnv: {
      YNAB_PERSONAL_ACCESS_TOKEN: 'stored-ynab-pat',
      YNAB_PAT: 'stored-ynab-pat',
    },
  },
  slack: {
    recovered: {
      credentialKind: 'secret_bundle',
      secret: JSON.stringify({
        slack_workspace: 'stored-workspace',
        slack_token: 'xoxc-stored-token',
        slack_cookie: 'xoxd-stored-cookie',
      }),
    },
    sourceBinding: null,
    expectedEnv: {
      SLACK_WORKSPACE: 'stored-workspace',
      SLACK_TOKEN: 'xoxc-stored-token',
      SLACK_COOKIE: 'xoxd-stored-cookie',
    },
  },
  reddit: {
    recovered: {
      credentialKind: 'username_password',
      secret: JSON.stringify({
        password: 'stored-reddit-password',
        username: 'dondochaka',
      }),
    },
    sourceBinding: null,
    expectedEnv: {
      REDDIT_PASSWORD: 'stored-reddit-password',
      REDDIT_USERNAME: 'dondochaka',
    },
  },
  usaa: {
    recovered: {
      credentialKind: 'username_password',
      secret: JSON.stringify({
        password: 'stored-usaa-password',
        username: 'owner@example.com',
      }),
    },
    sourceBinding: null,
    expectedEnv: {
      USAA_PASSWORD: 'stored-usaa-password',
      USAA_USERNAME: 'owner@example.com',
    },
  },
};

test('scheduled runs inject store credentials env-absent for every static-secret registry connector', async () => {
  for (const connectorId of Object.keys(STORE_FIXTURES)) {
    assert.ok(
      STATIC_SECRET_CONNECTOR_REGISTRY[connectorId],
      `fixture connector '${connectorId}' must exist in the injection registry`,
    );
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-sched-static-secret-'));
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_static_secret_user');

    for (const [connectorId, fixture] of Object.entries(STORE_FIXTURES)) {
      const connectorInstanceId = `cin_${connectorId}_test`;
      const envVarNames = [
        ...Object.keys(fixture.expectedEnv),
        'PDPP_RUN_AUTOMATION_MODE',
        'PDPP_RUN_TRIGGER_KIND',
      ];
      const { connectorPath, snapshotPath } = writeEnvSnapshotConnector(tmpDir, connectorId, envVarNames);
      const completedRuns = [];
      const interactions = [];
      const resolverCalls = [];

      const scheduler = createScheduler({
        connectors: [{
          connectorId,
          connectorInstanceId,
          connectorPath,
          manifest: BACKGROUND_SAFE_MANIFEST,
          intervalMs: 60_000,
          ownerToken,
        }],
        rsUrl,
        onInteraction: async (interaction) => {
          interactions.push(interaction);
          return { type: 'INTERACTION_RESPONSE', request_id: interaction.request_id, status: 'cancelled' };
        },
        onRunComplete: (record) => completedRuns.push(record),
        // The seam under test: resolve from a fake store row through the REAL
        // registry mapping, exactly like the server-side resolver does.
        resolveStaticSecretRunEnv: async (args) => {
          resolverCalls.push(args);
          return buildConnectionScopedSecretEnv(connectorId, fixture.recovered, fixture.sourceBinding);
        },
      });

      // Empty-string env vars simulate the recreated container's compose
      // `${VAR:-}` mappings — the incident posture. The store value MUST win.
      const restoreEnv = withEmptyStringEnv(envVarNames);
      try {
        scheduler.start();
        await waitFor(() => completedRuns.length === 1);
        scheduler.stop();
      } finally {
        restoreEnv();
      }

      const [record] = completedRuns;
      assert.equal(record.status, 'succeeded', `${connectorId}: scheduled run must succeed from the store row`);
      assert.deepEqual(interactions, [], `${connectorId}: no credentials_required interaction may surface`);
      assert.deepEqual(resolverCalls, [{ connectorId, connectorInstanceId }]);

      const childEnv = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      assert.deepEqual(
        childEnv,
        {
          ...fixture.expectedEnv,
          PDPP_RUN_AUTOMATION_MODE: 'unattended',
          PDPP_RUN_TRIGGER_KIND: 'scheduled',
        },
        `${connectorId}: child env must carry the store-recovered values (empty-string process env must not shadow them)`,
      );
    }
  } finally {
    await closeServer(server);
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('manual run forwards bounded trigger and automation metadata to connector children', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-run-metadata-'));
  const { connectorPath, snapshotPath } = writeEnvSnapshotConnector(tmpDir, 'manual-run', [
    'PDPP_RUN_AUTOMATION_MODE',
    'PDPP_RUN_TRIGGER_KIND',
  ]);

  try {
    const result = await runConnector({
      automationMode: 'assisted',
      connectorId: 'metadata-test',
      connectorPath,
      detailGapStore: {
        async listPendingGaps() { return []; },
        async reclaimStrandedInProgressGaps() {},
        async resetServedInProgressGaps() {},
        async upsertPendingGap() { return null; },
      },
      manifest: BACKGROUND_SAFE_MANIFEST,
      ownerToken: 'owner-token',
      rsUrl: 'http://localhost.invalid',
      triggerKind: 'manual',
    });

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(JSON.parse(readFileSync(snapshotPath, 'utf8')), {
      PDPP_RUN_AUTOMATION_MODE: 'assisted',
      PDPP_RUN_TRIGGER_KIND: 'manual',
    });
  } finally {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a store row suppresses credentials_required on the scheduled path (and its absence reproduces the incident)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-sched-creds-required-'));
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const githubAliases = ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN'];

  try {
    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_creds_required_user');
    const { connectorPath } = writeCredentialsRequiredConnector(tmpDir, 'github', githubAliases);

    const runCase = async ({ resolver }) => {
      const completedRuns = [];
      const interactions = [];
      const scheduler = createScheduler({
        connectors: [{
          connectorId: 'github',
          connectorInstanceId: 'cin_github_test',
          connectorPath,
          manifest: BACKGROUND_SAFE_MANIFEST,
          intervalMs: 60_000,
          ownerToken,
        }],
        rsUrl,
        onInteraction: async (interaction) => {
          interactions.push(interaction);
          return { type: 'INTERACTION_RESPONSE', request_id: interaction.request_id, status: 'cancelled' };
        },
        onRunComplete: (record) => completedRuns.push(record),
        ...(resolver ? { resolveStaticSecretRunEnv: resolver } : {}),
      });

      const restoreEnv = withEmptyStringEnv(githubAliases);
      try {
        scheduler.start();
        await waitFor(() => completedRuns.length === 1);
        scheduler.stop();
      } finally {
        restoreEnv();
      }
      return { record: completedRuns[0], interactions };
    };

    // Control case — the incident shape: no store resolution, empty-string
    // env → the connector raises credentials_required and the run fails.
    // This proves the child honestly enforces the env requirement.
    const control = await runCase({ resolver: null });
    assert.equal(control.record.status, 'failed');
    assert.equal(control.interactions.length, 1);
    assert.equal(control.interactions[0].kind, 'credentials');
    assert.match(control.interactions[0].message, /github needs: GITHUB_PERSONAL_ACCESS_TOKEN/);

    // Fixed case: identical child + identical empty-string env, but the store
    // row resolves → no interaction, run succeeds.
    const fixed = await runCase({
      resolver: async () =>
        buildConnectionScopedSecretEnv('github', {
          credentialKind: 'personal_access_token',
          secret: 'stored-github-pat',
        }),
    });
    assert.equal(fixed.record.status, 'succeeded');
    assert.deepEqual(fixed.interactions, []);
  } finally {
    await closeServer(server);
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scheduled launch defers for owner repair when source-scoped credential is missing (no child spawned)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-sched-fail-closed-'));
  const { connectorPath, snapshotPath } = writeEnvSnapshotConnector(tmpDir, 'github', ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  const completedRuns = [];

  const scheduler = createScheduler({
    connectors: [{
      connectorId: 'github',
      connectorInstanceId: 'cin_github_missing',
      connectorPath,
      manifest: BACKGROUND_SAFE_MANIFEST,
      intervalMs: 60_000,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    onInteraction: async (interaction) => ({
      type: 'INTERACTION_RESPONSE',
      request_id: interaction.request_id,
      status: 'cancelled',
    }),
    onRunComplete: (record) => completedRuns.push(record),
    resolveStaticSecretRunEnv: async () => {
      const err = new Error("No static-secret credential is stored for connection 'cin_github_missing'.");
      err.code = 'credential_not_found';
      throw err;
    },
  });

  try {
    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 5000);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'skipped');
    assert.equal(record.failureReason, undefined);
    assert.match(record.error, /^needs_human_attention: credential_not_found:/);
    assert.match(record.error, /credential is stored/);
    // The connector child must never have been spawned.
    assert.throws(() => readFileSync(snapshotPath, 'utf8'), /ENOENT/);
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
