// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  approveInline,
  buildParRequest,
  denyInline,
  introspectToken,
  queryStreamRecords,
  queryStreams,
  registerClient,
  stageParRequest,
} from "../examples/third-party-app/lib/flow.ts";
import { buildDefaultDraft as buildDefaultDraftUntyped } from "../examples/third-party-app/server.ts";
import { runConnector } from "../runtime/index.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } from "../server/reference-local-defaults.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

/**
 * Admission fixture for `runConnector`'s required `admitRunConnection`
 * callback, mirroring the production wiring in `server/index.ts`'s
 * `createController({ admitRunConnection: ... })`: calls the real
 * `admitOwnerRunConnection` against a request-scoped connector-instance
 * store so it materializes a genuine `connector_instances` row for
 * `ownerSubjectId`. Downstream flow-example assertions (`registerClient`,
 * `queryStreamRecords`, etc.) exercise the real HTTP surfaces, which
 * validate ingested records against that same real store — a naive
 * id-echoing double would leave the seeded run's records unreachable
 * (`connector_instance_not_found`/owner mismatch).
 */
function fakeAdmitRunConnection(
  ownerSubjectId: string
): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const resolvedOwnerSubjectId = requestedOwnerSubjectId || ownerSubjectId;
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: resolvedOwnerSubjectId,
    });
    return {
      connectorId: namespace.connectorId,
      connectorInstanceId: namespace.connectorInstanceId,
      ownerSubjectId: resolvedOwnerSubjectId,
    };
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

/**
 * `server/index.js`, `runtime/index.ts`, and `examples/third-party-app/**`
 * are unchecked JS (allowJs, checkJs:false); boundary-cast the few shapes
 * this file actually touches rather than at every call site.
 */
interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
}
interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  ownerAuthPassword?: string;
  ownerAuthSubjectId?: string;
  quiet?: boolean;
  rsPort?: number;
}
const startServer = startServerUntyped as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

interface ConnectorManifest {
  connector_id: string;
  streams: { name: string }[];
}

interface DefaultDraft {
  accessMode: string;
  clientName: string;
  initialAccessToken: string;
  pastedToken: string;
  purposeCode: string;
  purposeDescription: string;
  queryStream: string;
  sourceId: string;
  sourceKind: "connector" | "provider_native";
  streamName: string;
  subjectId: string;
}
const buildDefaultDraft = buildDefaultDraftUntyped as unknown as () => DefaultDraft;

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv: ClosableServer["asServer"]) =>
    new Promise<void>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function registerSpotify(asUrl: string): Promise<ConnectorManifest> {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8")
  ) as ConnectorManifest;
  const response = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(spotifyManifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`connector registration failed (${response.status})`);
  }
  return spotifyManifest;
}

function firstStream(manifest: ConnectorManifest): string {
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const stream = manifest.streams[0];
  assert.ok(stream, "manifest must declare at least one stream");
  return stream.name;
}

interface DeviceAuthorizationBody {
  device_code: string;
  user_code: string;
}
interface TokenBody {
  access_token: string;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(deviceResp.status, 200);
  const device = (await deviceResp.json()) as DeviceAuthorizationBody;

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);

  const tokenResp = await fetch(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(tokenResp.status, 200);
  const tokenBody = (await tokenResp.json()) as TokenBody;
  return tokenBody.access_token;
}

async function seedSpotify({
  asUrl,
  rsUrl,
  manifest,
  subjectId = "owner_local",
}: {
  asUrl: string;
  rsUrl: string;
  manifest: ConnectorManifest;
  subjectId?: string;
}) {
  const ownerToken = await issueOwnerToken(asUrl, subjectId);
  const result = await runConnector({
    admitRunConnection: fakeAdmitRunConnection(subjectId),
    collectionMode: "full_refresh",
    connectorId: manifest.connector_id,
    connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
    manifest: manifest as unknown as Record<string, unknown>,
    ownerToken,
    rsUrl,
    state: null,
  });
  assert.equal(result.status, "succeeded");
}

test("example client completes the current reference flow on the inline-approval path", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotifyManifest = await registerSpotify(asUrl);
    await seedSpotify({ asUrl, manifest: spotifyManifest, rsUrl });

    const registered = await registerClient({
      asUrl,
      initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
      metadata: { client_name: "Reference Example Client", token_endpoint_auth_method: "none" },
    });
    assert.equal(typeof registered.client_id, "string");
    assert.ok(registered.client_id.length > 0);

    const parRequest = buildParRequest({
      accessMode: "single_use",
      clientId: registered.client_id,
      clientName: "Reference Example Client",
      purposeCode: "https://pdpp.org/purpose/financial_planning",
      purposeDescription: "example-client test",
      sourceId: spotifyManifest.connector_id,
      sourceKind: "connector",
      streamName: firstStream(spotifyManifest),
    });
    const staged = await stageParRequest({ asUrl, request: parRequest });
    assert.equal(typeof staged.request_uri, "string");
    assert.ok(staged.request_uri.length > 0);

    const approval = await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: "owner_local",
    });
    assert.equal(typeof approval.token, "string");
    assert.ok(approval.token.length > 0);
    assert.equal(typeof approval.grantId, "string");

    const introspection = await introspectToken({ asUrl, token: approval.token });
    assert.equal(introspection.active, true);

    const streams = await queryStreams({ rsUrl, token: approval.token });
    assert.ok(streams);
    assert.ok(Array.isArray(streams.streams) || typeof streams === "object");
  } finally {
    await closeServer(server);
  }
});

