// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cursor provenance — detecting a watermark a connection did not earn.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * A watermark cursor ("fetch everything newer than T") is only sound when T
 * was reached by THIS connection actually walking its own history. When a new
 * connection is seeded with another connection's high-water mark, every record
 * older than T becomes permanently unreachable — the connection will only ever
 * ask for newer items — while `covered == considered` continues to report
 * complete coverage, because the run genuinely processed everything it
 * fetched.
 *
 * This is not hypothetical. On the live instance, ChatGPT connection
 * `cin_484604984db7c091bd08b259` (created 2026-08-17) holds a `conversations`
 * cursor of `2026-06-19T20:30:04.127Z` that is byte-identical, to the
 * millisecond, to the cursor of a DIFFERENT, paused connection
 * (`cin_e4ab231c7d49b8f59e4c80ed`) which reached that value on its own final
 * run. Two separate ChatGPT accounts do not independently walk to the same
 * millisecond; the value was copied, and everything older than it is
 * unreachable for the newer connection.
 *
 * WHY THIS IS THE IMAP `UIDVALIDITY` PROBLEM
 * ------------------------------------------
 * RFC 9051 §2.3.1.1 defines `UIDVALIDITY` precisely because a client holding
 * identifiers from one identifier space must never silently apply them to a
 * different one. A cursor inherited across connections is exactly that: a
 * position in connection A's history being used to bound connection B's
 * fetches. IMAP solved it by making the server declare the epoch; consumer
 * APIs declare nothing, so we must detect the reset locally.
 *
 * THE FALSE-POSITIVE PROBLEM, AND HOW IT IS AVOIDED
 * -------------------------------------------------
 * "The cursor has not moved" is NOT evidence of a defect. A genuinely idle
 * source — an account nobody has posted to in six months — has a legitimately
 * frozen watermark, and firing on it would cry wolf on exactly the quiet
 * connections an owner is least able to sanity-check. This module therefore
 * never uses staleness as a signal at all.
 *
 * Instead it uses ONE signal that is structurally impossible for an
 * independently-earned cursor, and that an idle connection cannot trip:
 *
 *   `duplicate_of_sibling` — the cursor is byte-identical to a DIFFERENT
 *   connection's cursor for the same connector and stream. Two independent
 *   walks of two different accounts landing on the same high-resolution
 *   timestamp is not a coincidence a real walk produces; it is the fingerprint
 *   of a copy. Deliberately requires EXACT equality, never proximity.
 *
 * A REJECTED RULE, AND WHY (the live fleet disproved it)
 * ------------------------------------------------------
 * An earlier version of this module also flagged a cursor that predated its
 * own connection's `created_at`, reasoning that a connection cannot have
 * observed data before it existed. Run against the live instance, that rule
 * produced SEVEN false positives, and they showed the reasoning was wrong.
 *
 * These watermarks store the timestamp of the newest CONTENT ITEM found, not
 * the time of observation: reddit persists `latestEpoch` (the newest post's
 * `created_utc`), notion persists the newest `last_edited_time`, github the
 * newest `pushed_at`. A connection created today that fully walks an account
 * whose newest post is from 2024 correctly stores a 2024 watermark — it
 * reached the true tip of that history. Flagging it would fire on a
 * connection that did everything right, and would fire hardest on exactly the
 * dormant accounts most at risk of silent loss.
 *
 * The rule would only be sound for a watermark meaning "I observed up to now",
 * and no connector in this fleet stores one. It is therefore not implemented.
 * Connection `created_at` remains used for ONE narrow purpose below: deciding
 * which of two connections sharing a value could plausibly have originated it.
 *
 * A finding is reported as `suspected`, never as a proven gap and never as a
 * downgrade to `degraded`. That is the honest verdict: the evidence proves the
 * cursor's PROVENANCE is unsound, which makes any completeness claim built on
 * it unfounded — but it does not by itself measure how much data is
 * unreachable. The correct outcome is to withhold the healthy claim and tell
 * the owner to re-seed, not to manufacture a quantified loss we never measured.
 *
 * SCOPE
 * -----
 * Applies only to cursors that are a single ordered watermark over the whole
 * stream — the shape where "everything older than T" is unreachable. It is
 * deliberately NOT applied to:
 *   - fingerprint maps / `fetched_at` freshness markers, which do not bound a
 *     fetch and cannot strand history;
 *   - per-partition maps (amazon years, chase accounts, slack channels), where
 *     partitions are independently seeded and identical values across
 *     connections are ordinary;
 *   - opaque tokens (CardDAV sync-token, YNAB `server_knowledge`), which are
 *     not timestamps and whose equality across connections carries no meaning.
 */

/** A watermark field that bounds "fetch everything newer than this". */
export interface WatermarkSpec {
  readonly connectorId: string;
  /** Dotted path to the watermark within the stream's cursor. */
  readonly path: readonly string[];
  readonly stream: string;
  /** How to read the stored value into a comparable instant. */
  readonly valueKind: "epoch_seconds" | "iso8601";
}

