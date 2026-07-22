// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-surface readiness probe.
 *
 * The lease manager declares a surface `ready` once the allocator (n.eko or a
 * test fake) reports `health: "ready"`. That's an allocator-level claim. It
 * does NOT prove that:
 *
 *   - the surface's `cdp_url` actually answers HTTP requests right now,
 *   - DevTools is listening and willing to enumerate page targets,
 *   - any usable page targets exist (a freshly-spawned surface with the
 *     Chromium process still bootstrapping returns an empty list),
 *   - the CDP HTTP socket will stay live past the manual-action wait that
 *     a Chase / USAA / ChatGPT OTP run inevitably triggers.
 *
 * The observed failure mode in the field looks like this:
 *
 *   1. Controller grants the lease, stamps env into the connector child.
 *   2. Connector launches Patchright against `cdp_url`, drives login.
 *   3. Connector emits a `manual_action` INTERACTION and awaits the human.
 *   4. The n.eko container or the inner Chromium drops the CDP socket
 *      (container restart, OOM-kill, navigation race, etc).
 *   5. The connector's awaiting Playwright handle eventually rejects with
 *      `Target page, context or browser has been closed` or
 *      `browser_disconnected` — *after* the human has already typed the OTP.
 *
 * That's the worst kind of failure: a one-shot OTP burned, no machine-
 * actionable signal until after the human has done the irreplaceable work.
 *
 * This module adds a preflight gate between "allocator says ready" and
 * "connector child gets the env block". It returns typed, machine-actionable
 * codes so a single failed live run yields enough evidence to fix the
 * surface before re-asking the owner for an OTP:
 *
 *   - `browser_surface_not_ready`        — surface health is not `ready`,
 *                                          or `cdp_url` is missing/malformed.
 *   - `browser_surface_cdp_unreachable`  — HTTP probe to the CDP HTTP base
 *                                          failed (timeout, refused, network).
 *   - `browser_surface_cdp_disconnected` — endpoint responded but not with a
 *                                          live DevTools surface (HTTP error,
 *                                          malformed JSON, missing fields).
 *   - `browser_surface_page_stale`       — DevTools enumerated zero usable
 *                                          page targets, or only closed /
 *                                          devtools:// internal targets.
 *   - `browser_surface_probe_timeout`    — overall probe budget exceeded.
 *
 * The probe is best-effort *for non-browser-required runs*: the controller
 * only invokes it when a `BrowserSurface` is being handed to the connector.
 * Connectors that don't need a managed surface skip this entirely.
 */

import { createHash } from "node:crypto";
import type { BrowserSurface } from "@opendatalabs/remote-surface/leases";

export const BROWSER_SURFACE_READINESS_PROBE_CODES = [
  "browser_surface_not_ready",
  "browser_surface_cdp_unreachable",
  "browser_surface_cdp_disconnected",
  "browser_surface_window_settle_unavailable",
  "browser_surface_page_stale",
  "browser_surface_probe_timeout",
] as const;

export type BrowserSurfaceReadinessProbeCode = (typeof BROWSER_SURFACE_READINESS_PROBE_CODES)[number];

export interface BrowserSurfaceReadinessProbeSuccess {
  readonly browserGenerationHash?: string;
  readonly browserVersion?: string;
  readonly ok: true;
  readonly pageTargetCount: number;
}

export interface BrowserSurfaceReadinessProbeFailure {
  readonly code: BrowserSurfaceReadinessProbeCode;
  readonly detail: string;
  readonly ok: false;
}

export type BrowserSurfaceReadinessProbeResult =
  | BrowserSurfaceReadinessProbeSuccess
  | BrowserSurfaceReadinessProbeFailure;

export interface BrowserSurfaceReadinessProbe {
  probe(surface: BrowserSurface): Promise<BrowserSurfaceReadinessProbeResult>;
}

interface DevtoolsVersionPayload {
  readonly Browser?: unknown;
  readonly webSocketDebuggerUrl?: unknown;
}

interface DevtoolsTargetPayload {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly url?: unknown;
  readonly webSocketDebuggerUrl?: unknown;
}

interface UsableDevtoolsPageTarget {
  readonly id: string;
  readonly type: "page";
  readonly url?: unknown;
  readonly webSocketDebuggerUrl: string;
}

