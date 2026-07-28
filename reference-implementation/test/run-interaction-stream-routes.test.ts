// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
/**
 * Integration tests for the run-interaction streaming companion routes.
 *
 * The harness boots the AS app with a deterministic mock companion factory
 * and a connector that emits a `manual_action` interaction. The tests prove:
 *   - mint requires a pending interaction of a streaming-eligible kind
 *   - mint succeeds and returns a token bound to the (run, interaction)
 *   - the SSE viewer channel only attaches with a valid token
 *   - input POSTs are dispatched to the companion after attach
 *   - resolving the interaction tears the streaming session down
 *   - the streaming session never authorizes record reads or unrelated runs
 */
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  type BrowserSurfaceHealth,
  BrowserSurfaceLeaseManager,
  type BrowserSurfaceMode,
  DEFAULT_NEKO_PRIORITY_RANKS,
  // biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
} from "@opendatalabs/remote-surface/leases";
import {
  __resetControllerInteractionStateForTests,
  type Controller,
  type RunNowResult,
} from "../runtime/controller.ts";
import {
  isManagedNekoSurfaceApproved as isManagedNekoSurfaceApprovedUntyped,
  startServer as startServerUntyped,
} from "../server/index.ts";
import { createMockCompanion, type MockCompanion } from "../server/streaming/cdp-companion.ts";
import { createNekoCompanion as createNekoCompanionUntyped } from "../server/streaming/neko-adapter.ts";
import { normalizeReferenceWireViewportPayload } from "../server/streaming/protocol-wire.ts";
import { createStreamingSessionStore } from "../server/streaming/sessions.ts";

const REGEXP_1 = /retry/i;
const REGEXP_2 = /retry/i;
const REGEXP_3 = /text\/event-stream/;
const REGEXP_4 = /text\/event-stream/;
const REGEXP_5 = /pdpp_neko_stream=/;
const REGEXP_6 = /Path=\/neko/;
const REGEXP_7 = /^\/neko\?pdpp_stream=/;
const REGEXP_8 = /pdpp_neko_stream=/;
const REGEXP_9 = /Path=\/neko/;
const REGEXP_10 = /<base href="\/neko\/">/;
const REGEXP_11 = /data-pdpp-neko-embed/;
const REGEXP_12 = /header-container/;
const REGEXP_13 = /video-menu/;
const REGEXP_14 = /pdpp-neko-focus/;
const REGEXP_15 = /<body>ok<\/body>/;
const REGEXP_16 = /<base href="\/neko\/">/;
const REGEXP_17 = /data-pdpp-neko-embed/;
const REGEXP_18 = /<body>ok<\/body>/;
const REGEXP_19 = /not configured/;
const REGEXP_20 = /^Bearer\s+realm="pdpp-stream"$/;
const REGEXP_21 = /ws:\/\/|wss:\/\//i;
const REGEXP_22 = /https?:\/\/(?:127\.0\.0\.1|localhost|neko)(?::\d+)?/i;
const REGEXP_23 = /\/json\/version|\/devtools\/browser/i;
const REGEXP_24 = /base_url|cdp_http_url|cdpWsUrl|cdpHttpUrl|webSocketDebuggerUrl/i;
const REGEXP_25 = /docker\.sock|allocatorCredentials/i;

/**
 * `server/index.js` (startServer, isManagedNekoSurfaceApproved) and
 * `server/streaming/neko-adapter.js` (createNekoCompanion) are untyped JS
 * (allowJs, checkJs:false) under server/**, forbidden to touch. Same
 * boundary-cast pattern established in slices 4a/4b/5b/6a: model the real
 * call/return shapes locally from the source and cast the untyped imports
 * once, rather than fighting incomplete structural inference at dozens of
 * call sites.
 */
interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  controller: Controller;
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  schedulerManager?: { stop?: () => void };
}

interface NekoCompanion {
  ackFrame: (sessionId?: number) => Promise<void>;
  backend: string;
  browser_session_id: string;
  browserOwnerMode?: () => string;
  dispatch: (event: Record<string, unknown>) => Promise<void>;
  getNekoProxyTarget?: () => unknown;
  onEvent: (handler: (event: unknown) => void) => () => void;
  onFrame: (handler: (frame: unknown) => void) => () => void;
  queryNekoStatus?: () => Promise<unknown>;
  start: (viewport?: Record<string, unknown>) => Promise<void>;
  stealthMode?: () => string;
  stop: () => Promise<void>;
}

type NekoCompanionOptions = Record<string, unknown>;

interface StartServerOptions {
  asPort?: number;
  browserSurfaceLeaseManager?: unknown;
  browserSurfaceReadinessProbe?: unknown;
  connectorPathResolver?: () => string;
  dbPath?: string;
  isNekoProxyTargetApproved?: unknown;
  makeStreamingBrowserSessionId?: (() => string) | undefined;
  nekoProxyAutoLogin?: unknown;
  nekoWindowSettleProbe?: (endpoint: string) => Promise<unknown>;
  ownerAuthPassword?: string;
  presentationScreenStateStore?: unknown;
  quiet?: boolean;
  rsPort?: number;
  streamingClearTimeout?: ((timer: unknown) => void) | undefined;
  streamingCompanionFactory?:
    | ((args: { browser_session_id: string; run_id: string; interaction_id: string; target?: unknown }) => unknown)
    | null;
  streamingLogger?: unknown;
  streamingNow?: (() => number) | undefined;
  streamingSessionStore?: unknown;
  streamingSetTimeout?: ((callback: () => void, delay: number) => unknown) | undefined;
}

const startServer = startServerUntyped as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;
const isManagedNekoSurfaceApproved = isManagedNekoSurfaceApprovedUntyped as unknown as (
  target: Record<string, unknown>,
  context: { runId?: string; interactionId?: string; browserSurfaceLeaseManager?: unknown }
) => boolean;
const createNekoCompanion = createNekoCompanionUntyped as unknown as (opts: NekoCompanionOptions) => NekoCompanion;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

test("viewport wire normalizes before validating so fractional dimensions never become zero downstream", () => {
  assert.equal(normalizeReferenceWireViewportPayload({ height: 800, width: 0.5 }), null);
  assert.equal(normalizeReferenceWireViewportPayload({ height: 0.5, width: 800 }), null);
  assert.deepEqual(normalizeReferenceWireViewportPayload({ height: 844.9, width: 390.9 }), { height: 844, width: 390 });
});

interface MakeLeaseManagerOptions {
  connectorId?: string;
  initialActiveLease?: boolean;
  profileKey?: string;
  runId?: string;
  surfaceHealth?: BrowserSurfaceHealth;
  surfaceMode?: BrowserSurfaceMode;
  withSettleEndpoint?: boolean;
}

function makeLeaseManager({
  connectorId = "chatgpt",
  profileKey = "profile_dynamic_1",
  runId = "run_dynamic_1",
  surfaceHealth = "ready",
  surfaceMode = "dynamic",
  initialActiveLease = false,
  withSettleEndpoint = true,
}: MakeLeaseManagerOptions = {}) {
  return new BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 300_000,
      leaseWaitTimeoutMs: 60_000,
      managedConnectors: new Set([connectorId]),
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceCap: 1,
      surfaceMode,
      ...(surfaceMode === "static"
        ? {
            staticCdpHttpUrl: "http://neko:9222",
            staticProfileKey: profileKey,
            staticStreamBaseUrl: "http://10.88.0.4:6080/_ref/browser-surfaces/surface_dynamic_1",
          }
        : {}),
    },
    initialSurfaces: [
      {
        backend: "neko",
        cdp_url: "http://neko:9222",
        connector_id: connectorId,
        profile_key: profileKey,
        stream_base_url: "http://10.88.0.4:6080/_ref/browser-surfaces/surface_dynamic_1",
        surface_id: "surface_dynamic_1",
        ...(withSettleEndpoint ? { window_settle_endpoint: "http://neko:9222/pdpp/window-settle" } : {}),
        allocator_metadata: {
          resource_owner: "pdpp-reference",
        },
        health: surfaceHealth,
        ...(initialActiveLease ? { active_lease_id: "lease_dynamic_1" } : {}),
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
    makeLeaseId: () => "lease_dynamic_1",
    makeSurfaceId: () => "surface_dynamic_1",
    nextFencingToken: () => 1,
    now: () => new Date("2026-05-12T12:00:00.000Z"),
    ...(initialActiveLease
      ? {
          initialLeases: [
            {
              connector_id: connectorId,
              expires_at: "2026-05-12T13:00:00.000Z",
              fencing_token: 1,
              lease_id: "lease_dynamic_1",
              leased_at: "2026-05-12T11:00:01.000Z",
              priority_class: "background",
              profile_key: profileKey,
              requested_at: "2026-05-12T11:00:00.000Z",
              run_id: runId,
              status: "leased",
              surface_id: "surface_dynamic_1",
            },
          ],
        }
      : {}),
  });
}

interface TimelineEvent {
  data?: Record<string, unknown>;
  event_type: string;
  interaction_id?: string;
  [key: string]: unknown;
}

interface TimelineBody {
  data: TimelineEvent[];
}

interface FetchJsonResult {
  body: unknown;
  headers: Headers;
  status: number;
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise<void>((r) => server.asServer.close(() => r())),
    new Promise<void>((r) => server.rsServer.close(() => r())),
  ]);
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<FetchJsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, headers: resp.headers, status: resp.status };
}

function presentationAttachmentCookie(response: Response): string {
  const raw = response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie");
  assert.ok(raw, "SSE attach must establish a presentation attachment cookie");
  return raw.split(";", 1)[0] ?? "";
}

interface InjectedClock {
  advance: (ms: number) => void;
  now: () => number;
}

function createInjectedClock(start = 0): InjectedClock {
  let current = start;
  return {
    advance(ms: number) {
      current += ms;
    },
    now() {
      return current;
    },
  };
}

interface InjectedTimer {
  at: number;
  callback: () => void | Promise<void>;
  cancelled: boolean;
  unref: () => InjectedTimer;
}

function createInjectedTimers(clock: InjectedClock) {
  const timers = new Set<InjectedTimer>();
  return {
    clearTimeout(timer: unknown) {
      const injectedTimer = timer as InjectedTimer;
      injectedTimer.cancelled = true;
      timers.delete(injectedTimer);
    },
    async runDue(): Promise<void> {
      const due = [...timers].filter((timer) => timer.at <= clock.now());
      for (const timer of due) {
        timers.delete(timer);
        if (!timer.cancelled) {
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          await timer.callback();
        }
      }
    },
    setTimeout(callback: () => void | Promise<void>, delay: number): InjectedTimer {
      const timer: InjectedTimer = {
        at: clock.now() + delay,
        callback,
        cancelled: false,
        unref() {
          return this;
        },
      };
      timers.add(timer);
      return timer;
    },
  };
}

function assertNoRawBackendAuthority(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.equal(REGEXP_21.test(serialized), false);
  assert.equal(REGEXP_22.test(serialized), false);
  assert.equal(REGEXP_23.test(serialized), false);
  assert.equal(REGEXP_24.test(serialized), false);
  assert.equal(REGEXP_25.test(serialized), false);
}

async function registerConnector(asUrl: string, manifest: unknown): Promise<void> {
  const r = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(r.status, 201, "register connector");
}

interface PendingInteractionEvent extends TimelineEvent {
  interaction_id: string;
}

