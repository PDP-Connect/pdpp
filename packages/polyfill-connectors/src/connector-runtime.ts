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
 *   - Fixture capture lifecycle (PDPP_CAPTURE_FIXTURES=1 always-retain;
 *     PDPP_CAPTURE_ON_FAILURE=1 retain-on-failure with on-success cleanup)
 *   - Terminal DONE + flushAndExit on both success and throw
 *   - Retryable-error detection via retryablePattern regex
 *   - Auth strategy resolution before collect() runs
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";

import { type AuthConfig, resolveAuth } from "./auth.ts";
import { DEADLINE_TIMEOUT, manualAction, prepareBrowserInteractionTarget, withDeadline } from "./browser-handoff.ts";
import { flushAndExitAfterRuntimeAck } from "./connector-exit.ts";
import type {
  AssistanceCompletionStatus,
  AssistanceRequest,
  DetailCoverageMessage,
  DetailGapMessage,
  DetailGapNetworkPressure,
  DetailGapStartEntry,
  DetailGapsPageResponse,
  EmittedMessage,
  InteractionRequest,
  InteractionResponse,
  ProgressExtra,
  RecordData,
  StartMessage,
  StreamScope,
  ValidateRecord,
} from "./connector-runtime-protocol.ts";
import { type CaptureSession, createCaptureSession } from "./fixture-capture.ts";
import { emitToStdout } from "./safe-emit.ts";
import { resourceSet } from "./scope-filters.ts";

// ─── Protocol message shapes (re-exported from connector-runtime-protocol.ts) ──
//
// The wire-protocol message types live in `connector-runtime-protocol.ts` so
// the local collector runner, ingest envelopes, scope filters, and
// filesystem-class connectors can import them without pulling the Playwright
// surface. This file re-exports them for backward compatibility with the
// many import sites that still target `connector-runtime.ts` directly.
export type {
  AssistanceAttachment,
  AssistanceAttachmentKind,
  AssistanceCompletion,
  AssistanceCompletionStatus,
  AssistanceOwnerAction,
  AssistanceProgressPosture,
  AssistanceRequest,
  AssistanceResponseContract,
  AssistanceSensitivity,
  CollectionRateProgress,
  DetailCoverageMessage,
  DetailGapMessage,
  DetailGapNetworkPressure,
  DetailGapRecoveredMessage,
  DetailGapStartEntry,
  EmittedMessage,
  InteractionKind,
  InteractionRequest,
  InteractionResponse,
  ProgressExtra,
  ProviderBudgetProgress,
  RecordData,
  StartMessage,
  StreamScope,
  ValidateRecord,
} from "./connector-runtime-protocol.ts";

// ─── Collect context ────────────────────────────────────────────────────

type Credentials = Record<string, string>;

interface EmitRecordOptions {
  skipResourceFilter?: boolean;
}

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
  emitRecord: (stream: string, data: RecordData, options?: EmitRecordOptions) => Promise<void>;
  emittedAt: string;
  progress: (message: string, extra?: ProgressExtra) => Promise<void>;
  /**
   * SLVP-ideal §4.3: when true, the connector MUST run its gap-recovery pass
   * then return before any forward walk / list-phase fetch. Threaded from the
   * START message's `recovery_only` field. Absent/false = ordinary full run —
   * optional so connectors that do not implement recovery-only ignore it.
   */
  recoveryOnly?: boolean;
  requestDetailGapPage: (req?: {
    maxBytes?: number;
    streams?: readonly string[];
  }) => Promise<readonly DetailGapStartEntry[]>;
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

/**
 * Mark a named session-establishment phase. Calling this updates the run's
 * last-establishment-progress marker (which the watchdog reads) and, when
 * capture is active, triggers a best-effort durable diagnostic capture for the
 * phase. Best-effort and bounded: a checkpoint SHALL NOT be able to hang the
 * watchdog and a failed capture never fails the run.
 */
export type SessionCheckpointFn = (label: string) => Promise<void>;

