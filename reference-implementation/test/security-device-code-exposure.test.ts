// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Regression tests for the P0 device-code-exposure fix.
//
// Pins five invariants:
//   1. /_ref/approvals never echoes the live device_code as approval_id.
//   2. /_ref/approvals consent entries do not echo the live device_code via
//      `request_uri` (which embeds it). user_code is also stripped.
//   3. /_ref/traces/<traceId> for a pending consent does not echo the
//      device_code or user_code.
//   4. /_ref/traces/<traceId> for a pending owner-device flow does not
//      echo the device_code or user_code.
//   5. The dashboard's `approval_id` based approve flow round-trips for
//      both consent and owner-device kinds without ever exposing the
//      live device_code via a public read surface.
//
// Spec: openspec/changes/harden-reference-auth-surfaces/specs/
//       reference-implementation-architecture/spec.md (§7 follow-up).
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const REGEXP_1 = /^urn:pdpp:pending-consent:/;
const REGEXP_2 = /^urn:pdpp:pending-consent:/;
const REGEXP_3 = /^urn:pdpp:pending-consent:/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-31T00:00:00.000Z";

interface TestHttpServer {
  close: (callback: () => void) => void;
  closeAllConnections?: () => void;
}

interface TestServerHandle {
  asPort: number;
  asServer: TestHttpServer;
  rsServer: TestHttpServer;
}

interface SpotifyManifest {
  connector_id: string;
}

interface HarnessContext {
  asUrl: string;
  spotifyManifest: SpotifyManifest;
}

interface FetchJsonResult {
  body: unknown;
  raw: string;
  status: number;
}

interface ConsentPar {
  request_uri: string;
  trace_id: string | null;
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
}

interface ApprovalEntry {
  approval_id: string;
  kind: string;
  request_uri: string | null;
  user_code: string | null;
}

interface ApprovalsList {
  data: ApprovalEntry[];
  object: string;
}

interface TraceEvent {
  data?: Record<string, unknown> | null;
  event_type: string;
  object_id: string;
  object_type: string;
}

interface TraceDetail {
  data: TraceEvent[];
}

interface TraceSummary {
  id?: string;
  trace_id?: string;
}

interface TracesList {
  data: TraceSummary[];
}

interface ApproveResponse {
  grant_id: string;
  token: string;
}

interface TokenResponse {
  access_token: string;
}

async function closeServer(server: TestServerHandle): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (srv: TestHttpServer) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<FetchJsonResult> {
  const resp = await fetch(url, opts);
  let body: unknown = null;
  const text = await resp.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { body, raw: text, status: resp.status };
}

async function withHarness(fn: (ctx: HarnessContext) => Promise<void>): Promise<void> {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  ) as SpotifyManifest;
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await seedSpotifyInstance(spotifyManifest);
    await fn({ asUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function seedSpotifyInstance(spotifyManifest: SpotifyManifest): Promise<void> {
  const connectorId = canonicalConnectorKey(spotifyManifest.connector_id);
  assert.ok(connectorId, "spotify manifest must resolve to a canonical connector key");
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: "cin_security_device_code_spotify",
    createdAt: NOW,
    displayName: "Security Device Code Spotify",
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: "security-device-code@example.com" },
    sourceBindingKey: "security-device-code@example.com",
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

async function startConsentPar(asUrl: string, spotifyManifest: SpotifyManifest): Promise<ConsentPar> {
  const resp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          purpose_description: "Device-code-exposure regression smoke",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: "concert_recommendation_app",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201);
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  const body = (await resp.json()) as { request_uri: string };
  return { ...body, trace_id: traceId };
}

async function startOwnerDeviceFlow(asUrl: string, clientId = "cli_longview"): Promise<DeviceAuthorization> {
  const resp = await fetch(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(resp.status, 200);
  return resp.json() as Promise<DeviceAuthorization>;
}

test("GET /_ref/approvals/:approval_id projects a live consent without device-flow credentials", async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const consentPar = await startConsentPar(asUrl, spotifyManifest);
    const consentDeviceCode = consentPar.request_uri.replace(REGEXP_1, "");
    const { body: rawApprovals } = await fetchJson(`${asUrl}/_ref/approvals`);
    const approvals = rawApprovals as ApprovalsList;
    const consentEntry = approvals.data.find((entry) => entry.kind === "consent");
    assert.ok(consentEntry, "expected a pending consent approval");
    if (!consentEntry) {
      throw new Error("unreachable: assert.ok would have thrown");
    }

    const detailResp = await fetch(`${asUrl}/_ref/approvals/${encodeURIComponent(consentEntry.approval_id)}`);
    const detailRaw = await detailResp.text();
    assert.equal(detailResp.status, 200, detailRaw);
    const detail = JSON.parse(detailRaw) as { approval_id: string; kind: string; purpose: { description: string } };
    assert.equal(detail.approval_id, consentEntry.approval_id);
    assert.equal(detail.kind, "consent");
    assert.equal(detail.purpose.description, "Device-code-exposure regression smoke");
    assert.ok(!detailRaw.includes(consentDeviceCode), "detail leaked device_code");
    assert.ok(!detailRaw.includes(consentPar.request_uri), "detail leaked request_uri");
    assert.ok(!detailRaw.includes("params_json"), "detail leaked raw pending payload");

    const reviewResp = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({ approval_id: consentEntry.approval_id, subject_id: "owner_local" }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    const reviewText = await reviewResp.text();
    assert.equal(reviewResp.status, 200, reviewText);
    const review = JSON.parse(reviewText) as { approval_review_revision: string; request_uri: string };
    assert.equal(review.request_uri, consentPar.request_uri);

    const approveResp = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: review.approval_review_revision,
        request_uri: review.request_uri,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(approveResp.status, 200);
    const terminalResp = await fetch(`${asUrl}/_ref/approvals/${encodeURIComponent(consentEntry.approval_id)}`);
    assert.equal(terminalResp.status, 404, "terminal approvals must not render a review projection");
  });
});

