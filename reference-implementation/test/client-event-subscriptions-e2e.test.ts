// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end proof for outbound client event subscriptions.
 *
 * Starts a real reference server (AS + RS, in-memory SQLite), registers the
 * Spotify connector, runs the full grant flow to mint a client bearer,
 * stands up a local HTTP receiver, creates a subscription, completes the
 * verification handshake, triggers a deterministic test event and a real
 * record ingest, asserts that the receiver gets signed callbacks with
 * verifiable HMACs, and confirms the hint cursor lets the client fetch the
 * changed record via the existing read API.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { signEvent, verifySignatureHeader } from "../operations/rs-client-event-deliver/index.ts";
import {
  deleteRegisteredClient,
  introspect,
  issueOwnerToken as issueOwnerTokenRecord,
  registerDynamicClient,
} from "../server/auth.ts";
import { startServer } from "../server/index.ts";
import { getSubscriptionSummary } from "../server/stores/client-event-subscription-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function fetchJson<T = unknown>(url: string, opts: RequestInit = {}): Promise<{ status: number; body: T }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body: body as T, status: resp.status };
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
}

interface TokenResponse {
  access_token: string;
}

async function issueOwnerDeviceToken(asUrl: string, clientId = "cli_longview"): Promise<string> {
  const device = (
    await fetchJson<DeviceAuthorization>(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body;
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "e2e_owner", user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokResp = await fetchJson<TokenResponse>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return tokResp.body.access_token;
}

interface ParResponse {
  request_uri: string;
}

interface ApprovedGrant {
  token: string;
}

async function approveClientGrant(asUrl: string, connectorId: string, streamName: string): Promise<string> {
  const par = (
    await fetchJson<ParResponse>(`${asUrl}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/analytics",
            purpose_description: "e2e subscription test",
            source: { id: connectorId, kind: "connector" },
            streams: [{ fields: ["id", "name"], name: streamName }],
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_id: "longview",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  ).body;
  const approved = (
    await fetchJson<ApprovedGrant>(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ request_uri: par.request_uri, subject_id: "e2e_owner" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  ).body;
  return approved.token;
}

interface CloudEventPayload {
  data?: {
    subscription_id?: string;
    stream?: string;
    changes_since?: string;
    [key: string]: unknown;
  };
  occurred_at?: string;
  pdppversion?: string;
  specversion?: string;
  subscription_id?: string;
  time?: string;
  type: string;
  [key: string]: unknown;
}

interface ReceiverEvent {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  method: string | undefined;
  payload?: CloudEventPayload | null;
  url: string | undefined;
}

interface Receiver {
  close: () => Promise<void>;
  events: ReceiverEvent[];
  url: string;
}

function startReceiver({
  challenge = null,
  respondWith = "ok",
}: {
  challenge?: string | null;
  respondWith?: string;
} = {}): Promise<Receiver> {
  const events: ReceiverEvent[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const record: ReceiverEvent = {
          body,
          headers: { ...req.headers },
          method: req.method,
          url: req.url,
        };
        events.push(record);
        if (req.headers["webhook-signature"] && body.length) {
          let payload: CloudEventPayload | null = null;
          try {
            payload = JSON.parse(body) as CloudEventPayload;
            // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
          } catch {}
          record.payload = payload;
          if (payload?.type === "pdpp.subscription.verify") {
            // echo challenge back
            res.writeHead(200, { "Content-Type": "application/json" });
            const reply = challenge === "wrong" ? { challenge: "WRONG" } : { challenge: payload.data?.challenge };
            res.end(JSON.stringify(reply));
            return;
          }
        }
        if (respondWith === "fail") {
          res.writeHead(500);
          res.end("fail");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object", "server.address() must return an AddressInfo");
      const { port } = address;
      resolve({
        close: () => new Promise<void>((r) => server.close(() => r())),
        events,
        url: `http://127.0.0.1:${port}/hook`,
      });
    });
  });
}

