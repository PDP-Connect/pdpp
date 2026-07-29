// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";

// The orchestration seam takes the connector-package injection helpers as
// injected dependencies (it does not hard-wire a cross-package import). The
// reference test suite runs under bare `node --test` (no tsx), so it cannot load
// the connector package's `.ts` runner barrel; instead it injects local stand-ins
// that mirror the real registry shape. The REAL `buildConnectionScopedSecretEnv`
// / `isStaticSecretConnector` are proven directly, including a live spawn-path
// run, in packages/polyfill-connectors/src/static-secret-injection.test.ts. This
// suite proves the store<->seam fail-closed contract.
interface StaticSecretDescriptor {
  credentialKind: string;
  secretEnvVars: string[];
}

const STATIC_SECRET_REGISTRY: Record<string, StaticSecretDescriptor> = {
  chatgpt: { credentialKind: "username_password", secretEnvVars: ["CHATGPT_PASSWORD"] },
  github: { credentialKind: "personal_access_token", secretEnvVars: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"] },
  gmail: { credentialKind: "app_password", secretEnvVars: ["GOOGLE_APP_PASSWORD_PDPP", "GMAIL_APP_PASSWORD"] },
};
function isStaticSecretConnector(connectorId: string): boolean {
  return Object.hasOwn(STATIC_SECRET_REGISTRY, connectorId);
}
function buildConnectionScopedSecretEnv(connectorId: string, recovered: { secret: string }): Record<string, string> {
  const descriptor = STATIC_SECRET_REGISTRY[connectorId];
  const fragment: Record<string, string> = {};
  if (!descriptor) {
    return fragment;
  }
  for (const envVar of descriptor.secretEnvVars) {
    fragment[envVar] = recovered.secret;
  }
  return fragment;
}

import {
  ConnectorInstanceCredentialError,
  createSqliteConnectorInstanceCredentialStore,
} from "../server/stores/connector-instance-credential-store.ts";
import {
  resolveStaticSecretRunEnv as resolveStaticSecretRunEnvUntyped,
  StaticSecretRunCredentialError,
} from "../server/stores/static-secret-run-credentials.ts";

// `resolveStaticSecretRunEnv` is untyped JS with no annotated parameters; the
// real runtime contract is exactly this shape (verified against the source
// above), so this restates it rather than leaving every call site with
// implicit-any args.
type ResolveStaticSecretRunEnv = (args: {
  connectorId: string;
  connectorInstanceId: string;
  ownerSubjectId?: string | undefined;
  sourceBinding: unknown;
  credentialStore: unknown;
  isStaticSecretConnector: (connectorId: string) => boolean;
  buildConnectionScopedSecretEnv: (connectorId: string, recovered: { secret: string }) => Record<string, string>;
}) => Promise<Record<string, string>>;

const resolveStaticSecretRunEnv = resolveStaticSecretRunEnvUntyped as ResolveStaticSecretRunEnv;

const NOW = "2026-06-01T12:00:00.000Z";
const LATER = "2026-06-01T12:05:00.000Z";
const LATEST = "2026-06-01T12:10:00.000Z";
const TEST_KEY = "test-operator-key-do-not-use-in-prod";
const APP_PASSWORD = "abcd efgh ijkl mnop";
const ROTATED = "zzzz yyyy xxxx wwww";

type CredentialStore = ReturnType<typeof createSqliteConnectorInstanceCredentialStore>;

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
    NOW
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
    NOW,
    NOW
  );
}

function withStore(fn: (store: CredentialStore) => Promise<void>): () => Promise<void> {
  return async () => {
    initDb(":memory:");
    try {
      const store = createSqliteConnectorInstanceCredentialStore({
        env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY },
      });
      await fn(store);
    } finally {
      closeDb();
    }
  };
}

function resolveEnv(
  store: CredentialStore,
  {
    connectorId,
    connectorInstanceId,
    ownerSubjectId,
    sourceBinding,
  }: {
    connectorId: string;
    connectorInstanceId: string;
    ownerSubjectId?: string | undefined;
    sourceBinding?: unknown;
  }
): Promise<Record<string, string>> {
  return resolveStaticSecretRunEnv({
    buildConnectionScopedSecretEnv,
    connectorId,
    connectorInstanceId,
    credentialStore: store,
    isStaticSecretConnector,
    ownerSubjectId,
    sourceBinding,
  });
}

test(
  "an active credential resolves a connection-scoped run env fragment",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    const env = await resolveEnv(store, {
      connectorId: "gmail",
      connectorInstanceId: "cin_a",
      ownerSubjectId: "owner_1",
    });
    assert.equal(env.GOOGLE_APP_PASSWORD_PDPP, APP_PASSWORD);
    assert.equal(env.GMAIL_APP_PASSWORD, APP_PASSWORD);
  })
);

