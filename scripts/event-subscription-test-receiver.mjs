#!/usr/bin/env node
/**
 * Local test receiver for PDPP client event subscriptions.
 *
 * Spins up a tiny Node HTTP server that:
 *   - Verifies the Standard Webhooks signature on every delivery.
 *   - Echoes the `data.challenge` value in the body of any
 *     `pdpp.subscription.verify` event so the reference deployment can
 *     complete its `post_with_challenge_echo` handshake.
 *   - Pretty-prints each CloudEvents envelope to stdout.
 *
 * Usage:
 *
 *   node scripts/event-subscription-test-receiver.mjs [--port N]
 *       [--secret whsec_…] [--insecure]
 *
 * The receiver does not register the subscription for you. Create the
 * subscription from your client (the MCP adapter's create_event_subscription
 * tool, or a direct POST /v1/event-subscriptions) with `callback_url`
 * pointing at this receiver's `/webhook` path. Capture the `secret`
 * returned by the create call and set it as WEBHOOK_SECRET (or pass
 * --secret) before the deployment delivers the verify event.
 *
 * Receiver intentionally has no persistent storage and no retry logic. It
 * is a verifier, not a substitute for a real callback host.
 *
 * Authoritative wire shape:
 *   /.well-known/oauth-protected-resource → capabilities.client_event_subscriptions
 *   docs/operator/event-subscriptions.md
 *
 * No code change here mutates the host filesystem; the receiver is a
 * read-only verifier. It does, however, accept incoming network traffic
 * on the configured port. Bind only to localhost by default.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const DEFAULT_PORT = 8765;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, secret: process.env.WEBHOOK_SECRET ?? null, insecure: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      out.port = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535) {
        die(`invalid --port value: ${argv[i]}`);
      }
    } else if (arg === "--secret") {
      out.secret = argv[++i] ?? null;
    } else if (arg === "--insecure") {
      out.insecure = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      die(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function printUsage() {
  process.stdout.write(
    [
      "Local test receiver for PDPP client event subscriptions.",
      "",
      "Usage:",
      "  node scripts/event-subscription-test-receiver.mjs [--port N] [--secret whsec_…] [--insecure]",
      "",
      "Flags:",
      "  --port N        Listen port (default 8765).",
      "  --secret SECRET Per-subscription secret returned by POST /v1/event-subscriptions.",
      "                  May also be set via the WEBHOOK_SECRET environment variable.",
      "  --insecure      Skip signature verification. For one-off envelope inspection only.",
      "",
    ].join("\n"),
  );
}

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  printUsage();
  process.exit(2);
}

function decodeWebhookSecret(secret) {
  if (secret.startsWith("whsec_")) {
    return Buffer.from(secret.slice("whsec_".length), "base64");
  }
  return Buffer.from(secret, "utf8");
}

function expectedSignature(secret, eventId, timestamp, body) {
  const key = decodeWebhookSecret(secret);
  return createHmac("sha256", key).update(`${eventId}.${timestamp}.${body}`).digest("base64");
}

function verify(secret, eventId, timestampHeader, body, signatureHeader) {
  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "missing or non-numeric webhook-timestamp" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: `webhook-timestamp outside ±${SIGNATURE_TOLERANCE_SECONDS}s of receiver clock` };
  }
  const expected = expectedSignature(secret, eventId, ts, body);
  const expectedBuf = Buffer.from(expected);
  const tokens = signatureHeader.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const idx = token.indexOf(",");
    if (idx < 0) continue;
    if (token.slice(0, idx) !== "v1") continue;
    const candidateBuf = Buffer.from(token.slice(idx + 1));
    if (
      candidateBuf.length === expectedBuf.length &&
      timingSafeEqual(candidateBuf, expectedBuf)
    ) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "no v1 token matched expected signature" };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function timestamp() {
  return new Date().toISOString();
}

function handleVerifyEvent(envelope) {
  const challenge = envelope?.data?.challenge;
  if (typeof challenge !== "string") {
    return null;
  }
  return JSON.stringify({ challenge });
}

async function main() {
  const args = parseArgs(process.argv);
  let secret = args.secret;
  if (!args.insecure && !secret) {
    process.stderr.write(
      [
        "warning: no secret configured.",
        "  Set WEBHOOK_SECRET or pass --secret <whsec_…> before the deployment delivers events.",
        "  Until then, the receiver will reject every signed delivery as `no_secret_configured`.",
        "",
      ].join("\n"),
    );
  }

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, listening: args.port, has_secret: Boolean(secret) }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
      return;
    }
    const eventId = req.headers["webhook-id"];
    const ts = req.headers["webhook-timestamp"];
    const sig = req.headers["webhook-signature"];
    const body = await readBody(req);
    const headerProblems = [];
    if (typeof eventId !== "string") headerProblems.push("webhook-id missing");
    if (typeof ts !== "string") headerProblems.push("webhook-timestamp missing");
    if (typeof sig !== "string") headerProblems.push("webhook-signature missing");
    if (headerProblems.length > 0) {
      process.stderr.write(`[${timestamp()}] rejecting delivery: ${headerProblems.join("; ")}\n`);
      res.writeHead(400, { "content-type": "text/plain" });
      res.end(`bad request: ${headerProblems.join("; ")}\n`);
      return;
    }

    if (!args.insecure) {
      if (!secret) {
        process.stderr.write(`[${timestamp()}] rejecting delivery webhook-id=${eventId}: no_secret_configured\n`);
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("no secret configured on receiver\n");
        return;
      }
      const v = verify(secret, eventId, ts, body, sig);
      if (!v.ok) {
        process.stderr.write(`[${timestamp()}] rejecting delivery webhook-id=${eventId}: ${v.reason}\n`);
        res.writeHead(401, { "content-type": "text/plain" });
        res.end(`signature rejected: ${v.reason}\n`);
        return;
      }
    }

    let envelope = null;
    try {
      envelope = JSON.parse(body);
    } catch (err) {
      process.stderr.write(`[${timestamp()}] received non-JSON delivery webhook-id=${eventId}: ${err}\n`);
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("non-JSON body\n");
      return;
    }

    const eventType = envelope?.type ?? "<no type>";
    process.stdout.write(`[${timestamp()}] ${eventType} webhook-id=${eventId}\n`);
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n\n`);

    if (eventType === "pdpp.subscription.verify") {
      const echo = handleVerifyEvent(envelope);
      if (!echo) {
        process.stderr.write(`[${timestamp()}] verify event has no data.challenge string; replying 422\n`);
        res.writeHead(422, { "content-type": "text/plain" });
        res.end("verify event missing data.challenge\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(echo);
      process.stdout.write(`[${timestamp()}] echoed challenge for subscription verification\n\n`);
      return;
    }

    res.writeHead(204);
    res.end();
  });

  server.listen(args.port, "127.0.0.1", () => {
    process.stdout.write(
      [
        `PDPP event-subscription test receiver listening on http://127.0.0.1:${args.port}/webhook`,
        `  health:   http://127.0.0.1:${args.port}/health`,
        `  secret:   ${args.insecure ? "(--insecure; verification skipped)" : secret ? "configured" : "NOT SET — pass --secret or WEBHOOK_SECRET"}`,
        "",
        "Create a subscription with callback_url=http://localhost:" +
          args.port +
          "/webhook from your client to drive the verification handshake.",
        "",
      ].join("\n"),
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      process.stdout.write(`\n[${timestamp()}] ${signal} received; closing receiver\n`);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
