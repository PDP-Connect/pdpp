/**
 * Bounded seen-event registry for remote `playground.*` events.
 *
 * Two parallel polls drain the playground page's ring buffer into the
 * viewer-side debug sink: the layout poll (drains during settle) and a
 * debug-only continuous drain (post-settle). Both must dedupe against
 * each other so an event surfaced by one is not re-emitted by the
 * other.
 *
 * Seq alone is brittle: when the remote playground reloads (n.eko-
 * driven `Page.navigate`, manual reload, soft-refresh) seq restarts
 * at 1 and a high-watermark dedupe would silently drop every event
 * from the new page until seq exceeded the pre-reload watermark.
 * Composing seq with `pageId` (set once per page-load on the remote)
 * scopes dedupe to one page-load and survives reload/reincarnation
 * cleanly.
 *
 * The registry is bounded so a long session cannot leak memory: the
 * remote ring buffer caps at 24 events, so a 512-entry registry
 * covers ~21 drain intervals — far more than the layout/debug polls
 * can simultaneously hold.
 */
export const PLAYGROUND_SEEN_REGISTRY_MAX = 512;

export interface PlaygroundSeenRegistry {
  keys: Set<string>;
  order: string[];
}

export function createPlaygroundSeenRegistry(): PlaygroundSeenRegistry {
  return { keys: new Set(), order: [] };
}

export type ClaimResult = "claimed" | "duplicate" | "unkeyable";

export function claimPlaygroundEvent(
  registry: PlaygroundSeenRegistry,
  entry: Record<string, unknown> | null | undefined,
  options: { max?: number } = {}
): ClaimResult {
  if (!entry || typeof entry !== "object") {
    return "unkeyable";
  }
  const seq = typeof entry.seq === "number" && Number.isFinite(entry.seq) ? entry.seq : null;
  if (seq === null) {
    // Without a seq we cannot dedupe safely. Emit and accept the
    // (very rare) risk of a duplicate over silently dropping.
    return "claimed";
  }
  // Compose with pageId so a remote reload (which restarts seq at 1)
  // does not collide with already-seen keys from the prior page-load.
  // Fall back to "anon" only when the playground page predates the
  // pageId field; the resulting key still scopes to the seq.
  const pageId = typeof entry.pageId === "string" && entry.pageId.length > 0 ? entry.pageId : "anon";
  const key = `${pageId}:${seq}`;
  if (registry.keys.has(key)) {
    return "duplicate";
  }
  registry.keys.add(key);
  registry.order.push(key);
  const max = options.max ?? PLAYGROUND_SEEN_REGISTRY_MAX;
  while (registry.order.length > max) {
    const evicted = registry.order.shift();
    if (evicted !== undefined) {
      registry.keys.delete(evicted);
    }
  }
  return "claimed";
}