test(
  "a missing credential fails the run closed (no env fragment)",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await assert.rejects(
      () => resolveEnv(store, { connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_not_found"
    );
  })
);

test(
  "a browser-session source may launch without an optional static login credential",
  withStore(async (store) => {
    const sourceBinding = {
      connector_id: "chatgpt",
      enrollment_completed_at: "2026-06-01T12:01:00.000Z",
      enrollment_expires_at: "2026-06-01T14:00:00.000Z",
      kind: "browser_collector",
    };
    seedConnectorInstance({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    const env = await resolveEnv(store, {
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    assert.equal(env, null);
  })
);

test(
  "a browser-session source ignores a revoked optional static login credential",
  withStore(async (store) => {
    const sourceBinding = {
      connector_id: "chatgpt",
      enrollment_completed_at: "2026-06-01T12:01:00.000Z",
      enrollment_expires_at: "2026-06-01T14:00:00.000Z",
      kind: "browser_collector",
    };
    seedConnectorInstance({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    await store.capture({
      connectorInstanceId: "cin_chatgpt",
      credentialKind: "username_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: "not-used-after-revoke",
    });
    await store.revoke({ connectorInstanceId: "cin_chatgpt", now: LATER });
    const env = await resolveEnv(store, {
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    assert.equal(env, null);
  })
);

test(
  "a browser-session source ignores a rejected optional static login credential",
  withStore(async (store) => {
    const sourceBinding = {
      connector_id: "chatgpt",
      enrollment_completed_at: "2026-06-01T12:01:00.000Z",
      enrollment_expires_at: "2026-06-01T14:00:00.000Z",
      kind: "browser_collector",
    };
    seedConnectorInstance({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    await store.capture({
      connectorInstanceId: "cin_chatgpt",
      credentialKind: "username_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: "not-used-after-rejection",
    });
    await store.markRejected({
      connectorInstanceId: "cin_chatgpt",
      reason: "provider rejected stored credential",
      rejectedAt: LATER,
    });
    const env = await resolveEnv(store, {
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    assert.equal(env, null);
  })
);

test(
  "a revoked credential fails the run closed; a run cannot authenticate with a stale secret",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    await store.revoke({ connectorInstanceId: "cin_a", now: LATER });
    await assert.rejects(
      () => resolveEnv(store, { connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_revoked"
    );
  })
);

test(
  "a rejected credential fails the run closed; a run cannot keep retrying stale provider credentials",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    await store.markRejected({
      connectorInstanceId: "cin_a",
      reason: "provider rejected stored credential",
      rejectedAt: LATER,
    });
    await assert.rejects(
      () => resolveEnv(store, { connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_rejected"
    );
  })
);

test(
  "a deleted credential fails the run closed and does not resurrect",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    await store.delete("cin_a");
    await assert.rejects(
      () => resolveEnv(store, { connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_not_found"
    );
  })
);

test(
  "after an explicit re-capture, the run resolves the new secret (not the revoked one)",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    await store.revoke({ connectorInstanceId: "cin_a", now: LATER });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: LATEST,
      ownerSubjectId: "owner_1",
      secret: ROTATED,
    });
    const env = await resolveEnv(store, {
      connectorId: "gmail",
      connectorInstanceId: "cin_a",
      ownerSubjectId: "owner_1",
    });
    assert.equal(env.GOOGLE_APP_PASSWORD_PDPP, ROTATED);
  })
);

test(
  "two connections resolve two distinct run envs (no process-global collision at the seam)",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_personal", ownerSubjectId: "owner_1" });
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_work", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_personal",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: "personal one here",
    });
    await store.capture({
      connectorInstanceId: "cin_work",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: "work two distinct",
    });
    const personal = await resolveEnv(store, { connectorId: "gmail", connectorInstanceId: "cin_personal" });
    const work = await resolveEnv(store, { connectorId: "gmail", connectorInstanceId: "cin_work" });
    assert.equal(personal.GOOGLE_APP_PASSWORD_PDPP, "personal one here");
    assert.equal(work.GOOGLE_APP_PASSWORD_PDPP, "work two distinct");
    assert.notEqual(personal.GOOGLE_APP_PASSWORD_PDPP, work.GOOGLE_APP_PASSWORD_PDPP);
  })
);

test(
  "a non-static-secret connector is refused at the seam",
  withStore(async (store) => {
    await assert.rejects(
      () => resolveEnv(store, { connectorId: "anthropic", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof StaticSecretRunCredentialError && err.code === "not_a_static_secret_connector"
    );
  })
);
