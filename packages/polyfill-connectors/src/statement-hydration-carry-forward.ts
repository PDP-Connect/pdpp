// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Carry-forward of prior hydrated statement PDF pointers across runs.
//
// Both statement connectors (chase, usaa) emit one `statements` record per
// index row. On a successful PDF download the body carries
// `document_url`/`pdf_path`/`pdf_sha256`; on a failed download they fall back
// to an all-null index-only body. The three hydrated fields are
// content-addressed (the path embeds the sha256 prefix; the bytes never move)
// and the statement identity is immutable, so the only thing that makes a
// previously-hydrated statement re-version is a hydration-availability flip:
//
//   run A: hydrate  -> {document_url: U, pdf_path: P, pdf_sha256: S}  (version 1)
//   run B: fail     -> {null, null, null}                            (version 2)  ← flap
//   run C: hydrate  -> {U, P, S}                                     (version 3)  ← flap-back
//
// Versions 2 and 3 are not real history: the PDF at path P still exists after
// run B; run B merely failed to re-fetch it, and the per-run `SKIP_RESULT`
// already records that failure honestly. The per-statement fingerprint cursor
// excludes only `fetched_at`, so a `value -> null` move on `pdf_path` is a
// genuine fingerprint change it must NOT collapse — a blanket exclusion would
// also swallow the legitimate `null -> value` first hydration. The flap can
// only be removed at the emit layer, by not producing it: on a hydration
// failure for a statement that was previously hydrated, re-emit the prior
// pointers instead of null.
//
// This is NOT a new runtime primitive. It is a second application of the
// existing `openCarryForwardCursor<T>` derived-field-preservation surface that
// Codex already consumes (`makeThreadFingerprint` carries the prior
// `message_count`/`function_call_count` forward rather than clobbering them
// with null). Here the carried fields are `{document_url, pdf_path, pdf_sha256}`
// keyed by statement `id`.
//
// Body-honesty invariant: a carried-forward body asserts the artifact's last
// known *content-addressed* location (a pointer to bytes a prior run did
// store), NOT that this run re-verified it. The per-run `SKIP_RESULT` for the
// failed download remains the authoritative record that this run did not
// re-fetch the PDF. Carrying forward a pointer to bytes a prior run stored is
// permitted; fabricating a pointer to bytes no run stored is not — a
// never-hydrated statement stays all-null.

import { type CarryForwardCursor, openCarryForwardCursor } from "./fingerprint-cursor.ts";

/** The content-addressed PDF pointer fields plus the positive content
 *  fingerprint, carried across runs. The blob pointers
 *  (`document_url`/`pdf_path`/`pdf_sha256`) point at bytes a prior run stored
 *  and never move; the content fields (`pdf_text_sha256`/`pdf_page_count`) are
 *  derived from those same bytes, so a previously-hydrated statement that fails
 *  to re-download this run carries BOTH forward together — otherwise a
 *  transient failure would drop the content fingerprint and flip the canonical
 *  exclusion back to conservative for that run, re-versioning an immutable
 *  statement. Content fields are optional so legacy persisted entries (written
 *  before this field existed) decode cleanly. */
export interface StatementHydration {
  document_url: string | null;
  pdf_page_count?: number | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  pdf_text_sha256?: string | null;
}

/** The all-null index-only triple a never-hydrated statement emits. */
export const NEVER_HYDRATED: StatementHydration = {
  document_url: null,
  pdf_path: null,
  pdf_sha256: null,
  pdf_text_sha256: null,
  pdf_page_count: null,
};

/** True iff this hydration entry carries a real (non-null) pointer. A prior
 *  entry whose `pdf_path` is null was itself an index-only emit — there is
 *  nothing to carry forward, so the statement stays index-only. */
export function isHydrated(h: StatementHydration | undefined): h is StatementHydration {
  return Boolean(h && h.pdf_path != null && h.pdf_sha256 != null && h.document_url != null);
}

