#!/usr/bin/env node

import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 90_000;
const STREAM_FRAME_SELECTOR = '[aria-label="Connector browser stream"]';

function env(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function publicUrlFromEnv() {
  return env("PDPP_STREAM_SMOKE_URL") || env("PDPP_PUBLIC_URL") || env("PDPP_REFERENCE_ORIGIN");
}

function smokeUrl(origin) {
  const url = new URL("/dashboard/stream-playground", origin);
  url.searchParams.set("backend", env("PDPP_STREAM_SMOKE_BACKEND") || "neko");
  url.searchParams.set("stream_debug", "1");
  return url.toString();
}

function skip(message) {
  process.stdout.write(`SKIP manual-action stream smoke: ${message}\n`);
}

function fail(message) {
  throw new Error(`FAIL manual-action stream smoke: ${message}`);
}

function parseDebugEventsFromPostData(postData) {
  if (!postData) return [];
  try {
    const parsed = JSON.parse(postData);
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

function eventType(event) {
  return typeof event?.type === "string" ? event.type : typeof event?.name === "string" ? event.name : "";
}

function eventPayload(event) {
  return event?.payload && typeof event.payload === "object" ? event.payload : {};
}

function hasEvent(events, predicate) {
  return events.some((event) => {
    try {
      return predicate(event, eventPayload(event), eventType(event));
    } catch {
      return false;
    }
  });
}

async function waitFor(predicate, message, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) {
    fail(`${message}: ${lastError.message}`);
  }
  fail(message);
}

async function importPatchright() {
  let resolved;
  try {
    resolved = require.resolve("patchright", {
      paths: [path.join(repoRoot, "reference-implementation")],
    });
  } catch {
    skip("Patchright is not installed. Run pnpm install before requiring the smoke.");
    process.exit(0);
  }
  return import(pathToFileURL(resolved).href);
}

async function deploymentReachable(origin) {
  try {
    const response = await fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

async function ensureOwnerSession(page) {
  const password = env("PDPP_STREAM_SMOKE_OWNER_PASSWORD") || env("PDPP_OWNER_PASSWORD");
  if (!/\/owner\/login(?:\?|$)/.test(page.url())) {
    return;
  }
  if (!password) {
    skip("owner login is required; set PDPP_STREAM_SMOKE_OWNER_PASSWORD or PDPP_OWNER_PASSWORD.");
    process.exit(0);
  }
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL(/\/dashboard\/stream-playground/, { timeout: DEFAULT_TIMEOUT_MS }),
    page.getByRole("button", { name: /sign in/i }).click(),
  ]);
}

async function clickInsideStream(page, xRatio, yRatio) {
  const frame = page.locator(STREAM_FRAME_SELECTOR).first();
  const box = await frame.boundingBox();
  if (!box) {
    fail("stream frame is not measurable");
  }
  await page.mouse.click(Math.round(box.x + box.width * xRatio), Math.round(box.y + box.height * yRatio));
}

async function run() {
  const origin = publicUrlFromEnv();
  if (!origin) {
    skip("set PDPP_STREAM_SMOKE_URL, PDPP_PUBLIC_URL, or PDPP_REFERENCE_ORIGIN to the running Docker/public web origin.");
    return;
  }
  if (!(await deploymentReachable(origin))) {
    skip(`configured origin is not reachable: ${origin}`);
    return;
  }

  const { chromium } = await importPatchright();
  const debugEvents = [];
  const browser = await chromium.launch({ headless: env("PDPP_STREAM_SMOKE_HEADFUL") !== "1" });
  const page = await browser.newPage({
    viewport: { width: 430, height: 820 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  });

  page.on("request", (request) => {
    try {
      const url = new URL(request.url());
      if (url.pathname === "/api/stream-debug") {
        debugEvents.push(...parseDebugEventsFromPostData(request.postData()));
      }
    } catch {
      // Ignore malformed request URLs from browser internals.
    }
  });

  try {
    const url = smokeUrl(origin);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await ensureOwnerSession(page);

    await page.getByRole("button", { name: /open browser/i }).click();
    const streamFrame = page.locator(STREAM_FRAME_SELECTOR).first();
    await streamFrame.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });

    await waitFor(
      async () =>
        !(await streamFrame.evaluate((node) => Boolean(node.getAttribute("data-pdpp-stream-loading"))).catch(() => true)) ||
        hasEvent(debugEvents, (_event, _payload, type) => type === "neko.media.displayable"),
      "stream never became displayable"
    );

    await waitFor(
      () =>
        hasEvent(
          debugEvents,
          (event, payload, type) =>
            type === "debug.enabled" ||
            type === "neko.client.start" ||
            type === "neko.media.displayable" ||
            (type === "stream.input.post.result" && payload.status === 202) ||
            Boolean(event.viewerId)
        ),
      "stream debug telemetry did not initialize"
    );

    await clickInsideStream(page, 0.36, 0.18);
    await waitFor(
      () => hasEvent(debugEvents, (_event, payload, type) => type === "playground.counter_click" && Number(payload.count) >= 1),
      "remote counter did not report an increment"
    );

    const token = `pdpp-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await clickInsideStream(page, 0.38, 0.26);
    await page.keyboard.type(token, { delay: 8 });
    await waitFor(
      () =>
        hasEvent(
          debugEvents,
          (_event, payload, type) =>
            type === "playground.input" &&
            payload.smokeTokenPresent === true &&
            Number(payload.valueLength) >= token.length
        ),
      "unique smoke token did not land in the remote playground input"
    );

    await waitFor(
      () =>
        hasEvent(debugEvents, (_event, _payload, type) => type.startsWith("surface.neko.") || type.startsWith("neko.touch")) &&
        hasEvent(debugEvents, (_event, payload, type) => type === "playground.click" || type === "playground.input") &&
        hasEvent(debugEvents, (_event, payload, type) => type === "stream.input.post.result" || type === "neko.client.start"),
      "telemetry did not capture both local input path and remote playground events"
    );

    process.stdout.write(`PASS manual-action stream smoke ${url}\n`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
