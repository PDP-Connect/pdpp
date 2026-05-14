/**
 * One runtime for every connector.
 *
 * The protocol — START → RECORD/STATE/SKIP_RESULT/PROGRESS → DONE — is
 * framework, not business logic. A connector should express WHAT it
 * collects, not HOW the protocol handshake works. This module owns the
 * handshake; connectors own the collection.
 *
 *   import { runConnector } from '../../src/connector-runtime.js';
 *   import { validateRecord } from './schemas.js';
 *
 *   runConnector({
 *     name: 'notion',
 *     validateRecord,
 *     async collect({ scope, state, emit, emitRecord, progress }) {
 *       // pure business logic
 *     },
 *   });
 *
 * For browser-based connectors, add `browser: { profileName, headless }`
 * and the runtime acquires an isolated Playwright context, passing `page`
 * and `context` into collect(). Optional `ensureSession` and `probeSession`
 * callbacks automate re-auth on session expiry.
 *
 * What the runtime owns (connector never writes this code again):
 *   - Reading START from stdin, validating shape
 *   - Building scope.streams into a Map + resourceSet filters
 *   - Zod shape-check via validateRecord; SKIP_RESULT on drift
 *   - Scope time_range filter on records with a configurable date field
 *   - Counters (emitted + skipped)
 *   - Browser acquire + release + finally cleanup
 *   - Playwright tracing lifecycle (PDPP_TRACE=1)
 *   - Fixture capture lifecycle (PDPP_CAPTURE_FIXTURES=1)
 *   - Terminal DONE + flushAndExit on both success and throw
 *   - Retryable-error detection via retryablePattern regex
 *   - Auth strategy resolution before collect() runs
 */

import { createInterface } from "node:readline";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";

import { type AuthConfig, resolveAuth } from "./auth.ts";
import { type CaptureSession, createCaptureSession } from "./fixture-capture.ts";
import { emitToStdout } from "./safe-emit.ts";
import { resourceSet } from "./scope-filters.ts";

// ─── Protocol message shapes ────────────────────────────────────────────

/** A single record passing through emit / emitRecord. */
export interface RecordData {
  id?: string | number | null;
  [field: string]: unknown;
}

export interface StreamScope {
  name: string;
  resources?: readonly string[];
  time_range?: {
    since?: string;
    until?: string;
  };
  [extra: string]: unknown;
}

export interface StartMessage {
  detail_gaps?: readonly DetailGapStartEntry[];
  scope: { streams: readonly StreamScope[] };
  state?: Record<string, unknown>;
  type: "START";
}

export interface DetailGapStartEntry {
  detail_locator?: {
    kind?: string;
    [field: string]: unknown;
  } | null;
  gap_id: string;
  record_key?: string | number | null;
  reference_only?: true;
  status: "pending";
  stream: string;
}

export interface InteractionResponse {
  data?: Record<string, string>;
  error?: { message: string };
  request_id: string;
  status: "success" | "cancelled" | "error";
  type: "INTERACTION_RESPONSE";
  value?: string;
}

export type InteractionKind = "credentials" | "otp" | "manual_action";

export type AssistanceProgressPosture = "running" | "blocked" | "waiting_retry";
export type AssistanceOwnerAction = "none" | "act_elsewhere" | "provide_value" | "operate_attachment";
export type AssistanceResponseContract = "none";
export type AssistanceSensitivity = "none" | "non_secret" | "secret";
export type AssistanceAttachmentKind = "browser_surface" | "url" | "qr" | "file" | "fixture";
export type AssistanceCompletionStatus = "cancelled" | "escalated" | "resolved" | "timed_out";

export interface AssistanceAttachment {
  kind: AssistanceAttachmentKind;
  label?: string;
  ref?: string;
  role?: string;
}

export interface AssistanceRequest {
  assistance_request_id?: string;
  attachments?: AssistanceAttachment[];
  input_schema?: Record<string, unknown>;
  message: string;
  owner_action: AssistanceOwnerAction;
  progress_posture: AssistanceProgressPosture;
  response_contract: AssistanceResponseContract;
  sensitivity?: AssistanceSensitivity;
  timeout_seconds?: number;
}

export interface AssistanceCompletion {
  assistance_request_id: string;
  message?: string;
  status: AssistanceCompletionStatus;
}

export interface DetailGapMessage {
  detail?: {
    class?: string;
    http_status?: number;
    network_pressure?: {
      attempt?: number;
      endpoint_route: string;
      error_class: string;
      max_attempts?: number;
      method: string;
      retry_after_ms?: number;
      safe_headers?: Record<string, string | number>;
      status?: number;
    };
  };
  detail_locator: {
    kind: string;
    [field: string]: string | number | boolean | null | Record<string, string | number | boolean | null>;
  };
  last_error?: {
    class?: string;
    http_status?: number;
    message?: string;
    network_pressure?: {
      attempt?: number;
      endpoint_route: string;
      error_class: string;
      max_attempts?: number;
      method: string;
      retry_after_ms?: number;
      safe_headers?: Record<string, string | number>;
      status?: number;
    };
  };
  list_cursor?: unknown;
  parent_stream?: string;
  reason: "rate_limited" | "retry_exhausted" | "temporary_unavailable" | "upstream_pressure";
  record_key: string | number;
  reference_only: true;
  retryable: true;
  status: "pending";
  stream: string;
  type: "DETAIL_GAP";
}

