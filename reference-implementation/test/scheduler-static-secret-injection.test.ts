const TOP_LEVEL_REGEX_1 = /github needs: GITHUB_PERSONAL_ACCESS_TOKEN/;
const TOP_LEVEL_REGEX_2 = /^needs_human_attention: credential_not_found:/;
const TOP_LEVEL_REGEX_3 = /credential is stored/;
const TOP_LEVEL_REGEX_4 = /ENOENT/;
const TOP_LEVEL_REGEX_5 = /connectionEnv key .* is reserved/;
const TOP_LEVEL_REGEX_6 = /connectionEnv\.allowedKeys has duplicate key|connectionEnv has unsupported key|reserved/i;
const TOP_LEVEL_REGEX_7 = /connectionEnv proxy key HTTP_PROXY requires connector-scoped operator authority/;
const TOP_LEVEL_REGEX_8 = /useful context survives/;

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
import { getRunTerminalEvent } from "../lib/spine.ts";
import {
  type ConnectorConnectionEnvironment,
  composeConnectorChildEnvironment,
} from "../runtime/connector-child-environment.ts";
import { runConnector } from "../runtime/index.ts";
import { createScheduler } from "../runtime/scheduler.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

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

async function registerManifest(asUrl: string, manifest: unknown): Promise<void> {
  const registerResp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await registerResp.text();
  assert.equal(registerResp.status, 201, text);
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

function writeFailingStderrConnector(tmpDir: string, name: string, stderrText: string): { connectorPath: string } {
  const connectorPath = join(tmpDir, `${name}-failing-connector.mjs`);
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stderr.write(${JSON.stringify(stderrText)});
  rl.close();
  process.exit(1);
});
`,
    "utf8"
  );
  return { connectorPath };
}

async function registerFixtureConnectorInstance(options: {
  connectorId: string;
  connectorInstanceId: string;
  displayName?: string;
  ownerSubjectId: string;
}): Promise<void> {
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: options.connectorId,
    connectorInstanceId: options.connectorInstanceId,
    createdAt: "2026-08-12T00:00:00.000Z",
    displayName: options.displayName ?? options.connectorId,
    ownerSubjectId: options.ownerSubjectId,
    sourceBinding: { kind: "test_connector_environment_policy" },
    sourceBindingKey: `${options.connectorInstanceId}_binding`,
    sourceKind: "account",
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
}

function minimalNestedAuthManifest(connectorKey: string): Record<string, unknown> {
  return {
    capabilities: {
      auth: { kind: "custom", required: [["NESTED_PRIMARY_TOKEN", "NESTED_SECONDARY_TOKEN"]] },
      refresh_policy: {
        background_safe: true,
        interaction_posture: "none",
        rationale: "Test fixture for connector environment policy coverage.",
        recommended_interval_seconds: 60,
        recommended_mode: "automatic",
      },
    },
    connector_id: connectorKey,
    connector_key: connectorKey,
    display_name: connectorKey,
    manifest_uri: `https://registry.pdpp.org/connectors/${connectorKey}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

