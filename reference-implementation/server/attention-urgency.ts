// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure urgency ranking over structured attention records, used by the
// connection-health projection in `ref-control.ts` to pick the single
// most-urgent open attention record for a connection. A leaf module: it reads
// only the record's response/posture/timestamp fields and has no store or
// projection dependency.

import type { AttentionRecord } from "../runtime/attention.ts";

/**
 * Pick the most-urgent record from a non-empty tuple. The list is small
 * (<= number of open attention records per connection — typically 0-2); a
 * single reduce over the non-empty tuple keeps the urgency comparator local.
 */
export function pickMostUrgentAttention(records: readonly [AttentionRecord, ...AttentionRecord[]]): AttentionRecord {
  const [head, ...rest] = records;
  return rest.reduce((best, candidate) => (compareAttentionUrgency(best, candidate) <= 0 ? best : candidate), head);
}

/**
 * Order two attention records by urgency (negative → `a` first): a required
 * response beats an optional one, then a blocked posture beats an unblocked
 * one, then the earlier expiry, then the earlier creation time.
 */
export function compareAttentionUrgency(a: AttentionRecord, b: AttentionRecord): number {
  const aResp = a.response_contract === "response_required" ? 1 : 0;
  const bResp = b.response_contract === "response_required" ? 1 : 0;
  if (aResp !== bResp) {
    return bResp - aResp;
  }
  const aBlocked = a.progress_posture === "blocked" ? 1 : 0;
  const bBlocked = b.progress_posture === "blocked" ? 1 : 0;
  if (aBlocked !== bBlocked) {
    return bBlocked - aBlocked;
  }
  const aExpiry = a.expires_at ? Date.parse(a.expires_at) : Number.POSITIVE_INFINITY;
  const bExpiry = b.expires_at ? Date.parse(b.expires_at) : Number.POSITIVE_INFINITY;
  if (aExpiry !== bExpiry) {
    return aExpiry - bExpiry;
  }
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}