export interface EnsureSessionArgs {
  assist: BaseCollectContext["assist"];
  capture: CaptureSession | null;
  /**
   * Mark a session-establishment phase (e.g. "sign-in-loaded", "email-submit",
   * "2fa-decision", "final-verify"). Resets the watchdog's no-progress deadline
   * and captures a phase diagnostic. Optional for connectors that do not adopt
   * checkpoints; the runtime still frames the window with its own checkpoints.
   */
  checkpoint: SessionCheckpointFn;
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

export interface TerminalErrorDetails {
  message: string;
  retryable: boolean;
}

export type NormalizeTerminalError = (error: TerminalErrorDetails) => TerminalErrorDetails;

/** Fields shared by browser and non-browser configs. */
interface BaseRunConnectorConfig {
  auth?: AuthConfig;
  /** Marks a record as a tombstone; runtime strips to { id } + op:'delete'. */
  isTombstone?: (stream: string, data: RecordData) => boolean;
  name: string;
  normalizeTerminalError?: NormalizeTerminalError;
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

type ClosableBrowserPage = Pick<Page, "close" | "isClosed">;

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

/**
 * Inputs for a per-run detail coverage report. A list+detail connector passes
 * the keys it considered for detail (`requiredKeys`, the denominator) and the
 * subset it hydrated (`hydratedKeys`, the numerator), so the console can tell a
 * partial run from a complete one without inferring it from gaps.
 */
export interface DetailCoverageParams {
  /**
   * Optional explicit `considered` denominator: how many items the run weighed
   * for this stream (the source inventory or boundary it enumerated). When
   * present it is preferred over `requiredKeys.length` so a list stream that has
   * no detail-hydration phase can still declare partial-vs-complete by passing
   * empty `requiredKeys`/`hydratedKeys` and a measured `considered` count. It
   * MUST be measured independently at the enumeration site, never aliased to the
   * collected/emitted count — the runtime never infers it from collected.
   */
  considered?: number;
  /**
   * Optional explicit `covered` count: how many of the `considered` in-boundary
   * items the run accounted for — the items it emitted plus the items it
   * deliberately suppressed as unchanged (a full-sync stream gated by a per-record
   * fingerprint). When present, the projection compares `considered` against
   * `covered` instead of the collected count, so a steady-state run that suppressed
   * every unchanged record reads `complete` rather than a false `partial`. It MUST
   * be measured at the enumeration site from objective per-record outcomes
   * (emitted, or suppressed-because-unchanged) and MUST NOT count a weighed-but-
   * dropped item — a dropped item is in neither the collected nor the covered
   * count, so it still reads `partial`. Never aliased to the collected count.
   */
  covered?: number;
  /** Keys for which a DETAIL_GAP was emitted and should be retried next run. */
  gapKeys?: ReadonlyArray<string | number>;
  /** Subset of requiredKeys whose detail was fetched and emitted. */
  hydratedKeys: ReadonlyArray<string | number>;
  /** Keys skipped by explicit policy, such as selection scope. */
  optionalSkipKeys?: ReadonlyArray<string | number>;
  /** Full set of keys considered for detail fetch this run. */
  requiredKeys: ReadonlyArray<string | number>;
  /** The list/parent stream whose cursor anchors the detail pass. */
  stateStream: string;
  /** The detail stream the coverage report describes. */
  stream: string;
}

/**
 * Build the per-run DETAIL_COVERAGE message a list+detail connector emits once
 * after its detail lane. Pure: the caller owns when/whether to emit. Empty
 * optional key sets are omitted so a fully hydrated run carries no gap fields.
 */
export function buildDetailCoverageMessage(params: DetailCoverageParams): DetailCoverageMessage {
  const { stream, stateStream, requiredKeys, hydratedKeys, gapKeys, optionalSkipKeys, considered, covered } = params;
  return {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    stream,
    state_stream: stateStream,
    required_keys: [...requiredKeys],
    hydrated_keys: [...hydratedKeys],
    // Only emit `considered` when the connector supplied a non-negative integer.
    // The runtime re-validates and drops anything unsafe to `unknown`; omitting
    // it here keeps a no-considered run byte-identical to the prior shape.
    ...(typeof considered === "number" && Number.isInteger(considered) && considered >= 0 ? { considered } : {}),
    // Same drop-don't-fabricate posture for the optional `covered` count: omitting
    // it when absent or unsafe keeps a no-covered run byte-identical to the prior
    // shape, so every existing declarer is unaffected.
    ...(typeof covered === "number" && Number.isInteger(covered) && covered >= 0 ? { covered } : {}),
    ...(gapKeys?.length ? { gap_keys: [...gapKeys] } : {}),
    ...(optionalSkipKeys?.length ? { optional_skip_keys: [...optionalSkipKeys] } : {}),
  };
}

/**
 * Thin emit wrapper for connectors adopting the detail coverage contract. `ctx`
 * is structural so both the collect context and connector-local dependency bags
 * can use it without importing a heavier runtime type.
 */
export function emitDetailCoverage(
  ctx: { emit: (msg: EmittedMessage) => Promise<void> },
  params: DetailCoverageParams
): Promise<void> {
  return ctx.emit(buildDetailCoverageMessage(params));
}

/**
 * Bounded error context for a recoverable detail gap. The same fields feed both
 * the `detail` and `last_error` blocks on the emitted `DETAIL_GAP` — connectors
 * built one identical copy for each by hand, which this helper centralizes.
 *
 * The helper copies these fields onto the wire verbatim; it does NOT redact
 * them. The connector is responsible for passing only safe, bounded values: a
 * connector-chosen error class, an optional HTTP status, an optional human
 * message, and an optional pre-redacted `network_pressure` diagnostic. Do NOT
 * pass bearer tokens, cookies, secret-bearing URLs, request bodies, or raw
 * payloads. In particular, the helper does not strip the attempt/max-attempt
 * budget from `network_pressure` — redact it at the source before passing it
 * here (see ChatGPT's `omitAttemptBudget`). Downstream the runtime applies the
 * same redaction policy as `known_gaps` / `SKIP_RESULT.diagnostics`, but the
 * connector is the only line of redaction inside this helper.
 */
export interface DetailGapErrorContext {
  /** Connector-chosen error class (e.g. `upstream_pressure`, the deferred class). */
  class: string;
  /** Optional upstream HTTP status that triggered the gap. */
  httpStatus?: number;
  /** Optional human-readable message. Carried on `last_error` only — the protocol's `detail` block has no `message` field. */
  message?: string;
  /** Pre-redacted network-pressure diagnostic (endpoint route, method, error class). Copied verbatim — redact at the source. */
  networkPressure?: DetailGapNetworkPressure;
}

/**
 * Inputs for a recoverable `DETAIL_GAP` — a per-record marker that detail for
 * `recordKey` could not be hydrated this run but is expected to be retried. The
 * shape mirrors `DetailCoverageParams`: the caller owns when to emit; the helper
 * owns the fixed reference-only / retryable / pending shape so connectors stop
 * hand-rolling it.
 *
 * `stream`, `recordKey`, `reason`, and `locator` are required. `parentStream`,
 * `listCursor`, and `error` are optional, first-class `DETAIL_GAP` protocol
 * fields and are omitted from the message when absent — a gap with no error
 * context carries neither `detail` nor `last_error` (matching connectors such as
 * USAA's statement gaps), and a flat detail stream carries no `parent_stream`.
 *
 * Only the source-pressure reasons (`rate_limited`, `upstream_pressure`) feed the
 * cross-run source-pressure cooldown governor; `retry_exhausted` and
 * `temporary_unavailable` record a resumable gap without arming a cooldown.
 */
export interface DetailGapParams {
  /** Optional bounded error context fanned into `detail` and `last_error`. Omit both blocks when absent. */
  error?: DetailGapErrorContext;
  /** Optional opaque cursor the next run uses to resume the parent list at this gap. */
  listCursor?: DetailGapMessage["list_cursor"];
  /** Locator the next run uses to re-hydrate this record's detail. */
  locator: DetailGapMessage["detail_locator"];
  /** Optional list/parent stream this detail stream hangs off (e.g. `accounts` for `transactions`). */
  parentStream?: string;
  /** Why detail could not be hydrated; drives retryability and any cooldown. */
  reason: DetailGapMessage["reason"];
  /** Key of the record whose detail is gapped. */
  recordKey: string | number;
  /** The detail stream the gap belongs to. */
  stream: string;
}

/**
 * Build a recoverable `DETAIL_GAP` message. Pure: the caller owns when/whether to
 * emit. The fixed reference-only shape (`status: "pending"`, `retryable: true`,
 * `reference_only: true`) is centralized here so a connector states only what
 * varies. Optional protocol fields (`parent_stream`, `list_cursor`, `detail`,
 * `last_error`) are omitted from the wire message when their input is absent, so
 * a minimal gap carries no empty blocks. When `error` is supplied, the `detail`
 * and `last_error` blocks share the same class / http_status / network_pressure;
 * `error.message` (if any) is added to `last_error` only, since the protocol's
 * `detail` block has no `message` field.
 */
export function buildDetailGap(params: DetailGapParams): DetailGapMessage {
  const { stream, recordKey, reason, locator, parentStream, listCursor, error } = params;
  let errorBlocks: Pick<DetailGapMessage, "detail" | "last_error"> = {};
  if (error) {
    const sharedBlock = {
      class: error.class,
      ...(error.httpStatus == null ? {} : { http_status: error.httpStatus }),
      ...(error.networkPressure == null ? {} : { network_pressure: error.networkPressure }),
    };
    errorBlocks = {
      detail: sharedBlock,
      last_error: error.message == null ? sharedBlock : { ...sharedBlock, message: error.message },
    };
  }
  return {
    type: "DETAIL_GAP",
    stream,
    ...(parentStream == null ? {} : { parent_stream: parentStream }),
    record_key: recordKey,
    status: "pending",
    reason,
    detail_locator: locator,
    ...(listCursor === undefined ? {} : { list_cursor: listCursor }),
    retryable: true,
    reference_only: true,
    ...errorBlocks,
  };
}

/**
 * Thin emit wrapper for connectors adopting the detail-gap contract. `ctx` is
 * structural so both the collect context and connector-local dependency bags can
 * use it without importing a heavier runtime type. Mirrors `emitDetailCoverage`.
 */
export function emitDetailGap(
  ctx: { emit: (msg: EmittedMessage) => Promise<void> },
  params: DetailGapParams
): Promise<void> {
  return ctx.emit(buildDetailGap(params));
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
    normalizeTerminalError = (error: TerminalErrorDetails): TerminalErrorDetails => error,
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
    const modeLabel = capture.keepOnSuccess
      ? "PDPP_CAPTURE_FIXTURES=1 (always retain)"
      : "PDPP_CAPTURE_ON_FAILURE=1 (retain on failure only)";
    process.stderr.write(`[capture] ${modeLabel}; writing to ${capture.baseDir}\n`);
  }