export interface StatementHydrationCursor {
  /** Record this statement id's hydration pointers into the next-run map and
   *  the seen-set. MUST be called for every observed statement id this run —
   *  with the freshly hydrated pointers on success, and (after carry-forward)
   *  with the resolved pointers on failure — so the next run's prior map is
   *  complete and the prune step has the right inputs. */
  note(id: string, value: StatementHydration): void;
  /** Drop ids not `note`d this run. Idempotent. Only valid on full-scan
   *  streams (both statement streams are full scans of the documents index),
   *  so a statement no longer listed stops being carried forever. Call in
   *  lockstep with the fingerprint cursor's `pruneStale()`. */
  pruneStale(): void;
  /** The pointers to emit for a statement that failed hydration this run:
   *  the prior hydrated pointers if the statement was previously hydrated,
   *  otherwise the all-null index-only triple. Pure: does not mutate the
   *  cursor (call `note` separately with the resolved value). */
  resolveOnFailure(id: string): StatementHydration;
  /** Number of ids in the next map. */
  size(): number;
  /** Serializable next-run map for the `hydration` key of the statements
   *  STATE cursor. */
  toState(): Record<string, StatementHydration>;
}

/** Open a statement hydration carry-forward cursor seeded from the prior
 *  STATE cursor's decoded `hydration` map. Reuses the shared
 *  `openCarryForwardCursor` seed/seen/prune/serialize lifecycle. */
export function openStatementHydrationCursor(prior: ReadonlyMap<string, StatementHydration>): StatementHydrationCursor {
  const cursor: CarryForwardCursor<StatementHydration> = openCarryForwardCursor(prior);
  return {
    note(id: string, value: StatementHydration): void {
      cursor.note(id, value);
    },
    resolveOnFailure(id: string): StatementHydration {
      const prev = cursor.prior(id);
      return isHydrated(prev) ? { ...prev } : { ...NEVER_HYDRATED };
    },
    pruneStale(): void {
      cursor.pruneStale();
    },
    size(): number {
      return cursor.size();
    },
    toState(): Record<string, StatementHydration> {
      return cursor.toState();
    },
  };
}

/** Coerce one persisted hydration entry, tolerating legacy / corrupt shapes.
 *  Only the three known pointer fields are kept; a missing or wrong-typed
 *  field decodes to null (which `isHydrated` then treats as not-carriable). */
function coerceHydrationEntry(value: unknown): StatementHydration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const str = (x: unknown): string | null => (typeof x === "string" && x.length > 0 ? x : null);
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);
  return {
    document_url: str(v.document_url),
    pdf_path: str(v.pdf_path),
    pdf_sha256: str(v.pdf_sha256),
    pdf_text_sha256: str(v.pdf_text_sha256),
    pdf_page_count: num(v.pdf_page_count),
  };
}

/** Decode the prior `statements` STATE cursor's `hydration` map. Keyed by
 *  statement `id`. Tolerant of legacy cursors (no `hydration`), missing
 *  field, wrong types, or values from a partially-different schema — bad
 *  entries are silently dropped rather than failing the whole run. A legacy
 *  cursor decodes to an empty map, so the first post-deploy run rebuilds it
 *  and any statement that fails hydration before it has ever been seen
 *  hydrated stays honestly index-only. */
export function readPriorStatementHydration(streamState: unknown): Map<string, StatementHydration> {
  const out = new Map<string, StatementHydration>();
  if (!streamState || typeof streamState !== "object" || Array.isArray(streamState)) {
    return out;
  }
  const raw = (streamState as Record<string, unknown>).hydration;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = coerceHydrationEntry(value);
    // Only retain entries that actually carry pointers; an all-null prior
    // entry has nothing to carry forward, so it need not be persisted.
    if (entry && isHydrated(entry)) {
      out.set(id, entry);
    }
  }
  return out;
}