async function waitForReceiverEvent(
  receiver: Receiver,
  predicate: (e: ReceiverEvent) => boolean,
  timeoutMs = 5000
): Promise<ReceiverEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = receiver.events.find(predicate);
    if (hit) {
      return hit;
    }
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for receiver event");
}

/** Narrows a ReceiverEvent's optional `payload` (and its optional `data`) to non-null, failing the assertion if absent. */
function payloadOf(event: ReceiverEvent): CloudEventPayload & { data: NonNullable<CloudEventPayload["data"]> } {
  assert.ok(event.payload, "expected a parsed CloudEvents payload on the receiver event");
  assert.ok(event.payload.data, "expected a data block on the CloudEvents payload");
  return event.payload as CloudEventPayload & { data: NonNullable<CloudEventPayload["data"]> };
}

function headerString(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name];
  assert.ok(typeof value === "string", `expected header "${name}" to be a single string value`);
  return value;
}

function verifySignature(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  body: string
): boolean {
  const ts = Number(headers["webhook-timestamp"]);
  const id = headers["webhook-id"];
  const sig = headers["webhook-signature"];
  if (!(id && sig) || typeof id !== "string" || typeof sig !== "string" || !Number.isFinite(ts)) {
    return false;
  }
  // Standard Webhooks libraries verify by recomputing the canonical signature
  // and comparing against any v1 token in the header. Use both the helper and
  // an independent recompute to guard against future drift.
  if (!verifySignatureHeader(secret, id, ts, body, sig)) {
    return false;
  }
  return signEvent(secret, id, ts, body).split(",")[1] === sig.split(",")[1];
}

/**
 * Guard: every received CloudEvents envelope must use only context attributes
 * that conform to CloudEvents §context-attribute-naming (lowercase alphanumeric,
 * no underscores). PDPP fields that don't satisfy that rule live in `data`.
 * `data` itself is a standard attribute and its keys are free-form.
 */
interface SubscriptionCreateBody {
  secret: string;
  subscription_id: string;
}

interface SubscriptionDetailBody {
  authority_kind?: string;
  grant_id?: string | null;
  status?: string;
  subscription_id?: string;
}

interface SubscriptionListBody {
  data: SubscriptionDetailBody[];
}

interface RecordEnvelope {
  data?: { id?: string; [key: string]: unknown };
  id?: string;
  [key: string]: unknown;
}

interface RecordsListBody {
  data: RecordEnvelope[];
}

function assertCloudEventsTopLevelShape(payload: CloudEventPayload | null | undefined, label: string) {
  assert.ok(payload, `${label}: payload present`);
  for (const key of Object.keys(payload)) {
    assert.ok(
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      /^[a-z0-9]+$/.test(key),
      `${label}: top-level CloudEvents attribute ${JSON.stringify(key)} must be lowercase alphanumeric (no underscores)`
    );
  }
  assert.equal(payload.specversion, "1.0", `${label}: specversion`);
  assert.equal(payload.pdppversion, "1", `${label}: pdppversion`);
  assert.equal(typeof payload.time, "string", `${label}: standard \`time\` attribute`);
  assert.equal(payload.occurred_at, undefined, `${label}: legacy occurred_at must be absent`);
  assert.equal(payload.subscription_id, undefined, `${label}: subscription_id must live in data, not top-level`);
}

