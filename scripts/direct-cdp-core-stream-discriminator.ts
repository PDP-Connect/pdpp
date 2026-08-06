#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Built-Core discriminator for the non-n.eko direct-CDP browser-surface path.
 *
 * The fixture is deliberately driven through the owner HTTP surface and the
 * emitted token-only stream paths. It does not read or print a CDP endpoint,
 * target id, registration credential, or stream token. The browser-backed
 * fixture itself is launched by Core's Patchright playground; this process is
 * the Patchright viewer/oracle that proves the selected page can be rendered
 * and controlled from the configured non-loopback origin.
 */

import { createRequire } from "node:module";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { establishOwnerSessionCookie } from "./lib/owner-session.ts";

interface JsonRecord {
  [key: string]: unknown;
}

interface HttpResult {
  body: unknown;
  raw: string;
  status: number;
}

interface PatchrightPage {
  evaluate: <T>(fn: (arg: unknown) => T | Promise<T>, arg?: unknown) => Promise<T>;
  goto: (url: string, options: { timeout: number; waitUntil: string }) => Promise<unknown>;
}

interface PatchrightBrowser {
  close: () => Promise<void>;
  newPage: () => Promise<PatchrightPage>;
}

interface PatchrightModule {
  chromium: {
    launch: (options: { args: string[]; executablePath?: string; headless: boolean }) => Promise<PatchrightBrowser>;
  };
}

interface PlaygroundSession {
  backend: string;
  interaction_id: string;
  run_id: string;
}

interface MintedStream {
  browser_session_id: string;
  input_path: string;
  interaction_id: string;
  run_id: string;
  token: string;
  viewer_path: string;
  viewport_path: string;
}

interface FrameStats {
  height: number;
  mean_luma: number;
  nonblack_ratio: number;
  width: number;
}

interface OracleState {
  errors: string[];
  first?: FrameStats & { hash: number };
  frames: number;
  last?: FrameStats & { hash: number };
}

const require = createRequire(import.meta.url);
const REQUEST_TIMEOUT_MS = 20_000;
const WAIT_TIMEOUT_MS = 30_000;
const VIEWPORT = { height: 600, width: 800 };
const AUTHORITY_KEY_PATTERN = /token|cookie|password|secret|cdp|websocket|ws_url|wsurl/i;
const RAW_CDP_AUTHORITY_PATTERN = /(?:wss?:\/\/|devtools\/page|webSocketDebuggerUrl|cdp_http_url|cdpHttpUrl)/i;
const TRAILING_SLASH_PATTERN = /\/$/;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function fail(message: string): never {
  throw new Error(`direct-cdp-core-stream-discriminator: ${message}`);
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function responseCode(value: unknown): string | null {
  const body = record(value);
  const direct = body.code;
  if (typeof direct === "string") {
    return direct;
  }
  const nested = record(body.error).code;
  return typeof nested === "string" ? nested : null;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

function redactAuthority(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAuthority);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: JsonRecord = {};
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    output[key] = AUTHORITY_KEY_PATTERN.test(key) ? "[redacted]" : redactAuthority(child);
  }
  return output;
}

function containsRawCdpAuthority(value: unknown): boolean {
  return RAW_CDP_AUTHORITY_PATTERN.test(JSON.stringify(value));
}

async function request(origin: string, cookie: string, path: string, init: RequestInit = {}): Promise<HttpResult> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(new URL(path, origin), {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    // Keep the text for a useful status failure.
  }
  return { body, raw, status: response.status };
}

async function importPatchright(repoRoot: string): Promise<PatchrightModule> {
  let resolved: string;
  try {
    resolved = require.resolve("patchright", {
      paths: [`${repoRoot}/reference-implementation`, `${repoRoot}/packages/polyfill-connectors`],
    });
  } catch (error) {
    fail(`Patchright is not installed (${error instanceof Error ? error.message : String(error)})`);
  }
  const imported = (await import(pathToFileURL(resolved).href)) as Partial<PatchrightModule> & {
    default?: PatchrightModule;
  };
  return imported.chromium ? (imported as PatchrightModule) : (imported.default as PatchrightModule);
}

function sessionFrom(result: HttpResult): PlaygroundSession {
  assert(result.status === 200, `playground session returned HTTP ${result.status}: ${result.raw.slice(0, 240)}`);
  const body = record(result.body);
  assert(
    typeof body.run_id === "string" && typeof body.interaction_id === "string",
    "playground session omitted run_id or interaction_id"
  );
  return {
    backend: String(body.backend ?? ""),
    interaction_id: body.interaction_id,
    run_id: body.run_id,
  };
}