test("example client denies a staged request on the inline path", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotifyManifest = await registerSpotify(asUrl);

    const registered = await registerClient({
      asUrl,
      initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
      metadata: { client_name: "Reference Example Client", token_endpoint_auth_method: "none" },
    });
    const staged = await stageParRequest({
      asUrl,
      request: buildParRequest({
        accessMode: "single_use",
        clientId: registered.client_id,
        clientName: "Reference Example Client",
        purposeCode: "https://pdpp.org/purpose/financial_planning",
        purposeDescription: "deny path",
        sourceId: spotifyManifest.connector_id,
        sourceKind: "connector",
        streamName: firstStream(spotifyManifest),
      }),
    });

    const result = await denyInline({ asUrl, requestUri: staged.request_uri });
    assert.equal(result.ok, true);

    // After denial, an approval attempt should fail honestly.
    await assert.rejects(approveInline({ asUrl, requestUri: staged.request_uri, subjectId: "owner_local" }));
  } finally {
    await closeServer(server);
  }
});

test("example client surfaces owner-auth enabled as an honest failure instead of silently breaking", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "hunter2",
    ownerAuthSubjectId: "owner_local",
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotifyManifest = await registerSpotify(asUrl);

    const registered = await registerClient({
      asUrl,
      initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
      metadata: { client_name: "Reference Example Client", token_endpoint_auth_method: "none" },
    });
    const staged = await stageParRequest({
      asUrl,
      request: buildParRequest({
        accessMode: "single_use",
        clientId: registered.client_id,
        clientName: "Reference Example Client",
        purposeCode: "https://pdpp.org/purpose/financial_planning",
        purposeDescription: "owner-auth enabled",
        sourceId: spotifyManifest.connector_id,
        sourceKind: "connector",
        streamName: firstStream(spotifyManifest),
      }),
    });

    // When the owner-auth placeholder is enabled, the inline shortcut cannot
    // succeed. The example app surfaces that as an `ownerAuthEnabled: true`
    // error rather than a silent failure.
    await assert.rejects(
      approveInline({ asUrl, requestUri: staged.request_uri, subjectId: "owner_local" }),
      (err: unknown) => !!err && (err as { ownerAuthEnabled?: boolean }).ownerAuthEnabled === true
    );
  } finally {
    await closeServer(server);
  }
});

test("example client shipped defaults stage a PAR request and reach records against a normally-registered reference manifest", async () => {
  // This test is the guardrail for the "follow the five sections top to
  // bottom" promise in the example app README: submit the form as-shipped,
  // without editing it, after registering the reference Spotify manifest the
  // normal way. If the shipped connector id or stream name drifts out of
  // the manifest, this test fails loudly.
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotifyManifest = await registerSpotify(asUrl);
    const draft = buildDefaultDraft();
    await seedSpotify({ asUrl, manifest: spotifyManifest, rsUrl, subjectId: draft.subjectId });

    // The shipped defaults must correspond to the real manifest.
    assert.equal(
      draft.sourceId,
      spotifyManifest.connector_id,
      "shipped default source.id must match the registered spotify manifest"
    );
    assert.ok(
      spotifyManifest.streams.some((s) => s.name === draft.streamName),
      `shipped default streamName "${draft.streamName}" must be declared by the spotify manifest`
    );

    const registered = await registerClient({
      asUrl,
      initialAccessToken: draft.initialAccessToken,
      metadata: { client_name: draft.clientName, token_endpoint_auth_method: "none" },
    });

    const parRequest = buildParRequest({
      accessMode: draft.accessMode,
      clientId: registered.client_id,
      clientName: draft.clientName,
      purposeCode: draft.purposeCode,
      purposeDescription: draft.purposeDescription,
      sourceId: draft.sourceId,
      sourceKind: draft.sourceKind,
      streamName: draft.streamName,
    });
    const staged = await stageParRequest({ asUrl, request: parRequest });
    assert.equal(typeof staged.request_uri, "string");
    assert.ok(staged.request_uri.length > 0);

    const approval = await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: draft.subjectId,
    });
    assert.equal(typeof approval.token, "string");

    const records = await queryStreamRecords({
      rsUrl,
      streamName: draft.streamName,
      token: approval.token,
    });
    assert.ok(records, "record list response should be truthful, not empty");
  } finally {
    await closeServer(server);
  }
});
