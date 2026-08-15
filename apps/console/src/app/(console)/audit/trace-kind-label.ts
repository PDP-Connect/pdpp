// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Trace kind → human "Type" label.
 *
 * `trace.kinds` holds raw `event_type`-shaped strings (`disclosure.served`,
 * `grant.issued`, `token.issued`, …). Nowhere on the Audit list did a row say
 * what KIND of thing it represents in plain terms — a reader had to guess
 * from those raw values. This maps the first kind on a trace to a short,
 * human label, same spirit as `traceEndorseStatus` turning a raw status into
 * an `Endorse` chip.
 *
 * A kind with no entry below has no human label yet, so it MUST surface the
 * raw kind string itself (bounded) rather than a blank "Unclassified" or a
 * guessed definite label — an unmapped kind stays visible as a coverage gap
 * instead of disappearing into an indistinguishable bucket. Only an entirely
 * missing/empty `kinds` array is truly Unclassified.
 */
const TRACE_KIND_LABELS: Record<string, string> = {
  "cimd.transport_failure": "Transport error",
  "client.deleted": "App removed",
  "client.metadata_changed": "App details updated",
  "consent.approved": "Access approved",
  "consent.denied": "Access denied",
  "disclosure.served": "Data read",
  "grant.issued": "Access granted",
  "grant.revoke_rejected": "Revoke rejected",
  "grant.revoked": "Access revoked",
  "grant_package.issued": "Access granted",
  "grant_package.revoke_partial": "Access partially revoked",
  "grant_package.revoked": "Access revoked",
  "mutation.completed": "Data write",
  "mutation.rejected": "Data write rejected",
  "mutation.requested": "Data write",
  "pdpp.subscription.verify": "Device login",
  "query.received": "Data read",
  "query.rejected": "Data read rejected",
  "request.rejected": "Request rejected",
  "request.submitted": "App connection",
  "token.issued": "Session started",
  "token.revoked": "Session ended",
};

/** Cap on a surfaced-raw-kind fallback label so a pathological kind string can't blow out the column. */
const RAW_KIND_LABEL_MAX_LENGTH = 40;

export function traceKindLabel(kinds: string[] | null | undefined): string {
  const firstKind = (kinds ?? []).map((k) => (typeof k === "string" ? k.trim() : "")).find(Boolean);
  if (!firstKind) {
    return "Unclassified";
  }
  const known = TRACE_KIND_LABELS[firstKind];
  if (known) {
    return known;
  }
  // Genuinely unmapped: surface the raw kind (bounded) instead of a blank
  // "Unclassified" so the next coverage gap is visible on the page instead
  // of silently collapsing into one indistinguishable bucket.
  return firstKind.length > RAW_KIND_LABEL_MAX_LENGTH
    ? `${firstKind.slice(0, RAW_KIND_LABEL_MAX_LENGTH - 1)}…`
    : firstKind;
}