async function createSession(
  origin: string,
  cookie: string,
  options: { assistance: boolean; fresh: boolean; registerTarget: boolean }
): Promise<PlaygroundSession> {
  const query = new URLSearchParams({
    assistance: options.assistance ? "1" : "0",
    backend: "cdp",
    fresh: options.fresh ? "1" : "0",
    register: options.registerTarget ? "1" : "0",
  });
  return sessionFrom(await request(origin, cookie, `/_ref/dev/playground/session?${query}`, { method: "POST" }));
}

function timelineEvents(body: unknown): JsonRecord[] {
  const payload = record(body);
  let candidates: unknown[] = [];
  if (Array.isArray(payload.events)) {
    candidates = payload.events;
  } else if (Array.isArray(payload.data)) {
    candidates = payload.data;
  }
  return candidates.filter((event): event is JsonRecord =>
    Boolean(event && typeof event === "object" && !Array.isArray(event))
  );
}

async function assertAssistanceEvent(origin: string, cookie: string, session: PlaygroundSession): Promise<void> {
  const result = await request(origin, cookie, `/_ref/runs/${encodeURIComponent(session.run_id)}/timeline`);
  assert(result.status === 200, `timeline returned HTTP ${result.status}: ${result.raw.slice(0, 240)}`);
  const event = timelineEvents(result.body).find(
    (candidate) =>
      candidate.event_type === "run.assistance_requested" &&
      record(candidate.data).assistance_request_id === session.interaction_id
  );
  assert(event, "fixture did not emit run.assistance_requested before stream mint");
  const { attachments } = record(event.data);
  assert(
    Array.isArray(attachments) &&
      attachments.some(
        (attachment) =>
          record(attachment).kind === "browser_surface" && record(attachment).role === "streaming_companion"
      ),
    "assistance event did not carry browser_surface/streaming_companion"
  );
}

function mintStream(origin: string, cookie: string, session: PlaygroundSession): Promise<HttpResult> {
  return request(origin, cookie, `/_ref/runs/${encodeURIComponent(session.run_id)}/run-interaction-stream`, {
    body: JSON.stringify({ interaction_id: session.interaction_id, viewport: VIEWPORT }),
    method: "POST",
  });
}

function mintedStream(result: HttpResult, session: PlaygroundSession): MintedStream {
  assert(result.status === 201, `stream mint returned HTTP ${result.status}: ${result.raw.slice(0, 300)}`);
  assert(!containsRawCdpAuthority(result.body), "stream mint exposed a raw CDP URL or target authority");
  const body = record(result.body);
  for (const key of [
    "browser_session_id",
    "input_path",
    "interaction_id",
    "run_id",
    "token",
    "viewer_path",
    "viewport_path",
  ]) {
    assert(typeof body[key] === "string", `stream mint omitted ${key}`);
  }
  assert(body.run_id === session.run_id && body.interaction_id === session.interaction_id, "mint identity drifted");
  return body as unknown as MintedStream;
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, message: string): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let last: T | undefined;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling must observe each sequential browser state.
    last = await read();
    if (predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`${message}; last=${JSON.stringify(last)}`);
}

async function armStreamOracle(page: PatchrightPage, viewerPath: string): Promise<void> {
  await page.evaluate((path) => {
    const oracle = {
      errors: [] as string[],
      frames: 0,
    } as OracleState & { source?: EventSource };
    const source = new EventSource(String(path));
    oracle.source = source;
    source.addEventListener("error", () => {
      oracle.errors.push("sse_error");
    });
    source.addEventListener("frame", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { data_base64?: string };
      const base64 = payload.data_base64;
      if (!base64) {
        return;
      }
      const image = new Image();
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the browser-side pixel oracle is intentionally one deterministic operation.
      image.onload = () => {
        const canvas = document.createElement("canvas");
        const width = Math.max(1, Math.min(image.naturalWidth, 800));
        const height = Math.max(1, Math.min(image.naturalHeight, 600));
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          oracle.errors.push("canvas_unavailable");
          return;
        }
        context.drawImage(image, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        let nonblack = 0;
        let luma = 0;
        let hash = 2_166_136_261;
        for (let index = 0; index < pixels.length; index += 4) {
          const red = pixels[index] ?? 0;
          const green = pixels[index + 1] ?? 0;
          const blue = pixels[index + 2] ?? 0;
          const brightness = red + green + blue;
          if (brightness > 24) {
            nonblack += 1;
          }
          luma += brightness / 3;
          if (index % 16 === 0) {
            hash = (hash * 16_777_619 + red) % 4_294_967_296;
            hash = (hash * 16_777_619 + green) % 4_294_967_296;
            hash = (hash * 16_777_619 + blue) % 4_294_967_296;
          }
        }
        const stats = {
          hash: Math.floor(hash),
          height,
          mean_luma: luma / (width * height),
          nonblack_ratio: nonblack / (width * height),
          width,
        };
        oracle.frames += 1;
        oracle.first ??= stats;
        oracle.last = stats;
      };
      image.onerror = () => oracle.errors.push("frame_decode_error");
      image.src = `data:image/jpeg;base64,${base64}`;
    });
    (window as Window & { __pdppDirectCdpOracle?: typeof oracle }).__pdppDirectCdpOracle = oracle;
  }, viewerPath);
}

