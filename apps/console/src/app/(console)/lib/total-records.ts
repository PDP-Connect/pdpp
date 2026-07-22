// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RefCountState } from "./ref-client.ts";

/** Shared predicate for whether a total_records value is an authoritative exact count. */
export function isTotalRecordsAuthoritative(totalRecordsState?: RefCountState): boolean {
  return totalRecordsState === undefined || totalRecordsState === "known" || totalRecordsState === "known_zero";
}

/** Format total_records without presenting stale or unavailable evidence as exact. */
export function formatTotalRecordsLabel(
  totalRecords: number,
  totalRecordsState: RefCountState | undefined,
  unit: string
): string {
  if (totalRecordsState === "stale") {
    return `${totalRecords.toLocaleString()} ${unit} (unverified)`;
  }
  if (totalRecordsState === "unobserved" || totalRecordsState === "unknown") {
    return `${unit} unavailable`;
  }
  return `${totalRecords.toLocaleString()} ${unit}`;
}