/**
 * Watermark cursors whose provenance is checkable. Each is a single ordered
 * position over the stream's whole history, so an inherited value strands
 * everything before it.
 */
export const WATERMARK_SPECS: readonly WatermarkSpec[] = [
  { connectorId: "chatgpt", path: ["last_update_time"], stream: "conversations", valueKind: "iso8601" },
  { connectorId: "chatgpt", path: ["last_update_time"], stream: "messages", valueKind: "iso8601" },
  { connectorId: "github", path: ["last_updated_at"], stream: "issues", valueKind: "iso8601" },
  { connectorId: "github", path: ["last_updated_at"], stream: "pull_requests", valueKind: "iso8601" },
  { connectorId: "github", path: ["last_pushed_at"], stream: "repositories", valueKind: "iso8601" },
  { connectorId: "github", path: ["last_starred_at"], stream: "starred", valueKind: "iso8601" },
  { connectorId: "notion", path: ["last_edited_time"], stream: "databases", valueKind: "iso8601" },
  { connectorId: "notion", path: ["last_edited_time"], stream: "pages", valueKind: "iso8601" },
  { connectorId: "reddit", path: ["last_created_utc"], stream: "comments", valueKind: "epoch_seconds" },
  { connectorId: "reddit", path: ["last_created_utc"], stream: "saved", valueKind: "epoch_seconds" },
  { connectorId: "reddit", path: ["last_created_utc"], stream: "submitted", valueKind: "epoch_seconds" },
];

/**
 * Why a cursor's provenance is or is not suspect.
 *
 * - `self_earned` — nothing indicates the cursor came from elsewhere.
 * - `duplicate_of_sibling` — byte-identical to another connection's cursor for
 *   the same connector and stream.
 * - `not_registered` / `unreadable` — no watermark declared, or the stored
 *   value is absent/malformed. Silence, never a finding.
 */
export type CursorProvenanceReason = "duplicate_of_sibling" | "not_registered" | "self_earned" | "unreadable";

export interface CursorProvenanceFinding {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  /** The sibling whose cursor this one duplicates, when applicable. */
  readonly duplicateOf: string | null;
  readonly reason: CursorProvenanceReason;
  readonly stream: string;
  /**
   * True when the evidence shows the cursor was not earned by this connection.
   * Never asserts how much data is unreachable — see the module doc.
   */
  readonly suspected: boolean;
  /** The raw stored watermark, echoed for the operator. */
  readonly value: string | null;
}

/** One connection's persisted cursor for one stream. */
export interface CursorProvenanceInput {
  /** Connection creation time, ISO 8601. */
  readonly connectionCreatedAt: string;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly cursor: unknown;
  readonly stream: string;
}

function readPath(cursor: unknown, path: readonly string[]): unknown {
  let node: unknown = cursor;
  for (const key of path) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export function findWatermarkSpec(connectorId: string, stream: string): WatermarkSpec | null {
  return WATERMARK_SPECS.find((spec) => spec.connectorId === connectorId && spec.stream === stream) ?? null;
}

/**
 * Read a watermark into epoch milliseconds, plus its canonical string form for
 * exact-equality comparison. Returns null for anything unparseable so a
 * malformed cursor stays silent rather than producing a bogus finding.
 */
function readWatermark(cursor: unknown, spec: WatermarkSpec): { ms: number; raw: string } | null {
  const value = readPath(cursor, spec.path);
  if (spec.valueKind === "epoch_seconds") {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return null;
    }
    return { ms: value * 1000, raw: String(value) };
  }
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : { ms, raw: value };
}

/**
 * Tolerance for the `predates_connection` rule.
 *
 * A connection's first run legitimately begins moments after the connection
 * row is written, and clock skew between the row's timestamp and the source's
 * timestamps is real. Only a cursor predating creation by more than this
 * margin is treated as impossible-to-have-earned. The live ChatGPT defect
 * predates creation by ~59 days, so it clears this bound by three orders of
 * magnitude — the tolerance exists to keep ordinary skew silent, not to make
 * the rule close.
 */
export const PREDATES_CONNECTION_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluate cursor provenance across a set of connections for ONE connector and
 * stream. Sibling comparison needs the whole set, so this is a batch function
 * rather than a per-row one.
 *
 * Pure: no I/O, no clock. Ordering of the input does not change which
 * connections are reported.
 */