function oracleState(page: PatchrightPage): Promise<OracleState> {
  return page.evaluate(() => {
    const value = (window as Window & { __pdppDirectCdpOracle?: OracleState }).__pdppDirectCdpOracle;
    return value
      ? { errors: [...value.errors], first: value.first, frames: value.frames, last: value.last }
      : { errors: [], frames: 0 };
  });
}

async function input(page: PatchrightPage, stream: MintedStream, event: JsonRecord): Promise<void> {
  const result = await page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { body: await response.text(), status: response.status };
    },
    { body: event, path: stream.input_path }
  );
  assert(
    result.status === 202,
    `input ${String(event.type)} returned HTTP ${result.status}: ${result.body.slice(0, 200)}`
  );
}

async function readTelemetry(page: PatchrightPage, stream: MintedStream): Promise<JsonRecord[]> {
  const telemetryPath = `${stream.input_path.slice(0, stream.input_path.lastIndexOf("/input"))}/input-telemetry`;
  const result = await page.evaluate(async (path) => {
    const response = await fetch(String(path));
    return { body: await response.text(), status: response.status };
  }, telemetryPath);
  if (result.status !== 200) {
    return [];
  }
  try {
    const payload = JSON.parse(result.body) as { records?: unknown };
    return Array.isArray(payload.records)
      ? payload.records.filter((value): value is JsonRecord =>
          Boolean(value && typeof value === "object" && !Array.isArray(value))
        )
      : [];
  } catch {
    return [];
  }
}

async function cancel(origin: string, cookie: string, session: PlaygroundSession): Promise<void> {
  const result = await request(origin, cookie, `/_ref/runs/${encodeURIComponent(session.run_id)}/interaction`, {
    body: JSON.stringify({ interaction_id: session.interaction_id, status: "cancelled" }),
    method: "POST",
  });
  assert(result.status === 202, `interaction cancellation returned HTTP ${result.status}: ${result.raw.slice(0, 240)}`);
}