interface DevtoolsPageGetFrameTreeResult {
  readonly frameTree?: {
    readonly frame?: unknown;
  };
}

export interface BrowserSurfaceReadinessWebSocketLike {
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { readonly data?: unknown }) => void
  ): void;
  close(): void;
  send(data: string): void;
}

export type BrowserSurfaceReadinessWebSocketFactory = (url: string) => BrowserSurfaceReadinessWebSocketLike;

type TargetListProjectionResult =
  | {
      readonly ok: true;
      readonly pageTargetCount: number;
      readonly pageTarget: UsableDevtoolsPageTarget;
    }
  | {
      readonly failure: BrowserSurfaceReadinessProbeFailure;
      readonly ok: false;
    };

export const DEFAULT_BROWSER_SURFACE_READINESS_PROBE_TIMEOUT_MS = 5000;
export const DEFAULT_MID_WAIT_SURFACE_LOSS_POLL_INTERVAL_MS = 10_000;

export interface CreateDefaultBrowserSurfaceReadinessProbeOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly webSocketFactory?: BrowserSurfaceReadinessWebSocketFactory;
}

export interface MidWaitSurfaceLossDetectorOptions {
  /** Generic observation hook; it runs after a successful probe and before the next poll is scheduled. */
  readonly onProbeResult?: (result: BrowserSurfaceReadinessProbeResult) => Promise<void> | void;
  readonly pollIntervalMs?: number;
}

export interface MidWaitSurfaceLossDetector {
  /** Stop polling. Safe to call multiple times. */
  cancel(): void;
  /**
   * Resolves with the first failing probe result, or never resolves if the
   * surface stays live until `cancel()` is called.
   */
  readonly lossPromise: Promise<BrowserSurfaceReadinessProbeFailure>;
}

/**
 * Create a detector that polls a browser surface during an open interaction
 * wait and resolves `lossPromise` with the first failing probe result.
 *
 * Callers race `lossPromise` against the owner-response promise and cancel
 * the detector when the race settles (either the owner responded or the
 * surface died).
 */
export function createMidWaitSurfaceLossDetector(
  surface: BrowserSurface,
  probe: BrowserSurfaceReadinessProbe,
  options: MidWaitSurfaceLossDetectorOptions = {}
): MidWaitSurfaceLossDetector {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_MID_WAIT_SURFACE_LOSS_POLL_INTERVAL_MS;

  let cancelled = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let resolveFailure!: (failure: BrowserSurfaceReadinessProbeFailure) => void;

  const lossPromise = new Promise<BrowserSurfaceReadinessProbeFailure>((resolve) => {
    resolveFailure = resolve;
  });

  function resolveSurfaceLoss(failure: BrowserSurfaceReadinessProbeFailure): void {
    if (cancelled) {
      return;
    }
    resolveFailure(failure);
  }

  async function handlePollResult(result: BrowserSurfaceReadinessProbeResult): Promise<void> {
    if (cancelled) {
      return;
    }
    if (result.ok) {
      await options.onProbeResult?.(result);
      scheduleNextPoll();
    } else {
      resolveSurfaceLoss(result);
    }
  }

  function pollErrorToFailure(err: unknown): BrowserSurfaceReadinessProbeFailure {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "browser_surface_cdp_unreachable",
      detail: `mid-wait surface poll threw: ${message}`,
    };
  }

  function handlePollError(err: unknown): void {
    if (cancelled) {
      return;
    }
    resolveSurfaceLoss(pollErrorToFailure(err));
  }

  function runScheduledPoll(): void {
    if (cancelled) {
      return;
    }
    probe.probe(surface).then(handlePollResult).catch(handlePollError);
  }

  function scheduleNextPoll(): void {
    if (cancelled) {
      return;
    }
    timerId = setTimeout(runScheduledPoll, pollIntervalMs);
  }

  function clearScheduledPoll(): void {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  scheduleNextPoll();

  return {
    lossPromise,
    cancel() {
      cancelled = true;
      clearScheduledPoll();
    },
  };
}

