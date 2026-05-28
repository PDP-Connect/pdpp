/**
 * Smoke test for scripts/event-subscription-test-receiver.mjs.
 *
 * Exercises three paths against the real receiver process:
 *   1. /health responds 200 JSON.
 *   2. A correctly signed pdpp.subscription.verify delivery receives a
 *      200 echo with `{challenge: …}` matching the data.challenge value.
 *   3. A signed delivery with the wrong secret receives 401.
 *
 * Run: node --test scripts/event-subscription-test-receiver.test.mjs
 */

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RECEIVER = `${HERE}event-subscription-test-receiver.mjs`;
const SECRET = "whsec_dGVzdC1zZWNyZXQtZm9yLXJlY2VpdmVyLXNwZWMtMTIzNDU="; // base64 of a test key

function decode(secret) {
  return Buffer.from(secret.slice("whsec_".length), "base64");
}

function sign(secret, eventId, timestamp, body) {
  const key = decode(secret);
  return `v1,${createHmac("sha256", key).update(`${eventId}.${timestamp}.${body}`).digest("base64")}`;
}

async function pickFreePort() {
  const { default: net } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startReceiver(port, secret) {
  const proc = spawn("node", [RECEIVER, "--port", String(port), "--secret", secret], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait for the "listening on …" line so callers know the port is open.
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      if (text.includes("listening on")) {
        proc.stdout.off("data", onData);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    proc.once("error", reject);
    proc.once("exit", (code) => reject(new Error(`receiver exited early code=${code}`)));
  });
  return proc;
}

async function stopReceiver(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await once(proc, "exit");
}

test("event-subscription-test-receiver: /health reports listening", async () => {
  const port = await pickFreePort();
  const proc = await startReceiver(port, SECRET);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.listening, port);
    assert.equal(body.has_secret, true);
  } finally {
    await stopReceiver(proc);
  }
});

test("event-subscription-test-receiver: signed verify event echoes challenge", async () => {
  const port = await pickFreePort();
  const proc = await startReceiver(port, SECRET);
  try {
    const eventId = "evt_test_verify_001";
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      specversion: "1.0",
      type: "pdpp.subscription.verify",
      id: eventId,
      data: { challenge: "challenge-value-xyz", subscription_id: "sub_001" },
    });
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/cloudevents+json; charset=utf-8",
        "webhook-id": eventId,
        "webhook-timestamp": String(ts),
        "webhook-signature": sign(SECRET, eventId, ts, body),
      },
      body,
    });
    assert.equal(res.status, 200);
    const echoed = await res.json();
    assert.equal(echoed.challenge, "challenge-value-xyz");
  } finally {
    await stopReceiver(proc);
  }
});

test("event-subscription-test-receiver: wrong-secret delivery is rejected", async () => {
  const port = await pickFreePort();
  const proc = await startReceiver(port, SECRET);
  try {
    const eventId = "evt_test_bad_sig";
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      specversion: "1.0",
      type: "pdpp.subscription.test",
      id: eventId,
      data: { subscription_id: "sub_002" },
    });
    const wrongSecret = "whsec_d3JvbmctdGVzdC1zZWNyZXQtZG8tbm90LW1hdGNo";
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/cloudevents+json; charset=utf-8",
        "webhook-id": eventId,
        "webhook-timestamp": String(ts),
        "webhook-signature": sign(wrongSecret, eventId, ts, body),
      },
      body,
    });
    assert.equal(res.status, 401);
  } finally {
    await stopReceiver(proc);
  }
});

test("event-subscription-test-receiver: signed non-verify event returns 204", async () => {
  const port = await pickFreePort();
  const proc = await startReceiver(port, SECRET);
  try {
    const eventId = "evt_records_changed_001";
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      specversion: "1.0",
      type: "pdpp.records.changed",
      id: eventId,
      data: { subscription_id: "sub_003", changes_since: "cursor-xyz" },
    });
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/cloudevents+json; charset=utf-8",
        "webhook-id": eventId,
        "webhook-timestamp": String(ts),
        "webhook-signature": sign(SECRET, eventId, ts, body),
      },
      body,
    });
    assert.equal(res.status, 204);
  } finally {
    await stopReceiver(proc);
  }
});
