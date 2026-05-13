#!/usr/bin/env node

import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 90_000;
const DEBUG_EVENT_BUFFER_MAX = 2_000;
const STREAM_FRAME_SELECTOR = '[aria-label="Connector browser stream"]';
const EVIDENCE_DIR = path.join(repoRoot, "tmp", "stream-smoke");

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

function eventSummary(event) {
  const payload = eventPayload(event);
  return {
    type: eventType(event),
    viewerId: typeof event?.viewerId === "string" ? event.viewerId : null,
    receivedAt: typeof event?.receivedAt === "string" ? event.receivedAt : null,
    payload: summarizePayload(payload),
  };
}

function summarizePayload(payload) {
  const out = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (
      [
        "type",
        "status",
        "count",
        "clientX",
        "clientY",
        "pageX",
        "pageY",
        "innerWidth",
        "innerHeight",
        "devicePixelRatio",
        "scrollX",
        "scrollY",
        "pageId",
        "seq",
        "backend",
        "runId",
        "interactionId",
        "smokeTokenPresent",
        "valueLength",
        "target",
        "elementAtPoint",
        "activeElement",
        "calibration",
        "controls",
        "beacons",
        "visualViewport",
        "error",
      ].includes(key)
    ) {
      out[key] = value;
    }
  }
  return out;
}

function latestEvent(events, predicate) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (predicate(event, eventPayload(event), eventType(event))) return event;
  }
  return null;
}

function latestRemoteLayoutEvent(events) {
  return latestEvent(
    events,
    (_event, payload, type) =>
      (type === "playground.ready" || type === "playground.calibration_init") &&
      payload.controls &&
      typeof payload.controls === "object"
  );
}

function resolveRemoteControlTarget(events, controlId) {
  const layoutEvent = latestRemoteLayoutEvent(events);
  const payload = layoutEvent ? eventPayload(layoutEvent) : null;
  const control = payload?.controls?.[controlId];
  const centre = control?.centre;
  const remoteWidth = Number(payload?.visualViewport?.width || payload?.innerWidth);
  const remoteHeight = Number(payload?.visualViewport?.height || payload?.innerHeight);
  if (
    Number.isFinite(centre?.x) &&
    Number.isFinite(centre?.y) &&
    Number.isFinite(remoteWidth) &&
    remoteWidth > 0 &&
    Number.isFinite(remoteHeight) &&
    remoteHeight > 0
  ) {
    return {
      sourceType: eventType(layoutEvent),
      controlId,
      remote: { x: centre.x, y: centre.y, width: remoteWidth, height: remoteHeight },
      xRatio: centre.x / remoteWidth,
      yRatio: centre.y / remoteHeight,
    };
  }
  return null;
}

async function streamFrameReport(page) {
  const frame = page.locator(STREAM_FRAME_SELECTOR).first();
  const box = await frame.boundingBox().catch(() => null);
  const attrs = await frame
    .evaluate((node) => ({
      loading: node.getAttribute("data-pdpp-stream-loading"),
      debug: node.getAttribute("data-pdpp-stream-debug"),
      width: node.clientWidth,
      height: node.clientHeight,
    }))
    .catch((error) => ({ error: error.message }));
  return { box, attrs };
}

async function captureFailureEvidence(page, debugEvents, message) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(EVIDENCE_DIR, `manual-action-stream-smoke-${stamp}.png`);
  const frame = await streamFrameReport(page);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  const recent = debugEvents.slice(-30).map(eventSummary);
  const relevantTypes = [
    "debug.enabled",
    "neko.client.start",
    "neko.media.displayable",
    "stream.input.post.start",
    "stream.input.post.result",
    "stream.input.post.error",
    "playground.ready",
    "playground.calibration_init",
    "playground.pointerdown",
    "playground.pointerup",
    "playground.click",
    "playground.counter_click",
    "playground.focusin",
    "playground.input",
  ];
  const relevant = debugEvents
    .filter((event) => {
      const type = eventType(event);
      return relevantTypes.includes(type) || type.startsWith("surface.neko.") || type.startsWith("neko.touch");
    })
    .slice(-40)
    .map(eventSummary);
  process.stderr.write(
    `${JSON.stringify(
      {
        failure: message,
        pageUrl: page.url(),
        screenshotPath,
        streamFrame: frame,
        remotePlaygroundReady: Boolean(latestEvent(debugEvents, (_event, _payload, type) => type === "playground.ready")),
        remoteLayoutSource: eventType(latestRemoteLayoutEvent(debugEvents)),
        debugEventCount: debugEvents.length,
        recent,
        relevant,
      },
      null,
      2
    )}\n`
  );
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
  const imported = await import(pathToFileURL(resolved).href);
  return imported.chromium ? imported : imported.default;
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

async function clickRemoteControl(page, debugEvents, controlId) {
  const target = resolveRemoteControlTarget(debugEvents, controlId);
  if (!target) {
    fail(`remote playground did not publish a measurable ${controlId} target`);
  }
  await clickInsideStream(page, target.xRatio, target.yRatio);
  return target;
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
        if (debugEvents.length > DEBUG_EVENT_BUFFER_MAX) {
          debugEvents.splice(0, debugEvents.length - DEBUG_EVENT_BUFFER_MAX);
        }
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

    await waitFor(
      () => resolveRemoteControlTarget(debugEvents, "counter"),
      "remote playground telemetry did not publish counter target"
    );

    await clickRemoteControl(page, debugEvents, "counter");
    await waitFor(
      () => hasEvent(debugEvents, (_event, payload, type) => type === "playground.counter_click" && Number(payload.count) >= 1),
      "remote counter did not report an increment"
    );

    const token = `pdpp-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await clickRemoteControl(page, debugEvents, "text-input");
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
  } catch (error) {
    await captureFailureEvidence(page, debugEvents, error instanceof Error ? error.message : String(error)).catch((captureError) => {
      process.stderr.write(`failed to capture smoke evidence: ${captureError.message}\n`);
    });
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