/**
 * Build a probe that talks to the surface's `cdp_url` as a Chrome DevTools
 * HTTP base (the same shape `chrome --remote-debugging-port` exposes and
 * the same shape `n.eko` proxies through its `/cdp` mount). It performs:
 *
 *   GET    <cdp_url>/json/version       → proves DevTools is live + reachable.
 *   GET    <cdp_url>/json/list          → proves at least one page target exists.
 *   GET    <cdp_url>/pdpp/window-settle → proves the live n.eko surface
 *                                          exposes the required, read-only
 *                                          window-settlement behavior.
 *   WS cmd <page-target>.webSocket...   → proves an existing page target
 *                                        accepts a semantic CDP command.
 *
 * Both must succeed within `timeoutMs` and the response shapes must match
 * the documented DevTools contract. Anything else is fail-closed.
 */
export function createDefaultBrowserSurfaceReadinessProbe(
  options: CreateDefaultBrowserSurfaceReadinessProbeOptions = {}
): BrowserSurfaceReadinessProbe {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const webSocketFactory =
    options.webSocketFactory ??
    ((url: string) => {
      const WebSocketCtor = globalThis.WebSocket;
      if (typeof WebSocketCtor !== "function") {
        throw new Error("browser surface readiness probe requires a WebSocket factory");
      }
      return new WebSocketCtor(url);
    });
  const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_SURFACE_READINESS_PROBE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("browser surface readiness probe timeoutMs must be a positive integer");
  }
  return {
    probe(surface) {
      return probeBrowserSurfaceReadinessOverHttp(surface, fetchImpl, webSocketFactory, timeoutMs);
    },
  };
}

export async function probeBrowserSurfaceReadinessOverHttp(
  surface: BrowserSurface,
  fetchImpl: typeof fetch,
  webSocketFactory: BrowserSurfaceReadinessWebSocketFactory,
  timeoutMs: number
): Promise<BrowserSurfaceReadinessProbeResult> {
  const notReady = validateSurfaceShape(surface);
  if (notReady) {
    return notReady;
  }

  const baseUrl = normalizeCdpBase(surface.cdp_url);

  const versionResult = await fetchJsonWithBudget(`${baseUrl}json/version`, fetchImpl, timeoutMs);
  if (!versionResult.ok) {
    return versionResult.failure;
  }
  const versionPayload = versionResult.payload as DevtoolsVersionPayload | null;
  if (
    !versionPayload ||
    typeof versionPayload !== "object" ||
    typeof versionPayload.webSocketDebuggerUrl !== "string"
  ) {
    return {
      ok: false,
      code: "browser_surface_cdp_disconnected",
      detail: `cdp_url ${baseUrl}json/version returned a payload without webSocketDebuggerUrl`,
    };
  }

  const targetsResult = await fetchJsonWithBudget(`${baseUrl}json/list`, fetchImpl, timeoutMs);
  if (!targetsResult.ok) {
    return targetsResult.failure;
  }
  const targetListProjection = projectUsablePageTargetCount(baseUrl, targetsResult.payload);
  if (!targetListProjection.ok) {
    return targetListProjection.failure;
  }

  return completeReadinessProbe({
    baseUrl,
    fetchImpl,
    targetListProjection,
    timeoutMs,
    versionPayload,
    webSocketFactory,
  });
}

interface CompleteReadinessProbeInput {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly targetListProjection: Extract<TargetListProjectionResult, { ok: true }>;
  readonly timeoutMs: number;
  readonly versionPayload: DevtoolsVersionPayload;
  readonly webSocketFactory: BrowserSurfaceReadinessWebSocketFactory;
}

async function completeReadinessProbe(input: CompleteReadinessProbeInput): Promise<BrowserSurfaceReadinessProbeResult> {
  const windowSettleFailure = await probeWindowSettleBehavior(input.baseUrl, input.fetchImpl, input.timeoutMs);
  if (windowSettleFailure) {
    return windowSettleFailure;
  }

  const targetCommandResult = await probeSemanticPageTarget(
    input.targetListProjection.pageTarget,
    input.webSocketFactory,
    input.timeoutMs
  );
  if (!targetCommandResult.ok) {
    return targetCommandResult.failure;
  }

  const browserVersion = typeof input.versionPayload.Browser === "string" ? input.versionPayload.Browser : undefined;
  const browserGenerationHash = deriveBrowserGenerationHash(
    browserVersion,
    input.versionPayload.webSocketDebuggerUrl as string
  );

  return {
    browserGenerationHash,
    ok: true,
    pageTargetCount: input.targetListProjection.pageTargetCount,
    ...(browserVersion ? { browserVersion } : {}),
  };
}