async function main(): Promise<void> {
  const origin = env("PDPP_CORE_ORIGIN") ?? env("PDPP_REFERENCE_ORIGIN");
  const ownerPassword = env("PDPP_OWNER_PASSWORD");
  assert(origin, "PDPP_CORE_ORIGIN is required");
  assert(ownerPassword, "PDPP_OWNER_PASSWORD is required");
  const parsedOrigin = new URL(origin);
  assert(!["127.0.0.1", "localhost", "::1"].includes(parsedOrigin.hostname), "origin must be LAN/non-loopback");
  const normalizedOrigin = parsedOrigin.origin;
  const repoRoot = new URL("..", import.meta.url).pathname.replace(TRAILING_SLASH_PATTERN, "");
  const cookie = await establishOwnerSessionCookie({ origin: normalizedOrigin, ownerPassword });
  assert(cookie, "owner login returned no session cookie");
  const { chromium } = await importPatchright(repoRoot);
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(env("PDPP_ORACLE_BROWSER_EXECUTABLE_PATH")
      ? { executablePath: env("PDPP_ORACLE_BROWSER_EXECUTABLE_PATH") }
      : { executablePath: "/usr/bin/google-chrome" }),
    headless: true,
  });
  const page = await browser.newPage();

  let fixture: Record<string, unknown>;
  let mutation: Record<string, unknown>;
  let crossRun: Record<string, unknown>;
  try {
    const session = await createSession(normalizedOrigin, cookie, {
      assistance: true,
      fresh: true,
      registerTarget: true,
    });
    assert(session.backend === "cdp", `Core fixture backend was ${session.backend}, expected cdp`);
    await assertAssistanceEvent(normalizedOrigin, cookie, session);
    const stream = mintedStream(await mintStream(normalizedOrigin, cookie, session), session);
    await page.goto(new URL("/owner/login", normalizedOrigin).toString(), {
      timeout: REQUEST_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    await armStreamOracle(page, new URL(stream.viewer_path, normalizedOrigin).toString());
    const first = await waitFor(
      () => oracleState(page),
      (state) => Boolean(state.first && state.first.nonblack_ratio > 0.02),
      "selected Patchright page did not produce a nonblack frame"
    );
    assert(first.first, "frame oracle did not retain first frame");
    const initialHash = first.first.hash;
    await input(page, stream, { action: "click", button: 0, type: "mouse", x: 400, y: 148 });
    await input(page, stream, { action: "click", button: 0, type: "mouse", x: 400, y: 210 });
    await input(page, stream, { action: "keydown", code: "KeyX", key: "x", type: "keyboard" });
    await input(page, stream, { action: "keyup", code: "KeyX", key: "x", type: "keyboard" });
    // A viewport refresh asks the CDP companion for a fresh screencast after
    // the bounded input sequence. This avoids relying on Chromium deciding
    // that a text-only repaint deserves another unsolicited screencast
    // frame, while the changed raster still proves the selected Page state
    // changed before the refresh.
    await input(page, stream, {
      deviceScaleFactor: 1,
      height: VIEWPORT.height,
      type: "viewport",
      width: VIEWPORT.width,
    });
    const remoteInput = await readTelemetry(page, stream);
    const afterInput = await waitFor(
      () => oracleState(page),
      (state) => Boolean(state.last && state.frames >= 2 && state.last.hash !== initialHash),
      "selected Patchright page did not change after bounded pointer/keyboard input"
    );
    assert(afterInput.last, "frame oracle did not retain post-input frame");
    await cancel(normalizedOrigin, cookie, session);
    const stale = await request(normalizedOrigin, cookie, stream.input_path, {
      body: JSON.stringify({ action: "click", button: 0, type: "mouse", x: 400, y: 148 }),
      method: "POST",
    });
    assert(stale.status >= 401 && stale.status < 500, `stale stream input unexpectedly returned HTTP ${stale.status}`);
    fixture = {
      cleanup: { stale_input_status: stale.status, interaction_cancelled: true },
      frame: {
        first: redactAuthority(first.first),
        frames: afterInput.frames,
        post_input: redactAuthority(afterInput.last),
      },
      input_dispatches: 5,
      interaction_id: session.interaction_id,
      remote_input_kinds: [...new Set(remoteInput.map((entry) => String(entry.kind ?? "")))],
      run_id: session.run_id,
    };

    const second = await createSession(normalizedOrigin, cookie, {
      assistance: true,
      fresh: true,
      registerTarget: true,
    });
    const cross = await request(
      normalizedOrigin,
      cookie,
      `/_ref/runs/${encodeURIComponent(second.run_id)}/run-interaction-stream`,
      {
        body: JSON.stringify({ interaction_id: session.interaction_id, viewport: VIEWPORT }),
        method: "POST",
      }
    );
    assert(cross.status === 409, `cross-run stale interaction returned HTTP ${cross.status}, expected 409`);
    crossRun = { code: responseCode(cross.body), status: cross.status, rejected: true };
    await cancel(normalizedOrigin, cookie, second);

    const negative = await createSession(normalizedOrigin, cookie, {
      assistance: true,
      fresh: true,
      registerTarget: false,
    });
    const negativeMint = await mintStream(normalizedOrigin, cookie, negative);
    assert(
      negativeMint.status === 503,
      `registration-disabled fixture returned HTTP ${negativeMint.status}, expected 503`
    );
    assert(
      responseCode(negativeMint.body) === "streaming_companion_unavailable",
      `registration-disabled fixture returned the wrong error code: ${JSON.stringify(negativeMint.body)}`
    );
    mutation = {
      code: responseCode(negativeMint.body),
      status: negativeMint.status,
      target_registration_disabled: true,
    };
    await cancel(normalizedOrigin, cookie, negative);
  } finally {
    await page
      .evaluate(() => {
        const value = (window as Window & { __pdppDirectCdpOracle?: { source?: EventSource } }).__pdppDirectCdpOracle;
        value?.source?.close();
      })
      .catch(() => undefined);
    await browser.close();
  }

  process.stdout.write(
    `${JSON.stringify({ origin: normalizedOrigin, fixture, mutation, cross_run: crossRun }, null, 2)}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
