// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { makeTemporaryDbPath } from "./helpers/temp-dir.js";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
import {
  __resetControllerInteractionStateForTests,
  createController,
} from "../runtime/controller.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.js";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.js";
import { resolveStaticSecretRunEnv } from "../server/stores/static-secret-run-credentials.js";

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
  version: "1.0.0",
  runtime_requirements: { bindings: { network: { required: true } } },
  streams: [],
};
const CHATGPT_CONNECTOR = "chatgpt";
const CHATGPT_MANIFEST = {
  connector_id: CHATGPT_CONNECTOR,
  name: "ChatGPT",
  version: "1.0.0",
  runtime_requirements: { bindings: { browser: { required: true } } },
  streams: [],
};
const AMAZON_CONNECTOR = "amazon";
const AMAZON_MANIFEST = {
  connector_id: AMAZON_CONNECTOR,
  name: "Amazon",
  version: "1.0.0",
  runtime_requirements: { bindings: { browser: { required: true } } },
  streams: [],
};
const NON_SECRET_CONNECTOR = "claude_code";
const NON_SECRET_MANIFEST = {
  connector_id: NON_SECRET_CONNECTOR,
  name: "Claude Code",
  version: "1.0.0",
  runtime_requirements: { bindings: { filesystem: { required: true } } },
  streams: [],
};

function seedConnectorInstance({ connectorInstanceId, ownerSubjectId, connectorId, sourceBinding = {} }) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)`).run(
    connectorId,
    JSON.stringify({ connector_id: connectorId }),
    "2026-06-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, ?, ?, ?, NULL)`,
  ).run(
    connectorInstanceId,
    ownerSubjectId,
    connectorId,
    connectorInstanceId,
    connectorInstanceId,
    JSON.stringify(sourceBinding),
    "2026-06-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z",
  );
}

// Builds the SAME resolver the reference server installs on the controller (see
// `buildControllerStaticSecretRunEnvResolver` in server/index.js): real
// credential store and real injection helpers from the connector package.
// Proving the real resolver — not a stub — is what makes this an end-to-end
// wiring proof.
function buildRealResolver() {
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
      connectorId,
      connectorInstanceId,
      ownerSubjectId,
      sourceBinding: createSqliteConnectorInstanceStore().get(connectorInstanceId)?.sourceBinding,
      credentialStore,
      isStaticSecretConnector,
      buildConnectionScopedSecretEnv,
    });
  };
}

function captureStore() {
  return createSqliteConnectorInstanceCredentialStore({
    env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY },
  });
}

function freshDb(t) {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-static-secret-run-"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

function makeController(calls, overrides = {}) {
  return createController({
    connectorPathResolver: () => "/tmp/connector.ts",
    logger: { error: () => {}, warn: () => {} },
    ownerSubjectId: "owner_1",
    resolveStaticSecretRunEnv: buildRealResolver(),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return Promise.resolve({ status: "succeeded", records_emitted: 0 });
    },
    ...overrides,
  });
}

test("a captured credential is injected into the connector run scoped to one connection", async (t) => {
  freshDb(t);
  seedConnectorInstance({ connectorInstanceId: "cin_personal", ownerSubjectId: "owner_1", connectorId: GMAIL_CONNECTOR });
  await captureStore().capture({
    connectorInstanceId: "cin_personal",
    ownerSubjectId: "owner_1",
    credentialKind: "app_password",
    secret: "personal one here",
    now: "2026-06-01T12:00:00.000Z",
  });

  const calls = [];
  const controller = makeController(calls);
  await controller.runNow(GMAIL_CONNECTOR, {
    connectorInstanceId: "cin_personal",
    manifest: GMAIL_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_personal",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].staticSecretEnv, {
    GOOGLE_APP_PASSWORD_PDPP: "personal one here",
    GMAIL_APP_PASSWORD: "personal one here",
  });
});

test("a captured ChatGPT username/password credential is injected into the connector run", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorInstanceId: "cin_chatgpt",
    ownerSubjectId: "owner_1",
    connectorId: CHATGPT_CONNECTOR,
  });
  await captureStore().capture({
    connectorInstanceId: "cin_chatgpt",
    ownerSubjectId: "owner_1",
    credentialKind: "username_password",
    secret: JSON.stringify({
      password: "chatgpt password here",
      username: "owner@example.com",
    }),
    now: "2026-06-01T12:00:00.000Z",
  });

  const calls = [];
  const controller = makeController(calls);
  await controller.runNow(CHATGPT_CONNECTOR, {
    connectorInstanceId: "cin_chatgpt",
    manifest: CHATGPT_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_chatgpt",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].staticSecretEnv, {
    CHATGPT_PASSWORD: "chatgpt password here",
    CHATGPT_USERNAME: "owner@example.com",
  });
});