async function probeWindowSettleBehavior(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<BrowserSurfaceReadinessProbeFailure | null> {
  // This endpoint is an observational X/window status read. Never attach
  // synthetic dimensions: explicit viewport operations own presentation
  // mutations, while capability evidence is a single no-query request.
  const settleResult = await fetchJsonWithBudget(`${baseUrl}pdpp/window-settle`, fetchImpl, timeoutMs);
  if (!settleResult.ok) {
    return { ...settleResult.failure, code: "browser_surface_window_settle_unavailable" };
  }
  if (isWindowSettleStatus(settleResult.payload) && settleResult.payload.settled === true) {
    return null;
  }
  return {
    ok: false,
    code: "browser_surface_window_settle_unavailable",
    detail: `cdp_url ${baseUrl}pdpp/window-settle returned an invalid status`,
  };
}

function deriveBrowserGenerationHash(browserVersion: string | undefined, webSocketDebuggerUrl: string): string {
  return createHash("sha256")
    .update(`browser-cdp-generation\0${browserVersion ?? ""}\0${webSocketDebuggerUrl}`, "utf8")
    .digest("hex");
}

function validateSurfaceShape(surface: BrowserSurface): BrowserSurfaceReadinessProbeFailure | null {
  if (surface.health !== "ready") {
    return {
      ok: false,
      code: "browser_surface_not_ready",
      detail: `surface ${surface.surface_id} health is ${surface.health}`,
    };
  }
  const cdpUrl = surface.cdp_url;
  if (typeof cdpUrl !== "string" || cdpUrl.length === 0) {
    return {
      ok: false,
      code: "browser_surface_not_ready",
      detail: `surface ${surface.surface_id} has no cdp_url`,
    };
  }
  try {
    const parsed = new URL(cdpUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        code: "browser_surface_not_ready",
        detail: `surface ${surface.surface_id} cdp_url scheme ${parsed.protocol} is not http(s)`,
      };
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      code: "browser_surface_not_ready",
      detail: `surface ${surface.surface_id} cdp_url is unparseable: ${message}`,
    };
  }
  return null;
}

function normalizeCdpBase(cdpUrl: string): string {
  return cdpUrl.endsWith("/") ? cdpUrl : `${cdpUrl}/`;
}

function isWindowSettleStatus(value: unknown): value is { settled: boolean; width: number; height: number } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const status = value as { settled?: unknown; width?: unknown; height?: unknown };
  return (
    typeof status.settled === "boolean" &&
    Number.isInteger(status.width) &&
    (status.width as number) > 0 &&
    Number.isInteger(status.height) &&
    (status.height as number) > 0
  );
}

function isUsablePageTarget(entry: unknown): entry is UsableDevtoolsPageTarget {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const candidate = entry as DevtoolsTargetPayload;
  if (typeof candidate.type !== "string" || candidate.type !== "page") {
    return false;
  }
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    return false;
  }
  if (typeof candidate.webSocketDebuggerUrl !== "string" || candidate.webSocketDebuggerUrl.length === 0) {
    return false;
  }
  if (typeof candidate.url === "string" && candidate.url.startsWith("devtools://")) {
    return false;
  }
  return true;
}

function isValidFrameTreeResult(result: unknown): result is DevtoolsPageGetFrameTreeResult {
  if (!result || typeof result !== "object") {
    return false;
  }
  const candidate = result as DevtoolsPageGetFrameTreeResult;
  if (!candidate.frameTree || typeof candidate.frameTree !== "object") {
    return false;
  }
  if (!candidate.frameTree.frame || typeof candidate.frameTree.frame !== "object") {
    return false;
  }
  return true;
}

function projectUsablePageTargetCount(baseUrl: string, targets: unknown): TargetListProjectionResult {
  if (!Array.isArray(targets)) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "browser_surface_cdp_disconnected",
        detail: `cdp_url ${baseUrl}json/list did not return a target array`,
      },
    };
  }

  const pageTargets = targets.filter((entry): entry is UsableDevtoolsPageTarget => isUsablePageTarget(entry));
  const [pageTarget] = pageTargets;
  if (!pageTarget) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "browser_surface_page_stale",
        detail:
          targets.length === 0
            ? `cdp_url ${baseUrl}json/list reported zero targets`
            : `cdp_url ${baseUrl}json/list reported ${String(targets.length)} target(s) but none are usable page targets`,
      },
    };
  }

  return { ok: true, pageTargetCount: pageTargets.length, pageTarget };
}

