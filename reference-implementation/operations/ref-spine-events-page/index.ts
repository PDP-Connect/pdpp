// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 * strip `token_id` from every event;
 * replace the literal `object_id` for `token`,
 *         `pending_consent`, and `owner_device_auth` events with
 *         redaction sentinels so the bearer / device_code is never
 *         echoed back;
 * replace `device_code` / `user_code` / `request_uri` keys
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

/**
 * Window-independent terminal status for the run kind. Derived by the
 * host from the run's most-recent terminal spine event (the bounded
 * `LIMIT 1` terminal-event query), NOT from the paginated event window.
 * `null` when the run has no terminal event yet, or for the trace/grant
 * kinds (terminal status applies to runs only).
 */
export type RefSpineRunTerminalStatus = "completed" | "failed" | "cancelled" | "abandoned";

export interface RefSpineEventInput {
  readonly data?: unknown;
  readonly object_id: string;
  readonly object_type: string;
  readonly token_id?: string | null;
  readonly trace_id?: string | null;
  readonly [key: string]: unknown;
}

export interface RefSpineEventsPageInputPagination {
  readonly events: readonly RefSpineEventInput[];
  readonly limit: number;
  readonly next_cursor: string | null;
  readonly truncated: boolean;
}

export interface RefSpineEventsPageInput {
  readonly cursor: string | null;
  readonly id: string;
  readonly kind: RefSpineEventsKind;
  readonly page: RefSpineEventsPageInputPagination;
  /**
   * Run-kind only: the run's window-independent terminal status, resolved
   * host-side from the most-recent terminal spine event. Omitted/`null`
   * means "no terminal event" (the run is still active). The host MUST NOT
   * supply a value for the trace/grant kinds; this operation ignores it
   * there (terminal status is a run concept) and emits `null` instead.
   */
  readonly terminalStatus?: RefSpineRunTerminalStatus | null;
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
  readonly data: readonly Record<string, unknown>[];
  readonly event_count: number;
  readonly limit: number;
  readonly next_cursor: string | null;
  readonly object: "trace" | "grant_timeline" | "run_timeline";
  /**
   * Run-kind only: the run's window-independent terminal status. Present on
   * the run-timeline envelope (value or `null`); always `null` for the
   * trace/grant envelopes. A consumer reading ANY single page receives the
   * same value — it does not depend on `limit`/`cursor`.
   */
  readonly terminal_status: RefSpineRunTerminalStatus | null;
  readonly trace_id: string | null;
  readonly truncated: boolean;
  readonly [identifierKey: string]: unknown;
}

const KIND_TO_ENVELOPE_OBJECT = {
  grant: "grant_timeline",
  run: "run_timeline",
  trace: "trace",
} as const;

const KIND_TO_ID_KEY = {
  grant: "grant_id",
  run: "run_id",
  trace: "trace_id",
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
  owner_device_auth: "<redacted-device-code>",
  pending_consent: "<redacted-device-code>",
  token: "<redacted-token-id>",
};

const REDACTED_BEARER_DATA_KEYS: ReadonlySet<string> = new Set(["device_code", "user_code", "request_uri"]);

const REDACTED_BEARER_VALUE = "<redacted-bearer>";
const LEGACY_INTERACTION_KINDS = new Set(["credentials", "manual_action", "otp"]);
const LEGACY_INTERACTION_MESSAGE_MAX = 200;
const LEGACY_INTERACTION_LIST_MAX = 50;
const LEGACY_INTERACTION_NAME_MAX = 160;
const LEGACY_UNSAFE_FIELD_NAME_RE = /^(?:__proto__|constructor|prototype)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A legacy interaction event predates the owner-safe assistance projection and
 * may contain connector-authored prompt text. Keep this redaction local to the
 * public timeline operation as well as the runtime writer: historical rows
 * still need a safe read path, and this operation is the final authority
 * before an event leaves the reference server.
 */
