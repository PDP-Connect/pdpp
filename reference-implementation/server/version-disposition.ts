// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";

/**
 * Server-derived `version_disposition` for record-version-churn rows.
 *
 * The owner-only `GET /_ref/records/version-stats` envelope returns numeric
 * churn facts (versions-per-record, risk level, risk reasons). This module adds
 * the *meaning* of a non-normal row — is it an active defect, expected
 * point-in-time history, an owner-reviewed residue, an actionable compaction
 * candidate, or a recurring snapshot stream? — as a reference-DERIVED label, so
 * the meaning lives in the auditable contract instead of the browser bundle.
 *
 * Why server-derived (not connector-authored): a connector must not be able to
 * self-declare its churn away. There is NO connector input to this derivation.
 * `classifyVersionDisposition` reads only signals the reference controls, but
 * (`ri-zero-knowledge-terminal-revise-0810`) it no longer resolves any of them
 * itself — every input is a plain, non-identity-bearing value the CALLER
 * (`record-version-stats.ts`) resolves and passes in:
 *   - the registered compaction-policy presence (a boolean the caller computes
 *     from `compact-record-history.ts`'s COMPACTION_POLICIES registry — the
 *     same registry the maintenance tool treats as authoritative);
 *   - `compactionClass`, a manifest-declared `"point_in_time_real_field" |
 *     "recurring_snapshot" | null` value the caller resolves once per
 *     `(connector, stream)` pair via the connector's OWN registered manifest
 *     (`getConnectorManifest` in `./auth.ts`) — never an RI source or
 *     RI-committed JSON literal. A connector's manifest is the one place a
 *     connector-authored fact about ITSELF is legitimate to read (that is
 *     what a manifest is FOR); this module still never trusts the raw class
 *     string as an override, it only recognizes the two enumerated values
 *     and treats anything else identically to `null` — see
 *     `isPointInTimeRealField`/`isRecurringSnapshot` below;
 *   - `reviewedAt`, the owner-maintained reviewed-residue evidence for the
 *     row's `connector/stream` key — an explicit OWNER acknowledgement,
 *     timestamp-gated so post-review growth re-alarms, read from OPERATOR
 *     runtime state at `PDPP_COMPACTION_RESIDUE_REVIEW_PATH` (see
 *     `readReviewedCompactionResidueMap` below). This is NOT a connector fact
 *     — no manifest field could ever substitute for it: it is a judgment call
 *     about one SPECIFIC connector INSTANCE's observed history, made by the
 *     RI operator after inspecting real data, not something a connector could
 *     honestly declare about itself.
 *
 * This is a label only: it never alters `risk_thresholds`, `risk_level`, or
 * `risk_reasons`. Those are computed exactly as before in
 * `classifyRecordVersionChurn` and are independent of disposition.
 *
 * `classifyVersionDisposition`/`classifyVersionRemediation` themselves stay
 * fully synchronous, pure, in-process unit-testable functions with ZERO I/O —
 * they are called once per row inside `record-version-stats.ts`'s per-row
 * loop, so any per-row I/O there would both violate this module's purity
 * contract and threaten the loop's performance. `record-version-stats.ts`
 * resolves every distinct `(connector, stream)` pair's `compactionClass`
 * ONCE, in a single batched pass BEFORE the loop, and reads the
 * `reviewedAt` map once (see `readReviewedCompactionResidueMap`, which IS
 * genuinely I/O — real external operator state, not a fiction of purity —
 * but is read-once-and-cached, matching this module's own prior load-once
 * timing for the now-deleted JSON policy file). Only the resolved,
 * connector-anonymous values flow into the per-row classifier calls.
 */

/**
 * The five operator-meaningful dispositions. Only
 * `active_defect_or_unclassified` counts toward an operator "needs review"
 * signal; the other four are recognized, expected retained history.
 */
export const VERSION_DISPOSITIONS = Object.freeze([
  "active_defect_or_unclassified",
  "reviewed_historical_residue",
  "point_in_time_retained_history",
  "lossless_compaction_candidate",
  "recurring_point_in_time_snapshot",
]);

/** One of the five operator-meaningful `version_disposition` values. */
export type VersionDisposition = (typeof VERSION_DISPOSITIONS)[number];