export interface DetailCoverageMessage {
  gap_keys?: Array<string | number>;
  hydrated_keys: Array<string | number>;
  optional_skip_keys?: Array<string | number>;
  reference_only: true;
  required_keys: Array<string | number>;
  state_stream: string;
  stream: string;
  type: "DETAIL_COVERAGE";
}

export interface DetailGapRecoveredMessage {
  gap_id: string;
  record_key?: string | number;
  reference_only: true;
  stream: string;
  type: "DETAIL_GAP_RECOVERED";
}

/** All messages a connector emits over stdout. */
export type EmittedMessage =
  | {
      type: "RECORD";
      stream: string;
      key: string | number;
      data: RecordData;
      emitted_at: string;
      op?: "delete";
    }
  | { type: "STATE"; stream: string; cursor: unknown }
  | { type: "PROGRESS"; message: string; stream?: string }
  | ({ type: "ASSISTANCE" } & AssistanceRequest)
  | ({ type: "ASSISTANCE_STATUS" } & AssistanceCompletion)
  | {
      type: "SKIP_RESULT";
      stream: string;
      reason: string;
      message: string;
      diagnostics?: unknown;
    }
  | DetailGapMessage
  | DetailCoverageMessage
  | DetailGapRecoveredMessage
  | {
      type: "DONE";
      status: "succeeded" | "failed";
      records_emitted: number;
      error?: { message: string; retryable: boolean };
    }
  | {
      type: "INTERACTION";
      request_id: string;
      kind: InteractionKind;
      message: string;
      schema?: Record<string, unknown>;
      timeout_seconds?: number;
    };

/** Body shape passed to sendInteraction (type + request_id are filled by the runtime). */
export interface InteractionRequest {
  kind: InteractionKind;
  message: string;
  request_id?: string;
  schema?: Record<string, unknown>;
  timeout_seconds?: number;
}

// ─── Shape-check validator ──────────────────────────────────────────────

export type ValidateRecord = (
  stream: string,
  data: RecordData
) => { ok: true; data: RecordData } | { ok: false; issues: Array<{ path: string; message: string }> };

// ─── Collect context ────────────────────────────────────────────────────

type Credentials = Record<string, string>;

interface BaseCollectContext {
  assist: (req: AssistanceRequest) => Promise<string>;
  capture: CaptureSession | null;
  completeAssistance: (
    assistanceRequestId: string,
    status: AssistanceCompletionStatus,
    extra?: { message?: string }
  ) => Promise<void>;
  credentials: Credentials;
  detailGaps: readonly DetailGapStartEntry[];
  emit: (msg: EmittedMessage) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  emittedAt: string;
  progress: (message: string, extra?: { stream?: string }) => Promise<void>;
  requested: Map<string, StreamScope>;
  scope: StartMessage["scope"];
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
  state: Record<string, unknown>;
}

export interface CollectContext extends BaseCollectContext {}

export interface BrowserCollectContext extends BaseCollectContext {
  context: BrowserContext;
  page: Page;
}

// ─── Config ─────────────────────────────────────────────────────────────

export interface BrowserConfig {
  headless?: boolean;
  profileName?: string;
}

export interface BrowserRuntimeVisibility {
  readonly envKey: string;
  readonly headless: boolean;
  readonly profileName: string;
}

export type BrowserLaunchSource =
  | {
      readonly kind: "managed_neko";
      readonly leaseId?: string;
      readonly profileKey?: string;
      readonly remoteCdpUrl: string;
    }
  | {
      readonly envKey: string;
      readonly kind: "legacy_remote_cdp";
      readonly remoteCdpUrl: string;
    }
  | { readonly kind: "isolated_local" };

export interface EnsureSessionArgs {
  assist: BaseCollectContext["assist"];
  capture: CaptureSession | null;
  completeAssistance: BaseCollectContext["completeAssistance"];
  context: BrowserContext;
  page: Page;
  progress: BaseCollectContext["progress"];
  sendInteraction: BaseCollectContext["sendInteraction"];
}

export interface ProbeSessionArgs {
  context: BrowserContext;
  page: Page;
}

/** Fields shared by browser and non-browser configs. */
interface BaseRunConnectorConfig {
  auth?: AuthConfig;
  /** Marks a record as a tombstone; runtime strips to { id } + op:'delete'. */
  isTombstone?: (stream: string, data: RecordData) => boolean;
  name: string;
  retryablePattern?: RegExp;
  /** Record field that scope.time_range filters on. Default 'date'. */
  timeRangeField?: string | ((stream: string) => string);
  validateRecord?: ValidateRecord;
}

/** Config for a non-browser connector (API, file-based). */
export interface NonBrowserConnectorConfig extends BaseRunConnectorConfig {
  browser?: undefined;
  collect: (ctx: CollectContext) => Promise<void>;
}

/** Config for a browser-driven connector. */
export interface BrowserConnectorConfig extends BaseRunConnectorConfig {
  browser: BrowserConfig;
  collect: (ctx: BrowserCollectContext) => Promise<void>;
  ensureSession?: (args: EnsureSessionArgs) => Promise<void>;
  probeSession?: (args: ProbeSessionArgs) => Promise<boolean>;
}

/**
 * Discriminated on `browser`: if it's set, `collect` gets page + context;
 * otherwise it doesn't. TS narrows the right way at each call site so
 * destructuring `{ page }` in a browser connector's collect() is type-safe.
 */
export type RunConnectorConfig = NonBrowserConnectorConfig | BrowserConnectorConfig;