async function probeSemanticPageTarget(
  target: UsableDevtoolsPageTarget,
  webSocketFactory: BrowserSurfaceReadinessWebSocketFactory,
  timeoutMs: number
): Promise<FetchOk | FetchErr> {
  let socket: BrowserSurfaceReadinessWebSocketLike | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const commandId = 1;
  const detailPrefix = `page target ${target.id}`;

  const finish = (result: FetchOk | FetchErr): FetchOk | FetchErr => {
    if (settled) {
      return result;
    }
    settled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      socket?.close();
    } catch {
      // Best-effort cleanup. The readiness result is already decided.
    }
    return result;
  };

  return await new Promise<FetchOk | FetchErr>((resolve) => {
    const fail = (code: BrowserSurfaceReadinessProbeCode, detail: string) => {
      resolve(
        finish({
          ok: false,
          failure: {
            ok: false,
            code,
            detail,
          },
        })
      );
    };

    const succeed = () => {
      resolve(finish({ ok: true, payload: null }));
    };

    try {
      socket = webSocketFactory(target.webSocketDebuggerUrl);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      fail("browser_surface_cdp_unreachable", `${detailPrefix} websocket open failed: ${message}`);
      return;
    }

    timer = setTimeout(() => {
      fail("browser_surface_probe_timeout", `${detailPrefix} Page.getFrameTree exceeded ${String(timeoutMs)}ms budget`);
    }, timeoutMs);

    const onOpen = () => {
      if (settled || socket === null) {
        return;
      }
      try {
        socket.send(JSON.stringify({ id: commandId, method: "Page.getFrameTree" }));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        fail("browser_surface_cdp_disconnected", `${detailPrefix} failed to send Page.getFrameTree: ${message}`);
      }
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: browser readiness message handling must keep settlement, timeout, and protocol validation together.
    const onMessage = (event: { readonly data?: unknown }) => {
      if (settled) {
        return;
      }
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        fail("browser_surface_cdp_disconnected", `${detailPrefix} returned malformed JSON: ${message}`);
        return;
      }
      if (!parsed || typeof parsed !== "object") {
        fail("browser_surface_cdp_disconnected", `${detailPrefix} returned a non-object CDP response`);
        return;
      }
      const response = parsed as {
        readonly id?: unknown;
        readonly error?: unknown;
        readonly result?: unknown;
      };
      if (response.id !== commandId) {
        return;
      }
      if (response.error !== undefined) {
        fail("browser_surface_cdp_disconnected", `${detailPrefix} returned an error for Page.getFrameTree`);
        return;
      }
      if (!isValidFrameTreeResult(response.result)) {
        fail("browser_surface_cdp_disconnected", `${detailPrefix} returned no valid Page.getFrameTree result`);
        return;
      }
      succeed();
    };

    const onError = () => {
      if (settled) {
        return;
      }
      fail("browser_surface_cdp_unreachable", `${detailPrefix} websocket error before Page.getFrameTree completed`);
    };

    const onClose = () => {
      if (settled) {
        return;
      }
      fail("browser_surface_cdp_disconnected", `${detailPrefix} websocket closed before Page.getFrameTree completed`);
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

interface FetchOk {
  readonly ok: true;
  readonly payload: unknown;
}

interface FetchErr {
  readonly failure: BrowserSurfaceReadinessProbeFailure;
  readonly ok: false;
}

async function fetchJsonWithBudget(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  init: RequestInit = {}
): Promise<FetchOk | FetchErr> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (cause) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          failure: {
            ok: false,
            code: "browser_surface_probe_timeout",
            detail: `GET ${url} exceeded ${String(timeoutMs)}ms budget`,
          },
        };
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        ok: false,
        failure: {
          ok: false,
          code: "browser_surface_cdp_unreachable",
          detail: `GET ${url} failed: ${message}`,
        },
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "browser_surface_cdp_disconnected",
          detail: `GET ${url} returned HTTP ${String(response.status)}`,
        },
      };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        ok: false,
        failure: {
          ok: false,
          code: "browser_surface_cdp_disconnected",
          detail: `GET ${url} returned malformed JSON: ${message}`,
        },
      };
    }
    return { ok: true, payload };
  } finally {
    clearTimeout(timer);
  }
}