/**
 * A manifest-declared stream compaction class, resolved by the caller from
 * the connector's own registered manifest (`streams[].compaction_class`) —
 * never read by this module directly, and never trusted as a raw override:
 * only these two enumerated values are recognized (see
 * `isPointInTimeRealField`/`isRecurringSnapshot`); any other string is
 * treated identically to `null` (an unrecognized/absent class), so a
 * connector cannot invent a third value to reach a disposition this module
 * does not itself define.
 *
 *   - `"point_in_time_real_field"`: the stream versions on a GENUINELY
 *     changing real field carried on the same record as a stable identity,
 *     whose sampled metric has already been split into its own append-keyed
 *     point-in-time stream. The retained entity history is the sole
 *     surviving copy of those observations and is NEVER compactable (a
 *     compaction policy would delete real history). These deliberately have
 *     NO registered compaction policy; the regression guard in
 *     `reference-implementation/test/compact-record-history.test.js` pins
 *     that.
 *   - `"recurring_snapshot"`: the stream legitimately re-versions on every
 *     real session-growth pass. The whole record (`message_count`,
 *     `last_event_at`, …) IS the evolving observation, not a metric you can
 *     peel off onto a stable identity, so the stream cannot be append-split.
 *     The connector mtime-gate prevents byte-identical no-op re-emits, so
 *     each version is a distinct real snapshot. These streams DO have a
 *     registered compaction policy (the exact-stable-JSON family in
 *     `compact-record-history.ts` covers them) — that policy is the
 *     regression safety net: if the mtime gate ever broke and produced
 *     byte-identical no-op re-emits, the dry-run would surface
 *     `removableVersions > 0` and a connector-level test would catch it. But
 *     for normal growth there is nothing to remove, so the row must NOT read
 *     as an actionable compaction candidate, and growth must NOT re-alarm
 *     it. `"recurring_snapshot"` therefore takes precedence over both the
 *     reviewed-residue map and the compaction-policy signal during
 *     derivation (see `classifyVersionDisposition`'s precedence doc).
 */
export type CompactionClass = "point_in_time_real_field" | "recurring_snapshot" | null;

function isPointInTimeRealField(compactionClass: CompactionClass): boolean {
  return compactionClass === "point_in_time_real_field";
}

function isRecurringSnapshot(compactionClass: CompactionClass): boolean {
  return compactionClass === "recurring_snapshot";
}

// Registry-URL connector id → bare connector id (last path segment). Also
// strips the `local-device:` multi-device prefix so callers resolving a
// manifest by connector id match local-collector connections.
const REGISTRY_CONNECTOR_ID_RE = /\/connectors\/([^/]+)\/?$/;

/**
 * Normalize a connector_id to its bare short id. Handles the registry-URL
 * form and the `local-device:` prefix. Returns null for a null input. This is
 * generic string mechanics, not connector knowledge — kept here because both
 * this module's (now-removed) list lookups and the caller's manifest
 * resolution need the identical normalization, and this module already owned
 * it.
 */
export function normalizeConnectorId(connectorId: string | null | undefined): string | null {
  if (!connectorId) {
    return null;
  }
  const match = connectorId.match(REGISTRY_CONNECTOR_ID_RE);
  const bare = match?.[1] ?? connectorId;
  return bare.startsWith("local-device:") ? bare.slice("local-device:".length) : bare;
}

