// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Smoke test for scripts/event-subscription-test-receiver.ts.
 *
 * Exercises three paths against the real receiver process:
 *   1. /health responds 200 JSON.
 *   2. A correctly signed pdpp.subscription.verify delivery receives a
 *      200 echo with `{challenge: …}` matching the data.challenge value.
 *   3. A signed delivery with the wrong secret receives 401.
 *
 * Run: node --test --import tsx scripts/event-subscription-test-receiver.test.ts
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { registerEphemeralOrigin, unregisterEphemeralOrigin } from "./hermetic/guard.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RECEIVER = `${HERE}event-subscription-test-receiver.ts`;
const SECRET = "whsec_dGVzdC1zZWNyZXQtZm9yLXJlY2VpdmVyLXNwZWMtMTIzNDU="; // base64 of a test key
// The readiness line the receiver prints once bound; group 1 is the bound port.
const READY_LINE_PATTERN = /listening on http:\/\/\S+:(\d+)\/webhook/;

function decode(secret: string): Buffer {
  return Buffer.from(secret.slice("whsec_".length), "base64");
}

function sign(secret: string, eventId: string, timestamp: number, body: string): string {
  const key = decode(secret);
  return `v1,${createHmac("sha256", key).update(`${eventId}.${timestamp}.${body}`).digest("base64")}`;
}

// Port 0: the child binds a free port itself, so no port is reserved before it listens.
async function startReceiver(
  secret: string | null,
  { host, extraArgs = [] }: { extraArgs?: string[]; host?: string } = {}
): Promise<{ port: number; proc: ChildProcess }> {
  const args = ["--import", "tsx", RECEIVER, "--port", "0"];
  if (secret) {
    args.push("--secret", secret);
  }
  args.push(...extraArgs);
  if (host) {
    args.push("--host", host);
  }
  const proc = spawn("node", args, {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait for the "listening on …" line; it names the port the child bound.
  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const ready = READY_LINE_PATTERN.exec(stdout);
      if (ready) {
        proc.stdout?.off("data", onData);
        resolve(Number(ready[1]));
      }
    };
    proc.stdout?.on("data", onData);
    proc.once("error", reject);
    proc.once("exit", (code) => reject(new Error(`receiver exited early code=${code}`)));
  });
  // This receiver binds in a child process, so the parent's bind hook cannot
  // observe it. Grant only the exact origin handed back by that child.
  registerEphemeralOrigin(`http://127.0.0.1:${port}`);
  return { port, proc };
}

async function stopReceiver(proc: ChildProcess | undefined, port?: number): Promise<void> {
  if (proc && proc.exitCode === null) {
    proc.kill("SIGTERM");
    await once(proc, "exit");
  }
  if (port !== undefined) {
    unregisterEphemeralOrigin(`http://127.0.0.1:${port}`);
  }
}

// Runs the receiver with flags it must refuse. If it starts listening instead, it is stopped and
// `listening` is true, so a regression fails at once rather than leaving the test waiting on it.
async function runRefused(args: string[]): Promise<{ code: number | null; listening: boolean; stderr: string }> {
  const proc = spawn("node", ["--import", "tsx", RECEIVER, ...args], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const listening = await new Promise<boolean>((resolve) => {
    proc.stdout?.on("data", () => {
      if (READY_LINE_PATTERN.test(stdout)) {
        resolve(true);
      }
    });
    proc.once("close", () => resolve(false));
  });
  if (listening) {
    await stopReceiver(proc);
  }
  return { code: proc.exitCode, listening, stderr };
}

test("event-subscription-test-receiver: /health reports listening", async () => {
  const { port, proc } = await startReceiver(SECRET);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.host, "127.0.0.1");
    assert.equal(body.listening, port);
    assert.equal(body.has_secret, true);
  } finally {
    await stopReceiver(proc, port);
  }
});

test("event-subscription-test-receiver: --port 0 reports the bound port and serves on it", async () => {
  const { port, proc } = await startReceiver(SECRET);
  try {
    assert.notEqual(port, 0);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).listening, port);
  } finally {
    await stopReceiver(proc, port);
  }
});

// parseInt reads each of these as 0 or -0, so the whole token has to be a decimal integer.
for (const value of ["0.5", "-0.5", "0oops"]) {
  test(`event-subscription-test-receiver: --port ${value} is refused`, async () => {
    const run = await runRefused(["--port", value]);
    assert.equal(run.listening, false, "receiver started listening");
    assert.equal(run.code, 2);
    assert.equal(run.stderr.split("\n")[0], `error: invalid --port value: ${value}`);
  });
}

test("event-subscription-test-receiver: --host controls bind address", async () => {
  const { port, proc } = await startReceiver(SECRET, { host: "0.0.0.0" });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.host, "0.0.0.0");
    assert.equal(body.listening, port);
  } finally {
    await stopReceiver(proc, port);
  }
});

test("event-subscription-test-receiver: signed verify event echoes challenge", async () => {
  const { port, proc } = await startReceiver(SECRET);
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
    await stopReceiver(proc, port);
  }
});

test("event-subscription-test-receiver: wrong-secret delivery is rejected", async () => {
  const { port, proc } = await startReceiver(SECRET);
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
    await stopReceiver(proc, port);
  }
});

test("event-subscription-test-receiver: --secret-file is read at delivery time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-event-receiver-"));
  const secretPath = join(dir, "webhook-secret");
  const { port, proc } = await startReceiver(null, { extraArgs: ["--secret-file", secretPath] });
  try {
    let health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).has_secret, false);

    await writeFile(secretPath, `${SECRET}\n`, { mode: 0o600 });

    health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).has_secret, true);

    const eventId = "evt_test_verify_secret_file";
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      specversion: "1.0",
      type: "pdpp.subscription.verify",
      id: eventId,
      data: { challenge: "challenge-from-secret-file", subscription_id: "sub_secret_file" },
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
    assert.equal((await res.json()).challenge, "challenge-from-secret-file");
  } finally {
    await stopReceiver(proc, port);
    await rm(dir, { recursive: true, force: true });
  }
});

test("event-subscription-test-receiver: signed non-verify event returns 204", async () => {
  const { port, proc } = await startReceiver(SECRET);
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
    await stopReceiver(proc, port);
  }
});
