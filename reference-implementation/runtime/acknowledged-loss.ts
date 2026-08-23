// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-acknowledged permanent loss: a durable, attributed fact that some data
 * is gone or unreachable for a reason OUTSIDE this system, which the owner has
 * examined and accepted.
 *
 * Why this exists. Two production connections carry causes the owner already
 * established but the page could not say (verified 2026-08-23 against live
 * Postgres):
 *
 *   - `heb` (tnunamak@gmail.com) rendered `Needs refresh` / "Run a refresh to
 *     bring this up to date." — a routine nudge — for orders H-E-B PURGED
 *     upstream. The refresh button cannot work, and each attempt costs an OTP.
 *   - `groupme` rendered "The next run is expected to fill the remaining data."
 *     over a gap whose own evidence says `recovery_hint.action:
 *     "not_retriable"`.
 *
 * Both are the SAME class — a permanent, externally-caused condition the owner
 * has acknowledged — not two connector special cases. An upstream purge and a
 * broken provider API are two INSTANCES of it. Nothing here is keyed on a
 * connector id; the only inputs are the stamped record and the connection it
 * is attached to.
 *
 * Design constraints this module encodes:
 *
 *  1. DURABLE AND ATTRIBUTED. The record carries WHO established the fact and
 *     WHEN. It is written by the code path that learns it and read verbatim
 *     here. Following the owner ruling of 2026-08-22 already embodied by
 *     `SetupFailedReason`/`deriveSetupFailedReason` (`server/ref-control.ts`)
 *     — "record WHY... do not retrofit a guess at read time if the writer can
 *     state the truth" — this module NEVER infers an acknowledgement. Absent a
 *     stamped record, every function here returns `null` and the caller keeps
 *     its prior behavior byte-for-byte.
 *
 *  2. NEVER FABRICATES GREEN. An acknowledgement explains a loss; it does not
 *     repair one. {@link acknowledgedLossTone} is `amber` — never `green` —
 *     because the data is genuinely missing. What the acknowledgement changes
 *     is the FORWARD claim: the source stops advertising a recovery that
 *     cannot happen, so it stops reading as an open action item.
 *
 *  3. HONEST ABOUT WHOSE FAULT IT IS. `scope` distinguishes a total loss from a
 *     partial one, and the rendered sentence names the PROVIDER as the cause,
 *     so the owner is never told our connector needs a code fix for something
 *     no code change can fix.
 */

/**
 * The externally-caused, permanent conditions an owner can acknowledge.
 *
 * This is a closed taxonomy of CAUSES, not a list of connectors. Adding a
 * connector never belongs here; adding a genuinely new KIND of external
 * permanence does. Each value answers "what did the provider do?".
 *
 *   - `provider_deleted_upstream`  : the provider destroyed the data at source.
 *                                    It is not present to be collected by
 *                                    anyone, including the owner in a browser.
 *   - `provider_data_contradictory`: the provider's own API reports the data
 *                                    exists but will not serve it on any
 *                                    documented access path.
 *   - `provider_access_withdrawn`  : the provider permanently removed the
 *                                    access path (endpoint retired, export
 *                                    discontinued) with no replacement.
 */
export type AcknowledgedLossCause =
  | "provider_access_withdrawn"
  | "provider_data_contradictory"
  | "provider_deleted_upstream";

/** How much of the connection's data the acknowledged loss covers. */
export type AcknowledgedLossScope = "partial" | "total";

/**
 * A durable acknowledgement record, read exactly as the writer stamped it.
 *
 * `acknowledgedBy` is a display identity for the actor who established the
 * fact (the owner), NOT a credential or subject token — this string is
 * rendered to the owner. `acknowledgedAt` is an ISO-8601 instant. Both are
 * required: an acknowledgement the owner cannot recognize as his own defeats
 * the purpose, so this module refuses to project a record missing either
 * (see {@link isAcknowledgedLossRecord}).
 */
export interface AcknowledgedLossRecord {
  readonly acknowledgedAt: string;
  readonly acknowledgedBy: string;
  readonly cause: AcknowledgedLossCause;
  /**
   * Optional free-text detail from the owner. Rendered verbatim when present,
   * so it must never carry secrets. Absent yields the cause sentence alone.
   */
  readonly note?: string | null;
  readonly scope: AcknowledgedLossScope;
  /** Streams the loss covers. Empty means connection-wide. */
  readonly streams?: readonly string[];
}