/**
 * Operator runtime state: the ISO 8601 timestamp at which the owner inspected
 * a stream and confirmed it was expected residue. A row can only be
 * classified as `reviewed_historical_residue` when its `last_history_at` is
 * at or before this timestamp — if new history was written since the review,
 * the row re-alarms as a `lossless_compaction_candidate`.
 *
 * This is NOT a connector fact and NEVER lived in a manifest: it is an
 * explicit OWNER acknowledgement that (1) the connector is fingerprint-
 * correct, (2) the dry-run at review time showed `removableVersions = 0`,
 * and (3) any later history write is fresh churn that must re-alarm — a
 * judgment call about one specific connector INSTANCE's observed behavior at
 * a point in time, not something a connector could honestly self-declare.
 * Per the `ri-zero-knowledge-terminal-revise-0810` ruling, it lives in
 * OPERATOR RUNTIME STATE, never RI-committed source or RI-committed JSON.
 *
 * The SAME operator-state file also carries `pendingRemediation` — whether
 * that reviewed residue's next action is `content_fingerprint_pending` (byte
 * churn is run-clock/blob-identity noise; a connector needs a stable content
 * fingerprint) or `owner_migration_pending` (the retained history is the sole
 * surviving copy of observations pending a migration into their canonical
 * append-keyed home). Like the review timestamp itself, this is an OWNER
 * judgment call about a specific connector instance's observed churn, not a
 * connector-declarable fact, so it belongs in the identical operator-state
 * entry rather than a second RI-committed list or a second file.
 *
 * Read from the JSON file at `PDPP_COMPACTION_RESIDUE_REVIEW_PATH` (default
 * `/var/lib/pdpp/compaction-residue-review.json`, matching this codebase's
 * existing `/var/lib/pdpp`-relative convention for other operator/runtime
 * state such as `PDPP_EMBEDDING_CACHE_DIR`'s `/var/lib/pdpp/transformers`
 * default). Expected shape: a flat JSON object mapping `"connector/stream"`
 * (bare connector id, post-`normalizeConnectorId`) to EITHER a bare ISO 8601
 * UTC timestamp string (reviewed residue, no pending remediation) or an
 * object carrying the timestamp plus an optional pending-remediation reason:
 *
 *   {
 *     "usaa/accounts": { "reviewedAt": "2026-06-05T13:57:05.707Z", "pendingRemediation": "owner_migration_pending" },
 *     "usaa/statements": { "reviewedAt": "2026-06-05T13:57:05.707Z", "pendingRemediation": "content_fingerprint_pending" },
 *     "some/other-stream": "2026-06-05T13:57:05.707Z"
 *   }
 *
 * If the file is absent, this reads as an EMPTY map — never an error, never a
 * crash. An operator who has not yet reviewed anything runs with zero
 * reviewed-residue entries, which is a safe (more re-alarming, not less)
 * default. This function performs real file I/O (unlike
 * `classifyVersionDisposition`/`classifyVersionRemediation`, which stay pure)
 * — that is an honest tradeoff for genuinely external operator state, not
 * something to paper over. The result is read once and cached for the life
 * of the process (matching this module's prior module-load-time timing for
 * the JSON policy file it replaces); call `resetReviewedCompactionResidueCacheForTests`
 * to force a re-read (e.g. after a test changes `PDPP_COMPACTION_RESIDUE_REVIEW_PATH`
 * or the file's contents).
 */
export interface ReviewedCompactionResidueEntry {
  readonly pendingRemediation: PendingRemediation;
  readonly reviewedAt: string;
}

let cachedReviewedResidueMap: ReadonlyMap<string, ReviewedCompactionResidueEntry> | null = null;
let cachedReviewedResiduePath: string | null = null;

function compactionResidueReviewPath(): string {
  return process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH || "/var/lib/pdpp/compaction-residue-review.json";
}

function normalizeReviewedResidueEntry(value: unknown): ReviewedCompactionResidueEntry | null {
  if (typeof value === "string") {
    return { pendingRemediation: null, reviewedAt: value };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { reviewedAt, pendingRemediation: rawPendingRemediation } = value as Record<string, unknown>;
    if (typeof reviewedAt !== "string") {
      return null;
    }
    const pendingRemediation =
      rawPendingRemediation === "content_fingerprint_pending" || rawPendingRemediation === "owner_migration_pending"
        ? rawPendingRemediation
        : null;
    return { pendingRemediation, reviewedAt };
  }
  return null;
}

export function readReviewedCompactionResidueMap(): ReadonlyMap<string, ReviewedCompactionResidueEntry> {
  const path = compactionResidueReviewPath();
  if (cachedReviewedResidueMap && cachedReviewedResiduePath === path) {
    return cachedReviewedResidueMap;
  }
  let map: ReadonlyMap<string, ReviewedCompactionResidueEntry> = new Map();
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entries: [string, ReviewedCompactionResidueEntry][] = [];
        for (const [key, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
          const entry = normalizeReviewedResidueEntry(rawEntry);
          if (entry) {
            entries.push([key, entry]);
          }
        }
        map = new Map(entries);
      }
    } catch {
      // Malformed operator file: treat as empty rather than crashing the
      // server. This is the same fail-safe posture as "file absent" — an
      // operator with a broken review file re-alarms everything, which is
      // safe (more conservative), never silently unsafe.
      map = new Map();
    }
  }
  cachedReviewedResidueMap = map;
  cachedReviewedResiduePath = path;
  return map;
}

/** Test-only: force the next `readReviewedCompactionResidueMap` call to re-read from disk. */
export function resetReviewedCompactionResidueCacheForTests(): void {
  cachedReviewedResidueMap = null;
  cachedReviewedResiduePath = null;
}

