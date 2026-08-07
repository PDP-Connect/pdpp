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
 * An unrecognized kind is genuinely unclassified, so it MUST say so plainly
 * rather than guessing or falling back to a misleading definite label.
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
  "pdpp.subscription.verify": "Device login",
  "query.received": "Data read",
  "query.rejected": "Data read rejected",
  "request.rejected": "Request rejected",
  "request.submitted": "App connection",
  "token.issued": "Session started",
  "token.revoked": "Session ended",
};

export function traceKindLabel(kinds: string[] | null | undefined): string {
  const firstKind = (kinds ?? []).map((k) => (typeof k === "string" ? k.trim() : "")).find(Boolean);
  if (!firstKind) {
    return "Unclassified";
  }
  return TRACE_KIND_LABELS[firstKind] ?? "Unclassified";
}
