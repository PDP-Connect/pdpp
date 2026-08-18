// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/performance/useTopLevelRegex: hosted-page assertions keep their semantic patterns beside each assertion.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * Hosted-UI tranche tests.
 *
 * These assertions verify that the reference server's HTML pages
 * (`/consent`, `/device`, approval/deny results, `/owner/login`, and
 * the shared `/__pdpp/hosted-ui.css` asset) go through the shared
 * hosted-UI layer rather than route-local inline-styled HTML.
 *
 * We keep the assertions semantic — shared CSS link, brand marker,
 * page heading, key content — so the tests remain resilient to small
 * markup refactors of the hosted-ui module.
 */
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initiateOwnerDeviceAuthorization } from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { HOSTED_UI_CSS_PATH } from "../server/hosted-ui.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const SPOTIFY_MANIFEST = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8"));

const TEST_PASSWORD = "hosted-ui-test-password";
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-31T00:00:00.000Z";

interface CloseableTestServer {
  readonly asPort: number;
  readonly asServer: { closeAllConnections?: () => void; close: (callback: () => void) => void };
  readonly rsServer: { closeAllConnections?: () => void; close: (callback: () => void) => void };
}

async function closeServer(server: CloseableTestServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeWithTimeout = (srv: CloseableTestServer["asServer"]) =>
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

async function withServer(
  opts: Record<string, unknown>,
  fn: (context: { asUrl: string }) => Promise<void>
): Promise<void> {
  const server: CloseableTestServer = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...opts,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl });
  } finally {
    await closeServer(server);
  }
}

async function startPendingConsent(asUrl: string): Promise<string> {
  const registerResp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(SPOTIFY_MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!registerResp.ok) {
    throw new Error(`connector registration failed: ${registerResp.status}`);
  }
  await seedSpotifyInstance();
  const resp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: SPOTIFY_MANIFEST.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_display: { name: "Longview" },
      client_id: "longview",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = (await resp.json()) as { request_uri: string };
  return body.request_uri;
}

async function seedSpotifyInstance(): Promise<void> {
  const connectorId = canonicalConnectorKey(SPOTIFY_MANIFEST.connector_id);
  assert.ok(connectorId, "spotify manifest must resolve to a canonical connector key");
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: "cin_hosted_ui_spotify",
    createdAt: NOW,
    displayName: "Hosted UI Spotify",
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: "hosted-ui@example.com" },
    sourceBindingKey: "hosted-ui@example.com",
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

/**
 * Assertions shared by every hosted page. Proves the page went through
 * `renderHostedDocument` rather than a route-local inline `<style>` block.
 */
function assertHostedShell(html: string): void {
  assert.match(html, /^<!DOCTYPE html>/, "starts with DOCTYPE");
  assert.match(html, /<main class="hosted-ui-page"/, "uses hosted-ui page shell");
  assert.match(html, /data-pdpp-hosted-ui/, "carries PDPP hosted-UI brand marker");
  assert.match(
    html,
    new RegExp(`<link[^>]+href="${HOSTED_UI_CSS_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
    "links shared hosted-ui stylesheet"
  );
  assert.match(html, /hosted-ui-header/, "renders brand header");
  assert.match(html, /<span class="hosted-ui-wordmark">PDPP<\/span>/, "shows PDPP wordmark");
  assert.doesNotMatch(html, /<style>[\s\S]*body\s*{\s*font-family:\s*system-ui/, "no route-local inline style block");
}

test("hosted-ui: shared stylesheet is served under /__pdpp/hosted-ui.css", async () => {
  await withServer({}, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}${HOSTED_UI_CSS_PATH}`);
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") || "", /text\/css/);
    const body = await resp.text();
    assert.match(body, /\.pdpp-display\b/, "includes PDPP type scale");
    assert.match(body, /\[data-surface="human"\]/, "includes semantic surfaces");
    assert.match(body, /\.hosted-ui-page/, "includes hosted-ui layout layer");
  });
});

test("hosted-ui: /consent uses the shared hosted-UI layer", async () => {
  await withServer({}, async ({ asUrl }) => {
    const requestUri = await startPendingConsent(asUrl);
    const resp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`);
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assertHostedShell(html);
    assert.match(html, /<h1[^>]*class="pdpp-display"/, "page uses pdpp-display heading");
    assert.match(html, /Longview/, "shows client name");
    assert.match(html, /concert-recommendation profile/, "shows purpose");
    assert.match(html, /data-surface="human"/, "frames consent as a human surface");
    assert.match(html, /action="\/consent\/review"/, "keeps review-first allow action");
    assert.match(html, /action="\/consent\/deny"/, "keeps deny action");
  });
});

test("hosted-ui: /device empty state uses the shared hosted-UI layer", async () => {
  await withServer({}, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/device`);
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assertHostedShell(html);
    assert.match(html, /Enter verification code/, "shows empty-state prompt");
    assert.match(html, /<label[^>]*for="hosted-ui-user_code"/, "has labelled input");
  });
});

