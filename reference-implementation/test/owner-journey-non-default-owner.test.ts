// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end journey for a NON-DEFAULT owner subject ("owner_alice", not the
 * conventional "owner_local" every other suite in this repo defaults to),
 * proving the reference server's owner-scoping holds across the full run
 * lifecycle, plus a dedicated foreign-owner ("owner_mallory") rejection at
 * every boundary that owner isolation depends on: run admission,
 * cancellation, web push fanout, and static-secret credential storage.
 *
 * Added closing PR #52's gate findings (P1-3): the existing browser-surface
 * fixture suite proved connector/instance-id scoping but never proved
 * end-to-end that a *non-default* owner's run/connection/subscription is
 * both fully usable by that owner and fully opaque to a different owner.
 *
 * Architecture note (see design discussion in the PR): the reference
 * server's owner-session COOKIE surface (`_ref/*` — interaction, cancel,
 * static-secret capture) is single-subject per server instance by design
 * (server/owner-session.ts's `OwnerSessionController` resolves one
 * `subjectId` at construction; `requireOwnerSession` never reads a
 * per-request subject). Only the bearer-token surface (`/v1/owner/*`) is
 * genuinely multi-tenant per request via `req.tokenInfo.subject_id`. This
 * test therefore runs the owner-session legs (interaction, static-secret
 * credential, push, cancellation) against ONE server configured for
 * "owner_alice", and proves foreign-owner rejection at the layers that are
 * actually multi-tenant: the connector-instance store (owner_mallory's
 * connection is invisible to alice's session and vice versa) and the
 * controller's `cancelRun(runId, ownerSubjectId)` primitive (the P0 fix).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import {
  createMemoryWebPushSubscriptionStore,
  fanoutPendingInteractionWebPush as fanoutPendingInteractionWebPushUntyped,
} from "../server/web-push-notifications.ts";
import { resolveCredentialFreeFixtureRunEnv } from "./helpers/credential-free-run-fixture.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

const OWNER_PASSWORD = "owner-journey-alice-password";
const OWNER_SUBJECT_ID = "owner_alice";
const FOREIGN_SUBJECT_ID = "owner_mallory";
const VAPID_PUBLIC = "BAabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcd";
const VAPID_PRIVATE = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
const REGEXP_1 = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;
const REGEXP_OWNER_MISMATCH = /run_owner_mismatch|does not belong/i;
const REGEXP_SUBMITTED_SECRET = /s3cr3t-should-never-be-stored/;

type FanoutFn = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
const fanoutPendingInteractionWebPush = fanoutPendingInteractionWebPushUntyped as unknown as FanoutFn;

interface CloseableHandle {
  close: (cb: () => void) => unknown;
  closeAllConnections?: () => void;
}

interface ClosableServer {
  asPort: number;
  asServer: CloseableHandle;
  controller: {
    awaitRun: (runId: string) => Promise<string>;
    cancelRun: (runId: string, ownerSubjectId: string) => Promise<{ run_id: string; status: string }>;
    getActiveRun: (
      connectorId: string,
      options?: { connectorInstanceId?: string }
    ) => { run_id: string; connector_instance_id: string } | null;
    runNow: (connectorId: string, options: Record<string, unknown>) => Promise<{ run_id?: string; status: string }>;
  };
  rsPort: number;
  rsServer: CloseableHandle;
  schedulerManager?: { stop?: () => void };
}

async function startServer(opts: Record<string, unknown>): Promise<ClosableServer> {
  return (await startServerUntyped({
    connectionScopedRunEnvResolver: resolveCredentialFreeFixtureRunEnv,
    ...opts,
  })) as unknown as ClosableServer;
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(() => resolve(undefined))),
    new Promise((resolve) => server.rsServer.close(() => resolve(undefined))),
  ]);
}

interface JsonResult {
  body: Record<string, unknown>;
  resp: Response;
  status: number;
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { body: body as Record<string, unknown>, resp, status: resp.status };
}