async function waitForPendingInteraction(
  asUrl: string,
  runId: string,
  timeoutMs = 5000
): Promise<PendingInteractionEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    const { body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    const timeline = body as Partial<TimelineBody> | null;
    if (timeline && Array.isArray(timeline.data)) {
      const required = timeline.data.find((event) => event.event_type === "run.interaction_required");
      const completed = timeline.data.find((event) => event.event_type === "run.interaction_completed");
      if (required && !completed) {
        assert.ok(required.interaction_id, "pending interaction carries an interaction_id");
        return required as PendingInteractionEvent;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for pending interaction on run ${runId}`);
}

async function waitForAssistanceRequest(asUrl: string, runId: string, timeoutMs = 5000): Promise<TimelineEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    const { body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    const timeline = body as Partial<TimelineBody> | null;
    if (timeline && Array.isArray(timeline.data)) {
      const requested = timeline.data.find((event) => event.event_type === "run.assistance_requested");
      if (requested) {
        return requested;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for assistance on run ${runId}`);
}

async function waitForRunTerminal(asUrl: string, runId: string, timeoutMs = 5000): Promise<TimelineBody> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    const { body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    const timeline = body as Partial<TimelineBody> | null;
    if (timeline && Array.isArray(timeline.data)) {
      const terminal = timeline.data.find(
        (event) =>
          event.event_type === "run.completed" ||
          event.event_type === "run.failed" ||
          event.event_type === "run.cancelled" ||
          event.event_type === "run.abandoned"
      );
      if (terminal) {
        return timeline as TimelineBody;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

async function waitForCondition(condition: () => boolean, message: string, attempts = 40): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function buildManualActionConnector(
  tmpDir: string,
  { kind = "manual_action", timeoutSeconds = 60 }: { kind?: string; timeoutSeconds?: number } = {}
): string {
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
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_stream_1',
      kind: '${kind}',
      message: 'Need browser control to continue.',
      timeout_seconds: ${timeoutSeconds},
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`,
    "utf8"
  );
  return path;
}

function buildNoResponseBrowserAssistanceConnector(tmpDir: string): string {
  const path = join(tmpDir, "connector-assistance.mjs");
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
    process.stdout.write(JSON.stringify({
      type: 'ASSISTANCE',
      assistance_request_id: 'asst_stream_1',
      progress_posture: 'blocked',
      owner_action: 'operate_attachment',
      response_contract: 'none',
      sensitivity: 'non_secret',
      message: 'Finish login in the browser surface.',
      attachments: [{ kind: 'browser_surface', role: 'streaming_companion' }],
      timeout_seconds: 60,
    }) + '\\n');
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  return path;
}

interface MockNekoCompanionOptions {
  browserOwnerMode?: string;
  dispatchedEvents?: unknown[];
  startedViewports?: unknown[];
  status?: unknown;
  stealthMode?: string;
}

function makeMockNekoCompanion(upstreamOrigin: string, options: MockNekoCompanionOptions = {}) {
  return ({ browser_session_id }: { browser_session_id: string }): NekoCompanion => {
    const companion: NekoCompanion = {
      async ackFrame() {
        /* intentionally empty */
      },
      backend: "neko",
      browser_session_id,
      browserOwnerMode() {
        return options.browserOwnerMode || "neko-owned";
      },
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      async dispatch(event) {
        options.dispatchedEvents?.push(event);
      },
      getNekoProxyTarget() {
        return { origin: upstreamOrigin };
      },
      onEvent() {
        return () => {
          /* intentionally empty */
        };
      },
      onFrame() {
        return () => {
          /* intentionally empty */
        };
      },
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      async start(viewport) {
        options.startedViewports?.push(viewport);
      },
      stealthMode() {
        return options.stealthMode || "balanced";
      },
      async stop() {
        /* intentionally empty */
      },
    };
    if ("status" in options) {
      companion.queryNekoStatus = async () => options.status;
    }
    return companion;
  };
}

function makeAbortableNekoSleep(): (ms: number, signal?: AbortSignal) => Promise<void> {
  return (_ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function makePhonePresentationCompanion({
  screenSelections,
  windowAcknowledgements,
}: {
  screenSelections: unknown[];
  windowAcknowledgements: unknown[];
}) {
  const baseline = { height: 900, rate: 30, width: 1440 };
  const configurations = [{ height: 915, rate: 30, width: 412 }, { height: 412, rate: 30, width: 915 }, baseline];
  return ({ browser_session_id }: { browser_session_id: string }): NekoCompanion => {
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    const fetchImpl = async (url: string, init: { method?: string; body?: string } = {}): Promise<Response> => {
      const method = init.method || "GET";
      if (url === "https://neko.test/api/room/screen" && method === "GET") {
        return jsonResponse(baseline);
      }
      if (url === "https://neko.test/api/room/screen/configurations" && method === "GET") {
        return jsonResponse(configurations);
      }
      if (url === "https://neko.test/api/room/screen" && method === "POST") {
        const selection = JSON.parse(init.body ?? "");
        screenSelections.push(selection);
        return jsonResponse(selection);
      }
      if (url === "https://neko.test/api/room/window" && method === "POST") {
        const acknowledgement = JSON.parse(init.body ?? "");
        windowAcknowledgements.push(acknowledgement);
        return jsonResponse({ acknowledged: true, ...acknowledgement });
      }
      if (url.startsWith("https://neko.test/pdpp/window-settle") && method === "GET") {
        const requested = new URL(url);
        return jsonResponse({
          height: Number(requested.searchParams.get("height")),
          settled: true,
          width: Number(requested.searchParams.get("width")),
        });
      }
      if (url === "https://neko.test/api/room/screen/cast.jpg" && method === "GET") {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      throw new Error(`unexpected n.eko request: ${method} ${url}`);
    };
    return createNekoCompanion({
      bearerToken: "test-token",
      browser_session_id,
      fetchImpl,
      origin: "https://neko.test",
      pollIntervalMs: 60_000,
      screenConfigurationsEndpoint: "/api/room/screen/configurations",
      screenEndpoint: "/api/room/screen",
      sleep: makeAbortableNekoSleep(),
      windowEndpoint: "/api/room/window",
      windowSettleEndpoint: "/pdpp/window-settle",
    });
  };
}

function makeRestoreGate() {
  let releaseStop: () => void = () => {
    throw new Error("releaseStop not yet assigned");
  };
  let stopStarted = false;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  return {
    release() {
      releaseStop();
    },
    started() {
      return stopStarted;
    },
    async stop() {
      stopStarted = true;
      await stopGate;
    },
  };
}

function makeGatedNekoCompanion(stop: () => Promise<void>) {
  return ({ browser_session_id }: { browser_session_id: string }): NekoCompanion => ({
    async ackFrame() {
      /* intentionally empty */
    },
    backend: "neko",
    browser_session_id,
    async dispatch() {
      /* intentionally empty */
    },
    getNekoProxyTarget() {
      return { origin: "http://127.0.0.1:9" };
    },
    onEvent() {
      return () => {
        /* intentionally empty */
      };
    },
    onFrame() {
      return () => {
        /* intentionally empty */
      };
    },
    async start() {
      /* intentionally empty */
    },
    stop,
  });
}

interface CompanionSpawnArgs {
  browser_session_id: string;
  interaction_id: string;
  run_id: string;
  target?: unknown;
}

/**
 * The harness's per-test override bag. Genuinely a wide, loosely-typed grab
 * bag by design — each test overrides only the handful of seams it's
 * exercising, and the same object is passed straight through to
 * `buildManualActionConnector`'s `{kind, timeoutSeconds}` destructure AND
 * into `startServer`'s many independent options. `Record<string, unknown>`
 * intersected with the known fields is the honest shape here (same pattern
 * as `NekoCompanionOptions`), not a suppression.
 */
interface HarnessOptions extends Record<string, unknown> {
  browserSurfaceLeaseManager?: unknown;
  browserSurfaceReadinessProbe?: unknown;
  buildConnector?: (tmpDir: string) => string;
  isNekoProxyTargetApproved?: unknown;
  kind?: string;
  makeCompanion?: (args: CompanionSpawnArgs) => unknown;
  makeStreamingBrowserSessionId?: () => string;
  manifestName?: string;
  nekoProxyAutoLogin?: unknown;
  nekoWindowSettleProbe?: (endpoint: string) => Promise<unknown>;
  streamingClearTimeout?: (timer: unknown) => void;
  streamingLogger?: unknown;
  streamingNow?: () => number;
  streamingSessionStore?: unknown;
  streamingSetTimeout?: (callback: () => void, delay: number) => unknown;
  timeoutSeconds?: number;
}

interface HarnessCompanionRecord {
  browser_session_id: string;
  companion: MockCompanion;
  interaction_id: string;
  run_id: string;
  target: Record<string, unknown> | null;
}

interface SpotifyManifest {
  connector_id: string;
  [key: string]: unknown;
}

interface HarnessContext {
  asUrl: string;
  companions: HarnessCompanionRecord[];
  server: ClosableServer;
  spotifyManifest: SpotifyManifest;
}

/**
 * `mint` results come from the generic `fetchJson()` helper (`body: unknown`)
 * across ~30 tests and ~80 call sites in this file. Rather than threading a
 * cast through every test body, `mint.body` is cast to this one shape at each
 * access site via the `MintBody` alias below — same boundary-typing tradeoff
 * as the other `Record<string, unknown>`-based local types in this file.
 */
interface MintBody {
  error?: { code?: string; message?: string; [key: string]: unknown };
  input_path?: string;
  interaction_id?: string;
  object?: string;
  run_id?: string;
  token?: string;
  viewer_path?: string;
  viewport?: { width?: number; height?: number; [key: string]: unknown };
  viewport_path?: string;
  [key: string]: unknown;
}

/**
 * `streamingLogger.info(record)` observations captured across the n.eko
 * proxy-diagnostic tests. The logger is genuinely structured-but-untyped
 * (an internal transport-diagnostic shape, not a public contract), so a
 * permissive record with the fields these tests assert against is the
 * honest local type — same tradeoff as `HarnessOptions`/`NekoCompanionOptions`.
 */
/** `MockCompanion.inputs: unknown[]` items dispatched via `dispatch(event)`. */
interface InputEvent {
  action?: string;
  deviceScaleFactor?: number;
  height?: number;
  mobile?: boolean;
  screenHeight?: number;
  screenWidth?: number;
  text?: string;
  type?: string;
  width?: number;
  [key: string]: unknown;
}

interface StreamObservation {
  backend?: string;
  error_code?: string;
  event?: string;
  stage?: string;
  target_protocol?: string;
  transport?: string;
  [key: string]: unknown;
}

async function withHarness(options: HarnessOptions | null, fn: (ctx: HarnessContext) => Promise<void>): Promise<void> {
  __resetControllerInteractionStateForTests();
  const harnessOptions = options || {};
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-ref-stream-"));
  const connectorPath =
    typeof harnessOptions.buildConnector === "function"
      ? harnessOptions.buildConnector(tmpDir)
      : buildManualActionConnector(tmpDir, harnessOptions);
  const companions: HarnessCompanionRecord[] = [];
  const streamingCompanionFactory = ({
    browser_session_id,
    run_id,
    interaction_id,
    target = null,
  }: CompanionSpawnArgs) => {
    const companion =
      typeof harnessOptions.makeCompanion === "function"
        ? harnessOptions.makeCompanion({ browser_session_id, interaction_id, run_id, target })
        : createMockCompanion({ browser_session_id });
    companions.push({
      browser_session_id,
      companion: companion as MockCompanion,
      interaction_id,
      run_id,
      target: target as Record<string, unknown> | null,
    });
    return companion;
  };
  const server = await startServer({
    asPort: 0,
    browserSurfaceLeaseManager: harnessOptions.browserSurfaceLeaseManager,
    browserSurfaceReadinessProbe: harnessOptions.browserSurfaceReadinessProbe,
    connectorPathResolver: () => connectorPath,
    dbPath: ":memory:",
    isNekoProxyTargetApproved: harnessOptions.isNekoProxyTargetApproved,
    makeStreamingBrowserSessionId: harnessOptions.makeStreamingBrowserSessionId,
    nekoProxyAutoLogin: harnessOptions.nekoProxyAutoLogin,
    nekoWindowSettleProbe:
      harnessOptions.nekoWindowSettleProbe ??
      (async () => ({ json: async () => ({ height: 900, settled: true, width: 1440 }), ok: true })),
    quiet: true,
    rsPort: 0,
    streamingClearTimeout: harnessOptions.streamingClearTimeout,
    streamingCompanionFactory,
    streamingLogger: harnessOptions.streamingLogger,
    streamingNow: harnessOptions.streamingNow,
    streamingSessionStore: harnessOptions.streamingSessionStore,
    streamingSetTimeout: harnessOptions.streamingSetTimeout,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const manifestName = harnessOptions.manifestName || "spotify";
  const spotifyManifest: SpotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, `manifests/${manifestName}.json`), "utf8")
  );
  try {
    await registerConnector(asUrl, spotifyManifest);
    await fn({ asUrl, companions, server, spotifyManifest });
  } finally {
    try {
      const runIds = new Set(companions.map(({ run_id }) => run_id));
      await Promise.all(
        Array.from(runIds, async (runId) => {
          const pending = server.controller.getPendingInteraction(runId);
          if (pending) {
            await server.controller.respondToInteraction(runId, {
              interaction_id: pending.interaction_id,
              status: "cancelled",
            });
          }
        })
      );
      const cancellations = await Promise.all(Array.from(runIds, (runId) => server.controller.cancelRun(runId)));
      const drain = await server.controller.drainActiveRuns(5000);
      assert.equal(
        drain.timedOut,
        0,
        `streaming harness left ${drain.timedOut} connector run(s) active after ${JSON.stringify(cancellations)}`
      );
    } finally {
      try {
        await closeServer(server);
      } finally {
        __resetControllerInteractionStateForTests();
        rmSync(tmpDir, { force: true, recursive: true });
      }
    }
  }
}

interface StartedRun {
  run_id: string;
  [key: string]: unknown;
}

interface ExpiredPresentationContext {
  abort: AbortController;
  asUrl: string;
  clock: InjectedClock;
  companions: HarnessCompanionRecord[];
  mint: FetchJsonResult;
  pending: TimelineEvent;
  server: ClosableServer;
  started: StartedRun;
  timers: ReturnType<typeof createInjectedTimers>;
}

async function withExpiredPresentation(
  harnessOptions: HarnessOptions,
  fn: (ctx: ExpiredPresentationContext) => Promise<void>
): Promise<void> {
  const clock = createInjectedClock();
  const timers = createInjectedTimers(clock);
  const streamingSessionStore = createStreamingSessionStore({ now: clock.now, ttlMs: 100 });
  await withHarness(
    {
      ...harnessOptions,
      streamingClearTimeout: timers.clearTimeout,
      streamingNow: clock.now,
      streamingSessionStore,
      streamingSetTimeout: timers.setTimeout,
    },
    async ({ asUrl, spotifyManifest, ...context }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(mint.status, 201);
      const mintBody = mint.body as { viewer_path: string; [key: string]: unknown };
      const abort = new AbortController();
      const stream = await fetch(`${asUrl}${mintBody.viewer_path}`, { signal: abort.signal });
      assert.equal(stream.status, 200);
      clock.advance(101);
      await fn({ ...context, abort, asUrl, clock, mint, pending, started, timers });
    }
  );
}

async function startRun(asUrl: string, connectorId: string): Promise<StartedRun> {
  const r = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/run`, { method: "POST" });
  assert.equal(r.status, 202);
  return (await r.json()) as StartedRun;
}

async function cancelRun(asUrl: string, runId: string, interactionId: string): Promise<void> {
  const response = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/interaction`, {
    body: JSON.stringify({ interaction_id: interactionId, status: "cancelled" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const responseBody = await response.text();
  assert.equal(response.status, 202, `cancel interaction: ${responseBody}`);
  await waitForRunTerminal(asUrl, runId);
}

async function requestNekoUpgrade(asUrl: string, cookie: string): Promise<void> {
  const target = new URL("/neko/socket", asUrl);
  await new Promise<void>((resolve, reject) => {
    const request = http.request({
      headers: {
        Connection: "Upgrade",
        Cookie: cookie,
        Upgrade: "websocket",
      },
      host: target.hostname,
      path: target.pathname,
      port: target.port,
    });
    request.once("response", (response) => {
      assert.equal(response.statusCode, 502);
      response.resume();
      response.once("end", () => resolve());
    });
    request.once("upgrade", () => reject(new Error("unexpected successful n.eko upgrade")));
    request.once("error", reject);
    request.end();
  });
}

test("managed n.eko approval is lease, surface, profile, run, interaction, readiness, and origin scoped", () => {
  const leaseManager = makeLeaseManager();
  const acquired = leaseManager.acquire({
    connectorId: "chatgpt",
    profileKey: "profile_dynamic_1",
    runId: "run_dynamic_1",
  });
  assert.equal(acquired.lease.status, "leased");

  const target: Record<string, unknown> & { interaction_id?: string } = {
    cdp_http_url: "http://neko:9222",
    interaction_id: "int_a",
    lease_id: "lease_dynamic_1",
    origin: "http://10.88.0.4:6080/_ref/browser-surfaces/surface_dynamic_1",
    profile_key: "profile_dynamic_1",
    surface_id: "surface_dynamic_1",
  };
  const context = {
    browserSurfaceLeaseManager: leaseManager,
    interactionId: "int_a",
    runId: "run_dynamic_1",
  };

  assert.equal(isManagedNekoSurfaceApproved(target, context), true);
  const { interaction_id: _interactionId, ...targetWithoutInteraction } = target;
  assert.equal(isManagedNekoSurfaceApproved(targetWithoutInteraction, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, interaction_id: "int_b" }, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, surface_id: "surface_other" }, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, lease_id: "lease_other" }, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, profile_key: "profile_other" }, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, cdp_http_url: "http://neko:9333" }, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, origin: "http://10.88.0.4:6080/neko" }, context), false);
  assert.equal(isManagedNekoSurfaceApproved(target, { ...context, runId: "run_other" }), false);

  leaseManager.release({ fencingToken: acquired.lease.fencing_token, leaseId: acquired.lease.lease_id });
  assert.equal(isManagedNekoSurfaceApproved(target, context), false);
});

test("managed n.eko approval rejects a non-ready real lease-manager surface", () => {
  const leaseManager = makeLeaseManager({ initialActiveLease: true, surfaceHealth: "starting" });

  assert.equal(
    isManagedNekoSurfaceApproved(
      {
        interaction_id: "int_a",
        lease_id: "lease_dynamic_1",
        origin: "http://10.88.0.4:6080/_ref/browser-surfaces/surface_dynamic_1",
        profile_key: "profile_dynamic_1",
        surface_id: "surface_dynamic_1",
      },
      {
        browserSurfaceLeaseManager: leaseManager,
        interactionId: "int_a",
        runId: "run_dynamic_1",
      }
    ),
    false
  );
});

test("mint accepts a pending manual_action interaction", async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const beforeMint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
    const beforeMintBody = beforeMint.body as TimelineBody;
    const assistanceRequested = beforeMintBody.data.find((event) => event.event_type === "run.assistance_requested");
    assert.ok(assistanceRequested, "manual_action should project to run.assistance_requested");
    assert.equal(assistanceRequested.interaction_id, pending.interaction_id);
    assert.equal(assistanceRequested.data?.assistance_request_id, pending.interaction_id);
    assert.equal(assistanceRequested.data?.progress_posture, "blocked");
    assert.equal(assistanceRequested.data?.owner_action, "operate_attachment");
    assert.equal(assistanceRequested.data?.response_contract, "response_required");
    assert.equal(assistanceRequested.data?.sensitivity, "non_secret");
    assert.deepEqual(assistanceRequested.data?.attachments, [{ kind: "browser_surface", role: "streaming_companion" }]);

    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        viewport: { height: 600, width: 800 },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(mint.status, 201);
    const mintBody = mint.body as MintBody;
    assert.equal(mintBody.object, "run_interaction_stream_session");
    assert.equal(typeof mintBody.token, "string");
    assert.ok((mintBody.token ?? "").length >= 32);
    assert.ok((mintBody.viewer_path ?? "").startsWith("/_ref/run-interaction-streams/"));

    await cancelRun(asUrl, started.run_id, pending.interaction_id);
    const afterCancel = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
    const afterCancelBody = afterCancel.body as TimelineBody;
    const assistanceCancelled = afterCancelBody.data.find((event) => event.event_type === "run.assistance_cancelled");
    assert.ok(assistanceCancelled, "manual_action cancellation should project to run.assistance_cancelled");
    assert.equal(assistanceCancelled.interaction_id, pending.interaction_id);
    assert.equal(assistanceCancelled.data?.status, "cancelled");
  });
});

test("mint accepts current no-response browser-surface assistance backed by a leased surface", async () => {
  const connectorId = "https://registry.pdpp.org/connectors/spotify";
  const leaseManager = makeLeaseManager({ connectorId });
  await withHarness(
    {
      browserSurfaceLeaseManager: leaseManager,
      buildConnector: buildNoResponseBrowserAssistanceConnector,
    },
    async ({ asUrl, spotifyManifest, companions }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      try {
        const acquired = leaseManager.acquire({
          connectorId,
          profileKey: "profile_dynamic_1",
          runId: started.run_id,
        });
        assert.equal(acquired.lease.status, "leased");

        const assistance = await waitForAssistanceRequest(asUrl, started.run_id);
        assert.equal(assistance.data?.assistance_request_id, "asst_stream_1");
        assert.equal(assistance.data?.response_contract, "none");
        assert.equal(assistance.data?.owner_action, "operate_attachment");
        assert.equal(assistance.data?.progress_posture, "blocked");

        const mint = await fetchJson(
          `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`,
          {
            body: JSON.stringify({
              interaction_id: "asst_stream_1",
              viewport: { height: 600, width: 800 },
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        assert.equal(mint.status, 201, JSON.stringify(mint.body));
        assert.equal((mint.body as MintBody).object, "run_interaction_stream_session");
        assert.equal((mint.body as MintBody).interaction_id, "asst_stream_1");
        assert.equal((mint.body as MintBody).run_id, started.run_id);
        assertNoRawBackendAuthority(mint.body);

        const tracked = companions.find((c) => c.run_id === started.run_id);
        assert.ok(tracked, "companion factory captured the assistance stream");
        assert.ok(tracked.target, "tracked companion has a target");
        assert.equal(tracked.interaction_id, "asst_stream_1");
        assert.equal(tracked.target.backend, "neko");
        assert.equal(tracked.target.lease_id, acquired.lease.lease_id);
        assert.equal(tracked.target.surface_id, acquired.lease.surface_id);
        assert.equal(tracked.target.interaction_id, "asst_stream_1");
        assert.equal(tracked.target.window_settle_endpoint, "http://neko:9222/pdpp/window-settle");
      } finally {
        await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/cancel`, { method: "POST" });
        await waitForRunTerminal(asUrl, started.run_id);
      }
    }
  );
});

