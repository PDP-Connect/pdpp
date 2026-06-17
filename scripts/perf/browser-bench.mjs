#!/usr/bin/env node
/**
 * Browser-perceived performance benchmark for the PDPP console + RS API.
 *
 * Dependency-free on purpose: launches the system Chrome with a temporary user
 * profile and talks to Chrome DevTools Protocol over Node's built-in WebSocket.
 * This captures the layer `scripts/perf/bench.mjs` cannot see: cold browser
 * navigation, DOM/load timings, paint/vitals observers, console failures, failed
 * requests, and repeated/sequential RSC fetches.
 *
 * Usage:
 *   PDPP_OWNER_PASSWORD=... PDPP_OWNER_TOKEN=... node scripts/perf/browser-bench.mjs
 *   node scripts/perf/browser-bench.mjs --routes /dashboard/runs --viewports desktop --warm --no-api
 *   node scripts/perf/browser-bench.mjs --headed --routes /dashboard/records/add
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(REPO_ROOT, "perf-results");

const BASE = (process.env.PDPP_BASE || "https://pdpp.vivid.fish").replace(/\/$/, "");
const OWNER_TOKEN = process.env.PDPP_OWNER_TOKEN || "";
const OWNER_PASSWORD = process.env.PDPP_OWNER_PASSWORD || "";
const COOKIE_ENV = process.env.PDPP_BENCH_COOKIE || "";
const SOURCE_ROUTE_ID = process.env.PDPP_PERF_SOURCE_ROUTE_ID || "";
const CONNECTION_ID = process.env.PDPP_BENCH_CONNECTION_ID || "cin_f565a96cb0a114b0a27e9606";
const CHROME_BIN =
  process.env.CHROME_BIN || findChrome() || fail("No Chrome binary found. Set CHROME_BIN=/path/to/chrome.");
const TIMEOUT_MS = Number(process.env.PDPP_BROWSER_BENCH_TIMEOUT_MS || 45000);
const SETTLE_MS = Number(process.env.PDPP_BROWSER_BENCH_SETTLE_MS || 1200);

const args = process.argv.slice(2);
const argSet = new Set(args);
const HEADED = argSet.has("--headed");
const WARM = argSet.has("--warm");
const API_ENABLED = !argSet.has("--no-api");
const KEEP_PROFILE = argSet.has("--keep-profile");
const ROUTES = readListArg("--routes") ?? defaultRoutes();
const VIEWPORTS = readListArg("--viewports") ?? ["desktop"];

const VIEWPORT_PRESETS = {
  desktop: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};

function defaultRoutes() {
  return [
    "/dashboard",
    "/dashboard/records",
    "/dashboard/records/add",
    "/dashboard/explore",
    "/dashboard/runs",
    "/dashboard/search",
    ...(SOURCE_ROUTE_ID ? [`/dashboard/records/${SOURCE_ROUTE_ID}`] : []),
  ];
}

function readListArg(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  const raw = args[idx + 1];
  if (!raw) fail(`${name} requires a comma-separated value`);
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function findChrome() {
  for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function nowIso() {
  return new Date().toISOString();
}

function resultPath(prefix) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  return join(RESULTS_DIR, `${prefix}-${nowIso().replace(/[:.]/g, "-")}.json`);
}

async function fetchOwnerCookie() {
  if (COOKIE_ENV) return COOKIE_ENV;
  if (!OWNER_PASSWORD) return "";
  const resp = await fetch(`${BASE}/owner/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: OWNER_PASSWORD }),
    redirect: "manual",
  });
  const setCookie = resp.headers.getSetCookie?.() ?? [];
  const session = setCookie.find((cookie) => cookie.startsWith("pdpp_owner_session="));
  return session ? session.split(";")[0] : "";
}

async function findFreePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function launchChrome() {
  const port = await findFreePort();
  const profileRoot = join(homedir(), ".tmp");
  mkdirSync(profileRoot, { recursive: true });
  const userDataDir = mkdtempSync(join(profileRoot, "pdpp-browser-bench-"));
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--window-size=1280,900",
  ];
  if (!HEADED) {
    chromeArgs.push("--headless=new", "--disable-gpu");
  }
  const proc = spawn(CHROME_BIN, chromeArgs, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  for (let i = 0; i < 80; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (resp.ok) {
        return { port, proc, userDataDir, stderr: () => stderr };
      }
    } catch {
      // wait
    }
    await sleep(100);
  }
  proc.kill("SIGKILL");
  fail(`Chrome did not expose CDP on port ${port}. stderr:\n${stderr.slice(-2000)}`);
}

async function closeChrome(chrome) {
  const exited = new Promise((resolve) => chrome.proc.once("exit", resolve));
  chrome.proc.kill("SIGTERM");
  const closed = await Promise.race([exited.then(() => true), sleep(800).then(() => false)]);
  if (!closed) {
    chrome.proc.kill("SIGKILL");
    await Promise.race([exited, sleep(800)]);
  }
  if (!KEEP_PROFILE) rmSync(chrome.userDataDir, { recursive: true, force: true });
}

async function newTab(port) {
  const resp = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  });
  if (!resp.ok) throw new Error(`CDP new tab failed: HTTP ${resp.status}`);
  const target = await resp.json();
  return new CdpClient(target.webSocketDebuggerUrl);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event.data));
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) ?? [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, method, timeout });
    });
  }

  onMessage(data) {
    const msg = JSON.parse(data.toString());
    if (msg.id) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      if (msg.error) {
        pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    const handlers = this.handlers.get(msg.method) ?? [];
    for (const handler of handlers) handler(msg.params ?? {});
  }

  close() {
    this.ws.close();
  }
}

const VITALS_BOOTSTRAP = `
(() => {
  window.__pdppBrowserBench = {
    fcp: null,
    lcp: null,
    cls: 0,
    paints: [],
    errors: [],
  };
  addEventListener("error", (event) => window.__pdppBrowserBench.errors.push(String(event.message || "error")));
  addEventListener("unhandledrejection", (event) => window.__pdppBrowserBench.errors.push(String(event.reason || "unhandledrejection")));
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__pdppBrowserBench.paints.push({ name: entry.name, startTime: entry.startTime });
        if (entry.name === "first-contentful-paint") window.__pdppBrowserBench.fcp = entry.startTime;
      }
    }).observe({ type: "paint", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) window.__pdppBrowserBench.lcp = last.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__pdppBrowserBench.cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
})();
`;

async function preparePage(client, viewport, cookie) {
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Runtime.enable");
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: VITALS_BOOTSTRAP });
  await client.send("Emulation.setDeviceMetricsOverride", viewport);
  await client.send("Emulation.setUserAgentOverride", {
    userAgent: viewport.mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136 Safari/537.36",
  });
  if (cookie) {
    const [name, value] = cookie.split("=", 2);
    await client.send("Network.setCookie", {
      name,
      value,
      domain: new URL(BASE).hostname,
      path: "/",
      secure: BASE.startsWith("https://"),
      httpOnly: true,
    });
  }
}

async function measureRoute(chrome, route, viewportName, cookie, phase) {
  const viewport = VIEWPORT_PRESETS[viewportName];
  if (!viewport) fail(`Unknown viewport '${viewportName}'. Expected ${Object.keys(VIEWPORT_PRESETS).join(", ")}`);
  const client = await newTab(chrome.port);
  const requests = new Map();
  const failedRequests = [];
  const abortedRequests = [];
  const consoleMessages = [];
  const exceptions = [];
  let documentRequestId = null;
  let documentResponseAt = null;
  let documentStatus = null;
  let domContentAt = null;
  let loadAt = null;

  client.on("Network.requestWillBeSent", (event) => {
    requests.set(event.requestId, {
      requestId: event.requestId,
      url: event.request?.url ?? "",
      method: event.request?.method ?? "",
      type: event.type,
      start: event.timestamp,
      response: null,
      end: null,
      failed: false,
      errorText: null,
    });
    if (event.type === "Document" && event.documentURL === `${BASE}${route}`) {
      documentRequestId = event.requestId;
    }
  });
  client.on("Network.responseReceived", (event) => {
    const record = requests.get(event.requestId);
    if (record) record.response = { status: event.response?.status, mimeType: event.response?.mimeType };
    if (event.requestId === documentRequestId) {
      documentResponseAt = event.timestamp;
      documentStatus = event.response?.status ?? null;
    }
  });
  client.on("Network.loadingFinished", (event) => {
    const record = requests.get(event.requestId);
    if (record) {
      record.end = event.timestamp;
      record.encodedDataLength = event.encodedDataLength;
    }
  });
  client.on("Network.loadingFailed", (event) => {
    const record = requests.get(event.requestId);
    if (record) {
      record.end = event.timestamp;
      record.failed = true;
      record.errorText = event.errorText ?? null;
      const failure = { url: record.url, type: record.type, errorText: record.errorText };
      if (record.errorText === "net::ERR_ABORTED") {
        abortedRequests.push(failure);
      } else {
        failedRequests.push(failure);
      }
    }
  });
  client.on("Runtime.consoleAPICalled", (event) => {
    consoleMessages.push({
      type: event.type,
      text: (event.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 500),
    });
  });
  client.on("Runtime.exceptionThrown", (event) => {
    exceptions.push(event.exceptionDetails?.text ?? event.exceptionDetails?.exception?.description ?? "exception");
  });
  client.on("Page.domContentEventFired", (event) => {
    domContentAt = event.timestamp;
  });
  client.on("Page.loadEventFired", (event) => {
    loadAt = event.timestamp;
  });

  await preparePage(client, viewport, cookie);
  const wallStart = performance.now();
  const cdpStart = await client.send("Runtime.evaluate", { expression: "performance.timeOrigin", returnByValue: true });
  const timeOrigin = cdpStart.result?.value ?? Date.now();
  await client.send("Page.navigate", { url: `${BASE}${route}` });
  await waitFor(() => loadAt !== null, TIMEOUT_MS, `load event for ${route}`);
  await sleep(SETTLE_MS);

  const vitalsEval = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      return {
        vitals: window.__pdppBrowserBench || null,
        navigation: nav ? {
          responseStart: nav.responseStart,
          domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
          loadEventEnd: nav.loadEventEnd,
          duration: nav.duration,
          transferSize: nav.transferSize,
          encodedBodySize: nav.encodedBodySize,
          decodedBodySize: nav.decodedBodySize,
        } : null,
        location: location.href,
      };
    })()`,
    returnByValue: true,
  });
  const wallMs = performance.now() - wallStart;
  const data = vitalsEval.result?.value ?? {};
  const routeUrl = new URL(`${BASE}${route}`);
  const documentRequest = documentRequestId ? requests.get(documentRequestId) : null;
  const navStartSeconds =
    documentRequest?.start ?? Math.min(...[...requests.values()].map((record) => record.start).filter(Boolean));
  const rsc = [...requests.values()]
    .filter((record) => {
      try {
        const url = new URL(record.url);
        return url.pathname === routeUrl.pathname && url.search.includes("_rsc=");
      } catch {
        return false;
      }
    })
    .map((record) => ({
      url: redactUrl(record.url),
      startMs: round((record.start - navStartSeconds) * 1000),
      endMs: record.end ? round((record.end - navStartSeconds) * 1000) : null,
      durationMs: record.end ? round((record.end - record.start) * 1000) : null,
      status: record.response?.status ?? null,
      failed: record.failed,
    }))
    .sort((a, b) => a.startMs - b.startMs);
  const rscWindow = summarizeRscWindow(rsc);
  const slowRequests = [...requests.values()]
    .filter((record) => record.end !== null && !record.failed)
    .map((record) => ({
      url: redactUrl(record.url),
      type: record.type,
      status: record.response?.status ?? null,
      startMs: round((record.start - navStartSeconds) * 1000),
      durationMs: round((record.end - record.start) * 1000),
      encodedDataLength: record.encodedDataLength ?? null,
    }))
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 12);

  client.close();
  return {
    route,
    phase,
    viewport: viewportName,
    status: documentStatus,
    final_url: data.location ?? null,
    wall_ms: round(wallMs),
    ttfb_ms:
      documentRequest && documentResponseAt ? round((documentResponseAt - documentRequest.start) * 1000) : null,
    dom_content_loaded_ms: data.navigation?.domContentLoadedEventEnd ?? (domContentAt ? cdpSecondsToMs(domContentAt, timeOrigin) : null),
    load_ms: data.navigation?.loadEventEnd ?? (loadAt ? cdpSecondsToMs(loadAt, timeOrigin) : null),
    fcp_ms: data.vitals?.fcp ?? null,
    lcp_ms: data.vitals?.lcp ?? null,
    cls: data.vitals?.cls ?? null,
    inp_ms: null,
    inp_unavailable_reason: "Load-only harness; pass an interaction script in a future tranche to measure INP.",
    console_messages: consoleMessages,
    page_errors: [...exceptions, ...(data.vitals?.errors ?? [])],
    failed_requests: failedRequests.map((req) => ({ ...req, url: redactUrl(req.url) })),
    aborted_requests: abortedRequests.map((req) => ({ ...req, url: redactUrl(req.url) })),
    slow_requests: slowRequests,
    request_count: requests.size,
    rsc_fetches: rsc,
    rsc_summary: rscWindow,
  };
}

function cdpSecondsToMs(timestampSeconds, timeOrigin) {
  // CDP timestamps are monotonic seconds from an arbitrary process origin.
  // For relative navigation metrics only deltas matter; normalize against the
  // earliest request when summarizing RSC separately. Keep this as a best-effort
  // absolute since PerformanceNavigationTiming is preferred for DOM/load values.
  return round(timestampSeconds * 1000 - Math.floor(timeOrigin / 1000) * 1000);
}

function summarizeRscWindow(fetches) {
  if (fetches.length === 0) {
    return { count: 0, occupied_ms: 0, sequential_ms: 0, max_single_ms: 0, stacked: false };
  }
  const complete = fetches.filter((fetch) => fetch.endMs !== null);
  if (complete.length === 0) {
    return { count: fetches.length, occupied_ms: null, sequential_ms: null, max_single_ms: null, stacked: null };
  }
  const minStart = Math.min(...complete.map((fetch) => fetch.startMs));
  const maxEnd = Math.max(...complete.map((fetch) => fetch.endMs));
  let sequentialMs = 0;
  let previousEnd = null;
  let stacked = false;
  for (const fetch of complete) {
    sequentialMs += fetch.durationMs ?? 0;
    if (previousEnd !== null && fetch.startMs >= previousEnd - 10) stacked = true;
    previousEnd = Math.max(previousEnd ?? 0, fetch.endMs);
  }
  return {
    count: fetches.length,
    occupied_ms: round(maxEnd - minStart),
    sequential_ms: round(sequentialMs),
    max_single_ms: round(Math.max(...complete.map((fetch) => fetch.durationMs ?? 0))),
    stacked,
  };
}

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|cookie|password/i.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function apiProbes() {
  if (!API_ENABLED || !OWNER_TOKEN) return [];
  const headers = { Authorization: `Bearer ${OWNER_TOKEN}` };
  const targets = [
    { name: "schema", url: `${BASE}/v1/schema` },
    { name: "search.lexical", url: `${BASE}/v1/search?q=error&limit=25` },
    { name: "search.semantic", url: `${BASE}/v1/search/semantic?q=deployment+failure&limit=25` },
    { name: "search.hybrid", url: `${BASE}/v1/search/hybrid?q=deployment+failure&limit=25` },
    { name: "records.page", url: `${BASE}/v1/streams/messages/records?limit=25&connection_id=${CONNECTION_ID}` },
  ];
  const results = [];
  for (const target of targets) {
    const t0 = performance.now();
    let status = 0;
    let bytes = 0;
    try {
      const resp = await fetch(target.url, { headers });
      status = resp.status;
      bytes = (await resp.arrayBuffer()).byteLength;
    } catch {
      status = -1;
    }
    results.push({ ...target, url: redactUrl(target.url), status, total_ms: round(performance.now() - t0), bytes });
  }
  return results;
}

async function main() {
  const cookie = await fetchOwnerCookie();
  const browserResults = [];
  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      // Cold means a fresh browser profile per route, not just a new tab. This
      // prevents one route's RSC prefetch/cache from making the next route look
      // faster than a real first visit. Optional warm repeats reuse the same
      // browser profile so warm/cold deltas are visible in one result.
      const chrome = await launchChrome();
      try {
        browserResults.push(await measureRoute(chrome, route, viewport, cookie, "cold"));
        if (WARM) {
          browserResults.push(await measureRoute(chrome, route, viewport, cookie, "warm"));
        }
      } finally {
        await closeChrome(chrome);
      }
    }
  }
  const out = {
    schema: "pdpp-browser-perf-bench/1",
    base: BASE,
    ran_at: nowIso(),
    chrome: { binary: CHROME_BIN, headed: HEADED },
    auth: {
      owner_cookie_present: Boolean(cookie),
      rs_bearer_present: Boolean(OWNER_TOKEN),
    },
    routes: browserResults,
    api: await apiProbes(),
  };
  const outPath = resultPath("browser-bench");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  writeFileSync(join(RESULTS_DIR, "browser-bench-latest.json"), JSON.stringify(out, null, 2));
  printSummary(out, outPath);
  console.log(JSON.stringify(out));
}

function printSummary(out, outPath) {
  console.error(`# PDPP browser perf — base=${out.base} routes=${out.routes.length}`);
  for (const row of out.routes) {
    console.error(
      `  ${row.viewport.padEnd(7)} ${row.phase.padEnd(4)} ${row.route.padEnd(32)} ` +
        `status=${row.status ?? "?"} wall=${pad(row.wall_ms)}ms fcp=${pad(round(row.fcp_ms))}ms ` +
        `lcp=${pad(round(row.lcp_ms))}ms cls=${round(row.cls) ?? "?"} ` +
        `rsc=${row.rsc_summary.count}/${pad(row.rsc_summary.sequential_ms)}ms ` +
        `errors=${row.page_errors.length + row.console_messages.length} failed=${row.failed_requests.length}`
    );
  }
  for (const row of out.api) {
    console.error(`  api     ${row.name.padEnd(24)} status=${row.status} total=${pad(row.total_ms)}ms ${fmtBytes(row.bytes)}`);
  }
  console.error(`# wrote ${outPath}`);
}

function pad(value) {
  if (value == null) return "   ?";
  return String(value).padStart(5);
}

function round(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

function fmtBytes(n) {
  if (n > 1024 * 1024) return `${round(n / 1024 / 1024)}MB`;
  if (n > 1024) return `${round(n / 1024)}KB`;
  return `${n}B`;
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