// ─── Primitive helpers (exported for connector convenience) ─────────────

const DEFAULT_RETRYABLE_PATTERN = /ECONN|ETIMEDOUT|timeout/i;
const TRACE_TIMESTAMP_UNSAFE = /[:.]/g;

/**
 * A failure that the runtime should convert to a terminal DONE rather than
 * let it bubble as an unhandled rejection. Carries an explicit `retryable`
 * bit so the outer catch doesn't have to heuristically pattern-match the
 * message.
 */
class TerminalError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "TerminalError";
    this.retryable = retryable;
  }
}

/** Returns true if the scope's time_range excludes this record's date value. */
function isOutsideTimeRange(timeRange: { since?: string; until?: string }, dateValue: unknown): boolean {
  if (typeof dateValue !== "string" || !dateValue) {
    return false;
  }
  if (timeRange.since && dateValue < timeRange.since.slice(0, 10)) {
    return true;
  }
  if (timeRange.until && dateValue >= timeRange.until.slice(0, 10)) {
    return true;
  }
  return false;
}

/** Build a SKIP_RESULT for a shape-check failure. */
function makeShapeCheckSkip(
  stream: string,
  data: RecordData,
  issues: ReadonlyArray<{ path: string; message: string }>
): Extract<EmittedMessage, { type: "SKIP_RESULT" }> {
  const message = `${String(data.id)}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`;
  return {
    type: "SKIP_RESULT",
    stream,
    reason: "shape_check_failed",
    message,
    diagnostics: { id: data.id, issues, record: data },
  };
}

export const nowIso = (): string => new Date().toISOString();

/**
 * Intentional pacing delay for anti-bot throttling between requests.
 * Distinct from Playwright's sync primitives (waitForSelector, waitForURL)
 * which wait for a page condition. This one is "slow us down so we look
 * human", not "wait until X is ready". See authoring guide §7.
 */
export const politeDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Runtime entry point ────────────────────────────────────────────────

/**
 * Run a connector end-to-end. The only entry point connectors should use.
 */