test("connector platform env keeps cross-host execution inputs without ambient secrets", () => {
  assert.deepEqual(
    composePlatformEnvironment({
      APPDATA: "C:\\Users\\pdpp\\AppData\\Roaming",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      HOME: "/home/pdpp",
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
  const allowed = composeConnectorChildEnvironment({
    connectionEnv: {
      allowedKeys: ["CONNECTION_SECRET"],
      connectorId: "test-connector",
      kind: "connection",
      values: { CONNECTION_SECRET: "allowed" },
    } satisfies ConnectorConnectionEnvironment,
    connectorId: "test-connector",
    explicitRunEnv: {},
    manifest: {},
    platform: "linux",
    sourceEnv: {},
  });
  assert.equal(allowed.CONNECTION_SECRET, "allowed");

  for (const name of ["PATH", "PDPP_OWNER_TOKEN", "PDPP_RS_URL", "PDPP_CONNECTOR_ID"]) {
    for (const variant of [name, name.toLowerCase(), `${name.slice(0, 1)}${name.slice(1).toLowerCase()}`]) {
      assert.throws(
        () =>
          composeConnectorChildEnvironment({
            connectionEnv: {
              allowedKeys: [variant, "CONNECTION_SECRET"],
              connectorId: "test-connector",
              kind: "connection",
              values: { [variant]: "must-not-cross", CONNECTION_SECRET: "allowed" },
            } satisfies ConnectorConnectionEnvironment,
            connectorId: "test-connector",
            explicitRunEnv: {},
            manifest: {},
            platform: "linux",
            sourceEnv: {},
          }),
        TOP_LEVEL_REGEX_5
      );
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
      const resolverCalls: { connectorId: string; connectorInstanceId: string; ownerSubjectId: string }[] = [];

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
            ownerSubjectId: "scheduler_static_secret_user",
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
      assert.deepEqual(resolverCalls, [
        { connectorId, connectorInstanceId, ownerSubjectId: "scheduler_static_secret_user" },
      ]);

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

test("startServer controller and scheduler-manager pass operator policy into spawned connector children", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-prod-env-policy-"));
  const providerManifest = JSON.parse(
    readFileSync(
      new URL("../../packages/polyfill-connectors/manifests/google_maps_data_portability.json", import.meta.url),
      "utf8"
    )
  );
  const manualManifest = JSON.parse(
    readFileSync(new URL("../../packages/polyfill-connectors/manifests/whatsapp.json", import.meta.url), "utf8")
  );
  const nestedManifest = minimalNestedAuthManifest("nested-auth-policy-test");
  const observedNames = [
    "GOOGLE_DATAPORTABILITY_CLIENT_ID",
    "GOOGLE_DATAPORTABILITY_CLIENT_SECRET",
    "GOOGLE_DATAPORTABILITY_REDIRECT_URI",
    "WHATSAPP_EXPORT_DIR",
    "NESTED_PRIMARY_TOKEN",
    "NESTED_SECONDARY_TOKEN",
    "HTTP_PROXY",
    "SIBLING_SECRET",
  ];
  const provider = writeEnvSnapshotConnector(tmpDir, "provider", observedNames);
  const manual = writeEnvSnapshotConnector(tmpDir, "manual", observedNames);
  const nested = writeEnvSnapshotConnector(tmpDir, "nested", observedNames);
  const priorEnv = new Map(
    [
      "GOOGLE_DATAPORTABILITY_CLIENT_ID",
      "GOOGLE_DATAPORTABILITY_CLIENT_SECRET",
      "GOOGLE_DATAPORTABILITY_REDIRECT_URI",
      "WHATSAPP_EXPORT_DIR",
      "NESTED_PRIMARY_TOKEN",
      "NESTED_SECONDARY_TOKEN",
      "HTTP_PROXY",
      "PDPP_CONNECTOR_ENVIRONMENT_POLICY",
      "SIBLING_SECRET",
    ].map((key) => [key, process.env[key]])
  );
  process.env.GOOGLE_DATAPORTABILITY_CLIENT_ID = "operator-google-dataportability-client-id";
  process.env.GOOGLE_DATAPORTABILITY_CLIENT_SECRET = "operator-google-dataportability-client-secret";
  process.env.GOOGLE_DATAPORTABILITY_REDIRECT_URI = "https://operator.example/oauth/google-dataportability/callback";
  process.env.HTTP_PROXY = "http://operator:proxy-password@proxy.example";
  process.env.NESTED_PRIMARY_TOKEN = "operator-nested-primary";
  process.env.NESTED_SECONDARY_TOKEN = "operator-nested-secondary";
  process.env.SIBLING_SECRET = "must-not-cross";
  process.env.WHATSAPP_EXPORT_DIR = "/operator/imports/whatsapp";
  process.env.PDPP_CONNECTOR_ENVIRONMENT_POLICY = JSON.stringify({
    bindings: [
      {
        connector_id: "google-maps-data-portability",
        logical_key: "GOOGLE_DATAPORTABILITY_CLIENT_ID",
        source: { key: "GOOGLE_DATAPORTABILITY_CLIENT_ID", kind: "process_env" },
        target_key: "GOOGLE_DATAPORTABILITY_CLIENT_ID",
      },
      {
        connector_id: "google-maps-data-portability",
        logical_key: "GOOGLE_DATAPORTABILITY_CLIENT_SECRET",
        source: { key: "GOOGLE_DATAPORTABILITY_CLIENT_SECRET", kind: "process_env" },
        target_key: "GOOGLE_DATAPORTABILITY_CLIENT_SECRET",
      },
      {
        connector_id: "google-maps-data-portability",
        logical_key: "GOOGLE_DATAPORTABILITY_REDIRECT_URI",
        source: { key: "GOOGLE_DATAPORTABILITY_REDIRECT_URI", kind: "process_env" },
        target_key: "GOOGLE_DATAPORTABILITY_REDIRECT_URI",
      },
      {
        connector_id: "whatsapp",
        logical_key: "WHATSAPP_EXPORT_DIR",
        source: { key: "WHATSAPP_EXPORT_DIR", kind: "process_env" },
        target_key: "WHATSAPP_EXPORT_DIR",
      },
      {
        connector_id: "nested-auth-policy-test",
        logical_key: "NESTED_PRIMARY_TOKEN",
        source: { key: "NESTED_PRIMARY_TOKEN", kind: "process_env" },
        target_key: "NESTED_PRIMARY_TOKEN",
      },
      {
        connector_id: "nested-auth-policy-test",
        logical_key: "NESTED_SECONDARY_TOKEN",
        source: { key: "NESTED_SECONDARY_TOKEN", kind: "process_env" },
        target_key: "NESTED_SECONDARY_TOKEN",
      },
      {
        connector_id: "google-maps-data-portability",
        logical_key: "GOOGLE_DATAPORTABILITY_CLIENT_ID",
        source: { key: "HTTP_PROXY", kind: "process_env" },
        target_key: "HTTP_PROXY",
      },
    ],
    proxy_connector_ids: ["google-maps-data-portability"],
  });
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    connectorPathResolver: (connectorId) => {
      if (connectorId === "google-maps-data-portability") {
        return provider.connectorPath;
      }
      if (connectorId === "whatsapp") {
        return manual.connectorPath;
      }
      if (connectorId === "nested-auth-policy-test") {
        return nested.connectorPath;
      }
      return null;
    },
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });

  try {
    const asUrl = `http://localhost:${server.asPort}`;
    await registerManifest(asUrl, providerManifest);
    await registerManifest(asUrl, manualManifest);
    await registerManifest(asUrl, nestedManifest);

    await registerFixtureConnectorInstance({
      connectorId: "google-maps-data-portability",
      connectorInstanceId: "cin_google_maps_data_portability_policy",
      displayName: "Google Maps Data Portability",
      ownerSubjectId: "owner_local",
    });
    await registerFixtureConnectorInstance({
      connectorId: "whatsapp",
      connectorInstanceId: "cin_whatsapp_policy",
      displayName: "WhatsApp",
      ownerSubjectId: "owner_local",
    });
    await registerFixtureConnectorInstance({
      connectorId: "nested-auth-policy-test",
      connectorInstanceId: "cin_nested_policy",
      ownerSubjectId: "owner_local",
    });

    const providerHandle = await server.controller.runNow("google-maps-data-portability", {
      connectorInstanceId: "cin_google_maps_data_portability_policy",
      manifest: providerManifest,
      runId: "run_provider_policy",
    });
    await server.controller.awaitRun(providerHandle.run_id);
    const providerEnv = JSON.parse(readFileSync(provider.snapshotPath, "utf8"));
    assert.equal(providerEnv.GOOGLE_DATAPORTABILITY_CLIENT_ID, "operator-google-dataportability-client-id");
    assert.equal(providerEnv.GOOGLE_DATAPORTABILITY_CLIENT_SECRET, "operator-google-dataportability-client-secret");
    assert.equal(
      providerEnv.GOOGLE_DATAPORTABILITY_REDIRECT_URI,
      "https://operator.example/oauth/google-dataportability/callback"
    );
    assert.equal(providerEnv.HTTP_PROXY, "http://operator:proxy-password@proxy.example");
    assert.equal(providerEnv.SIBLING_SECRET, null);

    const manualHandle = await server.controller.runNow("whatsapp", {
      connectorInstanceId: "cin_whatsapp_policy",
      manifest: manualManifest,
      runId: "run_manual_policy",
    });
    await server.controller.awaitRun(manualHandle.run_id);
    const manualEnv = JSON.parse(readFileSync(manual.snapshotPath, "utf8"));
    assert.equal(manualEnv.WHATSAPP_EXPORT_DIR, "/operator/imports/whatsapp");
    assert.equal(manualEnv.HTTP_PROXY, null);
    assert.equal(manualEnv.SIBLING_SECRET, null);

    await server.controller.upsertSchedule(
      "nested-auth-policy-test",
      { enabled: true, interval_seconds: 60, jitter_seconds: 0 },
      { connectorInstanceId: "cin_nested_policy" }
    );
    await server.schedulerManager.refresh();
    await waitFor(() => {
      try {
        const nestedEnv = JSON.parse(readFileSync(nested.snapshotPath, "utf8"));
        return nestedEnv.NESTED_PRIMARY_TOKEN === "operator-nested-primary";
      } catch {
        return false;
      }
    }, 5000);
    const nestedEnv = JSON.parse(readFileSync(nested.snapshotPath, "utf8"));
    assert.equal(nestedEnv.NESTED_PRIMARY_TOKEN, "operator-nested-primary");
    assert.equal(nestedEnv.NESTED_SECONDARY_TOKEN, "operator-nested-secondary");
    assert.equal(nestedEnv.HTTP_PROXY, null);
    assert.equal(nestedEnv.SIBLING_SECRET, null);
  } finally {
    await closeServer(server);
    for (const [key, value] of priorEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
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
    await assert.rejects(
      () =>
        runConnector({
          admitRunConnection: (input) =>
            Promise.resolve({
              connectorId: input.connectorId,
              connectorInstanceId: input.connectorInstanceId ?? "cin_hostile_proxy",
              ownerSubjectId: input.ownerSubjectId ?? "owner_local",
            }),
          connectorId: "hostile-proxy-test",
          connectorInstanceId: "cin_hostile_proxy",
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
          manifest: BACKGROUND_SAFE_MANIFEST,
          ownerToken: "owner-token",
          rsUrl: "http://localhost.invalid",
          staticSecretEnv: { HTTP_PROXY: "http://hostile:proxy@proxy.example" },
        }),
      TOP_LEVEL_REGEX_7
    );

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

test("connector stderr progress and retained diagnostics redact secret and proxy needles", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stderr-redaction-"));
  const secretNeedle = "secret=shortNeedle";
  const proxyNeedle = "http://operator:proxy-password@proxy.example";
  const usefulContext = "useful context survives";
  const stderrText = `${usefulContext} ${secretNeedle} ${proxyNeedle}\n`;
  const { connectorPath } = writeFailingStderrConnector(tmpDir, "runtime-progress", stderrText);
  const progress: unknown[] = [];

  try {
    const result = await runConnector({
      admitRunConnection: (input) =>
        Promise.resolve({
          connectorId: input.connectorId,
          connectorInstanceId: input.connectorInstanceId ?? "cin_stderr_runtime",
          ownerSubjectId: input.ownerSubjectId ?? "owner_local",
        }),
      connectorId: "stderr-runtime-test",
      connectorInstanceId: "cin_stderr_runtime",
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
      manifest: BACKGROUND_SAFE_MANIFEST,
      onProgress: (message) => progress.push(message),
      ownerToken: "owner-token",
      rsUrl: "http://localhost.invalid",
    });

    assert.equal(result.status, "failed");
    const serializedProgress = JSON.stringify(progress);
    assert.match(serializedProgress, TOP_LEVEL_REGEX_8);
    assert.equal(serializedProgress.includes("shortNeedle"), false);
    assert.equal(serializedProgress.includes("operator:proxy-password"), false);
    const serializedResult = JSON.stringify(result);
    assert.match(serializedResult, TOP_LEVEL_REGEX_8);
    assert.equal(serializedResult.includes("shortNeedle"), false);
    assert.equal(serializedResult.includes("operator:proxy-password"), false);
  } finally {
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }

  const serverTmpDir = mkdtempSync(join(tmpdir(), "pdpp-stderr-server-"));
  const serverNeedle = "api_key=serverShortNeedle";
  const serverProxyNeedle = "https://operator:server-proxy@proxy.example";
  const { connectorPath: serverConnectorPath } = writeFailingStderrConnector(
    serverTmpDir,
    "server-terminal",
    `${usefulContext} ${serverNeedle} ${serverProxyNeedle}\n`
  );
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    connectorPathResolver: () => serverConnectorPath,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });

  try {
    await registerManifest(`http://localhost:${server.asPort}`, {
      ...BACKGROUND_SAFE_MANIFEST,
      capabilities: {
        refresh_policy: {
          background_safe: true,
          interaction_posture: "none",
          rationale: "Test fixture for stderr redaction coverage.",
          recommended_interval_seconds: 60,
          recommended_mode: "automatic",
        },
      },
      connector_id: "stderr-server-test",
      connector_key: "stderr-server-test",
      display_name: "Stderr server test",
      manifest_uri: "https://registry.pdpp.org/connectors/stderr-server-test",
      protocol_version: "0.1.0",
      streams: [
        {
          name: "items",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
      ],
      version: "0.1.0",
    });
    await registerFixtureConnectorInstance({
      connectorId: "stderr-server-test",
      connectorInstanceId: "cin_stderr_server",
      ownerSubjectId: "owner_local",
    });
    const handle = await server.controller.runNow("stderr-server-test", {
      connectorInstanceId: "cin_stderr_server",
      manifest: BACKGROUND_SAFE_MANIFEST,
      runId: "run_stderr_server",
    });
    await server.controller.awaitRun(handle.run_id);
    const terminal = await getRunTerminalEvent(handle.run_id);
    const serializedTerminal = JSON.stringify(terminal);
    assert.match(serializedTerminal, TOP_LEVEL_REGEX_8);
    assert.equal(serializedTerminal.includes("serverShortNeedle"), false);
    assert.equal(serializedTerminal.includes("operator:server-proxy"), false);
    const historyRows = getDb().prepare("SELECT * FROM run_history WHERE run_id = ?").all(handle.run_id) as unknown[];
    const serializedHistory = JSON.stringify(historyRows);
    assert.equal(serializedHistory.includes("serverShortNeedle"), false);
    assert.equal(serializedHistory.includes("operator:server-proxy"), false);
  } finally {
    await closeServer(server);
    closeDb();
    rmSync(serverTmpDir, { force: true, recursive: true });
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
    await assert.rejects(
      () =>
        runConnector({
          admitRunConnection: (input) =>
            Promise.resolve({
              connectorId: input.connectorId,
              connectorInstanceId: input.connectorInstanceId ?? "cin_env_isolation",
              ownerSubjectId: input.ownerSubjectId ?? "owner_local",
            }),
          connectorId: "env-isolation-test",
          connectorInstanceId: "cin_env_isolation",
          connectorPath,
          manifest: {
            ...BACKGROUND_SAFE_MANIFEST,
            setup: { credential_capture: { fields: [{ env: [declaredEnvName] }] } },
          },
          ownerToken: "run-scoped-owner-token",
          rsUrl: "http://127.0.0.1:7663",
          staticSecretEnv: {
            [declaredEnvName]: "connection-scoped-value",
            PDPP_OWNER_TOKEN: "fragment-must-not-override-owner-token",
            Pdpp_Run_Id: "mixed-case-run-control-must-not-cross",
          },
        }),
      TOP_LEVEL_REGEX_6
    );

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
            ownerSubjectId: "scheduler_creds_required_user",
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
    admitRunConnection: (input) =>
      Promise.resolve({
        connectorId: input.connectorId,
        connectorInstanceId: input.connectorInstanceId ?? "cin_github_missing",
        ownerSubjectId: input.ownerSubjectId ?? "owner_local",
      }),
    connectors: [
      {
        connectorId: "github",
        connectorInstanceId: "cin_github_missing",
        connectorPath,
        intervalMs: 60_000,
        manifest: BACKGROUND_SAFE_MANIFEST,
        ownerSubjectId: "owner_local",
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