test("a connector credential_rejected terminal marks the injected stored credential rejected", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorInstanceId: "cin_chatgpt",
    ownerSubjectId: "owner_1",
    connectorId: CHATGPT_CONNECTOR,
  });
  const store = captureStore();
  await store.capture({
    connectorInstanceId: "cin_chatgpt",
    ownerSubjectId: "owner_1",
    credentialKind: "username_password",
    secret: JSON.stringify({
      password: "stale chatgpt password",
      username: "owner@example.com",
    }),
    now: "2026-06-01T12:00:00.000Z",
  });

  const calls = [];
  const controller = makeController(calls, {
    markStaticSecretCredentialRejected: async ({ connectorInstanceId, rejectedAt, reason }) => {
      await captureStore().markRejected({ connectorInstanceId, rejectedAt, reason });
    },
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return Promise.resolve({
        status: "failed",
        records_emitted: 0,
        connector_error: {
          code: "credential_rejected",
          message: "provider rejected stored credential",
          retryable: false,
        },
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
  assert.deepEqual(calls[0].staticSecretEnv, {
    CHATGPT_PASSWORD: "stale chatgpt password",
    CHATGPT_USERNAME: "owner@example.com",
  });
  const meta = await store.getMetadata("cin_chatgpt");
  assert.equal(meta.status, "rejected");
  assert.equal(meta.rejectionReason, "provider rejected stored credential");
});

test("a captured Amazon username/password credential is injected into the connector run", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorInstanceId: "cin_amazon",
    ownerSubjectId: "owner_1",
    connectorId: AMAZON_CONNECTOR,
  });
  await captureStore().capture({
    connectorInstanceId: "cin_amazon",
    ownerSubjectId: "owner_1",
    credentialKind: "username_password",
    secret: JSON.stringify({
      password: "amazon password here",
      username: "owner@example.com",
    }),
    now: "2026-06-01T12:00:00.000Z",
  });

  const calls = [];
  const controller = makeController(calls);
  await controller.runNow(AMAZON_CONNECTOR, {
    connectorInstanceId: "cin_amazon",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_amazon",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].staticSecretEnv, {
    AMAZON_PASSWORD: "amazon password here",
    AMAZON_USERNAME: "owner@example.com",
  });
});

test("non-secret static setup fields are injected with the captured credential", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorInstanceId: "cin_personal",
    ownerSubjectId: "owner_1",
    connectorId: GMAIL_CONNECTOR,
    sourceBinding: {
      kind: "static_secret_draft",
      setup_fields: {
        account_email: "owner@example.com",
      },
    },
  });
  await captureStore().capture({
    connectorInstanceId: "cin_personal",
    ownerSubjectId: "owner_1",
    credentialKind: "app_password",
    secret: "personal one here",
    now: "2026-06-01T12:00:00.000Z",
  });

  const calls = [];
  const controller = makeController(calls);
  await controller.runNow(GMAIL_CONNECTOR, {
    connectorInstanceId: "cin_personal",
    manifest: GMAIL_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_personal",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].staticSecretEnv, {
    GMAIL_ADDRESS: "owner@example.com",
    GMAIL_APP_PASSWORD: "personal one here",
    GMAIL_USER: "owner@example.com",
    GOOGLE_APP_PASSWORD_PDPP: "personal one here",
  });
});

test("two mailboxes run with two distinct injected secrets (no process-global collision)", async (t) => {
  freshDb(t);
  seedConnectorInstance({ connectorInstanceId: "cin_personal", ownerSubjectId: "owner_1", connectorId: GMAIL_CONNECTOR });
  seedConnectorInstance({ connectorInstanceId: "cin_work", ownerSubjectId: "owner_1", connectorId: GMAIL_CONNECTOR });
  const store = captureStore();
  await store.capture({
    connectorInstanceId: "cin_personal",
    ownerSubjectId: "owner_1",
    credentialKind: "app_password",
    secret: "personal one here",
    now: "2026-06-01T12:00:00.000Z",
  });
  await store.capture({
    connectorInstanceId: "cin_work",
    ownerSubjectId: "owner_1",
    credentialKind: "app_password",
    secret: "work two distinct",
    now: "2026-06-01T12:00:00.000Z",
  });

  const calls = [];
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
  assert.equal(byInstance.get("cin_personal").GOOGLE_APP_PASSWORD_PDPP, "personal one here");
  assert.equal(byInstance.get("cin_work").GOOGLE_APP_PASSWORD_PDPP, "work two distinct");
  assert.notEqual(
    byInstance.get("cin_personal").GOOGLE_APP_PASSWORD_PDPP,
    byInstance.get("cin_work").GOOGLE_APP_PASSWORD_PDPP,
  );
});

