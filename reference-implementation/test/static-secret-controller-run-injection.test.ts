// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";
import type { RecoveredStaticSecret } from "../../packages/polyfill-connectors/src/static-secret-injection.ts";
import {
  __resetControllerInteractionStateForTests,
  createController,
  type MarkStaticSecretCredentialRejected,
  type StaticSecretRunEnvResolver,
} from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions, RuntimeRunConnectorResult } from "../runtime/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  ConnectorInstanceCredentialError,
  createSqliteConnectorInstanceCredentialStore,
} from "../server/stores/connector-instance-credential-store.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { resolveStaticSecretRunEnv as resolveStaticSecretRunEnvUntyped } from "../server/stores/static-secret-run-credentials.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

type ResolveStaticSecretRunEnv = (args: {
  connectorId: string;
  connectorInstanceId: string;
  ownerSubjectId?: string | undefined;
  sourceBinding: unknown;
  credentialStore: unknown;
  isStaticSecretConnector: (connectorId: string) => boolean;
  buildConnectionScopedSecretEnv: (
    connectorId: string,
    recovered: RecoveredStaticSecret,
    sourceBinding?: unknown
  ) => Record<string, string>;
}) => Promise<Record<string, string> | null>;

const resolveStaticSecretRunEnv = resolveStaticSecretRunEnvUntyped as ResolveStaticSecretRunEnv;

function hasCode(err: unknown): err is { code: unknown } {
  return typeof err === "object" && err !== null && "code" in err;
}

function at<T>(items: T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `expected an entry at index ${index}`);
  return item;
}

// This suite proves the LAST connective leg of the static-secret primitive that
// was previously missing: that a captured credential actually reaches a
// connector run, scoped to one connection, through the controller's `runNow`
// → `runConnector` spawn path. The store/seam fail-closed contract is proven in
// static-secret-run-credentials.test.js; the pure injection registry + a live
// spawn merge-order proof live in
// packages/polyfill-connectors/src/static-secret-injection.test.ts. Here we wire
// the REAL resolver the reference server installs (real credential store + real
// `@pdpp/polyfill-connectors` injection helpers) into a real controller and
// assert the env fragment the connector child would be spawned with. The
// connector itself is stubbed
// (`runConnectorImpl` captures opts) so no provider/network is touched — the
// live intent→capture→first-ingest leg remains gated (design Decision 6).
//
// See add-static-secret-owner-connect-primitive design Decision 5.

const TEST_KEY = "test-operator-key-do-not-use-in-prod";
const GMAIL_CONNECTOR = "gmail";
const GMAIL_MANIFEST = {
  connector_id: GMAIL_CONNECTOR,
  name: "Gmail",
  runtime_requirements: { bindings: { network: { required: true } } },
  streams: [],
  version: "1.0.0",
};
const CHATGPT_CONNECTOR = "chatgpt";
const CHATGPT_MANIFEST = {
  connector_id: CHATGPT_CONNECTOR,
  name: "ChatGPT",
  runtime_requirements: { bindings: { browser: { required: true } } },
  streams: [],
  version: "1.0.0",
};
const AMAZON_CONNECTOR = "amazon";
const AMAZON_MANIFEST = {
  connector_id: AMAZON_CONNECTOR,
  name: "Amazon",
  runtime_requirements: { bindings: { browser: { required: true } } },
  streams: [],
  version: "1.0.0",
};
const NON_SECRET_CONNECTOR = "claude_code";
const NON_SECRET_MANIFEST = {
  connector_id: NON_SECRET_CONNECTOR,
  name: "Claude Code",
  runtime_requirements: { bindings: { filesystem: { required: true } } },
  streams: [],
  version: "1.0.0",
};

