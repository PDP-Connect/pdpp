// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { PresentationScreenStateStore } from "../stores/presentation-screen-state-store.ts";
import { createCdpCompanion } from "./cdp-adapter.js";
import { createNekoCompanion } from "./neko-adapter.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_OPEN_TIMEOUT_MS = 5000;

/** An `Error` carrying the streaming subsystem's stable machine `code`. */
type CodedError = Error & { code?: string };

/**
 * The backend companions (`createCdpCompanion` / `createNekoCompanion`) are
 * duck-typed across an untyped `.js` boundary; the factory never depends on
 * their concrete class, only on a handful of optionally-present methods.
 */
// biome-ignore lint/suspicious/noExplicitAny: backend companions cross an untyped `.js` boundary and are duck-typed (see comment above).
type InnerCompanion = any;

/** Resolved neko target descriptor (origin + passthrough fields). */
interface NekoTarget {
  base_url: string;
  origin: string;
  [key: string]: unknown;
}

type SelectedTarget = { backend: "neko"; neko: NekoTarget } | { backend: "cdp"; wsUrl: string };

/** Diagnostic logger; methods are looked up by level name and best-effort. */
type LoggerLike = Record<string, ((entry: unknown) => void) | undefined> | null | undefined;

interface PendingRecord {
  handler: (...args: unknown[]) => unknown;
  innerUnsubscribe: (() => void) | null;
}

export interface StreamingCompanion {
  _internal: {
    hasInner(): boolean;
    isClosed(): boolean;
    getBackend(): string | null;
  };
  ackFrame(sessionId: unknown): Promise<void>;
  readonly backend: string;
  readonly browser_session_id: unknown;
  dispatch(event: unknown): Promise<void>;
  getNekoProxyTarget(): { origin: string } | null;
  onEvent(handler: (...args: unknown[]) => unknown): () => void;
  onFrame(handler: (...args: unknown[]) => unknown): () => void;
  queryNekoStatus(): Promise<unknown>;
  resolveBackend(): Promise<string>;
  start(viewport: unknown): Promise<void>;
  stop(): Promise<void>;
}

type ResolveTargetForInteraction = (runId: unknown, interactionId: unknown) => unknown;

interface ResolvedCompanionOptions {
  browser_session_id: unknown;
  commandTimeoutMs?: number | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: injected `fetch` implementation is passed opaquely to the untyped `.js` adapters.
  fetchImpl: any;
  interaction_id: unknown;
  logger?: LoggerLike;
  neko?: Record<string, unknown> | undefined;
  openTimeoutMs?: number | undefined;
  resolveTargetForInteraction: ResolveTargetForInteraction;
  run_id: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: injected WebSocket constructor is passed opaquely to the untyped `.js` adapters.
  WebSocketCtor: any;
}

interface StreamingCompanionFactoryInput {
  browser_session_id: unknown;
  interaction_id: unknown;
  run_id: unknown;
  target?: unknown;
}

type ResolvedStreamingCompanionInput = StreamingCompanionFactoryInput & {
  interaction_id: string;
  run_id: string;
};

export type StreamingCompanionFactory = (input: StreamingCompanionFactoryInput) => StreamingCompanion | null;

interface FactoryOptions {
  commandTimeoutMs?: number | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: injected `fetch` implementation is passed opaquely to the untyped `.js` adapters.
  fetchImpl?: any;
  logger?: LoggerLike;
  neko?: Record<string, unknown> | undefined;
  openTimeoutMs?: number | undefined;
  presentationScreenStateStore?: PresentationScreenStateStore | null | undefined;
  resolveTargetForInteraction?: ResolveTargetForInteraction;
  // biome-ignore lint/suspicious/noExplicitAny: injected WebSocket constructor is passed opaquely to the untyped `.js` adapters.
  WebSocketCtor?: any;
}

type NekoPresentationLifecycleFactory = (input: { browser_session_id: unknown; target: NekoTarget }) => unknown;

type NekoOptions = Record<string, unknown> & {
  createPresentationLifecycle?: NekoPresentationLifecycleFactory;
};

