// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Per-record fingerprint cursor for polyfill connectors.
//
// Several connectors (Slack, Gmail, Codex, YNAB) emit records from sources
// that re-derive the full record on every run — slackdump archive rebuilds,
// IMAP `1:*` re-aggregations, sqlite mtime triggers, full-collection refetches.
// Without an emit-side gate, those sources produce a fresh RECORD per (record,
// run) pair even when the source state has not moved, which accumulates into
// hundreds-to-thousands of versions per record downstream.
//
// This module owns the repeated pattern those connectors converged on:
//
//   1. compute a stable fingerprint over the emitted record fields,
//      excluding caller-declared run-clock fields (`fetched_at`, etc.);
//   2. seed the next-run cursor from the prior cursor so a skipped record
//      survives into the next STATE write (carry-forward);
//   3. record every observed id in the seen-set, regardless of whether the
//      record was emitted, so a later prune knows what the source returned;
//   4. on full-scan streams, drop prior ids absent from this run so deleted
//      records do not stay gated as no-ops forever.
//
// Identity, run-clock-field selection, and which streams get pruned remain
// connector-owned. The runtime byte-equivalence check at the storage layer is
// a backstop for cases this gate cannot see (a connector emits the wrong key,
// or the source genuinely returns a byte-identical re-ingest); it is not a
// substitute for this gate.

import { createHash } from "node:crypto";
import type { RecordData } from "./connector-runtime-protocol.ts";

// ─── Carry-forward lifecycle (shared construction boundary) ──────────────
//
// The four converging connectors split into two layers:
//
//   1. A change-detection rule + fingerprint payload that is connector-owned.
//      Most connectors hash the emitted record (`openFingerprintCursor`).
//      Codex instead keeps a structured per-thread fingerprint
//      (`{updated_at, message_count, function_call_count}`) and gates on the
//      state_5 `updated_at` watermark while carrying derived counts forward.
//
//   2. A run lifecycle that is identical across all of them: seed the
//      next-run map from the prior cursor (so a record skipped this run
//      survives into the next STATE write), record every observed id in a
//      seen-set, optionally prune ids the source stopped returning, and
//      serialize the next map for STATE.
//
// `openCarryForwardCursor<T>` owns layer 2 over an arbitrary fingerprint
// type `T`. `openFingerprintCursor` is the `T = string` (hashed-record)
// specialization built on top of it. Codex consumes the generic cursor with
// `T = ThreadFingerprint`, so Slack/Gmail/YNAB and Codex now share one
// construction boundary instead of two hand-rolled lifecycles.

export interface CarryForwardCursor<T> {
  /** Record this id's fingerprint into the next-run map and the seen-set.
   *  Carry-forward and prune both depend on every observed id passing
   *  through here, even when the connector decides not to emit the record. */
  note(id: string, value: T): void;
  /** Prior cursor value for this id, if any. Connector change-detection
   *  rules and derived-field-preservation policies read this. The value is
   *  the prior run's serialized fingerprint, never the one `note` recorded
   *  this run. */
  prior(id: string): T | undefined;
  /** Drop ids from the next map that were not `note`d this run. Idempotent.
   *  Only valid on full-scan streams: a partial scan has no business
   *  pruning ids it never looked at. If `note` was called zero times this
   *  run, every prior id is dropped — the correct outcome for a requested
   *  full-scan stream that returned zero records. */
  pruneStale(): void;
  /** Number of ids in the next map. */
  size(): number;
  /** Serializable next-run map for STATE. */
  toState(): Record<string, T>;
}

/** Open a typed carry-forward cursor seeded from a pre-decoded prior map.
 *
 *  Unlike `openFingerprintCursor`, this does not decode a STATE shape or
 *  compute fingerprints — the caller owns both, because the fingerprint
 *  type and its on-disk shape are connector-specific. The cursor only owns
 *  the seed/seen/prune/serialize lifecycle.
 *
 *  The next map is seeded by copying the prior map, so a record the caller
 *  declines to `note` this run still surfaces in `toState()`. */
export function openCarryForwardCursor<T>(prior: ReadonlyMap<string, T>): CarryForwardCursor<T> {
  const next = new Map<string, T>(prior);
  const seen = new Set<string>();

  return {
    prior(id: string): T | undefined {
      return prior.get(id);
    },
    note(id: string, value: T): void {
      next.set(id, value);
      seen.add(id);
    },
    pruneStale(): void {
      for (const id of next.keys()) {
        if (!seen.has(id)) {
          next.delete(id);
        }
      }
    },
    size(): number {
      return next.size;
    },
    toState(): Record<string, T> {
      const out: Record<string, T> = {};
      for (const [id, value] of next) {
        out[id] = value;
      }
      return out;
    },
  };
}

export interface FingerprintCursorOptions {
  /** Fields that appear in the emitted record but must NOT participate in
   *  change detection. Typically run-clock fields like `fetched_at` whose
   *  value is "when this run happened" rather than "when the source row
   *  changed". Without exclusion, the fingerprint would never match across
   *  runs even when the source has not moved. */
  excludeFromFingerprint?: readonly string[];
  /** Optional pre-decoded prior fingerprint map. Use this when the caller
   *  has already pulled the map out of a non-standard cursor shape. If
   *  omitted, the cursor decodes `priorState` itself with the tolerant
   *  rules described on `openFingerprintCursor`. */
  priorFingerprints?: ReadonlyMap<string, string>;
  /** Compute the exclusion list per record instead of using one static list.
   *  Used by content-gated streams (PDF statements) whose exclusion depends on
   *  whether the record carries a positive content fingerprint: the gate moves
   *  the boundary between "blob/acquisition churn is a no-op" and "no positive
   *  signal, stay conservative" on a per-record basis. When provided, this
   *  takes precedence over `excludeFromFingerprint` for every record. */
  resolveExcludeFromFingerprint?: (record: Record<string, unknown>) => readonly string[];
}