function seedConnectorInstance({
  connectorInstanceId,
  ownerSubjectId,
  connectorId,
  sourceBinding = {},
}: {
  connectorInstanceId: string;
  ownerSubjectId: string;
  connectorId: string;
  sourceBinding?: unknown;
}): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    connectorId,
    JSON.stringify({ connector_id: connectorId }),
    "2026-06-01T00:00:00.000Z"
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, ?, ?, ?, NULL)`
  ).run(
    connectorInstanceId,
    ownerSubjectId,
    connectorId,
    connectorInstanceId,
    connectorInstanceId,
    JSON.stringify(sourceBinding),
    "2026-06-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z"
  );
}

// Builds the SAME resolver the reference server installs on the controller (see
// `buildControllerStaticSecretRunEnvResolver` in server/index.js): real
// credential store and real injection helpers from the connector package.
// Proving the real resolver — not a stub — is what makes this an end-to-end
// wiring proof.
function buildRealResolver(): StaticSecretRunEnvResolver {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
    const { isStaticSecretConnector, buildConnectionScopedSecretEnv } = await import(
      "../../packages/polyfill-connectors/src/static-secret-injection.ts"
    );
    if (!isStaticSecretConnector(connectorId)) {
      return null;
    }
    const credentialStore = createSqliteConnectorInstanceCredentialStore({
      env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY },
    });
    return await resolveStaticSecretRunEnv({
      buildConnectionScopedSecretEnv,
      connectorId,
      connectorInstanceId,
      credentialStore,
      isStaticSecretConnector,
      ownerSubjectId,
      sourceBinding: createSqliteConnectorInstanceStore().get(connectorInstanceId)?.sourceBinding,
    });
  };
}

// A minimal, production-shaped admission fixture: mints a deterministic
// default-account connector_instance_id per (ownerSubjectId, connectorId) and
// echoes back an explicitly requested one — the same authority shape
// `admitOwnerRunConnection` enforces in production, without a real store.
// Every `runNow` call in this file passes an explicit `connectorInstanceId`.
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? `cin_${ownerSubjectId}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

function captureStore() {
  return createSqliteConnectorInstanceCredentialStore({
    env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY },
  });
}

function freshDb(t: TestContext): void {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-static-secret-run-"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

function makeController(
  calls: RuntimeRunConnectorOptions[],
  overrides: {
    markStaticSecretCredentialRejected?: MarkStaticSecretCredentialRejected;
    runConnectorImpl?: (opts: RuntimeRunConnectorOptions) => Promise<RuntimeRunConnectorResult>;
  } = {}
) {
  return createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.ts",
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    logger: { error: () => {}, warn: () => {} },
    ownerSubjectId: "owner_1",
    resolveStaticSecretRunEnv: buildRealResolver(),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return Promise.resolve({ records_emitted: 0, status: "succeeded" });
    },
    ...overrides,
  });
}

test("a captured credential is injected into the connector run scoped to one connection", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorId: GMAIL_CONNECTOR,
    connectorInstanceId: "cin_personal",
    ownerSubjectId: "owner_1",
  });
  await captureStore().capture({
    connectorInstanceId: "cin_personal",
    credentialKind: "app_password",
    now: "2026-06-01T12:00:00.000Z",
    ownerSubjectId: "owner_1",
    secret: "personal one here",
  });

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls);
  await controller.runNow(GMAIL_CONNECTOR, {
    connectorInstanceId: "cin_personal",
    manifest: GMAIL_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_personal",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.deepEqual(at(calls, 0).staticSecretEnv, {
    GMAIL_APP_PASSWORD: "personal one here",
    GOOGLE_APP_PASSWORD_PDPP: "personal one here",
  });
});

test("a captured ChatGPT username/password credential is injected into the connector run", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorId: CHATGPT_CONNECTOR,
    connectorInstanceId: "cin_chatgpt",
    ownerSubjectId: "owner_1",
  });
  await captureStore().capture({
    connectorInstanceId: "cin_chatgpt",
    credentialKind: "username_password",
    now: "2026-06-01T12:00:00.000Z",
    ownerSubjectId: "owner_1",
    secret: JSON.stringify({
      password: "chatgpt password here",
      username: "owner@example.com",
    }),
  });

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls);
  await controller.runNow(CHATGPT_CONNECTOR, {
    connectorInstanceId: "cin_chatgpt",
    manifest: CHATGPT_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_chatgpt",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.deepEqual(at(calls, 0).staticSecretEnv, {
    CHATGPT_PASSWORD: "chatgpt password here",
    CHATGPT_USERNAME: "owner@example.com",
  });
});

test("a connector credential_rejected terminal marks the injected stored credential rejected", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorId: CHATGPT_CONNECTOR,
    connectorInstanceId: "cin_chatgpt",
    ownerSubjectId: "owner_1",
  });
  const store = captureStore();
  await store.capture({
    connectorInstanceId: "cin_chatgpt",
    credentialKind: "username_password",
    now: "2026-06-01T12:00:00.000Z",
    ownerSubjectId: "owner_1",
    secret: JSON.stringify({
      password: "stale chatgpt password",
      username: "owner@example.com",
    }),
  });

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    markStaticSecretCredentialRejected: async ({ connectorInstanceId, rejectedAt, reason }) => {
      await captureStore().markRejected({ connectorInstanceId, reason, rejectedAt });
    },
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return Promise.resolve({
        connector_error: {
          code: "credential_rejected",
          message: "provider rejected stored credential",
          retryable: false,
        },
        records_emitted: 0,
        status: "failed",
      });
    },
  });
  await controller.runNow(CHATGPT_CONNECTOR, {
    connectorInstanceId: "cin_chatgpt",
    manifest: CHATGPT_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_chatgpt_rejected",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.deepEqual(at(calls, 0).staticSecretEnv, {
    CHATGPT_PASSWORD: "stale chatgpt password",
    CHATGPT_USERNAME: "owner@example.com",
  });
  const meta = await store.getMetadata("cin_chatgpt");
  assert.ok(meta, "expected credential metadata for cin_chatgpt");
  assert.equal(meta.status, "rejected");
  assert.equal(meta.rejectionReason, "provider rejected stored credential");
});

