const TOP_LEVEL_REGEX_1 = /github needs: GITHUB_PERSONAL_ACCESS_TOKEN/;
const TOP_LEVEL_REGEX_2 = /^needs_human_attention: credential_not_found:/;
const TOP_LEVEL_REGEX_3 = /credential is stored/;
const TOP_LEVEL_REGEX_4 = /ENOENT/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredBrowserChannel } from "../../packages/polyfill-connectors/src/browser-launch.ts";
import { resolveBrowserRuntimeVisibility } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { isRunningInContainer } from "../../packages/polyfill-connectors/src/runtime-environment.ts";
import {
  buildConnectionScopedSecretEnv,
  type RecoveredStaticSecret,
  STATIC_SECRET_CONNECTOR_REGISTRY,
} from "../../packages/polyfill-connectors/src/static-secret-injection.ts";
import { composeConnectorChildEnvironment } from "../runtime/connector-child-environment.ts";
import { runConnector } from "../runtime/index.ts";
import { createScheduler } from "../runtime/scheduler.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const BACKGROUND_SAFE_MANIFEST = {
  capabilities: {
    refresh_policy: { background_safe: true, recommended_mode: "automatic" },
  },
  streams: [{ name: "items" }],
};

function composePlatformEnvironment(sourceEnv: NodeJS.ProcessEnv): Record<string, string> {
  return composeConnectorChildEnvironment({
    explicitRunEnv: {},
    manifest: {},
    platform: "win32",
    sourceEnv,
  });
}

interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  schedulerManager?: { stop?: () => void };
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeWithTimeout = (srv: { close: (cb: () => void) => void }) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);
      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = deviceBody as { user_code: string; device_code: string };
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const token = tokenBody as { access_token: string };
  return token.access_token;
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for scheduler run to complete");
}

/**
 * Connector child that snapshots the named env vars it actually received and
 * succeeds. The snapshot file is the test's proof of exactly what crossed the
 * spawn boundary.
 */
function writeEnvSnapshotConnector(
  tmpDir: string,
  name: string,
  envVarNames: string[]
): { connectorPath: string; snapshotPath: string } {
  const snapshotPath = join(tmpDir, `${name}-env.json`);
  const connectorPath = join(tmpDir, `${name}-connector.mjs`);
  writeFileSync(
    connectorPath,
    `
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
`,
    "utf8"
  );
  return { connectorPath, snapshotPath };
}

test("connector platform env keeps cross-host execution inputs without ambient secrets", () => {
  assert.deepEqual(
    composePlatformEnvironment({
      APPDATA: "C:\\Users\\pdpp\\AppData\\Roaming",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      HOME: "/home/pdpp",
      HTTPS_PROXY: "http://proxy.internal:8080",
      LOCALAPPDATA: "C:\\Users\\pdpp\\AppData\\Local",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      Path: "C:\\PDPP\\bin;C:\\Windows\\System32",
      PDPP_BROWSER_CHANNEL: "chrome",
      PDPP_BROWSER_HEADLESS: "1",
      PDPP_CAPTURE_ARIA_DEPTH: "12",
      PDPP_CAPTURE_FIXTURES: "1",
      PDPP_CAPTURE_ON_FAILURE: "1",
      PDPP_CAPTURE_ROOT_DIR: "/captures",
      PDPP_FORCE_CONTAINER: "1",
      PDPP_OWNER_PASSWORD: "must-not-cross",
      PDPP_REFERENCE_ORIGIN: "https://reference.example",
      PDPP_SESSION_ESTABLISH_WATCHDOG_MS: "45000",
      PDPP_TRACE: "1",
      PDPP_WEB_BASE_URL: "https://console.example",
      SystemRoot: "C:\\Windows",
      TMPDIR: "/tmp/pdpp",
      USERPROFILE: "C:\\Users\\pdpp",
    }),
    {
      APPDATA: "C:\\Users\\pdpp\\AppData\\Roaming",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      HOME: "/home/pdpp",
      HTTPS_PROXY: "http://proxy.internal:8080",
      LOCALAPPDATA: "C:\\Users\\pdpp\\AppData\\Local",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      Path: "C:\\PDPP\\bin;C:\\Windows\\System32",
      PDPP_BROWSER_CHANNEL: "chrome",
      PDPP_BROWSER_HEADLESS: "1",
      PDPP_CAPTURE_ARIA_DEPTH: "12",
      PDPP_CAPTURE_FIXTURES: "1",
      PDPP_CAPTURE_ON_FAILURE: "1",
      PDPP_CAPTURE_ROOT_DIR: "/captures",
      PDPP_FORCE_CONTAINER: "1",
      PDPP_REFERENCE_ORIGIN: "https://reference.example",
      PDPP_SESSION_ESTABLISH_WATCHDOG_MS: "45000",
      PDPP_TRACE: "1",
      PDPP_WEB_BASE_URL: "https://console.example",
      SystemRoot: "C:\\Windows",
      TMPDIR: "/tmp/pdpp",
      USERPROFILE: "C:\\Users\\pdpp",
    }
  );
  const childEnv = composePlatformEnvironment({
    PDPP_BROWSER_CHANNEL: "chrome",
    PDPP_BROWSER_HEADLESS: "1",
    PDPP_FORCE_CONTAINER: "1",
  });
  assert.equal(resolveBrowserRuntimeVisibility({}, "browser", childEnv).headless, true);
  assert.equal(configuredBrowserChannel(childEnv), "chrome");
  assert.equal(isRunningInContainer(childEnv, { fileExists: () => false }), true);
});

