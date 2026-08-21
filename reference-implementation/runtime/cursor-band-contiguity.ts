// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cursor-band contiguity — the one completeness check that needs no provider
 * call, no timestamps, and no second copy of the data.
 *
 * THE INVARIANT
 * -------------
 * When a stream walks ONE ordered identifier space with TWO independent
 * pointers — a historical pass climbing toward a frozen ceiling, and a forward
 * pass resuming from a watermark — the two walked intervals must MEET. If the
 * ceiling stops below where the forward pass resumes, the identifiers between
 * them belong to neither walk and are never fetched:
 *
 *     ID:  1 .......... ceiling | ORPHANED BAND | resume ....... *
 *          \___ historical ____/                 \___ forward __/
 *
 * Formally, for a two-pointer stream: `ceiling + 1 >= resume`.
 *
 * WHY NO EXISTING GATE CAUGHT THIS
 * --------------------------------
 * Every coverage signal in this codebase compares `covered` against
 * `considered` — "did I process what I fetched". That equality holds
 * throughout an orphaned band, because the connector genuinely did process
 * everything it fetched. It simply never fetched the band. Contiguity is a
 * statement about the FETCH PLAN, not about processing, which is why it is
 * the only local check that can see this class of loss.
 *
 * On the live instance the Gmail `messages` cursor sat at
 * `target_uid: 323723` / `forward_uidnext: 324021`, so `323724 >= 324021` was
 * false and a 297-UID band — two days of mail — was unreachable. This check
 * evaluates to `violated` on exactly that state.
 *
 * WHO DECLARES, AND WHO OWNS THE SEMANTICS
 * ----------------------------------------
 * A stream opts in by declaring a CLOSED enum in its manifest:
 *
 *     "cursor_shape": "imap_uid_band"
 *
 * That declaration carries exactly one bit of connector fact — "this stream's
 * cursor is a two-pointer walk of an IMAP UID space" — which only the
 * connector can know. Everything else below (which paths hold the ceiling and
 * the resume pointer, the `UIDVALIDITY` epoch guard, the `ceiling + 1 >=
 * resume` arithmetic) is IMAP-specific RI logic and stays RI-owned, keyed off
 * the declared enum. The manifest selects a variant; it never supplies the
 * formula.
 *
 * That split is the point. If the manifest carried the PATHS, a connector
 * could mis-path its own ceiling and quietly turn a real violation into
 * `incomplete_cursor` silence — the audited party would be defining the
 * audit. Because the enum is closed, an unrecognized value selects no variant
 * and yields `not_registered`, and declaring can only opt a connector IN:
 * omission yields `not_applicable`/`not_registered`, which is never reported
 * as healthy. The failure mode of a bad declaration is a check that does not
 * run, never a check that lies.
 *
 * Precedent: manifests already declare `cursor_field`, and
 * `capabilities.refresh_policy.max_recovery_attempts` uses the same "manifest
 * declares, RI clamps" shape.
 *
 * SCOPE: WHY ONLY THE IMAP UID BAND TODAY
 * ---------------------------------------
 * A fleet-wide survey of every persisted cursor shape (44 connectors, and the
 * live `connector_state` table) found that gmail `messages` is the ONLY stream
 * that keeps two pointers over one ordered space — hence exactly one variant
 * below. The others are:
 *
 *   - single-watermark (github, reddit, notion, spotify, strava, venmo, oura,
 *     imessage, signal, chatgpt, twitter_archive) — one pointer cannot form a
 *     band; there is nothing to check.
 *   - per-partition-map (amazon `years`, chase `per_account`, claude-code /
 *     codex `file_cursors`, slack `channel_last_ts`, groupme `cursors`) — each
 *     partition carries its OWN independent pointer over its OWN space. Two
 *     partitions are not two pointers over one space, and comparing across
 *     them would be meaningless. Amazon's `frozen` flag is a per-partition
 *     terminal marker, not a ceiling.
 *   - opaque-token (apple_contacts `sync_token`, google_calendar per-calendar
 *     `sync_token`, ynab `server_knowledge`) — the values are not ordered and
 *     not comparable by us at all; arithmetic on them is undefined.
 *   - gmail `attachments` — a backfill FLOOR (`backfilled_through_uid`) with
 *     no ceiling and no forward pointer. One-sided, so no band exists.
 *
 * Declaring any of those would produce a check that fires on correct
 * behavior, which is worse than no check. The variant table below is
 * therefore deliberately narrow and explicit rather than shape-sniffing: a
 * heuristic that guessed "two numbers in a cursor = a band" would fire on
 * `pacing_interval_ms`/`pacing_recorded_at_ms` and on gmail's own
 * `uidnext`/`highest_modseq`, none of which bracket a band.
 *
 * WHAT A VIOLATION MEANS, AND WHAT IT DOES NOT
 * --------------------------------------------
 * A violation is a POSITIVE, self-evident defect signal, not an "unproven"
 * — unlike a coverage claim, it needs no upstream cooperation to interpret.
 * The two stored numbers alone prove the fetch plan skips an interval; no
 * provider fact could make `323724 >= 324021` true. That is why this check
 * reports `violated` rather than withholding a healthy verdict: withholding
 * would understate a defect we can actually prove.
 *
 * Conversely, `not_applicable` (no registered band, or the cursor has not yet
 * written both pointers) is NEVER reported as healthy or as a violation. An
 * absent pointer means the walk has not started, which is not evidence of a
 * gap. This is the same honesty rule the coverage oracle applies: silence,
 * not a manufactured verdict.
 *
 * UIDVALIDITY GUARD
 * -----------------
 * IMAP's `UIDVALIDITY` (RFC 9051 §2.3.1.1) is the canonical signal that an
 * identifier space has been reset — every stored UID becomes meaningless.
 * When the two pointers were recorded under DIFFERENT `uidvalidity` epochs
 * they are not points in one ordered space and the subtraction is not
 * defined, so the comparison is refused (`epoch_mismatch`) rather than
 * producing an arithmetic answer over incomparable numbers.
 */

