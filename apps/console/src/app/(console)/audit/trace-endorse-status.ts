// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Trace status → Endorse variant mapping.
 *
 * Lives in its own pure module (no RSC / next imports) so the honesty
 * discipline below is unit-testable in isolation.
 *
 * An unrecognized status is genuinely indeterminate, so it MUST render
 * neutral (`unknown`) — never a definite `revoked`. Painting an unknown
 * trace as struck/revoked claims a terminal fact the console does not
 * have (a PDPP honesty violation: unknown reads unknown).
 */
export type TraceEndorseVariant = "active" | "continuous" | "expiring" | "revoked" | "denied" | "unknown";

export function traceEndorseStatus(status: string): TraceEndorseVariant {
  switch (status) {
    case "succeeded":
      return "active";
    case "started":
    case "in_progress":
      return "continuous";
    case "failed":
    case "rejected":
      return "denied";
    default:
      return "unknown";
  }
}
