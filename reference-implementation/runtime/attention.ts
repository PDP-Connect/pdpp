/**
 * Structured attention model for reference operator console.
 *
 * Implements the small, pure foundation called for by:
 *   - openspec/changes/define-run-assistance-state-contract/design.md
 *   - openspec/changes/complete-ri-operator-console-reliability/specs/
 *   - openspec/changes/add-dashboard-web-push-notifications/design.md
 *
 * Scope guarantees:
 *   1. Pure functions over plain data. No I/O, no scheduler, no DB, no push
 *      transport. Callers (controller / scheduler / push delivery) wire the
 *      decisions into their respective stores and channels.
 *   2. Generic over connector identity. Nothing here is ChatGPT- or
 *      Chase-specific. Connector-specific copy lives in callers.
 *   3. Secret-safe by construction: payload shaping strips sensitive values
 *      before anything is handed to a notification channel or timeline.
 *   4. Lifecycle is a closed enum; transitions are validated centrally so
 *      the dashboard projection cannot be lied to by individual call sites.
 *
 * Intentionally NOT here:
 *   - Persistence. Callers wrap these decisions in their own store.
 *   - Notification transport (Web Push, ntfy). The `pushPayload` helper
 *     shapes a payload; the actual `webpush.sendNotification` call lives
 *     in the push runtime.
 *   - Connector-specific classification rules. Auto-detected resolution
 *     accepts a generic evidence shape; the rule that "the connector
 *     observed the page is no longer behind the challenge" lives in the
 *     connector or controller.
 */

// ─── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Closed set of lifecycle states.  Matches the proposal's contract
 * (`open`, `acknowledged`, `in_progress`, `resolved`, `expired`,
 * `cancelled`, `superseded`).
 *
 * `superseded` is reserved for dedupe replacement; `expired` and
 * `cancelled` are terminal failure paths; `resolved` is terminal success.
 */
export type AttentionLifecycle =
  | "open"
  | "acknowledged"
  | "in_progress"
  | "resolved"
  | "expired"
  | "cancelled"
  | "superseded";