function createMissingTargetError(backend = "streaming"): CodedError {
  const err: CodedError = new Error(`No ${backend} target registered for this run`);
  err.code = "streaming_target_unregistered";
  return err;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasCompanionIds(input: StreamingCompanionFactoryInput): input is ResolvedStreamingCompanionInput {
  return optionalString(input.run_id) !== null && optionalString(input.interaction_id) !== null;
}

function resolveStreamingTarget(target: unknown, fallback: ResolveTargetForInteraction): ResolveTargetForInteraction {
  if (target == null) {
    return fallback;
  }
  return () => target;
}

function normalizeCdpTarget(target: unknown): string | null {
  if (typeof target === "string" && target.length > 0) {
    return target;
  }
  const targetRecord = recordOrNull(target);
  if (!targetRecord) {
    return null;
  }
  const cdp = recordOrNull(targetRecord.cdp);
  return (
    optionalString(targetRecord.wsUrl) ||
    optionalString(targetRecord.ws_url) ||
    optionalString(cdp?.wsUrl) ||
    optionalString(cdp?.ws_url)
  );
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function nekoTargetSource(target: unknown): Record<string, unknown> | null {
  const targetRecord = recordOrNull(target);
  if (!targetRecord) {
    return null;
  }
  return recordOrNull(targetRecord.neko) ?? targetRecord;
}

function nekoTargetOrigin(source: Record<string, unknown>, target: Record<string, unknown>): string | null {
  return (
    [source.origin, source.base_url, source.baseUrl, target.base_url, target.baseUrl]
      .map(optionalString)
      .find(Boolean) ?? null
  );
}

function normalizeNekoTarget(target: unknown): NekoTarget | null {
  const targetRecord = recordOrNull(target);
  const source = nekoTargetSource(target);
  if (!(targetRecord && source)) {
    return null;
  }
  const origin = nekoTargetOrigin(source, targetRecord);
  if (!origin) {
    return null;
  }
  return { ...source, origin, base_url: origin };
}

function explicitNekoTarget(target: unknown): SelectedTarget | null {
  if (recordOrNull(target)?.backend !== "neko") {
    return null;
  }
  const neko = normalizeNekoTarget(target);
  if (!neko) {
    throw createMissingTargetError("n.eko");
  }
  return { backend: "neko", neko };
}

function selectBackendTarget(target: unknown): SelectedTarget {
  const backend = optionalString(recordOrNull(target)?.backend);
  const explicitNeko = explicitNekoTarget(target);
  if (explicitNeko) {
    return explicitNeko;
  }
  const wsUrl = normalizeCdpTarget(target);
  if (wsUrl) {
    return { backend: "cdp", wsUrl };
  }

  const neko = normalizeNekoTarget(target);
  if (neko) {
    return { backend: "neko", neko };
  }

  throw createMissingTargetError(backend || "streaming");
}

function safeLog(logger: LoggerLike, level: string, msg: string, data?: Record<string, unknown>): void {
  if (!logger || typeof logger[level] !== "function") {
    return;
  }
  try {
    logger[level]?.({ msg, ...(data || {}) });
  } catch {
    /* logger errors must not break the streaming path */
  }
}

function createResolvedCompanion({
  run_id,
  interaction_id,
  browser_session_id,
  resolveTargetForInteraction,
  WebSocketCtor,
  fetchImpl,
  logger,
  commandTimeoutMs,
  openTimeoutMs,
  neko = {},
}: ResolvedCompanionOptions): StreamingCompanion {
  let inner: InnerCompanion = null;
  let closed = false;
  let backend: string | null = null;
  let nekoTarget: NekoTarget | null = null;
  const pendingFrames = new Map<(...args: unknown[]) => unknown, PendingRecord>();
  const pendingEvents = new Map<(...args: unknown[]) => unknown, PendingRecord>();

  function bindRecords(
    pending: Map<(...args: unknown[]) => unknown, PendingRecord>,
    subscribeToInner: (handler: (...args: unknown[]) => unknown) => () => void
  ): void {
    for (const record of pending.values()) {
      record.innerUnsubscribe = subscribeToInner(record.handler);
    }
  }

  function bindPending(next: InnerCompanion): void {
    inner = next;
    bindRecords(pendingFrames, inner.onFrame.bind(inner));
    if (typeof inner.onEvent === "function") {
      bindRecords(pendingEvents, inner.onEvent.bind(inner));
    }
  }

  function unsubscribePending(
    pending: Map<(...args: unknown[]) => unknown, PendingRecord>,
    handler: (...args: unknown[]) => unknown,
    record: PendingRecord
  ): void {
    pending.delete(handler);
    if (!record.innerUnsubscribe) {
      return;
    }
    try {
      record.innerUnsubscribe();
    } catch {
      /* unsubscribe is best-effort */
    }
  }

  function subscribe(
    pending: Map<(...args: unknown[]) => unknown, PendingRecord>,
    method: string,
    handler: (...args: unknown[]) => unknown
  ): () => void {
    if (inner && typeof inner[method] === "function") {
      return inner[method](handler);
    }
    const record: PendingRecord = { handler, innerUnsubscribe: null };
    pending.set(handler, record);
    return () => unsubscribePending(pending, handler, record);
  }

  function createInnerCompanion(selected: SelectedTarget): InnerCompanion {
    if (selected.backend === "neko") {
      nekoTarget = selected.neko;
      const { createPresentationLifecycle } = (neko as NekoOptions);
      return createNekoCompanion({
        ...neko,
        target: selected.neko,
        origin: selected.neko.origin,
        browser_session_id,
        fetchImpl,
        WebSocketCtor,
        logger,
        ...(typeof createPresentationLifecycle === "function"
          ? {
              presentationLifecycle: createPresentationLifecycle({
                browser_session_id,
                target: selected.neko,
              }),
            }
          : {}),
      });
    }
    return createCdpCompanion({
      wsUrl: selected.wsUrl,
      browser_session_id,
      WebSocketCtor,
      logger,
      commandTimeoutMs,
      openTimeoutMs,
      // biome-ignore lint/suspicious/noExplicitAny: cast defeats the untyped `.js` adapter's too-narrow inferred option shape without changing runtime values.
    } as any);
  }

  async function ensureInner(): Promise<InnerCompanion> {
    if (inner) {
      return inner;
    }
    const resolved = await Promise.resolve(resolveTargetForInteraction(run_id, interaction_id));
    if (!resolved) {
      throw createMissingTargetError();
    }

    const selected = selectBackendTarget(resolved);
    ({ backend: backend } = selected);
    safeLog(logger, "info", "streaming_backend_selected", {
      run_id,
      interaction_id,
      browser_session_id,
      backend,
    });
    bindPending(createInnerCompanion(selected));
    return inner;
  }

  return {
    get backend() {
      return backend || inner?.backend || "cdp";
    },
    async resolveBackend() {
      const companion = await ensureInner();
      return companion.backend || backend || "cdp";
    },
    browser_session_id,
    async start(viewport) {
      if (closed) {
        const err: CodedError = new Error("Streaming companion is closed");
        err.code = "companion_closed";
        throw err;
      }
      const companion = await ensureInner();
      await companion.start(viewport);
    },
    async stop() {
      if (closed) {
        return;
      }
      closed = true;
      if (inner) {
        await inner.stop();
      }
      pendingFrames.clear();
      pendingEvents.clear();
    },
    onFrame(handler) {
      return subscribe(pendingFrames, "onFrame", handler);
    },
    onEvent(handler) {
      return subscribe(pendingEvents, "onEvent", handler);
    },
    async dispatch(event) {
      const companion = await ensureInner();
      await companion.dispatch(event);
    },
    async ackFrame(sessionId) {
      if (!inner || typeof inner.ackFrame !== "function") {
        return;
      }
      await inner.ackFrame(sessionId);
    },
    async queryNekoStatus() {
      const companion = await ensureInner();
      if (typeof companion.queryNekoStatus !== "function") {
        return null;
      }
      return companion.queryNekoStatus();
    },
    getNekoProxyTarget() {
      if (inner && typeof inner.getNekoProxyTarget === "function") {
        return inner.getNekoProxyTarget();
      }
      if (!nekoTarget) {
        return null;
      }
      return { origin: nekoTarget.origin };
    },
    /** test-only escape hatch */
    _internal: {
      hasInner: () => inner !== null,
      isClosed: () => closed,
      getBackend: () => backend,
    },
  };
}

export function createDefaultStreamingCompanionFactory({
  resolveTargetForInteraction,
  WebSocketCtor = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  logger,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
  neko,
  presentationScreenStateStore = null,
}: FactoryOptions = {}): StreamingCompanionFactory | null {
  if (typeof resolveTargetForInteraction !== "function") {
    return null;
  }
  if (typeof WebSocketCtor !== "function") {
    throw new Error("createDefaultStreamingCompanionFactory: no WebSocket constructor available");
  }

  return (input) => {
    if (!hasCompanionIds(input)) {
      return null;
    }
    return createResolvedCompanion({
      run_id: input.run_id,
      interaction_id: input.interaction_id,
      browser_session_id: input.browser_session_id,
      resolveTargetForInteraction: resolveStreamingTarget(input.target, resolveTargetForInteraction),
      WebSocketCtor,
      fetchImpl,
      logger,
      commandTimeoutMs,
      openTimeoutMs,
      neko: {
        ...(neko || {}),
        ...(presentationScreenStateStore
          ? {
              createPresentationLifecycle: ({
                browser_session_id,
                target,
              }: {
                browser_session_id: string;
                target: NekoTarget;
              }) => {
                const surfaceId = optionalString(target.surface_id);
                if (!surfaceId) {
                  return null;
                }
                return {
                  captureBaseline: ({ baseline }: { baseline: unknown }) => {
                    const normalized = configurationForPresentationLifecycle(baseline);
                    if (!normalized) {
                      throw new Error("n.eko baseline configuration is invalid");
                    }
                    return presentationScreenStateStore.captureBaseline({
                      browserSessionId: String(browser_session_id),
                      surfaceId,
                      leaseId: optionalString(target.lease_id),
                      baseline: normalized,
                      capturedAt: new Date().toISOString(),
                    });
                  },
                  markRestored: () =>
                    presentationScreenStateStore.markRestored(String(browser_session_id), new Date().toISOString()),
                };
              },
            }
          : {}),
      },
    });
  };
}

function configurationForPresentationLifecycle(
  value: unknown
): { width: number; height: number; rate?: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const width = Number(candidate.width);
  const height = Number(candidate.height);
  const rate = candidate.rate == null ? undefined : Number(candidate.rate);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  if (rate !== undefined && (!Number.isFinite(rate) || rate <= 0)) {
    return null;
  }
  return { width, height, ...(rate === undefined ? {} : { rate }) };
}