/**
 * The closed set of cursor shapes a manifest may declare via a stream's
 * `cursor_shape`. Closed on purpose: an unrecognized value selects no variant
 * and the check stays silent, so a manifest can never invent a band shape the
 * RI has not reasoned about.
 */
export const CURSOR_BAND_SHAPES = ["imap_uid_band"] as const;
export type CursorBandShape = (typeof CURSOR_BAND_SHAPES)[number];

/** Is this manifest-declared value a cursor shape this RI understands? */
export function isCursorBandShape(value: unknown): value is CursorBandShape {
  return typeof value === "string" && (CURSOR_BAND_SHAPES as readonly string[]).includes(value);
}

/**
 * One RI-owned band variant: where to read the ceiling of the historical
 * walk, where to read the resume point of the forward walk, and (optionally)
 * where each records the epoch that makes them comparable.
 *
 * These paths are RI knowledge about a PROTOCOL (IMAP), not about any
 * connector — see the module doc on why the manifest selects a variant rather
 * than supplying one. Paths are read against the stream's persisted cursor.
 */
export interface CursorBandSpec {
  /** Dotted path to the epoch guarding the ceiling, when the space has one. */
  readonly ceilingEpochPath?: readonly string[];
  /** Dotted path to the frozen ceiling of the historical/backfill walk. */
  readonly ceilingPath: readonly string[];
  /** Human-readable note on why this shape forms a band; surfaced in reports. */
  readonly note: string;
  /** Dotted path to the epoch guarding the resume pointer. */
  readonly resumeEpochPath?: readonly string[];
  /** Dotted path to the point the forward walk resumes from. */
  readonly resumePath: readonly string[];
  /** The declared shape this variant implements. */
  readonly shape: CursorBandShape;
}

/**
 * Why a band evaluation reached its verdict.
 *
 * - `contiguous` — both pointers present, comparable, and the intervals meet.
 * - `violated` — both pointers present and comparable, and an identifier band
 *   between them belongs to neither walk. A proven defect.
 * - `not_registered` — this (connector, stream) declares no band. Silence.
 * - `incomplete_cursor` — a registered band whose cursor has not yet written
 *   both pointers (walk not started). Silence, never a violation.
 * - `epoch_mismatch` — the pointers were recorded under different identifier
 *   epochs, so they are not comparable. Silence, never a violation.
 */
export type CursorBandReason = "contiguous" | "epoch_mismatch" | "incomplete_cursor" | "not_registered" | "violated";

export interface CursorBandVerdict {
  /** Size of the orphaned interval; only meaningful when `violated`. */
  readonly bandSize: number | null;
  /** The ceiling value actually read, when present. */
  readonly ceiling: number | null;
  readonly reason: CursorBandReason;
  /** The resume value actually read, when present. */
  readonly resume: number | null;
  /** True only for `violated` — a proven, positively-detected gap. */
  readonly violated: boolean;
}