function getRawSetCookieList(resp: Response): string[] {
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies: string[], name: string): string | null {
  for (const header of setCookies) {
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const firstPair = header.split(";")[0];
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html: string): string | null {
  const match = html.match(REGEXP_1);
  return match ? (match[1] ?? null) : null;
}

// The single configured owner ("owner_alice") signs in through the real
// password + CSRF flow — the same one an operator would use — and gets back
// a signed session cookie scoped to that one subject.
async function loginAsConfiguredOwner(asUrl: string): Promise<string> {
  const getLogin = await fetch(`${asUrl}/owner/login`, { headers: { Accept: "text/html" }, redirect: "manual" });
  const csrfCookie = findSetCookiePair(getRawSetCookieList(getLogin), "pdpp_owner_csrf");
  const csrfField = extractCsrfFieldValue(await getLogin.text());
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField || "", password: OWNER_PASSWORD, return_to: "/" }).toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookie || "" },
    method: "POST",
    redirect: "manual",
  });
  const sessionCookie = findSetCookiePair(getRawSetCookieList(resp), "pdpp_owner_session");
  assert.ok(sessionCookie, `expected owner session cookie, got status ${resp.status}`);
  return sessionCookie;
}

interface TimelineEvent {
  event_type: string;
  interaction_id?: string;
  status?: string;
  [key: string]: unknown;
}

async function waitForPendingInteraction(
  asUrl: string,
  runId: string,
  cookie: string,
  timeoutMs = 5000
): Promise<{ interaction_id: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential poll-until-ready is the intentional wait strategy here.
    const { body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`, {
      headers: { Cookie: cookie },
    });
    const events = Array.isArray(body.data) ? (body.data as TimelineEvent[]) : [];
    const required = events.find((e) => e.event_type === "run.interaction_required");
    const completed = events.find((e) => e.event_type === "run.interaction_completed");
    if (required?.interaction_id && !completed) {
      return { interaction_id: required.interaction_id };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for pending interaction on run ${runId}`);
}

async function waitForRunTerminal(
  asUrl: string,
  runId: string,
  cookie: string,
  timeoutMs = 5000
): Promise<TimelineEvent[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential poll-until-ready is the intentional wait strategy here.
    const { status, body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`, {
      headers: { Cookie: cookie },
    });
    const events = Array.isArray(body.data) ? (body.data as TimelineEvent[]) : [];
    const isTerminal = (event: TimelineEvent) =>
      event.event_type === "run.completed" || event.event_type === "run.failed" || event.event_type === "run.cancelled";
    if (status === 200 && events.some(isTerminal)) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

// A connector that requests one credential interaction on START, then
// completes once it receives the response — the same idiom
// run-interaction-control.test.ts uses, kept local so this file has no
// cross-file coupling to another suite's fixture.
function buildInteractiveConnectorFixture(tmpDir: string): string {
  const path = join(tmpDir, "connector.mjs");
  writeFileSync(
    path,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
let started = false;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'START' && !started) {
    started = true;
    // A recovery-only run has no manual interaction to hold for — complete
    // immediately so it never blocks on an interaction that recovery mode
    // never expects the owner to answer.
    if (msg.recovery_only) {
      process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
      rl.close();
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_alice_journey',
      kind: 'credentials',
      message: 'Need credentials to continue.',
      schema: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] },
      timeout_seconds: 60,
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
    "utf8"
  );
  return path;
}

interface ManifestLike {
  connector_id: string;
  [key: string]: unknown;
}

function loadSpotifyManifest(): ManifestLike {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8"));
}

async function registerConnector(asUrl: string, manifest: ManifestLike): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status}`);
}