// ─── version_remediation: the orthogonal next-action axis ────────────────────
//
// `version_disposition` (above) answers "why does this row's retained history
// exist?". `version_remediation` answers the second, orthogonal question the
// records-page notice left open: "what does the operator do about it?". The two
// are genuinely independent — three of the live watch rows share the SAME
// disposition (`reviewed_historical_residue`) but need three different next
// actions — which is exactly why remediation is a second derived field, not a
// finer split of disposition. `classifyVersionDisposition` is unchanged here;
// remediation consumes its already-derived output plus the caller-resolved
// pending-remediation signal below.
//
// Like disposition, remediation has NO connector input. A connector that could
// declare its own remediation `none` could declare a needed fix away.

/**
 * The four operator-meaningful remediations. Only the three non-`none` values
 * name a pending action that is NOT already covered by the dry-run command the
 * disposition surface renders.
 */
export const VERSION_REMEDIATIONS = Object.freeze([
  "none",
  "content_fingerprint_pending",
  "owner_migration_pending",
  "owner_retention_policy",
]);

/** One of the four operator-meaningful `version_remediation` values. */
export type VersionRemediation = (typeof VERSION_REMEDIATIONS)[number];

/**
 * A caller-resolved pending-remediation signal for one row's `connector/
 * stream`, or `null` when no pending remediation is on record. Like
 * `reviewedAt`, this is an OWNER judgment call about a specific connector
 * INSTANCE's observed churn — never a connector-declarable fact — so it is
 * resolved by the caller from the same operator runtime state
 * (`readReviewedCompactionResidueMap`'s `.pendingRemediation` field, see
 * `record-version-stats.ts`), not read by this module directly.
 *
 *   - `"content_fingerprint_pending"`: the stream's byte churn is run-clock /
 *     blob-identity noise (RC4 re-encryption, regeneration timestamps) but
 *     its owner-visible content is invariant. It is fingerprint-correct on
 *     `fetched_at`, so the registered compaction dry-run reports
 *     `removableVersions = 0` and frees nothing. The real remediation is
 *     net-new CONNECTOR work — emitting a stable content fingerprint so the
 *     volatile acquisition/blob fields can be excluded losslessly.
 *   - `"owner_migration_pending"`: the stream's retained entity history is
 *     the SOLE surviving copy of real observations that must be migrated
 *     into their canonical append-keyed home before the history could ever
 *     be collapsed. Compaction is NOT the remediation here and could destroy
 *     real history if attempted out of order.
 */
export type PendingRemediation = "content_fingerprint_pending" | "owner_migration_pending" | null;

/**
 * Derive the four-way `version_remediation` for one churn row from the row's
 * already-derived `version_disposition` and caller-resolved reference
 * signals. NO connector-authored value participates.
 *
 * Inputs (all reference-controlled, all resolved by the caller):
 *   - `versionDisposition`        : the value `classifyVersionDisposition`
 *     already returned for this row (remediation never re-derives or
 *     contradicts it);
 *   - `pendingRemediation`        : the caller-resolved OPERATOR judgment
 *     call (`"content_fingerprint_pending" | "owner_migration_pending" |
 *     null`) for this row's `connector/stream`, read from operator runtime
 *     state (see `PendingRemediation` doc above).
 *   - `connectorId`/`stream`      : accepted for call-site symmetry with
 *     `classifyVersionDisposition` and so a caller can pass the same row
 *     object to both without stripping fields, but NOT read by this
 *     function's logic — every decision here is already fully determined by
 *     `versionDisposition` and `pendingRemediation`.
 *
 * Consistency precedence (first match wins), enforcing that remediation can
 * never disagree with disposition:
 *   1. disposition is `recurring_point_in_time_snapshot` →
 *      `owner_retention_policy`. Unlike (2)/(3), this is not an operator
 *      judgment call read from external state: EVERY recurring-snapshot
 *      stream carries the same open lever (whether to bound an otherwise
 *      unbounded-growth snapshot history), so it is derived directly from
 *      the disposition the manifest-declared `compactionClass` already
 *      produced — the generic rule "recurring snapshot ⇒ retention-policy
 *      lever exists" needs no connector-specific list.
 *   2. else `pendingRemediation === "owner_migration_pending"` →
 *      `owner_migration_pending`.
 *   3. else `pendingRemediation === "content_fingerprint_pending"` →
 *      `content_fingerprint_pending`.
 *   4. else `none`.
 *
 * Hard guards (independent of any signal): an `active_defect_or_unclassified`
 * or `lossless_compaction_candidate` row is ALWAYS `none`. Its action is
 * already conveyed — review it, or run the dry-run command the disposition
 * surface renders — so a pending-remediation signal must not override it.
 */
