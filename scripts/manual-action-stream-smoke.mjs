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
const STRICT_SMOKE_TOKEN = "pdpp-smoke";
const MOBILE_SMOKE = "1";

function env(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function publicUrlFromEnv() {
  return env("PDPP_STREAM_SMOKE_URL") || env("PDPP_PUBLIC_URL") || env("PDPP_REFERENCE_ORIGIN");
}

function mobileSmokeEnabled() {
  return env("PDPP_STREAM_SMOKE_MOBILE") === MOBILE_SMOKE;
}

function appendEvidence(list, entry) {
  if (list.length < 50) list.push(entry);
}

function redactRequestUrl(value) {
  try {
    const url = new URL(value);
    for (const name of ["token", "access_token", "id_token", "code"]) {
      if (url.searchParams.has(name)) url.searchParams.set(name, "[redacted]");
    }
    return url.toString();
  } catch {
    return String(value);
  }
}

function browserExecutablePath() {
  return env("PDPP_STREAM_SMOKE_BROWSER_EXECUTABLE_PATH");
}

function smokeUrl(origin) {
  const url = new URL("/stream-playground", origin);
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

export function isKnownBlackFrameFailure(pixels, signature) {
  const uniformlyBlack = pixels.sampled && pixels.nearBlackRatio >= 0.995 && pixels.brightRatio <= 0.002;
  // A remote page may legitimately be dark. The regression is the absence of
  // the first decoded frame in combination with a uniformly black stream
  // raster and a visible stream failure affordance. A merely-loading black
  // surface has no affordance and is not this failure signature.
  return uniformlyBlack && signature.hasErrorAffordance && !signature.hasFirstFrameSignal;
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

function hasEventAfter(events, sequence, predicate) {
  return hasEvent(events, (event, payload, type) => {
    return Number(event?.__smokeSequence) > sequence && predicate(event, payload, type);
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
        "eventType",
        "insideMedia",
        "insideOverlay",
        "insideWrapper",
        "mapped",
        "mappingBasis",
        "pageCdpAvailable",
        "reason",
        "reasons",
        "result",
        "screen",
        "strictSafe",
        "viewport",
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

function latestNekoPageCdpAvailability(events) {
  const event = latestEvent(
    events,
    (_event, payload, type) => type === "neko.status.poll" && typeof payload.pageCdpAvailable === "boolean"
  );
  return event ? eventPayload(event).pageCdpAvailable : null;
}

function latestNekoStatusViewport(events) {
  const event = latestEvent(events, (_event, payload, type) => type === "neko.status.poll" && payload.viewport);
  const viewport = event ? eventPayload(event).viewport : null;
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { width, height } : null;
}

function hasHealthyNekoPointerMapping(events) {
  return hasEvent(
    events,
    (_event, payload, type) =>
      type === "neko.pointer_mapping" &&
      (payload.eventType === "pointerdown" || payload.eventType === "mousedown") &&
      payload.mapped &&
      typeof payload.mapped === "object" &&
      payload.insideOverlay === true &&
      !hasEvent(
        events,
        (_issueEvent, issuePayload, issueType) =>
          issueType === "neko.pointer_mapping.issue" &&
          Array.isArray(issuePayload.reasons) &&
          issuePayload.reasons.length > 0
      )
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
      remotePoint: { x: centre.x, y: centre.y },
      remoteViewport: { width: remoteWidth, height: remoteHeight },
    };
  }
  return null;
}

function containedStreamRect(imageBox, viewport) {
  const aspectRatio = viewport.width / viewport.height;
  const boxRatio = imageBox.width / imageBox.height;
  if (!(Number.isFinite(aspectRatio) && Number.isFinite(boxRatio)) || imageBox.width <= 0 || imageBox.height <= 0) {
    return imageBox;
  }
  if (boxRatio > aspectRatio) {
    const width = imageBox.height * aspectRatio;
    return {
      x: imageBox.x + (imageBox.width - width) / 2,
      y: imageBox.y,
      width,
      height: imageBox.height,
    };
  }
  const height = imageBox.width / aspectRatio;
  return {
    x: imageBox.x,
    y: imageBox.y + (imageBox.height - height) / 2,
    width: imageBox.width,
    height,
  };
}

function mapRemoteRectToLocalClip(contentRect, remoteRect, remoteViewport) {
  const x = contentRect.x + (contentRect.width * remoteRect.x) / remoteViewport.width;
  const y = contentRect.y + (contentRect.height * remoteRect.y) / remoteViewport.height;
  const width = (contentRect.width * remoteRect.width) / remoteViewport.width;
  const height = (contentRect.height * remoteRect.height) / remoteViewport.height;
  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
  };
}

function strictVisualInputTarget(remoteViewport) {
  if (remoteViewport.width > remoteViewport.height && remoteViewport.height <= 672) {
    // The debug playground switches to a two-column landscape layout. The
    // input occupies the second row of the right column.
    return {
      clickPoint: { x: remoteViewport.width * 0.51, y: remoteViewport.height * 0.12 },
      cropRect: {
        x: remoteViewport.width * 0.34,
        y: remoteViewport.height * 0.075,
        width: remoteViewport.width * 0.36,
        height: remoteViewport.height * 0.09,
      },
    };
  }
  return {
    clickPoint: { x: remoteViewport.width * 0.5, y: remoteViewport.height * 0.28 },
    cropRect: {
      x: remoteViewport.width * 0.08,
      y: remoteViewport.height * 0.235,
      width: remoteViewport.width * 0.84,
      height: remoteViewport.height * 0.095,
    },
  };
}

function normalizeClipToViewport(clip, viewportSize) {
  const maxWidth = viewportSize?.width || clip.x + clip.width;
  const maxHeight = viewportSize?.height || clip.y + clip.height;
  const x = Math.max(0, Math.min(Math.floor(clip.x), Math.max(0, maxWidth - 1)));
  const y = Math.max(0, Math.min(Math.floor(clip.y), Math.max(0, maxHeight - 1)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.ceil(clip.width), maxWidth - x)),
    height: Math.max(1, Math.min(Math.ceil(clip.height), maxHeight - y)),
  };
}

async function captureStreamRemoteRect(page, remoteRect, remoteViewport) {
  const contentRect = await streamContentRect(page, remoteViewport);
  const clip = normalizeClipToViewport(mapRemoteRectToLocalClip(contentRect, remoteRect, remoteViewport), page.viewportSize());
  return {
    clip,
    png: await page.screenshot({ clip }),
  };
}

async function comparePngVisualChange(page, beforePng, afterPng) {
  return page.evaluate(
    async ({ beforeDataUrl, afterDataUrl }) => {
      async function decode(dataUrl) {
        const img = new Image();
        img.decoding = "sync";
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error("failed to decode smoke screenshot"));
          img.src = dataUrl;
        });
        return img;
      }
      const before = await decode(beforeDataUrl);
      const after = await decode(afterDataUrl);
      const width = Math.min(before.naturalWidth, after.naturalWidth);
      const height = Math.min(before.naturalHeight, after.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("2d canvas unavailable for smoke screenshot diff");
      context.drawImage(before, 0, 0, width, height);
      const a = context.getImageData(0, 0, width, height).data;
      context.clearRect(0, 0, width, height);
      context.drawImage(after, 0, 0, width, height);
      const b = context.getImageData(0, 0, width, height).data;
      let changedPixels = 0;
      let totalDelta = 0;
      const pixels = width * height;
      for (let i = 0; i < a.length; i += 4) {
        const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        totalDelta += delta;
        if (delta >= 36) changedPixels += 1;
      }
      return {
        width,
        height,
        changedPixels,
        changedRatio: pixels > 0 ? changedPixels / pixels : 0,
        meanRgbDelta: pixels > 0 ? totalDelta / pixels : 0,
      };
    },
    {
      beforeDataUrl: `data:image/png;base64,${beforePng.toString("base64")}`,
      afterDataUrl: `data:image/png;base64,${afterPng.toString("base64")}`,
    }
  );
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

async function streamFramePixelStats(page) {
  const frame = page.locator(STREAM_FRAME_SELECTOR).first();
  const mediaPixels = await frame.evaluate((node) => {
    const media = node.querySelector("video, canvas");
    if (!media) return { sampled: false };
    const canvas = document.createElement("canvas");
    const sourceWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.width;
    const sourceHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.height;
    if (!(sourceWidth > 0 && sourceHeight > 0)) return { sampled: false };
    const scale = Math.min(1, 240 / Math.max(sourceWidth, sourceHeight));
    canvas.width = Math.max(1, Math.floor(sourceWidth * scale));
    canvas.height = Math.max(1, Math.floor(sourceHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("stream pixel probe could not create a 2d context");
    context.drawImage(media, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nearBlack = 0;
    let bright = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      if (red <= 12 && green <= 12 && blue <= 12) nearBlack += 1;
      if (red >= 48 || green >= 48 || blue >= 48) bright += 1;
    }
    const total = pixels.length / 4;
    return {
      bright,
      brightRatio: bright / total,
      nearBlack,
      nearBlackRatio: nearBlack / total,
      sampled: true,
      total,
    };
  });
  if (mediaPixels.sampled) return mediaPixels;

  // The known failure can tear the media node down entirely while leaving the
  // stream rectangle black. Sample its exposed rectangle itself, not arbitrary
  // page pixels. PDPP instruction/error controls are painted over that same
  // rectangle, so exclude their intersections rather than diluting a black
  // stream with readable UI copy.
  const excludedRects = await frame.evaluate((node) => {
    const frameRect = node.getBoundingClientRect();
    return [...document.querySelectorAll("[data-pdpp-stream-ui]")]
      .map((element) => element.getBoundingClientRect())
      .map((rect) => ({
        bottom: Math.min(frameRect.bottom, rect.bottom) - frameRect.top,
        left: Math.max(frameRect.left, rect.left) - frameRect.left,
        right: Math.min(frameRect.right, rect.right) - frameRect.left,
        top: Math.max(frameRect.top, rect.top) - frameRect.top,
      }))
      .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
  });
  const png = await frame.screenshot();
  return page.evaluate(
    async ({ dataUrl, excludedRects }) => {
      const image = new Image();
      image.decoding = "sync";
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("failed to decode stream-frame screenshot"));
        image.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 240 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("stream-frame screenshot pixel probe could not create a 2d context");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let nearBlack = 0;
      let bright = 0;
      let total = 0;
      // The outer 10%/bottom quarter belongs to chrome, dock, and transient
      // stream controls. Judge the exposed central presentation raster; it is
      // the part that was visibly all-black in the regression screenshot.
      const presentation = {
        bottom: image.naturalHeight * 0.75,
        left: image.naturalWidth * 0.1,
        right: image.naturalWidth * 0.9,
        top: image.naturalHeight * 0.1,
      };
      for (let index = 0; index < pixels.length; index += 4) {
        const pixel = index / 4;
        const x = ((pixel % canvas.width) + 0.5) * (image.naturalWidth / canvas.width);
        const y = (Math.floor(pixel / canvas.width) + 0.5) * (image.naturalHeight / canvas.height);
        if (x < presentation.left || x >= presentation.right || y < presentation.top || y >= presentation.bottom) {
          continue;
        }
        if (excludedRects.some((rect) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)) {
          continue;
        }
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        if (red <= 12 && green <= 12 && blue <= 12) nearBlack += 1;
        if (red >= 48 || green >= 48 || blue >= 48) bright += 1;
        total += 1;
      }
      return {
        bright,
        brightRatio: total > 0 ? bright / total : 0,
        nearBlack,
        nearBlackRatio: total > 0 ? nearBlack / total : 0,
        sampled: total > 0,
        total,
      };
    },
    { dataUrl: `data:image/png;base64,${png.toString("base64")}`, excludedRects }
  );
}

async function streamFailureSignature(page) {
  const frame = page.locator(STREAM_FRAME_SELECTOR).first();
  return frame.evaluate((node) => {
    const media = node.querySelector("video, canvas");
    const video = media instanceof HTMLVideoElement ? media : null;
    const inlineError = [...node.querySelectorAll("[data-pdpp-stream-ui]")].some((element) =>
      /n\.eko WebRTC stream did not attach|secure browser viewport could not be applied/i.test(element.textContent || "")
    );
    const retryAffordance = [...node.querySelectorAll("button")].some((button) => /retry secure browser/i.test(button.textContent || ""));
    const bodyText = document.body?.innerText || "";
    const reachFailure =
      /couldn['’]t reach the browser stream|browser stream failed to start|browser stream isn['’]t available|n\.eko browser window did not settle/i.test(
        bodyText
      );
    return {
      hasErrorAffordance: Boolean(inlineError || retryAffordance || reachFailure),
      // A video can validly show a dark page. Its decoded, advancing frame is
      // the distinguishing signal that keeps dark content from looking like a
      // black-frame failure.
      hasFirstFrameSignal: Boolean(
        video && video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime > 0
      ),
      hasRasterMedia: Boolean(media),
    };
  });
}

async function assertKnownBlackFrameFailureAbsent(page) {
  const pixels = await streamFramePixelStats(page);
  const signature = await streamFailureSignature(page);
  // This is deliberately narrower than "the stream has dark pixels." The
  // regression signature is a uniformly black raster *and* the stream's
  // visible failure affordance with no first decoded frame. A real dark page
  // or a still-loading stream therefore passes this check.
  if (isKnownBlackFrameFailure(pixels, signature)) {
    fail(`known black-frame failure signature: ${JSON.stringify({ pixels, signature })}`);
  }
  return { pixels, signature };
}

async function streamContentRect(page, remoteViewport) {
  const frame = page.locator(STREAM_FRAME_SELECTOR).first();
  const box = await frame.boundingBox();
  if (!box) {
    fail("stream frame is not measurable");
  }
  const mediaBox = await frame
    .evaluate((node) => {
      const media = node.querySelector("video, img");
      if (!media) return null;
      const rect = media.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })
    .catch(() => null);
  if (mediaBox) {
    return containedStreamRect(mediaBox, remoteViewport);
  }
  return box;
}

async function assertMobileViewportFits(page, phase) {
  const metrics = await page.evaluate(() => {
    const visualWidth = window.visualViewport?.width ?? window.innerWidth;
    const documentElement = document.documentElement;
    const body = document.body;
    const frame = document.querySelector('[aria-label="Connector browser stream"]');
    const frameRect = frame?.getBoundingClientRect() ?? null;
    return {
      bodyScrollWidth: body?.scrollWidth ?? 0,
      documentClientWidth: documentElement.clientWidth,
      documentScrollWidth: documentElement.scrollWidth,
      frameRight: frameRect?.right ?? null,
      frameLeft: frameRect?.left ?? null,
      visualWidth,
    };
  });
  const overflowingDocument =
    metrics.documentScrollWidth > metrics.documentClientWidth + 1 ||
    metrics.bodyScrollWidth > metrics.documentClientWidth + 1;
  const frameEscapesVisualViewport =
    metrics.frameLeft !== null &&
    metrics.frameRight !== null &&
    (metrics.frameLeft < -1 || metrics.frameRight > metrics.visualWidth + 1);
  if (overflowingDocument || frameEscapesVisualViewport) {
    fail(`mobile ${phase} viewport does not fit: ${JSON.stringify(metrics)}`);
  }
  return metrics;
}

async function assertDocumentHorizontallyFits(page, phase) {
  const metrics = await page.evaluate(() => {
    const documentElement = document.documentElement;
    const body = document.body;
    return {
      bodyScrollWidth: body?.scrollWidth ?? 0,
      documentClientWidth: documentElement.clientWidth,
      documentScrollWidth: documentElement.scrollWidth,
    };
  });
  if (
    metrics.documentScrollWidth > metrics.documentClientWidth + 1 ||
    metrics.bodyScrollWidth > metrics.documentClientWidth + 1
  ) {
    fail(`non-stream ${phase} route has horizontal overflow: ${JSON.stringify(metrics)}`);
  }
  return metrics;
}

async function proxyKeyboardFocused(page) {
  return page.evaluate(() => {
    const textarea = document.querySelector('[data-pdpp-soft-keyboard="neko"]');
    return Boolean(textarea && document.activeElement === textarea);
  });
}

async function captureFailureEvidence(page, debugEvents, requestEvidence, message) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(EVIDENCE_DIR, `manual-action-stream-smoke-${stamp}.png`);
  const frame = await streamFrameReport(page);
  const framePixels = await streamFramePixelStats(page).catch((error) => ({ error: error.message }));
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  const recent = debugEvents.slice(-30).map(eventSummary);
  const relevantTypes = [
    "debug.enabled",
    "neko.client.start",
    "neko.media.displayable",
    "neko.pointer_mapping",
    "neko.pointer_mapping.issue",
    "neko.status.poll",
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
        streamFramePixels: framePixels,
        remotePlaygroundReady: Boolean(latestEvent(debugEvents, (_event, _payload, type) => type === "playground.ready")),
        remoteLayoutSource: eventType(latestRemoteLayoutEvent(debugEvents)),
        requestEvidence,
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
    page.waitForURL(/\/stream-playground/, { timeout: DEFAULT_TIMEOUT_MS }),
    page.getByRole("button", { name: /sign in/i }).click(),
  ]);
}

async function clickInsideStream(page, remotePoint, remoteViewport, { mobile = false } = {}) {
  const rect = await streamContentRect(page, remoteViewport);
  const x = Math.round(rect.x + (rect.width * remotePoint.x) / remoteViewport.width);
  const y = Math.round(rect.y + (rect.height * remotePoint.y) / remoteViewport.height);
  if (mobile) {
    await page.touchscreen.tap(x, y);
    return;
  }
  await page.mouse.click(x, y);
}

async function tapLocalButton(page, locator, { mobile = false } = {}) {
  if (!mobile) {
    await locator.click();
    return;
  }
  const box = await locator.boundingBox();
  if (!box) {
    fail("local mobile affordance is not measurable");
  }
  await page.touchscreen.tap(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
}

async function clickRemoteControl(page, debugEvents, controlId, { mobile = false } = {}) {
  const target = resolveRemoteControlTarget(debugEvents, controlId);
  if (!target) {
    fail(`remote playground did not publish a measurable ${controlId} target`);
  }
  await clickInsideStream(page, target.remotePoint, target.remoteViewport, { mobile });
  return target;
}

async function clickStrictVisualCounterTarget(page, debugEvents, { mobile = false } = {}) {
  const remoteViewport = latestNekoStatusViewport(debugEvents);
  if (remoteViewport) {
    await clickInsideStream(
      page,
      {
        // Strict mode cannot read remote DOM telemetry. This point targets the
        // visible playground counter button from the known debug page layout.
        x: remoteViewport.width * 0.29,
        y: remoteViewport.height * 0.15,
      },
      remoteViewport,
      { mobile }
    );
    return { remoteViewport, strictSafe: true };
  }

  const frame = page.locator(STREAM_FRAME_SELECTOR).first();
  const box = await frame.boundingBox();
  if (!box) {
    fail("stream frame is not measurable");
  }
  if (mobile) {
    await page.touchscreen.tap(Math.round(box.x + box.width * 0.29), Math.round(box.y + box.height * 0.15));
  } else {
    await page.mouse.click(Math.round(box.x + box.width * 0.29), Math.round(box.y + box.height * 0.15));
  }
  return { remoteViewport: null, strictSafe: true };
}

async function proveStrictVisualTyping(page, debugEvents, { mobile = false } = {}) {
  const remoteViewport = latestNekoStatusViewport(debugEvents);
  if (!remoteViewport) {
    fail("strict-mode smoke cannot prove typing visually without a remote viewport");
  }
  const target = strictVisualInputTarget(remoteViewport);
  await clickInsideStream(page, target.clickPoint, remoteViewport, { mobile });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const before = await captureStreamRemoteRect(page, target.cropRect, remoteViewport);
  await page.keyboard.type(STRICT_SMOKE_TOKEN, { delay: 35 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  const after = await captureStreamRemoteRect(page, target.cropRect, remoteViewport);
  const diff = await comparePngVisualChange(page, before.png, after.png);
  if (diff.changedPixels < 12 || diff.changedRatio < 0.001 || diff.meanRgbDelta < 0.15) {
    fail(
      `strict-mode smoke did not observe visual text-input change after typing (${JSON.stringify({
        diff,
        beforeClip: before.clip,
        afterClip: after.clip,
        remoteViewport,
      })})`
    );
  }
  return {
    diff,
    localClip: after.clip,
    remoteViewport,
    strictSafe: true,
    tokenLength: STRICT_SMOKE_TOKEN.length,
  };
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
  const requestEvidence = { consoleErrors: [], eventStreamErrors: [], failedRequests: [], httpFailures: [], nekoHttpFailures: [] };
  let debugEventSequence = 0;
  const mobile = mobileSmokeEnabled();
  const executablePath = browserExecutablePath();
  const browser = await chromium.launch({
    headless: env("PDPP_STREAM_SMOKE_HEADFUL") !== "1",
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 430, height: 820 },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
  });

  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    function TracedEventSource(url, configuration) {
      const source = new NativeEventSource(url, configuration);
      if (String(url).includes("/_ref/run-interaction-streams/")) {
        source.addEventListener("error", (event) => {
          const data = typeof event.data === "string" ? event.data : "";
          console.error(`[manual-action-stream-smoke EventSource error] ${data}`);
        });
      }
      return source;
    }
    TracedEventSource.prototype = NativeEventSource.prototype;
    window.EventSource = TracedEventSource;
  });

  page.on("request", (request) => {
    try {
      const url = new URL(request.url());
      if (url.pathname === "/api/stream-debug") {
        for (const event of parseDebugEventsFromPostData(request.postData())) {
          debugEvents.push({ ...(event || {}), __smokeSequence: ++debugEventSequence });
        }
        if (debugEvents.length > DEBUG_EVENT_BUFFER_MAX) {
          debugEvents.splice(0, debugEvents.length - DEBUG_EVENT_BUFFER_MAX);
        }
      }
    } catch {
      // Ignore malformed request URLs from browser internals.
    }
  });

  page.on("response", (response) => {
    const request = response.request();
    try {
      const url = new URL(request.url());
      const status = response.status();
      if (status >= 400) {
        const failure = { method: request.method(), resourceType: request.resourceType(), status, url: redactRequestUrl(url) };
        appendEvidence(requestEvidence.httpFailures, failure);
        if (url.pathname === "/neko" || url.pathname.startsWith("/neko/")) {
          appendEvidence(requestEvidence.nekoHttpFailures, failure);
        }
      }
      if (url.pathname.includes("/_ref/run-interaction-streams/") && url.pathname.endsWith("/events")) {
        response
          .text()
          .then((body) => {
            const errorMatch = body.match(/^event: error\ndata: (.+)$/m);
            if (!errorMatch) return;
            try {
              appendEvidence(requestEvidence.eventStreamErrors, JSON.parse(errorMatch[1]));
            } catch {
              appendEvidence(requestEvidence.eventStreamErrors, { raw: errorMatch[1] });
            }
          })
          .catch(() => undefined);
      }
    } catch {
      // Ignore malformed URLs from browser internals.
    }
  });

  page.on("requestfailed", (request) => {
    appendEvidence(requestEvidence.failedRequests, {
      failure: request.failure()?.errorText || "unknown request failure",
      method: request.method(),
      resourceType: request.resourceType(),
      url: redactRequestUrl(request.url()),
    });
  });

  page.on("console", (message) => {
    if (message.type() === "error") {
      appendEvidence(requestEvidence.consoleErrors, { text: message.text(), type: message.type() });
    }
  });

  try {
    const url = smokeUrl(origin);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await ensureOwnerSession(page);

    await page.goto(new URL("/", origin).toString(), { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await ensureOwnerSession(page);
    await assertDocumentHorizontallyFits(page, "console home");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await ensureOwnerSession(page);

    await page.getByRole("button", { name: /open browser/i }).click();
    const streamFrame = page.locator(STREAM_FRAME_SELECTOR).first();
    await streamFrame.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });

    if (mobile) {
      await assertMobileViewportFits(page, "portrait");
    }

    await waitFor(
      async () =>
        !(await streamFrame.evaluate((node) => Boolean(node.getAttribute("data-pdpp-stream-loading"))).catch(() => true)) ||
        hasEvent(debugEvents, (_event, _payload, type) => type === "neko.media.displayable"),
      "stream never became displayable"
    );

    // This is deliberately a pixel-content assertion, not a DOM-presence
    // check. It detects the observed all-black stream plus error/absent-frame
    // signature, without rejecting a legitimately dark remote page.
    await assertKnownBlackFrameFailureAbsent(page);

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
      () => resolveRemoteControlTarget(debugEvents, "counter") || latestNekoPageCdpAvailability(debugEvents) === false,
      "stream did not publish either remote playground telemetry or strict-mode page-CDP status"
    );

    if (latestNekoPageCdpAvailability(debugEvents) === false && !resolveRemoteControlTarget(debugEvents, "counter")) {
      await clickStrictVisualCounterTarget(page, debugEvents, { mobile });
      if (mobile && (await proxyKeyboardFocused(page))) {
        fail("strict-mode mobile counter touch focused the keyboard proxy");
      }
      await waitFor(
        () => hasHealthyNekoPointerMapping(debugEvents),
        "strict-mode smoke did not observe healthy n.eko pointer mapping"
      );
      await waitFor(
        () => hasEvent(debugEvents, (_event, _payload, type) => type === "adapter_mounted" || type === "neko.client.start"),
        "strict-mode smoke did not observe n.eko adapter/client startup"
      );
      if (mobile) {
        skip(
          "strict-mode path used Chromium touch emulation but has no remote playground focus geometry; proxy-focus and OS-keyboard acceptance are not verifiable"
        );
        return;
      }
      const visualTyping = await proveStrictVisualTyping(page, debugEvents, { mobile });
      process.stdout.write(
        `${JSON.stringify({ mode: "strict", pageCdpAvailable: false, mobileTouchPath: mobile, visualTyping })}\n`
      );
    } else {
      const counterActionSequence = debugEventSequence;
      await clickRemoteControl(page, debugEvents, "counter", { mobile });
      await waitFor(
        () =>
          hasEventAfter(
            debugEvents,
            counterActionSequence,
            (_event, payload, type) => type === "playground.counter_click" && Number(payload.count) >= 1
          ),
        "remote counter did not report an increment"
      );
      if (mobile) {
        if (await proxyKeyboardFocused(page)) {
          fail("unrelated mobile counter touch focused the keyboard proxy");
        }
        if (
          hasEventAfter(
            debugEvents,
            counterActionSequence,
            (_event, payload, type) =>
              (type === "neko.keyboard_focus.trusted_touch" || type === "neko.keyboard_focus.affordance_tap") &&
              payload.controllerTextareaFocused === true
          )
        ) {
          fail("unrelated mobile counter touch emitted keyboard-focus success telemetry");
        }
      }

      const token = `pdpp-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const inputActionSequence = debugEventSequence;
      await clickRemoteControl(page, debugEvents, "text-input", { mobile });
      if (mobile) {
        await waitFor(
          () =>
            hasEventAfter(
              debugEvents,
              inputActionSequence,
              (_event, payload, type) =>
                type === "neko.keyboard_focus.trusted_touch" &&
                payload.controllerTextareaFocused === true &&
                payload.userActivationActive === true
            ) ||
            hasEventAfter(
              debugEvents,
              inputActionSequence,
              (_event, _payload, type) => type === "neko.keyboard_focus.affordance"
            ),
          "mobile text-input touch produced neither trusted proxy focus nor a confirmed-focus affordance"
        );
        if (
          hasEventAfter(
            debugEvents,
            inputActionSequence,
            (_event, _payload, type) => type === "neko.keyboard_focus.affordance"
          )
        ) {
          const affordanceActionSequence = debugEventSequence;
          await tapLocalButton(page, page.getByRole("button", { name: /tap to type/i }), { mobile });
          await waitFor(
            () =>
              hasEventAfter(
                debugEvents,
                affordanceActionSequence,
                (_event, payload, type) =>
                  type === "neko.keyboard_focus.affordance_tap" &&
                  payload.controllerTextareaFocused === true &&
                  payload.userActivationActive === true
              ),
            "mobile confirmed-focus affordance did not synchronously focus the keyboard proxy"
          );
        }
        if (!(await proxyKeyboardFocused(page))) {
          fail("mobile text-input path did not leave the keyboard proxy focused");
        }
      }
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
          hasEvent(
            debugEvents,
            (_event, _payload, type) => type.startsWith("surface.neko.") || type.startsWith("neko.touch")
          ) &&
          hasEvent(debugEvents, (_event, payload, type) => type === "playground.click" || type === "playground.input") &&
          hasEvent(debugEvents, (_event, payload, type) => type === "stream.input.post.result" || type === "neko.client.start"),
        "telemetry did not capture both local input path and remote playground events"
      );
    }

    if (mobile) {
      await page.setViewportSize({ width: 844, height: 390 });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await assertMobileViewportFits(page, "landscape");
    }

    process.stdout.write(
      `PASS manual-action stream smoke ${JSON.stringify({
        mobile,
        mobileBoundary: mobile ? "Chromium touch emulation and proxy focus/typing; OS keyboard visibility not proven" : null,
        url,
      })}\n`
    );
  } catch (error) {
    await captureFailureEvidence(
      page,
      debugEvents,
      requestEvidence,
      error instanceof Error ? error.message : String(error)
    ).catch((captureError) => {
      process.stderr.write(`failed to capture smoke evidence: ${captureError.message}\n`);
    });
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
