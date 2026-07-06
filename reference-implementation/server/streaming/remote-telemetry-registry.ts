/**
 * Process-local registry of remote-page telemetry sinks, keyed by runId.
 *
 * The playground's Patchright-attached page (created by
 * `createNekoRemoteCdpPlaygroundSession`) installs a `page.exposeBinding`
 * so the streamed test page can call a global `__pdppRemoteTelemetry(payload)`
 * — which Patchright relays to a JS callback in our process.
 *
 * routes.js then looks up the callback at companion-creation time and pipes
 * remote-page events into the per-session telemetry ring. We can't pass the
 * Patchright `page` through `runTargetRegistry` cleanly (it's a foreign
 * object whose lifetime is bound to the playground module), so this tiny
 * registry exists to keep that coupling small.
 *
 * Debug-only. Empty in production paths that never instantiate the playground.
 */

/** A remote-telemetry sink: receives the caller-controlled page payload. */
type RemoteTelemetrySink = (payload: unknown) => void;

const sinks = new Map<string, Set<RemoteTelemetrySink>>(); // runId → set<callback>

export function registerRemoteTelemetrySink(runId: string, callback: RemoteTelemetrySink): () => void {
  if (!runId || typeof callback !== "function") {
    return () => {
      /* no-op unsubscribe: nothing was registered */
    };
  }
  let set = sinks.get(runId);
  if (!set) {
    set = new Set();
    sinks.set(runId, set);
  }
  set.add(callback);
  return () => {
    const current = sinks.get(runId);
    if (!current) {
      return;
    }
    current.delete(callback);
    if (current.size === 0) {
      sinks.delete(runId);
    }
  };
}

export function emitRemoteTelemetry(runId: string, payload: unknown): void {
  const set = sinks.get(runId);
  if (!set || set.size === 0) {
    return;
  }
  for (const cb of set) {
    try {
      cb(payload);
    } catch {
      /* never throw back into the page-side binding */
    }
  }
}

export function dropRemoteTelemetry(runId: string): void {
  sinks.delete(runId);
}