export const TERMINAL_LIFECYCLES: ReadonlySet<AttentionLifecycle> = new Set([
  "resolved",
  "expired",
  "cancelled",
  "superseded",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<AttentionLifecycle, readonly AttentionLifecycle[]>> = {
  open: ["acknowledged", "in_progress", "resolved", "expired", "cancelled", "superseded"],
  acknowledged: ["in_progress", "resolved", "expired", "cancelled", "superseded"],
  in_progress: ["resolved", "expired", "cancelled", "superseded"],
  resolved: [],
  expired: [],
  cancelled: [],
  superseded: [],
};

export function isTerminal(lifecycle: AttentionLifecycle): boolean {
  return TERMINAL_LIFECYCLES.has(lifecycle);
}

export function canTransition(from: AttentionLifecycle, to: AttentionLifecycle): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ─── Orthogonal axes (the design commitment) ───────────────────────────────

/** Run-side progress posture. */
export type ProgressPosture = "running" | "blocked" | "waiting_retry";

/** What the owner is being asked to do. */
export type OwnerAction = "none" | "act_elsewhere" | "provide_value" | "operate_attachment";

/** Whether the runtime is waiting on a structured response. */
export type ResponseContract = "none" | "response_required";

/**
 * Payload sensitivity classification.  Drives redaction and push
 * eligibility.  `secret` content never leaves the runtime.
 */
export type Sensitivity = "none" | "non_secret" | "secret";

/**
 * Durable notification delivery state per the schedule/manual-attention
 * policy. The state is recorded on the attention record so the operator
 * console can answer "did we tell the owner?" without re-querying push
 * transport logs, and so notification failure does not become permission
 * to repeatedly relaunch the same scheduled run.
 *
 *   - `pending`      : the attention exists but no delivery has been
 *                      attempted yet (default at create).
 *   - `sent`         : the channel accepted at least one delivery for the
 *                      current record.
 *   - `suppressed`   : delivery was intentionally skipped (no opted-in
 *                      channel, secret sensitivity, quiet hours for an
 *                      informational tier, or no actionable owner_action).
 *   - `failed`       : the channel rejected delivery. The attention SHALL
 *                      remain visible (the projection still surfaces
 *                      needs_attention) and another scheduled run SHALL
 *                      NOT be relaunched merely because notification
 *                      failed.
 *   - `acknowledged` : the owner has seen the prompt in-band (dashboard
 *                      open, lifecycle transitioned to acknowledged /
 *                      in_progress). Recorded so silent suppression and
 *                      noisy repeats can both be avoided.
 */
export type NotificationState = "acknowledged" | "failed" | "pending" | "sent" | "suppressed";

/**
 * Generic attachment kinds.  Implementation details (Playwright Page, n.eko
 * stream URL, CDP wsUrl, QR raw bytes) stay outside this module — only the
 * reference and a redaction-safe label appear here.
 */
export type AttachmentKind = "browser_surface" | "url" | "qr" | "file" | "fixture";

export interface AttentionAttachment {
  readonly kind: AttachmentKind;
  /** Optional non-secret label safe for display. */
  readonly label?: string;
  /** Opaque, ephemeral reference resolved by the surface layer. */
  readonly ref: string;
}

// ─── Core record ───────────────────────────────────────────────────────────

/**
 * The durable-shape attention record.  Stored by the controller; projected
 * into connection health; surfaced to notification channels through
 * `pushPayload`.
 *
 * `dedupe_key` is a caller-controlled string (typically connection id +
 * reason code + interaction kind).  Equality drives dedupe and supersession.
 */
export interface AttentionRecord {
  readonly action_target: string | null;
  readonly attachments: readonly AttentionAttachment[];
  readonly auto_detect: boolean;
  readonly connection_id: string;
  readonly created_at: string;
  readonly dedupe_key: string;
  readonly expires_at: string | null;
  readonly id: string;
  readonly lifecycle: AttentionLifecycle;
  /**
   * Free-form non-secret metadata for the timeline / dashboard.  Values are
   * passed through `redact()` before this record is constructed — the
   * runtime never trusts a caller to hand-classify metadata as safe.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * Short, redaction-safe reason explaining the latest notification
   * outcome (e.g. "no_opted_in_channel", "quiet_hours", "vapid_rejected").
   * Free-form opaque label; never contains owner copy or secret content.
   */
  readonly notification_reason: string | null;
  /**
   * Durable notification delivery state. Defaults to `"pending"` on
   * create; updated by the notification fanout path via
   * `recordNotificationOutcome`. Persists on the same record as the
   * lifecycle so a process restart does not lose the fact that a
   * delivery has been attempted (or has failed).
   */
  readonly notification_state: NotificationState;
  /** ISO-8601 time the last notification outcome was recorded. */
  readonly notification_updated_at: string | null;
  readonly owner_action: OwnerAction;
  readonly owner_copy: string | null;
  readonly progress_posture: ProgressPosture;
  readonly reason_code: string;
  readonly response_contract: ResponseContract;
  readonly run_id: string | null;
  readonly sensitivity: Sensitivity;
  readonly updated_at: string;
}

// ─── Construction ──────────────────────────────────────────────────────────

export interface CreateAttentionInput {
  readonly action_target?: string | null;
  readonly attachments?: readonly AttentionAttachment[];
  readonly auto_detect?: boolean;
  readonly connection_id: string;
  readonly dedupe_key: string;
  readonly expires_at?: string | null;
  readonly id: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly now: string;
  readonly owner_action: OwnerAction;
  readonly owner_copy?: string | null;
  readonly progress_posture: ProgressPosture;
  readonly reason_code: string;
  readonly response_contract: ResponseContract;
  readonly run_id?: string | null;
  readonly sensitivity?: Sensitivity;
}

export function createAttention(input: CreateAttentionInput): AttentionRecord {
  validateAxes(input.progress_posture, input.owner_action, input.response_contract);
  return {
    id: input.id,
    dedupe_key: input.dedupe_key,
    connection_id: input.connection_id,
    run_id: input.run_id ?? null,
    reason_code: input.reason_code,
    progress_posture: input.progress_posture,
    owner_action: input.owner_action,
    response_contract: input.response_contract,
    sensitivity: input.sensitivity ?? "none",
    auto_detect: input.auto_detect ?? false,
    lifecycle: "open",
    created_at: input.now,
    updated_at: input.now,
    expires_at: input.expires_at ?? null,
    owner_copy: input.owner_copy ?? null,
    action_target: input.action_target ?? null,
    attachments: input.attachments ?? [],
    metadata: Object.freeze({ ...redactMetadata(input.metadata ?? {}) }),
    notification_state: "pending",
    notification_updated_at: null,
    notification_reason: null,
  };
}

/**
 * Disallow nonsense combinations early.  A request with no owner action and
 * no response contract is observability, not attention; it should be a
 * progress message instead.
 */
function validateAxes(posture: ProgressPosture, action: OwnerAction, contract: ResponseContract): void {
  if (action === "none" && contract === "none" && posture === "running") {
    throw new Error(
      "attention: posture=running + owner_action=none + response_contract=none is not assistance; emit PROGRESS instead"
    );
  }
  if (contract === "response_required" && action === "none") {
    throw new Error("attention: response_required must specify a non-`none` owner_action");
  }
}

// ─── Transitions ───────────────────────────────────────────────────────────

export interface TransitionInput {
  readonly now: string;
  readonly to: AttentionLifecycle;
}

export function transition(record: AttentionRecord, input: TransitionInput): AttentionRecord {
  if (!canTransition(record.lifecycle, input.to)) {
    throw new Error(`attention: invalid transition ${record.lifecycle} -> ${input.to} for ${record.id}`);
  }
  // Lifecycle progress into acknowledged/in_progress is the canonical
  // signal that the owner has seen the prompt — promote the durable
  // notification state in lockstep so the projection can answer
  // "is the owner aware?" without re-reading transport logs.
  const promotedNotification: NotificationState | null =
    input.to === "acknowledged" || input.to === "in_progress" ? "acknowledged" : null;
  return {
    ...record,
    lifecycle: input.to,
    updated_at: input.now,
    notification_state: promotedNotification ?? record.notification_state,
    notification_updated_at: promotedNotification ? input.now : record.notification_updated_at,
    notification_reason: promotedNotification ? "owner_acknowledged" : record.notification_reason,
  };
}

// ─── Notification state ────────────────────────────────────────────────────

export interface NotificationOutcomeInput {
  readonly now: string;
  readonly outcome: NotificationState;
  /** Opaque, redaction-safe reason label. Never holds owner copy or secrets. */
  readonly reason?: string | null;
}

const VALID_NOTIFICATION_STATES: ReadonlySet<NotificationState> = new Set([
  "acknowledged",
  "failed",
  "pending",
  "sent",
  "suppressed",
]);

/**
 * Pure transition helper for the durable notification axis. The runtime
 * calls this from the push fanout seam so the operator console reflects
 * whether delivery actually reached the owner. Lifecycle is independent:
 * a `failed` notification SHALL NOT terminate the attention, because the
 * unresolved owner action is still real — the spec scenario "Notification
 * failure does not cause a run storm" requires the attention to stay
 * visible while the failure is recorded.
 */
export function recordNotificationOutcome(record: AttentionRecord, input: NotificationOutcomeInput): AttentionRecord {
  if (!VALID_NOTIFICATION_STATES.has(input.outcome)) {
    throw new Error(`attention: invalid notification outcome ${input.outcome}`);
  }
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null;
  return {
    ...record,
    notification_state: input.outcome,
    notification_updated_at: input.now,
    notification_reason: reason,
  };
}

export function isNotificationDeliveryFailed(record: AttentionRecord): boolean {
  return record.notification_state === "failed";
}

// ─── Dedupe / cooldown / supersession ──────────────────────────────────────

export interface DedupeDecisionInput {
  /** Cooldown window in seconds. */
  readonly cooldown_seconds: number;
  /** Currently active (non-terminal) record sharing the dedupe_key, if any. */
  readonly existing: AttentionRecord | null;
  /** Proposed creation. */
  readonly proposed: CreateAttentionInput;
}

export type DedupeOutcome =
  | { kind: "create" }
  | { kind: "suppress"; reason: "active_duplicate" | "cooldown" }
  | { kind: "supersede"; existing_id: string };

/**
 * Decide what to do when a new attention is proposed and an existing record
 * may share its dedupe key.
 *
 *   - `existing` is open/acknowledged/in_progress -> suppress as
 *     `active_duplicate` (the open prompt already covers it).
 *   - `existing` is terminal and within cooldown_seconds -> suppress as
 *     `cooldown` (avoid spamming the owner after a recent identical event).
 *   - `existing` is terminal and outside cooldown -> create fresh.
 *   - Axes changed materially while a prompt is still open -> supersede
 *     (the existing record is closed as `superseded` by the caller).
 */
export function decideDedupe(input: DedupeDecisionInput): DedupeOutcome {
  const { existing, proposed, cooldown_seconds } = input;
  if (!existing) {
    return { kind: "create" };
  }

  if (!isTerminal(existing.lifecycle)) {
    if (axesDiffer(existing, proposed)) {
      return { kind: "supersede", existing_id: existing.id };
    }
    return { kind: "suppress", reason: "active_duplicate" };
  }

  const elapsed = secondsBetween(existing.updated_at, proposed.now);
  if (elapsed < cooldown_seconds) {
    return { kind: "suppress", reason: "cooldown" };
  }
  return { kind: "create" };
}

function axesDiffer(a: AttentionRecord, b: CreateAttentionInput): boolean {
  return (
    a.progress_posture !== b.progress_posture ||
    a.owner_action !== b.owner_action ||
    a.response_contract !== b.response_contract ||
    a.reason_code !== b.reason_code
  );
}

// ─── Expiry ────────────────────────────────────────────────────────────────

export function isExpired(record: AttentionRecord, now: string): boolean {
  if (!record.expires_at) {
    return false;
  }
  if (isTerminal(record.lifecycle)) {
    return false;
  }
  return Date.parse(record.expires_at) <= Date.parse(now);
}

export function expireIfDue(record: AttentionRecord, now: string): AttentionRecord {
  return isExpired(record, now) ? transition(record, { to: "expired", now }) : record;
}

// ─── Redaction & push payload shaping ──────────────────────────────────────

/**
 * Keys that look secret-y at field level.  This is a safety net — the
 * primary mechanism is `sensitivity: "secret"` on the record, which blocks
 * the payload entirely.  Callers must still avoid stuffing secrets into
 * metadata in the first place.
 */
const SECRET_KEY_PATTERN = /(password|passwd|secret|token|otp|cookie|credential|authorization|bearer|api[_-]?key)/i;

function redactMetadata(meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    if (typeof v === "string" && v.length > 256) {
      out[k] = `${v.slice(0, 256)}…`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export interface PushPayload {
  readonly attention_id: string;
  readonly body: string;
  readonly connection_id: string;
  readonly reason_code: string;
  readonly tag: string;
  readonly title: string;
  readonly url: string;
}

export interface PushPayloadOptions {
  /**
   * Display name for the connection; caller-supplied because connector
   * display copy isn't part of this module.  `null` means use a generic
   * "A connection" label so lock-screen text stays non-revealing.
   */
  readonly connection_display: string | null;
  /** Dashboard origin, e.g. "https://dashboard.example". */
  readonly dashboard_origin: string;
  /** If true (privacy mode), strip connection display from the body. */
  readonly hide_source?: boolean;
}

/**
 * Shape the push-safe payload.  Returns null when the record is secret
 * (the runtime never lets secret payloads reach a push transport), or
 * when there is no actionable owner_action (notifications should not fire
 * for pure-progress states).
 *
 * The returned object is the *content* layer; the push runtime is
 * responsible for wrapping it in VAPID/TTL/urgency envelopes.
 */
export function pushPayload(record: AttentionRecord, options: PushPayloadOptions): PushPayload | null {
  if (record.sensitivity === "secret") {
    return null;
  }
  if (record.owner_action === "none") {
    return null;
  }
  if (isTerminal(record.lifecycle)) {
    return null;
  }

  const showSource = !options.hide_source && options.connection_display !== null;
  const sourceLabel = showSource ? (options.connection_display as string) : "A connection";

  const title = ownerActionTitle(record.owner_action);
  const body = `${sourceLabel} needs ${ownerActionBodyFragment(record.owner_action)}.`;

  const url = `${stripTrailingSlash(options.dashboard_origin)}/attention/${encodeURIComponent(record.id)}`;

  return {
    title,
    body,
    url,
    tag: record.dedupe_key,
    attention_id: record.id,
    connection_id: record.connection_id,
    reason_code: record.reason_code,
  };
}

function ownerActionTitle(action: OwnerAction): string {
  switch (action) {
    case "provide_value":
      return "Owner input needed";
    case "operate_attachment":
      return "Owner action needed";
    case "act_elsewhere":
      return "Approve in your other app";
    case "none":
      return "Update";
  }
}

function ownerActionBodyFragment(action: OwnerAction): string {
  switch (action) {
    case "provide_value":
      return "a code or value";
    case "operate_attachment":
      return "to complete a step";
    case "act_elsewhere":
      return "to approve a prompt outside the dashboard";
    case "none":
      return "a status update";
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

// ─── Connection-health classification ──────────────────────────────────────

/**
 * Decide whether a record is *health-relevant* — i.e. whether the
 * connection-health projection should treat it as a `needs_attention`
 * input.  Nonblocking running notices that are merely informational should not
 * toggle the pill, but time-bound external actions do: without owner action
 * before the deadline, the run can still fail.
 */
export function isHealthRelevant(record: AttentionRecord, now: string): boolean {
  if (isTerminal(record.lifecycle)) {
    return false;
  }
  if (isExpired(record, now)) {
    return false;
  }
  if (record.response_contract === "response_required") {
    return true;
  }
  if (record.progress_posture === "blocked") {
    return true;
  }
  if (record.owner_action === "act_elsewhere" && record.expires_at != null) {
    return true;
  }
  if (record.owner_action !== "none" && record.owner_action !== "act_elsewhere") {
    return true;
  }
  return false;
}

// ─── Auto-detected resolution ──────────────────────────────────────────────

export interface AutoDetectInput {
  /**
   * Evidence the connector / controller observed:
   *   - `proceeded`: the run continued past the blocking condition
   *     (e.g. the page is no longer on the challenge route).
   *   - `still_blocked`: the condition persists; do not auto-resolve.
   *   - `unknown`: no observation; do not auto-resolve.
   */
  readonly evidence: "proceeded" | "still_blocked" | "unknown";
  readonly now: string;
  readonly record: AttentionRecord;
}

export type AutoDetectOutcome =
  | { kind: "resolve"; record: AttentionRecord }
  | { kind: "no_change"; reason: "auto_detect_disabled" | "terminal" | "no_evidence" | "still_blocked" };

/**
 * Classify whether observed evidence is enough to auto-resolve the
 * attention without forcing the owner to confirm in the dashboard.  Safe
 * detection only fires when the record opted in (`auto_detect: true`) and
 * the evidence is positive.
 */
export function classifyAutoDetect(input: AutoDetectInput): AutoDetectOutcome {
  const { record, evidence, now } = input;
  if (isTerminal(record.lifecycle)) {
    return { kind: "no_change", reason: "terminal" };
  }
  if (!record.auto_detect) {
    return { kind: "no_change", reason: "auto_detect_disabled" };
  }
  switch (evidence) {
    case "proceeded":
      return { kind: "resolve", record: transition(record, { to: "resolved", now }) };
    case "still_blocked":
      return { kind: "no_change", reason: "still_blocked" };
    case "unknown":
      return { kind: "no_change", reason: "no_evidence" };
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function secondsBetween(a: string, b: string): number {
  return Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000);
}