test("a captured Amazon username/password credential is injected into the connector run", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorId: AMAZON_CONNECTOR,
    connectorInstanceId: "cin_amazon",
    ownerSubjectId: "owner_1",
  });
  await captureStore().capture({
    connectorInstanceId: "cin_amazon",
    credentialKind: "username_password",
    now: "2026-06-01T12:00:00.000Z",
    ownerSubjectId: "owner_1",
    secret: JSON.stringify({
      password: "amazon password here",
      username: "owner@example.com",
    }),
  });

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls);
  await controller.runNow(AMAZON_CONNECTOR, {
    connectorInstanceId: "cin_amazon",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_amazon",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.deepEqual(at(calls, 0).staticSecretEnv, {
    AMAZON_PASSWORD: "amazon password here",
    AMAZON_USERNAME: "owner@example.com",
  });
});

test("non-secret static setup fields are injected with the captured credential", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorId: GMAIL_CONNECTOR,
    connectorInstanceId: "cin_personal",
    ownerSubjectId: "owner_1",
    sourceBinding: {
      kind: "static_secret_draft",
      setup_fields: {
        account_email: "owner@example.com",
      },
    },
  });
  await captureStore().capture({
    connectorInstanceId: "cin_personal",
    credentialKind: "app_password",
    now: "2026-06-01T12:00:00.000Z",
    ownerSubjectId: "owner_1",
    secret: "personal one here",
  });

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls);
  await controller.runNow(GMAIL_CONNECTOR, {
    connectorInstanceId: "cin_personal",
    manifest: GMAIL_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_personal",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.deepEqual(at(calls, 0).staticSecretEnv, {
    GMAIL_ADDRESS: "owner@example.com",
    GMAIL_APP_PASSWORD: "personal one here",
    GMAIL_USER: "owner@example.com",
    GOOGLE_APP_PASSWORD_PDPP: "personal one here",
  });
});

test("two mailboxes run with two distinct injected secrets (no process-global collision)", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorId: GMAIL_CONNECTOR,
    connectorInstanceId: "cin_personal",
    ownerSubjectId: "owner_1",
  });
  seedConnectorInstance({ connectorId: GMAIL_CONNECTOR, connectorInstanceId: "cin_work", ownerSubjectId: "owner_1" });
  const store = captureStore();
  await store.capture({
    connectorInstanceId: "cin_personal",
    credentialKind: "app_password",
    now: "2026-06-01T12:00:00.000Z",
    ownerSubjectId: "owner_1",
    secret: "personal one here",
  });
  await store.capture({
    connectorInstanceId: "cin_work",
    credentialKind: "app_password",
    now: "2026-06-01T12:00:00.000Z",
    ownerSubjectId: "owner_1",
    secret: "work two distinct",
  });

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls);
  await controller.runNow(GMAIL_CONNECTOR, {
    connectorInstanceId: "cin_personal",
    manifest: GMAIL_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_personal",
  });
  await controller.runNow(GMAIL_CONNECTOR, {
    connectorInstanceId: "cin_work",
    manifest: GMAIL_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_work",
  });
  await controller.drainActiveRuns(1000);

  const byInstance = new Map(calls.map((c) => [c.connectorInstanceId, c.staticSecretEnv]));
  function envFor(connectorInstanceId: string): Record<string, string> {
    const env = byInstance.get(connectorInstanceId);
    assert.ok(env, `expected a staticSecretEnv for ${connectorInstanceId}`);
    return env;
  }
  assert.equal(envFor("cin_personal").GOOGLE_APP_PASSWORD_PDPP, "personal one here");
  assert.equal(envFor("cin_work").GOOGLE_APP_PASSWORD_PDPP, "work two distinct");
  assert.notEqual(envFor("cin_personal").GOOGLE_APP_PASSWORD_PDPP, envFor("cin_work").GOOGLE_APP_PASSWORD_PDPP);
});