test("a static-secret connection with no captured credential fails closed before child spawn", async (t) => {
  freshDb(t);
  seedConnectorInstance({ connectorInstanceId: "cin_personal", ownerSubjectId: "owner_1", connectorId: GMAIL_CONNECTOR });

  const calls = [];
  const controller = makeController(calls);
  await assert.rejects(
    () =>
      controller.runNow(GMAIL_CONNECTOR, {
        connectorInstanceId: "cin_personal",
        manifest: GMAIL_MANIFEST,
        ownerToken: "owner-token",
        runId: "run_personal",
      }),
    (err) => err && err.code === "credential_not_found",
  );
  // The configured source must not spawn a child that can fall back to
  // deployment-wide provider-account env.
  assert.equal(calls.length, 0);
});

test("a browser-collector connection with no captured static login credential still launches", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorInstanceId: "cin_chatgpt",
    ownerSubjectId: "owner_1",
    connectorId: CHATGPT_CONNECTOR,
    sourceBinding: {
      connector_id: CHATGPT_CONNECTOR,
      enrollment_completed_at: "2026-06-01T12:01:00.000Z",
      enrollment_expires_at: "2026-06-01T14:00:00.000Z",
      kind: "browser_collector",
    },
  });

  const calls = [];
  const controller = makeController(calls);
  await controller.runNow(CHATGPT_CONNECTOR, {
    connectorInstanceId: "cin_chatgpt",
    manifest: CHATGPT_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_chatgpt",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].staticSecretEnv, null);
});

test("a non-static-secret connector receives no injected secret", async (t) => {
  freshDb(t);
  seedConnectorInstance({
    connectorInstanceId: "cin_amazon",
    ownerSubjectId: "owner_1",
    connectorId: NON_SECRET_CONNECTOR,
  });

  const calls = [];
  const controller = makeController(calls);
  await controller.runNow(NON_SECRET_CONNECTOR, {
    connectorInstanceId: "cin_amazon",
    manifest: NON_SECRET_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_amazon",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].staticSecretEnv, null);
});

test("a revoked credential fails the run closed (no stale or process-global secret)", async (t) => {
  freshDb(t);
  seedConnectorInstance({ connectorInstanceId: "cin_personal", ownerSubjectId: "owner_1", connectorId: GMAIL_CONNECTOR });
  const store = captureStore();
  await store.capture({
    connectorInstanceId: "cin_personal",
    ownerSubjectId: "owner_1",
    credentialKind: "app_password",
    secret: "personal one here",
    now: "2026-06-01T12:00:00.000Z",
  });
  await store.revoke({ connectorInstanceId: "cin_personal", now: "2026-06-01T12:05:00.000Z" });

  const calls = [];
  const controller = makeController(calls);
  await assert.rejects(
    () =>
      controller.runNow(GMAIL_CONNECTOR, {
        connectorInstanceId: "cin_personal",
        manifest: GMAIL_MANIFEST,
        ownerToken: "owner-token",
        runId: "run_personal",
      }),
    (err) => err && err.code === "credential_revoked",
  );
  // The run was refused before the connector was ever spawned.
  assert.equal(calls.length, 0);
});

test("a resolver failure occurs before managed browser-surface acquisition", async (t) => {
  freshDb(t);
  seedConnectorInstance({ connectorInstanceId: "cin_personal", ownerSubjectId: "owner_1", connectorId: GMAIL_CONNECTOR });

  const calls = [];
  const managerCalls = [];
  const controller = createController({
    browserSurfaceLeaseManager: {
      isManagedConnector: (connectorId) => {
        managerCalls.push(connectorId);
        return true;
      },
    },
    connectorPathResolver: () => "/tmp/connector.ts",
    logger: { error: () => {}, warn: () => {} },
    ownerSubjectId: "owner_1",
    resolveStaticSecretRunEnv: () => {
      const err = new Error("credential revoked");
      err.code = "credential_revoked";
      throw err;
    },
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return Promise.resolve({ status: "succeeded", records_emitted: 0 });
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
    (err) => err && err.code === "credential_revoked",
  );

  // Static-secret failures are resolved before taking runtime resources, so a
  // revoked credential cannot leak a browser-surface lease or spawn a child.
  assert.deepEqual(managerCalls, []);
  assert.equal(calls.length, 0);
});