test("GET /_ref/approvals/:approval_id does not project expired consent approvals", async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    await startConsentPar(asUrl, spotifyManifest);
    const { body: rawApprovals } = await fetchJson(`${asUrl}/_ref/approvals`);
    const approvals = rawApprovals as ApprovalsList;
    const consentEntry = approvals.data.find((entry) => entry.kind === "consent");
    assert.ok(consentEntry, "expected a pending consent approval");
    if (!consentEntry) {
      throw new Error("unreachable: assert.ok would have thrown");
    }

    getDb()
      .prepare("UPDATE pending_consents SET expires_at = ? WHERE approval_id = ?")
      .run("2026-08-11T00:00:00.000Z", consentEntry.approval_id);

    const expiredResp = await fetch(`${asUrl}/_ref/approvals/${encodeURIComponent(consentEntry.approval_id)}`);
    assert.equal(expiredResp.status, 404, "expired approvals must not render a review projection");
  });
});

test("security: device-code exposure on _ref read surfaces", async (t) => {
  await t.test("/_ref/approvals never echoes device_code, request_uri, or user_code", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const consentPar = await startConsentPar(asUrl, spotifyManifest);
      const device = await startOwnerDeviceFlow(asUrl);

      const { status, body: rawBody, raw } = await fetchJson(`${asUrl}/_ref/approvals`);
      const body = rawBody as ApprovalsList;
      assert.equal(status, 200);
      assert.equal(body.object, "list");

      // The consent-flow `device_code` is the second segment of the
      // request_uri returned by PAR. The owner-device flow returns it
      // directly. Neither value SHALL appear anywhere in the response
      // body — not as approval_id, not in request_uri, not in any
      // grant_preview field.
      const consentDeviceCode = consentPar.request_uri.replace(REGEXP_1, "");
      assert.ok(consentDeviceCode.length > 0);
      assert.ok(!raw.includes(consentDeviceCode), "consent device_code leaked into _ref/approvals body");
      assert.ok(!raw.includes(device.device_code), "owner-device device_code leaked into _ref/approvals body");
      assert.ok(!raw.includes(device.user_code), "owner-device user_code leaked into _ref/approvals body");

      // Spot-check that the projected approval_id is not the device_code.
      for (const entry of body.data) {
        assert.notEqual(entry.approval_id, consentDeviceCode);
        assert.notEqual(entry.approval_id, device.device_code);
        assert.equal(entry.request_uri, null, `${entry.kind} request_uri must be null`);
        assert.equal(entry.user_code, null, `${entry.kind} user_code must be null`);
        assert.ok(typeof entry.approval_id === "string" && entry.approval_id.length > 0);
      }

      // Both kinds present.
      const consentEntry = body.data.find((e) => e.kind === "consent");
      const deviceEntry = body.data.find((e) => e.kind === "owner_device");
      assert.ok(consentEntry, "expected a consent entry");
      assert.ok(deviceEntry, "expected an owner_device entry");
    });
  });

  await t.test("/_ref/traces/:traceId redacts device_code and user_code on pending_consent events", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const consentPar = await startConsentPar(asUrl, spotifyManifest);
      const consentDeviceCode = consentPar.request_uri.replace(REGEXP_2, "");
      const traceId = consentPar.trace_id;
      assert.ok(traceId, "PAR did not return trace_id header");

      const { status, body: rawBody, raw } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);
      const body = rawBody as TraceDetail;
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.data));
      const submitted = body.data.find(
        (e: TraceEvent) => e.event_type === "request.submitted" && e.object_type === "pending_consent"
      );
      assert.ok(submitted, "expected a request.submitted event for pending_consent");

      // The live device_code SHALL NOT appear as object_id, and the
      // user_code SHALL NOT appear in the data payload.
      assert.notEqual(submitted.object_id, consentDeviceCode);
      assert.equal(submitted.object_id, "<redacted-device-code>");
      assert.ok(!raw.includes(consentDeviceCode), "device_code leaked into trace body");

      if (submitted.data && typeof submitted.data === "object" && "user_code" in submitted.data) {
        assert.equal(submitted.data.user_code, "<redacted-bearer>");
      }
    });
  });

  await t.test("/_ref/traces/:traceId redacts device_code and user_code on owner_device_auth events", async () => {
    await withHarness(async ({ asUrl }) => {
      const device = await startOwnerDeviceFlow(asUrl);
      // Look up the device flow's trace via the spine search helper.
      const tracesResp = await fetchJson(`${asUrl}/_ref/traces`);
      const tracesRespBody = tracesResp.body as TracesList;
      assert.equal(tracesResp.status, 200);
      assert.ok(Array.isArray(tracesRespBody.data) && tracesRespBody.data.length > 0);

      // Find the trace that corresponds to the owner-device-auth flow by
      // probing each trace's events.
      let matched: { id: string; body: TraceDetail; owner: TraceEvent } | null = null;
      for (const summary of tracesRespBody.data) {
        const id = summary.id || summary.trace_id;
        if (!id) {
          continue;
        }
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        const { body: rawBody } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(id)}`);
        const body = rawBody as TraceDetail;
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const owner = body?.data?.find?.((e: TraceEvent) => e.object_type === "owner_device_auth");
        if (owner) {
          matched = { body, id, owner };
          break;
        }
      }
      assert.ok(matched, "expected a trace with an owner_device_auth event");
      if (!matched) {
        throw new Error("unreachable: assert.ok would have thrown");
      }

      const raw = JSON.stringify(matched.body);
      assert.ok(!raw.includes(device.device_code), "owner-device device_code leaked into trace body");
      assert.ok(!raw.includes(device.user_code), "owner-device user_code leaked into trace body");
      assert.equal(matched.owner.object_id, "<redacted-device-code>");
      if (matched.owner.data && typeof matched.owner.data === "object" && "user_code" in matched.owner.data) {
        assert.equal(matched.owner.data.user_code, "<redacted-bearer>");
      }
    });
  });

  await t.test("approve-by-approval_id round-trips for consent", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const consentPar = await startConsentPar(asUrl, spotifyManifest);
      const consentDeviceCode = consentPar.request_uri.replace(REGEXP_3, "");

      const { body: rawApprovals } = await fetchJson(`${asUrl}/_ref/approvals`);
      const approvals = rawApprovals as ApprovalsList;
      const consentEntry = approvals.data.find((e: ApprovalEntry) => e.kind === "consent");
      assert.ok(consentEntry);
      if (!consentEntry) {
        throw new Error("unreachable: assert.ok would have thrown");
      }

      const reviewResp = await fetch(`${asUrl}/consent/review`, {
        body: JSON.stringify({ approval_id: consentEntry.approval_id, subject_id: "owner_local" }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      const reviewText = await reviewResp.text();
      assert.equal(reviewResp.status, 200, reviewText);
      const review = JSON.parse(reviewText) as { approval_review_revision: string; request_uri: string };
      assert.equal(review.request_uri, consentPar.request_uri);

      const approveResp = await fetch(`${asUrl}/consent/approve`, {
        body: JSON.stringify({
          approval_review_revision: review.approval_review_revision,
          request_uri: review.request_uri,
        }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(approveResp.status, 200);
      const approveBody = (await approveResp.json()) as ApproveResponse;
      assert.ok(approveBody.grant_id);
      assert.ok(approveBody.token);

      // Sanity: the live device_code never surfaced through the public
      // read path (we proved that already in the prior tests, but this
      // test confirms the alternate approve path does not require it).
      assert.ok(consentDeviceCode.length > 0);
      assert.ok(!JSON.stringify(approvals).includes(consentDeviceCode));
    });
  });

  await t.test("approve-by-approval_id round-trips for owner_device", async () => {
    await withHarness(async ({ asUrl }) => {
      const device = await startOwnerDeviceFlow(asUrl);
      const { body: rawApprovals } = await fetchJson(`${asUrl}/_ref/approvals`);
      const approvals = rawApprovals as ApprovalsList;
      const deviceEntry = approvals.data.find((e: ApprovalEntry) => e.kind === "owner_device");
      assert.ok(deviceEntry);
      if (!deviceEntry) {
        throw new Error("unreachable: assert.ok would have thrown");
      }

      const approveResp = await fetch(`${asUrl}/device/approve`, {
        body: new URLSearchParams({
          approval_id: deviceEntry.approval_id,
          subject_id: "owner_local",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(approveResp.status, 200);

      // Token can now be exchanged using the device_code the *client*
      // received from device_authorization (it never came from a public
      // read surface).
      const tokenResp = await fetch(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: "cli_longview",
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(tokenResp.status, 200);
      const tokenBody = (await tokenResp.json()) as TokenResponse;
      assert.ok(tokenBody.access_token);
    });
  });
});
