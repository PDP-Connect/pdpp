// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const NOTIFICATION_TIERS = Object.freeze({
  ACTION_REQUIRED: "action_required",
  INFORMATIONAL: "informational",
});

/** One of the two notification delivery tiers. */
type NotificationTier = (typeof NOTIFICATION_TIERS)[keyof typeof NOTIFICATION_TIERS];

/** A quiet-window config: enabled flag, `HH:MM` bounds, and an IANA time zone. */
type QuietWindow = {
  enabled?: boolean;
  start?: string;
  end?: string;
  timeZone?: string;
} | null;

const CLOCK_MINUTES_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function minutesSinceMidnight(date: Date, timeZone: string): number | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!(Number.isFinite(hour) && Number.isFinite(minute))) {
    return null;
  }
  return hour * 60 + minute;
}

function parseClockMinutes(value: unknown): number | null {
  const match = CLOCK_MINUTES_PATTERN.exec(String(value || ""));
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isWithinQuietWindow({
  now = new Date(),
  quietWindow = null,
}: {
  now?: Date;
  quietWindow?: QuietWindow;
} = {}): boolean {
  if (!quietWindow?.enabled) {
    return false;
  }
  const start = parseClockMinutes(quietWindow.start);
  const end = parseClockMinutes(quietWindow.end);
  const timeZone = stringField(quietWindow.timeZone) || "UTC";
  const current = minutesSinceMidnight(now, timeZone);
  if (start === null || end === null || current === null || start === end) {
    return false;
  }
  if (start < end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

/** The assistance signals a run event or its payload can carry. */
interface AssistanceInput {
  owner_action?: unknown;
  progress_posture?: unknown;
  response_contract?: unknown;
}

export function classifyAssistanceNotification(input: AssistanceInput = {}): NotificationTier {
  const ownerAction = stringField(input.owner_action);
  const progressPosture = stringField(input.progress_posture);
  const responseContract = stringField(input.response_contract);
  const actionRequired =
    ownerAction !== null &&
    ownerAction !== "none" &&
    (progressPosture === "running" || progressPosture === "blocked") &&
    (responseContract === null || responseContract === "none" || responseContract === "response_required");
  return actionRequired ? NOTIFICATION_TIERS.ACTION_REQUIRED : NOTIFICATION_TIERS.INFORMATIONAL;
}

export function classifyRunEventNotification(
  input: AssistanceInput & { event_type?: string; data?: AssistanceInput } = {}
): NotificationTier {
  if (input.event_type === "run.interaction_required" || input.event_type === "run.assistance_requested") {
    return classifyAssistanceNotification(input.data || input);
  }
  return NOTIFICATION_TIERS.INFORMATIONAL;
}

/** A rendered verdict as consumed by the notification fan-out gate. */
type RenderedVerdict = {
  channel?: string;
  required_actions?: Array<{ audience?: string; satisfied_when?: { kind?: string } }>;
} | null;

export function shouldFanoutRenderedVerdict(verdict: RenderedVerdict = null): boolean {
  if (!verdict || typeof verdict !== "object") {
    return false;
  }
  if (verdict.channel !== "attention") {
    return false;
  }
  const [primary] = Array.isArray(verdict.required_actions) ? verdict.required_actions : [];
  return Boolean(
    primary && primary.audience === "owner" && primary.satisfied_when && primary.satisfied_when.kind !== "none"
  );
}

/** RFC 8030 §5.3 urgency values this policy will ever choose between. */
export type WebPushUrgency = "high" | "normal";

/**
 * Response-required interaction kinds that are worth waking a device for.
 * `manual_action` is included because an owner-blocking manual step is just
 * as time-sensitive as an OTP/credentials prompt — but only when it also
 * carries a bounded timeout (see `INTERACTION_URGENT_TIMEOUT_CEILING_SECONDS`
 * below); an unbounded `manual_action` gets no urgency signal by design.
 */
const RESPONSE_REQUIRED_INTERACTION_KINDS: ReadonlySet<string> = new Set(["credentials", "manual_action", "otp"]);

/**
 * Upper bound (inclusive) on `timeout_seconds` for `high` urgency. Interactions
 * with a longer or absent timeout are not time-sensitive enough to justify
 * bypassing the push service's normal-urgency delivery class. 15 minutes.
 */
export const INTERACTION_URGENT_TIMEOUT_CEILING_SECONDS = 900;

/**
 * RFC 8030 `Urgency` for a pending-interaction push: `high` only for a
 * response-required interaction kind with a bounded, tested-ceiling
 * timeout. Everything else (long/unbounded timeouts, non-response-required
 * kinds, missing/invalid timeout) gets `normal` — the library default.
 */
export function projectInteractionTransportPriority({
  kind,
  timeoutSeconds,
}: {
  kind?: unknown;
  timeoutSeconds?: number | null;
} = {}): WebPushUrgency {
  if (typeof kind !== "string" || !RESPONSE_REQUIRED_INTERACTION_KINDS.has(kind)) {
    return "normal";
  }
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds > INTERACTION_URGENT_TIMEOUT_CEILING_SECONDS
  ) {
    return "normal";
  }
  return "high";
}

/** Transit margin subtracted from the durable remaining lifetime before it becomes a TTL. */
export const WEB_PUSH_TRANSIT_MARGIN_SECONDS = 30;

/** Ceiling on any computed TTL — matches the previous fixed default. */
export const WEB_PUSH_MAX_TTL_SECONDS = 10 * 60;

/**
 * A push worth attempting (`ttlSeconds` set, non-negative), or a signal to
 * suppress the send entirely because no useful time remains.
 */
export type InteractionPushTtlDecision = { send: false } | { send: true; ttlSeconds: number };

/**
 * Compute the Web Push `TTL` header from durable remaining interaction
 * lifetime at send time, not the interaction's original duration. RFC 8030
 * TTL is a retention request, never a delivery guarantee, and a push that
 * outlives the interaction it announces is worse than no push — so this
 * function suppresses the send outright once remaining lifetime (after an
 * explicit transit margin) reaches zero, rather than flooring TTL at a
 * positive value that would still let the service deliver a stale prompt.
 *
 * - No declared timeout (`remainingSeconds` null/undefined): fall back to
 *   `WEB_PUSH_MAX_TTL_SECONDS` — unbounded interactions (e.g. an unbounded
 *   `manual_action`) keep today's behavior.
 * - `remainingSeconds - WEB_PUSH_TRANSIT_MARGIN_SECONDS <= 0`: suppress.
 * - Otherwise: `min(WEB_PUSH_MAX_TTL_SECONDS, remainingSeconds - margin)`.
 */
export function computeInteractionPushTtl({
  remainingSeconds,
}: {
  remainingSeconds?: number | null;
} = {}): InteractionPushTtlDecision {
  if (remainingSeconds === null || remainingSeconds === undefined || !Number.isFinite(remainingSeconds)) {
    return { send: true, ttlSeconds: WEB_PUSH_MAX_TTL_SECONDS };
  }
  const budget = remainingSeconds - WEB_PUSH_TRANSIT_MARGIN_SECONDS;
  if (budget <= 0) {
    return { send: false };
  }
  return { send: true, ttlSeconds: Math.min(WEB_PUSH_MAX_TTL_SECONDS, budget) };
}

export function projectNotificationDelivery({
  channelOptedIn = false,
  now = new Date(),
  quietWindow = null,
  tier = NOTIFICATION_TIERS.INFORMATIONAL,
}: {
  channelOptedIn?: boolean;
  now?: Date;
  quietWindow?: QuietWindow;
  tier?: NotificationTier;
} = {}): {
  dashboard_inbox: string;
  interruptive_channel_opted_in: boolean;
  interruptive_eligible: boolean;
  quiet_hours_applied: boolean;
  tier: NotificationTier;
} {
  const quiet = isWithinQuietWindow({ now, quietWindow });
  const informational = tier === NOTIFICATION_TIERS.INFORMATIONAL;
  return {
    dashboard_inbox: "durable",
    interruptive_channel_opted_in: Boolean(channelOptedIn),
    interruptive_eligible: Boolean(channelOptedIn) && !(informational && quiet),
    quiet_hours_applied: informational && quiet,
    tier,
  };
}