test("connector fragments reject platform and run controls in every casing", () => {
  for (const name of ["PATH", "PDPP_OWNER_TOKEN", "PDPP_RS_URL", "PDPP_CONNECTOR_ID"]) {
    for (const variant of [name, name.toLowerCase(), `${name.slice(0, 1)}${name.slice(1).toLowerCase()}`]) {
      const env = composeConnectorChildEnvironment({
        connectionEnv: { [variant]: "must-not-cross", CONNECTION_SECRET: "allowed" },
        explicitRunEnv: {},
        manifest: {},
        platform: "linux",
        sourceEnv: {},
      });
      assert.equal(env[variant], undefined);
      assert.equal(env.CONNECTION_SECRET, "allowed");
    }
  }
});

/**
 * Connector child that mimics `packages/polyfill-connectors/src/auth.ts`:
 * empty-string env counts as MISSING; when no alias is satisfied it raises a
 * `credentials` interaction (the exact failure mode of the incident) and
 * fails when the response is not a success.
 */
function writeCredentialsRequiredConnector(
  tmpDir: string,
  name: string,
  envAliases: string[]
): { connectorPath: string } {
  const connectorPath = join(tmpDir, `${name}-auth-connector.mjs`);
  writeFileSync(
    connectorPath,
    `
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
`,
    "utf8"
  );
  return { connectorPath };
}