export function runConnector(config: RunConnectorConfig): void {
  if (!config.name) {
    throw new Error("runConnector: config.name required");
  }
  if (typeof config.collect !== "function") {
    throw new Error("runConnector: config.collect required");
  }

  const {
    name,
    validateRecord,
    collect,
    browser,
    retryablePattern = DEFAULT_RETRYABLE_PATTERN,
    timeRangeField = "date",
    isTombstone,
    auth,
  } = config;
  // ensureSession/probeSession are only on BrowserConnectorConfig; extract
  // after the browser-narrowing check.
  const ensureSession = browser ? config.ensureSession : undefined;
  const probeSession = browser ? config.probeSession : undefined;

  const timeRangeFieldFor: (stream: string) => string =
    typeof timeRangeField === "function" ? timeRangeField : (): string => timeRangeField;

  // Capture session: null unless PDPP_CAPTURE_FIXTURES=1.
  const capture = createCaptureSession(name);

  // stdin reader for START + INTERACTION_RESPONSE.
  const rl = createInterface({ input: process.stdin, terminal: false });

  // Wraps stdout write with backpressure. RECORD messages auto-captured.
  const emit = (msg: EmittedMessage): Promise<void> => {
    if (capture && msg.type === "RECORD") {
      capture.recordRecord(msg);
    }
    return emitToStdout(msg);
  };

  if (capture) {
    process.stderr.write(`[capture] PDPP_CAPTURE_FIXTURES=1; writing to ${capture.baseDir}\n`);
  }

  const flushAndExit = (code: number): void => {
    if (process.stdout.writableLength > 0) {
      process.stdout.once("drain", () => process.exit(code));
      setTimeout(() => process.exit(code), 3000).unref();
    } else {
      process.exit(code);
    }
  };

  let observedCounters: { totalEmitted: number; totalSkipped: number } | null = null;

  const emitFailed = (
    message: string,
    retryable = false,
    records_emitted = observedCounters?.totalEmitted ?? 0
  ): void => {
    // Fire-and-forget. emit() resolves after stdout drains; we're about to
    // exit(1) anyway, so we don't need to block. If it rejects (the write
    // fails), the process is dying either way.
    emit({
      type: "DONE",
      status: "failed",
      records_emitted,
      error: { message, retryable },
    }).catch((): undefined => undefined);
    flushAndExit(1);
  };

  let interactionCounter = 0;
  const nextInteractionId = (): string => `int_${Date.now()}_${++interactionCounter}`;
  let assistanceCounter = 0;
  const nextAssistanceId = (): string => `asst_${Date.now()}_${++assistanceCounter}`;

  const sendInteraction = (req: InteractionRequest): Promise<InteractionResponse> => {
    const request_id = req.request_id ?? nextInteractionId();
    const wrapped: EmittedMessage = {
      type: "INTERACTION",
      request_id,
      kind: req.kind,
      message: req.message,
      ...(req.schema === undefined ? {} : { schema: req.schema }),
      ...(req.timeout_seconds === undefined ? {} : { timeout_seconds: req.timeout_seconds }),
    };
    // Fire the INTERACTION; response arrives separately on stdin.
    emit(wrapped).catch((): undefined => undefined);
    return new Promise((resolve, reject) => {
      const onLine = (line: string): void => {
        try {
          const parsed = JSON.parse(line) as InteractionResponse;
          if (parsed.type === "INTERACTION_RESPONSE" && parsed.request_id === request_id) {
            rl.off("line", onLine);
            resolve(parsed);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      rl.on("line", onLine);
    });
  };

  const readStart = (): Promise<StartMessage> =>
    new Promise((resolve, reject) => {
      rl.once("line", (line: string) => {
        try {
          resolve(JSON.parse(line) as StartMessage);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

  const progress = (message: string, extra: { stream?: string } = {}): Promise<void> =>
    emit({ type: "PROGRESS", message, ...extra });
  const assist = async (req: AssistanceRequest): Promise<string> => {
    const assistance_request_id = req.assistance_request_id ?? nextAssistanceId();
    await emit({ type: "ASSISTANCE", ...req, assistance_request_id });
    return assistance_request_id;
  };
  const completeAssistance: BaseCollectContext["completeAssistance"] = (assistanceRequestId, status, extra = {}) =>
    emit({ type: "ASSISTANCE_STATUS", assistance_request_id: assistanceRequestId, status, ...extra });

  // Kick off the run. The outer catch distinguishes TerminalError (which
  // the runtime threw deliberately with an explicit retryable bit) from
  // unexpected throws (where we pattern-match the message).
  run().catch((err: unknown) => {
    if (err instanceof TerminalError) {
      emitFailed(err.message, err.retryable);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    emitFailed(message, retryablePattern.test(message));
  });

  async function run(): Promise<void> {
    const startMsg = await parseStart(readStart);
    const requested = buildRequested(startMsg);
    const credentials = await resolveCredentials(auth, {
      sendInteraction,
      connectorName: name,
    });

    const emitRecord = makeEmitRecord({
      requested,
      emit,
      emittedAt: nowIso(),
      validateRecord,
      isTombstone,
      timeRangeFieldFor,
    });
    observedCounters = emitRecord.counters;
    const emittedAt = nowIso();

    const baseCtx: BaseCollectContext = {
      scope: startMsg.scope,
      state: startMsg.state ?? {},
      requested,
      credentials,
      emit,
      emitRecord: emitRecord.emit,
      assist,
      completeAssistance,
      progress,
      capture,
      sendInteraction,
      emittedAt,
      detailGaps: startMsg.detail_gaps ?? [],
    };

    if (browser) {
      await runInBrowser({
        browser,
        name,
        emit,
        sendInteraction,
        assist,
        completeAssistance,
        progress,
        ensureSession,
        probeSession,
        collect,
        baseCtx,
      });
    } else {
      await collect(baseCtx);
    }

    await finalizeRun(emitRecord.counters, progress, emit);
    flushAndExit(0);
  }
}

// ─── run() helpers (top-level so each is independently readable) ───────

/**
 * Read the first line of stdin and parse it as a START message. Throws
 * TerminalError on malformed input or wrong type — the runtime can't
 * proceed without a valid START.
 */
async function parseStart(readStart: () => Promise<StartMessage>): Promise<StartMessage> {
  const startMsg = await readStart();
  if (startMsg.type !== "START") {
    throw new TerminalError("Expected START message", false);
  }
  return startMsg;
}

/** Build the requested-streams map; the runtime requires at least one stream. */
function buildRequested(startMsg: StartMessage): Map<string, StreamScope> {
  const requested = new Map<string, StreamScope>((startMsg.scope.streams ?? []).map((s) => [s.name, s]));
  if (requested.size === 0) {
    throw new TerminalError("START.scope.streams is required", false);
  }
  return requested;
}

/** Resolve credentials via the configured auth strategy. */
async function resolveCredentials(
  auth: AuthConfig | undefined,
  ctx: {
    sendInteraction: BaseCollectContext["sendInteraction"];
    connectorName: string;
  }
): Promise<Credentials> {
  if (!auth) {
    return {};
  }
  try {
    return await resolveAuth(auth, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TerminalError(message, false);
  }
}

/** Factory: returns the emitRecord closure + a live-updating counters object. */
function makeEmitRecord(deps: {
  requested: Map<string, StreamScope>;
  emit: (msg: EmittedMessage) => Promise<void>;
  emittedAt: string;
  validateRecord: ValidateRecord | undefined;
  isTombstone: ((stream: string, data: RecordData) => boolean) | undefined;
  timeRangeFieldFor: (stream: string) => string;
}): {
  emit: (stream: string, data: RecordData) => Promise<void>;
  counters: { totalEmitted: number; totalSkipped: number };
} {
  const { requested, emit, emittedAt, validateRecord, isTombstone, timeRangeFieldFor } = deps;
  const counters = { totalEmitted: 0, totalSkipped: 0 };
  const resFilters = new Map<string, ReadonlySet<string> | null>();
  for (const [streamName, scope] of requested) {
    resFilters.set(streamName, resourceSet(scope));
  }

  const emitRecord = (stream: string, data: RecordData): Promise<void> => {
    if (data.id == null) {
      return Promise.resolve();
    }
    const rs = resFilters.get(stream);
    if (rs && !rs.has(String(data.id))) {
      return Promise.resolve();
    }

    if (isTombstone?.(stream, data)) {
      counters.totalEmitted++;
      return emit({
        type: "RECORD",
        stream,
        key: data.id,
        data: { id: data.id },
        emitted_at: emittedAt,
        op: "delete",
      });
    }

    const streamScope = requested.get(stream);
    const field = timeRangeFieldFor(stream);
    if (streamScope?.time_range && isOutsideTimeRange(streamScope.time_range, data[field])) {
      return Promise.resolve();
    }

    if (validateRecord) {
      const result = validateRecord(stream, data);
      if (!result.ok) {
        counters.totalSkipped++;
        return emit(makeShapeCheckSkip(stream, data, result.issues));
      }
    }
    counters.totalEmitted++;
    return emit({
      type: "RECORD",
      stream,
      key: data.id,
      data,
      emitted_at: emittedAt,
    });
  };

  return { emit: emitRecord, counters };
}

/** Run collect() inside an acquired browser context, with session + tracing. */
async function runInBrowser(args: {
  browser: BrowserConfig;
  name: string;
  emit: (msg: EmittedMessage) => Promise<void>;
  sendInteraction: BaseCollectContext["sendInteraction"];
  assist: BaseCollectContext["assist"];
  completeAssistance: BaseCollectContext["completeAssistance"];
  progress: BaseCollectContext["progress"];
  ensureSession: BrowserConnectorConfig["ensureSession"];
  probeSession: BrowserConnectorConfig["probeSession"];
  collect: BrowserConnectorConfig["collect"];
  baseCtx: BaseCollectContext;
}): Promise<void> {
  const {
    browser,
    name,
    emit,
    sendInteraction,
    assist,
    completeAssistance,
    progress,
    ensureSession,
    probeSession,
    collect,
    baseCtx,
  } = args;
  const { context: ctx, release } = await acquireBrowser(browser, name);
  const visibility = resolveBrowserRuntimeVisibility(browser, name);
  const browserSendInteraction = makeBrowserInteractionKeepalive({
    context: ctx,
    diagnostics: process.env.PDPP_BROWSER_SURFACE_DIAGNOSTICS === "1",
    progress,
    sendInteraction: (req) => sendInteraction(decorateBrowserManualAction(req, visibility)),
  });
  // Prevention layer (Layer A): register a SIGTERM/SIGINT handler that
  // awaits release() before exit. Without this, Docker stop / controller
  // restart kills this child process before the `finally` block below
  // runs, Chromium dies with its profile-lock symlink still pointing at
  // this PID, and the next launch fails the hostname check. See
  // `shutdown-hook.ts` for the design and `profile-lock.ts` for the
  // correction-layer counterpart.
  const { withShutdownRelease } = await import("./shutdown-hook.ts");
  const disposeShutdownHook = withShutdownRelease(release);
  const tracer = makeTracer(ctx, name, emit);
  await tracer.start();
  try {
    const page = await ctx.newPage();
    await establishSession(
      { ensureSession, probeSession },
      {
        assist,
        capture: baseCtx.capture,
        completeAssistance,
        context: ctx,
        page,
        name,
        progress,
        sendInteraction: browserSendInteraction,
      }
    );
    await collect({ ...baseCtx, context: ctx, page, sendInteraction: browserSendInteraction });
  } finally {
    await tracer.stop();
    await release().catch((): undefined => undefined);
    disposeShutdownHook();
  }
}

const BROWSER_INTERACTION_KEEPALIVE_INTERVAL_MS = 15_000;

interface BrowserSurfaceDiagnosticContext {
  browser: BrowserContext["browser"];
  pages?: BrowserContext["pages"];
}

interface BrowserConnectionKeepaliveSummary {
  browserConnectedAtStart: boolean;
  browserConnectedAtStop: boolean;
  disconnectEventCount: number;
  disconnectEventElapsedMs?: number;
  elapsedMs: number;
  firstObservedDisconnectedElapsedMs?: number;
  lastError?: string;
  lastSuccessfulPingElapsedMs?: number;
  pingAttempts: number;
  pingFailures: number;
  pingInFlight: boolean;
  pingSuccesses: number;
  skippedDisconnected: number;
}

interface BrowserConnectionKeepaliveHandle {
  stop: () => BrowserConnectionKeepaliveSummary;
}

export function makeBrowserInteractionKeepalive(args: {
  context: BrowserSurfaceDiagnosticContext;
  diagnostics?: boolean;
  intervalMs?: number;
  progress?: BaseCollectContext["progress"];
  sendInteraction: BaseCollectContext["sendInteraction"];
}): BaseCollectContext["sendInteraction"] {
  const {
    context,
    diagnostics = false,
    intervalMs = BROWSER_INTERACTION_KEEPALIVE_INTERVAL_MS,
    progress,
    sendInteraction,
  } = args;
  return async (req) => {
    await emitBrowserSurfaceDiagnostic({ context, diagnostics, phase: "interaction_start", progress, req });
    const keepalive = startBrowserConnectionKeepalive(context, intervalMs);
    try {
      const response = await sendInteraction(req);
      await emitBrowserSurfaceDiagnostic({
        context,
        diagnostics,
        keepalive: keepalive.stop(),
        phase: "interaction_response",
        progress,
        req,
        responseStatus: response.status,
      });
      return response;
    } catch (err) {
      await emitBrowserSurfaceDiagnostic({
        context,
        diagnostics,
        error: err,
        keepalive: keepalive.stop(),
        phase: "interaction_error",
        progress,
        req,
      });
      throw err;
    }
  };
}

async function emitBrowserSurfaceDiagnostic(args: {
  context: BrowserSurfaceDiagnosticContext;
  diagnostics: boolean;
  error?: unknown;
  keepalive?: BrowserConnectionKeepaliveSummary;
  phase: "interaction_error" | "interaction_response" | "interaction_start";
  progress: BaseCollectContext["progress"] | undefined;
  req: InteractionRequest;
  responseStatus?: InteractionResponse["status"];
}): Promise<void> {
  const { context, diagnostics, error, keepalive, phase, progress, req, responseStatus } = args;
  if (!(diagnostics && progress)) {
    return;
  }
  let errorMessage: string | null = null;
  if (error instanceof Error) {
    errorMessage = error.message;
  } else if (error != null) {
    errorMessage = String(error);
  }
  const payload = {
    phase,
    interaction_kind: req.kind,
    request_id: req.request_id ?? null,
    response_status: responseStatus ?? null,
    surface: describeBrowserSurface(context),
    keepalive: keepalive ?? null,
    error: errorMessage,
  };
  try {
    await progress(`browser_surface.diagnostic ${JSON.stringify(payload)}`);
  } catch (progressError) {
    const message = progressError instanceof Error ? progressError.message : String(progressError);
    process.stderr.write(`[browser-surface-diagnostics] progress emit failed: ${message}\n`);
  }
}

function describeBrowserSurface(context: BrowserSurfaceDiagnosticContext): {
  browser_connected: boolean;
  page_count: number | null;
  pages: Array<{ closed: boolean; url: string | null }>;
} {
  const browser = context.browser();
  let pages: Page[] = [];
  try {
    pages = typeof context.pages === "function" ? context.pages() : [];
  } catch {
    pages = [];
  }
  return {
    browser_connected: Boolean(browser?.isConnected()),
    page_count: typeof context.pages === "function" ? pages.length : null,
    pages: pages.slice(0, 5).map((page) => ({
      closed: page.isClosed(),
      url: sanitizeDiagnosticUrl(page),
    })),
  };
}

function sanitizeDiagnosticUrl(page: Page): string | null {
  if (page.isClosed()) {
    return null;
  }
  try {
    const rawUrl = page.url();
    if (!rawUrl || rawUrl === "about:blank") {
      return rawUrl || null;
    }
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unparseable";
  }
}

function normalizeDiagnosticError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 300);
}

function summarizeInactiveKeepalive(
  browser: ReturnType<BrowserContext["browser"]> | null | undefined,
  startedAt: number
): BrowserConnectionKeepaliveSummary {
  return {
    browserConnectedAtStart: Boolean(browser?.isConnected()),
    browserConnectedAtStop: Boolean(browser?.isConnected()),
    elapsedMs: Date.now() - startedAt,
    disconnectEventCount: 0,
    pingAttempts: 0,
    pingFailures: 0,
    pingInFlight: false,
    pingSuccesses: 0,
    skippedDisconnected: 0,
  };
}

function startBrowserConnectionKeepalive(
  context: BrowserSurfaceDiagnosticContext,
  intervalMs: number
): BrowserConnectionKeepaliveHandle {
  const startedAt = Date.now();
  const browser = context.browser();
  if (intervalMs <= 0 || !browser?.isConnected()) {
    return { stop: () => summarizeInactiveKeepalive(browser, startedAt) };
  }
  let sessionPromise: Promise<CDPSession> | null = null;
  let pingInFlight = false;
  let pingAttempts = 0;
  let pingFailures = 0;
  let pingSuccesses = 0;
  let skippedDisconnected = 0;
  let stopped = false;
  let lastError: string | undefined;
  let lastSuccessfulPingElapsedMs: number | undefined;
  let firstObservedDisconnectedElapsedMs: number | undefined;
  let disconnectEventElapsedMs: number | undefined;
  let disconnectEventCount = 0;
  const browserConnectedAtStart = browser.isConnected();
  const removeDisconnectedListener = attachBrowserDisconnectedDiagnostic(browser, () => {
    disconnectEventCount++;
    disconnectEventElapsedMs ??= Date.now() - startedAt;
    process.stderr.write(
      `[browser-keepalive] browser disconnected during interaction after ${disconnectEventElapsedMs}ms\n`
    );
  });
  const sessionFor = (connectedBrowser: Browser): Promise<CDPSession> => {
    sessionPromise ??= connectedBrowser.newBrowserCDPSession();
    return sessionPromise;
  };
  const ping = async (): Promise<void> => {
    if (stopped || pingInFlight) {
      return;
    }
    if (!browser.isConnected()) {
      firstObservedDisconnectedElapsedMs ??= Date.now() - startedAt;
      skippedDisconnected++;
      return;
    }
    pingInFlight = true;
    pingAttempts++;
    try {
      const session = await sessionFor(browser);
      await session.send("Browser.getVersion");
      pingSuccesses++;
      lastSuccessfulPingElapsedMs = Date.now() - startedAt;
    } catch (err) {
      sessionPromise = null;
      pingFailures++;
      lastError = normalizeDiagnosticError(err);
      process.stderr.write(`[browser-keepalive] Browser.getVersion failed: ${lastError}\n`);
    } finally {
      pingInFlight = false;
    }
  };
  const timer = setInterval(ping, intervalMs);
  timer.unref?.();
  ping().catch((): undefined => undefined);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      removeDisconnectedListener();
      sessionPromise?.then((session) => session.detach()).catch((): undefined => undefined);
      return {
        browserConnectedAtStart,
        browserConnectedAtStop: browser.isConnected(),
        disconnectEventCount,
        ...(disconnectEventElapsedMs === undefined ? {} : { disconnectEventElapsedMs }),
        elapsedMs: Date.now() - startedAt,
        ...(firstObservedDisconnectedElapsedMs === undefined ? {} : { firstObservedDisconnectedElapsedMs }),
        ...(lastSuccessfulPingElapsedMs === undefined ? {} : { lastSuccessfulPingElapsedMs }),
        pingAttempts,
        pingFailures,
        pingInFlight,
        pingSuccesses,
        skippedDisconnected,
        ...(lastError ? { lastError } : {}),
      };
    },
  };
}

function attachBrowserDisconnectedDiagnostic(browser: Browser, onDisconnected: () => void): () => void {
  const eventTarget = browser as Browser & {
    off?: (event: "disconnected", listener: () => void) => Browser;
    on?: (event: "disconnected", listener: () => void) => Browser;
  };
  if (typeof eventTarget.on !== "function") {
    return () => undefined;
  }
  eventTarget.on("disconnected", onDisconnected);
  return () => {
    if (typeof eventTarget.off === "function") {
      eventTarget.off("disconnected", onDisconnected);
    }
  };
}

/** Emit the final PROGRESS summary (if any skips) and the succeeded DONE. */
async function finalizeRun(
  counters: { totalEmitted: number; totalSkipped: number },
  progress: BaseCollectContext["progress"],
  emit: (msg: EmittedMessage) => Promise<void>
): Promise<void> {
  if (counters.totalSkipped > 0) {
    await progress(`shape-check skipped ${String(counters.totalSkipped)} record(s); see SKIP_RESULT events above`);
  }
  await emit({
    type: "DONE",
    status: "succeeded",
    records_emitted: counters.totalEmitted,
  });
}

// ─── Browser-mode helpers ──────────────────────────────────────────────

interface AcquiredBrowser {
  context: BrowserContext;
  release: () => Promise<void>;
}

const MANUAL_ACTION_RECOVERY_RE = /\bheadless\b|local collector|rerun .*headed|PDPP_[A-Z0-9_]+_HEADLESS/iu;

export function resolveBrowserRuntimeVisibility(
  browser: BrowserConfig,
  name: string,
  env: NodeJS.ProcessEnv = process.env
): BrowserRuntimeVisibility {
  const profileName = browser.profileName ?? name;
  const envKey = `PDPP_${profileName.toUpperCase()}_HEADLESS`;
  return {
    envKey,
    headless: browser.headless ?? env[envKey] !== "0",
    profileName,
  };
}

export function resolveBrowserLaunchSource(
  visibility: Pick<BrowserRuntimeVisibility, "profileName">,
  env: NodeJS.ProcessEnv = process.env
): BrowserLaunchSource {
  const managedRequired = env.PDPP_BROWSER_SURFACE_REQUIRED?.trim().toLowerCase() === "neko";
  const managedRemoteCdpUrl = env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL?.trim();
  if (managedRequired) {
    if (!managedRemoteCdpUrl) {
      throw new TerminalError(
        "browser surface required: PDPP_BROWSER_SURFACE_REQUIRED=neko but PDPP_BROWSER_SURFACE_REMOTE_CDP_URL is missing",
        false
      );
    }
    return {
      kind: "managed_neko",
      remoteCdpUrl: managedRemoteCdpUrl,
      ...(env.PDPP_BROWSER_SURFACE_LEASE_ID?.trim() ? { leaseId: env.PDPP_BROWSER_SURFACE_LEASE_ID.trim() } : {}),
      ...(env.PDPP_BROWSER_SURFACE_PROFILE_KEY?.trim()
        ? { profileKey: env.PDPP_BROWSER_SURFACE_PROFILE_KEY.trim() }
        : {}),
    };
  }

  const legacyRemoteCdpEnvKey = `PDPP_${visibility.profileName.toUpperCase()}_REMOTE_CDP_URL`;
  const legacyRemoteCdpUrl = env[legacyRemoteCdpEnvKey]?.trim();
  if (legacyRemoteCdpUrl) {
    return {
      envKey: legacyRemoteCdpEnvKey,
      kind: "legacy_remote_cdp",
      remoteCdpUrl: legacyRemoteCdpUrl,
    };
  }

  return { kind: "isolated_local" };
}

export function decorateBrowserManualAction(
  req: InteractionRequest,
  visibility: BrowserRuntimeVisibility
): InteractionRequest {
  if (req.kind !== "manual_action") {
    return req;
  }
  if (!visibility.headless) {
    return req;
  }
  if (MANUAL_ACTION_RECOVERY_RE.test(req.message)) {
    return req;
  }
  return {
    ...req,
    message:
      `${req.message}\n\n` +
      "Open the streaming companion to drive the connector's browser from your phone or laptop. " +
      `Or rerun with ${visibility.envKey}=0 on a host desktop to use a visible local browser instead.`,
  };
}

/**
 * Acquire a browser context for the connector via the native isolated
 * launcher. Throws TerminalError on failure; preserves
 * HeadedBrowserUnavailableError's stable code in the message so
 * downstream logs/dashboards can pattern-match.
 *
 * If a streaming-target registration credential is available in env
 * (PDPP_RUN_ID + PDPP_REFERENCE_BASE_URL + either
 * PDPP_STREAMING_REGISTRATION_TOKEN (Mode A, in-process runtime) or
 * PDPP_LOCAL_DEVICE_TOKEN (Mode B, collector-runner) — all three
 * required), the launcher additionally registers the page-target CDP
 * wsUrl with the reference server's run-target registry so the
 * streaming companion can resolve it by `runId` at viewer-attach time.
 * Registration is best-effort and never affects the run's outcome —
 * see `acquireIsolatedBrowser` for the failure semantics.
 */
async function acquireBrowser(browser: BrowserConfig, name: string): Promise<AcquiredBrowser> {
  const { acquireBrowserForConnector, HeadedBrowserUnavailableError } = await import("./browser-launch.ts");
  const visibility = resolveBrowserRuntimeVisibility(browser, name);
  const { headless, profileName } = visibility;
  // Streaming env vars are present iff the controller wired up Mode-A
  // streaming for this run. Their presence is the signal to launch
  // Chromium in CDP-port mode (so the handoff helper can compose
  // wsUrls). Actual per-interaction registration happens in the binding
  // path via `manualAction(...)`, not at launch — so we don't need the
  // full registration client here, just the env presence check.
  const streamingEnabled =
    Boolean(process.env.PDPP_RUN_ID?.trim()) &&
    Boolean(process.env.PDPP_REFERENCE_BASE_URL?.trim()) &&
    Boolean(process.env.PDPP_STREAMING_REGISTRATION_TOKEN?.trim() || process.env.PDPP_LOCAL_DEVICE_TOKEN?.trim());
  const launchSource = resolveBrowserLaunchSource(visibility);
  const remoteCdpUrl =
    launchSource.kind === "managed_neko" || launchSource.kind === "legacy_remote_cdp"
      ? launchSource.remoteCdpUrl
      : undefined;
  try {
    return await acquireBrowserForConnector({
      profileName,
      headless,
      ...(streamingEnabled ? { streamingEnabled: true } : {}),
      ...(remoteCdpUrl ? { remoteCdpUrl } : {}),
    });
  } catch (err) {
    if (err instanceof HeadedBrowserUnavailableError) {
      // Surface the stable code in the terminal-error message so the
      // controller's run-failed copy can render the deployment-config
      // error state rather than a generic browser failure.
      throw new TerminalError(`[${err.code}] ${err.message}`, false);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new TerminalError(`could not open browser profile: ${message}`, false);
  }
}

interface SessionEstablishArgs {
  assist: BaseCollectContext["assist"];
  capture: CaptureSession | null;
  completeAssistance: BaseCollectContext["completeAssistance"];
  context: BrowserContext;
  name: string;
  page: Page;
  progress: BaseCollectContext["progress"];
  sendInteraction: BaseCollectContext["sendInteraction"];
}

/**
 * Run whichever session-management flow the connector configured.
 * Throws TerminalError if the session is dead and we couldn't recover.
 *
 * Priority: ensureSession (automated re-auth) > probeSession (read-only
 * + manual_action fallback) > nothing (connector assumes session is live).
 */
async function establishSession(
  hooks: {
    ensureSession: ((args: EnsureSessionArgs) => Promise<void>) | undefined;
    probeSession: ((args: ProbeSessionArgs) => Promise<boolean>) | undefined;
  },
  args: SessionEstablishArgs
): Promise<void> {
  const { ensureSession, probeSession } = hooks;
  const { assist, capture, completeAssistance, context, page, name, sendInteraction, progress } = args;

  if (typeof ensureSession === "function") {
    try {
      await ensureSession({ assist, capture, completeAssistance, context, page, sendInteraction, progress });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TerminalError(`${name}_session_failed: ${message}`, false);
    }
  }

  if (typeof probeSession !== "function") {
    return;
  }
  if (await probeSession({ context, page })) {
    return;
  }

  await sendInteraction({
    kind: "manual_action",
    message: `${name} session expired. Open the browser and re-authenticate, then continue.`,
    timeout_seconds: 1800,
  });
  if (await probeSession({ context, page })) {
    return;
  }

  throw new TerminalError(`${name}_session_required`, false);
}

// ─── Playwright tracing helper ──────────────────────────────────────────

interface Tracer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start/stop Playwright tracing, gated on PDPP_TRACE=1. Produces a
 * replayable .zip for debugging silent scraper failures. See §9.
 */
function makeTracer(context: BrowserContext, name: string, emit: (msg: EmittedMessage) => Promise<void>): Tracer {
  const enabled = process.env.PDPP_TRACE === "1";
  return {
    async start(): Promise<void> {
      if (!enabled) {
        return;
      }
      const ts = new Date().toISOString().replace(TRACE_TIMESTAMP_UNSAFE, "-");
      const traceName = `${name}-${ts}`;
      await context.tracing
        .start({
          name: traceName,
          screenshots: true,
          snapshots: true,
          sources: true,
        })
        .catch((): undefined => undefined);
      await emit({
        type: "PROGRESS",
        message: `tracing enabled (PDPP_TRACE=1); will write /tmp/${traceName}.zip on exit`,
      });
    },
    async stop(): Promise<void> {
      if (!enabled) {
        return;
      }
      const ts = new Date().toISOString().replace(TRACE_TIMESTAMP_UNSAFE, "-");
      const tracePath = `/tmp/${name}-trace-${ts}.zip`;
      try {
        await context.tracing.stop({ path: tracePath });
        await emit({
          type: "PROGRESS",
          message: `trace written to ${tracePath} — replay with: npx playwright show-trace ${tracePath}`,
        });
      } catch (err) {
        await emit({
          type: "PROGRESS",
          message: `failed to write trace: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