const CAUSES: ReadonlySet<string> = new Set<AcknowledgedLossCause>([
  "provider_access_withdrawn",
  "provider_data_contradictory",
  "provider_deleted_upstream",
]);

const SCOPES: ReadonlySet<string> = new Set<AcknowledgedLossScope>(["partial", "total"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate a stored record. Deliberately strict: an unrecognized `cause`, a
 * missing actor, or a missing timestamp yields `false` so the caller falls back
 * to its existing generic copy rather than rendering a half-attributed claim.
 * This is the same discipline `deriveSetupFailedReason` uses when it resolves
 * an unrecognized `revocation_reason` to `"unknown"` instead of guessing.
 */
export function isAcknowledgedLossRecord(value: unknown): value is AcknowledgedLossRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!(isNonEmptyString(record.cause) && CAUSES.has(record.cause))) {
    return false;
  }
  if (!(isNonEmptyString(record.scope) && SCOPES.has(record.scope))) {
    return false;
  }
  if (!(isNonEmptyString(record.acknowledgedBy) && isNonEmptyString(record.acknowledgedAt))) {
    return false;
  }
  return !Number.isNaN(Date.parse(record.acknowledgedAt));
}

/**
 * Read a stamped acknowledgement off an arbitrary carrier object, or `null`.
 * Keeps the storage shape (a JSON column) out of every consumer.
 */
export function readAcknowledgedLoss(carrier: unknown): AcknowledgedLossRecord | null {
  if (!carrier || typeof carrier !== "object" || Array.isArray(carrier)) {
    return null;
  }
  const candidate = (carrier as Record<string, unknown>).acknowledged_loss;
  return isAcknowledgedLossRecord(candidate) ? candidate : null;
}

/** `2026-08-21` from an ISO instant — a date the owner can match to his own memory. */
export function acknowledgedLossDate(record: AcknowledgedLossRecord): string {
  return new Date(record.acknowledgedAt).toISOString().slice(0, 10);
}

const CAUSE_CLAUSE: Readonly<Record<AcknowledgedLossCause, string>> = Object.freeze({
  provider_access_withdrawn: "Provider permanently withdrew access to this data",
  provider_data_contradictory: "Provider API returns contradictory data — documented, unfixable here",
  provider_deleted_upstream: "Provider deleted this data upstream",
});

/**
 * The one owner-facing sentence. Names the PROVIDER as the cause, then the
 * owner's own acknowledgement and its date, so the line can never read as the
 * system guessing:
 *
 *   "Provider deleted this data upstream — owner-confirmed 2026-08-21"
 *
 * Contains no counts, no retry language, and no claim that a future run or an
 * owner action changes anything.
 */
export function acknowledgedLossStatement(record: AcknowledgedLossRecord): string {
  const note = isNonEmptyString(record.note) ? ` ${record.note.trim()}` : "";
  return `${CAUSE_CLAUSE[record.cause]} — owner-confirmed ${acknowledgedLossDate(record)}.${note}`;
}

/**
 * The progress headline for an acknowledged loss. Reports what IS held and
 * states plainly that the rest is not coming, with no action implied.
 */
export function acknowledgedLossProgressHeadline(
  record: AcknowledgedLossRecord,
  retainedRecords: number | null
): string {
  const held =
    retainedRecords === null
      ? "Retained-record count is unavailable"
      : `Holding ${retainedRecords.toLocaleString()} records`;
  const rest =
    record.scope === "total" ? "no further data exists at the provider." : "the missing data is not recoverable.";
  return `${held}; ${rest}`;
}

/**
 * Always `amber`. An acknowledged loss is honest-but-settled: the data really
 * is missing (never `green`), and the owner has already accepted the cause, so
 * it is not an unexamined failure demanding escalation (never `red`).
 *
 * Exported as a function rather than a constant so callers read it as a
 * decision with a documented reason, and so a future scope-dependent tone has
 * one place to live.
 */
export function acknowledgedLossTone(): "amber" {
  return "amber";
}