export function classifyVersionRemediation({
  versionDisposition,
  pendingRemediation = null,
}: {
  connectorId?: string | null;
  stream?: string;
  versionDisposition?: VersionDisposition | string;
  pendingRemediation?: PendingRemediation;
} = {}): VersionRemediation {
  // A row whose action is already "review it" or "run the dry-run command"
  // never carries a pending remediation, regardless of any signal.
  if (
    versionDisposition === "active_defect_or_unclassified" ||
    versionDisposition === "lossless_compaction_candidate"
  ) {
    return "none";
  }

  if (versionDisposition === "recurring_point_in_time_snapshot") {
    return "owner_retention_policy";
  }
  if (pendingRemediation === "owner_migration_pending") {
    return "owner_migration_pending";
  }
  if (pendingRemediation === "content_fingerprint_pending") {
    return "content_fingerprint_pending";
  }
  return "none";
}

/**
 * Derive the five-way `version_disposition` for one churn row.
 *
 * Inputs (all reference-controlled — NO connector-authored value
 * participates; all resolved by the caller BEFORE this call, so this
 * function stays synchronous, pure, and zero-I/O):
 *   - `compactionClass`     : the manifest-declared class the caller resolved
 *     once per `(connector, stream)` pair via `getConnectorManifest` (see the
 *     module doc comment and `CompactionClass` above);
 *   - `lastHistoryAt`       : ground-truth max(record_changes.emitted_at), or
 *     null;
 *   - `hasCompactionPolicy` : boolean the caller resolved from the registered
 *     COMPACTION_POLICIES registry (`findPolicy(connectorId, stream) != null`);
 *   - `reviewedAt`          : the caller-resolved operator reviewed-residue
 *     timestamp for this row's `connector/stream` (from
 *     `readReviewedCompactionResidueMap`), or undefined if none is on record.
 *   - `connectorId`/`stream`: accepted for call-site symmetry with
 *     `classifyVersionRemediation` (a caller can pass the same row object to
 *     both) but NOT read by this function's logic — every decision here is
 *     already fully determined by the four resolved values above.
 *
 * Precedence (first match wins):
 *   1. `compactionClass === "recurring_snapshot"` → never compactable, never
 *      re-alarms on growth. Checked first so its registered compaction policy
 *      does not pull it into the candidate bucket.
 *   2. `compactionClass === "point_in_time_real_field"` → never compactable.
 *   3. reviewed historical residue (`reviewedAt` + timestamp guard). Demotes
 *      to (4) when `last_history_at` is after the review timestamp or is
 *      unavailable (unverifiable guard → re-alarm rather than suppress).
 *   4. lossless compaction candidate (registered policy, redundant versions
 *      removable; the read-only dry-run is a real remediation).
 *   5. otherwise active defect or unclassified (the only "needs review" class).
 *
 * The numeric churn classification (risk_level / risk_reasons /
 * versions_per_record) is NOT consulted or altered here — disposition is a pure
 * label over the row's identity and history-evidence.
 */
export function classifyVersionDisposition({
  compactionClass = null,
  lastHistoryAt = null,
  hasCompactionPolicy = false,
  reviewedAt,
}: {
  connectorId?: string | null;
  stream?: string;
  compactionClass?: CompactionClass;
  lastHistoryAt?: string | null;
  hasCompactionPolicy?: boolean;
  reviewedAt?: string | undefined;
} = {}): VersionDisposition {
  if (isRecurringSnapshot(compactionClass)) {
    return "recurring_point_in_time_snapshot";
  }
  if (isPointInTimeRealField(compactionClass)) {
    return "point_in_time_retained_history";
  }
  if (reviewedAt !== undefined && lastHistoryAt !== null && lastHistoryAt <= reviewedAt) {
    // Ground-truth evidence shows no new history since the review.
    return "reviewed_historical_residue";
  }
  // reviewedAt present but last_history_at absent / after review → fall
  // through to the candidate bucket (re-alarm), not silent suppression.
  if (hasCompactionPolicy) {
    return "lossless_compaction_candidate";
  }
  return "active_defect_or_unclassified";
}