test("client event subscriptions deliver signed hints end-to-end", async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const receiver = await startReceiver();

  try {
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
    const connectorId = spotifyManifest.connector_id;
    assert.equal(
      (
        await fetch(`${asUrl}/connectors`, {
          body: JSON.stringify(spotifyManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      ).status,
      201
    );

    const ownerToken = await issueOwnerDeviceToken(asUrl);
    const clientToken = await approveClientGrant(asUrl, connectorId, "top_artists");

    // Create subscription
    const createResp = await fetchJson<SubscriptionCreateBody>(`${rsUrl}/v1/event-subscriptions`, {
      body: JSON.stringify({ callback_url: receiver.url }),
      headers: { Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(createResp.status, 201);
    const { subscription_id, secret } = createResp.body;
    assert.ok(secret.startsWith("whsec_"), `secret must use Standard Webhooks prefix; got ${secret}`);

    // Verification handshake should complete via the immediate-tick on create.
    const verifyEvent = await waitForReceiverEvent(receiver, (e) => e.payload?.type === "pdpp.subscription.verify");
    assert.equal(verifyEvent.headers["webhook-id"], payloadOf(verifyEvent).id);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(headerString(verifyEvent.headers, "webhook-signature"), /^v1,[A-Za-z0-9+/=]+$/);
    assert.equal(verifyEvent.headers["pdpp-event-signature"], undefined);
    // CloudEvents JSON structured mode: content-type identifies the cloudevents+json media type.
    assert.equal(
      verifyEvent.headers["content-type"],
      "application/cloudevents+json; charset=utf-8",
      "delivery content-type must be CloudEvents structured-mode media type"
    );
    assertCloudEventsTopLevelShape(verifyEvent.payload, "verify event");
    assert.equal(payloadOf(verifyEvent).data.subscription_id, subscription_id);
    assert.equal(
      verifySignature(secret, verifyEvent.headers, verifyEvent.body),
      true,
      "verify event signature must validate against the raw structured-mode body"
    );

    // Allow a moment for the verification state transition.
    await new Promise((r) => setTimeout(r, 25));

    // Confirm subscription transitioned to active.
    const subBefore = await fetchJson<SubscriptionDetailBody>(`${rsUrl}/v1/event-subscriptions/${subscription_id}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(subBefore.body.status, "active");

    // Trigger a deterministic test event.
    const testResp = await fetchJson(`${rsUrl}/v1/event-subscriptions/${subscription_id}/test-event`, {
      headers: { Authorization: `Bearer ${clientToken}` },
      method: "POST",
    });
    assert.equal(testResp.status, 202);
    const testHit = await waitForReceiverEvent(receiver, (e) => e.payload?.type === "pdpp.subscription.test");
    assert.equal(verifySignature(secret, testHit.headers, testHit.body), true);
    assertCloudEventsTopLevelShape(testHit.payload, "test event");
    assert.equal(payloadOf(testHit).data.subscription_id, subscription_id);

    // Real record ingest to drive a records.changed hint.
    const ingestResp = await fetch(`${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(connectorId)}`, {
      body: JSON.stringify({
        data: { id: "artist_e2e_1", name: "E2E Artist" },
        emitted_at: new Date().toISOString(),
        key: "artist_e2e_1",
      }),
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    });
    assert.equal(ingestResp.status, 200);

    // The post-commit hook enqueues; force a worker tick to deliver promptly.
    const recordsHit = await (async (): Promise<ReceiverEvent> => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const hit = receiver.events.find((e) => e.payload?.type === "pdpp.records.changed");
        if (hit) {
          return hit;
        }
        // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("records.changed hint never arrived");
    })();
    assert.equal(verifySignature(secret, recordsHit.headers, recordsHit.body), true);
    assertCloudEventsTopLevelShape(recordsHit.payload, "records.changed event");
    const recordsHitData = payloadOf(recordsHit).data;
    assert.equal(recordsHitData.subscription_id, subscription_id);
    assert.equal(recordsHitData.stream, "top_artists");
    assert.ok(recordsHitData.changes_since);
    // Projection-safety: no record body.
    assert.equal("record" in recordsHitData, false);
    assert.equal("record_json" in recordsHitData, false);

    // Use the hint cursor to fetch the actual change via the existing read.
    // The cursor exposed in the hint is opaque to clients; this exercises the
    // exact value the receiver got in the callback.
    const changesSince = recordsHitData.changes_since;
    assert.ok(changesSince);
    const readResp = await fetchJson<RecordsListBody>(
      `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(changesSince)}`,
      { headers: { Authorization: `Bearer ${clientToken}` } }
    );
    assert.equal(readResp.status, 200);
    assert.ok(Array.isArray(readResp.body.data));
    const visible = readResp.body.data.find((r) => r.id === "artist_e2e_1" || r.data?.id === "artist_e2e_1");
    assert.ok(visible, "client must be able to read the changed record");
  } finally {
    await receiver.close();
    await closeServer(server);
  }
});

test("grant revoke disables subscription and notifies client", async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const receiver = await startReceiver();

  try {
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
    const connectorId = spotifyManifest.connector_id;
    await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const ownerToken = await issueOwnerDeviceToken(asUrl);
    const clientToken = await approveClientGrant(asUrl, connectorId, "top_artists");

    const create = await fetchJson<SubscriptionCreateBody>(`${rsUrl}/v1/event-subscriptions`, {
      body: JSON.stringify({ callback_url: receiver.url }),
      headers: { Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json" },
      method: "POST",
    });
    const { subscription_id, secret } = create.body;

    // Wait for verify event so subscription is active.
    await waitForReceiverEvent(receiver, (e) => e.payload?.type === "pdpp.subscription.verify");
    await new Promise((r) => setTimeout(r, 25));

    // Extract grant_id via the GET projection.
    const sub = (
      await fetchJson<SubscriptionDetailBody>(`${rsUrl}/v1/event-subscriptions/${subscription_id}`, {
        headers: { Authorization: `Bearer ${clientToken}` },
      })
    ).body;
    const grantId = sub.grant_id;

    // Revoke via owner bearer.
    const revokeResp = await fetch(`${asUrl}/grants/${grantId}/revoke`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
      method: "POST",
    });
    assert.equal(revokeResp.status, 200);

    const revokedHit = await waitForReceiverEvent(receiver, (e) => e.payload?.type === "pdpp.grant.revoked");
    assert.equal(verifySignature(secret, revokedHit.headers, revokedHit.body), true);
    assertCloudEventsTopLevelShape(revokedHit.payload, "grant.revoked event");
    assert.equal(payloadOf(revokedHit).data.subscription_id, subscription_id);

    // Re-read using the client token would now fail (grant revoked); we
    // skip that path here, the lifecycle property already proven.
  } finally {
    await receiver.close();
    await closeServer(server);
  }
});

test("trusted owner-agent event subscriptions deliver signed hints and are revoked with the registered client", async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const receiver = await startReceiver();

  try {
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
    const connectorId = spotifyManifest.connector_id;
    await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const ownerSubjectId = "e2e_owner";
    const registered = await registerDynamicClient(
      {
        client_name: "Daisy owner-agent event subscription e2e",
        token_endpoint_auth_method: "none",
      },
      { issuer_subject_id: ownerSubjectId }
    );
    assert.ok(typeof registered.client_id === "string");
    const ownerToken = await issueOwnerDeviceToken(asUrl, registered.client_id);
    const ownerInfo = (await introspect(ownerToken)) as {
      active: boolean;
      pdpp_token_kind?: string;
      client_id?: string;
    };
    assert.equal(ownerInfo.active, true);
    assert.equal(ownerInfo.pdpp_token_kind, "owner");
    assert.equal(ownerInfo.client_id, registered.client_id);

    const clientToken = await approveClientGrant(asUrl, connectorId, "top_artists");

    const createResp = await fetchJson<SubscriptionCreateBody>(`${rsUrl}/v1/event-subscriptions`, {
      body: JSON.stringify({ callback_url: receiver.url }),
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(createResp.status, 201);
    const { subscription_id, secret } = createResp.body;
    assert.ok(secret.startsWith("whsec_"));

    const verifyEvent = await waitForReceiverEvent(receiver, (e) => e.payload?.type === "pdpp.subscription.verify");
    assert.equal(verifySignature(secret, verifyEvent.headers, verifyEvent.body), true);
    await new Promise((r) => setTimeout(r, 25));

    const ownerList = await fetchJson<SubscriptionListBody>(`${rsUrl}/v1/event-subscriptions`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerList.status, 200);
    assert.equal(ownerList.body.data.length, 1);
    const [ownerListEntry] = ownerList.body.data;
    assert.ok(ownerListEntry);
    assert.equal(ownerListEntry.subscription_id, subscription_id);
    assert.equal(ownerListEntry.authority_kind, "trusted_owner_agent");
    assert.equal(ownerListEntry.grant_id, null);

    const clientCannotReadOwnerSub = await fetchJson(`${rsUrl}/v1/event-subscriptions/${subscription_id}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(clientCannotReadOwnerSub.status, 404);

    const testResp = await fetchJson(`${rsUrl}/v1/event-subscriptions/${subscription_id}/test-event`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
      method: "POST",
    });
    assert.equal(testResp.status, 202);
    const testHit = await waitForReceiverEvent(receiver, (e) => e.payload?.type === "pdpp.subscription.test");
    assert.equal(verifySignature(secret, testHit.headers, testHit.body), true);

    const ingestResp = await fetch(`${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(connectorId)}`, {
      body: JSON.stringify({
        data: { id: "artist_owner_agent_1", name: "Owner Agent Artist" },
        emitted_at: new Date().toISOString(),
        key: "artist_owner_agent_1",
      }),
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    });
    assert.equal(ingestResp.status, 200);

    const recordsHit = await waitForReceiverEvent(receiver, (e) => e.payload?.type === "pdpp.records.changed");
    assert.equal(verifySignature(secret, recordsHit.headers, recordsHit.body), true);
    const recordsHitData = payloadOf(recordsHit).data;
    assert.equal(recordsHitData.subscription_id, subscription_id);
    assert.equal(recordsHitData.connector_id, "spotify");
    assert.equal(recordsHitData.stream, "top_artists");
    assert.equal(typeof recordsHitData.connection_id, "string");
    assert.ok(recordsHitData.changes_since);
    const connectorId2 = recordsHitData.connector_id;
    const connectionId = recordsHitData.connection_id;
    const changesSince2 = recordsHitData.changes_since;
    assert.ok(typeof connectorId2 === "string");
    assert.ok(typeof connectionId === "string");

    const readResp = await fetchJson<RecordsListBody>(
      `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(connectorId2)}&connection_id=${encodeURIComponent(connectionId)}&changes_since=${encodeURIComponent(changesSince2)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(readResp.status, 200);
    assert.ok(readResp.body.data.some((r) => r.id === "artist_owner_agent_1" || r.data?.id === "artist_owner_agent_1"));

    const deleted = await deleteRegisteredClient(registered.client_id, {
      actingSubjectId: ownerSubjectId,
      requestId: "req_owner_agent_sub_delete",
      traceId: "tr_owner_agent_sub_delete",
    });
    assert.equal(deleted.disabledSubscriptionCount, 1);
    assert.equal((await introspect(ownerToken)).active, false);
    const summary = await getSubscriptionSummary(subscription_id);
    assert.ok(summary);
    assert.equal(summary.status, "disabled_revoked");
    assert.equal(summary.disabled_reason, "client_deleted");
  } finally {
    await receiver.close();
    await closeServer(server);
  }
});

test("discovery: RS protected-resource metadata advertises client_event_subscriptions", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    interface ClientEventSubscriptionsCapability {
      authority_kinds_supported: string[];
      callback_url: { https_required: boolean };
      delivery: {
        at_least_once: boolean;
        after_commit: boolean;
        coalescing: boolean;
        max_attempts: number;
        response_window_seconds: number;
      };
      endpoint: string;
      envelope: {
        specversion: string;
        pdppversion: string;
        format: string;
        content_type: string;
        subscription_id_location: string;
        fields: string[];
        no_record_bodies: boolean;
      };
      event_types: string[];
      hint_cursor: { cursor_field: string };
      limits: { callback_url_max_bytes: number };
      signing: {
        profile: string;
        algorithm: string;
        id_header: string;
        timestamp_header: string;
        signature_header: string;
        signed_payload: string;
        signature_encoding: string;
        secret_prefix: string;
      };
      stability: string;
      supported: boolean;
      transport: string;
      verification: { handshake: string };
    }
    const resp = await fetchJson<{
      capabilities?: {
        client_event_subscriptions?: ClientEventSubscriptionsCapability;
      };
    }>(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(resp.status, 200);
    const cap = resp.body?.capabilities?.client_event_subscriptions;
    assert.ok(cap, "client_event_subscriptions capability must be advertised");
    assert.equal(cap.supported, true);
    assert.equal(cap.stability, "reference_extension");
    assert.equal(cap.endpoint, "/v1/event-subscriptions");
    assert.deepEqual(cap.authority_kinds_supported, ["client_grant", "trusted_owner_agent"]);
    assert.equal(cap.transport, "https_webhook");
    assert.equal(cap.signing.profile, "standard-webhooks");
    assert.equal(cap.signing.algorithm, "HMAC-SHA256");
    assert.equal(cap.signing.id_header, "webhook-id");
    assert.equal(cap.signing.timestamp_header, "webhook-timestamp");
    assert.equal(cap.signing.signature_header, "webhook-signature");
    assert.equal(cap.signing.signed_payload, "{webhook-id}.{webhook-timestamp}.{body}");
    assert.equal(cap.signing.signature_encoding, "v1,<base64>");
    assert.equal(cap.signing.secret_prefix, "whsec_");
    assert.equal(cap.envelope.specversion, "1.0");
    assert.equal(cap.envelope.pdppversion, "1");
    assert.equal(cap.envelope.format, "cloudevents+json");
    // CloudEvents JSON structured mode media type and subscription_id location.
    assert.equal(cap.envelope.content_type, "application/cloudevents+json; charset=utf-8");
    assert.equal(cap.envelope.subscription_id_location, "data.subscription_id");
    // `fields` documents the standard `time` attribute, not the rev1 `occurred_at`.
    assert.ok(cap.envelope.fields.includes("time"), "envelope.fields advertises standard `time` attribute");
    assert.ok(!cap.envelope.fields.includes("occurred_at"), "envelope.fields must not advertise legacy occurred_at");
    assert.ok(
      !cap.envelope.fields.includes("subscription_id"),
      "envelope.fields must not advertise top-level subscription_id"
    );
    assert.ok(Array.isArray(cap.event_types));
    assert.ok(cap.event_types.includes("pdpp.records.changed"));
    assert.ok(cap.event_types.includes("pdpp.subscription.verify"));
    assert.ok(cap.event_types.includes("pdpp.subscription.test"));
    assert.ok(cap.event_types.includes("pdpp.grant.revoked"));
    assert.equal(cap.delivery.at_least_once, true);
    assert.equal(cap.delivery.after_commit, true);
    assert.equal(cap.delivery.coalescing, false);
    assert.equal(cap.delivery.max_attempts, 6);
    assert.equal(cap.delivery.response_window_seconds, 10);
    assert.equal(cap.verification.handshake, "post_with_challenge_echo");
    assert.equal(cap.hint_cursor.cursor_field, "data.changes_since");
    assert.equal(cap.callback_url.https_required, true);
    assert.equal(cap.limits.callback_url_max_bytes, 2048);
    assert.equal(cap.envelope.no_record_bodies, true);
  } finally {
    await closeServer(server);
  }
});

test("registered owner bearer cannot see client-grant subscriptions", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const receiver = await startReceiver();
  try {
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
    await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const ownerToken = await issueOwnerDeviceToken(asUrl);
    const clientToken = await approveClientGrant(asUrl, spotifyManifest.connector_id, "top_artists");
    await fetchJson(`${rsUrl}/v1/event-subscriptions`, {
      body: JSON.stringify({ callback_url: receiver.url }),
      headers: { Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json" },
      method: "POST",
    });
    const ownerListResp = await fetchJson<SubscriptionListBody>(`${rsUrl}/v1/event-subscriptions`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerListResp.status, 200);
    assert.deepEqual(ownerListResp.body.data, []);
  } finally {
    await receiver.close();
    await closeServer(server);
  }
});

test("unregistered owner bearer cannot use event-subscription endpoints", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const ownerToken = await issueOwnerTokenRecord("e2e_owner");
    const ownerListResp = await fetch(`${rsUrl}/v1/event-subscriptions`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerListResp.status, 403);
  } finally {
    await closeServer(server);
  }
});