/** Set every named env var to the empty string; returns a restore fn. */
function withEmptyStringEnv(names: string[]): () => void {
  const previous = new Map<string, string | undefined>();
  for (const name of names) {
    previous.set(name, process.env[name]);
    process.env[name] = "";
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
interface StoreFixture {
  expectedEnv: Record<string, string>;
  recovered: RecoveredStaticSecret;
  sourceBinding: unknown;
}

const STORE_FIXTURES: Record<string, StoreFixture> = {
  amazon: {
    expectedEnv: {
      AMAZON_PASSWORD: "stored-amazon-password",
      AMAZON_USERNAME: "owner@example.com",
    },
    recovered: {
      credentialKind: "username_password",
      secret: JSON.stringify({
        password: "stored-amazon-password",
        username: "owner@example.com",
      }),
    },
    sourceBinding: null,
  },
  chase: {
    expectedEnv: {
      CHASE_PASSWORD: "stored-chase-password",
      CHASE_USERNAME: "owner@example.com",
    },
    recovered: {
      credentialKind: "username_password",
      secret: JSON.stringify({
        password: "stored-chase-password",
        username: "owner@example.com",
      }),
    },
    sourceBinding: null,
  },
  chatgpt: {
    expectedEnv: {
      CHATGPT_PASSWORD: "stored-chatgpt-password",
      CHATGPT_USERNAME: "owner@example.com",
    },
    recovered: {
      credentialKind: "username_password",
      secret: JSON.stringify({
        password: "stored-chatgpt-password",
        username: "owner@example.com",
      }),
    },
    sourceBinding: null,
  },
  github: {
    expectedEnv: {
      GITHUB_PERSONAL_ACCESS_TOKEN: "stored-github-pat",
      GITHUB_TOKEN: "stored-github-pat",
    },
    recovered: { credentialKind: "personal_access_token", secret: "stored-github-pat" },
    sourceBinding: null,
  },
  gmail: {
    expectedEnv: {
      GMAIL_ADDRESS: "owner@example.com",
      GMAIL_APP_PASSWORD: "stored-gmail-app-password",
      GMAIL_USER: "owner@example.com",
      GOOGLE_APP_PASSWORD_PDPP: "stored-gmail-app-password",
    },
    recovered: { credentialKind: "app_password", secret: "stored-gmail-app-password" },
    sourceBinding: { setup_fields: { account_email: "owner@example.com" } },
  },
  reddit: {
    expectedEnv: {
      REDDIT_PASSWORD: "stored-reddit-password",
      REDDIT_USERNAME: "dondochaka",
    },
    recovered: {
      credentialKind: "username_password",
      secret: JSON.stringify({
        password: "stored-reddit-password",
        username: "dondochaka",
      }),
    },
    sourceBinding: null,
  },
  slack: {
    expectedEnv: {
      SLACK_COOKIE: "xoxd-stored-cookie",
      SLACK_TOKEN: "xoxc-stored-token",
      SLACK_WORKSPACE: "stored-workspace",
    },
    recovered: {
      credentialKind: "secret_bundle",
      secret: JSON.stringify({
        slack_cookie: "xoxd-stored-cookie",
        slack_token: "xoxc-stored-token",
        slack_workspace: "stored-workspace",
      }),
    },
    sourceBinding: null,
  },
  usaa: {
    expectedEnv: {
      USAA_PASSWORD: "stored-usaa-password",
      USAA_USERNAME: "owner@example.com",
    },
    recovered: {
      credentialKind: "username_password",
      secret: JSON.stringify({
        password: "stored-usaa-password",
        username: "owner@example.com",
      }),
    },
    sourceBinding: null,
  },
  ynab: {
    expectedEnv: {
      YNAB_PAT: "stored-ynab-pat",
      YNAB_PERSONAL_ACCESS_TOKEN: "stored-ynab-pat",
    },
    recovered: { credentialKind: "personal_access_token", secret: "stored-ynab-pat" },
    sourceBinding: null,
  },
};

interface EscalationInteraction {
  kind?: string;
  message?: string;
  request_id?: string;
}

test("scheduled runs inject store credentials env-absent for every static-secret registry connector", async () => {
  for (const connectorId of Object.keys(STORE_FIXTURES)) {
    assert.ok(
      STATIC_SECRET_CONNECTOR_REGISTRY[connectorId],
      `fixture connector '${connectorId}' must exist in the injection registry`
    );
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-sched-static-secret-"));
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const ownerToken = await issueOwnerToken(asUrl, "scheduler_static_secret_user");

    for (const [connectorId, fixture] of Object.entries(STORE_FIXTURES)) {
      const connectorInstanceId = `cin_${connectorId}_test`;
      const envVarNames = [...Object.keys(fixture.expectedEnv), "PDPP_RUN_AUTOMATION_MODE", "PDPP_RUN_TRIGGER_KIND"];
      const { connectorPath, snapshotPath } = writeEnvSnapshotConnector(tmpDir, connectorId, envVarNames);
      const completedRuns: RunRecord[] = [];
      const interactions: EscalationInteraction[] = [];
      const resolverCalls: { connectorId: string; connectorInstanceId: string }[] = [];

      const scheduler = createScheduler({
        admitRunConnection: (input) =>
          Promise.resolve({
            connectorId: input.connectorId,
            connectorInstanceId: input.connectorInstanceId ?? connectorInstanceId,
            ownerSubjectId: input.ownerSubjectId ?? "scheduler_static_secret_user",
          }),
        connectors: [
          {
            connectorId,
            connectorInstanceId,
            connectorPath,
            intervalMs: 60_000,
            manifest: BACKGROUND_SAFE_MANIFEST,
            ownerToken,
          },
        ],
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        onInteraction: async (...args: unknown[]) => {
          const interaction = args[0] as EscalationInteraction;
          interactions.push(interaction);
          return { request_id: interaction.request_id, status: "cancelled", type: "INTERACTION_RESPONSE" };
        },
        // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
        onRunComplete: (record) => completedRuns.push(record),
        // The seam under test: resolve from a fake store row through the REAL
        // registry mapping, exactly like the server-side resolver does.
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        resolveStaticSecretRunEnv: async (runArgs) => {
          resolverCalls.push(runArgs);
          return buildConnectionScopedSecretEnv(connectorId, fixture.recovered, fixture.sourceBinding);
        },
        rsUrl,
      });

      // Empty-string env vars simulate the recreated container's compose
      // `${VAR:-}` mappings — the incident posture. The store value MUST win.
      const restoreEnv = withEmptyStringEnv(envVarNames);
      try {
        scheduler.start();
        // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
        await waitFor(() => completedRuns.length === 1);
        scheduler.stop();
      } finally {
        restoreEnv();
      }

      const [record] = completedRuns;
      assert.ok(record, `${connectorId}: a completed run record was captured`);
      assert.equal(record.status, "succeeded", `${connectorId}: scheduled run must succeed from the store row`);
      assert.deepEqual(interactions, [], `${connectorId}: no credentials_required interaction may surface`);
      assert.deepEqual(resolverCalls, [{ connectorId, connectorInstanceId }]);

      const childEnv = JSON.parse(readFileSync(snapshotPath, "utf8"));
      assert.deepEqual(
        childEnv,
        {
          ...fixture.expectedEnv,
          PDPP_RUN_AUTOMATION_MODE: "unattended",
          PDPP_RUN_TRIGGER_KIND: "scheduled",
        },
        `${connectorId}: child env must carry the store-recovered values (empty-string process env must not shadow them)`
      );
    }
  } finally {
    await closeServer(server);
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("manual run forwards bounded trigger and automation metadata to connector children", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-run-metadata-"));
  const { connectorPath, snapshotPath } = writeEnvSnapshotConnector(tmpDir, "manual-run", [
    "PDPP_RUN_AUTOMATION_MODE",
    "PDPP_RUN_TRIGGER_KIND",
  ]);

  try {
    const result = await runConnector({
      admitRunConnection: (input) =>
        Promise.resolve({
          connectorId: input.connectorId,
          connectorInstanceId: input.connectorInstanceId ?? "cin_metadata_test",
          ownerSubjectId: input.ownerSubjectId ?? "owner_local",
        }),
      automationMode: "assisted",
      connectorId: "metadata-test",
      connectorPath,
      detailGapStore: {
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        async listPendingGaps() {
          return [];
        },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        async reclaimStrandedInProgressGaps() {},
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        async upsertPendingGap() {
          return null;
        },
      },
      manifest: BACKGROUND_SAFE_MANIFEST,
      ownerToken: "owner-token",
      rsUrl: "http://localhost.invalid",
      triggerKind: "manual",
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(JSON.parse(readFileSync(snapshotPath, "utf8")), {
      PDPP_RUN_AUTOMATION_MODE: "assisted",
      PDPP_RUN_TRIGGER_KIND: "manual",
    });
  } finally {
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("connector children receive run-scoped capabilities without unrelated parent secrets", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-run-env-isolation-"));
  const connectionSecretName = "PDPP_TEST_CONNECTION_SCOPED_SECRET";
  const operatorSecretName = "PDPP_TEST_UNRELATED_OPERATOR_SECRET";
  const ownerPasswordName = "PDPP_OWNER_PASSWORD";
  const otherProviderSecretName = "STRAVA_ACCESS_TOKEN";
  const declaredEnvName = "CURRENT_CONNECTOR_DECLARED_ENV";
  const parentEnv = {
    [declaredEnvName]: "ambient-current-connector-value",
    [operatorSecretName]: "must-not-cross-the-connector-boundary",
    [ownerPasswordName]: "must-not-cross-the-connector-boundary",
    [otherProviderSecretName]: "must-not-cross-the-connector-boundary",
    PDPP_BROWSER_CHANNEL: "chrome",
    PDPP_BROWSER_HEADLESS: "1",
    PDPP_BROWSER_SURFACE_REQUIRED: "stale-parent-browser-control",
    PDPP_CAPTURE_ARIA_DEPTH: "12",
    PDPP_CAPTURE_FIXTURES: "1",
    PDPP_CAPTURE_ON_FAILURE: "1",
    PDPP_CAPTURE_ROOT_DIR: "/captures",
    PDPP_FORCE_CONTAINER: "1",
    PDPP_OWNER_TOKEN: "stale-parent-owner-token",
    PDPP_RUN_ID: "stale-parent-run-id",
    PDPP_TRACE: "1",
  };
  const previousParentEnv = new Map(Object.keys(parentEnv).map((name) => [name, process.env[name]]));
  const observedNames = [
    connectionSecretName,
    operatorSecretName,
    ownerPasswordName,
    otherProviderSecretName,
    "PDPP_CONNECTOR_ID",
    "PDPP_CONNECTOR_INSTANCE_ID",
    "PDPP_OWNER_TOKEN",
    "PDPP_RS_URL",
    "PDPP_REFERENCE_BASE_URL",
    "PDPP_RUN_ID",
    "PDPP_STREAMING_REGISTRATION_TOKEN",
    declaredEnvName,
    "PDPP_BROWSER_CHANNEL",
    "PDPP_BROWSER_HEADLESS",
    "PDPP_CAPTURE_ARIA_DEPTH",
    "PDPP_CAPTURE_FIXTURES",
    "PDPP_CAPTURE_ON_FAILURE",
    "PDPP_CAPTURE_ROOT_DIR",
    "PDPP_FORCE_CONTAINER",
    "PDPP_TRACE",
    "PDPP_BROWSER_SURFACE_REQUIRED",
    "pdpp_owner_token",
    "Pdpp_Run_Id",
    "pAtH",
    "pdpp_browser_headless",
  ];
  const { connectorPath, snapshotPath } = writeEnvSnapshotConnector(tmpDir, "env-isolation", observedNames);
  Object.assign(process.env, parentEnv);

  try {
    const result = await runConnector({
      admitRunConnection: (input) =>
        Promise.resolve({
          connectorId: input.connectorId,
          connectorInstanceId: input.connectorInstanceId ?? "cin_env_isolation",
          ownerSubjectId: input.ownerSubjectId ?? "owner_local",
        }),
      connectorId: "env-isolation-test",
      connectorInstanceId: "cin_env_isolation",
      connectorPath,
      detailGapStore: {
        listPendingGaps() {
          return Promise.resolve([]);
        },
        reclaimStrandedInProgressGaps() {
          return Promise.resolve();
        },
        upsertPendingGap() {
          return Promise.resolve(null);
        },
      },
      manifest: {
        ...BACKGROUND_SAFE_MANIFEST,
        setup: { credential_capture: { fields: [{ env: [declaredEnvName] }] } },
      },
      ownerToken: "run-scoped-owner-token",
      rsUrl: "http://127.0.0.1:7663",
      staticSecretEnv: {
        [connectionSecretName]: "connection-scoped-secret",
        [declaredEnvName]: "connection-scoped-value",
        PDPP_CONNECTOR_ID: "fragment-must-not-override-connector-id",
        PDPP_CONNECTOR_INSTANCE_ID: "fragment-must-not-override-instance-id",
        PDPP_OWNER_TOKEN: "fragment-must-not-override-owner-token",
        PDPP_REFERENCE_BASE_URL: "http://fragment-must-not-enable-streaming.invalid",
        PDPP_RS_URL: "http://fragment-must-not-override-rs-url.invalid",
        PDPP_RUN_ID: "fragment-must-not-enable-streaming",
        PDPP_STREAMING_REGISTRATION_TOKEN: "fragment-must-not-enable-streaming",
        Pdpp_Run_Id: "mixed-case-run-control-must-not-cross",
        pAtH: "mixed-case-platform-must-not-cross",
        pdpp_browser_headless: "mixed-case-platform-must-not-cross",
        pdpp_owner_token: "mixed-case-owner-token-must-not-cross",
      },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(JSON.parse(readFileSync(snapshotPath, "utf8")), {
      [connectionSecretName]: "connection-scoped-secret",
      [operatorSecretName]: null,
      [ownerPasswordName]: null,
      [otherProviderSecretName]: null,
      PDPP_CONNECTOR_ID: "env-isolation-test",
      PDPP_CONNECTOR_INSTANCE_ID: "cin_env_isolation",
      [declaredEnvName]: "connection-scoped-value",
      PDPP_BROWSER_CHANNEL: "chrome",
      PDPP_BROWSER_HEADLESS: "1",
      PDPP_BROWSER_SURFACE_REQUIRED: null,
      PDPP_CAPTURE_ARIA_DEPTH: "12",
      PDPP_CAPTURE_FIXTURES: "1",
      PDPP_CAPTURE_ON_FAILURE: "1",
      PDPP_CAPTURE_ROOT_DIR: "/captures",
      PDPP_FORCE_CONTAINER: "1",
      PDPP_OWNER_TOKEN: "run-scoped-owner-token",
      PDPP_REFERENCE_BASE_URL: null,
      PDPP_RS_URL: "http://127.0.0.1:7663",
      PDPP_RUN_ID: null,
      PDPP_STREAMING_REGISTRATION_TOKEN: null,
      PDPP_TRACE: "1",
      Pdpp_Run_Id: null,
      pAtH: null,
      pdpp_browser_headless: null,
      pdpp_owner_token: null,
    });
  } finally {
    for (const [name, previous] of previousParentEnv) {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
  for (const [name, previous] of previousParentEnv) {
    assert.equal(process.env[name], previous);
  }
});

test("a store row suppresses credentials_required on the scheduled path (and its absence reproduces the incident)", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-sched-creds-required-"));
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const githubAliases = ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"];

  try {
    const ownerToken = await issueOwnerToken(asUrl, "scheduler_creds_required_user");
    const { connectorPath } = writeCredentialsRequiredConnector(tmpDir, "github", githubAliases);

    const runCase = async ({
      resolver,
    }: {
      resolver:
        | ((args: { connectorId: string; connectorInstanceId: string }) => Promise<Record<string, string> | null>)
        | null;
    }) => {
      const completedRuns: RunRecord[] = [];
      const interactions: EscalationInteraction[] = [];
      const scheduler = createScheduler({
        admitRunConnection: (input) =>
          Promise.resolve({
            connectorId: input.connectorId,
            connectorInstanceId: input.connectorInstanceId ?? "cin_github_test",
            ownerSubjectId: input.ownerSubjectId ?? "scheduler_creds_required_user",
          }),
        connectors: [
          {
            connectorId: "github",
            connectorInstanceId: "cin_github_test",
            connectorPath,
            intervalMs: 60_000,
            manifest: BACKGROUND_SAFE_MANIFEST,
            ownerToken,
          },
        ],
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        onInteraction: async (...args: unknown[]) => {
          const interaction = args[0] as EscalationInteraction;
          interactions.push(interaction);
          return { request_id: interaction.request_id, status: "cancelled", type: "INTERACTION_RESPONSE" };
        },
        // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
        onRunComplete: (record) => completedRuns.push(record),
        rsUrl,
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
      const [record] = completedRuns;
      assert.ok(record, "a completed run record was captured");
      return { interactions, record };
    };

    // Control case — the incident shape: no store resolution, empty-string
    // env → the connector raises credentials_required and the run fails.
    // This proves the child honestly enforces the env requirement.
    const control = await runCase({ resolver: null });
    assert.equal(control.record.status, "failed");
    assert.equal(control.interactions.length, 1);
    const [controlInteraction] = control.interactions;
    assert.ok(controlInteraction, "the control case raises exactly one interaction");
    assert.equal(controlInteraction.kind, "credentials");
    assert.match(controlInteraction.message ?? "", TOP_LEVEL_REGEX_1);

    // Fixed case: identical child + identical empty-string env, but the store
    // row resolves → no interaction, run succeeds.
    const fixed = await runCase({
      resolver: async () =>
        buildConnectionScopedSecretEnv("github", {
          credentialKind: "personal_access_token",
          secret: "stored-github-pat",
        }),
    });
    assert.equal(fixed.record.status, "succeeded");
    assert.deepEqual(fixed.interactions, []);
  } finally {
    await closeServer(server);
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduled launch defers for owner repair when source-scoped credential is missing (no child spawned)", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-sched-fail-closed-"));
  const { connectorPath, snapshotPath } = writeEnvSnapshotConnector(tmpDir, "github", ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
  const completedRuns: RunRecord[] = [];

  const scheduler = createScheduler({
    connectors: [
      {
        connectorId: "github",
        connectorInstanceId: "cin_github_missing",
        connectorPath,
        intervalMs: 60_000,
        manifest: BACKGROUND_SAFE_MANIFEST,
        ownerToken: "owner-token",
      },
    ],
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    onInteraction: async (...args: unknown[]) => {
      const interaction = args[0] as EscalationInteraction;
      return {
        request_id: interaction.request_id,
        status: "cancelled",
        type: "INTERACTION_RESPONSE",
      };
    },
    onRunComplete: (record) => completedRuns.push(record),
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    resolveStaticSecretRunEnv: async () => {
      const err: Error & { code?: string } = new Error(
        "No static-secret credential is stored for connection 'cin_github_missing'."
      );
      err.code = "credential_not_found";
      throw err;
    },
    rsUrl: "http://localhost.invalid",
  });

  try {
    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 5000);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "a completed run record was captured");
    assert.equal(record.status, "skipped");
    assert.equal(record.failureReason, undefined);
    assert.ok(record.error, "the skipped record carries an error message");
    assert.match(record.error, TOP_LEVEL_REGEX_2);
    assert.match(record.error, TOP_LEVEL_REGEX_3);
    // The connector child must never have been spawned.
    assert.throws(() => readFileSync(snapshotPath, "utf8"), TOP_LEVEL_REGEX_4);
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});