export function evaluateCursorProvenance(inputs: readonly CursorProvenanceInput[]): readonly CursorProvenanceFinding[] {
  // Group by (connector, stream) so siblings are compared only against
  // genuinely comparable cursors.
  const groups = new Map<string, CursorProvenanceInput[]>();
  for (const input of inputs) {
    const key = `${input.connectorId} ${input.stream}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(input);
    } else {
      groups.set(key, [input]);
    }
  }

  return [...groups.values()].flatMap((group) => evaluateOneStreamGroup(group));
}

/** One connection's watermark reading, tagged with whether it could be the origin. */
interface WatermarkReading {
  readonly couldHaveEarned: boolean;
  readonly input: CursorProvenanceInput;
  readonly watermark: { ms: number; raw: string } | null;
}

/** A connection holding a particular raw watermark value. */
interface ValueHolder {
  readonly connectorInstanceId: string;
  readonly couldHaveEarned: boolean;
}

/**
 * Read every connection's watermark in a group.
 *
 * `couldHaveEarned` is false only when the cursor predates the connection's
 * own creation. On its own that means nothing (see the rejected-rule note in
 * the module doc — content timestamps legitimately predate a connection). It
 * exists ONLY to break the symmetry of a duplicate: if exactly one holder
 * could have originated the value, that holder is the source and the others
 * are copiers, so the source is not blamed for a copy made from it.
 */
function readGroupWatermarks(
  group: readonly CursorProvenanceInput[],
  spec: WatermarkSpec
): readonly WatermarkReading[] {
  return group.map((input) => {
    const watermark = readWatermark(input.cursor, spec);
    const createdAtMs = Date.parse(input.connectionCreatedAt);
    const couldHaveEarned =
      watermark !== null &&
      (Number.isNaN(createdAtMs) || watermark.ms >= createdAtMs - PREDATES_CONNECTION_TOLERANCE_MS);
    return { couldHaveEarned, input, watermark };
  });
}

/** Index every connection holding each raw watermark value. */
function indexHoldersByValue(readings: readonly WatermarkReading[]): Map<string, ValueHolder[]> {
  const holdersByRawValue = new Map<string, ValueHolder[]>();
  for (const { couldHaveEarned, input, watermark } of readings) {
    if (!watermark) {
      continue;
    }
    const holder = { connectorInstanceId: input.connectorInstanceId, couldHaveEarned };
    const holders = holdersByRawValue.get(watermark.raw);
    if (holders) {
      holders.push(holder);
    } else {
      holdersByRawValue.set(watermark.raw, [holder]);
    }
  }
  return holdersByRawValue;
}

/** Evaluate every connection within one (connector, stream) group. */
function evaluateOneStreamGroup(group: readonly CursorProvenanceInput[]): readonly CursorProvenanceFinding[] {
  const [first] = group;
  if (!first) {
    return [];
  }
  const spec = findWatermarkSpec(first.connectorId, first.stream);
  if (!spec) {
    return group.map((input) => buildFinding(input, "not_registered", null, null));
  }

  const readings = readGroupWatermarks(group, spec);
  const holdersByRawValue = indexHoldersByValue(readings);

  return readings.map(({ couldHaveEarned, input, watermark }) => {
    if (!watermark) {
      return buildFinding(input, "unreadable", null, null);
    }

    // Byte-identical to a DIFFERENT connection's cursor. Two independent walks
    // do not land on the same high-resolution timestamp.
    const otherHolders = (holdersByRawValue.get(watermark.raw) ?? []).filter(
      (holder) => holder.connectorInstanceId !== input.connectorInstanceId
    );
    const [sibling] = otherHolders;
    if (!sibling) {
      return buildFinding(input, "self_earned", null, watermark.raw);
    }

    // Blame this connection unless it is the ONLY plausible origin among the
    // holders — i.e. every other holder could not have earned the value
    // itself, which makes them the copiers and this one the source. When
    // several could plausibly have earned it, all are reported: the stored
    // evidence cannot say which copied, and guessing would blame the wrong one.
    const isSolePlausibleOrigin = couldHaveEarned && otherHolders.every((holder) => !holder.couldHaveEarned);
    return isSolePlausibleOrigin
      ? buildFinding(input, "self_earned", null, watermark.raw)
      : buildFinding(input, "duplicate_of_sibling", sibling.connectorInstanceId, watermark.raw);
  });
}

function buildFinding(
  input: CursorProvenanceInput,
  reason: CursorProvenanceReason,
  duplicateOf: string | null,
  value: string | null
): CursorProvenanceFinding {
  return {
    connectorId: input.connectorId,
    connectorInstanceId: input.connectorInstanceId,
    duplicateOf,
    reason,
    stream: input.stream,
    suspected: reason === "duplicate_of_sibling",
    value,
  };
}

/**
 * Format a provenance finding for an operator. Watermarks are stream positions,
 * not record payloads — no message content or record key is read or printed.
 */
export function describeCursorProvenanceFinding(finding: CursorProvenanceFinding): string {
  const head = `${finding.connectorId}.${finding.stream} on ${finding.connectorInstanceId}`;
  if (finding.reason === "duplicate_of_sibling") {
    return (
      `${head}: cursor ${String(finding.value)} is byte-identical to ${String(finding.duplicateOf)}'s, ` +
      "which is the fingerprint of an inherited high-water mark rather than an independently earned one. " +
      "Re-seed the cursor to re-walk this connection's own history."
    );
  }
  return `${head}: ${finding.reason}`;
}
