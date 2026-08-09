// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable owner-declared collection scope for local-device connections.
 *
 * Where the scope lives, and why it is not a new column:
 *
 * `connector_instances.source_binding_json` is IDENTITY — it is hashed into
 * `source_binding_key`, which participates in the connection's uniqueness
 * constraint and derives the deterministic `connector_instance_id`. Scope is
 * mutable by definition, so storing it there would make every scope edit a
 * connection re-identification. `device_source_instances`' JSON columns are
 * rewritten on every heartbeat, so nothing durable survives there either.
 *
 * `connector_state` is already the durable, per-connection, server-owned store
 * the collector reads at run start (`GET .../state` -> `START.state`). Keying a
 * reserved, non-stream entry in it gives us persistence and delivery with no
 * schema migration and no new transport — the collector's existing state read
 * carries the boundary down with the cursors it already fetches.
 *
 * The reserved key is namespaced with a `$` prefix, which no manifest stream
 * name can take, so it can never collide with a real stream's cursor.
 */

import { collectionScopeFingerprint, normalizeCollectionScope } from "@pdpp/reference-contract/evidence";
import type { CollectionScope } from "@pdpp/reference-contract/evidence";

/**
 * Reserved `connector_state.stream` key holding the connection's declared
 * boundary. `$`-prefixed so it cannot collide with a manifest stream name.
 */
export const COLLECTION_SCOPE_STATE_KEY = "$collection_scope";

/**
 * Reserved `connector_state.stream` key holding the boundary the connection's
 * last committed terminal evidence was MEASURED under.
 *
 * Separate from {@link COLLECTION_SCOPE_STATE_KEY} because the two answer
 * different questions — what the owner declares NOW versus what the stored
 * proof actually covered — and the whole staleness check is their comparison.
 * Collapsing them would make every read trivially agree.
 *
 * Written by the terminal-collection handler, read by the coverage projection
 * off the same state row it already loads, so neither side depends on a caller
 * passing the value along and no extra query is added on either backend.
 */
export const MEASURED_COLLECTION_SCOPE_STATE_KEY = "$measured_collection_scope";

/**
 * Read the boundary the stored terminal evidence was measured under.
 *
 * `null` means no local run has committed terminal evidence under the scope
 * contract yet. That is deliberately NOT the same as `"unscoped"`: a run that
 * genuinely performed a full pass records `"unscoped"` explicitly, whereas a
 * connection with no such record has proven nothing either way.
 */
export function readMeasuredCollectionScope(
  state: Readonly<Record<string, unknown>> | null | undefined
): string | null {
  const entry = state?.[MEASURED_COLLECTION_SCOPE_STATE_KEY];
  if (isRecord(entry)) {
    const fingerprint = entry.fingerprint;
    return typeof fingerprint === "string" && fingerprint.trim() ? fingerprint.trim() : null;
  }
  return typeof entry === "string" && entry.trim() ? entry.trim() : null;
}

/** Build the durable envelope recording what a committed run actually measured. */
export function buildMeasuredCollectionScope(
  fingerprint: string,
  measuredAt: string
): { readonly fingerprint: string; readonly measured_at: string } {
  return { fingerprint: fingerprint.trim() || "unscoped", measured_at: measuredAt };
}

/**
 * The stored scope envelope. `fingerprint` is stored alongside the bounds
 * rather than recomputed on read so a stored proof and the scope it was
 * measured against can be compared without re-deriving either.
 */
export interface StoredCollectionScope {
  readonly declared_at: string;
  readonly fingerprint: string;
  readonly scope: CollectionScope | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the declared scope out of a connector-state projection.
 *
 * A connection that never declared one reads as `unscoped` — the honest
 * default, and identical to what an older collector would have run.
 */
export function readStoredCollectionScope(state: Readonly<Record<string, unknown>> | null | undefined): {
  fingerprint: string;
  scope: CollectionScope | null;
} {
  const entry = state?.[COLLECTION_SCOPE_STATE_KEY];
  if (!isRecord(entry)) {
    return { fingerprint: "unscoped", scope: null };
  }
  const scope = normalizeCollectionScope(entry.scope as CollectionScope | null | undefined);
  // Recompute rather than trusting a stored string: a hand-edited or
  // partially-written row must not be able to assert a boundary its own bounds
  // do not describe.
  return { fingerprint: collectionScopeFingerprint(scope), scope };
}

/**
 * Build the durable envelope for a newly-declared scope.
 *
 * `declaredAt` is injected rather than read from a clock so this stays a total
 * function of its arguments and the caller owns the run-clock.
 */
export function buildStoredCollectionScope(
  scope: CollectionScope | null | undefined,
  declaredAt: string
): StoredCollectionScope {
  const normalized = normalizeCollectionScope(scope);
  return {
    declared_at: declaredAt,
    fingerprint: collectionScopeFingerprint(normalized),
    scope: normalized,
  };
}

/**
 * Whether changing the declared scope must invalidate prior coverage proof.
 *
 * True whenever the boundary's identity changes — including to and from
 * `unscoped`, since a full pass is itself a declared region. A no-op edit
 * (reordered roots, padded whitespace) normalizes to the same fingerprint and
 * correctly does NOT discard valid proof.
 */
export function scopeChangeInvalidatesProof(
  previous: CollectionScope | null | undefined,
  next: CollectionScope | null | undefined
): boolean {
  return collectionScopeFingerprint(normalizeCollectionScope(previous)) !==
    collectionScopeFingerprint(normalizeCollectionScope(next));
}

/**
 * Whether committed coverage evidence still describes the connection's
 * currently-declared boundary.
 *
 * Evidence carries the fingerprint it was measured under; this compares it to
 * what is declared now. A mismatch means the owner moved the boundary after the
 * evidence was produced, so the evidence is stale — it describes a region that
 * is no longer the one being claimed, and must be recomputed by a fresh run
 * rather than reinterpreted.
 *
 * Evidence with NO recorded fingerprint is treated as describing the current
 * scope only when that scope is `unscoped`. Such evidence came from a collector
 * that predates the scope contract, which by definition ran a full pass; letting
 * it satisfy a narrowed boundary would credit a bound it never enforced.
 */
export function terminalEvidenceMatchesDeclaredScope(
  evidenceFingerprint: string | null | undefined,
  declared: CollectionScope | null | undefined
): boolean {
  const declaredFingerprint = collectionScopeFingerprint(normalizeCollectionScope(declared));
  if (typeof evidenceFingerprint !== "string" || !evidenceFingerprint.trim()) {
    return declaredFingerprint === "unscoped";
  }
  return evidenceFingerprint.trim() === declaredFingerprint;
}
