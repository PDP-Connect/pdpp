// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";

/**
 * Both Google-family connectors (Data Portability, Calendar, Contacts) must
 * be independently reachable and simultaneously active in one process
 * through the ONE generic, manifest-driven dispatcher (`buildGenericProviderAuthExchanger`
 * / `generic-dispatch.ts`, server/index.ts) — it routes each connector to
 * its own manifest-declared adapter (`exchanger_kind`) without either
 * adapter knowing the other exists. This exercises the real production
 * wiring path (no injected `providerAuthExchanger`), unlike the
 * single-adapter test files which inject a deterministic exchanger directly.
 *
 * No live Google credentials are used or required: both connectors'
 * `provider-auth-initiate` calls only need deployment-level app config
 * (env vars) to be present, and never make a network call themselves — the
 * authorization URL is built locally.
 */

type TestServer = Awaited<ReturnType<typeof startServer>> & {
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
  body: unknown;
  status: number;
}

async function fetchJson(url: string | URL, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  return { body: text ? JSON.parse(text) : null, status: resp.status };
}

test("both Google provider-auth adapters are simultaneously reachable through one composite dispatcher", async () => {
  const asPublicUrl = "https://pdpp.example";
  const originalEnv = { ...process.env };
  Object.assign(process.env, {
    GOOGLE_DATAPORTABILITY_CLIENT_ID: "dp-client-id",
    GOOGLE_DATAPORTABILITY_CLIENT_SECRET: "dp-client-secret",
    GOOGLE_DATAPORTABILITY_REDIRECT_URI: `${asPublicUrl}/_ref/provider-auth/callback`,
    GOOGLE_OAUTH_CLIENT_ID: "owner-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "owner-client-secret",
  });

  const server = (await startServer({
    asPort: 0,
    asPublicUrl,
    autoEnrollEligibleSchedules: false,
    configuredProviderAuthConnectorKeys: ["google-maps-data-portability", "google-calendar", "google-contacts"],
    dbPath: ":memory:",
    ownerAuthPassword: "",
    ownerAuthSubjectId: "owner_local",
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const readManifest = async (path: string) =>
      JSON.parse(await (await import("node:fs/promises")).readFile(new URL(path, import.meta.url), "utf8"));

    const dataPortabilityManifest = await readManifest(
      "../../packages/polyfill-connectors/manifests/google_maps_data_portability.json"
    );
    const calendarManifest = await readManifest("../../packages/polyfill-connectors/manifests/google_calendar.json");
    const contactsManifest = await readManifest("../../packages/polyfill-connectors/manifests/google_contacts.json");

    for (const manifest of [dataPortabilityManifest, calendarManifest, contactsManifest]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential registration over a fixed short list reads clearer than Promise.all here.
      await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    }

    const dataPortabilityInitiate = await fetchJson(
      `${asUrl}/_ref/connectors/google-maps-data-portability/provider-auth-initiate`,
      { method: "POST" }
    );
    assert.equal(dataPortabilityInitiate.status, 201, JSON.stringify(dataPortabilityInitiate.body));
    const dataPortabilityUrl = new URL(
      (dataPortabilityInitiate.body as { next_step: { authorization_url: string } }).next_step.authorization_url
    );
    // biome-ignore lint/performance/useTopLevelRegex: one-off assertion regex
    assert.match(dataPortabilityUrl.searchParams.get("scope") ?? "", /dataportability/);
    assert.equal(dataPortabilityUrl.searchParams.get("client_id"), "dp-client-id");

    const calendarInitiate = await fetchJson(`${asUrl}/_ref/connectors/google-calendar/provider-auth-initiate`, {
      method: "POST",
    });
    assert.equal(calendarInitiate.status, 201, JSON.stringify(calendarInitiate.body));
    const calendarUrl = new URL(
      (calendarInitiate.body as { next_step: { authorization_url: string } }).next_step.authorization_url
    );
    assert.equal(calendarUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.readonly");
    assert.equal(calendarUrl.searchParams.get("client_id"), "owner-client-id");

    const contactsInitiate = await fetchJson(`${asUrl}/_ref/connectors/google-contacts/provider-auth-initiate`, {
      method: "POST",
    });
    assert.equal(contactsInitiate.status, 201, JSON.stringify(contactsInitiate.body));
    const contactsUrl = new URL(
      (contactsInitiate.body as { next_step: { authorization_url: string } }).next_step.authorization_url
    );
    assert.equal(contactsUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/contacts.readonly");
    assert.equal(contactsUrl.searchParams.get("client_id"), "owner-client-id");

    // The three authorization URLs must never bleed scopes/client config
    // across providers — proves dispatch, not just "some exchanger answered".
    assert.notEqual(dataPortabilityUrl.searchParams.get("client_id"), calendarUrl.searchParams.get("client_id"));
  } finally {
    await closeServer(server);
    process.env = originalEnv;
  }
});

test("generic dispatcher is always mounted; an unconfigured Google-family connector is blocked by deployment readiness (503), not route absence (404)", async () => {
  const originalEnv = { ...process.env };
  for (const key of [
    "GOOGLE_DATAPORTABILITY_CLIENT_ID",
    "GOOGLE_DATAPORTABILITY_CLIENT_SECRET",
    "GOOGLE_DATAPORTABILITY_REDIRECT_URI",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
  ]) {
    delete process.env[key];
  }

  const server = (await startServer({
    asPort: 0,
    asPublicUrl: "https://pdpp.example",
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    ownerAuthSubjectId: "owner_local",
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const calendarManifest = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        new URL("../../packages/polyfill-connectors/manifests/google_calendar.json", import.meta.url),
        "utf8"
      )
    );
    await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(calendarManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const initiate = await fetchJson(`${asUrl}/_ref/connectors/google-calendar/provider-auth-initiate`, {
      method: "POST",
    });
    // The generic dispatcher (server/provider-auth/generic-dispatch.ts) is
    // manifest-driven, never null, and always mounted — readiness is decided
    // per-connector by connection-setup-plan.ts's deployment-readiness check
    // (manifest deployment_config against env / the provider-app-config
    // store), not by whether ANY provider happens to be configured at
    // process start. An unconfigured connector is a 503, not a 404.
    const body = initiate.body as { error?: { code?: string } };
    assert.equal(initiate.status, 503, JSON.stringify(initiate.body));
    assert.equal(body.error?.code, "provider_app_deployment_config_missing");
  } finally {
    await closeServer(server);
    process.env = originalEnv;
  }
});