  const flushAndExit = (code: number): void => {
    flushAndExitAfterRuntimeAck(code);
  };

  let observedCounters: { totalEmitted: number; totalSkipped: number } | null = null;

  const emitFailed = (
    message: string,
    retryable = false,
    records_emitted = observedCounters?.totalEmitted ?? 0
  ): void => {
    const terminalError = normalizeTerminalError({ message, retryable });
    // Fire-and-forget. emit() resolves after stdout drains; we're about to
    // exit(1) anyway, so we don't need to block. If it rejects (the write
    // fails), the process is dying either way.
    emit({
      type: "DONE",
      status: "failed",
      records_emitted,
      error: terminalError,
    }).catch((): undefined => undefined);
    flushAndExit(1);
  };

  let interactionCounter = 0;
  const nextInteractionId = (): string => `int_${Date.now()}_${++interactionCounter}`;
  let detailGapPageCounter = 0;
  const nextDetailGapPageRequestId = (): string => `dgp_${Date.now()}_${++detailGapPageCounter}`;
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

  const requestDetailGapPage: BaseCollectContext["requestDetailGapPage"] = (req = {}) => {
    const request_id = nextDetailGapPageRequestId();
    const streams = Array.isArray(req.streams)
      ? req.streams.filter((stream) => typeof stream === "string" && stream.length > 0)
      : undefined;
    const maxBytes =
      typeof req.maxBytes === "number" && Number.isFinite(req.maxBytes) && req.maxBytes > 0
        ? Math.floor(req.maxBytes)
        : undefined;
    emit({
      type: "DETAIL_GAPS_PAGE_REQUEST",
      reference_only: true,
      request_id,
      ...(streams && streams.length > 0 ? { streams } : {}),
      ...(maxBytes ? { max_bytes: maxBytes } : {}),
    }).catch((): undefined => undefined);
    return new Promise((resolve, reject) => {
      const onLine = (line: string): void => {
        try {
          const parsed = JSON.parse(line) as DetailGapsPageResponse;
          if (parsed.type !== "DETAIL_GAPS_PAGE_RESPONSE" || parsed.request_id !== request_id) {
            return;
          }
          rl.off("line", onLine);
          if (parsed.reference_only !== true || !Array.isArray(parsed.detail_gaps)) {
            reject(new Error("Invalid DETAIL_GAPS_PAGE_RESPONSE envelope"));
            return;
          }
          resolve(parsed.detail_gaps);
        } catch (err) {
          rl.off("line", onLine);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      rl.on("line", onLine);
    });
  };

  const progress = (message: string, extra: ProgressExtra = {}): Promise<void> =>
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
      requestDetailGapPage,
      // §4.3: forward recovery_only from the START message so connectors can
      // suppress the forward walk while draining non-pressure detail gaps.
      recoveryOnly: startMsg.recovery_only === true,
    };

    if (browser) {
      await runInBrowser({
        browser,
        name,
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

  const emitRecord = (stream: string, data: RecordData, options: EmitRecordOptions = {}): Promise<void> => {
    if (data.id == null) {
      return Promise.resolve();
    }
    const rs = resFilters.get(stream);
    if (!options.skipResourceFilter && rs && !rs.has(String(data.id))) {
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
  // Prevention layer (Layer A): register a SIGTERM/SIGINT handler that
  // awaits release() before exit. Without this, Docker stop / controller
  // restart kills this child process before the `finally` block below
  // runs, Chromium dies with its profile-lock symlink still pointing at
  // this PID, and the next launch fails the hostname check. See
  // `shutdown-hook.ts` for the design and `profile-lock.ts` for the
  // correction-layer counterpart.
  const { withShutdownRelease } = await import("./shutdown-hook.ts");
  const tracer = makeTracer(ctx, name, baseCtx.capture);
  // Finalization runs before release(). On SIGTERM/SIGINT this is what
  // gives the operator a usable trace/capture artifact for the in-flight
  // run; without it, Docker stop / scheduler restart drops the trace.
  let traceFinalized = false;
  const finalizeDiagnostics = async (): Promise<void> => {
    if (traceFinalized) {
      return;
    }
    traceFinalized = true;
    baseCtx.capture?.setTraceCheckpointHook?.(null);
    await tracer.stop();
  };
  const disposeShutdownHook = withShutdownRelease(release, { finalize: finalizeDiagnostics });
  await tracer.start();
  baseCtx.capture?.setTraceCheckpointHook?.((label) => tracer.checkpoint(label));
  let page: Page | null = null;
  try {
    page = await ctx.newPage();
    const browserSendInteraction = makeBrowserInteractionKeepalive({
      context: ctx,
      diagnostics: process.env.PDPP_BROWSER_SURFACE_DIAGNOSTICS === "1",
      progress,
      sendInteraction: async (req) => {
        const decorated = decorateBrowserManualAction(req, visibility);
        if (decorated.kind !== "otp") {
          return sendInteraction(decorated);
        }
        const { interactionId } = await prepareBrowserInteractionTarget({
          page: page as Page,
          reason: "2fa",
          ...(decorated.request_id ? { interactionId: decorated.request_id } : {}),
        });
        return sendInteraction({ ...decorated, request_id: interactionId });
      },
    });
    await captureBrowserPage(baseCtx.capture, page, "runtime-new-page");
    await closeBrowserContextPagesExcept(ctx, page);
    // Session establishment is the window the watchdog guards. A wedged
    // renderer can hang a connector's ensureSession indefinitely with no
    // INTERACTION ever emitted, so the controller's mid-wait detector cannot
    // help. The watchdog keys on checkpoint progress (paused while an
    // interaction is open) and fails closed if establishment stalls.
    const watchdog = makeSessionEstablishWatchdog({
      capture: baseCtx.capture,
      name,
      page,
    });
    await watchdog.run(() =>
      establishSession(
        { ensureSession, probeSession },
        {
          assist: watchdog.wrapAssist(assist),
          capture: baseCtx.capture,
          checkpoint: watchdog.checkpoint,
          completeAssistance: watchdog.wrapCompleteAssistance(completeAssistance),
          context: ctx,
          page: page as Page,
          name,
          progress,
          sendInteraction: watchdog.wrapSendInteraction(browserSendInteraction),
        }
      )
    );
    await captureBrowserPage(baseCtx.capture, page, "runtime-session-established");
    await captureBrowserPage(baseCtx.capture, page, "runtime-collect-start");
    await collect({ ...baseCtx, context: ctx, page, sendInteraction: browserSendInteraction });
    await captureBrowserPage(baseCtx.capture, page, "runtime-collect-complete");
    // Mark success before the finally so tracer.stop() deletes chunks on a
    // clean run, and capture.finalize() can scrub the raw dir in
    // PDPP_CAPTURE_ON_FAILURE mode. Anything thrown after this point (only
    // release/page-close) is treated as benign teardown.
    tracer.markSucceeded();
    baseCtx.capture?.markSucceeded?.();
  } catch (err) {
    if (page) {
      await captureBrowserPage(baseCtx.capture, page, "runtime-error");
    }
    throw err;
  } finally {
    await finalizeDiagnostics();
    await closeBrowserPage(page);
    await release().catch((): undefined => undefined);
    disposeShutdownHook();
    baseCtx.capture?.finalize?.();
  }
}

// A wedged renderer can hang the CDP-backed reads inside captureDom
// (`page.content()`, `page.title()`, `page.ariaSnapshot()`) with no per-call
// timeout. Bound the whole capture so a diagnostic snapshot during teardown of
// a wedged run cannot itself re-hang the teardown.
const CAPTURE_DOM_DEADLINE_MS = 10_000;
const PAGE_CLOSE_DEADLINE_MS = 10_000;

export async function captureBrowserPage(
  capture: CaptureSession | null,
  page: Page,
  label: string,
  deadlineMs = CAPTURE_DOM_DEADLINE_MS
): Promise<void> {
  if (!capture) {
    return;
  }
  // After a CDP transport drop / remote target loss the page may already
  // be closed by the time we try to capture (`runtime-error` is the
  // common case). Skipping cleanly here keeps a bounded diagnostic line
  // out of Playwright's noisy "Target page, context or browser has been
  // closed" exception path.
  if (page.isClosed()) {
    process.stderr.write(`[capture] page already closed at ${label}; skipping dom snapshot\n`);
    return;
  }
  // captureDom is best-effort by construction (each internal step swallows its
  // own errors to stderr), so it never rejects; on timeout the detached promise
  // simply keeps running harmlessly while teardown proceeds.
  const captureWork = capture.captureDom(page, label);
  captureWork.catch((): undefined => undefined);
  await withDeadline(captureWork, deadlineMs, () => {
    process.stderr.write(
      `[capture] dom snapshot for ${label} exceeded ${String(deadlineMs)}ms (wedged renderer?); abandoning this capture.\n`
    );
  });
}

export async function closeBrowserContextPagesExcept(
  context: { pages: () => ClosableBrowserPage[] },
  keepPage: ClosableBrowserPage,
  deadlineMs = PAGE_CLOSE_DEADLINE_MS
): Promise<number> {
  let pages: ClosableBrowserPage[];
  try {
    pages = context.pages();
  } catch {
    return 0;
  }

  let closed = 0;
  for (const page of pages) {
    if (page === keepPage || page.isClosed()) {
      continue;
    }
    if (await closeBrowserPage(page, deadlineMs)) {
      closed++;
    }
  }
  return closed;
}

export async function closeBrowserPage(
  page: ClosableBrowserPage | null,
  deadlineMs = PAGE_CLOSE_DEADLINE_MS
): Promise<boolean> {
  if (!page || page.isClosed()) {
    return false;
  }
  try {
    const closeWork = page.close();
    closeWork.catch((): undefined => undefined);
    const result = await withDeadline(closeWork, deadlineMs, () => {
      process.stderr.write(
        `[browser-runtime] page.close() exceeded ${String(deadlineMs)}ms (wedged renderer?); abandoning close.\n`
      );
    });
    return result !== DEADLINE_TIMEOUT;
  } catch {
    // Remote-CDP targets can disappear underneath us during banking OTP/manual
    // waits. Cleanup must never mask the connector's real terminal reason.
    return false;
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

// ─── Session-establishment watchdog ─────────────────────────────────────
//
// Guards the window between the browser page being created and the connector
// returning from session establishment. A wedged renderer can hang a
// connector's ensureSession indefinitely with no INTERACTION ever emitted, so
// the controller-side mid-wait surface-loss detector (which only arms once an
// interaction is open) cannot help. The watchdog keys on *checkpoint progress*
// rather than wall-clock so a legitimately slow-but-progressing auth flow is
// never killed; a stall (no checkpoint for longer than the deadline, with no
// interaction open) fails the run closed so it cannot sit active indefinitely.

const DEFAULT_SESSION_ESTABLISH_WATCHDOG_MS = 120_000;
const SESSION_ESTABLISH_WATCHDOG_ENV = "PDPP_SESSION_ESTABLISH_WATCHDOG_MS";

export interface SessionEstablishWatchdog {
  checkpoint: SessionCheckpointFn;
  /** Run the establishment work under the watchdog; rejects with TerminalError on trip. */
  run: (work: () => Promise<void>) => Promise<void>;
  /** Wrap nonblocking assistance so external owner waits pause the watchdog. */
  wrapAssist: (assist: BaseCollectContext["assist"]) => BaseCollectContext["assist"];
  /** Re-arm the watchdog when a nonblocking assistance wait is resolved/escalated. */
  wrapCompleteAssistance: (
    completeAssistance: BaseCollectContext["completeAssistance"]
  ) => BaseCollectContext["completeAssistance"];
  /** Wrap a sendInteraction so the watchdog is paused while an interaction is open. */
  wrapSendInteraction: (send: BaseCollectContext["sendInteraction"]) => BaseCollectContext["sendInteraction"];
}

export function resolveSessionEstablishWatchdogMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SESSION_ESTABLISH_WATCHDOG_ENV]?.trim();
  if (!raw) {
    return DEFAULT_SESSION_ESTABLISH_WATCHDOG_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!(Number.isFinite(parsed) && parsed > 0)) {
    return DEFAULT_SESSION_ESTABLISH_WATCHDOG_MS;
  }
  return parsed;
}

/**
 * Build a session-establishment watchdog. Exposed (with injectable `deadlineMs`,
 * `now`, `pollIntervalMs`, and `onTrip`) so tests can drive it deterministically
 * without real-time sleeps.
 */
export function makeSessionEstablishWatchdog(args: {
  capture: CaptureSession | null;
  deadlineMs?: number;
  name: string;
  now?: () => number;
  page: Page;
  pollIntervalMs?: number;
  /** Hook fired exactly once when the watchdog trips, before the run rejects. */
  onTrip?: (info: { lastLabel: string | null; sinceMs: number }) => void;
}): SessionEstablishWatchdog {
  const now = args.now ?? Date.now;
  const deadlineMs = args.deadlineMs ?? resolveSessionEstablishWatchdogMs();
  // Poll often enough to trip near the deadline without busy-waiting; never
  // longer than the deadline itself so a small test deadline still trips.
  const pollIntervalMs = args.pollIntervalMs ?? Math.max(1, Math.min(1000, Math.floor(deadlineMs / 4)));

  let lastProgressAt = now();
  let lastLabel: string | null = null;
  const openAssistance = new Map<string, number>();
  let openInteractions = 0;
  let tripped = false;

  const markProgress = (label: string | null): void => {
    lastProgressAt = now();
    if (label !== null) {
      lastLabel = label;
    }
  };

  const checkpoint: SessionCheckpointFn = async (label) => {
    markProgress(label);
    // Best-effort durable diagnostic so a hang no longer leaves only the
    // initial blank-page artifact. captureBrowserPage already guards a closed
    // page; the bounded-title fix keeps the underlying metadata read from
    // hanging. A failed capture never fails the run.
    try {
      await captureBrowserPage(args.capture, args.page, `session-establish-${label}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[session-watchdog] checkpoint capture failed for ${label}: ${message}\n`);
    }
  };

  const assistancePausesWatchdog = (req: AssistanceRequest): boolean =>
    req.progress_posture === "running" && req.response_contract === "none";

  const pruneExpiredAssistance = (): void => {
    const current = now();
    let pruned = false;
    for (const [id, expiresAt] of openAssistance) {
      if (expiresAt > current) {
        continue;
      }
      openAssistance.delete(id);
      pruned = true;
    }
    if (pruned) {
      // Give post-timeout fallback logic a fresh watchdog window.
      markProgress(null);
    }
  };

  const wrapAssist: SessionEstablishWatchdog["wrapAssist"] = (assist) => async (req) => {
    markProgress(null);
    const assistanceRequestId = await assist(req);
    if (assistancePausesWatchdog(req)) {
      const timeoutMs =
        typeof req.timeout_seconds === "number" && Number.isFinite(req.timeout_seconds) && req.timeout_seconds > 0
          ? req.timeout_seconds * 1000
          : deadlineMs;
      openAssistance.set(assistanceRequestId, now() + timeoutMs + deadlineMs);
      markProgress(null);
    }
    return assistanceRequestId;
  };

  const wrapCompleteAssistance: SessionEstablishWatchdog["wrapCompleteAssistance"] =
    (completeAssistance) =>
    async (assistanceRequestId, status, extra = {}) => {
      try {
        await completeAssistance(assistanceRequestId, status, extra);
      } finally {
        if (openAssistance.delete(assistanceRequestId)) {
          markProgress(null);
        }
      }
    };

  const wrapSendInteraction: SessionEstablishWatchdog["wrapSendInteraction"] = (send) => async (req) => {
    // An open interaction means the run is legitimately waiting on the owner;
    // pause the watchdog so a long CAPTCHA/OTP wait is not killed. Reset the
    // deadline on resolve so post-interaction work gets a fresh window.
    openInteractions++;
    markProgress(null);
    try {
      return await send(req);
    } finally {
      openInteractions--;
      markProgress(null);
    }
  };

  const run: SessionEstablishWatchdog["run"] = async (work) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let tripInfo: { lastLabel: string | null; sinceMs: number } | null = null;
    // The trip path *resolves* (rather than rejects) a sentinel and the caller
    // throws afterward. Rejecting from inside the interval callback opens a
    // one-microtask window where the rejection has no attached handler yet,
    // which Node surfaces as PromiseRejectionHandledWarning / an unhandled
    // rejection. Resolving avoids that window entirely; the TerminalError is
    // constructed and thrown synchronously in `run` once the race settles.
    const TRIP = Symbol("session-establish-trip");
    const tripPromise = new Promise<typeof TRIP>((resolve) => {
      const onTick = (): void => {
        pruneExpiredAssistance();
        if (tripped || openInteractions > 0 || openAssistance.size > 0) {
          return;
        }
        const sinceMs = now() - lastProgressAt;
        if (sinceMs <= deadlineMs) {
          return;
        }
        tripped = true;
        if (timer) {
          clearInterval(timer);
        }
        tripInfo = { lastLabel, sinceMs };
        args.onTrip?.(tripInfo);
        resolve(TRIP);
      };
      timer = setInterval(onTick, pollIntervalMs);
    });

    const workPromise = work();
    // If the watchdog wins the race, `workPromise` may still settle later
    // (e.g. the wedged call finally rejects). Attach a no-op catch so that
    // late rejection cannot surface as an unhandled rejection after we have
    // already failed the run closed.
    workPromise.catch((): undefined => undefined);
    try {
      const outcome = await Promise.race([workPromise, tripPromise]);
      if (outcome === TRIP) {
        const info = tripInfo as { lastLabel: string | null; sinceMs: number } | null;
        const sinceMs = info?.sinceMs ?? deadlineMs;
        const lastCheckpoint = info?.lastLabel ?? "<none>";
        throw new TerminalError(
          `${args.name}_session_establish_timeout: no session-establishment progress for ${String(sinceMs)}ms ` +
            `(last checkpoint: ${lastCheckpoint}); failing run closed`,
          true
        );
      }
    } finally {
      if (timer) {
        clearInterval(timer);
      }
    }
  };

  return { checkpoint, wrapAssist, wrapCompleteAssistance, wrapSendInteraction, run };
}

interface SessionEstablishArgs {
  assist: BaseCollectContext["assist"];
  capture: CaptureSession | null;
  checkpoint: SessionCheckpointFn;
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
 *
 * The runtime frames the window with a `begin` checkpoint before delegating
 * and a `probe` checkpoint around the read-only probe path so the watchdog
 * has progress markers even for connectors that do not checkpoint themselves.
 */
async function establishSession(
  hooks: {
    ensureSession: ((args: EnsureSessionArgs) => Promise<void>) | undefined;
    probeSession: ((args: ProbeSessionArgs) => Promise<boolean>) | undefined;
  },
  args: SessionEstablishArgs
): Promise<void> {
  const { ensureSession, probeSession } = hooks;
  const { assist, capture, checkpoint, completeAssistance, context, page, name, sendInteraction, progress } = args;

  await checkpoint("session-establish:begin");

  if (typeof ensureSession === "function") {
    try {
      await ensureSession({
        assist,
        capture,
        checkpoint,
        completeAssistance,
        context,
        page,
        sendInteraction,
        progress,
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TerminalError(`${name}_session_failed: ${message}`, false);
    }
  }

  if (typeof probeSession !== "function") {
    return;
  }
  await checkpoint("session-establish:probe");
  if (await probeSession({ context, page })) {
    return;
  }

  await manualAction(
    {
      page,
      reason: "login",
      message: `${name} session expired. Open the browser and re-authenticate, then continue.`,
      timeoutSeconds: 1800,
    },
    sendInteraction
  );
  await checkpoint("session-establish:probe-after-manual");
  if (await probeSession({ context, page })) {
    return;
  }

  throw new TerminalError(`${name}_session_required`, false);
}

// ─── Playwright tracing helper ──────────────────────────────────────────

interface Tracer {
  checkpoint(label: string): Promise<void>;
  markSucceeded(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Best-effort check that the underlying browser is still connected.
 * Patchright exposes `context.browser()?.isConnected()`; we tolerate any
 * shape by treating an unknown answer as "connected" so this guard never
 * silently disables a working trace stop.
 */
export function isContextDisconnected(context: Pick<BrowserContext, "browser">): boolean {
  try {
    const browser = context.browser?.();
    if (!browser) {
      return false;
    }
    if (typeof browser.isConnected === "function") {
      return browser.isConnected() === false;
    }
  } catch {
    // If the bridge itself throws, treat that as a disconnect signal.
    return true;
  }
  return false;
}

/**
 * Start/stop Playwright tracing. With raw fixture capture active, traces are
 * flushed as chunks at every fixture checkpoint so a later browser/context
 * closure does not destroy the entire diagnostic artifact.
 *
 * Storage note: traces with screenshots+snapshots+sources can be 20–100 MB per
 * run. To keep the on-disk footprint bounded, written trace chunks are deleted
 * after a clean run (markSucceeded() called before stop()) and retained on
 * failure for post-mortem debugging.
 */
export function makeTracer(context: BrowserContext, name: string, capture: CaptureSession | null): Tracer {
  const enabled = process.env.PDPP_TRACE === "1" || capture !== null;
  const traceName = `${name}-${new Date().toISOString().replace(TRACE_TIMESTAMP_UNSAFE, "-")}`;
  const tracePath = capture ? join(capture.baseDir, "traces", `${traceName}.zip`) : `/tmp/${traceName}.zip`;
  const traceBaseDir = capture ? join(capture.baseDir, "traces") : null;
  const tracing = context.tracing as BrowserContext["tracing"] & {
    startChunk?: (options?: { title?: string }) => Promise<void>;
    stopChunk?: (options?: { path?: string }) => Promise<void>;
  };
  let started = false;
  let chunkStarted = false;
  let chunkSeq = 0;
  let succeeded = false;
  const writtenTraceFiles: string[] = [];

  const safeChunkLabel = (label: string): string =>
    String(label)
      .replace(/[^A-Za-z0-9_.-]/g, "_")
      .slice(0, 80);

  const writeTraceDiagnostic = (phase: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[trace] ${phase} failed: ${message}\n`);
    if (!traceBaseDir) {
      return;
    }
    try {
      writeFileSync(
        join(traceBaseDir, `${traceName}-${String(chunkSeq).padStart(3, "0")}-${safeChunkLabel(phase)}.error.json`),
        JSON.stringify(
          {
            captured_at: new Date().toISOString(),
            error: message,
            phase,
          },
          null,
          2
        )
      );
    } catch {
      // Diagnostics must never affect the connector outcome.
    }
  };

  const startChunk = async (label: string): Promise<void> => {
    if (!traceBaseDir || typeof tracing.startChunk !== "function") {
      return;
    }
    try {
      await tracing.startChunk({ title: `${traceName}:${label}` });
      chunkStarted = true;
    } catch (err) {
      chunkStarted = false;
      writeTraceDiagnostic("start-chunk", err);
    }
  };

  const stopChunk = async (label: string): Promise<void> => {
    if (!(traceBaseDir && chunkStarted) || typeof tracing.stopChunk !== "function") {
      return;
    }
    chunkSeq += 1;
    const path = join(traceBaseDir, `${traceName}-${String(chunkSeq).padStart(3, "0")}-${safeChunkLabel(label)}.zip`);
    try {
      await tracing.stopChunk({ path });
      writtenTraceFiles.push(path);
    } catch (err) {
      writeTraceDiagnostic(`stop-chunk-${safeChunkLabel(label)}`, err);
    } finally {
      chunkStarted = false;
    }
  };

  const deleteWrittenTraces = (): void => {
    for (const path of writtenTraceFiles) {
      try {
        rmSync(path, { force: true });
      } catch (err) {
        writeTraceDiagnostic("delete-on-success", err);
      }
    }
    writtenTraceFiles.length = 0;
  };

  return {
    async start(): Promise<void> {
      if (!enabled) {
        return;
      }
      try {
        // Max-fidelity flags: screenshots+snapshots+sources. Expect ~20–100 MB
        // per run; retain-on-failure (see stop()) keeps the disk cost bounded.
        await context.tracing.start({
          name: traceName,
          screenshots: true,
          snapshots: true,
          sources: true,
        });
        started = true;
      } catch (err) {
        writeTraceDiagnostic("start", err);
        return;
      }
      await startChunk("start");
      process.stderr.write(
        `[trace] tracing enabled; ${traceBaseDir ? `writing chunks under ${traceBaseDir}` : `will write ${tracePath} on exit`}\n`
      );
    },
    async checkpoint(label: string): Promise<void> {
      if (!(enabled && started && traceBaseDir) || typeof tracing.startChunk !== "function") {
        return;
      }
      await stopChunk(label);
      await startChunk(label);
    },
    markSucceeded(): void {
      succeeded = true;
    },
    async stop(): Promise<void> {
      if (!(enabled && started)) {
        return;
      }
      started = false; // idempotent: SIGTERM finalize + finally block both call stop().
      // If the browser is already disconnected (CDP transport drop), the
      // server has buffered events we can't retrieve. Skip the stop call
      // and keep the chunks we've already written rather than throwing a
      // noisy "Target page, context or browser has been closed".
      if (isContextDisconnected(context)) {
        finalizeDisconnected();
        return;
      }
      try {
        if (traceBaseDir && typeof tracing.stopChunk === "function") {
          await stopChunkedTrace();
          return;
        }
        await stopSingleTrace();
      } catch (err) {
        writeTraceDiagnostic("stop", err);
      }
    },
  };

  function finalizeDisconnected(): void {
    writeTraceDiagnostic("stop-disconnected", new Error("browser disconnected before trace stop"));
    if (!traceBaseDir) {
      return;
    }
    if (succeeded) {
      deleteWrittenTraces();
      process.stderr.write(
        `[trace] run succeeded but browser disconnected; trace chunks deleted from ${traceBaseDir}\n`
      );
    } else {
      process.stderr.write(`[trace] browser disconnected before stop; chunks retained under ${traceBaseDir}\n`);
    }
  }

  async function stopChunkedTrace(): Promise<void> {
    await stopChunk("final");
    await context.tracing.stop();
    if (succeeded) {
      deleteWrittenTraces();
      process.stderr.write(`[trace] run succeeded; trace chunks deleted from ${traceBaseDir}\n`);
    } else {
      process.stderr.write(`[trace] run failed; trace chunks retained under ${traceBaseDir}\n`);
    }
  }

  async function stopSingleTrace(): Promise<void> {
    await context.tracing.stop({ path: tracePath });
    if (!succeeded) {
      process.stderr.write(`[trace] run failed; trace retained at ${tracePath}\n`);
      return;
    }
    try {
      rmSync(tracePath, { force: true });
      process.stderr.write(`[trace] run succeeded; trace deleted (${tracePath})\n`);
    } catch (err) {
      writeTraceDiagnostic("delete-on-success", err);
    }
  }
}