/**
 * The RI-owned variant table, keyed by declared shape. Deliberately explicit;
 * see the module doc for why every other live cursor shape is excluded rather
 * than heuristically matched.
 */
export const CURSOR_BAND_SPECS: readonly CursorBandSpec[] = [
  {
    ceilingEpochPath: ["backfill", "uidvalidity"],
    ceilingPath: ["backfill", "target_uid"],
    note:
      "IMAP UID space: `backfill.target_uid` freezes the historical walk's ceiling while " +
      "`all_mail.forward_uidnext` advances only when a run happens. Mail arriving during " +
      "downtime lands above the frozen ceiling and below the resumed watermark.",
    resumeEpochPath: ["all_mail", "uidvalidity"],
    resumePath: ["all_mail", "forward_uidnext"],
    shape: "imap_uid_band",
  },
];

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

/**
 * Read a path as a finite integer. Anything else — missing, null, a string, a
 * float, NaN — reads as absent rather than being coerced, so a malformed
 * cursor yields `incomplete_cursor` (silence) instead of arithmetic on junk.
 */
function readInteger(cursor: unknown, path: readonly string[]): number | null {
  const value = readPath(cursor, path);
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * Select the RI-owned variant for a manifest-declared shape, if the RI
 * recognizes it. An undeclared or unrecognized shape selects nothing, and the
 * caller reports `not_registered` (silence) rather than guessing.
 */
export function findCursorBandSpec(declaredShape: unknown): CursorBandSpec | null {
  if (!isCursorBandShape(declaredShape)) {
    return null;
  }
  return CURSOR_BAND_SPECS.find((spec) => spec.shape === declaredShape) ?? null;
}

const SILENT: Omit<CursorBandVerdict, "reason"> = {
  bandSize: null,
  ceiling: null,
  resume: null,
  violated: false,
};

/**
 * Evaluate one stream's cursor against its registered band invariant.
 *
 * Pure: no I/O, no clock, no provider call. Given the same cursor it always
 * returns the same verdict, which is what makes it safe to run on every
 * STATE commit.
 */
export function evaluateCursorBand(args: {
  readonly cursor: unknown;
  /** The stream's manifest-declared `cursor_shape`, if it declared one. */
  readonly declaredShape: unknown;
}): CursorBandVerdict {
  const spec = findCursorBandSpec(args.declaredShape);
  if (!spec) {
    return { ...SILENT, reason: "not_registered" };
  }

  const ceiling = readInteger(args.cursor, spec.ceilingPath);
  const resume = readInteger(args.cursor, spec.resumePath);
  if (ceiling === null || resume === null) {
    // The walk has not written both pointers yet. An unstarted walk is not a
    // gap — reporting one here would fire on every freshly-created connection.
    return { ...SILENT, ceiling, reason: "incomplete_cursor", resume };
  }

  // RFC 9051 UIDVALIDITY: pointers recorded under different epochs are not
  // points in one ordered space, so their difference is undefined. Refuse the
  // comparison rather than answering it wrongly.
  if (spec.ceilingEpochPath && spec.resumeEpochPath) {
    const ceilingEpoch = readInteger(args.cursor, spec.ceilingEpochPath);
    const resumeEpoch = readInteger(args.cursor, spec.resumeEpochPath);
    if (ceilingEpoch !== null && resumeEpoch !== null && ceilingEpoch !== resumeEpoch) {
      return { ...SILENT, ceiling, reason: "epoch_mismatch", resume };
    }
  }

  // The intervals meet when the historical walk's ceiling reaches at least the
  // identifier just below where the forward walk resumes.
  if (ceiling + 1 >= resume) {
    return { bandSize: 0, ceiling, reason: "contiguous", resume, violated: false };
  }

  return {
    bandSize: resume - ceiling - 1,
    ceiling,
    reason: "violated",
    resume,
    violated: true,
  };
}

/**
 * Format a violation for an operator. Cursor positions are mailbox
 * coordinates, not record payloads — they are exactly what an operator must
 * see to act, and carry no message content, address, or record key.
 */
export function describeCursorBandViolation(args: {
  readonly connectorId: string;
  readonly stream: string;
  readonly verdict: CursorBandVerdict;
}): string {
  const { verdict } = args;
  return (
    `${args.connectorId}.${args.stream}: ${String(verdict.bandSize)} identifier(s) belong to neither walk ` +
    `(historical ceiling ${String(verdict.ceiling)}, forward resume ${String(verdict.resume)}). ` +
    "These records are never fetched and no coverage signal reports them missing."
  );
}
