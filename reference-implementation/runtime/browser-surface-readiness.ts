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

import type { BrowserSurface } from "@opendatalabs/remote-surface/leases";

export const BROWSER_SURFACE_READINESS_PROBE_CODES = [
  "browser_surface_not_ready",
  "browser_surface_cdp_unreachable",
  "browser_surface_cdp_disconnected",
  "browser_surface_page_stale",
  "browser_surface_probe_timeout",
] as const;

export type BrowserSurfaceReadinessProbeCode = (typeof BROWSER_SURFACE_READINESS_PROBE_CODES)[number];

export interface BrowserSurfaceReadinessProbeSuccess {
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

type TargetListProjectionResult =
  | {
      readonly ok: true;
      readonly pageTargetCount: number;
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
}

export interface MidWaitSurfaceLossDetectorOptions {
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

  function scheduleNextPoll(): void {
    if (cancelled) {
      return;
    }
    timerId = setTimeout(() => {
      if (cancelled) {
        return;
      }
      probe
        .probe(surface)
        .then((result) => {
          if (cancelled) {
            return;
          }
          if (result.ok) {
            scheduleNextPoll();
          } else {
            resolveFailure(result);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) {
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          resolveFailure({
            ok: false,
            code: "browser_surface_cdp_unreachable",
            detail: `mid-wait surface poll threw: ${message}`,
          });
        });
    }, pollIntervalMs);
  }

  scheduleNextPoll();

  return {
    lossPromise,
    cancel() {
      cancelled = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    },
  };
}

/**
 * Build a probe that talks to the surface's `cdp_url` as a Chrome DevTools
 * HTTP base (the same shape `chrome --remote-debugging-port` exposes and
 * the same shape `n.eko` proxies through its `/cdp` mount). It performs:
 *
 *   GET <cdp_url>/json/version          → proves DevTools is live + reachable.
 *   GET <cdp_url>/json/list             → proves at least one page target exists.
 *   PUT <cdp_url>/json/new?about:blank  → proves Chromium can create a target.
 *
 * Both must succeed within `timeoutMs` and the response shapes must match
 * the documented DevTools contract. Anything else is fail-closed.
 */
export function createDefaultBrowserSurfaceReadinessProbe(
  options: CreateDefaultBrowserSurfaceReadinessProbeOptions = {}
): BrowserSurfaceReadinessProbe {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_SURFACE_READINESS_PROBE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("browser surface readiness probe timeoutMs must be a positive integer");
  }
  return {
    probe(surface) {
      return probeBrowserSurfaceReadinessOverHttp(surface, fetchImpl, timeoutMs);
    },
  };
}

export async function probeBrowserSurfaceReadinessOverHttp(
  surface: BrowserSurface,
  fetchImpl: typeof fetch,
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

  const targetCreateResult = await createAndCloseSmokeTarget(baseUrl, fetchImpl, timeoutMs);
  if (!targetCreateResult.ok) {
    return targetCreateResult.failure;
  }

  const browserVersion = typeof versionPayload.Browser === "string" ? versionPayload.Browser : undefined;

  return {
    ok: true,
    pageTargetCount: targetListProjection.pageTargetCount,
    ...(browserVersion ? { browserVersion } : {}),
  };
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
  if (pageTargets.length === 0) {
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

  return { ok: true, pageTargetCount: pageTargets.length };
}

async function createAndCloseSmokeTarget(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<FetchOk | FetchErr> {
  const createResult = await fetchJsonWithBudget(`${baseUrl}json/new?about:blank`, fetchImpl, timeoutMs, {
    method: "PUT",
  });
  if (!createResult.ok) {
    return createResult;
  }
  const createdTarget = createResult.payload;
  if (!isUsablePageTarget(createdTarget)) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "browser_surface_page_stale",
        detail: `cdp_url ${baseUrl}json/new?about:blank did not return a usable page target`,
      },
    };
  }

  const closeResult = await fetchOkWithBudget(
    `${baseUrl}json/close/${encodeURIComponent(createdTarget.id)}`,
    fetchImpl,
    timeoutMs
  );
  if (!closeResult.ok) {
    return closeResult;
  }
  return { ok: true, payload: createdTarget };
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

async function fetchOkWithBudget(
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
    return { ok: true, payload: null };
  } finally {
    clearTimeout(timer);
  }
}