test("hosted-ui: /device approval page uses the shared hosted-UI layer", async () => {
  await withServer({}, async ({ asUrl }) => {
    const pending = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });
    const userCode = pending.user_code;
    assert.ok(typeof userCode === "string", "device authorization returns a user code");
    const resp = await fetch(`${asUrl}/device?user_code=${userCode}`);
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assertHostedShell(html);
    assert.match(html, /Approve owner access/, "shows approval heading");
    assert.match(html, /data-surface="human"/, "frames approval as a human surface");
    assert.match(html, new RegExp(userCode), "shows user code");
    assert.match(html, /action="\/device\/approve"/, "keeps approve action");
  });
});

test("hosted-ui: /consent/approve result page uses the shared hosted-UI layer", async () => {
  await withServer({}, async ({ asUrl }) => {
    const requestUri = await startPendingConsent(asUrl);
    const reviewResp = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({ request_uri: requestUri, subject_id: "owner_local" }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reviewResp.status, 200);
    const review = (await reviewResp.json()) as { approval_review_revision?: unknown };
    assert.equal(typeof review.approval_review_revision, "string", "consent review returns a revision");
    const reviewRevision = review.approval_review_revision as string;
    const resp = await fetch(`${asUrl}/consent/approve`, {
      body: new URLSearchParams({
        approval_review_revision: reviewRevision,
        request_uri: requestUri,
      }).toString(),
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assertHostedShell(html);
    assert.match(html, /Access approved/, "shows approval result");
    assert.match(html, /data-surface="protocol"/, "technical details use protocol surface");
    assert.match(html, /Grant ID/, "includes grant id label");
  });
});

test("hosted-ui: /consent/deny result page uses the shared hosted-UI layer", async () => {
  await withServer({}, async ({ asUrl }) => {
    const requestUri = await startPendingConsent(asUrl);
    const resp = await fetch(`${asUrl}/consent/deny`, {
      body: new URLSearchParams({ request_uri: requestUri }).toString(),
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assertHostedShell(html);
    assert.match(html, /Access Denied/, "shows denial result");
  });
});

test("hosted-ui: /device/approve and /device/deny result pages use the shared hosted-UI layer", async () => {
  // Approve path
  await withServer({}, async ({ asUrl }) => {
    const pending = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });
    const userCode = pending.user_code;
    assert.ok(typeof userCode === "string", "device authorization returns a user code");
    const approveResp = await fetch(`${asUrl}/device/approve`, {
      body: new URLSearchParams({ subject_id: "owner_local", user_code: userCode }).toString(),
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(approveResp.status, 200);
    const html = await approveResp.text();
    assertHostedShell(html);
    assert.match(html, /CLI access approved/, "shows device approval result");
  });

  // Deny path
  await withServer({}, async ({ asUrl }) => {
    const pending = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });
    const userCode = pending.user_code;
    assert.ok(typeof userCode === "string", "device authorization returns a user code");
    const denyResp = await fetch(`${asUrl}/device/deny`, {
      body: new URLSearchParams({ subject_id: "owner_local", user_code: userCode }).toString(),
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(denyResp.status, 200);
    const html = await denyResp.text();
    assertHostedShell(html);
    assert.match(html, /CLI access denied/, "shows device deny result");
  });
});

test("hosted-ui: /owner/login reuses the shared hosted-UI layer", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/login`, { headers: { Accept: "text/html" } });
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assertHostedShell(html);
    assert.match(html, /Sign in to/, "shows sign-in heading");
    assert.match(html, /<label[^>]*for="hosted-ui-password"/, "has labelled password input");
    assert.match(html, /data-surface="human"/, "owner login is framed as a human surface");
  });
});

test("hosted-ui: /owner/login disabled state still uses the shared hosted-UI layer", async () => {
  await withServer({}, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/login`, { headers: { Accept: "text/html" } });
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assertHostedShell(html);
    assert.match(html, /owner access/i, "shows owner-access heading");
    assert.match(html, /disabled/i, "explains disabled placeholder auth");
    assert.doesNotMatch(html, /hosted-ui-password/, "does not render password field");
  });
});