export interface FingerprintCursor {
  /** Prior cursor value for this id, if any. Use this when a connector
   *  has a derived-field-preservation policy (e.g. Codex pulls counts
   *  forward from the prior fingerprint when this run did not re-parse
   *  the source). The primitive does not encode policy — it just
   *  exposes the prior value. */
  priorFingerprint(id: string): string | undefined;
  /** Drop ids from the next map that were not observed this run.
   *  Idempotent. Must only be called on streams whose run is a full
   *  scan, because partial-scan streams have no business pruning ids
   *  they did not look at this run. If `shouldEmit` was called zero
   *  times this run, every prior id is dropped — that is the correct
   *  outcome for a requested full-scan stream that returned zero
   *  records. */
  pruneStale(): void;
  /** Returns `true` iff the record's fingerprint differs from the prior
   *  cursor value for this id (or no prior exists). Always records the
   *  computed fingerprint into the next map and the id into the seen
   *  set — even when returning `false` — so STATE carry-forward is
   *  intact and the prune step has the right inputs.
   *
   *  Records whose `data.id` is null/undefined/empty cannot be
   *  fingerprinted; this method returns `true` for them and does NOT
   *  touch the next map or the seen set. The caller decides whether to
   *  emit. */
  shouldEmit(data: RecordData): boolean;
  /** Number of ids currently in the next map. Useful for callers that
   *  want to skip writing an empty `fingerprints` field. */
  size(): number;
  /** Serializable cursor for STATE. The caller decides where to put
   *  this in the stream's cursor object (typically under a
   *  `fingerprints` key alongside other cursor fields). */
  toState(): Record<string, string>;
}

/** Stable per-record fingerprint over the emitted record's fields. Keys
 *  are sorted recursively so the hash does not depend on incidental key
 *  order in the record builder. SHA-1 is fine for change detection: a
 *  collision between distinct shapes would silently skip one emit per
 *  record, and the run-clock-field risk dominates anyway.
 *
 *  Exposed because the four existing implementations all needed the
 *  same primitive under slightly different names; future migrations can
 *  import it directly without reaching for `openFingerprintCursor`. */
export function recordFingerprint(record: Record<string, unknown>, excludeKeys: readonly string[] = []): string {
  const exclude = new Set(excludeKeys);
  return createHash("sha1").update(stableStringify(record, exclude)).digest("hex");
}

/** Open a cursor seeded from a prior STATE shape.
 *
 *  `priorState` is decoded tolerantly. The following shapes all produce
 *  an empty prior map without throwing:
 *    - `undefined` / `null`
 *    - any non-object value
 *    - arrays
 *    - an object missing a `fingerprints` field (legacy cursor shape)
 *    - a `fingerprints` field whose value is not an object
 *    - entries whose value is not a non-empty string
 *
 *  This matches the existing per-connector tolerance for legacy cursors
 *  and corrupt-on-disk state: a broken cursor never blocks a successful
 *  run, it just re-emits everything next time.
 *
 *  The cursor is seeded by copying the prior map into the next map so a
 *  record skipped this run still surfaces in the next STATE write. */
export function openFingerprintCursor(priorState: unknown, options: FingerprintCursorOptions = {}): FingerprintCursor {
  const staticExcludeKeys = options.excludeFromFingerprint ?? [];
  const resolveExcludeKeys = options.resolveExcludeFromFingerprint;
  const prior = options.priorFingerprints ?? decodePriorFingerprints(priorState);
  // The hashed-record specialization is layer 1 (compute the fingerprint,
  // compare against prior) over the shared `T = string` carry-forward
  // lifecycle (layer 2).
  const cursor = openCarryForwardCursor<string>(prior);

  return {
    shouldEmit(data: RecordData): boolean {
      const rawId = data.id;
      if (rawId == null) {
        return true;
      }
      const id = String(rawId);
      if (id.length === 0) {
        return true;
      }
      const record = data as Record<string, unknown>;
      const excludeKeys = resolveExcludeKeys ? resolveExcludeKeys(record) : staticExcludeKeys;
      const fingerprint = recordFingerprint(record, excludeKeys);
      cursor.note(id, fingerprint);
      return cursor.prior(id) !== fingerprint;
    },
    priorFingerprint(id: string): string | undefined {
      return cursor.prior(id);
    },
    pruneStale(): void {
      cursor.pruneStale();
    },
    toState(): Record<string, string> {
      return cursor.toState();
    },
    size(): number {
      return cursor.size();
    },
  };
}

// ─── Internals ──────────────────────────────────────────────────────────

function decodePriorFingerprints(priorState: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!priorState || typeof priorState !== "object" || Array.isArray(priorState)) {
    return out;
  }
  const raw = (priorState as Record<string, unknown>).fingerprints;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
}

function compareKeys(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function stableStringify(value: unknown, exclude: ReadonlySet<string>): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v, exclude)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k]) => !exclude.has(k))
    .sort(([a], [b]) => compareKeys(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v, exclude)}`).join(",")}}`;
}