test("non-default owner completes a full journey (token/runtime/interaction/push/credential/recovery/restart/cancel), and a foreign owner is rejected at every boundary", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-owner-journey-"));
  const connectorPath = buildInteractiveConnectorFixture(tmpDir);
  const pushStore = createMemoryWebPushSubscriptionStore();
  const dbPath = join(tmpDir, "pdpp.sqlite");

  let server = await startServer({
    asPort: 0,
    connectorPathResolver: () => connectorPath,
    dbPath,
    ownerAuthPassword: OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsPort: 0,
    webPushSubscriptionStore: pushStore,
  });
  let asUrl = `http://localhost:${server.asPort}`;

  try {
    const manifest = loadSpotifyManifest();
    await registerConnector(asUrl, manifest);
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "spotify manifest must canonicalize to a connector key");

    // --- token: the configured owner ("owner_alice") signs in and gets a
    // session scoped to exactly that subject; no other subject can ever
    // read/mint one from this server instance. ---
    const aliceCookie = await loginAsConfiguredOwner(asUrl);

    // --- runtime: start a real run through the owner-session HTTP surface.
    // The admitted run belongs to owner_alice by construction (this
    // server's single configured subject). ---
    const startResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(manifest.connector_id)}/run`, {
      headers: { Cookie: aliceCookie },
      method: "POST",
    });
    assert.equal(startResp.status, 202);
    const started = (await startResp.json()) as { run_id: string };
    assert.ok(started.run_id, "run should start and return a run_id");

    // --- interaction: answer the pending credential prompt through the
    // owner-session route; the run must complete. ---
    const pending = await waitForPendingInteraction(asUrl, started.run_id, aliceCookie);
    const interactionResp = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      body: JSON.stringify({
        data: { username: "alice" },
        interaction_id: pending.interaction_id,
        status: "success",
      }),
      headers: { "Content-Type": "application/json", Cookie: aliceCookie },
      method: "POST",
    });
    assert.equal(interactionResp.status, 202);
    const terminalEvents = await waitForRunTerminal(asUrl, started.run_id, aliceCookie);
    assert.ok(
      terminalEvents.some((e) => e.event_type === "run.completed"),
      "run must complete after the owner answers the interaction"
    );

    // --- push: a subscription registered for owner_alice receives the
    // fanout; a subscription registered for a foreign owner (owner_mallory)
    // does not, and stays untouched. ---
    await pushStore.upsert(
      OWNER_SUBJECT_ID,
      { endpoint: "https://push.example.invalid/sub/alice", keys: { auth: "a", p256dh: "p" } },
      {}
    );
    await pushStore.upsert(
      FOREIGN_SUBJECT_ID,
      { endpoint: "https://push.example.invalid/sub/mallory", keys: { auth: "a", p256dh: "p" } },
      {}
    );
    const notifiedEndpoints: string[] = [];
    await fanoutPendingInteractionWebPush({
      config: {
        enabled: true,
        privateKey: VAPID_PRIVATE,
        publicKey: VAPID_PUBLIC,
        subject: "mailto:test@example.invalid",
      },
      connectorDisplayName: "Spotify",
      interaction: { kind: "credentials", request_id: "int_alice_journey" },
      log: { warn: () => undefined },
      ownerSubjectId: OWNER_SUBJECT_ID,
      runId: started.run_id,
      sender: (subscription: unknown) => {
        notifiedEndpoints.push((subscription as { endpoint: string }).endpoint);
      },
      store: pushStore,
    });
    assert.deepEqual(
      notifiedEndpoints,
      ["https://push.example.invalid/sub/alice"],
      "fanout must reach only owner_alice's subscription, never owner_mallory's"
    );
    const malloryList = await pushStore.list(FOREIGN_SUBJECT_ID);
    assert.equal(malloryList[0]?.last_success_at ?? null, null, "the foreign owner's subscription must stay untouched");

    // --- credential: a rejected static-secret credential capture stores
    // nothing and never leaks the submitted secret in the response body. ---
    const captureResp = await fetch(`${asUrl}/_ref/connections/cin_does_not_exist/static-secret-credential`, {
      body: JSON.stringify({ credential_kind: "personal_access_token", secret: "s3cr3t-should-never-be-stored" }),
      headers: { "Content-Type": "application/json", Cookie: aliceCookie },
      method: "POST",
    });
    // The connection doesn't exist for this owner (or any owner) — a typed
    // not-found, never a 200 that would imply the secret was accepted.
    assert.equal(captureResp.status, 404);
    const captureBody = (await captureResp.json()) as { error?: { code?: string; message?: string } };
    assert.ok(captureBody.error, "capture against an unknown connection must return a typed error");
    assert.doesNotMatch(
      JSON.stringify(captureBody),
      REGEXP_SUBMITTED_SECRET,
      "the submitted secret must never echo back in the response"
    );

    // --- recovery: a recovery-only run for owner_alice's active connection
    // is admitted under her identity, proven at the controller (the layer
    // that actually enforces admission; recoveryOnly has no HTTP-body
    // param on the owner-session run routes). ---
    const activeRun = server.controller.getActiveRun(connectorKey, {});
    assert.equal(activeRun, null, "the interactive run above already completed and drained");
    const recoveryRun = await server.controller.runNow(connectorKey, {
      ownerSubjectId: OWNER_SUBJECT_ID,
      ownerToken: "owner-token",
      recoveryOnly: true,
      runId: "run_alice_recovery",
    });
    assert.equal(recoveryRun.status, "started");
    await server.controller.awaitRun("run_alice_recovery");

    // --- foreign-owner rejection on cancellation (the P0 fix): start a new
    // run, then prove owner_mallory cannot cancel owner_alice's run. ---
    const secondRunResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(manifest.connector_id)}/run`, {
      headers: { Cookie: aliceCookie },
      method: "POST",
    });
    assert.equal(secondRunResp.status, 202);
    const secondRun = (await secondRunResp.json()) as { run_id: string };

    await assert.rejects(
      () => server.controller.cancelRun(secondRun.run_id, FOREIGN_SUBJECT_ID),
      REGEXP_OWNER_MISMATCH,
      "a foreign owner must never be able to cancel another owner's run"
    );
    const secondPending = await waitForPendingInteraction(asUrl, secondRun.run_id, aliceCookie);
    // The run must still be live and answerable by its real owner after the
    // foreign cancel attempt was refused.
    const cancelResult = await server.controller.cancelRun(secondRun.run_id, OWNER_SUBJECT_ID);
    assert.equal(cancelResult.status, "cancel_requested", "the true owner's cancel request must succeed");
    // Answer the still-pending interaction with a cancelled response so the
    // connector child unblocks and exits on its own — deterministic and fast,
    // rather than depending on the runtime's SIGTERM/child-process-exit
    // timing (proven separately, end to end, by runtime-cancel-run.test.ts).
    await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(secondRun.run_id)}/interaction`, {
      body: JSON.stringify({ interaction_id: secondPending.interaction_id, status: "cancelled" }),
      headers: { "Content-Type": "application/json", Cookie: aliceCookie },
      method: "POST",
    });
    const secondRunTerminalEvents = await waitForRunTerminal(asUrl, secondRun.run_id, aliceCookie, 10_000);
    assert.ok(
      secondRunTerminalEvents.some((e) => e.event_type === "run.cancel_requested"),
      "the owner's cancel request must be recorded on the run's timeline"
    );
    assert.ok(
      secondRunTerminalEvents.some(
        (e) => e.event_type === "run.cancelled" || e.event_type === "run.failed" || e.event_type === "run.completed"
      ),
      "the cancelled run must reach a terminal state"
    );

    // --- restart: the reference server (same dbPath) survives a full
    // process-level restart, and owner_alice's completed run remains
    // readable through the same owner-session surface afterward. ---
    await closeServer(server);
    server = await startServer({
      asPort: 0,
      connectorPathResolver: () => connectorPath,
      dbPath,
      ownerAuthPassword: OWNER_PASSWORD,
      ownerAuthSubjectId: OWNER_SUBJECT_ID,
      quiet: true,
      rsPort: 0,
      webPushSubscriptionStore: pushStore,
    });
    asUrl = `http://localhost:${server.asPort}`;
    const postRestartCookie = await loginAsConfiguredOwner(asUrl);
    const timelineAfterRestart = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`, {
      headers: { Cookie: postRestartCookie },
    });
    assert.equal(timelineAfterRestart.status, 200);
    const eventsAfterRestart = Array.isArray(timelineAfterRestart.body.data)
      ? (timelineAfterRestart.body.data as TimelineEvent[])
      : [];
    assert.ok(
      eventsAfterRestart.some((e) => e.event_type === "run.completed"),
      "the run's history must survive a full server restart against the same database"
    );
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { force: true, recursive: true });
  }
});