test("mint accepts pending browser interaction backed by a managed browser surface", async () => {
  const connectorId = "https://registry.pdpp.org/connectors/spotify";
  const leaseManager = makeLeaseManager({ connectorId });
  await withHarness(
    {
      browserSurfaceLeaseManager: leaseManager,
    },
    async ({ asUrl, spotifyManifest, companions }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      try {
        const acquired = leaseManager.acquire({
          connectorId,
          profileKey: "profile_dynamic_1",
          runId: started.run_id,
        });
        assert.equal(acquired.lease.status, "leased");

        const pending = await waitForPendingInteraction(asUrl, started.run_id);
        assert.equal(pending.interaction_id, "int_stream_1");

        const mint = await fetchJson(
          `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`,
          {
            body: JSON.stringify({
              interaction_id: pending.interaction_id,
              viewport: { height: 600, width: 800 },
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        assert.equal(mint.status, 201, JSON.stringify(mint.body));
        assert.equal((mint.body as MintBody).object, "run_interaction_stream_session");
        assert.equal((mint.body as MintBody).interaction_id, pending.interaction_id);
        assertNoRawBackendAuthority(mint.body);

        const tracked = companions.find((c) => c.run_id === started.run_id);
        assert.ok(tracked, "companion factory captured the pending stream");
        assert.ok(tracked.target, "tracked companion has a target");
        assert.equal(tracked.interaction_id, pending.interaction_id);
        assert.equal(tracked.target.backend, "neko");
        assert.equal(tracked.target.lease_id, acquired.lease.lease_id);
        assert.equal(tracked.target.surface_id, acquired.lease.surface_id);
        assert.equal(tracked.target.interaction_id, pending.interaction_id);
        assert.equal(tracked.target.window_settle_endpoint, "http://neko:9222/pdpp/window-settle");
      } finally {
        await cancelRun(asUrl, started.run_id, "int_stream_1");
      }
    }
  );
});

test("mint derives the presentation endpoint from live behavior rather than surface metadata", async () => {
  const connectorId = "https://registry.pdpp.org/connectors/spotify";
  const leaseManager = makeLeaseManager({ connectorId, withSettleEndpoint: false });
  const requests: unknown[] = [];
  await withHarness(
    {
      browserSurfaceLeaseManager: leaseManager,
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      nekoWindowSettleProbe: async (endpoint) => {
        requests.push(endpoint);
        return { json: async () => ({ height: 900, settled: true, width: 1440 }), ok: true };
      },
    },
    async ({ asUrl, spotifyManifest, companions }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      try {
        const acquired = leaseManager.acquire({ connectorId, profileKey: "profile_dynamic_1", runId: started.run_id });
        assert.equal(acquired.lease.status, "leased");
        const pending = await waitForPendingInteraction(asUrl, started.run_id);
        const mint = await fetchJson(
          `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`,
          {
            body: JSON.stringify({ interaction_id: pending.interaction_id }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        assert.equal(mint.status, 201, JSON.stringify(mint.body));
        assert.deepEqual(requests, ["http://neko:9222/pdpp/window-settle"]);
        const tracked = companions.find((companion) => companion.run_id === started.run_id);
        assert.ok(tracked, "companion factory captured the streaming session");
        assert.ok(tracked.target, "tracked companion has a target");
        assert.equal(tracked.target.window_settle_endpoint, "http://neko:9222/pdpp/window-settle");
      } finally {
        await cancelRun(asUrl, started.run_id, "int_stream_1");
      }
    }
  );
});

test("mint fails loudly before viewer creation when the live window-settle behavior is absent", async () => {
  const connectorId = "https://registry.pdpp.org/connectors/spotify";
  const leaseManager = makeLeaseManager({ connectorId });
  let companionCreated = false;
  await withHarness(
    {
      browserSurfaceLeaseManager: leaseManager,
      makeCompanion() {
        companionCreated = true;
        return createMockCompanion({ browser_session_id: "must-not-create" });
      },
      nekoWindowSettleProbe: async () => ({ json: async () => ({}), ok: false }),
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      try {
        const acquired = leaseManager.acquire({ connectorId, profileKey: "profile_dynamic_1", runId: started.run_id });
        assert.equal(acquired.lease.status, "leased");
        const pending = await waitForPendingInteraction(asUrl, started.run_id);
        const mint = await fetchJson(
          `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`,
          {
            body: JSON.stringify({ interaction_id: pending.interaction_id }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        assert.equal(mint.status, 503);
        assert.equal((mint.body as MintBody).error?.code, "managed_surface_window_settle_unavailable");
        assert.match((mint.body as MintBody).error?.message ?? "", REGEXP_1);
        assert.equal(companionCreated, false);
      } finally {
        await cancelRun(asUrl, started.run_id, "int_stream_1");
      }
    }
  );
});

test("managed lifecycle reaches interaction attach after readiness and a manual wait", async () => {
  const connectorId = "https://registry.pdpp.org/connectors/spotify";
  const leaseManager = makeLeaseManager({ connectorId, profileKey: connectorId });
  let readinessCalls = 0;
  let attachCalls = 0;
  let companionCreated = false;
  await withHarness(
    {
      browserSurfaceLeaseManager: leaseManager,
      browserSurfaceReadinessProbe: {
        // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
        async probe() {
          readinessCalls += 1;
          return { ok: true, pageTargetCount: 1 };
        },
      },
      makeCompanion() {
        companionCreated = true;
        return createMockCompanion({ browser_session_id: "created-after-managed-manual-wait" });
      },
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      nekoWindowSettleProbe: async () => {
        attachCalls += 1;
        return { json: async () => ({ height: 900, settled: true, width: 1440 }), ok: true };
      },
    },
    async ({ asUrl, server, spotifyManifest }) => {
      const started = await server.controller.runNow(spotifyManifest.connector_id, {
        manifest: spotifyManifest,
        ownerToken: "owner-token",
        runId: "run_readiness_manual_attach",
      });
      assert.equal(started.status, "started");
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(readinessCalls, 1, "preflight readiness must pass before manual_action is exposed");
      assert.equal(attachCalls, 1, "the managed attach gate must re-observe current geometry after the wait");
      assert.equal(mint.status, 201, JSON.stringify(mint.body));
      assert.equal((mint.body as MintBody).object, "run_interaction_stream_session");
      assert.equal(companionCreated, true, "a settled framed surface may attach after the manual wait");
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    }
  );
});

test("a new app paired with a stale static n.eko container fails loudly before any black-frame viewer can mount", async () => {
  const connectorId = "https://registry.pdpp.org/connectors/spotify";
  const leaseManager = makeLeaseManager({ connectorId, surfaceMode: "static" });
  let companionCreated = false;
  await withHarness(
    {
      browserSurfaceLeaseManager: leaseManager,
      makeCompanion() {
        companionCreated = true;
        return createMockCompanion({ browser_session_id: "must-not-create-static" });
      },
      nekoWindowSettleProbe: async () => ({ json: async () => ({}), ok: false }),
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      try {
        const acquired = leaseManager.acquire({ connectorId, profileKey: "profile_dynamic_1", runId: started.run_id });
        assert.equal(acquired.lease.status, "leased");
        const pending = await waitForPendingInteraction(asUrl, started.run_id);
        const mint = await fetchJson(
          `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`,
          {
            body: JSON.stringify({ interaction_id: pending.interaction_id }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        assert.equal(mint.status, 503);
        assert.equal((mint.body as MintBody).error?.code, "managed_surface_window_settle_unavailable");
        assert.match((mint.body as MintBody).error?.message ?? "", REGEXP_2);
        assert.equal(companionCreated, false, "no stream viewer may be created for a stale static surface");
      } finally {
        await cancelRun(asUrl, started.run_id, "int_stream_1");
      }
    }
  );
});

test("mint capability probe observes the current geometry without changing it", async () => {
  const connectorId = "https://registry.pdpp.org/connectors/spotify";
  const leaseManager = makeLeaseManager({ connectorId });
  const before = { height: 915, width: 412 };
  let currentScreen = { ...before };
  const requests: URL[] = [];
  await withHarness(
    {
      browserSurfaceLeaseManager: leaseManager,
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      nekoWindowSettleProbe: async (endpoint: string) => {
        const url = new URL(endpoint);
        requests.push(url);
        if (url.pathname === "/pdpp/window-settle") {
          // Detect an accidental presentation mutation: the probe must not
          // send synthetic dimensions to the settle endpoint.
          if (url.searchParams.has("width") || url.searchParams.has("height")) {
            currentScreen = {
              height: Number(url.searchParams.get("height")),
              width: Number(url.searchParams.get("width")),
            };
          }
          return { json: async () => ({ settled: true, ...currentScreen }), ok: true };
        }
        throw new Error(`unexpected probe endpoint ${endpoint}`);
      },
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      try {
        const acquired = leaseManager.acquire({ connectorId, profileKey: "profile_dynamic_1", runId: started.run_id });
        assert.equal(acquired.lease.status, "leased");
        const pending = await waitForPendingInteraction(asUrl, started.run_id);
        const mint = await fetchJson(
          `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`,
          {
            body: JSON.stringify({ interaction_id: pending.interaction_id }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        assert.equal(mint.status, 201, JSON.stringify(mint.body));
      } finally {
        await cancelRun(asUrl, started.run_id, "int_stream_1");
      }
    }
  );
  assert.deepEqual(currentScreen, before, "pre-attach probing must not resize the shared presentation");
  assert.deepEqual(
    requests.map((url) => `${url.pathname}${url.search}`),
    ["/pdpp/window-settle"]
  );
});

test("mint refuses a stale no-response browser-surface assistance id", async () => {
  const connectorId = "https://registry.pdpp.org/connectors/spotify";
  const leaseManager = makeLeaseManager({ connectorId });
  await withHarness(
    {
      browserSurfaceLeaseManager: leaseManager,
      buildConnector: buildNoResponseBrowserAssistanceConnector,
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      try {
        leaseManager.acquire({
          connectorId,
          profileKey: "profile_dynamic_1",
          runId: started.run_id,
        });
        await waitForAssistanceRequest(asUrl, started.run_id);

        const mint = await fetchJson(
          `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`,
          {
            body: JSON.stringify({
              interaction_id: "asst_stream_stale",
              viewport: { height: 600, width: 800 },
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        assert.equal(mint.status, 409);
        assert.equal((mint.body as MintBody).error?.code, "no_pending_interaction");
      } finally {
        await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/cancel`, { method: "POST" });
        await waitForRunTerminal(asUrl, started.run_id);
      }
    }
  );
});

test("mint refuses current no-response browser-surface assistance without a ready surface", async () => {
  const connectorId = "https://registry.pdpp.org/connectors/spotify";
  const leaseManager = makeLeaseManager({ connectorId, surfaceHealth: "starting" });
  await withHarness(
    {
      browserSurfaceLeaseManager: leaseManager,
      buildConnector: buildNoResponseBrowserAssistanceConnector,
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      try {
        leaseManager.acquire({
          connectorId,
          profileKey: "profile_dynamic_1",
          runId: started.run_id,
        });
        await waitForAssistanceRequest(asUrl, started.run_id);

        const mint = await fetchJson(
          `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`,
          {
            body: JSON.stringify({
              interaction_id: "asst_stream_1",
              viewport: { height: 600, width: 800 },
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        assert.equal(mint.status, 503);
        assert.equal((mint.body as MintBody).error?.code, "streaming_companion_unavailable");
      } finally {
        await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/cancel`, { method: "POST" });
        await waitForRunTerminal(asUrl, started.run_id);
      }
    }
  );
});

test("mint accepts a pending otp interaction for browser-backed verification flows", async () => {
  await withHarness({ kind: "otp" }, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        viewport: { height: 600, width: 800 },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(mint.status, 201);
    assert.equal((mint.body as MintBody).object, "run_interaction_stream_session");
    assert.equal((mint.body as MintBody).interaction_id, pending.interaction_id);
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test("mint refuses an interaction kind that does not need browser control", async () => {
  await withHarness({ kind: "credentials" }, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      body: JSON.stringify({ interaction_id: pending.interaction_id }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(mint.status, 409);
    assert.equal((mint.body as MintBody).error?.code, "stream_not_supported_for_kind");
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test("mint refuses a stale interaction id", async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      body: JSON.stringify({ interaction_id: "int_does_not_match" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(mint.status, 409);
    assert.equal((mint.body as MintBody).error?.code, "interaction_id_mismatch");
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test("mint with a duplicate idempotency_key returns the same token (defense-in-depth against StrictMode/retry double-mints)", async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest, companions }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mintUrl = `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`;
    const idempotency_key = "fixture-key-001";
    const body = JSON.stringify({
      idempotency_key,
      interaction_id: pending.interaction_id,
      viewport: { height: 600, width: 800 },
    });
    const first = await fetchJson(mintUrl, {
      body,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(first.status, 201);
    const firstBody = first.body as MintBody;
    assert.equal(firstBody.idempotency_replayed, false);
    const second = await fetchJson(mintUrl, {
      body,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(second.status, 201);
    const secondBody = second.body as MintBody;
    assert.equal(secondBody.token, firstBody.token);
    assert.equal(secondBody.browser_session_id, firstBody.browser_session_id);
    assert.equal(secondBody.idempotency_replayed, true);
    // Crucially: the duplicate mint must NOT have spawned a second companion;
    // otherwise the original would be torn down at the next attach and the
    // dashboard 401 cascade returns. Filter to companions for this run only —
    // earlier tests in the suite share the harness file but not the server,
    // but the safety belt is cheap.
    const forThisRun = companions.filter((c) => c.run_id === started.run_id);
    assert.equal(forThisRun.length, 1, "duplicate mint must reuse the existing companion");
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test("mint with a different idempotency_key supersedes the prior token (legitimate re-open)", async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mintUrl = `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`;
    const first = await fetchJson(mintUrl, {
      body: JSON.stringify({
        idempotency_key: "first-click",
        interaction_id: pending.interaction_id,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(first.status, 201);
    const firstBody = first.body as MintBody;
    const second = await fetchJson(mintUrl, {
      body: JSON.stringify({
        idempotency_key: "second-click",
        interaction_id: pending.interaction_id,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(second.status, 201);
    const secondBody = second.body as MintBody;
    assert.notEqual(secondBody.token, firstBody.token);
    assert.equal(secondBody.idempotency_replayed, false);
    // Prior token is now invalid for SSE attach.
    const reattach = await fetch(`${asUrl}${firstBody.viewer_path}`);
    assert.ok(reattach.status === 401 || reattach.status === 410);
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test("SSE attach delivers an attached event and dispatches frames", async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest, companions }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        viewport: { height: 480, width: 320 },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(mint.status, 201);
    const mintBody = mint.body as MintBody;
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const token = mintBody.token;

    const ac = new AbortController();
    const sseResp = await fetch(`${asUrl}${mintBody.viewer_path}`, { signal: ac.signal });
    assert.equal(sseResp.status, 200);
    assert.match(sseResp.headers.get("content-type") || "", REGEXP_3);
    assert.ok(sseResp.body, "SSE response has a body stream");
    assert.ok(sseResp.body, "SSE response has a body stream");
    const reader = sseResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    async function readEvent(name: string, deadlineMs = 1500): Promise<Record<string, unknown>> {
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        const block = buffer.indexOf("\n\n");
        if (block !== -1) {
          const event = buffer.slice(0, block);
          buffer = buffer.slice(block + 2);
          if (event.includes(`event: ${name}`)) {
            const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
            assert.ok(dataLine, `SSE event ${name} is missing a data: line`);
            return JSON.parse(dataLine.slice(5).trim());
          }
          continue;
        }
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
      }
      throw new Error(`Did not receive SSE event ${name} in ${deadlineMs}ms`);
    }

    const attached = await readEvent("attached");
    assert.equal(attached.run_id, started.run_id);
    assert.equal(attached.interaction_id, pending.interaction_id);
    assert.deepEqual(attached.viewport, { height: 480, width: 320 });

    const backendReady = await readEvent("backend_ready");
    assert.equal(backendReady.backend, "cdp");
    assert.equal(backendReady.client_config_path, null);
    assert.equal(backendReady.iframe_path, null);
    assertNoRawBackendAuthority(backendReady);

    // Inject a frame via the mock companion and confirm the viewer receives it.
    const tracked = companions.find((c) => c.run_id === started.run_id);
    assert.ok(tracked, "companion factory captured the streaming session");
    tracked.companion.pushFrame({ data: "AA==", metadata: { device_width: 320 }, sessionId: 7 });
    const frame = await readEvent("frame");
    assert.equal(frame.session_id, 7);
    assert.equal(frame.data_base64, "AA==");

    // The route MUST acknowledge each delivered CDP screencast frame, or a
    // real Chromium will stop sending frames after the first one. Wait for
    // the best-effort ack to land on the companion record.
    const ackDeadline = Date.now() + 500;
    while (Date.now() < ackDeadline) {
      if (
        tracked.companion.cdpCalls.some(
          (c) =>
            c.method === "Page.screencastFrameAck" && (c.params as { sessionId?: number } | undefined)?.sessionId === 7
        )
      ) {
        break;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      tracked.companion.cdpCalls.some(
        (c) =>
          c.method === "Page.screencastFrameAck" && (c.params as { sessionId?: number } | undefined)?.sessionId === 7
      ),
      "route must call companion.ackFrame(sessionId) for every delivered frame"
    );

    // Re-attach with the same token must SUCCEED — the viewer's SSE socket
    // can drop transiently (mobile network blip, tab visibility change,
    // dev-mode HMR reload) and the operator must be able to resume frame
    // delivery on the same token without losing the session. The session
    // outlives any single transport. See sessions.js `attach` doc comment
    // and routes.js per-connection vs terminal teardown split.
    const reattach = await fetch(`${asUrl}${mintBody.viewer_path}`);
    assert.equal(reattach.status, 200);
    assert.match(reattach.headers.get("content-type") || "", REGEXP_4);
    try {
      await reattach.body?.cancel();
    } catch {
      /* aborted */
    }

    ac.abort();
    try {
      await reader.cancel();
    } catch {
      /* aborted */
    }

    await cancelRun(asUrl, started.run_id, pending.interaction_id);
    // biome-ignore lint/complexity/noVoid: Explicit fire-and-forget is the behavior under test.
    void token;
  });
});

test("n.eko backend emits bounded, redacted first-load lifecycle observations", async () => {
  let observedUpstreamCookie: string | null = null;
  const upstreamRequests: { cookie: string; method?: string | undefined; url?: string | undefined }[] = [];
  const observations: unknown[] = [];
  const upstream = http.createServer((req, res) => {
    observedUpstreamCookie = req.headers.cookie || "";
    upstreamRequests.push({ cookie: req.headers.cookie || "", method: req.method, url: req.url });
    if (req.url === "/neko/" || req.url?.startsWith("/neko/?")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<html><head><script src="js/app.js"></script></head><body>ok</body></html>');
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`proxied:${req.method}:${req.url}`);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => resolve());
  });
  const upstreamAddress = upstream.address();
  const upstreamPort = typeof upstreamAddress === "object" && upstreamAddress ? upstreamAddress.port : 0;
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;

  try {
    await withHarness(
      {
        makeCompanion: makeMockNekoCompanion(upstreamOrigin),
        streamingLogger: {
          info(record: unknown) {
            observations.push(record);
          },
        },
      },
      async ({ asUrl, spotifyManifest }) => {
        const unauthenticatedProxy = await fetchJson(`${asUrl}/neko/echo`);
        assert.equal(unauthenticatedProxy.status, 401);

        const started = await startRun(asUrl, spotifyManifest.connector_id);
        const pending = await waitForPendingInteraction(asUrl, started.run_id);
        const mint = await fetchJson(
          `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`,
          {
            body: JSON.stringify({ interaction_id: pending.interaction_id }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        assert.equal(mint.status, 201);
        const mintBody = mint.body as MintBody;

        const ac = new AbortController();
        const sseResp = await fetch(`${asUrl}${mintBody.viewer_path}`, { signal: ac.signal });
        assert.equal(sseResp.status, 200);
        const controllerCookie = presentationAttachmentCookie(sseResp);
        assert.ok(sseResp.body, "SSE response has a body stream");
        assert.ok(sseResp.body, "SSE response has a body stream");
        const reader = sseResp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        async function readEvent(name: string, deadlineMs = 1500): Promise<Record<string, unknown>> {
          const deadline = Date.now() + deadlineMs;
          while (Date.now() < deadline) {
            const block = buffer.indexOf("\n\n");
            if (block !== -1) {
              const event = buffer.slice(0, block);
              buffer = buffer.slice(block + 2);
              if (event.includes(`event: ${name}`)) {
                const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
                assert.ok(dataLine, `SSE event ${name} is missing a data: line`);
                return JSON.parse(dataLine.slice(5).trim());
              }
              continue;
            }
            // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });
          }
          throw new Error(`Did not receive SSE event ${name} in ${deadlineMs}ms`);
        }

        await readEvent("attached");
        const backendReady = await readEvent("backend_ready");
        assert.equal(backendReady.backend, "neko");
        assert.equal(
          backendReady.client_config_path,
          `/_ref/run-interaction-streams/${encodeURIComponent(mintBody.token ?? "")}/neko/session`
        );
        assert.equal(
          backendReady.iframe_path,
          `/_ref/run-interaction-streams/${encodeURIComponent(mintBody.token ?? "")}/neko`
        );
        assert.equal(backendReady.browser_owner_mode, "neko-owned");
        assert.equal(backendReady.stealth_mode, "balanced");
        assertNoRawBackendAuthority(backendReady);

        const clientConfig = await fetch(`${asUrl}${backendReady.client_config_path}`);
        assert.equal(clientConfig.status, 200);
        const clientConfigCookie = clientConfig.headers.get("set-cookie") || "";
        assert.match(clientConfigCookie, REGEXP_5);
        assert.match(clientConfigCookie, REGEXP_6);
        const clientConfigBody = await clientConfig.json();
        assert.deepEqual(clientConfigBody, {
          login: {
            password: "neko",
            username: "user",
          },
          object: "run_interaction_neko_client",
          server_path: "/neko",
          status_path: "/neko/__pdpp/status",
        });
        assertNoRawBackendAuthority(clientConfigBody);

        const entry = await fetch(`${asUrl}${backendReady.iframe_path}`, { redirect: "manual" });
        assert.equal(entry.status, 302);
        const entryLocation = entry.headers.get("location");
        assert.ok(entryLocation, "redirect must carry a location header");
        assert.match(entryLocation, REGEXP_7);
        const entryUrl = new URL(entryLocation, asUrl);
        assert.equal(entryUrl.pathname, "/neko");
        assert.ok(entryUrl.searchParams.get("pdpp_stream"));
        assert.equal(entryUrl.searchParams.get("embed"), "1");
        assert.equal(entryUrl.searchParams.has("usr"), false);
        assert.equal(entryUrl.searchParams.has("pwd"), false);
        const cookie = entry.headers.get("set-cookie") || "";
        assert.match(cookie, REGEXP_8);
        assert.match(cookie, REGEXP_9);

        const statusNoControl = await fetchJson(`${asUrl}/neko/__pdpp/status`, { headers: { cookie } });
        assert.equal(statusNoControl.status, 200);
        assert.deepEqual(statusNoControl.body, {
          control_available: false,
          object: "run_interaction_neko_status",
        });

        const proxiedEntry = await fetch(`${asUrl}${entryLocation}`, { headers: { cookie } });
        assert.equal(proxiedEntry.status, 200);
        const proxiedEntryHtml = await proxiedEntry.text();
        assert.match(proxiedEntryHtml, REGEXP_10);
        assert.match(proxiedEntryHtml, REGEXP_11);
        assert.match(proxiedEntryHtml, REGEXP_12);
        assert.match(proxiedEntryHtml, REGEXP_13);
        assert.match(proxiedEntryHtml, REGEXP_14);
        assert.match(proxiedEntryHtml, REGEXP_15);

        const proxied = await fetch(`${asUrl}/neko/echo?x=1`, { headers: { cookie } });
        assert.equal(proxied.status, 200);
        assert.equal(await proxied.text(), "proxied:GET:/neko/echo?x=1");

        const bearerOnlyMutation = await fetchJson(`${asUrl}/neko/echo`, {
          body: JSON.stringify({ action: "mutate" }),
          headers: { "Content-Type": "application/json", Cookie: cookie },
          method: "POST",
        });
        assert.equal(bearerOnlyMutation.status, 409);
        assert.equal((bearerOnlyMutation.body as MintBody).error?.code, "presentation_attachment_not_controlling");
        assert.equal(
          upstreamRequests.some((request) => request.method === "POST"),
          false,
          "a bearer-derived n.eko cookie alone must not reach a mutating upstream route"
        );

        const controllerMutation = await fetch(`${asUrl}/neko/echo`, {
          body: JSON.stringify({ action: "mutate" }),
          headers: { "Content-Type": "application/json", Cookie: `${cookie}; ${controllerCookie}` },
          method: "POST",
        });
        assert.equal(controllerMutation.status, 200);
        assert.equal(await controllerMutation.text(), "proxied:POST:/neko/echo");

        const observerStream = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`);
        assert.equal(observerStream.status, 200);
        await observerStream.body?.cancel();
        const observerGet = await fetch(`${asUrl}/neko/observer`, { headers: { cookie } });
        assert.equal(observerGet.status, 200);
        assert.equal(await observerGet.text(), "proxied:GET:/neko/observer");

        const proxiedRoot = await fetch(`${asUrl}/neko`, { headers: { cookie } });
        assert.equal(proxiedRoot.status, 200);
        const proxiedRootHtml = await proxiedRoot.text();
        assert.match(proxiedRootHtml, REGEXP_16);
        assert.match(proxiedRootHtml, REGEXP_17);
        assert.match(proxiedRootHtml, REGEXP_18);

        const transportEvents = (observations as { event?: string; [key: string]: unknown }[]).filter((record) =>
          record.event?.startsWith("stream_")
        );
        const expectedFirstLoadEvents = [
          "stream_sse_attach_started",
          "stream_backend_ready_emitted",
          "stream_neko_proxy_target_resolved",
          "stream_neko_client_config_issued",
        ];
        for (const event of expectedFirstLoadEvents) {
          assert.equal(
            transportEvents.some((record) => record.event === event),
            true,
            `missing ${event}`
          );
        }
        for (const record of transportEvents) {
          assert.equal(record.run_id, started.run_id);
          assert.equal(record.interaction_id, pending.interaction_id);
          assert.equal(typeof record.browser_session_id, "string");
          assert.equal(JSON.stringify(record).includes(upstreamOrigin), false);
          assert.equal(JSON.stringify(record).includes(mintBody.token ?? ""), false);
        }

        assert.ok(
          !String(observedUpstreamCookie).includes("pdpp_neko_stream="),
          "stream token cookie must not be forwarded to n.eko"
        );
        const [controllerCookieName] = controllerCookie.split("=", 1);
        assert.ok(controllerCookieName, "controller cookie has a name");
        assert.equal(
          upstreamRequests.find((request) => request.method === "POST")?.cookie.includes(controllerCookieName),
          false,
          "controller attachment cookie must not be forwarded to n.eko"
        );

        ac.abort();
        try {
          await reader.cancel();
        } catch {
          /* aborted */
        }
        await cancelRun(asUrl, started.run_id, pending.interaction_id);
      }
    );
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("n.eko diagnostic observations retain finite target and transport discriminators under repeated upstream failures", async () => {
  const observations: StreamObservation[] = [];
  const secretBackend = "neko://operator:credential@private.example";
  await withHarness(
    {
      makeCompanion: ({ browser_session_id }) => ({
        ...makeMockNekoCompanion("http://127.0.0.1:9")({ browser_session_id }),
        backend: secretBackend,
      }),
      streamingLogger: {
        info(record: StreamObservation) {
          observations.push(record);
        },
      },
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(mint.status, 201);

      const abort = new AbortController();
      const stream = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: abort.signal });
      assert.equal(stream.status, 200);
      assert.ok(stream.body, "SSE response has a body stream");
      const reader = stream.body.getReader();
      let sse = "";
      while (!sse.includes("event: backend_ready")) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        const { done, value } = await reader.read();
        assert.equal(done, false, "SSE must reach backend-ready before proxy diagnostics");
        sse += new TextDecoder().decode(value, { stream: true });
      }

      const clientConfig = await fetch(
        `${asUrl}/_ref/run-interaction-streams/${encodeURIComponent((mint.body as MintBody).token ?? "")}/neko/session`
      );
      assert.equal(clientConfig.status, 200);
      const cookie = clientConfig.headers.get("set-cookie");
      assert.ok(cookie);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        const response = await fetch(`${asUrl}/neko/repeated-failure`, { headers: { Cookie: cookie } });
        assert.equal(response.status, 502);
      }
      await requestNekoUpgrade(asUrl, cookie);

      const backendReady = observations.find((record) => record.event === "stream_backend_ready_emitted");
      assert.ok(backendReady, "expected a stream_backend_ready_emitted observation");
      assert.equal(backendReady.backend, "unknown");
      const target = observations.find(
        (record) => record.event === "stream_neko_proxy_target_resolved" && record.stage === "neko_client_config"
      );
      assert.ok(target, "expected a stream_neko_proxy_target_resolved observation");
      assert.deepEqual(target.target_protocol, "http");
      const failures = observations.filter((record) => record.event === "stream_neko_proxy_upstream_failed");
      assert.deepEqual(
        failures
          .map((record) => ({ error_code: record.error_code, stage: record.stage, transport: record.transport ?? "" }))
          .sort((a, b) => a.transport.localeCompare(b.transport)),
        [
          { error_code: "ECONNREFUSED", stage: "neko_proxy_http", transport: "http_proxy" },
          { error_code: "ECONNREFUSED", stage: "neko_proxy_websocket_upgrade", transport: "websocket_upgrade" },
        ]
      );
      assert.ok(observations.length <= 12, "per-session diagnostic key budget must bound 100 failures");
      assert.ok(Math.max(...observations.map((record) => Buffer.byteLength(JSON.stringify(record)))) < 512);
      assert.equal(JSON.stringify(observations).includes(secretBackend), false);

      abort.abort();
      await reader.cancel().catch(() => {
        /* intentionally empty */
      });
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    }
  );
});

test("n.eko diagnostic observations clamp megabyte companion error codes before logging", async () => {
  const observations: StreamObservation[] = [];
  const megabyteCode = `secret-${"x".repeat(1024 * 1024)}`;
  await withHarness(
    {
      makeCompanion: ({ browser_session_id }) => {
        const companion = makeMockNekoCompanion("http://127.0.0.1:9")({ browser_session_id });
        // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
        companion.start = async () => {
          const error: Error & { code?: string } = new Error("companion start failed");
          error.code = megabyteCode;
          throw error;
        };
        return companion;
      },
      streamingLogger: {
        info(record: StreamObservation) {
          observations.push(record);
        },
      },
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(mint.status, 201);
      const stream = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`);
      assert.ok(stream.body, "SSE response has a body stream");
      const reader = stream.body.getReader();
      let sse = "";
      while (!sse.includes("event: error")) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        const { done, value } = await reader.read();
        assert.equal(done, false, "SSE must report the companion start failure");
        sse += new TextDecoder().decode(value, { stream: true });
      }
      const failure = observations.find((record) => record.event === "stream_companion_start_failed");
      assert.ok(failure, "expected a stream_companion_start_failed observation");
      assert.deepEqual(failure.error_code, "unknown");
      assert.ok(Buffer.byteLength(JSON.stringify(failure)) < 512);
      assert.equal(JSON.stringify(failure).includes(megabyteCode), false);
      await reader.cancel().catch(() => {
        /* intentionally empty */
      });
    }
  );
});

test("companion-less invalidation clears the diagnostic key budget before a browser-session id is reused", async () => {
  const observations: StreamObservation[] = [];
  const baseSessionStore = createStreamingSessionStore();
  type StreamingSessionRecord = ReturnType<typeof baseSessionStore.authorize>;
  type MintRequest = Parameters<typeof baseSessionStore.mint>[0];
  let authorizedSession: StreamingSessionRecord | null = null;
  const streamingSessionStore = {
    ...baseSessionStore,
    authorize() {
      return authorizedSession;
    },
    mint(request?: MintRequest) {
      const minted = baseSessionStore.mint(request);
      authorizedSession = minted.session;
      return minted;
    },
  };
  await withHarness(
    {
      makeCompanion: () => null,
      makeStreamingBrowserSessionId: () => "bs_reused_without_companion",
      streamingLogger: {
        info(record: StreamObservation) {
          observations.push(record);
        },
      },
      streamingSessionStore,
    },
    async ({ asUrl, spotifyManifest }) => {
      for (let pass = 0; pass < 2; pass += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        const started = await startRun(asUrl, spotifyManifest.connector_id);
        const pending = await waitForPendingInteraction(asUrl, started.run_id);
        const mint = await fetchJson(
          `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`,
          {
            body: JSON.stringify({ interaction_id: pending.interaction_id }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        assert.equal(mint.status, 201);
        const unavailable = await fetchJson(
          `${asUrl}/_ref/run-interaction-streams/${encodeURIComponent((mint.body as MintBody).token ?? "")}/neko/session`
        );
        assert.equal(unavailable.status, 401);
        assert.equal((unavailable.body as MintBody).error?.code, "companion_unavailable");
        await cancelRun(asUrl, started.run_id, pending.interaction_id);
      }
      const unavailableRecords = observations.filter(
        (record) => record.event === "stream_neko_proxy_target_unavailable"
      );
      assert.equal(unavailableRecords.length, 2);
      assert.deepEqual(
        unavailableRecords.map((record) => record.browser_session_id),
        ["bs_reused_without_companion", "bs_reused_without_companion"]
      );
    }
  );
});

test("n.eko client config allows allocator-approved dynamic origin without exposing backend URLs", async () => {
  const upstream = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`proxied:${req.method}:${req.url}`);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => resolve());
  });
  const upstreamAddress = upstream.address();
  const upstreamPort = typeof upstreamAddress === "object" && upstreamAddress ? upstreamAddress.port : 0;
  const dynamicOrigin = `http://127.0.0.1:${upstreamPort}/_ref/browser-surfaces/surf_dynamic_1`;

  try {
    await withHarness(
      {
        isNekoProxyTargetApproved(
          target: Record<string, unknown>,
          { session }: { session?: { run_id?: string; interaction_id?: string } }
        ) {
          return (
            session?.run_id &&
            target.origin === dynamicOrigin &&
            target.surface_id === "surf_dynamic_1" &&
            target.lease_id === "lease_dynamic_1" &&
            target.profile_key === "profile_dynamic_1" &&
            target.interaction_id === session.interaction_id
          );
        },
        makeCompanion: ({ browser_session_id, interaction_id }) => ({
          ...makeMockNekoCompanion(dynamicOrigin)({ browser_session_id }),
          getNekoProxyTarget() {
            return {
              interaction_id,
              lease_id: "lease_dynamic_1",
              origin: dynamicOrigin,
              profile_key: "profile_dynamic_1",
              surface_id: "surf_dynamic_1",
            };
          },
        }),
      },
      async ({ asUrl, spotifyManifest }) => {
        const started = await startRun(asUrl, spotifyManifest.connector_id);
        const pending = await waitForPendingInteraction(asUrl, started.run_id);
        const mint = await fetchJson(
          `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`,
          {
            body: JSON.stringify({ interaction_id: pending.interaction_id }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        assert.equal(mint.status, 201);

        const ac = new AbortController();
        const sseResp = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: ac.signal });
        assert.equal(sseResp.status, 200);
        try {
          const clientConfig = await fetchJson(
            `${asUrl}/_ref/run-interaction-streams/${encodeURIComponent((mint.body as MintBody).token ?? "")}/neko/session`
          );
          assert.equal(clientConfig.status, 200, JSON.stringify(clientConfig.body));
          assert.equal((clientConfig.body as MintBody).server_path, "/neko");
          assertNoRawBackendAuthority(clientConfig.body);
          const cookie = clientConfig.headers.get("set-cookie") || "";
          const proxied = await fetch(`${asUrl}/neko/api/room/screen?x=1`, { headers: { cookie } });
          assert.equal(proxied.status, 200);
          assert.equal(await proxied.text(), "proxied:GET:/_ref/browser-surfaces/surf_dynamic_1/api/room/screen?x=1");
        } finally {
          ac.abort();
          await cancelRun(asUrl, started.run_id, pending.interaction_id);
        }
      }
    );
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("n.eko client config rejects allocator-approved dynamic origin for the wrong interaction", async () => {
  const dynamicOrigin = "http://10.88.0.4:6080/neko";
  await withHarness(
    {
      isNekoProxyTargetApproved(
        target: Record<string, unknown>,
        { session }: { session?: { run_id?: string; interaction_id?: string } }
      ) {
        return target.interaction_id === session?.interaction_id;
      },
      makeCompanion: ({ browser_session_id }) => ({
        ...makeMockNekoCompanion(dynamicOrigin)({ browser_session_id }),
        getNekoProxyTarget() {
          return {
            interaction_id: "int_other",
            lease_id: "lease_dynamic_1",
            origin: dynamicOrigin,
            profile_key: "profile_dynamic_1",
            surface_id: "surf_dynamic_1",
          };
        },
      }),
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(mint.status, 201);

      const ac = new AbortController();
      const sseResp = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: ac.signal });
      assert.equal(sseResp.status, 200);
      try {
        const rejected = await fetchJson(
          `${asUrl}/_ref/run-interaction-streams/${encodeURIComponent((mint.body as MintBody).token ?? "")}/neko/session`
        );
        assert.equal(rejected.status, 401);
        assert.equal((rejected.body as MintBody).error?.code, "neko_origin_not_allowed");
      } finally {
        ac.abort();
        await cancelRun(asUrl, started.run_id, pending.interaction_id);
      }
    }
  );
});

test("n.eko client config rejects unapproved dynamic origin", async () => {
  await withHarness(
    {
      isNekoProxyTargetApproved() {
        return false;
      },
      makeCompanion: makeMockNekoCompanion("http://10.88.0.9:6080/neko"),
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(mint.status, 201);

      const ac = new AbortController();
      const sseResp = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: ac.signal });
      assert.equal(sseResp.status, 200);
      try {
        const rejected = await fetchJson(
          `${asUrl}/_ref/run-interaction-streams/${encodeURIComponent((mint.body as MintBody).token ?? "")}/neko/session`
        );
        assert.equal(rejected.status, 401);
        assert.equal((rejected.body as MintBody).error?.code, "neko_origin_not_allowed");
      } finally {
        ac.abort();
        await cancelRun(asUrl, started.run_id, pending.interaction_id);
      }
    }
  );
});

test("n.eko viewport dispatch uses one native coordinate space for video and input", async () => {
  const startedViewports: unknown[] = [];
  const dispatchedEvents: {
    type?: string;
    width?: number;
    height?: number;
    screenWidth?: number;
    screenHeight?: number;
    deviceScaleFactor?: number;
    [key: string]: unknown;
  }[] = [];
  await withHarness(
    {
      makeCompanion: makeMockNekoCompanion("http://127.0.0.1:9", {
        dispatchedEvents,
        startedViewports,
      }),
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({
          interaction_id: pending.interaction_id,
          viewport: {
            deviceScaleFactor: 2.25,
            hasTouch: true,
            height: 819,
            mobile: true,
            screenHeight: 1840,
            screenWidth: 1008,
            width: 448,
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(mint.status, 201);

      const ac = new AbortController();
      const sseResp = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: ac.signal });
      assert.equal(sseResp.status, 200);
      const attachmentCookie = presentationAttachmentCookie(sseResp);
      assert.ok(sseResp.body, "SSE response has a body stream");
      const reader = sseResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      async function readEvent(name: string, deadlineMs = 1500): Promise<Record<string, unknown>> {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
          const block = buffer.indexOf("\n\n");
          if (block !== -1) {
            const event = buffer.slice(0, block);
            buffer = buffer.slice(block + 2);
            if (event.includes(`event: ${name}`)) {
              const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
              assert.ok(dataLine, `SSE event ${name} is missing a data: line`);
              return JSON.parse(dataLine.slice(5).trim());
            }
            continue;
          }
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
        }
        throw new Error(`Did not receive SSE event ${name} in ${deadlineMs}ms`);
      }

      await readEvent("backend_ready");
      // mobile / hasTouch / userAgent are intentionally stripped by
      // viewportForCompanionBackend before reaching the companion's start.
      // The stealth-and-input-bouncing rationale lives in
      // docs/reference/neko-stealth-design-brief.md and the inline comment on
      // normalizeViewportForNeko in server/streaming/routes.js. The
      // assertions below reflect the post-strip contract.
      assert.deepEqual(startedViewports[0], {
        deviceScaleFactor: 1,
        height: 819,
        screenHeight: 819,
        screenWidth: 448,
        width: 448,
      });

      const viewport = await fetchJson(`${asUrl}${(mint.body as MintBody).viewport_path}`, {
        body: JSON.stringify({
          deviceScaleFactor: 2.25,
          hasTouch: true,
          height: 364,
          mobile: true,
          screenHeight: 816,
          screenWidth: 2128,
          width: 947,
        }),
        headers: { "Content-Type": "application/json", Cookie: attachmentCookie },
        method: "POST",
      });
      assert.equal(viewport.status, 202);
      assert.deepEqual((viewport.body as MintBody).viewport, {
        deviceScaleFactor: 1,
        height: 364,
        screenHeight: 364,
        screenWidth: 947,
        width: 947,
      });
      assert.ok(
        dispatchedEvents.some(
          (event) =>
            event.type === "viewport" &&
            event.width === 947 &&
            event.height === 364 &&
            event.screenWidth === 947 &&
            event.screenHeight === 364 &&
            event.deviceScaleFactor === 1
        ),
        "n.eko viewport POST must not dispatch a high-DPR virtual screen that breaks native input hit-testing"
      );

      ac.abort();
      try {
        await reader.cancel();
      } catch {
        /* aborted */
      }
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    }
  );
});

test("n.eko entry can include noauth auto-login query params", async () => {
  await withHarness(
    {
      makeCompanion: makeMockNekoCompanion("http://127.0.0.1:8080"),
      nekoProxyAutoLogin: { password: "1", username: "operator" },
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(mint.status, 201);

      const ac = new AbortController();
      const sseResp = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: ac.signal });
      assert.equal(sseResp.status, 200);
      assert.ok(sseResp.body, "SSE response has a body stream");
      const reader = sseResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      async function readEvent(name: string, deadlineMs = 1500): Promise<Record<string, unknown>> {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
          const block = buffer.indexOf("\n\n");
          if (block !== -1) {
            const event = buffer.slice(0, block);
            buffer = buffer.slice(block + 2);
            if (event.includes(`event: ${name}`)) {
              const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
              assert.ok(dataLine, `SSE event ${name} is missing a data: line`);
              return JSON.parse(dataLine.slice(5).trim());
            }
            continue;
          }
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
        }
        throw new Error(`Did not receive SSE event ${name} in ${deadlineMs}ms`);
      }

      await readEvent("attached");
      const backendReady = await readEvent("backend_ready");
      assert.equal(backendReady.backend, "neko");
      assert.equal(backendReady.browser_owner_mode, "neko-owned");
      assert.equal(backendReady.stealth_mode, "balanced");
      assertNoRawBackendAuthority(backendReady);

      const clientConfig = await fetch(`${asUrl}${backendReady.client_config_path}`);
      assert.equal(clientConfig.status, 200);
      const clientConfigBody = await clientConfig.json();
      assert.deepEqual(clientConfigBody, {
        login: {
          password: "1",
          username: "operator",
        },
        object: "run_interaction_neko_client",
        server_path: "/neko",
        status_path: "/neko/__pdpp/status",
      });
      assertNoRawBackendAuthority(clientConfigBody);

      const entry = await fetch(`${asUrl}${backendReady.iframe_path}`, { redirect: "manual" });
      assert.equal(entry.status, 302);
      const entryLocation = entry.headers.get("location");
      assert.ok(entryLocation, "redirect must carry a location header");
      const entryUrl = new URL(entryLocation, asUrl);
      assert.equal(entryUrl.pathname, "/neko");
      assert.ok(entryUrl.searchParams.get("pdpp_stream"));
      assert.equal(entryUrl.searchParams.get("embed"), "1");
      assert.equal(entryUrl.searchParams.get("usr"), "operator");
      assert.equal(entryUrl.searchParams.get("pwd"), "1");

      ac.abort();
      try {
        await reader.cancel();
      } catch {
        /* aborted */
      }
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    }
  );
});

test("n.eko status diagnostics are scoped to the n.eko stream cookie", async () => {
  await withHarness(
    {
      makeCompanion: makeMockNekoCompanion("http://127.0.0.1:8080", {
        status: { connected: true, url: "https://example.test/login" },
      }),
    },
    async ({ asUrl, spotifyManifest }) => {
      const unauthorized = await fetchJson(`${asUrl}/neko/__pdpp/status`);
      assert.equal(unauthorized.status, 401);

      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(mint.status, 201);

      const ac = new AbortController();
      const sseResp = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: ac.signal });
      assert.equal(sseResp.status, 200);
      assert.ok(sseResp.body, "SSE response has a body stream");
      const reader = sseResp.body.getReader();
      await reader.read();

      const entry = await fetch(
        `${asUrl}/_ref/run-interaction-streams/${encodeURIComponent((mint.body as MintBody).token ?? "")}/neko`,
        {
          redirect: "manual",
        }
      );
      assert.equal(entry.status, 302);
      const cookie = entry.headers.get("set-cookie") || "";
      const status = await fetchJson(`${asUrl}/neko/__pdpp/status`, { headers: { cookie } });
      assert.equal(status.status, 200);
      assert.deepEqual(status.body, {
        control_available: true,
        native_control_available: true,
        object: "run_interaction_neko_status",
        status: { connected: true, url: "https://example.test/login" },
      });

      ac.abort();
      try {
        await reader.cancel();
      } catch {
        /* aborted */
      }
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    }
  );
});

test("n.eko status keeps native control available separate from strict stealth page CDP", async () => {
  await withHarness(
    {
      makeCompanion: makeMockNekoCompanion("http://127.0.0.1:8080", {
        status: {
          page_cdp_available: false,
          page_cdp_skipped: {
            browser_owner_mode: "neko-owned",
            stealth_mode: "strict",
          },
          screen: { height: 720, width: 1280 },
        },
        stealthMode: "strict",
      }),
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(mint.status, 201);

      const ac = new AbortController();
      const sseResp = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: ac.signal });
      assert.equal(sseResp.status, 200);
      assert.ok(sseResp.body, "SSE response has a body stream");
      const reader = sseResp.body.getReader();
      await reader.read();

      const entry = await fetch(
        `${asUrl}/_ref/run-interaction-streams/${encodeURIComponent((mint.body as MintBody).token ?? "")}/neko`,
        {
          redirect: "manual",
        }
      );
      assert.equal(entry.status, 302);
      const cookie = entry.headers.get("set-cookie") || "";
      const status = await fetchJson(`${asUrl}/neko/__pdpp/status`, { headers: { cookie } });
      assert.equal(status.status, 200);
      assert.deepEqual(status.body, {
        control_available: true,
        native_control_available: true,
        object: "run_interaction_neko_status",
        status: {
          page_cdp_available: false,
          page_cdp_skipped: {
            browser_owner_mode: "neko-owned",
            stealth_mode: "strict",
          },
          screen: { height: 720, width: 1280 },
        },
      });

      ac.abort();
      try {
        await reader.cancel();
      } catch {
        /* aborted */
      }
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    }
  );
});

test("input POST dispatches to the companion after attach and rejects bad input", async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest, companions }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      body: JSON.stringify({ interaction_id: pending.interaction_id }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(mint.status, 201);

    // Input without prior attach is refused.
    const earlyInput = await fetchJson(`${asUrl}${(mint.body as MintBody).input_path}`, {
      body: JSON.stringify({ action: "click", type: "mouse", x: 1, y: 1 }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(earlyInput.status, 409);
    assert.equal((earlyInput.body as MintBody).error?.code, "session_not_attached");

    // Attach via SSE.
    const ac = new AbortController();
    const sseResp = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: ac.signal });
    assert.equal(sseResp.status, 200);
    const attachmentCookie = presentationAttachmentCookie(sseResp);
    assert.ok(sseResp.body, "SSE response has a body stream");
    const reader = sseResp.body.getReader();
    // Prime the stream so the server has run companion.start.
    await reader.read();

    const tracked = companions.find((c) => c.run_id === started.run_id);
    assert.ok(tracked);

    const click = await fetchJson(`${asUrl}${(mint.body as MintBody).input_path}`, {
      body: JSON.stringify({ action: "click", type: "mouse", x: 42, y: 13 }),
      headers: { "Content-Type": "application/json", Cookie: attachmentCookie },
      method: "POST",
    });
    assert.equal(click.status, 202);
    const trackedInputs = tracked.companion.inputs as InputEvent[];
    assert.ok(trackedInputs.some((e) => e.type === "mouse" && e.action === "click"));

    const paste = await fetchJson(`${asUrl}${(mint.body as MintBody).input_path}`, {
      body: JSON.stringify({ text: "one-time code 123456", type: "paste" }),
      headers: { "Content-Type": "application/json", Cookie: attachmentCookie },
      method: "POST",
    });
    assert.equal(paste.status, 202);
    assert.ok(
      trackedInputs.some((e) => e.type === "paste" && e.text === "one-time code 123456"),
      "paste POST must dispatch to the companion without special route handling"
    );

    const viewport = await fetchJson(`${asUrl}${(mint.body as MintBody).viewport_path}`, {
      body: JSON.stringify({
        deviceScaleFactor: 3,
        height: 844.8,
        mobile: true,
        screenHeight: 1920.8,
        screenWidth: 1080.2,
        width: 390.9,
      }),
      headers: { "Content-Type": "application/json", Cookie: attachmentCookie },
      method: "POST",
    });
    assert.equal(viewport.status, 202);
    // mobile / hasTouch / userAgent are stripped from BOTH backends (cdp
    // and neko) by viewportForCompanionBackend. The original test
    // asserted mobile:true survived for the cdp backend; that was the
    // bug behind the soft-keyboard flicker and the UA/TLS inconsistency
    // Cloudflare Turnstile was detecting. See
    // docs/reference/neko-stealth-design-brief.md for the full rationale.
    assert.deepEqual((viewport.body as MintBody).viewport, {
      deviceScaleFactor: 3,
      height: 844,
      screenHeight: 1920,
      screenWidth: 1080,
      width: 390,
    });
    assert.ok(
      trackedInputs.some(
        (e) =>
          e.type === "viewport" &&
          e.width === 390 &&
          e.height === 844 &&
          e.screenWidth === 1080 &&
          e.screenHeight === 1920 &&
          e.deviceScaleFactor === 3 &&
          // mobile is stripped — see comment above.
          e.mobile === undefined
      ),
      "viewport POST must dispatch the CSS-pixel viewport to the companion"
    );
    assert.ok(
      tracked.companion.cdpCalls.some(
        (c) =>
          c.method === "Page.startScreencast" &&
          (c.params as { maxWidth?: number; maxHeight?: number } | undefined)?.maxWidth === 390 &&
          (c.params as { maxWidth?: number; maxHeight?: number } | undefined)?.maxHeight === 844
      ),
      "viewport POST must restart screencast with the new viewport bounds"
    );

    const badViewport = await fetchJson(`${asUrl}${(mint.body as MintBody).viewport_path}`, {
      body: JSON.stringify({ height: 844, width: 0 }),
      headers: { "Content-Type": "application/json", Cookie: attachmentCookie },
      method: "POST",
    });
    assert.equal(badViewport.status, 400);
    assert.equal((badViewport.body as MintBody).error?.code, "invalid_request");

    const fractionalViewport = await fetchJson(`${asUrl}${(mint.body as MintBody).viewport_path}`, {
      body: JSON.stringify({ height: 844, width: 0.5 }),
      headers: { "Content-Type": "application/json", Cookie: attachmentCookie },
      method: "POST",
    });
    assert.equal(fractionalViewport.status, 400);
    assert.equal((fractionalViewport.body as MintBody).error?.code, "invalid_request");

    const bad = await fetchJson(`${asUrl}${(mint.body as MintBody).input_path}`, {
      body: JSON.stringify({ action: "spin", type: "mouse", x: 0, y: 0 }),
      headers: { "Content-Type": "application/json", Cookie: attachmentCookie },
      method: "POST",
    });
    assert.equal(bad.status, 400);
    assert.equal((bad.body as MintBody).error?.code, "invalid_input");

    ac.abort();
    try {
      await reader.cancel();
    } catch {
      /* aborted */
    }
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test("SSE delivers multiple frames and acks each, even when ack rejects", async () => {
  // The CDP screencast contract is back-pressured: each frame must be
  // acknowledged before the next is delivered. The route must call
  // companion.ackFrame for every frame and must survive an ack rejection
  // without tearing the SSE response down (the next frame's ack can
  // recover).
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-ref-stream-ack-"));
  const connectorPath = buildManualActionConnector(tmpDir, {});
  const ackCalls: unknown[] = [];
  const ackErrors: Error[] = [];
  const companionRef: { current: MockCompanion | null } = { current: null };
  const failingFactory = ({ browser_session_id }: { browser_session_id: string }): MockCompanion => {
    const base = createMockCompanion({ browser_session_id });
    let frameCount = 0;
    const wrapped: MockCompanion = {
      ...base,
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      async ackFrame(sessionId) {
        ackCalls.push(sessionId);
        frameCount += 1;
        // Make the second ack reject to prove the route is best-effort.
        if (frameCount === 2) {
          const err = new Error("cdp ack boom");
          ackErrors.push(err);
          throw err;
        }
        return base.ackFrame(sessionId);
      },
      cdpCalls: base.cdpCalls,
      inputs: base.inputs,
      pushFrame: base.pushFrame,
    };
    companionRef.current = wrapped;
    return wrapped;
  };
  try {
    const server = await startServer({
      asPort: 0,
      connectorPathResolver: () => connectorPath,
      dbPath: ":memory:",
      quiet: true,
      rsPort: 0,
      streamingCompanionFactory: failingFactory,
    });
    try {
      const asUrl = `http://localhost:${server.asPort}`;
      const spotifyManifest: SpotifyManifest = JSON.parse(
        readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8")
      );
      await registerConnector(asUrl, spotifyManifest);
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(mint.status, 201);

      const ac = new AbortController();
      const sseResp = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: ac.signal });
      assert.equal(sseResp.status, 200);
      assert.ok(sseResp.body, "SSE response has a body stream");
      const reader = sseResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      async function readEvent(name: string, deadlineMs = 1500): Promise<Record<string, unknown>> {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
          const block = buffer.indexOf("\n\n");
          if (block !== -1) {
            const event = buffer.slice(0, block);
            buffer = buffer.slice(block + 2);
            if (event.includes(`event: ${name}`)) {
              const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
              assert.ok(dataLine, `SSE event ${name} is missing a data: line`);
              return JSON.parse(dataLine.slice(5).trim());
            }
            continue;
          }
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
        }
        throw new Error(`Did not receive SSE event ${name} in ${deadlineMs}ms`);
      }
      await readEvent("attached");

      const companion = companionRef.current;
      assert.ok(companion, "companion captured");

      // Push three frames. The route should ack all three, with the second
      // ack rejecting (proving best-effort) and the third still arriving.
      companion.pushFrame({ data: "AA==", sessionId: 11 });
      const f1 = await readEvent("frame");
      assert.equal(f1.session_id, 11);

      companion.pushFrame({ data: "AB==", sessionId: 12 });
      const f2 = await readEvent("frame");
      assert.equal(f2.session_id, 12);

      companion.pushFrame({ data: "AC==", sessionId: 13 });
      const f3 = await readEvent("frame");
      assert.equal(f3.session_id, 13);

      // All three acks must have been attempted, even though the second one
      // rejected. The order matters because ack triggers the next frame.
      const ackDeadline = Date.now() + 500;
      while (Date.now() < ackDeadline && ackCalls.length < 3) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(ackCalls, [11, 12, 13], "route must call ackFrame for every delivered frame");
      assert.equal(ackErrors.length, 1, "second ack rejected — route must remain alive");

      ac.abort();
      try {
        await reader.cancel();
      } catch {
        /* aborted */
      }
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    } finally {
      await closeServer(server);
    }
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("mint fails closed with 503 streaming_companion_unavailable when no companion is configured", async () => {
  // Run the server without a streamingCompanionFactory. The default factory
  // is built from the run-target registry resolver — the resolver itself is
  // always present, but the route layer treats `companionFactory == null` as
  // fail-closed, which only happens when no resolver and no factory injection
  // is wired. Here we inject `null` explicitly to exercise the route's
  // fail-closed branch.
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-ref-stream-unavail-"));
  const connectorPath = buildManualActionConnector(tmpDir, {});
  try {
    const server = await startServer({
      asPort: 0,
      connectorPathResolver: () => connectorPath,
      dbPath: ":memory:",
      quiet: true,
      rsPort: 0,
      streamingCompanionFactory: null,
    });
    try {
      const asUrl = `http://localhost:${server.asPort}`;
      const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
      await registerConnector(asUrl, spotifyManifest);
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(mint.status, 503);
      assert.equal((mint.body as MintBody).error?.code, "streaming_companion_unavailable");
      assert.match((mint.body as MintBody).error?.message ?? "", REGEXP_19);
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    } finally {
      await closeServer(server);
    }
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("input POST with an unknown token returns 401 with a WWW-Authenticate header", async () => {
  // Regression: the 401 path in pdppError() chains `.status(401).header(...)`.
  // Express exposes `res.header()` as an alias of `setHeader`; the transport
  // shim must expose the same so the chain doesn't throw and get converted
  // into a 500 by Fastify (which the user sees as
  // `res.status(...).header is not a function`).
  await withHarness({}, async ({ asUrl }) => {
    const bogus = "not-a-real-token";
    const resp = await fetchJson(`${asUrl}/_ref/run-interaction-streams/${bogus}/input`, {
      body: JSON.stringify({ action: "click", type: "mouse", x: 1, y: 1 }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(resp.status, 401, "unknown token must produce 401, not a transport-level 500");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal((resp.body as MintBody)?.error?.type, "invalid_request_error");
    assert.match(resp.headers.get("www-authenticate") || "", REGEXP_20);
  });
});

test("resolving the interaction invalidates streaming and emits a resolved timeline event", async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      body: JSON.stringify({ interaction_id: pending.interaction_id }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(mint.status, 201);

    // Resolve the interaction → streaming token must be invalidated.
    await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      body: JSON.stringify({ interaction_id: pending.interaction_id, status: "success" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    await waitForRunTerminal(asUrl, started.run_id);

    const reattach = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`);
    assert.ok(reattach.status === 401 || reattach.status === 409 || reattach.status === 410);

    const timeline = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
    const types = (timeline.body as TimelineBody).data.map((e) => e.event_type);
    assert.ok(types.includes("run.stream_session_requested"), "requested event recorded");
    assert.ok(types.includes("run.stream_session_resolved"), "resolved event recorded");

    // Sensitive payload guard: timeline must not carry the streaming token.
    const raw = JSON.stringify(timeline.body);
    assert.ok(!raw.includes((mint.body as MintBody).token ?? ""), "streaming token must never appear in timeline");
  });
});

test("SSE forwards companion out-of-band events as named SSE events", async () => {
  // The cdp adapter exposes `companion.onEvent` for non-frame wire events
  // (URL changes, popup open/close). The SSE route must fan these out as
  // named SSE event types so the viewer's EventSource registers a handler
  // per event name. Existing screencast frames (`event: frame`) must keep
  // flowing.
  await withHarness({}, async ({ asUrl, spotifyManifest, companions }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        viewport: { height: 600, width: 800 },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(mint.status, 201);

    const ac = new AbortController();
    const sseResp = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: ac.signal });
    assert.equal(sseResp.status, 200);
    assert.ok(sseResp.body, "SSE response has a body stream");
    const reader = sseResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    async function readEvent(name: string, deadlineMs = 1500): Promise<Record<string, unknown>> {
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        const block = buffer.indexOf("\n\n");
        if (block !== -1) {
          const event = buffer.slice(0, block);
          buffer = buffer.slice(block + 2);
          if (event.includes(`event: ${name}`)) {
            const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
            assert.ok(dataLine, `SSE event ${name} is missing a data: line`);
            return JSON.parse(dataLine.slice(5).trim());
          }
          continue;
        }
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
      }
      throw new Error(`Did not receive SSE event ${name} in ${deadlineMs}ms`);
    }
    await readEvent("attached");

    const tracked = companions.find((c) => c.run_id === started.run_id);
    assert.ok(tracked);
    assert.equal(typeof tracked.companion.pushEvent, "function", "mock companion exposes pushEvent");

    // url_changed with title.
    tracked.companion.pushEvent({ kind: "url_changed", title: "Sign in", url: "https://example.com/login" });
    const urlEvt = await readEvent("url_changed");
    assert.deepEqual(urlEvt, { title: "Sign in", url: "https://example.com/login" });

    // url_changed without title — title field must be omitted.
    tracked.companion.pushEvent({ kind: "url_changed", url: "https://example.com/dash" });
    const urlEvt2 = await readEvent("url_changed");
    assert.deepEqual(urlEvt2, { url: "https://example.com/dash" });

    // popup_opened.
    tracked.companion.pushEvent({ kind: "popup_opened", targetId: "tg_pop", url: "https://oauth.example.com/" });
    const popOpen = await readEvent("popup_opened");
    assert.deepEqual(popOpen, { targetId: "tg_pop", url: "https://oauth.example.com/" });

    // popup_closed.
    tracked.companion.pushEvent({ kind: "popup_closed", targetId: "tg_pop" });
    const popClose = await readEvent("popup_closed");
    assert.deepEqual(popClose, { targetId: "tg_pop" });

    // Frame stream still works alongside.
    tracked.companion.pushFrame({ data: "AA==", metadata: null, sessionId: 1 });
    const frame = await readEvent("frame");
    assert.equal(frame.session_id, 1);

    ac.abort();
    try {
      await reader.cancel();
    } catch {
      /* aborted */
    }
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test("SSE handler emits keepalive comment pings while idle to prevent timeout", async () => {
  // Fastify keepAliveTimeout defaults to 30 seconds. If no frames flow, the SSE
  // stream would be closed silently. Keepalive comment pings (lines starting with `:`)
  // reset the timer without firing client-side handlers.
  await withHarness({}, async ({ asUrl, spotifyManifest, companions }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        viewport: { height: 600, width: 800 },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(mint.status, 201);

    const ac = new AbortController();
    const sseResp = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: ac.signal });
    assert.equal(sseResp.status, 200);
    assert.ok(sseResp.body, "SSE response has a body stream");
    const reader = sseResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    async function readRawBytes(deadlineMs = 3000) {
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        const { value, done } = await reader.read();
        if (done) {
          return null;
        }
        buffer += decoder.decode(value, { stream: true });
        return buffer; // Return accumulated buffer so far
      }
      return null;
    }

    // Read from the stream for ~1 second to prime the attached event and verify
    // the stream is alive. This doesn't test the keepalive interval directly
    // (which is 15s), but it verifies the stream doesn't crash with keepalive active.
    await readRawBytes(1000);

    // Inject a frame to confirm the handler is still operational.
    const tracked = companions.find((c) => c.run_id === started.run_id);
    assert.ok(tracked, "companion factory captured the streaming session");
    tracked.companion.pushFrame({ data: "TESTFRAME", sessionId: 99 });

    // Read for up to 2 seconds and verify we receive the frame event.
    let foundFrame = false;
    const frameDeadline = Date.now() + 2000;
    while (Date.now() < frameDeadline && !foundFrame) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await readRawBytes(200);
      // Check if the frame event appears in the accumulated buffer.
      if (buffer.includes("event: frame") && buffer.includes('"session_id":99')) {
        foundFrame = true;
      }
    }
    assert.ok(foundFrame, "handler must deliver frames with keepalive mechanism active");

    ac.abort();
    try {
      await reader.cancel();
    } catch {
      /* aborted */
    }

    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

// ── Stream-reach give-up beacon ──────────────────────────────────────────────

function reachFailureUrl(asUrl: string, runId: string): string {
  return `${asUrl}/_ref/runs/${encodeURIComponent(runId)}/run-interaction-stream/reach-failure`;
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function postReachFailure(asUrl: string, runId: string, payload: unknown): Promise<FetchJsonResult> {
  return fetchJson(reachFailureUrl(asUrl, runId), {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

function findReachFailedEvent(timelineBody: Partial<TimelineBody> | null): TimelineEvent | null {
  return (timelineBody?.data || []).find((event) => event.event_type === "run.stream_reach_failed") || null;
}

test("reach-failure beacon emits run.stream_reach_failed with the typed reason and http status", async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const beacon = await postReachFailure(asUrl, started.run_id, {
      http_status: 410,
      interaction_id: pending.interaction_id,
      reason: "companion_unavailable",
    });
    assert.equal(beacon.status, 202);
    assert.equal((beacon.body as MintBody).object, "run_interaction_stream_reach_failure");
    assert.equal((beacon.body as MintBody).reason, "companion_unavailable");
    assert.equal((beacon.body as MintBody).http_status, 410);

    const timeline = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
    const event = findReachFailedEvent(timeline.body as Partial<TimelineBody>);
    assert.ok(event, "run.stream_reach_failed should appear on the run timeline");
    assert.equal(event.interaction_id, pending.interaction_id);
    assert.equal(event.data?.reason, "companion_unavailable");
    assert.equal(event.data?.http_status, 410);
    // A connector run can succeed even when the operator gave up reaching the
    // stream, so the diagnostic must not use a run-terminal failure status.
    assert.notEqual(event.status, "failed");
    assert.notEqual(event.status, "rejected");
    assert.equal(event.status, "stream_reach_failed");
    // No raw backend authority (token, cookie, ws/cdp URL) in the spine data.
    assertNoRawBackendAuthority(event.data);

    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test("reach-failure beacon clamps an out-of-set reason to unknown", async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const beacon = await postReachFailure(asUrl, started.run_id, {
      http_status: 999_999,
      interaction_id: pending.interaction_id,
      reason: "DROP TABLE runs",
    });
    assert.equal(beacon.status, 202);
    assert.equal((beacon.body as MintBody).reason, "unknown");
    // http_status outside 100-599 is dropped to null rather than recorded.
    assert.equal((beacon.body as MintBody).http_status, null);

    const timeline = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
    const event = findReachFailedEvent(timeline.body as Partial<TimelineBody>);
    assert.ok(event, "run.stream_reach_failed should still be emitted");
    assert.equal(event.data?.reason, "unknown");
    assert.equal(event.data?.http_status, null);

    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test("reach-failure beacon is rejected when a different interaction is pending", async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const beacon = await postReachFailure(asUrl, started.run_id, {
      http_status: 401,
      interaction_id: "int_not_the_pending_one",
      reason: "invalid_token",
    });
    assert.equal(beacon.status, 409);
    assert.equal((beacon.body as MintBody).error?.code, "interaction_id_mismatch");

    const timeline = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
    assert.equal(
      findReachFailedEvent(timeline.body as Partial<TimelineBody>),
      null,
      "no event for a mismatched interaction"
    );

    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test("reach-failure beacon requires an interaction_id", async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const beacon = await postReachFailure(asUrl, started.run_id, {
      http_status: 410,
      reason: "session_expired",
    });
    assert.equal(beacon.status, 400);
    assert.equal((beacon.body as MintBody).error?.code, "invalid_request");

    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test("only the controlling SSE attachment may rotate the presentation viewport", async () => {
  const dispatched: InputEvent[] = [];
  await withHarness(
    { makeCompanion: makeMockNekoCompanion("http://127.0.0.1:9", { dispatchedEvents: dispatched }) },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const controllerAbort = new AbortController();
      const controllerStream = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, {
        signal: controllerAbort.signal,
      });
      const controllerCookie = presentationAttachmentCookie(controllerStream);
      const observerAbort = new AbortController();
      const observerStream = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, {
        signal: observerAbort.signal,
      });
      assert.equal(observerStream.status, 200);

      const observerViewport = await fetchJson(`${asUrl}${(mint.body as MintBody).viewport_path}`, {
        body: JSON.stringify({ height: 390, width: 844 }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(observerViewport.status, 409);
      assert.equal((observerViewport.body as MintBody).error?.code, "presentation_attachment_not_controlling");
      assert.equal(dispatched.length, 0);

      const observerInput = await fetchJson(`${asUrl}${(mint.body as MintBody).input_path}`, {
        body: JSON.stringify({ action: "click", type: "mouse", x: 4, y: 5 }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(observerInput.status, 409);
      assert.equal((observerInput.body as MintBody).error?.code, "presentation_attachment_not_controlling");
      assert.equal(dispatched.length, 0);

      const controllingViewport = await fetchJson(`${asUrl}${(mint.body as MintBody).viewport_path}`, {
        body: JSON.stringify({ height: 390, width: 844 }),
        headers: { "Content-Type": "application/json", Cookie: controllerCookie },
        method: "POST",
      });
      assert.equal(controllingViewport.status, 202);
      assert.equal(dispatched.filter((event) => event.type === "viewport").length, 1);

      const controllingInput = await fetchJson(`${asUrl}${(mint.body as MintBody).input_path}`, {
        body: JSON.stringify({ action: "click", type: "mouse", x: 4, y: 5 }),
        headers: { "Content-Type": "application/json", Cookie: controllerCookie },
        method: "POST",
      });
      assert.equal(controllingInput.status, 202);
      assert.equal(dispatched.filter((event) => event.type === "mouse").length, 1);

      controllerAbort.abort();
      observerAbort.abort();
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    }
  );
});

test("two stream sessions in one cookie jar retain session-scoped controller authority", async () => {
  const dispatched: InputEvent[] = [];
  await withHarness(
    { makeCompanion: makeMockNekoCompanion("http://127.0.0.1:9", { dispatchedEvents: dispatched }) },
    async ({ asUrl, server, spotifyManifest }) => {
      const [runA, runB] = await Promise.all([
        server.controller.runNow(spotifyManifest.connector_id, {
          connectorInstanceId: "stream_cookie_session_a",
          manifest: spotifyManifest,
          ownerToken: "owner-token",
          runId: "run_stream_cookie_a",
        }),
        server.controller.runNow(spotifyManifest.connector_id, {
          connectorInstanceId: "stream_cookie_session_b",
          manifest: spotifyManifest,
          ownerToken: "owner-token",
          runId: "run_stream_cookie_b",
        }),
      ]);
      const [pendingA, pendingB] = await Promise.all([
        waitForPendingInteraction(asUrl, runA.run_id),
        waitForPendingInteraction(asUrl, runB.run_id),
      ]);
      const [mintA, mintB] = await Promise.all(
        [runA, runB].map(async (run: RunNowResult, index: number) => {
          const pending = index === 0 ? pendingA : pendingB;
          const minted = await fetchJson(
            `${asUrl}/_ref/runs/${encodeURIComponent(run.run_id)}/run-interaction-stream`,
            {
              body: JSON.stringify({ interaction_id: pending.interaction_id }),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            }
          );
          assert.equal(minted.status, 201);
          return minted.body as MintBody;
        })
      );
      assert.ok(mintA, "expected a mint result for run A");
      assert.ok(mintB, "expected a mint result for run B");

      const controllerAbortA = new AbortController();
      const controllerAbortB = new AbortController();
      const observerAbortA = new AbortController();
      try {
        const [streamA, streamB, observerA] = await Promise.all([
          fetch(`${asUrl}${mintA.viewer_path}`, { signal: controllerAbortA.signal }),
          fetch(`${asUrl}${mintB.viewer_path}`, { signal: controllerAbortB.signal }),
          fetch(`${asUrl}${mintA.viewer_path}`, { signal: observerAbortA.signal }),
        ]);
        assert.equal(streamA.status, 200);
        assert.equal(streamB.status, 200);
        assert.equal(observerA.status, 200);
        const cookieA = presentationAttachmentCookie(streamA);
        const cookieB = presentationAttachmentCookie(streamB);
        assert.notEqual(cookieA.split("=", 1)[0], cookieB.split("=", 1)[0]);

        for (const [path, body] of [
          [mintA.viewport_path, { height: 390, width: 844 }],
          [mintA.input_path, { action: "click", type: "mouse", x: 4, y: 5 }],
        ]) {
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          const crossSession = await fetchJson(`${asUrl}${path}`, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json", Cookie: cookieB },
            method: "POST",
          });
          assert.equal(crossSession.status, 409);
          assert.equal((crossSession.body as MintBody).error?.code, "presentation_attachment_not_controlling");
        }
        assert.equal(dispatched.length, 0, "another session cookie must not dispatch into session A");

        for (const [path, body] of [
          [mintA.viewport_path, { height: 844, width: 390 }],
          [mintA.input_path, { action: "click", type: "mouse", x: 7, y: 8 }],
        ]) {
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          const observerMutation = await fetchJson(`${asUrl}${path}`, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
          assert.equal(observerMutation.status, 409);
          assert.equal((observerMutation.body as MintBody).error?.code, "presentation_attachment_not_controlling");
        }
        assert.equal(dispatched.length, 0, "observer/no-cookie attachments stay read-only");

        const ownMutationCases: [string | undefined, string, Record<string, unknown>][] = [
          [mintA.viewport_path, cookieA, { height: 844, width: 390 }],
          [mintA.input_path, cookieA, { action: "click", type: "mouse", x: 9, y: 10 }],
          [mintB.viewport_path, cookieB, { height: 390, width: 844 }],
          [mintB.input_path, cookieB, { action: "click", type: "mouse", x: 11, y: 12 }],
        ];
        for (const [path, cookie, body] of ownMutationCases) {
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          const ownMutation = await fetchJson(`${asUrl}${path}`, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json", Cookie: cookie },
            method: "POST",
          });
          assert.equal(ownMutation.status, 202);
        }
        assert.deepEqual(
          dispatched.map((event) => event.type),
          ["viewport", "mouse", "viewport", "mouse"],
          "each session controller alone retains input and viewport authority"
        );
      } finally {
        controllerAbortA.abort();
        controllerAbortB.abort();
        observerAbortA.abort();
        await Promise.all([
          cancelRun(asUrl, runA.run_id, pendingA.interaction_id),
          cancelRun(asUrl, runB.run_id, pendingB.interaction_id),
        ]);
      }
    }
  );
});

test("the controlling stream attachment selects phone portrait and landscape screens, acknowledges the window size, and restores the desktop baseline", async () => {
  const screenSelections: unknown[] = [];
  const windowAcknowledgements: { width: number; height: number; [key: string]: unknown }[] = [];
  await withHarness(
    { makeCompanion: makePhonePresentationCompanion({ screenSelections, windowAcknowledgements }) },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const controllerAbort = new AbortController();
      const controllerStream = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, {
        signal: controllerAbort.signal,
      });
      assert.equal(controllerStream.status, 200);
      const controllerCookie = presentationAttachmentCookie(controllerStream);

      const observerAbort = new AbortController();
      const observerStream = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, {
        signal: observerAbort.signal,
      });
      assert.equal(observerStream.status, 200);
      const observerViewport = await fetchJson(`${asUrl}${(mint.body as MintBody).viewport_path}`, {
        body: JSON.stringify({ height: 915, width: 412 }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(observerViewport.status, 409, "a phone-mode selection needs the owner presentation attachment");

      for (const viewport of [
        { height: 915, width: 412 },
        { height: 412, width: 915 },
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        const response = await fetchJson(`${asUrl}${(mint.body as MintBody).viewport_path}`, {
          body: JSON.stringify(viewport),
          headers: { "Content-Type": "application/json", Cookie: controllerCookie },
          method: "POST",
        });
        assert.equal(response.status, 202);
        assert.deepEqual(
          { height: (response.body as MintBody).viewport?.height, width: (response.body as MintBody).viewport?.width },
          viewport
        );
      }

      const resolved = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id, status: "success" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(resolved.status, 202);
      await waitForRunTerminal(asUrl, started.run_id);

      assert.deepEqual(screenSelections, [
        { height: 915, rate: 30, width: 412 },
        { height: 412, rate: 30, width: 915 },
        { height: 900, rate: 30, width: 1440 },
      ]);
      assert.deepEqual(
        windowAcknowledgements.map(({ width, height }) => ({ height, width })),
        [
          { height: 915, width: 412 },
          { height: 412, width: 915 },
        ]
      );

      controllerAbort.abort();
      observerAbort.abort();
    }
  );
});

test("controller-cookie reconnect keeps viewport updates ordered while an observer remains read-only", async () => {
  const dispatchStarted: unknown[] = [];
  const dispatched: InputEvent[] = [];
  let releaseFirstDispatch: () => void = () => {
    throw new Error("releaseFirstDispatch not yet assigned");
  };
  const firstDispatch = new Promise<void>((resolve) => {
    releaseFirstDispatch = resolve;
  });
  await withHarness(
    {
      makeCompanion: ({ browser_session_id }) => ({
        async ackFrame() {
          /* intentionally empty */
        },
        backend: "neko",
        browser_session_id,
        async dispatch(event: InputEvent) {
          if (event.type !== "viewport") {
            return;
          }
          dispatchStarted.push(event);
          if (dispatchStarted.length === 1) {
            await firstDispatch;
          }
          dispatched.push(event);
        },
        getNekoProxyTarget() {
          return { origin: "http://127.0.0.1:9" };
        },
        onEvent() {
          return () => {
            /* intentionally empty */
          };
        },
        onFrame() {
          return () => {
            /* intentionally empty */
          };
        },
        async start() {
          /* intentionally empty */
        },
        async stop() {
          /* intentionally empty */
        },
      }),
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const initialControllerAbort = new AbortController();
      const initialController = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, {
        signal: initialControllerAbort.signal,
      });
      const controllerCookie = presentationAttachmentCookie(initialController);
      initialControllerAbort.abort();

      const controllerAbort = new AbortController();
      const observerAbort = new AbortController();
      // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
      // biome-ignore lint/suspicious/noImplicitAnyLet: Fixture accumulator is intentionally inferred from runtime test data.
      let portrait;
      // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
      // biome-ignore lint/suspicious/noImplicitAnyLet: Fixture accumulator is intentionally inferred from runtime test data.
      let landscape;
      try {
        const controllerReconnect = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, {
          headers: { Cookie: controllerCookie },
          signal: controllerAbort.signal,
        });
        assert.equal(controllerReconnect.status, 200);
        const observerStream = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, {
          signal: observerAbort.signal,
        });
        assert.equal(observerStream.status, 200);

        const observerViewport = await fetchJson(`${asUrl}${(mint.body as MintBody).viewport_path}`, {
          body: JSON.stringify({ height: 390, width: 844 }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(observerViewport.status, 409);
        assert.equal((observerViewport.body as MintBody).error?.code, "presentation_attachment_not_controlling");

        portrait = fetchJson(`${asUrl}${(mint.body as MintBody).viewport_path}`, {
          body: JSON.stringify({ height: 844, width: 390 }),
          headers: { "Content-Type": "application/json", Cookie: controllerCookie },
          method: "POST",
        });
        await waitForCondition(
          () => dispatchStarted.length === 1,
          "first controller viewport must reach the companion"
        );

        landscape = fetchJson(`${asUrl}${(mint.body as MintBody).viewport_path}`, {
          body: JSON.stringify({ height: 390, width: 844 }),
          headers: { "Content-Type": "application/json", Cookie: controllerCookie },
          method: "POST",
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(
          dispatchStarted.length,
          1,
          "later controller viewport must not interleave before the first dispatch"
        );
      } finally {
        releaseFirstDispatch();
        await Promise.allSettled([portrait, landscape]);
        controllerAbort.abort();
        observerAbort.abort();
      }

      const [portraitAck, landscapeAck] = await Promise.all([portrait, landscape]);
      assert.equal(portraitAck.status, 202);
      assert.equal(landscapeAck.status, 202);
      assert.deepEqual(
        dispatched.map((event) => [event.width, event.height]),
        [
          [390, 844],
          [844, 390],
        ]
      );
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    }
  );
});

test("interaction response waits for presentation restoration before connector resume", async () => {
  let releaseStop: () => void = () => {
    throw new Error("releaseStop not yet assigned");
  };
  let stopStarted = false;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  await withHarness(
    {
      makeCompanion: ({ browser_session_id }) => ({
        async ackFrame() {
          /* intentionally empty */
        },
        backend: "neko",
        browser_session_id,
        async dispatch() {
          /* intentionally empty */
        },
        getNekoProxyTarget() {
          return { origin: "http://127.0.0.1:9" };
        },
        onEvent() {
          return () => {
            /* intentionally empty */
          };
        },
        onFrame() {
          return () => {
            /* intentionally empty */
          };
        },
        async start() {
          /* intentionally empty */
        },
        async stop() {
          stopStarted = true;
          await stopGate;
        },
      }),
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const abort = new AbortController();
      const stream = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: abort.signal });
      assert.equal(stream.status, 200);

      let settled = false;
      const response = fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id, status: "success" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).finally(() => {
        settled = true;
      });
      for (let attempt = 0; attempt < 20 && !stopStarted; attempt += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(stopStarted, true);
      assert.equal(settled, false, "HTTP acknowledgement must not precede presentation restore");
      releaseStop();
      const acknowledged = await response;
      assert.equal(acknowledged.status, 202);
      await waitForRunTerminal(asUrl, started.run_id);
      abort.abort();
    }
  );
});

test("interaction timeout waits for presentation restoration before the runtime commits its terminal response", async () => {
  let releaseStop: () => void = () => {
    throw new Error("releaseStop not yet assigned");
  };
  let stopStarted = false;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  await withHarness(
    {
      makeCompanion: ({ browser_session_id }) => ({
        async ackFrame() {
          /* intentionally empty */
        },
        backend: "neko",
        browser_session_id,
        async dispatch() {
          /* intentionally empty */
        },
        getNekoProxyTarget() {
          return { origin: "http://127.0.0.1:9" };
        },
        onEvent() {
          return () => {
            /* intentionally empty */
          };
        },
        onFrame() {
          return () => {
            /* intentionally empty */
          };
        },
        async start() {
          /* intentionally empty */
        },
        async stop() {
          stopStarted = true;
          await stopGate;
        },
      }),
      timeoutSeconds: 1,
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const abort = new AbortController();
      const stream = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: abort.signal });
      assert.equal(stream.status, 200);

      for (let attempt = 0; attempt < 240 && !stopStarted; attempt += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(stopStarted, true);
      const beforeRestore = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
      assert.equal(
        (beforeRestore.body as TimelineBody).data.some((event) => event.event_type === "run.interaction_completed"),
        false
      );
      releaseStop();
      const terminal = await waitForRunTerminal(asUrl, started.run_id);
      assert.equal(
        terminal.data.some((event) => event.event_type === "run.interaction_completed"),
        true
      );
      abort.abort();
    }
  );
});

test("restore failure cancels the run instead of resuming against the mutated presentation", async () => {
  await withHarness(
    {
      makeCompanion: ({ browser_session_id }) => ({
        async ackFrame() {
          /* intentionally empty */
        },
        backend: "neko",
        browser_session_id,
        async dispatch() {
          /* intentionally empty */
        },
        getNekoProxyTarget() {
          return { origin: "http://127.0.0.1:9" };
        },
        onEvent() {
          return () => {
            /* intentionally empty */
          };
        },
        onFrame() {
          return () => {
            /* intentionally empty */
          };
        },
        async start() {
          /* intentionally empty */
        },
        // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
        async stop() {
          const err: Error & { code?: string } = new Error("restore rejected");
          err.code = "neko_screen_restore_failed";
          throw err;
        },
      }),
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const abort = new AbortController();
      const stream = await fetch(`${asUrl}${(mint.body as MintBody).viewer_path}`, { signal: abort.signal });
      assert.equal(stream.status, 200);

      const rejected = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id, status: "success" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(rejected.status, 500);
      const timeline = await waitForRunTerminal(asUrl, started.run_id);
      assert.equal(
        timeline.data.some((event) => event.event_type === "run.completed"),
        false
      );
      assert.equal(
        timeline.data.some((event) => event.event_type === "run.cancelled"),
        true
      );
      abort.abort();
    }
  );
});

test("boot recycles captured and unrestored presentation surfaces before they can be reused", async () => {
  const state = {
    async captureBaseline() {
      /* intentionally empty */
    },
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async listUnrestored() {
      return [
        {
          baseline: { height: 720, rate: 30, width: 1280 },
          browserSessionId: "bs_before_crash",
          capturedAt: "2026-05-12T12:00:00.000Z",
          leaseId: null,
          surfaceId: "surface_dynamic_1",
        },
      ];
    },
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async markRecycled(browserSessionId: string) {
      this.recycled.push(browserSessionId);
    },
    async markRestored() {
      /* intentionally empty */
    },
    recycled: [] as string[],
  };
  const manager = makeLeaseManager();
  const server = await startServer({
    asPort: 0,
    browserSurfaceLeaseManager: manager,
    dbPath: ":memory:",
    presentationScreenStateStore: state,
    quiet: true,
    rsPort: 0,
  });
  try {
    assert.deepEqual(state.recycled, ["bs_before_crash"]);
    const removedSurface = manager.getSurface("surface_dynamic_1");
    assert.equal(removedSurface === null || removedSurface === undefined, true);
  } finally {
    await closeServer(server);
  }
});

test("late success waits for presentation restore after the bearer session expires", async () => {
  const gate = makeRestoreGate();
  await withExpiredPresentation(
    { makeCompanion: makeGatedNekoCompanion(gate.stop) },
    async ({ abort, asUrl, pending, started }) => {
      let settled = false;
      const response = fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id, status: "success" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).finally(() => {
        settled = true;
      });
      try {
        await waitForCondition(gate.started, "late success must stop the presentation after bearer expiry");
        assert.equal(settled, false, "late success must wait for presentation restoration");
      } finally {
        gate.release();
        await response;
      }
      const acknowledged = await response;
      assert.equal(acknowledged.status, 202);
      abort.abort();
    }
  );
});

test("late cancelled response waits for presentation restore after the bearer session expires", async () => {
  const gate = makeRestoreGate();
  await withExpiredPresentation(
    { makeCompanion: makeGatedNekoCompanion(gate.stop) },
    async ({ abort, asUrl, pending, started }) => {
      let settled = false;
      const response = fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id, status: "cancelled" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).finally(() => {
        settled = true;
      });
      try {
        await waitForCondition(gate.started, "late cancellation must stop the presentation after bearer expiry");
        assert.equal(settled, false, "late cancellation must wait for presentation restoration");
      } finally {
        gate.release();
        await response;
      }
      const acknowledged = await response;
      assert.equal(acknowledged.status, 202);
      abort.abort();
    }
  );
});

test("interaction timeout waits for presentation restore after the bearer session expires", async () => {
  const gate = makeRestoreGate();
  await withExpiredPresentation(
    {
      makeCompanion: makeGatedNekoCompanion(gate.stop),
      timeoutSeconds: 1,
    },
    async ({ abort, asUrl, started }) => {
      try {
        await waitForCondition(gate.started, "timeout must stop the presentation after bearer expiry", 300);
        const timeline = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
        assert.equal(
          (timeline.body as TimelineBody).data.some((event) => event.event_type === "run.interaction_completed"),
          false
        );
      } finally {
        gate.release();
      }
      await waitForRunTerminal(asUrl, started.run_id);
      // The timeout terminal event precedes the connector-child reap by one
      // event-loop turn. Let the harness retire that child before its next
      // isolated server reuses the in-memory controller state.
      await new Promise((resolve) => setTimeout(resolve, 25));
      abort.abort();
    }
  );
});

test("bearer expiry is a presentation lifecycle event rather than an auth-record purge", async () => {
  const gate = makeRestoreGate();
  await withExpiredPresentation({ makeCompanion: makeGatedNekoCompanion(gate.stop) }, async ({ abort, timers }) => {
    let settled = false;
    const expiry = timers.runDue().finally(() => {
      settled = true;
    });
    try {
      await waitForCondition(gate.started, "expiry must enter the same presentation terminalizer");
      assert.equal(settled, false, "expiry must await presentation restoration");
    } finally {
      gate.release();
    }
    await expiry;
    abort.abort();
  });
});

test("restore failure after bearer expiry cancels instead of resuming on presentation geometry", async () => {
  await withExpiredPresentation(
    {
      makeCompanion: ({ browser_session_id }) => ({
        async ackFrame() {
          /* intentionally empty */
        },
        backend: "neko",
        browser_session_id,
        async dispatch() {
          /* intentionally empty */
        },
        getNekoProxyTarget() {
          return { origin: "http://127.0.0.1:9" };
        },
        onEvent() {
          return () => {
            /* intentionally empty */
          };
        },
        onFrame() {
          return () => {
            /* intentionally empty */
          };
        },
        async start() {
          /* intentionally empty */
        },
        // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
        async stop() {
          const err: Error & { code?: string } = new Error("restore rejected");
          err.code = "neko_screen_restore_failed";
          throw err;
        },
      }),
    },
    async ({ abort, asUrl, pending, started }) => {
      const rejected = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
        body: JSON.stringify({ interaction_id: pending.interaction_id, status: "success" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(rejected.status, 500);
      const timeline = await waitForRunTerminal(asUrl, started.run_id);
      assert.equal(
        timeline.data.some((event) => event.event_type === "run.completed"),
        false
      );
      assert.equal(
        timeline.data.some((event) => event.event_type === "run.cancelled"),
        true
      );
      abort.abort();
    }
  );
});

test("POST cancel waits for presentation restore after the bearer session expires", async () => {
  const gate = makeRestoreGate();
  await withExpiredPresentation(
    { makeCompanion: makeGatedNekoCompanion(gate.stop) },
    async ({ abort, asUrl, started }) => {
      // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
      // biome-ignore lint/suspicious/noImplicitAnyLet: Fixture accumulator is intentionally inferred from runtime test data.
      let cancellation;
      let settled = false;
      try {
        cancellation = fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/cancel`, {
          method: "POST",
        }).finally(() => {
          settled = true;
        });
        await waitForCondition(gate.started, "run cancellation must stop the presentation after bearer expiry");
        assert.equal(settled, false, "POST cancel must await presentation restoration");
      } finally {
        gate.release();
      }
      const acknowledged = await cancellation;
      assert.equal(acknowledged.status, 202);
      abort.abort();
    }
  );
});
