/**
 * Canonical public read envelope adapter.
 *
 * The canonical public read contract defines a uniform envelope family with
 * `data`, `has_more`, `links`, and `meta` (see
 * `openspec/changes/canonicalize-public-read-contract/specs/...`). The
 * runtime is still landing the full envelope per-operation; until every
 * read returns it, dashboard/console code must be able to consume both:
 *
 *   - the canonical envelope ({ data, has_more, links, meta: { warnings, count } })
 *   - the current per-operation shapes ({ data, has_more, next_cursor, ... })
 *
 * This module is the single tolerant adapter. It does NOT invent backend
 * fields and it does NOT push UI-specific keys back at request time.
 * Callers stay backward-compatible: when `meta.warnings` is missing the
 * helper returns an empty array; when `links.next` is missing it returns
 * null. Consumers can render warnings only when the runtime supplies them.
 */

export interface CanonicalReadWarning {
  code: string;
  dropped_parameter?: string;
  message?: string;
}

export interface CanonicalCountMeta {
  kind: "exact" | "estimated" | "none";
  value?: number;
}

export interface CanonicalEnvelopeMeta {
  count: CanonicalCountMeta | null;
  warnings: CanonicalReadWarning[];
}

export interface CanonicalEnvelopeLinks {
  next: string | null;
  self: string | null;
}

export interface CanonicalListEnvelope<T> {
  data: T[];
  has_more: boolean;
  links: CanonicalEnvelopeLinks;
  meta: CanonicalEnvelopeMeta;
  /** Legacy cursor field still emitted by some operations. */
  next_cursor: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractMeta(value: unknown): CanonicalEnvelopeMeta {
  if (!isPlainObject(value)) {
    return { count: null, warnings: [] };
  }
  const meta = value as Record<string, unknown>;
  const warnings = Array.isArray(meta.warnings)
    ? (meta.warnings.filter(
        (w): w is CanonicalReadWarning => isPlainObject(w) && typeof w.code === "string"
      ) as CanonicalReadWarning[])
    : [];
  let count: CanonicalCountMeta | null = null;
  if (isPlainObject(meta.count)) {
    const kind = (meta.count as { kind?: unknown }).kind;
    const rawValue = (meta.count as { value?: unknown }).value;
    if (kind === "exact" || kind === "estimated" || kind === "none") {
      count = {
        kind,
        value: typeof rawValue === "number" ? rawValue : undefined,
      };
    }
  }
  return { count, warnings };
}

function extractLinks(value: unknown): CanonicalEnvelopeLinks {
  if (!isPlainObject(value)) {
    return { next: null, self: null };
  }
  const links = value as Record<string, unknown>;
  return {
    next: typeof links.next === "string" ? links.next : null,
    self: typeof links.self === "string" ? links.self : null,
  };
}

/**
 * Adapt any list-like RS response into the canonical envelope shape, while
 * preserving legacy `next_cursor` for paginators that still need it.
 *
 * Unknown extra fields on the envelope are dropped here, not rejected. The
 * contract calls for strict validation server-side, not on the client.
 */
export function adaptListEnvelope<T>(body: unknown): CanonicalListEnvelope<T> {
  const root = isPlainObject(body) ? body : {};
  const rawData = (root as { data?: unknown }).data;
  const data = Array.isArray(rawData) ? (rawData as T[]) : [];
  const hasMore = (root as { has_more?: unknown }).has_more === true;
  const nextCursor =
    typeof (root as { next_cursor?: unknown }).next_cursor === "string"
      ? (root as { next_cursor: string }).next_cursor
      : null;
  return {
    data,
    has_more: hasMore,
    next_cursor: nextCursor,
    links: extractLinks((root as { links?: unknown }).links),
    meta: extractMeta((root as { meta?: unknown }).meta),
  };
}

/**
 * Pull `meta.warnings` from any public read response (list, single, schema)
 * without coupling to envelope shape. Returns `[]` when missing or invalid.
 */
export function extractReadWarnings(body: unknown): CanonicalReadWarning[] {
  if (!isPlainObject(body)) {
    return [];
  }
  return extractMeta((body as { meta?: unknown }).meta).warnings;
}
