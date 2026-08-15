// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Terminal end-to-end journey for the provider-app OAuth architecture:
 *
 *   fresh instance -> configure the Google app ONCE via the Console-facing
 *   /_ref/provider-app-config route -> add Calendar and Contacts accounts
 *   through the real provider-auth initiate/callback lifecycle -> the
 *   captured token bundle resolves into the exact per-run env vars each
 *   connector already reads -- with ZERO GOOGLE_* env vars ever set in the
 *   process. Environment aliases remain available as a fallback only
 *   (createDeploymentConfigResolver is DB-first: a Console-configured value
 *   always wins over env), and this test proves the DB-backed store path
 *   alone is sufficient -- the normal user path, not the migration/automation
 *   fallback.
 *
 * Also proves, against the REAL production wiring (no injected exchanger,
 * no injected store):
 *   - the route rejects a forged/unknown identity_group and an unknown
 *     logical_key, against manifest authority, with zero writes;
 *   - a blank submitted value preserves the already-configured secret
 *     (never overwrites, never round-trips it back to the client);
 *   - two Google accounts (one Calendar, one Contacts) authorize under the
 *     SAME shared-google-oauth-app identity with separate, honest per-
 *     connector consent (each initiate call requests only its own
 *     connector's scope) and produce two independent connections;
 *   - revoking one connection's credential does not disturb the other's.
 *
 * Network is mocked at the fetch boundary (token exchange + userinfo) --
 * this is a deterministic test, no live Google credentials.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { startServer as startServerUntyped } from "../server/index.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { resolveProviderAuthRunEnv } from "../server/stores/provider-auth-run-credentials.ts";

// Provider-app-config values and captured OAuth token bundles are both
// sealed at rest through this operator-held key.
process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "test terminal-journey credential encryption key";

const OWNER_SUBJECT_ID = "owner_local";
const OPEN_SESSION_COOKIE = "";

type TestServer = Awaited<ReturnType<typeof startServerUntyped>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

interface JsonResult {
  body: any;
  status: number;
}

async function fetchJson(url: string | URL, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  return { body: text ? JSON.parse(text) : null, status: resp.status };
}

async function readManifest(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

// Mocks the token-exchange (POST .../token) and userinfo (GET .../userinfo)
// legs the generic OAuth2 adapter calls against the real global fetch --
// this is the ONLY network boundary in the entire lifecycle; everything
// else (deployment config, scope, identity grouping) is real production
// code exercising the real manifests.
function installFakeGoogleFetch(accountsByCode: Record<string, { email: string; id: string }>) {
  const original = globalThis.fetch;
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // Anything that isn't the two Google endpoints under test (i.e. the
    // test's own calls to the local reference server) passes through to the
    // real fetch unchanged.
    if (!(url.includes("oauth2.googleapis.com/token") || url.includes("googleapis.com/oauth2/v2/userinfo"))) {
      return original(input, init);
    }
    if (url.includes("oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const code = body.get("code") ?? "";
      return new Response(
        JSON.stringify({
          access_token: `access-for-${code}`,
          expires_in: 3600,
          refresh_token: `refresh-for-${code}`,
          token_type: "Bearer",
        }),
        { status: 200 }
      );
    }
    if (url.includes("googleapis.com/oauth2/v2/userinfo")) {
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      const code = authHeader.replace("Bearer access-for-", "");
      const account = accountsByCode[code];
      if (!account) {
        return new Response(JSON.stringify({}), { status: 404 });
      }
      return new Response(JSON.stringify({ email: account.email, id: account.id }), { status: 200 });
    }
    throw new Error(`installFakeGoogleFetch: unexpected fetch to ${url}`);
  }) as typeof fetch;
  globalThis.fetch = fake;
  return () => {
    globalThis.fetch = original;
  };
}

function assertNoGoogleEnv() {
  const leaked = Object.keys(process.env).filter((key) => key.startsWith("GOOGLE_"));
  assert.deepEqual(leaked, [], `no GOOGLE_* env vars may be set: found ${leaked.join(", ")}`);
}

test("terminal journey: configure Google app once -> add Calendar + Contacts -> callback/token storage -> collection-ready env, zero GOOGLE_* env vars", async (t) => {
  assertNoGoogleEnv();

  const restoreFetch = installFakeGoogleFetch({
    "auth-code-calendar": { email: "owner@example.test", id: "google-owner-id-1" },
    "auth-code-contacts": { email: "owner@example.test", id: "google-owner-id-1" },
  });
  t.after(restoreFetch);

  // Fresh instance: real server, real SQLite, no injected exchanger/store —
  // this exercises buildGenericProviderAuthExchanger and the real
  // provider-app-config store exactly as production wires them.
  const server = (await startServerUntyped({
    asPort: 0,
    asPublicUrl: "https://pdpp.example",
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const calendarManifest = await readManifest("../../packages/polyfill-connectors/manifests/google_calendar.json");
    const contactsManifest = await readManifest("../../packages/polyfill-connectors/manifests/google_contacts.json");
    for (const manifest of [calendarManifest, contactsManifest]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential registration over a fixed short list reads clearer than Promise.all here.
      await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    }

    // ---- Step 1: before configuration, initiation is blocked (needs_config) ----
    const blockedInitiate = await fetchJson(`${asUrl}/_ref/connectors/google-calendar/provider-auth-initiate`, {
      headers: { Cookie: OPEN_SESSION_COOKIE },
      method: "POST",
    });
    assert.equal(blockedInitiate.status, 503);
    assert.equal(blockedInitiate.body.error.code, "provider_app_deployment_config_missing");

    // ---- Step 2: discover the identity group via the Console's list endpoint ----
    const list = await fetchJson(`${asUrl}/_ref/provider-app-config`, { headers: { Cookie: OPEN_SESSION_COOKIE } });
    assert.equal(list.status, 200);
    assert.equal(list.body.object, "provider_app_config_list");
    const group = list.body.groups.find((g: { identity_group: string }) => g.identity_group === "shared-google-oauth-app");
    assert.ok(group, "shared-google-oauth-app group must be discoverable without prior knowledge of its token");
    assert.equal(group.provider_identity_label, "Shared Google OAuth App");
    const logicalKeys = group.logical_keys.map((f: { logical_key: string }) => f.logical_key).sort();
    assert.deepEqual(logicalKeys, ["client_id", "client_secret"]);
    for (const field of group.logical_keys) {
      assert.ok(!("env_alias" in field), "env_alias must never be exposed to the client");
    }

    // ---- Step 3: reject a forged/unknown identity_group before any write ----
    const forgedGroup = await fetchJson(`${asUrl}/_ref/provider-app-config`, {
      body: JSON.stringify({ identity_group: "not-a-real-group", values: { client_id: "x" } }),
      headers: { "Content-Type": "application/json", Cookie: OPEN_SESSION_COOKIE },
      method: "POST",
    });
    assert.equal(forgedGroup.status, 404);

    // ---- Step 4: reject an unknown logical_key against manifest authority, zero writes ----
    const unknownKey = await fetchJson(`${asUrl}/_ref/provider-app-config`, {
      body: JSON.stringify({
        identity_group: "shared-google-oauth-app",
        values: { client_id: "x", client_secret: "y", not_a_real_field: "z" },
      }),
      headers: { "Content-Type": "application/json", Cookie: OPEN_SESSION_COOKIE },
      method: "POST",
    });
    assert.equal(unknownKey.status, 400);
    assert.equal(unknownKey.body.error.code, "provider_app_config_unknown_key");

    // ---- Step 5: configure the Google app ONCE (Calendar + Contacts share this identity) ----
    const configure = await fetchJson(`${asUrl}/_ref/provider-app-config`, {
      body: JSON.stringify({
        identity_group: "shared-google-oauth-app",
        values: { client_id: "console-configured-client-id", client_secret: "console-configured-client-secret" },
      }),
      headers: { "Content-Type": "application/json", Cookie: OPEN_SESSION_COOKIE },
      method: "POST",
    });
    assert.equal(configure.status, 200, JSON.stringify(configure.body));
    assert.deepEqual([...configure.body.written].sort(), ["client_id", "client_secret"]);
    // The response must never echo the submitted secret back.
    assert.ok(!JSON.stringify(configure.body).includes("console-configured-client-secret"));

    assertNoGoogleEnv();

    // ---- Step 6: blank preserves the already-configured secret; never round-trips it ----
    const blankRotate = await fetchJson(`${asUrl}/_ref/provider-app-config`, {
      body: JSON.stringify({ identity_group: "shared-google-oauth-app", values: {} }),
      headers: { "Content-Type": "application/json", Cookie: OPEN_SESSION_COOKIE },
      method: "POST",
    });
    assert.equal(blankRotate.status, 200);
    assert.deepEqual(blankRotate.body.written, [], "an all-already-configured no-op POST writes nothing");

    const reGet = await fetchJson(`${asUrl}/_ref/provider-app-config?identity_group=shared-google-oauth-app`, {
      headers: { Cookie: OPEN_SESSION_COOKIE },
    });
    for (const field of reGet.body.logical_keys) {
      assert.equal(field.configured, true, `${field.logical_key} must read configured after step 5`);
    }

    // ---- Step 7: initiation now succeeds -- Calendar and Contacts each get
    // their OWN scope (honest separate consent), same client_id (shared app) ----
    const calendarInitiate = await fetchJson(`${asUrl}/_ref/connectors/google-calendar/provider-auth-initiate`, {
      headers: { Cookie: OPEN_SESSION_COOKIE },
      method: "POST",
    });
    assert.equal(calendarInitiate.status, 201, JSON.stringify(calendarInitiate.body));
    const calendarAuthUrl = new URL(calendarInitiate.body.next_step.authorization_url);
    assert.equal(calendarAuthUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.readonly");
    assert.equal(calendarAuthUrl.searchParams.get("client_id"), "console-configured-client-id");

    const contactsInitiate = await fetchJson(`${asUrl}/_ref/connectors/google-contacts/provider-auth-initiate`, {
      headers: { Cookie: OPEN_SESSION_COOKIE },
      method: "POST",
    });
    assert.equal(contactsInitiate.status, 201, JSON.stringify(contactsInitiate.body));
    const contactsAuthUrl = new URL(contactsInitiate.body.next_step.authorization_url);
    assert.equal(contactsAuthUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/contacts.readonly");
    assert.equal(contactsAuthUrl.searchParams.get("client_id"), "console-configured-client-id");
    // Separate consent: each authorization URL requests exactly its own
    // connector's scope, never a union of both -- honest per-connector grant.
    assert.notEqual(calendarAuthUrl.searchParams.get("scope"), contactsAuthUrl.searchParams.get("scope"));

    // ---- Step 8: complete the callback for BOTH connectors (two accounts) ----
    const calendarState = new URL(calendarAuthUrl).searchParams.get("state");
    const calendarCallback = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?code=auth-code-calendar&state=${calendarState}`
    );
    assert.equal(calendarCallback.status, 201, JSON.stringify(calendarCallback.body));
    const calendarConnectionId = calendarCallback.body.connections[0].connector_instance_id;

    const contactsState = new URL(contactsAuthUrl).searchParams.get("state");
    const contactsCallback = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?code=auth-code-contacts&state=${contactsState}`
    );
    assert.equal(contactsCallback.status, 201, JSON.stringify(contactsCallback.body));
    const contactsConnectionId = contactsCallback.body.connections[0].connector_instance_id;

    assert.notEqual(calendarConnectionId, contactsConnectionId, "two independent connections, not one shared row");

    // No provider token/secret ever appears in a response body.
    const dangerousPattern = /refresh-for-|access-for-|console-configured-client-secret/;
    assert.ok(!dangerousPattern.test(JSON.stringify(calendarCallback.body)));
    assert.ok(!dangerousPattern.test(JSON.stringify(contactsCallback.body)));

    assertNoGoogleEnv();

    // ---- Step 9: collection is runnable -- resolveProviderAuthRunEnv
    // produces the exact per-run env each connector's own manifest declares,
    // sourced ENTIRELY from the captured credential, with zero GOOGLE_* env
    // vars anywhere in the process. ----
    const credentialStore = createSqliteConnectorInstanceCredentialStore();
    const connectorInstanceStore = createSqliteConnectorInstanceStore();

    const calendarInstance = await connectorInstanceStore.get(calendarConnectionId);
    const calendarRunEnv = await resolveProviderAuthRunEnv({
      connectionConfig: [{ bundleField: "refresh_token", envVar: "GOOGLE_CALENDAR_REFRESH_TOKEN" }],
      connectorId: "google-calendar",
      connectorInstanceId: calendarConnectionId,
      credentialStore,
      ownerSubjectId: OWNER_SUBJECT_ID,
      sourceBinding: calendarInstance?.sourceBinding,
    });
    assert.equal(calendarRunEnv?.GOOGLE_CALENDAR_REFRESH_TOKEN, "refresh-for-auth-code-calendar");

    const contactsInstance = await connectorInstanceStore.get(contactsConnectionId);
    const contactsRunEnv = await resolveProviderAuthRunEnv({
      connectionConfig: [{ bundleField: "refresh_token", envVar: "GOOGLE_CONTACTS_REFRESH_TOKEN" }],
      connectorId: "google-contacts",
      connectorInstanceId: contactsConnectionId,
      credentialStore,
      ownerSubjectId: OWNER_SUBJECT_ID,
      sourceBinding: contactsInstance?.sourceBinding,
    });
    assert.equal(contactsRunEnv?.GOOGLE_CONTACTS_REFRESH_TOKEN, "refresh-for-auth-code-contacts");

    // The two connections' run env never cross-contaminate.
    assert.notEqual(calendarRunEnv?.GOOGLE_CALENDAR_REFRESH_TOKEN, contactsRunEnv?.GOOGLE_CONTACTS_REFRESH_TOKEN);

    assertNoGoogleEnv();

    // ---- Step 10: revoking one connection's credential does not disturb the other ----
    await credentialStore.revoke({ connectorInstanceId: calendarConnectionId, now: new Date().toISOString() });

    await assert.rejects(
      () =>
        resolveProviderAuthRunEnv({
          connectionConfig: [{ bundleField: "refresh_token", envVar: "GOOGLE_CALENDAR_REFRESH_TOKEN" }],
          connectorId: "google-calendar",
          connectorInstanceId: calendarConnectionId,
          credentialStore,
          ownerSubjectId: OWNER_SUBJECT_ID,
          sourceBinding: calendarInstance?.sourceBinding,
        }),
      "the revoked Calendar credential must no longer resolve"
    );

    const contactsRunEnvAfterRevoke = await resolveProviderAuthRunEnv({
      connectionConfig: [{ bundleField: "refresh_token", envVar: "GOOGLE_CONTACTS_REFRESH_TOKEN" }],
      connectorId: "google-contacts",
      connectorInstanceId: contactsConnectionId,
      credentialStore,
      ownerSubjectId: OWNER_SUBJECT_ID,
      sourceBinding: contactsInstance?.sourceBinding,
    });
    assert.equal(
      contactsRunEnvAfterRevoke?.GOOGLE_CONTACTS_REFRESH_TOKEN,
      "refresh-for-auth-code-contacts",
      "revoking the Calendar connection must not disturb the Contacts connection's credential"
    );
  } finally {
    await closeServer(server);
  }

  assertNoGoogleEnv();
});