function sanitizeLegacyInteractionString(value: unknown, maxLength = LEGACY_INTERACTION_MESSAGE_MAX): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const bounded = value.trim().slice(0, maxLength);
  if (!bounded) {
    return null;
  }
  const sanitized = bounded
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"')]+/gi, "[REDACTED_URL]")
    .replace(
      /\b((?:qr[_-]?)?(?:secret|token|password|passwd|cookie|otp|bearer))\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      "$1=[REDACTED]"
    )
    .replace(
      /\b((?:cdp|playwright|webrtc|neko)[_-]?(?:url|uri|endpoint|token|secret))\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/\b\d{6}\b/g, "[REDACTED_OTP]");
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength - 1)}…`;
}

function safeLegacySource(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = typeof value.kind === "string" ? value.kind.trim().slice(0, 80) : "";
  const id = typeof value.id === "string" ? value.id.trim().slice(0, 240) : "";
  return kind && id ? { id, kind } : null;
}

function safeLegacyFieldName(value: string): boolean {
  return Boolean(value) && value.length <= LEGACY_INTERACTION_NAME_MAX && !LEGACY_UNSAFE_FIELD_NAME_RE.test(value);
}

function projectLegacyInteractionSchema(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const result = projectLegacySchemaMetadata(value);
  const properties = projectLegacySchemaProperties(value.properties);
  if (properties) {
    result.properties = properties;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function projectLegacySchemaMetadata(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof schema.type === "string" && schema.type.length <= 40) {
    result.type = schema.type;
  }
  const required = Array.isArray(schema.required)
    ? schema.required
        .filter((entry): entry is string => typeof entry === "string" && safeLegacyFieldName(entry))
        .slice(0, LEGACY_INTERACTION_LIST_MAX)
    : [];
  if (required.length > 0) {
    result.required = required;
  }
  return result;
}

function projectLegacySchemaProperties(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const properties: Record<string, unknown> = {};
  for (const [name, rawDefinition] of Object.entries(value).slice(0, LEGACY_INTERACTION_LIST_MAX)) {
    const definition = projectLegacySchemaField(name, rawDefinition);
    if (definition) {
      properties[name] = definition;
    }
  }
  return Object.keys(properties).length > 0 ? properties : null;
}

function projectLegacySchemaField(name: string, value: unknown): Record<string, unknown> | null {
  if (!(safeLegacyFieldName(name) && isRecord(value))) {
    return null;
  }
  const definition: Record<string, unknown> = {};
  if (typeof value.type === "string" && value.type.length <= 40) {
    definition.type = value.type;
  }
  if (value.format === "password") {
    definition.format = "password";
  }
  const title = sanitizeLegacyInteractionString(value.title, 160);
  if (title) {
    definition.title = title;
  }
  return Object.keys(definition).length > 0 ? definition : null;
}

function projectLegacyInteractionData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  if (typeof value.kind === "string" && LEGACY_INTERACTION_KINDS.has(value.kind)) {
    result.kind = value.kind;
  }
  const message = sanitizeLegacyInteractionString(value.message);
  if (message) {
    result.message = message;
  }
  if (value.stream === null) {
    result.stream = null;
  } else {
    const stream = sanitizeLegacyInteractionString(value.stream, 160);
    if (stream) {
      result.stream = stream;
    }
  }
  const source = safeLegacySource(value.source);
  if (source) {
    result.source = source;
  }
  const schema = projectLegacyInteractionSchema(value.schema);
  if (schema) {
    result.schema = schema;
  }
  if (
    typeof value.timeout_seconds === "number" &&
    Number.isFinite(value.timeout_seconds) &&
    value.timeout_seconds > 0
  ) {
    result.timeout_seconds = value.timeout_seconds;
  }
  // Deliberately omit every other legacy data key, including arbitrary
  // `attachments`, defaults, examples, and connector-authored metadata.
  return result;
}

export function redactSpineEventForPublic(event: RefSpineEventInput): Record<string, unknown> {
  if (!event || typeof event !== "object") {
    return event as unknown as Record<string, unknown>;
  }
  // Strip `token_id` defensively — even if a host accidentally surfaces
  // a `null`, the field is removed from the projected event entirely.
  const { token_id: _token_id, ...rest } = event as Record<string, unknown>;
  const objectType = typeof rest.object_type === "string" ? rest.object_type : "";
  const literal = REDACTED_OBJECT_ID_LITERAL_BY_TYPE[objectType];
  if (literal && typeof rest.object_id === "string") {
    rest.object_id = literal;
  }
  if (rest.event_type === "run.interaction_required") {
    rest.data = projectLegacyInteractionData(rest.data);
  } else if (rest.data && typeof rest.data === "object" && !Array.isArray(rest.data)) {
    let cloned: Record<string, unknown> | null = null;
    const dataObj = rest.data as Record<string, unknown>;
    for (const key of REDACTED_BEARER_DATA_KEYS) {
      if (key in dataObj) {
        if (!cloned) {
          cloned = { ...dataObj };
        }
        cloned[key] = REDACTED_BEARER_VALUE;
      }
    }
    if (cloned) {
      rest.data = cloned;
    }
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
  _dependencies: RefSpineEventsPageDependencies = {}
): RefSpineEventsPageEnvelope {
  const { events } = input.page;
  const traceId = events.find((event) => typeof event.trace_id === "string" && event.trace_id)?.trace_id ?? null;
  const idKey = KIND_TO_ID_KEY[input.kind];
  const objectKind = KIND_TO_ENVELOPE_OBJECT[input.kind];
  const data = events.map((event) => redactSpineEventForPublic(event));
  // Terminal status is a run concept; for trace/grant the field is always
  // null regardless of any value the host may pass.
  const terminalStatus = input.kind === "run" ? (input.terminalStatus ?? null) : null;
  return {
    object: objectKind,
    [idKey]: input.id,
    data,
    event_count: events.length,
    limit: input.page.limit,
    next_cursor: input.page.next_cursor,
    terminal_status: terminalStatus,
    trace_id: traceId,
    truncated: input.page.truncated,
  } as RefSpineEventsPageEnvelope;
}
