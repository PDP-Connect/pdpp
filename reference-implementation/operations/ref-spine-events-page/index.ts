/**
 * Canonical `ref.spine.events.page` operation.
 *
 * Owns the timeline-envelope semantics for the reference-only
 * operator-console reads of `GET /_ref/traces/:traceId`,
 * `GET /_ref/grants/:grantId/timeline`, and
 * `GET /_ref/runs/:runId/timeline`. Host adapters supply a paginated
 * spine-event page via the dependency contract; the operation owns:
 *
 *   - the per-kind envelope `object` discriminator
 *     (`trace` | `grant_timeline` | `run_timeline`);
 *   - the identifying `*_id` key (`trace_id` | `grant_id` | `run_id`);
 *   - the derived `trace_id` of the page (the first event's `trace_id`,
 *     or `null` for an empty page);
 *   - the `event_count` and pagination fields (`truncated`,
 *     `next_cursor`, `limit`);
 *   - the per-event live-bearer redaction:
 *       * strip `token_id` from every event;
 *       * replace the literal `object_id` for `token`,
 *         `pending_consent`, and `owner_device_auth` events with
 *         redaction sentinels so the bearer / device_code is never
 *         echoed back;
 *       * replace `device_code` / `user_code` / `request_uri` keys
 *         inside each event's `data` map with a redaction sentinel.
 *
 * The empty-page on first cursor (`!events.length && !cursor`) is
 * surfaced via the envelope's `event_count` and empty `data`. The host
 * adapter MAY translate that signal to HTTP 404 (it does today); this
 * operation does not assume an HTTP framework.
 *
 * This is reference/operator surface, not PDPP protocol. Clients must
 * not depend on the response shape.
 *
 * Boundary rules (see openspec/changes/mount-ref-spine-operations):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, a raw SQL handle, sandbox modules,
 *   `reference-implementation/server/*` route or auth modules, or
 *   `process` / `process.env`.
 */

export type RefSpineEventsKind = "trace" | "grant" | "run";

export interface RefSpineEventInput {
  readonly token_id?: string | null;
  readonly object_type: string;
  readonly object_id: string;
  readonly trace_id?: string | null;
  readonly data?: unknown;
  readonly [key: string]: unknown;
}

export interface RefSpineEventsPageInputPagination {
  readonly events: readonly RefSpineEventInput[];
  readonly truncated: boolean;
  readonly next_cursor: string | null;
  readonly limit: number;
}

export interface RefSpineEventsPageInput {
  readonly kind: RefSpineEventsKind;
  readonly id: string;
  readonly cursor: string | null;
  readonly page: RefSpineEventsPageInputPagination;
}

export interface RefSpineEventsPageDependencies {
  /**
   * No host substrate is required at execution time — the host injects
   * the already-fetched page in `input.page`. Declared for symmetry
   * with the other operations and to keep the door open for future
   * dependency-driven hooks (e.g. metrics) without a signature break.
   */
  readonly _noop?: never;
}

export interface RefSpineEventsPageEnvelope {
  readonly object: "trace" | "grant_timeline" | "run_timeline";
  readonly trace_id: string | null;
  readonly event_count: number;
  readonly data: readonly Record<string, unknown>[];
  readonly truncated: boolean;
  readonly next_cursor: string | null;
  readonly limit: number;
  readonly [identifierKey: string]: unknown;
}

const KIND_TO_ENVELOPE_OBJECT = {
  trace: "trace",
  grant: "grant_timeline",
  run: "run_timeline",
} as const;

const KIND_TO_ID_KEY = {
  trace: "trace_id",
  grant: "grant_id",
  run: "run_id",
} as const;

/**
 * Live-bearer redaction map. The reference's `spine_events.token_id`
 * column stores the literal opaque bearer (see `auth.js::issueToken`);
 * `token.issued` events also use the bearer string as their
 * `object_id`. `pending_consent` and `owner_device_auth` events use
 * the live `device_code` as their `object_id` and `request.submitted`
 * carries `user_code` in `data`. All of these are bearer-equivalent
 * and MUST be stripped before any operator-console read leaves the
 * reference. The schema-level fix is tracked in
 * `openspec/changes/harden-reference-auth-surfaces/design-notes/
 * spine-token-id-storage-2026-04-27.md`; this projection is the
 * read-time guarantee shipped today.
 */
const REDACTED_OBJECT_ID_LITERAL_BY_TYPE: Record<string, string> = {
  token: "<redacted-token-id>",
  pending_consent: "<redacted-device-code>",
  owner_device_auth: "<redacted-device-code>",
};

const REDACTED_BEARER_DATA_KEYS: ReadonlySet<string> = new Set([
  "device_code",
  "user_code",
  "request_uri",
]);

const REDACTED_BEARER_VALUE = "<redacted-bearer>";

export function redactSpineEventForPublic(
  event: RefSpineEventInput,
): Record<string, unknown> {
  if (!event || typeof event !== "object") return event as unknown as Record<string, unknown>;
  // Strip `token_id` defensively — even if a host accidentally surfaces
  // a `null`, the field is removed from the projected event entirely.
  const { token_id: _token_id, ...rest } = event as Record<string, unknown>;
  const objectType = typeof rest.object_type === "string" ? rest.object_type : "";
  const literal = REDACTED_OBJECT_ID_LITERAL_BY_TYPE[objectType];
  if (literal && typeof rest.object_id === "string") {
    rest.object_id = literal;
  }
  if (rest.data && typeof rest.data === "object" && !Array.isArray(rest.data)) {
    let cloned: Record<string, unknown> | null = null;
    const dataObj = rest.data as Record<string, unknown>;
    for (const key of REDACTED_BEARER_DATA_KEYS) {
      if (key in dataObj) {
        if (!cloned) cloned = { ...dataObj };
        cloned[key] = REDACTED_BEARER_VALUE;
      }
    }
    if (cloned) rest.data = cloned;
  }
  return rest;
}

/**
 * Execute the canonical `ref.spine.events.page` operation.
 *
 * Hosts pass the already-fetched page (the spine read is host-side
 * because cursor decoding lives in `lib/spine.ts`); the operation
 * projects each event through the live-bearer redaction and assembles
 * the per-kind envelope. The operation has no notion of HTTP, owner
 * sessions, or framework.
 */
export function executeRefSpineEventsPage(
  input: RefSpineEventsPageInput,
  _dependencies: RefSpineEventsPageDependencies = {},
): RefSpineEventsPageEnvelope {
  const events = input.page.events;
  const traceId =
    events.find((event) => typeof event.trace_id === "string" && event.trace_id)?.trace_id ?? null;
  const idKey = KIND_TO_ID_KEY[input.kind];
  const objectKind = KIND_TO_ENVELOPE_OBJECT[input.kind];
  const data = events.map((event) => redactSpineEventForPublic(event));
  return {
    object: objectKind,
    [idKey]: input.id,
    trace_id: traceId,
    event_count: events.length,
    data,
    truncated: input.page.truncated,
    next_cursor: input.page.next_cursor,
    limit: input.page.limit,
  } as RefSpineEventsPageEnvelope;
}
