// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing coverage for the `web_push_unavailable` typed-error code
 * (server/routes/web-push.ts).
 *
 * The operator-only Web Push surface (`POST /_ref/web-push/subscriptions` and
 * `POST /_ref/web-push/test`) requires VAPID to be configured. When the web
 * push config is disabled (no VAPID keypair), each of those endpoints refuses
 * with HTTP 503 and code `web_push_unavailable`, surfacing the config's
 * `unavailableReason` as the message rather than silently 500-ing on a missing
 * keypair or accepting a subscription that can never receive a push.
 *
 * The existing web-push test suite exercises the owner-session gate and the
 * happy path, but never the disabled-config guard; no `test/` file asserted
 * `web_push_unavailable` by name. This test pins both guarded endpoints (503 +
 * code + reason) and a control proving an enabled config does NOT 503.
 *
 * Owner auth is left disabled so the owner session auto-passes and the ONLY
 * thing under test is the VAPID-availability guard.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";
import { createMemoryWebPushSubscriptionStore } from "../server/web-push-notifications.ts";

const UNAVAILABLE_REASON = "VAPID public/private keys are not configured";

type StartedServer = Awaited<ReturnType<typeof startServer>>;
type StoppableServer = StartedServer["asServer"] | StartedServer["rsServer"];

interface ErrorEnvelope {
  error: { code: string; message: string };
}

interface SubscriptionListEnvelope {
  data: unknown[];
}

function hasCloseAllConnections(server: object): server is { closeAllConnections: () => void } {
  return "closeAllConnections" in server && typeof server.closeAllConnections === "function";
}

async function closeServer(server: StartedServer): Promise<void> {
  const closeOne = (httpServer: StoppableServer) =>
    new Promise<void>((resolve) => {
      if (!httpServer) {
        resolve();
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      if (hasCloseAllConnections(httpServer)) {
        httpServer.closeAllConnections();
      }
      httpServer.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

function sampleSubscription() {
  return { endpoint: "https://push.example.invalid/sub/one", keys: { auth: "a", p256dh: "p" } };
}

test("web push endpoints refuse with web_push_unavailable (503) when VAPID is not configured", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    webPushConfig: {
      enabled: false,
      privateKey: null,
      publicKey: null,
      subject: "mailto:operator@example.test",
      unavailableReason: UNAVAILABLE_REASON,
    },
    webPushSubscriptionStore: createMemoryWebPushSubscriptionStore(),
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    // POST /subscriptions
    const create = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
      body: JSON.stringify({ subscription: sampleSubscription() }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(create.status, 503, "create SHALL 503 when web push is unavailable");
    const createBody = (await create.json()) as ErrorEnvelope;
    assert.equal(createBody.error.code, "web_push_unavailable");
    assert.equal(createBody.error.message, UNAVAILABLE_REASON, "unavailableReason SHALL be surfaced");

    // POST /test
    const ping = await fetch(`${asUrl}/_ref/web-push/test`, {
      body: JSON.stringify({}),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(ping.status, 503, "test SHALL 503 when web push is unavailable");
    const pingBody = (await ping.json()) as ErrorEnvelope;
    assert.equal(pingBody.error.code, "web_push_unavailable");

    // The rejected create SHALL persist no subscription.
    const list = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as SubscriptionListEnvelope;
    assert.equal(listBody.data.length, 0, "no subscription is persisted while unavailable");
  } finally {
    await closeServer(server);
  }
});

test("an enabled web push config does NOT 503 the create endpoint (control)", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    webPushConfig: {
      enabled: true,
      privateKey: "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
      publicKey: "BAabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcd",
      subject: "mailto:test@example.invalid",
      unavailableReason: null,
    },
    webPushSubscriptionStore: createMemoryWebPushSubscriptionStore(),
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const create = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
      body: JSON.stringify({ subscription: sampleSubscription() }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
      redirect: "manual",
    });
    assert.notEqual(create.status, 503, "an enabled config SHALL NOT report web_push_unavailable");
    assert.equal(create.status, 201, "a valid subscription is created when web push is available");
  } finally {
    await closeServer(server);
  }
});