test("a static-secret connection with no captured credential fails closed before child spawn", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorId: GMAIL_CONNECTOR,
    connectorInstanceId: "cin_personal",
    ownerSubjectId: "owner_1",
  });

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls);
  await assert.rejects(
    () =>
      controller.runNow(GMAIL_CONNECTOR, {
        connectorInstanceId: "cin_personal",
        manifest: GMAIL_MANIFEST,
        ownerToken: "owner-token",
        runId: "run_personal",
      }),
    (err) => hasCode(err) && err.code === "credential_not_found"
  );
  // The configured source must not spawn a child that can fall back to
  // deployment-wide provider-account env.
  assert.equal(calls.length, 0);
});

test("a browser-collector connection with no captured static login credential still launches", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorId: CHATGPT_CONNECTOR,
    connectorInstanceId: "cin_chatgpt",
    ownerSubjectId: "owner_1",
    sourceBinding: {
      connector_id: CHATGPT_CONNECTOR,
      enrollment_completed_at: "2026-06-01T12:01:00.000Z",
      enrollment_expires_at: "2026-06-01T14:00:00.000Z",
      kind: "browser_collector",
    },
  });

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls);
  await controller.runNow(CHATGPT_CONNECTOR, {
    connectorInstanceId: "cin_chatgpt",
    manifest: CHATGPT_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_chatgpt",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.equal(at(calls, 0).staticSecretEnv, null);
});

test("a non-static-secret connector receives no injected secret", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorId: NON_SECRET_CONNECTOR,
    connectorInstanceId: "cin_amazon",
    ownerSubjectId: "owner_1",
  });

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls);
  await controller.runNow(NON_SECRET_CONNECTOR, {
    connectorInstanceId: "cin_amazon",
    manifest: NON_SECRET_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_amazon",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.equal(at(calls, 0).staticSecretEnv, null);
});

test("a revoked credential fails the run closed (no stale or process-global secret)", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorId: GMAIL_CONNECTOR,
    connectorInstanceId: "cin_personal",
    ownerSubjectId: "owner_1",
  });
  const store = captureStore();
  await store.capture({
    connectorInstanceId: "cin_personal",
    credentialKind: "app_password",
    now: "2026-06-01T12:00:00.000Z",
    ownerSubjectId: "owner_1",
    secret: "personal one here",
  });
  await store.revoke({ connectorInstanceId: "cin_personal", now: "2026-06-01T12:05:00.000Z" });

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls);
  await assert.rejects(
    () =>
      controller.runNow(GMAIL_CONNECTOR, {
        connectorInstanceId: "cin_personal",
        manifest: GMAIL_MANIFEST,
        ownerToken: "owner-token",
        runId: "run_personal",
      }),
    (err) => hasCode(err) && err.code === "credential_revoked"
  );
  // The run was refused before the connector was ever spawned.
  assert.equal(calls.length, 0);
});

test("a resolver failure occurs before managed browser-surface acquisition", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorId: GMAIL_CONNECTOR,
    connectorInstanceId: "cin_personal",
    ownerSubjectId: "owner_1",
  });

  const calls: RuntimeRunConnectorOptions[] = [];
  const managerCalls: string[] = [];
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    // The real BrowserSurfaceLeaseManager (from @opendatalabs/remote-surface)
    // is a class with private fields, so no plain object literal can ever
    // structurally satisfy it; this test only exercises isManagedConnector
    // (the controller's static-secret-failure path is proven to never reach
    // any other member — assert.deepEqual(managerCalls, []) below), so a
    // Pick-typed partial stands in for the one member under test.
    browserSurfaceLeaseManager: {
      isManagedConnector: (connectorId: string) => {
        managerCalls.push(connectorId);
        return true;
      },
    } as import("@opendatalabs/remote-surface/leases").BrowserSurfaceLeaseManager,
    connectorPathResolver: () => "/tmp/connector.ts",
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    logger: { error: () => {}, warn: () => {} },
    ownerSubjectId: "owner_1",
    resolveStaticSecretRunEnv: () => {
      throw new ConnectorInstanceCredentialError("credential_revoked", "credential revoked");
    },
    runConnectorImpl: (opts: RuntimeRunConnectorOptions) => {
      calls.push(opts);
      return Promise.resolve({ records_emitted: 0, status: "succeeded" });
    },
  });

  await assert.rejects(
    () =>
      controller.runNow(GMAIL_CONNECTOR, {
        connectorInstanceId: "cin_personal",
        manifest: GMAIL_MANIFEST,
        ownerToken: "owner-token",
        runId: "run_personal",
      }),
    (err) => hasCode(err) && err.code === "credential_revoked"
  );

  // Static-secret failures are resolved before taking runtime resources, so a
  // revoked credential cannot leak a browser-surface lease or spawn a child.
  assert.deepEqual(managerCalls, []);
  assert.equal(calls.length, 0);
});
